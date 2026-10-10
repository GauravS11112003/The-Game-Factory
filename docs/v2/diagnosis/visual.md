# Diagnosis 3: visual and create-flow UX quality

Reviewed as art director + UX lead, 2026-10-10, against the running app (live model mode) in the browser pane (701 CSS px wide, DPR 2) and the v1 sources. Raw per-screen observations are in `docs/v2/diagnosis/visual/notes.md`. Screenshots are described there because the pane can't save image files.

## Verdict

The owner says the build after drawing is "extremely poor quality". The cause is that v1 has **no art pipeline**. The output is a nearest-neighbour upscale of a raster photo of your strokes, with invisible, blocky collision on top that doesn't match the ink, and a few procedural doodles stuck on top in a second style. Nothing is cleaned, animated, layered, lit, voiced or celebrated. The create flow has the same problem from the other side. The draw tool is MS-Paint-class: raster, fixed 48x27 screen, half-cell brush. The preview shows you overlays of the outcome. It never says *what it understood or why*. When the interpretation goes wrong (my test drawing turned the starting floor into a zero-length moving platform), the engine crashes silently and the UI only shows "goal_unreachable".

One drawing session reproduced every complaint:

| I drew | v1 built |
|---|---|
| Left ground stroke | `moving_platform` with path `[[0,23],[0,23]]`. It removed the floor from the grid and crashed the scene (`RangeError` in `MovingPlatform.startLeg`, MovingPlatform.ts:58), so there was no HUD, no rules and no timer |
| "high platform moves 4 cells" | Also made a moving platform (correct). Its dashed preview marker stays put while the sprite slides away |
| Red line resting on the ground | Hazard tiles floating 1-2 rows above the floor, 2 rows thick |
| Red line under the gap | Hazard tiles hanging in mid-air below the pit |
| Slightly tilted platform | 2-row stair-step collision block |
| Two blue coin taps | Nothing. Dropped below `MIN_AREA_CELLS` (cv/components.py:19), with no warning |
| Green flag | The drawn flag stays in the backdrop, and the engine adds its own ink flag too (two goals) |
| Character | Spawned at x=0, half off-screen |

Round trip was about 5 s, which is fine. Quality is the problem, not speed.

## 1. How the drawn art is rendered

**Photo backdrop crunch (critical).** `mountGame` sets `pixelArt: true` (web/src/game/index.ts:68). The canvas is a 768x432 backing store (index.ts:65-77, `scale.mode FIT`) shown with `image-rendering: pixelated`. In the pane that is 669 CSS px x DPR 2 = 1338 device px, a **1.74x non-integer nearest-neighbour stretch**. On a 1100 px desktop stage it is about 2.9x. Anti-aliased marker strokes come out as stair-steps with uneven widths, and the LANCZOS-resized crops (compile.py:300) get re-aliased. Pixel-art filtering on hand-drawn art is the wrong choice in every case.

**Collision does not match ink (critical).** Collision is an invisible 16 px tile layer (LevelScene.ts:175-205, alpha 0 unless debug), and the visual is the untouched photo. A thin 8 px stroke becomes a 1-2 row block wherever its bbox lands, so the player stands in the air above lines or sinks into them. Tilted strokes become staircases, and spike strokes become hazard rectangles larger than the red line. Nothing ever re-draws the ink to match the physics, or snaps the physics to the ink.

**Two art styles in one frame (major).**
- Published starter levels use `seed.render_backdrop` (vision/app/seed.py:38): flat, square, programmatic black blocks with no paper texture.
- Entities use the procedural doodle renderer in tiles.ts (rounded ink slabs, blob enemy, spring, flag).
- Drawn levels use the raw photo.

So Spike Valley shows a rounded ink moving platform on flat clip-art ground. The fixture path, which renders the same grid with `renderInkBackdrop`, looks better than the published level.

**Erase artefacts (minor).** `_whiten_mask` / `_whiten_bbox` (compile.py:310-322) paint white over components that become entities. This leaves faint ghost edges and white boxes cut out of neighbouring ink, such as a spike strip that overlaps the ground's bbox.

**Sprite quality (major).**
- The default player (`drawPlayerDoodle`, tiles.ts) is charming but a single static frame.
- A custom character is squeezed into 32x48 at upload, then shown nearest-neighbour.
- Coins are 12 px dots, and the goal is a 24x32 flag drawn even when the user drew their own.
- Enemy crops have no gravity (Patroller.ts header: "a monster drawn in mid-air hovers"), so they float.

