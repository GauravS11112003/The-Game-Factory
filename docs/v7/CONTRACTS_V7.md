# draw.play v7: the drawing is the blueprint, Claude makes it a real-looking game

v6 made sketches *behave* like games (docs/v6/CONTRACTS_V6.md; read it first, everything there still holds). v7 makes
them *look* like games. The maker's drawing decides the idea: where things are, how big, what each thing is, the rough
shape and colours. Claude decides the finished look, from one game-wide art direction so the whole game matches.
Every AI result is offered, never forced: the maker sees their drawing next to Claude's versions and picks.

Quality is the only goal. Cost and speed do not matter (no budget caps for art; take the time you need), but the UI must
always show progress and the game must stay usable while art generates.

## 1. Spec (written; only the orchestrator changes it)

`vision/app/spec/studio.py` → `web/src/core/types.gen.ts`:

- `ObjectDef.art: ObjectArt | null` — `{use: "sketch"|"ai", chosen: variant id, variants: ArtVariant[≤6],
  terrain: TerrainSkin | null, asked}`.
- `ArtVariant {id, svg, w, h, rev, note}` — a sanitized SVG with `viewBox="0 0 w h"` where **w, h = the object's
  `drawing.w, drawing.h`** (the box of the maker's strokes; the art is drawn into that box, centred on the object, scaled
  and rotated with it). Physics always comes from the maker's strokes (v6 §2), so art must fill the box the way the
  sketch does (a car's body where the sketch's body is, its wheels' positions left free when wheels are separate objects).
- `TerrainSkin {fill[1..4] top→bottom, surface, surface_width, surface_svg?, texture_svg?, decor: ArtVariant[≤6],
  decor_every, rev}` — for objects whose physics shape is `line` (ground). Not one big picture: the renderer fills land
  under every stroke of the line down to the world's bottom (§4.2), and the skin says how it looks.
- `ArtDirection {rev, prompt, summary, guide, palette[], kinds{kind: description}}` on `GameDoc.art_direction`.
- `Backdrop {rev, sky[], layers: BackdropLayer[≤4]}` on `GameDoc.backdrop`; `BackdropLayer {svg, w, h, depth 0..1,
  anchor top|bottom|fill, tile_x, height 0..1}`. When present (and `look` is `game`) it replaces
  `theme.background` in the editor and the runtime.
- `GameDoc.look: "game" | "sketch"` — `sketch` shows every object's raw strokes and the theme background (the
  Sketch ↔ Game toggle); `game` shows the chosen look of each object (AI variant when `use` is `ai`, else the
  cleaned-up sketch, §4.3) and the backdrop.
- New StudioEdit actions: `set_art` (target object; data = partial ObjectArt, merged: `variants` replaced when given),
  `set_art_direction` (data = ArtDirection), `set_backdrop` (data = Backdrop or `{}` to clear), `set_look`
  (`{look}`).
