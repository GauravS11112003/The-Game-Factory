"""The parallax backdrop (CONTRACTS_V7 §3.5): three horizontally tiling SVG layers (far / mid / near) painted by Claude
concurrently from the art direction, composed exactly as the game shows them (seams in view, sample ground and grey
gameplay boxes) and reviewed and fixed by Claude, up to 2 rounds. Layers whose seam still shows are mirror-tiled.
Without the model: procedural layers from the world family.

    backdrop_for(doc, scene, direction, rev) → (Backdrop dict, error_key | None, source)
"""
from __future__ import annotations

import asyncio
import logging
import secrets
from typing import Any

from app.mind import client
from app.studio.art import brief, palette as P, preview, procedural, render, svg as svgmod
from app.studio.art.calls import (
    BackdropReviewFlat, LayerFlat, call, craft_block, direction_block, error_key, image, text,
)

log = logging.getLogger("dal.v7.art")

REVIEW_ROUNDS = 0  # v7-fast: draw once
SEAM_LIMIT = 2.5
LAYER_BRIEF = {
    "far": "FAR layer: the horizon and the sky objects; the lowest contrast, colours pushed toward the sky.",
    "mid": "MID layer: middle-distance scenery, transparent above its silhouette.",
    "near": "NEAR layer: the closest scenery, the most detail of the three but still calm background, transparent "
            "above its silhouette, nothing that looks like a platform.",
}


def _family(doc: dict[str, Any], direction: dict[str, Any]) -> P.Family:
    return P.family_for(f"{direction.get('prompt') or ''} {direction.get('summary') or ''} "
                        f"{brief.scene_of(doc, None).get('world', {}).get('kind', '')}", doc.get("theme"))


def fallback_backdrop(doc: dict[str, Any], direction: dict[str, Any], rev: int) -> dict[str, Any]:
    return procedural.backdrop(_family(doc, direction), rev, str(doc.get("id") or "g"))


def _scene_image(doc: dict[str, Any], scene: dict[str, Any]) -> list[dict[str, Any]]:
    if not render.available() or not any(brief.has_strokes(o) for o in scene.get("objects") or []):
        return []
    s, W, _ = render.scene_svg(doc, scene)
    png = render.png(s, width=int(min(1400, max(400, W / 4))))
    return [text("The scene's sketch (where gameplay happens):"), image(png)] if png else []


def _ground_cols(doc: dict[str, Any], scene: dict[str, Any], fam: P.Family) -> list[str]:
    for o in scene.get("objects") or []:
        t = ((o.get("art") or {}).get("terrain") or {}) if isinstance(o.get("art"), dict) else {}
        if t.get("fill"):
            return list(t["fill"])
    return list(fam.fill)


def _seam_of(svg: str) -> float | None:
    return render.seam(render.png(svg, width=1200), "x")


def _review_content(base: list[dict[str, Any]], bd: dict[str, Any], names: list[str], ground: list[str]
                    ) -> list[dict[str, Any]]:
    out = list(base)
    comp = render.png(preview.backdrop_svg(bd, ground=ground), width=1400)
    if comp:
        out += [text("COMPOSITE as the game shows it (every layer's repeat seam is at the horizontal centre; grey "
                     "shapes = gameplay pieces; the band at the bottom = sample ground):"), image(comp)]
    lines = []
    for name, layer in zip(names, bd["layers"]):
        png = render.png(layer["svg"], width=1200)
        if png:
            out += [text(f"{name.upper()} layer alone (checkerboard = transparent):"), image(render.checker(png))]
        lines.append(f"{name.upper()} (viewBox 0 0 {round(layer['w'])} {round(layer['h'])}, covers "
                     f"{round(layer['height'] * 100)}% of the view height, seam {render.seam(png, 'x')}):\n{layer['svg']}")
    out.append(text(f"Sky: {bd.get('sky')}\n\n" + "\n\n".join(lines)
                    + "\n\nReview the backdrop and fix the layers that need it."))
    return out


