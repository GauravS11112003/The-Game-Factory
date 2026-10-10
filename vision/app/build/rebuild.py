"""Authoritative rebuilds after the kid acts on a draft (PLAN_V2 §11.3e PUT edits / POST answers, D6).

Toggling an edit is a rebuild: `build()` is a pure function of (ink, graph0, edit records with statuses, rules,
library, tier). The browser rebuilds locally for instant feedback; the worker's result is authoritative and is
what publish verifies. The new tiers are saved as `tiers/current.<tier>.json` (fetchable under /uploads).

When the Designed tiers came from a model plan, the rebuild re-applies that plan (so the model's picks stay);
otherwise it reruns the greedy tiers. Accepted suggestions ride along as picks by cid when the current menu still
offers them, else as stored edit records.
"""
from __future__ import annotations

import copy
from typing import Any

from app.build import drafts, present
from app.build.bridge import RPC_TIMEOUTS_S, TIERS_SLACK_S, CoreError, get_pool
from app.build.orchestrator import TIERS_DEADLINE_MS, default_rules, graph_for_build, intent_edits

TIERS = drafts.TIERS


class DraftError(Exception):
    def __init__(self, status: int, message_key: str, args: dict[str, Any] | None = None) -> None:
        super().__init__(message_key)
        self.status = status
        self.message_key = message_key
        self.args = args or {}


async def rpc(method: str, params: dict[str, Any], timeout_s: float | None = None) -> Any:
    pool = get_pool()
    if pool is None:
        raise DraftError(503, "error.worker_down")
    try:
        return await pool.call(method, params, timeout_s)
    except CoreError as e:
        if e.code in ("down", "timeout"):
            raise DraftError(503, "error.worker_down") from None
        raise DraftError(422, "error.build_failed", {"why": e.code}) from None


def base_input(draft_id: str, state: dict[str, Any], edits: list[dict[str, Any]]) -> dict[str, Any]:
    ink = drafts.read_json(draft_id, "ink.json")
    graph0 = drafts.read_json(draft_id, "graph0.json")
    if ink is None or graph0 is None:
        raise DraftError(409, "error.not_found", {"what": "drawing"})
    return {"ink": ink, "graph0": graph_for_build(graph0, state), "edits": edits, "rules": state.get("rules") or default_rules(),
            "library": drafts.read_json(draft_id, "library.json") or [],
            "parent": drafts.read_json(draft_id, "parent.json"), "repairUnsolvable": True,
            "seed": int(state.get("seed") or 1)}


def understood(state: dict[str, Any]) -> bool:
    return (state.get("perception") or {}).get("status") == "ok"


async def rebuild(draft_id: str, state: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Rebuild every tier from the draft's current intent; returns (TierSet, rejected ids/cids)."""
    current = drafts.load_current(draft_id)
    menu = (current or {}).get("menu") or []
    menu_cids = {c.get("cid") for c in menu}
    accepted = list((state.get("edits") or {}).get("accepted") or [])
    by_pick = [r for r in accepted if r.get("cid") and r["cid"] in menu_cids]
    known = drafts.read_json(draft_id, "edits.json")
    exclude = {r["id"] for r in by_pick}
    edits = [e for e in intent_edits(state, understood=understood(state), known=known) if e["id"] not in exclude]
    inp = base_input(draft_id, state, edits)
    plan = copy.deepcopy(state.get("plan")) if state.get("design_source") == "model" and state.get("plan") else None
    if by_pick:
        plan = plan or {"repair_choices": [], "vetoes": [], "picks": [], "novel": [], "asks": [], "designer_note": "",
                        "critique": [], "title": None}
        have = {p["cid"] for p in plan.get("picks", [])}
        for r in by_pick:
            if r["cid"] not in have:
                tier = r.get("tier") if r.get("tier") in ("polished", "normal", "hard") else "polished"
                plan["picks"].append({"cid": r["cid"], "tier": tier, "reason": r.get("reason_text") or ""})
    rejected: list[str] = []
    if plan is not None and menu:
        ts = await rpc("apply_plan", {"input": inp, "menu": menu, "plan": plan}, RPC_TIMEOUTS_S.get("apply_plan", 20))
        rejected = [str(r.get("cid")) for r in (ts or {}).get("rejected") or [] if r.get("cid")]
    else:
        params = {**inp, "deadlineMs": TIERS_DEADLINE_MS}
        if state.get("band"):
            params["band"] = state["band"]
        ts = await rpc("build_tiers", params, TIERS_DEADLINE_MS / 1000 + TIERS_SLACK_S)
    if not isinstance(ts, dict) or not all(t in ts for t in TIERS):
        raise DraftError(422, "error.build_failed", {"why": "bad_tierset"})
    for t in TIERS:
        rejected += [str(e.get("id")) for e in (ts.get(t) or {}).get("rejected") or [] if e.get("id")]
    drafts.save_tierset(draft_id, "current", ts)
    drafts.write_json(draft_id, "edits.json", present.edits_union(ts, edits))
    return ts, sorted(set(rejected))


def record_current(state: dict[str, Any], ts: dict[str, Any], rejected: list[str]) -> None:
    state["current"] = {"stage": "current", **present.summary(ts, rejected)}
