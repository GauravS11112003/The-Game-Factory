"""Template v2: drawing sheets and pack PDFs (PLAN_V2 §6.4, §6.5). Lane C.

Every page keeps the v1 A4 layout (ArUco markers, swatches, the 240 × 135 mm drawing area = 48 × 27 cells) and adds:
- a header "DRAW A LEVEL · Sheet n of k" with a per-sheet subtitle (name line on sheet 1, "keep drawing" after);
- seam marks: gray row numbers 3, 6, …, 24 on both edges of the drawing area and "sheet n−1 / sheet n+1" arrows;
- the character and rules boxes on sheet 1 only; sheets 2..k show a pack map (where this sheet sits) instead;
- the QR v2 payload `dal2|p|<pack_id>|<n>/<k>` (a sheet printed without a server pack: `dal2|p|blank|1/1`).

Remix prints carry the parent's ink in gray #B0B0B0 (the background class), with parent coins, keys and goals as
gray *outlines* only, plus gray dashes at the seam columns where the neighbour's terrain meets this sheet.
Extend prints one sheet with the parent's last 2 columns in gray at its left edge, a dashed line where the parent ends
and its terrain heights there as dashes (cv/stitch.py maps the sheet to world x = 48·k_parent − 2).

The game's Rules Sheet (§8.2) and Library Sheet (§8.1) share the markers and the QR position, so the same rectifier
reads them; every OMR box is drawn at the mm in template_spec_v2.json that cv/checkbox.py registers on.

    make_pack_pdf(pack, parent) -> PDF bytes (k pages; 1 for extend)
    make_rules_pdf(game_id, current=None) -> PDF bytes (1 page)
    make_library_pdf(game_id, types=()) -> PDF bytes (the sheet, plus a reference page of the existing types)
    render_sheet(n, k, qr_payload=...) / render_rules_sheet / render_library_sheet -> PIL image (2970 × 2100)

CLI:  uv run --no-sync python -m app.template.generate_v2 pack --pack-id abcd1234 --k 3 --out ../out/pack.pdf
      uv run --no-sync python -m app.template.generate_v2 blank --out ../out/blank_v2.pdf
      uv run --no-sync python -m app.template.generate_v2 rules --game-id g_abcd --out ../out/rules.pdf
      uv run --no-sync python -m app.template.generate_v2 library --game-id g_abcd [--types types.json] --out lib.pdf
"""
from __future__ import annotations

import argparse
import io
from functools import lru_cache
from pathlib import Path
from typing import TYPE_CHECKING, Any, Sequence

import cv2
import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFont

from app.template import spec_v2

if TYPE_CHECKING:
    from app.cv.scan_v2 import PackInfo

_BOLD_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    "C:/Windows/Fonts/arialbd.ttf",
]
_REGULAR_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    "C:/Windows/Fonts/arial.ttf",
]

FontT = ImageFont.FreeTypeFont | ImageFont.ImageFont


@lru_cache(maxsize=128)
def font(size_px: int, bold: bool = False) -> FontT:
    """A TrueType font at size_px (first hit of the candidate list), else Pillow's built-in font."""
    size_px = max(6, int(size_px))
    for path in _BOLD_FONTS if bold else _REGULAR_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size_px)
            except OSError:
                continue
    return ImageFont.load_default(size=size_px)


def _mm(v: float) -> int:
    return spec_v2.mm_to_px(v)


def _rgb(name: str) -> tuple[int, int, int]:
    return spec_v2.hex_to_rgb(spec_v2.colors()[name])


def _hex(h: str) -> tuple[int, int, int]:
    return spec_v2.hex_to_rgb(h)


def _fit_font(text: str, max_w: int, size: int, bold: bool = False, min_size: int = 10) -> FontT:
    f = font(size, bold)
    while f.getlength(text) > max_w and size > min_size:
        size -= 2
        f = font(size, bold)
    return f


# ------------------------------------------------------------------------------------------------------
# page elements
# ------------------------------------------------------------------------------------------------------


def _draw_markers(img: Image.Image) -> None:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    for m in spec_v2.marker_specs():
        x, y, w, _ = m["rect_px"]
        marker = cv2.aruco.generateImageMarker(dictionary, m["id"], w)
        img.paste(Image.fromarray(marker).convert("RGB"), (x, y))


def _draw_qr(img: Image.Image, payload: str) -> None:
    x, y, w, h = spec_v2.qr_rect_px()
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1, box_size=10)
    qr.add_data(payload)
    qr.make(fit=True)
    tile = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img.paste(tile.resize((w, h), Image.Resampling.NEAREST), (x, y))


def _draw_header(draw: ImageDraw.ImageDraw, title: str, subtitle: str, sheet_label: str | None) -> None:
    x, y, w, _ = spec_v2.header_rect_px()
    label_w = 0
    if sheet_label:
        lf = font(_mm(4.6), bold=True)
        label_w = int(lf.getlength(sheet_label)) + _mm(3)
        draw.text((x + w - label_w + _mm(3), y + _mm(1.2)), sheet_label, fill=(40, 40, 40), font=lf)
    tf = _fit_font(title, w - label_w, _mm(6.5), bold=True, min_size=_mm(3))
    draw.text((x, y), title, fill="black", font=tf)
    sf = _fit_font(subtitle, w, _mm(3.6), min_size=12)
    draw.text((x, y + _mm(8.5)), subtitle, fill=(60, 60, 60), font=sf)


