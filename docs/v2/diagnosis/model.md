# Diagnosis 4: what a level-design "mind" can get from Claude (live probe)

Date: 2026-10-10. Model `claude-opus-5`, adaptive thinking, explicit `output_config.effort`, called through
`client.beta.messages.parse` (Pydantic schema) with `betas=["server-side-fallback-2026-07-01"]` and `fallbacks="default"`.
Budget: 24 API calls, all 24 used. Total spend: **$1.55**. No errors, no refusals, no fallbacks were triggered.
Everything is reproducible from `docs/v2/diagnosis/model/` (scripts, inputs, raw call log).

## TL;DR

1. **Perception works.** From the v1 annotated image plus the CV component list, Claude labels each ink blob's role
   with 95-97% accuracy (ground and platform counted as one family). It gets 75/76 relations right (what sits on what,
   what hangs from what, which way spikes point). It recognised 37/38 pieces of text, arrows and decoration as
   non-geometry, and never marked real geometry as an annotation. Low effort is as accurate as medium, and about 1.3x faster (p50 11.8 s vs 15.8 s).
2. **Repair planning works when the solver supplies the facts.** Each plan was 2-6 small edits from a fixed vocabulary
   with a reason a child can read. All 4 levels repaired at medium effort became solvable, checked with the real v1 solver.
   Before repair, only 1 of 4 was solvable from the role-aware build and 1 of 4 from the v1 grid.
   Most edits preserved what the child meant. One clear exception: in the cave the model "lifted the wall so you can
   duck under it" instead of lowering it.
3. **Claude is bad at judging physics from the picture.** Without solver facts it called a jumpable 5-cell gap
   "likely too far" in 3 of 3 runs. When the solver's reachable set was in the prompt it got this right every time.
   **Reachability must stay deterministic and be fed to the model, never inferred by it.**
4. **Designer enhancements have good taste but must be validated.** Most suggestions were sensible: coin arcs over
   risky jumps, a walker on a long flat stretch, a checkpoint after the hard part. 15/18 additions passed placement
   checks; one more (a spike strip under a low overhang) made a level **unsolvable**. That leaves 15/18 accepted.
   The deterministic re-solve caught every failure.
5. **Prompt-to-level is viable.** 5/5 skeletons were solvable. In both key-and-door levels the key was reachable
   with the door closed, and the door really blocked the goal. 59/60 coins were reachable and 16/16 enemies stood on surfaces.
   Caveat: the v1 solver ignores moving-platform timing and enemies, so "solvable" overstates fairness for the "hard" prompt.
6. **Latency is the main constraint.** p50 is about 12 s for perception (low), 25 s for repair (medium) and 29 s for
   enhancement (medium). Running A then B then C at medium takes about 70 s, so the "scan and play in 15 s" promise
   cannot run that chain synchronously. Per level it costs about $0.05 + $0.08 + $0.07 = **$0.20 at medium**.
7. **The v1 live path is broken on a realistic drawing, and the cause is not timeouts.** The v1 `interpret` call took
   10.9 s, inside its 20 s timeout. But the model left out `opens_component_id`, so v1 compiled the key into a coin
   behind a permanent door. It also bound "start" to the whole ground, and the bbox-center rule moved the spawn to
   x=23, the middle of the level. The tree stayed solid. Result: v1's level is **unsolvable**. The A+B chain made the
   same drawing solvable, with the key gating the door.

## Setup

Inputs (`model/inputs/<scene>/`): `annotated.jpg` is exactly what v1 sends to the model. `cv.json` is the v1
`run_scan` output: grid, components with cells, goal, start. `gt.json` holds hand-authored ground truth, matched to the
CV components by color and cell overlap, plus the repairs a designer would expect.

