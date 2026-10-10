# draw-a-level v2: Geometry-First Design

Track: geometry-first (deterministic geometry and procedural design at the core, the model used surgically).
Date: 2026-10-10. Inputs: `PROJECT_CONTEXT.md`, `PLAN.md` (v1), `README.md`, and the four diagnoses in
`docs/v2/diagnosis/` (build, gameplay, visual, model). Every major decision cites the evidence that forces it.

---

## 0. Summary

**Thesis: fit, don't threshold; one geometry, three consumers.** Every mark on the page is fitted into a typed
vector primitive: a surface made of segments, a spike strip with a host and a facing, a creature body, a flag on a
pole, a dot, a word, an arrow. Deterministic code does this with a shape grammar and a confidence score. Collision,
art and the playtest solver are all compiled from those same fitted primitives, so what you see is exactly what you
stand on. A deterministic designer repairs the level and tunes its difficulty against an engine-exact solver. Claude
is consulted only where geometry cannot decide: uncertain roles, handwriting, and taste. It is never on the critical
path to a playable, solvable level.

Why this shape, in one paragraph of evidence. v1 turns pixels into 16 px cells before anything knows what the objects
are [B-synth-1]. That single step causes pole walls, staircases, inflated spikes, invisible walls and dropped taps
[B-F1, F4, F5, F7, F13]. When Claude was asked the right question it labelled roles at 95-97% and relations at 75/76
[M-A]. It was wrong 3/3 times on physics judged from pixels and right every time when given solver facts [M-B]. A
synchronous chain of perception, repair and enhancement calls takes about 70 s [M-lat]. So geometry must be fixed in
code, physics must be measured in code, and the model must be asked small, typed, semantic questions off the critical
path.

### Headline targets (each is an acceptance criterion in section 17.7)

| Metric | v1 measured | v2 target |
|---|---|---|
| Build-diagnosis drawings solvable after build | 1/6 [B-score] | **6/6 at Faithful, model off** |
| Flag pole built as a solid wall | 6/6 [B-F1] | 0/6 |
| Goal at the drawn flag (not the tree, not mid-air) | 0/6 grounded [B-F1, F2] | 6/6 |
| Coins drawn vs built | 22 drawn, 17 built [B-F7] | 22/22 |
| One-cell bumps on walkable surfaces (unintended) | 3-13 per level [B-F4] | 0 |
| Gap between drawn line top and collision top | mean 5-14 px [B-F13] | 0 px by construction (art is rendered from collision) |
| Text and arrows colliding with the model off | yes [B-F3] | never |
| Canvas: submit to playable (p50 / p90) | about 5 s round trip [V-§0] | **0.5 s / 2.5 s** (client kernel, no network) |
| Paper: photo to playable (p50 / p90) | 2.3-9.8 s [B-method] | **≈ 2.5 s (gate ≤ 3 s) / ≤ 5 s** |
| Polished build shown | n/a | **within 1 s of faithful** (deterministic) |
| Model enrichments (handwriting, uncertain roles) | 10.9 s, blocking [M-v1] | p90 at most 14 s, non-blocking |
| Starter World casual C (expected deaths per attempt) | 0.000 / 0.004 / 0.000 [G-§3] | 0.10 / 0.30 / 0.60 / 1.00 / 1.80 |
| Starter World fastest clear | 3.6-4.9 s [G-§3] | 20-45 s (casual 40-90 s) |
| Engine crash on a bad interpretation | yes [V-1] | impossible: validator plus per-entity isolation |

### Ten decisions

| # | Decision | Forced by |
|---|---|---|
| D1 | **Python sees, TypeScript thinks.** Python handles pixels to strokes, model I/O, storage and HTTP. A dependency-free TypeScript kernel (`shared/kernel/`) handles strokes to scene, repair, realize, playtest and design. It runs in the browser and in a Node sidecar. Node 24 on this machine runs `.ts` with erasable syntax natively (verified: 70 ms cold start, no build step). | The solver and the engine must share one physics module [G-§7.1, G-§10]. The server must solve [B-F12]. Per-edit undo must re-validate instantly [V-4]. |
| D2 | **The kernel owns simulation.** Player, enemies, platforms and hazards are stepped by `kernel.stepWorld()` at a fixed 60 Hz. Phaser renders, reads input, plays audio and runs particles. The solver is the engine by identity, not by port. | v1's solver is a hand port of Arcade with documented gaps (no coyote, enemies ignored, static moving platforms) [G-§6 notes, M-B solver]. |
| D3 | **Vectors in.** The canvas submits vector strokes (no raster round trip). Paper is skeletonized into the same `StrokeDoc`. | The raster canvas and the 8 px brush lose taps and wobble lines [V-5, B-F7]. |
| D4 | **Deterministic perception with calibrated confidence.** A shape grammar labels every glyph. The model sees only glyphs under 0.75 confidence, text, and rules. | The model's meaningful labelling errors had confidence 0.4-0.7, and 0.75 worked as an "ask" threshold [M-A calibration]. The model-off path must not turn text into walls [B-F3]. |
| D5 | **One fixed edit vocabulary of 37 ops** with typed parameters and bounds. Every change, whether from a normalizer, the repair search, the designer, the model or the user, is an `EditRecord` replayed deterministically from the faithful base. | Loose params let the model drop required fields [M-v1]. Ambiguous ops get misapplied [M-B face]. Preview has no edit model [V-4]. |
| D6 | **Difficulty is measured, not guessed.** C is the expected deaths in the hardest segment for a casual player (σ = 3 frames) [G-§6]. The dial targets bands. The designer is a greedy procedural tuner over cost-ranked ops. The model only vetoes or suggests. | Starter levels are trivial [G-R6]. Model enhancements broke 1 of 3 levels [M-C]. |
| D7 | **Collision is a 16 px tile layer with 8 tile shapes**, including 45° and 26.6° slopes and one-way tops. Hazards are pixel-precise shapes, not tiles. | Staircases from ramps [B-F4]. 32 px hazards from 13 px spikes [B-F5]. Wall spikes turn walls into hazard [B-F6]. |
| D8 | **Long levels are horizontal.** w = 48·k for k = 1 to 6, h = 27, so the 48x27 viewport always shows the full height and the camera only follows horizontally. Paper sheets are stitched by a QR sheet index. | One-screen levels are solved at a glance [G-R4]. |
| D9 | **One ink renderer** (a TypeScript display-list builder) for play, preview, thumbnails and seeds. Linear filtering; line boil via a PostFX shader. | Three art styles [V-8]. Crunchy `pixelArt: true` [V-3, B-F16]. |
| D10 | **Format v2 is a public spec** with a reference kernel and conformance tests. v1 levels migrate and play under physics profile `v1`. | Open-source thesis [PROJECT_CONTEXT]. |

---

## 1. Evidence keys used in this document

| Key | Source |
|---|---|
| `B-F1` ... `B-F17` | `docs/v2/diagnosis/build.md`, failure catalogue rows F1-F17 (line numbers of v1 at `1db31c9`) |
| `B-score`, `B-synth-n`, `B-sweep` | build.md scoreboard, "Why quality is poor" item n, controlled sweeps (`build/probe_sweeps.json`) |
| `G-R1` ... `G-R8` | `docs/v2/diagnosis/gameplay.md` §4 root causes |
| `G-§n` | gameplay.md section n (§6 difficulty model, §7.1 physics, §9 dial) |
| `V-1` ... `V-9` | `docs/v2/diagnosis/visual.md`, ranked problems 1-9; `V-§4a/b/c` its proposals |
| `M-A`, `M-B`, `M-C`, `M-D` | `docs/v2/diagnosis/model.md` probes A (perception), B (repair), C (enhancement), D (prompt-to-level) |
| `M-lat`, `M-api`, `M-v1` | model.md latency table, API facts, the v1 live reproduction |

---

## 2. Architecture

### 2.1 Pipeline

```
                    PYTHON (vision/)                          TS KERNEL (shared/kernel/, browser + Node sidecar)
 paper photos ─► rectify ─► segment ─► vectorize ─┐
 (1..6 sheets)   (v1)      (v1 Lab)   (skeleton)  │
                                                  ├─► StrokeDoc ─► perceive ─► Scene ─► build(faithful) ─► design(dial) ─► Level v2
 canvas vectors ──────────────────────────────────┘                  │                      │                  │
 prompt text ─► [model] LevelPlan ─► kernel.generate() ─► StrokeDoc  │                      │                  │
                                                                     ▼                      ▼                  ▼
                                        [model, low] semantics: uncertain glyphs,   playtest bot      [model, async] taste review:
                                        handwriting, rules → typed edits             (same physics)    veto + up to 3 typed proposals
                                                     └──────────────► rebuild ◄──────────────────────────────────┘ (each re-verified)
```

Stage contract in one line each:

| Stage | Input | Output | Where | Deterministic |
|---|---|---|---|---|
| S0 ingest | photo(s) or canvas strokes | rectified sheets or `StrokeDoc` | Python / browser | yes |
| S1 vectorize | binary ink masks per color | `Stroke[]` (centreline + width, or blob contour, or dot) | Python | yes |
| S2 perceive | `StrokeDoc` | `Scene` (glyphs, objects, roles with confidence, relations, fitted shapes) | kernel | yes |
| S3 semantics | glyph table + image + rules | `Semantics` (typed) → `P*` edits | Python → Claude | model |
| S4 normalize + repair | `Scene` + edits | `Scene'` + `EditRecord[]` | kernel | yes |
| S5 realize | `Scene'` | `LevelV2` (terrain, things, collision, art anchors) | kernel | yes |
| S6 playtest | `LevelV2` | `Playtest` (reachability, route, windows, flags, C, F, T) | kernel | yes |
| S7 design | `LevelV2` + `Playtest` + dial | `LevelV2'` + `D*` edits | kernel | yes |
| S8 taste | render + edits + metrics | vetoes + proposals → verified `D*` edits | Python → Claude | model, then verified |
| S9 report | edits + playtest | change list, flags, dial meter | browser | yes |

### 2.2 Runtime placement

| Concern | Browser | FastAPI server | Node kernel sidecar |
|---|---|---|---|
| Canvas editing, live role chips | kernel `perceive()` on every stroke end (under 20 ms) | none | none |
| Paper rectify, segment, vectorize | none | OpenCV (v1 rectify and segment kept; new vectorizer) | none |
| Faithful and polished build for the preview | kernel (default) | none | used when the client reports a slow device (startup benchmark over 150 ms) |
| Model calls | never (no key in the browser) | all of them | none |
| Facts for the model (solver output) | sent with the request | re-derived via the sidecar when needed | `playtest()` |
| Publish verification | none | orchestrates | recomputes the level from `StrokeDoc` + accepted edits, compares `level_hash`, re-solves |
| Speedrun verification | records inputs | orchestrates | replays the input log frame by frame |
| Prompt-to-level | renders the result | model call | `generate()` + `build()` + `design()` |

Sidecar: `node shared/kernel/cli.ts --serve`, JSON-lines over stdio, a pool of 2 processes, restarted on crash,
spawned by `vision/app/v2/kernel_client.py` at FastAPI startup. If Node is missing the server still answers scans
(strokes and semantics). The browser builds the level itself, and publish verification is queued (`verified: false`
until the sidecar is back). The level JSON keeps no server-only state.

### 2.3 Timeline of one scan (progressive UI)

```
t=0     submit (canvas) / photo uploaded (paper; client downsizes to 2400 px long edge, JPEG q85, about 600 KB)
+0.02   canvas: perceive → glyph chips already visible while drawing
+0.4    FAITHFUL playable in the preview (canvas p50); paper: +1.5 s for rectify + vectorize on the server
+0.9    POLISHED applied (default dial); change list animates in, one row per edit group
+0.9    background: POST /api/v2/semantics (only if text, rules ink or uncertain glyphs exist)
+6..12  semantics arrive → typed P* edits → rebuild (under 1 s) → toast "I read your note: 'this platform moves'.
        2 changes ready." Applied immediately in the preview, queued (never hot-swapped) if the player is mid-run.
+12..25 taste review notes arrive as optional cards ("Designer's notes"), each already verified by the kernel.
```

### 2.4 Who decides what, and every model call

| Decision | Owner | Evidence |
|---|---|---|
| Ink → strokes, widths, dots | code (OpenCV) | v1 segmentation is reliable; its *thresholding* is the bug [B-F4, F7] |
| Glyph grouping, shape fitting, roles with confidence | code (grammar); model only below conf 0.75 | model 95-97% when asked [M-A]; code must work offline [B-F3] |
| Relations (host, face, facing, part_of) | code | the face ambiguity broke the model's own plans [M-B face] |
| Reading handwriting, binding rules to objects | model (parser offline) | v1 heuristic bound the wrong object [B-F10] |
| Reachability, jump feasibility, windows, difficulty | code (kernel solver) | model wrong 3/3 from pixels [M-A, M-B] |
| Which minimal repair preserves intent when two tie | code first; model arbitrates ties | model chose minimal plans in 4/4 given solver facts [M-B] |
| Difficulty tuning to a band | code (procedural tuner) | model additions broke 1 of 3 levels [M-C] |
| Taste: is this addition ugly, unfair-looking or off-intent | model veto + ≤ 3 typed proposals, all re-verified | 15/18 sensible additions [M-C] |
| Pacing of a level from a text prompt | model (beats); geometry by code | 5/5 solvable skeletons [M-D] |

| Prompt (`vision/app/v2/mind/prompts/`) | Responsibility | Output schema | Effort, timeout, max_tokens | When |
|---|---|---|---|---|
| `semantics.md` | roles for asked glyphs, read text, typed rules with references, questions, title, safety | `Semantics` (4.8) | low, 14 s, 6000 | paper with text or uncertain glyphs; unbindable typed text |
| `arbitrate.md` | pick between solver-verified repair options; propose ≤ 4 repair ops only when none exists | `Arbitration` (5.5) | medium, 40 s, 8000 | rare, async |
| `review.md` | veto designer edits that hurt intent or readability; ≤ 3 typed proposals; one kid-facing note | `TasteReview` (8.5) | low (P0 gate), 35 s, 8000 | polished/challenging preview, async, optional |
| `plan.md` | turn a text prompt into a beat plan with teach-test-twist pacing | `LevelPlan` (14.3) | low, 25 s, 8000 | prompt-to-level |
| `moderate.md` | safety only, for levels published without a semantics call | `Moderation{safety: ok\|flag, reason}` | low, 10 s, 2000 | publish |

Every prompt states that code computes physics and that the model must use only listed ids. Every response is
sanitized (unknown ids dropped, values clamped, enums mapped) and applied as `EditRecord`s that the kernel verifies.

---

## 3. Contracts (frozen at phase P0)

All coordinates are **cell units** (float), origin top-left, x right, y down. One cell = 16 world px = 5 mm on paper =
50 px in the paper working image (`template_spec.json drawing_area.cell_working_px`). Schemas live in
`shared/schema/` (JSON Schema 2020-12, `additionalProperties: false`). TS interfaces live in `shared/kernel/types.ts`.
Pydantic mirrors live in `vision/app/v2/contracts.py`. `test_contracts.py` and `contracts.test.ts` validate the same
fixtures against all three.

### 3.1 `StrokeDoc` (`shared/schema/strokes.v2.schema.json`)

```ts
export type Ink = 'black' | 'red' | 'green' | 'blue' | 'designer';
export type Vec = [number, number];                    // cells, 1/64 precision
export interface Stroke {
  id: string;                    // 's12'; stable within the doc
  ink: Ink;
  kind: 'line' | 'blob' | 'dot'; // line = centreline; blob = filled region contour; dot = tap or small blob
  pts: Vec[];                    // line: centreline; blob: closed outer contour; dot: [centre]
  w: number;                     // median ink width in cells (dot: diameter)
  closed: boolean;
  sheet: number;                 // 0-based screen index
  order?: number;                // canvas: creation order (used to break ties)
  stamp?: StampKind;             // canvas stamp tool: 'coin'|'goal'|'spikes'|'enemy'|'spring'|'checkpoint'|'door'|'key'|'start'
  label?: Role;                  // canvas role chip set by the user (confidence 1.0)
  rule?: BehaviorSpec;           // canvas chip rule attached to this stroke
  lib?: string;                  // object-library type id (stamp or matched symbol)
}
export interface StrokeDoc {
  v: 2;
  source: 'canvas' | 'paper' | 'prompt' | 'migrated';
  screens: number;               // 1..6; world w = 48*screens, h = 27
  strokes: Stroke[];
  rules_text: string;            // canvas typed rules; '' on paper (the rules box is ink in rules_ink)
  rules_ink: string[];           // stroke ids inside the paper rules box
  character: { strokes: Stroke[] } | { png_url: string } | null;
  parent: { level_id: string; level_hash: string } | null;
  sheets: { index: number; raster_url: string; qr: string | null; warnings: string[] }[];
}
```

### 3.2 `Scene` (kernel-internal, but serialized for the model and the report)

```ts
export type Role =
  | 'ground' | 'platform' | 'wall' | 'ceiling'                 // terrain (collides)
  | 'spikes' | 'lava' | 'saw'                                   // hazards
  | 'enemy' | 'goal' | 'pole' | 'coin' | 'key' | 'door' | 'checkpoint' | 'spring' | 'start_mark'
  | 'decoration' | 'text' | 'arrow' | 'unknown';               // never collide
export type Dir = 'up' | 'down' | 'left' | 'right' | 'none';
export type Face = 'top' | 'bottom' | 'left' | 'right';
export interface Seg { a: Vec; b: Vec; slope: 0 | 0.5 | -0.5 | 1 | -1 } // dy/dx after quantization (+ = descends to the right)
export type Shape =
  | { k: 'surface'; segs: Seg[]; thick: number }                // thick in cells (1 = line)
  | { k: 'wall'; x: number; y0: number; y1: number }
  | { k: 'strip'; a: Vec; b: Vec }                              // spike or lava baseline
  | { k: 'body'; bbox: [number, number, number, number]; poly: Vec[] } // creature, flag, decoration, text
  | { k: 'point'; p: Vec };
export interface SceneObject {
  id: string;                    // 'o' + smallest stroke id in its glyph: stable across rebuilds
  strokes: string[];
  role: Role; conf: number;      // conf in 0..1
  role_by: 'grammar' | 'model' | 'user' | 'library' | 'parser';
  alt: { role: Role; conf: number }[];   // runner-up roles, for the re-label menu
  shape: Shape;
  host?: string; face?: Face; facing?: Dir;   // spikes/enemy/goal rest on host's face; spikes point 'facing'
  parts?: string[]; part_of?: string;
  behavior?: BehaviorSpec; lib?: string; text?: string;
}
export interface Scene { screens: number; objects: SceneObject[]; uncertain: string[]; text_objects: string[] }
```

### 3.3 `LevelV2` (`shared/schema/level.v2.schema.json`)

