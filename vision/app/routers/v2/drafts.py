"""Draft actions (PLAN_V2 §11.3e): the kid's edits and answers (authoritative worker rebuilds), the dial, Redesign
and "Why is this hard?".

PUT  /drafts/{id}/edits      {statuses: {edit_id: applied|undone}, kid_edits: EditOp[]} → {tiers, rejected}
POST /drafts/{id}/answers    {ask_id, choice}  → {tiers, rejected}   (choice: an option id, or a tapped object id)
POST /drafts/{id}/dial       {tier}            → {tier}              (persisted selection; tiers are precomputed)
POST /drafts/{id}/redesign   {}                → 202 {build_id, draft_id}
POST /drafts/{id}/critic     {telemetry}       → 202 {build_id, draft_id}  (SSE `note` + `suggestions`)

Accepting a suggestion is `statuses: {<suggested id>: "applied"}`; undoing it again moves it back to suggestions.
"""
from __future__ import annotations

import copy
import re
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse
from pydantic import ValidationError

from app.build import drafts, present, runner
from app.build.orchestrator import BuildRequest
from app.build.rebuild import DraftError, rebuild, record_current
from app.spec.api import AnswerBody, CriticBody, DialBody, EditsBody

router = APIRouter()

TAP_PLACEHOLDERS = {"$tap", "?", ""}
# scene object ids (CONTRACTS §3.10): o<cid>, o<cid>_<k>, o<cid>_s<n>, designer e_<kind>_<hash6>[_k], e_goal
_OBJ_ID = re.compile(r"^(o\d+(_[A-Za-z0-9]+)*|e_[A-Za-z0-9_]+)$")


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _check(draft_id: str) -> JSONResponse | None:
    if not drafts.DRAFT_RE.match(draft_id) or not drafts.exists(draft_id):
        return err(404, "error.not_found", {"what": "draft"})
    return None


async def _body(request: Request) -> Any:
    try:
        return await request.json()
    except Exception:  # noqa: BLE001
        return {}


def _stage_of(state: dict[str, Any]) -> str:
    s = state.get("stage")
    return s if s in drafts.STAGES else "designed"


def apply_statuses(state: dict[str, Any], statuses: dict[str, str]) -> None:
    """Kid toggles. A suggested record the kid applies becomes an accepted edit; undoing an accepted one puts it back
    among the suggestions. Every other id is a status override the core honours by stable id."""
    e = state.setdefault("edits", {})
    sugg = {r["id"]: r for r in e.get("suggestions") or []}
    acc = {r["id"]: r for r in e.get("accepted") or []}
    st = dict(state.get("statuses") or {})
    for eid, status in statuses.items():
        if eid in sugg and status == "applied":
            r = copy.deepcopy(sugg.pop(eid))
            r["status"] = "applied"
            acc[eid] = r
            st.pop(eid, None)
        elif eid in acc and status == "undone":
            r = copy.deepcopy(acc.pop(eid))
            r["status"] = "suggested"
            sugg[eid] = r
            st.pop(eid, None)
        else:
            st[eid] = status
    e["suggestions"] = list(sugg.values())
    e["accepted"] = list(acc.values())
    state["statuses"] = st


def add_kid_ops(state: dict[str, Any], ops: list[dict[str, Any]], *, reason_key: str | None = None) -> list[str]:
    """Append kid edits (answers). A new re-label of an object replaces the kid's earlier re-label of it, as in the
    browser, so the newest one is the one that counts."""
    stage = _stage_of(state)
    kid = {r["id"]: r for r in (state.setdefault("edits", {}).get("kid") or [])}
    ids = []
    for op in ops:
        r = present.kid_record(op, stage, reason_key=reason_key)
        if op.get("op") == "set_role":
            for k in [k for k, x in kid.items() if (x.get("op") or {}).get("op") == "set_role"
                      and (x.get("op") or {}).get("target") == op.get("target")]:
                kid.pop(k)
        kid.pop(r["id"], None)
        kid[r["id"]] = r
        ids.append(r["id"])
    state["edits"]["kid"] = list(kid.values())
    return ids


