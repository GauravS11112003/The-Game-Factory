# Diagnosis 2: gameplay, challenge and game feel

Owner's complaint: "the game itself feels too easy." This document measures why, compares v1 with Super Mario Bros 1-1, Celeste and Geometry Dash, and sets out what v2 needs. The numbers come from a script that reuses the v1 solver physics frame for frame. It does not use estimates.

- Script: `docs/v2/diagnosis/gameplay/level_metrics.ts`. Run it with `cd web && ./node_modules/.bin/vite-node ../docs/v2/diagnosis/gameplay/level_metrics.ts` (about 2 s).
- Results: `docs/v2/diagnosis/gameplay/results.json` (full) and `results.md` (tables).
- Inputs: the 3 Starter World fixtures, the 2 seeded remixes from `vision/data/dal.sqlite`, the owner's 5 drafts from `vision/data/uploads/drafts/` (copied read-only into `gameplay/inputs/`), and 5 synthetic calibration levels.
- Proposed v2 physics envelope: `gameplay/proposed_physics.py` and `proposed_physics_results.md`.

---

## 1. Summary

v1 feels too easy for three reasons, and they add up:

1. **The levels ask almost nothing of the player.** Each Starter World level needs 1 to 3 real jumps. Every required jump has a takeoff window of 16 to 44 frames (0.27 to 0.73 s). The model predicts 0.000 to 0.004 deaths per attempt and a 99.6 to 100% chance of clearing on the first try. Every level can be finished in about 4 to 5 seconds. No hazard touches walkable ground in any starter level. The only enemy (Key Cave) patrols a platform you never need to stand next to: the level stays solvable with the enemy's whole patrol treated as a wall.
2. **The player has no skill ceiling, so there is nothing to master.** Speed is binary: 0 or 10 cells/s, reached in 0 frames, with full instant control in the air. There is no run button, no momentum, no stomp, no lives and no score that matters. Coins do nothing. Completion time is measured but never shown. A death costs 300 ms. The game has no audio (`audio: { noAudio: true }`). Nothing rewards playing well, and nothing punishes playing badly.
3. **The level is one fully visible screen, and the vocabulary has no active threats.** A 48x27 single screen with no camera means the whole level is solved by looking at it before you move. The v1 vocabulary has nothing that moves toward the player. There is no gravity-bound enemy, no projectile, no saw, no crumbling floor, no lava and no time pressure beyond a timer rule. Timers in the data give 11 to 15 times the time needed.

There is also a fourth reason that ties into the "built after I draw is poor quality" half of the complaint. **The way a drawing is compiled removes whatever challenge the drawer intended, or breaks the level.** Of the owner's 5 drafts:
- 2 are unsolvable. One fails because a drawn stepping-stone platform was rasterized 2 cells thick and turned the gap jump into a head-bonk. The other fails because a black scribble became a 1-cell wall.
- 1 turned a drawn "spikes on the platform" zigzag into a 41-cell hazard slab floating above the platform. It sits off the route and adds zero risk.
- Only one owner level (Synth 1, drawn on paper) produces any measurable risk: 0.125 expected deaths per attempt.

Better physics alone makes v1 levels easier, because the proposed v2 player can do more. Challenge in v2 has to come from three places: (a) a richer vocabulary of threats, (b) longer levels with a camera, and (c) a designer that can raise a drawing's difficulty toward a target without breaking the drawer's intent. That is the Faithful / Polished / Challenging dial in section 9.

---

## 2. What v1 actually is (measured)

### 2.1 Player physics (`web/src/game/constants.ts`, `Player.ts`)

| Property | v1 value | Measured consequence |
|---|---|---|
| Horizontal speed | `RUN_SPEED` 160 px/s = **10 cells/s** | `body.setVelocityX(dir * RUN_SPEED)` every frame (`web/src/game/Player.ts:158`) |
| Acceleration / deceleration | **none** (0 frames to full speed, 0 frames to stop) | No momentum. Turning around mid-air is instant. |
| Run button | **none** | Jump distance does not depend on speed. A standing jump and a "running" jump are the same jump. |
| Air control | full and instant | You can fix any mistake mid-air, which takes away most commitment. |
| Gravity | 900 px/s², the same rising and falling | Floaty, symmetric arc |
| Jump | vy -330. Releasing early cuts vy to -120. | Full jump: **apex 3.61 cells, 7.33 cells long, 44 frames airborne**. A 1-frame tap: apex 0.77 cells, 3.17 cells long. |
| Max fall speed | 1200 px/s (75 cells/s) | Falls are fast and hard to read. |
| Coyote / buffer | 80 ms / 100 ms | Fine. Note that the solver does not model them (about 0.8 cells of extra reach). |
| Jump envelope by hold time | 1 f: 0.77 high / 3.17 long. 6 f: 2.17 / 5.17. 12 f: 3.34 / 6.83. 15 f and up: 3.61 / 7.33 | Holding past 15 frames does nothing. Most gaps can be cleared with any hold from 1 to 40 frames (see the "hold frames that work" column in `results.md`: 35 to 39 of 40 in every starter jump). |
| Crossing the level | 768 px / 160 px/s = **4.8 s** | The whole game takes seconds. |

