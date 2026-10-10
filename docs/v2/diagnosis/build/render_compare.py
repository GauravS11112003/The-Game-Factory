"""Render compare_<n>.png (input drawing | built level at 2x) and measure build-quality failures.

Inputs (all next to this file):
  inputs/<stem>.png, inputs/manifest.json       from make_kid_drawings.py
  responses/<stem>.json                          live POST /api/scan responses (model ON)
  api_out/<stem>/backdrop.png, comp_*.png        files the API produced
  offline/<stem>/level.json, backdrop.png        run_offline.py (model OFF)
Writes:
  compare_<n>.png, compare_<n>_model_off.png, cf/*.json (counterfactual levels),
  metrics.json (every number quoted in build.md)

Run from vision/:  uv run --no-sync python ../docs/v2/diagnosis/build/render_compare.py
It shells out to v1's own TypeScript solver (web/src/solver/solve.ts) via vite-node.
"""
from __future__ import annotations

import copy
import json
import subprocess
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
WEB = ROOT / "web"
GW, GH, CELL = 48, 27, 16
S = 2  # render scale
C2 = CELL * S

PALETTE = {"black": (0, 0, 0), "red": (229, 57, 53), "green": (67, 160, 71), "blue": (30, 136, 229)}


def font(size: int) -> ImageFont.FreeTypeFont:
    for name in ("/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


F_BIG, F_MED, F_SMALL = font(30), font(20), font(15)


# ----------------------------------------------------------------------------- input analysis


def ink_masks(img: Image.Image) -> dict[str, np.ndarray]:
    """Nearest-palette classification of the 768x432 input (ink = clearly not paper)."""
    a = np.asarray(img.convert("RGB")).astype(np.int32)
    names = list(PALETTE)
    cols = np.array([PALETTE[n] for n in names] + [(255, 255, 255)])
    d = ((a[:, :, None, :] - cols[None, None]) ** 2).sum(-1)
    idx = d.argmin(-1)
    return {n: (idx == i) for i, n in enumerate(names)}


def blobs(mask: np.ndarray, min_px: int = 4) -> list[dict]:
    n, lab, st, cen = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    return [
        {"area": int(st[i, 4]), "cx": float(cen[i, 0]), "cy": float(cen[i, 1]),
         "bbox": [int(st[i, 0]), int(st[i, 1]), int(st[i, 0] + st[i, 2] - 1), int(st[i, 1] + st[i, 3] - 1)]}
        for i in range(1, n) if st[i, 4] >= min_px
    ]


# ----------------------------------------------------------------------------- level analysis


def grid(level: dict) -> np.ndarray:
    return np.array([[int(ch) for ch in row] for row in level["grid"]["rows"]], dtype=np.int8)


def regions(mask: np.ndarray, conn: int = 4) -> list[list[tuple[int, int]]]:
    n, lab = cv2.connectedComponents(mask.astype(np.uint8), connectivity=conn)
    out = []
    for i in range(1, n):
        ys, xs = np.nonzero(lab == i)
        out.append(list(zip(xs.tolist(), ys.tolist())))
    return out


def analyze(level: dict, ink: dict[str, np.ndarray], reach: dict | None) -> dict:
    g = grid(level)
    solid, hazard = g == 1, g == 2
    m: dict = {}
    # surfaces: solid cell with a non-solid cell above
    surf = [(x, y) for y in range(GH) for x in range(GW) if solid[y, x] and (y == 0 or not solid[y - 1, x])]
    # 1-cell bumps along a surface: neighbouring columns of the same region whose tops differ by 1
    bumps, steps2 = [], []
    for reg in regions(solid):
        tops: dict[int, int] = {}
        for x, y in reg:
            tops[x] = min(tops.get(x, 99), y)
        for x in sorted(tops):
            if x + 1 in tops:
                d = abs(tops[x + 1] - tops[x])
                if d == 1:
                    bumps.append((x, tops[x], x + 1, tops[x + 1]))
                elif d >= 2:
                    steps2.append((x, tops[x], x + 1, tops[x + 1]))
    m["surface_cells"] = len(surf)
    m["one_cell_bumps"] = len(bumps)
    m["bumps"] = bumps
    # thickness under each surface cell
    thick = 0
    for x, y in surf:
        if y + 1 < GH and solid[y + 1, x]:
            thick += 1
    m["surface_cells_2plus_thick_pct"] = round(100 * thick / max(1, len(surf)), 1)
    # art vs collision: ink coverage of each solid cell and top-edge offset
    blk = ink["black"]
    phantom, offsets = [], []
    for y in range(GH):
        for x in range(GW):
            if not solid[y, x]:
                continue
            cov = blk[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL].mean()
            if cov < 0.10:
                phantom.append((x, y, round(float(cov), 3)))
    for x, y in surf:
        col = blk[max(0, (y - 2) * CELL):min(GH * CELL, (y + 2) * CELL), x * CELL:(x + 1) * CELL]
        rows = np.nonzero(col.any(axis=1))[0]
        if len(rows):
            ink_top = max(0, (y - 2) * CELL) + int(rows[0])
            offsets.append(ink_top - y * CELL)
    m["solid_cells"] = int(solid.sum())
    m["phantom_solid_cells"] = len(phantom)
    m["phantom_pct"] = round(100 * len(phantom) / max(1, int(solid.sum())), 1)
    m["phantom"] = phantom
    if offsets:
        off = np.array(offsets)
        m["surface_vs_ink_top_px"] = {"mean_abs": round(float(np.abs(off).mean()), 1), "min": int(off.min()), "max": int(off.max()),
                                      "pct_off_by_4px_or_more": round(100 * float((np.abs(off) >= 4).mean()), 1)}
    # floating hazards: hazard regions touching no solid cell (8-neighbourhood)
    floating = []
    for reg in regions(hazard, 8):
        touch = any(0 <= x + dx < GW and 0 <= y + dy < GH and solid[y + dy, x + dx]
                    for x, y in reg for dx in (-1, 0, 1) for dy in (-1, 0, 1))
        if not touch:
            floating.append(reg)
    m["floating_hazard_regions"] = len(floating)
    m["floating"] = floating
    # hazard that replaced ground (cells whose black ink coverage is high but are hazard)
    eaten = [(x, y) for y in range(GH) for x in range(GW) if hazard[y, x] and blk[y * CELL:(y + 1) * CELL, x * CELL:(x + 1) * CELL].mean() > 0.15]
    m["hazard_cells_over_black_ink"] = len(eaten)
    # tall walls: vertical solid runs >= 4 that rise above a surface (cannot be jumped: max 3.8 cells)
    walls = []
    for x in range(GW):
        y = 0
        while y < GH:
            if solid[y, x]:
                y0 = y
                while y < GH and solid[y, x]:
                    y += 1
                run = y - y0
                # height above the neighbouring ground on either side
                for nx in (x - 1, x + 1):
                    if 0 <= nx < GW and not solid[y0, nx]:
                        h = 0
                        yy = y0
                        while yy < GH and not solid[yy, nx]:
                            yy += 1
                            h += 1
                        if h >= 4 and run >= 3:
                            walls.append((x, y0, min(h, run + 1)))
                            break
            else:
                y += 1
    m["walls_4plus"] = sorted(set((x, y0) for x, y0, _ in walls))
    # debris: tiny solid regions
    m["tiny_solid_regions"] = [r for r in regions(solid, 8) if len(r) <= 4]
    # entities
    ents = level["entities"]
    start = next((e for e in ents if e["type"] == "player_start"), None)
    goal = next((e for e in ents if e["type"] == "goal"), None)
    hz = np.argwhere(hazard)
    if start and len(hz):
        m["start_to_nearest_hazard_cells"] = int(min(max(abs(int(x) - start["x"]), abs(int(y) - start["y"])) for y, x in hz))
    if goal:
        gx, gy = goal["x"], goal["y"]
        m["goal_cell"] = [gx, gy]
        m["goal_grounded"] = bool(gy + 1 < GH and solid[gy + 1, gx])
        pole = 0
        for x in (gx - 1, gx - 2):
            if 0 <= x < GW:
                run = 0
                for y in range(gy, max(-1, gy - 8), -1):
                    if solid[y, x]:
                        run += 1
                pole = max(pole, run)
        m["solid_cells_in_2_cols_left_of_goal_rows_gy_up"] = pole
    m["coins"] = sum(1 for e in ents if e["type"] == "coin")
    coin_rows = sorted({e["y"] for e in ents if e["type"] == "coin"})
    m["coin_rows"] = coin_rows
    m["enemies"] = []
    for e in ents:
        if e["type"] == "enemy":
            x0, y0, x1, y1 = e["bbox"]
            overlap = int(solid[y0:y1 + 1, x0:x1 + 1].sum())
            below = bool(y1 + 1 < GH and solid[y1 + 1, x0:x1 + 1].any())
            m["enemies"].append({"id": e["id"], "component_id": e.get("component_id"), "bbox": e["bbox"], "patrol": e.get("patrol"),
                                 "solid_cells_inside_bbox": overlap, "ground_below_bbox": below})
    if reach:
        m["solver"] = {k: reach[k] for k in ("solvable", "reason", "reachable")}
    return m


# ----------------------------------------------------------------------------- rendering


def render_level(level: dict, backdrop: Image.Image | None, reach: dict | None, m: dict, dropped: list[dict]) -> Image.Image:
    W, H = GW * C2, GH * C2
    base = Image.new("RGBA", (W, H), (255, 255, 255, 255))
    if backdrop is not None:
        bd = backdrop.convert("RGBA").resize((W, H), Image.LANCZOS)
        bd.putalpha(int(255 * 0.4))
        base.alpha_composite(bd)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(GW + 1):
        d.line([(i * C2, 0), (i * C2, H)], fill=(0, 0, 0, 22))
    for j in range(GH + 1):
        d.line([(0, j * C2), (W, j * C2)], fill=(0, 0, 0, 22))
    g = grid(level)
    for y in range(GH):
        for x in range(GW):
            box = (x * C2 + 1, y * C2 + 1, (x + 1) * C2 - 1, (y + 1) * C2 - 1)
            if g[y, x] == 1:
                d.rectangle(box, fill=(0, 0, 0, 205))
            elif g[y, x] == 2:
                d.rectangle(box, fill=(229, 57, 53, 215))
    # problem overlays
    for x, y, _ in m.get("phantom", []):
        d.rectangle((x * C2 + 3, y * C2 + 3, (x + 1) * C2 - 3, (y + 1) * C2 - 3), outline=(255, 214, 0, 255), width=3)
    for x0, y0, x1, y1 in m.get("bumps", []):
        cx = (x1 * C2)
        cy = min(y0, y1) * C2
        d.polygon([(cx - 7, cy - 2), (cx + 7, cy - 2), (cx, cy - 13)], fill=(255, 140, 0, 255))
    for reg in m.get("floating", []):
        xs, ys = [p[0] for p in reg], [p[1] for p in reg]
        d.rectangle((min(xs) * C2 - 4, min(ys) * C2 - 4, (max(xs) + 1) * C2 + 4, (max(ys) + 1) * C2 + 4), outline=(255, 0, 0, 255), width=3)
    for x, y0 in m.get("walls_4plus", []):
        d.rectangle((x * C2 - 2, y0 * C2 - 2, (x + 1) * C2 + 2, y0 * C2 + 4 * C2 + 2), outline=(0, 200, 255, 255), width=3)
    for b in dropped:
        cx, cy = b["cx"] * S, b["cy"] * S
        d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), outline=(30, 136, 229, 255), width=3)
        d.text((cx + 24, cy - 10), "dropped", fill=(30, 136, 229, 255), font=F_SMALL)
    # reachable standing cells from v1's solver
    if reach:
        for c in reach.get("cells", []):
            x, y = map(int, c.split(","))
            cx, cy = x * C2 + C2 // 2, y * C2 + C2 // 2
            d.ellipse((cx - 4, cy - 4, cx + 4, cy + 4), fill=(0, 170, 80, 230))
    # entities
    for e in level["entities"]:
        t = e["type"]
        if t == "player_start":
            x, y = e["x"], e["y"]
            d.rectangle((x * C2 + 4, (y - 1) * C2 + 2, (x + 1) * C2 - 4, (y + 1) * C2 - 2), outline=(220, 0, 220, 255), width=4)
            d.text((x * C2 + 6, (y - 1) * C2 - 22), "START", fill=(220, 0, 220, 255), font=F_SMALL)
        elif t == "goal":
            x, y = e["x"], e["y"]
            d.rectangle((x * C2, (y - 1) * C2, (x + 1) * C2, (y + 1) * C2), outline=(0, 140, 40, 255), width=3)
            px = x * C2 + 6
            d.line([(px, (y + 1) * C2), (px, (y - 1) * C2 + 2)], fill=(0, 110, 30, 255), width=4)
            d.polygon([(px, (y - 1) * C2 + 2), (px + 24, (y - 1) * C2 + 12), (px, (y - 1) * C2 + 22)], fill=(67, 160, 71, 255))
            d.text((x * C2 - 8, (y - 1) * C2 - 24), "GOAL", fill=(0, 120, 30, 255), font=F_SMALL)
        elif t in ("coin", "key"):
            cx, cy = e["x"] * C2 + C2 // 2, e["y"] * C2 + C2 // 2
            d.ellipse((cx - 9, cy - 9, cx + 9, cy + 9), outline=(30, 136, 229, 255), width=4)
        elif t == "enemy":
            x0, y0, x1, y1 = e["bbox"]
            d.rectangle((x0 * C2, y0 * C2, (x1 + 1) * C2, (y1 + 1) * C2), outline=(255, 120, 0, 255), width=4)
            dx = (e.get("patrol") or {}).get("dx", 0)
            ym = (y0 + y1 + 1) * C2 // 2
            d.line([(x0 * C2, ym), ((x0 + dx) * C2, ym)], fill=(255, 120, 0, 255), width=3)
            d.text((x0 * C2, y0 * C2 - 22), f"ENEMY {e['id']} patrol dx={dx}", fill=(230, 100, 0, 255), font=F_SMALL)
        elif t == "moving_platform":
            x0, y0, x1, y1 = e["bbox"]
            d.rectangle((x0 * C2, y0 * C2, (x1 + 1) * C2, (y1 + 1) * C2), outline=(140, 60, 220, 255), width=4)
            (ax, ay), (bx, by) = e["path"][0], e["path"][-1]
            d.line([(ax * C2, ay * C2 - 8), (bx * C2, by * C2 - 8)], fill=(140, 60, 220, 255), width=3)
            d.text((x0 * C2, y0 * C2 - 30), f"MOVING {e['id']} -> {e['path'][-1]}", fill=(120, 40, 200, 255), font=F_SMALL)
    base.alpha_composite(ov)
    return base.convert("RGB")