| Scene | Source | Components | What it tests |
|---|---|---|---|
| `canvas_floating_spikes` | Pillow canvas, 8 px brush | 16 | spikes floating 1 row above a ledge, spikes hanging from a ceiling, monster on the ground, goal floating in mid-air, the word "jump!", an arrow, a cloud and a sun |
| `canvas_wobbly_cave` | Pillow canvas | 12 | wavy floor and roof, accidental 1-cell gap, 8-cell pit (max is 6), 5-cell wall (max is 3), **red** handwriting "lava!", a bat |
| `canvas_tower_key` | Pillow canvas | 22 | staircase with one 4-row step (max is 3), key on a ledge, door bar, "key opens door" and "S" written in black, spikes on a wall face, enemy on a ledge, tree, top ledge split into 3 by the goal star |
| `paper_synth_1` | `shared/fixtures/photos/synth_1.jpg` (paper mode) | 11 | v1 fixture: "moves" plus an arrow, spikes, goal. synth_2 and synth_3 have the same layout under different warps, so they were not probed separately |

Physics facts given to the model come from PLAN.md section 2 and the solver: jump 3 cells up and 6 empty cells across,
player 1x2. Every result was validated by the **real v1 TypeScript solver** (`web/src/solver/solve.ts`, called through
`npx vite-node`). Throwaway Python code (`builder.py`) applied the edits deterministically.

## Probe A: perception (scene graph)

The model gets the annotated image and the component list. It returns a node per component with role,
`rests_on`, `attached_to`, `points`, `part_of`, confidence, plus `creator_intent` and `problems_noticed`.
Scoring: `score_a.py`, output in `results/probe_a_scores.json`.

| Scene | low: role (lenient) / relations | medium | high |
|---|---|---|---|
| floating_spikes (16) | 0.94 / 10/10 | 0.94 / 10/10 | 0.94 / 10/10 |
| wobbly_cave (12) | 1.00 / 6/6 | 1.00 / 5/6 | not run |
| tower_key (22) | 0.91 / 8/8 | 0.95 / 8/8 | 0.95 / 8/8 |
| paper_synth_1 (11) | 1.00 / 5/5 | 1.00 / 5/5 | not run |
| **Aggregate** | **58/61 = 0.95, rel 29/29** | **59/61 = 0.97, rel 28/29** | **36/38 = 0.95, rel 18/18** |
| Text, arrows and decoration recognised as non-geometry | 13/14 | 14/14 | 10/10 |
| Geometry wrongly dropped as annotation | 0 | 0 | 0 |

- Relations included every spike-orientation case: up on a ledge, down from a ceiling, left on a wall face.
  The floating strip got `rests_on` the ledge below it. The monster got `rests_on` the ground. The arrow got
  `attached_to` the platform with `points: right`.
- `part_of` grouping was correct at all 3 effort levels (not auto-scored): the words of "key opens door" became one
  phrase, the 3 fragments of the split top ledge became one ledge, and the tree trunk joined the tree crown.
- The only role errors:
  - A high ledge with spikes hanging under it was called "platform" instead of "ceiling" (confidence 0.9). This is defensible.
  - The unlabeled door bar was called "wall" (0.7). The repair stage later turned it into a door from the text "key opens door".
  - At low effort only, the tree crown was called "door" (0.4).
- Calibration: the 153 correct labels averaged confidence 0.86, and only 7.8% were below 0.75. The meaningful
  errors were at 0.4 and 0.7. A threshold of about 0.75 is a usable "ask the child" trigger.
- One integrity failure at low effort: the model invented a placeholder node id 17 that does not exist (confidence 0.1,
  "placeholder not in list"). **Code must drop unknown ids** (v1 compile already does this for bindings).
- `problems_noticed` is good at intent issues: floating goal, words that would become walls, "no door exists although
  the text promises one". It is bad at physics. In floating_spikes the 5-cell gap was called impossible or "likely too far"
  at all 3 effort levels; the solver says it is jumpable. It also miscounts gaps by 1 ("spikes 2 cells above"; the real gap is 1 empty row).

## Probe B: repair planning

Input: the scene graph from A (medium), the role-aware ASCII grid, the start and goal, the solver's reachable cells,
the jump limits, and the image. Output: edits in the fixed vocabulary
`snap_to_surface | orient | straighten | merge | close_gap | move_goal_to_ground | clear_spawn | nudge | reclassify`.
Edits are applied by `builder.py` and re-solved. Re-application without new calls: `rescore_b.py`, output in
`results/probe_b_rescored.json`.

