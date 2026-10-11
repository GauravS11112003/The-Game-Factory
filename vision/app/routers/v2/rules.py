"""Game rules (PLAN_V2 §8.2, §11.3e). Rules are game-wide; each published level keeps the resolved snapshot it was
published with (`level.rules`), so changing the game's rules never alters a published level or invalidates its runs.

GET  /games/{id}/rules                  → GameRules
POST /games/{id}/rules/check            GameRules (or a partial patch) → {affected: [{level_id, reason_key, repairable,
                                         repairs, level_hash, x_title, x_version}], checked, rules}
                                         the bot dry-runs every level of the game under the new rules, and the designer
                                         tries a Faithful repair on each one that breaks (core `rules_check`)
PUT  /games/{id}/rules[?apply=all&repair=1]
                                         GameRules (or a partial patch) → {rules, applied, affected, failed}
    apply omitted: the rules change for new builds only (version + 1).
    apply=all: "Apply to all levels". The dry run comes first; if any level would become unsolvable the change is
               blocked (409 rules.blocked with the affected list) unless repair=1, which lets the designer rebuild
               those levels with Faithful repairs. Every level of the game is then rebuilt under the new rules and
               saved as a new version (levels that still cannot be finished are listed in `failed` and keep their
               old version).
POST /scan/rules-sheet                  multipart photo → {patch, asks}   (lane C's deterministic OMR, no model)

`v1-classic` is for migrated levels only: a game can keep it, but cannot switch to it.

v4 (docs/v4/CONTRACTS_V4.md §3, §6): `mode` (platformer | topdown | runner | flappy) and the game-wide `logic` (RuleV4[])
travel in the same GameRules patch, are checked by the same dry run and reach new builds through the game's rules
(orchestrator load_context). "platformer" and an empty `logic` are stored as null.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app import db_v2
from app.build import levels_io
from app.build.bridge import CoreError, get_pool, per_level_timeout
from app.config import SHARED_DIR
from app.routers.v2.library import _as_dict, lane_c, read_upload
from app.spec.rules import GameRules

log = logging.getLogger("dal.v2.rules")
router = APIRouter()

MAX_LEVELS = 40
ANALYZE_TIMEOUT_S = 12.0
BUILD_TIMEOUT_S = 15.0
CHECK_CONCURRENCY = 2


def err(status: int, key: str, args: dict[str, Any] | None = None, **extra: Any) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}, **extra}, status_code=status)


def _game_v2(game_id: str) -> dict[str, Any] | None:
    g = db_v2.get_game(game_id)
    return g if g is not None and g.get("format") == 2 else None


def default_rules() -> dict[str, Any]:
    return GameRules(version=1).model_dump(mode="json")


def current_rules(game: dict[str, Any]) -> dict[str, Any]:
    return game.get("rules") or default_rules()


def profile_hash(profile: str) -> str | None:
    try:
        p = json.loads((SHARED_DIR / "spec" / "physics-profiles.json").read_text(encoding="utf-8"))
        return ((p.get("profiles") or {}).get(profile) or {}).get("profile_hash")
    except (OSError, json.JSONDecodeError):
        return None


def resolve(patch: dict[str, Any], current: dict[str, Any], *, bump: bool) -> dict[str, Any]:
    """The full GameRules from a (partial) patch on the current rules; the version is bumped when saving."""
    merged = copy.deepcopy(current)
    for k, v in patch.items():
        if k == "abilities" and isinstance(v, dict):
            merged["abilities"] = {**(merged.get("abilities") or {}), **v}
        elif k not in ("version", "profile_hash"):
            merged[k] = v
    merged["version"] = int(current.get("version") or 1) + (1 if bump else 0)
    if merged.get("physics_profile") == "v1-classic" and current.get("physics_profile") != "v1-classic":
        raise ValueError("physics_profile")
    rules = GameRules.model_validate(merged).model_dump(mode="json")
    rules["profile_hash"] = profile_hash(rules["physics_profile"]) or rules.get("profile_hash")
    # v4 (CONTRACTS_V4 §3): "platformer" and "no game-wide rules" are stored as null, the v2 default, so a game that
    # switches back keeps its levels' level_hash (and their runs) unchanged
    if rules.get("mode") == "platformer":
        rules["mode"] = None
    if not rules.get("logic"):
        rules["logic"] = None
    return rules


def reason_key(old: dict[str, Any], new: dict[str, Any]) -> str:
    oa, na = old.get("abilities") or {}, new.get("abilities") or {}
    if oa.get("run", True) and not na.get("run", True):
        return "rules.needs_run"
    if oa.get("double_jump") and not na.get("double_jump"):
        return "rules.needs_double_jump"
    return "rules.becomes_unsolvable"


async def _analyze(level: dict[str, Any]) -> dict[str, Any] | None:
    pool = get_pool()
    if pool is None:
        raise CoreError("down", "no pool")
    res = await pool.call("analyze", {"level": level, "mode": "fast"}, ANALYZE_TIMEOUT_S)
    return (res or {}).get("report") if isinstance(res, dict) else None


async def _rules_check_one(level: dict[str, Any], rules: dict[str, Any], repair: bool) -> dict[str, Any] | None:
    """Lane B's rules re-verify helper on one level: the affected row (with the designer's Faithful repairs when
    `repair`), or None when the level still plays. Raises CoreError; `invalid` means an older core without it."""
    pool = get_pool()
    if pool is None:
        raise CoreError("down", "no pool")
    res = await pool.call("rules_check", {"levels": [level], "rules": rules, "repair": repair}, per_level_timeout(1))
    rows = (res or {}).get("affected") if isinstance(res, dict) else None
    return rows[0] if isinstance(rows, list) and rows and isinstance(rows[0], dict) else None


async def dry_run(game_id: str, rules: dict[str, Any], *, repair: bool = True) -> tuple[list[dict[str, Any]], int]:
    """(affected levels, levels checked): every level of the game whose bot run fails under the new rules.

    Each row is lane B's AffectedLevel {level_id, reason_key, repairable, repairs, level_hash} (F-4: the designer's
    Faithful repairs per level, so "Let the designer fix them" needs no browser dry run) plus x_title / x_version.
    Falls back to a plain fast analyze per level when the core has no `rules_check`."""
    rows = db_v2.game_level_rows(game_id)[:MAX_LEVELS]
    sem = asyncio.Semaphore(CHECK_CONCURRENCY)
    use_helper = True

    async def one(row: dict[str, Any]) -> dict[str, Any] | None:
        nonlocal use_helper
        level = row["level"]
        if not row.get("verified", True):
            return None  # already unfinishable under its own rules: not something this change breaks
        extra = {"x_title": row.get("title"), "x_version": row.get("version")}
        async with sem:
            if use_helper:
                try:
                    hit = await _rules_check_one(level, rules, repair)
                    return {**hit, "level_id": row["id"], **extra} if hit is not None else None
                except CoreError as e:
                    if e.code == "down":
                        raise
                    if e.code == "invalid":  # an older core: no rules_check method
                        use_helper = False
                    else:
                        return {"level_id": row["id"], "reason_key": "rules.becomes_unsolvable", "repairable": False,
                                "repairs": [], **extra, "x_error": e.code}
            try:
                report = await _analyze(levels_io.with_rules(level, rules))
            except CoreError as e:
                if e.code in ("down",):
                    raise
                return {"level_id": row["id"], "reason_key": "rules.becomes_unsolvable", **extra, "x_error": e.code}
        if report is None or report.get("solvable"):
            return None
        return {"level_id": row["id"], "reason_key": reason_key(level.get("rules") or {}, rules), **extra}

    out = await asyncio.gather(*(one(r) for r in rows))
    return [a for a in out if a is not None], len(rows)


async def _body_patch(request: Request) -> dict[str, Any]:
    raw = await request.json()
    if isinstance(raw, dict) and isinstance(raw.get("rules"), dict):
        raw = raw["rules"]
    if not isinstance(raw, dict):
        raise ValueError("rules")
    return raw


@router.get("/games/{game_id}/rules")
def get_rules(game_id: str) -> Any:
    g = _game_v2(game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    return current_rules(g)


@router.post("/games/{game_id}/rules/check")
async def check_rules(game_id: str, request: Request) -> Any:
    g = _game_v2(game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    try:
        rules = resolve(await _body_patch(request), current_rules(g), bump=True)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "rules", "errors": min(e.error_count(), 99)})
    except ValueError as e:
        return err(400, "error.bad_request", {"field": str(e) or "rules"})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request", {"field": "rules"})
    try:
        affected, n = await dry_run(game_id, rules)
    except CoreError:
        return err(503, "error.worker_down")
    return {"affected": affected, "checked": n, "rules": rules}


async def _apply_all(game_id: str, rules: dict[str, Any]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Rebuild every level of the game under the new rules (Faithful repairs allowed); save the solvable ones as a new
    version. Returns (applied [{level_id, version}], failed [{level_id, reason_key}])."""
    pool = get_pool()
    if pool is None:
        raise CoreError("down", "no pool")
    applied, failed = [], []
    for row in db_v2.game_level_rows(game_id)[:MAX_LEVELS]:
        level = row["level"]
        parent = None
        if level.get("parent_id"):
            prow = db_v2.get_level_row(str(level["parent_id"]))
            parent = (prow or {}).get("level")
        lib = levels_io.embedded_library(level, game_id)
        try:
            res = await pool.call("build", levels_io.rebuild_input(level, rules=rules, parent=parent, library=lib),
                                  BUILD_TIMEOUT_S)
        except CoreError as e:
            if e.code == "down":
                raise
            failed.append({"level_id": row["id"], "reason_key": "rules.becomes_unsolvable", "x_error": e.code})
            continue
        new = (res or {}).get("level") if isinstance(res, dict) else None
        report = (res or {}).get("report") or {}
        if not isinstance(new, dict) or not report.get("solvable"):
            failed.append({"level_id": row["id"], "reason_key": reason_key(level.get("rules") or {}, rules)})
            continue
        version, errors = levels_io.save_rebuilt(row, new, report, library=lib)
        if version is None:
            log.warning("rules apply %s: invalid level: %s", row["id"], errors[:2])
            failed.append({"level_id": row["id"], "reason_key": "rules.becomes_unsolvable", "x_error": "invalid"})
            continue
        applied.append({"level_id": row["id"], "version": version})
    return applied, failed


