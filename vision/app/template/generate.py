"""Blank, add-a-level and remix sheets -> PIL image / PDF bytes (PLAN.md section 5). Owned by lane A.

Pillow draws at spec.page.px_per_mm (10 px/mm -> 2970x2100),
cv2.aruco.generateImageMarker for the markers, the qrcode package for the QR.

CLI (used by scripts/print_templates.sh):

    uv run python -m app.template.generate blank --out ../out/blank.pdf [--game-id ID]
    uv run python -m app.template.generate remix --level path/to/level.json --out ../out/remix.pdf
"""
from __future__ import annotations

import argparse
import io
import json
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
import qrcode
from PIL import Image, ImageDraw, ImageFont

from app.models import Level
from app.template import spec

# Candidate font files, first hit wins; Pillow's built-in font is the last resort so
# the generator never fails on a machine without these fonts.
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


@lru_cache(maxsize=64)
def font(size_px: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in _BOLD_FONTS if bold else _REGULAR_FONTS:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size_px)
            except OSError:
                continue
    return ImageFont.load_default(size=size_px)


def _mm(v: float) -> int:
    return spec.mm_to_px(v)


def _rgb(name: str) -> tuple[int, int, int]:
    return spec.hex_to_rgb(spec.colors()[name])


def _draw_markers(img: Image.Image) -> None:
    dictionary = cv2.aruco.getPredefinedDictionary(cv2.aruco.DICT_4X4_50)
    for m in spec.marker_specs():
        x, y, w, h = m["rect_px"]
        marker = cv2.aruco.generateImageMarker(dictionary, m["id"], w)
        img.paste(Image.fromarray(marker).convert("RGB"), (x, y))


def _draw_qr(img: Image.Image, payload: str) -> None:
    x, y, w, h = spec.qr_rect_px()
    qr = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, border=1, box_size=10)
    qr.add_data(payload)
    qr.make(fit=True)
    tile = qr.make_image(fill_color="black", back_color="white").convert("RGB")
    img.paste(tile.resize((w, h), Image.Resampling.NEAREST), (x, y))


def _draw_header(draw: ImageDraw.ImageDraw, title: str, subtitle: str) -> None:
    x, y, w, h = spec.header_rect_px()
    title_font = font(_mm(6.5), bold=True)
    # Shrink long remix titles to fit the header width.
    while title_font.getlength(title) > w and title_font.size > _mm(3):
        title_font = font(title_font.size - 4, bold=True)
    draw.text((x, y), title, fill="black", font=title_font)
    draw.text((x, y + _mm(8.5)), subtitle, fill=(60, 60, 60), font=font(_mm(3.6)))


def _draw_legend(draw: ImageDraw.ImageDraw) -> None:
    x, y, w, h = spec.legend_rect_px()
    legend = spec.load_spec()["legend"]
    items = legend["items"]
    sq = _mm(4)
    gap, pad = _mm(1.2), _mm(3)
    label_font = font(_mm(2.6))
    # Lay the items out by measured width; shrink the font until the row fits.
    while True:
        widths = [sq + gap + label_font.getlength(item["label"]) for item in items]
        if sum(widths) + pad * (len(items) - 1) <= w or label_font.size <= 10:
            break
        label_font = font(label_font.size - 1)
    sx = x
    for item, iw in zip(items, widths):
        draw.rectangle([sx, y, sx + sq, y + sq], fill=_rgb(item["color"]))
        draw.text((sx + sq + gap, y - _mm(0.3)), item["label"], fill="black", font=label_font)
        sx += int(iw) + pad
    hint_font = font(_mm(2.4))
    hint = legend["hint"]
    while hint_font.getlength(hint) > w and hint_font.size > 10:
        hint_font = font(hint_font.size - 2)
    draw.text((x, y + _mm(7)), hint, fill=(60, 60, 60), font=hint_font)


def _draw_drawing_area(draw: ImageDraw.ImageDraw) -> None:
    x, y, w, h = spec.drawing_area_px()
    area = spec.load_spec()["drawing_area"]
    border = spec.hex_to_rgb(area["border_color"])
    bw = max(1, _mm(area["border_width_mm"]))
    draw.rectangle([x, y, x + w, y + h], outline=border, width=bw)
    dot = spec.hex_to_rgb(area["dot_grid_color"])
    r = max(1, _mm(area["dot_radius_mm"]))
    step = _mm(area["dot_grid_spacing_mm"])
    cols, rows = spec.grid_cells()
    for j in range(1, rows):
        cy = y + j * step
        for i in range(1, cols):
            cx = x + i * step
            draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=dot)


def _draw_labelled_box(draw: ImageDraw.ImageDraw, rect: spec.RectPx, label: str) -> None:
    x, y, w, h = rect
    line = spec.hex_to_rgb(spec.load_spec()["rules_box"]["line_color"])
    draw.rectangle([x, y, x + w, y + h], outline=line, width=3)
    # Labels sit in the gap between the drawing area and the boxes so the whole
    # box interior stays free for ink (the sprite crop uses the full box).
    draw.text((x, y - _mm(3.4)), label, fill=(90, 90, 90), font=font(_mm(2.6)))


def _draw_rules_box(draw: ImageDraw.ImageDraw) -> None:
    rules = spec.load_spec()["rules_box"]
    x, y, w, h = spec.rules_box_px()
    _draw_labelled_box(draw, (x, y, w, h), rules["label"])
    n = int(rules["ruled_lines"])
    line = spec.hex_to_rgb(rules["line_color"])
    for i in range(1, n + 1):
        ly = y + round(h * i / (n + 1))
        draw.line([(x + _mm(2), ly), (x + w - _mm(2), ly)], fill=line, width=2)


