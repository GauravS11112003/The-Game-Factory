# draw-a-level v2: "Player First" design

Status: complete v2 design proposal, 2026-10-10. It replaces PLAN.md for v2 and keeps its stack: FastAPI + OpenCV + Claude Python SDK + Vite/TS/Phaser 3 + SQLite.

Evidence is cited as **[B]** build diagnosis (`docs/v2/diagnosis/build.md`, failures F1-F17), **[G]** gameplay diagnosis (`gameplay.md`, sections and R1-R8), **[V]** visual/UX diagnosis (`visual.md`) and **[M]** live model probe (`model.md`, Probes A-D). File:line references are to v1 at commit `1db31c9`.

---

## 0. Thesis, the experience, and the quality bar

### 0.1 The one idea

**One object model, one physics.**

- A drawing becomes a **scene graph of typed ink objects**. Examples: "spike strip resting on platform o4, pointing up", "monster o9 with eyes o10 and o11", "flag o14 whose pole is scenery".
- That single graph does four jobs at once:
  1. It is the art the renderer draws.
  2. It is the collision the player stands on.
  3. It is the unit every repair and design edit acts on, explains, and can undo.
  4. It is what the playtest bot plays.
- One deterministic TypeScript physics core runs the game, the playtest bot, the designer's validation, and the leaderboard replay check. So a level ships only after a frame-exact playtester has finished it and measured how hard it is.
- The model is used only where it was measured to be good:
  - naming objects and their relations: 95-97% role accuracy and 75/76 relations correct [M Probe A];
  - choosing among small, pre-validated edits and explaining each choice to a child [M Probes B, C].
- The model never judges physics. Without solver facts it was wrong 3 of 3 times [M]. It never emits coordinates and never writes code. It only picks ids from menus that deterministic code built and already validated.

Why this fixes what the owner complained about:

| Complaint | Measured cause | What v2 changes at the root |
|---|---|---|
| "How it's built after I draw is extremely poor quality" | v1 turns pixels into cells before anything understands objects [B synthesis 1-5]. The flag pole became a wall in 6 of 6 drawings, the tree canopy became the goal, spikes became 2-row blocks, taps were dropped, and lines became staircases. 5 of 6 levels were unbeatable. | The pipeline goes from ink to objects to fitted geometry. Art and collision are both derived from the same fitted shapes. A server-side bot confirms every build. |
| "Placed on the board without any thought" | The model is told its "only job" is to read words (`prompt.py:26`). There is no repair stage and no solver on the server (`compile.py:638`). | A designer "mind": perception, then intent-preserving repair, then measured enhancement. Every edit is explained and can be undone. |
| "The game itself feels too easy" | No momentum, 35-39 of 40 hold lengths work, E[deaths] 0.000-0.004, one 5-second screen, nothing at stake [G §2-4]. | Momentum physics with a run skill, real threats, long levels with a camera, stakes and rewards, and a dial that targets a **measured** difficulty band. |

### 0.2 The experience in 60 seconds (north star)

1. **Draw.**
   - On the canvas, a faint chip appears next to each stroke as you draw: "ground", "spikes ↑", "coin".
   - A soft green halo shows where the player can reach.
   - A red dashed line marks any gap that needs a run-up ("too far to walk-jump").
2. **Press ▶.**
   - The level is playable in under 0.3 s, offline, in your ink, with your character.
   - Press ✎ to go back to drawing. This is the Mario Maker edit-and-play loop.
3. **Press "Make it a level!"**
   - **About 2 s:** the cleaned "ink build" is playable.
   - **About 10-14 s:** a banner says "I understood your drawing". The tree softens and stops blocking you, the flag pole turns into scenery, and the spikes click onto their ledge. Each change appears as a card you can undo.
   - **About 20 s:** a banner says "Polished".
     - A pencil checkpoint flag sketches itself in.
     - A coin arc appears over the scary jump.
     - Three big ink stars appear in risky spots.
     - The difficulty readout says "Easy · about 1 fall in 5 tries · bot time 0:31".
4. **Slide the dial to "Challenging".**
   - The level tightens immediately using the deterministic designer.
   - The model's picks then arrive as upgraded cards.
5. **Play.**
   - The game has momentum, stomps, squash and stretch, dust, synthesized sound, and a timer.
   - A results card shows four stamps, your time against the creator's, and your personal best.
6. **Publish and share** a "Beat my time" link. A friend's run plays against your ghost.

### 0.3 Quality bar (numbers that define "phenomenal")

| Metric | v1 measured | v2 target |
|---|---|---|
| Golden kid drawings beatable after build | 1/6 [B scoreboard] | 100% after Faithful; 100% after Polished and Challenging |
| Flag pole built as a wall | 6/6 [B F1] | 0 |
| One-cell bumps on drawn flat surfaces | 3-13 per level [B] | 0 |
| Drawn line top vs. standing surface | mean 5-14 px; ≥4 px off on 56-96% of surfaces [B F13] | ≤1 px on 100% of terrain surfaces (top-edge alignment, §D.3) |
| Brush taps becoming coins | 0/5 [B F7] | 100% |
| Handwriting becoming terrain with the model off | yes, "jump!" became a wall [B F3] | 0 colliding cells from text/arrows on golden G4 with the model off |
| Starter World casual difficulty C | 0.000 / 0.004 / 0.000 [G §3] | 0.1 / 0.3 / 0.6 / 1.0 (±25%), plus a Hard bonus level |
| Takeoff window of the hardest required jump | 16-44 frames in every starter [G] | Level 1 ≥12 frames; Level 4 6-10 frames; never <4 frames (fairness) |
| Time to playable | about 5 s round trip [V] | Canvas ▶: <0.3 s, local. Ink build: ≤2 s (canvas) / ≤4 s (paper) p50, ≤8 s p95. Understood: ≤15 s p50. Polished: ≤25 s p90 |
| Render | 1.74x nearest-neighbour stretch at DPR 2 [V] | Native resolution up to 2x DPR, linear filtering; 60 fps on a mid phone with 4 screens |
| Engine crash on a degenerate entity | yes, `MovingPlatform.ts:58` recursion [V] | 0. Validator plus a per-entity guard. Publishing is blocked if the build fails |
| Model cost | about $0.04/scan, but silently broken [M] | ≤$0.12 per 1-screen Polished scan; ≤$0.30 for a 4-screen Challenging build |

---

## A. The level-design mind

### A.1 Pipeline at a glance

```
CANVAS: editor vector strokes ──────────────┐
PAPER:  photo(s) ─► CV v2 (Python) ─────────┤
                                            ▼
                                     InkDoc (strokes + components + features)
                                            │
          ┌─────────────────────────────────┼───────────────────────────────────────┐
          ▼  (TS core, browser or worker)   │                                       ▼  (Python, async)
   heuristic perceive ─► G0 ─► auto-repair ─► fit+compile ─► bot      model PERCEIVE (effort low, per sheet)
          │                                                 │                       │
          ▼                                                 ▼                       ▼
   [1 INK build] playable at ~2 s                      report        merge ─► perception edits (set_role, merge_parts,
                                                                              snap, bind_behavior, link_key_door)
                                            ┌─────────────────────────────────────┘
                                            ▼
   [2 UNDERSTOOD] G1 = G0 + perception edits + kid edits ─► auto-repair ─► compile ─► bot (full metrics)
                                            │
                                            ▼
             candidates(G1, report, dial, target)  ── deterministic menu, every entry pre-applied and verified
                    │                                   │
                    ▼                                   ▼
        greedy designer (≤3 s, always)        model DESIGN pick (effort low; medium for Challenging rounds)
                    └──────────────┬────────────────────┘
                                   ▼
   [3 POLISHED] apply picks one by one ─► invariants + bot after each ─► report ─► cards
     (hard deadline 25 s from submit: if the model is late, ship the greedy result and show the model's picks
      later as optional "Designer suggestions")
```

**Division of labour: Python sees and talks; TypeScript builds and plays.**

- **Python** handles everything that needs pixels or the network:
  - photo rectification;
  - color classification and stroke extraction;
  - the annotated image;
  - model calls;
  - persistence and HTTP.
- **TypeScript** handles everything after strokes, in a package of pure TS with no DOM and no Phaser:
  - perception heuristics and merge;
  - geometry fitting;
  - compilation;
  - edits;
  - physics, bot, difficulty and designer;
  - replay verification.
- The TS code runs in two places:
  - **In the browser.** This gives the instant ▶ test-play, live hints, and instant undo toggles.
  - **In a persistent Node worker** that FastAPI drives over JSON-lines stdio. This gives authoritative server builds, publish verification, and run verification.
- Engine and solver can never disagree, because they are the same code. v1's solver had to copy Arcade's rules by hand (`physicsSim.ts` header).

| Stage | Input | Output | Runs in | Model | Budget (p50 / p90) |
|---|---|---|---|---|---|
| CV v2 | photo per sheet | InkDoc sheet | Python | no | 0.6 / 0.9 s per sheet |
| Ink build | InkDoc | level + report (fast) + "What I saw (quick look)". Auto-repairs, plus the cheapest deterministic unsolvable fix, so it is always beatable. | TS (browser for canvas, worker for paper) | no | 0.15 / 0.4 s per screen |
| Perceive | annotated image + component table + typed rules + library list | Perception | Python → Claude | effort low | 10 / 15 s (timeout 20 s) |
| Understood build | G0 + perception edits | level + full report | TS worker | no | 0.4 / 0.8 s |
| Candidates + greedy | level, report, dial | menu (≤40 entries) + greedy edits | TS worker | no | 1.2 / 3 s |
| Design pick | menu + compact graph + report (+ image for ≤2 sheets) | DesignPlan | Python → Claude | low (Polished), medium (Challenging) | 8 / 12 s (timeout 15 s) |
| Apply + verify | picks | final level + cards | TS worker | no | 0.5 / 1 s |

### A.2 Seeing: InkDoc

InkDoc is the only thing that crosses from "seeing" to "building". Schema: `shared/spec/ink.schema.json`.

```ts
interface InkStroke {
  id: string;                         // "s17"
  color: 'black' | 'red' | 'green' | 'blue' | 'pencil' | 'draft';  // pencil = designer ink, draft = prompt-to-level
  points: [number, number][];         // centreline, world px (CELL = 16 px), ≥2 points
  widths: number[];                   // per-point stroke width, world px
  closed: boolean;
  sheet: number;                      // 0-based sheet index (x offset = sheet_col*768, y offset = sheet_row*432)
  origin: 'kid' | 'parent' | 'designer' | 'library' | 'draft';
}
interface InkComponent {               // a connected blob of one colour: the unit the model labels
  id: number; color: InkStroke['color']; stroke_ids: string[];
  bbox_px: [number, number, number, number]; area_px: number;
  features: { fill_ratio: number; circularity: number; straightness: number; zigzag: number;
              aspect: number; holes: number | null; mean_width: number; is_dot: boolean };
}
interface InkDoc {
  world: { screens_x: 1|2|3|4|5|6; screens_y: 1|2; cell: 16 };
  strokes: InkStroke[]; components: InkComponent[];
  character?: { strokes: InkStroke[]; png_url: string };   // from the character box or the studio
  typed_rules?: { text: string; target_component?: number }[];   // editor rules can be pinned to a stroke
  sheets: { index: number; photo_url?: string; sketch_url?: string; qr?: string }[];
}
```

**Canvas mode.**
- The editor emits vector strokes directly: pointer samples resampled to 2 px, with width taken from `pointer.pressure`.
- Components are unions of same-colour strokes that touch (gap ≤ 0.5 × width). They are computed in TS with no image processing.
- The browser also renders the PNG the model will look at.

**Paper mode.** CV v2 lives in `vision/app/cv/`:
1. Reuse v1 rectify, calibrate and classify.
2. Build per-colour masks **without** the coverage dilation.
3. Skeletonize with `cv2.ximgproc.thinning`. This is available in the installed OpenCV 5.0.0 contrib build.
4. Turn the skeleton into a graph and split it into polylines at junctions. Prune spurs shorter than 0.4 cell.
5. Take widths from twice the distance transform along the skeleton.
6. Compute features: holes come from the contour hierarchy.

**Never drop ink [B F7].**
- Marks of 0.03 cell² or more are kept and become `is_dot` strokes.
- Blue dots become coin candidates whatever their size. An 8 px brush tap is about 0.2 cell².
- Marks smaller than 0.03 cell² are sensor noise. They are counted and shown as "N tiny specks ignored".

### A.3 Perception: scene graph

**Roles.** Schema: `shared/spec/scene-graph.schema.json`. "Collides" is the default and can be changed with `set_collision`.

| Role | Collides | Compiles to | Default behavior |
|---|---|---|---|
| `ground` | solid | fitted surface, filled solid down to the world bottom | static |
| `platform` | solid if thick or filled; **one-way** if a thin floating stroke | fitted surface, 1 tile thick | static |
| `wall` | solid | column of fitted width | static |
| `ceiling` | solid | fitted underside, filled up to the world top or to the stroke's top | static |
| `spikes` | hazard band | spike strip entity with host and facing | static |
| `lava` | hazard fill | lava region (pit fill) | animated |
| `saw` | hazard | saw entity | static unless bound to move |
| `enemy` | creature | enemy entity with the kid's sprite | **walker**, 2 c/s, ledge-aware, gravity |
| `coin` / `big_coin` | pickup | coin / big coin | — |
| `key` / `door` | pickup / solid until opened | key / door entities | key requires `opens` |
| `spring` | solid top | spring entity | up, strength 1.0 |
| `checkpoint` / `goal` | trigger | checkpoint / goal (pole parts become scenery) | — |
| `start_marker` | none | sets `player_start` | — |
| `text` / `arrow` | none | not built; feeds bindings | — |
| `decoration` | none | rendered softly in the level plane (§D.1) | — |
| `character` / `unknown` | none / solid* | — | *`unknown` black ink collides and gets an "Is this right?" chip |

**Relations on each object:**
- `rests_on` (host id);
- `attached_to` (host id plus face top/bottom/left/right);
- `points` (up/down/left/right/none);
- `part_of` (group root id);
- `refers_to` (for arrows and text: the object they describe).

**Heuristic perceiver** (`web/src/core/scene/heuristics.ts`). It is deterministic, works offline, and runs live in the editor. Rules are applied in order; each yields a role and a confidence:

1. **Goal flag** = a green blob of 0.3-6 cells² whose bbox touches the top third of a vertical stroke (height 2-7 cells, straightness ≥ 0.9, width ≤ 0.6 cell, any colour). The pole is set to `part_of` the flag. Conf 0.85.
   - With several flags, the **rightmost** is the goal and the others are `checkpoint`.
   - Fixes F1. It also replaces v1's "largest green component" rule (`pipeline.py:142`, [B F2]).
2. **Tree** = a green blob with one or more black near-vertical strokes touching its underside. All parts are decoration. Conf 0.75.
3. **Text** = 3 or more small components (each ≤ 2.5 × 2.5 cells) aligned on a baseline (y spread ≤ 0.8 cell, gaps ≤ 1.2 cell). Also a single component with `holes ≥ 1`, curvature-dense and ≤ 3 cells high, that does not touch any surface. Conf 0.6. This builds the PLAN's missing fallback [B F3].
4. **Arrow** = a straight stroke (straightness ≥ 0.92, length ≥ 1.5 cells) with two short strokes meeting one end at 20-70°. Set `points` to that end and `refers_to` to the nearest object within 2 cells of the tail side. Conf 0.7.
5. **Spikes** = red with `zigzag ≥ 3` direction reversals of amplitude ≥ 0.25 cell, **or** a red straight stroke within 1.5 cells of a surface and parallel to it. `attached_to` = the nearest surface within 2.5 cells, with face = the side facing the spikes. `points` is away from the host. Conf 0.8.
6. **Enemy** = a red closed blob (circularity ≥ 0.45, ≥ 1.2 × 1.2 cells). Ink of any colour inside its bbox becomes `part_of` it (eyes, mouth) [B F8]. `rests_on` = the surface within 3 cells below; if there is none, it is a flyer. Conf 0.7.
7. **Saw** = a red circle with ≥ 5 radial ticks. Conf 0.5.
8. **Coin** = a blue dot or blob ≤ 1.5 cells. **Key** = a blue blob with `holes ≥ 1` and aspect ≥ 1.8. **Big coin** = a blue star (5 convex peaks).
9. **Black terrain**, by fitted direction:
   - long and near-horizontal: `ground` if it is the lowest ink in its columns and within 6 rows of the bottom, otherwise `platform`;
   - near-vertical: `wall`;
   - near-horizontal with ink-free space below it and the player's reachable region beneath it: `ceiling`.
10. **Decoration** = black closed curves (circularity ≥ 0.6) with no flat top run ≥ 2 cells and no contact with terrain, or radial "sun" patterns. Conf 0.55.
11. **Start marker** = an isolated glyph "S" in the leftmost 8 columns. Model only; offline, it falls back to rule 3 (text).

**Model perceiver** (`vision/app/mind/perceive.py`, §A.8): one call per sheet, run in parallel.

**Merge** (`web/src/core/scene/merge.ts`). The model's answer is converted into **perception edits** relative to G0, so every change the model makes is visible and can be undone:
- Unknown or invented ids are dropped. [M] saw an invented id 17.
- If the model's role differs and (model conf ≥ 0.5 or heuristic conf < model conf), emit `set_role`.
- Relations are validated geometrically:
  - the `rests_on` host must lie within 3 cells along the face direction;
  - `part_of` targets must be within 2 cells.
  Failing relations are dropped and shown as "unsure" chips.
- Bindings are typed (§A.8). A binding with a missing required field (a key with no door) becomes an **Ask card**, never a silent downgrade [M: v1 turned a key into a coin].
- The keyword heuristic is used only when there is no model answer. It is never merged on top of one [B F10].
- Objects with confidence < 0.75 get an "Is this right?" chip with one-tap re-labels. In [M], 7.8% of correct labels fell below 0.75, and every meaningful error sat at 0.4-0.7.

### A.4 Geometry: strokes to shapes (deterministic, `web/src/core/build/fit.ts`)

