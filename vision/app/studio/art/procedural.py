"""Procedural art for the fallbacks (CONTRACTS_V7 §3.7): a terrain skin and a 3-layer parallax backdrop drawn by code
from the world family and the palette. Everything tiles seamlessly by construction: silhouettes are sums of periodic
functions with whole cycles per tile, and scattered elements that cross an edge are repeated on the other side.
Deterministic for a seed (the game id + the direction's rev)."""
from __future__ import annotations

import math
import random
from typing import Any

from app.studio.art import palette as P
from app.studio.art import svg as svgmod

STRIP_W, STRIP_H, LINE_Y = 512, 128, 32
TEX = 256


def _f(x: float) -> str:
    s = f"{x:.1f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _svg(w: float, h: float, body: str, defs: str = "") -> str:
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {_f(w)} {_f(h)}" width="{_f(w)}" height="{_f(h)}">'
            + (f"<defs>{defs}</defs>" if defs else "") + body + "</svg>")


def _wrapped(x: float, r: float, w: float) -> list[float]:
    """x, plus copies shifted by ±w when an element of radius r crosses an edge."""
    xs = [x]
    if x - r < 0:
        xs.append(x + w)
    if x + r > w:
        xs.append(x - w)
    return xs


def _periodic(x: float, w: float, waves: list[tuple[float, int, float]]) -> float:
    return sum(a * math.sin(2 * math.pi * k * x / w + ph) for a, k, ph in waves)


# ---- terrain ------------------------------------------------------------------------------------------------------