- `StudioChatResult.art_prompt` (the copilot changed the game's look/kind: restyle with these words) and
  `StudioChatResult.error` (why the model path failed when `source` is `keywords`).
- Art API models: `ArtDirectionBody/Result`, `ArtJobBody`, `ArtJobItem`, `ArtJobStatus`.

## 2. The experience (what all lanes build toward)

1. The maker draws something; recognize asks "Is this a car?" → Yes. If the game has no art direction yet, one is made
   from the game (kind, title, theme) first. Then an art job draws 3 variants of that object.
2. A **compare card** opens next to the object: the maker's drawing (cleaned up) and the 3 Claude versions, large enough
   to judge. "Use this" / "Keep mine" / "Try again". Choosing is one undo step (`set_art`).
3. "Reimagine as hill climb racing in space": the copilot changes rules and world (low gravity…) and returns
   `art_prompt`. The Studio then makes a new art direction from it, and starts one job for **every drawn object plus the
   backdrop** (ground lines get terrain skins). Objects whose `use` is `ai` switch to the new variant 0 automatically
   (keeping the old ones until the maker confirms); objects on `sketch` get their variants and a review card. A
   **restyle card** in the chat shows before/after of the whole scene: "Use the new look" / "Keep the old one".
4. "✨ Make it real" in the top bar does step 3 with the current direction (or the game's kind) for everything.
5. **Sketch ↔ Game** toggle in the top bar (and on the play page) flips `look`.
6. Play: the finished look, solid terrain, parallax backdrop, a game camera.

## 3. Lane A2: AI art backend

Endpoints (in `vision/app/routers/v2/studio_art.py`, add `"studio_art"` to `V6_MODULES` in
`vision/app/routers/v2/__init__.py`; prefix `/api/v2`):

| Method | Path | Body → result |
|---|---|---|
| POST | `/studio/art/direction` | ArtDirectionBody → ArtDirectionResult (sync) |
| POST | `/studio/art/jobs` | ArtJobBody → 202 `{id}` (async, in-process asyncio task) |
| GET | `/studio/art/jobs/{id}` | → ArtJobStatus (items fill in as they finish; poll every ~1.5 s) |

Uses `game.art_direction` from the body (the client creates the direction first). Jobs are kept in memory for an hour.
Identity is not required (the doc is in the body), but rate-limit per IP sanely (e.g. ≤ 4 running jobs).

**Quality pipeline** (`vision/app/studio/art/*`, prompts `vision/app/mind/prompts/studio_art_*.md`, model
`claude-opus-5-5`, high effort, generous max_tokens and timeouts (e.g. 180 s per call); register call kinds with
`client.CALLS.setdefault`, set their budget estimates but do not block on budget: art must not be skipped for cost):

1. **Art direction**: from the prompt + game summary (kinds of objects, world, theme) → a rich, specific guide:
   palette (6–10 hex), line weight and colour, shading model (flat/cel/soft gradients), lighting direction, texture
   rules, mood, level of detail at game scale, what to avoid; `kinds` maps every object kind in the game to a concrete
   description in this world ("car" → "a chunky white lunar rover with gold foil panels, a dish antenna…"). Also a
   matching StudioTheme (palette for HUD, font, particles, music) returned as `theme`.
2. **Object art**: Claude gets the guide, the object's kind/name/role/behaviours, its box size, and **the image of the
   maker's drawing** (from `images` or rendered server-side from strokes), and writes an SVG `viewBox="0 0 w h"` that
   keeps the drawing's idea (silhouette, proportions, pose, colour hints) but is genuinely good game art. N variants
   per object (different takes, same guide); run objects and variants concurrently.
3. **Draw → look → fix**: rasterize each SVG server-side (`pip install resvg-py` into the venv; fall back to
   Pillow-free skip only if it cannot be installed) at game size and at thumbnail size, show Claude the render next to
   the sketch and the guide, and have it fix problems (proportions, broken shapes, off-style, unreadable small,
   empty or clipped areas). Up to 2 review rounds; keep the best.
4. **Terrain skins** for `line` objects: colours plus a tileable `surface_svg` strip and `texture_svg`, and 2–4
   decoration sprites (`decor`) in the guide's style.
5. **Backdrop**: 3 layers (far / mid / near), wide horizontally tileable SVGs (e.g. 2400×900 viewBox, seamless left/right
   edges), sky gradient; consistent with the guide and readable behind gameplay (lower contrast, nothing that looks
   like a platform).
6. **SVG safety**: sanitize every SVG (allow-list of shape/gradient/filter/pattern/text-free elements and attributes;
   no scripts, event handlers, external references, `<image>`, `<foreignObject>`, CSS `url()` except `#ids`), force the
   viewBox, cap size (`_SVG_MAX`).
7. **Fallbacks** (model off / failed): the direction comes from keywords + theme presets; object art falls back to
   nothing (item `failed`, the client keeps the sketch); terrain skins and backdrops fall back to good procedural
   values from the palette.

Also in lane A2:
- **Copilot**: `studio_chat` timeout 150 s (and recognize 30 s); set `art_prompt` whenever the reply changes the
  game's kind, world look or theme, or the maker asks for a look ("make it look like…", "in space", "candy land"); set
  `error` on fallback (`timeout`, `failed`, `budget`, `off`) and make the fallback reply honest ("That took too long
  for me — try a shorter ask, or one change at a time."); prompt: for partly impossible asks, build the closest thing
  the catalog can do and say plainly what was left out (e.g. physics block stacking instead of grid Tetris).
- Raise `MAX_DOC_BYTES` to 24 MB and the chat/recognize body limits accordingly (docs now carry SVGs). The game summary
  sent to the copilot must ignore `art`, `backdrop` and `art_direction.guide` (one line of the direction is fine).
- Tests `vision/tests/test_studio_art*.py` with a fake `client.call` (sanitizer, job flow, fallbacks, limits).

## 4. Lane R2: runtime and renderers

### 4.1 Art rendering (`web/src/studio/theme/art.ts`, shared with the editor)
- `artImage(svg) → Promise<HTMLImageElement>` (cached by string; Blob URL), `artCanvas(variant, scale) →
  Promise<HTMLCanvasElement>` rasterized crisp at the needed scale, `objectLook(obj, doc) → 'ai' | 'sketch' | 'raw'`
  (`raw` when `doc.look` is `sketch`).
- `renderTerrain(ctx, obj, skin | null, theme, world, camera)` and/or a Phaser-side equivalent: fill under each stroke
  of a `line` object down to the world bottom (polygon from the stroke points in world space), gradient `fill`, tiled
  `texture_svg`, the surface band (`surface_svg` tiled along the line, following its slope, or a thick `surface`
  stroke), and `decor` sprites placed deterministically (seeded by object id) every ~`decor_every` px on the surface.
  **Without a skin** (sketch look) ground still gets solid land from the theme palette — never a bare wire in `game`.
- `renderBackdrop(ctx, backdrop, world, camera, view)` with the same device-space camera convention as
  `renderBackground` (v6 integration note), parallax by `depth`, `anchor`, `height`, `tile_x`.

### 4.2 Runtime
- Objects with `use: ai` draw their chosen variant (texture from the SVG at the right resolution, fitted to
  `drawing.w × drawing.h`, centred, then the object's scale/rotation), in `game` look. `sketch` use draws the cleaned-up
  sketch (§4.3). `look: sketch` draws raw strokes everywhere (v6 behaviour).
- Terrain per §4.1, backdrop per §4.1 (else theme background).
- **Game camera**: fills the screen (no letterbox bars: extend the view to the screen aspect, clamp to the world),
  zooms so the player is a comfortable size (~1/8 of the view height), leads ahead in the direction of motion, smooth
  look-ahead and vertical damping. Fixed-camera worlds smaller than the view are centred over the backdrop/theme
  colour, not bars.
- **Cars**: wheel joints anchor where the wheel was drawn relative to the body (ignore `at`/`to_at` that disagree with
  the drawing by more than half a wheel), a short suspension (soft constraint) so the body bounces, wheels never detach,
  spokes or a hub mark so rotation is visible (draw on top of AI wheel art too, subtle), dust from wheels on ground.
- Keep everything from v6 working.

### 4.3 Cleaned-up sketch (game look for objects that keep the maker's drawing)
`renderDrawing(..., { polish: true })`: smooth jitter (Chaikin / moving average, keep corners), close strokes whose
ends are near each other, fill closed shapes (palette colour near the stroke colour), a soft inner highlight and a
drop shadow, even line weight. Stable (no per-frame randomness). The editor uses the same in `game` look.

## 5. Lane E2: Studio UI

- **Compare card** (anchored to the object, or a sheet on phones): the cleaned-up sketch + the variants, big previews on
  the theme/backdrop colour, "Use this" / "Keep mine" / "Try again" (new job for this object). Shown when a job brings
  variants for an object whose `asked` is false; sets `asked`.
- **Art progress**: objects being drawn shimmer on the canvas; a small progress pill ("Drawing 4 of 9…"); jobs keep
  polling while the maker works; results apply as `set_art` / `set_backdrop` edits (one undo step per batch, quiet).
- **Make it real** (top bar ✨): ensure a direction (`/studio/art/direction`, using `doc.art_direction.prompt` or the
  game's kind), then one job for every drawn, visible object + backdrop. **Restyle** from the copilot: when a chat
  result has `art_prompt`, create a new direction with it, `set_art_direction`, `set_theme` with the returned theme, and
  run the job; show a restyle card in the chat with before/after thumbnails of the scene ("Use the new look" / "Keep the
  old one"; the old variants/backdrop are kept until then).
- **Recognize → art**: after "Yes" on a recognize bubble, start a one-object job (direction first when missing).
- **Sketch ↔ Game toggle** in the top bar (`set_look`), and on the play page (local only, not saved).
- **Inspector "Look" section**: current look thumbnail, variants strip (pick), "Keep my drawing", "Redraw" (job), and
  for ground the terrain preview. **Game panel "Art style"**: the direction's summary + prompt field + "Restyle
  everything".
- **Editor canvas** renders the same look as the runtime (AI variants, cleaned sketch, terrain fill, backdrop) via lane
  R2's `art.ts` functions (until they land, fall back to v6 rendering behind a small adapter).
- Requests to `/studio/chat` and `/studio/recognize` send the doc **without** art payloads (strip `art`, `backdrop`,
  `art_direction.guide`) to keep them small. Art job requests send the doc without other objects' variants, plus
  `images` (PNG of each target object's strokes, ≤ 512 px) from `objectPng`.
- Copilot UI: show "Thinking…" with elapsed seconds; client timeout ≥ 160 s for chat; when `error` is set, show the
  reply plus a quiet note ("Claude took too long" etc.).
- applyEdits: implement the 4 new actions (pure, tested).

## 6. Files per lane (work only in your worktree; the orchestrator merges)

- **A2:** `vision/app/studio/art/**`, `vision/app/routers/v2/studio_art.py`, `vision/app/routers/v2/__init__.py`
  (one line), `vision/app/studio/copilot.py` + `fallback.py` + `summary.py` (timeouts, art_prompt, error, ignore art),
  `vision/app/routers/v2/studio.py` (limits only), `vision/app/mind/prompts/studio_*.md`,
  `shared/spec/messages-v6/ai.json`, `vision/tests/test_studio_art*.py`, the venv package `resvg-py`.
- **R2:** `web/src/studio/runtime/**`, `web/src/studio/theme/**`, `shared/spec/messages-v6/runtime.json`, tests in
  `web/src/studio/__tests__/runtime*` / `theme*` / `art*`.
- **E2:** `web/src/studio/editor/**`, `web/src/studio/model/**`, `web/src/studio/studio.css`, `web/src/app/studio/**`,
  `web/src/app/studio_api.ts`, `shared/spec/messages-v6/editor.json`, tests in `web/src/studio/__tests__/{edits,…}`.

## 7. Workflow

Same as v6 §11. The user is testing on ports 8000/5173 and will do the testing: keep your own checks to typecheck and
unit tests (no long browser sessions). Commit on your worktree branch; never push; never touch the main working tree.
Final report: what was built, anything not done, exported APIs other lanes use, branch and commits.

## 8. Changelog

- 2026-10-10: v7 contracts and spec (orchestrator).
