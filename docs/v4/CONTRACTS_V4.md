# draw.play v4: modes, rules, blocks and the creator workspace

Several lanes build v4 at the same time. This file is the handshake: code against it, never against another lane's
internals. The Pydantic models in `vision/app/spec/` (`logic.py`, `blocks.py`, the v4 parts of `common.py`,
`rules.py`, `behavior.py`, `level.py`, `library.py`, `api.py`) are the source of truth for every shape named here;
`web/src/core/types.gen.ts` is generated from them. Only the orchestrator changes the spec. If you need a change,
stop and say so in your final report with the exact field you need.

## 1. Principles

1. **v2 levels do not change.** Every v4 field is optional and defaults to "absent". A level without v4 fields must
   validate, hash (`level_hash`) and simulate exactly as before, frame for frame. `cli.ts selftest`, the conformance
   levels and the goldens in `shared/golden/` are the proof; they must keep passing.
2. **Rules are data, never code.** The kid's words become `RuleV4` objects from a fixed vocabulary. The model may
   pick from that vocabulary; it never writes code.
3. **Determinism.** The sim, bot and replay code keep the lint bans (`web/src/core/util/lint.ts`): no `Math.random`,
   `Math.sin/cos/tan/atan2/exp/pow`, `Date`, `performance`. Time is whole frames: `frames = round(seconds * 60)`.
   Every new piece of sim state lives in `SimState`, is copied in `cloneState()` and is part of `hash()`.
4. **The bot still guards fairness.** A level is publishable when the bot clears it. Where the bot cannot judge a
   v4 level well, it reports `solvable` honestly and marks the report approximate (`reason`), never a fake "yes".

## 2. Logic: the rules engine (`app/spec/logic.py`)

`RuleV4 {id, when: RuleWhen, then: RuleDo[1..4], once}`. Game-wide rules: `GameRules.logic`. A level's own rules:
`LevelV2.compiled.logic`. Each frame, after contacts and before the goal check, the sim evaluates
`rules.logic ?? []` then `compiled.logic ?? []`, in array order; actions of one rule run in order.

### 2.1 Triggers (edges, never "while held")

| kind | fires when |
|---|---|
| `start` | on the first simulated frame of each life (start and every respawn) |
| `key` | the key's input bit goes from 0 to 1 (`space` = bit 64, `action` = bit 128) |
| `touch` | the player's body starts overlapping the entity (was not overlapping last frame) |
| `collect` | `target` set: that entity is collected this frame. `item` set: any pickup with that item name is collected; `item: "coin"` = any coin or big coin |
| `all_coins` | the frame the last coin of the level is collected (fires once) |
| `timer` | `seconds` after the clock starts (the first input); with `every`, at every multiple of `seconds` |
| `zone` | the player's feet point enters `rect` (cells, half-open) |
| `score` | the score crosses from below `at_least` to at least `at_least` |
| `counter` | the named counter crosses from below `at_least` to at least `at_least` |

`once: true` = the rule fires at most once per life.

### 2.2 Actions

`seconds: null` = until the player respawns. A new timed effect of the same kind replaces the old one.

| kind | effect |
|---|---|
| `flip_gravity` | the player's gravity sign flips (see 2.3) |
| `gravity` | gravity × `times` for `seconds` |
| `speed` | walk and run speed × `times` for `seconds` |
| `jump_power` | jump launch speed × `times` for `seconds` |
| `reverse_controls` | left and right swap for `seconds` (top-down: up and down too) |
| `teleport` | the player's feet go to cell `to`, or onto entity `target` (its centre); velocity is kept |
| `toggle` | entity `target` is shown (`on`), hidden (`off`) or swapped (`flip`); hidden entities are inert (not drawn, not solid, no contact, no motion) |
| `open` | opens door `target` (as a key would) |
| `freeze_enemies` | enemies and blobs stop moving for `seconds` (contact still hurts) |
| `add_score` | score += `n` (score starts at 0; coins do not add to it unless a rule says so) |
| `add_counter` | counter `name` += `n` (counters start at 0) |
| `heal` | +1 heart, up to `GameRules.hearts` |
| `hurt` | the same as touching a hazard (cause `rule`) |
| `win` / `lose` | win or lose the level now |
| `say` | speech bubble over the player (or `target`) for `seconds` |
| `sound` | emits a `sound` event with `name` (no state) |
| `shake` | emits a `shake` event (no state) |

### 2.3 Gravity flip

