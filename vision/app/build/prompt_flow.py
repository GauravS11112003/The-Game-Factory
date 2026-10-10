"""Prompt-to-level (PLAN_V2 §8.3): text → beats → a verified blue-line draft the kid draws over.

    1. PLAN (model, effort low) → LevelPlan; offline / failed / over budget → the core's keyword planner
       (`keyword_plan` RPC), and if the core cannot answer, app.mind.plan.keyword_plan.
    2. Layout + verify + fix in the core: the `generate_level` RPC (B-2) clamps the beats, lays them out as blue-line
       `draft` strokes with `label` roles (so perception is exact and PERCEIVE is skipped), builds Faithful with
       repairs off, runs the bot, and applies the deterministic fixer (≤ 3 steps) before answering. It returns
       `solvable` and, when the draft still fails, `frontier_text` in plain words.
       When that RPC is unavailable (older core, stub mode), the same steps run here: `layout_plan`, a Faithful
       build, and the Python fixer (`app.mind.plan.fix_plan`).
    3. Unsolvable after the fixer → ONE PLAN retry with the bot's frontier in plain words, then the greedy repair
       (the normal build's repair search) in the Ink stage.
    4. The draft then goes through the ordinary Ink → Designed stages at the requested dial and band.

Events: `stage(upload done)`, `stage(cv start, note_key stage.plan)`, … `stage(cv done)`; then the normal stream.
"""
from __future__ import annotations

import copy
import logging
import time
from typing import Any

from app.build import drafts
from app.build.bridge import CoreError
from app.mind import client, sanitize
from app.mind import plan as mplan

log = logging.getLogger("dal.v2.prompt")

PLAN_STAGE_NOTE = "stage.plan"
CHECK_TIMEOUT_S = 15.0
GENERATE_TIMEOUT_S = 30.0  # B-2: up to 4 layouts + fast analyses + one full build


class PromptUnavailable(Exception):
    """The core cannot lay out plans yet (layout_plan not implemented or failing)."""


async def _keyword(run: Any, prompt: str, screens: int) -> tuple[dict[str, Any], str]:
    try:
        res = await run.rpc("keyword_plan", {"prompt": prompt, "screens": screens}, 2.0)
        plan = (res or {}).get("plan") if isinstance(res, dict) else None
        if isinstance(plan, dict) and plan.get("sections"):
            return mplan.sanitize_plan(plan, screens), "keywords"
    except CoreError as e:
        log.info("core keyword_plan unavailable (%s); using the Python keyword planner", e.code)
    return mplan.keyword_plan(prompt, screens), "keywords_py"


async def _layout(run: Any, plan: dict[str, Any], rules: dict[str, Any]) -> dict[str, Any]:
    try:
        res = await run.rpc("layout_plan", {"plan": plan, "rules": rules, "seed": int(run.state.get("seed") or 1)}, 4.0)
    except CoreError as e:
        raise PromptUnavailable(e.code) from None
    ink = (res or {}).get("ink") if isinstance(res, dict) else None
    if not isinstance(ink, dict) or not ink.get("strokes"):
        raise PromptUnavailable("empty_layout")
    ink = copy.deepcopy(ink)
    ink["source"] = "prompt"
    return ink


async def _check(run: Any, ink: dict[str, Any], rules: dict[str, Any]) -> dict[str, Any] | None:
    """The bot's report on the raw layout (Faithful, repairs off), or None when the core could not build it."""
    try:
        res = await run.rpc("build", {"ink": ink, "tier": "faithful", "edits": [], "rules": rules, "library": run.library,
                                      "parent": None, "repairUnsolvable": False, "seed": int(run.state.get("seed") or 1)},
                            CHECK_TIMEOUT_S)
    except CoreError as e:
        log.info("prompt draft check failed: %s", e)
        return None
    return (res or {}).get("report") if isinstance(res, dict) else None


def _solvable(report: dict[str, Any] | None) -> bool:
    return bool(report and report.get("solvable"))