| Scene, effort | Solvable before → after | Edits | Matches expected repairs? |
|---|---|---|---|
| floating_spikes, medium | no → **yes** | 2: goal onto G2, snap spikes onto ledge (dy=+1) | All of them. Explicitly left the ceiling spikes, monster, ground spikes and the jumpable 5-cell gap alone |
| wobbly_cave, medium | no → **yes** | 5: spawn moved off the roof, 1-cell hole closed, goal floor nudged 2 left (pit 8 → 6), goal grounded, wall nudged **up** 2 | 4 of 6. Did not straighten the wavy floor ("keep their bumpy shape"), and the 1-cell bumps stay. Lifting the wall into a floating pillar changes the drawing; lowering it by 2 would preserve intent. A 6-cell pit sits exactly at the limit, which is too tight for kids |
| tower_key, medium | no → **yes** (key reachable with the door closed, door blocks the goal) | 6: wall reclassified as door (from "key opens door"), top ledge and **all 3 fragments** nudged down 1, door moved with it, goal grounded | All of them |
| tower_key, high | no → **yes** | 6: same idea plus 2 spike "snaps"; **forgot the 2 ledge fragments**, leaving a 1-cell step | Worse than medium at 2.4x the latency. With an ambiguous `snap_to_surface`, the first applier put 2 of 6 edits on the wrong face, moving spikes under a ledge and down a wall. Fixed by having the applier choose the face from the node's `points` |
| paper_synth_1, medium | yes → yes | 4: both floating ledges (4-5 rows up, unreachable) dropped 2-3 rows, coins moved with them | Reasonable, but it touches what the child drew. The "moves" arrow intent is outside the repair vocabulary (v1 behaviors handle it) |

- A v1 bug exposed: the default start ("top of the leftmost solid column") puts the player **on the roof** of any cave
  level (wobbly_cave start = (1,1)). The model noticed and moved it; deterministic code should not need the model for this.
- Every edit carried a one-line reason fit for a child ("The green goal was floating in the sky where nobody can reach it...").
- Without vocabulary support, the model coordinated dependent moves itself in the medium plans: the door, goal and
  2 fragments moved with the tower ledge, and the coins moved with the paper ledges. The miss was at high effort,
  where the ledge fragments were left behind. In the cave the goal component stayed put when its floor moved; the
  model fixed that with a separate `move_goal_to_ground`.

## Probe C: designer enhancement ("challenging but fair")

Input: each repaired level from B (medium). Output: 3-6 additions from
`add_coin_trail | add_enemy | make_crumble | add_checkpoint | add_spike_strip | add_bounce_pad`.

| Scene | Valid placements | Solvable after | Taste |
|---|---|---|---|
| floating_spikes | 6/6 | yes | Good: coin arcs over the pit and over the child's spikes, checkpoint after the pit, walkers on both long flats, the optional spike ledge made crumbly. Difficulty "easy → medium" |
| tower_key | 6/6 | yes | Mostly good: short spike strip right after the start, coin trails marking each climb, enemy on the top walkway before the door. The bounce pad from the ground to the top walkway **skips the whole climb**, which weakens the challenge |
| wobbly_cave | 4/6 (1 of the 4 then broke solvability) | **no** | Coins and checkpoint fine. One enemy was placed on a bump (invalid), and one patrol ran off its surface. The spike strip was placed under the raised wall, so the player can no longer jump it with the head clearance left: **unsolvable**. B's "left the bumps" choice made C's placements fail downstream |

Coin trails were 100% valid (5 trails, 23/23 coins in empty cells and within jump reach). Every failure came from local geometry:
bumps and low ceilings. Rule: **every suggestion is re-solved; reject the ones that break solvability or fail
placement, and show the child the survivors as optional, undoable suggestions.**

## Probe D: prompt-to-level

Output is a `LevelSkeleton`: sections, solid and hazard rects, moving platforms, enemies, coins, checkpoints,
key and door, start and goal. It is rasterised and checked 3 ways: goal reachable with the door open, key reachable
with the door closed, and goal unreachable with the door closed.

