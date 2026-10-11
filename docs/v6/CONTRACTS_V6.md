# draw.play v6: the Studio (sketch any 2D game with an AI copilot)

The maker is in charge. They draw anything on a free canvas (a player, a car, a wall, a coin, a whole hill) and talk to
an AI copilot in a side chat: "reimagine the canvas as a hill climb racer", "make this a car", "the blue blobs are
enemies that shoot at me", "give the player 3 lives and a sword". The copilot turns words into **editable building
blocks**: physics, behaviours, rules scoped to an object or the whole game, counters (health, fuel, keys: the
inventory), joints (wheels), worlds, cameras, HUD and themes. Nothing is code and the code stays hidden: every
change shows as cards in an inspector that the maker can edit, switch off or undo. Then they press Play, in place.

v6 replaces the old flow (paper scan, computer vision, colour roles ground/spike/flag/coin, the tile level generator) for
new games. Three lanes build it in parallel worktrees branched from `v4-workspace`; the orchestrator integrates them and
does the removal (§9).

**No AI-drawn art.** Everything visible is the maker's strokes. A theme restyles strokes (marker, neon, pixel, comic…)
and paints the world behind them (§4.3). The copilot can ask the maker to draw something (`ask_draw`), never draw it.

## 1. Spec (already written; only the orchestrator changes it)

- `vision/app/spec/studio.py` → `shared/spec/studio.schema.json` → `web/src/core/types.gen.ts` (`GameDoc`,
  `SceneDef`, `ObjectDef`, `Drawing`, `Stroke`, `PhysicsDef`, `BehaviorDef`, `RuleDef`, `EventDef`, `ActionDef`,
  `Condition`, `JointDef`, `WorldDef`, `CameraDef`, `HudDef`, `HudItem`, `StudioTheme`, `BackgroundDef`,
  `StrokeStyleDef`, `StudioEdit`, `StudioChatBody/Result`, `RecognizeBody/Result`, `ThemeBody/Result`,
  `StudioGameCard`). Regenerate with `python scripts/gen_contracts.py` (only the orchestrator).
- `shared/spec/studio_catalog.json`: the one list of behaviours, rule events, rule actions, keys, archetypes and world
  presets, with every parameter (type, default, min, max, options, label). Loaded in TS by
  `web/src/studio/model/catalog.ts` (`CATALOG`, `BEHAVIORS`, `EVENTS`, `ACTIONS`, `withDefaults`). Behaviour, event
  and action `type` strings in a GameDoc must be catalog entries; `params` are plain values checked against the
  catalog (unknown params are ignored, missing ones take the default, numbers are clamped to min/max).
- Need a spec or catalog change? Stop and put the exact change in your final report. Small catalog additions
  (a new param with a default, a new choice option) are fine to make in your lane if the other lanes cannot be broken
  by them; list them in your report.

## 2. GameDoc semantics

**Units:** world pixels, +y down, angles in degrees (clockwise), times in seconds, speeds in px/s, gravity in g where
**1 g = 1600 px/s²**. A world is `width × height` with (0, 0) at the top left.

**Objects.** An object's `drawing` is in object-local pixels with (0, 0) at the object's centre; `x, y` is where that
centre sits in the world; `rotation` and `scale` apply around it. `drawing.w/h` is the local bounding box size (kept in
sync by the editor). An object with no strokes and a non-zero `w/h` is an invisible box (zones, spawners, sensors): the
editor shows it as a dashed box, the runtime does not draw it. `layer` orders drawing (higher on top; ties by array
order). `kind` is a free label (the maker's word: "car", "slime", "lava"); behaviour comes from `physics`,
`behaviors`, `rules`, never from `kind` or colours. `tags` group objects for targets ("enemy", "coin").
`template: true` objects are not placed; spawners, shooters and the `spawn` action copy them (a copy gets a fresh id
`<template id>#<n>`, keeps tags, behaviours, rules, counters). `hidden` objects start invisible and inert until shown.
`player: 1|2` means that player's keys drive the object's control behaviours (§4.2).

**Physics** (Matter.js through Phaser's Matter plugin):
- `body`: `none` (pure decoration, no collisions; behaviours that move things still move it), `static` (immovable
  solid), `dynamic` (simulated), `kinematic` (moved by behaviours only, pushes dynamic bodies, not pushed).
- `shape`: `auto` = convex hull of the drawing's points (decomposed to ≤ 8 convex parts with `poly-decomp` when the
  hull is a poor fit and the body is static; otherwise hull), `box` = the drawing's bounding box, `circle` = radius
  max(w, h)/2, `line` = **every stroke becomes a chain of thin static segments** following the pen (ground and
  terrain: draw a hill, drive on it). `line` forces a static body.
- `density`, `friction`, `bounce` (restitution), `fixed_rotation` (players that should not tip over),
  `sensor` (overlap events only, never blocks), `gravity_scale` (0 = floats; negative = falls up).

**Counters** are named numbers: `game.counters` (score, lives, time) and each object's `counters` (health, fuel, ammo,
keys…). They are the inventory: `give`/`take`/`pickup` move items between counters, conditions read them, the HUD
shows them. Counter names match `^[a-z][a-z0-9 _]{0,23}$`. A missing counter reads as 0.

