"""CVResult + Interpretation (+ parent Level) -> Level (PLAN.md section 8). Owned by lane C (AI + compile).

Component id space
    Parent components keep their ids. The scanned components are renumbered to
    continue after the parent's highest id (see remix_offset); without a parent
    the offset is 0 and ids equal the magenta numbers on the annotated image.
    Interpretation.bindings and annotation_component_ids use this level-wide id
    space, which is exactly what interpret() shows the model.

Validation rules are listed in shared/behaviors.md. The level always compiles,
even with interp=None (then meta.warnings gets "rules_not_read"). Nothing in
here raises on a valid CVResult: every failure becomes a meta.warnings entry.
"""
from __future__ import annotations

import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image, ImageChops, ImageFilter

from app.models import (
    BBox,
    Binding,
    Cell,
    Component,
    CVComponent,
    CVResult,
    Entity,
    Grid,
    Interpretation,
    Level,
    Meta,
    Rule,
    Source,
    Sprites,
)

GRID_W, GRID_H = 48, 27
CELL_PX = 16
BACKDROP_SIZE = (768, 432)
FLOOR_AREA_CELLS = 60
TIMER_RANGE = (10, 300)
DYNAMIC_BEHAVIORS = {"move", "patrol", "door"}
BEHAVIOR_COLOR: dict[str, str | None] = {
    "move": "black",
    "patrol": "red",
    "bounce": "black",
    "key": "blue",
    "door": "black",
    "checkpoint": None,
    "start": None,
}
PARAM_DEFAULTS: dict[str, dict[str, float]] = {
    "move": {"dx": 8, "dy": 0, "speed": 2},
    "patrol": {"dx": 6, "speed": 3},
    "bounce": {"strength": 1.0},
}
# name -> (lo, hi, signed). Signed ranges clamp the magnitude and keep the sign (dx: direction).
PARAM_RANGES: dict[str, tuple[float, float, bool]] = {
    "dx": (2, 20, True),
    "dy": (-10, 10, False),
    "speed": (1, 6, False),
    "strength": (0.5, 2.0, False),
}
NEAR_WHITE = 245  # a backdrop/drawing pixel with every channel >= this is paper


# --------------------------------------------------------------------------- id space


def remix_offset(parent_components: Sequence[Component]) -> int:
    """Scanned component k becomes level component k + offset."""
    return max((c.id for c in parent_components), default=0)


def renumber_new_components(
    cv_components: Sequence[CVComponent], parent_components: Sequence[Component]
) -> list[CVComponent]:
    offset = remix_offset(parent_components)
    return [c.model_copy(update={"id": c.id + offset}) for c in cv_components]


# --------------------------------------------------------------------------- small helpers


def _clamp(v: float, lo: float, hi: float) -> float:
    return min(max(v, lo), hi)


def _clamp_bbox(b: Sequence[int]) -> BBox:
    x0, y0, x1, y1 = (int(v) for v in b)
    x0, x1 = sorted((int(_clamp(x0, 0, GRID_W - 1)), int(_clamp(x1, 0, GRID_W - 1))))
    y0, y1 = sorted((int(_clamp(y0, 0, GRID_H - 1)), int(_clamp(y1, 0, GRID_H - 1))))
    return (x0, y0, x1, y1)


def _clamp_cell(c: Sequence[int]) -> Cell:
    return (int(_clamp(int(c[0]), 0, GRID_W - 1)), int(_clamp(int(c[1]), 0, GRID_H - 1)))


def _unique_id(base: str, taken: set[str]) -> str:
    eid, n = base, 2
    while eid in taken:
        eid = f"{base}_{n}"
        n += 1
    taken.add(eid)
    return eid


