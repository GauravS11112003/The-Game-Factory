# Visual diagnosis: raw browser notes (2026-10-10)

Browser pane viewport: 701 CSS px wide, devicePixelRatio 2 (screenshots 800x974). App in LIVE model mode.
Screenshots could not be saved as files (pane returns them inline only; region zoom unsupported), so they are described here.

## Home `#/`
- Generic dark "admin dashboard" chrome (#111318, system-ui, blue primary buttons). No paper, no ink, no character, no motion. Nothing says "game".
- One game card "Starter World": thumbnail is a stark white rectangle with flat black blocks along the bottom ~25%; no coins, flag or player visible (seeded backdrop.png only contains the grid).
- Footer line shows "Backend ok · vision model live" plus engine fixture links: dev text on the consumer home page.

## Game page `#/game/game_starter`
- 3 rows, each a 200x113 thumbnail + title + Play/Remix/Tree. All three thumbnails read as nearly empty white boxes with a black strip at the bottom; levels 1 and 2 are indistinguishable at a glance.
- "Add a level" card with Draw / Scan / Print. Functional, but zero visual hierarchy or delight.

## Play `#/play/lvl_starter1` (First Steps)
- Stage 669 CSS px wide. Top ~70% of the screen is empty white paper; all geometry lives in the bottom 5 rows of 27.
- Ground and the pyramid are hard-edged flat black rectangles (the seeded backdrop.png is a programmatic render: square blocks, no ink texture, no dot paper). The fixture version of the same level (ink renderer) looks better than the published one.
- Player: cute wobbly smiley doodle with stick legs, 32x48, static texture. No walk cycle, no blink, no idle; only flipX and a 160 ms squash on jump/land.
- Coins: 12 px blue dots, bob 2 px. Goal: small green ink flag.
- HUD: Chalkboard-style text "0 / 5", "x 0", "restart" at top. Fine but small.
- Played with held ArrowRight + 2 jumps: WON in about 5 s, 0 deaths, 2/5 coins. 768 px at 160 px/s = 4.8 s minimum; the level is basically "hold right".
- Win: DUPLICATE banner confirmed. Canvas card "You made it! 2 / 5 coins · 0 deaths" renders underneath the HTML `.win-overlay` "You made it!" heading; the two titles overlap with a visible ghosted double text, and the HTML buttons sit across the canvas card. No time shown, no stars, no confetti, no sound.

## Play `#/play/lvl_starter2` (Spike Valley)
- Same flat-block backdrop; spike pits are rows of small red triangles. The moving platform and the bounce pad are drawn with the ink renderer (rounded, marker streak, red spring) on top of the flat programmatic backdrop: two art styles in one frame.
- Died once to spikes: tint red + rotate + fade + 300 ms camera shake, respawn at start. No particles, no sound, no checkpoint.
- Goal sits on a ledge reached from the bounce pad; still a ~10 s level.

## Fixture `#/play/fixture/starter_3_key_cave` (for comparison)
- Ink renderer path: dot paper, rounded ink slabs, spikes, red enemy blob with eyes, key, door with planks, gray checkpoint flag. Clearly the better look, but HUD text sits on the black ceiling row (black text on black ink, only the white stroke keeps it legible) and "restart" overlaps the ceiling.

## Draw `#/draw?game=game_starter`
- Toolbar: 4 round swatches (black/red/green/blue), Eraser, Undo, Clear. Legend line "black = ground · red = spikes · green = goal · blue = coins. Draw thick; one cell is 16 px."
- Canvas 768x432 shown at 669 CSS px with a 16 px dot grid; brush 8 px = half a cell; fixed size, no zoom, no pan, no long levels, no redo, no shape/line tool, no stamps, no snapping, no live "what this will become" feedback.
- Drew: two black ground strokes with a gap, a slightly tilted mid platform, a tilted high platform, a red line just above the left ground (spikes "on" the ground), a red line below the gap, a green flag (pole + hook), two blue taps (coins), a blue round face in the character box, rule text "the high platform moves left and right 4 cells; timer 45".
- Blue taps render as ~5 px dots: obviously too small, and indeed they were NOT detected (no coin entities, no warning).
- Synthetic pointer events from devtools throw in `setPointerCapture` (canvas.ts:71) and abort the stroke; real mouse works.

## Preview (draft d_b14b143e, ~5 s round trip)
- Heading "Preview", toggles Solver/Tiles/Markers, red notice "Goal can't be reached. ... goal_unreachable" (raw code leaks), yellow warning "moving platform 5 has no room to move" (component ids the user never saw; the annotated id image is not shown).
- What the system built (from draft JSON):
  - The LEFT GROUND (component 5) became a moving_platform with path [[0,23],[0,23]] (zero length). The intended "high platform" (component 1) also got motion. So the floor you start on is an entity, not ground.
  - Both coins lost.
  - Red line above the ground became hazard tiles floating at rows 22-23; red line under the gap became hazard tiles at row 25 hanging in mid-air: spikes placed with zero thought about surfaces or orientation.
  - Tilted mid platform became a 2-row stair-step collision block (rows 17-18 offset).
  - Right ground collision row 24 stops at x=43 while the stroke runs to x=47.
  - Player start at x=0: custom sprite half off the left edge; "S" marker and "moves" label overlap.
  - Goal at (45,21): the drawn green stroke stays in the backdrop and the engine also places its own ink flag, so two flags.
  - Timer rule parsed (timer:45 -> lose) and the transcript is shown as "Read from the sheet:" even though it was typed.
- Engine CRASH: `RangeError: Maximum call stack size exceeded at MovingPlatform.startLeg` (MovingPlatform.ts:58, zero-length path recursion). Scene create aborts after behaviors: no HUD, no rules, no timer. Both in the preview and in Play test. The preview UI says nothing.
- Tiles toggle: gray 2-row-thick blocks under thin strokes, red 2-row blocks under thin red lines; collision visibly does not match ink.
- The dashed "moves" marker box is static while the platform sprite tweens away, so the overlay contradicts the game.
- Phaser canvas: 768x432 backing store, `image-rendering: pixelated`, shown at 669 CSS px on DPR 2 = 1.74x nearest-neighbour: stroke edges stair-step and line widths vary. Backdrop also shows faint ghost lines where crops were whitened out.

## Play test `#/play/draft/d_b14b143e`
- Frozen scene from the crash: no HUD, player half off-screen at x=0, no flag sprite, timer never runs.

## Tree `#/tree/lvl_starter1`
- Indented cards with thumbnails; root + 2 remixes. Thumbnails are near-identical; nothing shows what each remix changed (no diff highlight).