When the sign is −1, "down" points up for the player only: gravity pulls toward the ceiling, the player lands on and
walks along the underside of solid tiles, one-way tiles and one-way platforms do not hold the player, a jump
launches toward +y, and leaving the top of the world (y < −2 cells) is a pit death. Enemies are not flipped.
On respawn: gravity sign 1, every timed effect cleared, no speech bubble. Score, counters, `once` latches and
toggled entities follow the checkpoint rules that coins and opened doors already follow.

### 2.4 Written rules

`core.parseLogic(sentences: string[], entityIds: string[]) → LogicParseResult` (offline keyword parser, also worker
method `parse_logic {sentences, entity_ids?}`), and `POST /api/v2/logic/parse` (Claude when a key is set, the core
parser otherwise). Must understand at least: "space flips gravity", "press E to flip gravity", "enter makes you
fast", "every 10 seconds lava rises" (unknown: lava rising is not a v4 action, it goes to `unknown`), "get all coins
to win", "touching the star gives you a speed boost", "it's like flappy bird" (→ mode flappy), "top-down",
"runner", "you have 3 hearts" (not logic: unknown), "collect 5 stars to win" (counter or item collect + counter
rule). Rule ids: `r1`, `r2`, … in sentence order.

**Into a build.** `BuildInputJson` gains optional `logic` and `mode`. Lane C: when a build has typed rules and the
model is available, it calls the logic model and passes the result as `logic` (and `mode` when a sentence names
one). Lane A: when `logic` is null, `build()` runs `parseLogic` on `ink.typed_rules` itself; the result goes into
`compiled.logic`, and `mode` (given or parsed) into the level's resolved rules snapshot. Sentences that became v4
rules must not also produce v2 `parseRules` edits.

`core.describeRule(rule) → MessageRef[]` returns one sentence per part ("When you press space", "flip gravity")
using `logic.when.<kind>` and `logic.do.<kind>` keys (lane A adds them to `messages-v4/core.json`). The UI shows
rule cards with it.

## 3. Modes (`GameRules.mode`, null = platformer)

| mode | rules |
|---|---|
| `platformer` | v2, unchanged |
| `runner` | horizontal input is forced: Left ignored, Right always held (Run as the abilities allow); otherwise platformer |
| `flappy` | forced right at walk speed; each Jump press (edge) sets vy = −0.8 × `jump_base`, in the air too; gravity × 0.6; no coyote time, no double jump; the ground is still solid |
| `topdown` | no gravity and no jumping. Left/Right/Jump(=up)/Down move at walk speed (Run as the abilities allow). Solid tiles and solid entities block in every direction; one-way tiles are floor you walk over; the world edges are walls (no pits); lava, spikes, saws hurt; springs push along their `dir`; walkers patrol without falling; chasers chase in 2D; no stomps (touching an enemy hurts) |

The camera, the world size (48 × screens by 27 cells) and the view are the same in every mode. `SimView.mode`
reports the mode.

## 4. Sim, input and view contract (lane A writes it, lanes B and D read it)

### 4.1 Input bits (`web/src/core/sim/types.ts`)

`IN_L 1, IN_R 2, IN_J 4, IN_RUN 8, IN_D 16, IN_RESTART 32` (unchanged), new `IN_SPACE 64`, `IN_ACTION 128`,
`INPUT_MASK 255`. The replay codec accepts all 8 bits (`Replay.v` stays 1: old replays never set them).
Keyboard (lane B): E and Enter → `IN_ACTION`. Space → `IN_SPACE` **only when the level has a `key: space` rule**
(then jump stays on W / Up / Z); otherwise Space stays jump as in v2. Touch: an action button appears when a rule
uses a key.

### 4.2 SimView additions

```ts
mode: GameMode;                       // 'platformer' when rules.mode is null
gravity: 1 | -1;
score: number;
counters: Record<string, number>;     // only names some rule mentions, starting at 0
effects: { speed_f: number; jump_f: number; gravity_f: number; reverse_f: number; freeze_f: number };
                                      // frames left; −1 = until respawn; 0 = off
say: { text: string; target: string | null; frames_left: number } | null;
uses_keys: RuleKey[];                 // keys some rule listens to (for the controls)
```

`PlayerView.gravity: 1 | -1` (the sprite draws upside down at −1). `EntityView.active` is false for hidden
entities. New `EntityView.type` values `portal`, `zone`, `pickup`, `npc` (fields: `kind` = zone effect or pickup
item; `state` = 'idle' | 'used'; `w`, `h` for zones and npcs).

