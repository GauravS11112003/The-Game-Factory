# v2 contracts (v1.0)

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
