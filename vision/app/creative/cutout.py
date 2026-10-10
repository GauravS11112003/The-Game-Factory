"""Local background removal and trimming (OpenCV), plus small helpers on the kid's crop.

    white_key(image) → transparent PNG   Firefly is prompted for "a plain white background"; the background is the
                                           near-key-colour region connected to the image border (so the white of an
                                           eye inside the sprite stays), with a soft, colour-decontaminated edge.
                                           The key colour is the border's median, so an off-white or pale backdrop
                                           also works. When keying finds no background, GrabCut on the centre is
                                           the fallback.
    trim(rgba png) → PNG                   crop to content + padding, long side ≤ max_px
    crop_aspect(crop) → w/h                aspect of the ink in the kid's crop (dark pixels on white)
    trace_strokes(crop, size_cells)        the crop's ink outlines as InkStroke dicts (library pins without strokes)

All functions are synchronous and CPU-bound: call them through asyncio.to_thread.
"""
from __future__ import annotations

from typing import Any

import cv2
import numpy as np

MAX_WORK_PX = 1024  # keying runs at this size at most
KEY_LO, KEY_HI = 16.0, 64.0  # colour distance: ≤ LO is background, ≥ HI is foreground, between is a soft edge
NEAR = 40  # pixels within this distance of the key may belong to the background region


class CutoutError(Exception):
    pass


def _decode(data: bytes) -> np.ndarray:
    arr = np.frombuffer(data, np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    if img is None or img.size == 0:
        raise CutoutError("undecodable image")
    if img.dtype != np.uint8:
        img = cv2.convertScaleAbs(img, alpha=255.0 / max(1.0, float(img.max())))
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGRA)
    elif img.shape[2] == 3:
        img = cv2.cvtColor(img, cv2.COLOR_BGR2BGRA)
    return img


def _encode_png(bgra: np.ndarray) -> bytes:
    ok, buf = cv2.imencode(".png", bgra)
    if not ok:
        raise CutoutError("png encode failed")
    return buf.tobytes()


def _has_transparency(bgra: np.ndarray) -> bool:
    a = bgra[:, :, 3]
    return float((a < 250).mean()) > 0.01