**Terrain** (ground, platform, ceiling):
1. **Top envelope.** For each 1 px column, take the top of the ink (for ceilings, the bottom).
2. **Piecewise-linear fit.** Ramer-Douglas-Peucker with ε = 3 px, then merge segments whose slopes differ by less than 0.08.
3. **Classify each segment by |slope|:**
   - ≤ 0.12: flat. Horizontal at the median top y.
   - 0.12-0.75: slope 1:2 (26.6°).
   - 0.75-1.6: slope 1:1 (45°).
   - > 1.6: wall.
   This removes the staircases and bumps in [B F4] (drawing 6's 9-row ramp becomes one walkable 1:2 slope).
4. **Snap to the grid.** A flat top snaps to the nearest cell row boundary, `row = round(top_y/16)`, which shifts it by at most 8 px. Slopes snap to tile-aligned 1:1 or 1:2 runs. **Exactly one collision surface sits at the ink's top edge.** Thickness comes from the role, not from pixel coverage:
   - ground fills down to the world bottom;
   - floating platforms are one tile;
   - walls take their fitted width rounded to ≥1 cell.
5. **Auto close_gap.** Collinear surfaces whose ink gap is ≤ 10 px and whose rows differ by ≤ 1 are joined.
6. **Collision mode for floating platforms:**
   - **one-way** when mean stroke width ≤ 0.75 cell and there is no ink below;
   - **solid** when filled (`fill_ratio` ≥ 0.4) or when it has a wall attached.
   One-way platforms remove the head-bonk failure in owner draft `d_b14b143e` [G §3.1].

**Entities:**
- **Spikes** are a strip entity: `{host, face, x0..x1 or y0..y1}` along the host face.
  - Hitbox: a 6 px band from the face, inset 2 px at both strip ends.
  - Art: about 9 px.
  - Never a tile. Never overwrites a host cell [B F5, F6].
- **Enemies.** The sprite comes from the object mask (all parts). Its bottom snaps to the host surface top [B F9]. Patrol bounds are the host surface extents.
- **Coins** sit at the blob centre. **Keys and checkpoints** are grounded onto the host. **Goal** = the pole base cell on its host surface, or the flag centre grounded within 6 cells [B F1].
- **Start:**
  1. the lowest standable cell under or next to the `start_marker`, if present;
  2. otherwise, the lowest standable cell in the leftmost 8 columns with ≥3 free rows above. This never puts the player on a cave roof, as v1 did in [M] wobbly_cave start (1,1).
  3. `clear_spawn` then guarantees no hazard within 2 cells and no enemy patrol within 4 cells [B F11].

**Compiled tile alphabet** (`compiled.tiles.rows`):

| Char | Meaning |
|---|---|
| `.` | empty |
| `#` | solid |
| `=` | one-way |
| `/` `\` | 45° slopes rising right / left |
| `a` `b` | 1:2 slope rising right, low half / high half |
| `c` `d` | 1:2 slope rising left, high half / low half |
| `~` | lava fill (hazard; top hitbox 4 px below the art) |
| `X` | legacy full-cell hazard, only for migrated v1 levels |

Everything that moves or changes is an entity, never a tile.

### A.5 The fixed edit vocabulary

**Rules for every edit:**
- It addresses **object ids** (`o12`). It never addresses free coordinates.
- Placement cells for added content come only from slots that the candidate generator computed.
- Edits are applied by `web/src/core/design/apply.ts`.
- After **every** edit, the invariants and the bot are re-checked.
- An edit that breaks anything is rejected and logged with its reason. It is not shown as a card.

Edit ids are stable: `${op}:${target}:${short-hash(params)}`. When the build is recomputed, an undone edit stays undone.

**Repair (class R): allowed in every dial position.**

| Op | Parameters and bounds | Proposed by | Applied when |
|---|---|---|---|
| `set_role` | target, role ∈ Role | perception merge, kid chip | Never turns the start's support surface into a moving or non-colliding role unless another standable surface lies within 3 cells. This fixes the v1 zero-length "moving ground" crash [V]. |
| `merge_parts` | target, parts[] (each ≤ 2 cells away) | heuristic, model | Parts move and animate with the target and share its collision mode. Eyes go with the monster [B F8]. |
| `straighten` | target, mode flat/slope_1_2/slope_1_1, max_shift_px ≤ 8 | auto | Every fitted surface. Shown as one grouped card. |
| `close_gap` | a, b, ink gap ≤ 10 px, Δrow ≤ 1 | auto | Accidental near-touches |
| `snap_to_surface` | target, host, face top/bottom/left/right, distance ≤ 3 cells | auto from relations | Spikes, enemies (non-flyer), goal, key, checkpoint, spring, door. The face is explicit; the applier never guesses it [M rescore_b]. |
| `orient` | target, facing up/down/left/right | auto (away from host) | Spikes, springs |
| `form_goal` | flag, pole? | auto | Pole → scenery part; goal at the pole base [B F1] |
| `ground_object` | target, max_drop ≤ 6 cells | auto | Goal, walker enemies, key, checkpoint |
| `place_start` | — (computed) | auto | §A.4 |
| `clear_spawn` | hazard radius 2, enemy radius 4 | auto | Moves the start ≤ 4 cells, otherwise trims the enemy patrol |
| `set_collision` | target, solid / one_way / none | auto, kid | Thin floating platform → one_way; decoration / text / arrow → none |
| `fix_behavior` | target, param, value | auto | A degenerate move path is fitted to the available room (≥ 2 cells), otherwise the behavior is dropped and a card says so |
| `link_key_door` | key, door | model, kid, Ask card | — |
| `nudge` | target **group**, dx ∈ [-3, 3], dy ∈ [-3, 3], abs(dx)+abs(dy) ≤ 3; per level Σ ≤ 6 cells | candidate menu | Only to fix *unsolvable* or *unfair*. The whole `part_of` group moves together [M fragments]. |
| `resize_surface` | target, end left/right, delta ∈ [-2, +3] cells | candidate menu | Extend a landing, or pull an overhang back to stop head-bonks |
| `add_spring` | slot, strength 0.6-1.2 | candidate menu | Only to escape a softlock or reach an otherwise unreachable drawn goal. Rejected if the route then skips a drawn setpiece [M Probe C bounce pad]. |

**Polish (class P): allowed in Polished and Challenging.**

| Op | Parameters and bounds | Purpose |
|---|---|---|
| `add_checkpoint` | slot: flat ground ≥ 3 cells wide, ≥ 3 cells from hazards | Bring every segment to F_s ≤ 30 s and T_s ≤ 40 s |
| `add_coin_trail` | route action i, count 3-7 placed on the bot's arc | Guide blind or risky jumps. At most one trail per required jump. |
| `add_coin` | slot | Rewards; at most 10 coins per screen in total |
| `add_big_coin` | slot from the risk-spot list | At most 3 per level. Must be optional and returnable, with detour p_death ≥ 0.1. |
| `add_hint_arrow` | slot, direction | Pencil arrow for blind drops or hidden routes; at most 1 per screen |
| `set_param` | entity, param, value inside the behavior's bounds (§B.5, §B.6) | Never overrides `pinned` params from the kid's text [G §9 invariant 4] |
| `set_par_time` | seconds = ceil to 0.5 s of (1.3 × bot fastest) | Auto |

**Challenge (class C): allowed in Challenging only.**

| Op | Parameters and bounds | Guard |
|---|---|---|
| `widen_gap` | gap (surface pair), +1 or +2 cells | Implemented as a nudge or resize of the landing group. Must stay within the run-up envelope the bot measures for the available runway. |
| `shrink_landing` | surface, -1 or -2, minimum width 2 cells | — |
| `raise_platform` | surface group, dy ±1 (±2 in the Hard band) | — |
| `add_spikes` | host surface, span 1-6 cells, face | Only on **undrawn** stretches (no kid ink within 1 cell). At least 3 cells from start and checkpoints. |
| `add_enemy` | archetype (walker or hopper for Normal; also flyer, shooter, chaser for Hard), slot, params | Flat empty stretch ≥ 8 cells for walkers. At least 6 cells from start and checkpoints. |
| `add_hazard` | saw / firebar / lava, slot | Empty space with ≥ 1 cell clearance from kid ink |
| `make_crumble` | surface ≤ 5 cells wide | Never the start, checkpoint or goal surface |
| `set_timer` | 1.5-2.0 × bot fastest | Only when the creator turns on "Timer pressure" |
| `reprise` (macro) | setpiece ref, target slot, escalation ∈ {faster, plus_saw, plus_spikes, narrower} | Levels with ≥ 3 screens. Expands to class C and P atoms sharing a `group` id, shown as one card. |

**Intent cost** (used for ordering and budgets):

```
cost = Σ_moved_objects cells_moved × w_role
     + 2.0 × [role change on a kid object]
     + 1.5 × [collision change on a kid object]
     + 3.0 × [topology change: opens a passage under or through a kid wall, or closes a kid gap > 1 cell]
     + 0.5 × [added pickup or checkpoint] + 1.0 × [added hazard or enemy]

w_role: ground 2.0, wall 1.5, hazard 1.5, enemy 1.5, goal 2.0, platform 1.0, coin 0.3
```

The topology term is what stops a fix like "lift the wall into a floating pillar" [M Probe B wobbly_cave] from beating "lower the wall by 2".

**Intent invariants.** These are checked after every edit. The first six come from [G §9]; the seventh is new.
1. Every kid object survives with its role. Role changes come only from perception or the kid, and are shown.
2. Drift: at most ±1 cell for P/C geometry edits in Polished, ±2 in Challenging. Repairs may move up to 3 cells, only to fix unsolvable or unfair spots.
3. The ordered route through drawn setpieces is kept. The bot's route must visit the drawn surfaces it used before, in the same order (checked as an ordered subsequence of standing nodes).
4. Text-pinned parameters never change.
5. Added content is drawn in designer pencil (§D.1), listed as a card, and can be undone.
6. The level is solvable and passes every fairness flag (§B.8).
7. **Respect ratio.** Added non-coin objects ≤ 50% of the kid's object count, and at most 1 per screen in Polished or 3 per screen in Challenging. The designer never draws more than the child did.

**Edit record** (`shared/spec/edits.schema.json`):

```ts
interface EditRecord {
  id: string; op: EditOp;                    // EditOp: discriminated union of the tables above
  class: 'repair' | 'polish' | 'challenge';
  by: 'auto' | 'model' | 'greedy' | 'kid';
  stage: 'ink' | 'understood' | 'polished' | 'challenging' | 'manual';
  reason_key: string;                        // shared/spec/messages.json key, e.g. "repair.goal.pole_scenery"
  reason_text: string;                       // ≤ 90 chars, kid-facing (template, or model-written for model picks)
  depends_on: string[];                      // undoing a parent greys out its children
  status: 'applied' | 'undone' | 'rejected' | 'suggested';
  validation: { solvable: boolean; flags: string[]; drift_cells: number; dC: number | null; reject_reason?: string };
  ghost: { before: Rect[]; after: Rect[] };  // world px, for the preview overlay
  group?: string;                            // macro/grouped cards
}
```

**Build function** (pure and deterministic, about 0.3 s per screen):

```
G1 = apply(G0, perceptionEdits ∪ kidEdits)
A  = autoRepair(G1) minus undone ids       // recomputed every time, stable ids
G2 = apply(G1, A)
D  = stored design edits, re-validated against G2; any that fail become 'rejected' with a reason
level = compile(apply(G2, D accepted))
report = bot.analyze(level)
if !report.solvable and repairUnsolvable:   // Ink and Understood stages: the child always gets a beatable level
   U = cheapest 'unsolvable' candidate chain from greedy (repair class only, ≤ 3 edits, by:'greedy')
   level, report = rebuild with U          // shown as cards like any other edit; the model may later pick an alternative
```

### A.6 Designer-grade playtesting (the bot)

The bot (`web/src/core/bot/`) is the solver upgraded to play like a careful designer. It shares the engine's physics module (§B.2). It returns a `PlaytestReport`:

```ts
interface PlaytestReport {
  solvable: boolean; reason?: 'no_start' | 'no_goal' | 'goal_unreachable' | 'key_unreachable';
  frontier?: { reached: Cell[]; blocking: { from: Cell; to_object: string; need: string; have: string } };
  route: RouteStep[];               // min expected-deaths route; each step: action, takeoff px range, windows, lethality
  segments: { from: string; to: string; E: number; T_ms: number; F_s: number; actions: number }[];
  C: number; F: number; score: number; band: 'trivial' | 'easy' | 'normal' | 'hard' | 'expert';
  fastest_ms: number; par_ms: number; casual_clear_s: number;
  flags: Flag[]; reachable: string[];
  risk_spots: Cell[]; coin_slots: Cell[]; checkpoint_slots: Cell[]; hazard_slots: Slot[]; enemy_slots: Slot[];
}
```

| Flag | Detects | Fixed by (candidates) |
|---|---|---|
| `unsolvable` | goal or key unreachable. `frontier` names the blocking jump ("needs 7 cells, run-jump does 9 with 6 cells of runway; you have 3") | nudge, resize_surface, set_collision one_way, add_spring |
| `tight_window` | any required window < 4 frames (casual) | nudge, resize_surface, set_param |
| `blind_jump` | landing not on camera at takeoff under the §C.2 camera rule | add_coin_trail, add_hint_arrow, nudge |
| `leap_of_faith` | a drop whose landing is below the view | add_hint_arrow, add_coin_trail |
| `head_bonk` | a route jump hits a ceiling before its apex and loses ≥ 1 cell of reach | set_collision one_way, resize_surface |
| `softlock` | a reachable region with no path to the goal and no lethal exit | add_spring, nudge. The HUD restart button always exists. |
| `missing_checkpoint` | segment F_s > 30 s or T_s > 40 s | add_checkpoint |
| `spawn_unsafe` | hazard ≤ 2 cells from start or a checkpoint, or enemy patrol ≤ 4 cells | clear_spawn |
| `skippable_setpiece` | a drawn hazard or enemy that the route never comes near ("your spikes don't matter", the `d_79eff85e` 41-cell slab [G §3.1]) | Polished: info card. Challenging: shrink_landing, raise_platform, add_spikes near it. |
| `trivial` | C < 0.05 | Polished: set_param toward C ≥ 0.1 |
| `unreachable_pickup` | a coin, big coin or key that cannot be reached | nudge (coin), info |
| `long_flat` | ≥ 16 cells with no required action | Challenging: add_enemy, add_hazard |

### A.7 The designer and the dial

| Dial | Classes allowed | Target | Edit budget (excluding auto-repairs) | Model effort |
|---|---|---|---|---|
| **Faithful** | R | Solvable plus all fairness flags. Difficulty is whatever was drawn. | ≤ 5 choice repairs | low |
| **Polished** (default) | R + P | C ≥ max(drawn C, 0.1), raised by `set_param` only up to the Easy band (C ≤ 0.3). Never lowers drawn difficulty except to fix a fairness flag. If drawn C > 3 (Expert), offer optional "gentler" cards. | + ≤ 2 P edits per screen (coins are separate), ≤ 4 `set_param` | low |
| **Challenging · Normal** | R + P + C | C ∈ [0.3, 1.0], sawtooth across segments | + ≤ 4 C edits per screen; respect ratio | medium, ≤ 2 rounds |
| **Challenging · Hard** | R + P + C | C ∈ [1.0, 3.0] | same | medium, ≤ 2 rounds |

**Sawtooth target.** For segment k of n:

```
target_k = lo + (hi - lo) × (0.4 + 0.6 × k / max(1, n-1))
```

Difficulty rises inside the level and falls back after each checkpoint [G §5 principle 2].

**Candidate generator** (`core/design/candidates.ts`). For each flag and dial goal it enumerates options. Each candidate is applied in a sandbox, checked against the invariants, then:
- fast-verified (reachability plus route, ≤ 20 ms per affected segment);
- for the top 12 only, fully measured (ΔC, ΔF).

It returns ≤ 40 entries. Each entry carries its `cid`, the edit, a human summary, drift, intent cost, the metric deltas, `fixes: flag ids`, and an `alts` group (mutually exclusive alternatives for one issue).

For `unsolvable`, it tries in order, keeping the cheapest 3 that work:
1. the 2 nearest objects on the frontier-to-target line, with dx, dy ∈ [-3..3];
2. `resize_surface` on the landing or the overhang;
3. `set_collision` one_way on the bonking ceiling;
4. `add_spring` as a last resort.

**Greedy designer** (`core/design/greedy.ts`). This is the deterministic fallback and also the instant dial response.

```
loop until target met or budget spent or no candidate improves:
  score(c) = progress_toward_target(c) / max(0.25, intent_cost(c))   − 0.5 × [same op type used ≥ 3 times]
  apply best; re-analyze affected segments
```

A ≤ 3 s cap is enforced with a 3-thread `worker_threads` pool for candidate verification.

**Model design pick.** The model receives the menu, never the geometry. It returns:
- an ordered list of picks, at most 1 per `alts` group, each with a reason (≤ 12 words, written for a 7-year-old);
- Ask cards for meaning-changing ambiguities, such as "Is this black bar a door?";
- a one-line level summary and a title suggestion.

Code then applies the picks in order. Each pick re-runs the invariants and the bot, and any pick that fails is rejected with its reason logged.

In Challenging, if the band is not yet reached, the model gets the new report and a fresh menu (round 2). After 2 rounds, greedy finishes the job.

### A.8 Model calls: responsibilities, schemas, parameters

| Call | When | Inputs | Output schema | Effort | max_tokens | Timeout |
|---|---|---|---|---|---|---|
| `perceive` | every build, per sheet in parallel | annotated sheet image (1500 px wide, magenta ids, cell rulers, **taps included**: v1 removed them before the model looked [B F17]), component table, typed rules with optional target ids, library names, parent objects (remix) | `Perception` | low | 6000 | 20 s |
| `design` | after Understood; on dial change | compact graph, intent, report summary, menu ≤ 40, dial, target, budget, image for ≤ 2 sheets at 1024 px | `DesignPlan` | low (Polished, Faithful repairs); medium (Challenging) | 5000 | 15 s |
| `skeleton` | prompt-to-level | prompt, screens, game rules summary, setpiece catalogue | `Skeleton` | low | 6000 | 20 s |
| `creature` | library studio "what does it do?" text | name, sentence, creature image (≤ 512 px) | `CreatureSpec` | low | 2000 | 10 s |

**Wrapper** (`vision/app/mind/client.py`). It extends the probe-validated pattern in `docs/v2/diagnosis/model/common.py`:

```python
resp = client.beta.messages.parse(                      # sync client run in a worker thread (probe-validated);
    model="claude-opus-5",                              # switch to AsyncAnthropic only if Phase 0 confirms
    max_tokens=MAX_TOKENS[call],                        # beta.messages.parse exists on it in SDK 1.13.0
    system=[{"type": "text", "text": SYSTEM[call], "cache_control": {"type": "ephemeral"}}],  # ≥512 tok cacheable on Opus 5
    thinking={"type": "adaptive"},                      # on by default on Opus 5; explicit for clarity
    output_config={"effort": EFFORT[call]},
    betas=["server-side-fallback-2026-07-01"],
    fallbacks="default",
    messages=[{"role": "user", "content": content}],
    output_format=SCHEMA[call],
)
# Client: anthropic.Anthropic().with_options(timeout=TIMEOUT[call], max_retries=0)
# A result is None when:
#   - stop_reason is "refusal" (log stop_details.category) or "max_tokens";
#   - parsed_output is None;
#   - the call raises APIError or ValidationError.
# fallback_used = any(it.type == "fallback_message" for it in (resp.usage.iterations or []))
# One retry only on HTTP 529 or overloaded, and only if ≥ 8 s of the stage deadline remain.
```

`max_tokens` covers thinking plus output on Opus 5. The values above are 4-5 times the measured output [M], so a stop on `max_tokens` means a real failure, not a tight cap.

**Model-facing schemas** (`vision/app/mind/schemas.py`):
- They use enums and required fields only.
- Numeric bounds are **not** in the schema. Code clamps them after parsing, so one out-of-range number cannot invalidate a whole answer.
- Behaviors are a **discriminated union**, so required fields such as a key's `opens` are enforced by structured output [M failure 2].

```python
Role = Literal["ground","platform","wall","ceiling","spikes","lava","saw","enemy","coin","big_coin","key",
               "door","spring","checkpoint","goal","start_marker","text","arrow","decoration","character","unknown"]
Face = Literal["top","bottom","left","right"]
Dir  = Literal["up","down","left","right","none"]

class Node(BaseModel):          # slim: no free-text "why" (about 30% fewer output tokens than Probe A)
    id: int; role: Role
    on: int | None              # rests_on
    att: int | None; face: Face | None     # attached_to + face
    pts: Dir; part: int | None; ref: int | None
    conf: float

class Move(BaseModel):    kind: Literal["move"];    dir: Dir; cells: int; speed: float; mode: Literal["pingpong","loop"]
class Walker(BaseModel):  kind: Literal["walker"];  speed: float; ledge_aware: bool
class Hopper(BaseModel):  kind: Literal["hopper"];  interval_s: float; forward: bool
class Flyer(BaseModel):   kind: Literal["flyer"];   pattern: Literal["hover","horizontal","vertical","circle"]; range_cells: int; speed: float
class Shooter(BaseModel): kind: Literal["shooter"]; interval_s: float; facing: Literal["left","right","toward_player"]
class Chaser(BaseModel):  kind: Literal["chaser"];  speed: float; sight_cells: int
class Crusher(BaseModel): kind: Literal["crusher"]
class Spring(BaseModel):  kind: Literal["spring"];  strength: float; direction: Literal["up","left","right"]
class Crumble(BaseModel): kind: Literal["crumble"]; delay_s: float
class Key(BaseModel):     kind: Literal["key"];     opens: int          # REQUIRED door component id
class Door(BaseModel):    kind: Literal["door"]
class Static(BaseModel):  kind: Literal["static"]                       # "the monster sleeps"
Behavior = Annotated[Union[Move,Walker,Hopper,Flyer,Shooter,Chaser,Crusher,Spring,Crumble,Key,Door,Static],
                     Field(discriminator="kind")]

class Binding(BaseModel):
    target: int; behavior: Behavior
    spiky: bool                 # enemy cannot be stomped
    pinned: list[str]           # params the text states explicitly ("slow" → speed)
    evidence: str               # the words, or "arrow 14"

class Perception(BaseModel):
    nodes: list[Node]; bindings: list[Binding]
    start_marker: int | None; goal: int | None
    timer_seconds: int | None; title: str | None
    transcript: str; intent: str                     # ≤ 160 chars: what the kid is going for
    library: list[LibMatch]                          # {target: int, library_id: str}
    safety_ok: bool; safety_reason: str | None

class Pick(BaseModel): cid: str; reason: str
class Ask(BaseModel):
    about: str
    kind: Literal["which_door","is_decoration","what_does_it_do","which_flag_is_goal","keep_or_fix"]
    options: list[str]
class DesignPlan(BaseModel):
    picks: list[Pick]; asks: list[Ask]; summary: str; title: str | None

class Setpiece(BaseModel):
    kind: Literal["runway","gap","steps","platform_hops","spike_run","enemy_patrol","moving_bridge","lift",
                  "crumble_run","saw_corridor","tower","key_door","spring_jump","rest"]
    size: int; count: int; height: int
    hazard: Literal["none","pit","spikes","lava"]
    enemy: Literal["none","walker","hopper","flyer","shooter","chaser","crusher"]
    beat: Literal["teach","test","twist","finale","rest"]
class Skeleton(BaseModel):
    title: str; theme: Literal["sketchbook","notebook","graph","kraft"]
    screens: int; band: Literal["easy","normal","hard"]
    setpieces: list[Setpiece]; coins: Literal["trail","risk","both","none"]
    safety_ok: bool

class CreatureSpec(BaseModel):
    archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher","static"]
    behavior: Behavior; spiky: bool; summary: str; safety_ok: bool
```

**Prompt responsibilities.** System prompts live in `vision/app/mind/prompts/*.md`, each ≤ 1.5k tokens and cached.

- **perceive.md**
  - Explains the sheet, the magenta ids and the cell rulers, and that kids use colours loosely.
  - Defines every role with its in-game consequence ("decoration: the player walks through it").
  - Defines every relation, with the instruction "say what the creator MEANT".
  - Flag convention: the rightmost flag is the goal and other flags are checkpoints.
  - Bind behaviors only from the union, only from text or arrows. A typed rule with a target id binds to that id.
  - Name tags matching a library object set `library`.
  - **Never judge distances, gaps or reachability; code does.**
  - Return every listed id exactly once and invent none.
  - Safety check: sexual, hateful or graphic content. Spikes, monsters and lava are fine.
- **design.md**
  - Role: "You are the level designer. The child's drawing is the boss."
  - States the dial goal and target band, the invariants, and the budget.
  - Pick only from the menu, at most 1 per alts group. Prefer the smallest change that keeps the drawing's meaning.
  - Every reason is ≤ 12 words, positive, and readable by a 7-year-old ("Moved this ledge down so you can reach it").
  - Ask instead of guessing when a pick would change what the drawing means.
  - Never claim a jump is possible or impossible: the menu's deltas are the facts.
- **skeleton.md**: compose a level from the setpiece catalogue, in teach → test → twist → finale order, sized to the screens. The physics envelope is given as numbers. No coordinates.
- **creature.md**: map the sentence to one archetype and its parameters. "Spiky" means it cannot be stomped.

**Model vs deterministic code**

| Task | Owner | Evidence |
|---|---|---|
| Strokes, components, features | Code | v1 CV is reliable at segmentation [M] |
| Roles, relations, part grouping, text-to-behavior binding, library name tags | **Model** (low), heuristic offline | 95-97% roles, 75/76 relations, 37/38 non-geometry [M A] |
| Fit, snap, orient, ground, start, gap closing, collision modes, compile | Code | Pure geometry; the model's coordinates are off by 1 [M] |
| Reachability, windows, difficulty, fairness, invariants | Code (bot) | The model was wrong 3/3 without solver facts [M] |
| Choosing among valid repairs and enhancements; kid-facing reasons; asks; title | **Model** (low or medium), greedy offline | Minimal plans 4/4; good taste 15/18, with every failure caught by re-solve [M B, C] |
| Prompt to setpiece sequence | **Model** (low) | 5/5 solvable skeletons; low effort as good as medium and 2.6x faster [M D] |
| Setpiece layout, rasterisation, verification | Code | — |

### A.9 Latency budget and progressive UI

| t (p50) | Canvas | Paper (1 sheet) | What the child sees |
|---|---|---|---|
| 0 | ▶ test-play is already local and instant | upload starts | the drawing "inks itself": cleaned strokes animate in, 400 ms |
| 0.3 s | POST InkDoc + PNG | — | — |
| 0.5 s | **Ink build** (computed in the browser, server mirrors it) | CV ~0.7 s | "What I saw (quick look)" chips; playable |
| 2.5 s | — | **Ink build** from the worker | playable |
| ~10 s (p90 15) | **Understood** | ~12 s | Banner "I understood your drawing". Changed objects morph old→new over 300 ms; new perception cards slide in. |
| +1.2 s | greedy result ready in the background | | — |
| ~19 s (p90 24) | **Polished** (model picks) | ~21 s | Banner "Polished". Pencil additions sketch themselves in (400 ms stroke reveal). Difficulty readout appears. |
| 25 s | hard deadline: ship greedy if the model is late | | late model picks arrive as optional "Designer suggestions" |

The paper target of ≤ 8 s to a faithful playable build is met by the Ink build. The canvas ▶ needs no server at all.

**Streaming.** `GET /api/v2/builds/{id}/events` is Server-Sent Events. Event types are listed in §H.2. Events are persisted to `drafts/<id>/events.jsonl`, so `Last-Event-ID` reconnects work.

**Never yank the level mid-jump.** If the child is playing when a new stage arrives, the swap waits for the next respawn, pause or goal, or for a tap on the toast "The designer polished your level: try it". In preview (not playing), the swap is immediate and animated.

**Dial changes respond instantly.** The greedy result shows in ≤ 3 s, and the model's picks replace it when they arrive.

### A.10 Fallbacks (the game never waits on the model)

| Failure | Detection | Behavior | What the child sees |
|---|---|---|---|
| No API key, offline, `DAL_FAKE_LLM=1` | config | Heuristic perception + greedy designer. Prompt-to-level uses the keyword skeleton (§E.3). Creature uses chips. | Badge "Quick look (offline)"; more "Is this right?" chips |
| Perceive timeout (20 s) or API error | exception | Keep the Ink build. Design runs on G0. | "I'll keep it as you drew it" |
| Refusal (after the server-side fallback) | `stop_reason == "refusal"` | Same as a timeout. Publishing is held as *unlisted, needs safety check*. | "Saved privately" |
| Invented ids or invalid relations | merge | Drop them. If > 30% of nodes are invalid, discard the whole perception. | — |
| `max_tokens` or parse failure | `stop_reason`, `ValidationError` | Treated as a timeout | — |
| Design call late or failed | deadline 25 s | Greedy result; late picks become suggestions | "Polished (auto)" |
| A model pick fails validation | apply | Rejected; the reason is logged in `meta.build` | not shown |
| Node worker crash | broken pipe or 2 s RPC timeout | Restart (≤ 1 s) and retry once; otherwise HTTP 503 | "Builder is restarting, tap retry" |
| Engine error in one entity | try/catch per entity in create and update | Disable the entity and report it. **Publish blocked.** | "I couldn't build the moving platform here. Fix or remove it." |
| Budget exceeded (`DAL_DAILY_BUDGET_USD`, default $10; per build $0.40) | cost ledger | Model-off path | "The designer is resting; quick look only" |

### A.11 Cost per scan

Prices for `claude-opus-5`: $5 per million input tokens, $25 per million output tokens; thinking is billed as output. Token counts are from [M], adjusted for the slim schemas.

| Item | Input tokens | Output tokens | $ |
|---|---|---|---|
| Perceive, 1 sheet, low | about 4.5k (system cached) | about 0.9k | 0.045 |
| Design pick, low | about 6k (menu about 1.8k, image about 1k) | about 0.7k | 0.048 |
| **Polished, 1-screen scan** | | | **≈ 0.09** |
| Challenging, +1-2 medium rounds | about 6k each | about 2k each | +0.08 to 0.16 |
| 4-screen paper level, Polished (4 perceive + 1 design) | | | ≈ 0.25 |
| Prompt-to-level (skeleton low + design low) | | | ≈ 0.09 |
| Creature text | about 1.5k | about 0.4k | ≈ 0.02 |

Every call's tokens, latency, fallback use and cost are written to `builds.cost_usd` and to `meta.build.model_calls`.

---
## B. Gameplay: Mario-grade feel and real challenge

### B.1 Controls

| Input | Keyboard | Gamepad (browser Gamepad API) | Touch (landscape) |
|---|---|---|---|
| Move | ←/→ or A/D | d-pad / left stick | Left thumb: ◀ ▶. You can slide between them without lifting. |
| Jump (variable height) | Z, Space, ↑, W | A | Right thumb: large Jump button |
| Run | X or Shift (hold) | B / X | Automatic after a direction is held for 0.5 s [G §7.1]. Setting: "Always run". |
| Down: fast-fall; with Jump on a one-way, drop through | ↓ / S | down | Small ↓ button above Jump |
| Restart from checkpoint / pause | R / Esc | Select / Start | HUD buttons |

On touch, `navigator.vibrate(10)` fires on stomp and on death, where the browser supports it.

### B.2 Physics core (one module for engine, bot, designer and replays)

`web/src/core/physics/` is pure TypeScript.
- It runs fixed 60 Hz steps. The engine accumulates real time and interpolates rendering between steps, so it stays smooth on 120 Hz screens.
- **Phaser Arcade physics is no longer used for gameplay bodies.** Phaser does rendering, input, particles and audio. This is the v2 version of v1's principle that "the solver shares the engine's constants". Now they share the code itself.
- Determinism rules:
  - float64 state;
  - no `Math.sin`, `cos` or `random` inside the core. Rotations use a 1024-entry lookup table, and the RNG is a seeded xorshift32;
  - time is counted in integer frames.
- The same replay therefore produces the same result in every browser and in Node (§E.4).

**Physics profiles.** These are game-wide and chosen on the rules sheet. The `v2-standard` numbers are from [G §7.1], verified with `proposed_physics.py`. The `gentle` and `snappy` envelopes were computed with the same script.

| Constant | v2-standard (default) | v2-gentle (young kids) | v2-snappy (experts) | v1-classic (migrated levels) |
|---|---|---|---|---|
| Walk max | 96 px/s (6 c/s) | 88 | 104 | 160 (no run) |
| Run max | 168 px/s (10.5 c/s) | 152 | 184 | — |
| Ground accel (to walk, then to run) | 1000, then 300 px/s² (about 6 frames, then 14 more) | 1100 / 260 | 1100 / 340 | instant |
| Friction with no input / skid decel | 1400 / 2400 px/s² | 1600 / 2400 | 1400 / 2600 | instant |
| Air acceleration | 65% of ground. With no input: 200 px/s² drag | 85% / 300 | 60% / 150 | instant, full |
| Jump launch | vy = −(340 + 0.25·abs(vx)) | −(330 + 0.25·abs(vx)) | −(350 + 0.25·abs(vx)) | −330 |
| Gravity while rising with jump held / near apex (abs(vy) < 40, held) / otherwise | 900 / 450 / 1700 | 800 / 400 / 1300 | 950 / 475 / 1900 | 900 / 900 / 900 |
| Release cut | vy := max(vy, −220) | −200 | −230 | −120 |
| Max fall (fast-fall) | 330 (450) | 280 (400) | 360 (480) | 1200 |
| Coyote / buffer | 100 / 120 ms | 150 / 150 | 83 / 100 | 80 / 100 |
| Corner correction (ceiling nudge / ledge pop) | 4 px / 3 px | 5 / 4 | 4 / 3 | 0 |
| **Envelope: apex standing / walk / run** | 3.86 / 4.45 / 4.92 cells | 4.14 / 4.70 / 5.15 | 3.88 / 4.48 / 4.99 | 3.61 |
| **Envelope: distance walk / run** | 4.9 / 9.1 cells | 5.0 / 9.3 | 5.1 / 9.6 | 7.33 |
| Tap hop | 1.1 cells | 1.2 | 1.1 | 0.77 |

**What this does to play.**
- Gaps of 4 cells or less are walk-gaps.
- Gaps of 5-8 cells need a run-up, which is the main new skill [G §7.1].
- A tap hop (1.1 cells) differs from a full jump (3.9-4.9 cells), so variable height matters.
- Momentum makes turning in the air a commitment.

**Abilities** (rules sheet):
- `run`: on by default.
- `stomp`: on.
- `double_jump`: off. The second jump has a fixed vy of −260. Measured from the apex of a full first jump, this gives 6.1 cells standing, 6.7 cells high and 7.6 long walking, and 7.2 high and 13.7 long running.
- `wall_jump` (Tier 2): off. Wall slide falls at most 90 px/s. A wall jump launches vx ±150, vy −320, and locks input away from the wall for 8 frames.

The bot and the difficulty model always use the game's profile and abilities.

**Collision rules.**
1. **Order.** Move along x and resolve against tiles. Then move along y and resolve, applying slope floor height and one-way landing (feet were at or above the platform top on the previous frame). Then resolve against kinematic solids: moving platforms, doors and crumbles, which carry their riders by their frame delta.
2. **Slopes.**
   - Walkable at any speed; uphill speed is ×0.9 and downhill ×1.1.
   - The player sticks to a descending slope if the ground is within 6 px.
   - Kinks are not step-ups: fitted surfaces have no 1-cell bumps (§A.4), so no auto-climb rule is needed.
3. **Generous hurtbox, strict level** [G §5 principle 6].
   - The collision box stays 12×28 px (v1 scale, so drawings keep their size).
   - Against hazards and enemies the player's hurtbox is 8×22 (inset 2 px at the sides and 6 px at the top).
   - Enemy hurtboxes are inset 2 px. Spike bands are 6 px. The lava hitbox is 4 px below its drawn surface.

### B.3 Damage, stomp, death, lives

- **Hits.** By default one hit returns you to the last checkpoint, as in small Mario.
  - Rules sheet `hearts: 1|2|3`. With more than 1, a hit causes knockback (vx ±160, vy −200) and 1.0 s of blinking invulnerability.
  - Falling more than 2 cells below the world bottom is a death.
- **Stomp.**
  - Condition: player vy > 0, the player's bottom on the previous frame ≤ the enemy's top on the previous frame + 4 px, and the enemy is not `spiky`.
  - Result: the enemy is squashed, and the player bounces with vy −280 (−380 if jump is held).
  - Hit-stop of 4 frames.
  - **Stomp chain:** each further stomp without landing raises the stomp sound by 2 semitones and pays +1 coin per chain step ≥ 2.
- **Death sequence.**
  - Hit-stop 6 frames.
  - The character's ink shatters into shards over 250 ms.
  - The camera glides to the checkpoint (≤ 300 ms).
  - The character reassembles over 200 ms.
  - Total 0.75 s. Pressing Jump after 250 ms skips the rest. The time counts toward the speedrun clock, so dying costs time.
- **Respawn state** (deterministic). Entities reset to their initial state, with these exceptions:
  - enemies killed before the checkpoint was activated stay dead;
  - doors opened by keys collected before activation stay open;
  - regular coins stay collected;
  - big coins not yet banked go back to their spots (the Celeste strawberry rule: a big coin counts once you reach the next checkpoint or the goal).
- **Lives** (rules sheet `lives: off|3|5`, default off with a visible death counter [G R5]).
  - With lives on, game over restarts the level with full lives.
  - 100 coins give +1 life.
  - Lives are per level, which is kind to kids.

### B.4 Enemies: six archetypes, all with gravity unless they fly

| Archetype | Motion | Parameters: default (bounds) | Stompable | Telegraph | How the bot models it |
|---|---|---|---|---|---|
| `walker` | Walks with gravity. Turns at walls, at other enemies and, if `ledge_aware`, at ledges. | speed 2 (1-6) c/s; ledge_aware true | yes | 2-frame waddle | Periodic, a function of the frame |
| `hopper` | Hops every interval: vy −380 (about 2.6 cells), 1.5 c/s forward | interval 1.6 (1.0-3.0) s; forward true | yes | 150 ms crouch | Periodic |
| `flyer` | No gravity. Patterns: hover (bob 0.5 cell, 2 s), horizontal or vertical (range 2-10), circle (radius 1.5-4, period 3-6 s) | speed 2 (1-5) | yes | wing flap | Periodic |
| `shooter` | Stands with gravity. Fires an ink blob (6×6 hitbox) that dies on solid ground or after 16 cells. | interval 2.5 (1.5-5) s; blob speed 5 (3-8) c/s; facing left / right / toward_player | yes | 0.4 s inflate | Periodic, or simulated with the player for `toward_player` |
| `chaser` | Patrols at 1.5 c/s. When it sees the player (within `sight` cells horizontally, abs(dy) ≤ 3, no solid between) it accelerates at 600 px/s² toward the player. Hops 1-cell steps. Gives up 3 s after losing sight. Not ledge-aware. | speed 4 (2-5.5, always below walk speed) c/s; sight 8 (4-12) | yes | eyes go red, "!" scribble | Simulated with the player |
| `crusher` | Waits on the ceiling. Triggers when the player is within 1.5 cells horizontally below. Drops at 2500 px/s² (max 400), rests 0.8 s, rises at 2 (1-4) c/s. Lethal only while moving down onto the player. You can stand on it. | warn 0.5 (0.3-0.8) s | no | shakes, dust falls | Simulated with the player |

- The `spiky` modifier applies to any archetype. Perception sets it when drawn spikes are part of the creature, or text says so. A spiky enemy cannot be stomped.
- A perceived enemy with no text defaults to a **walker at 2 c/s, ledge-aware, bounded to its host surface**: the drawing comes alive.
- "Sleeps", "doesn't move" or "stays" make it `static`.
- This fixes the v1 hover [B F9, `Patroller.ts:38`].

### B.5 Hazards and platforms

| Type | From a drawing | Behavior and numbers | Art (§D.3) |
|---|---|---|---|
| Spike strip | red zigzag or red line on or near a surface | Host plus facing. 6 px hitbox band inset 2 px at the ends. Lethal. | Kid's zigzag re-based onto the face, 9 px teeth |
| Lava | red or orange fill or scribble in a pit, or the text "lava" | `~` tiles; hitbox 4 px below the surface | Animated wavy top, 2 bubbles/s |
| Saw | red circle with teeth, or `add_hazard` | Radius 0.75 / 1 / 1.5 cells; hitbox circle 0.8·r; static or on a `move` path | Spinning scribble, whirr that gets louder with proximity |
| Firebar (Tier 2) | text "fire bar", or designer | Anchor plus 3-6 balls; 90 (45-180) °/s | Ink fireballs |
| Rising lava (Tier 2) | text "rising lava", only in levels with screens_y = 2 | 0.6 (0.3-1.5) c/s after a 3 s delay | Full-width animated band |
| One-way platform | thin floating stroke | Land from above. Down + Jump drops through (ignores one-way for 12 frames). | Stroke plus a dotted underside |
| Slopes | tilted strokes | 1:1 and 1:2 | Stroke along the slope |
| Moving platform | arrow or text "moves" | Direction plus 2-20 cells; speed 2 (1-6) c/s; ping-pong or loop; waits 0.3 s at each end; carries riders. Path is clipped at solids and must be ≥ 2 cells long, otherwise `fix_behavior`. | Kid's stroke, with motion-line ticks at the ends |
| Crumble | "crumbles", or designer | Shakes 0.5 (0.3-1.0) s after first contact, falls at g 1700, respawns after 3 (2-6) s once clear | Paper bits fall |
| Falling platform | "falls" | Falls 0.4 s after being stood on; resets on death | — |
| Spring | "bouncy", "spring", or a coil doodle | Up: vy = −450·strength (0.5-2). Jump held: about 7 cells; not held: about 3.7 cells (holding is the skill). Side: vx ±400 locked for 20 frames, vy −250. | Coil squash, rings |
| Key / door | blue key shape; text "door" or "key opens door" | The key opens one door by id. The door stays solid until opened (puff plus glide sound). Multiple pairs are allowed. | Kid strokes |
| Checkpoint | any non-rightmost flag, or designer | Touch to activate (the flag unfurls); respawn point | Kid flag, or a pencil flag |
| Goal | rightmost flag | Touch to win (0.5x slow motion for 400 ms, confetti) | Kid flag waving (vertex wobble). The pole is scenery. |
| Coin / big coin | blue dot / blue star or designer | Coin: magnet radius 6 px. Big coin: at most 3 per level, banked at the next checkpoint or the goal. | House ink coin in the kid's blue; big coin is a hand-drawn star |

### B.6 Scoring, timers and stamps

- **Speedrun clock.** Always on, top centre, `m:ss.cc`.
  - Counts simulation frames from the first input until the goal is touched.
  - Includes death and respawn frames; excludes pause.
  - The time shows on the win card [G R5].
- **Level timer rule** (from text, or Challenging `set_timer`).
  - Shown as a ring around the clock.
  - With 10 s left, the music speeds up 10% and the ring pulses.
  - When it expires you lose and the level restarts.
  - Designer timers are 1.5-2.0 times the bot's fastest time. v1's data had 11-15 times [G].
- **Four stamps per level:**
  - **Clear**;
  - **Collector** (all big coins banked);
  - **Speedy** (at or under par = 1.3 × the bot's fastest, rounded up to 0.5 s);
  - **Flawless** (0 deaths).
  - Plus a "Beat the creator" badge if the creator posted a run.
- **Coins** count toward Collector only through big coins. Regular coins guide the player and fill the per-game "ink jar" total on the game page, a cosmetic counter. With lives on, 100 coins give +1 life.

### B.7 The difficulty model (numeric, computed from playtest metrics)

This formalizes [G §6]. Code: `web/src/core/difficulty/model.ts`. Inputs come from the bot's route, which is the route with the **fewest expected deaths**; ties are broken by fewer actions, then by time.

**Per route action i**, measured by engine-exact simulation:
- **Takeoff window `w_i`** (frames). Sample takeoff x in 2 px steps around the edge and find both ends of the successful interval by bisection. Convert to frames at the takeoff speed. Policies cover:
  - run-up, walk and standing starts;
  - holds {1, 3, 6, 9, 12, 16, 20, 30, 45} frames;
  - releasing the direction never, at the apex, or at apex + 6. This addresses [G §11]: the v1 sweep was pessimistic for small landings.
- **Hold window `h_i`** (frames): the number of consecutive working hold values from the best takeoff, interpolated.
- **Phase window `φ_i`** (frames) for timed entities: the number of working samples out of 24 across the entity's cycle, times the cycle length / 24. The player can wait, so this is a window in frames.
- **Lethal share `L_i`**: the fraction of failing samples (±1 window width, all holds) that end in death rather than a recoverable state.

**Formulas:**

```
miss(x)   = 2·Φ(−x / (2σ))                         σ = 3 frames (casual), 1.5 (skilled)
p_fail_i  = 1 − (1 − miss(w_i))·(1 − miss(h_i))·(1 − miss(φ_i))     (miss(∞) = 0)
d_i       = p_fail_i · L_i
E_s       = Σ_{i∈s} d_i                            expected deaths per attempt of segment s (between checkpoints)
A_s       = 1 / Π_{i∈s}(1 − d_i)                   expected attempts
F_s       = (A_s − 1) · T_s / 2                    expected seconds lost to replays in s; T_s = bot fastest
C         = max_s E_s + 0.25 · Σ_s E_s
score     = round(100 · (1 − e^(−C)))              0-100 badge
casual_clear_s = 1.6 · Σ_s T_s + Σ_s (A_s − 1)·(T_s/2 + 0.75)
```

**Bands** [G §6]:

| Band | C | Score |
|---|---|---|
| Trivial | < 0.05 | < 5 |
| Easy | 0.05-0.3 | 5-26 |
| Normal | 0.3-1 | 26-63 |
| Hard | 1-3 | 63-95 |
| Expert | > 3 | > 95 |

**Readout for kids:** "Easy · about 1 fall in N tries", with N = round(1 / max(E_s)), plus "bot time 0:31 · par 0:41".

**Fairness flags** are hard constraints. They hold in every dial position and are never traded for difficulty:
- any window < 4 frames (casual);
- a blind jump or leap of faith;
- a hazard within 2 cells of a spawn or checkpoint;
- an enemy patrol within 4 cells of a spawn;
- a lethal fall with no visible danger (pits always render an "abyss scribble" at the world bottom);
- any segment with F_s > 30 s;
- a softlock.

**Calibration anchors.** These are tests that must reproduce [G §3] under `v1-classic` with `opts.legacy_measure = true`, with tolerance ±0.01. Legacy measuring disables coyote and buffer modelling and the release-direction policies, matching how `level_metrics.ts` measured.
- 4-cell spike pit: E = 0.000;
- 5-cell spike pit: E = 0.004;
- 6-cell spike pit: E = 0.049;
- 7 pillars over spikes: E = 1.92 ± 0.2.

With legacy measuring off, every E may only go down, because the player can do more. The ranking of the v1 levels must be unchanged.

**Performance budget** (Node, one core):
- fast verify (reachability plus route): ≤ 15 ms per screen;
- full metrics: ≤ 150 ms per screen.

The v1 solver needed < 11 ms per 48×27 screen [M].

**How the dial uses it** (§A.7):
- Faithful only enforces fairness.
- Polished lifts C toward 0.1 using parameters only.
- Challenging drives each segment toward its sawtooth target using class C edits, cheapest intent cost per unit of ΔC first.

Every output re-runs the full model. The preview shows before and after ("Your drawing: Trivial → Polished: Easy (0.14)").

---

## C. Scrolling levels

### C.1 World size

- The viewport stays 48×27 cells (768×432 logical px), so the drawing scale is unchanged.
- The world is `w = 48·screens_x` with screens_x in 1..6 (up to 288 cells), and `h = 27·screens_y` with screens_y in 1..2.
- At most 8 screens in total. Up to 6 screens is about the length of SMB 1-1 [G §7.3].
- The core, the bot, the engine bounds and the tile rows are all parameterized by `world.w` and `world.h`. This removes the hard-coded `GRID_W` and `GAME_W` [G R4, M].

### C.2 Camera (`web/src/game/camera.ts`; the same rule lives in `core/bot/camera_rule.ts` for blind-jump checks)

**Horizontal:**
- Dead zone of 4 cells.
- Target = player x + look-ahead of 6 cells in the direction of motion. When standing, the look-ahead follows the facing direction and eases in over 0.5 s.
- Lerp 0.1 per frame.
- With the run speeds above, every run-jump landing (≤ 9.6 cells) is on screen at takeoff [G §7.3].

**Vertical:**
- Platform snap: the target is the last grounded y, lerp 0.08.
- If the player leaves the band from 25% to 65% of the screen height, follow with lerp 0.25.
- Falls follow immediately once the player is below 70% of the screen height.

**Bounds and events:**
- Clamp to the world.
- On respawn, glide to the checkpoint (≤ 300 ms).
- On win, zoom to 1.1 with 0.5x slow motion for 400 ms.

**Screen shake:** death 6 px for 250 ms; crusher landing 4 px for 150 ms; stomp 2 px for 80 ms. Shake is off with `prefers-reduced-motion`.

**Minimap strip** (HUD, top right): 1 px per cell, showing terrain, the goal, checkpoints and the player dot.

### C.3 Long-canvas editor

- **Viewport.** Pan with two fingers, space-drag, or the middle mouse button. Zoom with pinch or wheel from 0.5x to 3x. At 1x one cell is 16 CSS px on desktop, and at least 12 px on a phone thanks to zoom.
- **"+ Add screen"** buttons sit on the right edge (and below, up to 2 rows). Sheet boundaries are shown as perforated lines with the sheet numbers.
- **Minimap** at the bottom: thumbnails of every screen, tap to jump.
- **Storage.** Strokes are stored in world px. Undo and redo use a command stack 200 deep. Strokes may cross sheet boundaries freely.
- **Test-play.**
  - ▶ starts from the start.
  - Long-press ▶ (or drag the player flag) to "play from here": spawn at the chosen standable cell, for testing late sections.
  - The camera and world size are the real ones.

### C.4 Multi-sheet paper stitching

- **Print a pack.** `GET /api/v2/templates/pack.pdf?k=3&game=<id>` prints k A4 sheets. Each sheet has:
  - the v1 layout (ArUco markers, swatches, character box only on sheet 1, rules box only on sheet 1);
  - a QR code `dal2|s|<pack>|<i>|<k>|<game or ->|<parent or ->`, where pack is 8 base32 characters minted at print time;
  - gray seam ticks every 5 cells on the left and right drawing-area edges, labelled "continues on sheet i+1".
- **Scan.** The scan screen has a pack tray: scan the sheets in any order. Each sheet is rectified independently, which is exact because each maps to cells [48·i, 48·i+47].
  - Strokes that touch a seam (endpoint within 0.5 cell of the edge) are joined to strokes on the neighbouring sheet if their endpoint rows differ by ≤ 1 cell. They become one stroke whose seam point is the average.
  - Missing sheets show as dashed placeholders.
  - The level is playable as soon as the scanned sheets form a contiguous run starting at sheet 0.
  - Publishing requires all k sheets and a goal.
- **Model calls.** Perception runs **per sheet, in parallel**. Each call sees one sheet image plus a 2-cell context strip from each neighbour. The latency of a 4-sheet level is therefore about that of a 1-sheet level; cost grows linearly (§A.11). A component crossing a seam takes the id given by the sheet holding the majority of its ink.

### C.5 Remix across sheets, and re-scanning

- The remix PDF for a k-screen level prints k pages: the parent's ink in gray #B0B0B0 plus `dal2|r|<parent>|<i>|<k>`.
  - Parent coins, keys and goals print as **gray outline glyphs**, never filled blue or green. They classify as gray and cannot turn into duplicates.
  - Scanning any subset of sheets changes only those screens. The other screens inherit from the parent.
- **Object-level remix diff** (`core/scene/remix.ts`):
  - New ink objects are matched to parent objects by role and overlap (IoU ≥ 0.3, or centre within 1 cell). A match is the **same object** and keeps its id.
  - Only unmatched ink becomes new objects.
  - Compile also de-duplicates same-type entities closer than 0.75 cell.
  - This fixes "remix by re-scanning duplicates coins". The test is that re-scanning an untouched remix sheet yields 0 new objects.
- **Extend a level**: `dal2|x|<parent>|<k+1>` prints a blank sheet that appends a screen.
- **Paper to screen**: a scanned level opens in the canvas editor as vector strokes (CV v2 outputs vectors), so you can scan, then tweak on screen.

### C.6 Performance for long worlds

- **Terrain ink** is rasterized into 512×512 logical-px chunk textures at render scale r (§D.4). Only chunks within the camera ±1 chunk are kept, with an LRU of 16. A 6×2-screen world at r = 2 holds about 16 MB of chunk textures.
- **Entities** are culled outside the camera +4 cells. Their physics still runs, because the world is deterministic.
- **Bot and designer** re-analyze only the checkpoint segments that intersect an edit's bounding box ±10 cells.

---
## D. Visual quality: from a drawing to beautiful game art

### D.1 Art direction: "living ink on paper"

There is one renderer for every level, thumbnail and seed. This removes v1's three clashing styles: seed blocks, doodle entities and the raw photo [V]. It draws three kinds of ink, so a player can always tell who drew what:

| Ink | Who | Look | Use |
|---|---|---|---|
| **Marker** | the kid (and parent ink in remixes) | Solid, saturated. Canonical palette: ink #1F1B18, red #E0453A, green #3E9E4F, blue #2C7BE5. Their own strokes, cleaned and top-aligned. | everything they drew |
| **Pencil** | the designer | Coloured-pencil grain with 45° hatch fill, 85% opacity. Graphite-violet #6A5ACD for neutral additions. Red pencil with a dark outline for hazards (still clearly lethal). | every class P or C addition [G §9 invariant 5] |
| **Graphite / blue-line** | the world and the prompt drafts | Graphite at ≤30% contrast for parallax and the sketch underlay. Animator's non-photo blue #8FB8DE for prompt-to-level drafts. | backgrounds; drafts you draw over |

**Readability rules** (checked in the golden visual review):
1. Anything that hurts is red-family, has a dark outline and an animated tell: spikes shimmer 1 px, saws spin, lava waves.
2. Anything you can stand on has a crisp top edge that is exactly the collision surface (§D.3).
3. **Anything that doesn't collide doesn't look solid.** Decoration renders at 55% opacity with a 20% watercolour wash inside closed shapes. Text and arrows render as graphite "signs".
4. Gameplay ink always sits above parallax.
5. The HUD sits on paper plates.

**Type:** "Patrick Hand" (Google Fonts) for the HUD, buttons and headings; system-ui for long text.

### D.2 Stroke cleanup (art side; `web/src/render/clean.ts`)

1. Resample to 2 px, then 2 iterations of Chaikin smoothing, then RDP with ε 1.2 px. This is finer than the physics fit's 3 px, so the character survives.
2. Smooth the width profile (window 9) and clamp it to 3-10 logical px. A tap renders as a dot at least 10 px across.
3. Close near-touching ends (≤3 px) on closed shapes such as flags and creatures.
4. **Paper re-inking.**
   - Paper strokes are redrawn as vector marker strokes in the canonical palette, using the colour class from v1's swatch calibration.
   - Every paper level therefore looks equally good in any lighting.
   - The photo survives only as the optional "my original sketch" underlay (15% opacity, linear filtering).

### D.3 Art from geometry: what you see is what you stand on

**Top-edge alignment** (`render/terrain.ts`). For each terrain object:
- Δ(x) = collision_top(x) − ink_top(x). By construction |Δ| ≤ 8 px (§A.4).
- Δ is smoothed over 5 px and applied to every point of that object's strokes: y' = y + Δ(x).
- The drawn line's top edge then lies on the surface the player stands on, within 1 px.
- The line keeps its own width variation and texture below the top edge. Only the wobble of the top edge is tidied.
- This closes [B F13]: v1's mean offset was 5-14 px.

Per-role recipes:

| Role | Recipe |
|---|---|
| Ground | Aligned marker stroke. Below it: 45° graphite hatch (7 px spacing, 1.2 px, 28% alpha) over a paper tint #EFE7D6 at 60%. Pits get an "abyss scribble" at the world bottom. |
| One-way platform | Aligned stroke plus a dotted underside (3 dots per cell). This tells the player "you can jump through". |
| Solid floating platform | Stroke plus 1 cell of light hatch underneath |
| Wall / ceiling | Same rule on the colliding face; hatch on the solid side |
| Spikes | The kid's zigzag vertices projected onto the host face and normalized to 9 px teeth. A drawn straight line gets generated teeth 8 px wide. Fill #F6B3AD, marker-red outline, pointing away from the host. |
| Enemy / key / door / spring / creature | The kid's vector strokes (all `part_of` parts) baked into a sprite texture at render scale r. Crisp, never nearest-neighbour [V]. |
| Coin | House coin: 10 px blue marker ring with a shine tick. The kid's dot is not drawn again (never twice) [B F14]. |
| Big coin | The kid's star if drawn, otherwise the house star |
| Goal | The kid's flag with a waving vertex wobble. The pole is scenery. **The engine never adds a second flag** [B F14, V]. |
| Decoration | The kid's strokes at 55% opacity plus a watercolour wash |
| Text / arrow | The kid's handwriting at 70% graphite, a sign on the paper ("jump!" stays visible and is never a wall) |
| Designer additions | Pencil recipes. House doodles in pencil: walker blob, hopper frog, flyer bat, shooter cannon, chaser angry blob, crusher block. Plus pencil checkpoint flag, pencil coin trail, pencil hint arrow. |
| Migrated v1 levels | Solid regions traced with marching squares, wobbled with seeded noise and drawn as marker. No more flat clip-art. |

### D.4 Rendering technology (`web/src/game/index.ts`, `web/src/render/*`)

**Phaser configuration:**
- `pixelArt: false`, `antialias: true`, `roundPixels: false`, WebGL. The Canvas renderer is a fallback without boil.
- This fixes [V critical 3] and [B F16].

**Render scale r ∈ {1, 1.5, 2}:**
- r is the smallest value ≥ min(2, devicePixelRatio × displayed CSS width / 768).
- The internal size is 768r × 432r. The main camera zooms by r. Scale mode is FIT.
- Example: the measured 669 CSS px at DPR 2 gives r = 2, a 1536 px backing store shown with linear downscaling. v1 instead stretched 768 px by 1.74x with nearest-neighbour [V].
- Physics stays in logical px.

**Textures:**
- Every ink texture is generated from vectors at scale r and uses LINEAR filtering.
- On resize (debounced 250 ms), chunks re-rasterize at the new r without restarting the scene.

**Layers** (depth, scroll factor):

| Depth | Layer | Scroll factor |
|---|---|---|
| 0 | paper | — |
| 10 | far parallax | 0.2 |
| 20 | mid parallax | 0.5 |
| 30 | sketch underlay (optional) | — |
| 40 | decoration | — |
| 50 | terrain chunks | — |
| 60 | entities | — |
| 70 | player | — |
| 80 | particles | — |
| 90 | foreground tufts (sparse, never within 2 cells of hazards) | 1.1 |
| 100 | preview overlays | — |

The HUD uses a separate camera with no zoom and no shake.

### D.5 Living ink: boil, paper, parallax

- **Line boil.** `InkBoilFX` is a WebGL PostFX pipeline on the decoration, terrain and entity layers.
  - It displaces UVs by a tileable 3-frame noise texture (amplitude 0.7 logical px) and switches frame every 6 simulation frames (10 fps).
  - It needs no per-chunk texture variants, so there is no memory blow-up.
  - It turns off with `prefers-reduced-motion`, when fps < 50 for 2 s (auto-degrade), and on the Canvas renderer.
  - Physics never boils.
- **Paper.** A procedural 512×512 grain tile (fBm, 4 octaves, ±4% luminance) is made once at boot. There are four themes (rules sheet):

  | Theme | Look |
  |---|---|
  | sketchbook (default) | cream #FBF6EA with a 6% dot grid every 16 px |
  | notebook | blue rules every 32 px and a red margin |
  | graph | 10% blue 16 px grid |
  | kraft | #D9C2A0 with fibre noise; ink lightened 8% |

  Every theme has a 12% vignette.
- **Parallax.** Deterministic from (level id, theme); no assets.
  - Far layer: 2-3 graphite hill lines (sums of 3 seeded sines) and scalloped clouds every ~12 cells, drifting at 2 px/s.
  - Mid layer: bush, grass and tree doodles every 6-10 cells.
  - Foreground: tufts about 1 per 8 cells on terrain surfaces.
  - All of it stays at ≤30% contrast, so it never competes with gameplay ink. Levels stop looking like "70% blank paper" [V].

### D.6 Sprites that come alive from one drawing

**Rig extraction.** This runs in TS for studio vectors and in Python for paper (CV v2 sends the character as strokes).
- **Body:** all strokes.
- **Legs:** 1-4 strokes whose lowest point is in the bottom 25% of the bbox, within 35° of vertical, and ≥15% of the height long.
- **Arms:** strokes in the middle band that stick out past the body silhouette.
- **Eyes:** 1-2 small closed dark blobs (≤12% of the width) in the top half.
- **No legs found:** synthesize 2 stick legs in the kid's main ink colour, as v1 does.

**Player animation** (`web/src/game/player/PlayerView.ts`). It is driven only by the simulation state, so ghosts animate identically.

| State | Animation |
|---|---|
| Run | Legs swing ±28° at f = 1.8 + 0.12·speed(c/s) Hz in opposite phase. Arms swing ±20° against them. Body bobs 1.5 px at 2f. Lean of 4° × v/vmax. |
| Skid | Lean back 10°, dust |
| Jump | Launch squash (scaleX 0.8, scaleY 1.25), easing to 1 over 120 ms. Apex: (1.05, 0.95). Falling: legs together, arms up 30°. |
| Land | (1.25, 0.75) back to 1 over 140 ms, scaled by impact (vy/330) |
| Idle | Breathing scaleY 1.00↔1.03 at 0.6 Hz. A 100 ms blink every 2.5-5 s (seeded) when eyes were found. Pupils shift 1 px toward the nearest enemy or coin within 6 cells. |
| Turn | 60 ms squash, then flip |
| Death | The sprite is cut into 12-16 precomputed Voronoi shards that fly with gravity and spin. Respawn plays this in reverse. |

**Enemies and objects:**
- Enemies waddle (±6° at 3 Hz, 1 px bob), watch the player with their eyes, and flash an angry outline within 4 cells. A stomp flattens them to 25% height and they puff away over 300 ms.
- Flags wave.
- Moving platforms trail speed ticks when moving faster than 2 c/s.
- All of this fixes the single static frame in v1's `Player.ts:128-185` [V].

### D.7 Juice

| Event | Hit-stop | Shake | Particles (pre-baked ink textures, ≤300 alive) | Sound | Extra |
|---|---|---|---|---|---|
| Jump | — | — | 5 graphite dust specks | jump | squash |
| Land | — | — | 4-8 specks, scaled by impact | land | squash |
| Skid | — | — | 3 specks every 4 frames | skid | lean |
| Coin | — | — | 6 star sparkles; the coin flies to the HUD (bezier, 350 ms) | coin (combo pitch) | — |
| Big coin | 3 f | — | ring of 12 + 16 confetti | arpeggio | HUD slot fills (pulsing outline until banked) |
| Stomp | 4 f | 2 px / 80 ms | 8 ink splats + ring | stomp (chain pitch) | enemy squash |
| Death | 6 f | 6 px / 250 ms | ink shards | death | camera glide to checkpoint |
| Checkpoint | — | — | 10 sparkles | chime | flag unfurls |
| Spring | — | — | 2 shock rings | boing | coil squash |
| Crumble | — | — | 6-10 paper bits | crumble | shake |
| Door opens | 2 f | — | puff of 14 | glide | — |
| Goal | — | — | 60 confetti scribbles | jingle | 0.5x slow motion for 400 ms, zoom 1.1 |

### D.8 Synthesized sound (WebAudio, no asset files; `web/src/audio/`)

v1 shipped with `noAudio: true` [V, G R8].

| Sound | Recipe |
|---|---|
| Jump | square wave, 260→520 Hz exponential over 90 ms; attack 2 ms, decay 120 ms; gain 0.18; ±3% random pitch |
| Double jump | triangle, 400→800 Hz over 80 ms |
| Land | noise burst through a 400 Hz lowpass, 60 ms; gain scaled by impact |
| Coin | triangle, 988 Hz for 50 ms then 1319 Hz for 120 ms. +1 semitone per coin within 1.2 s, up to +7 |
| Big coin | C6-E6-G6-C7 at 60 ms per note, plus a shimmer (detuned triangles) |
| Stomp | square, 180→80 Hz over 100 ms, plus a noise click; +2 semitones per chain step |
| Death | sawtooth, 440→110 Hz over 300 ms, plus 120 ms of noise |
| Spring | FM: carrier 220 Hz, modulator 110 Hz, index 6→0 over 250 ms |
| Checkpoint | triangle chime, 660 Hz then 880 Hz |
| Goal | C5 E5 G5 C6 G5 C6 on square + triangle, 900 ms total |
| Crumble | noise through a 1.2 kHz bandpass, 150 ms |
| Door | triangle glide, 300→600 Hz over 200 ms |
| Skid | noise through a 2 kHz bandpass, 80 ms |
| Saw | looping filtered noise, gain = proximity |
| UI tap | sine, 880 Hz for 30 ms |

**Music.**
- One generative loop per theme: sketchbook in C major pentatonic, notebook in D dorian, graph in G mixolydian, kraft in A minor pentatonic.
- 4 bars at 100 BPM: triangle bass on beats 1 and 3, a lead on a square wave with 12.5% duty seeded by the level id, and noise hats.
- Levels: master 0.6, music 0.25. Music ducks 50% under jingles and speeds up 10% in the last 10 s of a timer.
- Mute with M or the HUD button; the setting is saved in localStorage.
- The AudioContext resumes on first input. The preview starts muted until Play.

### D.9 HUD, results, chrome, thumbnails

- **HUD plates.** Paper rounded rectangles with a 2 px marker outline and ±1° rotation. HUD text never sits directly on ink [V].
  - Left: coins plus 3 big-coin slots.
  - Centre: the speedrun clock, with the timer ring when a timer rule exists.
  - Right: deaths (a skull doodle), the minimap, and mute / restart / pause.
- **One win moment** [V, G7 fix 1]:
  - The canvas plays slow motion and confetti only. `Hud.showBanner` is deleted.
  - Then one HTML results card shows:
    - the time, large, with the delta to your personal best;
    - the four stamps slapping on one after another with a "thunk";
    - deaths, coins and big coins;
    - the creator's time or "beat my level" result;
    - buttons: Retry (R), Next level, Watch ghost, Challenge a friend, Remix.
- **Chrome.** Paper cards with tape corners, marker underlines, marker-outlined pill buttons. The game canvas is always on light paper. The dev footer moves to `#/dev` [V].
- **Thumbnails.**
  - The feed renders them with the same ink renderer's Canvas2D backend (`render/thumbnails.ts`), including entities, player and goal, cached in IndexedDB by `id@version`.
  - Publishing also uploads a 640×360 PNG for share cards.
  - Remix-tree nodes outline new objects in pencil, so each remix's change is visible [V].

### D.10 The preview: "what I saw, what I changed, how it plays"

**Layout.** Desktop: stage 70%, report 30%. Phone in landscape: full-screen stage with the report as a swipe-up bottom sheet.

**Top strip:**
- Stage chips "① Ink ✓ 0.5 s · ② Understood ⏳ · ③ Polished".
- The dial: **Faithful | Polished | Challenging ▾ (Normal, Hard)**.
- A difficulty pill, for example "Easy · ~1 fall in 6 tries".

**Report sections:**

1. **What I saw.**
   - Objects grouped by role, each with an icon and a thumbnail of its strokes. Examples:
     - "Ground ×3"
     - "Spike strip on the left ledge, pointing up"
     - "Monster (walks) with its eyes"
     - "Flag = goal; pole is scenery"
     - "2 coins from your dots"
     - "'jump!' is a sign; you can walk through it"
   - Items below 0.75 confidence show "Is this right?" with one-tap re-labels: platform, wall, decoration, enemy, spikes, text.
   - A re-label is a `kid` edit and rebuilds in under 150 ms.
   - Ignored specks are counted.
2. **What I changed.** Cards in the fixed vocabulary, grouped where sensible ("Straightened 6 wobbly lines").
   - Each card has an icon, the reason, a badge ("fixed for you 🔧", "designer ✎", "designer's pick ✨" for model picks) and an **Undo / Redo** toggle.
   - Tapping a card shows ghosts on the stage: *before* as a dashed graphite outline, *after* as a solid pencil outline, with an arrow for moves.
   - Dependent cards grey out with "needs: …".
   - **Undo all** gives the level as drawn. Repairs required for solvability show a lock note: "needed so the level can be finished". They can still be undone, but then publishing is blocked.
3. **Questions.** Ask cards such as "Which door does this key open? Tap it." or "Is this black bar a door?" The answer becomes a `kid` edit.
4. **How it plays.**
   - **Watch the bot:** a pencil ghost runs the bot's route at 1x. Tight jumps get an orange ring and blind spots an eye icon.
   - Bot time and par.
   - A band bar per segment (the sawtooth).
   - Flags as plain sentences, each with a **Fix it** button that applies the top candidate. Example: "The jump after the second checkpoint is 9 cells. You need a long run-up there. Add a coin arc?"

**Toggles:**
- A toggle rebuilds and fast-verifies in the browser (core, < 150 ms per screen) and morphs the stage.
- Full metrics are refreshed in a Web Worker in ≤ 1 s.

**Publish** is enabled only when all of these hold:
- the bot cleared the level;
- the engine reports no entity errors;
- the safety check passed, or the level is held unlisted;
- every Ask card is answered or defaulted.

When disabled, it says why in one sentence and offers a fix button.

**Text and overlays:**
- All text comes from `shared/spec/messages.json`: keys mapped to sentences of ≤12 words for reading age 7. Raw codes never appear [V].
- Overlays live inside the Phaser scene, so markers follow moving sprites [V].

**Back to drawing** opens the editor with the current objects as editable vectors. Edits are kept by object id, so the system's fixes survive. v1 could not do this [V].

### D.11 The editor: a drawing tool that knows it is making a level

**Tools:**

| Tool | Behavior |
|---|---|
| Marker | 4 colours. The default width is **12 px (0.75 cell)**, with pressure. |
| Tap | A press with < 4 px movement and < 250 ms stamps a **14 px dot**, coin-sized. This fixes the dropped taps [B F7, G7 fix 2]. |
| Line | Holding still for 400 ms at the end of a stroke snaps it straight, Procreate QuickShape style. Optional "snap to rows" toggle. |
| Eraser | Two modes: tap to delete a stroke, or scrub to split strokes. |
| Select | Lasso or tap. Move, delete, recolour, and **"What does it do?"** |
| Stamps tray | coin, big coin, spikes, flag, checkpoint, spring, saw, walker, hopper, flyer, key, door, plus the game's library objects (§E.1) |
| Undo / redo | 200 steps |
| ▶ Test-play | Instant, from the start; long-press for "play from here" |
| ✎ | Back to drawing |
| Character | Opens the Character Studio |
| Rules | Opens the game rules sheet |
| **Make it a level!** | Starts the full build |

**Live hints.** The TS core runs in a Web Worker, debounced 150 ms after each stroke:
- role chips that fade after 2 s and stay on selected objects;
- a reach halo from the start (reachable standing cells shaded green);
- red dashed "too far" markers on unreachable gaps, with "needs a run-up" when a run-jump would make it;
- snap ghosts showing where floating spikes will land;
- the goal pulsing while it is unreachable.

All hints can be turned off with "Hints off" for purists.

**Rules attached to things.**
- Select a stroke, then "What does it do?" opens chips over the fixed vocabulary:
  - moves ↔ or ↕ with a distance slider;
  - walks, hops, flies, shoots, chases, crushes;
  - bouncy, crumbles;
  - key → (tap a door), door, checkpoint, start here.
- Each chip makes an explicit `kid` binding with no model involved.
- Free text typed while a stroke is selected is sent to Perceive with that stroke's component id, so a typed rule can never bind to the wrong object [B F10].

**Character Studio** [G7 fix 7]:
- A 256×256 vector canvas with its **own** colour and tool state.
- An onion-skin outline of the 12×28 hitbox scaled up.
- A live mini-stage on the right where the doodle runs, jumps and lands with the rig (§D.6) as you draw.
- "Save to library as my player".
- Kept in the draft and restored when you come back.
- On paper, the character box goes through the same rig extraction.

---
## E. The natural extensions

### E.1 Object library per game

**Library object** (`shared/spec/library-object.schema.json`):

```ts
interface LibraryObject {
  id: string; game_id: string; version: number;              // edits create version n+1; levels pin a version
  name: string;                                              // "Grumpo" (≤16 chars, kid-safe filter)
  kind: 'creature' | 'platform' | 'hazard' | 'pickup' | 'prop' | 'player';
  behavior: Behavior;                                        // the same typed union as perception (§A.8)
  spiky: boolean; collision: 'solid' | 'one_way' | 'none';
  art: { strokes: InkStroke[]; sprite_url: string; rig?: Rig; size_cells: [number, number] };
  symbol: { letter: string; circled: true };                 // auto-assigned (first free letter of the name)
  author: string; created_at: string; uses: number;
}
```

**Ways to make one:**
1. **Creature Studio** ("Make a creature"): draw it, name it, then pick from chips (walks, hops, flies, shoots, chases, crushes; spiky; slow ↔ fast) or type a sentence.
   - The `creature` call (low effort, about $0.02) pre-selects the chips. Offline, keywords do it.
   - A mini-stage shows it moving with gravity against a dummy player.
   - Save.
2. **From a level:** select any object, then "Save to library". Its strokes and behavior are kept.
3. **On paper:** the Creature Sheet (`dal2|lib|<game>`) has 6 boxes. Each box has a drawing area, a name line and checkboxes.
   - CV reads the checkboxes deterministically: a box counts as filled when its interior is more than 12% dark.
   - Strokes come from CV v2.
   - The name is read by a small perceive-style call. Offline, the creature is named "Creature N".

**Ways to place one:**
- Tap it in the editor's stamps tray. It snaps to the surface below.
- On canvas or paper, draw a rough blob and **write its name or its circled letter next to it** (within 2 cells).
  - Perceive receives the library names and letters and returns `library: [{target, library_id}]`.
  - The instance uses the library art at library size by default. A per-instance toggle, "use my new drawing", switches to the new blob.
  - Offline, or when unsure, the blob becomes a plain enemy with the Ask chip "Is this Grumpo?" showing library thumbnails.

**Reuse:**
- Libraries are per game.
- A level pins the library versions it used.
- Exported and remixed levels embed the objects they reference (`embedded_library`), so every level is self-contained.

### E.2 Game rules sheet (game-wide physics, abilities, lives, theme)

```jsonc
// shared/spec/game-rules.schema.json
{ "version": 3,
  "physics_profile": "v2-standard",          // v2-gentle | v2-standard | v2-snappy | v1-classic (migrated only)
  "abilities": { "run": true, "stomp": true, "double_jump": false, "wall_jump": false },
  "lives": "off", "hearts": 1,               // lives off|3|5, hearts 1..3
  "theme": "sketchbook", "music": true,
  "timer_pressure": false,                   // lets Challenging add timers
  "default_dial": "polished", "default_band": "normal",
  "player_library_id": null }                // the game's default character
```

- **On screen:** a Rules screen styled as a printed sheet with big checkboxes. A mini-stage shows the jump arc for the selected profile and abilities, so "double jump" is visible before you commit to it.
- **On paper:** the Rules Sheet PDF (`dal2|rules|<game>`) is a checkbox grid:
  - profile: Gentle / Standard / Snappy;
  - each ability;
  - lives and hearts;
  - 4 theme swatches;
  - music on/off.

  CV reads it with **no model** (fixed box positions in `template_spec_v2.json`). An optional "Story" line is read by the model to make the game title and blurb.
- **Effects:**
  - Rules are game-wide. Each level stores a resolved snapshot at publish, so later rule changes never alter published levels or invalidate runs.
  - "Apply to all levels" re-runs the bot over the game. Any level that becomes unbeatable is listed, for example after turning off double jump.
  - The bot and the designer always use the game's rules.

### E.3 Prompt-to-level: text → skeleton → repaired → verified draft you draw over

1. **Skeleton.** The `skeleton` call (low effort, about 11 s [M D]) returns a `Skeleton`: an ordered list of setpieces, each with a teach / test / twist / finale beat.
   - Offline, a keyword skeleton is used. Keywords map to setpieces: lava → lava gaps, key/door → key_door, tower/climb → tower, enemies → enemy_patrol, saw → saw_corridor. Easy/medium/hard set the band.
   - The default sequence is runway, gap, steps, enemy_patrol, platform_hops, rest, key_door if asked, finale.
2. **Layout.** `core/design/setpieces.ts` lays the setpieces out left to right with a cursor. Exact geometry comes from parameter tables tied to the physics envelope:

   | Setpiece | Easy | Normal | Hard |
   |---|---|---|---|
   | gap | 3 cells | 4-5 (walk) or 6-7 with ≥6 cells of runway | 8 with ≥8 runway |
   | steps | rise 1-2 | rise 2-3 | rise 3-4 (run) |
   | platform_hops | gaps 2-3 | gaps 3-4 | gaps 4-6, landings 2 |
   | enemy_patrol | 1 walker | 2 walkers / 1 hopper | chaser or shooter |
   | moving_bridge | 1 platform, 2 c/s | 2 platforms, 3 c/s | 3 platforms, 4 c/s + saw |

   The output is a SceneGraph whose objects have origin `draft`, with generated wobbly strokes in blue-line.
3. **Repair and verify.** Auto-repair, then the bot.
   - If the level is unsolvable, retry the skeleton call **once** with the bot's frontier in plain words ("the jump at setpiece 4 needs 9 cells; max is 9.1 with runway 6, you gave 3").
   - Then fall back to greedy repair.
   - This uses [M D]'s retry-once pattern. Setpieces carry their beats, which makes the teach → test → twist structure explicit.
4. **Design pass** at the requested band. "Medium" maps to Challenging · Normal.
5. **Draw over it.**
   - The draft opens in the editor as editable blue-line vectors and is playable with ▶ at once.
   - Kid marker strokes whose role overlaps a draft object (IoU ≥ 0.3) **replace** it: your ground wins.
   - Draft objects can be moved or deleted.
   - "Ink it" turns the remaining draft strokes into marker.

### E.4 Speedruns, replays and "beat my level"

- **Replay.**
  - Format: `{v:1, engine:"<core semver>+<profile hash>", level_id, level_version, frames, input}`.
  - `input` is base64 run-length encoding of 5 bits per frame (left, right, jump, run, down).
  - A 60 s run is 3600 frames, about 0.3-0.8 KB.
  - The physics is deterministic (§B.2), so a replay is the proof of the run.
- **Submitting a run.**
  - The client sends `POST /api/v2/levels/{id}/runs` with `{player, replay, claimed:{time_ms, deaths, coins, big_coins}}`.
  - The Node worker re-simulates the replay (≤ 50 ms for a 2-minute run).
  - The run is accepted only if it reaches the goal and the claimed numbers match exactly. Stamps are computed on the server.
- **Boards.**
  - Per level: top 10 verified times (**Any%** and **Collector**), each player's PB, and the creator's best.
  - Feed sorts: New, Hot (plays in the last 7 days), Hard (score), Most cleared.
  - Level cards show the difficulty badge, the measured clear rate, and the best time.
- **Ghosts.**
  - Up to 3 at once: your PB, the leader, and the challenger.
  - Each ghost is a 45%-alpha pencil copy of the runner's own character, stepped in lock-step from its replay.
- **"Beat my level".**
  - After a clear, "Challenge a friend" makes `#/play/<id>?vs=<run_id>`, shared with the Web Share API or copy-link.
  - The opener sees "Maya cleared this in 0:41.20 with 2 deaths. Beat it!" and races her ghost.
  - At the finish they see "You beat Maya by 1.32 s!" (or "0.4 s to go!") with a one-tap rematch.
- **Calibration loop** (Tier 2).
  - Each level stores anonymous per-day counts: attempts, clears and deaths.
  - Comparing measured first-try clear rate with the model's e^(−E) fits σ per band. The difficulty readout learns from real kids.
- **Names.** Free text, ≤16 chars, deterministic blocklist. No accounts (as in v1).

### E.5 Format v2 as a public spec, and v1 migration

**Files:**

| File | Contents |
|---|---|
| `docs/spec/level-format-v2.md` | normative prose |
| `shared/spec/level-v2.schema.json` | the level schema |
| `shared/spec/ink.schema.json`, `scene-graph.schema.json`, `edits.schema.json`, `game-rules.schema.json`, `library-object.schema.json`, `run.schema.json`, `replay.schema.json` | the other schemas (draft 2020-12, `additionalProperties:false`) |
| `shared/spec/physics-profiles.json` | the §B.2 numbers. **Normative**, so third-party engines can match. |
| `shared/spec/conformance/{valid,invalid}/*.json` | conformance fixtures |
| `shared/spec/messages.json` | UI strings (informative) |

**Level v2 shape:**

```jsonc
{ "format": "dal-level", "schema_version": 2, "engine_min": "2.0.0",
  "id": "lvl_…", "version": 1, "game_id": "game_…", "parent_id": null, "order_index": 0,
  "title": "Monster Meadow", "author": "maya", "created_at": "…", "license": "CC-BY-4.0",
  "world": { "cell": 16, "screens_x": 3, "screens_y": 1, "w": 144, "h": 27 },
  "rules": { /* resolved GameRules snapshot (E.2) */ },
  "source": { "kind": "paper|canvas|prompt|fixture|migrated_v1", "sheets": [ … ], "prompt": null },
  "ink": { "strokes": [ /* InkStroke */ ] },                    // editing: art source
  "objects": [ /* SceneObject: id, origin, role, stroke_ids, parts, geometry, relations, behavior, pinned, library_ref, confidence */ ],
  "edits": [ /* EditRecord (A.5) */ ],                           // editing: explained change log
  "compiled": {                                                  // PLAYING: all an engine needs
    "tiles": { "rows": ["....##==…"], "legend": ".#=/\\abcd~X" },
    "entities": [ /* typed: player_start, goal, checkpoint, coin, big_coin, key, door, spikes, saw, firebar,
                     moving_platform, crumble, falling, spring, enemy{archetype,…}, rising_lava, hint_arrow */ ],
    "triggers": [ { "when": "collect:k1", "then": "open:d1" }, { "when": "timer:90", "then": "lose" } ],
    "sprites": { "player": { "url": "…", "rig": { … } }, "objects": { "o9": "…/o9.png" } }
  },
  "design": { "dial": "polished", "band": "easy", "C": 0.14, "score": 13, "fastest_ms": 31120, "par_ms": 40500,
              "segments": [ … ], "flags": [], "solvable": true, "bot_route": [ … ] },
  "embedded_library": [ ],
  "meta": { "transcript": "…", "intent": "…", "warnings": [ { "key": "…", "args": {} } ],
            "build": { "stages": [ … ], "model_calls": [ … ], "cost_usd": 0.094 } } }