```ts
export type Origin = 'drawn' | 'normalizer' | 'repair' | 'designer' | 'model' | 'user' | 'library';
export type Archetype = 'walker' | 'hopper' | 'flyer' | 'shooter' | 'chaser' | 'crusher';
export interface Terrain {
  id: string; obj: string | null; origin: Origin;
  kind: 'ground' | 'platform' | 'wall' | 'ceiling';
  collide: 'solid' | 'oneway';
  segs: Seg[];                                  // integer endpoints after realization (see section 6)
  crumble?: { delay_ms: number; respawn_ms: number };
  move?: { path: Vec[]; speed: number; mode: 'pingpong' | 'loop' };  // path length >= 1 cell (validator)
}
export type Thing = { id: string; obj: string | null; origin: Origin } & (
  | { t: 'start'; x: number; y: number }
  | { t: 'goal'; x: number; y: number; art: string | null }       // art = scene object id of the drawn flag
  | { t: 'coin' | 'big_coin'; x: number; y: number }
  | { t: 'key'; x: number; y: number; opens: string }
  | { t: 'door'; x: number; y0: number; y1: number }
  | { t: 'checkpoint'; x: number; y: number }
  | { t: 'spikes'; a: Vec; b: Vec; facing: Dir; host: string }    // hitbox derived (section 6.2)
  | { t: 'lava'; x0: number; x1: number; y: number }
  | { t: 'saw'; r: number; path: Vec[]; speed: number; mode: 'pingpong' | 'loop' | 'static' }
  | { t: 'firebar'; x: number; y: number; len: number; deg_s: number; phase: number }
  | { t: 'enemy'; arch: Archetype; x: number; y: number; w: number; h: number; params: EnemyParams; art: string | null }
  | { t: 'spring'; x: number; y: number; dir: Dir; strength: number }
  | { t: 'art'; role: 'decoration' | 'text' | 'pole' | 'arrow' }     // drawn, never collides
);
export interface LevelV2 {
  schema_version: 2;
  id: string; game_id: string | null; parent_id: string | null; order_index: number;
  title: string; author: string; created_at: string;
  physics: { profile: 'v2' | 'v1'; rules: ResolvedRules };          // numbers resolved from GameRules
  world: { cell: 16; w: number; h: 27; screens: number };
  terrain: Terrain[];
  things: Thing[];
  rules: { when: string; then: string }[];   // v1 vocabulary + 'lava_rise:<cells_per_s>@<delay_s>'
  collision: { rows: string[]; hash: string };   // DERIVED cache, RLE per row (section 6.1); verifiable
  art: { theme: Theme; seed: number; stroke_doc_url: string; sketch_urls: string[] };
  design: { dial: Dial; band: Band | null; edits: EditRecord[]; metrics: MetricsSummary;
            par_ms: number | null; timer_s: number | null };
  meta: { solvable: boolean; warnings: MessageRef[]; notes_transcript: string;
          level_hash: string; kernel_version: string; safety: 'ok' | 'flag' | 'unknown' };
}
```

`level_hash` = SHA-256 of the canonical JSON of `{physics, world, terrain, things, rules}` (sorted keys, numbers
printed with up to 4 decimals). Collision, art and design are excluded so a renderer change never invalidates
speedruns.

### 3.4 `EditRecord` (`shared/schema/edits.v2.schema.json`)

```ts
export interface EditRecord {
  id: string;                            // 'e7'; ordinal within the log
  op: OpName; params: OpParams;          // discriminated by op (table in section 5.3)
  origin: 'normalizer' | 'repair' | 'designer' | 'model' | 'user' | 'parser' | 'library';
  stage: 'faithful' | 'polished' | 'challenging' | 'semantic';
  reason: { code: ReasonCode; args: Record<string, string | number> };  // rendered via shared/messages/en.json
  group: string | null;                  // aggregation key in the report ('tidy_lines')
  depends_on: string[];
  verdict: { ok: boolean; solvable: boolean; flags: FlagCode[]; dC: number; drift: number } | null;
  accepted: boolean;                     // user toggle; default true
  stale?: boolean;                       // precondition failed on replay after an upstream undo
}
```

### 3.5 `GameRules` (`shared/schema/rules.v2.schema.json`), `ObjectType`, `InputLog`

```ts
export interface GameRules {
  v: 1;
  preset: 'gentle' | 'classic' | 'zippy';               // section 11.1
  abilities: { run: boolean; double_jump: boolean; stomp: boolean; fast_fall: boolean };
  run_mode: 'button' | 'auto';                           // touch default 'auto'
  lives: 0 | 3 | 5;                                      // 0 = off, death counter only (default)
  coins_per_life: 50 | 100;
  theme: 'paper' | 'chalk' | 'blueprint' | 'crayon' | 'night';
  music: boolean;
  default_dial: Dial; default_band: Band;                // Dial = 'faithful'|'polished'|'challenging'; Band = 'normal'|'hard'
  timer: 'off' | 'auto';                                 // auto = designer sets 1.5 x par
}
export interface ObjectType {
  id: string; game_id: string; version: number; name: string;          // immutable per version
  role: 'enemy' | 'collectible' | 'platform' | 'hazard' | 'decoration' | 'spring';
  arch?: Archetype; params: Record<string, number | boolean>;          // bounded per role (section 14.1)
  art: { strokes: Stroke[] };                                          // cleaned, normalized to its bbox
  symbol: { samples: Stroke[][]; ink: Ink } | null;                    // how to place it on paper
  author: string; created_at: string;
}
export interface InputLog { v: 1; fps: 60; frames: number; rle: string } // base64 of (u16 run, u8 bits L R J Run Down)
```

### 3.6 Kernel API (`shared/kernel/api.ts`)

```ts
export function perceive(doc: StrokeDoc, ctx: { library: ObjectType[]; parent: LevelV2 | null }): Scene;
export function build(inp: BuildInput): BuildResult;                     // normalize + repair + realize + playtest
export function design(base: BuildResult, opts: DesignOpts): BuildResult;// polished / challenging
export function applyEdits(base: BuildResult, edits: EditRecord[]): BuildResult; // replay; marks stale edits
export function playtest(level: LevelV2, opts?: PlaytestOpts): Playtest;
export function stepWorld(w: WorldState, input: FrameInput): StepEvents; // the ONLY simulation step (engine and solver)
export function generate(plan: LevelPlan, seed: number): StrokeDoc;      // prompt-to-level and Starter World
export function verifyRun(level: LevelV2, log: InputLog): RunVerdict;
export function migrateV1(level: LevelV1): { strokes: StrokeDoc; level: LevelV2 };
export function levelHash(level: LevelV2): string;
export function renderArt(level: LevelV2, scene: Scene, opts: ArtOpts): ArtDoc; // display list (section 13.1)

export interface BuildInput {
  strokes: StrokeDoc; rules: GameRules; library: ObjectType[]; parent: LevelV2 | null;
  semantic_edits: EditRecord[];   // from the model (P* ops), may be empty
  user_edits: EditRecord[];       // re-labels, chip rules, undo toggles
  seed: number;
}
export interface BuildResult { scene: Scene; level: LevelV2; playtest: Playtest; edits: EditRecord[]; ms: number }
export interface DesignOpts { dial: Dial; band: Band | null; budget_ms: number; pinned: string[] /* text-pinned params */ }
```

---

## 4. A. The level-design mind, part 1: perception

The perception stage replaces v1's "colour, then components, then 25% coverage per cell" [B-synth-1] with
"ink → strokes → glyphs → fitted shapes → roles with confidence → relations". It is entirely deterministic. The
model is consulted afterwards only for what geometry cannot settle (section 4.8).

### 4.1 Paper: ink to strokes (`vision/app/v2/vectorize.py`)

Input: the v1 per-colour masks at working resolution (2400x1350 per sheet, 50 px per cell), from the v1 rectifier
and Lab classifier, which already work (model.md, "Model vs deterministic code" table: "already reliable"). Two v1 steps are removed: the
`cell/4` coverage dilation [B-F4] and the `MIN_AREA_CELLS = 0.3` drop [B-F7].

| Step | Operation | Parameters |
|---|---|---|
| 1 | Connected components per colour, 8-connectivity | area < 12 px² (0.005 cell²) is noise; counted and reported, never silently |
| 2 | Dot test | max bbox side ≤ 0.9 cell and fill ratio ≥ 0.5 → `kind: 'dot'`, centre and diameter |
| 3 | Width | distance transform DT; `w = 2 · median(DT on skeleton)` |
| 4 | Blob test | DT > 0.45 cell on ≥ 30% of skeleton pixels → `kind: 'blob'`: `findContours` + `approxPolyDP(ε = 0.08 cell)` |
| 5 | Skeleton | `cv2.ximgproc.thinning(roi, THINNING_ZHANGSUEN)` per component ROI (available in the installed OpenCV 5.0.0) |
| 6 | Graph | endpoints (1 neighbour), junctions (≥ 3), junction clusters within 3 px merged; spurs shorter than max(0.4 cell, 1.5·w) pruned |
| 7 | Stroke decomposition | at each junction, pair edges by straightest continuation (turn < 35°), so a pole standing on a floor stays its own stroke and the floor stays one stroke |
| 8 | Simplify | RDP ε = 0.06 cell (keeps wobble for the fitter to measure); resample so consecutive points are ≤ 0.25 cell apart |
| 9 | Units | x/50 + 48·sheet, y/50 → cells; closed if the endpoints are within max(0.4 cell, 2·w) |

Accuracy bars (unit tests on synthetic strokes): centreline RMS error ≤ 0.1 cell; dots of diameter ≥ 0.25 cell
(1.25 mm on paper) detected 100%; T-junctions split correctly ≥ 95%. Budget: ≤ 0.5 s per sheet.

The rules box (`template_spec.json rules_box`) is vectorized the same way and its strokes are listed in
`rules_ink`. The character box is vectorized into `character.strokes` (fixes the half-wired character, section 16).

### 4.2 Canvas: vectors natively (`web/src/editor/`)

The v2 canvas never rasterizes for interpretation. Each pointer stroke is stored as `{pts, ink, w}` in world cells
(simplified by RDP at 0.03 cell). A **tap** (movement < 4 px and duration < 250 ms) becomes a `dot` of diameter 1
cell. That fixes the coin tap at the source [B-F7, V-5]. Stamps and chips set `stamp`, `label` and `rule` with
confidence 1.0, so a canvas level usually needs no model at all. The raster is still uploaded once at publish, for
the sketch layer and moderation.

### 4.3 Features (`shared/kernel/perceive/features.ts`)

Per stroke and per glyph, all in cells:

| Feature | Definition | Used for |
|---|---|---|
| `len`, `bbox`, `w`, `closed` | arc length, extent, width, closure | everything |
| `area`, `circ` | shoelace area of closed loops or blobs; circularity 4πA/P² | creatures, suns, coins |
| `theta`, `straight` | principal direction (0° = horizontal); chord / len | surfaces, poles, walls, arrows |
| `resid` | RMS distance to the best 1-3-segment quantized fit (section 4.5) | wobbly versus intentional bumps |
| `zigN`, `zigAmp` | local extrema of perpendicular offset from the baseline with prominence ≥ 0.2 cell; count per cell of baseline and median prominence | spike strips |
| `corners` | RDP(0.2 cell) vertices with a turn > 50° | flags (triangles), arrows, letters |
| `spokes` | short strokes (len ≤ 1.5) with one endpoint within 0.6 cell of a closed loop, radial within 25° | suns |
| `bumps` | convexity defects deeper than 0.15 cell | clouds, bushes |

### 4.4 Glyph grouping (`perceive/group.ts`)

Grouping fixes the "per-colour components split one creature into parts" failure [B-F8] and the split ledge
[M-failure-5]. The rules apply in this order; the result is a set of glyphs, each with a list of part strokes:

1. **Containment.** A stroke whose bbox centre lies inside a closed loop's polygon, and whose bbox fits inside the
   loop's bbox grown by 0.2 cell, is a part of that loop's glyph (eyes and mouth of a monster, sun face, scribble
   inside a tree crown).
2. **Flag and pole.** A green glyph within 0.4 cell of the top 40% of a near-vertical black stroke (|θ| ≥ 70°,
   straight ≥ 0.85, len ≥ 1.2) joins it as `{flag, pole}`. An all-green "Γ" (vertical part ≥ 1.2 cells plus a hook)
   is the same glyph drawn in one colour (owner draft `d_b14b143e`).
3. **Trunk.** Near-vertical black strokes whose top endpoints touch the bottom of a closed loop join that loop's
   glyph (the tree in drawing 3 [B-F2]).
4. **Text cluster.** Same-ink strokes with max side ≤ 1.6 cells and len ≤ 6, bottoms aligned within 0.6 cell and
   consecutive gaps ≤ 1.0 cell, form one text glyph. So does a single stroke with ≥ 4 corners inside a 1.6-cell box.
5. **Arrow.** One or two short strokes (len ≤ 1.2) at one end of a straight shaft (len ≥ 1.5, straight ≥ 0.9),
   each at 20-70° to it, or a single stroke with a sharp double turn at one end, form an arrow glyph.
6. **Collinear fragments.** Flat same-ink surface strokes with Δy ≤ 0.3 cell and gap ≤ 0.6 cell form one surface glyph.
7. Everything else is its own glyph. **No ink is ever discarded**: the noise count is reported in "What I saw".

### 4.5 Shape fitting and the shape grammar (`perceive/fit.ts`, `perceive/grammar.ts`)

**Surface fitting.** Each black line glyph is fitted by recursive splitting into at most 6 segments. Each segment's
angle is snapped to the slope set {0°, ±26.57° (1:2), ±45° (1:1)}, and a split is accepted only if the snapped fit's
max deviation from the centreline exceeds **0.35 cell**. A wobbly near-horizontal line therefore becomes one flat
segment. The 4-13 bumps per level in [B-F4] become 0. A drawn ramp at about 37° becomes a 1:1 or 1:2 slope instead
of v1's 9-row staircase (drawing 6). Angles from 55° to 75° fall between ramp and wall: they become a solid slope
of 1:1 plus a wall and get a conf of 0.6, which asks the creator. Above 75° the stroke is a wall.

**Grammar.** Shape rules are numbered S1-S21 (distinct from the repair ops R1-R5). Each rule scores a glyph from 0 to 1. Role = argmax, `alt` = the next two, and `conf` comes from the
rule's isotonic calibration table (`perceive/calibration.json`, fitted on the golden set so that conf ≥ 0.75 has
≥ 95% precision; [M-A] found 0.75 is the natural "ask" threshold).