def _normalize_rows(rows: Sequence[str], warnings: list[str]) -> list[list[str]]:
    """Coerce whatever we got into 27 rows of 48 chars in '012'."""
    out: list[list[str]] = []
    bad = False
    for y in range(GRID_H):
        row = rows[y] if y < len(rows) else ""
        chars = [ch if ch in "012" else "0" for ch in row[:GRID_W]]
        if len(row) != GRID_W or len(chars) != len(row) or any(ch not in "012" for ch in row):
            bad = True
        chars += ["0"] * (GRID_W - len(chars))
        out.append(chars)
    if bad or len(rows) != GRID_H:
        warnings.append("grid rows from the scan were malformed and have been padded/truncated")
    return out


def _compose_cell(base: str, new: str) -> str:
    if "2" in (base, new):
        return "2"
    if "1" in (base, new):
        return "1"
    return "0"


def _standing_cell(x: int, y: int, rows: list[list[str]]) -> Cell:
    """Move a point entity up until its 2-tall body (y-1, y) is in empty cells."""
    x = int(_clamp(x, 0, GRID_W - 1))
    y = int(_clamp(y, 1, GRID_H - 1))
    while y > 1 and (rows[y][x] != "0" or rows[y - 1][x] != "0"):
        y -= 1
    return (x, y)