**Rules** are "when EVENT [if CONDITIONS] then ACTIONS". Where a rule lives sets its scope:
- on an object (`ObjectDef.rules`): events are about that object ("when *this* collides with an enemy"), `self` is
  the object, `other` is the other object in the event (collide/overlap/leave/clicked) if any;
- on a scene (`SceneDef.rules`) or the game (`GameDoc.rules`, every scene): global events ("every 2 seconds",
  "when all enemies are gone", "when space is pressed"); `self` is the scene's player 1 object (or nothing).
- `conditions` must all hold when the event fires (`subject` = self | game | other | an object id). `once` rules fire
  at most once per scene play. `off` rules are kept but never fire.
- Copies made from a template carry its rules (scoped to each copy).

**Targets** (params of type `target`): `self`, `other`, `player` (player 1's object, or in 2-player games the nearest
player object), `player1`, `player2`, `any` (events only), `game` (counter subjects only), an object id, or a tag (all
objects with that tag). Ids win over tags when both match.

**Scenes.** Play starts in the first scene. `next_scene` goes to the next one (after the last: win). Game counters
carry over between scenes; object state does not. `edges`: `walls` = solid world bounds, `floor` = only a solid floor,
`wrap` = leaving one side enters the opposite, `none` = open (falling far below the world fires `out_of_bounds`, and a
player object that falls out loses a life / respawns at its checkpoint, see `health`).

**Win / lose.** The `win`/`lose` actions, `goal` behaviour, `health.on_zero = lose`. Lose restarts the scene (game
counters reset to their value at scene start) after a short calm card; win shows the end card. In 2-player games with
no explicit win rule, when one fighter-tagged/player object is destroyed, the other player wins ("Player 2 wins").

## 3. The catalog in the runtime (lane R implements every entry)

Behaviours (params and defaults are in the catalog; this is what they mean):
- **platformer**: left/right set horizontal speed (`air_control` × in the air), jump when grounded (contact normal
  pointing up within 45°), `double_jump`. Coyote time 0.08 s and jump buffer 0.1 s. Needs a dynamic body; sets
  `fixed_rotation` behaviour-wise even if the body allows rotation.
- **move_keys**: velocity from arrows/WASD on `axes` (normalised diagonal); `face_move` rotates the drawing to the
  move direction. Usually with gravity_scale 0.
- **car**: right = drive (applies angular velocity up to `max_speed` px/s at the rim to every `wheel` joint with
  `motor`, or to every wheel-jointed child), left = brake then reverse; in the air left/right tilt the chassis
  (`tilt`). `fuel_counter`: driving spends 1 per second of throttle; at 0 the motor stops.
