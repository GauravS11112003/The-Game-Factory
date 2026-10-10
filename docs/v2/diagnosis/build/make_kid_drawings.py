"""Render six realistic 768x432 canvas-mode drawings the way a 9-year-old draws with markers.

Diagnostic input for docs/v2/diagnosis/build.md. Each drawing uses only the
four canvas palette colors (the exact hexes web/src/screens/canvas.ts paints
with), wobbly 6-10 px round strokes, and is supersampled 4x then downsampled
so edges are anti-aliased like an HTML canvas stroke.

Run (from vision/):  uv run --no-sync python ../docs/v2/diagnosis/build/make_kid_drawings.py
Writes inputs/<n>_<name>.png next to this file plus inputs/manifest.json
(the intended meaning of every mark, used by the diagnosis report).
"""
from __future__ import annotations

import json
import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

W, H = 768, 432
SS = 4  # supersampling factor
CELL = 16
BLACK = (0, 0, 0)
RED = (0xE5, 0x39, 0x35)
GREEN = (0x43, 0xA0, 0x47)
BLUE = (0x1E, 0x88, 0xE5)

OUT = Path(__file__).resolve().parent / "inputs"


class Kid:
    """A marker that wobbles. All coordinates are in 768x432 canvas pixels."""

    def __init__(self, seed: int) -> None:
        self.rng = random.Random(seed)
        self.img = Image.new("RGB", (W * SS, H * SS), "white")
        self.d = ImageDraw.Draw(self.img)

    # -- primitives -------------------------------------------------------------
    def _wobble(self, pts: list[tuple[float, float]], amp: float) -> list[tuple[float, float]]:
        """Resample a polyline every ~2 px and push each sample sideways by smooth noise."""
        dense: list[tuple[float, float, float, float]] = []  # x, y, nx, ny
        for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
            L = math.hypot(x1 - x0, y1 - y0) or 1.0
            nx, ny = -(y1 - y0) / L, (x1 - x0) / L
            n = max(1, int(L / 2))
            for i in range(n):
                t = i / n
                dense.append((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nx, ny))
        dense.append((pts[-1][0], pts[-1][1], dense[-1][2] if dense else 0, dense[-1][3] if dense else 0))
        waves = [(self.rng.uniform(0.02, 0.06), self.rng.uniform(0, 6.28), 1.0),
                 (self.rng.uniform(0.08, 0.15), self.rng.uniform(0, 6.28), 0.45),
                 (self.rng.uniform(0.25, 0.4), self.rng.uniform(0, 6.28), 0.15)]
        out = []
        s = 0.0
        prev = None
        for x, y, nx, ny in dense:
            if prev is not None:
                s += math.hypot(x - prev[0], y - prev[1])
            prev = (x, y)
            off = amp * sum(a * math.sin(f * s + p) for f, p, a in waves)
            out.append((x + nx * off, y + ny * off))
        return out

    def stroke(self, pts, color, width: float | None = None, wobble: float = 1.8) -> None:
        width = width if width is not None else self.rng.uniform(6.5, 9.5)
        r = width * SS / 2
        for i, (x, y) in enumerate(self._wobble([(float(a), float(b)) for a, b in pts], wobble)):
            # marker pressure varies a little along the stroke
            rr = r * (1 + 0.12 * math.sin(i * 0.07))
            cx, cy = x * SS, y * SS
            self.d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=color)

    def dot(self, x: float, y: float, color, width: float = 8) -> None:
        """A single brush tap: exactly what canvas.ts paints on pointerdown with no move."""
        r = width * SS / 2
        self.d.ellipse((x * SS - r, y * SS - r, x * SS + r, y * SS + r), fill=color)

    def circle(self, cx, cy, r, color, width=None, overshoot=0.25, squash=1.0) -> None:
        start = self.rng.uniform(0, 6.28)
        n = 40
        pts = []
        for i in range(n + int(n * overshoot) + 1):
            a = start + 2 * math.pi * i / n
            rr = r * (1 + 0.06 * math.sin(3 * a + start))
            pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a) * squash))
        self.stroke(pts, color, width, wobble=0.6)

    def zigzag_h(self, x0, x1, base_y, height, teeth, color, up=True, width=None) -> None:
        pts = []
        step = (x1 - x0) / (2 * teeth)
        for i in range(2 * teeth + 1):
            x = x0 + i * step + self.rng.uniform(-1.5, 1.5)
            tip = (i % 2 == 1)
            y = base_y - (height if up else -height) * (1 if tip else 0) + self.rng.uniform(-1.5, 1.5)
            pts.append((x, y))
        self.stroke(pts, color, width, wobble=0.8)

    def zigzag_v(self, y0, y1, base_x, depth, teeth, color, left=True, width=None) -> None:
        pts = []
        step = (y1 - y0) / (2 * teeth)
        for i in range(2 * teeth + 1):
            y = y0 + i * step + self.rng.uniform(-1.5, 1.5)
            tip = (i % 2 == 1)
            x = base_x - (depth if left else -depth) * (1 if tip else 0) + self.rng.uniform(-1.5, 1.5)
            pts.append((x, y))
        self.stroke(pts, color, width, wobble=0.8)

    def flag(self, pole_x, base_y, top_y, flag_w=34, flag_h=24) -> None:
        """Black pole, green triangular flag outline with a scribble fill."""
        self.stroke([(pole_x, base_y), (pole_x + 1, top_y)], BLACK, 7, wobble=0.8)
        a, b, c = (pole_x + 5, top_y), (pole_x + 5 + flag_w, top_y + flag_h / 2), (pole_x + 5, top_y + flag_h)
        self.stroke([a, b, c, a], GREEN, 6, wobble=0.6)
        for k in range(1, 4):  # scribble fill
            t = k / 4
            self.stroke([(pole_x + 7, top_y + flag_h * t), (pole_x + 5 + flag_w * (1 - abs(t - 0.5) * 2) * 0.8, top_y + flag_h * t)], GREEN, 5, wobble=0.5)

    def arrow(self, x0, y0, x1, y1, color=BLACK) -> None:
        self.stroke([(x0, y0), (x1, y1)], color, 7)
        ang = math.atan2(y1 - y0, x1 - x0)
        for da in (2.6, -2.6):
            self.stroke([(x1, y1), (x1 + 16 * math.cos(ang + da), y1 + 16 * math.sin(ang + da))], color, 7, wobble=0.5)

    def word_jump(self, x, b, s=1.6, color=BLACK) -> None:
        """Handwritten 'jump!' with its baseline at b; s scales an 18 px x-height."""
        def P(pts):
            return [(x + px * s, b + py * s) for px, py in pts]
        w = 6.5
        # j
        self.stroke(P([(6, -16), (6, 5), (3, 9), (-1, 6)]), color, w)
        self.dot(x + 6 * s, b - 23 * s, color, w)
        x += 14 * s
        # u
        self.stroke(P([(0, -16), (0, -4), (4, 0), (9, 0), (13, -5)]), color, w)
        self.stroke(P([(13, -16), (13, 0)]), color, w)
        x += 20 * s
        # m
        self.stroke(P([(0, 0), (0, -16)]), color, w)
        self.stroke(P([(0, -12), (4, -16), (8, -12), (8, 0)]), color, w)
        self.stroke(P([(8, -12), (12, -16), (16, -12), (16, 0)]), color, w)
        x += 24 * s
        # p
        self.stroke(P([(0, -16), (0, 10)]), color, w)
        self.stroke(P([(0, -14), (6, -17), (12, -12), (12, -5), (6, -1), (0, -3)]), color, w)
        x += 20 * s
        # !
        self.stroke(P([(3, -24), (3, -7)]), color, w)
        self.dot(x + 3 * s, b, color, w)

    def save(self, path: Path) -> None:
        self.img.resize((W, H), Image.LANCZOS).save(path)


