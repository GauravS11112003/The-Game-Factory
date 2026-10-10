"""Publish verification (PLAN_V2 §1.3 "Publish verification", §11.3e POST /levels, D27).

The browser sends the tier, the kid's final edit statuses and the `level_hash` of the level it shows. The server
never trusts that level: the worker recomputes it from ink + graph0 + edit records (with those statuses), the hash
is recomputed and compared, and the recomputed level is re-analyzed by the bot. 409s, each a message key:

    publish.hash_mismatch     the browser's level differs from the recomputation
    publish.unsolvable        the bot cannot finish it (publish.needs_goal when there is no goal)
    publish.entity_error      an entity was disabled by the engine guard
    publish.unanswered_ask    an Ask without a default option is still open
    publish.required_undone   the kid undid an edit the level needs
    publish.safety_flag       PERCEIVE or MODERATE flagged it, or the deterministic blocklist hit a name/title
    publish.needs_all_sheets  a multi-sheet paper pack (kind new or game) with sheets still unscanned (§6.4); remix
                              and extend packs may leave sheets out (those screens inherit the parent)

A refusal (PERCEIVE or MODERATE) publishes the level unlisted with `safety: held`. With the model offline it
publishes with `safety: unchecked` ("not checked yet"), unless DAL_REQUIRE_MODERATION=1, which holds it.
"""
from __future__ import annotations

import copy
import logging
import secrets
import time
from typing import Any

from pydantic import ValidationError

from app import db_v2
from app.build import drafts, present
from app.build.orchestrator import intent_edits
from app.build.rebuild import DraftError, base_input, rpc, understood
from app.config import get_settings_v2
from app.mind import client, moderate, render, sanitize
from app.spec.level import LevelV2, level_hash

log = logging.getLogger("dal.v2.publish")

TITLE_CHARS = 40
TIERS = drafts.TIERS


def new_level_id() -> str:
    return f"lvl_{secrets.token_hex(4)}"


def _level_ink(ink: dict[str, Any]) -> dict[str, Any]:
    """LevelInk: the InkDoc without v/source/world/sheets/parent (CONTRACTS §3.3)."""
    return {"strokes": ink.get("strokes") or [], "components": ink.get("components") or [],
            "character": ink.get("character"), "typed_rules": ink.get("typed_rules") or [],
            "rules_ink": ink.get("rules_ink") or [], "noise": ink.get("noise") or {"count": 0}}


def _apply_default_asks(state: dict[str, Any], statuses: dict[str, str]) -> list[dict[str, Any]]:
    """Unanswered asks: their default option is applied (CONTRACTS §3.3); one without a default blocks."""
    extra: list[dict[str, Any]] = []
    for ask in state.get("asks") or []:
        if ask.get("answer") is not None:
            continue
        default = ask.get("default_option")
        opt = next((o for o in ask.get("options") or [] if o.get("id") == default), None) if default else None
        if opt is None:
            raise DraftError(409, "publish.unanswered_ask", {"about": ask.get("about")})
        for op in opt.get("ops") or []:
            extra.append(present.kid_record(op, "designed", reason_key="kid.answer"))
        for eid, st in (opt.get("x_statuses") or {}).items():
            statuses.setdefault(eid, st)
    return extra


def _check_sheets(state: dict[str, Any], ink: dict[str, Any]) -> None:
    """§6.4: "Publishing requires all k sheets and a goal" (playable as soon as sheet 1 onward is contiguous)."""
    if ink.get("source") != "paper":
        return
    pack = state.get("pack") or {}
    if pack.get("kind") in ("remix", "extend"):
        return
    k = int(pack.get("k") or (ink.get("world") or {}).get("screens") or 1)
    have = {int(sh.get("index", -1)) for sh in ink.get("sheets") or []}
    if k > 1 and not all(i in have for i in range(k)):
        raise DraftError(409, "publish.needs_all_sheets", {"k": k, "missing": [i + 1 for i in range(k) if i not in have]})


def changed_objects(parent: dict[str, Any] | None, level: dict[str, Any]) -> dict[str, Any] | None:
    """Remix diff for the tree: objects added, removed and changed (role, shape or behavior) vs the parent."""
    if not parent:
        return None
    a = {o["id"]: o for o in parent.get("objects") or [] if o.get("id")}
    b = {o["id"]: o for o in level.get("objects") or [] if o.get("id")}
    changed = [oid for oid in b if oid in a and any(a[oid].get(k) != b[oid].get(k) for k in ("role", "shape", "behavior"))]
    return {"added": sorted(set(b) - set(a)), "removed": sorted(set(a) - set(b)), "changed": sorted(changed)}