async def _paint(base: list[dict[str, Any]], name: str, W: int, H: int, rev: int) -> tuple[str | None, list[str], Any]:
    r = await call("studio_art_backdrop", LayerFlat, base + [text(
        f"{LAYER_BRIEF[name]}\nUse exactly viewBox=\"0 0 {W} {H}\". Paint the {name} layer now.")])
    if not r.ok or r.value is None:
        return None, [], r
    s = svgmod.sanitize(r.value.svg, view=(W, H), prefix=f"b{rev}{name}{secrets.token_hex(2)}_")
    return s, P.clean_list(r.value.sky, 4), r


def finish(bd: dict[str, Any]) -> dict[str, Any]:
    if not render.available():
        return bd
    for layer in bd["layers"]:
        if (_seam_of(layer["svg"]) or 0) > SEAM_LIMIT:
            m = svgmod.mirror_tile(layer["svg"], "x")
            if m and len(m[0]) <= svgmod.SVG_MAX:
                layer["svg"], layer["w"], layer["h"] = m
    return bd


async def backdrop_for(doc: dict[str, Any], scene: dict[str, Any], direction: dict[str, Any], rev: int,
                       on_status: Any = None) -> tuple[dict[str, Any], str | None, str]:
    fb = fallback_backdrop(doc, direction, rev)
    if not client.available():
        return fb, "off", "keywords"
    fam = _family(doc, direction)
    scene_blocks = await asyncio.to_thread(_scene_image, doc, scene)
    world_kind = (scene.get("world") or {}).get("kind") or ""
    base = [craft_block(), direction_block(direction)] + scene_blocks + [
        text(f"The game kind: {world_kind or 'not set'}. The view is 1600 x 900 world px.")]
    specs = procedural.LAYERS
    results = await asyncio.gather(*(_paint(base, name, W, H, rev) for name, W, H, _, _ in specs))
    layers, names, sky, err = [], [], [], None
    for (name, W, H, depth, height), (s, sk, r) in zip(specs, results):
        if s is None:
            err = err or error_key(r)
            fbl = next((x for x in fb["layers"] if round(x["h"]) == H), None)
            if fbl is None:
                continue
            s = fbl["svg"]
        if name == "far" and sk:
            sky = sk
        sky = sky or sk
        layers.append({"svg": s, "w": W, "h": H, "depth": depth, "anchor": "bottom", "tile_x": True,
                       "height": height})
        names.append(name)
    if all(s is None for s, _, _ in results):
        return fb, err or "failed", "keywords"
    bd = {"rev": rev, "sky": sky or fb["sky"], "layers": layers}
    if render.available():
        if on_status is not None:
            await on_status("reviewing")
        ground = _ground_cols(doc, scene, fam)
        for _ in range(REVIEW_ROUNDS):
            content = await asyncio.to_thread(_review_content, base, bd, names, ground)
            rv = await call("studio_art_backdrop_review", BackdropReviewFlat, content, attempts=2)
            if not rv.ok or rv.value is None:
                break
            v = rv.value
            changed = False
            new_sky = P.clean_list(v.sky, 4)
            if new_sky and len(new_sky) >= 2:
                bd["sky"], changed = new_sky, True
            for fx in v.fixes:
                if fx.layer not in names:
                    continue
                i = names.index(fx.layer)
                L = bd["layers"][i]
                s = svgmod.sanitize(fx.svg, view=(L["w"], L["h"]), prefix=f"b{rev}{fx.layer}{secrets.token_hex(2)}_")
                if s is not None:
                    m = render.measure(render.png(s, width=600))
                    if m is None or not m.empty:
                        L["svg"], changed = s, True
            log.info("art backdrop: score %s, %d fixes", v.score, len(v.fixes))
            if v.verdict == "keep" or not changed:
                break
    bd = await asyncio.to_thread(finish, bd)
    return bd, None, "model"