def set_kid_ops(state: dict[str, Any], ops: list[dict[str, Any]]) -> None:
    """PUT /edits sends the kid's full list of applied edits (the browser's `kidOps()`): it is authoritative. Earlier
    kid edits missing from it were undone or replaced, so they stay on record as `undone` (never re-applied)."""
    stage = _stage_of(state)
    old = {r["id"]: r for r in (state.setdefault("edits", {}).get("kid") or [])}
    new: dict[str, dict[str, Any]] = {}
    for op in ops:
        r = old.get(present.edit_id(op)) or present.kid_record(op, stage)
        r = {**r, "status": "applied"}
        new.pop(r["id"], None)
        new[r["id"]] = r
    gone = [{**r, "status": "undone"} for k, r in old.items() if k not in new]
    state["edits"]["kid"] = gone + list(new.values())


async def _rebuild_and_save(draft_id: str, mutate: Any) -> JSONResponse:
    """Under the draft lock: apply `mutate` to a copy of the state, rebuild with it, then merge into the freshest
    state (a build may have written meanwhile) and save."""
    async with drafts.lock(draft_id):
        state = drafts.load_state(draft_id)
        if state is None:
            return err(404, "error.not_found", {"what": "draft"})
        work = copy.deepcopy(state)
        try:
            mutate(work)
        except DraftError as e:
            return err(e.status, e.message_key, e.args)
        prev = drafts.load_current(draft_id)
        try:
            ts, rejected = await rebuild(draft_id, work)
        except DraftError as e:
            return err(e.status, e.message_key, e.args)
        fresh = drafts.load_state(draft_id) or work
        for k in ("statuses", "asks", "answers"):
            fresh[k] = work.get(k, fresh.get(k))
        fresh.setdefault("edits", {})
        for k in ("kid", "accepted", "suggestions"):
            fresh["edits"][k] = (work.get("edits") or {}).get(k, [])
        record_current(fresh, ts, rejected)
        drafts.save_state(draft_id, fresh)
        emit_rebuilt(draft_id, fresh, ts, prev)
        return JSONResponse(present.summary(ts, rejected))


def emit_rebuilt(draft_id: str, state: dict[str, Any], ts: dict[str, Any], prev: dict[str, Any] | None) -> None:
    """The authoritative rebuilt tiers also go into the draft's event log (F-3): a client whose local core cannot
    rebuild, or a preview reopened later, picks them up with `GET /drafts/{id}?since=`."""
    from app.build.events import JsonlEventSink
    from app.build.orchestrator import intent_edits

    try:
        sink = JsonlEventSink(drafts.events_path(draft_id))
        ink = drafts.read_json(draft_id, "ink.json") or {}
        known = drafts.read_json(draft_id, "edits.json")
        extra = intent_edits(state, understood=(state.get("perception") or {}).get("status") == "ok", known=known)
        sink.emit("edits", {"edits": present.edits_union(ts, extra)})
        reach = ts.get("reach") or {}
        stage = _stage_of(state)
        for t in drafts.TIERS:
            if t not in ts:
                continue
            ev = present.tier_payload(
                stage, t, ts[t], draft_id=draft_id, reach=True if t == "faithful" else bool(reach.get(t, True)),
                morphs_=present.morphs((prev or {}).get(t), ts[t], ink))
            ev["x_kid"] = True  # already includes the kid's edits: the client must not rebuild on top of it
            sink.emit("tier", ev)
    except Exception as e:  # noqa: BLE001 - the HTTP answer (and tiers/current.*) is what matters
        import logging

        logging.getLogger("dal.v2.drafts").info("rebuilt tier events not written: %s", e)


@router.put("/drafts/{draft_id}/edits")
async def put_edits(draft_id: str, request: Request) -> Any:
    if (bad := _check(draft_id)) is not None:
        return bad
    raw = await _body(request)
    try:
        body = EditsBody.model_validate(raw)
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "edits", "errors": min(e.error_count(), 99)})
    statuses = dict(body.statuses)
    # the ops exactly as the browser sent them (validated above): a re-dump would add defaults and change the ids
    ops = [{k: v for k, v in op.items() if v is not None} for op in raw.get("kid_edits") or [] if isinstance(op, dict)]

    def mutate(s: dict[str, Any]) -> None:
        apply_statuses(s, statuses)
        set_kid_ops(s, ops)

    return await _rebuild_and_save(draft_id, mutate)


