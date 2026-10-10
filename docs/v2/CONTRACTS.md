# v2 contracts (v1.4)

Version **1.0**, frozen at the end of P0 (2026-10-10, P0 scaffold agent). PLAN_V2.md is the design. This file records:
- what each contract is and where its source of truth lives;
- every place where P0 had to pin down something PLAN_V2 left open, or deviate from it;
- every later contract change.

Lane B (spec owner) maintains this file.

## 1. How a contract changes

A contract change is a **contract PR**. It needs:
- an entry in §5 below that names the affected lanes;
- the regenerated artifacts;
- updated fixtures.

Regenerate with:

```sh
cd vision && uv run --no-sync python ../scripts/gen_contracts.py      # shared/spec/*.schema.json + web/src/core/types.gen.ts
node web/src/core/cli.ts gen-spec-data                                # shared/spec/params.json + physics-profiles.json
cd vision && uv run --no-sync python -m app.build.events --write-sample   # shared/spec/conformance/events/sample_build.jsonl (lane D)
```

Staleness tests fail when a generated file is out of date:
- `vision/tests/test_spec_fresh.py`
- `web/src/core/__tests__/contracts.fresh.test.ts`
- `cli.ts selftest` (params/profiles)

To ask another lane for a change, write `docs/v2/requests/<lane>-<n>.md`.

## 2. Inventory

