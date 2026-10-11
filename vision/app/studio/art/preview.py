"""Composed previews for the review calls: a terrain skin on a sample hill and the backdrop as the game shows it.
They are internal pictures (never sent to clients), built as one SVG from the sanitized pieces and rasterized."""
from __future__ import annotations

import math
from typing import Any

from app.studio.art import svg as svgmod

HILL = [(0, 330), (220, 330), (420, 250), (560, 205), (700, 235), (900, 360), (1200, 385)]
PW, PH = 1200, 600
VIEW = (1600, 900)


def _f(x: float) -> str:
    s = f"{x:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _def(svg: str | None, gid: str) -> tuple[str, tuple[float, float]] | None:
    if not svg:
        return None
    got = svgmod.inner(svg)
    if got is None:
        return None
    xml, size = got
    return f'<g id="{gid}">{xml}</g>', size


def terrain_svg(skin: dict[str, Any], sky: str = "#cfe3f5") -> str:
    fill = skin.get("fill") or ["#8d6e63", "#5d4037"]
    sw = float(skin.get("surface_width") or 14)
    defs: list[str] = []
    top = min(y for _, y in HILL)
    stops = "".join(f'<stop offset="{_f(i / max(1, len(fill) - 1))}" stop-color="{c}"/>' for i, c in enumerate(fill))
    defs.append(f'<linearGradient id="pv_land" gradientUnits="userSpaceOnUse" x1="0" y1="{top}" x2="0" '
                f'y2="{top + 380}">{stops}</linearGradient>')
    land = "M" + " L".join(f"{x} {y}" for x, y in HILL) + f" L{PW} {PH} L0 {PH} Z"
    defs.append(f'<clipPath id="pv_clip"><path d="{land}"/></clipPath>')
    body = [f'<rect width="{PW}" height="{PH}" fill="{sky}"/>', f'<path d="{land}" fill="url(#pv_land)"/>']
    tex = _def(skin.get("texture_svg"), "pv_tex")
    if tex:
        xml, (tw, th) = tex
        defs.append(xml)
        tiles = []
        for ty in range(int(top), PH, max(8, int(th))):
            for tx in range(0, PW, max(8, int(tw))):
                tiles.append(f'<use href="#pv_tex" x="{tx}" y="{ty}"/>')
        body.append(f'<g clip-path="url(#pv_clip)">{"".join(tiles)}</g>')
    strip = _def(skin.get("surface_svg"), "pv_strip")
    if strip:
        xml, (vw, vh) = strip
        defs.append(xml)
        hs = sw * 4 / 3
        k = hs / vh
        tile_w = vw * k
        line_y = vh / 4
        cum = 0.0
        for n, ((x0, y0), (x1, y1)) in enumerate(zip(HILL, HILL[1:])):
            L = math.hypot(x1 - x0, y1 - y0)
            a = math.degrees(math.atan2(y1 - y0, x1 - x0))
            defs.append(f'<clipPath id="pv_seg{n}"><rect x="-1" y="{_f(-hs * 2)}" width="{_f(L + 2)}" '
                        f'height="{_f(hs * 4)}"/></clipPath>')
            t = -(cum % tile_w)
            tiles = []
            while t < L:
                tiles.append(f'<use href="#pv_strip" transform="translate({_f(t)} {_f(-line_y * k)}) '
                             f'scale({k:.4f})"/>')
                t += tile_w
            body.append(f'<g transform="translate({_f(x0)} {_f(y0)}) rotate({_f(a)})"><g clip-path="url(#pv_seg{n})">'
                        + "".join(tiles) + "</g></g>")
            cum += L
    else:
        body.append(f'<path d="M' + " L".join(f"{x} {y}" for x, y in HILL) + f'" fill="none" '
                    f'stroke="{skin.get("surface", "#3bb273")}" stroke-width="{_f(sw)}" stroke-linejoin="round"/>')
    for i, d in enumerate(skin.get("decor") or []):
        got = _def(d.get("svg"), f"pv_d{i}")
        if not got:
            continue
        xml, (vw, vh) = got
        defs.append(xml)
        w, h = float(d.get("w") or vw), float(d.get("h") or vh)
        for frac in ((0.12 + 0.27 * i) % 1.0, (0.62 + 0.21 * i) % 1.0):
            x = frac * PW
            seg = next(((a, b) for a, b in zip(HILL, HILL[1:]) if a[0] <= x <= b[0]), (HILL[-2], HILL[-1]))
            (ax, ay), (bx, by) = seg
            y = ay + (by - ay) * (x - ax) / max(1, bx - ax)
            body.append(f'<use href="#pv_d{i}" transform="translate({_f(x - w / 2)} {_f(y - h * 0.92)}) '
                        f'scale({w / vw:.4f} {h / vh:.4f})"/>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {PW} {PH}" width="{PW}" height="{PH}">'
            f'<defs>{"".join(defs)}</defs>{"".join(body)}</svg>')


def backdrop_svg(bd: dict[str, Any], *, ground: list[str] | None = None, mock_play: bool = True) -> str:
    """The view as the game shows it (1600 x 900): sky, layers tiled with every seam at x = 800, a sample ground band
    and grey gameplay-sized boxes."""
    W, H = VIEW
    sky = bd.get("sky") or ["#9fd3ff", "#e8f6ff"]
    defs = [f'<linearGradient id="pv_sky" x1="0" y1="0" x2="0" y2="1">'
            + "".join(f'<stop offset="{_f(i / max(1, len(sky) - 1))}" stop-color="{c}"/>' for i, c in enumerate(sky))
            + "</linearGradient>"]
    body = [f'<rect width="{W}" height="{H}" fill="url(#pv_sky)"/>']
    for i, layer in enumerate(bd.get("layers") or []):
        got = _def(layer.get("svg"), f"pv_l{i}")
        if not got:
            continue
        xml, (vw, vh) = got
        defs.append(xml)
        ph = float(layer.get("height") or 0.5) * H
        k = ph / vh
        tw = vw * k
        y = H - ph if layer.get("anchor", "bottom") == "bottom" else 0
        x = W / 2 - tw * math.ceil((W / 2) / tw)
        while x < W:
            body.append(f'<use href="#pv_l{i}" transform="translate({_f(x)} {_f(y)}) scale({k:.4f})"/>')
            x += tw
    if mock_play:
        g = ground or ["#8d6e63", "#5d4037"]
        band = "M0 800 " + " ".join(f"L{x} {_f(790 + 18 * math.sin(x / 140))}" for x in range(0, W + 1, 40)) + \
               f" L{W} {H} L0 {H} Z"
        defs.append(f'<linearGradient id="pv_g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{g[0]}"/>'
                    f'<stop offset="1" stop-color="{g[-1]}"/></linearGradient>')
        body.append(f'<path d="{band}" fill="url(#pv_g)"/>')
        body.append('<g fill="#8f9399" stroke="#2b2d33" stroke-width="5">'
                    '<rect x="260" y="690" width="170" height="86" rx="14"/><circle cx="292" cy="784" r="26"/>'
                    '<circle cx="398" cy="784" r="26"/><circle cx="760" cy="640" r="20"/><circle cx="830" cy="620" '
                    'r="20"/><circle cx="900" cy="640" r="20"/><rect x="1180" y="560" width="70" height="110" '
                    'rx="10"/></g>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">'
            f'<defs>{"".join(defs)}</defs>{"".join(body)}</svg>')