def _substitute(op: dict[str, Any], tapped: str) -> dict[str, Any]:
    return {k: (tapped if isinstance(v, str) and v in TAP_PLACEHOLDERS and k != "op" else v) for k, v in op.items()}


def answer_ops(ask: dict[str, Any], choice: str) -> tuple[list[dict[str, Any]], dict[str, str]]:
    """The kid edits (and status overrides) an answer applies. A tapped object id answers a 'Tap it' ask."""
    opt = next((o for o in ask.get("options") or [] if o.get("id") == choice), None)
    if opt is not None:
        return list(opt.get("ops") or []), dict(opt.get("x_statuses") or {})
    if not _OBJ_ID.match(choice):
        raise DraftError(400, "error.bad_request", {"field": "choice"})
    tap = next((o for o in ask.get("options") or [] if o.get("tap_target")), None)
    if tap is not None and tap.get("ops"):
        return [_substitute(op, choice) for op in tap["ops"]], dict(tap.get("x_statuses") or {})
    about, kind = ask.get("about"), ask.get("kind")
    if kind == "which_door":
        return [{"op": "link", "key": about, "door": choice}], {}
    if kind == "which_flag_is_goal":
        return [{"op": "set_role", "target": choice, "role": "goal"}], {}
    if kind == "is_library":
        return [], {}
    raise DraftError(400, "error.bad_request", {"field": "choice"})


@router.post("/drafts/{draft_id}/answers")
async def post_answer(draft_id: str, request: Request) -> Any:
    if (bad := _check(draft_id)) is not None:
        return bad
    try:
        body = AnswerBody.model_validate(await _body(request))
    except ValidationError:
        return err(400, "error.bad_request", {"field": "answer"})

    def mutate(s: dict[str, Any]) -> None:
        ask = next((a for a in s.get("asks") or [] if a.get("id") == body.ask_id), None)
        if ask is None:
            raise DraftError(404, "error.not_found", {"what": "ask"})
        ops, statuses = answer_ops(ask, body.choice)
        ask["answer"] = body.choice
        s.setdefault("answers", {})[body.ask_id] = body.choice
        if statuses:
            apply_statuses(s, statuses)
        if ops:
            add_kid_ops(s, ops, reason_key="kid.answer")

    return await _rebuild_and_save(draft_id, mutate)


@router.post("/drafts/{draft_id}/dial")
async def post_dial(draft_id: str, request: Request) -> Any:
    if (bad := _check(draft_id)) is not None:
        return bad
    try:
        body = DialBody.model_validate(await _body(request))
    except ValidationError:
        return err(400, "error.bad_request", {"field": "tier"})
    async with drafts.lock(draft_id):
        state = drafts.load_state(draft_id) or {}
        state["dial"] = body.tier
        drafts.save_state(draft_id, state)
    return {"tier": body.tier}


async def _later_build(draft_id: str, kind: str, telemetry: dict[str, Any] | None = None) -> JSONResponse:
    if drafts.load_current(draft_id) is None:
        return err(409, "error.not_found", {"what": "level"})
    if not await runner.preempt(draft_id):
        return err(409, "warning.design_late")
    build_id = drafts.new_build_id()
    state = drafts.load_state(draft_id) or {}
    runner.start(BuildRequest(build_id=build_id, draft_id=draft_id, kind=kind,  # type: ignore[arg-type]
                              dial=str(state.get("dial") or "polished"), band=state.get("band"), telemetry=telemetry,
                              game_id=state.get("game_id"), parent_id=state.get("parent_id")))
    return JSONResponse({"build_id": build_id, "draft_id": draft_id}, status_code=202)


@router.post("/drafts/{draft_id}/redesign", status_code=202)
async def post_redesign(draft_id: str) -> Any:
    if (bad := _check(draft_id)) is not None:
        return bad
    return await _later_build(draft_id, "redesign")


@router.post("/drafts/{draft_id}/critic", status_code=202)
async def post_critic(draft_id: str, request: Request) -> Any:
    if (bad := _check(draft_id)) is not None:
        return bad
    try:
        body = CriticBody.model_validate(await _body(request))
    except ValidationError:
        return err(400, "error.bad_request", {"field": "telemetry"})
    return await _later_build(draft_id, "critic", body.telemetry.model_dump(mode="json"))
