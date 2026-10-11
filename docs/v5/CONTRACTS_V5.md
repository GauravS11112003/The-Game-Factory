# draw.play v5: physics, logic blocks, developer packs and race multiplayer

Four lanes build v5 in parallel, each in its own git worktree branched from `v4-workspace`. Read
`docs/v4/CONTRACTS_V4.md` first: its principles (§1), determinism rules, input bits, SimView fields and the lane
conventions still hold. The v5 spec is already in the Pydantic models and in `web/src/core/types.gen.ts`:

- `vision/app/spec/behavior.py`: `Material`, `BPhysics`, `BFlipbook`, `BScripted`
- `vision/app/spec/level.py`: `EBody`, `EFlipbook`, `EScripted`, `NpcChoice` + `ENpc.choices`, `Compiled.scripts`
  (in `level_hash` only when non-empty, like `compiled.logic`; Python done, TS `build/hash.ts` must match: lane S)
- `vision/app/spec/logic.py`: triggers `WhenFrame`, `WhenChoice`; actions `DoSetFrame`, `DoPush`; `RuleIf` and
  `RuleV4.only_if`
- `vision/app/spec/script.py`: the developer-pack script language (`Script`, `ScriptState`, `ScriptOp`)
- `vision/app/spec/library.py` and `blocks.py`: `frames` (flipbook art) and `script` on library types and blocks;
  `api.py` `BlockCreate.frames/script`

Only the orchestrator changes the spec. If you need a change, stop and put the exact field in your final report.
v4 levels must keep validating, hashing and simulating exactly as before (selftest, conformance levels, goldens).

## 1. Lane P: physics

`BPhysics {shape: box|ball, material, fixed}` compiles to `EBody {x, y, w, h, shape, material, fixed}` (top-left box,
cells). In the sim (deterministic, frame-integer, lint rules apply, no npm physics library in the core):

- Bodies are axis-aligned boxes (balls collide as boxes or circles, your choice, but must roll visually: report a
  rotation in `EntityView.angle` turns from distance travelled / circumference). No rotation of boxes.
- Gravity (player g_fall × material factor is fine), friction and restitution per material: wood (normal), stone
  (heavy, no bounce, hard to push), rubber (bouncy), ice (slides far), metal (heavy, slight bounce). Mass ∝ area ×
  density.
- Bodies collide with solid tiles, one-way tops (from above), other bodies (stacking must be stable: no jitter at
  rest, use a sleep threshold), and the player: the player stands on bodies, walks into them to push (slower when
  heavy), and a falling body landing on the player crushes like a crusher. A body moving faster than a threshold that
  hits an enemy defeats it (a stomp event, "knock things onto monsters").
- `fixed: true` = static solid that toggles like any entity. Hidden bodies are inert.
- `DoPush {target, vx, vy}` adds velocity. Touch/zone triggers keep working with bodies.
- `EntityView` for bodies: `type 'body'`, `x, y, w, h, vx, vy, angle?, kind = material, state = 'rest'|'moving'`.
- Bot: levels with bodies get an honest report (search mode, `approx` when it is not certain).
- Engine: draw bodies from their sprite (kid ink) or material art (wood planks, stone, rubber, ice, metal) in the ink
  style; small dust/clack juice on impact. Editor/library: "Physics" behaviour chips (shape + material + fixed) in the
  block studio and creature/library flows; perception: no new role needed (behaviour wins, like v4 primitives).

## 2. Lane L: logic blocks

- **Flipbook** `BFlipbook` → `EFlipbook`: frame index advances every `frame_s` seconds (from the clock start), stops at
  the last frame unless `loop`; solid from `solid_from`; collectible as `item` at `collect_at` (fires `collect`
  triggers like a pickup and adds 1 to the counter named `item`). `WhenFrame` fires on reaching a frame;
  `DoSetFrame` jumps. `EntityView`: `type 'flipbook'`, `phase = frame index`, `state`. Art: the library type's
  `frames` (frame 0 = `art`); the engine draws the current frame. Block studio: draw 2-6 frames (a strip of small
  canvases), plus timing and "becomes solid / collectible at frame N".
- **Conditions (inventory)** `RuleV4.only_if`: every `RuleIf` must hold (counter ≥ `at_least`, counter < `below`) when
  the trigger fires; otherwise the rule does not fire (and a `once` rule is not used up). Counters double as the
  inventory: the HUD shows counters named like items with their pickup art when there is one. `parseLogic` and the
  model learn "if you have 3 keys…", "only with the red gem…".
- **Choices** `ENpc.choices`: after the last line, the bubble shows the choices; while it is open, Left/Right (or
  Up/Down in top-down) move the selection and the action key or jump confirms. Picking fires `WhenChoice
  {target, index}` and, when the choice has a `counter`, sets that counter to `value`. Sim state holds the open choice
  and selection; `SimView.say` gains `choices?: string[]` and `selected?: number`. New `SimEvent` `choice` (`id`,
  `n` = index). The bot treats an open choice as a branch (try each).
- Describe/parse: `describeRule` covers the new parts (core.json has starter sentences: `logic.when.frame`,
  `logic.when.choice`, `logic.do.set_frame`, `logic.do.push`, `logic.if.at_least`, `logic.if.below`).
- Turn-based games are out of scope for v5.

## 3. Lane S: developer packs (scripts)