| # | Ink | Signature (all thresholds in cells) | Role | Base conf | Evidence |
|---|---|---|---|---|---|
| S1 | blue | dot, or closed loop with diameter ≤ 1.2 | coin | 0.95 | taps dropped in 5/6 [B-F7] |
| S2 | blue | closed loop (diameter ≤ 1.5) plus an attached stem ≥ 0.8 | key | 0.85 | |
| S3 | green + black | flag-and-pole glyph (group rule 2) | goal (flag) + pole (scenery) | 0.95 | pole wall 6/6 [B-F1] |
| S4 | green | area ≤ 6 cells², ≥ 3 corners or a small filled shape, no pole | goal | 0.80 | |
| S5 | green | closed scribble with area > 6 cells², or a crown on trunks | decoration (tree/bush) | 0.80 (0.55 if it is the only green glyph) | tree became the goal [B-F2] |
| S6 | red | closed loop or blob with circ ≥ 0.35 and area 0.8-9 cells²; +0.1 with internal parts (eyes) or legs | enemy | 0.75-0.90 | [B-F8] |
| S7 | red | `zigN` ≥ 1.5 per cell, ≥ 3 teeth, `zigAmp` 0.2-1.5 | spikes | 0.90 | [B-F5] |
| S8 | red | straight (≥ 0.9) near-horizontal line within 1.2 cells of a surface face | spikes (flat strip) | 0.75 | owner draft `d_b14b143e` |
| S9 | red | straight line or blob whose x-span lies inside a pit (between two surface ends, below their tops) | lava | 0.80 | owner draft, drawing 5 |
| S10 | black | `zigN` ≥ 1.5 per cell | decoration (grass) 0.55, spikes alt 0.45 | 0.55 (asks) | black zigzag walls [G-§3.1 `d_dfbfe619`] |
| S11 | black | closed loop with ≥ 5 spokes | decoration (sun) | 0.90 | sun became 9 sky blocks [B-F2] |
| S12 | black/any | closed bumpy loop (bumps ≥ 4) in the top 40% with no surface within 2 cells below | decoration (cloud) | 0.75 | [M-A] |
| S13 | any | text cluster (group rule 4) | text | 0.85 | "jump!" became a wall [B-F3] |
| S14 | black | arrow glyph | arrow (with direction) | 0.85 | arrow fused onto platform [B-F3] |
| S15 | black | line with \|θ\| ≤ 55° after fitting, len ≥ 2 | ground if its lowest point is in the bottom 25% of the world or it spans ≥ 50% of a screen near the bottom; ceiling if it is in the top 30% with something hanging under it or it caps two walls; else platform | 0.90 | |
| S16 | black | blob (filled), large, touching the world bottom | ground (mass) | 0.80 | |
| S17 | black | near-vertical (\|θ\| ≥ 75°), len ≥ 1.2, bottom within 0.6 cell of a surface or the world bottom | wall | 0.85 (0.60 if free-floating) | |
| S18 | black | full-height bar spanning floor to ceiling, and the level has exactly one key | door (link to key) | 0.60 (asks) | key became a coin [M-v1] |
| S19 | any | small glyph (≤ 1 cell) not matched above | decoration (mark) | 0.60 | |
| S20 | any | library symbol match (chamfer distance ≤ 0.12 cell on a 32x32 normalized skeleton, against the type's registered samples) | that library type's role | 0.80 | section 14.1 |
| S21 | any | nothing matched | decoration (non-colliding) | 0.30 (asks) | never drop ink [B-direction] |

User labels (canvas chips, re-label menu) always win with conf 1.0. Stamps carry their role.

### 4.6 Relations (`perceive/relate.ts`)

| Relation | Rule | Fixes |
|---|---|---|
| spikes `host`, `face`, `facing` | Candidate faces are parallel to the strip's baseline within 1.5 cells perpendicular with ≥ 40% overlap. The tooth tips point away from the host; the face is the host side nearest the baseline. Facing = away from the face (up on a floor top, down under a ceiling, left/right on wall faces). No host within 1.5 cells: nearest surface below within 3 cells, recorded as `float_dist` for N3. None at all: a hostless thin hazard (allowed, explained). | [B-F5, F6]; the `face` parameter that [M-B] found missing |
| enemy `host` | the surface below the bbox bottom within 3 cells with ≥ 50% overlap | [B-F9] |
| goal anchor | pole bottom, else flag bottom; host = surface below within 6 cells | [B-F1] |
| arrow target | the nearest platform, enemy or saw whose bbox is within 1.5 cells of the arrow's tail and within 1 cell of the shaft line. It gives a `move` (or `patrol`) hint with `cells = round(shaft length)` in the arrow's direction. | v1 handled arrows only via the model |
| text label | nearest object within 2 cells (context for the model) | |
| start | `start_mark` or `start` stamp → the lowest standable cell under it; else the **lowest** standable cell in the leftmost 6 columns that has ≥ 3 rows of headroom | spawn on the cave roof [M-B], spawn mid-level [M-v1] |
| key → door | explicit rule, or S18's single-key heuristic (asks) | [M-v1] |

### 4.7 Typed rules without the model (`perceive/rules_parser.ts`)

Canvas rules come from chips attached to a stroke (exact binding) or from the rules text box. The parser handles the
common sentences offline with a small grammar:

| Pattern (case-insensitive, examples) | Produces |
|---|---|
| `<target> (moves\|slides\|goes) [left\|right\|up\|down] [N] [cells\|blocks\|squares]` | P3 `move` (default 4 cells right, speed normal) |
| `<target> (walks\|patrols\|jumps\|hops\|flies\|chases\|shoots)` | P3 enemy archetype |
| `<target> is (bouncy\|a trampoline\|a spring)` | P3 `bounce` |
| `key opens [the] door`, `door opens with [the] key` | P4 `link_key` |
| `N seconds`, `timer N`, `hurry` | P3 `timer` (hurry = auto, 1.5 × par) |
| `<target> (crumbles\|falls\|breaks)` | P3 `crumble` |
| `make it (easy\|hard)` | dial band pin |

Target resolution: nouns map to roles (platform, ledge, floor → platform; monster, enemy, guy, spikes → enemy or
spikes; door; key). "This" or "that" uses the stroke the chip is attached to. Adjectives narrow the set: high/top →
smallest y; low/bottom → largest y; left/first → smallest x; right/last → largest x; big/long → longest; small/short →
shortest. Ground-role objects are never targets of `move`. If exactly one object remains, the rule binds to it. **If several match, the parser asks** ("Which platform moves? Tap it."). It never picks "the largest"
[B-F10]. It never merges its guesses on top of the model's answer; the model's typed rules replace the parser's for
any sentence the model returns.

### 4.8 The semantic pass (model, surgical)

**When it runs** (otherwise no call is made and the cost is $0):

- the scene has glyphs with conf < 0.75; or
- there are text glyphs in the drawing area, or ink in the paper rules box; or
- there are typed sentences the parser could not bind.

A canvas level drawn with stamps and chips typically triggers none of these.

**What it sees:** the annotated sheet image(s) at ≤ 1600 px wide (glyph ids in magenta, asked glyphs boxed; only the
sheets that contain asked or text glyphs; at most 3 images), plus a JSON glyph table with every glyph (`id, ink, bbox,
role, conf, alt, asked`) so references resolve, the rules text, parent objects for remixes, and library names. **No
physics question is asked**, because the model judges gaps wrongly from pixels [M-A problems, M-B].

**Call:** `client.beta.messages.parse`, `model="claude-opus-5"`, thinking omitted (adaptive is the Opus 5 default),
`output_config={"effort": "low"}` (low matched medium accuracy at 1.3x the speed [M-A]),
`betas=["server-side-fallback-2026-07-01"]`, `fallbacks="default"` (verified accepted in 23/23 calls [M-api]),
`max_tokens=6000`, `with_options(timeout=14.0, max_retries=0)`, system prompt marked
`cache_control: {"type": "ephemeral"}` (Opus 5 caches prefixes from 512 tokens).

**Schema** (`vision/app/v2/mind/schemas.py`). Model-facing schemas use enums instead of numeric bounds, because
structured outputs do not enforce `minimum`/`maximum` and the SDK would reject the whole response client-side on a
violation. Bounds are applied by the sanitizer instead.

```python
Role = Literal["ground","platform","wall","ceiling","spikes","lava","saw","enemy","goal","pole","coin","key",
               "door","checkpoint","spring","start_mark","decoration","text","arrow","unknown"]
Speed = Literal["slow", "normal", "fast"]

class GlyphAnswer(BaseModel):
    id: str
    role: Role
    confidence: Literal["high", "medium", "low"]       # mapped to 0.9 / 0.75 / 0.5
    part_of: str | None
    reads: str | None                                  # verbatim text for text glyphs

class RuleMove(BaseModel):      kind: Literal["move"]; target: str; direction: Literal["left","right","up","down"]; cells: int; speed: Speed
class RuleEnemy(BaseModel):     kind: Literal["enemy"]; target: str; style: Literal["walker","hopper","flyer","shooter","chaser","crusher"]; speed: Speed
class RuleBounce(BaseModel):    kind: Literal["bounce"]; target: str; strength: Literal["small","normal","big"]
class RuleKeyDoor(BaseModel):   kind: Literal["key_door"]; key: str; door: str            # both REQUIRED [M-v1]
class RuleCrumble(BaseModel):   kind: Literal["crumble"]; target: str
class RuleCheckpoint(BaseModel):kind: Literal["checkpoint"]; target: str
class RuleStart(BaseModel):     kind: Literal["start"]; near: str
class RuleTimer(BaseModel):     kind: Literal["timer"]; seconds: int
class RuleLibrary(BaseModel):   kind: Literal["library"]; target: str; name: str
class RuleDifficulty(BaseModel):kind: Literal["difficulty"]; band: Literal["easy","normal","hard"]
SemRule = Annotated[RuleMove | RuleEnemy | RuleBounce | RuleKeyDoor | RuleCrumble | RuleCheckpoint
                    | RuleStart | RuleTimer | RuleLibrary | RuleDifficulty, Field(discriminator="kind")]

class Question(BaseModel):
    about: str                                         # glyph id
    ask_kid: str                                       # e.g. "Which door does this key open?"

class Semantics(BaseModel):
    answers: list[GlyphAnswer]
    rules: list[SemRule]
    questions: list[Question]
    title: str | None
    transcript: str                                    # all handwriting, verbatim
    safety: Literal["ok", "flag"]
    safety_reason: str | None
```

**System prompt responsibilities** (`mind/prompts/semantics.md`, about 450 words, frozen and versioned):

1. Explain that code already found every glyph, its geometry and a role guess with confidence, and that code
   computes all physics: "never judge distances, heights or whether something can be reached."
2. Answer only for glyph ids where `asked` is true, plus read every text glyph verbatim into `reads`.
3. Define each role in one line, including that kids draw scenery (trees, suns, clouds) that must not collide,
   that a flag pole is scenery, and that the eyes of a monster are `part_of` it.
4. Turn the handwriting and typed rules into `rules`, resolving "the monster", "this platform" or an arrow to glyph
   ids. Where a required link is missing (a key but no door), add a `question` instead of guessing.
5. Safety: flag sexual, hateful or graphically violent content; monsters, spikes and lava are fine.
6. "Use only the listed ids." (Code drops unknown ids anyway [M-A invented id 17].)

**Sanitizer** (`mind/sanitize.py`): drop answers for unknown or un-asked ids; drop rules whose targets do not exist or
violate the colour/role matrix; clamp `cells` to 1-12 and `seconds` to 10-300; map enums to numbers via
`shared/kernel/params.json`; turn the result into `P1`-`P6` edits with `origin: 'model'`. Priority on conflict: user >
model > parser > grammar.

**Failure handling:**

| Outcome | Detection | Behaviour |
|---|---|---|
| Timeout (14 s), connection error, 5xx | SDK exceptions | Grammar roles stand; text stays non-colliding; rules box shows "I couldn't read your writing. Type it here." with the parser |
| Refusal after the fallback chain | `stop_reason == "refusal"` (checked before reading content) | As above, plus `meta.safety = 'unknown'`: private play allowed, public publish held until `POST /api/v2/levels/{id}/moderate` succeeds |
| Served by the fallback model | `usage.iterations` contains `fallback_message` | Accept; log `served_by` |
| Truncated | `stop_reason == "max_tokens"` | Treat as a failure (never partial-apply) |
| Schema or validation error | parse raises | Treat as a failure; log the request id |
| No network or no key | `/api/v2/health` reports `model: offline` | Model features hidden, with one line of explanation; everything else works |

---

## 5. A. The level-design mind, part 2: intent-preserving repair

### 5.1 Structure

Repair is a small constrained optimization. Objects keep the pose they were drawn with unless a **hard constraint**
fails. Hard constraints are: solvable; the fairness flags of section 7.4; spikes attached to a face; enemies and goal
grounded; spawn clear; no collider overlapping a thing. When one fails, the kernel searches for the minimal-cost set of
vocabulary ops that satisfies it, under the **intent invariants** of section 5.4. Two layers:

1. **Normalizers** (`N*`): always applied, local, cheap and explained in aggregate ("Tidied 9 wobbly lines"). They
   implement the build diagnosis's direction column [B-F1 ... F11]. They run **before** any model stage, so
   downstream stages never trip on bumps and holes [M-failure-7].
2. **Repair search** (`R*`): runs only while a hard constraint fails, edits the minimum, and explains each edit
   individually ("This jump was 9 cells. The longest run jump is 8. I moved this ledge 1 cell left.").

### 5.2 Repair search (`shared/kernel/repair/search.ts`)

```
level = realize(normalize(scene)); pt = playtest(level)
for round in 1..4 while (not pt.solvable or pt.hardFlags):
    f = classify(pt.firstFailure)        # the unreached setpiece nearest the frontier, in route order
    C = generators[f.kind](f)            # at most 64 candidates, each 1-2 ops, all inside vocabulary bounds
    for c in C (ordered by intent cost):
        sandbox = applyEdits(level, c); local = playtest(sandbox, window = f.x ± 1.5 screens)
        keep c if local.frontier advanced and invariants(sandbox) hold
    choose: cheapest c that makes the window solvable, else largest frontier gain per unit of cost
    if two solvable c within 20% cost and online: queue arbitration (5.5), proceed with the cheaper now
if still failing: report in plain words + "Ask the designer" button (model repair planner, 5.5)
```

| Failure kind | Detected as | Candidate generators (cheapest first) |
|---|---|---|
| `gap_too_wide` | from the frontier edge, no jump policy lands on the next surface; gap `g`, runway `r` | R1 nudge far surface toward by `g − g_max(r)` (≤ 3); R3 extend near or far edge (≤ 2); R3 extend runway behind (to 3 cells, the run-up distance in 11.1); R4 add_step mid-gap |
| `ledge_too_high` | landing top is `Δ` rows above the takeoff top, beyond the walk/run envelope | R1 nudge target down (≤ 3); R4 add_step under it; R5 add_spring |
| `head_bonk` | the arc collides with an overhang's underside before its apex (owner draft `d_b14b143e` bonks at frame 8 [G-§3.1]) | N6 make the overhang one-way (cost 1, preferred when it is a thin platform); R1 nudge the overhang up (≤ 2); R2 trim the overhang end (≤ 2) |
| `wall_too_tall` | wall height `h` exceeds the max jumpable from the available speed | R2 trim the wall top (≤ 2), **preferred over lifting it** (detached-pillar penalty +4) [M-B wall lifted]; R4 add_step at its base; R5 add_spring |
| `goal_unreachable` | goal trigger not touched by any reachable trajectory | N4 ground the goal (≤ 6); R1 nudge its surface; extend |
| `spawn_trapped` | fewer than 4 reachable nodes | N7 place the start on the next-lowest standable surface |
| `key_unreachable` | key not reachable with the door closed | the same as gaps/ledges, targeted at the key's surface |
| `hard_flag` | tight window, blind jump or spawn danger on a required action | widen the window: R3 extend landing; R1 nudge closer; N7 move the spawn |

**Intent cost** (`repair/cost.ts`): R1 nudge 1.0 per cell in x and 1.5 per cell in y, multiplied by
`clamp(sqrt(len/4), 0.75, 2)` so big objects cost more to move; R2 trim 1.2 per cell; R3 extend 0.8 per cell; N6 flip 1.0;
N7 2.0 plus 0.5 per cell; R4 add_step 6; R5 add_spring 8; a detached wall +4; moving an object the creator also wrote
about (a text label targets it) ×2. Ties are broken by op order, then by smaller x, so the result is deterministic.

Worked examples on the evidence:

| Input | v1 outcome | v2 normalizers | v2 repair |
|---|---|---|---|
| Drawings 1-6, flag pole | 4-5 cell wall, goal floating behind it [B-F1] | S3 groups pole + flag; N5 pole is scenery; N4 goal grounded at the pole foot | none needed |
| Drawing 3, tree and sun | tree is the goal; trunk walls the player into 9 cells [B-F2] | S5 tree = decoration (crown 0.80, trunk part_of); S11 sun = decoration; S3 the small flag is the goal | none; solvable (the counterfactual had 58 reachable cells) |
| Drawing 4, model off | "jump!" and the arrow become terrain, reachable 41 → 26 [B-F3] | S13 text, S14 arrow (a move hint for the platform: `cells` from the shaft length) | none |
| Drawing 5, 8-cell drawn gap | silently impossible [B-F12] | none | with v2 physics a run jump clears 8 cells given 3 cells of runway (11.1), so solvable if the runway exists; else R3 extends the runway |
| Drawing 6, goal platform 12 cells away and 4 rows up | unsolvable, no suggestion | ramp → 1:1 slope (no staircase); spikes snapped (N3); monster grounded; only the monster walks (no heuristic merge) | R1 nudge the goal platform 3 left + R3 extend 2 left, or R4 one stepping stone; whichever is cheapest |
| Owner `d_b14b143e` | stepping stone 6 rows up, head bonk, floor became a moving platform [G-§3.1, V-1] | N6 floating thin platforms are one-way (no bonk); red flat lines = spikes on the floor (S8) and lava in the pit (S9); green Γ = goal | Faithful: **0 repair edits**. The level is solvable because the bonk is gone and the 5-cell pit is a run gap (G-§10 asks for ≤ 3 edits, each ≤ 3 cells). Polished: R1 nudges the stepping stone down 2 rows (rise 6 → 4, under the 4.45-cell walk-jump apex) and the high ledge down 2, so both drawn coins become reachable (`unreachable_drawn`). The typed "high platform moves 4 cells" binds to the highest platform (parser adjective rule), never the floor |
| Owner `d_dfbfe619` black zigzag on a platform | 1-cell walls, 12 reachable cells | S10 black zigzag = decoration (conf 0.55, asks: "Is this grass or spikes?") | none |
| Wobbly cave [M-B] | spawn on the roof; 8-cell pit; 5-cell wall | N7 lowest standable start; N2 closes the 1-cell hole; N1 straightens | 8-cell pit is run-jumpable; wall: R2 trim 1 (5 → 4, walk-jumpable) instead of lifting it |

### 5.3 The edit vocabulary (fixed, 37 ops)

Every op is a typed variant in `shared/kernel/ops/*.ts` with `precondition(level)`, `apply(level) → level`,
`explain() → ReasonCode`, and bounds that are clamped (never trusted) whoever proposes it. "Who" says which origins
may emit the op. "Dial" is the lowest dial position at which the op can be applied automatically. Cell displacement is
measured on the fitted shape.

**Perception corrections (P), stage `semantic` or `user`**

| Op | Params | Bounds and preconditions | Who |
|---|---|---|---|
| P1 `relabel` | `obj, role` | role allowed by the ink matrix (black: terrain, decoration, text, arrow, door, wall, pole, spikes; red: hazards, enemy, text, decoration; green: goal, decoration, checkpoint; blue: coin, key, decoration) | model, user |
| P2 `merge` | `into, parts[]` | parts are within 1 cell of `into` | model, user |
| P3 `bind` | `obj, behavior: BehaviorSpec` | BehaviorSpec union: `move{dir,cells 1-12,speed}`, `enemy{arch,speed}`, `bounce{strength}`, `crumble{}`, `checkpoint{}`, `timer{seconds 10-300}`, `difficulty{band}`; ground-role objects spanning > 60% of a screen cannot move (v1 rule kept [V-1]) | parser, model, user |
| P4 `link_key` | `key, door` | both exist; door is a wall-like object | parser, model, user |
| P5 `set_start` | `near: obj` | resolves via N7 | parser, model, user |
| P6 `use_library` | `obj, type_id` | type exists in the game library | matcher, model, user |

**Normalizers (N), stage `faithful`, origin `normalizer`, always auto**

| Op | Params | Bounds | Report group |
|---|---|---|---|
| N1 `straighten` | `obj, segs[]` | max deviation from the ink centreline ≤ 0.5 cell (else keep a split) | tidy_lines |
| N2 `close_gap` | `a, b` | gap ≤ 1.0 cell along the baseline, Δy ≤ 0.5 after snapping, same role family, no hazard inside the gap | tidy_lines |
| N3 `snap_spikes` | `strip, host, face` | displacement ≤ 2 cells; clipped to the face extent; facing = away from the face | snap_hazards |
| N4 `ground` | `obj, surface` | enemy, checkpoint, spring ≤ 3 cells; goal ≤ 6; coins and keys may float | ground_things |
| N5 `scenery` | `obj` | role ∈ pole, decoration, text, arrow | scenery |
| N6 `surface_mode` | `obj, mode: solid\|oneway` | default oneway for floating thin platforms (w < 0.6, not ground or ceiling) [G-§7.2 item 6] | platforms |
| N7 `place_start` | `surface, x` | ≤ 8 cells from the mark or default; hazard-free radius 3; no enemy path within 3 | spawn |
| N8 `coin_from_dot` | `obj` | blue dot or small loop | coins |
| N9 `dedupe` | `keep, drop` | same thing type within 1 cell; keeps the parent's | remix |
| N10 `join_seam` | `a, b` | both ends within 0.75 cell of a sheet seam, Δy ≤ 1 cell | sheets |
| N11 `fit_creature` | `obj, w, h` | hitbox from the glyph bbox, scaled to ≤ 2x2 cells keeping aspect, ≥ 0.75 cell | creatures |

**Repair (R), stage `faithful`, origin `repair` (or `model` via 5.5)**

| Op | Params | Bounds | Cost |
|---|---|---|---|
| R1 `nudge` | `group, dx, dy` (moves `part_of` groups and carried things together [M-failure-5]) | \|dx\| ≤ 3, \|dy\| ≤ 3 | 1.0 / 1.5 per cell × size factor |
| R2 `trim` | `obj, side: left\|right\|top\|bottom, cells` | 1-2 cells; result length ≥ 2 | 1.2 per cell |
| R3 `extend` | `obj, side, cells` | 1-2 cells into empty space | 0.8 per cell |
| R4 `add_step` | `x, y, w` | w 2-3, in empty space, designer ink | 6 |
| R5 `add_spring` | `surface, x` | on a flat top, designer ink | 8 |

**Designer (D), stages `polished`/`challenging`, origin `designer` (subset also `model` via 8.5)**

| Op | Params | Bounds and site rules | Dial |
|---|---|---|---|
| D1 `add_checkpoint` | `surface, x` | flat run ≥ 4 cells, ≥ 3 cells from hazards and enemy paths, ≤ 1 per screen | Polished |
| D2 `add_coin_arc` | `action, n` | n 3-5 coins sampled along the bot's actual trajectory for that action | Polished |
| D3 `add_coin` | `x, y` | empty cell, reachable | Polished |
| D4 `add_big_coin` | `x, y` | ≤ 3 per level; site where the best path has d ≥ 0.1, or an off-route alcove ≤ 2 extra actions | Polished |
| D5 `tune` | `obj, param, value` | ranges in 11.4 and 11.5; Polished may only raise (never lower) drawn params and only to C ≤ 0.3 | Polished |
| D6 `widen_gap` | `gap, cells` | +1..+2, never beyond `g_max(runway) − 1` | Challenging |
| D7 `shrink_landing` | `surface, side, cells` | 1-2, landing stays ≥ 2 cells | Challenging |
| D8 `shift_platform` | `obj, dx, dy` | \|dx\| ≤ 2, \|dy\| ≤ 1 | Challenging |
| D9 `add_spikes` | `surface, x0, x1, face` | only on undrawn faces of drawn surfaces or pit floors; length 1-6; ≥ 3 cells from spawn/checkpoints; leaves a landing ≥ 2 | Challenging |
| D10 `add_enemy` | `arch, surface, x, params` | flat empty run ≥ 8 cells (walker, chaser), ≥ 6 (hopper), clear air 3x3 (flyer); ≥ 6 cells from spawn/checkpoints | Challenging |
| D11 `add_hazard` | `kind: saw\|firebar\|lava, ...` | empty space with ≥ 1 cell clearance from ink; saws on paths ≤ 8 cells | Challenging |
| D12 `make_crumble` | `obj` | platform ≤ 6 cells, not ground, not under a spawn or checkpoint | Challenging |
| D13 `set_timer` | `seconds` | 1.2-2.0 × the bot's fastest time; only with GameRules `timer: auto` or Challenging-Hard | Challenging |
| D14 `set_par` | `ms` | ceil to 0.5 s of 1.3 × the bot's fastest | Polished |
| D15 `reprise` | `setpiece, at_x, escalation: faster\|add_saw\|narrower` | levels ≥ 3 screens; target region ≥ 10 empty cells after the original; one per level | Challenging |

### 5.4 Intent invariants (`shared/kernel/design/invariants.ts`)

Checked after every op; an op that breaks one is rejected and logged (not shown unless the user opens "Rejected
ideas"). These are G-§9's invariants made concrete:

| # | Invariant | Check |
|---|---|---|
| I1 | Every drawn object survives with its role and stays lethal or collectable | multiset of (drawn obj id, role family) unchanged except by P1/N5 |
| I2 | Drift: normalizers ≤ 1 cell per object; repair ≤ 3 per object and only while a hard constraint fails; designer geometry ≤ 2 (Challenging only). Level budgets: repair ≤ 12 cell-moves; designer geometry ≤ 10 cell-moves | displacement of fitted shapes vs the faithful base |
| I3 | Route order: the drawn setpieces visited on the critical path, in order, are an ordered subsequence of the new critical path | setpiece = drawn surface, hazard, enemy, spring, key or door within 2 cells of the path |
| I4 | Text and chip rules pin parameters | `DesignOpts.pinned` params are immutable |
| I5 | Added content looks added | origin ∈ {repair add_*, designer} renders in designer ink |
| I6 | Always solvable and fair | playtest: solvable, no hard flags |

### 5.5 Model arbitration and the model repair planner (async, medium effort)

Used in two cases only: (a) the search found two or more solvable candidates within 20% cost (for example "lower this
ledge" or "move that one closer"), or (b) it found no candidate within bounds. Input: failure descriptions **with
solver facts** ("gap 9 cells; the best run jump from a 3-cell runway clears 8"), the candidate options with
before/after thumbnails rendered by the client (≤ 4 PNGs of 480x270), and the scene object table. This is the setup
in which the model repaired 4/4 levels [M-B].

```python
class Pick(BaseModel):
    failure: str; option: str; why_for_kid: str
class OpNudge(BaseModel):    op: Literal["nudge"]; group: str; dx: int; dy: int
class OpTrim(BaseModel):     op: Literal["trim"]; obj: str; side: Literal["left","right","top","bottom"]; cells: int
class OpExtend(BaseModel):   op: Literal["extend"]; obj: str; side: Literal["left","right"]; cells: int
class OpOneWay(BaseModel):   op: Literal["surface_mode"]; obj: str; mode: Literal["solid","oneway"]
class OpRelabel(BaseModel):  op: Literal["relabel"]; obj: str; role: Role
class OpAddStep(BaseModel):  op: Literal["add_step"]; x: int; y: int; w: int
RepairOp = Annotated[OpNudge | OpTrim | OpExtend | OpOneWay | OpRelabel | OpAddStep, Field(discriminator="op")]
class Arbitration(BaseModel):
    picks: list[Pick]
    extra_ops: list[RepairOp]        # only for failures with no option; at most 4 kept by the sanitizer
```

Effort `medium` (high was slower and worse [M-B high]), `timeout=40`, `max_retries=1`. Every returned op is clamped,
applied in a sandbox and re-solved; anything that fails is discarded. The level the user already sees is replaced only
if the result is valid, with a diff row "The designer chose a different fix: ...".

---

## 6. Realize: one geometry → collision, things and art anchors

### 6.1 Collision tiles (`shared/kernel/realize/tiles.ts`, spec in `shared/spec/level-format-v2.md` §5)

16 px cells, one character per cell, rows run-length encoded as `<count><char>` (count omitted when 1):

| Code | Shape | Floor height at left → right edge (px from the cell top, 16 = cell bottom) |
|---|---|---|
| `.` | empty | n/a |
| `#` | solid | full |
| `-` | one-way top (land from above; drop through with Down + Jump) | top edge only |
| `/` | 45° floor rising to the right | 16 → 0 |
| `\` | 45° floor rising to the left | 0 → 16 |
| `a`, `b` | 1:2 floor rising to the right, low half and high half | 16 → 8, 8 → 0 |
| `c`, `d` | 1:2 floor rising to the left, high half and low half | 0 → 8, 8 → 16 |

Below a slope profile the tile is solid. Hazards, doors, moving platforms, crumble platforms and springs are not
tiles; they are things with their own hitboxes. So a spike strip can never convert its wall into hazard [B-F6].

### 6.2 Rasterization rules (the spec other engines implement)

| Primitive | Rule |
|---|---|
| Flat segment | ink top edge `y_top = y_centre − w/2`; row `r = round(y_top)`; cells `x ∈ [round(x0), round(x1))` in row r get `#` or `-`. **Exactly one row** for platforms [B-F4: 26-91% double-thick in v1]. |
| Ground | the surface row plus a ground mass filled down to the world bottom, stopping 1 row above any other surface beneath it. The art draws the hatch fill over exactly these cells. |
| Ceiling | one row; if within the top 4 rows and ≥ 4 cells long, a rock mass filled up to row 0 |
| Slope | endpoints snapped to integer x and to the slope lattice; 1:1 → `/` or `\` per cell, 1:2 → `a b` or `c d` pairs; adjoining segments share endpoints so there are no seams or bumps |
| Wall | column `round(x_centre − 0.5)`, rows from `round(y_top)` down to its host's row or the world bottom |
| Spike hitbox | facing up on the top face of row r: x ∈ [16·x0 + 2, 16·x1 − 2], y ∈ [16·r − 6, 16·r]. Down, left and right are the same 6 px band on the respective face. Art triangles are 10 px tall, so the art is slightly larger than the hitbox (forgiving). Replaces v1's 32 px block [B-F5]. |
| Lava | x-span of the pit at the lava row; hitbox top 4 px below the drawn surface |
| Enemy | AABB from N11; feet exactly on the host top |
| Goal | trigger = union of the flag and pole art boxes (touch the pole, like Mario's flagpole); the art is the kid's flag |
| Coin | 10 px circle hitbox at the dot centre, no cell snapping, so the art and the pickup coincide [B-F14] |
| Moving / crumble platform | kinematic one-row AABB (one-way top unless `solid`), path in cells |

### 6.3 Structural validator (`realize/validate.ts`), run before any simulation

This fixes the class of failure where a ground stroke became a zero-length moving platform and crashed the scene
[V-1, V-§0]. Each check either auto-fixes via an op or blocks publish with a message:

| Check | Auto-fix | Otherwise |
|---|---|---|
| start cell standable, not inside a thing | N7 | block |
| moving path length ≥ 1 cell and inside the world | drop `move`, warn | n/a |
| ground-role object not dynamic if it spans > 60% of a screen | drop the binding, warn | n/a |
| every key has a door, every door a key | turn the orphan key into a coin, plus a Question card | n/a |
| one goal exists | synthesize one at the rightmost standable cell (designer ink) | n/a |
| no duplicates of the same type within 0.5 cell | N9 | n/a |
| the collision hash matches `collision.rows` | rebuild | n/a |

The engine also wraps each behavior in try/catch. On an exception the behavior is disabled, the event
`entity_error` is reported to the preview, and **publish is blocked** with the message "Something I built doesn't
work: the moving platform near the start. I turned it off."

---

## 7. A + B. The playtest bot and the difficulty model

### 7.1 One simulation (`shared/kernel/physics/`, `shared/kernel/world/`)

`stepWorld(state, input)` advances player, enemies, projectiles, platforms, crumble timers, saws, firebars, lava and
the camera by exactly one 60 Hz frame. The engine calls it from a fixed-timestep accumulator (render interpolates
between the last two states), and the solver calls the same function. There is no second implementation to drift
[G-§10 "the solver and engine must share one physics module"].

Determinism rules, enforced by a lint test that scans `physics/` and `world/`: no `Math.random` (seeded xorshift only);
no `Math.sin`, `cos`, `exp`, `pow` or `atan2` in the step (firebars and flyers use a 1024-entry sine table generated at
module load with exact arithmetic); time is an integer frame counter; only `+ − × ÷ floor round min max abs sqrt`
(IEEE-exact in every engine). The result is bit-identical in Chrome, Safari, Firefox and Node, which makes publish
hashes and speedrun replays verifiable (14.4).

### 7.2 The solver (`shared/kernel/solver/`)

| Aspect | v1 | v2 |
|---|---|---|
| World size | `GAME_W`/`GAME_H` hard-coded [G-§6 notes, M-B] | `world.w × world.h` from the level |
| Physics | Arcade port, no coyote or buffer | `stepWorld` itself (coyote, buffer, corner correction, slopes, one-way) |
| Moving platforms | static one-way along the whole path [M-B] | time-exact: takeoff frames sampled over 16 phases of the nearest cycle, refined to 1 frame by bisection; explicit `wait k` actions |
| Enemies | ignored | simulated; contact kills; stomp is an action (`stomp-bounce`) |
| Policies | hold direction for the whole jump [G-§11] | speed ∈ {stand, walk, run if runway ≥ 3 cells}; hold ∈ {1, 3, 6, 9, 12, 16, 20, 30} frames; direction release ∈ {never, 8, 16, 24}; air reverse-steer for small landings; drop; drop-through; spring; double jump at {8, 14, 20, 26} when the ability is on |
| Nodes | standing cells | (surface id, x at 4 px resolution, key bitmask) |
| Output | reachable cells | reachable set, critical path, fastest time, per-action windows, flags |

**Speed trick: trajectory templates.** For each (physics profile, initial-speed bucket, hold, release) the kernel
precomputes the body offsets of free flight for up to 3 s. At runtime a jump walks its template and tests only cells,
hazards and entities along it; at the first contact it switches to exact `stepWorld` from that frame. A property test
checks 10,000 random (node, action) pairs against full simulation: the outcomes must be identical.

Budgets (Node 24 on this laptop; the browser is similar, phones 2-3x): reachability + critical path + windows for 3
screens ≤ 300 ms, for 6 screens ≤ 1 s. A local re-solve inside the repair or design loop covers ±1.5 screens and takes
≤ 60 ms.

### 7.3 Metrics (`shared/kernel/metrics/difficulty.ts`)

Per required action i on the critical path, where the critical path is the route with the fewest expected deaths and
ties go to the fastest [G-§6]:

- `w_i` takeoff window, in frames: a 1 px sweep of the takeoff position at the action's speed, divided by px per frame;
- `h_i` hold window: hold lengths 1-40 frames that succeed from the best takeoff;
- `φ_i` phase window: frames of the governing entity's cycle in which the action succeeds (∞ if static);
- `L_i` lethal share: the fraction of failing samples that end in death rather than a safe fall-back.

```
p_i = 1 − (1 − 2Φ(−w_i / 2σ)) · (1 − 2Φ(−h_i / 2σ)) · (1 − 2Φ(−φ_i / 2σ))     σ_casual = 3 f, σ_skilled = 1.5 f
d_i = p_i · L_i
E_s = Σ_{i ∈ s} d_i        T_s = fastest time of segment s (segments are split by checkpoints)
C   = max_s E_s + 0.25 · Σ_s E_s          (Challenge; the hardest segment dominates)
F   = Σ_s E_s · T_s                        (Frustration: expected seconds lost to replays)
T_casual = 1.5 · Σ_s T_s + F               (used for clear-time targets)
score = round(100 · (1 − e^(−C)))          (0-100 badge for the UI and the feed)
```

Bands (casual) [G-§6]:

| Band | C | Reference measurements |
|---|---|---|
| Trivial | < 0.05 | all three v1 Starter levels [G-§3] |
| Easy | 0.05-0.3 | one 6-cell pit 0.049; owner's Synth 1 0.125 |
| Normal | 0.3-1.0 | n/a |
| Hard | 1.0-3.0 | 7 pillar jumps over spikes 1.92 |
| Expert | > 3.0 | not targeted by the designer |

`level_metrics.ts` in the gameplay diagnosis is the prototype; its Starter World numbers are a regression fixture
(v1 levels under the `v1` profile must reproduce E[deaths] 0.000 / 0.004 / 0.000 within 0.005).

### 7.4 Bot flags (designer-grade playtesting)

| Flag | Definition | Severity |
|---|---|---|
| `unsolvable` | goal not reachable (or key unreachable with the door closed) | hard: blocks publish |
| `tight_window` | a required action with min(w, h, φ) < 4 frames (casual) | hard (fairness) |
| `blind_jump` | at the takeoff frame, the landing node is outside the camera rect produced by the kernel's camera model (12.2) | hard |
| `spawn_danger` | a hazard hitbox or enemy path within 2 cells of the spawn or a checkpoint | hard |
| `long_segment` | F_s > 30 s, or T_s > 25 s with E_s > 0.3 | hard for designer output, warning for drawn content (Polished adds a checkpoint) |
| `softlock` | reachable node with no path to the goal and no way to die or return | warning for drawn content; the designer may never create one |
| `unreachable_drawn` | a drawn coin, key or platform never reached | warning (Polished repairs coins with R1 ≤ 2 or moves the coin ≤ 2 cells) |
| `unused_hazard` | a drawn hazard never within 2 cells of any route | info ("You drew spikes nobody will meet") |
| `dead_end` | an off-route region that costs > 10 s to back out of | info |
| `trivial_screen` | a screen with 0 required actions | info (the Challenging designer targets these) |

Each flag carries the frame, the position and a suggested fix as an edit, so "How it plays" can offer "Fix it".

---

## 8. A + B. The designer and the difficulty dial

### 8.1 Dial semantics

| Position | Ops allowed automatically | Target | Notes |
|---|---|---|---|
| **Faithful** | P, N, R | solvable + no hard flags; C is whatever was drawn | v2 physics makes most drawn gaps and walls feasible, so repairs are rare |
| **Polished** (default) | Faithful + D1-D5, D14; R1 or coin moves for unreachable drawn coins | C_target = max(C_drawn, 0.1); D5 may raise drawn params only, and only up to C 0.3; **never lowers drawn difficulty** except to clear a hard flag | checkpoints so every F_s ≤ 30 s; coin arcs over run-up gaps and over jumps > 5 cells; ≤ 3 big coins; par time and medals |
| **Challenging · Normal** | all D | C ∈ [0.3, 1.0), aim 0.6 | geometry drift ≤ 2; sawtooth pacing; one reprise in levels ≥ 3 screens |
| **Challenging · Hard** | all D, D13 | C ∈ [1.0, 3.0), aim 1.8 | timer only if GameRules `timer: auto` |

Switching the dial re-runs `design()` from the faithful base locally (≤ 2.5 s, deterministic) and replaces the D edits;
P, N, R and user edits are kept.

### 8.2 Algorithm (`shared/kernel/design/tuner.ts`)

```
base = faithful build; pt = playtest(base)
if dial == faithful: return base
polish(base): checkpoints (8.4) → coin arcs → big coins → par → (raise params if C < 0.1)
if dial == challenging:
  loop until C ∈ band or ops == 12 or elapsed > budget_ms (2500):
    cands = Σ generators(level, pt)                    # 8.3; each candidate has a site and a predicted ΔC
    top   = 24 best by predicted ΔC / intent cost, preferring sites in the later 60% of each segment (sawtooth)
    for c in top: sandbox apply → invariants (5.4) → local playtest → actual ΔC; reject overshoot (C > band max)
    commit the best actual ΔC / cost; re-place checkpoints if F_s > 30
  if C < band min after the loop: report "Couldn't reach Normal without changing your drawing too much (C 0.21)"
```

Ties are broken by op order, then by x, then by object id, so the same input always yields the same level in the
browser and on the server.

### 8.3 Pattern generators (procedural difficulty)

| Generator | Site | Ops | Predicted ΔC (cheap, analytic) |
|---|---|---|---|
| `tighten_jump` | a required jump with w > 12 frames | D6 widen_gap +1, D7 shrink_landing | Δw ≈ −16 px ÷ (px per frame at takeoff speed): −5.7 f when running, −10 f when walking → Δp via the formula |
| `guard_flat` | a flat run ≥ 8 cells on the route with no threat | D10 walker (or hopper with headroom ≥ 4, chaser on long runs) | +0.05 to +0.2 depending on the stomp/jump-over phase window |
| `arm_landing` | an undrawn top face the route lands on | D9 spikes on the far part, leaving ≥ 2 landing cells | lethal share L ↑ for overshoots |
| `speed_up` | a drawn enemy or moving platform | D5 +1 cell/s | φ ↓ |
| `crumble_landing` | a landing platform ≤ 6 cells mid-segment | D12 | adds a timing action |
| `saw_window` | the apex region of a gap jump with ≥ 3 cells of clear air (Hard) | D11 saw on a 4-6 cell path | φ window ≈ cycle × safe fraction |
| `reprise` | an empty region ≥ 10 cells after a drawn setpiece | D15 with one escalation | as the setpiece × 1.3 |
| `pit_floor` | a pit with a void floor | D9 spikes on the pit floor (readability; L unchanged) | 0 (used for readability only) |

### 8.4 Checkpoints, coins and pacing (Polished)

- **Checkpoints**: walk the critical path; close a segment when T_s ≥ 20 s or E_s ≥ 0.5, at the nearest flat run of
  ≥ 4 cells with no hazard within 3 cells. At most 1 per screen, none in the first screen. Drawn checkpoints are kept
  and count.
- **Coin arcs**: 3-5 coins sampled along the bot's real trajectory over each run-up gap (this teaches the run), each
  jump > 5 cells, and each jump that would otherwise be blind. Coins never sit on a different trajectory than a
  successful one. M-C found coin trails were 100% valid when placed this way.
- **Big coins** (≤ 3): the apex of the riskiest optional arc; an off-route alcove reachable in ≤ 2 extra actions; above
  an enemy, reachable only via a stomp bounce.
- **Par** = ceil to 0.5 s of 1.3 × the bot's fastest time. Medals: clear, all coins (including big coins), par, no deaths.
- **Sawtooth**: in Challenging, sites in the later part of each segment are preferred, so E rises toward each
  checkpoint and drops after it [G-§5 principle 2].

### 8.5 Taste review (model, async, optional)

After the polished or challenging build, the browser sends `POST /api/v2/review` with: a PNG render of the whole level
(wrapped every 3 screens, ≤ 2048 px wide), the object table (id, role, origin, bbox), the edit list (id, op,
reason), per-segment metrics, the dial and band, and the invariants. The model may **veto** designer edits that hurt
the drawing's intent or readability, and **propose at most 3** ops from a typed subset. It never states reachability.
Every proposal is clamped, applied in a sandbox and verified before it appears as an optional "Designer's note" card.
Probe C measured 15/18 sensible additions with 1 level-breaking one, which validation caught [M-C].

```python
class Veto(BaseModel):          edit: str; why_for_kid: str
class PCoinArc(BaseModel):      op: Literal["add_coin_arc"]; action: str
class PEnemy(BaseModel):        op: Literal["add_enemy"]; arch: Literal["walker","hopper","flyer","shooter","chaser","crusher"]; surface: str; x: int
class PSpikes(BaseModel):       op: Literal["add_spikes"]; surface: str; x0: int; x1: int
class PCrumble(BaseModel):      op: Literal["make_crumble"]; target: str
class PTune(BaseModel):         op: Literal["tune"]; target: str; param: Literal["speed","period","range"]; direction: Literal["up","down"]
class PCheckpoint(BaseModel):   op: Literal["add_checkpoint"]; surface: str; x: int
class PBigCoin(BaseModel):      op: Literal["add_big_coin"]; x: int; y: int
Proposal = Annotated[PCoinArc | PEnemy | PSpikes | PCrumble | PTune | PCheckpoint | PBigCoin, Field(discriminator="op")]
class TasteReview(BaseModel):
    vetoes: list[Veto]
    proposals: list[Proposal]       # sanitizer keeps the first 3 valid
    designer_note: str              # one sentence for the kid
```

Effort `low` by default. Probe C's medium effort took 28.8 s p50 [M-C], over the 25 s budget, so phase P0's benchmark
gate decides: keep low if its golden-set veto agreement is within 10% of medium. Settings: `timeout=35`,
`max_retries=1`, never blocking. The deterministic polished build is already playable at about 1 s.

---

## 9. A + D. The explainable change list and the preview

### 9.1 Layout (`web/src/screens2/preview/`)

```
┌──────────────────────────────── stage (Phaser, playable, overlays IN-scene) ─────────────────────────────┐
│  [minimap ▭▭▭▭]                          ⏱ 00:00.00  ● 0/12  ○○○  ✖ 0                                  │
│   cleaned ink level; hover/tap an object → highlight + its report row; ghosts for before/after         │
└────────────────────────────────────────────────────────────────────────────────────────────────────────┘
 Dial: ( Faithful | ●Polished | Challenging ▾Normal )    Difficulty ▮▮▮▯▯ 34 · "≈0.4 deaths per try (Normal)"
 ┌ What I saw ──────────────┐ ┌ What I changed (7) ───────────────┐ ┌ How it plays ─────────────────────┐
 │ 🟫 Ground · 3 pieces      │ │ ✓ Tidied 9 wobbly lines  ▸         │ │ ▶ Watch the bot (24.6 s)          │
 │ ▲ Spikes on ground, up    │ │ ✓ Flag pole is scenery; goal = flag│ │ Par 32.0 s · 2 checkpoints        │
 │ 👾 Monster (walks) on top │ │ ✓ Spikes snapped onto the ledge    │ │ ⚠ Jump at screen 2 is tight (5 f) │
 │ 🏁 Flag = goal            │ │ ✓ Ledge moved 2 down so you can    │ │   [Fix it]                        │
 │ ● 4 coins (1 was a tap)   │ │   reach it (was 6 rows, max 4)  ↺  │ │ ⓘ Spikes at the top nobody meets  │
 │ 🌳 Tree · scenery  [≠]    │ │ ✎ Added checkpoint after the pit ↺ │ │                                   │
 │ ✍ "jump!" (your note)     │ │ ✎ Coin arc shows the run-up    ↺  │ │ Designer's notes (2)  …loading    │
 │ ? 1 thing I'm unsure of   │ │ [Undo all changes]                 │ │                                   │
 └──────────────────────────┘ └────────────────────────────────────┘ └───────────────────────────────────┘
 [Back to drawing]                                   [Play test]                      [Publish ▸] (enabled)
```

On phones the three panels become tabs under the stage.

### 9.2 Behaviour

- **Rows come from `EditRecord`s**, grouped by `group` (the normalizers collapse into one expandable row). Text comes
  from `shared/messages/en.json` via `reason.code` + `args`. Raw codes are never shown [V-4].
- **Accept / undo** toggles `accepted` and replays (`applyEdits`, < 50 ms for 3 screens). Dependents are greyed with
  "no longer applies" (`stale`). Each row shows its verdict chip after the replay ("still beatable ✓"; "unbeatable
  without this ✗"). Undo is always allowed. **Publish** is blocked while the level is unsolvable or has hard flags,
  with the reason in plain words.
- **Before/after ghost**: hovering or tapping a row draws the pre-edit geometry as a pale dashed outline in the scene
  (the overlay is a Phaser layer, so it moves with sprites; v1 used a separate static canvas [V-4]).
- **What I saw**: one row per object family with a stroke thumbnail, its role and relation in words. A `[≠]`
  re-label menu offers `alt` roles first. Uncertain objects (conf < 0.75) are listed under "? I'm unsure of", and
  answering emits a P1 edit. Ink treated as noise is listed as a count ("ignored 3 specks"), never hidden [B-F7].
- **Questions** from the model or the validator ("Which door does this key open?") appear as cards: tap the door to
  answer (P4).
- **How it plays**: the bot's fastest run as a ghost (input replay through `stepWorld`), the flags with [Fix it]
  (the flag's suggested edit), par, checkpoints and the difficulty meter with a per-screen sparkline of E_s.
- **Streaming states**: "Tidying your lines…" (≤ 0.5 s), then "Playable!" (faithful), then "Polishing…" (polished
  rows animate in), then "Reading your writing…" (only if semantics was requested; a progress shimmer on text rows),
  then "Designer is looking…" (taste review).

### 9.3 Message table (excerpt of `shared/messages/en.json`)

| Code | Text |
|---|---|
| `pole_scenery` | Your flag pole is scenery now, so it doesn't block the way. Touch the flag to win. |
| `goal_grounded` | Your flag was floating, so I stood it on the ground below ({cells} down). |
| `spikes_snapped` | These spikes were hovering, so I stuck them onto the {host_name}, pointing {facing}. |
| `ledge_nudged` | This ledge was {rise} rows up. The highest jump is {max}. I moved it {dy} down. |
| `gap_nudged` | This jump was {gap} cells. The longest run jump is {max}. I moved this ledge {dx} closer. |
| `oneway_platform` | Thin floating lines are jump-through platforms, so you can jump up through them. |
| `spawn_moved` | You started right next to spikes, so I moved your start {cells} cells to safety. |
| `text_kept` | "{text}" is your note. It's drawn in the level but you can't stand on it. |
| `tap_coin` | That small blue dot is a coin. |
| `checkpoint_added` | I added a checkpoint after the hard part so you don't have to replay {seconds} s. |
| `coin_arc` | Coins show the jump. Run (hold {run_key}) before this gap. |
| `tight_window` | This jump is very tight ({frames} frames). Most players will fall here. |
| `unsolvable_gap` | I couldn't find a way across this {gap}-cell gap without moving your drawing more than 3 cells. |
| `entity_error` | Something I built doesn't work: the {thing} near {where}. I turned it off. |

---

## 10. Latency, progressive delivery, fallbacks and cost

### 10.1 Latency budget

Canvas path (kernel in the browser; laptop / mid-range phone):

| Step | Laptop p50 | Phone p90 |
|---|---|---|
| perceive (live while drawing) | 20 ms | 80 ms |
| normalize + realize | 30 ms | 120 ms |
| faithful playtest (3 screens) | 150 ms | 600 ms |
| repair search (only when needed) | 300 ms | 1.5 s |
| ink textures (renderer) | 150 ms | 500 ms |
| **faithful playable** | **≈ 0.4 s** | **≤ 2.5 s** |
| design (polished) | 400 ms | 1.8 s |
| **polished shown** | **≈ 0.9 s** | **≤ 4.5 s** |
| semantics (only if needed), parallel | 6-9 s (P0 gate p50 ≤ 9 s) | hard cap 14 s |
| taste notes, parallel | 12-20 s | hard cap 35 s |

Paper adds about 0.3-1.5 s of upload (2400 px JPEG, about 600 KB), 0.4 s rectify + segment and ≤ 0.5 s vectorize per
sheet on the server. That gives faithful at about 2.5 s p50 and ≤ 5 s p90, well inside the 8 s budget, and polished
at about 3 s. A phone that scores over 150 ms on a 20-solve startup micro-benchmark asks the server to build instead
(`POST /api/v2/build`), which takes about 0.6 s on the sidecar.

**Why the faithful build is not blocked by the model.** M-lat measured about 12 s for perception at low effort and
about 70 s for an A→B→C chain. In v2, perception is deterministic, so the model's only first-build role, semantics,
runs in parallel and patches the level when it lands. The P0 benchmark (17.4) measures the reduced semantic call on the
golden set. Its smaller output (answers for uncertain glyphs only, about 300-800 tokens) is expected to cut latency
below Probe A's 1.2k-token outputs; if p50 > 9 s, the payload is trimmed (crop to asked glyphs). Disabling thinking at
low effort is allowed on Opus 5 at effort ≤ high, but the migration guide recommends low effort with thinking on, so
it is only a measured fallback.

### 10.2 Fallback matrix

| Condition | Faithful | Polished | Semantics | Taste | Publish |
|---|---|---|---|---|---|
| All online | ✓ | ✓ | ✓ | ✓ | ✓ after server verification |
| Model timeout / error | ✓ | ✓ | grammar roles + parser; "type it" box for handwriting | hidden | ✓ |
| Model refusal | ✓ | ✓ | as above | hidden | private only until moderation passes (`safety: unknown`) |
| No network (canvas) | ✓ (browser kernel) | ✓ | parser only | hidden | queued; saved locally (IndexedDB draft) |
| Node sidecar down | ✓ (browser) | ✓ | ✓ | ✓ (facts sent by the client) | stored with `verified: false`; re-verified when the sidecar returns; hidden from leaderboards until then |
| Kernel exception in the browser | server build fallback | server | ✓ | ✓ | ✓ |

### 10.3 Cost per scan (Opus 5: $5 / M input, $25 / M output; thinking billed as output)

| Call | When | Input tokens | Output tokens | $ per call |
|---|---|---|---|---|
| Semantics, low | paper with handwriting or uncertain glyphs; canvas with unbindable text | ≈ 1.7k image + 1.1k table + 0.9k system ≈ 3.7k | 0.4-1.0k | **0.03-0.045** |
| Taste review, low | every polished/challenging preview when online (debounced 3 s after the last dial change) | ≈ 1.7k render + 1.5k JSON + 0.9k ≈ 4.1k | 1.0-2.0k | **0.045-0.07** |
| Arbitration / repair planner, medium | rare (ties or no in-bounds fix) | ≈ 5.5k (images + facts) | ≈ 2.0k | ≈ 0.08 [M-B $0.078] |
| Prompt-to-level, low | per prompt | ≈ 2.4k | ≈ 0.9k | ≈ 0.036 [M-D] |
| Publish moderation, low | canvas level published without a semantics call | ≈ 2.5k | ≈ 0.2k | ≈ 0.018 |

Typical totals: a canvas level drawn with stamps and chips costs $0.02 (moderation only) to $0.09 (with taste notes).
A paper level with handwriting costs about $0.08-0.12. v1 spent $0.041 per scan on an interpretation that broke the
level [M-v1]. A daily budget guard (`DAL_MODEL_BUDGET_USD`, default 5) switches the taste review off first.

---

## 11. B. Gameplay: Mario-grade feel and real threats

### 11.1 Player physics (`shared/kernel/physics/profiles.ts`)

The v2 numbers are the gameplay diagnosis's verified envelope [G-§7.1, `proposed_physics.py`]. CELL = 16 px and the
12x28 px body are unchanged, so drawing scale is unchanged.

| Constant | `v2` (preset classic) | `v1` (migrated levels) |
|---|---|---|
| Walk max speed | 96 px/s (6 c/s) | 160 (instant) |
| Run max speed | 168 px/s (10.5 c/s), hold Run or auto-run | 160 |
| Ground acceleration | 1000 px/s² up to walk speed, then 300 up to run speed | instant |
| Friction (no input) / skid (reversing) | 1400 / 2400 px/s² | instant |
| Air acceleration | 65% of ground; no drag with a direction held; 200 px/s² drag without input | instant, full |
| Jump launch | vy = −(340 + 0.25·\|vx\|) | −330 |
| Gravity | 900 rising with jump held; ×0.5 at the apex (\|vy\| < 40, held); 1700 otherwise | 900 |
| Release cut | vy := max(vy, −220) | −120 |
| Max fall / fast-fall (Down) | 330 / 450 px/s | 1200 |
| Coyote / buffer | 6 frames (100 ms) / 7 frames (120 ms) | 5 / 6 frames |
| Corner correction | 4 px sideways on a ceiling-corner bonk; 3 px up on a ledge graze | none |
| Stomp bounce | vy −280, −380 with jump held; 4-frame hit-stop | n/a |
| Spring | vy = −600 × strength (0.5-2.0); side spring vx ±300 | −600 × strength |
| Double jump (ability) | vy = −300 once per airtime (adds about 3 cells) | n/a |

Envelope (from `proposed_physics_results.md`; a kernel test asserts it within 0.1 cell):

| Takeoff | Max height | Max distance | Tap hop |
|---|---|---|---|
| Standing | 3.86 cells (clears a 3-cell wall) | n/a | 1.12 |
| Walking 6 c/s | 4.45 cells (clears 4) | 4.9 cells (clears a 4-cell gap) | 1.14 |
| Running 10.5 c/s | 4.92 cells | 9.1 cells (clears an 8-cell gap) | 1.16 |

Derived design facts the designer and messages use: reaching full run speed from rest takes 2.27 cells of runway
(4.6 px to walk speed at 1000 px/s², then 31.7 px to run speed at 300 px/s²), so **a run-gap needs ≥ 3 cells of
runway**. Gaps of 1-4 cells are walk gaps and 5-8 are run gaps; this split is the new core skill [G-R1]. Presets
scale within bounds: *gentle* (gravity ×0.9, walk 88, run 150, coyote 8 f), *zippy* (walk 104, run 184, run accel
400). The solver always reads the resolved numbers stored in `level.physics.rules`.

### 11.2 Controls

| Action | Keyboard | Touch |
|---|---|---|
| Move | ←/→ or A/D | left and right pads |
| Run | hold Z, X or Shift | auto-run after holding a direction 0.35 s (`run_mode: auto`), or a Run pad (`button`) |
| Jump (variable) | Space, ↑, W | Jump pad |
| Fast-fall / drop through a one-way | ↓ / ↓ + Jump | swipe down on the left pad |
| Restart / pause | R / Esc | HUD buttons |

### 11.3 Damage, stomps, lives, respawn

- **One-hit model** (Mario small, Celeste): touching a hazard hitbox, an enemy's side or bottom, a projectile, or
  falling below the world kills.
- **Stomp**: if the player's vy > 0 and the player's bottom on the previous frame was ≤ the enemy top + 4 px, the
  enemy is defeated (puff, 4-frame hit-stop, a bounce of −280 or −380 with jump held). Chains of stomps are a skill.
  Crushers and projectiles cannot be stomped; a crusher's top is safe to stand on.
- **Respawn**: a 4-frame hit-stop, a 400 ms ink-splat, then the player respawns at the last checkpoint. Stomped
  enemies and crumble platforms reset, the global entity clock keeps running, and collected coins stay collected for
  this attempt. That is about 0.75 s in total, versus v1's 300 ms that made death meaningless [G-R5].
- **Lives** (GameRules): `0` = off (default; a death counter is shown with pride, Celeste-style) or 3/5. At 0 lives
  the level restarts from the start with its coins reset. `coins_per_life` 50 or 100 grants +1.

### 11.4 Enemies: six archetypes, all with gravity unless they fly

Fixes "enemies hover in mid-air" [B-F9, G-R3, V-6]. Every enemy is a kernel entity with an AABB from N11, its drawn
art and a 2-frame waddle (13.4). Default parameters are bold.

| Archetype | Behaviour | Params (range, **default**) | Stompable | From a drawing |
|---|---|---|---|---|
| `walker` | walks, turns at walls; with `ledge_aware` it turns at ledges | speed 1-4 c/s (**2**), ledge_aware (**true** on platforms, false on ground) | yes | red creature + "walks", or an arrow; default for a drawn enemy on a surface |
| `hopper` | hops in place or forward every period | period 1.0-3.0 s (**1.6**), height 1-3 cells (**2**), forward 0-2 cells (**0**) | yes | "jumps", "hops" |
| `flyer` | sine path, no gravity | amplitude 0-3 cells (**1.5**), period 1.5-4 s (**2.5**), range ≤ 12 cells (**6**) | yes | a red creature drawn in the air with no host below, or "flies" |
| `shooter` | stationary; fires a slow ink ball in its facing direction | period 1.5-4 s (**2.5**), ball speed 3-6 c/s (**4**) | yes | "shoots", or a red creature with an arrow pointing away |
| `chaser` | walks toward the player when within sight and \|dy\| ≤ 3 | speed 2-4.5 c/s (**3**, below walk speed), sight 4-10 cells (**8**) | yes | "chases" |
| `crusher` | waits overhead; drops when the player is within 1.5 cells below, rises slowly | fall 20 c/s (fixed), rise 1-3 c/s (**2**), wait 0.4-1.2 s (**0.6**) | no (top is safe) | a red creature hanging under a ceiling, or "crushes", "falls" |

A drawn monster with no rule is a **static enemy** (walker with speed 0) in Faithful, and a walker at speed 2 when the
dial is Polished or above and the creature has a host surface ≥ 4 cells long. The change list shows this as a D5 edit
that can be undone.

### 11.5 Hazards and platforms

| Type | Source | Params (range, **default**) | Notes |
|---|---|---|---|
| Spikes | red zigzag or flat red line (S7, S8) | facing derived from the host; length ≥ 1 cell | 6 px hitbox band, 10 px art; oriented by surface [B-F5] |
| Lava | red in a pit (S9) or the Lava stamp | animated surface | hitbox 4 px below the visual top |
| Rising lava | rule `lava rises`, Challenging-Hard | 0.3-2 c/s (**0.6**), delay 2-10 s (**3**) | resets at checkpoints; the camera shows the lava line |
| Saw | Saw stamp, red circle with an arrow, D11 | radius 0.75-1.5 (**1**), speed 1-6 c/s (**3**), path ≤ 8 cells, `static` allowed | circle hitbox r − 3 px |
| Firebar | stamp, D11 | 3-6 balls (**4**), 60-180°/s (**90**), phase | per-ball circle hitbox r 5 px; sine table (7.1) |
| One-way platform | thin floating stroke (N6) | n/a | Down + Jump drops through; art shows underside ticks |
| Crumble | rule `crumbles`, D12 | delay 0.3-1.0 s (**0.5**), respawn 2-5 s (**3**) | shakes for the delay; reset on respawn |
| Spring | rule `bouncy`, Spring stamp | strength 0.5-2.0 (**1.0**), dir up/left/right | up: ≈ 12.5 cells at strength 1 |
| Moving platform | rule `moves`, arrow (S14) | speed 1-6 c/s (**2**), path 1-20 cells, pingpong/loop | carries the player; path ≥ 1 cell (validator) [V-1] |
| Door + key | rule, S18 + question | n/a | the door is a solid thing removed on `collect:key` |

### 11.6 Checkpoints

Drawn checkpoints come from a stamp, a small green flag that is not the rightmost, or the rule "checkpoint". Designer
checkpoints come from 8.4. Touching one sets the respawn point (unfurl animation and sound). Fairness: there must be no
hazard within 2 cells of a checkpoint (`spawn_danger`).

### 11.7 Scoring, timers, medals

- **Speedrun timer always on**: `mm:ss.cc`, counted in kernel frames (time = frames / 60) so a time is replayable and
  verifiable (14.4). Shown in the HUD and on the results card [G-R5].
- **Coins** count toward medals and lives (if on). **Big coins** (3 per level max): ○○○ in the HUD.
- **Medals per level**: Clear, All coins (including big coins), Par (≤ `design.par_ms`), Flawless (0 deaths). They are
  shown on the level card and in the feed.
- **Countdown timer**: only from a text rule ("60 seconds") or D13 (1.2-2.0 × the bot's fastest), never the 11-15x
  slack v1 had [G-§3].
- **Difficulty badge**: score 0-100 from C (7.3), plus community stats once there are 20+ attempts (empirical deaths
  per attempt per segment, used to calibrate σ per game).

---

## 12. C. Scrolling levels

### 12.1 World

`world.w = 48 · screens` (1 to 6, up to 288 cells), `world.h = 27`. Since the viewport is 48x27 cells (768x432 world
px, the v1 drawing scale), the full height is always visible, falls are always readable, and the camera moves only
horizontally. Six screens is about SMB 1-1 length in player-height units [G-§7.3]. Taller levels are deferred (v2.x).

### 12.2 Camera (`shared/kernel/camera.ts`, part of the world state)

- Target x = player x + look-ahead, where look-ahead is 6 cells in the facing direction while \|vx\| > 0.5 × walk
  speed and decays to 0 otherwise. The camera eases toward it with lerp 0.1 per frame.
- Dead zone: 4 cells wide around the target. Clamp to [0, world.w − 48] cells.
- No vertical movement (h = 27).
- Optional rule "no going back": the camera never scrolls left past the last checkpoint.

Because the camera is in the kernel, the solver's `blind_jump` check runs the same camera on the bot's actual input
trace. With look-ahead 6 and dead zone 4, at least 22 cells ahead are visible while moving, so every run jump
(≤ 9.1 cells) lands on screen [G-§7.3].

### 12.3 Long canvas editor (`web/src/editor/`)

| Feature | Spec |
|---|---|
| Surface | vector strokes on an infinite-feeling strip of 48·k × 27 cells; dot grid every cell; dashed screen boundaries labelled 1..k |
| Navigation | two-finger pan, space-drag, middle-drag, wheel / trackpad horizontal scroll; pinch or Ctrl-wheel zoom 0.5-3x; "fit screen" button |
| Screens | "+ add screen" at the right edge (≤ 6); delete the last empty screen; minimap strip with the viewport box |
| Brush | 13 px marker (0.8 cell), pressure ±20%; **tap = 1-cell dot**; hold still 400 ms at the end of a stroke = straighten (if the residual < 0.4 cell); optional row snap (toggle) |
| Tools | ink colours with icons (ground, spikes, goal, coin); stamps (coin, spikes, enemy archetypes, spring, checkpoint, saw, door, key, start, library objects); select / move / delete / re-colour; eraser deletes whole strokes or splits them; undo/redo of stroke operations (unlimited) |
| Live understanding | `perceive()` on stroke end: a role chip under each glyph ("ground", "spikes ↑", "coin", "? unsure"); reach halo from the start (reachable surfaces tinted after a 300 ms debounced playtest); a red dashed span over gaps wider than `g_max(runway)` with the label "too far (9 > 8)" |
| Rules | tap a stroke, then "What does it do?" opens a chip picker (moves ↔ N cells, walks / hops / flies / shoots / chases / crushes, bouncy, crumbles, checkpoint, door + key link); free text as a fallback goes to the parser and the model |
| Character | its own panel with its own palette (fixes the shared colour [V-5]); onion-skin of the 12x28 body box; a live mini-stage running the rig; "save to library" |

### 12.4 Multi-sheet paper

- **QR grammar v2**: `dal2|<kind>|<id>|<n>/<k>`, kind ∈ `new` (blank set; id = set id minted at print time),
  `game` (add a level to a game), `lvl` (remix of a level), `rules`, `lib`. Regex
  `^dal2\|(new|game|lvl|rules|lib)\|[A-Za-z0-9_-]+\|[1-6]/[1-6]$`. v1 `dal1|...` payloads are still read as a single
  sheet.
- **Template v2** (`template_spec.json` version 2; the drawing area is unchanged at 240x135 mm = 48x27 cells): the
  header shows "Sheet n of k". **Seam marks**: the left and right edges of the drawing area carry the row numbers 3, 6,
  9, ..., 24 in gray, so a child continues the ground "at mark 21" on the next sheet. Remix and continuation prints
  also show the previous sheet's terrain ending heights as gray dashes in the first cell column.
- **Scan**: `POST /api/v2/scans` accepts 1-6 photos in any order. Each is rectified (v1 ArUco), its QR read and its
  sheet index used for x offset 48·(n−1). Duplicate indexes: the latest photo wins. A missing sheet becomes an empty
  screen with the warning "Sheet 2 of 3 is missing: scan it or continue without it". Mixed set ids are an error.
- **Seams**: N10 joins strokes that end within 0.75 cell of a seam on both sides with Δy ≤ 1 cell; otherwise the gap
  is real.

### 12.5 Remix across sheets

A remix print is k sheets with the parent's ink in gray (#B0B0B0, the v1 background class) and QR
`dal2|lvl|<parent>|n/k`. The child scans any subset; unscanned sheets inherit the parent unchanged. New ink on sheet n
is added to the parent's `StrokeDoc` at screen n, so the child's level is parent strokes + child strokes, rebuilt
through the same pipeline. Re-traced parent objects (a child colouring over a gray coin) are removed by N9 `dedupe`,
which fixes "remix by re-scanning duplicates coins" (section 16). Remix on screen loads the parent's strokes locked in
gray; unlocking allows deleting or moving them.

### 12.6 Rendering long worlds

Ink textures are chunked at 1024 world px (5 chunks for 6 screens) at the render scale; only chunks overlapping the
camera ±1 are resident (LRU of 4). Entities are culled 4 cells outside the camera but still simulated (determinism).
Memory budget on a phone at render scale 2: 4 chunks × 2048×864 × 4 B ≈ 28 MB.

---

## 13. D. Visual quality: how a drawing becomes beautiful game art

### 13.1 One renderer (`shared/kernel/art/` builds, `web/src/game2/render/` draws)

`renderArt(level, scene, opts) → ArtDoc` is pure data: layers of paths with style ids, seeded so it is deterministic.
The web rasterizes ArtDoc to Canvas2D per chunk (`canvasInk.ts`) for play, preview, thumbnails and seeded levels. Node
serializes the same ArtDoc to SVG (`svgInk.ts`) for golden snapshots and the public spec's reference images. One
renderer replaces v1's three styles: flat seed blocks, procedural doodles and the raw photo [V-8].

| Layer (back to front) | Content | Style |
|---|---|---|
| paper | theme texture: fBm grain tile 512², 1-cell dot grid at 6% opacity, vignette | per theme (13.6) |
| parallax far (scroll 0.25) | seeded pencil hills | 1.2 px pencil, 18% opacity |
| parallax mid (scroll 0.5) | seeded clouds and bushes | 25% opacity |
| sketch (off in play, on in preview "Compare") | the original photo or canvas raster | 12% opacity, linear filtered |
| decoration and text | the kid's strokes, cleaned: RDP 0.05 cell + Chaikin ×2 | kid's colours mapped to the theme palette, 85% (text 60%) |
| terrain | **drawn from the realized collision**: top edge exactly on the collision edge; ground mass as 45° hatching (6 px spacing, 1.2 px, 30%); one-way platforms with small underside ticks every 2 cells | marker 4.5 px, round caps; width ±12% following the kid's original stroke's width profile; ≤ 0.8 px seeded wobble on the lower edge only |
| hazards | spike triangles (16 px base, 10 px tall) facing away from the host; lava with a wavy top | red fill + 1.5 px ink outline |
| things | kid-drawn enemies, goal flag, coins and keys rendered from their own cleaned strokes (never a dilated bitmap crop [B-F15]); default doodles only when nothing was drawn | as drawn |
| designer ink | everything with origin repair-add or designer | violet `#6C4BD8`, dashed 4/3, a small pencil glyph on the first; legend toggle "show designer marks" |
| foreground (scroll 1.0) | grass tufts along ground tops (in front of the player's feet by 4 px), occasional ink splats | seeded |

Because the art is rendered from geometry, there is no backdrop to whiten, no erase artefacts, and nothing drawn twice
[B-F14, V-8]. The drawn line top and the standing surface coincide to 0 px [B-F13].

### 13.2 Rendering configuration (fixes crunchy art [V-3, B-F16])

`pixelArt: false`, `antialias: true`, `roundPixels: false`. Game size = 768·S × 432·S, where
S = clamp(ceil(cssWidth · devicePixelRatio / 768 · 2) / 2, 1, 3), and the main camera zoom = S. Ink textures are
generated at S, so strokes are drawn at native device resolution. Physics remains in world px. Kid-drawn PNG sprites
(paper characters) use linear filtering with mipmaps.

### 13.3 Line boil and life

A `BoilFX` PostFX pipeline on the ink camera displaces texture UVs by a noise texture × 0.6 world px. The noise offset
switches between 3 seeds every 100 ms, giving the classic 10 fps hand-animation boil [V-§4a-3] at the cost of one
shader pass and no extra textures. It is off under `prefers-reduced-motion` and in the Canvas renderer.

### 13.4 Animating a sprite from one drawing (`web/src/game2/rig.ts`)

| Element | Method |
|---|---|
| Body split | hip line at 70% of the glyph height |
| Legs | if ≥ 2 stroke endpoints in the bottom 30% point downward (within 30° of vertical), those stroke groups are legs and swing ±18° about their top endpoints, alternating, at a step rate of \|vx\| / 1.25 cells per second; otherwise two synthesized stick legs (v1's look) |
| Squash and stretch | anticipation (1.15, 0.85) for 3 frames → rising (0.88, 1.12) → apex (1, 1) → landing (1.2, 0.8) easing back over 6 frames, scaled by fall speed |
| Walk wobble | rotation ±3° and a 1 px bob at the step rate; lean ±6° by vx / run speed |
| Idle | breathing scaleY 1.00-1.03 at 0.6 Hz; blink every 2.5-5 s for 120 ms, where eyes are small dark closed parts in the upper half (an ink line over each) |
| Paper (PNG) characters | a 4x4 Phaser Mesh grid for bend and squash; synthesized legs |
| Enemies | the same rig, a 2-frame waddle ±5°, a red tint pulse when the player is within 4 cells |

### 13.5 Particles, hit-stop, shake

| Event | Effect |
|---|---|
| Land | 6 dust puffs, 250 ms, scaled by fall speed |
| Skid / turn | 3 puffs at the feet |
| Coin | 8-point sparkle + the coin flies to the HUD counter in 400 ms |
| Stomp | 10-puff ring + 4-frame hit-stop + 2 px / 80 ms shake |
| Death | ink splat: the character breaks into 16 stroke shards (400 ms), then they reassemble at the checkpoint (300 ms); 6 px / 250 ms shake |
| Spring | 2 expanding ink rings |
| Checkpoint | flag unfurl + 12 sparkles |
| Crumble | 8 falling ink crumbs |
| Win | 60 scribble confetti + flag wave + jingle |

### 13.6 Themes (GameRules)

| Theme | Paper | Ink palette (black / red / green / blue) |
|---|---|---|
| paper | cream `#FBF7EE`, grain | `#1F1B16` / `#E04436` / `#3E9B4F` / `#2C7BE5` |
| chalk | slate `#2E3A3F` | `#F2F2EC` / `#FF8A80` / `#B9F6CA` / `#82B1FF` |
| blueprint | blue `#1E4E8C`, grid | `#FFFFFF` / `#FFB4A2` / `#C6F6D5` / `#BEE3F8` |
| crayon | white, heavy tooth | waxy wider strokes, same hues |
| night | navy `#121A2E` | glowing ink (additive outer glow 2 px) |

### 13.7 Sound (`web/src/game2/audio/synth.ts`, WebAudio, no assets)

| Sound | Recipe |
|---|---|
| Jump | square 260 → 520 Hz exponential sweep, 90 ms, gain 0.18 |
| Land | white noise, lowpass 600 Hz, 50 ms, gain scaled by fall speed |
| Coin | triangle 988 Hz 60 ms → 1319 Hz 120 ms; +1 semitone per coin within 0.6 s (max +12) |
| Big coin | C6 E6 G6 C7 arpeggio, 60 ms each + shimmer |
| Stomp | square 200 → 80 Hz 120 ms + noise click |
| Death | sawtooth 440 → 110 Hz 400 ms + noise 200 ms |
| Spring | FM "boing": carrier 180 Hz, modulator 90 Hz, index 6 → 0 over 250 ms |
| Checkpoint | triangle 660 → 880 Hz, 2 notes |
| Crumble | bandpass noise 1.2 kHz crackle, 300 ms |
| Win | G5 C6 E6 G6 at 120 ms each, the last held 400 ms |
| Music (optional) | a seeded 4-bar loop per theme: triangle bass + square arpeggio at 100 bpm |

Master gain 0.6; a mute toggle is persisted in localStorage; the AudioContext resumes on the first input. v1 had
`noAudio: true` [G-R8].

### 13.8 HUD and the win moment

The HUD sits on a paper plate with a hand-lettered font (Patrick Hand, bundled as woff2 under the OFL so it works
offline): time, coins, big coins, deaths, and a minimap for levels longer than 1 screen. **One win moment**: canvas
confetti + flag + jingle, then the HTML results card (time, PB, medals, coins, deaths, "Watch my run" ghost,
"Beat my level" share, Next level, Remix). `Hud.showBanner` is deleted, which fixes the duplicate banner [V-9].

---

## 14. E. Platform extensions

### 14.1 Object library per game

**Create** (`#/game/:id/library/new`, or the paper library sheet): draw the creature (vector strokes), name it, pick
what it is (enemy, collectible, platform, hazard, decoration, spring), pick its behaviour from the fixed vocabulary
(archetype chips plus sliders bounded by 11.4 and 11.5), and choose how it is placed on paper: **draw its symbol 3
times** (registered samples) or "write its name". A mini-stage previews it running.

**Storage**: table `object_types(id, game_id, version, json, author, created_at)`. Versions are immutable. A level
references `{type_id, version}`, so editing a type never silently changes published levels. "Update levels to v3"
rebuilds and re-verifies them explicitly.

**Placement**:

| Path | Mechanism | Deterministic? |
|---|---|---|
| Canvas | the type appears as a stamp in the palette; placing it writes a stroke with `lib = type_id` | yes |
| Paper: symbol | grammar S20: normalize the glyph to 32x32 (aspect kept), compare to the samples by chamfer distance on rendered skeletons; ≤ 0.12 cell and same ink → match (conf 0.80) | yes |
| Paper: name | write the name next to any blob; the semantic pass returns `RuleLibrary{target, name}`, matched case-insensitively to the library | model |

The placed object takes its position and size from the drawn blob, or the stamp default, and its art, behaviour and
params from the type. The kernel receives the library via `BuildInput.library`.

**Library sheet** (`GET /api/v2/templates/library.pdf?game=…`, QR `dal2|lib|<game>|1/1`): boxes for "draw your
creature", "its name", "what it does" (9 checkboxes) and "draw its symbol 3 times". Checkboxes are read by OMR: ink
covering > 15% of a box ticks it, and two ticks in one group ask the creator. The name is read by the model or typed
after the scan.

### 14.2 Game rules sheet

`GameRules` (3.5) applies to every level of a game. Edit it in `#/game/:id/rules`, or print the rules sheet (QR
`dal2|rules|<game>|1/1`). Its checkbox groups are physics preset (gentle, classic, zippy), abilities (run, double jump,
stomp, fast-fall), lives (off, 3, 5), theme (5), music (on, off), default dial and timer (off, auto). It is scanned
deterministically by OMR. Each level stores the **resolved** numbers in `level.physics.rules`, so a published level is
self-contained and its speedruns stay valid. Changing the game rules applies to new builds; "Apply to all levels"
rebuilds and re-verifies each one and lists any that would become unsolvable before committing. The solver honours
abilities: double jump adds air actions, and `stomp: false` removes stomp actions.

### 14.3 Prompt to level

Flow: text → model `LevelPlan` (beats) → `kernel.generate(plan, seed)` → `StrokeDoc` (pencil-style strokes with seeded
wobble, so it looks hand-drawn) → `build` → `design` to the requested band → verified → opened in the canvas editor as
a draft you draw over. Generated strokes carry `label` roles (conf 1.0), so perception of a generated draft is exact. Probe D built 5/5 solvable skeletons from free rectangles but designed at the physics limits and
could not be timing-checked [M-D]. Here the model chooses **pacing and content** from a fixed beat vocabulary, and code
chooses exact geometry and proves it.

| Beat | Params (bounds) | Width (cells) |
|---|---|---|
| `flat` | length 3-16; enemy none/walker/hopper/chaser; coins 0-5; spikes none/middle/far_end | length |
| `gap` | width 1-8; floor void/spikes/lava (runway ≥ 3 enforced when width ≥ 5) | width |
| `step` | rise −4..4 rows; length 3-10 | length |
| `stairs` | n 2-6; rise 1-2; run 1-3 | n·run |
| `pillars` | n 2-6; spacing 2-6; hazard void/spikes/lava | n·(1+spacing) |
| `floaters` | n 2-5; dy −3..3; spacing 2-5; oneway | n·(3+spacing) |
| `ceiling` | length 6-12; spikes; headroom 3-5 | length |
| `wall` | height 2-4; spikes none/near_face | 2 |
| `moving_bridge` | gap 6-16; speed slow/normal/fast; vertical | gap |
| `crumble_run` | n 2-5; floor void/shallow | 3·n |
| `saw_corridor` | length 8-16; saws 1-3 | length |
| `tower` | tiers 2-5; rise 3-4; oneway | 10 |
| `enemy_gauntlet` | archetype; n 2-4 | 14 |
| `spring_up` | height 5-10 | 4 |
| `key`, `door` | key place high/guarded/alcove (the generator links the latest key to the next door) | 6 / 2 |
| `checkpoint`, `rest`, `goal` | rest length 3-6; goal style flag/staircase | 0 / length / 6-10 |

```python
class LevelPlan(BaseModel):
    title: str
    theme: Literal["paper","chalk","blueprint","crayon","night"]
    screens: int                                   # clamped 1-6
    band: Literal["easy","normal","hard"]
    sections: list[Section]                        # Section{name: str, beats: list[Beat]}; Beat is the union above
    kid_summary: str
```

The generator lays beats along a ground spine (default top row 22), tracks rises and falls, stretches `flat`/`rest` to
fill `48·screens` or trims them, and inserts checkpoints per 8.4. If the built level fails verification, a
deterministic fixer runs up to 3 times (shrink the failing beat's width or rise by 1, add a rest); then the model gets
one retry with the failure facts. Call: effort `low` (11.4 s, $0.036 in Probe D [M-D]), timeout 25 s. Offline, a
keyword planner (lava, key, tower, spikes, moving, easy/hard) picks one of 12 canned plans seeded by the text hash.

### 14.4 Speedruns, ghosts and "beat my level"

- The engine records an `InputLog` every attempt (5 bits per frame, run-length encoded; under 2 KB per minute).
- `POST /api/v2/runs {level_id, level_hash, log, claimed_frames, name}`: the sidecar's `verifyRun` replays the log
  through `stepWorld` from the start. It must touch the goal on exactly `claimed_frames`. Only verified runs are
  ranked. Runs against an older `level_hash` are archived when a level is republished. Rate limit: 30 runs per minute
  per IP; logs over 20 minutes are rejected; names pass a static blocklist.
- Leaderboards: top 10 verified per level plus your PB, and per-game totals.
- Ghosts: `GET /api/v2/runs/{id}` returns the log; the client replays it in a second kernel instance as a translucent
  sprite with no collisions.
- **Beat my level**: the results card's share button creates `#/challenge/<run_id>`. The level plays with that ghost
  and the result compares times and medals.

### 14.5 Format v2 as a public spec (and v1 migration)

| Artifact | Content | Licence |
|---|---|---|
| `shared/spec/level-format-v2.md` | coordinate system; StrokeDoc; LevelV2; collision codes and rasterization rules (6.1-6.2); physics profiles (11.1); entity semantics (11.3-11.5); rule and edit vocabularies; hashing; InputLog; versioning | CC0 |
| `shared/schema/*.json` | strokes, level, edits, rules, object type, input log | CC0 |
| `shared/kernel/` | reference implementation | MIT |
| `shared/conformance/` | 40 cases: StrokeDoc → expected collision hash, solvable, fastest frames; InputLog → expected end frame. An independent engine conforms if it reproduces the hashes and the replays | CC0 |

Versioning: `schema_version: 2`; `kernel_version` is semver; physics profiles are immutable by name (`v2` never
changes, a retune becomes `v2.1`). GitHub mirroring of `levels/<game>/<id>.json` plus strokes stays on the roadmap.

**Migration** (`shared/kernel/migrate/v1.ts`, driven by `vision/app/v2/migrate.py`):

| v1 | v2 |
|---|---|
| grid `1` runs | merged into surfaces (horizontal runs), walls (vertical stacks) and ground mass; emitted as `migrated` strokes so they remix in the v2 editor |
| grid `2` | spikes facing away from an adjacent solid cell (up if solid below), else a lava block |
| `player_start`, `goal`, `coin`, `checkpoint` | same things; goal grounded by N4 |
| `moving_platform` | terrain with `move` (zero-length paths dropped [V-1]) |
| `enemy` (patrol) | `walker`, speed = patrol speed, **gravity on**, grounded by N4 (fixes hovering) |
| `bounce_pad` / `key` / `door` | `spring` / `key` / `door` |
| rules | unchanged |
| physics | profile `v1` (instant acceleration, symmetric gravity), so old levels feel as they did |
| backdrop.png | kept as the sketch layer; the level is rendered by the new ink renderer |

`uv run --no-sync python -m app.v2.migrate --all` writes `levels.json_v2` beside v1 JSON, verifies each level and logs
failures. v1 endpoints keep serving v1 JSON until the P5 switch-over. The v1 Starter World becomes the game "Classic
Starter".

---

## 15. F. Starter World v2 (teach, test, twist, finale)

Five levels authored as **beat plans** (`shared/starter/L*.plan.json`), generated by the kernel, built at Faithful
plus hand-pinned overrides (`L*.overrides.json`, ordinary edits), and verified in CI against `shared/starter/expected.json`.
Ground top is row 22 unless noted, and the spawn is at x = 2. Each new mechanic is first met where a mistake is not
lethal (teach), then with real risk (test), then combined (twist), then in a finale [G-§5 principle 1].

| Level | Screens | Teaches | Target C (casual) | T_fast | T_casual |
|---|---|---|---|---|---|
| L1 First Run | 4 | run, jump, stomp | 0.10 ± 0.05 | 20-26 s | 40-55 s |
| L2 Spike Garden | 4 | oriented spikes, one-way platforms | 0.30 ± 0.08 | 24-32 s | 45-65 s |
| L3 Crumble Bridge | 5 | crumble, moving platforms, saws, flyers | 0.60 ± 0.12 | 30-40 s | 55-80 s |
| L4 Key Keep | 5 | key and door, chaser, crusher, shooter, firebar | 1.00 ± 0.20 | 35-45 s | 65-90 s |
| L5 Ink Storm (bonus) | 5 | rising lava + everything (Hard) | 1.80 ± 0.40 | 35-45 s | 80-120 s (bonus, exempt from the 90 s cap) |

v1's three levels measured 0.000 / 0.004 / 0.000 and 3.6-4.9 s [G-§3].

**L1 First Run**
| Screen | Beats | Purpose |
|---|---|---|
| 1 teach | rest 6 · step +2 (6) · gap 3 void · flat 8, coins 3 · step −2 (4) · flat 12 with a walker approaching, coin arc above it | jump; first enemy on safe flat ground, the coins hint the stomp |
| 2 teach | rest 4 (the runway, with a coin line) · gap 6 void · flat 6 · floaters n2 dy +3 oneway (big coin 1 above the second) · gap 4 void · flat 10 + walker | the run-gap; jump-through ledges |
| 3 test | stairs n3 rise 2 run 2 with a walker coming down · checkpoint · gap 7 void (big coin 2 at the run-jump apex) · flat 8 | run + stomp under pressure |
| 4 finale | enemy_gauntlet walker n3 on islands separated by 3-gaps (stomp chain) · stairs n4 rise 1 run 1 · goal flag (big coin 3 above the pole, reached by a full run jump off the top step) | the SMB staircase finale |

**L2 Spike Garden**
| Screen | Beats | Purpose |
|---|---|---|
| 1 teach | flat 8 · step +1 (3) with spikes on top (go around or over) · ceiling 10 with spikes, headroom 4 (don't jump here) · gap 4 floor spikes | spikes point away from their surface |
| 2 test | gap 4 spikes → landing 3 · flat 6 spikes far_end · wall 3 spikes near_face · floaters n3 oneway dy +2 · checkpoint | landings shrink; spiked faces |
| 3 twist | tower tiers 4 rise 3 oneway, spiked ceilings alternating sides · walker on the top tier · big coin in a spike-lined alcove | vertical reading |
| 4 finale | pillars n3 spacing 4 spikes · enemy_gauntlet hopper n2 · goal staircase | |

**L3 Crumble Bridge**
| Screen | Beats | Purpose |
|---|---|---|
| 1 teach | crumble_run n2 floor shallow (falling is safe) · rest 4 · crumble_run n3 floor void | crumble timing |
| 2 teach | moving_bridge gap 10 normal · moving_bridge vertical gap 6 to a ledge · checkpoint | ride and wait |
| 3 test | crumble_run n2 · saw_corridor 10 saws 1 · enemy_gauntlet flyer n2 | rhythm: crumble, crumble, saw window |
| 4 twist | moving_bridge gap 12 with a saw circling its path · crumble_run n3 · checkpoint | combine |
| 5 finale | a shooter on a tower firing across crumble_run n4 · goal staircase | |

**L4 Key Keep**
| Screen | Beats | Purpose |
|---|---|---|
| 1 teach | flat 14 with a chaser (slower than walk) · door (closed, visible) on a side path · floaters oneway up | the door blocks a path you can see |
| 2 test | crusher corridor (3 crushers, phase windows ≈ 20 f) · checkpoint | timing under threat |
| 3 twist | key (guarded) on a high ledge behind a firebar · gaps with spiked landings · shooter | the key is the reward for the hardest part |
| 4 test | moving_bridge gap 12 with a chaser following onto it · checkpoint | pursuit |
| 5 finale | door · stairs n4 with 2 crushers · goal | |

**L5 Ink Storm** (Hard showcase): rule `lava_rise 0.6 c/s @ 3 s` (resets at checkpoints), firebars, flyers and saws,
with a checkpoint every screen to keep F_s ≤ 30 s.

**Acceptance (checked by `npm run starter:verify`)**: each C within its tolerance; C strictly increasing L1 → L5;
0 hard flags; T_fast and T_casual inside the ranges; ≥ 1 engaged enemy in L2-L5 (removing it lowers the route's E by
≥ 0.02); the first encounter with each mechanic has lethal share 0 (teach); E of the last segment ≥ E of the first
segment in each level (sawtooth trend); 3 reachable big coins per level. `seed.py` v2 loads the levels as the game
"Starter World", and the old levels become "Classic Starter".

---

## 16. G. The v1 review fixes

| # | v1 issue | Root cause | v2 fix | Test |
|---|---|---|---|---|
| 1 | Duplicate win banner | `Hud.showBanner` (hud.ts:115) and the `.win-overlay` (play.ts:106) both render [V-9] | one moment: canvas confetti + the HTML results card; `showBanner` removed | e2e: exactly one node with the win title after reaching the goal |
| 2 | Single brush tap too small to register | 8 px brush vs `MIN_AREA_CELLS = 0.3` (components.py:19, canvas.ts:21) [B-F7] | a tap writes a 1-cell dot stroke; the vectorizer keeps ink ≥ 12 px²; S1 dot → coin | unit: tap → coin; paper 3 mm dot → coin; build drawings 1-6 keep 22/22 coins |
| 3 | Enemies hover in mid-air | `setAllowGravity(false)` (Patroller.ts:6, 38) [B-F9] | kernel enemies have gravity; N4 grounds them at build; only `flyer` hovers | unit: an enemy drawn 2 cells above ground is grounded at build and stays grounded over 600 frames |
| 4 | Crunchy photo backdrops | `pixelArt: true` (index.ts:68) at a non-integer scale [V-3] | 13.2: linear filtering, render scale S, vector ink | config unit test; visual golden check |
| 5 | Handwriting becomes solid tiles with the model off | text removal depended only on model annotations (compile.py:394-408; heuristic returns `[]`) [B-F3] | S13 text and S14 arrow in the deterministic grammar; N5 makes them scenery | golden G04 model-off: 0 colliding text cells; reachable ≥ the model-on build |
| 6 | Remix by re-scanning duplicates coins | parent entities kept plus re-detected child ink at the same spot | gray parent ink stays background; N9 dedupes same-type things within 1 cell, keeping the parent's | unit: a child re-traces 2 parent coins → coin count unchanged |
| 7 | Canvas character box only partly wired | a 128 px raster canvas sharing the main tool colour [V-5] | a character panel with its own palette, vector strokes, onion-skin body box, live rig preview, "save to library"; the sprite is rendered from vectors | e2e: draw a character → it is the player in play; changing the main colour leaves the character palette alone |
| + | Zero-length moving platform crashes the scene | trusted roles, `startLeg` recursion (MovingPlatform.ts:58) [V-1] | validator (6.3) + per-entity try/catch; publish blocked on `entity_error` | unit: path length 0 → binding dropped with a warning; engine survives a throwing behaviour |
| + | "the monster walks" also walks the spawn spikes | heuristic merged on top of the model, largest red (interpret.py:154) [B-F10] | parser binds only unambiguous targets and asks otherwise; the model's rules replace the parser's | golden G06: exactly 1 enemy moves |
| + | `goal_unreachable` raw codes; Publish on a broken level | no message table, no gating [V-4] | 9.3 message table; publish gating | e2e: no snake_case token is visible in the preview DOM |

---

## 17. H. Build plan for a multi-agent implementation

v2 code lives in new directories beside v1, so v1 keeps running until the switch-over in P5. Seven owners: a lead (L0)
who writes the contracts in P0, then six parallel lanes.

### 17.1 Lanes and exact file ownership

| Lane | Owns (create/edit only these) | Delivers |
|---|---|---|
| **L0 Lead / contracts** | `shared/schema/*.v2.schema.json`; `shared/kernel/types.ts`, `api.ts` (signatures + stubs), `params.json` (every bound and default in this doc), `ops/vocabulary.ts` (op names and param types only), `tsconfig.json`; `shared/messages/codes.ts` (reason and flag codes); `vision/app/v2/contracts.py`, `vision/app/v2/mind/schemas.py`; `shared/golden/**`; `docs/v2/spec/http.md`; `docs/v2/CONTRACTS.md` (changelog) | frozen contracts, golden set, test harness wiring |
| **K1 Physics & playtest** | `shared/kernel/physics/**`, `world/**`, `camera.ts`, `solver/**`, `metrics/**`, `replay/**`; `shared/conformance/physics/**`, `shared/conformance/replay/**` | `stepWorld`, `playtest`, `verifyRun`, metrics, flags |
| **K2 Perception & realize** | `shared/kernel/perceive/**`, `geometry/**`, `realize/**`, `library/**`, `migrate/**`; `shared/conformance/collision/**` | `perceive`, realization, validator, symbol matcher, `migrateV1` |
| **K3 Mind** | `shared/kernel/ops/**` (except `vocabulary.ts`), `repair/**`, `design/**`, `generate/**`, `pipeline.ts`, `cli.ts`; `shared/messages/en.json`; `shared/starter/**` | normalizers, repair search, designer and dial, `generate`, `build`/`design`/`applyEdits`, sidecar server, Starter World |
| **V Vision & model service** (Python) | `vision/app/v2/{ingest,vectorize,sheets,omr,kernel_client,migrate}.py`, `vision/app/v2/template/**`, `shared/template_spec.v2.json`, `vision/app/v2/mind/{client,semantics,review,arbitrate,plan,moderate,sanitize}.py`, `vision/app/v2/mind/prompts/*.md`, `vision/tests/v2/test_{vectorize,sheets,omr,mind,sanitize,migrate}.py`, `docs/v2/bench/**` | strokes from photos, multi-sheet, OMR, all model calls with fallbacks, sidecar client |
| **E Engine & art** | `shared/kernel/art/**` (ArtDoc builder, styles, SVG serializer); `web/src/game2/**` (scene, kernel adapter, input, render, boil FX, rig, particles, audio, HUD, touch, ghost); `web/public/fonts/**` | `mountGame2`, the ink renderer, feel |
| **P Product: UI, API, data** | `web/src/editor/**`, `web/src/screens2/**`, `web/src/api2.ts`, `web/src/style2.css`, `web/src/main.ts` (P5 switch-over only); `vision/app/routers/v2/**`, `vision/app/v2/{db,seed}.py`, `vision/tests/v2/test_api_*.py`; `scripts/v2_smoke.sh`, `web/scripts/golden.ts` | editor, preview/report, library, rules, prompt, play, social screens; HTTP API; storage; golden report page |

Contract change rule: any change to an L0 file needs an entry in `docs/v2/CONTRACTS.md` naming the affected lanes,
and lands with updated fixtures. Lanes never edit each other's files; they file a note to the owner.

### 17.2 Cross-lane interfaces (beyond section 3)

```ts
// web/src/game2/index.ts (E)
export interface MountOptions2 {
  mode: 'play' | 'preview' | 'ghost' | 'challenge';
  record: boolean;                     // produce an InputLog
  ghost: InputLog | null;
  overlays: OverlaySpec;               // in-scene: ghosts for edits, bot path, flags, reach halo
  onEvent: (e: GameEvent2) => void;
}
export type GameEvent2 =
  | { type: 'ready' }
  | { type: 'win'; frames: number; log: InputLog; coins: number; big: number; deaths: number }
  | { type: 'die'; cause: 'hazard' | 'enemy' | 'void' | 'projectile' | 'lava'; x: number; y: number }
  | { type: 'checkpoint'; id: string } | { type: 'coin'; big: boolean }
  | { type: 'entity_error'; thing: string; message: string };
export function mountGame2(el: HTMLElement, level: LevelV2, art: ArtDoc, opts: MountOptions2): GameHandle2;
export interface GameHandle2 { destroy(): void; restart(): void; pause(p: boolean): void;
  setOverlays(o: OverlaySpec): void; setGhost(l: InputLog | null): void }
```

```python
# vision/app/v2/kernel_client.py (V)
class Kernel:
    async def call(self, method: Literal["perceive","build","design","apply_edits","playtest",
                                         "generate","verify_run","migrate_v1","level_hash"],
                   params: dict, timeout_s: float) -> dict: ...
# vision/app/v2/mind/client.py (V): the only module that talks to Anthropic
def parse_call(*, purpose: str, system: str, content: list[dict], schema: type[BaseModel],
               effort: Literal["low","medium"], timeout_s: float, max_retries: int,
               max_tokens: int) -> ModelResult   # ModelResult = Ok(parsed, usage, served_by) | Refused(category) | Failed(reason)
```

**Sidecar RPC** (JSON lines over stdio): request `{"id": n, "method": m, "params": {...}}`, response
`{"id": n, "result": ...}` or `{"id": n, "error": {"code", "message"}}`. Timeouts: perceive 1 s, build 3 s,
design 4 s, playtest 2 s, generate 3 s, verify_run 2 s, migrate_v1 2 s. Pool of 2, restarted on crash or timeout.

### 17.3 HTTP API v2 (P owns the routers; V owns the logic they call)

| Method and path | Body / query | Returns |
|---|---|---|
| `GET /api/v2/health` | n/a | `{ok, model: "live"\|"fake"\|"offline", kernel: "ok"\|"down", kernel_version}` |
| `POST /api/v2/scans` | multipart `images[]` (1-6), `parent_id?`, `game_id?` | `{scan_id, stroke_doc, sheets[], semantics_job: id\|null}` (~1.5 s per sheet) |
| `POST /api/v2/semantics` | `{stroke_doc \| scan_id, ask: [obj ids], glyph_table, rules_text}` | `{job_id}` |
| `GET /api/v2/jobs/{id}?wait=15` | long-poll | `{status: pending\|done\|failed, result?, message?}` (used for semantics, review, arbitrate, generate) |
| `POST /api/v2/build` | `BuildInput + {dial, band}` | `BuildResult` (server build for slow devices) |
| `POST /api/v2/review` | `{level, scene_table, edits, metrics, render_png}` | `{job_id}` |
| `POST /api/v2/arbitrate` | `{failures, options, thumbnails[]}` | `{job_id}` |
| `POST /api/v2/generate` | `{prompt, screens?, band?, game_id?}` | `{job_id}` → `{plan, stroke_doc, build}` |
| `POST /api/v2/levels` | `{stroke_doc, semantic_edits, user_edits, dial, band, level_hash, title, author, game_id?, parent_id?, thumbnail_png}` | `{level}`, or 422 `{reasons: [MessageRef]}` if the server's recomputed hash differs, the level is unsolvable or safety is flagged |
| `GET /api/v2/levels/{id}` | n/a | `{level, author, likes, children, medals_stats}` |
| `POST /api/v2/levels/{id}/moderate` | n/a | `{safety}` |
| `POST /api/v2/runs` | `{level_id, level_hash, log, claimed_frames, name}` | `{run, verified, rank}` |
| `GET /api/v2/levels/{id}/runs?limit=10` / `GET /api/v2/runs/{id}` | n/a | leaderboard / run with log |
| `GET, POST /api/v2/games/{id}/objects`; `GET /api/v2/objects/{id}?v=` | ObjectType | library |
| `GET, PUT /api/v2/games/{id}/rules`; `POST /api/v2/games/{id}/rules/scan` | GameRules / photo | rules |
| `GET /api/v2/templates/sheets.pdf?kind=new\|game\|lvl&id=&sheets=k`; `/rules.pdf?game=`; `/library.pdf?game=` | n/a | PDF |

SQLite additions (`vision/app/v2/db.py`): `levels` gains `schema_version, json_v2, level_hash, difficulty_c, screens,
verified, safety`; new tables `stroke_docs(id, json, created_at)`, `object_types(id, game_id, version, json, author,
created_at)`, `game_rules(game_id, json)`, `runs(id, level_id, level_hash, name, frames, deaths, coins, log, verified,
created_at)`, `jobs(id, kind, status, result_json, cost_usd, created_at)`.

### 17.4 Phase order and gates

| Phase | Work (by lane) | Exit gate (all must pass) |
|---|---|---|
| **P0 Contracts & harness** (L0; lanes review) | all L0 files; golden inputs copied plus `expected.json`; vector StrokeDocs for G01-G06 exported by a copy of `docs/v2/diagnosis/build/make_kid_drawings.py` whose `Kid.stroke`/`dot`/`circle` also record each wobbled polyline (same seeds, so the raster is byte-identical; the original script is not modified); vitest includes `shared/kernel`; pytest collects `vision/tests/v2`; sidecar echo; `docs/v2/bench/model_bench.py` (≤ 30 calls, ≤ $2) | schemas validate fixtures in TS and Python; `node shared/kernel/cli.ts --selftest` OK; **latency gates measured**: semantics p50 ≤ 9 s at low (else trim the payload); taste review p50 ≤ 20 s at low (else it ships as a late "notes" feature) |
| **P1 Foundations** (all lanes in parallel) | K1 profiles + player `stepWorld` + static-tile solver with slopes and one-way; K2 features, grouping, fitting, grammar; V vectorizer + kernel client; E `mountGame2` renders a fixture LevelV2 with the kernel-stepped player at render scale S; P editor (strokes, taps, pan/zoom/screens, undo/redo, StrokeDoc export) | envelope within 0.1 cell; v1 profile reproduces v1 Starter E[deaths]; vectorizer centreline RMS ≤ 0.1 cell; grammar ≥ 90% roles on golden glyphs (model off); editor exports schema-valid StrokeDocs |
| **P2 Faithful end-to-end** | K1 enemies, platforms, hazards, time-aware solver, windows, flags, camera; K2 relations, realize, validator, migrate; K3 P/N/R ops, repair search, `build`, `applyEdits`, messages; V `/scans`, semantics + sanitizer, sidecar pool; E all things, designer ink, boil, HUD, results card; P preview report with accept/undo, publish verification, play screen | **acceptance A2-A6, A11, A13, A14, A24** (17.7) |
| **P3 Mind and feel** | K3 designer, dial, generators, checkpoints/coins/par, taste-proposal applier; K1 trajectory templates, perf, bot ghost; V review, arbitrate, moderation; E rig, particles, SFX, parallax, themes; P dial UI, difficulty meter, notes and question cards, rule chips | A7-A10, A12, A23, A25 |
| **P4 Breadth** | V template v2 (multi-sheet, rules sheet, library sheet), OMR, plan call; K2 seams, symbol matching; K3 `generate`; E chunked textures, minimap, ghosts; P long-canvas polish, library, rules and prompt screens | A16-A20 |
| **P5 Content, social, switch-over** | K3 Starter World plans + overrides; K1 `verifyRun` + conformance suite; P runs, leaderboards, challenge links, feed thumbnails, router switch-over, seed v2; V migration run | A1, A15, A21, A22, A26, and a full re-run of A2-A25 |

Integration points: P1 → P2 (K2 + K3 + K1 meet in `pipeline.ts`; V + P meet at `/scans`); P2 → P3 (E + P meet in
the preview overlays). A lane may start the next phase's work early only inside its own files.

### 17.5 Golden drawings (the quality bar)

Inputs live in `shared/golden/<id>/` (copied from the diagnosis folders and from `vision/data/uploads/drafts/`, never
moved). Each has `input.*`, optional `prompt.txt` and `strokes.json`, and an `expected.json` with **musts**,
**must-nots** and **bands**, checked automatically by `npm run golden` (P), which writes
`docs/v2/golden/out/<id>/{faithful,polished,challenging}.svg`, `report.json` and an `index.html` grid for visual review.

| Id | Source | Must (offline unless noted) | Must not |
|---|---|---|---|
| G01 spike_hop | `docs/v2/diagnosis/build/inputs/1_spike_hop.png` | solvable; goal within 1 cell of the drawn flag and grounded; 4 coins (tap kept); spikes on the floor facing up and on platform 1 (N3 dy ≤ 1); 12 px floor gap closed; spawn ≥ 2 cells from spikes | pole collision; 2-row hazards; bumps |
| G02 spike_cave | `.../2_spike_cave.png` | ceiling spikes facing down; wall spikes facing left with the wall solid; floor route to the flag open; 4 coins | hazard cells over the wall |
| G03 monster_meadow (+prompt) | `.../3_monster_meadow.png` | tree and sun are decoration; goal = small flag; monster = walker with eyes as parts, grounded; ≥ 58 reachable standing cells | tree as goal; trunk wall; orphan eyes |
| G04 words_and_arrows | `.../4_words_and_arrows.png` | "jump!" non-colliding (model on and off); arrow → platform moves right ≈ shaft length; platform 1 row | text tiles |
| G05 big_leap | `.../5_big_leap.png` | solvable (run jump with runway ≥ 3, else R3 extend); lava bottom; 3 coins | silent impossibility |
| G06 kid_full_level (+prompt) | `.../6_kid_full_level.png` | ramp as slope tiles; exactly 1 moving enemy (the monster); spawn cleared; spikes snapped; solvable with ≤ 3 R edits each ≤ 3 cells, or 1 add_step; 3/3 coins | staircase; walking spawn spikes |
| G07 floating_spikes | `docs/v2/diagnosis/model/inputs/canvas_floating_spikes/input.png` | goal grounded on G2; spikes snapped onto the ledge; the jumpable 5-cell gap untouched | edits to the 5-cell gap |
| G08 wobbly_cave | `.../canvas_wobbly_cave/input.png` | start not on the roof; 1-cell hole closed; wall trimmed (not lifted); 0 bumps; solvable | detached pillar |
| G09 tower_key | `.../canvas_tower_key/input.png` | 3 ledge fragments = 1 surface; key reachable with the door closed and the door gating the goal (model on); offline: a "which door?" question | key silently becomes a coin |
| G10 paper_synth_1 | `.../paper_synth_1/input.jpg` | paper path; moving platform from "moves" + arrow; solvable; paper p90 ≤ 5 s | |
| G11 owner `d_b14b143e` | `vision/data/uploads/drafts/d_b14b143e/photo.jpg` | Faithful solvable with ≤ 3 R edits each ≤ 3 cells (expected: 0); Polished makes both drawn coins reachable with ≤ 2 nudges of ≤ 2 rows; floor is not dynamic; "high platform moves 4 cells" moves the highest platform; red lines: floor spikes + pit lava; green Γ = goal; 2 coins | head bonk; zero-length mover |
| G12 owner `d_dfbfe619` | `.../d_dfbfe619/photo.jpg` | black zigzag = decoration (asks); solvable | 1-cell walls |
| G13 owner `d_79eff85e` | `.../d_79eff85e/photo.jpg` | red zigzag = spike strip on the platform's top face (6 px band); Challenging-Normal C > 0.3 with the route crossing it [G-§10] | 41-cell floating slab |
| G14 owner `d_45f50934` | `.../d_45f50934/photo.jpg` | pit spikes kept; E ≥ 0.07 at Faithful | |
| G15 owner `d_23962d19` | `.../d_23962d19/photo.jpg` | solvable, 0 hard flags | |
| G16 two_sheets | new: `vision/tests/v2/make_synthetic_v2.py --sheets 2` | stitched w = 96; ground continuous across the seam (N10); missing-sheet warning when one is removed | |
| G17 long_canvas | new vector doc, 3 screens | 0 blind jumps; playtest ≤ 300 ms | |
| G18 library_bob | new: type "Bob" (hopper) + paper symbol + canvas stamp | both placements become hoppers with Bob's art | |
| G19 handwriting_rules | new paper photo: "the platform moves", "door opens with key" | model on: move + key_door; offline: "type it" box with the parser | |
| G20 harsh_photo | `shared/fixtures/photos/synth_2.jpg` + shadow augmentation | rectified; roles ≥ 90% | |
| P01-P10 | prompts, e.g. "lava cave where a key opens the exit", "easy first level", "hard spike gauntlet with moving platforms", "tower climb with walking enemies" | solvable; 0 hard flags; C in the requested band (≥ 8/10) | |

**Visual bar** (reviewed on `index.html`, plus browser-pane screenshots at DPR 2 saved to `docs/v2/golden/screens/`):
ink top edges sit exactly on standing surfaces; no stair-stepped or blurry ink; spikes point away from their surface;
enemies stand on surfaces; the goal is the kid's flag; designer ink is clearly distinct; text is visible but faded;
nothing is drawn twice.

### 17.6 Automated tests

| Suite | Command | Covers |
|---|---|---|
| Kernel unit + property | `cd web && npx vitest run ../shared/kernel` | envelope; determinism lint (forbidden `Math.*` in step code); template ≡ full sim (10k samples); solver fixtures (v1 profile on v1 Starter; v2 fixtures); perceive per-glyph expectations; ops: replay identity (apply all, undo all = base), bounds clamping, idempotent normalizers, invariants; repair on G01-G15; designer bands; `generate` on 50 random plans → 100% solvable; migrate all v1 fixtures; conformance |
| Engine | `cd web && npx vitest run src/game2` | kernel adapter fixed-step; 200-level fuzz mount with no uncaught exception; one win moment |
| Python | `cd vision && uv run --no-sync pytest tests/v2 -q` | vectorizer accuracy; sheets and QR v2; OMR; sanitizer (unknown ids, clamps, missing key_door field, refusal, timeout, max_tokens via a fake client); recorded model responses (no network); API with the sidecar |
| Golden | `cd web && npm run golden` | 17.5 musts and must-nots; SVG outputs |
| Starter | `cd web && npm run starter:verify` | section 15 acceptance |
| Perf | `cd web && npm run bench:kernel` | 7.2 and 10.1 budgets |
| Model (live, manual) | `cd vision && set -a; source ../.env; set +a; uv run --no-sync python ../docs/v2/bench/model_bench.py --budget 2` | latency and accuracy gates; never prints the key |
| Smoke | `scripts/v2_smoke.sh` | G01-G06 through `/api/v2/scans` → build → publish verify |

### 17.7 Acceptance criteria (reviewer checklist)

| # | Criterion | How to check |
|---|---|---|
| A1 | All suites in 17.6 green; `npx tsc --noEmit` clean for web and kernel | commands |
| A2 | G01-G06 at Faithful, model off: 6/6 solvable; 0 pole walls; goal within 1 cell of the drawn flag and grounded 6/6; coins 22/22; 0 unintended bumps; floating platforms exactly 1 row | `report.json` |
| A3 | Art equals physics: every terrain top edge in the ArtDoc is 0 px from its collision edge; normalizer drift ≤ 0.5 cell | golden geometry check |
| A4 | G04 model off: 0 colliding text cells; reachable cells ≥ the model-on build | golden |
| A5 | G06: exactly 1 moving enemy; 0 staircase steps on the ramp; spawn hazard-free radius ≥ 2 | golden |
| A6 | G11 solvable with ≤ 3 R edits each ≤ 3 cells; G13 spikes are a 6 px band on the top face | golden |
| A7 | Model on (≤ $2): ≥ 95% role accuracy on asked glyphs; every key_door has both ids; 0 invented ids applied | `model_bench.py` |
| A8 | Latency: canvas faithful p50 ≤ 0.5 s (laptop); paper p50 ≤ 3 s, p90 ≤ 5 s; semantics p90 ≤ 14 s; polished ≤ 1.5 s after faithful | bench + server logs |
| A9 | Physics envelope within 0.1 cell of `proposed_physics_results.md`; v1 profile reproduces v1 Starter E[deaths] within 0.005 | kernel tests |
| A10 | Templates ≡ full sim on 10k samples; 3-screen playtest ≤ 300 ms, 6-screen ≤ 1 s | tests + bench |
| A11 | Browser and server `level_hash` equal for every golden; `verifyRun` accepts recorded runs and rejects a log with one frame altered | e2e + unit |
| A12 | On G01-G10: Polished never lowers drawn C (except to clear hard flags) and keeps F_s ≤ 30 s; Challenging-Normal lands in [0.3, 1.0) on ≥ 8/10 and Hard in [1, 3) on ≥ 6/10 (the rest report why); 0 hard flags in all outputs; invariants I1-I6 logged as held | golden |
| A13 | Every change-list row shows a message (no snake_case code in the DOM); Accept/Undo replays in < 50 ms for 3 screens; undoing a needed repair blocks publish with a plain message | e2e + manual |
| A14 | 200 random schema-valid levels mount without an uncaught exception; bad entities surface as `entity_error` | fuzz test |
| A15 | Starter World meets every item in section 15 | `starter:verify` |
| A16 | G17 plays across 3 screens with 0 blind jumps; the bot trace keeps every landing on camera | golden |
| A17 | G16 stitches with continuous ground; removing a sheet shows the warning | golden + API test |
| A18 | G18 places Bob by symbol (paper) and by stamp (canvas) with the type's behaviour and art | golden |
| A19 | Rules-sheet OMR is 100% on 5 synthetic photos; enabling double jump lets the solver reach a ledge 6 rows up | tests |
| A20 | P01-P10: 10/10 solvable, 0 hard flags, ≥ 8/10 in band, end-to-end p50 ≤ 15 s online; the offline planner yields solvable drafts | bench |
| A21 | A run submits and verifies, appears on the leaderboard, and the challenge link plays its ghost | manual + API test |
| A22 | 100% of v1 levels in `dal.sqlite` migrate; solvable status kept or flagged; Classic Starter plays under the `v1` profile | migrate log |
| A23 | In the browser at DPR 2: `game.config.pixelArt === false`; no stair-stepped ink; boil visible; SFX after the first input; mute works; one win card | manual (browser pane) |
| A24 | Key unset: scan → play → publish works and model features are hidden with one line of explanation; mocked refusal → `safety: unknown` and public publish held | manual + tests |
| A25 | Median model spend per golden paper scan ≤ $0.10; the budget guard disables taste review first | jobs table |
| A26 | v1 fixes 1-7 pass their tests (section 16) | tests |

---

## 18. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| The shape grammar is brittle on real children's drawings; the golden set is synthetic and clean [M-caveats] | medium / high | calibrated confidence with an "ask" path (chips, re-label, model for < 0.75); add consented real drawings to the golden set in P5; thresholds live in `params.json`, not code |
| Runtime drift between browser and Node | low / high | determinism lint, hash parity tests on every golden, kernel version in every level |
| Node type-stripping constraints (erasable syntax only, `.ts` import suffixes) | low / medium | kernel `tsconfig.json` sets `erasableSyntaxOnly`, `allowImportingTsExtensions`, `noEmit`; CI runs `node shared/kernel/cli.ts --selftest` |
| Solver cost with timed entities on 6 screens | medium / medium | trajectory templates, 16-phase sampling with local windows; if over budget, 8 phases with metrics marked `approx` |
| Custom slope collision has corner cases | medium / medium | only two angles; tile-transition unit tests (slope→flat→wall); fallback: 1:2 slopes become steps with an 8 px step-up assist |
| Model latency or price changes | medium / low | the model is off the critical path; P0 gates; payload trimming; daily budget guard |
| Over-repair changes the drawing | medium / high | invariants I1-I6, drift budgets, cost ranking that prefers trimming over lifting, the Faithful dial, every edit undoable |
| The designer cannot reach a band without breaking intent | medium / low | it stops and reports C and why; it never violates invariants |
| Phones are slow at kernel builds | medium / medium | startup micro-benchmark → server build; render scale capped at 2; texture LRU |
| Scope ("fully redesign") | high / medium | phases deliver value in order: P2 alone fixes "poor quality after I draw"; P3 fixes "too easy"; P4-P5 add breadth |
| uvicorn `--reload` restarts orphan the sidecar | medium / low | the kernel client owns the child processes, kills them on shutdown and restarts on demand; `/api/v2/health` reports them |

---

## Appendix A. Kernel layout (`shared/kernel/`, TypeScript, zero dependencies, erasable syntax)

```
shared/kernel/
  api.ts  types.ts  params.json  tsconfig.json  cli.ts (sidecar: --serve, --selftest)  pipeline.ts
  geometry/   vec.ts  rdp.ts  fit.ts (quantized segment fitting)  poly.ts  chamfer.ts
  perceive/   features.ts  group.ts  grammar.ts  calibration.json  relate.ts  rules_parser.ts  index.ts
  realize/    tiles.ts  things.ts  validate.ts  hash.ts
  physics/    profiles.ts  player.ts  collide.ts (tiles, slopes, one-way)  sine.ts
  world/      state.ts  step.ts (stepWorld)  enemies.ts  platforms.ts  hazards.ts  rules.ts
  camera.ts
  solver/     graph.ts  actions.ts  templates.ts  phases.ts  search.ts
  metrics/    windows.ts  difficulty.ts  flags.ts
  ops/        vocabulary.ts  perception.ts  normalizers.ts  repair.ts  designer.ts  apply.ts
  repair/     search.ts  failures.ts  cost.ts
  design/     tuner.ts  generators.ts  pacing.ts  invariants.ts
  generate/   beats.ts  spine.ts  wobble.ts
  library/    match.ts
  art/        build.ts  styles.ts  svg.ts  parallax.ts
  replay/     inputlog.ts  verify.ts
  migrate/    v1.ts
```

## Appendix B. Semantic-pass system prompt (draft, `vision/app/v2/mind/prompts/semantics.md`)

> You help a children's game turn a drawing into a platformer level. Code has already found every mark on the page,
> grouped the marks into numbered glyphs, measured their exact geometry and guessed a role for each with a confidence.
> Code also computes all physics. Never judge distances, heights, or whether something can be reached.
>
> You get the image (glyph ids in magenta; boxed ids are the ones you are asked about) and a table of all glyphs.
> 1. For each glyph with `asked: true`, give its role. Roles: ground, platform, wall, ceiling (terrain you stand on or
>    bump into); spikes, lava, saw (hurt you); enemy (a creature; its eyes, mouth and legs are `part_of` it); goal
>    (the flag; its pole is `pole`); coin; key; door; checkpoint; spring; start_mark (an "S" or "start"); decoration
>    (scenery that must not collide: trees, suns, clouds, grass, animals that are not enemies); text; arrow; unknown.
> 2. Read every text glyph exactly as written into `reads`.
> 3. Turn the writing (labels, the rules box, typed rules) into `rules`, pointing at glyph ids. "This platform moves"
>    with an arrow → `move` toward the arrow. "The monster walks" → `enemy` for that monster only. A key needs both
>    `key` and `door`. If something needed is missing or ambiguous, add a `question` for the child instead of guessing.
> 4. Safety: set `flag` for sexual, hateful or graphically violent content. Monsters, spikes and lava are fine.
> 5. Suggest a short title if the child wrote one or the drawing clearly suggests one.
>
> Use only the listed ids. Keep `why` text short and kind. Do not add mechanics nobody drew or wrote.