New `SimEvent.type` values: `flip`, `teleport`, `portal`, `pickup`, `say`, `sound`, `shake`, `score`, `toggle`,
`freeze`, `rule` (a rule fired; `id` = rule id). New optional fields `name?: string` (sound name, counter name,
pickup item) and `text?: string` (say).

## 5. v4 primitives (entities and behaviours)

| behaviour (library types, blocks) | entity in `compiled.entities` | sim |
|---|---|---|
| `BPortal {pair}` | `EPortal {x, y, pair}` (centre; pair = partner portal id) | touching teleports to the partner's centre, velocity kept; 30-frame cooldown on both portals |
| `BZone {effect, dir, strength}` | `EZone {x, y, w, h, effect, dir, strength}` | while the feet are inside: wind pushes 220 px/s² × strength toward `dir`; conveyor moves the player 60 px/s × strength while grounded; water: gravity × 0.35, max fall 90 px/s, Jump swims up anywhere; ice: friction × 0.15; low_gravity: gravity × 0.5; slow: speed × 0.5 |
| `BPickup {item, effect, seconds, respawn_s}` | `EPickup {x, y, item, respawn_s}` and, when `effect` ≠ none, one rule in `compiled.logic` `{when: collect target, then: [effect action]}` | collected on touch; fires `collect`; comes back after `respawn_s` when set |
| `BNpc {lines, name}` | `ENpc {x, y, w, h, lines, name}` | on touch shows the next line as `say` (target = the npc) for 3 s |

Effect → action map for pickups: speed → `speed ×1.6`, jump → `jump_power ×1.4`, flip → `flip_gravity`,
heart → `heal`, score → `add_score 10`, freeze → `freeze_enemies`, low_gravity → `gravity ×0.5`; timed ones use the
pickup's `seconds`.

Any entity may carry `hidden: true` (starts hidden; a `toggle` rule shows it). Compile emits it when a library type
or a binding asks for it.

## 6. HTTP API (lane C implements, lane D calls). All under `/api/v2`; identity header `X-DP-Player`.

| method, path | body → result | notes |
|---|---|---|
| GET `/blocks?q=&kind=&sort=new\|popular&author_id=&limit=&offset=` | → `BlockList` | public library |
| POST `/blocks` | `BlockCreate` → `BlockCard` | needs a player; blocklist and moderation like library names |
| GET `/blocks/{id}?v=` | → `BlockCard` | newest when `v` is absent |
| POST `/blocks/{id}/versions` | `BlockCreate` → `BlockCard` | author only; version n+1 |
| POST `/blocks/describe` | `BlockDescribeBody` → `BlockDescribeResult` | Claude when a key is set, keywords otherwise |
| POST `/games/{id}/blocks` | `UseBlockBody` → `UseBlockResult` | object → a new library type in the game (`block` = ref); rules → appended to `GameRules.logic` with ids `<block_id>_<rule id>`; records a use; credits the block's author (credit kind `block`) |
| POST `/logic/parse` | `LogicParseBody` → `LogicParseResult` | |
| GET `/dashboard` | → `Dashboard` | needs a player |
| GET `/games/{id}/export/tiled` | → zip | one Tiled `.tmj` per listed level plus a tileset image |
| GET `/games/{id}/export/minecraft` | → zip | a datapack: one `.mcfunction` per level that builds it |
| POST `/games/{id}/export/minecraft/live` | `MinecraftBody` → `MinecraftResult` | RCON; never log or store the password |
| PUT `/games/{id}/rules` | existing | mode and game-wide logic travel in `GameRules` |

`POST /builds` records `{draft_id, player_id, game_id, kind, title, updated_at}` in a new `drafts` table so the
dashboard can list unpublished drafts.

## 7. Workspace UI (lane D)

Routes (owned by the orchestrator in `web/src/app/main.ts`): `#/` workspace home, `#/games` my games, `#/new` new
game, `#/explore` the old home feed, `#/blocks` blocks library, `#/blocks/new` and `#/blocks/:id` block studio,
`#/game/:id` game workspace (levels, canvas, inspector tabs Rules / Legend / Blocks / Style / Bot / Send to),
`#/styles`, `#/templates`. Every v2/v3 route keeps working.

## 8. Strings