# --- the six drawings ------------------------------------------------------------------


def d1_spike_hop() -> tuple[Kid, dict]:
    k = Kid(1)
    # sloped floor with an accidental 1-cell gap where the marker lifted
    k.stroke([(4, 396), (150, 389), (300, 373)], BLACK)
    k.stroke([(313, 373), (500, 377), (764, 386)], BLACK)
    # spikes right next to spawn, resting on the floor
    k.zigzag_h(30, 92, 390, 14, 4, RED)
    # platform with spikes drawn hovering ~1 cell above it
    k.stroke([(190, 278), (332, 271)], BLACK)
    k.zigzag_h(214, 300, 256, 13, 4, RED)
    k.stroke([(400, 214), (522, 219)], BLACK)
    for cx in (440, 470, 500):
        k.circle(cx, 190, 6, BLUE, 5)
    k.dot(622, 340, BLUE)  # a coin made with one tap
    k.flag(712, 383, 300)
    return k, {
        "name": "spike_hop",
        "prompt": None,
        "intent": [
            "floor slopes up ~1.5 cells over the left half (wobbly hand line)",
            "accidental ~12 px (under 1 cell) gap in the floor at x~300-313 px (cell ~19)",
            "red zigzag spikes resting on the floor just right of spawn (cells 2-5)",
            "red zigzag spikes drawn hovering ~1 cell above platform 1 (cells 12-23, y~16)",
            "3 coins as small blue circles above platform 2, 1 coin as a single tap at (622,340)",
            "goal: black pole + green flag at x~712 px (cell 44)",
        ],
    }