- `BScripted` + `LibraryType.script` (or `Block.script`) compile to `EScripted {x, y, w, h, script}` with the
  script copied into `compiled.scripts[id]` (id = the library type id + version, or the block id). Update
  `web/src/core/build/hash.ts` so `scripts` is hashed only when non-empty (must equal Python `level.py`).
- Interpreter in the sim, deterministic: per entity `{state, enteredFrame, vx, vy, gravity, solid, hazard, hidden,
  anchorX}`; on entering a state run `enter` ops; every frame run `tick` ops, then integrate velocity (with gravity
  when on, colliding with solid tiles like an enemy), then `touch` ops on the touch edge; `after` moves on after
  `seconds`. `OpPatrol` patrols around the x where the state was entered. `OpDo` runs a rule action through the
  same code as rules (a `say` without target speaks from this entity). Solid scripted entities carry the player
  like a moving platform; hazard ones hurt. Guard against runaway loops: at most 8 `goto`s per entity per frame.
- `EntityView`: `type 'scripted'`, `state` = script state name, plus `vx, vy`.
- Authoring: a "Script" section in the block studio: a readable state editor (states as cards, ops as chips with
  small number fields), a JSON view for developers, validation against the spec, and 3 example packs published as
  starter blocks (a ghost that chases only when you look away is not possible; pick ones the ops can express: a
  sleepy guard that wakes and patrols, a bouncing spring-bot, a shy ghost that hides when touched and comes back).
  Docs: `docs/v5/PACKS.md`, a short guide for developers with the op table and the three examples.
- Bot: levels with scripted entities use the search mode with honest `approx`.

## 4. Lane M: race multiplayer (no sim changes)

- **Local race, two players on one keyboard:** a "Race" button on the play screen opens split screen (top/bottom or
  left/right): two independent sims of the same level, player 1 on WASD + Space/E, player 2 on the arrows + Enter /
  right-shift (map the bits so rule keys still work per player). First to win is shown with both times; restart and
  rematch. Phones/touch: show "Race needs a keyboard" calmly.
- **Online race:** "Race a friend online" creates a room (reuse the live WebSocket server in
  `vision/app/routers/v2/live.py`, add race messages there or in a sibling module), shows a code/QR/link; the friend
  joins from `#/play/<id>?race=<room>`. Countdown starts when both are ready; each client runs its own sim, streams
  its position/pose ~10×/s, and draws the other as a live ghost (reuse the engine's ghost views). On finish each
  client sends its replay; the server re-simulates it (existing replay verification) and announces the winner by
  verified time. Disconnects end the race calmly.
- No changes to `web/src/core/sim/**`. Engine changes are allowed for split screen and live ghosts.

## 5. Files per lane (work only in your worktree; merge conflicts are resolved by the orchestrator)

- **P:** `web/src/core/sim/**` (physics parts), `web/src/core/build/compile.ts` (body entities), `web/src/core/bot/**`
  (body awareness), `web/src/core/art/**` (material art), `web/src/engine/**` (body views), block studio/library
  behaviour chips in `web/src/app/ws/**` and `web/src/editor/**`, physics conformance levels `v5_physics_*.json`,
  tests, `shared/spec/messages-v5/physics.json`.
- **L:** sim (flipbook, conditions, choices), compile (flipbook entities), `core/logic/**` (parse + describe),
  bot (choices), engine (flipbook frames, choice bubble, inventory HUD), studio (frames strip), vision mind
  logic prompt/fallback (conditions), `shared/spec/messages-v5/logic.json`, `v5_logic_*.json`, tests.
- **S:** sim (script interpreter), compile (scripted entities + scripts), `build/hash.ts`, bot, engine (scripted
  views), studio (script editor), vision (blocks accept/validate scripts; seed 3 example packs in
  `vision/app/seed_blocks.py`), `docs/v5/PACKS.md`, `shared/spec/messages-v5/packs.json`, `v5_scripts_*.json`, tests.
- **M:** `web/src/app/**` (race UI), `web/src/engine/**` (split screen, live ghosts), `vision/app/routers/v2/live.py`
  or a new race module, `shared/spec/messages-v5/race.json`, tests.

Strings: v5 lanes put sentences in `shared/spec/messages-v5/<lane>.json` (`{"messages": {...}}`); add your file to
the loaders the way `messages-v4/*.json` are merged (`web/src/app/messages.ts`, `web/src/render/text.ts`,
`vision/app/mind/messages.py`, `web/src/core/__tests__/contracts.messages.test.ts`), keeping the loader edit minimal
so four branches merge cleanly. Same sentence rules as before.

## 6. Environment and workflow

Same as `docs/v4/CONTRACTS_V4.md` §10 (Node 22 with `NODE_OPTIONS="--experimental-strip-types
--disable-warning=ExperimentalWarning"`, Python at `C:\Users\kavya\.draw-play-env\venv\Scripts\python.exe`, run
pytest from your worktree's `vision/` so `app` resolves to your copy). Your worktree has no `node_modules`: run
`npm ci --prefer-offline --no-audit --no-fund` in `web/` first. Do not start servers on ports 8000 or 5173 (the user
is testing on them); use another port (e.g. 5190/8090) if you must run one. Commit your work on your worktree branch
with clear messages when it is done and tested (the user approved local commits); never push, never touch the main
working tree.

## 7. Changelog

- 2026-10-10: v5 contracts and spec (orchestrator).