def _draw_legend(draw: ImageDraw.ImageDraw) -> None:
    x, y, w, _ = spec_v2.legend_rect_px()
    legend = spec_v2.load_spec()["legend"]
    items = legend["items"]
    sq, gap, pad = _mm(4), _mm(1.2), _mm(3)
    size = _mm(2.6)
    while True:
        lf = font(size)
        widths = [sq + gap + lf.getlength(item["label"]) for item in items]
        if sum(widths) + pad * (len(items) - 1) <= w or size <= 10:
            break
        size -= 1
    sx = x
    for item, iw in zip(items, widths):
        draw.rectangle([sx, y, sx + sq, y + sq], fill=_rgb(item["color"]))
        draw.text((sx + sq + gap, y - _mm(0.3)), item["label"], fill="black", font=lf)
        sx += int(iw) + pad
    hint = legend["hint"]
    draw.text((x, y + _mm(7)), hint, fill=(60, 60, 60), font=_fit_font(hint, w, _mm(2.4), min_size=10))


def _draw_drawing_area(draw: ImageDraw.ImageDraw) -> None:
    x, y, w, h = spec_v2.drawing_area_px()
    area = spec_v2.load_spec()["drawing_area"]
    bw = max(1, _mm(area["border_width_mm"]))
    draw.rectangle([x, y, x + w, y + h], outline=_hex(area["border_color"]), width=bw)
    dot = _hex(area["dot_grid_color"])
    r = max(1, _mm(area["dot_radius_mm"]))
    step = _mm(area["dot_grid_spacing_mm"])
    cols, rows = spec_v2.grid_cells()
    for j in range(1, rows):
        cy = y + j * step
        for i in range(1, cols):
            cx = x + i * step
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=dot)