def d2_spike_cave() -> tuple[Kid, dict]:
    k = Kid(2)
    k.stroke([(4, 401), (380, 405), (764, 402)], BLACK)
    k.stroke([(150, 141), (360, 146), (560, 143)], BLACK)  # ceiling
    k.zigzag_h(196, 524, 152, 16, 10, RED, up=False)  # spikes hanging under the ceiling
    k.stroke([(232, 262), (470, 258)], BLACK)  # ledge under the ceiling
    k.stroke([(522, 352), (572, 349)], BLACK)  # step up to the wall
    k.stroke([(601, 404), (599, 300), (640, 300)], BLACK)  # wall with a lip
    k.zigzag_v(312, 396, 592, 14, 4, RED, left=True)  # spikes on the wall's left face
    for cx in (270, 310, 350):
        k.circle(cx, 236, 6, BLUE, 5)
    k.dot(548, 322, BLUE)
    k.flag(712, 402, 330)
    return k, {
        "name": "spike_cave",
        "prompt": None,
        "intent": [
            "ceiling line with a row of red spikes pointing DOWN under it",
            "a wall (x~600 px, cell 37) 6+ cells tall with red spikes pointing LEFT on its left face",
            "a small step platform to climb onto the wall",
            "3 coins as circles on the ledge, 1 coin as a tap",
            "goal: black pole + green flag on the right",
        ],
    }


def d3_monster_meadow() -> tuple[Kid, dict]:
    k = Kid(3)
    k.stroke([(4, 396), (380, 390), (764, 398)], BLACK)
    # monster: red lumpy body, legs, jagged mouth, black eyes
    k.circle(330, 360, 22, RED, 7, squash=0.9)
    k.stroke([(318, 380), (314, 392)], RED, 7)
    k.stroke([(342, 380), (346, 392)], RED, 7)
    k.zigzag_h(318, 344, 368, 5, 3, RED, up=True, width=5)
    k.circle(322, 352, 3, BLACK, 6)
    k.circle(339, 352, 3, BLACK, 6)
    # tree: black trunk, green scribbled canopy
    k.stroke([(150, 392), (151, 322)], BLACK)
    k.stroke([(168, 392), (166, 322)], BLACK)
    k.circle(158, 292, 38, GREEN, 8)
    k.circle(150, 288, 20, GREEN, 7)
    k.stroke([(132, 300), (182, 282)], GREEN, 7)
    # sun: black circle with rays
    k.circle(680, 70, 24, BLACK, 7)
    for i in range(8):
        a = i * math.pi / 4 + 0.2
        k.stroke([(680 + 34 * math.cos(a), 70 + 34 * math.sin(a)), (680 + 50 * math.cos(a), 70 + 50 * math.sin(a))], BLACK, 6, wobble=0.4)
    k.stroke([(430, 300), (562, 296)], BLACK)
    for cx in (470, 500, 530):
        k.circle(cx, 272, 6, BLUE, 5)
    k.dot(250, 366, BLUE)
    k.flag(724, 396, 350, flag_w=22, flag_h=16)
    return k, {
        "name": "monster_meadow",
        "prompt": "the monster walks back and forth",
        "intent": [
            "red monster with black eyes standing on the floor at x~330 px (cell 20)",
            "decoration: tree (black trunk, big green canopy) at x~158 px",
            "decoration: black sun with rays in the sky at (680,70)",
            "a small goal flag (black pole + small green flag) at x~724 px",
            "3 coin circles above the platform, 1 tap coin near the tree",
        ],
    }