```

**What is normative for what:**
- `world`, `rules` and `compiled` are normative for **playing**. A third-party engine needs only these and `physics-profiles.json`.
- `ink`, `objects` and `edits` are normative for **editing and remixing**.
- `design` is informative.
- Published levels are immutable. An edit after publish creates `version` + 1 under the same id lineage, and runs pin `level_version`.

**Export and credit:**
- `GET /api/v2/levels/{id}/export` returns a zip with the JSON, sprites and the sketch.
- `GET /api/v2/games/{id}/export` returns the game manifest, levels, library and rules.
- Import is the reverse. The credits chain comes from `parent_id`. Mirroring to GitHub stays on the roadmap.

**v1 → v2 migration** (`vision/app/migrate_v1.py` at boot, idempotent; the TS mirror `core/build/migrate.ts` handles fixtures):

| v1 | v2 |
|---|---|
| `grid.rows` '1' | `#` tiles plus synthesized terrain objects (one per maximal horizontal run) so they can be edited |
| '2' runs with a solid neighbour | spike strip on that host, facing the open side. Other runs: `X` legacy tiles. |
| `moving_platform` / `enemy.patrol` / `bounce_pad` / `key` + `door` / `checkpoint` / `coin` / `goal` / `player_start` | the same entities, typed. A v1 enemy becomes `flyer horizontal` under `v1-classic` so it plays identically. |
| `backdrop_url` | `source.sheets[0].sketch_url`. Art is re-traced from tiles (§D.3), so there is one renderer. |
| physics | `rules.physics_profile = "v1-classic"` |
| — | Button **"Upgrade to v2"**: v2-standard, walkers with gravity, Faithful repair, new version |

