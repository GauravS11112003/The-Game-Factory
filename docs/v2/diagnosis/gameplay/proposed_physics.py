#!/usr/bin/env python3
"""Envelope of the proposed v2 player physics (docs/v2/diagnosis/gameplay.md section 7.1).

60 Hz semi-implicit Euler like Phaser Arcade. Run: python3 proposed_physics.py
Model: launch vy = -(340 + 0.25*|vx|) px/s; gravity 900 while rising with jump held,
half gravity near the apex (|vy| < 40) while held, 1700 otherwise; release cuts vy to -220;
max fall 330 px/s. Walk 6 cells/s (96 px/s), run 10.5 cells/s (168 px/s). CELL = 16 px.
"""
CELL = 16
DT = 1 / 60


def jump(vx: float, hold: int, base=340, bonus=0.25, g_up=900, g_down=1700, thr=40, maxfall=330, cut=-220):
    vy = -(base + bonus * abs(vx))
    y = x = 0.0
    f = 0
    apex = 0.0
    cut_done = False
    while True:
        held = f < hold
        if not held and not cut_done and vy < cut:
            vy = cut
            cut_done = True
        if held and abs(vy) < thr:
            g = g_up * 0.5
        elif held and vy < 0:
            g = g_up
        else:
            g = g_down
        vy = min(vy + g * DT, maxfall)
        y += vy * DT
        x += vx * DT
        f += 1
        apex = max(apex, -y)
        if y >= 0 and f > 1:
            return apex / CELL, x / CELL, f


if __name__ == "__main__":
    print("| speed | hold (frames) | apex (cells) | distance (cells) | airtime (frames) |")
    print("|---|---|---|---|---|")
    for name, vx in (("stand", 0), ("walk 6 c/s", 96), ("run 10.5 c/s", 168)):
        for h in (1, 6, 12, 20, 60):
            a, d, f = jump(vx, h)
            print(f"| {name} | {h} | {a:.2f} | {d:.2f} | {f} |")