PLAN.md says the max jump height is "≈ 3.8 cells". That is the continuous formula v²/2g = 60.5 px. The discrete 60 Hz simulation the solver uses gives 57.8 px (3.61 cells). Both clear a 3-cell wall and not a 4-cell one.

### 2.2 Threats, stakes and feedback

| System | v1 | Evidence |
|---|---|---|
| Enemies | One kind, `Patroller`. **No gravity** (`setAllowGravity(false)`): it hovers wherever it was drawn. 3 cells/s, which is 30% of player speed. Any contact kills, **including landing on top**. You cannot stomp it. | `web/src/game/behaviors/Patroller.ts:6` (header), `:38` (`setAllowGravity(false)`), `:45` (overlap calls `scene.die()`) |
| Hazards | The `2` tile: a full 16x16 cell, no orientation, no inset hitbox | `LevelScene.createTilemap`, `cv/components.py` (red coverage ≥ 25% makes a hazard cell) |
| Moving hazards | none (no saws, projectiles, crushers, rising lava) | `shared/behaviors.md` vocabulary |
| Platforms that change | Moving platform only. `crumble` and `gravity_flip` are named as stretch goals and were not built. | `behaviors.md` |
| Lives / health | none. Infinite retries. | `web/src/game/LevelScene.ts:364` (300 ms, then respawn) |
| Death cost | 300 ms. Collected coins stay collected after death. | `LevelScene.die` / `respawnPlayer` |
| Score / reward | Coins are counted and **have no effect**. `timeMs` is sent with `win` but **never shown** to the player (only logged on the dev page). | `LevelScene.win`, `dev/main.ts:51` |
| Camera | **none**. The world is the screen (`setBounds(0,0,GAME_W,…)`). The whole level is visible from frame 1. | `web/src/game/LevelScene.ts:138-139` |
| Audio | **off** (`audio: { noAudio: true }`) | `web/src/game/index.ts:71` |
| Juice | Squash and stretch on jump and land, a camera shake on death, a coin "+1" | `Player.squash`, `LevelScene.die`, `collectCoin` |

---

## 3. Per-level measurements

The method is a fewest-jumps route over the solver's standing-cell graph, using Dijkstra with jumps as the primary cost and frames as the tie-break. For each required jump on that route, the script sweeps every takeoff pixel on the platform, holding the direction, with all 40 hold lengths:
- **takeoff window**: how many frames of takeoff timing still make progress toward the goal, at 160 px/s = 2.67 px/frame
- **hold window**: how many hold lengths work from the best takeoff
- **lethal share**: how often a miss kills, counting both early takeoffs and running off the edge

A casual-player timing-noise model (takeoff SD = 3 frames ≈ 50 ms) turns windows into a P(fail) and a P(death) for each jump. Expected deaths per attempt is the sum of those, and P(clear first try) is their product.

| Level | Solvable | Required jumps | Fastest clear (s) | Route length (cells) | Tightest window (frames) | Hazards next to walkable ground | Enemy on required route | E[deaths]/attempt | P(clear 1st try) | Timer slack |
|---|---|---|---|---|---|---|---|---|---|---|
| **Starter 1: First Steps** | yes | 2 | 3.95 | 36 | 28.1 | 0 | n/a | 0.000 | 100% | n/a |
| **Starter 2: Spike Valley** | yes | 3 + 1 bounce | 4.85 | 51 | 16.1 | 0 | n/a | 0.004 | 99.6% | n/a |
| **Starter 3: Key Cave** | yes | 1 | 4.05 | 34 | 22.1 | 0 | **no** | 0.000 | 100% | n/a |
| Remix: First Steps + spikes (seed) | yes | 2 | 3.98 | 36 | 13.9 | 2 | n/a | 0.010 | 99% | n/a |
| Remix: First Steps speedrun (seed) | yes | 2 | 3.98 | 36 | 13.9 | 2 | n/a | 0.010 | 99% | **11.3x** (45 s timer) |
| Owner: Synth 1 (paper) | yes | 3 | 4.13 | 36 | 8.6 | 2 | n/a | **0.125** | 87.6% | **14.5x** (60 s timer) |
| Owner: Key Cave remix, spikes in pit | yes | 1 | 4.05 | 35 | 9.0 | 2 | no | 0.070 | 93% | n/a |
| Owner: Key Cave remix, red zigzag on platform | yes | 1 | 4.17 | 34 | 22.1 | 1 | no | 0.000 | 100% | n/a |
| Owner: Key Cave remix, black zigzag on platform | **NO** | n/a | n/a | n/a | n/a | 0 | n/a | n/a | n/a | n/a |
| Owner: Untitled (canvas, 2 platforms, pit, flag) | **NO** | n/a | n/a | n/a | n/a | 4 | n/a | n/a | n/a | n/a |
| Calib: one 4-cell spike pit | yes | 1 | 3.63 | 22 | 22.1 | 0 | n/a | 0.000 | 100% | n/a |
| Calib: one 5-cell spike pit | yes | 1 | 3.63 | 23 | 16.1 | 0 | n/a | 0.004 | 99.6% | n/a |
| Calib: one 6-cell spike pit (the widest v1 allows) | yes | 1 | 3.65 | 24 | 10.1 | 0 | n/a | 0.049 | 95% | n/a |
| Calib: rising 2-wide steps over spikes | yes | 6 | 3.95 | 49 | 16.1 | 0 | n/a | 0.022 | 97.8% | n/a |
| Calib: 1-cell pillars 5 apart over spikes | yes | 7 | 4.22 | 46 | 10.1 | 0 | n/a | **1.92** | **9%** | n/a |

