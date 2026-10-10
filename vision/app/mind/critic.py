"""CRITIC (PLAN_V2 §3.8, §3.10): on demand ("Why is this hard?", or offered after 5 deaths in one segment).

Input: the bot's report for the tier being played, the creator's own telemetry (death positions, causes, frames,
attempts, segment times) and a menu restricted to the struggling segment (easier fairness fixes and harder
variants). Output: ≤ 3 observations in kid words and ≤ 3 picks, which the orchestrator validates through the
core and shows as `suggestions`. Never judges the child's skill.

`offline_critique` is the model-off floor: the segment with the most deaths and its fairness fixes (checkpoint,
coin trail, flag fixes) from the menu, cheapest intent cost first.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
from typing import Any

from app.mind import client, sanitize
from app.mind import schemas as ms
from app.mind.design import DesignCtx, PlanOut
from app.mind.digest import DesignDigest

FAIRNESS_GENERATORS = ("fix_flag", "checkpoint", "trail")
CRITIC_MAX_PICKS = 3


@dataclass
class Struggle:
    segment: str | None
    deaths: int
    causes: Counter[str]
    attempts: int


def struggle(telemetry: dict[str, Any]) -> Struggle:
    deaths = telemetry.get("deaths") or []
    by_seg = Counter(str(d.get("segment") or "") for d in deaths)
    seg = by_seg.most_common(1)[0][0] if by_seg else None
    causes = Counter(str(d.get("cause") or "unknown") for d in deaths if str(d.get("segment") or "") == seg)
    return Struggle(segment=seg or None, deaths=by_seg.get(seg or "", 0), causes=causes,
                    attempts=int(telemetry.get("attempts") or 0))


def slot_segments(result: dict[str, Any]) -> dict[str, str]:
    out: dict[str, str] = {}
    for group in ((result.get("report") or {}).get("slots") or {}).values():
        for s in group or []:
            if isinstance(s, dict) and s.get("id") and s.get("segment"):
                out[s["id"]] = s["segment"]
    return out


def _op_slot(op: dict[str, Any]) -> str | None:
    v = op.get("slot") or op.get("action")
    return v if isinstance(v, str) else None


def segment_menu(menu: list[dict[str, Any]], result: dict[str, Any], segment: str | None) -> list[dict[str, Any]]:
    """Candidates whose slot lies in `segment`, plus candidates with no slot (object targets) — the menu
    'restricted to that segment' (§3.8). The whole menu when the segment is unknown."""
    if not segment:
        return list(menu)
    seg_of = slot_segments(result)
    route_seg = {f"r{s.get('i')}": s.get("segment") for s in (result.get("report") or {}).get("route") or []}
    out = []
    for c in menu:
        slot = _op_slot(c.get("op") or {})
        if slot is None:
            out.append(c)
            continue
        if seg_of.get(slot, route_seg.get(slot)) == segment:
            out.append(c)
    return out


def telemetry_text(t: dict[str, Any], s: Struggle) -> str:
    deaths = t.get("deaths") or []
    by_seg: dict[str, Counter[str]] = {}
    where: dict[str, list[str]] = {}
    for d in deaths:
        seg = str(d.get("segment") or "?")
        by_seg.setdefault(seg, Counter())[str(d.get("cause") or "unknown")] += 1
        where.setdefault(seg, []).append(f"x≈{float(d.get('x', 0)):.0f}")
    lines = [f"attempts {s.attempts}; deaths {len(deaths)}"]
    for seg, causes in sorted(by_seg.items(), key=lambda kv: -sum(kv[1].values())):
        lines.append(f"{seg}: " + ", ".join(f"{c} ×{n}" for c, n in causes.most_common())
                     + f" ({', '.join(sorted(set(where.get(seg, [])))[:6])})")
    times = t.get("segment_times") or {}
    if times:
        lines.append("segment times: " + ", ".join(f"{k} {float(v):.1f} s" for k, v in times.items()))
    if s.segment:
        lines.append(f"most deaths in: {s.segment}")
    return "\n".join(lines)


async def critic(dig: DesignDigest, telemetry: dict[str, Any], ctx: DesignCtx) -> tuple[PlanOut, dict[str, Any] | None]:
    """§11.3d `critic`: returns (PlanOut with a picks-only plan, {observations, note}). Never raises."""
    s = struggle(telemetry)
    text = (
        f"LEVEL DIGEST (the tier the child is playing)\n{dig.level_digest}\n\nTELEMETRY\n{telemetry_text(telemetry, s)}\n\n"
        f"ALTS GROUPS (pick at most one per group)\n{dig.alts_text()}\n\n"
        f"MENU FOR THIS SEGMENT (cid · summary · tiers · dC · dT · cost · fixes)\n{dig.menu_rows or '(empty)'}\n\n"
        "Explain where and why the child falls, and suggest up to 3 changes."
    )
    r = await client.call("critic", ms.Critique, [{"type": "text", "text": text}], draft_id=ctx.draft_id,
                          deadline=ctx.deadline)
    out = PlanOut(result=r)
    if not r.ok or r.value is None:
        return out, None
    try:
        crit, dropped = sanitize.sanitize_critique(r.value, dig.index)
    except Exception as e:  # noqa: BLE001
        out.result = r.model_copy(update={"status": "failed", "error": f"sanitize: {type(e).__name__}: {e}"[:300]})
        return out, None
    out.plan, out.dropped = crit["plan"], dropped
    return out, {"observations": crit["observations"], "note": crit["note"]}


def offline_critique(menu: list[dict[str, Any]], telemetry: dict[str, Any]) -> dict[str, Any]:
    """Model-off CRITIC: fairness fixes for the struggling segment, cheapest first, as a picks-only plan."""
    fair = [c for c in menu if c.get("generator") in FAIRNESS_GENERATORS]
    fair.sort(key=lambda c: (float(c.get("intent_cost", 1) or 1), -abs(float(c.get("dF_s", 0) or 0))))
    picks, used = [], set()
    for c in fair:
        if c.get("alts") and c["alts"] in used:
            continue
        tiers = [t for t in c.get("tiers") or [] if t != "faithful"] or ["polished"]
        picks.append({"cid": c["cid"], "tier": tiers[0], "reason": ""})
        if c.get("alts"):
            used.add(c["alts"])
        if len(picks) >= CRITIC_MAX_PICKS:
            break
    return {"repair_choices": [], "vetoes": [], "picks": picks, "novel": [], "asks": [], "designer_note": "",
            "critique": [], "title": None}