def d4_words_and_arrows() -> tuple[Kid, dict]:
    k = Kid(4)
    k.stroke([(4, 400), (420, 403)], BLACK)
    k.stroke([(500, 404), (764, 398)], BLACK)  # 5-cell pit between
    k.stroke([(180, 300), (312, 303)], BLACK)  # platform with an arrow next to it
    k.arrow(334, 302, 410, 300)
    k.word_jump(420, 352, s=1.5)
    for cx in (220, 250, 280):
        k.circle(cx, 276, 6, BLUE, 5)
    k.dot(600, 370, BLUE)
    k.flag(728, 399, 330)
    return k, {
        "name": "words_and_arrows",
        "prompt": None,
        "intent": [
            "a platform with a black arrow drawn to its right, meaning 'this platform moves right'",
            "the word 'jump!' handwritten in black above the pit (x~420-540 px)",
            "a 5-cell pit in the floor",
            "3 coin circles above the platform, 1 tap coin",
            "goal: black pole + green flag",
        ],
    }


def d5_big_leap() -> tuple[Kid, dict]:
    k = Kid(5)
    k.stroke([(4, 400), (150, 398)], BLACK)
    k.stroke([(190, 370), (262, 372)], BLACK)
    k.stroke([(300, 341), (372, 338)], BLACK)
    k.stroke([(410, 310), (482, 312)], BLACK)
    k.stroke([(610, 301), (764, 303)], BLACK)  # 8-cell final gap from 482 to 610
    k.zigzag_h(160, 600, 424, 12, 14, RED)  # lava spikes at the bottom
    for cx, cy in ((226, 346), (336, 316), (446, 286)):
        k.circle(cx, cy, 6, BLUE, 5)
    k.flag(720, 300, 230)
    return k, {
        "name": "big_leap",
        "prompt": None,
        "intent": [
            "three easy stepping platforms (2-cell gaps, 2-cell rises)",
            "a final gap of 8 cells (x 482 -> 610 px), wider than the 6-cell max jump",
            "a strip of red spikes along the bottom as lava",
            "a coin above each stepping platform",
            "goal: black pole + green flag on the last platform",
        ],
    }


def d6_kid_full_level() -> tuple[Kid, dict]:
    k = Kid(6)
    k.stroke([(4, 396), (120, 394)], BLACK)
    k.zigzag_h(22, 104, 391, 14, 5, RED)  # spikes right next to the spawn
    k.stroke([(120, 394), (300, 280)], BLACK)  # a ramp drawn as one diagonal line
    k.stroke([(300, 280), (462, 285)], BLACK)
    # small red monster with black eyes on the top platform
    k.circle(410, 262, 14, RED, 7)
    k.circle(405, 258, 2, BLACK, 5)
    k.circle(416, 258, 2, BLACK, 5)
    k.stroke([(520, 331), (642, 335)], BLACK)
    k.zigzag_h(548, 622, 316, 12, 3, RED)  # spikes hovering above platform 2
    k.stroke([(660, 222), (762, 220)], BLACK)
    for cx in (330, 360):
        k.circle(cx, 252, 6, BLUE, 5)
    k.dot(580, 280, BLUE)
    k.flag(730, 220, 160)
    return k, {
        "name": "kid_full_level",
        "prompt": "the monster walks",
        "intent": [
            "spawn on a short ledge with red spikes starting 1 cell to its right",
            "a ramp drawn as one diagonal line from the floor up to the top platform",
            "small red monster with black eyes on the top platform",
            "red spikes drawn hovering above platform 2",
            "goal: black pole + green flag on a high platform at the right",
            "2 coin circles + 1 tap coin",
        ],
    }


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = []
    for n, fn in enumerate((d1_spike_hop, d2_spike_cave, d3_monster_meadow, d4_words_and_arrows, d5_big_leap, d6_kid_full_level), 1):
        kid, info = fn()
        name = f"{n}_{info['name']}.png"
        kid.save(OUT / name)
        manifest.append({"n": n, "file": name, **info})
        print("wrote", OUT / name)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