Acceptance: every v1 fixture and seeded level migrates, validates, and is solvable under `v1-classic` with the same reachable set as the v1 solver.

---
## F. Starter World v2 (the first impression)

Five hand-authored levels follow a real curve: teach → test → twist → finale inside each level, and a rising sawtooth across the world [G §5, §7.4].

**Common settings:**
- Profile `v2-standard`; height 1 screen (27 rows).
- The main ground surface is at row 22.
- Checkpoints are placed so that every segment has F_s ≤ 30 s.
- Each level has exactly 3 big coins in risk spots (detour p_death ≥ 0.1).
- Par = ceil to 0.5 s of (1.3 × bot fastest).

| # | Level | Screens | Introduces | Casual C target | Bot fastest | Casual clear (model) | Tightest required window | Engaged enemies |
|---|---|---|---|---|---|---|---|---|
| 1 | Doodle Meadow | 3 | walk, jump, **run-up**, **stomp** | 0.10 ± 0.025 | 18-24 s | 40-60 s | ≥ 12 f | ≥ 1 |
| 2 | Spike Garden | 4 | spike strips, one-way ledges, tap hops, hopper | 0.30 ± 0.075 | 24-32 s | 50-75 s | 8-14 f | ≥ 1 per screen from screen 2 |
| 3 | Crumble Cliffs | 4 | crumble, moving ferry and lift, saws (rhythm) | 0.60 ± 0.15 | 26-34 s | 60-85 s | 8-12 f (phase windows ≥ 8 f) | ≥ 2 |
| 4 | Keyhole Castle | 5 | key/door, crusher, shooter, chaser, flyers; reprise of L3 faster | 1.0 ± 0.25 | 32-40 s | 70-90 s | 6-10 f | ≥ 3 |
| 5 | Ink Gauntlet (bonus, unlocked by clearing L4) | 3 | stomp chains over pits, everything tight | 2.0 ± 0.5 (Hard) | 24-30 s | 90 s+ | 5-8 f | ≥ 4 |