- **thrust_ship**: up = thrust along the facing (drawing's "up" = −y local), left/right rotate at `turn` deg/s,
  speed capped.
- **launcher**: drag back from the object with the mouse/finger (≤ `max_pull` px), release launches it opposite to
  the pull with speed ∝ pull × `power` × 12; draws a dotted aim arc; the body is static until launched;
  `shots_counter` on the game counts launches (decrements; at 0 no more launches).
- **draggable**: pointer picks it up (mouse joint) and drops it; works in play mode.
- **shooter**: on `key` (or `auto` every 1/rate s, or `click` toward the pointer) spawns `projectile` (a template id,
  or `default` = a small dot in the theme accent) at the object's edge with `speed` in `direction`, `spread` degrees
  of random spread, `lifetime` s, and gives the projectile a `damage` of `damage` to anything not on the shooter's
  side (projectiles never hit their shooter or its tags' allies). Rate-limited by `rate` shots/s.
- **melee**: on `key`, a short swing (drawing squash/rotate juice) hitting objects within `range` px in front:
  `damage` + `knockback` impulse; `cooldown`.
- **health**: sets `counters.health` to `max` if missing; `damage` lowers it, then `invulnerable` s of blinking;
  `bar` draws a small bar above it; at 0: `on_zero` (`destroy`, `lose` the game, `respawn` at the last checkpoint or
  start with full health and −1 game `lives` if that counter exists, `nothing`) and fires `health_zero`.
- **damage**: touching (collide or overlap) a matching `to` target takes `amount` health (with `knockback`);
  `destroy_self` removes this object after hitting (bullets).
- **pickup**: touching by `to` adds `amount` to the toucher's `item` counter (and the game's `score` += amount when
  item is coins/score), plays a ding, disappears (`respawn` s later if > 0).
- **spawner**: every `every` s, if fewer than `max` live copies, spawns `template` at `area` (self = its box,
  top/bottom/left/right = a random point along that world edge just outside the camera, screen = random visible
  point) with `velocity` ± `jitter`.
- **follow**: moves toward `target` at `speed` on `axes` when within `range` (0 = always).
- **patrol**: back and forth `range` px from its start on `axis`, turning at walls and ledges (platformer worlds).
- **rotate**: spins at `speed` deg/s. **oscillate**: sinus motion on `axis`, `range` px, `period` s (kinematic;
  carries what stands on it). **float**: idle bob of the drawing only (no physics change).
- **bounce_pad**: anything landing on it gets an upward velocity `power` (and a boing).
- **conveyor**: things on top move at `speed` px/s along its surface.
- **goal**: when touched by `by`: `next_scene` or `win`. **hazard**: touching by `to` = all health / a life.
- **checkpoint**: touching marks the respawn point (small flag wave juice). **lifetime**: destroyed after `seconds`.
- **wrap**: leaves one world side, appears on the opposite. **ai_fighter**: walks toward `target`, jumps over
  obstacles, uses its own melee/shooter when in range; `skill` 0..1 sets reaction time and accuracy. In 2-player games
  an `ai_fighter` with `player: 2` is ignored while a human controls player 2 (so the same game works 1P vs bot and 2P).

Events: `start` (scene begins), `key_down`/`key_up` (`key` from the catalog key names; on an object with a player,
left…action2 use that player's scheme), `collide` (solid contact begins with `with`), `overlap` (sensor overlap begins),
`leave` (overlap ends), `timer` (once after `seconds` from start), `every` (repeating), `counter` (the comparison becomes
true; re-arms when it becomes false), `health_zero`, `destroyed`, `spawned`, `all_gone` (no live objects with `tag`
remain; fires once, re-arms when one appears), `clicked` (pointer down on the object), `out_of_bounds`.

Actions: `add`/`set` counters, `give`/`take` items between self and a target, `damage`/`heal`, `destroy`, `spawn`
(template at a target, `count`, `velocity`), `impulse` (adds velocity in px/s, mass independent), `velocity` (sets
it), `teleport` (target to another target's position), `show`/`hide`, `solid` (sensor off/on), `gravity` (sets world
gravity in g), `flip_gravity`, `time_scale` (slow motion for `seconds`), `enable` (a behaviour on/off by id or type),
`sound`, `shake`, `flash`, `say` (speech bubble), `camera` (follow target and zoom), `win`, `lose`, `next_scene`,
`go_scene`.

Keys: catalog `keys.schemes`. In a 1-player world every player object uses `single`; with `world.players = 2`,
player-1 objects use `player1` (WASD + F/G) and player-2 objects use `player2` (arrows + L/K). Touch devices get
on-screen buttons for the keys the game uses (left, right, up/jump, action) and pointer for launcher/draggable/click.

## 4. Lane R: the runtime and themes

### 4.1 API (`web/src/studio/runtime/index.ts`, stub exists)

```ts
mountRuntime(parent: HTMLElement, doc: GameDoc, o?: { scene?: string; onEvent?: (e: RuntimeEvent) => void;
  muted?: boolean }): RuntimeHandle   // { stop, restart, setPaused, counters }
```
- Phaser 3.90 (already a dependency) with its bundled Matter physics, fixed 60 Hz step, canvas fills `parent`
  (letterboxed to the camera view; view = 1600×900 world px at zoom 1, scaled to fit). Several runtimes can exist
  (the Studio and a thumbnail) and `stop()` frees everything (Phaser game destroyed, listeners removed).
- Never throws on a bad doc: unknown behaviours/actions are skipped with one `{type:'error'}` event each; dangling
  targets, joints to missing objects and empty templates are ignored.
- Emits `ready`, `win`, `lose`, `scene` (changed), `counter` (changed; throttled to 10/s), `say`, `destroyed`,
  `spawned`, `error`. `counters()` returns `{ game: {...}, <object id>: {...} }` for objects that have counters.
- HUD (DOM overlay or Phaser text, theme font): `hud.items` (number, bar with max, hearts, icons using the item's
  pickup drawing when one exists), timer, title; 2-player games show each player's health bars at the top corners.
  Win/lose/pause cards with Restart. Particles per theme (`dust` on landings, `sparks` on hits, `confetti` on win…).
  Sound effects through `web/src/audio` or WebAudio synthesis (no audio files needed); `theme.music` a small
  procedural loop, off when `muted`.

### 4.2 Physics and rules engine

- World gravity `world.gravity` (g) × 1600 px/s², per-body `gravity_scale`. Edges per §2. Camera per `CameraDef`
  (follow lerp with dead zone; `auto_scroll` moves at `speed` along `axis` and objects pushed off-screen behind the
  camera by it are `out_of_bounds`).
- Joints: `wheel` (pin at `at`/`to_at` + a revolute constraint; the car behaviour drives it; `motor` + `speed` without a
  car = constant spin), `hinge` (revolute), `rope` (distance constraint, max `length`), `weld` (rigid), `spring`
  (soft constraint with `stiffness`, rest `length`).
- Rules: an event bus per scene; each rule's event subscription per scope; conditions; actions run in order. Guard
  against loops: at most 64 rule firings per frame, events raised by actions are queued to the next frame.
- Determinism is not required (no replays/bots in v6). Keep the core lint rules out of `web/src/studio/**`.

### 4.3 Themes (`web/src/studio/theme/**`)

- `renderDrawing(drawing, theme, {scale, pad}) → HTMLCanvasElement` (stub exists): the one stroke renderer used by the
  Studio canvas, the runtime (textures, re-rendered on theme change) and thumbnails. Stroke styles: `ink` (thin, dark,
  slight taper), `marker` (round, flat colour), `neon` (bright core + glow, on dark backgrounds), `pixel` (snapped to
  a grid, square caps, no AA), `chalk` (grainy, broken), `comic` (thick dark `outline` behind + optional `halftone`
  fill), `crayon` (waxy texture), `watercolor` (soft translucent edges + bleed). `outline`, `width_scale`, `glow`,
  `wobble` (stable hand jitter: seed from the stroke index, never random per frame), `fill_closed` (closed strokes
  without `fill` get a palette colour near their stroke colour), `recolor` (map distinct stroke colours to the
  palette in order of first use, so a black-pen sketch becomes a coloured game).
- `renderBackground(ctx or Phaser scene, theme, world, camera)`: the 14 `BackgroundDef.style`s with `colors` and
  parallax layers (paper texture, gradient sky, stars, grid, city skyline, rolling hills, clouds, neon synth grid,
  halftone dots, waves, dunes, forest silhouettes, space nebula).
- `shared/studio/themes.json`: ≥ 14 preset themes (`{ "themes": [StudioTheme, ...] }`): Sketchbook (default),
  Neon Arcade, Pixel Retro, Comic Pop, Chalkboard, Crayon Kids, Watercolor Dream, Blueprint, Desert Dunes, Deep Space,
  Spooky Night, Candy, Jungle, Ocean, Noir Ink. Lane A's keyword fallback picks from these; the Studio shows them.

### 4.4 Templates (`shared/studio/templates/*.json`, `blank.json` exists)

Full GameDocs that play well and show what the Studio can do, drawn as convincing hand strokes (generate them with a
script, `scripts/studio_templates.ts` or `.py`, committed together with its output): **hill climb racer** (line-shape
hills, car body + 2 wheel joints, fuel counter + fuel cans, coins, distance HUD, flip = lose), **fighting game**
(2 fighters, platformer + melee + shooter fireball, health bars, P2 also `ai_fighter` for 1P), **space shooter**
(thrust ship, wrap, asteroid spawner, score), **platformer** (ground, platforms, enemies that patrol, coins, goal flag,
checkpoint), **physics puzzle** (launcher bird, stacked crates/pigs with health, shots counter, all_gone → win),
**catch game** (paddle move_keys x, spawner of falling stars and bombs, score/lives), **flappy** (gravity + a
`key_down space → velocity y −520` rule, pipe spawner, score), **top-down collect** (hero, walls, keys + locked door via
a condition on keys ≥ 1), **endless runner** (auto_scroll, jump, obstacle spawner). Each is beatable by a person.

## 5. Lane A: AI backend, storage, templates API

### 5.1 Endpoints (`vision/app/routers/v2/studio.py`, already listed in `V6_MODULES`; prefix `/api/v2`)

| Method | Path | Body → result |
|---|---|---|
| POST | `/studio/games` | `{template?: id, title?: str, doc?: GameDoc}` → 201 GameDoc (new id `sg_<12>`, author from identity) |
| GET | `/studio/games/{id}` | → GameDoc (+ header-free; 404 calm) |
| PUT | `/studio/games/{id}` | GameDoc → GameDoc (author only; validates; bumps `updated_at`; ≤ 4 MB) |
| GET | `/studio/games?mine=1` / `?published=1` | → `{games: StudioGameCard[]}` newest first |
| POST | `/studio/games/{id}/publish` | `{published: bool}` → StudioGameCard |
| PUT | `/studio/games/{id}/thumbnail` | PNG bytes (≤ 600 KB) → 204; served at `GET /studio/games/{id}/thumbnail.png` |
| POST | `/studio/games/{id}/remix` | → 201 GameDoc copy owned by the caller |
| GET | `/studio/templates` | → `{templates: StudioGameCard[]}` from `shared/studio/templates/*.json` |
| GET | `/studio/templates/{id}` | → GameDoc |
| GET | `/studio/themes` | → `{themes: StudioTheme[]}` from `shared/studio/themes.json` |
| POST | `/studio/chat` | StudioChatBody → StudioChatResult |
| POST | `/studio/recognize` | RecognizeBody → RecognizeResult |
| POST | `/studio/theme` | ThemeBody → ThemeResult |

Identity like `routers/v2/blocks.py` (`app.collab.identity.player_from_request`); anyone can read a published game or
a game by its id (links work), only the author writes. Storage: table `studio_games(id, author, author_id, title,
kind, doc_json, published, thumb_png, created_at, updated_at)` created by the lane's own idempotent migration in
`vision/app/studio/store.py` using `db_v2.connect()`. Errors are `{error: {key, args}}` with keys in
`shared/spec/messages-v6/ai.json`.

### 5.2 StudioEdit shapes (the copilot's only output; the client applies them, lane E)

`target` is an object id unless said otherwise; `scene` defaults to the scene in the request.

| action | target | data |
|---|---|---|
| `set_world` | – | partial WorldDef (deep-merged; `camera` merged) |
| `set_theme` | – | partial StudioTheme (deep-merged) or `{preset: <theme id from themes.json>}` |
| `set_hud` | – | HudDef (replaces) |
| `set_title` | – | `{title}` |
| `add_scene` | – | `{id?, name, world?, copy_from?: scene id}` |
| `update_object` | id (new id = create) | partial ObjectDef without `drawing.strokes` (physics deep-merged, counters merged, lists replaced). Creating needs `drawing: {w, h}` (an invisible box) and `x, y`. |
| `delete_object` | id | `{}` |
| `duplicate_object` | id | `{x?, y?, count?, dx?, dy?}` |
| `add_behavior` | id | BehaviorDef (`id` optional → `b<n>`) |
| `update_behavior` | id | `{id or type, params?, off?}` (params merged) |
| `remove_behavior` | id | `{id or type}` |
| `add_rule` | id, `@scene` or `@game` (null = `@game`) | RuleDef (`id` optional → `r<n>`) |
| `update_rule` | same | `{id, ...partial RuleDef}` |
| `remove_rule` | same | `{id}` |
| `add_joint` | id | JointDef (`to` may name an object the maker has not drawn yet; kept, ignored until it exists) |
| `set_counters` | id | `{counters: {name: number or null}}` (null removes) |
| `set_game_counters` | – | `{counters: {...}}` |
| `ask_draw` | – | `{id, prompt, object: partial ObjectDef}`: asks the maker to draw something; the next object they finish becomes `id` with those settings. |

### 5.3 The copilot (`vision/app/studio/copilot.py`, prompts `vision/app/mind/prompts/studio_*.md`)

- Calls through `app.mind.client.call` (register kinds `studio_chat` (medium effort, ~8000 max tokens, 40 s),
  `studio_recognize` (low, 2500, 15 s), `studio_theme` (low, 2000, 12 s) with `client.CALLS.setdefault` +
  `budget.ESTIMATE_USD.setdefault` like `mind/logic.py`). Model `claude-opus-5-5` (client default).
- Structured outputs need a model-facing schema with no free-form dicts: make flat models (e.g. `params_json: str`,
  `data_json: str` per edit) and parse/validate them server side. The system prompt includes a compact rendering of
  the catalog (types, params with defaults/ranges, one-line meaning) and the edit table; cache it
  (`cache_control`, it is the same for every call).
- The user turn: game summary (title, world, theme name, HUD, counters, game/scene rules, and per object: id, name,
  kind, x, y, w, h, body, behaviours with params, rules, counters, tags, player, colours used) — never raw strokes;
  the selection; up to 20 history turns; the message; the canvas snapshot PNG when sent (image block).
- "Reimagine the canvas as X" = choose a world preset, a fitting theme (`set_theme` with a preset or custom values),
  HUD, game rules, re-purpose what is already drawn (update_object on the maker's objects: a long line becomes
  `line`-shape ground, a box with circles becomes a car with wheel joints…), and `ask_draw` for what is missing
  ("Draw your car"), at most 3 asks per reply. The reply is short and friendly (≤ 2 sentences) and plain words, no
  jargon ("physics body", "sensor" → "solid", "you can walk through it"); `suggestions` are 2-4 next things to say.
- Server-side validation of every edit (shape, catalog types, params clamped, targets exist or are being created,
  ids), dropping bad ones; never trust the model's ids for `id` fields that collide (rename). At most 40 edits.
- **Recognize:** the PNG of one newly finished object + the game summary → the best guess (question "Is this a car?",
  name, kind, and the edits that would make it one: physics, behaviours from the matching archetype, counters, and
  for a car `ask_draw` the wheels when none are near). Archetypes from the catalog are the starting point.
- **Theme:** text ("spooky halloween", "like Geometry Dash", "watercolor forest") → a StudioTheme (palette with good
  contrast between bg and ink, a background style, a stroke style).
- **Keyword fallbacks** (no key, fake mode without a reply, over budget, failed/refused call): `source: "keywords"`.
  Chat: recognise "make/turn/reimagine … into/as <game kind>" against the world presets and template names
  (racer/hill climb/car, fighter/fighting, shooter/space, platformer/mario, puzzle/angry birds, catch, flappy,
  runner, top-down/zelda) and produce the same kind of edits from a table; "make this/the selection a <archetype>"
  applies the archetype; "gravity off/flip/low", "add N lives/health", "<theme words>" → set_theme from the preset
  keywords; otherwise reply asking to rephrase with 3 suggestions. Recognize: "What is this?" with no edits. Theme:
  best keyword match in themes.json, else Sketchbook.
- Blocks: `routers/v2/blocks.py` accepts and stores kinds `object` (needs `object`) and `theme` (needs `theme`);
  `BlockCard` already carries the doc fields it returns. Keep v4 kinds working.
- Tests in `vision/tests/test_studio_*.py`: CRUD + auth, validation of edits, every fallback path (model off), the
  model path with `DAL_FAKE_LLM` or a monkeypatched `client.call`.

## 6. Lane E: the Studio editor and copilot UI

Routes (already in `web/src/app/main.ts`): `#/studio/:id` → `studioScreen` (`web/src/app/studio/studio_screen.ts`),
`#/g/:id` → `studioPlayScreen`. `#/new` (`web/src/app/screens/new_game.ts`, lane E now owns it) creates a Studio game.

**Layout (desktop, ≥ 1100 px):** top bar (editable title, scene tabs + add, undo/redo, **Play** ▶ / Stop, Share,
save state "Saved"), a slim tool rail on the left, the canvas in the middle, and the right column: the **Copilot**
chat, always visible, and the **Inspector** as a second panel that opens beside it when something is selected (or a
"Game" settings panel when nothing is). Phones: canvas full width, copilot and inspector as bottom sheets; drawing
with a finger works.

**Canvas** (`web/src/studio/editor/**`): the world (width × height, pan with space-drag / two fingers / middle mouse,
zoom with wheel / pinch, "fit"), rendered live with the theme (`renderDrawing` and the background renderer from
lane R; until they land use the stub). Tools: **pen** (pressure-free smooth strokes, Catmull-Rom/RDP simplified, any
colour: a swatch row from the theme palette + custom picker, 4 widths), **line**, **rectangle**, **circle** (closed
strokes; great for wheels and ground), **eraser** (removes whole strokes under the cursor in the selected or pending
object), **select** (click, shift-click, marquee; move by drag, rotate and scale handles, arrow-key nudge,
delete, duplicate Ctrl+D, copy/paste, bring forward/back), **hand**. Strokes drawn close together in time and space
(within ~32 px of the pending group's box, < 1.5 s apart) group into one pending object, finalised on a pause, a tool
switch or Enter; select + "Merge" / "Split" fixes grouping. A finished object's centre is its bbox centre and strokes are
stored relative to it.

**Recognize:** when an object is finished and is still `kind: "thing"`, post `/studio/recognize` (PNG of the object
alone, ≤ 256 px) and show a small bubble next to it: "Is this a car? **Yes** · No, it's… · ignore". Yes applies the
edits as one undo step. "No, it's…" sends the typed words to the copilot with the object selected. If an `ask_draw`
is pending, the finished object takes that id and those settings instead (no recognize), and the next ask shows.

**Inspector (no code, ever):** name, kind (free text with archetype suggestions; picking one offers "make it act like
a <label>" which applies the archetype), "Controlled by" (nobody / player 1 / player 2), **Body** (segmented: decoration,
solid, moves with physics, moves on its own path → none/static/dynamic/kinematic; shape auto/box/circle/ground line;
sliders: weight, grip, bounciness; toggles: never tips over, ghost (things pass through), gravity slider), **Behaviours**
(cards from the catalog with generated controls per param type: number slider + field, bool toggle, choice segmented or
select, key picker, target/object/template/tag pickers listing objects and tags, counter name combobox, vec two fields;
off switch; add from a grouped picker with the catalog help lines), **Rules** (sentence cards "When [this touches ▾
an enemy ▾] and [coins ▾ ≥ 3] → [win ▾]", every chip a dropdown from the catalog, + condition, + action, once, off,
delete; the maker's `text` shown above), **Items & stats** (counter rows name / value; "+ item"), **Tags**, **Joints**
("attach…" then click another object: wheel, hinge, rope, weld, spring), **Make it a template** (for bullets and spawned
things), **hidden at start**, Save as block. Every control edits the doc through the same edit path as the copilot.
**Game panel** (nothing selected): world preset picker (cards from catalog `worlds`), gravity (strength + direction:
down, up, none, sideways), camera, edges, world size, players (1 / 2), theme (preset gallery from
`shared/studio/themes.json` + "describe a theme…" → `/studio/theme`), HUD items, game counters, game and scene rules.

**Copilot chat:** message list (maker / copilot), input with send, suggestions as chips, the starter chips on an empty
game ("Reimagine as a hill climb racer", "Make it a fighting game", "Space shooter", "Platformer"). Each copilot reply
with edits applies them immediately as **one undo step** and shows "Changed N things · Undo" with a collapsed list of
plain sentences per edit (`web/src/studio/model/describe.ts`), and pending `ask_draw` prompts appear as a banner at the
top of the canvas ("✏️ Draw your car" · skip). The request carries the GameDoc, scene, selection, last 20 turns and a
canvas snapshot PNG (≤ 1024 px wide). Offline/keyword replies are marked subtly.

**Model:** `web/src/studio/model/edits.ts` `applyEdits(doc, sceneId, edits) → {doc, warnings, created: string[],
asks: AskDraw[]}` (pure, immutable, §5.2 semantics, fresh ids, archetype helper `applyArchetype(obj, kind)`),
`web/src/studio/model/doc.ts` (bbox, recentre, new ids, stroke simplification), undo/redo as doc snapshots with
coalescing (drags, slider scrubs). Client API `web/src/app/studio_api.ts` for §5.1. Autosave: PUT 1.2 s after the
last change, a local draft in localStorage (try/catch) when offline, "Saved / Saving… / Offline, kept on this device".

**Play in place:** Play swaps the canvas for `mountRuntime` (same view), the inspector shows a live counters watch,
Stop returns to the exact editor state. Esc stops. **#/g/:id** plays full-screen with title, restart, fullscreen,
share link copy and **Remix**. Thumbnails: after a save, render the first scene to a 480×270 PNG (background +
drawings) and PUT it (throttled to once per 30 s).

**New game (`#/new`):** "What are you making?" input (sent as the first copilot message after creation), a template
gallery (GET `/studio/templates`), and "Blank canvas". Creating = POST `/studio/games` → `#/studio/<id>`.

Tests: `web/src/studio/__tests__/` for `applyEdits`, describe sentences, grouping and bbox maths (vitest, node).

## 7. Shared rules for all lanes

- TypeScript strict, no new framework; DOM helpers `h()`, `card()`, `icon()` from `web/src/app/dom.ts`; visual language
  of `web/src/app/ws/ws.css` and `style.css` (tokens, radii, Atkinson Hyperlegible / Patrick Hand). Studio CSS in
  `web/src/studio/studio.css` (lane E) and `web/src/studio/runtime/runtime.css` (lane R).
- No new npm dependencies except `poly-decomp` (lane R, if used). Phaser's Matter plugin is built in.
- The old `web/src/core/**`, `web/src/engine/**`, v4 screens and CV code are not to be changed by lanes (the
  orchestrator removes/keeps them, §9).

## 8. Strings

Kid- and maker-facing sentences live in `shared/spec/messages-v6/{runtime,editor,ai}.json` (`{"messages": {...}}`),
already merged by `web/src/app/messages.ts` (`t()`), `web/src/render/text.ts` and `vision/app/mind/messages.py`.
Lane R writes `runtime.json` (keys `rt.*`), lane E `editor.json` (`studio.*`), lane A `ai.json` (`ai.*`). Catalog labels
and help lines stay in the catalog. Copilot replies are model text (or fallback sentences from `ai.json`).

## 9. Orchestrator: integration and removal

New game, dashboard and sidebar point at the Studio; Studio games appear in "My games" and Explore; the paper scan,
camera, computer vision and colour-role flows (ground/spike/flag/coin legend, `#/scan`, `#/draw` level drawing,
`vision/app/cv`) are removed from the product; Blocks gets object/theme kinds, Styles becomes the theme gallery,
Templates lists Studio templates. Old v4 games keep playing where they exist.

## 10. Files per lane (work only in your worktree; the orchestrator merges)

- **R:** `web/src/studio/runtime/**`, `web/src/studio/theme/**`, `shared/studio/themes.json`,
  `shared/studio/templates/**` (+ its generator script under `scripts/`), `shared/spec/messages-v6/runtime.json`,
  `web/src/studio/__tests__/runtime*.test.ts`, `theme*.test.ts`. Optional dev page `web/studio-dev.html` + entry under
  `web/src/studio/dev/` to try templates.
- **E:** `web/src/studio/editor/**`, `web/src/studio/model/**` (except `catalog.ts`, shared: additive changes only),
  `web/src/studio/studio.css`, `web/src/app/studio/**`, `web/src/app/studio_api.ts`, `web/src/app/screens/new_game.ts`,
  `shared/spec/messages-v6/editor.json`, `web/src/studio/__tests__/{edits,describe,doc,editor}*.test.ts`.
- **A:** `vision/app/studio/**`, `vision/app/routers/v2/studio.py`, `vision/app/mind/prompts/studio_*.md`,
  `vision/app/routers/v2/blocks.py` (object/theme kinds), `shared/spec/messages-v6/ai.json`, `vision/tests/test_studio*.py`.

## 11. Environment and workflow

Node 22: `NODE_OPTIONS="--experimental-strip-types --disable-warning=ExperimentalWarning"`. Python:
`C:\Users\kavya\.draw-play-env\venv\Scripts\python.exe`, run pytest from your worktree's `vision/`. In a fresh worktree
run `npm ci --prefer-offline --no-audit --no-fund` in `web/` first. Typecheck `npx tsc --noEmit` in `web/`, tests
`npx vitest run <paths>`. Do not start servers on 8000 or 5173 (the user is testing on them); use 5190+/8090+.
Commit on your worktree branch when done and tested (local commits are approved); never push; never touch the main
working tree. Final report: what works, what does not, any spec/catalog change you need, how to try it.

## 12. Changelog

- 2026-10-10: v6 contracts, spec, catalog, stubs (orchestrator).
- 2026-10-10: lanes A, E, R merged. Catalog additions (lane R): `platformer.auto_run`, `car.distance_counter`,
  `launcher.out_of_shots`, `damage.min_speed`. Orchestrator: `POST /studio/games/{id}/blocks/{block_id}/use` (counts a
  use, credits the block's author), doc extension `x_credits: [{block_id, name, author, kind}]` (kept by the editor and
  shown on `#/g/:id` with `x_remix_of`), the Blocks drawer in the Studio rail, object/theme blocks into Studio games
  from `#/blocks`, `#/styles` as the theme gallery, published Studio games on `#/explore`, template thumbnails drawn
  in the browser. The editor hands `renderBackground` a device-space camera read off the canvas transform.