**No animation (major).** Player feedback is `setFlipX` plus a 160 ms squash on jump/land (Player.ts:128-185). There is no run cycle, no idle breathing, no blink, no lean, no anticipation and no landing dust. Nothing in the world moves except coin bob, patrol and platform tweens. The ink never "boils".

**No particles or juice (major).** The only particle emitter is the gray `puff` used when doors open (LevelScene.ts:334). Coins pop as a `+1` system-font text. Death is a tint, a 40 degree rotation and a 300 ms shake with no splat. The win only wobbles the flag. There is no hit-stop, no screen flash, no trail and no confetti.

**No sound (major).** The game is mounted with `audio: { noAudio: true }` (index.ts:71). There is no jump, coin, death, bounce or win sound, and no music.

**Flat camera, wasted canvas (major).** The world is exactly one screen (`setBounds(0,0,GAME_W,…)`, LevelScene.ts:138), and the camera never moves. Starter levels use the bottom 5 of 27 rows, so about 70% of every frame is blank paper. First Steps is won in about 5 s by holding right (768 px / 160 px/s = 4.8 s). There is no parallax, no depth and no sense of a place.

**HUD and win screen (major).** The win is shown twice. `Hud.showBanner` paints a canvas card (hud.ts:115), and play.ts:106 adds an HTML `.win-overlay`. I confirmed both are visible together, with "You made it!" ghosted twice and buttons over the card. HUD text sits on top of ceiling ink in Key Cave, and time is not shown on win.

**Chrome (minor).** Every screen is a generic dark dashboard: `#111318`, system-ui and blue buttons (style.css:2-36). Nothing echoes paper or ink. Thumbnails of seeded levels are the flat backdrop PNGs with no coins, flag or player (thumbnails.ts:104), so they all look like the same white box with a black strip. The home page footer shows "Backend ok · vision model live" plus engine fixture links.

## 2. How the drawing tool feels

- **Raster-only surface.** canvas.ts keeps a single bitmap and 25 ImageData undo snapshots (canvas.ts:45-120). There are no stroke objects, so strokes can't be selected, moved, recoloured, cleaned or re-labelled, and there is no redo.
- **Brush is half a cell.** `BRUSH_PX = 8` while a cell is 16. Taps leave about 5 px dots that CV discards (`MIN_AREA_CELLS = 0.3`), so the coin colour mostly doesn't work. The legend says "Draw thick", which pushes the tool's job onto the user.
- **No shape aids.** There is no line or rect tool, no hold-to-straighten, no grid snap and no stamps (coin, flag, spikes, enemy). Platforms come out wobbly, then get rasterised into staircases.
- **No live understanding.** You learn what a stroke means only after a 5 s round trip and a page swap. While drawing there is no ghost ("this will be ground"), no jump-arc preview, and no reachability halo from the start.
- **Colour = meaning is hidden.** Meanings live in `title` tooltips and a gray legend line. Swatches have no icons, and only four meanings exist. There is no way to say "this red blob is an enemy, not spikes" except prose rules.
- **Fixed 768x432.** There is no zoom, no pan and no long canvas. On a phone the canvas is about 340 px wide, so a cell is about 7 px under a finger. That rules out Mario-length levels.
- **Character box is barely wired.** It is a separate 128 px canvas with its own undo/clear that shares the main tool colour. There are no frames or poses, no preview of the character in the world, and no reuse.
- **Rules are a bare textarea.** There is no autocomplete from the fixed vocabulary, and it isn't tied to strokes (you can't point at "this platform"). A typed rule is later shown as "Read from the sheet".
- **Back to drawing** re-shows the raster as it was. There's no way to keep the system's fixes, because there are none.

## 3. How the preview communicates what the system understood

- **It shows outcomes, not understanding.** Toggles for Solver / Tiles / Markers paint green standing cells, gray tile blocks and dashed bboxes (preview.ts:51-125). It never says "I saw 7 strokes: 3 ground, 1 moving platform, 2 spike strips, 1 flag; I ignored 2 dots".
- **Dropped strokes are silent.** The coins vanished with no warning.
- **Errors are in machine language.** You get `goal_unreachable` as a raw code next to the sentence, and "moving platform 5 has no room to move" uses component ids that only exist in `annotated.jpg`, which is never shown.
- **Engine failures are invisible.** The scene crashed (no HUD, rules or timer), yet the preview still offered Publish.
- **The overlay contradicts the game.** Static dashed markers sit where moving sprites used to be, and the S marker and "moves" label overlap at the spawn.
- **There is no notion of an edit.** v1 has nothing to accept or undo. The only remedy is "Back to drawing" and redraw.
- **The solver is binary.** Reachable or not, with green cells. It gives no path, no "this jump needs 7.4 cells, max is 7.3", and no difficulty read.
- The title defaults to "Untitled level", and there is no thumbnail or name suggestion.