"40-90 s per level" in [G §7.4] is read as the **casual clear time**. A 3-5 screen level has a bot-fastest time of about 18-40 s at 10.5 c/s.

**Beat sheets** (x in cells):

- **L1 Doodle Meadow** (w = 144)
  - **Teach (0-47):**
    - flat start, then a 2-row step at x14-19;
    - a **safe 3-wide dip** at x23-25 (floor 2 rows down, walk out);
    - walker #1 at x36 on a 13-cell flat, with a 5-coin arc that draws the stomp bounce;
    - checkpoint at x45.
  - **Test (48-95):**
    - a 4-wide bottomless pit at x52-55;
    - 3 rising steps (2 rows each, 4 wide);
    - walker #2 at 2.5 c/s on the plateau (on the route);
    - a drop to a **12-cell runway** with a kid-text "run! →" sign, then a **7-wide gap** at x91-97 that you can only cross with a run-up.
    - **Big coin 1:** one row above the run-jump apex over that gap.
  - **Twist and finale (96-143):**
    - two walkers 3 cells apart. A held stomp chain reaches **big coin 2**, 7 rows up, which you cannot reach without the chain;
    - checkpoint at x119;
    - 4 one-way ledges rising 3 rows each to a hill, with the goal flag at x141;
    - **Big coin 3** on a high ledge off the staircase, reached with a precise run-jump.