| Prompt | Effort | Solvable | Key/door logic | Coins reachable | Enemies on a surface | Notes |
|---|---|---|---|---|---|---|
| lava cave, key opens exit, medium | medium | yes | key reachable, door gates the goal | 7/8 | 2/2 | lava pits 5 wide, vertical lift, full-height wall with the door at its base |
| same | low | yes | key reachable, door gates the goal | 8/8 | 3/3 | 3 lava pits 4 wide, staircase to the key, guard on the key ledge; 11 s vs 29 s at medium |
| easy first level, small gaps | medium | yes | n/a | 17/17 | 1/1 | three 3-wide gaps, the last one with spikes: a clean teaching ramp |
| hard spike gauntlet, moving platforms, bottomless pit | medium | yes* | n/a | 11/11 | 3/3 | 32-cell pit crossed on 3 moving platforms. *The solver treats moving platforms as static along their whole path, so timing is not checked |
| tower climb, walking enemies, medium | medium | yes | n/a | 16/16 | 7/7 | 6 tiers each 3 rows apart (exactly the max), 7 walkers, a 7-cell lift |

**Solvable rate: 5/5. Key logic correct: 2/2.** The model respects the stated physics but designs right at the
limits (3-row steps, 6-cell gaps). "Medium" and "hard" come mostly from enemy count and moving platforms, which are
exactly what the solver cannot check. Every skeleton fit one 48x27 screen. The v1 solver clamps the player to
`GAME_W`/`GAME_H` (`physicsSim.ts:314,360`), so **scrolling levels need solver changes before prompt-to-level can target them**.

## Latency, tokens and cost

All calls used `claude-opus-5` at $5 per million input tokens and $25 per million output tokens; thinking tokens
are billed as output. Some A, B and C calls ran 3-4 at a time, so latencies are slightly pessimistic.
n is small (1-4 per cell); treat p90 as indicative.

| Probe | Effort | n | p50 s | p90 s | in tok | out tok | $/call |
|---|---|---|---|---|---|---|---|
| A perception | low | 4 | 11.8 | 15.2 | 3,994 | 1,158 | 0.049 |
| A perception | medium | 4 | 15.8 | 23.0 | 3,994 | 1,435 | 0.056 |
| A perception | high | 2 | 25.9 | 28.5 | 4,036 | 2,214 | 0.076 |
| B repair | medium | 4 | 24.6 | 37.8 | 5,508 | 2,008 | 0.078 |
| B repair | high | 1 | 58.4 | 58.4 | 5,899 | 4,383 | 0.139 |
| C enhance | medium | 3 | 28.8 | 33.8 | 4,148 | 2,019 | 0.071 |
| D prompt→level | low | 1 | 11.4 | 11.4 | 2,432 | 940 | 0.036 |
| D prompt→level | medium | 4 | 29.2 | 32.6 | 2,432 | 1,941 | 0.061 |
| v1 interpret (as shipped, default effort) | high | 1 | 10.9 | 10.9 | 4,714 | 700 | 0.041 |

Input cost is almost entirely the image (about 1.6-1.8k tokens) plus the component JSON. Each system prompt is
under 1k tokens, which is likely below the minimum cacheable prefix, so prompt caching saves little here. Output and
thinking tokens dominate cost and latency, and they scale with effort: high roughly doubles medium's output for no
measured accuracy gain.

## API facts verified on this machine (SDK `anthropic` 1.13.0)

- `client.beta.messages.parse(..., output_format=PydanticModel, output_config={"effort": ...}, betas=["server-side-fallback-2026-07-01"], fallbacks="default")`
  was accepted in 23/23 calls. The SDK merges `output_format` into `output_config.format` together with `effort`.
- The non-beta `client.messages.parse` **has no `fallbacks` parameter** (signature inspected). v1's `interpret.py` uses it,
  so v1 has no refusal fallback. v2 should use the beta parse.
- No refusals occurred (0/24), so the fallback path itself was not exercised. All stop reasons were `end_turn`.
  Code must still branch on `stop_reason == "refusal"`, and on `usage.iterations` for `fallback_message`, before trusting
  `parsed_output`. The probe wrapper (`common.py`) records both.