def surface_strip(fam: P.Family, surface: str, outline: str, rng: random.Random) -> str:
    kind = fam.surface_kind
    light, dark = P.shade(surface, 0.35), P.shade(surface, -0.35)
    top_w = [(2.5, 3, rng.random() * 6.3), (1.5, 7, rng.random() * 6.3)]
    bot_w = [(7, 4, rng.random() * 6.3), (4, 9, rng.random() * 6.3), (2.5, 15, rng.random() * 6.3)]
    band = {"grass": 46, "snow": 54, "candy": 50, "neon": 22, "rock": 34}.get(kind, 40)
    xs = [i * 8 for i in range(STRIP_W // 8 + 1)]
    top = [(x, LINE_Y + _periodic(x, STRIP_W, top_w)) for x in xs]
    bot = [(x, LINE_Y + band + _periodic(x, STRIP_W, bot_w)) for x in xs]
    if kind == "candy":  # frosting drips
        bot = [(x, y + max(0.0, 14 * math.sin(2 * math.pi * 8 * x / STRIP_W)) ** 1.0) for x, y in bot]
    d_band = "M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in top) + " L" + " L".join(
        f"{_f(x)} {_f(y)}" for x, y in reversed(bot)) + " Z"
    d_top = "M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in top)
    d_bot = "M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in bot)
    defs = (f'<linearGradient id="sb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{light}"/>'
            f'<stop offset="0.45" stop-color="{surface}"/><stop offset="1" stop-color="{dark}"/></linearGradient>')
    body = [f'<path d="{d_bot}" fill="none" stroke="{P.shade(fam.fill[0], -0.5)}" stroke-width="10" opacity="0.28" '
            f'transform="translate(0 5)"/>', f'<path d="{d_band}" fill="url(#sb)"/>']
    if kind == "grass":
        blades = []
        n = 32
        for i in range(n):
            x0 = (i + 0.5) * STRIP_W / n + rng.uniform(-4, 4)
            hgt = rng.uniform(14, 26)
            lean = rng.uniform(-6, 6)
            for x in _wrapped(x0, 12, STRIP_W):
                y = LINE_Y + _periodic(x, STRIP_W, top_w) + 4
                blades.append(f"M{_f(x - 7)} {_f(y)} Q{_f(x - 2 + lean)} {_f(y - hgt * 0.6)} {_f(x + lean)} "
                              f"{_f(y - hgt)} Q{_f(x + 2 + lean * 0.5)} {_f(y - hgt * 0.5)} {_f(x + 7)} {_f(y)} Z")
        body.append(f'<path d="{" ".join(blades)}" fill="{surface}" stroke="{outline}" stroke-width="3" '
                    f'stroke-linejoin="round"/>')
        body.append(f'<path d="{" ".join(blades)}" fill="{light}" opacity="0.35" transform="translate(-1.5 -1)"/>')
    elif kind == "snow":
        lumps = []
        for i in range(16):
            x0 = (i + 0.5) * STRIP_W / 16 + rng.uniform(-6, 6)
            r = rng.uniform(10, 16)
            for x in _wrapped(x0, r * 1.6, STRIP_W):
                lumps.append(f'<ellipse cx="{_f(x)}" cy="{_f(LINE_Y + 4)}" rx="{_f(r * 1.6)}" ry="{_f(r)}"/>')
        body.append(f'<g fill="#ffffff">{"".join(lumps)}</g>')
    elif kind in ("dust", "sand"):
        dots = []
        for _ in range(40):
            x0, y0, r = rng.uniform(0, STRIP_W), rng.uniform(LINE_Y + 8, LINE_Y + band - 6), rng.uniform(2.5, 6)
            for x in _wrapped(x0, r * 1.3, STRIP_W):
                dots.append(f'<ellipse cx="{_f(x)}" cy="{_f(y0)}" rx="{_f(r * 1.3)}" ry="{_f(r)}"/>')
        body.append(f'<g fill="{dark}" opacity="0.45">{"".join(dots)}</g>')
        if kind == "sand":
            for j in range(3):
                y = LINE_Y + 12 + j * 10
                wv = [(2, 6 + j * 2, rng.random() * 6.3)]
                d = "M" + " L".join(f"{_f(x)} {_f(y + _periodic(x, STRIP_W, wv))}" for x in xs)
                body.append(f'<path d="{d}" fill="none" stroke="{light}" stroke-width="3" opacity="0.6"/>')
    elif kind == "candy":
        spr = []
        cols = ["#ff5fa2", "#49c6e5", "#ffd23f", "#57cc99", "#ffffff"]
        for _ in range(26):
            x0, y0 = rng.uniform(0, STRIP_W), rng.uniform(LINE_Y + 8, LINE_Y + band - 8)
            a = rng.uniform(0, 180)
            for x in _wrapped(x0, 8, STRIP_W):
                spr.append(f'<rect x="{_f(x - 6)}" y="{_f(y0 - 2)}" width="12" height="4" rx="2" '
                           f'fill="{rng.choice(cols)}" transform="rotate({_f(a)} {_f(x)} {_f(y0)})"/>')
        body.append("".join(spr))
    elif kind == "neon":
        body.append(f'<path d="{d_top}" fill="none" stroke="{surface}" stroke-width="16" opacity="0.35"/>')
    elif kind == "rock":
        cracks = []
        for i in range(10):
            x0 = (i + 0.5) * STRIP_W / 10 + rng.uniform(-10, 10)
            y0 = LINE_Y + 6
            pts = [(x0, y0)]
            for _ in range(3):
                pts.append((pts[-1][0] + rng.uniform(-8, 8), pts[-1][1] + rng.uniform(6, 10)))
            if all(4 < p[0] < STRIP_W - 4 for p in pts):
                cracks.append("M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in pts))
        body.append(f'<path d="{" ".join(cracks)}" fill="none" stroke="{surface}" stroke-width="5" '
                    f'stroke-linecap="round" opacity="0.9"/>')
    body.append(f'<path d="{d_top}" fill="none" stroke="{outline}" stroke-width="5" stroke-linecap="round"/>')
    body.append(f'<path d="{d_top}" fill="none" stroke="{light if kind != "neon" else "#ffffff"}" stroke-width="2.5" '
                f'opacity="0.85" transform="translate(0 3)"/>')
    return _svg(STRIP_W, STRIP_H, "".join(body), defs)


def texture_tile(fam: P.Family, rng: random.Random) -> str:
    base = fam.fill[min(1, len(fam.fill) - 1)]
    dark, light = P.shade(base, -0.45), P.shade(base, 0.3)
    parts = []
    for _ in range(26):
        x0, y0, r = rng.uniform(0, TEX), rng.uniform(0, TEX), rng.uniform(3, 9)
        for x in _wrapped(x0, r * 1.4, TEX):
            for y in _wrapped(y0, r, TEX):
                parts.append(f'<ellipse cx="{_f(x)}" cy="{_f(y)}" rx="{_f(r * 1.4)}" ry="{_f(r)}" fill="{dark}" '
                             f'opacity="0.22"/><ellipse cx="{_f(x - r * 0.3)}" cy="{_f(y - r * 0.35)}" '
                             f'rx="{_f(r * 0.6)}" ry="{_f(r * 0.35)}" fill="{light}" opacity="0.25"/>')
    for _ in range(70):
        x0, y0 = rng.uniform(0, TEX), rng.uniform(0, TEX)
        for x in _wrapped(x0, 2, TEX):
            for y in _wrapped(y0, 2, TEX):
                parts.append(f'<circle cx="{_f(x)}" cy="{_f(y)}" r="1.6" fill="{dark}" opacity="0.3"/>')
    for j in range(2):  # strata
        y = 70 + j * 120 + rng.uniform(-10, 10)
        wv = [(5, 1, rng.random() * 6.3), (2, 3, rng.random() * 6.3)]
        d = "M" + " L".join(f"{_f(x)} {_f(y + _periodic(x, TEX, wv))}" for x in range(0, TEX + 1, 8))
        parts.append(f'<path d="{d}" fill="none" stroke="{dark}" stroke-width="3" opacity="0.18"/>')
    return _svg(TEX, TEX, "".join(parts))


def rock_sprite(colour: str, outline: str, rng: random.Random) -> str:
    W, H = 160, 110
    n = 9
    pts = []
    for i in range(n + 1):
        a = math.pi + math.pi * i / n
        rx, ry = W * 0.46 * rng.uniform(0.85, 1.0), H * 0.88 * rng.uniform(0.75, 1.0)
        pts.append((W / 2 + rx * math.cos(a), H - 6 + ry * math.sin(a)))
    d = "M" + " L".join(f"{_f(x)} {_f(min(H - 6, y))}" for x, y in pts) + " Z"
    light, dark = P.shade(colour, 0.35), P.shade(colour, -0.4)
    defs = (f'<linearGradient id="rk" x1="0.2" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="{light}"/>'
            f'<stop offset="1" stop-color="{dark}"/></linearGradient><clipPath id="rc"><path d="{d}"/></clipPath>')
    body = (f'<ellipse cx="{W / 2}" cy="{H - 5}" rx="{W * 0.45}" ry="6" fill="#000000" opacity="0.18"/>'
            f'<path d="{d}" fill="url(#rk)"/><g clip-path="url(#rc)"><path d="M{W * 0.62} 0 L{W} 0 L{W} {H} '
            f'L{W * 0.5} {H} Z" fill="{dark}" opacity="0.45"/><ellipse cx="{W * 0.32}" cy="{H * 0.42}" rx="{W * 0.16}" '
            f'ry="{H * 0.1}" fill="{P.shade(colour, 0.6)}" opacity="0.6"/></g>'
            f'<path d="{d}" fill="none" stroke="{outline}" stroke-width="6" stroke-linejoin="round"/>')
    return _svg(W, H, body, defs)


def crystal_sprite(colour: str, outline: str) -> str:
    W, H = 120, 140
    light, dark = P.shade(colour, 0.5), P.shade(colour, -0.35)
    shards = [(60, 8, 44, 130, 76, 130), (30, 50, 18, 132, 46, 132), (92, 40, 78, 132, 104, 132)]
    defs = (f'<radialGradient id="cg" cx="0.5" cy="0.6" r="0.6"><stop offset="0" stop-color="{colour}" '
            f'stop-opacity="0.55"/><stop offset="1" stop-color="{colour}" stop-opacity="0"/></radialGradient>')
    body = [f'<ellipse cx="60" cy="96" rx="58" ry="42" fill="url(#cg)"/>']
    for tx, ty, lx, ly, rx, ry in shards:
        mx = (lx + rx) / 2
        body.append(f'<path d="M{tx} {ty} L{rx} {ry} L{lx} {ly} Z" fill="{colour}" stroke="{outline}" '
                    f'stroke-width="5" stroke-linejoin="round"/><path d="M{tx} {ty} L{mx} {ry} L{lx} {ly} Z" '
                    f'fill="{light}" opacity="0.7"/><path d="M{tx} {ty} L{rx} {ry} L{mx} {ry} Z" fill="{dark}" '
                    f'opacity="0.35"/>')
    return _svg(W, H, "".join(body), defs)


def plant_sprite(colour: str, outline: str, rng: random.Random) -> str:
    W, H = 120, 100
    leaves = []
    for i in range(5):
        a = math.radians(-150 + i * 30 + rng.uniform(-8, 8))
        L = rng.uniform(55, 80)
        x2, y2 = 60 + L * math.cos(a), 96 + L * math.sin(a)
        cx, cy = 60 + L * 0.5 * math.cos(a - 0.35), 96 + L * 0.5 * math.sin(a - 0.35)
        cx2, cy2 = 60 + L * 0.5 * math.cos(a + 0.35), 96 + L * 0.5 * math.sin(a + 0.35)
        leaves.append(f"M60 96 Q{_f(cx)} {_f(cy)} {_f(x2)} {_f(y2)} Q{_f(cx2)} {_f(cy2)} 60 96 Z")
    d = " ".join(leaves)
    return _svg(W, H, f'<path d="{d}" fill="{colour}" stroke="{outline}" stroke-width="5" stroke-linejoin="round"/>'
                      f'<path d="{d}" fill="{P.shade(colour, 0.45)}" opacity="0.35" transform="translate(-2 -2)"/>')


def terrain(fam: P.Family, pal: list[str], rev: int, seed: str) -> dict[str, Any]:
    """A TerrainSkin dict for a family, tinted toward the direction's palette."""
    rng = random.Random(f"{seed}:terrain:{rev}")
    fill = list(fam.fill)
    surface = fam.surface
    outline = P.shade(fill[-1], -0.65)
    strip = svgmod.sanitize(surface_strip(fam, surface, outline, rng), prefix=f"ps{rev}_")
    tex = svgmod.sanitize(texture_tile(fam, rng), prefix=f"pt{rev}_")
    rock_col = P.mix(fill[min(1, len(fill) - 1)], "#8a8a9a", 0.35)
    decor_svgs = [("rock", rock_sprite(rock_col, outline, rng), 64, 44)]
    if fam.key in ("space", "neon", "lava", "snow"):
        accent = {"space": "#5ee7ff", "neon": "#ff3fd8", "lava": "#ff7a2f", "snow": "#9fe3ff"}[fam.key]
        decor_svgs.append(("crystal", crystal_sprite(accent, outline), 40, 46))
    else:
        decor_svgs.append(("plant", plant_sprite(P.mix(surface, "#2f8f46", 0.4), outline, rng), 54, 45))
    decor = []
    for i, (name, s, w, h) in enumerate(decor_svgs):
        clean = svgmod.sanitize(s, prefix=f"pd{rev}{i}_")
        fitted = svgmod.fit(clean, w, h, stretch=False) if clean else None
        if fitted:
            decor.append({"id": f"d{rev}_{i}_{name}", "svg": fitted, "w": w, "h": h, "rev": rev, "note": name})
    return {"fill": fill[:4], "surface": surface, "surface_width": 24, "surface_svg": strip, "texture_svg": tex,
            "decor": decor, "decor_every": 260, "rev": rev}


# ---- backdrop -----------------------------------------------------------------------------------------------------

# far, mid, near base colours per family (mixed toward the sky for atmospheric perspective)
LAYER_COLS = {
    "space": ("#6b5a9e", "#7a729f", "#4a4566"), "forest": ("#8db3d8", "#6dbb63", "#2f7d47"),
    "desert": ("#eab68c", "#e4a35a", "#a8643a"), "snow": ("#b7d1ec", "#e3eff9", "#4f7393"),
    "ocean": ("#6aa7c9", "#3392c4", "#1f6f92"), "candy": ("#ffc6e0", "#ff9fcf", "#c76a9b"),
    "neon": ("#3b1d70", "#2b1559", "#1a0b38"), "spooky": ("#3f2e5e", "#2d2244", "#1b1429"),
    "lava": ("#5c2828", "#40201d", "#261313"),
}
LAYERS = (("far", 2400, 900, 0.12, 0.85), ("mid", 2400, 760, 0.35, 0.6), ("near", 2400, 560, 0.6, 0.4))


def _silhouette(kind: str, W: float, H: float, rng: random.Random, level: float) -> list[tuple[float, float]]:
    xs = [i * 10 for i in range(int(W // 10) + 1)]
    base = H * level
    if kind == "mountains":
        peaks = [(H * a * rng.uniform(0.8, 1.1), k, rng.random() * math.pi) for a, k in ((0.2, 2), (0.11, 3), (0.06, 5))]
        fn = lambda x: base - sum(a * (1 - abs(math.sin(math.pi * k * x / W + ph))) ** 1.6 for a, k, ph in peaks)  # noqa: E731
    elif kind == "dunes":
        fn = lambda x: base - H * 0.12 * (math.sin(2 * math.pi * 3 * x / W) + 0.35 * math.sin(2 * math.pi * 6 * x / W + 1.2)) - H * 0.04 * math.sin(2 * math.pi * 7 * x / W)  # noqa: E731
    elif kind == "waves":
        fn = lambda x: base - H * 0.04 * math.sin(2 * math.pi * 12 * x / W) - H * 0.03 * math.sin(2 * math.pi * 5 * x / W + 2)  # noqa: E731
    elif kind == "craters":
        waves = [(H * 0.05, 2, rng.random() * 6.3), (H * 0.03, 5, rng.random() * 6.3)]
        fn = lambda x: base - _periodic(x, W, waves) - H * 0.035 * max(0.0, math.sin(2 * math.pi * 6 * x / W)) ** 8  # noqa: E731
    elif kind == "rocks":
        peaks = [(H * a * rng.uniform(0.8, 1.1), k, rng.random() * math.pi) for a, k in ((0.2, 4), (0.12, 7), (0.07, 11))]
        fn = lambda x: base - sum(a * (1 - abs(math.sin(math.pi * k * x / W + ph))) ** 3 for a, k, ph in peaks)  # noqa: E731
    else:  # hills
        waves = [(H * 0.09, 2, rng.random() * 6.3), (H * 0.05, 3, rng.random() * 6.3), (H * 0.025, 7, rng.random() * 6.3)]
        fn = lambda x: base - _periodic(x, W, waves)  # noqa: E731
    return [(x, max(4.0, min(H - 4, fn(x)))) for x in xs]


def _y_at(pts: list[tuple[float, float]], x: float, W: float) -> float:
    """The silhouette height at x (wrapped into the tile)."""
    x = x % W
    step = pts[1][0] - pts[0][0] if len(pts) > 1 else W
    i = max(0, min(len(pts) - 1, round(x / step)))
    return pts[i][1]


def _skyline(W: float, H: float, rng: random.Random, level: float, colour: str, win: str) -> str:
    parts, x = [], 0.0
    widths = []
    while x < W:
        w = rng.uniform(60, 150)
        widths.append(min(w, W - x))
        x += w
    x = 0.0
    for w in widths:
        top = H * level - rng.uniform(0, H * 0.35)
        parts.append(f'<rect x="{_f(x)}" y="{_f(top)}" width="{_f(w + 0.5)}" height="{_f(H - top)}" fill="{colour}"/>')
        for wy in range(int(top + 20), int(H - 20), 34):
            for wx in range(int(x + 12), int(x + w - 16), 26):
                if rng.random() < 0.35:
                    parts.append(f'<rect x="{wx}" y="{wy}" width="10" height="14" rx="2" fill="{win}" opacity="0.7"/>')
        x += w
    return "".join(parts)


def _layer(name: str, W: float, H: float, fam: P.Family, sky: list[str], rng: random.Random) -> str:
    kind = {"far": fam.far, "mid": fam.mid, "near": fam.near}[name]
    t = {"far": 0.35, "mid": 0.15, "near": 0.0}[name]
    base = LAYER_COLS.get(fam.key, LAYER_COLS["forest"])[("far", "mid", "near").index(name)]
    col = P.mix(base, sky[-1], t)
    top_col, bot_col = P.shade(col, 0.18), P.shade(col, -0.2)
    level = {"far": 0.42, "mid": 0.45, "near": 0.5}[name]
    defs = (f'<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{top_col}"/>'
            f'<stop offset="1" stop-color="{bot_col}"/></linearGradient>')
    body: list[str] = []
    if name == "far":
        body.append(_sky_extras(fam.sky_extra, W, H * level, rng, sky))
    if kind == "skyline":
        win = "#ffe28a" if fam.key != "neon" else "#ff6ad5"
        body.append(f'<g>{_skyline(W, H, rng, level, col, win)}</g>')
    else:
        pts = _silhouette(kind, W, H, rng, level)
        d = f"M0 {_f(H)} L" + " L".join(f"{_f(x)} {_f(y)}" for x, y in pts) + f" L{_f(W)} {_f(H)} Z"
        body.append(f'<path d="{d}" fill="url(#g)"/>')
        ridge = "M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in pts)
        body.append(f'<path d="{ridge}" fill="none" stroke="{P.shade(col, 0.3)}" stroke-width="4" opacity="0.55"/>')
        if kind == "craters" or (name == "mid" and fam.key == "space"):
            for i in range(6):
                cx = (i + 0.5) * W / 6 + rng.uniform(-60, 60)
                cy = min(H - 30, _y_at(pts, cx, W) + H * rng.uniform(0.12, 0.3))
                rx = rng.uniform(50, 110)
                for x in _wrapped(cx, rx, W):
                    body.append(f'<ellipse cx="{_f(x)}" cy="{_f(cy)}" rx="{_f(rx)}" ry="{_f(rx * 0.22)}" '
                                f'fill="{P.shade(col, -0.25)}"/><ellipse cx="{_f(x)}" cy="{_f(cy + rx * 0.05)}" '
                                f'rx="{_f(rx * 0.82)}" ry="{_f(rx * 0.15)}" fill="{P.shade(col, 0.12)}"/>')
        if name == "near" and fam.key in ("forest", "spooky", "snow"):
            canopy, lights = [], []
            n = 34
            for i in range(n):
                x0 = (i + 0.5) * W / n + rng.uniform(-20, 20)
                y0 = _y_at(pts, x0, W)
                r = rng.uniform(38, 66)
                for x in _wrapped(x0, r, W):
                    if fam.key == "snow":
                        canopy.append(f'<path d="M{_f(x)} {_f(y0 - r * 2.0)} L{_f(x + r * 0.75)} {_f(y0 + 30)} '
                                      f'L{_f(x - r * 0.75)} {_f(y0 + 30)} Z"/>')
                        lights.append(f'<path d="M{_f(x)} {_f(y0 - r * 2.0)} L{_f(x - r * 0.75)} {_f(y0 + 30)} '
                                      f'L{_f(x - r * 0.2)} {_f(y0 + 30)} Z"/>')
                    else:
                        canopy.append(f'<circle cx="{_f(x)}" cy="{_f(y0 - r * 0.35)}" r="{_f(r)}"/>')
                        lights.append(f'<circle cx="{_f(x - r * 0.3)}" cy="{_f(y0 - r * 0.6)}" r="{_f(r * 0.55)}"/>')
            body.append(f'<g fill="{top_col}">{"".join(canopy)}</g>')
            body.append(f'<g fill="{P.shade(top_col, 0.22)}" opacity="0.55">{"".join(lights)}</g>')
    return _svg(W, H, "".join(body), defs)


def _sky_extras(kind: str, W: float, horizon: float, rng: random.Random, sky: list[str]) -> str:
    out: list[str] = []
    if kind in ("stars", "moon"):
        for _ in range(140):
            x0, y0, r = rng.uniform(0, W), rng.uniform(0, horizon * 0.95), rng.choice((1.5, 2, 2, 3, 4))
            for x in _wrapped(x0, r, W):
                out.append(f'<circle cx="{_f(x)}" cy="{_f(y0)}" r="{r}" fill="#ffffff" '
                           f'opacity="{rng.uniform(0.35, 0.95):.2f}"/>')
    if kind == "stars":  # one ringed planet per tile
        cx, cy, r = W * rng.uniform(0.55, 0.75), horizon * 0.42, 120
        out.append(f'<defs><radialGradient id="pl" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="#ffd6a5"/>'
                   f'<stop offset="0.6" stop-color="#e38b6f"/><stop offset="1" stop-color="#7a3e6e"/></radialGradient>'
                   f'</defs><ellipse cx="{_f(cx)}" cy="{_f(cy)}" rx="{_f(r * 2)}" ry="{_f(r * 0.42)}" fill="none" '
                   f'stroke="#f6d8b8" stroke-width="10" opacity="0.55" transform="rotate(-14 {_f(cx)} {_f(cy)})"/>'
                   f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="{r}" fill="url(#pl)"/>')
    elif kind == "moon":
        cx, cy = W * 0.7, horizon * 0.4
        out.append(f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="150" fill="#fff6d8" opacity="0.18"/>'
                   f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="96" fill="#fff3c4"/>'
                   f'<circle cx="{_f(cx - 30)}" cy="{_f(cy - 20)}" r="18" fill="#efe0a8"/>')
    elif kind == "sun":
        cx, cy = W * 0.68, horizon * 0.45
        out.append(f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="210" fill="#fff6c9" opacity="0.25"/>'
                   f'<circle cx="{_f(cx)}" cy="{_f(cy)}" r="120" fill="#fff1b0"/>')
    elif kind == "clouds":
        for i in range(6):
            x0, y0 = (i + 0.5) * W / 6 + rng.uniform(-80, 80), rng.uniform(horizon * 0.15, horizon * 0.7)
            s = rng.uniform(0.7, 1.3)
            for x in _wrapped(x0, 160 * s, W):
                out.append(f'<g fill="#ffffff" opacity="0.8"><ellipse cx="{_f(x)}" cy="{_f(y0)}" rx="{_f(110 * s)}" '
                           f'ry="{_f(34 * s)}"/><circle cx="{_f(x - 40 * s)}" cy="{_f(y0 - 22 * s)}" r="{_f(40 * s)}"/>'
                           f'<circle cx="{_f(x + 30 * s)}" cy="{_f(y0 - 30 * s)}" r="{_f(52 * s)}"/></g>')
    return "".join(out)


def backdrop(fam: P.Family, rev: int, seed: str, sky: list[str] | None = None) -> dict[str, Any]:
    rng = random.Random(f"{seed}:backdrop:{rev}")
    sky_cols = P.clean_list(sky, 4) or list(fam.sky)
    layers = []
    for name, W, H, depth, height in LAYERS:
        s = svgmod.sanitize(_layer(name, W, H, fam, sky_cols, rng), prefix=f"pb{rev}{name}_")
        if s:
            layers.append({"svg": s, "w": W, "h": H, "depth": depth, "anchor": "bottom", "tile_x": True,
                           "height": height})
    return {"rev": rev, "sky": sky_cols, "layers": layers}
