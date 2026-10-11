"""PLAN (PLAN_V2 §8.3, §3.10): a child's text → a LevelPlan of beats from the fixed catalogue. The model chooses pacing
and content; code (the core's `layoutPlan`) chooses the exact geometry and the bot proves it.

    plan_level(prompt, screens, rules, …)   the model call (effort low, 6000 tokens, 20 s); never raises
    sanitize_plan(plan, screens)            structure + integer clamps by band (params.json PROMPT_LEVEL.clamps)
    keyword_plan(prompt, screens)           offline planner (only when the core's `keyword_plan` RPC is unavailable)
    fix_plan(plan, report, ink)             one deterministic fixer step on the failing beat (≤ 3 per build)
    describe_failure(report, plan, ink)     the bot's frontier in plain words, for the single PLAN retry

Beat positions come from `ink.x_beats` ([{section, beat, x0, x1}]) when present, else from the draft strokes' own
`x_beat: "<section>.<beat>"` tags (layoutPlan writes them), else they are estimated from the beat sizes the same way the
layout stretches flats and rests to fill 48·screens.
"""
from __future__ import annotations

import copy
import hashlib
import json
import re
import time
from typing import Any

from pydantic import ValidationError

from app.config import SHARED_DIR
from app.mind import client, moderate, sanitize
from app.mind import schemas as ms
from app.mind.client import MindResult
from app.spec.plan import LevelPlan

SCREEN_W = 48
GROUND_ROW = 22
TITLE_CHARS = 40
SUMMARY_CHARS = 160
MAX_BEATS_PER_SCREEN = 12
MIN_BEATS_PER_SCREEN = 3
SPAWN_PAD = 6  # cells of flat ground the layout keeps at the start (spawn at x = 2)
GOAL_PAD = 4

BANDS = ("easy", "normal", "hard")
THEMES = ("sketchbook", "notebook", "graph", "kraft")

# Fallbacks for shared/spec/params.json PROMPT_LEVEL.clamps (§8.3 table)
_FALLBACK_CLAMPS: dict[str, Any] = {
    "gap_width": {"easy": [2, 4], "normal": [4, 6], "hard": [6, 8]},
    "step_rise": {"easy": [1, 2], "normal": [2, 3], "hard": [3, 4]},
    "spacing": {"easy": [2, 3], "normal": [3, 4], "hard": [4, 6]},
    "tower_rise": {"easy": [3, 3], "normal": [3, 3], "hard": [3, 4]},
}
# Clamps the §8.3 table leaves open (code's choice; kept inside the v2-standard envelope)
_EXTRA = {
    "flat_length": (2, 24), "flat_coins": (0, 7), "step_length": (3, 16), "stairs_n": (2, 6), "stairs_run": (2, 6),
    "pillars_n": (2, 6), "floaters_n": (2, 6), "floaters_dy": (-3, 3), "ceiling_length": (4, 20),
    "ceiling_headroom": (2, 5), "wall_height": {"easy": (2, 3), "normal": (2, 4), "hard": (3, 4)},
    "bridge_gap": {"easy": (4, 6), "normal": (6, 10), "hard": (8, 12)}, "crumble_n": {"easy": (2, 3), "normal": (3, 5), "hard": (4, 7)},
    "saw_length": (6, 20), "saws": {"easy": (1, 1), "normal": (1, 2), "hard": (2, 4)}, "tower_tiers": (2, 5),
    "gauntlet_n": {"easy": (1, 1), "normal": (1, 2), "hard": (2, 4)}, "spring_height": (4, 10), "rest_length": (3, 12),
}
GAUNTLET_ARCHETYPES = {"easy": ("walker",), "normal": ("walker", "hopper"),
                       "hard": ("walker", "hopper", "flyer", "shooter", "chaser", "crusher")}
BRIDGE_SPEEDS = {"easy": ("slow",), "normal": ("slow", "normal"), "hard": ("slow", "normal", "fast")}
FLAT_ENEMIES = {"easy": ("none", "walker"), "normal": ("none", "walker", "hopper"), "hard": ("none", "walker", "hopper", "chaser")}
OBSTACLES = {"gap", "step", "stairs", "pillars", "floaters", "ceiling", "wall", "moving_bridge", "crumble_run",
             "saw_corridor", "tower", "enemy_gauntlet", "spring_up", "key", "door"}
BLOCKING_WORDS = {
    "gap_too_wide": "jump over the gap", "ledge_too_high": "climb up the ledge", "wall_too_tall": "wall",
    "head_bonk": "jump under the low ceiling", "key_unreachable": "way to the key", "spawn_trapped": "start",
    "goal_unreachable": "way to the goal", "hard_flag": "unfair spot",
}


def _clamps() -> dict[str, Any]:
    return {**_FALLBACK_CLAMPS, **((sanitize.params().get("PROMPT_LEVEL") or {}).get("clamps") or {})}