Every visible sentence goes through `t()`. v4 sentences live in lane files merged over `messages.json` at load
time: `shared/spec/messages-v4/{shell,core,engine,api,ui}.json` (`{"messages": {...}}`). Each lane writes only its
own file. Same rules as messages.json: ≤ 20 words per sentence, `{placeholders}` only, no snake_case in values.
Prefixes: shell `nav.*`, `ws.*`, `mode.*`, `new.*`; core `logic.*`, `prim.*`; engine `hud.*`, `play4.*`;
api `blocks.err.*`, `export4.*`, `api4.*`; ui `blocks.*`, `studio4.*`, `gw.*`, `legend.*`, `send.*`.

## 9. Lanes and file ownership (no overlaps; ask before touching another lane's files)

- **Orchestrator:** `vision/app/spec/**`, `shared/spec/*.schema.json`, `web/src/core/types.gen.ts`,
  `scripts/gen_contracts.py`, `docs/v4/**`, `web/src/app/main.ts`, `web/src/app/shell.ts`,
  `web/src/app/v4api.ts`, `web/src/app/screens/{workspace,games,new_game}.ts`, `web/src/app/style.css`,
  `shared/spec/messages-v4/shell.json`, `web/src/core/build/hash.ts`.
- **Lane A, core:** `web/src/core/**` except `art/`, `build/hash.ts` and `types.gen.ts`; `shared/spec/params.json`,
  `shared/spec/physics-profiles.json` (via gen-spec-data); new v4 conformance levels in
  `shared/spec/conformance/levels/valid/v4_*.json`; `shared/spec/messages-v4/core.json`.
- **Lane B, engine:** `web/src/engine/**`, `web/src/core/art/**`, `web/src/render/**`,
  `shared/spec/messages-v4/engine.json`.
- **Lane C, api:** `vision/app/**` except `vision/app/spec/**`; `vision/tests/**`; `shared/spec/messages-v4/api.json`.
- **Lane D, ui:** `web/src/app/**` except the orchestrator's files; `web/src/editor/**`; `web/src/app/ws/**`
  (new: panels and `ws.css`); `shared/spec/messages-v4/ui.json`.

Nobody commits; the orchestrator does. Do not start servers on ports 8000 or 5173 (the orchestrator's preview uses
them); use another port if you must run one.

## 10. Environment (Windows, this machine)

- Node 22 runs the core's `.ts` files with `NODE_OPTIONS="--experimental-strip-types --disable-warning=ExperimentalWarning"`
  (set it for every node, npx and vitest command). The selftest check "node >= 24" fails here; ignore it.
- Python: `C:\Users\kavya\.draw-play-env\venv\Scripts\python.exe` (no uv). Tests:
  `cd vision && PYTHONUTF8=1 NODE_OPTIONS=... <python> -m pytest -q`. Web tests: `cd web && npx vitest run`.
  Core checks: `node web/src/core/cli.ts selftest`, `npx tsc --noEmit -p src/core/tsconfig.json`, `npx tsc --noEmit`.
- Regenerate contracts (orchestrator only): `cd vision && <python> ../scripts/gen_contracts.py`.
- Baseline before v4 (pre-existing failures, not yours): web 5 failing tests (tap.test, art.api stub test,
  contracts.api replay test, contracts.fresh (needs uv), worker.rpc stub test); python 9 failing (test_api_v2
  scaffold tests expecting 501s, test_bridge stub test, test_mind_client prompts list, test_spec_fresh without uv).

## 11. Changelog

- 2026-10-10: v4 contracts written (orchestrator).
- 2026-10-10: `DashboardGame.to_fix` counts hard/block flags only (warn flags are notes, not fixes).
- 2026-10-10 (lane B): E/Enter send `IN_ACTION` only on levels with a `key: action` rule, so v2 levels never record
  bit 128. `PlayerView.y` is the bottom of the 28 px body box in both gravities; upside down the engine draws the
  feet at `y − 28 px`.
- 2026-10-10: `RuleV4.off` (optional; true = kept but never fires). `hidden` on `LibraryType`, `OpBind` and
  `OpUseLibrary` replaces the `x_hidden` workaround. `POST /builds` accepts a `mode` form field (the editor's mode).
- 2026-10-10: starter overrides take `logic` and `mode`, and four `draw` kinds (`portal`, `zone`, `pickup`, `npc`);
  `shared/starter/showcase/S1..S4` build the "draw.play Showcase" game (`starter:build showcase`), seeded as
  `game_showcase`. `vision/app/seed_blocks.py` seeds 18 starter blocks by the draw.play team.
- 2026-10-10 (lane C): stored game rules write `mode: "platformer"` and an empty `logic` as null (hash stable).
  Minecraft live RCON only reaches loopback and private-network hosts unless `DAL_MC_HOSTS` lists the host.
