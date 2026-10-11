"""Terrain skins for ground lines (CONTRACTS_V7 §3.4): Claude designs land colours, a tileable surface strip, a
tileable texture and 2-4 decorations; the skin is rendered on a sample hill and Claude fixes what it sees (up to 2
rounds). Seams that still show are made invisible by mirror tiling. Without the model: procedural from the family.

    skin_for(doc, scene, obj, direction, rev) → (TerrainSkin dict, error_key | None, source)

Conventions the renderers use (also told to the model):
- surface_svg: viewBox "0 0 W 128" (W = 512, or 1024 after mirror tiling); the ground line runs at y = 32 (a
  quarter of the height); drawn along the line with height 4/3 × surface_width world px, tiled every
  W × (that height / 128) px.
- texture_svg: viewBox "0 0 256 256" (or 512 x 512 mirrored), 1 unit = 1 world px, tiled over the land.
- decor: ArtVariants with viewBox "0 0 w h", w and h in world px, bottom edge on the line.
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from typing import Any

from app.mind import client, moderate, sanitize
from app.studio.art import brief, palette as P, preview, procedural, render, svg as svgmod
from app.studio.art.calls import (
    TerrainFlat, TerrainReviewFlat, call, craft_block, direction_block, error_key, image, text,
)

log = logging.getLogger("dal.v7.art")

REVIEW_ROUNDS = 0  # v7-fast: draw once
SEAM_LIMIT = 2.5


def fallback_skin(doc: dict[str, Any], direction: dict[str, Any], rev: int) -> dict[str, Any]:
    fam = P.family_for(f"{direction.get('prompt') or ''} {direction.get('summary') or ''} "
                       f"{brief.scene_of(doc, None).get('world', {}).get('kind', '')}", doc.get("theme"))
    return procedural.terrain(fam, list(direction.get("palette") or []), rev, str(doc.get("id") or "g"))


def clean_skin(v: TerrainFlat, rev: int, fb: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """A valid TerrainSkin dict from the model's answer; parts that do not survive come from `fb`. Also the list of
    parts that were replaced (told to the reviewer)."""
    lost: list[str] = []
    tag = secrets.token_hex(2)
    fill = P.clean_list(v.fill, 4)
    if not fill:
        fill, _ = fb["fill"], lost.append("fill")
    surface = (P.clean_list([v.surface], 1) or [fb["surface"]])[0]
    sw = max(6.0, min(60.0, float(v.surface_width or 0) or 20.0))
    strip = svgmod.sanitize(v.surface_svg, view=(512, 128), prefix=f"s{rev}{tag}_")
    if strip is None:
        strip, _ = fb["surface_svg"], lost.append("surface_svg")
    tex = svgmod.sanitize(v.texture_svg, view=(256, 256), prefix=f"x{rev}{tag}_")
    if tex is None:
        tex, _ = fb["texture_svg"], lost.append("texture_svg")
    decor = []
    for i, d in enumerate(v.decor[:6]):
        w, h = max(16.0, min(220.0, float(d.w or 0) or 48)), max(16.0, min(220.0, float(d.h or 0) or 48))
        s = svgmod.sanitize(d.svg, view=(4 * w, 4 * h), prefix=f"d{rev}{tag}{i}_")
        fitted = svgmod.fit(s, w, h, stretch=True) if s else None
        if fitted:
            name = sanitize.text(d.name, 40)
            decor.append({"id": f"d{rev}_{tag}_{i}", "svg": fitted, "w": round(w, 1), "h": round(h, 1), "rev": rev,
                          "note": None if moderate.blocklist_hit([name]) else (name or None)})
    if not decor:
        decor, _ = fb["decor"], lost.append("decor")
    every = max(80.0, min(1200.0, float(v.decor_every or 0) or 260.0))
    return {"fill": fill, "surface": surface, "surface_width": round(sw, 1), "surface_svg": strip,
            "texture_svg": tex, "decor": decor, "decor_every": round(every), "rev": rev}, lost


def seams(skin: dict[str, Any]) -> dict[str, float | None]:
    strip = render.png(skin.get("surface_svg") or "", width=512)
    tex = render.png(skin.get("texture_svg") or "", width=256)
    return {"surface_x": render.seam(strip, "x"), "texture_x": render.seam(tex, "x"), "texture_y": render.seam(tex, "y")}


def finish(skin: dict[str, Any]) -> dict[str, Any]:
    """Mirror-tile any part whose seam still shows (a guaranteed seamless repeat)."""
    if not render.available():
        return skin
    s = seams(skin)
    if (s["surface_x"] or 0) > SEAM_LIMIT and skin.get("surface_svg"):
        m = svgmod.mirror_tile(skin["surface_svg"], "x")
        if m and len(m[0]) <= svgmod.SVG_MAX:
            skin["surface_svg"] = m[0]
    if max(s["texture_x"] or 0, s["texture_y"] or 0) > SEAM_LIMIT and skin.get("texture_svg"):
        m = svgmod.mirror_tile(skin["texture_svg"], "xy")
        if m and len(m[0]) <= svgmod.SVG_MAX:
            skin["texture_svg"] = m[0]
    return skin


def _context(doc: dict[str, Any], scene: dict[str, Any], obj: dict[str, Any]) -> list[dict[str, Any]]:
    world = scene.get("world") or {}
    w, h = render.box_of(obj)
    lines = [f"GROUND {obj.get('id')}: kind \"{sanitize.text(obj.get('kind'), 24) or 'ground'}\""
             + (f", named \"{sanitize.text(obj.get('name'), 32)}\"" if obj.get("name") else ""),
             f"{len((obj.get('drawing') or {}).get('strokes') or [])} stroke(s) spanning {round(w)} x {round(h)} px "
             f"in a {round(float(world.get('width', 1600)))} x {round(float(world.get('height', 900)))} world; game "
             f"kind \"{sanitize.text(world.get('kind'), 60) or 'not set'}\"; gravity {list(world.get('gravity') or [0, 1])}."]
    out: list[dict[str, Any]] = [text("\n".join(lines))]
    if render.available():
        s, W, H = render.scene_svg(doc, scene, highlight=str(obj.get("id")))
        png = render.png(s, width=int(min(1400, max(400, W / 4))))
        if png:
            out += [text("The scene's sketch with this ground in full colour (other drawings faded):"), image(png)]
    return out


def _sky(doc: dict[str, Any], direction: dict[str, Any]) -> str:
    sky = (doc.get("backdrop") or {}).get("sky") or []
    if sky:
        return sky[-1]
    pal = direction.get("palette") or []
    light = [c for c in pal if P.lum(c) > 0.55]
    return light[0] if light else "#cfe3f5"


def _review_content(base: list[dict[str, Any]], skin: dict[str, Any], lost: list[str], sky: str) -> list[dict[str, Any]]:
    pv = render.png(preview.terrain_svg(skin, sky), width=1200)
    s = seams(skin)
    out = list(base)
    if pv:
        out += [text("PREVIEW of your current skin on a sample hill, at real game scale (1 px = 1 world px):"),
                image(pv)]
    strip = render.png(skin.get("surface_svg") or "", width=1024)
    if strip:
        out += [text("The surface strip alone, two tiles side by side would join at its left/right edges:"),
                image(render.checker(strip))]
    cur = {k: v for k, v in skin.items() if k != "decor"}
    cur["decor"] = [{"name": d.get("note"), "w": d.get("w"), "h": d.get("h"), "svg": d.get("svg")}
                    for d in skin.get("decor") or []]
    out.append(text(
        f"Seam measurements (≈1 seamless, above {SEAM_LIMIT} visible): surface left/right {s['surface_x']}, "
        f"texture left/right {s['texture_x']}, texture top/bottom {s['texture_y']}."
        + (f"\nThese parts did not survive the SVG sanitizer and were replaced by defaults: {', '.join(lost)}."
           if lost else "")
        + f"\n\nYour current skin (JSON):\n{json.dumps(cur)}\n\nReview it and fix it if it is not excellent (return the complete "
          "corrected skin in `fixed` when the verdict is fix)."))
    return out


async def skin_for(doc: dict[str, Any], scene: dict[str, Any], obj: dict[str, Any], direction: dict[str, Any],
                   rev: int, on_status: Any = None) -> tuple[dict[str, Any], str | None, str]:
    fb = fallback_skin(doc, direction, rev)
    if not client.available():
        return fb, "off", "keywords"
    ctx = await asyncio.to_thread(_context, doc, scene, obj)
    base = [craft_block(), direction_block(direction)] + ctx
    r = await call("studio_art_terrain", TerrainFlat, base + [text("Design the terrain skin now.")])
    if not r.ok or r.value is None:
        return fb, error_key(r), "keywords"
    skin, lost = clean_skin(r.value, rev, fb)
    if render.available():
        if on_status is not None:
            await on_status("reviewing")
        sky = _sky(doc, direction)
        for _ in range(REVIEW_ROUNDS):
            content = await asyncio.to_thread(_review_content, base, skin, lost, sky)
            rv = await call("studio_art_terrain", TerrainReviewFlat, content, attempts=2)
            if not rv.ok or rv.value is None or rv.value.verdict == "keep" or not rv.value.fixed:
                break
            skin, lost = clean_skin(rv.value.fixed[0], rev, skin)
    skin = await asyncio.to_thread(finish, skin)
    return skin, None, "model"