class Generated:
    """One `generate_level` answer: the fixed plan, its draft ink, whether it was solvable as laid out."""

    def __init__(self, res: dict[str, Any]) -> None:
        self.plan: dict[str, Any] = res.get("plan") if isinstance(res.get("plan"), dict) else {}
        ink = copy.deepcopy(res.get("ink") or {})
        ink["source"] = "prompt"
        self.ink: dict[str, Any] = ink
        self.solvable = bool(res.get("solvable"))
        self.frontier_text: str | None = res.get("frontier_text") or None
        self.fixes: list[str] = [_fix_words(f) for f in res.get("fixes") or [] if isinstance(f, dict)]
        self.dropped: list[str] = [str(d) for d in res.get("dropped") or []]
        result = res.get("result") if isinstance(res.get("result"), dict) else {}
        self.report: dict[str, Any] | None = (result or {}).get("report")


def _fix_words(f: dict[str, Any]) -> str:
    """A PlanFix as a short trace line, e.g. `2.3 gap_too_wide: run_gap → rest`."""
    to = f.get("to")
    after = (to or {}).get("kind") if isinstance(to, dict) else "rest"
    before = (f.get("from") or {}).get("kind") if isinstance(f.get("from"), dict) else "?"
    return f"{f.get('beat', '?')} {f.get('why', '')}: {before} → {after}".strip()


async def _generate(run: Any, plan: dict[str, Any], rules: dict[str, Any]) -> Generated | None:
    """The core's whole §8.3 step 2-3 in one call; None when the core cannot answer (fall back to the local path)."""
    try:
        res = await run.rpc("generate_level", {"plan": plan, "rules": rules, "seed": int(run.state.get("seed") or 1),
                                               "tier": "faithful", "clamp": "band", "ink": "draft",
                                               "library": run.library}, GENERATE_TIMEOUT_S)
    except CoreError as e:
        log.info("core generate_level unavailable (%s: %s); using layout_plan + the Python fixer", e.code, e.message)
        return None
    if not isinstance(res, dict) or not (res.get("ink") or {}).get("strokes"):
        return None
    return Generated(res)