- **L2 Spike Garden** (w = 192)
  - **Teach:** a 3-cell spike strip on flat ground; a platform half covered in spikes (land on the 3-cell safe half); a coin trail.
  - **Test:** a zig-zag tower of 4 one-way ledges 3 rows apart over a spike floor, with a walker on ledge 3; checkpoint on the top plateau.
  - **Twist:** a ceiling-spike corridor (spikes 5 rows above the floor) over 1-cell floor spikes. **Tap hops** of 1.1 cells clear the floor spikes, while full jumps hit the ceiling. Hopper intro.
  - **Finale:** one-way bridges over a spike pit with 2 walkers; goal.
  - **Big coins:** under a one-way ledge boxed in by spikes; above the corridor on a hidden one-way route; at the end of a spiky detour.
- **L3 Crumble Cliffs** (w = 192)
  - **Teach:** a 4-tile crumble bridge over a **safe** pit with a spring back up.
  - **Test:** a crumble run of 5 two-wide crumbles with 2-cell gaps over a bottomless pit (keep moving); a horizontal ferry with 8 cells of travel at 2.5 c/s over a 10-wide pit; checkpoint.
  - **Twist:**
    - static saws above a run-gap (jump low);
    - a vertical-path saw guarding a ledge, which creates a **phase window**;
    - a lift with saws beside it.
  - **Finale:** wait for a saw, then sprint across crumbles; ride a ferry past 2 path saws; goal on a cliff.
- **L4 Keyhole Castle** (w = 240)
  - **Teach:** a corridor with 2 crushers and a clear shake telegraph.
  - **Test:** shooters on ledges firing across a one-way tower; checkpoint.
  - **Twist:** the **key detour up** uses springs and crumbles, guarded by a **chaser** that chases you back down.
  - **Reprise:** the L3 crumble + saw rhythm at saw speed 4 c/s, right before the **door**; checkpoint after the door.
  - **Finale:** a climb through circling flyer bats to the keep; goal.
- **L5 Ink Gauntlet** (w = 144)
  - Stomp-chain over a 12-wide spike pit (bounce off 3 flyers).
  - Crumble + crusher combo.
  - Checkpoints about every 20 s.

**Authoring:**
- `shared/starter/world.ts` is a small DSL: setpieces plus explicit object overrides in cells, on the **same** setpiece layout engine as prompt-to-level (§E.3).
- Strokes are generated with seeded marker wobble, so the levels look hand-drawn and go through the real renderer.
- Build: `npm run starter:build` writes `shared/starter/dist/*.level.json`. `vision/app/seed.py` loads them as game "Starter World".
- A "Classic" game holds the migrated v1 levels. A v2 remix chain under L1 (maya: "spikes + Challenging Normal"; sam: speedrun) keeps the tree demo.

**Verification:**
- `npm run starter:verify` runs the bot with the casual and skilled profiles and fails if any target in the table is missed, if a fairness flag is raised, if any F_s > 30 s, or if any big coin is not optional and returnable.
- It writes `shared/starter/report.md`.
- Cross-check: the Faithful build of L1's bare skeleton, without its authored enemies, put through Challenging · Normal, must land at C ∈ [0.3, 1.0]. This proves the designer can produce L2-grade difficulty.

---

## G. v1 review fixes (all closed by v2)

