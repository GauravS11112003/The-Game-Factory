"""DesignDigest: everything DESIGN, REFINE and CRITIC see, built from a TierSet (PLAN_V2 §3.8, §3.10).

The model sees the menu and digests, never raw geometry. The core's `digest` RPC is authoritative for the three
text blocks (graph digest, level digest, menu rows); `fallback_digest` writes the same blocks from the BuildResult
in Python when that RPC is unavailable, so the designer never depends on one worker method.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.mind import messages
from app.mind.sanitize import MenuIndex

TIER_LABEL = {"faithful": "faithful", "polished": "polish", "normal": "normal", "hard": "hard"}


@dataclass
class DesignDigest:
    graph_digest: str
    level_digest: str
    menu_rows: str
    index: MenuIndex
    screens: int = 1
    wish: str = "none"
    band: str | None = None  # the dial's Challenging band (normal | hard), when the child chose one
    c: dict[str, float] = field(default_factory=dict)  # measured C per tier
    reach: dict[str, bool] = field(default_factory=dict)
    segments: list[dict[str, Any]] = field(default_factory=list)

    def alts_text(self) -> str:
        if not self.index.alts:
            return "none"
        return "\n".join(f"{g}: {', '.join(c)}" for g, c in sorted(self.index.alts.items()))


def _num(x: Any) -> str:
    try:
        f = float(x)
    except (TypeError, ValueError):
        return "?"
    s = f"{f:+.2f}" if f else "0"
    return s


def menu_rows(menu: list[dict[str, Any]]) -> str:
    rows = []
    for c in menu:
        tiers = ",".join(TIER_LABEL.get(t, t) for t in c.get("tiers") or [])
        summary = messages.say(c.get("summary_key", ""), c.get("summary_args") or {}, default=c.get("summary_key", ""))
        alts = f" · alts {c['alts']}" if c.get("alts") else ""
        fixes = ",".join(c.get("fixes") or []) or "-"
        rows.append(f"{c['cid']} · {summary} · {tiers}{alts} · dC {_num(c.get('dC'))} · dT {_num(c.get('dT_s'))}"
                    f" · cost {c.get('intent_cost', 0):g} · fixes {fixes}")
    return "\n".join(rows)


def _extent(o: dict[str, Any]) -> str:
    sh = o.get("shape") or {}
    k = sh.get("k")
    if k == "surface" and sh.get("segs"):
        xs = [p for s in sh["segs"] for p in (s["a"][0], s["b"][0])]
        ys = [p for s in sh["segs"] for p in (s["a"][1], s["b"][1])]
        sl = " sloped" if any(s.get("slope") for s in sh["segs"]) else ""
        return f"x{min(xs):g}-{max(xs):g} r{min(ys):g}{sl}"
    if k == "strip":
        return f"x{sh['a'][0]:g}-{sh['b'][0]:g} r{sh['a'][1]:g}"
    if k == "body":
        b = sh.get("bbox") or [0, 0, 0, 0]
        return f"x{b[0]:g}-{b[2]:g} r{b[1]:g}-{b[3]:g}"
    if k == "point":
        p = sh.get("p") or [0, 0]
        return f"at {p[0]:g},{p[1]:g}"
    if k == "wall":
        return f"x{sh.get('x', 0):g} r{sh.get('y0', 0):g}-{sh.get('y1', 0):g}"
    return ""


def fallback_graph_digest(graph: dict[str, Any]) -> str:
    parts = []
    for o in graph.get("objects") or []:
        rel = o.get("rel") or {}
        bits = [o.get("id", "?"), o.get("role", "?")]
        if o.get("collision") == "one_way":
            bits.append("one-way")
        ext = _extent(o)
        if ext:
            bits.append(ext)
        if rel.get("rests_on"):
            bits.append(f"on {rel['rests_on']}")
        att = rel.get("attached")
        if att:
            bits.append(f"att {att.get('host')} {att.get('face')}")
        if rel.get("points") and rel["points"] != "none":
            bits.append(f"points {rel['points']}")
        beh = o.get("behavior") or {}
        if beh.get("kind") and beh["kind"] != "static":
            bits.append(beh["kind"] + (f" {beh.get('archetype')}" if beh.get("archetype") else ""))
        if o.get("origin") and o["origin"] != "kid":
            bits.append(f"({o['origin']})")
        if o.get("pinned"):
            bits.append("pinned " + ",".join(o["pinned"]))
        parts.append(" ".join(str(b) for b in bits))
    sp = "; ".join(f"\"{s.get('name')}\" [{', '.join(s.get('ids') or [])}]" for s in graph.get("setpieces") or [])
    return ("objects: " + " | ".join(parts) + f"\nsetpieces: {sp or 'none'}\nintent: {graph.get('intent') or 'unknown'}; "
            f"wish: {graph.get('difficulty_wish', 'none')}")


def fallback_level_digest(result: dict[str, Any]) -> str:
    rep = result.get("report") or {}
    steps = []
    for s in rep.get("route") or []:
        bits = [f"r{s.get('i')} {s.get('kind')} {s['from'][0]:g}→{s['to'][0]:g}" if s.get("from") and s.get("to")
                else f"r{s.get('i')} {s.get('kind')}"]
        if s.get("w_f") is not None:
            bits.append(f"w {s['w_f']:g}f")
        if s.get("h_f"):
            bits.append(f"h {s['h_f']:g}f")
        if s.get("phi_f"):
            bits.append(f"φ {s['phi_f']:g}f")
        if s.get("p_death_casual"):
            bits.append(f"p {s['p_death_casual']:.2f}")
        if s.get("setpiece"):
            bits.append(f"setpiece \"{s['setpiece']}\"")
        if s.get("blind"):
            bits.append("blind")
        steps.append(" ".join(bits))
    segs = " | ".join(f"{g.get('id')} {g.get('from')}→{g.get('to')} E {g.get('E', 0):.2f} T {g.get('T_ms', 0) / 1000:.1f} s "
                      f"F {g.get('F_s', 0):.1f} s actions {g.get('actions', 0)}" for g in rep.get("segments") or [])
    flags = " | ".join(f"{f.get('code')} ({f.get('severity')})" + (f" {','.join(f.get('object_ids') or [])}" if f.get("object_ids") else "")
                       for f in rep.get("flags") or [])
    return (f"route: {' | '.join(steps) or 'none'}\nsegments: {segs or 'none'}\n"
            f"C {rep.get('C', 0):.2f} ({rep.get('band', '?')}) · fastest {rep.get('fastest_ms', 0) / 1000:.1f} s · "
            f"par {rep.get('par_ms', 0) / 1000:.1f} s · solvable {rep.get('solvable')}\nflags: {flags or 'none'}")


def build_digest(rpc_digest: dict[str, Any] | None, tierset: dict[str, Any], *, base_tier: str = "faithful",
                 undone: set[str] | None = None, band: str | None = None, menu: list[dict[str, Any]] | None = None
                 ) -> DesignDigest:
    base = tierset.get(base_tier) or tierset.get("faithful") or {}
    menu = menu if menu is not None else (tierset.get("menu") or [])
    graph = base.get("graph") or {}
    idx = MenuIndex.build(menu, base, undone=undone or set(), graph=graph)
    d = rpc_digest or {}
    world = (base.get("level") or {}).get("world") or {}
    c = {t: float(((tierset.get(t) or {}).get("report") or {}).get("C", 0) or 0) for t in ("faithful", "polished", "normal", "hard")}
    return DesignDigest(
        graph_digest=d.get("graph_digest") or fallback_graph_digest(graph),
        level_digest=d.get("level_digest") or fallback_level_digest(base),
        menu_rows=d.get("menu_rows") or menu_rows(menu),
        index=idx, screens=int(world.get("screens", 1) or 1), wish=str(graph.get("difficulty_wish", "none")),
        band=band, c=c, reach=dict(tierset.get("reach") or {}),
        segments=list((base.get("report") or {}).get("segments") or []),
    )


def tier_targets_text(dig: DesignDigest, dial: dict[str, Any]) -> str:
    pol = dial.get("polished") or {}
    nor = dial.get("normal") or {}
    hard = dial.get("hard") or {}
    cf = dig.c.get("faithful", 0.0)
    lo = max(cf, float(pol.get("C_min", 0.1)))
    t = (f"polish: C ≥ {lo:.2f} (never easier than drawn: faithful C {cf:.2f}), raised only up to "
         f"{float(pol.get('C_raise_max', 0.3)):g}; checkpoints so no segment costs more than {pol.get('max_F_s', 30)} s.\n"
         f"normal: C {nor.get('C', [0.3, 1])[0]:g}-{nor.get('C', [0.3, 1])[1]:g} (aim {nor.get('aim', 0.6):g}). "
         f"hard: C {hard.get('C', [1, 3])[0]:g}-{hard.get('C', [1, 3])[1]:g} (aim {hard.get('aim', 1.8):g}).")
    if dig.band == "hard":
        t += " The child chose Challenging·Hard."
    if dig.wish and dig.wish != "none":
        t += f" The drawing asks for {dig.wish}."
    return t


def budgets_text(dig: DesignDigest, design: dict[str, Any]) -> str:
    b = design.get("budgets") or {}
    return (f"polish ≤ {b.get('polished_P_per_screen', 2)} picks per screen plus coins and ≤ {b.get('polished_tune', 4)} "
            f"tune; normal/hard ≤ {b.get('challenging_C_per_screen', 4)} challenge picks per screen. "
            f"The level is {dig.screens} screen{'s' if dig.screens != 1 else ''}.")


def measured_text(dig: DesignDigest, dial: dict[str, Any]) -> str:
    nor = (dial.get("normal") or {}).get("C", [0.3, 1])
    hard = (dial.get("hard") or {}).get("C", [1, 3])
    def mark(c: float, lo: float, hi: float) -> str:
        return "in band" if lo <= c <= hi else ("MISSED (too easy)" if c < lo else "MISSED (too hard)")
    return (f"faithful C {dig.c.get('faithful', 0):.2f}; polish C {dig.c.get('polished', 0):.2f}; "
            f"normal C {dig.c.get('normal', 0):.2f} (target {nor[0]:g}-{nor[1]:g}, {mark(dig.c.get('normal', 0), nor[0], nor[1])}); "
            f"hard C {dig.c.get('hard', 0):.2f} (target {hard[0]:g}-{hard[1]:g}, {mark(dig.c.get('hard', 0), hard[0], hard[1])})")


def band_missed(tierset: dict[str, Any], dial: dict[str, Any]) -> list[str]:
    """Tiers (normal, hard) whose measured C is outside the band, among tiers the drawing can reach."""
    out = []
    reach = tierset.get("reach") or {}
    for t in ("normal", "hard"):
        lo, hi = (dial.get(t) or {}).get("C", [0.3, 1.0] if t == "normal" else [1.0, 3.0])
        c = float(((tierset.get(t) or {}).get("report") or {}).get("C", 0) or 0)
        if reach.get(t, True) and not (lo <= c <= hi):
            out.append(t)
    return out


def setpiece_text(dig: DesignDigest) -> str:
    return ", ".join(f"\"{s}\"" for s in sorted(dig.index.setpieces)) or "none"


def slots_text(dig: DesignDigest, limit: int = 60) -> str:
    slots = sorted(s for s in dig.index.slots if s.startswith("slot."))
    return ", ".join(slots[:limit]) or "none"


def cosmetic_text(dig: DesignDigest) -> str:
    return ", ".join(sorted(dig.index.cosmetic)) or "none"