def _draw_swatches(draw: ImageDraw.ImageDraw) -> None:
    sw = spec.load_spec()["swatches"]
    for p in spec.swatch_patches_px():
        x, y, w, h = p["rect_px"]
        if p["outlined"]:
            draw.rectangle([x, y, x + w, y + h], outline=_rgb("gray"), width=3)
        else:
            draw.rectangle([x, y, x + w, y + h], fill=spec.hex_to_rgb(p["hex"]))
    rx, _, rw, _ = spec.swatches_rect_px()
    label_font = font(_mm(2.0))
    label = sw["label"]
    while label_font.getlength(label) > rw and label_font.size > 8:
        label_font = font(label_font.size - 1)
    draw.text((rx, _mm(sw["label_y_mm"])), label, fill=(90, 90, 90), font=label_font)


def _sheet(qr_payload: str, title: str, subtitle: str) -> Image.Image:
    img = Image.new("RGB", spec.canvas_size_px(), "white")
    draw = ImageDraw.Draw(img)
    _draw_header(draw, title, subtitle)
    _draw_legend(draw)
    _draw_drawing_area(draw)
    _draw_labelled_box(draw, spec.character_box_px(), spec.load_spec()["character_box"]["label"])
    _draw_rules_box(draw)
    _draw_swatches(draw)
    _draw_markers(img)
    _draw_qr(img, qr_payload)
    return img


def render_blank(qr_payload: str) -> Image.Image:
    """Blank sheet; qr_payload is "dal1|blank" or "dal1|game|<game_id>"."""
    header = spec.load_spec()["header"]
    return _sheet(qr_payload, header["title"], header["name_label"])


def _gray_overlay_from_backdrop(backdrop_png_path: str, size: tuple[int, int]) -> Image.Image:
    """Backdrop PNG -> gray ink (RGBA) at the drawing-area size; near-white pixels stay transparent."""
    bd = Image.open(backdrop_png_path).convert("RGB")
    arr = np.asarray(bd).astype(np.int16)
    ink = (arr.min(axis=2) < 225) | ((arr.max(axis=2) - arr.min(axis=2)) > 40)
    mask = Image.fromarray((ink * 255).astype(np.uint8)).resize(size, Image.Resampling.BILINEAR)
    mask = mask.point(lambda v: 255 if v >= 128 else 0)
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    overlay.paste(Image.new("RGBA", size, _rgb("gray") + (255,)), (0, 0), mask)
    return overlay


def _gray_overlay_from_grid(level: Level, size: tuple[int, int]) -> Image.Image:
    overlay = Image.new("RGBA", size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    cols, rows = spec.grid_cells()
    cw, ch = size[0] / cols, size[1] / rows
    fill = _rgb("gray") + (255,)
    for j, row in enumerate(level.grid.rows):
        for i, c in enumerate(row):
            if c == "0":
                continue
            x0, y0, x1, y1 = i * cw, j * ch, (i + 1) * cw, (j + 1) * ch
            if c == "2":
                draw.polygon([(x0, y1), ((x0 + x1) / 2, y0), (x1, y1)], fill=fill)
            else:
                draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=fill)
    return overlay


def render_remix(parent: Level, backdrop_png_path: str | None) -> Image.Image:
    """Same sheet with the parent's backdrop in gray ink and component numbers; QR "dal1|lvl|<parent id>"."""
    header = spec.load_spec()["header"]
    title = header["remix_title_format"].format(title=parent.title, author=parent.author)
    img = _sheet(f"dal1|lvl|{parent.id}", title, header["name_label"])
    x, y, w, h = spec.drawing_area_px()
    if backdrop_png_path and Path(backdrop_png_path).exists():
        overlay = _gray_overlay_from_backdrop(backdrop_png_path, (w, h))
    else:
        overlay = _gray_overlay_from_grid(parent, (w, h))
    img.paste(overlay, (x, y), overlay)

    draw = ImageDraw.Draw(img)
    remix = spec.load_spec()["remix"]
    num_font = font(_mm(remix["component_number_height_mm"]) + 4, bold=True)
    num_color = spec.hex_to_rgb(remix["component_number_color"])
    cell = spec.cell_working_px()
    for comp in parent.components:
        bx0, by0, _, _ = comp.bbox
        tx = x + bx0 * cell + 2
        ty = y + by0 * cell - num_font.size - 2
        if ty < y:
            ty = y + by0 * cell + 2
        draw.text((tx, ty), str(comp.id), fill=num_color, font=num_font)
    return img


def to_pdf_bytes(img: Image.Image) -> bytes:
    """Single-page A4 landscape PDF of the sheet (px_per_mm * 25.4 dpi keeps the page at 297x210 mm)."""
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="PDF", resolution=spec.px_per_mm() * 25.4)
    return buf.getvalue()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description="Render printable sheets")
    sub = parser.add_subparsers(dest="kind", required=True)
    blank = sub.add_parser("blank")
    blank.add_argument("--out", required=True)
    blank.add_argument("--game-id", default=None)
    remix = sub.add_parser("remix")
    remix.add_argument("--level", required=True, help="path to a level JSON")
    remix.add_argument("--backdrop", default=None, help="path to the parent's backdrop PNG")
    remix.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    if args.kind == "blank":
        payload = f"dal1|game|{args.game_id}" if args.game_id else "dal1|blank"
        img = render_blank(payload)
    else:
        parent = Level.model_validate(json.loads(Path(args.level).read_text()))
        img = render_remix(parent, args.backdrop)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.suffix.lower() == ".png":
        img.save(out)
    else:
        out.write_bytes(to_pdf_bytes(img))
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