def _bottom_center(bbox: BBox) -> Cell:
    x0, y0, x1, y1 = bbox
    return ((x0 + x1) // 2, y1)


def _rightmost_ground_top(rows: list[list[str]]) -> Cell:
    for x in range(GRID_W - 1, -1, -1):
        for y in range(GRID_H):
            if rows[y][x] == "1":
                return (x, max(1, y - 1))
    return (GRID_W - 3, GRID_H - 3)


# --------------------------------------------------------------------------- binding validation


def _clamp_params(binding: Binding, warnings: list[str]) -> dict[str, float | int]:
    params: dict[str, float | int] = {}
    for name, default in PARAM_DEFAULTS.get(binding.behavior, {}).items():
        raw = binding.params.get(name, default)
        try:
            val = float(raw)
        except (TypeError, ValueError):
            warnings.append(f"{binding.behavior} on component {binding.component_id}: {name}={raw!r} is not a number, using {default}")
            val = float(default)
        lo, hi, signed = PARAM_RANGES[name]
        if signed:
            mag = _clamp(abs(val), lo, hi)
            clamped = -mag if val < 0 else mag
        else:
            clamped = _clamp(val, lo, hi)
        if clamped != val:
            warnings.append(f"{binding.behavior} on component {binding.component_id}: {name}={val:g} clamped to {clamped:g}")
        params[name] = int(round(clamped)) if name in ("dx", "dy") else clamped
    if binding.behavior == "key":
        opens = binding.params.get("opens_component_id")
        if opens is not None:
            params["opens_component_id"] = int(opens)
    return params


def _validate_bindings(
    bindings: Sequence[Binding],
    by_id: dict[int, Component],
    warnings: list[str],
) -> list[Binding]:
    """Rules 1-8 of shared/behaviors.md. Returns bindings with clamped params, keys resolved."""
    valid: list[Binding] = []
    bound: set[int] = set()
    for b in bindings:
        if b.behavior not in BEHAVIOR_COLOR:
            warnings.append(f"binding dropped: unknown behavior {b.behavior!r}")
            continue
        comp = by_id.get(b.component_id)
        if comp is None:
            warnings.append(f"binding dropped: {b.behavior} on unknown component {b.component_id}")
            continue
        want = BEHAVIOR_COLOR[b.behavior]
        if want is not None and comp.color != want:
            warnings.append(
                f"binding dropped: {b.behavior} needs a {want} component but component {b.component_id} is {comp.color}"
            )
            continue
        if b.behavior == "move" and comp.area_cells > FLOOR_AREA_CELLS:
            warnings.append(
                f"binding dropped: move on component {b.component_id} ({comp.area_cells} cells) looks like the floor"
            )
            continue
        if b.component_id in bound:
            warnings.append(f"binding dropped: component {b.component_id} already has a behavior ({b.behavior} ignored)")
            continue
        valid.append(Binding(component_id=b.component_id, behavior=b.behavior, params=_clamp_params(b, warnings)))
        bound.add(b.component_id)

    door_ids = {b.component_id for b in valid if b.behavior == "door"}
    resolved: list[Binding] = []
    for b in valid:
        if b.behavior == "key":
            opens = b.params.get("opens_component_id")
            if opens is None or int(opens) not in door_ids:
                warnings.append(
                    f"key on component {b.component_id} has no valid door (opens_component_id={opens}); it stays a coin"
                )
                continue
        resolved.append(b)
    return resolved


# --------------------------------------------------------------------------- images


def _resolve_upload(url: str | None, uploads_dir: Path, public_prefix: str) -> Path | None:
    """Map a /uploads/... URL of the parent level to a file, using the uploads_dir <-> public_prefix pairing.

    The trailing path components the two share (e.g. "drafts/d_ab12") are stripped from
    both to find the uploads root on disk and its URL root.
    """
    if not url or "://" in url:
        return None
    url_parts = [p for p in public_prefix.split("/") if p]
    dir_parts = list(uploads_dir.parts)
    n = 0
    while n < min(len(url_parts), len(dir_parts)) and url_parts[-1 - n] == dir_parts[-1 - n]:
        n += 1
    url_root = "/".join(url_parts[: len(url_parts) - n])
    fs_root = Path(*dir_parts[: len(dir_parts) - n]) if len(dir_parts) > n else Path(".")
    rel = url.split("?", 1)[0].strip("/")
    if url_root:
        if not rel.startswith(url_root + "/"):
            return None
        rel = rel[len(url_root) + 1 :]
    candidate = fs_root / rel
    return candidate if candidate.is_file() else None


def _load_rgb(path: str | Path | None, size: tuple[int, int] | None = None) -> Image.Image | None:
    if not path or not Path(path).is_file():
        return None
    try:
        img = Image.open(path).convert("RGB")
    except (OSError, ValueError):
        return None
    if size and img.size != size:
        img = img.resize(size, Image.LANCZOS)
    return img


def _load_labels(path: str | None) -> np.ndarray | None:
    if not path or not Path(path).is_file():
        return None
    try:
        img = Image.open(path)
        return np.asarray(img).astype(np.int32)
    except (OSError, ValueError):
        return None


def _component_mask(labels: np.ndarray, cv_id: int) -> Image.Image:
    """Binary L image of the component's pixels, dilated 2 px so anti-aliased edges travel with it."""
    mask = Image.fromarray(((labels == cv_id) * 255).astype(np.uint8), "L")
    return mask.filter(ImageFilter.MaxFilter(5))


def _crop_new_component(drawing: Image.Image, mask: Image.Image, bbox: BBox) -> Image.Image:
    """RGBA crop of the bbox cell region at backdrop scale: (w*16, h*16) px, paper -> transparent."""
    x0, y0, x1, y1 = bbox
    sx, sy = drawing.width / GRID_W, drawing.height / GRID_H
    box = (round(x0 * sx), round(y0 * sy), round((x1 + 1) * sx), round((y1 + 1) * sy))
    rgb = np.asarray(drawing.crop(box))
    alpha = np.asarray(mask.crop(box)).copy()
    alpha[(rgb >= NEAR_WHITE).all(axis=2)] = 0
    rgba = np.dstack([rgb, alpha]).astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")
    target = ((x1 - x0 + 1) * CELL_PX, (y1 - y0 + 1) * CELL_PX)
    return out.resize(target, Image.LANCZOS) if out.size != target else out


def _crop_parent_component(backdrop: Image.Image, bbox: BBox) -> Image.Image:
    x0, y0, x1, y1 = bbox
    rgb = np.asarray(backdrop.crop((x0 * CELL_PX, y0 * CELL_PX, (x1 + 1) * CELL_PX, (y1 + 1) * CELL_PX)))
    alpha = np.where((rgb >= NEAR_WHITE).all(axis=2), 0, 255).astype(np.uint8)
    return Image.fromarray(np.dstack([rgb, alpha]).astype(np.uint8), "RGBA")


def _whiten_mask(backdrop: Image.Image, mask: Image.Image) -> Image.Image:
    small = mask.resize(backdrop.size, Image.BOX)
    arr = np.asarray(backdrop).copy()
    arr[np.asarray(small) > 0] = 255
    return Image.fromarray(arr, "RGB")


def _whiten_bbox(backdrop: Image.Image, bbox: BBox) -> Image.Image:
    x0, y0, x1, y1 = bbox
    arr = np.asarray(backdrop).copy()
    arr[y0 * CELL_PX : (y1 + 1) * CELL_PX, x0 * CELL_PX : (x1 + 1) * CELL_PX] = 255
    return Image.fromarray(arr, "RGB")


# --------------------------------------------------------------------------- compile


def compile_level(
    cv: CVResult,
    interp: Interpretation | None,
    parent: Level | None,
    author: str,
    game_id: str | None,
    level_id: str,
    uploads_dir: str,
    public_prefix: str,
) -> Level:
    """Build the Level document and write its image files.

    Writes player.png, backdrop.png and comp_<id>.png into uploads_dir and sets
    the URLs on the level as public_prefix + "/" + filename, for example
    "/uploads/drafts/d_ab12/backdrop.png".
    """
    warnings: list[str] = list(cv.warnings)
    out_dir = Path(uploads_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = public_prefix.rstrip("/")

    def url_for(name: str) -> str:
        return f"{prefix}/{name}"

    parent_components: list[Component] = list(parent.components) if parent else []
    offset = remix_offset(parent_components)
    new_components = renumber_new_components(cv.components, parent_components)
    new_by_id: dict[int, CVComponent] = {c.id: c for c in new_components}
    parent_by_id: dict[int, Component] = {c.id: c for c in parent_components}
    all_by_id: dict[int, Component] = {**parent_by_id, **new_by_id}

    # 1. Interpretation -> validated bindings and annotation ids.
    bindings: list[Binding] = []
    annotation_ids: set[int] = set()
    timer_seconds: int | None = None
    if interp is None:
        warnings.append("rules_not_read")
    else:
        if not interp.safety_ok:
            warnings.append(f"unsafe_content: {interp.safety_reason or 'flagged by the vision model'}")
        bindings = _validate_bindings(interp.bindings, all_by_id, warnings)
        for aid in interp.annotation_component_ids:
            if aid in new_by_id:
                annotation_ids.add(aid)
            elif aid in parent_by_id:
                warnings.append(f"annotation id {aid} is a parent component and was left in place")
            else:
                warnings.append(f"annotation id {aid} does not exist")
        if interp.timer_seconds is not None:
            if interp.timer_seconds < 1:
                warnings.append(f"timer {interp.timer_seconds}s ignored")
            else:
                t = int(_clamp(int(interp.timer_seconds), *TIMER_RANGE))
                if t != interp.timer_seconds:
                    warnings.append(f"timer {interp.timer_seconds}s clamped to {t}s")
                timer_seconds = t
    kept: list[Binding] = []
    for b in bindings:  # an "S" or a flag may be both an annotation and a start/checkpoint; geometry behaviors may not
        if b.component_id in annotation_ids and b.behavior not in ("start", "checkpoint"):
            warnings.append(f"binding dropped: {b.behavior} on component {b.component_id}, which is an annotation")
        else:
            kept.append(b)
    bindings = kept
    by_behavior: dict[int, Binding] = {b.component_id: b for b in bindings}
    dynamic_new = {b.component_id for b in bindings if b.behavior in DYNAMIC_BEHAVIORS and b.component_id in new_by_id}
    dynamic_parent = {b.component_id for b in bindings if b.behavior in DYNAMIC_BEHAVIORS and b.component_id in parent_by_id}

    # 2. Grid: clear annotation + dynamic cells from the new ink, then compose over the parent.
    new_rows = _normalize_rows(cv.grid_rows, warnings)
    cleared_ids = annotation_ids | dynamic_new
    retained_cover: dict[Cell, str] = {}
    for c in new_components:
        if c.id in cleared_ids or c.color not in ("black", "red"):
            continue
        for cell in c.cells:
            cat = "2" if c.color == "red" else "1"
            retained_cover[tuple(cell)] = _compose_cell(retained_cover.get(tuple(cell), "0"), cat)
    for cid in cleared_ids:
        for cell in new_by_id[cid].cells:
            x, y = cell
            if 0 <= x < GRID_W and 0 <= y < GRID_H:
                new_rows[y][x] = retained_cover.get((x, y), "0")
    if parent:
        base_rows = [list(r) for r in parent.grid.rows]
        for cid in dynamic_parent:  # the parent's per-cell coverage is gone; its bbox is the best we have
            x0, y0, x1, y1 = _clamp_bbox(parent_by_id[cid].bbox)
            for y in range(y0, y1 + 1):
                for x in range(x0, x1 + 1):
                    base_rows[y][x] = "0"
        rows = [[_compose_cell(base_rows[y][x], new_rows[y][x]) for x in range(GRID_W)] for y in range(GRID_H)]
    else:
        rows = new_rows

    # 3. Images: backdrop (+ parent compose), dynamic component crops, sprite.
    backdrop = _load_rgb(cv.backdrop_path, BACKDROP_SIZE)
    if backdrop is None:
        warnings.append("backdrop image missing; using a blank one")
        backdrop = Image.new("RGB", BACKDROP_SIZE, "white")
    labels = _load_labels(cv.labels_path) if dynamic_new else None
    drawing = _load_rgb(cv.drawing_path) if dynamic_new else None
    if dynamic_new and (labels is None or drawing is None):
        warnings.append("drawing/labels images missing; dynamic components have no image")
    if labels is not None and drawing is not None and labels.shape[:2] != (drawing.height, drawing.width):
        warnings.append("labels image size differs from the drawing; dynamic components have no image")
        labels = drawing = None
    comp_images: dict[int, str] = {}
    for cid in sorted(dynamic_new):
        comp = new_by_id[cid]
        if labels is None or drawing is None:
            continue
        mask = _component_mask(labels, cid - offset)
        if mask.getbbox() is None:
            warnings.append(f"component {cid} has no pixels in the labels image")
        try:
            crop = _crop_new_component(drawing, mask, _clamp_bbox(comp.bbox))
            name = f"comp_{cid}.png"
            crop.save(out_dir / name)
            comp_images[cid] = url_for(name)
            backdrop = _whiten_mask(backdrop, mask)
        except (OSError, ValueError) as exc:
            warnings.append(f"could not crop component {cid}: {exc}")

    parent_backdrop: Image.Image | None = None
    if parent:
        parent_backdrop = _load_rgb(_resolve_upload(parent.source.backdrop_url, out_dir, prefix), BACKDROP_SIZE)
        if parent_backdrop is not None:
            backdrop = ImageChops.darker(parent_backdrop, backdrop)
        elif parent.source.backdrop_url:
            warnings.append("parent backdrop could not be found; the remix shows only the new ink")
        for cid in sorted(dynamic_parent):
            bbox = _clamp_bbox(parent_by_id[cid].bbox)
            if parent_backdrop is not None:
                name = f"comp_{cid}.png"
                _crop_parent_component(parent_backdrop, bbox).save(out_dir / name)
                comp_images[cid] = url_for(name)
            backdrop = _whiten_bbox(backdrop, bbox)
    backdrop.save(out_dir / "backdrop.png")
    backdrop_url = url_for("backdrop.png")

    sprite_url: str | None = None
    sprite_src: Path | None = Path(cv.sprite_path) if cv.sprite_path and Path(cv.sprite_path).is_file() else None
    if sprite_src is None and parent:
        sprite_src = _resolve_upload(parent.sprites.player, out_dir, prefix)
    if sprite_src is not None:
        sprite_dst = out_dir / "player.png"
        try:
            # run_scan may already have written player.png into this very folder
            # (the scan router uses one work dir); copying a file onto itself raises.
            if not (sprite_dst.exists() and sprite_dst.samefile(sprite_src)):
                shutil.copyfile(sprite_src, sprite_dst)
            sprite_url = url_for("player.png")
        except OSError as exc:
            warnings.append(f"could not copy the character sprite: {exc}")

    # 4. Entities.
    entities: list[Entity] = []
    taken: set[str] = set()
    has_green = any(c.color == "green" for c in cv.components)
    new_goal: Cell | None = _clamp_cell(cv.goal) if cv.goal is not None else None
    start_binding = next((b for b in bindings if b.behavior == "start"), None)
    parent_goal: Entity | None = None
    parent_start: Entity | None = None
    if parent:
        replace_goal = has_green and new_goal is not None
        for e in parent.entities:
            if e.component_id is not None and e.component_id in by_behavior:
                continue  # bound again in this remix: the new binding owns it
            if e.type == "goal":
                if replace_goal:
                    continue
                parent_goal = e
            if e.type == "player_start":
                if start_binding is not None:
                    continue
                parent_start = e
            copied = e.model_copy()
            src = _resolve_upload(e.image_url, out_dir, prefix)
            if src is not None:
                name = f"comp_{e.component_id}.png" if e.component_id is not None else f"parent_{e.id}.png"
                try:
                    shutil.copyfile(src, out_dir / name)
                    copied.image_url = url_for(name)
                except OSError:
                    pass
            entities.append(copied)
            taken.add(e.id)

    coins = [_clamp_cell(c) for c in cv.coins]
    entity_for_component: dict[int, str] = {}
    key_opens: dict[str, int] = {}  # key entity id -> door component id, resolved once every entity exists
    for b in bindings:
        comp = all_by_id[b.component_id]
        bbox = _clamp_bbox(comp.bbox)
        x0, y0, x1, y1 = bbox
        w, h = x1 - x0 + 1, y1 - y0 + 1
        eid = _unique_id("start" if b.behavior == "start" else f"e{b.component_id}", taken)
        entity_for_component[b.component_id] = eid
        if b.behavior == "move":
            dx, dy = int(b.params["dx"]), int(b.params["dy"])
            dx = int(_clamp(x0 + dx, 0, GRID_W - w)) - x0
            dy = int(_clamp(y0 + dy, 0, GRID_H - h)) - y0
            if dx == 0 and dy == 0:
                warnings.append(f"moving platform {b.component_id} has no room to move")
            entities.append(
                Entity(
                    id=eid,
                    type="moving_platform",
                    component_id=b.component_id,
                    bbox=bbox,
                    image_url=comp_images.get(b.component_id),
                    path=[(x0, y0), (x0 + dx, y0 + dy)],
                    speed=float(b.params["speed"]),
                )
            )
        elif b.behavior == "patrol":
            dx = int(b.params["dx"])
            dx = int(_clamp(x0 + dx, 0, GRID_W - w)) - x0
            entities.append(
                Entity(
                    id=eid,
                    type="enemy",
                    component_id=b.component_id,
                    bbox=bbox,
                    image_url=comp_images.get(b.component_id),
                    patrol={"dx": dx, "speed": float(b.params["speed"])},
                )
            )
        elif b.behavior == "door":
            entities.append(
                Entity(id=eid, type="door", component_id=b.component_id, bbox=bbox, image_url=comp_images.get(b.component_id))
            )
        elif b.behavior == "bounce":
            entities.append(
                Entity(id=eid, type="bounce_pad", component_id=b.component_id, bbox=bbox, strength=float(b.params["strength"]))
            )
        elif b.behavior == "key":
            # The CV coin that sits on this blue component becomes the key.
            cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
            cell = min(coins, key=lambda c: (c[0] - cx) ** 2 + (c[1] - cy) ** 2, default=None)
            if cell is None or abs(cell[0] - cx) > w or abs(cell[1] - cy) > h:
                cell = ((x0 + x1) // 2, (y0 + y1) // 2)
            else:
                coins.remove(cell)
            key_opens[eid] = int(b.params["opens_component_id"])
            entities.append(Entity(id=eid, type="key", component_id=b.component_id, x=cell[0], y=cell[1], opens="pending"))
        elif b.behavior == "checkpoint":
            x, y = _standing_cell(*_bottom_center(bbox), rows)
            entities.append(Entity(id=eid, type="checkpoint", component_id=b.component_id, x=x, y=y))
        elif b.behavior == "start":
            x, y = _standing_cell(*_bottom_center(bbox), rows)
            entities.append(Entity(id=eid, type="player_start", component_id=b.component_id, x=x, y=y))
    for e in entities:
        if e.id in key_opens:
            e.opens = entity_for_component[key_opens[e.id]]

    if start_binding is None and parent_start is None:
        x, y = _standing_cell(*_clamp_cell(cv.player_start), rows)
        entities.append(Entity(id=_unique_id("start", taken), type="player_start", x=x, y=y))

    if parent_goal is None:
        if new_goal is None:
            new_goal = _rightmost_ground_top(rows)
            warnings.append("no goal drawn; placed one on the rightmost ground")
        entities.append(Entity(id=_unique_id("goal", taken), type="goal", x=new_goal[0], y=new_goal[1]))

    coin_n = sum(1 for e in entities if e.type == "coin")
    for cell in coins:
        coin_n += 1
        entities.append(Entity(id=_unique_id(f"c{coin_n}", taken), type="coin", x=cell[0], y=cell[1]))

    # 5. Rules: parent rules that still resolve, then key and timer rules.
    rules: list[Rule] = []
    entity_ids = {e.id for e in entities}
    if parent:
        for r in parent.rules:
            if r.when.startswith("timer:") and timer_seconds is not None:
                continue
            refs = [s.split(":", 1)[1] for s in (r.when, r.then) if s.startswith(("collect:", "touch:", "open:"))]
            if all(ref in entity_ids for ref in refs):
                rules.append(r)
    for e in entities:
        if e.type == "key" and e.opens in entity_ids:
            rules.append(Rule(when=f"collect:{e.id}", then=f"open:{e.opens}"))
    if timer_seconds is not None:
        rules.append(Rule(when=f"timer:{timer_seconds}", then="lose"))

    # 6. Components kept on the level: parent's, plus the new ones that are geometry.
    components: list[Component] = list(parent_components) + [
        Component(id=c.id, color=c.color, bbox=_clamp_bbox(c.bbox), area_cells=max(0, c.area_cells))
        for c in new_components
        if c.id not in annotation_ids
    ]

    title = (interp.title or "").strip()[:80] if interp else ""
    if not title:
        title = f"Remix of {parent.title}" if parent else "Untitled level"

    return Level(
        id=level_id,
        game_id=game_id or (parent.game_id if parent else None),
        parent_id=parent.id if parent else None,
        order_index=0,
        title=title,
        author=author or "anonymous",
        created_at=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        source=Source(kind=cv.mode, photo_url=None, backdrop_url=backdrop_url, template_version=1),
        grid=Grid(rows=["".join(r) for r in rows]),
        sprites=Sprites(player=sprite_url),
        components=components,
        entities=entities,
        rules=rules,
        meta=Meta(solvable=None, warnings=warnings, notes_transcript=(interp.notes_transcript if interp else "") or ""),
    )