| # | v1 issue | Root cause | v2 fix | Verified by |
|---|---|---|---|---|
| 1 | Duplicate win banner | `hud.ts:115` canvas card + `play.ts:106` HTML overlay [V] | One win moment: canvas confetti and slow-mo only, then one HTML results card (§D.9) | Test: on win the DOM has exactly one results card and the scene has no banner text; golden screenshot |
| 2 | Single brush tap too small to register | `canvas.ts:21` 8 px brush < `MIN_AREA_CELLS = 0.3` (`components.py:19`); the tap is also erased from the art (`pipeline.py:170-178`) [B F7] | 12 px marker; a tap stamps a 14 px dot; never-drop rule (≥ 0.03 cell² kept); blue dots become coins at any size | CV sweep: 6/8/10/12/20 px blue dots all become coins; G1-G6 coin counts exact |
| 3 | Enemies hover with no gravity | `Patroller.ts:6,38` [B F9, G] | Gravity by default; snap to host; ledge-aware walkers; only `flyer` hovers | G3/G6: enemy bottoms on the surface ±1 px; a non-ledge-aware walker falls off ledges in a unit test |
| 4 | Crunchy photo backdrops | `pixelArt: true` (`index.ts:68`), 768×432 stretched with pixelated rendering [V] | `pixelArt:false`, linear filtering, render scale r, vector re-ink; photo only as an optional 15% underlay | Test: canvas `image-rendering` is not pixelated; backing store ≥ 0.85 × displayed device px; visual review |
| 5 | Handwriting becomes solid tiles with the model off | `compile.py:394-408` depends only on the model's annotations; `heuristic.py:200-207` returns none [B F3] | Offline text and arrow detector (§A.3 rules 3-4); text and arrows never collide; uncertain black ink gets an "Is this writing?" chip | G4 model-off: 0 colliding cells from text components; reachable count ≥ the model-on v1 count (41) |
| 6 | Remix by re-scanning duplicates coins | Parent entities kept plus new CV coins with no de-duplication (`compile.py` compose, about :592) | Parent pickups printed as gray outlines; object-level remix diff (IoU/centre match); entity de-dup at 0.75 cell (§C.5) | Re-scan an untouched remix sheet: 0 new objects and an equal coin count |
| 7 | Canvas character box only partly wired | Shares the main tool colour (`canvas.ts:211-213`); nearest-neighbour 32×48 squeeze (`scan.py:116`); not kept or previewed [V] | Character Studio: own tools, live mini-stage, rig, library "player", persisted with the draft (§D.11) | Test: studio colour is independent; the character survives back-to-draw; the rig has ≥ 2 legs or synthesized legs; the sprite is rendered at r |

**Other v1 defects closed:**

| Defect | Cause | Fix |
|---|---|---|
| Zero-length "moving ground" crash | `MovingPlatform.ts:58` [V] | `set_role` guard, `fix_behavior`, per-entity try/catch, publish blocked |
| Raw codes in the UI ("goal_unreachable") | — | `messages.json` table |
| Typed rule binds the wrong object | `interpret.py:154-155` | One perception pass; editor binds by selection |
| Start placed mid-level or on a cave roof | `pipeline.py:113-118`; bbox-centre start [M] | §A.4 start rule |
| Goal = largest green | `pipeline.py:142` | Flag rule |
| Key silently becomes a coin | untyped `params` dict | Discriminated union plus Ask card |
| Art and collision disagree; coins and flag drawn twice | `LevelScene.ts:164-168, 226-249` | §D.3 |
| Whitening ghosts and floor notch | `compile.py:310-322` | No whitening; layered render from objects |
| HUD over ink; dev footer; thumbnails without entities; static preview overlays | [V] | §D.9, §D.10 |
| Solver ignores enemies, timing and coyote; fixed at 48×27 | `physicsSim.ts` | Core bot (§B.7) |
| Server never solves | `compile.py:638` | Every build stage is analyzed by the worker |
| No refusal fallback | non-beta `messages.parse` | Beta parse with `fallbacks="default"` |
| `setPointerCapture` throws on synthetic events | `canvas.ts:71` | Guarded |

---
## H. Build plan for a multi-agent implementation

### H.1 Lanes and exact file ownership

Six lanes. A lane writes **only** inside the paths it owns. Shared contract files change only through a "contract PR" that every lane owner approves (§H.2). New v2 code lives beside v1 until §H.7 retires the v1 files.

| Lane | Owns (write access) | Delivers |
|---|---|---|
| **A · Physics & Bot** (TS) | `web/src/core/physics/**`, `web/src/core/sim/**`, `web/src/core/bot/**`, `web/src/core/difficulty/**`, `web/src/core/replay/**`, `shared/spec/physics-profiles.json`, their tests in `web/src/core/__tests__/{physics,sim,bot,difficulty,replay}.*.test.ts` | Profiles; fixed-step deterministic sim (tiles, slopes, one-way, kinematic solids, every entity in §B.4-B.5, stomp, hearts and lives, checkpoint snapshots); `createSim`; `analyze` (reachability, route, windows, flags, camera rule, risk and slot lists); the difficulty model; replay codec and `verifyRun` |
| **B · Build & Design** (TS, spec owner) | `shared/spec/**` (except physics-profiles), `docs/spec/level-format-v2.md`, `web/src/core/types.ts`, `web/src/core/index.ts`, `web/src/core/scene/**`, `web/src/core/build/**`, `web/src/core/design/**`, `web/src/worker/**`, `shared/starter/**`, their tests | InkDoc helpers; heuristic perceiver; merge; remix diff; fit and compile; migrate; the full edit vocabulary with apply, invariants and autoRepair; candidates; greedy; applyPicks; setpiece layout plus the offline keyword skeleton; the Node worker (JSON-lines RPC); Starter World |
| **C · See** (Python) | `vision/app/cv/**` (new: `v2.py`, `ink.py`, `skeleton.py`, `features.py`, `stitch.py`, `rig.py`, `checkbox.py`, `annotate.py`; keeps v1 `rectify.py`, `calibrate.py`, `segment.py`), `vision/app/template/**`, `shared/template_spec_v2.json`, `vision/cli.py`, `vision/tests/test_cv_*.py`, `vision/tests/make_synthetic_v2.py`, `scripts/make_golden_inputs.py` | `run_scan_v2` → InkDoc (strokes, components, features, sheets, character); seam stitching; QR v2; annotated sheets for the model; rules and creature sheet checkbox reading; pack, remix, rules, creature and extend PDFs; synthetic paper goldens |
| **D · Mind & Platform** (Python) | `vision/app/mind/**` (client, schemas, prompts/*.md, perceive, design, skeleton, creature, fake, budget), `vision/app/build/**` (orchestrator, events, bridge), `vision/app/routers/**`, `vision/app/db.py`, `vision/app/spec.py`, `vision/app/migrate_v1.py`, `vision/app/seed.py`, `vision/app/main.py`, `vision/app/config.py`, `vision/pyproject.toml`, `vision/tests/test_{mind,orchestrator,api,runs,migrate,spec}*.py`, `scripts/golden.py`, `scripts/bench_build.py`, `scripts/dev.sh` | Model calls with fallbacks, deadlines and the cost ledger; staged orchestrator with SSE; worker bridge (pool of 2); every HTTP endpoint; SQLite v2; run verification and boards; migration; seed; golden runner; latency bench |
| **E · Feel** (TS) | `web/src/game/**` (v2 rewrite), `web/src/render/**`, `web/src/audio/**`, `web/src/game/__tests__/**` | `mountGame` v2 on the core sim with interpolation; input and touch; camera; PlayerView and rig animation; entity views; juice; HUD plates; ghosts; in-scene overlays and morph swaps; the ink renderer (clean, terrain alignment, spikes, sprites, pencil, blue-line, paper themes, parallax, `InkBoilFX`, chunking); Canvas2D thumbnails and editor underlay; audio synth and music |
| **F · Studio** (TS) | `web/src/editor/**`, `web/src/screens/**`, `web/src/ui/**`, `web/src/api.ts`, `web/src/main.ts`, `web/index.html`, `web/src/style.css`, `web/golden.html`, `web/src/golden/**`, `shared/spec/messages.json` (strings; B and D add keys by PR) | Vector editor, long canvas, stamps, live hints (core in a Web Worker), Character Studio, rules attached to strokes; scan pack tray; preview design report (cards, asks, dial, bot ghost, Fix-it, publish gating); play screen with results card, boards and challenge links; home feed, tree, library, rules and prompt screens; paper/ink chrome; golden review page |

Shared build plumbing:
- `web/package.json` is owned by F. Lanes A, B and E request scripts by PR: `build:worker`, `starter:build`, `starter:verify`, `golden:shots`.
- `vision/pyproject.toml` is owned by D.

### H.2 Cross-lane contracts (frozen at the end of Phase 0)

**1. Schemas** in `shared/spec/`:
- `ink`, `scene-graph`, `edits`, `level-v2`, `game-rules`, `library-object`, `run`, `replay`, `physics-profiles`, `messages`.
- They are mirrored by hand in `web/src/core/types.ts` (B) and `vision/app/spec.py` (D).
- Both sides validate `shared/spec/conformance/{valid,invalid}/*.json` in CI.

**2. TS core API** (`web/src/core/index.ts`):

```ts
// Lane B
export function inkFromStrokes(strokes: InkStroke[], world: World): InkDoc;
export function perceiveHeuristic(ink: InkDoc): SceneGraph;
export function mergePerception(g0: SceneGraph, p: PerceptionJson): { edits: EditRecord[]; asks: Ask[]; dropped: string[] };
export function build(i: { graph0: SceneGraph; edits: EditRecord[]; rules: GameRules; world: World;
                           repairUnsolvable: boolean }): { level: LevelV2; report: PlaytestReport; auto: EditRecord[]; rejected: EditRecord[] };
export function candidates(level: LevelV2, report: PlaytestReport, o: { dial: Dial; band?: Band; budget: Budget }): Candidate[];
export function greedy(level: LevelV2, report: PlaytestReport, o: { dial: Dial; band?: Band; deadlineMs: number }): { edits: EditRecord[]; level: LevelV2; report: PlaytestReport };
export function applyPicks(level: LevelV2, menu: Candidate[], picks: { cid: string; reason: string }[]): { edits: EditRecord[]; level: LevelV2; report: PlaytestReport; rejected: { cid: string; why: string }[] };
export function layoutSkeleton(s: SkeletonJson, rules: GameRules): SceneGraph;
export function keywordSkeleton(prompt: string, screens: number): SkeletonJson;
export function remixDiff(parent: LevelV2, ink: InkDoc): { matched: Record<number, string>; added: number[] };
export function migrateV1(v1: LevelV1): LevelV2;
// Lane A
export const PROFILES: Record<ProfileId, PhysicsProfile>;
export function createSim(level: LevelV2, o?: { startAt?: Cell }): Sim;
export interface Sim { readonly frame: number; step(input: number /* 5-bit L R J RUN D */): SimEvent[];
                       view(): SimView; snapshot(): SimSnapshot; restore(s: SimSnapshot): void; hash(): string }
export function analyze(level: LevelV2, o: { mode: 'fast' | 'full'; profile: 'casual' | 'skilled'; segments?: string[] }): PlaytestReport;
export function encodeReplay(inputs: Uint8Array): string;  export function decodeReplay(s: string): Uint8Array;
export function verifyRun(level: LevelV2, r: Replay): { finished: boolean; frames: number; deaths: number; coins: number; big_coins: number };
```

**3. Worker RPC** (B implements, D calls).
- Process: `node web/dist-worker/designWorker.mjs`, built with `npm run build:worker` (`vite build --ssr src/worker/designWorker.ts`).
- Protocol: one JSON object per line on stdio. Request `{id, method, params}`, response `{id, ok, result}` or `{id, ok:false, error:{code, message}}`.

| Method | Params | Result | Timeout (Python side) |
|---|---|---|---|
| `ping` | — | `{version, engine}` | 1 s |
| `perceive_heuristic` | `{ink}` | `{graph}` | 2 s |
| `merge_perception` | `{graph0, perception}` | `{edits, asks, dropped}` | 1 s |
| `build` | `{graph0, edits, rules, world, repairUnsolvable}` | `{level, report, auto, rejected}` | 3 s |
| `analyze` | `{level, mode, profile}` | `{report}` | 3 s |
| `candidates` | `{level, report, dial, band, budget}` | `{menu}` | 4 s |
| `greedy` | `{level, report, dial, band, deadlineMs}` | `{edits, level, report}` | deadline + 1 s |
| `apply_picks` | `{level, menu, picks}` | `{edits, level, report, rejected}` | 3 s |
| `layout_skeleton` | `{skeleton, rules}` | `{graph}` | 2 s |
| `remix_diff` | `{parent, ink}` | `{matched, added}` | 2 s |
| `migrate_v1` | `{level}` | `{level}` | 2 s |
| `verify_run` | `{level, replay}` | `{finished, frames, deaths, coins, big_coins}` | 2 s |

Bridge: `vision/app/build/bridge.py`, `class DesignWorker: async def call(method: str, params: dict, timeout: float) -> dict`. It runs a pool of 2 processes started in the FastAPI lifespan, restarts on exit, retries once, and is reported by `/api/health`.

**4. HTTP API** (D provides, F consumes through `web/src/api.ts`). All bodies are JSON unless marked.

| Method and path | Body | Returns |
|---|---|---|
| `POST /api/v2/builds` | multipart: `ink` (InkDoc JSON, canvas) or `photos[]` (paper), `typed_rules?`, `parent_id?`, `game_id?`, `pack_id?`, `dial` (default `polished`), `band?`, `character?` | 202 `{build_id, draft_id, events_url}` |
| `GET /api/v2/builds/{build_id}/events` | SSE, `Last-Event-ID` resume | `BuildEvent` stream |
| `GET /api/v2/drafts/{id}` | — | `{level, cards, asks, report, stages}` |
| `PUT /api/v2/drafts/{id}/edits` | `{statuses:{edit_id:"applied"\|"undone"}, kid_edits: EditOp[]}` | `{level, report, rejected}` (worker is authoritative) |
| `POST /api/v2/drafts/{id}/dial` | `{dial, band?}` | 202 `{build_id}` |
| `POST /api/v2/drafts/{id}/answers` | `{ask_id, choice}` | `{level, report}` |
| `POST /api/v2/levels` | `{draft_id, author, title?}` | `{level}`, or 409 `{message_key}` (unsolvable, engine error, unanswered ask, safety hold) |
| `GET /api/v2/levels/{id}[?version=]` | — | `{level, stats:{plays, clears, clear_rate, best}, children}` |
| `GET /api/v2/levels/{id}/tree` | — | nested tree with authors, versions and diff counts |
| `POST /api/v2/levels/{id}/runs` | `{player, replay, claimed, vs_run_id?}` | `{run_id, verified, rank, pb, stamps, vs?:{beat, by_ms}}`, or 422 if not verified |
| `GET /api/v2/levels/{id}/runs?board=any\|collector&limit=10` | — | runs |
| `GET /api/v2/runs/{run_id}` | — | `{run, replay, sprite_url}` |
| `POST /api/v2/levels/{id}/attempts` | `{attempts, deaths, cleared}` | 204 |
| `PUT /api/v2/levels/{id}/thumbnail` | PNG | 204 |
| `GET/POST /api/v2/games`, `GET /api/v2/games/{id}` | — | games feed (sort=new\|hot\|hard\|cleared) / game with ordered levels |
| `GET/PUT /api/v2/games/{id}/rules` | GameRules | GameRules (`version` + 1) |
| `GET/POST /api/v2/games/{id}/library`, `PUT /api/v2/library/{obj_id}` | LibraryObject | LibraryObject |
| `POST /api/v2/library/interpret` | `{name, text, ink}` | `{spec: CreatureSpec, source:"model"\|"keywords"}` |
| `POST /api/v2/prompt-levels` | `{prompt, game_id?, screens, dial, band?}` | 202 `{build_id, draft_id}` |
| `POST /api/v2/scan/rules-sheet`, `POST /api/v2/scan/creature-sheet` | multipart photo | GameRules patch / creature drafts |
| `GET /api/v2/templates/{pack.pdf?k=&game=, remix/{id}.pdf, extend/{id}.pdf, rules.pdf?game=, creatures.pdf?game=}` | — | PDF |
| `GET /api/v2/levels/{id}/export`, `GET /api/v2/games/{id}/export`, `POST /api/v2/import` | zip | zip / ids |
| `GET /api/health` | — | `{ok, llm:"live"\|"fake"\|"off", worker:"ok"\|"down", budget_left_usd}` |

**5. SSE events** (D emits, F consumes):

```ts
type BuildEvent =
  | { type: 'stage'; stage: 'upload'|'cv'|'ink'|'perceive'|'understood'|'design'|'polished'|'challenging';
      status: 'start'|'done'|'skipped'|'failed'|'late'; t_ms: number; note_key?: string }
  | { type: 'level'; stage: string; level: LevelV2; morphs: Morph[] }        // Morph: {object_id, from: Rect, to: Rect, kind}
  | { type: 'saw'; items: SawItem[] }                                          // "What I saw" rows (object id, role, relation text key, conf)
  | { type: 'edits'; edits: EditRecord[] }
  | { type: 'report'; report: PlaytestReport }
  | { type: 'ask'; ask: AskCard }
  | { type: 'suggestions'; edits: EditRecord[] }                               // late model picks (status 'suggested')
  | { type: 'cost'; usd: number; calls: number }
  | { type: 'done' } | { type: 'error'; message_key: string };
```

**6. Engine and renderer API** (E provides, F consumes):

```ts
export function mountGame(el: HTMLElement, level: LevelV2, o: {
  mode: 'play' | 'preview' | 'test'; assetBase?: string; startAt?: Cell;
  ghosts?: { replay: Replay; sprite?: string; label: string }[];      // ≤ 3
  overlays?: OverlaySpec;                                              // edit ghosts, bot path, flags; drawn in-scene
  audio?: boolean; reducedMotion?: boolean; debug?: boolean }): GameHandle;