async def draft_ink(run: Any) -> dict[str, Any] | None:
    """Plan, lay out and verify the draft; returns its InkDoc (None after a fatal error event)."""
    req = run.req
    prompt = sanitize.text(req.prompt or "", 400)
    screens = max(1, min(6, int(req.screens or 1)))
    rules = run.rules()
    pp = mplan.prompt_params()
    run.stage("upload", "done")
    run.stage("cv", "start", PLAN_STAGE_NOTE)
    if not prompt:
        run.stage("cv", "failed")
        run.emit("error", {"message_key": "error.bad_request", "args": {"field": "prompt"}, "fatal": True})
        return None

    plan: dict[str, Any] | None = None
    source = "keywords"
    if run.model_on():
        deadline = min(run.deadline - 3, time.monotonic() + client.CALLS["plan"].timeout_s)
        r = await mplan.plan_level(prompt, screens, rules, draft_id=run.id, deadline=deadline)
        run.record(r)
        if r.status == "refused":
            run.mutate(lambda s: s.__setitem__("safety", "held"))
            run.warn("warning.safety_held")
        plan = mplan.plan_from_result(r, screens)
        if plan is not None:
            source = "model"
            if not plan.get("safety_ok", True):
                run.mutate(lambda s: s.__setitem__("safety", "flag"))
    if plan is None:
        plan, source = await _keyword(run, prompt, screens)
        if not plan.get("safety_ok", True):
            run.mutate(lambda s: s.__setitem__("safety", "flag"))

    fixes: list[str] = []
    retried = False
    gen = await _generate(run, plan, rules)
    if gen is not None:
        plan, ink, report = gen.plan or plan, gen.ink, gen.report
        fixes = list(gen.fixes)
        solvable = gen.solvable
        if (not solvable and source == "model" and run.model_on() and int(pp.get("plan_retries", 1)) > 0
                and run.elapsed() < float(run.settings.design_deadline_s) - 8):
            problem = gen.frontier_text or mplan.describe_failure(report or {}, plan, ink)
            deadline = min(run.deadline - 3, time.monotonic() + client.CALLS["plan"].timeout_s)
            r2 = await mplan.plan_level(prompt, screens, rules, draft_id=run.id, deadline=deadline,
                                        retry={"plan": plan, "problem": problem})
            run.record(r2)
            retried = True
            plan2 = mplan.plan_from_result(r2, screens)
            if plan2 is not None:
                gen2 = await _generate(run, plan2, rules)
                if gen2 is not None and (gen2.solvable or not solvable):
                    plan, ink, report, solvable = gen2.plan or plan2, gen2.ink, gen2.report, gen2.solvable
                    fixes = fixes + gen2.fixes
        _finish_plan(run, prompt, screens, plan, source, fixes, retried, solvable, gen.dropped)
        return ink

    try:
        ink = await _layout(run, plan, rules)
    except PromptUnavailable as e:
        log.warning("prompt-to-level: layout unavailable (%s)", e)
        run.stage("cv", "failed")
        run.emit("error", {"message_key": "error.not_implemented", "args": {"route": "layout_plan"}, "fatal": True})
        return None
    report = await _check(run, ink, rules)

    while report is not None and not _solvable(report) and len(fixes) < int(pp.get("fixer_max", 3)):
        step = mplan.fix_plan(plan, report, ink)
        if step is None:
            break
        cand, what = step
        try:
            cand_ink = await _layout(run, cand, rules)
        except PromptUnavailable:
            break
        plan, ink, fixes = cand, cand_ink, fixes + [what]
        report = await _check(run, ink, rules)

    if (report is not None and not _solvable(report) and source == "model" and run.model_on()
            and int(pp.get("plan_retries", 1)) > 0 and run.elapsed() < float(run.settings.design_deadline_s) - 8):
        problem = mplan.describe_failure(report, plan, ink)
        deadline = min(run.deadline - 3, time.monotonic() + client.CALLS["plan"].timeout_s)
        r2 = await mplan.plan_level(prompt, screens, rules, draft_id=run.id, deadline=deadline,
                                    retry={"plan": plan, "problem": problem})
        run.record(r2)
        retried = True
        plan2 = mplan.plan_from_result(r2, screens)
        if plan2 is not None:
            try:
                ink2 = await _layout(run, plan2, rules)
                report2 = await _check(run, ink2, rules)
                if report2 is not None and (_solvable(report2) or not _solvable(report)):
                    plan, ink, report = plan2, ink2, report2
            except PromptUnavailable:
                pass
    # still unsolvable: the normal build's repair search (greedy repair) takes over in the Ink stage
    _finish_plan(run, prompt, screens, plan, source, fixes, retried, _solvable(report), [])
    return ink


def _finish_plan(run: Any, prompt: str, screens: int, plan: dict[str, Any], source: str, fixes: list[str],
                 retried: bool, solvable: bool, dropped: list[str]) -> None:
    """Persist the plan and its trace (plan.json, state.level_plan) and close the PLAN stage."""
    title = sanitize.text(plan.get("title"), 40) or None
    info = {"prompt": prompt, "screens": screens, "source": source, "fixes": fixes, "retried": retried,
            "solvable_raw": solvable, "band": plan.get("band"), "kid_summary": plan.get("kid_summary"),
            "dropped": dropped}
    drafts.write_json(run.id, "plan.json", {"plan": plan, **info})

    def f(s: dict[str, Any]) -> None:
        s["prompt"] = prompt
        s["level_plan"] = info
        s["title"] = s.get("title") or title
        if not s.get("game_id") and plan.get("theme"):
            rr = dict(s.get("rules") or {})
            rr["theme"] = plan["theme"]
            s["rules"] = rr

    run.mutate(f)
    run.stage("cv", "done")