async def _safety(state: dict[str, Any], draft_id: str, title: str, author: str, ink: dict[str, Any]) -> tuple[str, bool]:
    """(safety, listed) for the published level."""
    if moderate.blocklist_hit([title, author, state.get("transcript")]):
        raise DraftError(409, "publish.safety_flag")
    s = state.get("safety") or "unchecked"
    if s == "flag":
        raise DraftError(409, "publish.safety_flag")
    if s == "held":
        return "held", False
    needs_moderation = s != "ok" or not state.get("perceive_ran") or (title and title != state.get("title"))
    if needs_moderation and client.available():
        r = await moderate.moderate(render.moderation_image(ink), [title, author, state.get("transcript") or ""],
                                    draft_id=draft_id, deadline=time.monotonic() + client.CALLS["moderate"].timeout_s)
        if r.status == "ok" and r.value is not None:
            if r.value.safety == "flag":
                raise DraftError(409, "publish.safety_flag")
            return "ok", True
        if r.status == "refused":
            return "held", False
        # failed / skipped / truncated: as if offline
    if s == "ok":  # PERCEIVE checked the drawing; the new text passed the blocklist
        return "ok", True
    if get_settings_v2().require_moderation:
        return "held", False
    return "unchecked", True


async def publish(body: dict[str, Any]) -> dict[str, Any]:
    draft_id = body["draft_id"]
    tier = body["tier"]
    if not drafts.exists(draft_id):
        raise DraftError(404, "error.not_found", {"what": "draft"})
    async with drafts.lock(draft_id):
        state = drafts.load_state(draft_id) or {}
        current = drafts.load_current(draft_id)
        if current is None or tier not in current:
            raise DraftError(409, "publish.unsolvable")
        statuses = {**(state.get("statuses") or {}), **(body.get("statuses") or {})}
        stored = current[tier]
        for e in stored.get("edits") or []:
            if e.get("required") and statuses.get(e.get("id")) == "undone":
                raise DraftError(409, "publish.required_undone")
        extra = _apply_default_asks(state, statuses)
        _check_sheets(state, drafts.read_json(draft_id, "ink.json") or {})

        # recompute: the tier's own records (its P/C edits reproduce the tier) + the draft's intent, statuses applied
        st = copy.deepcopy(state)
        st["statuses"] = statuses
        known = drafts.read_json(draft_id, "edits.json")
        records: dict[str, dict[str, Any]] = {}
        for e in stored.get("edits") or []:
            if e.get("id"):
                r = copy.deepcopy(e)
                if r["id"] in statuses:
                    r["status"] = statuses[r["id"]]
                records[r["id"]] = r
        for r in intent_edits(st, understood=understood(st), known=known) + extra:
            records[r["id"]] = r
        inp = base_input(draft_id, st, list(records.values()))
        res = await rpc("build", {**inp, "tier": tier})
        level = (res or {}).get("level")
        report = (res or {}).get("report") or {}
        if not isinstance(level, dict):
            raise DraftError(422, "error.build_failed", {"why": "no_level"})
        try:
            h = (await rpc("level_hash", {"level": level})).get("hash")
        except DraftError:
            h = None
        h = h or level_hash(level)
        if h != body.get("level_hash"):
            # The browser may be showing the stored tier itself (computed by the worker, never by the browser):
            # greedy tiers stop on a time budget, so a fresh single-tier rebuild can differ from what buildTiers
            # produced. A hash that matches the stored worker result is as trustworthy as the recomputation.
            stored_level = stored.get("level") if isinstance(stored.get("level"), dict) else None
            stored_h = level_hash(stored_level) if stored_level else None
            if stored_level is None or stored_h != body.get("level_hash"):
                raise DraftError(409, "publish.hash_mismatch")
            level, report, h = copy.deepcopy(stored_level), dict(stored.get("report") or {}), stored_h
        if not report.get("solvable", False):
            raise DraftError(409, "publish.needs_goal" if report.get("reason") == "no_goal" else "publish.unsolvable")
        if any(f.get("code") == "entity_error" for f in report.get("flags") or []):
            raise DraftError(409, "publish.entity_error")

        ink = drafts.read_json(draft_id, "ink.json") or {}
        title = sanitize.text(body.get("title") or state.get("title") or ((state.get("note") or {}).get("title_suggestion"))
                              or "My level", TITLE_CHARS)
        author = sanitize.text(body.get("author") or "", 16)
        safety, listed = await _safety(state, draft_id, title, author, ink)

        prev = state.get("published") or {}
        level_id = prev.get("level_id") or new_level_id()
        version = db_v2.next_level_version(level_id)
        parent_id = state.get("parent_id")
        parent = drafts.read_json(draft_id, "parent.json")
        game_id = state.get("game_id") or (parent or {}).get("game_id")
        order_index = db_v2.count_sequence(game_id) if game_id and version == 1 else int(prev.get("order_index") or 0)

        out = copy.deepcopy(level)
        out.update({"id": level_id, "version": version, "game_id": game_id, "parent_id": parent_id,
                    "order_index": order_index, "title": title, "author": author, "created_at": db_v2.now_iso()})
        out.pop("ink_ref", None)
        if not out.get("ink"):
            out["ink"] = _level_ink(ink)
        meta = dict(out.get("meta") or {})
        meta.update({"level_hash": h, "safety": safety, "transcript": state.get("transcript") or meta.get("transcript", ""),
                     "intent": state.get("intent") or meta.get("intent")})
        meta["build"] = {"stages": state.get("stages") or [], "model_calls": state.get("model_calls") or [],
                         "cost_usd": round(float((state.get("cost") or {}).get("usd", 0)), 5)}
        meta.setdefault("core_version", report.get("core_version") or "unknown")
        out["meta"] = meta
        note = state.get("note") or {}
        if (out.get("design") and note.get("designer_note") and note.get("source") == "model"
                and state.get("design_source") == "model"):  # a late plan's note talks about suggestions, not this level
            out["design"] = {**out["design"], "designer_note": note["designer_note"]}
        src = dict(out.get("source") or {})
        src.setdefault("kind", ink.get("source") or "canvas")
        if state.get("prompt") and (state.get("kind") == "prompt" or src.get("kind") == "prompt"):
            src["kind"] = "prompt"
            src["prompt"] = state["prompt"]
        if state.get("pack_id"):
            src["pack_id"] = state["pack_id"]
        if ink.get("sheets") and not src.get("sheets"):
            src["sheets"] = [{"index": s.get("index", 0), "photo_url": s.get("photo_url"), "qr": s.get("qr")}
                             for s in ink["sheets"]]
        # "My original sketch" underlay (§7.2, E-2): the rectified 48 × 27-cell drawing area of each sheet
        sketches = {int(s.get("index", -1)): s.get("x_sketch_url") for s in ink.get("sheets") or []
                    if isinstance(s, dict) and isinstance(s.get("x_sketch_url"), str)}
        if sketches and src.get("sheets"):
            src["sheets"] = [{**sh, "sketch_url": sketches.get(int(sh.get("index", -1)), sh.get("sketch_url"))}
                             for sh in src["sheets"] if isinstance(sh, dict)]
        out["source"] = src
        try:
            from app.build.levels_io import embedded_library

            out["embedded_library"] = embedded_library(out, game_id)  # exports and remixes stay self-contained (§8.1)
        except Exception as e:  # noqa: BLE001
            log.info("embedded library for %s: %s", level_id, e)
        try:
            LevelV2.model_validate(out)
        except ValidationError as e:
            log.warning("published level %s fails the format: %s", level_id, e.errors()[:3])
            raise DraftError(422, "error.build_failed", {"why": "invalid_level"}) from None

        design = out.get("design") or {}
        db_v2.insert_level({
            "id": level_id, "version": version, "game_id": game_id, "parent_id": parent_id,
            "parent_version": (parent or {}).get("version"), "order_index": order_index, "title": title,
            "author": author, "json": _dumps(out), "level_hash": h, "c_casual": report.get("C"),
            "score": report.get("score"), "band": report.get("band"), "screens": (out.get("world") or {}).get("screens"),
            "verified": True, "safety": safety, "listed": listed, "par_ms": report.get("par_ms") or design.get("par_ms"),
            "fastest_ms": report.get("fastest_ms") or design.get("fastest_ms"),
            "changed_json": _dumps(changed_objects(parent, out)) if parent else None, "draft_id": draft_id,
            "created_at": out["created_at"],
        })
        fresh = drafts.load_state(draft_id) or state
        fresh["published"] = {"level_id": level_id, "version": version, "order_index": order_index}
        fresh["statuses"] = statuses
        drafts.save_state(draft_id, fresh)
        return out


def _dumps(x: Any) -> str:
    import json

    return json.dumps(x, separators=(",", ":"), ensure_ascii=False)