## 4. What a phenomenal version looks like

### 4a. Hand-drawn aesthetic done right ("living ink")

1. **Vectorise the ink.** CV/skeletonisation turns each component into polylines (centreline + width) with simplification (Ramer-Douglas-Peucker), Chaikin smoothing and a straighten pass for near-horizontal platforms. The engine renders **cleaned strokes** from these vectors at device resolution, with `pixelArt: false`, `resolution: devicePixelRatio`, roundPixels off for art and on for physics. The raw photo becomes an optional "original sketch" layer at 15% opacity behind the cleaned ink.
2. **Ink matches physics, by construction.** Ground is drawn *from* the collision geometry. Each solid run gets a marker-stroke top edge following the cleaned polyline, a cross-hatch or scribble fill below, and slope tiles or one-way platforms where the stroke tilts. Spikes are drawn as triangles oriented away from the surface they are snapped to (see diagnosis 1: the repair pass). What you see is exactly what you stand on.
3. **Line boil.** Render 3 jitter variants of every stroke (seeded noise on the vertices, ±0.6 px) and cycle them at 8-12 fps. This is the classic hand-animated "boil", it is cheap (3 cached textures per layer), and it makes the whole page feel alive.
4. **Paper.** A procedural paper grain (fBm noise) plus subtle notebook dot grid, a vignette, and a faint coffee-stain or fold detail per game theme from the rules sheet.
5. **Parallax and depth.** 2-3 background layers of auto-generated light pencil doodles (hills, clouds, grass tufts) at 0.2/0.5 scroll factors, plus a foreground layer of grass and ink splats at 1.1. Generate them deterministically from the level seed and theme so every level has a place.
6. **Characters with life.** Build a procedural rig for the drawn character: split the doodle into body + legs (or synthesise stick legs as v1 does). Give it a run cycle (leg swing, 2-frame bob), idle breathing (scaleY 1.0-1.03), blinks, a lean into motion, and squash/stretch on jump, apex and land. Enemies get gravity (fixing the v1 hover bug), a 2-frame waddle and an angry flash when you get close.
7. **Juice.** Particle systems (pre-baked ink-dot textures):
   - dust puffs on land and turn
   - coin sparkle bursts plus a coin flying to the HUD counter
   - ink-splat death (the character shatters into strokes, then reassembles at the checkpoint)
   - bounce-pad shockwave rings
   - checkpoint flag unfurl
   - a goal confetti of tiny scribbles
   - hit-stop of 60 ms on death or stomp, and a short screen flash

   The camera should have look-ahead, a deadzone, vertical lerp, and screen-shake scaled by event.
8. **Synthesised sound (WebAudio, no assets).** Small oscillator+envelope recipes (sfxr-style):
   - jump: square sweep up
   - coin: two-note triangle arpeggio, pitch rising with combo
   - land: filtered noise thump
   - death: down-sweep + noise
   - bounce: "boing" FM
   - win: 4-note jingle

   Add an optional generative 4-bar loop per theme. Include a mute toggle and respect autoplay unlock.
9. **Scrolling world.** A long canvas (for example 48xN cells) or stitched sheets, with a following camera, world bounds from the level and a minimap strip in the HUD. This is extension 2. The renderer must chunk ink textures (for example 1024 px tiles) for memory.
10. **One HUD, one win moment.** Delete the HTML win overlay or the canvas banner (keep the HTML for buttons, and use the canvas only for the confetti moment). The results card shows time, coins, deaths and a speedrun ghost/PB (extension 6). Use hand-lettered type (load one Google font such as "Patrick Hand" / "Gaegu" across chrome and HUD). The chrome adopts the paper/ink identity: paper cards, marker underlines, tape corners.

### 4b. Drawing tool that knows it's making a level