| Contract | Source of truth | Generated / published | Owner | Checked by |
|---|---|---|---|---|
| Format schemas (13 modules) | `vision/app/spec/{common,behavior,ink,edits,scene,report,rules,library,level,events,runs,plan,api}.py` (Pydantic v2) | `shared/spec/<name>.schema.json` (runs → `run.schema.json`); `web/src/core/types.gen.ts` (one file, json-schema-to-typescript 15.0.4) | B | `test_spec_fresh.py`, `contracts.fresh.test.ts` |
| Conformance levels | `shared/spec/conformance/levels/{valid,invalid}/*.json` (README there) | - | B | `test_spec_conformance.py`, `contracts.conformance.test.ts`, `cli.ts selftest` |
| Sample SSE stream | `vision/app/build/events.py` `build_sample_events()` (from the core's stub fixtures) | `shared/spec/conformance/events/sample_build.jsonl` | D | `test_spec_models.py`, `test_api_v2.py`, `src/app/__tests__/messages.test.ts` |
| Tunables, param grids, model call table | `web/src/core/params.ts` | `shared/spec/params.json` | B (values owned by the lane that uses them) | `contracts.fresh.test.ts`, selftest |
| Physics profiles | `web/src/core/sim/profiles.ts` | `shared/spec/physics-profiles.json` (+ `profile_hash`) | A | same |
| TS core API | `web/src/core/index.ts` (+ lane dirs) | - | B (A, E implement their parts) | `contracts.api.test.ts`, selftest |
| Worker RPC | `web/src/core/worker/dispatch.ts` (methods, required params); `vision/app/spec/api.py` (`WorkerRequest/Response`) | - | B implements, D calls (`vision/app/build/bridge.py`) | `worker.rpc.test.ts`, `test_bridge.py` |
| HTTP API v2 | `vision/app/spec/api.py` (bodies), `vision/app/routers/v2/*` | - | D provides, F consumes (`web/src/app/api.ts`) | `test_api_v2.py` |
| Engine/render API | `web/src/engine/types.ts`, `web/src/engine/index.ts`, `web/src/render/index.ts` | - | E provides, F consumes | P1 |
| Messages | `shared/spec/messages.json` | - | F | `contracts.messages.test.ts`, `src/app/__tests__/messages.test.ts` |
| SQLite v2 | `vision/app/db_v2.py` (additive, idempotent) | live `dal.sqlite` migrated at startup | D | `test_db_v2.py` |
| Model-facing schemas | `vision/app/mind/schemas.py` (slim, enum-only; not part of the format) | - | D | `test_mind_client.py`, `scripts/latency_bakeoff.py` |
| Paper template v2 | `shared/template_spec_v2.json` (initial version; rules/library sheet boxes are drafts) | - | C | P1/P5 |
| Golden inputs and expectations | inputs `shared/golden/<id>/{input.*,strokes.json,prompt.txt,gt.json}` (C); `expect.json`, `notes.md` (B) | `scripts/make_golden_inputs.py` | C / B | P1 `npm run golden` |
| Legacy v1 schema | `shared/spec/legacy/level-v1.schema.json` (copy of `shared/level.schema.json`, which stays until P6) | - | B | - |

## 3. P0 clarifications and decisions

Each item pins down something PLAN_V2 leaves open, or deviates from it. Lanes rely on these.

### 3.1 Schema conventions
- **Strictness and `x_*` extension keys.**
  - Every model derives from `Spec` (`vision/app/spec/common.py`). Unknown keys are rejected unless they start with
    `x_`. Extension keys validate, round-trip and are ignored by engines.
  - Published schemas say `"additionalProperties": false` plus `"patternProperties": {"^x_": {}}`.
  - `types.gen.ts` drops `patternProperties`, so TS types do not grow index signatures.
  - The model-facing `plan.py` beats are plain strict models with no `x_*` allowance, because they double as the
    PLAN output schema.
- **Python aliases.** Fields named after Python keywords use aliases: `EditRecord.cls` ↔ `"class"`;
  `RouteStep/Segment/DesignSegment/Blocking/Morph.from_` ↔ `"from"`. Models validate by name or alias and serialize
  by alias.
- **Optional and required in TS.** Fields with defaults are optional in TS (serialization-mode schema). Producers
  (core and Python) should still emit them.
- **Named aliases.** Unions and enums are `TypeAliasType`s, so they appear as named `$defs` and named TS types:
  `Role`, `Behavior`, `EditOp`, `Shape`, `Entity`, `BuildEvent`, `NovelOp`, `Binding`, and so on.
- **Renamed type.** The design pick type is `DesignPick` (not `Pick`), so it does not shadow TS's `Pick<>`.

### 3.2 `level_hash` and canonical JSON (§2.5 made exact)
- **Canonical JSON:**
  - keys sorted (code-unit order), no whitespace;
  - **object members whose value is `null` are omitted**;
  - numbers are rounded half-up as `floor(x·10000 + 0.5)` (never banker's rounding) and printed as an integer, or
    with up to 4 decimals and no trailing zeros (`2.0` → `2`);
  - strings are printed as in `JSON.stringify`.
- **Hash input:** `{world, rules, tiles, entities (each without sprite and origin), triggers}`.
- **Raw JSON only.** Always hash the raw level JSON, never a model re-dump, because defaults would change it.
- **Implementations:** `web/src/core/build/hash.ts` and `vision/app/spec/level.py` (`canonical_json`,
  `level_hash`). They are byte-identical on every conformance level (tested both ways).

### 3.3 Level and ink
- **World types.** `World` is `{cell: 16, screens 1..6, w = 48·screens, h: 27}`. `InkDoc.world` is `InkWorld`, the
  same without `cell` (§3.2).
- **`LevelInk`.** `LevelV2.ink` is a `LevelInk`: an InkDoc without `v/source/world/sheets/parent`, matching the
  §2.2 example.
- **SSE tier events.** In a `tier` event, `level.ink` is omitted and **`level.ink_ref`** (a new optional field) holds
  `drafts/<draft_id>/ink.json`.
- **Semantic checks.** `LevelV2` checks that tile rows decode to `world.w × world.h`, and `World` checks
  `w = 48·screens`. JSON Schema cannot express these. Conformance files named `invalid/semantic_*` exercise them.
- **`core.validateLevel()`.** It runs the published level schema, embedded as `LEVEL_SCHEMA` in `types.gen.ts`
  (there are no JSON imports in core), plus the same semantic checks. It uses a small JSON Schema interpreter in
  `core/util/schema.ts`.
- **Entities** form a 16-way union on `type`:
  - `player_start`, `spikes`, `enemy`, `coin`, `big_coin`, `checkpoint`, `goal`, `key`, `door`;
  - `spring`, `saw`, `firebar`, `moving_platform`, `crumble`, `falling_platform`, `hint_arrow`.
  - `enemy.archetype` also allows `static` (Faithful drawn monsters).
  - `sprite` and `origin` are art-only fields.
- **Behaviors** form an 8-way union on `kind`: `static`, `enemy`, `move`, `spring`, `crumble`, `falling`, `saw`,
  `firebar`.
  - Values are numbers from the §5.6 grids.
  - Model enums (`slow/normal/fast`, `small/normal/big`) are mapped by the sanitizer through `params.json` `GRIDS`.
  - `move.cells` has no lower bound in the schema: N12 fits or drops degenerate paths, and the schema never rejects
    a kid's chip.
- **Rules.**
  - `GameRules.lives` is `"off" | 3 | 5`.
  - `default_dial` is `faithful | polished | challenging`; `default_band` is `normal | hard`.
  - `profile_hash` is optional; it is `profileHash(id)`, the sha256 of the profile's canonical JSON.
- **Edits.** `EditRecord` gains two optional fields: `reject_reason: MessageRef` and `cid`.
- **`straighten`.** It takes optional `mode` and `max_shift` (≤ 0.85). The §3.5 table names `mode` and the §2.2
  example uses `max_shift`.
- **Op parameters left open by §3.5:**
  - `detach.branch` (a stroke id);
  - `place_start.at` and `clear_spawn.{start_dx, trimmed}` (computed);
  - `tune.step` (`1 | 2`);
  - `set_timer.k` (1.5 to 2.0);
  - `set_par.par_ms`.
  - Schema bounds are the contract's hard limits. The per-tier clamps live in `core/edits/vocabulary.ts`.
- **`Candidate` (menu row):**
  - fields: `cid`, `generator`, `op`, `extra_ops` (macro atoms), `tiers` (allowed tiers, lowest first), `alts`,
    `summary_key`/`summary_args`, `dC`, `dT_s`, `dF_s`, `drift`, `intent_cost`, `fixes`, `measured`;
  - edit and candidate ids follow `EDIT_ID_RE` (`op:target:hash6`).
- **`AskCard`:**
  - fields: `{id, about, kind, message_key, args, options[{id, label_key, label_args, ops: EditOp[], tap_target}],
    default_option, answer, by}`;
  - the default option is applied when publishing with the ask unanswered.
- **`SceneGraph`** is `{objects, setpieces, intent, difficulty_wish, title, safety}`.
- **`SceneObject`** adds `alt` (re-label chips), `lib` and `text`.

### 3.4 Events (SSE, §3.11)
- **Persisted envelope.** Each persisted line is `{"seq", "event", "data"}`; the type is `BuildEvent`, a 13-way
  union on `event`. The SSE wire format is `id: seq` / `event: name` / `data: <payload>`.
- **Resume.** Resume uses the `Last-Event-ID` header, or the query alias `?last=<seq>` for clients that cannot set
  headers. The heartbeat is `: ping` every 10 s.
- **`saw` events** carry an optional `stage`.
- **Sample stream.** `sample_build.jsonl` has 35 events and covers all 13 names: 12 `tier` events (3 stages × 4
  tiers), plus `ask`, `warning`, a non-fatal `error` and late `suggestions`.

### 3.5 Python ↔ core wire forms
- **Sanitized model output.** `PerceptionJson` and `DesignPlanJson` (`api.py`) are the sanitized forms the core
  receives:
  - confidence is a number (0.9 / 0.75 / 0.5);
  - speeds and strengths are numbers from the grids;
  - the model tier `polish` becomes `polished`;
  - `tune.step` is `1 | 2`;
  - `Binding` stays a discriminated union.
- **PERCEIVE output schema (bakeoff).** The API **rejected** the 10-variant `Binding` union inside the model-facing
  `Perception` ("compiled grammar is too large"). The model therefore answers with `PerceptionFlat`: one `FlatBinding`
  with sentinels (-1 / "none" / 0 / ""). `mind/schemas.unflatten()` re-validates each binding per variant, and a key
  without a door yields `None`, which becomes an Ask card. The wire form above is unchanged. Details:
  `docs/v2/latency.md`.
- **Mirrored build types.** `BuildInputJson`, `BuildResultJson` and `TierSetJson` mirror the TS interfaces in
  `index.ts`. `contracts.api.test.ts` asserts that they stay mutually assignable.

### 3.6 TS core
- **File layout.** `index.ts` declares `BuildInput`/`BuildResult`/`TierSet` and re-exports each lane's functions
  from that lane's directory:
  - B: `ink/`, `scene/`, `build/`, `design/`, `generate/`;
  - A: `sim/`, `bot/`, `replay/`;
  - E: `art/`.
  - Lanes edit their own directories, never `index.ts`.
- **Plan types.** `LevelPlanJson` is an alias of the generated `LevelPlan`. `PerceptionJson` and `DesignPlanJson`
  are generated.
- **Hand-written types.** Runtime types not in the format are written by hand:
  - `sim/types.ts`: `PhysicsProfile`, `Sim`, `SimEvent`, `SimView`, `CameraState`, `SimSnapshot`;
  - `art/types.ts`: `ArtDoc`;
  - `bot/index.ts`: `AnalyzeOptions`.
- **Stubs.** Every stub throws `NotImplemented('<fn>')`. Real at P0: `levelHash`, `validateLevel`, `encodeReplay`,
  `decodeReplay`, `PROFILES` (+ `profileHash`). `API_FUNCTIONS` and `P0_REAL` list them.
- **Replay `input`.** It is base64 of 3-byte records: **u16 little-endian run (1..65535)**, then **u8 bits**
  (L=1, R=2, J=4, RUN=8, D=16). One byte per frame decoded.
- **Core rules.** They are enforced by tsc (`verbatimModuleSyntax`, `erasableSyntaxOnly`), by
  `__tests__/contracts.lint.test.ts` (the TS compiler API checks `import type`), by `determinism.lint.test.ts`, and by
  `cli.ts selftest`:
  - Node-only files (`cli.ts`, `worker/{main,pool,stub}.ts`, `__tests__/`) may import `node:*` and reference
    `@types/node` with a triple-slash directive;
  - every other core file must stay browser-safe.
- **`cli.ts selftest`** has two modes:
  - default (stub) mode reports stubs and is the P0 gate;
  - `selftest --real` (or `DAL_CORE_REAL=1`) fails on any stub and is the P1 gate.
- **Unfinished commands.** `golden`, `starter:*`, `calibrate`, `envelope` and `bench` exit with code 2 until their
  lanes land.
- **Worker processes.** They never call `process.exit()` while output is pending, because that truncates pipes. They
  exit when stdin closes. The CLI uses `process.exitCode` for the same reason.
- **Stub mode.** With `DAL_CORE_STUB=1`, the worker answers every method except `ping` with contract-valid fixtures
  built from `example_2screen.json` (`worker/stub.ts`); `level_hash` is always real. `PingResult` carries `stub`.

### 3.7 Python platform
- **Guarded mount.** `vision/app/main.py` mounts `/api/v2` behind a guarded import: any exception at import or mount
  disables v2 and logs, and `DAL_V2=0` turns v2 off. The v2 lifespan runs `db_v2.migrate()` and starts the
  `CorePool`, and v1 startup never depends on it. Tested in three cases: v2 healthy, v2 import failing, and
  `DAL_V2=0`.
- **`config.py`** adds `SettingsV2` / `get_settings_v2()`, which reads the §11.3j env. Its `llm_mode` is:
  - `fake` when `DAL_FAKE_LLM=1`;
  - `live` when a key is set;
  - `off` otherwise.
  - This differs from v1, where no key means `fake`.
- **CorePool** (`app/build/bridge.py`):
  - **API:** `CorePool(n, node, stub)`, `await start()/stop()`, `await call(method, params, timeout_s=None)`,
    `state()`, `info()`. Default timeouts follow the §11.3c table.
  - **Errors:** `CoreError.code` is one of `timeout | invalid | internal | down`. `down` is Python-only and means no
    worker could answer.
  - **Retries:** restart + 1 retry happens on `timeout` and `down`, never on `invalid` or `internal`.
  - **Singleton:** `get_pool()`/`set_pool()`.
- **Ids.** Draft ids are `d_[0-9a-f]{8}` and build ids `b_[0-9a-f]{8}`. The `builds` table maps build → draft.
- **P0 build stub.** `POST /api/v2/builds` runs `app.build.orchestrator.run_build`, which at P0 replays the sample
  stream with the build's ids into `drafts/<draft_id>/events.jsonl`. `GET /drafts/{id}?since=` returns
  `{state: running|done|failed, events}`.
- **501 responses.** Every other §11.3(e) route answers **501 `{message_key: "error.not_implemented", args: {route}}`**
  (`ApiMessage`).
- **Mind client** (`app/mind/client.py`):
  - **Call shape:** `beta.messages.parse` on **AsyncAnthropic** (it exists in anthropic 1.13.0), with
    `fallbacks="default"` + beta `server-side-fallback-2026-07-01`, `max_retries=0` plus one 529 retry, and
    `stop_reason` checked before `parsed_output`.
  - **Result:** `MindResult[T]` never raises.
  - **Ledger:** every request is written to `model_calls`, including failed ones (`ok=0`).
  - **Budget:** `budget.allow` uses UTC-day spend and per-draft spend from `model_calls`.

### 3.8 Bakeoff decisions (P0 gate, details in `docs/v2/latency.md`)
- **Thinking disabled: not adopted.** PERCEIVE p50 dropped only 11%; the rule requires ≥ 30%. Runtime calls keep
  `thinking` omitted.
- **DESIGN at low: not kept as the synchronous designer.** p50 was 14.9 s; the rule requires ≤ 10 s. Picks were 95%
  valid.
  - DESIGN runs **at medium on the async suggestions path only**, and **the greedy tiers are the synchronous
    Designed result**.
  - Recorded as `client.DESIGN_SYNCHRONOUS = False` and `CALLS["design"] = medium / 8000 tok / 45 s`.
  - Recorded in `params.ts` `MODEL.calls.design` (→ `params.json`).
  - Affects D (orchestrator: speculative DESIGN, transfer and DESIGN #2 deliver `suggestions` events) and F (the
    preview shows model picks as suggestions).
  - SSE event names and payloads are unchanged.
- **Async client: adopted.**
- **Fast mode: not measured.** Owner decision 1 stays off.
- **Call count.** The bakeoff counted "≤ 16 calls" as billed calls: 16 billed, $0.83. Including the 12 zero-token
  400 rejections of the union schema, it sent 28 requests.

### 3.9 Other P0 notes
- **Golden sources.** All five listed owner drafts exist (`d_b14b143e`, `d_dfbfe619`, `d_79eff85e`, `d_45f50934`,
  `d_23962d19`); none is missing.
  - G01-G06 `strokes.json` re-render byte-identically to the copied `input.png`.
  - G07-G10 carry the [M] probe's `gt.json` (v1 role names) as reference input.
  - Every `expect.json` has `"status": "skeleton"`. G11-G23 still lack near-cell locators, to be filled once
    `ink.json` exists (lane C, P1).
- **Messages.** `messages.json` has the shape `{version, locale, messages: {key: sentence}}`.
  - It covers every flag code, ask kind, stage and status, role, band and tier.
  - It covers every reason or summary key in the example level, the stub menu and the sample stream.
  - Sentences are ≤ 12 words, except texts quoted verbatim from PLAN_V2 (the tests allow up to 20).
- **Additive v1 edits** (all allowed by §11.2):
  - `vision/app/main.py`: guarded mount + lifespan;
  - `vision/app/config.py`: `SettingsV2`;
  - `web/vite.config.ts`: rollup input `v2: 'v2.html'`;
  - `web/tsconfig.json`: `allowImportingTsExtensions: true`;
  - `web/package.json`: scripts per §11.4 P0 item 9, plus pinned devDependencies `json-schema-to-typescript@15.0.4`
    and `@types/node@24.19.2` (types for the Node-only core files).
- **Live data.** The live `dal.sqlite` was migrated additively when the v1 server reloaded `main.py`:
  - v2 tables were created;
  - v1 tables gained nullable columns;
  - v1 behaviour is unchanged (`GET /api/health` answered throughout).

### 3.10 Lane B core conventions (v1.1, P1-P3 build)

No schema changed. These pin down what PLAN_V2 left open, as the core now implements it.

- **Entity geometry and rasterization** are stated in `docs/spec/level-format-v2.md` ("Entity geometry",
  "Rasterization details"). They match lane A's `sim/world.ts` (A-1 §1) and lane E's art (E-1). Vertical spike strips:
  `x0..x1` is the vertical range and `y` the face's x. Entity ids equal the scene object ids for kid objects (E-1 B.1).
- **Object ids.** `'o' + min component id` for the primary piece of a component; further pieces of one black component
  (a pole on a floor, a wall on a ledge) are `o<cid>_<k>`; a detached glyph that starts a new sign is `o<cid>_<stroke>`;
  designer additions are `e_<kind>_<hash6>[_<k>]` from their edit id; a synthesized goal is `e_goal`.
- **Self-describing slot ids** (`edits/slots.ts`). build() is a pure function of edit records, so a slot must resolve
  without the report that produced it. The core re-keys every bot slot (A-1 §2 conventions) into
  `slot.<kind>.x<X>-y<Y>[-h<host>][-f<face>][-a<x0>-b<x1>][-w<w>]` (kind ∈ cp coin risk enemy hazard spikes step
  spring hint). Coin trails use `arc.<fx>-<fy>-<tx>-<ty>-<apex>` as `add_coin_trail.action`; gaps use
  `gap.<left id>-<right id>`. DESIGN sees these ids in `digest().level_digest` and must use them in novel ops.
- **Extension keys the core writes** (all `x_*`, so every validator accepts them):
  - `SceneGraph.x_work`: the build state (start, fitted creatures, par, timer, drift budgets, added objects, repair
    alternatives). `BuildResult.graph` carries it so a result can be resumed (candidates, sandboxes). Level `objects`
    are stored without `x_*` keys.
  - G0 hints on objects: `x_detach: [{branch, into}]` (normalize turns them into U3 `detach` cards) and `x_ask`
    (the heuristic's question kind).
  - Ops: `set_role.x_conf` (model confidence), `bind.x_pinned` (pinned params, I4), `set_timer.x_seconds` (a timer
    read from text: class U, exact seconds), `form_goal.x_at` (synthesized goal), `place_start.x_repair` (a repair's
    alternative start).
  - Strokes (from lane F, F-1): `x_opens: <door stroke id>` on a key stroke → a kid `link` edit.
- **Statuses** are honoured by record id and by `editId(op)`; ids hash the op without its computed fields
  (`place_start.at`, `clear_spawn.start_dx/trimmed`, `set_par.par_ms`, `fix_behavior.value`).
- **Edits D sends** (D-1 §4) are accepted as described there: the core regenerates N, R and greedy P/C edits; an
  `undone` record is never re-applied or re-picked; applied P/C records (accepted suggestions) join every tier at or
  above theirs; R records by the model or kid at tier `faithful` (repair choices, Fix it) are applied before the search.
- **Worker RPC.**
  - `build` and `build_tiers` require only `ink` (+ `tier` / `deadlineMs`): `graph0` defaults to
    `perceive_heuristic(ink)`, `edits` to `[]`, `library` to `[]`, `parent` to null, `repairUnsolvable` to true
    (the editor's ▶ passes false), `seed` to 1.
  - `merge_perception` with `perceptions: []` returns the heuristic's own Ask cards (model off).
  - `parse_rules` takes an optional `target` component id (D-1 §3); a sentence may also start with `@<cid> `.
  - Heavy methods run on the worker's `worker_threads` pool (`DAL_CORE_THREADS`, default 3, 0 = inline). Responses
    can therefore arrive **out of order**; they are matched by id (the bridge already does).
- **Setpieces** (I3): the orchestrator puts `merge_perception(...).setpieces` into `graph0.setpieces` for the
  Understood build. With none, build() derives geometric setpieces (kid hazards, enemies, springs, keys and doors
  within 2 cells of the Faithful route, neighbours within 4 cells grouped, ≤ 4).
- **Merge** (D-1 §2): `BindEnemy.speed` is the archetype's grid value: c/s for walker/flyer/chaser, the interval in
  seconds for hopper and shooter, the warn time for crusher. Flat `FlatBinding`s are also accepted.
- **Ask options** carry their ops; tap options use the placeholder object id `"$tap"` (D-1 §4).
- **Features** (C-1 §1): `ensureComponents` recomputes `f`, `bbox` and `area` of every component with
  `featuresOf(computeGeo(strokes))` whatever the source; paper keeps its grouping. Definitions are in
  `web/src/core/ink/features.ts` (zigN = monotone runs per cell). `rules_ink` strokes are never in a component.
- **Bot fallback.** If `analyze` throws, the build still completes with an envelope-based report (`approx: true`) and
  the level warning `warning.bot_unavailable`; candidates then carry predicted (not measured) deltas.
- **Rejection reasons** are `MessageRef`s with keys `reject.*` (requested from lane F in `docs/v2/requests/B-1.md`).
- **Replay input bits** (A-1 §6): L=1, R=2, J=4, RUN=8, D=16, **RESTART=32** (starts the normal death sequence,
  cause `restart`); the byte layout is unchanged.
- **Paper constants** (C-1 §3) are mirrored in `params.ts` `PAPER` → `shared/spec/params.json`.

### 3.11 Integration decisions (v1.2, after wave 1)

No schema changed. These connect the lanes end to end (draw → build → preview → publish → play).

- **Worker timeouts** (`app/build/bridge.py`). The §11.3c timeouts were p50-sized for 1-2 screens; the bot bounds its
  work in simulated frames, not wall time. Backstops are now: `build` 15 s, `build_tiers` deadline + 15 s,
  `apply_plan` 20 s, `analyze` 12 s, `verify_run` 8 s, `perceive_heuristic` 4 s, light methods 2 s. A timeout on
  `build`, `build_tiers`, `apply_plan`, `analyze` or `verify_run` restarts the worker but is **not retried** (the same
  deterministic call would only double the wait); `down` is still retried once.
- **Setpieces into G0** (`orchestrator.graph_for_build`). Once PERCEIVE was merged (`state.perception.status == ok`),
  every build of the draft (Understood, Designed, kid rebuilds, publish) starts from `graph0` with
  `setpieces = merge_perception(...).setpieces`. Before that the core derives geometric setpieces.
- **Offline asks.** When the model does not read the drawing (off, over budget, all calls skipped or failed), the
  orchestrator calls `merge_perception` with `perceptions: []` and emits the heuristic's Ask cards after the Ink stage.
- **Publish hash check.** The worker recomputes the tier with `build()`. If that hash differs from the browser's but the
  browser's hash equals the stored worker tier (`tiers/current.<tier>.json`, never computed by the browser), the stored
  level and report are published (greedy tiers stop on a time budget, so a single-tier rebuild can differ). Otherwise
  `409 publish.hash_mismatch`.
- **Tap answers** accept every scene-object id form (§3.10 "Object ids"): `o<cid>[_<k>…]`, `e_<kind>_<hash6>[_k]`, `e_goal`.
- **Feed** `GET /games?sort=`: each game carries `levels` (its playable sequence, ≤ 8 level summaries with `stats`,
  `clear_rate`, `best_ms`); the top-level `levels` lists published levels outside any game (≤ 40, same sort).
  `thumbnail_url` is set only when a PNG was uploaded (`/uploads/thumbs/<id>.png?v=<mtime>`); the client renders its own
  thumbnail otherwise (and on an image error).
- **Endpoints now live** (were 501): `POST /levels/{id}/runs` (worker `verify_run` on the replay's level version; the
  server's numbers are stored, never the claim; `422 run.rejected` when not finished, wrong level or a blocked name;
  `board` is `collector` when every big coin was banked) → `{run_id, verified, rank, pb, stamps, vs, time_ms, deaths}`;
  `GET /levels/{id}/runs?board=any|collector&limit=` → `{runs: [{run_id, player, frames, time_ms, deaths, coins,
  big_coins, level_version, board, created_at}]}` (each player's best, fastest first; `any` includes collector runs);
  `GET /runs/{run_id}` → `{run, replay, sprite_url: null}`; `POST /levels/{id}/attempts` → 204 (daily counters,
  clears ≤ attempts); `PUT /levels/{id}/thumbnail` (PNG ≤ 3 MB) → 204; `GET /games/{id}/rules` → GameRules;
  `GET /games/{id}/library` → `{types}` (latest version of each type); `POST /games/{id}/library` → 201 LibraryType
  (a new immutable version; the server sets `game_id`, `version`, `created_at`).
- **Bot** (lane A, fixed in integration): the action runner's "stuck" test compared a position with itself, so every
  walk to a takeoff longer than ~8 frames failed (all running jumps). It now compares positions across one tick. The
  frontier treats a spike strip on the run ahead as a gap (the jump over it) and never reports the world edge as a wall.
- **Messages.** `reject.*` (B-1), `warning.bot_unavailable`, `warning.migrated_note` (B-1) and the nine scan warnings
  (C-2) are in `messages.json`.

### 3.12 P5 lane B: generator, library, remix, rules check (v1.3)

Schema change (additive): `WorkerMethod` gains `generate_level`, `rules_check` and `library_check`; `AffectedLevel` gains optional
`repairable`, `repairs` (EditRecords) and `level_hash`; `LibraryDraft` and `RulesSheetResult.story_crop/game_id` (C-6). Everything else below is core behaviour.

- **New worker methods** (heavy, on the thread pool; D picks the timeouts, e.g. 20 s like `build`):
  - `generate_level {plan, rules?, seed?, tier?, clamp?: 'band'|'envelope', ink?: 'draft'|'marker', library?}` →
    `{plan, ink, graph0, result: BuildResult, solvable, fixes[], frontier_text, dropped[], spans[]}` (§8.3 steps
    2-5): clamp → layout → build → bot → deterministic fixer (≤ 3: shrink the frontier beat by 1, or insert a rest).
    `solvable` is the verdict before any R repair; when false, `frontier_text` is the plain-words reason for the one
    PLAN retry, and `result` is already the greedy-repaired build (always playable). `ink` is the blue-line draft
    (`source: 'prompt'`, every stroke `origin: 'draft'`, colour `draft`, an exact `label`, `x_beat` = beat address).
  - `rules_check {levels: LevelV2[], rules, repair?}` → `{affected: AffectedLevel[]}` (§8.2): levels solvable under
    their own rules that the new rules break, with `rules.needs_run` / `rules.needs_double_jump` /
    `rules.becomes_unsolvable`, plus a Faithful repair under the new rules when the level carries ink.
  - `library_check {levels, type, library?}` → `{updated: [{level_id, level}], broken: AffectedLevel[]}` (§8.1
    "Update levels to v<n>"): levels pinning an older version of `type` rebuilt with the new one and re-verified;
    `updated` levels carry `version + 1`, `broken` ones are listed with `library.update_breaks`.
  - `layout_plan` / `keyword_plan` / `remix_diff` are real (no longer stubs).
- **`merge_perception`** takes an optional `library` (the game's types): a `BLibrary {target, type_name}` matches a
  type by name or circled letter (case-insensitive, newest version) and becomes a U7 `use_library` edit by the model;
  no match → an `is_library` Ask whose options apply `use_library` per type (≤ 4) or make it scenery.
- **Library instances (§8.1).** Normalize step 1 emits U7 `use_library` (by `library`) for every object whose stroke
  carries `lib` (editor stamp) or whose glyph matched a symbol (H21, `core/scene/symbol.ts`: 32 × 32 normalized
  skeletons, symmetric chamfer, mean of the 2 best samples ≤ 0.12 cell, same ink). The instance takes the type's
  role, behavior, collision and **size** (`art.size_cells`, feet kept; flyers/saws/pickups keep their centre); the op
  extension `x_own_art: true` keeps the kid's drawing size. A pinned version missing from the library leaves a
  non-colliding tag and the warning `warning.library_missing {about}`. Library instances are not straightened.
- **Remix (§6.5).** `remixDiff(parent, ink)` matches by the parent's own strokes (exact), else same role family with
  IoU ≥ 0.3 or centres ≤ 1 cell, one-to-one. A **paper remix** scan (`ink.parent.level_id == parent.id`, no
  parent-origin strokes) inherits the parent's ink: `withParentInk` appends the parent strokes with origin `parent`
  and `p_`-prefixed ids (components offset past the scan's). `perceiveHeuristic` and `build` both do this when given
  `parent`, so **D must pass the parent LevelV2 as `parent`** in `perceive_heuristic`, `build`, `build_tiers` and
  publish for remix drafts. Matched parent objects keep the parent's ids; a new object that would reuse a parent id
  is renamed `<id>k`. N10 dedupe then drops kid retraces. Canvas remixes (parent strokes already in the ink) only
  get the id mapping.
- **Prompt drafts.** Kid marker that overlaps a draft object of the same role family (IoU ≥ 0.3) replaces it: the
  draft object becomes scenery (`x_replaced_by` in G0). "Ink it" is `make_mine` (F) or `core.inkIt(ink)` (all strokes).
- **Components (C-1 note for lane C).** `computeComponents` no longer unites two `dot` strokes (every tap is its own
  coin, also when two taps touch) nor two strokes with different `label`s. Paper keeps its own grouping
  (`ensureComponents`), so the Python port only needs the dot rule if raster ingest relies on core grouping.
- **Labelled pieces are exact** (`scene/group.ts`): a labelled piece is never merged with a differently-labelled
  fragment, never read as an arrow, never made a part by containment or trunk rules, and keeps its fused glyphs
  (eyes). Labelled flags (`goal`/`checkpoint`) pair with a labelled `pole` in any ink.
- **Fixes found while building content:** a checkpoint flag on a pole is no longer N3-snapped (that sank the pole
  into the ground; N5 grounds it by the pole foot); a `saw`-role object with a `firebar` behavior compiles to a
  `firebar` entity (C6 Hard fire bars were compiling as saws); v1 bounce pads drawn as solid cells migrate as
  springs standing on those cells (Classic "Spike Valley" was unbeatable).
- **Starter World** (`shared/starter/README.md`): `npm run starter:build` (a pure build) writes
  `dist/L1..L5.level.json`, `dist/classic_1..3.level.json` and `dist/index.json` (games, ordered level ids, L5's
  `unlock_after`). Levels are built `tier: faithful` from plan + overrides, re-inked in marker (origin `kid`),
  game `game_world`, ids `lvl_world_l1..l5`, licence CC0-1.0; Classic Starter (`dist/classic/`) keeps the v1 ids
  under `game_classic`, so seeding and the boot migration agree.
- **CLI:** `starter:build [L1 …|classic]`, `plan "<prompt>" [screens] [--layout]` (keyword plan / draft ink),
  `envelope [profile] [--no-run] [--double-jump]` (prints the bot-measured envelope, g_max table and `reachFor`;
  nothing is written).
- **Draft beat extents.** `layout_plan` / `generate_level` InkDocs carry `x_beats: [{section, beat, kind, x0, x1}]`
  (world cells, plan order, D-2 §3.1); strokes also carry `x_beat: "<section>.<beat>"`.
- **N11 at touching seams** (C-6 §3): on paper, ends within 0.75 cell of a seam that touch or overlap by a hair are
  joined too; a 1-row height change across a seam becomes one 1:2 ramp through the averaged seam point.
- **Repair search** screens candidates with lane A's windowed `localReach` (±1.5 screens around the blocker, §4.1)
  before paying for a whole-level fast analysis (A-2 §2.5); when no candidate passes locally it falls back to the
  cheapest ones, so timing-dependent blockers are still repaired.

#### Recorded from the wave-2 requests (no schema change unless marked)
- **A-2.** `verify_run {level, replay, claimed?}` → a superset of `RunVerdict`: `accepted` (finished and every claimed
  number matches), `reason` (`ok | bad_input | too_long | frames_mismatch | level_hash | profile_hash |
  not_finished | claim_mismatch`), `mismatch[]`, `win_frame`, `input_frames`. Bot failures are classed **soft**
  (spikes, enemy, saw, firebar, blob, hazard cell: a heart absorbs it) or **hard** (pit, lava, crush, crusher,
  timer); a bot route never takes a hit. `core/index.ts` re-exports `GhostTrack`, `ghostTrack`, `ReplayRecorder`,
  `replayOfTrace`, `verifyRunDetail`, `reachFor`, `jumpArcs` and `localReach`.
- **C-6.** Schema (additive): `LibraryDraft` (one Library Sheet box, `api.py`) and `RulesSheetResult.story_crop` /
  `game_id`. The extension keys `RulesSheetResult.x_values`, `x_story_ink`, `x_warnings` and
  `SheetInfo.x_inherited: true` (a remix screen that was not scanned keeps the parent's ink) are recorded as is. Paper
  remix InkDocs carry the parent's strokes themselves (origin `parent`, ids `p1..`); `withParentInk` is then a no-op
  and `remixDiff` matches those strokes to the parent's objects by geometry.
- **D-2.** The model-facing PLAN schema is flat (`mind/schemas.LevelPlanFlat`, one `FlatBeat` with sentinels); the
  wire form stays `LevelPlan`. Export zips (`format: "dal-export", v: 1`: `manifest.json`, `levels/<id>/v<n>.json`,
  `library/<id>/v<n>.json`, `rules.json`, `files/…`) and the extension keys `x_versions`, `x_title`, `x_version`,
  `x_error` are D's. Rules `PUT /games/{id}/rules?apply=all[&repair=1]` and `POST /library/{id}/update-levels` use
  `rules_check` / `library_check`. Seeded games: `game_world` (Starter World v2, levels `lvl_world_l1..l5`) and
  `game_classic` (Classic Starter, the v1 ids kept); the remix chain is `lvl_world_l1_maya` → `lvl_world_l1_sam`.
  `seed_v2` reads `shared/starter/dist/*.level.json` (Classic Starter's files are under `dist/classic/`).

### 3.13 v2 switch-over and wave-2 wiring (v1.4, integrator)

No schema change. Decisions taken while wiring wave 2 and making v2 the main app:

- **Web entry points.** `web/index.html` boots the v2 app (`src/app/main.ts`); `web/v2.html` is an alias; the v1 app
  moved to `web/v1.html` (v1 source files untouched; the v1 `/api/*` routes still serve v1 JSON). The home page links
  to `/v1.html`.
- **Worker timeouts.** `generate_level` 30 s; `rules_check` / `library_check` 8 s + 8 s per level
  (`bridge.per_level_timeout`); all three never retry on timeout (B-2).
- **Prompt-to-level.** `prompt_flow` calls `generate_level {plan, rules, seed, tier: faithful, clamp: band, ink:
  draft, library}` (the core lays out, proves and fixes); one PLAN retry with `frontier_text` when it is still
  unsolvable; the old `layout_plan` + Python fixer path is only the fallback for a core without the method.
- **Rules check.** `POST /games/{id}/rules/check` rows are lane B's `AffectedLevel` (with `repairable`, `repairs`,
  `level_hash`) plus `x_title` / `x_version` (F-4), one `rules_check` call per level (2 in parallel); a plain fast
  `analyze` is the fallback. `PUT ?apply=all` dry-runs without repairs.
- **Runs.** `verify_run` gets `claimed` (A-2). The route no longer pre-rejects a replay whose `level_hash` differs
  from the stored one: the core accepts the recomputed or the stored hash. A rejection's `why` is the core's
  `reason` (`level_hash`, `profile_hash`, `bad_input`, `frames_mismatch`, `too_long`, `not_finished`) or
  `claim_<field>` (time compared in frames).
- **Migrated levels.** `levels_io.rebuild_input` passes the stored objects as `graph0` for `source.kind ==
  "migrated"` (re-perceiving terrain-only ink lost the entities), so rules apply-all works on Classic Starter.
  New route `POST /levels/{id}/upgrade` (§2.6 "Upgrade to v2"): re-runs a migrated `v1-classic` level under
  `v2-standard` through the Faithful build, v1 patrollers (horizontal flyers) becoming walkers with gravity; saved
  as a new version, `409 upgrade.not_needed | upgrade.breaks`. The play screen shows the button on such levels.
- **Paper remixes.** The orchestrator passes `parent=` / `parent_lookup=` to `run_scan_v2` and adopts `ScanV2.parent`
  before `perceive_heuristic` (C-5 §1); `scan_complete` / `playable_screens` go into the draft state. Each sheet's
  drawing area is cropped to `sheets/<n>.sketch.jpg` (`SheetInfo.x_sketch_url`), published as
  `LevelSheet.sketch_url` for the "My sketch" underlay (E-2). `merge_perception` gets the game library.
- **Seeds.** `seed_v2` is driven by `shared/starter/dist/index.json`: Starter World = the index's `game_world` levels,
  Classic Starter's three sequence levels = `dist/classic/` (a changed hash becomes a new version; the v1 remixes come
  from the boot migration). A slot keeps the id a seed already gave it (so existing boards survive); a fresh database
  gets the index ids. Seeded sequence levels the index no longer lists are **unlisted and detached** (`game_id` NULL), never deleted. L5's
  `unlock_after` is exposed per level as `unlock_after` / `bonus` on `GET /games` and `GET /games/{id}`
  (`seed_v2.sequence_meta`; new versions also carry `x_unlock_after` / `x_bonus`); the app locks the card until this
  device has cleared the named level.
- **Library art.** `buildArt` draws an instance (`obj.lib`, body shape) with the type's `art.strokes` from
  `level.embedded_library`, scaled into the instance box with its feet on the bottom, unless an applied
  `use_library` edit has `x_own_art: true` (B-2 → E).
- **Messages.** Added `library.option`, `warning.library_missing`, `game.bonus`, `game.locked_after`,
  `game.unlocked`, `home.v1_link`, `upgrade.*`.

## 4. Generated files (do not edit)

- `shared/spec/*.schema.json`
- `web/src/core/types.gen.ts`
- `shared/spec/params.json`
- `shared/spec/physics-profiles.json`
- `shared/spec/conformance/events/sample_build.jsonl`

## 5. Change log

| Version | Date | Change | Lanes |
|---|---|---|---|
| 1.0 | 2026-10-10 | Initial contracts (P0 scaffold): all of §2 and the decisions in §3. | all |
| 1.1 | 2026-10-10 | Lane B core conventions (§3.10): entity geometry and rasterization in the spec doc, object and slot ids, `x_*` keys, RPC defaults, worker threads (out-of-order responses), merge speed mapping, tap placeholders, features recompute, bot fallback, RESTART bit, paper constants. Answers A-1, C-1, D-1 §2-§4, E-1 (lane B), F-1. No schema change. | all |
| 1.2 | 2026-10-10 | Integration decisions (§3.11): worker timeouts and no-retry for heavy calls, setpieces into G0, offline asks, publish accepts the stored worker tier, tap ids, feed `levels`, runs / attempts / thumbnail / rules / library endpoints live, bot stuck-test fix, messages for B-1 and C-2. No schema change. | all |
| 1.3 | 2026-10-10 | P5 lane B (§3.12): worker methods `generate_level`, `rules_check` and `library_check`; optional `AffectedLevel.repairable/repairs/level_hash`; `merge_perception.library`; library instances (U7 from stamps and H21 chamfer matches, type size); paper-remix ink inheritance and id preservation (`parent` must be passed); draft replacement; component and labelled-grouping rules; checkpoint-pole, firebar and bounce-pad fixes; Starter World dist + manifest. | B, C, D, E, F |
| 1.4 | 2026-10-10 | v2 switch-over and wave-2 wiring (§3.13): v2 at `/`, v1 at `/v1.html`; P5 worker timeouts; prompt flow on `generate_level`; rules check with repairs; run claims to the core; migrated G0 + `POST /levels/{id}/upgrade`; paper-remix parent + sketch underlay; index-driven seeds with unlisting and L5 unlock; library instance art. No schema change. | all |