@router.put("/games/{game_id}/rules")
async def put_rules(game_id: str, request: Request, apply: str = Query(default="none"),
                    repair: int = Query(default=0, ge=0, le=1)) -> Any:
    g = _game_v2(game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    if apply not in ("none", "all"):
        return err(400, "error.bad_request", {"field": "apply"})
    try:
        rules = resolve(await _body_patch(request), current_rules(g), bump=True)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "rules", "errors": min(e.error_count(), 99)})
    except ValueError as e:
        return err(400, "error.bad_request", {"field": str(e) or "rules"})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request", {"field": "rules"})
    if apply == "none":
        db_v2.set_game_rules(game_id, rules)
        return {"rules": rules, "applied": [], "affected": [], "failed": []}
    try:
        affected, _ = await dry_run(game_id, rules, repair=False)
        if affected and not repair:
            return err(409, "rules.blocked", {"n": len(affected)}, affected=affected)
        applied, failed = await _apply_all(game_id, rules)
    except CoreError:
        return err(503, "error.worker_down")
    db_v2.set_game_rules(game_id, rules)
    return {"rules": rules, "applied": applied, "affected": affected, "failed": failed}


@router.post("/scan/rules-sheet")
async def scan_rules_sheet(request: Request) -> Any:
    """Lane C's deterministic OMR → {patch, asks}; the "My world is…" line is transcribed by the handwriting call
    (title and blurb) when the model is available. The game named by the sheet's QR gets the resolved rules too."""
    data = await read_upload(request)
    if not data:
        return err(400, "error.upload_failed")
    detail = lane_c("read_rules_sheet_detail")
    fn = detail or lane_c("read_rules_sheet")
    if fn is None:
        return err(501, "error.not_implemented", {"route": "POST /api/v2/scan/rules-sheet"})
    try:
        raw = await asyncio.to_thread(fn, data)
    except Exception as e:  # noqa: BLE001
        msg = _as_dict(getattr(e, "message", None))
        log.info("rules sheet: %s", e)
        return err(422, msg.get("key") if isinstance(msg, dict) and msg.get("key") else "error.paper_missing",
                   (msg or {}).get("args") if isinstance(msg, dict) else {})
    res = _as_dict(getattr(raw, "result", raw)) if detail is not None else _as_dict(raw)
    if not isinstance(res, dict):
        return err(422, "error.paper_missing")
    patch = res.get("patch") or {}
    out: dict[str, Any] = {"patch": patch, "asks": [_as_dict(a) for a in res.get("asks") or []]}
    for k in ("x_values", "x_warnings", "x_story_ink"):
        if k in res:
            out[k] = res[k]
    story = getattr(raw, "story_jpeg", None) if detail is not None else None
    if story and (getattr(raw, "story_has_ink", False) or res.get("x_story_ink")):
        from app.mind import handwriting

        texts = await handwriting.read_lines([story], "the \"My world is...\" line of a game's rules sheet", max_chars=160)
        if texts and texts[0]:
            out["story"] = texts[0]
            out["title_suggestion"] = texts[0].split(".")[0][:40].strip() or None
    gid = res.get("game_id") or res.get("x_game_id") or (getattr(raw, "game_id", None) if detail is not None else None)
    game = _game_v2(gid) if isinstance(gid, str) else None
    if game is not None:
        out["game_id"] = gid
        try:
            out["rules"] = resolve(patch, current_rules(game), bump=True)
        except Exception:  # noqa: BLE001 - an ask-only sheet: the client resolves after the answers
            pass
    return out