def prompt_params() -> dict[str, Any]:
    return {"fixer_max": 3, "plan_retries": 1, "keyword_budget_s": 2, **(sanitize.params().get("PROMPT_LEVEL") or {})}


def _rng(band: str, key: str) -> tuple[int, int]:
    v = _clamps().get(key) or _FALLBACK_CLAMPS[key]
    lo, hi = v.get(band) or v.get("normal")
    return int(lo), int(hi)


def _extra(key: str, band: str) -> tuple[int, int]:
    v = _EXTRA[key]
    if isinstance(v, dict):
        return v.get(band) or v["normal"]
    return v


def _cl(v: Any, lo: int, hi: int) -> int:
    return sanitize.clamp(v, lo, hi)


# ---- the envelope and the catalogue (model input) --------------------------------------------------------------


def _profiles() -> dict[str, Any]:
    try:
        return json.loads((SHARED_DIR / "spec" / "physics-profiles.json").read_text(encoding="utf-8")).get("profiles") or {}
    except (OSError, json.JSONDecodeError):
        return {}


def envelope_text(rules: dict[str, Any]) -> str:
    pid = rules.get("physics_profile") or "v2-standard"
    env = (_profiles().get(pid) or _profiles().get("v2-standard") or {}).get("envelope") or {}
    apex = env.get("apex_c") or {"stand": 3.86, "walk": 4.45, "run": 4.92}
    dist = env.get("dist_c") or {"walk": 4.9, "run": 9.1}
    ab = rules.get("abilities") or {}
    der = sanitize.params().get("DERIVED") or {}
    runway = der.get("run_gap_runway_c", 3)
    lines = [f"Physics profile {pid}. Heights and distances in cells (1 cell = 16 px; a screen is 48 x 27 cells)."]
    lines.append(f"Standing jump reaches {apex.get('stand')} cells high; walking jump {apex.get('walk')} high and "
                 f"{dist.get('walk')} far.")
    if ab.get("run", True) and apex.get("run"):
        lines.append(f"Running jump reaches {apex.get('run')} high and {dist.get('run')} far, but only with at least "
                     f"{runway} cells of run-up. Gaps of 1-4 cells are walk-gaps; 5-8 need a run-up.")
    else:
        lines.append("Running is OFF in this game: every gap must be a walk-gap (at most 4 cells).")
    if ab.get("double_jump"):
        dj = ((sanitize.params().get("ABILITIES") or {}).get("double_jump") or {}).get("reach") or {}
        lines.append(f"Double jump is ON: about {dj.get('walking_high_c', 6.7)} cells high when walking.")
    if not ab.get("stomp", True):
        lines.append("Stomping is OFF: enemies cannot be squashed, only avoided.")
    return "\n".join(lines)


def catalogue_text() -> str:
    c = _clamps()
    g, s, sp, tr = c["gap_width"], c["step_rise"], c["spacing"], c["tower_rise"]

    def r(v: dict[str, Any]) -> str:
        return ", ".join(f"{b} {v[b][0]}-{v[b][1]}" for b in BANDS if b in v)

    return "\n".join([
        "BEAT CATALOGUE (use only these kinds and fields):",
        "- flat {length, enemy: none|walker|hopper|chaser, coins, spikes: none|middle|far_end}: ground to run on.",
        f"- gap {{width, floor: void|spikes|lava}}: a pit to jump. width by band: {r(g)}; width 5+ gets a run-up.",
        f"- step {{rise, length}}: a ledge up (rise > 0) or down. rise by band: {r(s)}.",
        "- stairs {n, rise, run}: n steps of rise cells every run cells.",
        f"- pillars {{n, spacing, hazard: void|spikes|lava}}: posts to hop across. spacing by band: {r(sp)}.",
        "- floaters {n, dy, spacing, oneway}: floating platforms, each dy rows above the last (negative goes down).",
        "- ceiling {length, spikes, headroom}: a low roof; with spikes the jumps must stay low.",
        "- wall {height, spikes: none|near_face}: a wall to jump over (height 2-4).",
        "- moving_bridge {gap, speed: slow|normal|fast, vertical}: a moving platform carries you over a gap or up.",
        "- crumble_run {n, floor: void|shallow}: platforms that crumble after you step on them; keep moving.",
        "- saw_corridor {length, saws}: spinning saws to time your way past.",
        f"- tower {{tiers, rise, oneway}}: a climb of ledges. rise by band: {r(tr)}.",
        "- enemy_gauntlet {archetype: walker|hopper|flyer|shooter|chaser|crusher, n}: a run of enemies "
        "(easy: 1 walker; normal: 2 walkers or 1 hopper; hard: 2-4 of any kind).",
        "- spring_up {height}: a spring launches you up to a higher ledge.",
        "- key {place: high|guarded|alcove} and door {}: the key always comes before its door.",
        "- rest {length}: a calm stretch to breathe. checkpoint {}: a respawn flag. goal {style: flag|staircase}: the end.",
    ])