interface GameHandle {
  on(ev: 'ready'|'win'|'die'|'coin'|'big_coin'|'checkpoint'|'entity_error', fn: (p: any) => void): void;
  swapLevel(level: LevelV2, o?: { morphs?: Morph[]; when?: 'now' | 'safe' }): void;
  setOverlays(o: OverlaySpec): void; pause(): void; resume(): void;
  restart(from?: 'start' | 'checkpoint'): void; replay(): Replay; destroy(): void;
}
// 'win' payload: { frames, time_ms, deaths, coins, big_coins_banked, replay }
export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, o?: { view?: Rect }): void;
export function drawInk(ctx: CanvasRenderingContext2D, level: LevelV2, view: Rect, o?: { style?: 'final' | 'underlay' }): void;
```

**7. Python internal APIs:**
- Lane C provides to D:
  - `run_scan_v2(images: list[bytes], pack_hint: str | None) -> ScanV2` (InkDoc, sheet infos, QR, character, warnings)
  - `render_annotated(ink: InkDoc, sheet: int, width: int = 1500) -> bytes`
  - `read_rules_sheet(img: bytes) -> dict`
  - `read_creature_sheet(img: bytes) -> list[CreatureDraft]`
- Lane D, internal:
  - `perceive(...)`, `design(...)`, `skeleton(...)`, `creature(...)`, all `async`.
  - Each returns `MindResult[T] = {value: T | None, latency_s, cost_usd, fallback_used, stop_reason, error}` and **never raises**.

### H.3 Phases and gates

| Phase | Work (lanes) | Gate (all must pass to start the next phase) |
|---|---|---|
| **P0 Contracts and spikes** | B: every schema, types and conformance fixtures. D: `spec.py`, plus a latency spike (≤ 12 calls, ≤ $1): slim `Perception` at low effort on the 4 [M] scenes, and `DesignPlan` at low on 2 menus; also confirm `AsyncAnthropic().beta.messages.parse` exists. A: `PROFILES` and physics-profiles.json. C: a v1-CV → InkDoc adapter to unblock others. E, F: API stubs. C + B: golden inputs and `expect.json` skeletons. | Conformance passes in TS and Python. Stubs compile. Spike numbers are in `docs/v2/latency.md`. If perceive p50 > 13 s, test `thinking: {type: "disabled"}` at low effort as a measured option (allowed at ≤ high effort); the Ink build stays the playable path either way. |
| **P1 Foundations** | A: sim (tiles, slopes, one-way, kinematic), v1-classic parity, fast analyze. B: heuristics, fit, compile, auto-repair basics, greedy unsolvable fix, worker. C: CV v2 strokes, annotate, QR v2. D: mind client, perceive, DB v2, orchestrator Ink stage, SSE, bridge. E: engine on core sim, renderer basics (paper, aligned terrain, spikes, sprites), DPR fix, camera, HUD. F: vector editor, long canvas, local ▶, preview shell. | Heuristic mode on G1-G6: **6/6 solvable after the Ink build**, 0 bumps, art offset ≤ 1 px, taps → coins 100%. Editor ▶ < 300 ms per screen. v1-classic envelope 3.61 / 7.33 cells. 60 fps desktop. |
| **P2 Understanding** | D: Understood stage, fallbacks, budget, cost ledger. B: merge, full repair vocabulary, invariants, stable ids. F: What I saw, change cards, Ask cards, local undo rebuild, publish gating, messages. E: morph swap, in-scene overlays, entity guard. C: paper polish. | Live G1-G10: role accuracy ≥ 95% vs `expect.json`; 0 pole walls; goals grounded 100%; Understood p50 ≤ 15 s; paper Ink build p95 ≤ 8 s; G4 with the model off has 0 text collision cells. |
| **P3 Designer** | A: windows, phase windows, flags, camera rule, full difficulty, calibration anchors. B: candidates, greedy, applyPicks, budgets, sawtooth. D: design call, 25 s deadline, late suggestions, dial endpoint. F: dial, difficulty pill, bot ghost, segment bars, Fix-it. | Polished p90 ≤ 25 s. Challenging · Normal reaches the band on ≥ 80% of G1-G14, with 100% still solvable and fair. `d_b14b143e` Faithful solvable with ≤ 3 choice edits of ≤ 3 cells each. `d_79eff85e` zigzag is a spike strip on the platform top, and Challenging · Normal gives C > 0.3 [G §10]. Calibration anchors pass. |
| **P4 Feel and content** | A: every Tier 1-2 entity, stomp, hearts and lives, replay record. E: juice table, audio, rig, parallax, boil, results moment, ghosts. B: Starter World plus `migrate_v1`. | `starter:verify` green. 60 fps on a Pixel 6 / iPhone 12-class phone in L4. Golden visual checklist passes. Reduced motion respected. |
| **P5 Extensions** | C: packs, stitching, multi-sheet remix, rules and creature sheets. D: runs, boards, attempts, library, creature call, rules endpoints, prompt-levels, export/import, boot migration, seed. F: pack tray, library studio, rules screen, prompt screen, boards, challenge links, tree diff. B: skeleton layout, keyword skeleton, remixDiff, library instances. | Every E2E flow in §H.6 passes. 20 recorded runs verify identically in Chrome, Firefox, Safari and Node. |
| **P6 Hardening** | All lanes: fallback drills (no key; injected timeouts; mocked refusal; worker kill), perf, README and spec docs, demo rehearsal, golden sign-off. | §H.6 is fully green. |

### H.4 Golden drawings (the quality bar)

Inputs live in `shared/golden/<id>/` with `input.*`, `expect.json` and `notes.md`. Most already exist in `docs/v2/diagnosis/`.

| Id | Source | Must show |
|---|---|---|
| G1 | `build/inputs/1_spike_hop.png` | pole → scenery and goal grounded; spikes are a 1-row strip on platform 1 pointing up; spawn cleared; tap → coin; solvable |
| G2 | `build/inputs/2_spike_cave.png` | wobbly floor with 0 bumps; wall-face spikes facing left with the wall still solid; ceiling spikes facing down; 4 coins |
| G3 | `build/inputs/3_monster_meadow.png` + "the monster walks back and forth" | canopy and trunk are decoration (no collision); sun is decoration; goal = the real flag; monster is a walker with its eyes merged and grounded; floor art intact; ≥ 50 reachable cells |
| G4 | `build/inputs/4_words_and_arrows.png`, model on **and** off | "jump!" and the arrow do not collide; platform moves +8 right; pole is scenery; solvable in both modes |
| G5 | `build/inputs/5_big_leap.png` | the 7-cell gap is a **run-gap** under v2 (≤ 8); solvable if the runway is ≥ 6, otherwise 1 nudge; the bot note says "needs a run-up"; lava strip at the pit bottom |
| G6 | `build/inputs/6_kid_full_level.png` + "the monster walks" | ramp = one slope with 0 bumps; **only** the monster walks (spawn spikes are a static strip on the ground); goal platform reachable after ≤ 1 choice repair; 3 coins |
| G7 | `model/inputs/canvas_floating_spikes` | matches `gt.json`; the jumpable 5-cell gap is **not** nudged |
| G8 | `model/inputs/canvas_wobbly_cave` | start not on the roof; 1-cell hole closed; 5-cell wall **lowered**, not lifted (topology cost); "lava!" text does not collide |
| G9 | `model/inputs/canvas_tower_key` | key opens the door (from text); door gates the goal; key reachable with the door closed; tree is decoration; "S" start honoured; ledge fragments grouped |
| G10 | `model/inputs/paper_synth_1` | paper path; "moves" + arrow binding; solvable |
| G11 | owner draft `d_b14b143e` | Faithful solvable with ≤ 3 choice edits; stepping stone is one-way; **the left ground stays ground**; 2 coins |
| G12 | owner draft `d_dfbfe619` | the black zigzag never becomes 1-cell walls (it is decoration or spikes with an "Is this spikes?" chip); solvable |
| G13 | owner draft `d_79eff85e` | red zigzag = spike strip on the platform top; Challenging · Normal C > 0.3 |
| G14 | owner draft `d_45f50934` | pit spikes kept; Polished C ≥ drawn C |
| G15 | synthetic 3-sheet paper pack | seams joined (continuous floor); sheet order from the QR; 144 wide and playable |
| G16 | studio creature "Grumpo" + a canvas level with a circled "G" next to a red blob | library instance with Grumpo's art and behavior |
| G17 | rules-sheet photo (double jump, lives 3, notebook) | exact GameRules patch |
| G18 | prompt "a lava cave where a key opens the exit, medium", live and keyword | solvable; key reachable with the door closed; door gates the goal; C in Normal |
| G19 | v1 fixtures + seeded remixes | migrate, validate, and give the same reachable set under v1-classic |
| G20 | G10 re-photographed: shadow gradient, 25° tilt, JPEG 60 | same objects as G10 within ±1 cell |

**`expect.json` format.** Objects are addressed by `near` (a cell within 2 cells of the object's bbox), so expectations survive id changes:

```jsonc
{ "id": "G3", "mode": "canvas", "prompt": "the monster walks back and forth",
  "objects": [ { "near": [9, 17], "role": "decoration", "collides": false },
               { "near": [9, 22], "role": "decoration", "collides": false },
               { "near": [44, 21], "role": "goal", "grounded": true },
               { "near": [20, 22], "role": "enemy", "behavior": "walker", "grounded": true, "parts_min": 2 } ],
  "counts": { "coin": 4, "enemy": 1 },
  "invariants": { "solvable_at": ["ink", "understood", "polished", "challenging_normal"],
                  "pole_walls": 0, "bumps": 0, "art_offset_px_max": 1, "reachable_min": 50 },
  "difficulty": { "polished_C_min": 0.1, "challenging_normal_C": [0.3, 1.0] },
  "latency": { "ink_s_max": 2.0 },
  "model_off": { "solvable": true, "text_collision_cells": 0 } }
```

**Screenshots.**
- `web/golden.html` shows each golden as input | Ink | Understood | Polished | Challenging, at camera positions start, middle and goal, with boil frozen (seed 1) at DPR 2.
- `scripts/golden_shots.mjs` (Playwright, optional dev dependency) saves them to `shared/golden/<id>/shots/` and pixel-diffs them against baselines (≤ 0.5% of pixels changed).

**Visual checklist** (a human, or an agent with the browser pane, signs off each golden):
1. Crisp lines at DPR 2, no stair-steps.
2. Feet touch the drawn line on every visited surface.
3. Spikes sit on their surface and point away from it.
4. Exactly one flag, and no doubled coins.
5. Additions read as pencil; decoration reads as soft.
6. The HUD sits on plates, never on ink.
7. No white cut-outs or ghost edges.
8. Side by side with the input, it "looks like my drawing, tidied".

### H.5 Automated tests

| Area | Command | What it checks |
|---|---|---|
| Physics (A) | `cd web && npm test -- core/physics` | Envelope within 0.1 cell for all 4 profiles; v1-classic 3.61 / 7.33; coyote, buffer and corner correction; slopes; one-way drop-through; platform carry; determinism (10k random frames → identical `hash()` twice) |
| Bot and difficulty (A) | `npm test -- core/bot core/difficulty` | v1 fixture parity (flat, too_wide_gap, too_tall_wall, key_door); v2 fixtures (one-way, slope, crumble timing, ferry phase, chaser); flags on crafted cases (blind jump, softlock, head bonk, tight window); calibration anchors (§B.7) |
| Build (B) | `npm test -- core/build core/scene` | An 8 px line at every sub-cell phase → exactly 1 surface; rises of 16/32/64/128 px over 400 px → one slope and 0 bumps (inverts [B sweeps]); spikes at gaps 0 / 6-20 / 24-48 px → a strip on the host face that never overwrites the host; pole → scenery; text does not collide; remix rescan → 0 new objects |
| Design (B) | `npm test -- core/design` | Every op: bound clamps, invariants, stable ids, undo/redo idempotence; owner drafts repaired; greedy reaches the band within budget; respect ratio |
| Replay (A) | `npm test -- core/replay` and `golden_shots` cross-browser | RLE round-trip; record → verify equality; identical results in Node and three browsers |
| Render and engine (E) | `npm test -- game render` + Playwright smoke | Thumbnails for all goldens render without throwing; terrain top alignment ≤ 1 px measured from rasterized alpha; entity error guard; exactly one win UI |
| CV (C) | `cd vision && uv run pytest -q tests/test_cv_*` | Centreline error ≤ 1.5 px and width ±1 px on synthetic strokes; dot sweep 6-20 px → coins; seam joins; QR v2; checkbox reading exact |
| Mind and orchestrator (D) | `uv run pytest -q tests/test_mind* tests/test_orchestrator*` | Schemas accepted by `beta.messages.parse` (mocked); fake mode; mocked timeout, refusal, max_tokens and invented ids → `None` or dropped; cost ledger and budget cap; stage order; deadline → greedy; late picks → suggestions; SSE resume |
| API and data (D) | `uv run pytest -q tests/test_api* tests/test_runs* tests/test_migrate* tests/test_spec*` | Publish 409s; run tamper → 422; export/import round-trip; every v1 level migrates; Pydantic ↔ schema conformance |
| Goldens | `python scripts/golden.py` (heuristic, in CI) / `--live --max-usd 3` | Every `expect.json` assertion → `shared/golden/report.{json,md}` |
| Latency | `python scripts/bench_build.py --live` | Stage p50 and p90 per golden → `docs/v2/latency.md` |
| Starter World | `npm run starter:verify` | §F targets |

### H.6 Acceptance criteria (a reviewer can check each one)

**Build quality**
1. `scripts/golden.py` heuristic mode: G1-G14 solvable at the Ink stage, and every `expect.json` invariant passes with the model off, except role assertions marked `model_only`.
2. Live mode: role accuracy ≥ 95% on G1-G10; G3 goal is the flag; G6 has exactly one walking enemy.
3. 0 pole walls, 0 bumps on fitted flat surfaces, art offset ≤ 1 px, and taps → coins 100% on all goldens.

**Mind**

4. Every build streams `ink` → `understood` → `polished` (or `skipped`) events; the Ink build arrives ≤ 8 s p95 (paper) and ≤ 2 s p50 (canvas).
5. Polished arrives ≤ 25 s p90. With the model stubbed to sleep 40 s, the greedy result ships at 25 s and the late picks arrive as `suggestions`.
6. Every edit card has a kid-readable reason, an Undo that rebuilds in < 150 ms per screen, ghosts on the stage, and a validator verdict. No raw codes appear in the UI (grep the DOM for `_` codes).
7. With `ANTHROPIC_API_KEY` unset, every flow works except model taste: drawing, ▶, building, Polished (greedy), Challenging, publishing (held for safety), play, runs and prompt-to-level (keyword skeleton).

**Gameplay**

8. Physics envelope tests pass. A run-gap of 7 cells cannot be cleared walking but can with a 6-cell runway.
9. Stomp, the six archetypes with gravity, spikes with facing, one-way platforms, crumble, springs, moving platforms, saws, key/door, checkpoints, big coins (banking), hearts and lives each have a vitest and a playable fixture in `#/dev`.
10. The difficulty readout shows the band and "~1 fall in N tries". Challenging · Normal lands in [0.3, 1.0] on ≥ 80% of G1-G14. No output anywhere raises a fairness flag.

**Scrolling**

11. A 6-screen level plays at 60 fps on a mid phone. The camera look-ahead keeps every run-jump landing on screen. The minimap works.
12. A 3-sheet paper pack scanned out of order stitches into one level (G15). Remix re-scan creates no duplicates.

**Visual**

13. Golden visual checklist signed off for G1-G20. Canvas is not pixelated. Boil, paper theme, parallax, rig animation, particles and synth audio are all present and can be muted or reduced.
14. Exactly one win moment, with the results card (time, PB, stamps, deaths, coins, creator time).

**Extensions**

15. Library: create Grumpo in the studio, place him by stamp and by circled "G" on canvas, and he walks with his own art (G16).
16. Rules sheet: switching to v2-gentle and double jump changes the bot's reachable set and the mini-stage arc; G17 sheet photo gives the exact patch.
17. Prompt-to-level: G18 produces a solvable blue-line draft in ≤ 25 s live (≤ 2 s keyword). Drawing ground over it replaces the draft ground.
18. Runs: a recorded clear verifies on the server. A tampered replay or claim is rejected. `?vs=` shows the ghost and "You beat Maya by X s".
19. `docs/spec/level-format-v2.md` + schemas + conformance fixtures are published. Export → import round-trips a level byte-identically, apart from ids.

**Starter World**

20. `starter:verify` is green for the §F table (C bands, windows, F_s ≤ 30 s, engaged enemies, optional big coins). L1 has an enemy on the required route.

**v1 fixes**

21. All seven items in §G have a passing test, plus the extra defect table.

**Robustness**

22. Killing the worker mid-build gives the "builder restarting" message and recovers on retry.
23. An injected degenerate entity never crashes the scene: the entity is disabled and publishing is blocked with a sentence.
24. The budget cap switches to model-off.

**Cost**

25. `meta.build.cost_usd` ≤ $0.12 for a 1-screen Polished build and ≤ $0.30 for a 4-screen Challenging build (averaged over the live golden run).

### H.7 v1 files retired or replaced (at the end of P5)

**Retired:**
- `web/src/solver/*` → `web/src/core/bot`
- `web/src/game/{LevelScene,Player,hud,tiles}.ts` and `behaviors/*` → v2 `web/src/game` + `web/src/render`
- `web/src/screens/{canvas,preview,scan}.ts` → editor and v2 screens
- `vision/app/compile.py`, `vision/app/llm/*` → `core/build` + `core/design` + `vision/app/mind`
- `vision/app/routers/scan.py` → `builds.py`
- `shared/level.schema.json` → kept as `shared/spec/legacy/level-v1.schema.json` for migration
- `shared/behaviors.md` → `docs/spec/level-format-v2.md` §Behaviors

v1 routes stay as 301 aliases to v2 until P6.

---

## Appendix: risks and mitigations

| Risk | Mitigation |
|---|---|
| A custom physics core replacing Arcade could feel different or regress | Port v1's tile rules (already ported in `physicsSim.ts`); envelope tests against `proposed_physics.py`; v1-classic parity; Phase 1 gate |
| Perception latency p90 at 15 s on busy drawings; long levels | Slim schema, per-sheet parallel calls, the Ink build is always playable, 25 s deadline with greedy; Phase 0 measurement gate |
| A menu-only designer could feel less creative | The generator spans the full vocabulary, including reprise macros. `asks` and `summary` let the model shape intent. The vocabulary grows by spec PR, never by model freedom. |
| σ and difficulty calibration come from a model, not from kids | Bands are relative and tested on anchors; clear-rate telemetry recalibrates σ (§E.4) |
| Top-edge straightening may feel "less mine" | Shifts are capped at 8 px; texture and bottom edge are kept; "my original sketch" underlay; Faithful shows exactly what moved |
| Node worker process management inside FastAPI | Pool of 2, auto-restart, health endpoint, 1 retry; worker failure is explicit and never silent |
| Replay determinism across browsers | No trig or random in the core, integer frames, cross-browser test in P5; the server verification is authoritative |
| Scope across 6 lanes | Tiers (Tier 1 must, Tier 2 should, Tier 3 later: ladders, gravity flip, wind); phase gates; contracts frozen at P0 |
| Real kid drawings are messier than the goldens | Collect 20 real photos in P2; confidence chips; G20 robustness golden |
| Phone performance (vector ink, boil, particles, long worlds) | Chunk LRU, PostFX boil (no texture variants), particle cap 300, auto-degrade below 50 fps |