- **Stroke model, not bitmap.** Store strokes as vectors `{points, color, width, tool}` with real undo/redo and select/move/delete. Rasterise only on submit, and send the vectors to the backend too.
- **Brush tuned to the grid.** A 12-14 px marker with pressure (pointer.pressure). A tap always stamps a full-cell dot, so coins register. Add hold-to-straighten (like Procreate QuickShape) and an optional light snap to cell rows.
- **Stamps and semantic swatches.** Swatches get icons (ground, spikes, goal, coin, enemy, moving, bounce, door, key, checkpoint), and a "ink" tool lets the user draw freely with a meaning attached. Pick from the object library (extension 3) and drop a saved creature.
- **Live local understanding while drawing.** The same CV runs client-side or in a debounced backend call, and every stroke gets a faint label chip ("ground", "spikes ↑", "coin"). Add a jump-reach halo from the start flag and a red dashed marker on any gap wider than 7 cells. The user sees intent before submitting.
- **Long levels.** Pan with two fingers or space-drag, zoom with pinch or the wheel, and a "+ add screen" button that extends the canvas right. A minimap shows the whole level.
- **Rules attached to things.** Tap a stroke, then "what does it do?" opens a chip picker over the fixed vocabulary (moves ↔ N cells, patrols, bounces, opens door X) with free text as fallback. The typed rule highlights its target.
- **Character studio.** A larger character canvas with an onion-skin of the player bbox, a live preview of the doodle running in a mini stage, and "save to library".

### 4c. Preview = "Here's what I understood + what I changed"

Use a split view: on the left the cleaned, playable level; on the right a **design report** in three sections. Each item is clickable and highlights its region on the stage.

1. **What I saw.** Each detected object with its role and relation, in plain words, with a thumbnail of the source stroke:
   - "Ground, 3 pieces."
   - "Spike strip on top of the left ground, pointing up."
   - "Moving platform (from your rule) — moves 4 cells left↔right."
   - "Flag = goal."
   - "2 small blue dots — I think these are coins."

   Ignored strokes are listed with a reason and a "this is actually a…" re-label button.
2. **What I changed.** An edit list in the FIXED vocabulary (snap_spikes, straighten_platform, close_gap, ground_goal, clear_spawn, nudge_jump, add_checkpoint, add_coin_trail…). Each edit has a one-line reason ("this jump was 8 cells; max is 7 — moved the ledge 1 cell left"), a before/after ghost on the stage, and **Accept / Undo** toggles plus "Undo all". Edits are applied and physics-validated by deterministic code, and the report shows the validator's verdict per edit.
3. **How it plays.** Bot playtest results:
   - an animated ghost of the solver path
   - time-to-beat
   - jumps rated tight/blind/safe
   - dead ends
   - "no checkpoint for 40 s"
   - a difficulty dial

   Each comes with a suggested fix (as an edit the user can accept).

Also:
- Raw codes are never shown; all text comes from a message table.
- A level that fails to build (engine exception or validator failure) is never publishable. It shows "I couldn't build X; here is why" and offers to retry interpretation.
- Overlays are rendered *in the Phaser scene* (a debug camera layer), so markers move with sprites.
- The title suggestion and an auto-thumbnail rendered by the new ink renderer are created at publish.

## Ranked problems (feeds the orchestrator)

1. **Critical.** The interpretation can produce structurally broken levels: a ground stroke becomes a zero-length moving platform. The engine then crashes silently (MovingPlatform.ts:58 recursion), and the preview still allows publishing.
2. **Critical.** Rendered ink doesn't match collision: blocky bbox tiles under thin strokes, staircases, floating spikes (LevelScene.ts:175-205 + raw backdrop).
3. **Critical.** Crunchy rendering: `pixelArt: true` + 768x432 backing store + `image-rendering: pixelated` at non-integer DPR scale (index.ts:62-77).
4. **Major.** The preview has no "understood/changed" model, no per-edit accept/undo, and errors are in machine language (preview.ts).
5. **Major.** The drawing tool is a raster MS-Paint: 8 px brush loses coin taps, there are no stroke objects, redo, shape aids, live feedback, zoom/pan or long canvas (canvas.ts).
6. **Major.** No animation, juice, particles or sound (Player.ts, LevelScene.ts, `noAudio: true`).
7. **Major.** A single static screen with 70% empty paper. Levels win in about 5 s holding right, and there's no camera, parallax or scroll.
8. **Major.** Art style is inconsistent: seeded flat-block backdrops, ink doodle entities and the raw photo all appear together. The user's goal flag is duplicated by the engine flag.
9. **Minor.** Duplicate win banner. HUD collides with ceiling ink. Generic dark dashboard chrome. Thumbnails omit entities. Dev footer on home.