def _drop_specks(alpha: np.ndarray) -> np.ndarray:
    """Remove tiny islands (JPEG noise, stray dots) but keep every real part of a multi-part sprite."""
    solid = (alpha > 127).astype(np.uint8)
    n, labels, stats, _ = cv2.connectedComponentsWithStats(solid, connectivity=8)
    if n <= 2:
        return alpha
    areas = stats[1:, cv2.CC_STAT_AREA]
    total = float(areas.sum())
    keep = np.zeros(n, dtype=bool)
    keep[1:] = areas >= max(24.0, 0.004 * total)
    mask = keep[labels]
    # soft edge pixels that belong to a dropped island go too
    grown = cv2.dilate(mask.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    return np.where(grown, alpha, 0).astype(np.uint8)


def _grabcut(bgr: np.ndarray) -> np.ndarray:
    h, w = bgr.shape[:2]
    mask = np.zeros((h, w), np.uint8)
    rect = (max(1, int(w * 0.04)), max(1, int(h * 0.04)), max(2, int(w * 0.92)), max(2, int(h * 0.92)))
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(bgr, mask, rect, bgd, fgd, 4, cv2.GC_INIT_WITH_RECT)
    fg = np.where((mask == cv2.GC_FGD) | (mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
    return cv2.GaussianBlur(fg, (3, 3), 0)


def _key_alpha(bgra: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(alpha, decontaminated BGR) by keying the border colour."""
    bgr = bgra[:, :, :3]
    h, w = bgr.shape[:2]
    border = np.concatenate([bgr[0, :], bgr[h - 1, :], bgr[:, 0], bgr[:, w - 1]]).astype(np.float32)
    key = np.median(border, axis=0)
    dist = np.abs(bgr.astype(np.float32) - key[None, None, :]).max(axis=2)
    near = (dist <= NEAR).astype(np.uint8)
    n, labels = cv2.connectedComponents(near, connectivity=8)
    edge_labels = np.unique(np.concatenate([labels[0, :], labels[h - 1, :], labels[:, 0], labels[:, w - 1]]))
    edge_labels = edge_labels[edge_labels != 0]
    bg = np.isin(labels, edge_labels) & (near > 0)
    fg = ~bg
    k = np.ones((3, 3), np.uint8)
    band = (cv2.dilate(bg.astype(np.uint8), k, iterations=2) > 0) & (cv2.dilate(fg.astype(np.uint8), k, iterations=2) > 0)
    soft = np.clip((dist - KEY_LO) / (KEY_HI - KEY_LO), 0.0, 1.0).astype(np.float32)
    a = fg.astype(np.float32)  # inside: opaque (enclosed whites such as eyes stay), outside: clear
    edge_bg = band & bg  # anti-aliased fringe that keyed as background
    a[edge_bg] = soft[edge_bg]
    edge_fg = band & fg & (dist > NEAR)  # the sprite's own outermost pixels
    a[edge_fg] = soft[edge_fg]
    # colour decontamination on the soft edge: C = a·F + (1-a)·K  →  F = (C - (1-a)·K) / a
    col = bgr.astype(np.float32)
    a3 = a[:, :, None]
    fixed = np.clip((col - (1.0 - a3) * key[None, None, :]) / np.maximum(a3, 1e-3), 0, 255)
    partial = band & (a > 0.02) & (a < 0.98)
    out = np.where(partial[:, :, None], fixed, col).astype(np.uint8)
    return (a * 255).astype(np.uint8), out


def white_key(data: bytes, *, max_px: int = 512, pad: int = 6) -> bytes:
    """Image on a plain (white) background → trimmed transparent PNG. Raises CutoutError on an unusable image."""
    img = _decode(data)
    h, w = img.shape[:2]
    scale = min(1.0, MAX_WORK_PX / max(h, w))
    if scale < 1.0:
        img = cv2.resize(img, (max(1, round(w * scale)), max(1, round(h * scale))), interpolation=cv2.INTER_AREA)
    if _has_transparency(img):  # already cut out (Photoshop API, an uploaded PNG)
        return _trim_bgra(img, max_px=max_px, pad=pad)
    alpha, bgr = _key_alpha(img)
    cover = float((alpha > 127).mean())
    if cover < 0.003 or cover > 0.97:  # keying found no background (or nothing on it): GrabCut the centre
        bgr = img[:, :, :3].copy()
        alpha = _grabcut(bgr)
        cover = float((alpha > 127).mean())
        if cover < 0.003:
            raise CutoutError("nothing on the image")
    alpha = _drop_specks(alpha)
    out = np.dstack([bgr, alpha])
    return _trim_bgra(out, max_px=max_px, pad=pad)


def _trim_bgra(bgra: np.ndarray, *, max_px: int, pad: int) -> bytes:
    a = bgra[:, :, 3]
    ys, xs = np.where(a > 10)
    if len(xs) == 0:
        raise CutoutError("empty after cutout")
    h, w = a.shape
    x0, x1 = max(0, int(xs.min()) - pad), min(w, int(xs.max()) + 1 + pad)
    y0, y1 = max(0, int(ys.min()) - pad), min(h, int(ys.max()) + 1 + pad)
    crop = bgra[y0:y1, x0:x1]
    ch, cw = crop.shape[:2]
    s = min(1.0, max_px / max(ch, cw))
    if s < 1.0:
        # premultiply so transparent pixels never bleed their colour into the edge when downscaling
        f = crop.astype(np.float32)
        al = f[:, :, 3:4] / 255.0
        f[:, :, :3] *= al
        f = cv2.resize(f, (max(1, round(cw * s)), max(1, round(ch * s))), interpolation=cv2.INTER_AREA)
        al = np.maximum(f[:, :, 3:4] / 255.0, 1e-4)
        f[:, :, :3] = np.where(f[:, :, 3:4] > 0.5, f[:, :, :3] / al, 0)
        crop = np.clip(f, 0, 255).astype(np.uint8)
    return _encode_png(crop)


def trim(data: bytes, *, max_px: int = 512, pad: int = 6) -> bytes:
    """A transparent PNG (e.g. the Photoshop API cutout) → cropped to content, long side ≤ max_px."""
    img = _decode(data)
    if not _has_transparency(img):
        return white_key(data, max_px=max_px, pad=pad)
    return _trim_bgra(img, max_px=max_px, pad=pad)


def fit_png(data: bytes, *, max_px: int) -> bytes:
    """Any image → PNG with its long side ≤ max_px (alpha kept)."""
    img = _decode(data)
    h, w = img.shape[:2]
    s = min(1.0, max_px / max(h, w))
    if s < 1.0:
        img = cv2.resize(img, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA)
    return _encode_png(img)


def _ink_mask(data: bytes) -> np.ndarray:
    img = _decode(data)
    bgr = img[:, :, :3].astype(np.int16)
    alpha = img[:, :, 3]
    # ink = anything clearly darker or more saturated than paper, and not transparent
    dark = bgr.min(axis=2) < 200
    sat = (bgr.max(axis=2) - bgr.min(axis=2)) > 60
    return ((dark | sat) & (alpha > 64)).astype(np.uint8)


def crop_aspect(data: bytes) -> float | None:
    """w/h of the ink in the kid's crop (None when the crop is blank or unreadable)."""
    try:
        m = _ink_mask(data)
    except CutoutError:
        return None
    ys, xs = np.where(m > 0)
    if len(xs) < 4:
        return None
    w = float(xs.max() - xs.min() + 1)
    h = float(ys.max() - ys.min() + 1)
    return max(0.2, min(5.0, w / h))


def ink_colors(data: bytes, n: int = 3) -> list[str]:
    """The main ink colours of the crop as hex (helps the SVG writer keep the kid's colours)."""
    try:
        img = _decode(data)
    except CutoutError:
        return []
    m = _ink_mask(data) > 0
    px = img[:, :, :3][m]
    if len(px) < 8:
        return []
    q = (px // 32).astype(np.int32)
    keys = q[:, 0] * 64 + q[:, 1] * 8 + q[:, 2]
    vals, counts = np.unique(keys, return_counts=True)
    out = []
    for k in vals[np.argsort(-counts)][:n]:
        sel = px[keys == k].mean(axis=0)
        b, g, r = (int(v) for v in sel)
        out.append(f"#{r:02x}{g:02x}{b:02x}")
    return out


def trace_strokes(data: bytes, size_cells: tuple[float, float], *, max_strokes: int = 12,
                  max_pts: int = 80) -> list[dict[str, Any]]:
    """The crop's ink outlines as closed InkStroke dicts in cells (0..w, 0..h), for a library pin that came without
    the kid's strokes. Coarse but faithful enough for "My drawing" and the paper symbol."""
    try:
        m = _ink_mask(data)
    except CutoutError:
        return []
    ys, xs = np.where(m > 0)
    if len(xs) < 4:
        return []
    x0, y0 = int(xs.min()), int(ys.min())
    bw, bh = max(1, int(xs.max()) - x0 + 1), max(1, int(ys.max()) - y0 + 1)
    wc, hc = max(0.5, float(size_cells[0])), max(0.5, float(size_cells[1]))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:max_strokes]
    strokes = []
    for i, c in enumerate(contours):
        if cv2.contourArea(c) < 4:
            continue
        eps = 0.004 * cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        while len(approx) > max_pts:
            eps *= 1.5
            approx = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)
        if len(approx) < 3:
            continue
        pts = [[round((float(px) - x0) / bw * wc * 64) / 64, round((float(py) - y0) / bh * hc * 64) / 64]
               for px, py in approx]
        strokes.append({"id": f"tr{i + 1}", "color": "black", "kind": "line", "pts": pts, "w": [0.15],
                        "closed": True, "sheet": 0, "origin": "kid"})
    return strokes