What these numbers mean:

- **Starter World is a tutorial with no test.** Its hardest jump has a 16-frame window. The hardest single jump the v1 engine allows on flat ground (a 6-cell pit) has a 10-frame window. So the starters never get close to the engine's own limit. Spike Valley's spikes sit at the bottom of pits two rows below the floor. They are the same as a bottomless pit and never next to where you walk. Spike Valley's moving platform is the only timing element, and its 7-cell gap is covered by a platform that moves only 4 cells.
- **Key Cave's enemy is decoration.** It patrols x 14 to 22 on a raised platform. The player can climb on at x 23 or 24, past the end of the patrol, or walk underneath it. The script marks the enemy's whole swept patrol area as a wall and the level is still solvable.
- **The engine can produce challenge**, as the pillar calibration shows: 7 precise jumps, 9% first-try clear. But only with structures that nobody draws by hand and that no designer adds. This model is pessimistic for pillars because it holds the direction for the whole jump. Players who let go of the direction in mid-air do better.
- **Every level takes 4 to 5 s.** For comparison, a casual SMB 1-1 clear takes roughly a minute or more. The available timers (45 s, 60 s) give 11 to 15 times the needed time, so a timer never creates pressure.

### 3.1 How the build step breaks or flattens the owner's drafts (the "poor quality after I draw" link)

These levels came from the owner's real drawings in `vision/data/uploads/drafts/`.

- **`d_b14b143e`, "Untitled level" (canvas): unsolvable.** The drawing is a textbook level: a floor, a pit with spikes, a spike strip on the floor, a low stepping-stone platform, a high platform that "moves left and right", and a flag. The build has these faults:
  - The stepping-stone platform became a 2-cell-thick wobbly staircase (rows 17-18) 6 cells above the floor. That is higher than the 3.6-cell jump, so it cannot be reached.
  - Its underside overhangs the pit edge. The 5-cell gap jump, which is normally easy, bonks the player's head at frame 8 (y 304, vy 0) and drops them into the pit at frame 31. This came from the script's frame trace.
  - The left floor was bound as a second `moving_platform` with "no room to move" (warning).
  - The spike strip floats in rows 22-23.
  - The goal floats one cell above the ground.

  No step checked whether a drawn platform was meant as a stepping stone and placed it at a jumpable height.
- **`d_dfbfe619` (black zigzag on the Key Cave platform): unsolvable.** The zigzag's lowest strokes became single solid cells at row 23 under the platform (x 12 and x 20). Together with the platform they form walls with 1 cell of headroom, and the player is 1.75 cells tall. Only 12 cells can be reached.
- **`d_79eff85e` (red zigzag "spikes" on the Key Cave platform).** 41 hazard cells, 3.2% of the grid. They became a solid hazard slab in rows 19-21 floating over the platform the route never uses. Expected deaths added: **0**.
- **`d_45f50934` (red spikes drawn into the pit).** This is the one remix where the drawing added real risk: the window went from 22.1 to 9.0 frames and E[deaths] went from 0 to 0.07.

So the owner's two complaints are one problem. A level with no designer between drawing and play is either trivial or broken. It is rarely "hard but fair".

---

## 4. Why it feels too easy: root causes