- Streaming was not measured. `parse()` returns only when the response is complete. For progress UI, use
  `client.messages.stream(..., output_format=...)` (the SDK's streaming structured-output helper) or show staged progress per call.

## Failure modes seen

1. **Physics judged from pixels is unreliable.** Gap feasibility was wrong 3/3 times without solver facts and right
   every time with them. Fix: always feed solver output; never ask the model to decide reachability.
2. **Loosely typed parameters let the model skip required fields.** v1's `Binding.params: dict[str, float|int]`
   lets the model drop `opens_component_id`, and then compile silently turns the key into a coin. Fix: one typed
   variant per op (discriminated union) so structured outputs enforce the required fields.
3. **Ambiguous edit semantics.** `snap_to_surface` without a face parameter was applied to the wrong face in 2 of
   6 high-effort edits. Fix: put `face` (top, bottom, left, right) in the op, or derive it from the node's `points` (now done in `builder.py`).
4. **Invented ids** (1 of 10 perception calls, confidence 0.1). Fix: drop unknown ids in code.
5. **Fragmented components.** A goal star drawn over a ledge split it into 3 components (a CV artifact). The model
   groups them correctly with `part_of`, but repair must move groups, not single components. Fix: edits act on `part_of` groups.
6. **Rendering intent drift.** Lifting a wall to make a "duck under" passage, or bounce-pad shortcuts that skip a
   climb. These are legal but change the drawing. Fix: prefer edits whose total cell displacement is smallest; show
   before/after; every edit undoable.
7. **Downstream coupling.** C's enemies failed on bumps that B chose to keep. Fix: deterministic cleanup
   (straighten lines within ±1 row, close 1-cell holes) runs **before** any model stage and does not depend on the model.
8. **Effort is not monotonic.** High was never more accurate than medium, and once worse (forgot fragments),
   at 1.4-2.4x the latency.

## Model vs deterministic code (recommendation for v2)

| Task | Owner | Why (evidence) |
|---|---|---|
| Ink segmentation, components, grid, cells | Code (v1 CV) | already reliable on the fixtures; the model never sees pixels as coordinates |
| Role per component (geometry vs text/arrow/decoration, enemy, key, door, goal) | **Model, low effort** | 95% role accuracy at low, 0 geometry wrongly dropped; replaces v1's "letters are annotations" and has a decoration concept v1 lacks |
| Relations: rests_on, attached_to, points, part_of | **Model** (same call) | 75/76 correct; this is the "what did the child mean" part |
| Snap, orient, group-move, ground the goal, place the spawn, close 1-cell holes, straighten ±1-row wobble | **Code**, driven by the relations | pure geometry once relations are known; the model's own coordinates are off by 1 |
| Reachability, jump feasibility, softlocks, key/door gating | **Code (solver)** | the model got it wrong 3/3 times without solver facts |
| Which fix best preserves intent when several work (lower this ledge or raise that one; is this bar a door) | **Model, medium**, given the solver's facts | door-from-text inference, minimal plans in 4/4 cases |
| Kid-facing explanation of each edit | Model (same call as the edit) | every edit came with a usable sentence |
| "Make it challenging but fair" suggestions | **Model, medium, async** (after the first playable build), each one re-solved and optional | good taste; 2/18 misplaced and 1 that broke a level, all caught by validation |
| Prompt → level skeleton | **Model** at low or medium, then code rasterises, solves, and retries once on failure | 5/5 solvable; low effort was as good and 2.6x faster |
| Moving-platform timing, enemy contact, fairness under timing | **Code (solver upgrade needed)** | v1 solver ignores both, so "solvable" overstates fairness for hard levels |

**Latency budget implied:** first playable build = CV (under 1 s) + perception at low effort (about 12 s p50)
+ deterministic repair + solve (under 0.1 s). That is about 13 s, which fits the "play in about 15 s" goal. The model
repair-planner (about 25 s) and designer (about 29 s) should run **after** the child is already playing, as
"Suggested fixes / Make it harder" cards with diff previews.

## Caveats

- Ground truth is synthetic: 3 clean Pillow canvases and 1 synthetic paper photo, with the 8 px brush imitated by a
  stroked handwriting font. Real children's drawings are messier. Treat the accuracy numbers as an upper bound for
  clean inputs, not a field result.
- Sample sizes are tiny (24 calls total). Latency percentiles come from 1-4 samples per cell.
- Probe B and C judgments of intent preservation are mine, written against the per-scene `expected_repairs` in `gt.json`.
  Solvability and placement checks are mechanical.
- `builder.py` is a probe-grade stand-in for a v2 edit engine: tiles only, enemies and coins are not simulated, and crumble is not modeled.