def render_input(img: Image.Image, dropped: list[dict]) -> Image.Image:
    W, H = GW * C2, GH * C2
    big = img.convert("RGBA").resize((W, H), Image.LANCZOS)
    ov = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(ov)
    for i in range(GW + 1):
        d.line([(i * C2, 0), (i * C2, H)], fill=(0, 0, 0, 22))
    for j in range(GH + 1):
        d.line([(0, j * C2), (W, j * C2)], fill=(0, 0, 0, 22))
    for b in dropped:
        cx, cy = b["cx"] * S, b["cy"] * S
        d.ellipse((cx - 22, cy - 22, cx + 22, cy + 22), outline=(30, 136, 229, 255), width=3)
    big.alpha_composite(ov)
    return big.convert("RGB")


def compose(n: int, info: dict, inp: Image.Image, lvl: Image.Image, head: str, lines: list[str], out: Path) -> None:
    W, H = GW * C2, GH * C2
    gap, top = 24, 92
    foot = 34 + 26 * len(lines)
    canvas = Image.new("RGB", (W * 2 + gap * 3, H + top + foot), (245, 244, 240))
    d = ImageDraw.Draw(canvas)
    d.text((gap, 14), f"{n}. {info['name']}" + (f'   prompt: "{info["prompt"]}"' if info.get("prompt") else ""), fill=(20, 20, 20), font=F_BIG)
    d.text((gap, 54), head, fill=(150, 20, 20) if "UNSOLVABLE" in head else (20, 110, 40), font=F_MED)
    canvas.paste(inp, (gap, top))
    canvas.paste(lvl, (gap * 2 + W, top))
    d.text((gap, top + H + 6), "INPUT drawing (2x, cell grid overlaid)", fill=(90, 90, 90), font=F_SMALL)
    d.text((gap * 2 + W, top + H + 6),
           "BUILT level (2x): black=solid, red=hazard, backdrop 40%; green dots=v1 solver reachable; yellow box=collision with <10% ink; "
           "orange tick=1-cell bump; cyan=4+ cell wall; red frame=floating hazard",
           fill=(90, 90, 90), font=F_SMALL)
    for i, line in enumerate(lines):
        d.text((gap, top + H + 34 + 26 * i), line, fill=(30, 30, 30), font=F_MED)
    canvas.save(out)