| # | Root cause | Evidence | Impact |
|---|---|---|---|
| R1 | **No momentum or speed skill.** 0 to 10 cells/s instantly, full air control, jump distance independent of speed. | `Player.update` (`setVelocityX(dir*RUN_SPEED)`), envelope table | Every jump is the same jump. There is no "run up to clear the big gap" and no commitment. The skill ceiling is reached in 10 seconds. |
| R2 | **Jumps are far over-provisioned.** Typical drawn gaps are 3 to 5 cells against a 7.3-cell reach. 31 to 39 of 40 hold lengths work. | `results.md` per-jump tables | Precision never matters. |
| R3 | **No active threats.** One enemy type, gravity-less, slow (3 c/s), avoidable, not stompable. No moving hazards. | `Patroller.ts`, `behaviors.md` | Nothing forces timing or attention. Enemies are obstacles you avoid, not things you engage with. |
| R4 | **Single fully visible screen.** No camera, 48x27 world, 4 to 5 s to cross. | `LevelScene.create` world bounds | No discovery, no pacing, no rhythm. Every level is "one setpiece". |
| R5 | **No stakes or reward loop.** Infinite 300 ms respawns, coins with no value, time never shown, no medals or leaderboard. | `die()`, `win()`, HUD | Dying means nothing, and playing well earns nothing. |
| R6 | **The starter content is a tutorial.** 1 to 3 jumps per level, no hazard next to the route, a decorative enemy, no difficulty curve across the three levels (E[deaths] 0.000 / 0.004 / 0.000). | Section 3 | The first impression is "this is a toy". |
| R7 | **Build step without design intelligence.** Drawn hazards land where they don't matter. Drawn platforms land where they cannot be reached. Nothing tunes difficulty. | Section 3.1 | Even a drawer who wants challenge gets none, or gets an unwinnable level. |
| R8 | **No game feel.** No audio, no hit-stop, no stomp feedback, no dust, no landing sound. | `web/src/game/index.ts:71` | Easy and silent reads as "unfinished". |

---

## 5. What Mario-grade play needs: comparison

The numbers below are approximate and come from public sources: SMB community disassembly notes, Celeste's published `Player.cs`, and widely cited design analyses. They are reference points. They are not targets to copy exactly.

| Aspect | SMB 1-1 | Celeste | Geometry Dash | v1 |
|---|---|---|---|---|
| Speed model | Walk ≈ 1.5 px/frame (≈ 5.6 tiles/s), run (B) ≈ 2.5 px/frame (≈ 9.6 tiles/s), with acceleration, skid and friction | MaxRun 90 px/s with RunAccel 1000 px/s² (about 0.09 s to full speed). Air accel is 65% of ground. | Automatic, constant, synced to music | 10 cells/s instantly, full air control |
| Jump | Height and distance grow with horizontal speed (3 tiers). Variable height. Heavier gravity after release or at the apex. | Variable jump (0.2 s hold window), half gravity near the apex (\|vy\| < 40), fast-fall, coyote 0.1 s, buffer, corner correction | One fixed jump, timing is everything | Variable by cut only. Distance does not depend on speed. |
| Level size | About 200+ tiles wide (≈ 13 screens of 16 tiles), a following camera that never scrolls back | One screen per "room", rooms chained, camera per room | Long auto-scrolling levels, 1 to 3 minutes | **48 cells, one screen, no camera** |
| Structure | Teach, test, twist. The first Goomba arrives in a safe flat area. Pipes of rising height teach jump height. Pits come after the player can jump. A staircase finale and a flagpole whose height sets the score. | One idea per chapter, escalated room by room. Rest rooms between hard rooms. | Rhythm: obstacles on the beat, memorization, practice mode | No teaching structure. The three levels are flat in difficulty. |
| Threat variety | Goomba (walker with gravity, stompable), Koopa (shell becomes a weapon), Piranha (timed), firebars, Bullet Bills, Hammer Bros | Spikes (directional), crumble blocks, moving blocks, wind, seekers, Badeline chasers | Spikes, saws, gravity portals, speed portals | Hovering patroller, hazard cells |
| Stakes | 3 lives, a timer (400 game units ≈ 160 s), score, 100 coins = 1-up | Infinite lives, instant respawn, a death counter shown with pride, strawberries (optional risk) | Attempt counter, percent progress, stars | Infinite lives, nothing shown, coins worthless |
| Precision windows | Mostly generous (≈ 10 to 30 frames) in World 1. Tight late. | Can be 2 to 5 frames in late B/C sides. Early chapters are generous. | Frame-tight in Demon levels | 16 to 44 frames everywhere |
| Reward | Hidden blocks, warp zones, flagpole score | Strawberries that must be carried to safe ground, cassettes, hearts | Coins, perfect runs | Coins with no effect |

The principles v1 is missing:

1. **Teach, test, twist (Nintendo's 4-beat level design).** Introduce a mechanic safely, test it with real risk, then twist it by combining or escalating, and finish with a flourish. v1 has no sequencing at all: everything is visible and happens once.
2. **A difficulty curve across a world, sawtooth shaped.** Difficulty rises within a level and drops at checkpoints and at the start of the next level. The overall trend rises across a world. v1 starters score 0.000 / 0.004 / 0.000.
3. **Rhythm.** Obstacles spaced so a run has a cadence (jump, step, jump, wait, jump). This needs length and a camera.
4. **Risk and reward.** Optional coins placed in harder spots, worth something: a medal, a life, a leaderboard bonus. v1 coins sit near the route and do nothing.
5. **Momentum platforming.** Speed as a resource you build and must manage. Wide gaps require a run-up.
6. **Generous inputs, harsh levels.** Celeste's lesson. Coyote, buffer and corner correction remove unfair deaths, which lets the level be strict. v1 has the generous inputs but not the strict levels.
7. **Checkpoints sized to frustration.** Respawn cost should stay under about 20 to 30 s of replay. In v1 this is irrelevant because levels are 5 s long. Once levels are long it becomes essential.
8. **Every death is readable.** The cause is visible, nothing is off-screen, and there are no blind jumps. The camera's look-ahead has to show the landing before the player commits.

---

## 6. A difficulty model the designer can target

Built from the solver, which already lives in `web/src/solver/`. The script in this folder is a working prototype of it.

**Per required action i** on the intended route, meaning the route with the fewest expected deaths:

- `w_i` = takeoff window in frames (pixel sweep of takeoff positions ÷ px per frame)
- `h_i` = hold window (number of jump-hold lengths that work)
- `L_i` = lethal share of misses (early takeoff, running off the edge, wrong hold)
- For v2 timing entities, an extra phase window `φ_i`: the fraction of an enemy's or moving platform's cycle in which the move is safe, converted to frames

`p_i = 1 − (1 − 2Φ(−w_i / 2σ)) · (1 − 2Φ(−h_i / 2σ)) · (1 − 2Φ(−φ_i / 2σ))`, with σ = 3 frames for a "casual" profile and 1.5 frames for a "skilled" profile.

`d_i = p_i · L_i` is the death probability at that action.

**Per segment s** (between checkpoints): `E_s = Σ d_i` is the expected deaths per attempt. `T_s` is the segment's fastest clear time.

**Level scores**

- **Challenge C** = max over segments of E_s, plus 0.25 · Σ E_s (the hardest part dominates, and total length counts a little)
- **Frustration F** = Σ_s E_s · T_s (expected seconds lost to replays). F is the knob that decides where checkpoints go.
- **Fairness flags** (hard constraints, never traded for difficulty):
  - any window < 4 frames (casual)
  - a jump whose landing is not on screen at takeoff (blind jump)
  - a hazard within 2 cells of a spawn or checkpoint
  - an enemy whose patrol overlaps the spawn
  - a lethal fall with no visible hazard
  - a segment with F > 30 s

**Bands** for the casual profile, using the measurements in section 3:

| Band | C (E[deaths] in the hardest segment) | Examples measured here |
|---|---|---|
| 0 Trivial | < 0.05 | All three v1 starters, the seeded remixes |
| 1 Easy (SMB World 1) | 0.05 to 0.3 | one 6-cell pit (0.05), owner's Synth 1 (0.125) |
| 2 Normal | 0.3 to 1.0 | n/a |
| 3 Hard | 1.0 to 3.0 | 7 pillar jumps over spikes (1.92) |
| 4 Expert | > 3.0 | n/a |

A 0 to 100 "difficulty score" for the UI and leaderboards can be `100 · (1 − e^(−C))`, plus a small length term. The prototype score in `level_metrics.ts` uses a cruder additive formula. The v1 starters score 2 to 6, the pillars score 100.

Engineering notes for v2:
- The solver must take a **physics profile** parameter. It is currently hard-wired to `constants.ts`.
- It must handle a level wider than 48 cells. `GAME_W` is used for the world's right wall in `physicsSim.stepFrame`.
- It must model moving entities in time (state = cell + phase), not as static bridges. v1 makes moving platforms "one-way along their whole path" and ignores enemies. Both under-estimate difficulty.
- It must stop holding the direction for the whole jump (add "release direction at frame k" policies). This matters for small-landing jumps.

---

## 7. Recommendations

### 7.1 Player physics v2 (numbers, verified by `proposed_physics.py`)

Keep `CELL = 16` and the 12x28 body so v1 drawings keep their scale. Add a `physics_profile` to the game rules sheet. v1 levels keep `profile: "v1"`.

| Constant | v2 value | Why |
|---|---|---|
| Walk max speed | 96 px/s (6 cells/s) | Default movement is slower and more controllable |
| Run max speed (hold Run, or auto-run after 0.5 s of holding a direction on touch) | 168 px/s (10.5 cells/s) | Creates a speed skill and the "run-up" gap |
| Ground acceleration | 1000 px/s² to walk speed (≈ 6 frames), then 300 px/s² to run speed (≈ 0.25 s more) | Momentum you feel but don't fight |
| Ground friction (no input) | 1400 px/s² (stop from run in ≈ 7 frames) | Slight slide gives a sense of weight |
| Turn-around (skid) decel | 2400 px/s² | A skid frame, and a reason to commit |
| Air acceleration | 65% of ground. No air friction while a direction is held, 200 px/s² without input. | Commitment with recoverable small errors (Celeste) |
| Jump launch | vy = −(340 + 0.25·\|vx\|) px/s | Speed-dependent height and distance (SMB) |
| Gravity | 900 rising with jump held. **Half gravity at the apex** (\|vy\| < 40, held). **1700 otherwise** (falling or released). | Snappy fall, readable floaty apex |
| Jump release cut | vy := max(vy, −220) on release | Taps hop about 1.1 cells |
| Max fall | 330 px/s (≈ 20 cells/s). 450 px/s with Down held (fast-fall). | Readable falls, control while descending |
| Coyote / buffer | 100 ms / 120 ms | Generous inputs, so levels can be strict |
| Corner correction | Nudge up to 4 px sideways on a ceiling-corner bonk, and up to 3 px up on a ledge-corner graze | Removes unfair bonks like the one in `d_b14b143e` |

Resulting envelope (`proposed_physics_results.md`):

| Takeoff | Max height | Max distance | Tap hop |
|---|---|---|---|
| Standing | 3.86 cells (clears a 3-cell wall) | 0 | 1.12 cells |
| Walking 6 c/s | 4.45 cells (clears 4) | 4.9 cells (clears a 4-cell gap) | 1.14 cells |
| Running 10.5 c/s | 4.92 cells | 9.1 cells (clears an 8-cell gap) | 1.16 cells |

The split between walk-gaps (≤ 4) and run-gaps (5 to 8) is the main new skill. A designer can now require a run-up by drawing a wide gap with enough runway in front of it. The solver checks this through its runway-aware run-jump action.

### 7.2 Systems to add (fixed vocabulary, in priority order)

Tier 1, needed for "not too easy":

1. **Camera and long levels** (see 7.3).
2. **Run and momentum** (7.1).
3. **Stomp.** Landing on an enemy's top half while vy > 0 kills it. Bounce vy −280, or −380 with jump held (a stomp-chain skill). Add 60 ms hit-stop, a puff and a sound.
4. **Enemies obey gravity by default.** Walkers fall, land, and turn at walls. A flag (`ledge_aware`) makes them turn at ledges too. Only the explicit `flyer` type hovers. This also fixes the v1 review item "enemies hover in mid-air".
5. **Directional spikes.** A spike strip is an entity with a surface and a facing (up/down/left/right). Its hitbox is a 6 px-tall band inset 2 px from the cell edges, snapped onto the surface it rests on. Drawn red zigzags become this, not 3-row hazard slabs.
6. **One-way (jump-through) platforms.** Thin single-stroke lines become jump-through by default and thick filled shapes stay solid. This alone fixes most head-bonk failures in drawn levels. Drop through with Down plus Jump.
7. **Crumble platforms.** They fall 0.5 s after being stood on and respawn after 3 s.
8. **Saws.** A circular hazard on a path (reuses the `move` path vocabulary). A visible, timed threat.
9. **Checkpoints placed by the designer** (fairness rule F ≤ 30 s), plus drawn checkpoints.
10. **Stakes and rewards.**
    - Always show a speedrun timer, and show the time on the win banner.
    - Per-level medals: clear / all coins / par time / no-death.
    - Coins feed medals, and 100 coins give a life when lives are on.
    - Up to 3 optional "big coins" per level, placed by the designer in risk spots.
    - Lives come from the game rules sheet: `lives: off | 3 | 5`. Default off (Celeste model) with the death counter shown, because user-made levels vary in fairness.
11. **Audio and juice.**
    - SFX for jump, land, coin, stomp, death, checkpoint and goal.
    - Dust on landing and on skid.
    - Hit-stop on stomp.
    - The v1 squash and stretch, kept.

Tier 2, for variety and twists:

- **Enemy archetypes** (6, fixed): `walker` (Goomba), `hopper` (jumps every N s), `flyer` (sine path, no gravity), `shooter` (fires a slow projectile every N s in its facing direction), `chaser` (walks toward the player when within 8 cells, with gravity), `crusher` (drops when the player is below and rises slowly). Each has 1 to 3 parameters with clamped ranges, just like v1 `patrol`.
- **Hazards**: `lava` (an animated hazard fill for pits; lethal, readable), `rising_lava` (a level-wide timer threat), `firebar` (a rotating line around an anchor).
- **Springs**: v1 `bounce_pad` with a direction (side springs).
- **Moving and falling platforms**: v1 `move`, plus `falls_when_stood`.

Tier 3, later:

- **Ladders and vines.** They slow the tempo, need a climb state machine, and are ambiguous when drawn. Add them only when a drawn ladder (two parallel strokes with rungs) is reliably detected.
- **Gravity flip** (the v1 stretch item), **wind zones**, **keys with multiple doors**.

### 7.3 Level size and camera

- **Viewport** stays 48x27 cells (768x432) so the drawing scale is unchanged. **The world becomes width 48·k, with k = 1 to 6 sheets** (up to 288 cells ≈ 6 screens), with optional extra height of 27·m.
  - A paper level spans multiple sheets, stitched by the QR code (`dal2|lvl|<id>|sheet|<n>`).
  - A canvas level is a long scrollable canvas.
  - In player-height units, our viewport already shows about 1.7 times more horizontal space than SMB's 16x15 screen, so 4 to 6 sheets is about SMB 1-1 length.
- **Camera**:
  - Horizontal follow with a dead zone 4 cells wide around the player.
  - **Look-ahead** of 6 cells in the facing or moving direction, eased with lerp 0.1 per frame. With the walk and run speeds above, this keeps every landing of a run jump (≤ 9 cells) on screen at takeoff. The designer's "blind jump" check uses this same rule.
  - Vertical: follow on landing (platform snap). Follow during a fall only when the player leaves the middle 60% band.
  - Clamp to world bounds. Never scroll back past a checkpoint in "SMB mode" (optional rule).
- **The solver and world bounds must be parameterized by `grid.w`/`grid.h`.** v1 hard-codes `GAME_W` / `GRID_W` in `physicsSim.ts`, `LevelScene.createTilemap` and the world bounds.

### 7.4 Starter World v2 (the first impression)

Replace the 3 one-screen fixtures with 4 levels of 3 to 5 screens each. Each follows teach, test, twist, finale, and they follow a curve (casual C):

| Level | Teaches | Target C | Length | Notes |
|---|---|---|---|---|
| 1 | run, jump, stomp | 0.1 | 3 screens | The first walker arrives on flat ground. A pit that needs a run-up (6 cells). A risk coin over the pit. |
| 2 | spikes and one-way platforms | 0.3 | 4 screens | Spike strips on platform tops. Jump-through ledges stacked as a tower. A checkpoint after the tower. |
| 3 | moving and crumble platforms, saws | 0.6 | 4 screens | Rhythm section: crumble, crumble, saw window. Big coins off the path. |
| 4 | key and door, plus everything | 1.0 | 5 screens | The finale combines the twists. A par-time medal at 1.3 times the dev time. |

Starter World should be built with the same designer pipeline (section 9) from team drawings. That makes it double as the reference for "what Challenging produces".

---

## 8. Recommended fixed vocabulary for the designer's edits (gameplay part)

These are the AI-proposed and code-applied edit operations that touch difficulty. The perception and repair half is covered by the build diagnosis. Each edit is:
- typed and bounded
- applied by deterministic code
- re-validated with the solver and the difficulty model
- shown as a diff with a one-line reason
- individually undoable

| Op | Params (clamped) | Changes difficulty by |
|---|---|---|
| `set_enemy_param` | id, speed 1 to 6, patrol range ≤ its platform, archetype within the drawn role | phase windows |
| `set_platform_param` | id, speed 1 to 6, path length ≤ ±50% of drawn | phase windows |
| `widen_gap` | gap id, +1 to +2 cells, never past the max for the runway available | takeoff window, run requirement |
| `shrink_landing` | platform id, −1 to −2 cells, never below 2 cells | landing window |
| `raise_platform` | id, ±1 row | hold window |
| `add_spikes` | surface id, span, only on undrawn surfaces of drawn platforms and pit floors | lethality of misses |
| `add_enemy` | archetype, cell, only on flat empty stretches ≥ 8 cells, ≥ 6 cells from spawn and checkpoints | new threat |
| `add_hazard` | saw / firebar / lava, only in empty space, never overlapping drawn ink | new threat |
| `add_checkpoint` | cell, only on flat ground | frustration F |
| `add_coin` / `add_big_coin` | cell, breadcrumb or risk spot | reward |
| `set_timer` | seconds = 1.2 to 2.0 times the solver's fastest time | time pressure |
| `set_par_time` | seconds | medal target |

---

## 9. Getting challenge the drawer didn't draw, without breaking their intent: the difficulty dial

**Intent invariants**, which every dial position must keep and the code must check after each edit:

1. **Every drawn object survives with its role.** A platform stays a platform, a hazard stays a hazard and stays lethal, an enemy stays an enemy, a coin stays collectable. Nothing drawn is deleted or covered.
2. **Every drawn object stays near where it was drawn.** At most ±1 cell in Faithful/Polished, ±2 in Challenging, and only along the axis the edit needs.
3. **The order and the route the drawer implied stay the same.** Start, the order of setpieces from left to right, key before door, goal. The fewest-jumps route must still visit the same drawn platforms in the same order. The solver can check this as an ordered subsequence of standing nodes.
4. **Explicit text rules win.** "Slow platform", "easy", "the monster walks" pin those parameters, and the designer never overrides them.
5. **Added content looks added.** It is drawn in a distinct "designer ink" style, listed in a diff panel ("Designer added 3 things: …"), and each item is undoable.
6. **Always solvable, always fair.** The fairness flags from section 6 hold after every edit, or the edit is rejected.

**The dial**

| Position | What the designer may do | Target |
|---|---|---|
| **Faithful** | Only repairs needed for the drawing to work as drawn: snap spikes onto their surface and orient them, ground enemies and the goal, de-noise scribbles, make thin strokes jump-through, clear the spawn, nudge an impossible jump by the smallest edit (for example, the stepping-stone in `d_b14b143e` drops from 6 to 3 rows above the floor). | Solvable, plus fairness flags. Difficulty is whatever was drawn. |
| **Polished** (default) | Faithful, plus readability and flow: checkpoints so every segment has F ≤ 30 s, breadcrumb coins over jumps that would otherwise be blind, a par time and medals, enemies on the drawn platforms they were meant for, rhythm smoothing (even spacing within ±1 cell). It can **raise** difficulty only up to band 1 (C ≤ 0.3) using parameter edits (enemy speed, patrol range, platform speed). It never lowers what was drawn. | C = max(drawn C, 0.1). Fairness. |
| **Challenging** | Polished, plus difficulty edits (section 8) until C reaches the target band the creator picks (Normal 0.3 to 1.0, Hard 1 to 3). They are applied in this order, cheapest intent cost first: (1) parameters, (2) geometry within ±2 cells (`widen_gap`, `shrink_landing`, `raise_platform`), (3) additions in empty space (`add_spikes` on undrawn surfaces, `add_enemy`, `add_hazard`), (4) a **twist reprise**: in a long level, a mechanic the drawer used once is repeated later with an escalation (a faster platform, a saw added), in empty space only. Risk coins are added so the harder parts pay off. | C in the target band. Sawtooth: segment C rises within the level and drops after each checkpoint. Fairness. |

**The loop** (no code is written by the model):

1. Perception produces a typed scene graph.
2. The AI proposes a list of ops for the chosen dial and target band, with a reason for each.
3. Deterministic code applies them one by one. After each op it runs the intent-invariant checks, the solver and the difficulty model, and rejects any op that breaks an invariant or overshoots the band.
4. If the band isn't reached after the proposed ops, the AI gets the metric deltas and may propose up to 2 more rounds. The deterministic fallback is a greedy search over the same ops ranked by "C gained per intent cost".
5. The UI shows the diff, the predicted "≈ N deaths per attempt for a casual player", and a slider to switch the dial. Each step can be undone.

Because the difficulty model is computed and not guessed, this loop can measure whether "Challenging" actually got harder: re-run `level_metrics.ts` on the output. It also gives social features a number to sort by: the difficulty badge, "beat my level", and speedrun boards.

---

## 10. Measurements to accept v2 (re-run the script)

- Starter World v2: C per level ≈ 0.1 / 0.3 / 0.6 / 1.0 (casual). Fastest clear 40 to 90 s per level. ≥ 1 enemy that must be engaged in levels 2 to 4. ≥ 8 required actions per screen on average.
- Owner draft `d_b14b143e` after Faithful: solvable, with ≤ 3 edits, each ≤ 3 cells.
- Owner draft `d_79eff85e` after Faithful: the zigzag becomes a spike strip on top of the platform's surface. With Challenging-Normal the route crosses that platform, so C > 0.3.
- Fairness: 0 windows under 4 frames (casual), 0 blind jumps, F ≤ 30 s per segment, in all Starter World v2 levels and in every Challenging output.
- Physics: the measured envelope matches `proposed_physics_results.md` within 0.1 cells once the engine is ported (the solver and engine must share one physics module, as in v1).

## 11. Method caveats

- The jump sweep holds the direction for the whole jump and tries hold lengths 1 to 40. It does not try "release the direction mid-air", so small-landing jumps (the pillars) are pessimistic.
- Moving platforms are static bridges along their path (the v1 solver's approximation). Enemies are only checked as "is the route forced through the patrol area". Both under-estimate v1 difficulty slightly. They do not change the conclusion: the starter levels have no forced timing interaction.
- Coyote time and the jump buffer are not modeled (the v1 solver's documented approximation, about +0.8 cells of reach). That would make every window above a little wider, so v1 is even easier than measured.
- σ = 3 frames is a modeling choice for a "casual" player. The ranking of levels does not change with σ, but the absolute E[deaths] does.