def _rotated_text(img: Image.Image, text: str, center: tuple[int, int], size: int, color: tuple[int, int, int],
                  angle: int) -> None:
    f = font(size, bold=True)
    tw = int(f.getlength(text)) + 4
    th = size + 8
    layer = Image.new("RGBA", (tw, th), (255, 255, 255, 0))
    ImageDraw.Draw(layer).text((2, 2), text, fill=color + (255,), font=f)
    layer = layer.rotate(angle, expand=True)
    img.paste(layer, (center[0] - layer.width // 2, center[1] - layer.height // 2), layer)


def _arrow(draw: ImageDraw.ImageDraw, x: int, y0: int, y1: int, color: tuple[int, int, int], head: int, width: int,
           pointing: str) -> None:
    """A vertical-band arrow drawn as a horizontal arrow `pointing` left or right, centred at x between y0 and y1."""
    cy = (y0 + y1) // 2
    L = head * 3
    if pointing == "left":
        draw.line([(x + L // 2, cy), (x - L // 2 + head, cy)], fill=color, width=width)
        draw.polygon([(x - L // 2, cy), (x - L // 2 + head, cy - head // 2), (x - L // 2 + head, cy + head // 2)], fill=color)
    else:
        draw.line([(x - L // 2, cy), (x + L // 2 - head, cy)], fill=color, width=width)
        draw.polygon([(x + L // 2, cy), (x + L // 2 - head, cy - head // 2), (x + L // 2 - head, cy + head // 2)], fill=color)


def _draw_seam_marks(img: Image.Image, draw: ImageDraw.ImageDraw, n: int, k: int) -> None:
    sm = spec_v2.seam_marks()
    color = _hex(sm["color"])
    x, y, w, h = spec_v2.drawing_area_px()
    cell = _mm(spec_v2.cell_mm())
    tick = _mm(float(sm.get("tick_mm", 2)))
    nf = font(_mm(float(sm.get("number_height_mm", 2.4))), bold=True)
    for r in sm["row_numbers"]:
        yy = y + int(r) * cell
        draw.line([(x - tick, yy), (x, yy)], fill=color, width=3)
        draw.line([(x + w, yy), (x + w + tick, yy)], fill=color, width=3)
        label = str(r)
        lw = nf.getlength(label)
        asc = nf.size // 2 + 2
        draw.text((x - tick - _mm(0.6) - lw, yy - asc), label, fill=color, font=nf)
        draw.text((x + w + tick + _mm(0.6), yy - asc), label, fill=color, font=nf)
    ah = _mm(float(sm.get("arrow_height_mm", 3.2)))
    # the marker columns (x 8-23 mm and 274-289 mm) are free between the corner markers
    left_x, right_x = _mm(15.5), _mm(281.5)
    mid = y + h // 2
    if n > 1:
        _rotated_text(img, sm["left_label_format"].replace("← ", "").format(prev=n - 1), (left_x, mid), ah, color, 90)
        _arrow(draw, left_x, mid + _mm(20), mid + _mm(20), color, _mm(3), 6, "left")
        _arrow(draw, left_x, mid - _mm(20), mid - _mm(20), color, _mm(3), 6, "left")
    if n < k:
        _rotated_text(img, sm["right_label_format"].replace(" →", "").format(next=n + 1), (right_x, mid), ah, color, -90)
        _arrow(draw, right_x, mid + _mm(20), mid + _mm(20), color, _mm(3), 6, "right")
        _arrow(draw, right_x, mid - _mm(20), mid - _mm(20), color, _mm(3), 6, "right")


def _draw_labelled_box(draw: ImageDraw.ImageDraw, rect: spec_v2.RectPx, label: str) -> None:
    x, y, w, h = rect
    line = _hex(spec_v2.load_spec()["rules_box"]["line_color"])
    draw.rectangle([x, y, x + w, y + h], outline=line, width=3)
    # Labels sit in the gap above the box so the whole interior stays free for ink.
    draw.text((x, y - _mm(3.4)), label, fill=(90, 90, 90), font=font(_mm(2.6)))


def _draw_rules_box(draw: ImageDraw.ImageDraw) -> None:
    rules = spec_v2.load_spec()["rules_box"]
    x, y, w, h = spec_v2.rules_box_px()
    _draw_labelled_box(draw, (x, y, w, h), rules["label"])
    nl = int(rules["ruled_lines"])
    line = _hex(rules["line_color"])
    for i in range(1, nl + 1):
        ly = y + round(h * i / (nl + 1))
        draw.line([(x + _mm(2), ly), (x + w - _mm(2), ly)], fill=line, width=2)


def _draw_swatches(draw: ImageDraw.ImageDraw) -> None:
    sw = spec_v2.load_spec()["swatches"]
    for p in spec_v2.swatch_patches_px():
        x, y, w, h = p["rect_px"]
        if p["outlined"]:
            draw.rectangle([x, y, x + w, y + h], outline=_rgb("gray"), width=3)
        else:
            draw.rectangle([x, y, x + w, y + h], fill=_hex(p["hex"]))
    rx, _, rw, _ = spec_v2.swatches_rect_px()
    label = sw["label"]
    draw.text((rx, _mm(sw["label_y_mm"])), label, fill=(90, 90, 90), font=_fit_font(label, rw, _mm(2.0), min_size=8))


def _draw_pack_map(draw: ImageDraw.ImageDraw, n: int, k: int) -> None:
    pm = spec_v2.load_spec()["pack_map"]
    x, y, w, h = spec_v2.pack_map_px()
    outline = _hex(pm["outline_color"])
    fill = _hex(pm["fill_color"])
    label = pm["label_format"].format(n=n, k=k)
    lf = _fit_font(label, w, _mm(3.2), bold=True, min_size=12)
    draw.text((x, y), label, fill=(70, 70, 70), font=lf)
    boxes = spec_v2.pack_map_boxes_px(k)  # the same geometry cv/stitch.read_pack_map reads back
    bh = boxes[0][3]
    nf = font(max(12, bh // 3), bold=True)
    for i, (bx, top, bw, bh) in enumerate(boxes, start=1):
        box = [bx, top, bx + bw, top + bh]
        if i == n:
            draw.rectangle(box, fill=fill, outline=(90, 90, 90), width=5)
        else:
            draw.rectangle(box, outline=outline, width=3)
        t = str(i)
        tw = nf.getlength(t)
        draw.text((bx + bw / 2 - tw / 2, top + bh / 2 - nf.size / 2 - 2), t, fill=(90, 90, 90) if i == n else outline, font=nf)


# ------------------------------------------------------------------------------------------------------
# parent ink in gray (remix and extend)
# ------------------------------------------------------------------------------------------------------

_OUTLINE_COLORS = {"blue", "green"}  # parent pickups and goals: outlines only (§6.5)


def _strokes_of(parent: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not parent:
        return []
    ink = parent.get("ink") or {}
    return list(ink.get("strokes") or [])


def _draw_parent_ink(img: Image.Image, strokes: Sequence[dict[str, Any]], x_from: float, x_to: float,
                     shift: float) -> None:
    """Draw parent strokes overlapping world x ∈ [x_from, x_to) in gray, shifted by -shift cells into the area."""
    from app.cv.features import draw_stroke  # local: keeps the template importable without the CV stack loaded

    ax, ay, aw, ah = spec_v2.drawing_area_px()
    ppc = float(spec_v2.cell_working_px())
    arr = np.array(img)
    area = np.ascontiguousarray(arr[ay : ay + ah, ax : ax + aw])
    gray = _rgb("gray")
    for s in strokes:
        pts = s.get("pts") or []
        if not pts:
            continue
        xs = [float(p[0]) for p in pts]
        if max(xs) < x_from or min(xs) >= x_to:
            continue
        kind = str(s.get("kind", "line"))
        w = [float(v) for v in (s.get("w") or [0.5])]
        closed = bool(s.get("closed", False))
        if str(s.get("color")) in _OUTLINE_COLORS:
            if kind == "dot":
                cx, cy = (float(pts[0][0]) - shift) * ppc, float(pts[0][1]) * ppc
                r = max(0.35, w[0] / 2.0) * ppc
                cv2.circle(area, (int(round(cx)), int(round(cy))), int(round(r)), gray, 4, cv2.LINE_AA)
            else:
                draw_stroke(area, "line", pts, [0.07], closed or kind == "blob", ppc=ppc, origin_cells=(shift, 0.0),
                            color=gray, aa=True, min_px=3)
            continue
        draw_stroke(area, kind, pts, w, closed, ppc=ppc, origin_cells=(shift, 0.0), color=gray, aa=True, min_px=3)
    arr[ay : ay + ah, ax : ax + aw] = area
    img.paste(Image.fromarray(arr))


def _seam_heights(strokes: Sequence[dict[str, Any]], seam_x: float) -> list[float]:
    """y values where the parent's black strokes cross world x = seam_x (terrain end heights)."""
    ys: list[float] = []
    for s in strokes:
        if str(s.get("color")) != "black" or s.get("kind") != "line":
            continue
        pts = [(float(p[0]), float(p[1])) for p in s.get("pts") or []]
        for (x0, y0), (x1, y1) in zip(pts[:-1], pts[1:]):
            if (x0 - seam_x) * (x1 - seam_x) <= 0 and x0 != x1:
                t = (seam_x - x0) / (x1 - x0)
                ys.append(y0 + t * (y1 - y0))
    out: list[float] = []
    for y in sorted(ys):
        if not out or abs(y - out[-1]) > 0.5:
            out.append(y)
    return out


def _draw_neighbour_dashes(draw: ImageDraw.ImageDraw, heights: Sequence[float], column: int) -> None:
    sm = spec_v2.seam_marks()
    dash_len, dash_gap = (float(v) for v in sm.get("neighbour_dash_mm", [3, 1.2]))
    ax, ay, _, _ = spec_v2.drawing_area_px()
    cell = _mm(spec_v2.cell_mm())
    gray = _hex(sm["color"])
    x0 = ax + column * cell
    for hy in heights:
        yy = ay + int(round(hy * cell))
        x = x0
        while x < x0 + cell:
            draw.line([(x, yy), (min(x0 + cell, x + _mm(dash_len)), yy)], fill=gray, width=5)
            x += _mm(dash_len + dash_gap)


# ------------------------------------------------------------------------------------------------------
# sheets and PDFs
# ------------------------------------------------------------------------------------------------------


def _draw_extend_guide(draw: ImageDraw.ImageDraw, overlap_c: float) -> None:
    """The extend sheet's seam: a dashed gray line where the parent level ends (overlap_c cells from the left)."""
    sm = spec_v2.seam_marks()
    gray = _hex(sm["color"])
    ax, ay, _, ah = spec_v2.drawing_area_px()
    x = ax + int(round(overlap_c * _mm(spec_v2.cell_mm())))
    y = ay
    dash, gap = _mm(3), _mm(2)
    while y < ay + ah:
        draw.line([(x, y), (x, min(ay + ah, y + dash))], fill=gray, width=4)
        y += dash + gap
    label = str(spec_v2.load_spec()["header"].get("extend_seam_label", ""))
    if label:
        f = font(_mm(2.4), bold=True)
        draw.text((x + _mm(1.0), ay + _mm(1.0)), label, fill=gray, font=f)


def render_sheet(
    n: int = 1,
    k: int = 1,
    *,
    qr_payload: str,
    title: str | None = None,
    parent: dict[str, Any] | None = None,
    parent_x_from: float | None = None,
    parent_shift: float | None = None,
    neighbour_left: Sequence[float] = (),
    neighbour_right: Sequence[float] = (),
    neighbour_left_column: int = 0,
    extend_screen: int | None = None,
) -> Image.Image:
    """One A4 landscape page at 10 px/mm. `parent` (a LevelV2 dict) draws its ink in gray for world x ∈
    [parent_x_from, parent_x_from + 48), shifted by parent_shift cells (defaults: this sheet's own range).
    `extend_screen` (1-based) makes it an extend sheet: the subtitle says which screen it adds and a dashed line marks
    where the parent ends."""
    header = spec_v2.load_spec()["header"]
    img = Image.new("RGB", spec_v2.canvas_size_px(), "white")
    draw = ImageDraw.Draw(img)
    if extend_screen is not None:
        subtitle = str(header.get("extend_label_format", header["name_label"])).format(n=extend_screen)
    elif n == 1:
        subtitle = header["name_label"]
    elif n == k:
        subtitle = header.get("last_label_format", "").format(prev=n - 1) or header["name_label"]
    else:
        subtitle = header.get("continue_label_format", "").format(prev=n - 1) or header["name_label"]
    sheet_label = header.get("sheet_label_format", "Sheet {n} of {k}").format(n=n, k=k) if k > 1 else None
    _draw_header(draw, title or header["title"], subtitle, sheet_label)
    _draw_legend(draw)
    _draw_drawing_area(draw)
    if n in spec_v2.character_sheets():
        _draw_labelled_box(draw, spec_v2.character_box_px(), spec_v2.load_spec()["character_box"]["label"])
    if n in spec_v2.rules_sheets():
        _draw_rules_box(draw)
    if n not in spec_v2.character_sheets() and n not in spec_v2.rules_sheets():
        _draw_pack_map(draw, n, k)
    _draw_swatches(draw)
    _draw_seam_marks(img, draw, n, k)
    if parent is not None:
        x_from = float(spec_v2.SCREEN_W_CELLS * (n - 1)) if parent_x_from is None else float(parent_x_from)
        shift = x_from if parent_shift is None else float(parent_shift)
        _draw_parent_ink(img, _strokes_of(parent), x_from, x_from + spec_v2.SCREEN_W_CELLS, shift)
        draw = ImageDraw.Draw(img)
    if extend_screen is not None:
        _draw_extend_guide(draw, float(spec_v2.seam_marks().get("extend_overlap_c", 2)))
    if neighbour_left:
        _draw_neighbour_dashes(draw, neighbour_left, neighbour_left_column)
    if neighbour_right:
        _draw_neighbour_dashes(draw, neighbour_right, spec_v2.grid_cells()[0] - 1)
    _draw_markers(img)
    _draw_qr(img, qr_payload)
    return img


def render_blank_v2() -> Image.Image:
    """A single sheet that needs no server pack: QR dal2|p|blank|1/1."""
    return render_sheet(1, 1, qr_payload=spec_v2.pack_payload(spec_v2.blank_pack_id(), 1, 1))


def to_pdf_bytes(pages: Sequence[Image.Image]) -> bytes:
    """A4 landscape PDF, one page per sheet (px_per_mm · 25.4 dpi keeps each page at 297 × 210 mm)."""
    if not pages:
        raise ValueError("no pages")
    buf = io.BytesIO()
    rgb = [p.convert("RGB") for p in pages]
    rgb[0].save(buf, format="PDF", save_all=True, append_images=rgb[1:], resolution=spec_v2.px_per_mm() * 25.4)
    return buf.getvalue()


def _parent_screens(parent: dict[str, Any] | None) -> int:
    world = (parent or {}).get("world") or {}
    try:
        return max(1, min(spec_v2.MAX_SHEETS, int(world.get("screens", 1))))
    except (TypeError, ValueError):
        return 1


def _remix_title(parent: dict[str, Any] | None) -> str | None:
    if not parent:
        return None
    fmt = spec_v2.load_spec()["header"]["remix_title_format"]
    return fmt.format(title=parent.get("title") or "a level", author=parent.get("author") or "someone")


def make_pack_pdf(pack: "PackInfo", parent: dict[str, Any] | None = None, *, title: str | None = None) -> bytes:
    """The PDF for a pack record: k blank sheets (new, game), k remix sheets over the parent, or 1 extend sheet.
    `title` replaces the "DRAW A LEVEL" heading on new and game packs (e.g. the game's title)."""
    k = max(1, min(spec_v2.MAX_SHEETS, int(pack.k)))
    pages: list[Image.Image] = []
    if pack.kind == "extend":
        # The sheet's drawing area starts 2 columns before the parent's end (cv/stitch.py maps it to world
        # x = 48·k_parent − 2): those 2 columns show the parent in gray, the dashes mark its terrain heights at the seam.
        strokes = _strokes_of(parent)
        kp = _parent_screens(parent)
        if parent is not None and kp >= spec_v2.MAX_SHEETS:
            raise ValueError(f"the parent already has {kp} screens; a level has at most {spec_v2.MAX_SHEETS}")
        overlap = float(spec_v2.seam_marks().get("extend_overlap_c", 2))
        w = float(spec_v2.SCREEN_W_CELLS * kp)
        title = _remix_title(parent)
        pages.append(
            render_sheet(1, 1, qr_payload=spec_v2.pack_payload(pack.pack_id, 1, 1), title=title, parent=parent,
                         parent_x_from=w - overlap, parent_shift=w - overlap,
                         neighbour_left=_seam_heights(strokes, w - 0.01),
                         neighbour_left_column=int(overlap), extend_screen=kp + 1)
        )
        return to_pdf_bytes(pages)
    remix = pack.kind == "remix" and parent is not None
    strokes = _strokes_of(parent) if remix else []
    for n in range(1, k + 1):
        left = _seam_heights(strokes, float(spec_v2.SCREEN_W_CELLS * (n - 1))) if remix and n > 1 else []
        right = _seam_heights(strokes, float(spec_v2.SCREEN_W_CELLS * n)) if remix and n < k else []
        pages.append(
            render_sheet(
                n, k,
                qr_payload=spec_v2.pack_payload(pack.pack_id, n, k),
                title=_remix_title(parent) if remix else title,
                parent=parent if remix else None,
                neighbour_left=left,
                neighbour_right=right,
            )
        )
    return to_pdf_bytes(pages)


def sheet_png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


# ------------------------------------------------------------------------------------------------------
# strokes into a box (library art, reference cards, the PERCEIVE library strip)
# ------------------------------------------------------------------------------------------------------

INK_HEX = {
    "black": "#1A1A1A",
    "red": "#E53935",
    "green": "#43A047",
    "blue": "#1E88E5",
    "pencil": "#6A5ACD",
    "draft": "#7FA9DD",
}


def _stroke_fields(s: Any) -> tuple[str, list[tuple[float, float]], list[float], bool, str]:
    """(kind, pts, w, closed, color) of an InkStroke model or its dict."""
    g = s.get if isinstance(s, dict) else (lambda k, d=None: getattr(s, k, d))
    pts = [(float(p[0]), float(p[1])) for p in (g("pts") or [])]
    w = [float(v) for v in (g("w") or [0.3])]
    return str(g("kind", "line")), pts, w, bool(g("closed", False)), str(g("color", "black"))


def draw_strokes_fit(
    img: np.ndarray,
    strokes: Sequence[Any],
    rect: tuple[int, int, int, int],
    *,
    pad: int = 6,
    color: tuple[int, int, int] | None = None,
    bgr: bool = True,
    max_ppc: float = 80.0,
) -> None:
    """Draw strokes (cells, any frame) into `rect` (x, y, w, h px) of a uint8 image, scaled to fit with the aspect kept
    and centred, in their ink colours (or one `color`). `bgr` picks the channel order of `img`."""
    from app.cv.features import draw_stroke  # local: keeps the template importable without the CV stack

    items = [_stroke_fields(s) for s in strokes]
    items = [it for it in items if it[1]]
    if not items:
        return
    xs = [p[0] for it in items for p in it[1]]
    ys = [p[1] for it in items for p in it[1]]
    wmax = max(max(it[2]) for it in items)
    x0, x1 = min(xs) - wmax / 2, max(xs) + wmax / 2
    y0, y1 = min(ys) - wmax / 2, max(ys) + wmax / 2
    rx, ry, rw, rh = rect
    ppc = min((rw - 2 * pad) / max(0.05, x1 - x0), (rh - 2 * pad) / max(0.05, y1 - y0), max_ppc)
    ox = x0 - (rx + rw / 2 - (x1 - x0) * ppc / 2) / ppc
    oy = y0 - (ry + rh / 2 - (y1 - y0) * ppc / 2) / ppc
    for kind, pts, w, closed, c in items:
        rgb = color or spec_v2.hex_to_rgb(INK_HEX.get(c, "#1A1A1A"))
        col = (rgb[2], rgb[1], rgb[0]) if bgr else rgb
        draw_stroke(img, kind, pts, w, closed, ppc=ppc, origin_cells=(ox, oy), color=col, aa=True, min_px=2.0,
                    min_dot_px=4.0)


# ------------------------------------------------------------------------------------------------------
# Rules Sheet (§8.2) and Library Sheet (§8.1)
# ------------------------------------------------------------------------------------------------------


def _checkbox(draw: ImageDraw.ImageDraw, rect: spec_v2.RectPx, color: tuple[int, int, int], width: int) -> None:
    """A printed OMR box: PIL draws the outline inward from [x, x + w], which is what cv/checkbox.py registers on."""
    x, y, w, h = rect
    draw.rectangle([x, y, x + w, y + h], outline=color, width=width)


def _theme_swatch(draw: ImageDraw.ImageDraw, rect: spec_v2.RectPx, t: dict[str, Any]) -> None:
    x, y, w, h = rect
    draw.rectangle([x, y, x + w, y + h], fill=_hex(t["base"]), outline=(170, 170, 170), width=2)
    ink = _hex(t.get("ink", "#C8C8C8"))
    pattern = t.get("pattern", "none")
    if pattern == "dots":
        for yy in range(y + _mm(1.2), y + h - 4, _mm(1.6)):
            for xx in range(x + _mm(1.2), x + w - 4, _mm(1.6)):
                draw.ellipse([xx - 2, yy - 2, xx + 2, yy + 2], fill=ink)
    elif pattern == "rules":
        for yy in range(y + _mm(1.6), y + h - 2, _mm(1.6)):
            draw.line([(x + 2, yy), (x + w - 2, yy)], fill=ink, width=2)
        if t.get("margin"):
            mx = x + _mm(2.5)
            draw.line([(mx, y + 2), (mx, y + h - 2)], fill=_hex(t["margin"]), width=2)
    elif pattern == "grid":
        for yy in range(y + _mm(1.4), y + h - 2, _mm(1.4)):
            draw.line([(x + 2, yy), (x + w - 2, yy)], fill=ink, width=1)
        for xx in range(x + _mm(1.4), x + w - 2, _mm(1.4)):
            draw.line([(xx, y + 2), (xx, y + h - 2)], fill=ink, width=1)
    else:
        for i in range(4):
            yy = y + _mm(1.2) + i * _mm(1.5)
            draw.line([(x + _mm(1) + i * 9, yy), (x + _mm(5) + i * 13, yy + 6)], fill=ink, width=2)


def _tick(draw: ImageDraw.ImageDraw, rect: spec_v2.RectPx, color: tuple[int, int, int] = (20, 20, 20)) -> None:
    x, y, w, h = rect
    draw.line([(x + w * 0.2, y + h * 0.55), (x + w * 0.42, y + h * 0.8), (x + w * 0.85, y + h * 0.2)], fill=color,
              width=max(4, w // 9), joint="curve")


def _current_value(current: Any, path: str) -> Any:
    if current is None:
        return None
    cur = current.model_dump() if hasattr(current, "model_dump") else dict(current)
    for k in path.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def render_rules_sheet(game_id: str, *, current: Any = None, title: str | None = None) -> Image.Image:
    """The Rules Sheet (QR dal2|rules|<game_id>): one OMR row per rule, every box at template_spec_v2.json's mm.
    `current` (GameRules or dict) prints a small gray "now" under each current choice."""
    rs = spec_v2.rules_sheet()
    payload = spec_v2.rules_payload(game_id)
    img = Image.new("RGB", spec_v2.canvas_size_px(), "white")
    draw = ImageDraw.Draw(img)
    _draw_header(draw, title or rs["title"], rs["subtitle"], None)

    # "Tick like this" example (outside every OMR row)
    lx, ly, lw, _ = spec_v2.legend_rect_px()
    ef = font(_mm(3.0), bold=True)
    label = str(rs.get("example_label", "Tick like this:"))
    draw.text((lx, ly + _mm(2.5)), label, fill=(60, 60, 60), font=ef)
    bx = lx + int(ef.getlength(label)) + _mm(3)
    ex = (bx, ly + _mm(1.5), _mm(7), _mm(7))
    ow = max(1, _mm(float(rs.get("box_outline_mm", 0.5))))
    outline = _hex(rs.get("box_outline_color", "#8A8A8A"))
    _checkbox(draw, ex, outline, ow)
    _tick(draw, ex)

    lab_x = _mm(float(rs.get("label_x_mm", 28)))
    lab_w = _mm(float(rs.get("label_w_mm", 66)))
    row_h = _mm(float(rs.get("row_h_mm", 12)))
    lf_size, hf = _mm(3.6), font(_mm(2.4))
    of = font(_mm(3.2), bold=True)
    nowf = font(_mm(1.8), bold=True)
    now_color = _hex(rs.get("now_color", "#A0A0A0"))
    themes = rs.get("theme_swatches", {})
    right = _mm(268)
    for row in spec_v2.rules_rows_px():
        y = row["y_px"]
        lf = _fit_font(row["label"], lab_w, lf_size, bold=True, min_size=_mm(2.6))
        draw.text((lab_x, y + _mm(1.4)), row["label"], fill=(25, 25, 25), font=lf)
        if row.get("hint"):
            draw.text((lab_x, y + _mm(6.6)), str(row["hint"]), fill=(120, 120, 120), font=hf)
        draw.line([(lab_x, y + row_h), (right, y + row_h)], fill=(232, 232, 232), width=2)
        cur = _current_value(current, str(row["field"]))
        for o in row["options"]:
            x0, y0, w0, h0 = o["box_px"]
            _checkbox(draw, o["box_px"], outline, ow)
            tx = x0 + w0 + _mm(float(rs.get("label_gap_mm", 3.0)))  # outside the reader's ±2 mm search window
            if "swatch_px" in o:
                _theme_swatch(draw, o["swatch_px"], themes.get(str(o["value"]), {"base": "#FFFFFF"}))
                sx, _, sw, _ = o["swatch_px"]
                tx = sx + sw + _mm(1.5)
            olf = _fit_font(str(o["label"]), _mm(40) - (tx - x0) - _mm(1), of.size, bold=True, min_size=_mm(2.2))
            draw.text((tx, y0 + h0 / 2), str(o["label"]), fill=(40, 40, 40), font=olf, anchor="lm")
            if cur is not None and cur == o["value"] and type(cur) is type(o["value"]):
                draw.text((x0 + w0 / 2, y0 + h0 + _mm(0.4)), str(rs.get("now_label", "now")), fill=now_color,
                          font=nowf, anchor="mt")

    st = rs["story_line"]
    sx, sy, sw, sh = spec_v2.rect_px(st["rect_mm"])
    lx0, lx1 = (_mm(float(v)) for v in st.get("line_x_mm", [58, 266]))
    # the label stays left of the lines: the reader looks for handwriting only between lx0 and lx1
    slf = _fit_font(st["label"], lx0 - sx - _mm(2), _mm(float(st.get("label_height_mm", 3.0))), bold=True, min_size=12)
    draw.text((sx, sy + _mm(4.5)), st["label"], fill=_hex(st.get("label_color", "#9A9A9A")), font=slf)
    for yy in st.get("lines_y_mm", []):
        draw.line([(lx0, _mm(float(yy))), (lx1, _mm(float(yy)))], fill=_hex(st.get("line_color", "#C8C8C8")), width=3)
    _draw_markers(img)
    _draw_qr(img, payload)
    return img


def make_rules_pdf(game_id: str, *, current: Any = None, title: str | None = None) -> bytes:
    """§11.3d: the game's Rules Sheet as a 1-page A4 PDF."""
    return to_pdf_bytes([render_rules_sheet(game_id, current=current, title=title)])


def _draw_library_swatches(draw: ImageDraw.ImageDraw, lib: dict[str, Any]) -> None:
    for p in spec_v2.library_swatch_patches_px():
        x, y, w, h = p["rect_px"]
        if p["outlined"]:
            draw.rectangle([x, y, x + w, y + h], outline=_rgb("gray"), width=3)
        else:
            draw.rectangle([x, y, x + w, y + h], fill=_hex(p["hex"]))
    lx, ly = (_mm(float(v)) for v in lib.get("swatch_label_mm", [172, 19]))
    draw.text((lx, ly), str(lib.get("swatch_label", "")), fill=(110, 110, 110), font=font(_mm(2.0)))


def render_library_sheet(game_id: str, *, title: str | None = None) -> Image.Image:
    """The Library Sheet (QR dal2|lib|<game_id>): 6 creature boxes, each with a drawing area, 3 symbol cells, a name
    line and 9 OMR checkboxes. Every printed mark a reader looks inside is gray, so it classifies as paper."""
    lib = spec_v2.library_sheet()
    payload = spec_v2.library_payload(game_id)
    img = Image.new("RGB", spec_v2.canvas_size_px(), "white")
    draw = ImageDraw.Draw(img)
    _draw_header(draw, title or lib["title"], lib["subtitle"], None)
    _draw_library_swatches(draw, lib)
    frame = _hex(lib.get("frame_color", "#B8B8B8"))
    area = _hex(lib.get("area_color", "#C8C8C8"))
    text = _hex(lib.get("text_color", "#8A8A8A"))
    outline = _hex(lib.get("box_outline_color", "#8A8A8A"))
    ow = max(1, _mm(float(lib.get("box_outline_mm", 0.45))))
    dot = _hex(spec_v2.load_spec()["drawing_area"]["dot_grid_color"])
    cell = _mm(spec_v2.cell_mm())
    tf, sf, nf, cf = font(_mm(3.2), bold=True), font(_mm(2.2)), font(_mm(3.0), bold=True), font(_mm(2.8), bold=True)
    for b in spec_v2.library_boxes_px():
        fx, fy, fw, fh = b["frame_px"]
        draw.rounded_rectangle([fx, fy, fx + fw, fy + fh], radius=_mm(2), outline=frame, width=4)
        draw.text(b["title_px"], str(lib.get("box_title_format", "Creature {i}")).format(i=b["index"]), fill=text, font=tf)
        dx, dy, dw, dh = b["drawing_px"]
        draw.rectangle([dx, dy, dx + dw, dy + dh], outline=area, width=3)
        for yy in range(dy + cell, dy + dh, cell):
            for xx in range(dx + cell, dx + dw, cell):
                draw.ellipse([xx - 2, yy - 2, xx + 2, yy + 2], fill=dot)
        slx, sly = b["symbol_label_px"]
        for j, line in enumerate(lib.get("symbol_label", [])):
            draw.text((slx, sly + j * _mm(2.6) - _mm(0.4)), str(line), fill=text, font=sf)
        for r in b["symbols_px"]:
            x, y, w, h = r
            draw.rectangle([x, y, x + w, y + h], outline=area, width=3)
        draw.text(b["name_label_px"], str(lib.get("name_label", "Name:")), fill=text, font=nf)
        x0, y0, x1, y1 = b["name_line_px"]
        draw.line([(x0, y0), (x1, y1)], fill=area, width=3)
        for c in b["checks"]:
            x, y, w, h = c["box_px"]
            _checkbox(draw, c["box_px"], outline, ow)
            draw.text((x + w + _mm(float(lib.get("label_gap_mm", 2.6))), y + h / 2), str(c["label"]), fill=(85, 85, 85),
                      font=cf, anchor="lm")
    _draw_markers(img)
    _draw_qr(img, payload)
    return img


def _type_fields(t: Any) -> dict[str, Any]:
    d = t.model_dump(mode="json") if hasattr(t, "model_dump") else dict(t or {})
    return d


def behavior_words(behavior: Any, spiky: bool = False) -> str:
    """'hopper · spiky · fast'-style words for a library type's behavior (cards, the PERCEIVE strip)."""
    b = behavior.model_dump() if hasattr(behavior, "model_dump") else dict(behavior or {})
    kind = b.get("kind", "static")
    words = [str(b.get("archetype", "")) if kind == "enemy" else ("stays still" if kind == "static" else str(kind))]
    if spiky or b.get("spiky"):
        words.append("spiky")
    return " · ".join(w for w in words if w)


def render_library_reference(types: Sequence[Any], *, title: str | None = None) -> Image.Image | None:
    """A reference page of the game's existing types: art, name, circled letter, behavior and paper symbol, so a kid
    knows what to draw on a level sheet to use them. None when there are no types. No markers: it is not scanned."""
    items = [_type_fields(t) for t in types][:24]
    if not items:
        return None
    lib = spec_v2.library_sheet()
    img = Image.new("RGB", spec_v2.canvas_size_px(), "white")
    draw = ImageDraw.Draw(img)
    _draw_header(draw, title or str(lib.get("reference_title", "Already in this game")),
                 str(lib.get("reference_hint", "")), None)
    cols, gap = 6, _mm(3)
    x0, y0, w = _mm(28), _mm(30), _mm(240)
    cw = (w - (cols - 1) * gap) // cols
    ch = int(cw * 1.25)
    arr = np.array(img)
    cells = []
    for i, t in enumerate(items):
        cx = x0 + (i % cols) * (cw + gap)
        cy = y0 + (i // cols) * (ch + gap)
        cells.append((t, cx, cy))
        art = (t.get("art") or {}).get("strokes") or []
        draw_strokes_fit(arr, art, (cx + 8, cy + 8, cw - 16, int(ch * 0.62)), bgr=False)
        sym = (t.get("symbol") or {}).get("samples") or []
        if sym:
            s = _mm(9)
            draw_strokes_fit(arr, sym[0], (cx + cw - s - 6, cy + int(ch * 0.62) - s, s, s), bgr=False)
    img = Image.fromarray(arr)
    draw = ImageDraw.Draw(img)
    nf, lf, wf = font(_mm(3.4), bold=True), font(_mm(3.2), bold=True), font(_mm(2.4))
    for t, cx, cy in cells:
        draw.rounded_rectangle([cx, cy, cx + cw, cy + ch], radius=_mm(2), outline=(190, 190, 190), width=3)
        r = _mm(3.2)
        lx, ly = cx + _mm(1.2) + r, cy + _mm(1.2) + r
        draw.ellipse([lx - r, ly - r, lx + r, ly + r], outline=(40, 40, 40), width=4)
        draw.text((lx, ly), str(t.get("letter") or "?"), fill=(40, 40, 40), font=lf, anchor="mm")
        ty = cy + int(ch * 0.66)
        name = str(t.get("name") or "?")
        draw.text((cx + cw / 2, ty), name, fill=(25, 25, 25), font=_fit_font(name, cw - 12, nf.size, bold=True), anchor="mt")
        words = behavior_words(t.get("behavior"), bool(t.get("spiky")))
        draw.text((cx + cw / 2, ty + _mm(5)), words, fill=(110, 110, 110), font=wf, anchor="mt")
        if t.get("symbol"):
            draw.text((cx + cw - 6, cy + int(ch * 0.62) + 4), "symbol", fill=(150, 150, 150), font=font(_mm(1.8)), anchor="ra")
    return img


def make_library_pdf(game_id: str, types: Sequence[Any] = (), *, title: str | None = None) -> bytes:
    """§11.3d: the Library Sheet, plus a reference page of the game's existing types when there are any."""
    pages = [render_library_sheet(game_id, title=title)]
    ref = render_library_reference(types)
    if ref is not None:
        pages.append(ref)
    return to_pdf_bytes(pages)


def main(argv: list[str] | None = None) -> None:
    from app.cv.scan_v2 import PackInfo

    parser = argparse.ArgumentParser(description="Render v2 template sheets")
    sub = parser.add_subparsers(dest="kind", required=True)
    blank = sub.add_parser("blank", help="one sheet that needs no server pack")
    blank.add_argument("--out", required=True)
    pk = sub.add_parser("pack", help="a k-sheet pack")
    pk.add_argument("--pack-id", required=True)
    pk.add_argument("--k", type=int, default=1)
    pk.add_argument("--kind", choices=["new", "game", "remix", "extend"], default="new")
    pk.add_argument("--parent", default=None, help="parent LevelV2 JSON (remix, extend)")
    pk.add_argument("--out", required=True)
    ru = sub.add_parser("rules", help="the game's Rules Sheet")
    ru.add_argument("--game-id", required=True)
    ru.add_argument("--current", default=None, help="GameRules JSON: marks the current choices 'now'")
    ru.add_argument("--out", required=True)
    li = sub.add_parser("library", help="the game's Library Sheet")
    li.add_argument("--game-id", required=True)
    li.add_argument("--types", default=None, help="JSON list of LibraryType (adds the reference page)")
    li.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    png = out.suffix.lower() == ".png"
    if args.kind == "blank":
        img = render_blank_v2()
        out.write_bytes(sheet_png_bytes(img) if png else to_pdf_bytes([img]))
    elif args.kind == "rules":
        import json

        current = json.loads(Path(args.current).read_text()) if args.current else None
        img = render_rules_sheet(args.game_id, current=current)
        out.write_bytes(sheet_png_bytes(img) if png else to_pdf_bytes([img]))
    elif args.kind == "library":
        import json

        types = json.loads(Path(args.types).read_text()) if args.types else []
        if png:
            out.write_bytes(sheet_png_bytes(render_library_sheet(args.game_id)))
        else:
            out.write_bytes(make_library_pdf(args.game_id, types))
    else:
        import json

        parent = json.loads(Path(args.parent).read_text()) if args.parent else None
        pdf = make_pack_pdf(PackInfo(pack_id=args.pack_id, kind=args.kind, k=args.k), parent)
        out.write_bytes(pdf)
    print(f"wrote {out}")


if __name__ == "__main__":
    main()


__all__ = [
    "INK_HEX", "behavior_words", "draw_strokes_fit", "font", "make_library_pdf", "make_pack_pdf", "make_rules_pdf",
    "render_blank_v2", "render_library_reference", "render_library_sheet", "render_rules_sheet", "render_sheet",
    "sheet_png_bytes", "to_pdf_bytes",
]