def rules_text(rules: dict[str, Any]) -> str:
    ab = rules.get("abilities") or {}
    on = [k.replace("_", " ") for k in ("run", "stomp", "double_jump", "fast_fall") if ab.get(k, k in ("run", "stomp", "fast_fall"))]
    lives = rules.get("lives", "off")
    return (f"Game rules: abilities {', '.join(on) or 'none'}; lives {lives}; hearts {rules.get('hearts', 1)}; "
            f"theme {rules.get('theme', 'sketchbook')}.")


def plan_content(prompt: str, screens: int, rules: dict[str, Any], retry: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    w = SCREEN_W * screens
    lo, hi = MIN_BEATS_PER_SCREEN * screens + 2, 8 * screens + 2
    text = (
        f"THE CHILD'S PROMPT: {sanitize.text(prompt, 400)!r}\n\n"
        f"SCREENS: {screens} (the level is {w} cells wide and 27 tall; the main ground is row {GROUND_ROW}).\n"
        f"{rules_text(rules)}\n\nPHYSICS ENVELOPE\n{envelope_text(rules)}\n\n{catalogue_text()}\n\n"
        f"SIZE: about {lo}-{hi} beats in total, flats and rests included. Code stretches flats and rests to fill "
        f"the {screens} screen(s), clamps every number to the band and inserts checkpoints.\n"
        "Return the level plan."
    )
    if retry:
        text += (
            "\n\nYOUR PREVIOUS PLAN could not be finished by the playtest bot.\n"
            f"Previous plan: {json.dumps(retry.get('plan'), separators=(',', ':'))[:6000]}\n"
            f"What went wrong: {retry.get('problem')}\n"
            "Return a corrected plan that keeps the child's idea and stays inside the envelope."
        )
    context = rules.get("x_creation_context")
    if isinstance(context, list):
        text += "\n\nGAME DESIGN CONTEXT:\n" + "\n".join(sanitize.text(line, 600) for line in context[:5])
    if rules.get("guidance"):
        text += "\n\nRESOLVED AUTHOR GUIDANCE:\n" + json.dumps(rules["guidance"])
        text += "\nUse the listed components and mechanics. Explicit author constraints override reference defaults."
    return [{"type": "text", "text": text}]


async def plan_level(prompt: str, screens: int, rules: dict[str, Any], *, draft_id: str | None,
                     deadline: float | None = None, retry: dict[str, Any] | None = None) -> MindResult[Any]:
    """§11.3d `plan_level`: never raises. The model answers the flat form (`schemas.LevelPlanFlat`); the value is the
    unflattened LevelPlan dict, still to be sanitized with `sanitize_plan`."""
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS["plan"].timeout_s
    try:
        content = plan_content(prompt, screens, rules, retry)
    except Exception as e:  # noqa: BLE001
        return MindResult[ms.LevelPlanFlat](kind="plan", status="failed", error=f"content: {e}"[:300])
    return await client.call("plan", ms.LevelPlanFlat, content, draft_id=draft_id, deadline=dl)


def plan_from_result(r: MindResult[Any], screens: int) -> dict[str, Any] | None:
    """The sanitized LevelPlan of an ok PLAN result (None otherwise)."""
    if not r.ok or r.value is None:
        return None
    try:
        return sanitize_plan(ms.unflatten_plan(r.value), screens)
    except Exception:  # noqa: BLE001
        return None


# ---- sanitizing (structure + clamps) ---------------------------------------------------------------------------


def _clamp_beat(b: dict[str, Any], band: str) -> dict[str, Any] | None:
    k = b.get("kind")
    o = dict(b)
    if k == "flat":
        o["length"] = _cl(o.get("length"), *_extra("flat_length", band))
        o["coins"] = _cl(o.get("coins"), *_extra("flat_coins", band))
        if o.get("enemy") not in FLAT_ENEMIES[band]:
            o["enemy"] = "walker" if o.get("enemy") not in (None, "none") else "none"
        if o.get("spikes") not in ("none", "middle", "far_end"):
            o["spikes"] = "none"
    elif k == "gap":
        o["width"] = _cl(o.get("width"), *_rng(band, "gap_width"))
        if o.get("floor") not in ("void", "spikes", "lava"):
            o["floor"] = "void"
    elif k == "step":
        lo, hi = _rng(band, "step_rise")
        rise = sanitize.clamp(o.get("rise"), -hi, hi)
        o["rise"] = rise if abs(rise) >= lo else (lo if rise >= 0 else -lo)
        o["length"] = _cl(o.get("length"), *_extra("step_length", band))
    elif k == "stairs":
        o["n"] = _cl(o.get("n"), *_extra("stairs_n", band))
        lo, hi = _rng(band, "step_rise")
        rise = sanitize.clamp(o.get("rise"), -hi, hi)
        o["rise"] = rise if abs(rise) >= 1 else 1
        o["run"] = _cl(o.get("run"), *_extra("stairs_run", band))
    elif k == "pillars":
        o["n"] = _cl(o.get("n"), *_extra("pillars_n", band))
        o["spacing"] = _cl(o.get("spacing"), *_rng(band, "spacing"))
        if o.get("hazard") not in ("void", "spikes", "lava"):
            o["hazard"] = "void"
    elif k == "floaters":
        o["n"] = _cl(o.get("n"), *_extra("floaters_n", band))
        o["dy"] = sanitize.clamp(o.get("dy"), *_extra("floaters_dy", band))
        o["spacing"] = _cl(o.get("spacing"), *_rng(band, "spacing"))
        o["oneway"] = bool(o.get("oneway", True))
    elif k == "ceiling":
        o["length"] = _cl(o.get("length"), *_extra("ceiling_length", band))
        o["headroom"] = _cl(o.get("headroom"), *_extra("ceiling_headroom", band))
        o["spikes"] = bool(o.get("spikes", False))
    elif k == "wall":
        o["height"] = _cl(o.get("height"), *_extra("wall_height", band))
        if o.get("spikes") not in ("none", "near_face"):
            o["spikes"] = "none"
    elif k == "moving_bridge":
        o["gap"] = _cl(o.get("gap"), *_extra("bridge_gap", band))
        if o.get("speed") not in BRIDGE_SPEEDS[band]:
            o["speed"] = BRIDGE_SPEEDS[band][-1]
        o["vertical"] = bool(o.get("vertical", False))
    elif k == "crumble_run":
        o["n"] = _cl(o.get("n"), *_extra("crumble_n", band))
        if o.get("floor") not in ("void", "shallow"):
            o["floor"] = "shallow" if band == "easy" else "void"
        if band == "easy":
            o["floor"] = "shallow"  # teach crumbles over a safe pit
    elif k == "saw_corridor":
        o["length"] = _cl(o.get("length"), *_extra("saw_length", band))
        o["saws"] = _cl(o.get("saws"), *_extra("saws", band))
    elif k == "tower":
        o["tiers"] = _cl(o.get("tiers"), *_extra("tower_tiers", band))
        o["rise"] = _cl(o.get("rise"), *_rng(band, "tower_rise"))
        o["oneway"] = bool(o.get("oneway", True))
    elif k == "enemy_gauntlet":
        if o.get("archetype") not in GAUNTLET_ARCHETYPES[band]:
            o["archetype"] = "walker"
        lo, hi = _extra("gauntlet_n", band)
        if band == "normal" and o["archetype"] == "hopper":
            hi = 1
        o["n"] = _cl(o.get("n"), lo, hi)
    elif k == "spring_up":
        o["height"] = _cl(o.get("height"), *_extra("spring_height", band))
    elif k == "key":
        if o.get("place") not in ("high", "guarded", "alcove"):
            o["place"] = "alcove"
    elif k == "rest":
        o["length"] = _cl(o.get("length"), *_extra("rest_length", band))
    elif k == "goal":
        if o.get("style") not in ("flag", "staircase"):
            o["style"] = "flag"
    elif k not in ("door", "checkpoint"):
        return None
    return o


def sanitize_plan(plan: Any, screens: int, *, band: str | None = None) -> dict[str, Any]:
    """A LevelPlan dict that layoutPlan can always lay out: screens = the requested count, ≤ 12 beats per screen,
    every integer clamped to its band, a key before its door (a door with no key is dropped, a key with no door gets
    one before the goal), exactly one goal at the very end, free text cut to size."""
    p = plan.model_dump(mode="json") if hasattr(plan, "model_dump") else copy.deepcopy(plan or {})
    screens = max(1, min(6, int(screens or 1)))
    b = band if band in BANDS else (p.get("band") if p.get("band") in BANDS else "normal")
    title = sanitize.text(p.get("title"), TITLE_CHARS) or "My level"
    if moderate.blocklist_hit([title]):
        title = "My level"
    out_sections: list[dict[str, Any]] = []
    budget = MAX_BEATS_PER_SCREEN * screens
    keys_open = 0
    goal: dict[str, Any] | None = None
    for sec in p.get("sections") or []:
        if not isinstance(sec, dict):
            continue
        role = sec.get("role") if sec.get("role") in ("teach", "test", "twist", "finale", "rest") else "test"
        beats: list[dict[str, Any]] = []
        for raw in sec.get("beats") or []:
            if not isinstance(raw, dict) or budget <= 0:
                continue
            if raw.get("kind") == "goal":
                goal = goal or _clamp_beat(raw, b)
                continue
            beat = _clamp_beat(raw, b)
            if beat is None:
                continue
            if beat["kind"] == "key":
                keys_open += 1
            elif beat["kind"] == "door":
                if keys_open <= 0:
                    continue  # a door nobody can open
                keys_open -= 1
            beats.append(beat)
            budget -= 1
        if beats:
            out_sections.append({"role": role, "beats": beats})
    if not out_sections:
        out_sections = [{"role": "teach", "beats": [{"kind": "flat", "length": 12, "enemy": "none", "coins": 3, "spikes": "none"}]}]
    last = out_sections[-1]["beats"]
    for _ in range(keys_open):
        last.append({"kind": "rest", "length": 4})
        last.append({"kind": "door"})
    last.append(goal or {"kind": "goal", "style": "flag"})
    theme = p.get("theme") if p.get("theme") in THEMES else "sketchbook"
    summary = sanitize.text(p.get("kid_summary"), SUMMARY_CHARS) or "Run, jump and reach the flag!"
    out = {"title": title, "theme": theme, "screens": screens, "band": b, "sections": out_sections,
           "kid_summary": summary, "safety_ok": bool(p.get("safety_ok", True))}
    try:
        return LevelPlan.model_validate(out).model_dump(mode="json")
    except ValidationError:
        return out


# ---- beat positions --------------------------------------------------------------------------------------------


def _nominal_width(b: dict[str, Any]) -> tuple[float, bool]:
    """(width in cells, stretchable) of one beat as the layout lays it out before stretching."""
    k = b.get("kind")
    n = lambda f, d=0: float(b.get(f) or d)  # noqa: E731
    if k == "flat":
        return max(2.0, n("length", 8)), True
    if k == "rest":
        return max(2.0, n("length", 4)), True
    if k == "gap":
        return n("width", 3) + 2, False
    if k == "step":
        return max(3.0, n("length", 6)), False
    if k == "stairs":
        return n("n", 3) * n("run", 3), False
    if k == "pillars":
        return n("n", 3) * (n("spacing", 3) + 1) + 1, False
    if k == "floaters":
        return n("n", 3) * (n("spacing", 3) + 3) + 1, False
    if k == "ceiling":
        return n("length", 8), False
    if k == "wall":
        return 4.0, False
    if k == "moving_bridge":
        return n("gap", 6) + 4, False
    if k == "crumble_run":
        return n("n", 3) * 4.0, False
    if k == "saw_corridor":
        return n("length", 10), False
    if k == "tower":
        return n("tiers", 3) * 5.0, False
    if k == "enemy_gauntlet":
        return n("n", 2) * 7.0, False
    if k == "spring_up":
        return 6.0, False
    if k == "key":
        return 6.0, False
    if k == "door":
        return 3.0, False
    if k == "goal":
        return float(GOAL_PAD), False
    return 0.0, False


def beat_spans(plan: dict[str, Any], ink: dict[str, Any] | None = None) -> list[tuple[int, int, float, float]]:
    """(section, beat, x0, x1) for every beat, left to right."""
    xb = (ink or {}).get("x_beats")
    if isinstance(xb, list) and xb:
        out = []
        for e in xb:
            try:
                out.append((int(e["section"]), int(e["beat"]), float(e["x0"]), float(e["x1"])))
            except (KeyError, TypeError, ValueError):
                continue
        if out:
            return sorted(out, key=lambda t: (t[2], t[0], t[1]))
    # layoutPlan tags every draft stroke with the beat it draws (`x_beat: "<section>.<beat>"`, 0-based)
    ext: dict[tuple[int, int], list[float]] = {}
    for st in (ink or {}).get("strokes") or []:
        addr = st.get("x_beat") if isinstance(st, dict) else None
        m = re.match(r"^(\d+)\.(\d+)$", str(addr or ""))
        xs = [float(p[0]) for p in st.get("pts") or [] if isinstance(p, (list, tuple)) and p] if m else []
        if not xs:
            continue
        key = (int(m.group(1)), int(m.group(2)))
        e = ext.setdefault(key, [min(xs), max(xs)])
        e[0], e[1] = min(e[0], min(xs)), max(e[1], max(xs))
    beats = [(si, bi, b) for si, s in enumerate(plan.get("sections") or []) for bi, b in enumerate(s.get("beats") or [])]
    if ext:
        # beats that draw nothing of their own (a void gap) sit between their neighbours' extents
        out2: list[tuple[int, int, float, float]] = []
        known = [(k, ext[k]) for k in ((si, bi) for si, bi, _ in beats) if k in ext]
        for idx, (si, bi, b) in enumerate(beats):
            if (si, bi) in ext:
                x0, x1 = ext[(si, bi)]
            else:
                prev = [e for (k, e) in known if k < (si, bi)]
                nxt = [e for (k, e) in known if k > (si, bi)]
                x0 = prev[-1][1] if prev else float(SPAWN_PAD)
                x1 = nxt[0][0] if nxt else x0 + _nominal_width(b)[0]
                if x1 <= x0:
                    x1 = x0 + max(1.0, _nominal_width(b)[0])
            out2.append((si, bi, x0, x1))
        return out2

    widths = [_nominal_width(b) for _, _, b in beats]
    total_w = SCREEN_W * int(plan.get("screens") or 1)
    fixed = sum(w for w, st in widths if not st)
    stretch = [w for w, st in widths if st]
    room = total_w - SPAWN_PAD - fixed
    scale = (room / sum(stretch)) if stretch and sum(stretch) > 0 and room > 0 else 1.0
    x = float(SPAWN_PAD)
    out = []
    for (si, bi, _), (w, st) in zip(beats, widths):
        ww = w * scale if st else w
        out.append((si, bi, x, x + ww))
        x += ww
    return out


def _failing_beat(plan: dict[str, Any], report: dict[str, Any], ink: dict[str, Any] | None) -> tuple[int, int] | None:
    fr = (report or {}).get("frontier") or {}
    blk = fr.get("blocking") or {}
    x: float | None = None
    src = blk.get("from") or blk.get("from_")
    if isinstance(src, (list, tuple)) and src:
        x = float(src[0])
    elif fr.get("reached"):
        try:
            x = max(float(p[0]) for p in fr["reached"])
        except (TypeError, ValueError, IndexError):
            x = None
    spans = beat_spans(plan, ink)
    if not spans:
        return None
    sections = plan.get("sections") or []

    def kind(si: int, bi: int) -> str:
        try:
            return str(sections[si]["beats"][bi].get("kind"))
        except (IndexError, KeyError, AttributeError):
            return ""

    if x is None:
        # no frontier: the hardest-looking obstacle
        obst = [(si, bi) for si, bi, _, _ in spans if kind(si, bi) in OBSTACLES]
        return obst[0] if obst else None
    if blk.get("kind") == "key_unreachable":
        for si, bi, _, _ in spans:
            if kind(si, bi) == "key":
                return si, bi
    # the first obstacle that ends past the point the bot reached (the thing in front of it)
    for si, bi, x0, x1 in spans:
        if x1 > x + 0.5 and kind(si, bi) in OBSTACLES:
            return si, bi
    return None


def describe_failure(report: dict[str, Any], plan: dict[str, Any], ink: dict[str, Any] | None) -> str:
    """'the jump over the gap in section 2 beat 3 (gap) needs 9 cells; the most it can do is 8'."""
    blk = ((report or {}).get("frontier") or {}).get("blocking") or {}
    where = _failing_beat(plan, report, ink)
    what = BLOCKING_WORDS.get(str(blk.get("kind")), "next part")
    loc = ""
    if where is not None:
        si, bi = where
        try:
            k = plan["sections"][si]["beats"][bi].get("kind")
        except (IndexError, KeyError):
            k = "?"
        loc = f" in section {si + 1} beat {bi + 1} ({k})"
    need, have = blk.get("need"), blk.get("have")
    if need and have:
        return f"the {what}{loc} needs {need}; the most the player can do is {have}"
    if (report or {}).get("reason") == "no_goal":
        return "the plan has no reachable goal"
    return f"the player gets stuck at the {what}{loc}"


# ---- the deterministic fixer (§8.3 step 3) ---------------------------------------------------------------------

_SHRINK = {  # beat kind → (field, kind of clamp: "band:<key>" or "extra:<key>")
    "gap": ("width", "band:gap_width"), "step": ("rise", "band:step_rise"), "stairs": ("rise", "band:step_rise"),
    "pillars": ("spacing", "band:spacing"), "floaters": ("spacing", "band:spacing"), "tower": ("rise", "band:tower_rise"),
    "wall": ("height", "extra:wall_height"), "moving_bridge": ("gap", "extra:bridge_gap"),
    "crumble_run": ("n", "extra:crumble_n"), "saw_corridor": ("saws", "extra:saws"),
    "enemy_gauntlet": ("n", "extra:gauntlet_n"), "spring_up": ("height", "extra:spring_height"),
    "ceiling": ("headroom", "grow:ceiling_headroom"),
}


def fix_plan(plan: dict[str, Any], report: dict[str, Any], ink: dict[str, Any] | None) -> tuple[dict[str, Any], str] | None:
    """One fixer step: shrink the failing beat's size by 1 (width, rise, spacing, …) while it stays inside its band;
    else insert a rest before it (a runway and a breather); else swap the beat for a flat. Returns (plan, what)."""
    where = _failing_beat(plan, report, ink)
    if where is None:
        return None
    si, bi = where
    p = copy.deepcopy(plan)
    beats = p["sections"][si]["beats"]
    beat = beats[bi]
    band = p.get("band") if p.get("band") in BANDS else "normal"
    k = beat.get("kind")
    spec = _SHRINK.get(k)
    if spec is not None:
        field_, clamp = spec
        cur = beat.get(field_)
        if isinstance(cur, (int, float)):
            kind_, key = clamp.split(":")
            if kind_ == "grow":
                lo, hi = _extra(key, band)
                if cur < hi:
                    beat[field_] = int(cur) + 1
                    return p, f"{k}.{field_}+1"
            else:
                lo, hi = _rng(band, key) if kind_ == "band" else _extra(key, band)
                mag = abs(int(cur))
                if mag - 1 >= max(1, lo):
                    beat[field_] = (mag - 1) * (1 if cur >= 0 else -1)
                    return p, f"{k}.{field_}-1"
    prev = beats[bi - 1] if bi > 0 else None
    if not (prev and prev.get("kind") == "rest"):
        beats.insert(bi, {"kind": "rest", "length": 5})
        return p, f"rest_before_{k}"
    if k not in ("key", "door"):
        beats[bi] = {"kind": "flat", "length": 8, "enemy": "none", "coins": 3, "spikes": "none"}
        return p, f"{k}_to_flat"
    return None


# ---- the offline keyword planner (fallback for the core's keyword_plan) ------------------------------------------

_FEATURES: list[tuple[str, tuple[str, ...]]] = [
    ("lava", ("lava", "volcano", "magma", "fire", "hot", "molten")),
    ("key", ("key", "door", "locked", "lock", "treasure", "castle", "keep", "vault")),
    ("tower", ("tower", "climb", "tall", "high", "up", "mountain", "sky", "clouds", "castle")),
    ("spikes", ("spike", "spikes", "spiky", "thorn", "thorns", "pointy", "cactus", "trap", "traps")),
    ("moving", ("moving", "move", "moves", "bridge", "ferry", "elevator", "lift", "platforms", "train", "boat")),
    ("saw", ("saw", "saws", "blade", "blades", "buzz", "factory", "machine")),
    ("crumble", ("crumble", "crumbling", "break", "breaking", "collapse", "cliff", "cliffs", "falling", "fragile")),
    ("cave", ("cave", "tunnel", "underground", "mine", "dungeon", "ceiling", "low")),
    ("enemies", ("monster", "monsters", "enemy", "enemies", "bad guys", "zombie", "zombies", "goblin", "goblins")),
    ("hopper", ("frog", "frogs", "hop", "hopping", "bunny", "bunnies", "jumpy")),
    ("flyer", ("bat", "bats", "bird", "birds", "fly", "flying", "bee", "bees", "ghost", "ghosts")),
    ("shooter", ("cannon", "cannons", "shoot", "shooting", "turret", "laser")),
    ("chaser", ("chase", "chasing", "angry", "hunt")),
    ("crusher", ("crush", "crusher", "smash", "rocks", "boulder", "thwomp")),
    ("coins", ("coin", "coins", "gold", "treasure", "gems", "money", "loot")),
    ("speed", ("run", "running", "fast", "speed", "race", "racing", "dash", "sprint")),
    ("pits", ("pit", "pits", "hole", "holes", "gap", "gaps", "jump", "jumps", "jumping")),
]
_EASY = ("easy", "simple", "baby", "little", "beginner", "first", "short", "gentle", "chill", "relaxing")
_HARD = ("hard", "difficult", "impossible", "insane", "expert", "tricky", "challenging", "tough", "brutal", "crazy")
_THEME_WORDS = {"kraft": ("desert", "sand", "cardboard", "pyramid", "brown"),
                "graph": ("math", "science", "robot", "robots", "grid", "space", "lab", "computer", "factory"),
                "notebook": ("school", "homework", "notebook", "class", "paper", "pencil")}
_TITLE_NOUNS = ("cave", "castle", "tower", "garden", "forest", "mountain", "volcano", "jungle", "desert", "factory",
                "island", "city", "dungeon", "sky", "park", "lab", "temple", "swamp")
_ADJ = {"lava": "Lava", "spikes": "Spiky", "saw": "Buzzing", "crumble": "Crumbly", "moving": "Moving", "key": "Locked",
        "tower": "Tall", "cave": "Deep", "speed": "Speedy", "flyer": "Batty", "hopper": "Hoppy", "coins": "Golden"}


def _words(prompt: str) -> str:
    return " " + re.sub(r"[^a-z0-9 ]+", " ", (prompt or "").lower()) + " "


def _has(t: str, words: tuple[str, ...]) -> bool:
    return any(f" {w} " in t for w in words)


def keyword_plan(prompt: str, screens: int) -> dict[str, Any]:
    """A deterministic LevelPlan from the prompt's words (lava, key, tower, spikes, moving, saw, easy/hard, …), varied
    by the text hash. Teach → test → twist → finale with a checkpoint after each hard section."""
    t = _words(prompt)
    screens = max(1, min(6, int(screens or 1)))
    seed = int(hashlib.sha256((prompt or "").strip().lower().encode("utf-8")).hexdigest()[:8], 16)
    band = "easy" if _has(t, _EASY) else "hard" if _has(t, _HARD) else "normal"
    feats = [f for f, ws in _FEATURES if _has(t, ws)]
    theme = next((th for th, ws in _THEME_WORDS.items() if _has(t, ws)), "sketchbook")
    mains = [f for f in feats if f in ("lava", "spikes", "moving", "saw", "crumble", "tower", "cave", "pits")]
    if not mains:
        mains = [("pits", "spikes", "moving", "tower", "crumble", "saw")[seed % 6], "pits"]
    enemy = next((f for f in feats if f in ("hopper", "flyer", "shooter", "chaser", "crusher")), None)
    if enemy is None and "enemies" in feats:
        enemy = "walker"
    coins = 5 if "coins" in feats else 3

    def obstacle(f: str, i: int, strong: bool) -> list[dict[str, Any]]:
        v = (seed >> (i * 3)) & 7
        gw = _rng(band, "gap_width")
        if f == "lava":
            return [{"kind": "gap", "width": gw[1] if strong else gw[0], "floor": "lava"}] if v % 2 else \
                   [{"kind": "pillars", "n": 3 + (v % 2), "spacing": _rng(band, "spacing")[1 if strong else 0], "hazard": "lava"}]
        if f == "spikes":
            return [{"kind": "flat", "length": 8, "enemy": "none", "coins": 0, "spikes": "middle"},
                    {"kind": "gap", "width": gw[0], "floor": "spikes"}] if v % 2 else \
                   [{"kind": "ceiling", "length": 10, "spikes": True, "headroom": 3 if strong else 4}]
        if f == "moving":
            return [{"kind": "moving_bridge", "gap": _extra("bridge_gap", band)[1 if strong else 0],
                     "speed": BRIDGE_SPEEDS[band][-1 if strong else 0], "vertical": bool(v % 2)}]
        if f == "saw":
            return [{"kind": "saw_corridor", "length": 12, "saws": _extra("saws", band)[1 if strong else 0]}]
        if f == "crumble":
            return [{"kind": "crumble_run", "n": _extra("crumble_n", band)[1 if strong else 0],
                     "floor": "shallow" if band == "easy" or not strong else "void"}]
        if f == "tower":
            return [{"kind": "tower", "tiers": 3 + (1 if strong else 0), "rise": _rng(band, "tower_rise")[1], "oneway": True}] if v % 2 else \
                   [{"kind": "stairs", "n": 3, "rise": _rng(band, "step_rise")[0], "run": 4},
                    {"kind": "spring_up", "height": 6}]
        if f == "cave":
            return [{"kind": "ceiling", "length": 12, "spikes": strong and band != "easy", "headroom": 4}]
        return [{"kind": "gap", "width": gw[1] if strong else gw[0], "floor": "void"},
                {"kind": "step", "rise": _rng(band, "step_rise")[0], "length": 6}]

    def foe(strong: bool) -> list[dict[str, Any]]:
        arche = enemy or "walker"
        if arche not in GAUNTLET_ARCHETYPES[band]:
            arche = "walker" if band != "hard" else arche
        n = _extra("gauntlet_n", band)[1 if strong else 0]
        return [{"kind": "enemy_gauntlet", "archetype": arche, "n": n}]

    sections: list[dict[str, Any]] = []
    first = mains[0]
    sections.append({"role": "teach", "beats": [
        {"kind": "flat", "length": 10, "enemy": "none", "coins": coins, "spikes": "none"},
        *obstacle(first, 0, False),
        {"kind": "flat", "length": 8, "enemy": "walker" if (enemy or "enemies" in feats) else "none", "coins": 3, "spikes": "none"},
    ]})
    n_mid = max(1, screens - 1)
    for i in range(n_mid):
        f = mains[(i + 1) % len(mains)]
        beats = [*obstacle(f, i + 1, True), {"kind": "flat", "length": 6, "enemy": "none", "coins": coins, "spikes": "none"}]
        if enemy or "enemies" in feats or i % 2:
            beats += foe(i == n_mid - 1)
        if "key" in feats and i == n_mid // 2:
            beats.insert(0, {"kind": "key", "place": ("high", "guarded", "alcove")[seed % 3]})
        beats.append({"kind": "checkpoint"})
        sections.append({"role": "test" if i % 2 == 0 else "twist", "beats": beats})
    finale = [*obstacle(mains[-1], 7, True), *(foe(True) if enemy else []), {"kind": "rest", "length": 4}]
    if "key" in feats:
        finale.append({"kind": "door"})
    finale.append({"kind": "goal", "style": "staircase" if "tower" in feats else "flag"})
    sections.append({"role": "finale", "beats": finale})

    noun = next((w for w in _TITLE_NOUNS if f" {w} " in t), None)
    adj = next((_ADJ[f] for f in feats if f in _ADJ), None)
    title = f"{adj or 'Doodle'} {(noun or ('Run' if 'speed' in feats else 'Adventure')).capitalize()}"
    bits = []
    if "lava" in feats:
        bits.append("jump over the lava")
    if "key" in feats:
        bits.append("find the key")
    if "tower" in feats:
        bits.append("climb up high")
    if "spikes" in feats:
        bits.append("dodge the spikes")
    if not bits:
        bits.append("run and jump")
    summary = (", ".join(bits[:-1]) + (" and " if len(bits) > 1 else "") + bits[-1]).capitalize() + ", then reach the flag!"
    plan = {"title": title, "theme": theme, "screens": screens, "band": band, "sections": sections,
            "kid_summary": summary, "safety_ok": moderate.blocklist_hit([prompt]) is None}
    return sanitize_plan(plan, screens)