# ----------------------------------------------------------------------------- solver


def run_solver(paths: list[Path]) -> dict[str, dict]:
    proc = subprocess.run(
        ["npx", "vite-node", str(HERE / "solve_levels.ts"), "--", *map(str, paths)],
        cwd=WEB, capture_output=True, text=True, check=True,
    )
    out = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{"):
            d = json.loads(line)
            out[str(Path(d["file"]).resolve())] = d
    return out


def counterfactual_no_pole(level: dict) -> dict:
    """Same level with the solid cells of the drawn flag pole removed (cols gx-2..gx above the ground)."""
    lv = copy.deepcopy(level)
    g = grid(lv)
    goal = next(e for e in lv["entities"] if e["type"] == "goal")
    gx, gy = goal["x"], goal["y"]
    ref = gx - 3
    ground = next((y for y in range(max(0, gy - 5), GH) if g[y, ref] == 1), GH)
    for x in range(gx - 2, gx + 1):
        for y in range(0, ground):
            if g[y, x] == 1:
                g[y, x] = 0
    lv["grid"]["rows"] = ["".join(str(int(v)) for v in row) for row in g]
    return lv


def counterfactual_meadow(level: dict) -> dict:
    """Monster meadow with the intended reading: goal at the drawn flag, tree trunk and pole are scenery."""
    lv = copy.deepcopy(level)
    g = grid(lv)
    for y in range(19, 24):
        for x in (9, 10):
            g[y, x] = 0
        g[y, 45] = 0
    lv["grid"]["rows"] = ["".join(str(int(v)) for v in row) for row in g]
    for e in lv["entities"]:
        if e["type"] == "goal":
            e["x"], e["y"] = 46, 23
    return lv


# ----------------------------------------------------------------------------- main


def main() -> None:
    manifest = json.loads((HERE / "inputs" / "manifest.json").read_text())
    (HERE / "cf").mkdir(exist_ok=True)
    jobs = []
    for item in manifest:
        stem = Path(item["file"]).stem
        live = json.loads((HERE / "responses" / f"{stem}.json").read_text())["level"]
        off = json.loads((HERE / "offline" / stem / "level.json").read_text())["level"]
        cf = counterfactual_meadow(live) if item["n"] == 3 else counterfactual_no_pole(live)
        cfp = HERE / "cf" / f"{stem}_{'intended' if item['n'] == 3 else 'no_pole'}.json"
        cfp.write_text(json.dumps({"level": cf}))
        jobs.append((item, stem, live, off, cfp))
    paths = [HERE / "responses" / f"{s}.json" for _, s, *_ in jobs] + [HERE / "offline" / s / "level.json" for _, s, *_ in jobs] + [j[4] for j in jobs]
    sol = run_solver(paths)

    metrics = {}
    for item, stem, live, off, cfp in jobs:
        n = item["n"]
        img = Image.open(HERE / "inputs" / item["file"]).convert("RGB")
        ink = ink_masks(img)
        drawn_blue = blobs(ink["blue"])
        drawn_coins = len(drawn_blue)
        for variant, level, bd_path, out_name in (
            ("live", live, HERE / "api_out" / stem / "backdrop.png", f"compare_{n}.png"),
            ("model_off", off, HERE / "offline" / stem / "backdrop.png", f"compare_{n}_model_off.png"),
        ):
            key = str((HERE / "responses" / f"{stem}.json").resolve()) if variant == "live" else str((HERE / "offline" / stem / "level.json").resolve())
            reach = sol.get(key)
            m = analyze(level, ink, reach)
            coins = [(e["x"], e["y"]) for e in level["entities"] if e["type"] in ("coin", "key")]
            dropped = [b for b in drawn_blue if not any(abs(int(b["cx"] // CELL) - x) <= 1 and abs(int(b["cy"] // CELL) - y) <= 1 for x, y in coins)]
            m["drawn_blue_blobs"] = drawn_coins
            m["dropped_blue_marks"] = [{"cx": round(b["cx"]), "cy": round(b["cy"]), "area_px": b["area"]} for b in dropped]
            m["warnings"] = level["meta"]["warnings"]
            m["notes_transcript"] = level["meta"]["notes_transcript"]
            cf_res = sol.get(str(cfp.resolve()))
            if variant == "live" and cf_res:
                m["counterfactual"] = {"file": cfp.name, "solvable": cf_res["solvable"], "reason": cf_res["reason"], "reachable": cf_res["reachable"]}
            bd = Image.open(bd_path) if bd_path.is_file() else None
            sv = m.get("solver", {})
            head = (f"{'MODEL ON (live API)' if variant == 'live' else 'MODEL OFF (fake mode, same pipeline)'} | v1 solver: "
                    f"{'SOLVABLE' if sv.get('solvable') else 'UNSOLVABLE (' + str(sv.get('reason')) + ')'} | reachable standing cells: {sv.get('reachable')}")
            ofs = m.get("surface_vs_ink_top_px", {})
            lines = [
                f"collision cells: {m['solid_cells']} solid, {m['phantom_solid_cells']} ({m['phantom_pct']}%) have <10% ink under them | "
                f"walkable surface: {m['surface_cells']} cells, {m['one_cell_bumps']} one-cell bumps, {m['surface_cells_2plus_thick_pct']}% are 2+ cells thick",
                f"drawn line top vs collision top: mean {ofs.get('mean_abs')} px, range {ofs.get('min')}..{ofs.get('max')} px (game px; player feet are drawn 0 px from collision) | "
                f"floating hazard strips: {m['floating_hazard_regions']} | hazard cells painted over black ink: {m['hazard_cells_over_black_ink']}",
                f"blue marks drawn: {drawn_coins}, coins built: {m['coins']} (dropped: {len(dropped)}) | coin rows: {m['coin_rows']} | start->nearest hazard: "
                f"{m.get('start_to_nearest_hazard_cells')} cells | goal {m.get('goal_cell')} grounded={m.get('goal_grounded')} | 4+ cell walls: {len(m['walls_4plus'])}",
                f"enemies: {[(e['id'], 'comp', e['component_id'], 'solid-in-bbox', e['solid_cells_inside_bbox'], 'ground-below', e['ground_below_bbox']) for e in m['enemies']] or 'none'}"
                f" | tiny solid debris regions: {len(m['tiny_solid_regions'])} | warnings: {m['warnings'] or 'none'}",
            ]
            if variant == "live" and "counterfactual" in m:
                c = m["counterfactual"]
                lines.append(f"counterfactual ({c['file']}): {'SOLVABLE' if c['solvable'] else 'still UNSOLVABLE (' + str(c['reason']) + ')'}, reachable {c['reachable']}")
            compose(n, item, render_input(img, dropped), render_level(level, bd, reach, m, dropped), head, lines, HERE / out_name)
            slim = {k: v for k, v in m.items() if k not in ("bumps", "phantom", "floating", "tiny_solid_regions")}
            slim["tiny_solid_regions"] = len(m["tiny_solid_regions"])
            metrics.setdefault(stem, {})[variant] = slim
            print(out_name, json.dumps({k: slim[k] for k in ("solver", "phantom_pct", "one_cell_bumps", "coins", "dropped_blue_marks")}, default=str))
    (HERE / "metrics.json").write_text(json.dumps(metrics, indent=2, default=str) + "\n")


if __name__ == "__main__":
    main()
