# draw-a-level v2: the build plan

Status: **single source of truth for the v2 implementation workflow.** Date 2026-10-10.

- **Base design:** player-first [PF], ranked 1st by all three judges (185 points).
- **Grafts:** the judges' named best ideas from mind-first [MF] and geometry-first [GF].
- **Fixes:** every fatal flaw the judges [J] named is removed.
- **Stack (unchanged):** FastAPI, OpenCV, the Claude Python SDK, Vite/TS/Phaser 3 and SQLite.
- **Coexistence with v1:** v1 keeps running beside v2 until the P6 switch-over.

## Evidence keys

| Key | Source |
|---|---|
| [B Fn], [B score], [B sweep] | `docs/v2/diagnosis/build.md`: failure catalogue F1-F17, scoreboard, controlled sweeps |
| [G §n], [G Rn] | `docs/v2/diagnosis/gameplay.md` sections and root causes R1-R8 |
| [V n], [V §n] | `docs/v2/diagnosis/visual.md` ranked problems 1-9 and sections |
| [M A-D], [M lat], [M api], [M fail n] | `docs/v2/diagnosis/model.md`: probes A-D, latency table, API facts, failure modes |
| [PF], [MF], [GF], [J] | `docs/v2/designs/{player-first,mind-first,geometry-first}.md` and the judges' verdicts |
| [API] | the claude-api reference bundled on this machine: Python README, structured outputs and the Opus 5 migration notes |

Facts verified on this machine for this plan:
- **Node and the core runtime:** Node `v24.16.0` runs erasable-syntax `.ts` natively, including `.ts` imports and `worker_threads` with `.ts` entry files. Cold start is about 40 ms, so the core needs no build step.
- **Python libraries:** `anthropic` 1.13.0, OpenCV 5.0.0 with `cv2.ximgproc`, and Pydantic 2.14.
- **Web toolchain:** Phaser ^3.90, Vite ^7 and TypeScript ^5.9.
- **v1 TypeScript is erasable:** it uses no enums, namespaces or parameter properties.

## What the owner asked, and the root fix

| Owner said | Measured cause | v2 root fix |
|---|---|---|
| "How it's built after I draw is extremely poor quality" | Pixels become 16 px cells before anything understands objects [B synthesis 1-5]. As a result, 5 of 6 kid drawings were unbeatable after the build [B score]. Specific failures: the flag pole became a wall in 6/6 [B F1], the tree became the goal [B F2], spikes became 2-row blocks [B F5], lines became staircases [B F4], taps were dropped [B F7], and art and collision were 5-14 px apart [B F13]. | The pipeline becomes ink → typed objects → fitted geometry. Collision and art are both derived from the same fitted shapes. A frame-exact bot plays every build before anyone sees it. |
| "Is there a mind that thinks about how the spikes are placed?" | The model is told its "only job" is reading words (`prompt.py:26`) [B F17]. There is no repair stage, and the server never solves (`compile.py:638`) [B F12]. | A level-design mind: perception (Claude plus a deterministic perceiver), then intent-preserving repair, then a designer that picks moves from a menu that has already been verified. Every change is a card with a reason and an Undo. |
| "The game itself feels too easy" | There is no momentum. 35-39 of 40 hold lengths work. E[deaths] per level is 0.000-0.004. A level is one 5-second screen, and nothing is at stake [G §2-§4, R1-R8]. | Momentum physics with a run skill, real threats, levels up to 6 screens long with a camera, stakes and rewards, and a dial that targets a **measured** difficulty band. |

---

## 0. Decisions

Every open question from the three designs is resolved here. Section numbers point to the detail.

| # | Topic | Decision | Why (evidence) | From |
|---|---|---|---|---|
| D1 | Language split | **Python sees and talks; one pure-TS core builds, plays and judges.** Python owns pixels, model I/O, HTTP and SQLite. `web/src/core/` holds everything after strokes: perception heuristics, merge, fit, compile, edits, sim, bot, difficulty, designer, generator, replay and art display lists. It runs in the browser (Web Worker) and in 2 persistent Node workers (`node web/src/core/worker/main.ts`, native TS, no build step). | One implementation of geometry and physics [G §10]. No Python/TS boundary on every candidate, which was MF's fatal flaw [J]. Instant local test-play and undo [V 4]. | PF + GF |
| D2 | One simulation | Phaser Arcade is no longer used for gameplay bodies. A fixed 60 Hz deterministic `Sim` is the engine, the bot, the designer's validator and the replay verifier. A lint test bans trig and `Math.random` in step code. | v1's solver was a hand port of Arcade with gaps: no coyote, enemies ignored, static movers [G §6, §11]. | PF + GF |
| D3 | Unit of meaning | **Objects, not cells.** InkDoc vectors become a scene graph, which becomes fitted geometry. Art and collision both come from the fitted shapes. Ink is never dropped silently. | [B synthesis 1], [B F4, F7, F13] | all |
| D4 | Perception | A deterministic heuristic perceiver (grouping, a 22-rule grammar, isotonic-calibrated confidence) runs on every build in < 100 ms. **Claude PERCEIVE (effort low) runs on every build that has any unpinned ink or text**, one call per paper sheet or per 2-screen canvas tile, all in parallel. It is skipped ($0) when stamps and chips pin every component. | Model roles are 95-97% correct and relations 75/76 [M A]. The model must run offline-safe [B F3]. Calls are skipped when they add nothing [J]. | PF + GF |
| D5 | Unknown ink | Ink that matches no rule becomes **non-colliding decoration** with an "Is this right?" chip, **unless it is surface-like**: black, fitted residual ≤ 0.35 cell, length ≥ 2 cells, \|angle\| ≤ 55°. | PF defaulted unknown ink to colliding, which reopens [B F3] [J]. | MF + GF |
| D6 | Edits are intents | `build()` is a pure function of (ink, graph0, edit records with statuses, rules, library, tier). Undoing "straighten o4" re-snaps its spikes onto the wobbly line. A rebuild must be byte-identical (acceptance test). Edit ids are stable: `op:target:hash6(params)`. | [V 4]; MF's "edits as intents" [J] | MF + PF |
| D7 | Edit vocabulary | **43 ops in 6 classes**: Understand, Normalize, Repair, Polish, Challenge, Kid (§3.5). Bounds are enforced in code. The model never emits coordinates. Placements come only from slots the bot computed. | Loose params let v1 drop `opens` [M fail 2]. An ambiguous face was misapplied [M fail 3]. | all |
| D8 | Repair | A minimal-intent-cost search keyed by **failure kind**, with topology +3, detached pillar +4 and text-pinned ×2 penalties (§3.7). | The model "lifted the wall into a pillar" [M B]. | GF + PF |
| D9 | Designer | Code builds a menu of ≤ 40 pre-verified candidates. **One DESIGN call (effort low) picks moves for all three tiers.** It runs *speculatively* on the Ink build's menu, and its picks are transferred to the Understood menu by stable candidate id. REFINE runs at most 1 round. CRITIC runs on demand from the creator's own deaths. The greedy designer is always the floor. | Taste is good but needs validation [M C]. Latency [M lat]. MF's tiers and critic [J]. | MF + PF |
| D10 | Dial | Faithful / **Polished (default)** / Challenging·Normal / Challenging·Hard. All four are **precomputed and nested** (polished ⊂ normal ⊂ hard), so moving the dial is an instant client-side swap. | [G §9], [J] | MF |
| D11 | Intent invariants | I1-I8 (§3.6), including model-named setpieces (I3), never easier than drawn (I7), and a respect ratio (I8). | [G §9], [J] | all |
| D12 | Physics | Profile `v2-standard` uses the numbers in [G §7.1], plus `v2-gentle`, `v2-snappy` and `v1-classic`. **A run-gap needs ≥ 3 cells of runway** (2.27 cells computed, §5.3). | PF's 6-cell runway contradicted the envelope [J]. | GF |
| D13 | Level size | World = 48·k × 27 cells, k = 1..6. The camera moves **horizontally only**. Tall levels, rising lava and wall jump are deferred to v2.x. | [G §7.3]; scope [J] | GF |
| D14 | Difficulty | C, F and score are computed from engine-exact windows with σ = 3 frames (casual). Bands come from [G §6]. Fairness flags are hard constraints. | [G §6] | all |
| D15 | Latency | Canvas ▶ test-play is local, < 0.3 s. **Ink build: ≤ 0.6 s on canvas, ≈ 2.5 s on paper (p50), ≤ 8 s (p95).** Greedy tiers add ≤ 3 s. Model Understood arrives at ≈ 12 s. Model Polished arrives at ≈ 13-14 s p50 via the speculative transfer. **Hard deadline 25 s**: if missed, the greedy result ships and late picks become suggestions. | [M lat], the brief | PF + MF |
| D16 | Streaming | SSE `GET /api/v2/builds/{id}/events` carries 13 named events with `Last-Event-ID` resume. Polling fallback: `GET /api/v2/drafts/{id}?since=<seq>`. | [V §3] | PF |
| D17 | Model API | Model `claude-opus-5` via `client.beta.messages.parse`:<br>- thinking omitted (adaptive is the Opus 5 default);<br>- `output_config={"effort": "low"}` for every runtime call;<br>- `fallbacks="default"` with beta `server-side-fallback-2026-07-01`;<br>- `stop_reason` checked **before** `parsed_output`;<br>- `max_retries=0` plus one retry on 529;<br>- model-facing schemas use **enums, not numeric bounds**. | [M api], [API], [J] | all |
| D18 | Contracts | Pydantic v2 models in `vision/app/spec/` are the single source of truth. They generate `shared/spec/*.schema.json` (the published spec) and `web/src/core/types.gen.ts`. Staleness tests run in both CI suites. | Hand-mirroring drifts [J] | MF |
| D19 | Art | Three inks. The kid's own strokes are top-aligned onto collision (shift ≤ 0.85 cell, typically ≤ 8 px; residual ≤ 1 px). An ArtDoc display list built in the core is drawn by Canvas2D in play and serialized to SVG for goldens. `pixelArt: false`, render scale r. PostFX line boil. | [B F13, F16], [V 1-3, 6, 8] | PF + GF |
| D20 | Format | `dal-level` v2. `world`, `rules` and `compiled` are normative for playing. `ink`, `objects` and `edits` are normative for editing. `design` is informative. **`level_hash` covers gameplay only**, so a renderer change never invalidates runs. | [GF], [J] | PF + GF |
| D21 | Library | Object types are immutable per version, and levels pin `{type_id, version}`. Paper symbols match by chamfer distance against 3 registered samples. Circled letters and names are read by the model. | [J] | GF + PF |
| D22 | Prompt-to-level | The model picks **beats** from a fixed vocabulary. Code lays out the geometry, proves it, and runs a deterministic fixer before any model retry. **The same generator authors Starter World.** | [M D], [J] | GF |
| D23 | Social | Deterministic input replays, verified on the server, power boards, ghosts and "beat my level" links. | [G R5] | all |
| D24 | Starter World | 5 levels with casual C 0.10 / 0.30 / 0.60 / 1.00 / 1.80. Each is verified by the bot in CI. | [G §7.4, §10] | PF + GF |
| D25 | Coexistence | v2 is served at `web/v2.html` and `/api/v2/*`, with new directories only. v1 files are untouched until P6. v2 routers are mounted behind a guarded import, so a v2 error can never take down the running v1 API (uvicorn `--reload` is live). | The app is running now | - |
| D26 | Quality bar | 23 goldens in `shared/golden/`. Each has an `expect.json` with near-cell locators, SVG baselines, a human checklist, and an eval-only LOOK judge. | [J] | all |
| D27 | Safety | `safety_ok` comes from PERCEIVE, or from MODERATE at publish when PERCEIVE was skipped. A refusal holds the level as unlisted. With the model offline, a level publishes with a "not checked yet" badge unless `DAL_REQUIRE_MODERATION=1`. A deterministic blocklist always runs on names and titles. | [M api] | PF + GF |
| D28 | Budget | Per-draft cap $0.40. `DAL_DAILY_BUDGET_USD` defaults to 10. Over budget, the build takes the model-off path. Every call is logged to `model_calls`. | [M lat] | PF |
| D29 | Scope tiers | **T1 (P1-P4):** everything that fixes the two complaints, scrolling, Starter World, and the v1 fixes. **T2 (P5):** library, rules sheet, prompt-to-level, runs and boards, spec publication. **Deferred to v2.x:** `screens_y=2`, rising lava, wall jump, the σ telemetry recalibration loop, GitHub mirroring. | [J] scope | - |

**Owner decisions.** A default is already chosen for each; flip it with a flag.
1. **Fast mode** costs 2× ($10/$50 per MTok). Default **off**. Turn it on with `DAL_FAST_MODE=1` only if the P0 bakeoff shows it at least halves PERCEIVE latency and you accept the cost.
2. **Daily model budget.** Default $10/day and $0.40 per draft.
3. **Lives.** Default **off**: infinite tries with a death counter, as in Celeste. The rules sheet can switch to 3 or 5 lives, Mario style.
4. **Licences.** Default: code MIT; the spec and Starter World CC0; user levels CC-BY-4.0 (attribution matches the remix credit chain).
5. **Paper re-inking.** Default **on**: paper strokes are redrawn in the canonical marker palette. The alternative is to keep the photo's ink colours.

---

## 1. Architecture overview

### 1.1 Pipeline

```
 CANVAS editor ── vector strokes (InkDoc, cells) ─────────────────────────────┐
 PAPER photos (1..6 sheets) ─► CV v2 (Python: rectify, classify, skeletonize) ─┤
 PROMPT text ─► PLAN (Claude, low) ─► core.layoutPlan() ─► blue-line strokes ──┤
                                                                               ▼
                                                InkDoc (strokes + components + features)
                    ┌──────────────────────────────────┼─────────────────────────────────────┐
                    ▼ TS core (browser for canvas, Node worker for paper/server)               ▼ Python, parallel
     perceiveHeuristic ─► G0 ─► normalize ─► fit+compile ─► bot ─► cheapest unsolvable fix     PERCEIVE (Claude low)
                    │                                                    │                     per sheet / 2-screen tile
                    ▼                                                    ▼                          │
       [① INK build] playable (≤0.6 s canvas, ≈2.5 s paper)   greedy tiers (≤3 s) ─► candidates ─► DESIGN (speculative,
                    │                                                    │                          Claude low)
                    │◄───────────── merge ◄── perception edits (set_role, group, bind, link, …) ◄───┘
                    ▼
       [② UNDERSTOOD] G1 = G0 + perception edits + kid edits ─► normalize ─► repair search ─► compile ─► bot
                    │
                    ▼
       candidates(G1) ─► transferPicks(speculative plan) ──ok (≥70%)──► applyPicks per tier (nested) ─► bot after each
                    │                                  └─not ok──► DESIGN #2 (if t < 14 s) ──┘
                    ▼
       [③ DESIGNED] faithful / polished / normal / hard builds + cards + designer note
                    hard deadline 25 s from submit → ship greedy tiers; late picks → "Designer suggestions"
                    │
                    ▼  SSE → preview (stage + design report + dial)  ─►  engine plays the same Sim
```

### 1.2 Stages and budgets

| Stage | Input → output | Runs in | Model | p50 / p90 |
|---|---|---|---|---|
| CV v2 | photo → InkDoc sheet | Python, sheets in parallel | no | 0.6 / 0.9 s per sheet |
| Ink build | InkDoc → level + report + "What I saw (quick look)". Always beatable, using the cheapest R-repair chain of ≤ 3 edits. | TS core: browser (canvas) or worker (paper) | no | 0.15 / 0.4 s per screen |
| Greedy tiers | Ink build → 4 nested tier builds + menu | worker, pool of 3 `worker_threads` | no | 1.2 / 3 s |
| PERCEIVE | annotated tile + component table + typed rules + library list → `Perception` | Python → Claude | low | 10 / 15 s (timeout 20 s) |
| DESIGN (speculative) | Ink menu + digests → `DesignPlan` | Python → Claude | low | 8 / 12 s (timeout 15 s) |
| Understood build | G0 + perception edits → level + full report | worker | no | 0.4 / 0.8 s |
| Transfer + apply | plan + new menu → 4 tier builds | worker | no | 0.6 / 1.2 s |
| DESIGN #2 (only if transfer < 70%) | Understood menu → `DesignPlan` | Claude | low | 8 / 12 s |

### 1.3 Runtime placement

| Concern | Browser | FastAPI (Python) | Node core worker |
|---|---|---|---|
| Canvas editing, live chips, reach halo, ▶ test-play | core in a Web Worker | - | - |
| Paper rectify, classify, vectorize, annotated images | - | OpenCV | - |
| Ink, Understood and Designed builds; tiers; menus | canvas Ink build (preview); local toggles | orchestrates | authoritative builds |
| Model calls | never (no key in the browser) | all | - |
| Publish verification | sends edit statuses + `level_hash` | orchestrates | recomputes from ink + edits; compares hash; re-analyzes |
| Run verification | records inputs | orchestrates | `verifyRun` |
| Prompt-to-level | renders the draft | PLAN call | `layoutPlan` + build + tiers |

Process model:
- The FastAPI lifespan spawns **2** core workers:
  - command: `node web/src/core/worker/main.ts` (cwd = repo root);
  - protocol: JSON lines over stdio;
  - each worker owns a `worker_threads` pool of 3 for candidate verification.
- `vision/app/build/bridge.py` restarts a worker on exit or on a 2 s RPC timeout, and retries once.
- `/api/v2/health` reports the worker state.
- The web app talks only to Vite :5173, which proxies `/api` and `/uploads` (unchanged from v1).

### 1.4 Repository layout (v2 additions; v1 files untouched until P6)

```
shared/
  spec/                 *.schema.json (generated), physics-profiles.json + params.json (generated from core),
                        messages.json, conformance/{levels,replays,events}/, legacy/level-v1.schema.json
  golden/<id>/          input.*, ink.json, prompt.txt?, expect.json, notes.md, shots/*.svg
  starter/              L1..L5.plan.json, L1..L5.overrides.json, expected.json, dist/*.level.json, report.md
  template_spec_v2.json
web/
  v2.html               v2 entry (dev: http://localhost:5173/v2.html)
  src/core/             pure TS, zero deps, erasable syntax, `.ts` import suffixes, no DOM
    index.ts types.gen.ts params.ts tsconfig.json cli.ts
    util/ ink/ scene/ build/ edits/ design/ generate/      (lane B)
    sim/ bot/ difficulty/ replay/                          (lane A)
    art/                                                   (lane E)
    worker/ (main.ts Node stdio server, pool.ts, web.worker.ts browser entry)   (lane B)
    __tests__/
  src/engine/           Phaser v2 engine on core Sim            (lane E)
  src/render/  src/audio/  public/fonts/                     (lane E)
  src/editor/  src/app/                                      (lane F)
vision/app/
  spec/                 Pydantic contracts (source of truth)   (lane B)
  cv/ (new v2 files), template/ (v2 files)                     (lane C)
  mind/ build/ routers/v2/ db_v2.py migrate_v1.py seed_v2.py   (lane D)
vision/evals/  scripts/  docs/spec/level-format-v2.md  docs/v2/{CONTRACTS.md,latency.md,evals/}
```

---

## 2. Level format v2 (`dal-level`, schema_version 2)

### 2.1 Conventions

- **Units and axes.** All coordinates are in **cells**: floats quantized to 1/16 (= 1 world px; ink points use 1/64). The origin is top-left, x points right and y points down. CELL = 16 world px = 5 mm on paper.
- **Bounds.** `bbox` is `[x0, y0, x1, y1]`, half-open.
- **Grounded things.** For anything that stands (player start, enemy, checkpoint, goal), `y` is the **feet line**, which is the top of its support surface.
- **World size.** `w = 48·screens`, with `screens` 1..6. `h = 27`.
- **Strict schemas.** Every schema has `additionalProperties: false`, except `x_*` keys. Those are allowed for extensions, and engines must ignore them.

### 2.2 Full example (2 screens, Polished)

```json
{
  "format": "dal-level", "schema_version": 2, "core_min": "2.0.0",
  "id": "lvl_7c1e9a20", "version": 1, "game_id": "game_0a1b2c3d", "parent_id": null, "order_index": 0,
  "title": "Spike Hop", "author": "maya", "created_at": "2026-10-10T18:00:00Z", "license": "CC-BY-4.0",
  "world": { "cell": 16, "screens": 2, "w": 96, "h": 27 },
  "rules": {
    "version": 3, "physics_profile": "v2-standard", "profile_hash": "sha256:5b1e…",
    "abilities": { "run": true, "stomp": true, "double_jump": false, "fast_fall": true },
    "lives": "off", "hearts": 1, "theme": "sketchbook", "music": true, "timer_pressure": false,
    "camera": "follow", "default_dial": "polished", "default_band": "normal", "player_type": null
  },
  "source": {
    "kind": "canvas", "prompt": null, "pack_id": null,
    "sheets": [ { "index": 0, "photo_url": null, "qr": null }, { "index": 1, "photo_url": null, "qr": null } ]
  },
  "ink": {
    "strokes": [
      { "id": "s1", "color": "black", "kind": "line", "pts": [[0.2,22.45],[14.1,22.2],[29.8,22.6]], "w": [0.74,0.8,0.71], "closed": false, "sheet": 0, "origin": "kid" },
      { "id": "s2", "color": "black", "kind": "line", "pts": [[36.1,22.3],[70.0,22.5],[95.8,22.4]], "w": [0.75,0.76,0.75], "closed": false, "sheet": 0, "origin": "kid" },
      { "id": "s3", "color": "black", "kind": "line", "pts": [[40.0,17.4],[46.9,17.2]], "w": [0.72,0.72], "closed": false, "sheet": 0, "origin": "kid" },
      { "id": "s4", "color": "red", "kind": "line", "pts": [[52,21.6],[52.5,21.0],[53,21.6],[53.5,21.0],[54,21.6],[54.5,21.0],[55,21.6],[55.5,21.0],[56,21.6]], "w": [0.6,0.6,0.6,0.6,0.6,0.6,0.6,0.6,0.6], "closed": false, "sheet": 1, "origin": "kid" },
      { "id": "s5", "color": "red", "kind": "blob", "pts": [[63.2,20.9],[64.6,20.6],[65.1,21.6],[64.0,22.1],[63.0,21.8]], "w": [0.5], "closed": true, "sheet": 1, "origin": "kid" },
      { "id": "s6", "color": "black", "kind": "dot", "pts": [[63.9,21.2]], "w": [0.3], "closed": true, "sheet": 1, "origin": "kid" },
      { "id": "s7", "color": "blue", "kind": "dot", "pts": [[33.0,19.5]], "w": [0.9], "closed": true, "sheet": 0, "origin": "kid" },
      { "id": "s8", "color": "black", "kind": "line", "pts": [[91.0,22.2],[91.1,17.0]], "w": [0.6,0.6], "closed": false, "sheet": 1, "origin": "kid" },
      { "id": "s9", "color": "green", "kind": "blob", "pts": [[91.1,17.0],[93.4,17.6],[91.1,18.4]], "w": [0.6], "closed": true, "sheet": 1, "origin": "kid" },
      { "id": "s10", "color": "black", "kind": "line", "pts": [[22.0,18.0],[22.6,16.8],[23.4,18.1],[24.1,17.0],[24.8,18.0]], "w": [0.5,0.5,0.5,0.5,0.5], "closed": false, "sheet": 0, "origin": "kid" }
    ],
    "components": [
      { "id": 1, "color": "black", "stroke_ids": ["s1"], "bbox": [0.2,21.8,29.8,23.0], "area": 22.1, "f": { "fill": 0.04, "circ": 0.01, "straight": 0.99, "zigN": 0, "zigAmp": 0, "aspect": 24.7, "holes": 0, "w": 0.75, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 2, "color": "black", "stroke_ids": ["s2"], "bbox": [36.1,21.9,95.8,22.9], "area": 44.8, "f": { "fill": 0.03, "circ": 0.0, "straight": 0.99, "zigN": 0, "zigAmp": 0, "aspect": 59.7, "holes": 0, "w": 0.75, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 3, "color": "black", "stroke_ids": ["s3"], "bbox": [40.0,16.8,46.9,17.8], "area": 5.0, "f": { "fill": 0.1, "circ": 0.02, "straight": 0.99, "zigN": 0, "zigAmp": 0, "aspect": 6.9, "holes": 0, "w": 0.72, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 4, "color": "red", "stroke_ids": ["s4"], "bbox": [52.0,20.7,56.0,21.9], "area": 2.6, "f": { "fill": 0.2, "circ": 0.05, "straight": 0.3, "zigN": 1.75, "zigAmp": 0.6, "aspect": 3.3, "holes": 0, "w": 0.6, "corners": 7, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 5, "color": "red", "stroke_ids": ["s5"], "bbox": [63.0,20.6,65.1,22.1], "area": 2.1, "f": { "fill": 0.66, "circ": 0.71, "straight": 0.2, "zigN": 0, "zigAmp": 0, "aspect": 1.4, "holes": 0, "w": 0.5, "corners": 1, "spokes": 0, "bumps": 1, "is_dot": false } },
      { "id": 6, "color": "black", "stroke_ids": ["s6"], "bbox": [63.75,21.05,64.05,21.35], "area": 0.07, "f": { "fill": 0.78, "circ": 0.9, "straight": 0.0, "zigN": 0, "zigAmp": 0, "aspect": 1.0, "holes": 0, "w": 0.3, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": true } },
      { "id": 7, "color": "blue", "stroke_ids": ["s7"], "bbox": [32.55,19.05,33.45,19.95], "area": 0.64, "f": { "fill": 0.79, "circ": 0.92, "straight": 0.0, "zigN": 0, "zigAmp": 0, "aspect": 1.0, "holes": 0, "w": 0.9, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": true } },
      { "id": 8, "color": "black", "stroke_ids": ["s8"], "bbox": [90.7,17.0,91.4,22.2], "area": 3.1, "f": { "fill": 0.85, "circ": 0.05, "straight": 0.99, "zigN": 0, "zigAmp": 0, "aspect": 7.4, "holes": 0, "w": 0.6, "corners": 0, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 9, "color": "green", "stroke_ids": ["s9"], "bbox": [91.1,17.0,93.4,18.4], "area": 1.6, "f": { "fill": 0.5, "circ": 0.55, "straight": 0.1, "zigN": 0, "zigAmp": 0, "aspect": 1.6, "holes": 0, "w": 0.6, "corners": 3, "spokes": 0, "bumps": 0, "is_dot": false } },
      { "id": 10, "color": "black", "stroke_ids": ["s10"], "bbox": [22.0,16.8,24.8,18.1], "area": 1.4, "f": { "fill": 0.3, "circ": 0.1, "straight": 0.3, "zigN": 1.43, "zigAmp": 0.55, "aspect": 2.2, "holes": 0, "w": 0.5, "corners": 3, "spokes": 0, "bumps": 0, "is_dot": false } }
    ],
    "character": { "strokes": [ { "id": "c1", "color": "black", "kind": "line", "pts": [[0.5,0.2],[0.5,1.6]], "w": [0.2,0.2], "closed": false, "sheet": 0, "origin": "kid" } ] },
    "typed_rules": [], "rules_ink": [], "noise": { "count": 2 }
  },
  "objects": [
    { "id": "o1", "components": [1], "strokes": ["s1"], "role": "ground", "conf": 0.93, "role_by": "model", "origin": "kid",
      "shape": { "k": "surface", "segs": [ { "a": [0,22], "b": [30,22], "slope": 0 } ], "fill": "to_bottom" }, "collision": "solid", "rel": {}, "pinned": [] },
    { "id": "o2", "components": [2], "strokes": ["s2"], "role": "ground", "conf": 0.93, "role_by": "model", "origin": "kid",
      "shape": { "k": "surface", "segs": [ { "a": [36,22], "b": [96,22], "slope": 0 } ], "fill": "to_bottom" }, "collision": "solid", "rel": {}, "pinned": [] },
    { "id": "o3", "components": [3], "strokes": ["s3"], "role": "platform", "conf": 0.9, "role_by": "heuristic", "origin": "kid",
      "shape": { "k": "surface", "segs": [ { "a": [40,17], "b": [47,17], "slope": 0 } ], "fill": "one_row" }, "collision": "one_way", "rel": {}, "pinned": [] },
    { "id": "o4", "components": [4], "strokes": ["s4"], "role": "spikes", "conf": 0.95, "role_by": "model", "origin": "kid",
      "shape": { "k": "strip", "a": [52,22], "b": [56,22] }, "collision": "hazard", "rel": { "attached": { "host": "o2", "face": "top" }, "points": "up" }, "pinned": [] },
    { "id": "o5", "components": [5], "strokes": ["s5"], "role": "enemy", "conf": 0.9, "role_by": "model", "origin": "kid",
      "shape": { "k": "body", "bbox": [63.0,20.6,65.1,22.1] }, "collision": "hazard", "rel": { "rests_on": "o2", "parts": ["o6"] },
      "behavior": { "kind": "static" }, "pinned": [] },
    { "id": "o6", "components": [6], "strokes": ["s6"], "role": "enemy", "conf": 0.9, "role_by": "heuristic", "origin": "kid",
      "shape": { "k": "point", "p": [63.9,21.2] }, "collision": "none", "rel": { "part_of": "o5" }, "pinned": [] },
    { "id": "o7", "components": [7], "strokes": ["s7"], "role": "coin", "conf": 0.95, "role_by": "heuristic", "origin": "kid",
      "shape": { "k": "point", "p": [33.0,19.5] }, "collision": "none", "rel": {}, "pinned": [] },
    { "id": "o8", "components": [8], "strokes": ["s8"], "role": "pole", "conf": 0.95, "role_by": "heuristic", "origin": "kid",
      "shape": { "k": "wall", "x": 91.0, "y0": 17.0, "y1": 22.0 }, "collision": "none", "rel": { "part_of": "o9", "rests_on": "o2" }, "pinned": [] },
    { "id": "o9", "components": [9], "strokes": ["s9"], "role": "goal", "conf": 0.95, "role_by": "heuristic", "origin": "kid",
      "shape": { "k": "body", "bbox": [91.1,17.0,93.4,18.4] }, "collision": "trigger", "rel": { "parts": ["o8"] }, "pinned": [] },
    { "id": "o10", "components": [10], "strokes": ["s10"], "role": "decoration", "conf": 0.8, "role_by": "model", "origin": "kid",
      "shape": { "k": "body", "bbox": [22.0,16.8,24.8,18.1] }, "collision": "none", "rel": {}, "pinned": [] }
  ],
  "setpieces": [ { "name": "the spike hop", "ids": ["o4","o5"], "kind": "hazard_run", "by": "model" } ],
  "edits": [
    { "id": "straighten:o1:3f9a01", "op": { "op": "straighten", "target": "o1", "max_shift": 0.85 }, "class": "N", "by": "auto", "stage": "ink", "tier": "faithful",
      "status": "applied", "reason_key": "norm.tidy_lines", "reason_args": { "n": 2 }, "reason_text": null, "depends_on": [], "required": false, "group": "tidy_lines",
      "validation": { "solvable": true, "flags": [], "drift_cells": 0.4, "dC": 0.0 }, "ghost": { "before": [[0,21.8,30,23.0]], "after": [[0,22,30,23]] } },
    { "id": "straighten:o2:9e0b12", "op": { "op": "straighten", "target": "o2", "max_shift": 0.85 }, "class": "N", "by": "auto", "stage": "ink", "tier": "faithful",
      "status": "applied", "reason_key": "norm.tidy_lines", "reason_args": { "n": 2 }, "reason_text": null, "depends_on": [], "required": false, "group": "tidy_lines",
      "validation": { "solvable": true, "flags": [], "drift_cells": 0.45, "dC": 0.0 }, "ghost": { "before": [[36,21.9,96,22.9]], "after": [[36,22,96,23]] } },
    { "id": "form_goal:o9:a1c2e3", "op": { "op": "form_goal", "flag": "o9", "pole": "o8" }, "class": "N", "by": "auto", "stage": "ink", "tier": "faithful",
      "status": "applied", "reason_key": "norm.pole_scenery", "reason_args": {}, "reason_text": null, "depends_on": [], "required": true, "group": null,
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.0 }, "ghost": { "before": [[91,17,92,22]], "after": [[91,17,92,22]] } },
    { "id": "set_collision:o3:77b210", "op": { "op": "set_collision", "target": "o3", "mode": "one_way" }, "class": "N", "by": "auto", "stage": "ink", "tier": "faithful",
      "status": "applied", "reason_key": "norm.oneway_platform", "reason_args": {}, "reason_text": null, "depends_on": [], "required": false, "group": "platforms",
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.0 }, "ghost": { "before": [[40,17,47,18]], "after": [[40,17,47,18]] } },
    { "id": "snap:o4:c09d44", "op": { "op": "snap", "target": "o4", "host": "o2", "face": "top" }, "class": "N", "by": "auto", "stage": "ink", "tier": "faithful",
      "status": "applied", "reason_key": "norm.spikes_snapped", "reason_args": { "facing": "up" }, "reason_text": null, "depends_on": ["straighten:o2:9e0b12"], "required": false, "group": "snap_hazards",
      "validation": { "solvable": true, "flags": [], "drift_cells": 0.4, "dC": 0.0 }, "ghost": { "before": [[52,21,56,21.6]], "after": [[52,21.4,56,22]] } },
    { "id": "set_role:o10:5d6e7f", "op": { "op": "set_role", "target": "o10", "role": "decoration" }, "class": "U", "by": "model", "stage": "understood", "tier": "faithful",
      "status": "applied", "reason_key": "understand.decoration", "reason_args": { "what": "scribble" }, "reason_text": null, "depends_on": [], "required": false, "group": null,
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.0 }, "ghost": { "before": [[22,16.8,24.8,18.1]], "after": [[22,16.8,24.8,18.1]] } },
    { "id": "animate:o5:1a2b3c", "op": { "op": "animate", "target": "o5", "archetype": "walker" }, "class": "P", "by": "model", "stage": "designed", "tier": "polished",
      "status": "applied", "reason_key": "polish.monster_walks", "reason_args": {}, "reason_text": "Your monster walks now, so time your hop!", "depends_on": [], "required": false, "group": null,
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.06 }, "ghost": { "before": [[63,20.6,65.1,22.1]], "after": [[60,20.6,73,22.1]] } },
    { "id": "add_checkpoint:slot.cp.3:44aa01", "op": { "op": "add_checkpoint", "slot": "slot.cp.3" }, "class": "P", "by": "greedy", "stage": "designed", "tier": "polished",
      "status": "applied", "reason_key": "polish.checkpoint", "reason_args": { "seconds": 9 }, "reason_text": null, "depends_on": [], "required": false, "group": null,
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.0 }, "ghost": { "before": [], "after": [[47.5,19.5,48.5,22]] } },
    { "id": "add_big_coin:slot.risk.2:0bd771", "op": { "op": "add_big_coin", "slot": "slot.risk.2" }, "class": "P", "by": "model", "stage": "designed", "tier": "polished",
      "status": "applied", "reason_key": "polish.big_coin", "reason_args": {}, "reason_text": "A big star above the ledge, for brave jumpers.", "depends_on": ["set_collision:o3:77b210"], "required": false, "group": null,
      "validation": { "solvable": true, "flags": [], "drift_cells": 0, "dC": 0.0 }, "ghost": { "before": [], "after": [[43,14,44,15]] } }
  ],
  "compiled": {
    "tiles": {
      "legend": ".#=/\\abcd~X",
      "rows": [
        "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.", "96.",
        "40.7=49.",
        "96.", "96.", "96.", "96.",
        "30#6.60#", "30#6.60#", "30#6.60#", "30#6.60#", "30#6.60#"
      ]
    },
    "entities": [
      { "id": "start", "type": "player_start", "x": 2.0, "y": 22.0 },
      { "id": "o4", "type": "spikes", "host": "o2", "face": "top", "x0": 52.0, "x1": 56.0, "y": 22.0, "facing": "up" },
      { "id": "o5", "type": "enemy", "archetype": "walker", "x": 64.0, "y": 22.0, "w": 1.5, "h": 1.25, "spiky": false,
        "params": { "speed": 2.0, "ledge_aware": true }, "bounds": [60.0, 73.0], "sprite": "o5" },
      { "id": "o7", "type": "coin", "x": 33.0, "y": 19.5 },
      { "id": "e_cp1", "type": "checkpoint", "x": 48.0, "y": 22.0, "origin": "designer" },
      { "id": "e_bc1", "type": "big_coin", "x": 43.5, "y": 14.5, "origin": "designer" },
      { "id": "o9", "type": "goal", "x": 91.0, "y": 22.0, "trigger": [90.75, 17.0, 93.4, 22.0], "sprite": "o9" }
    ],
    "triggers": [],
    "sprites": {
      "player": { "url": "/uploads/lvl_7c1e9a20/player.png", "rig": { "legs": [], "synth_legs": true, "eyes": [], "hip_y": 0.7 } },
      "objects": { "o5": "/uploads/lvl_7c1e9a20/o5.png", "o9": "/uploads/lvl_7c1e9a20/o9.png" }
    }
  },
  "design": {
    "tier": "polished", "band": "easy", "C": 0.14, "score": 13, "fastest_ms": 15120, "par_ms": 20000, "casual_clear_s": 31.5,
    "segments": [ { "from": "start", "to": "e_cp1", "E": 0.02, "T_ms": 7300, "F_s": 0.1, "actions": 6 },
                  { "from": "e_cp1", "to": "o8", "E": 0.12, "T_ms": 7820, "F_s": 0.5, "actions": 9 } ],
    "flags": [], "solvable": true, "reach": { "normal": true, "hard": true },
    "designer_note": "Your level is a spiky hop past a monster. I set your spikes on the ground and added a checkpoint before the hard part.",
    "source": "model"
  },
  "embedded_library": [],
  "meta": {
    "transcript": "", "intent": "a spiky run with a monster", "safety": "ok",
    "level_hash": "sha256:9c4f…", "core_version": "2.0.0", "warnings": [],
    "build": {
      "stages": [ { "stage": "ink", "t_ms": 540 }, { "stage": "understood", "t_ms": 11020 }, { "stage": "designed", "t_ms": 13480 } ],
      "model_calls": [
        { "kind": "perceive", "effort": "low", "latency_ms": 10412, "in_tok": 4410, "out_tok": 870, "cost_usd": 0.044, "stop_reason": "end_turn", "fallback_used": false },
        { "kind": "design", "effort": "low", "latency_ms": 8950, "in_tok": 6120, "out_tok": 730, "cost_usd": 0.049, "stop_reason": "end_turn", "fallback_used": false }
      ],
      "cost_usd": 0.093
    }
  }
}
```

### 2.3 What is normative for what

| Block | Normative for | Notes |
|---|---|---|
| `world`, `rules`, `compiled` | **playing** | A third-party engine needs only these plus `shared/spec/physics-profiles.json`. `rules` is the resolved GameRules snapshot taken at publish, so later rule changes never alter a published level. |
| `ink`, `objects`, `setpieces`, `edits` | **editing and remixing** | `build(ink, graph0, edits)` must reproduce `compiled` byte for byte, for the same `core_version`. |
| `design`, `meta.build` | informative | Metrics, the designer note, model calls and cost. |
| `embedded_library` | self-containment | Every library type the level uses, at its pinned version (§8.1). |

**Versioning rules.**
- Published levels are immutable. An edit after publish creates `version` + 1 with the same `id`. Runs pin `level_version` and `level_hash`.
- A minor schema change may only add optional fields.
- Physics profiles are **immutable by name**. A retune ships as a new name, for example `v2-standard.1`.

### 2.4 Tile alphabet and rasterization (the spec other engines implement)

`compiled.tiles.rows` uses one character per cell, run-length encoded per row as `<count><char>`. The count is omitted when it is 1.

| Char | Shape | Floor height at the cell's left → right edge (px from the cell top) |
|---|---|---|
| `.` | empty | - |
| `#` | solid | full |
| `=` | one-way top. Land from above. Down + Jump drops through. | top edge only |
| `/` `\` | 45° floor rising right / rising left | 16 → 0 / 0 → 16 |
| `a` `b` | 1:2 floor rising right, low half / high half | 16 → 8 / 8 → 0 |
| `c` `d` | 1:2 floor rising left, high half / low half | 0 → 8 / 8 → 16 |
| `~` | lava fill. Hazard; its hitbox top is 4 px below the drawn top. | - |
| `X` | full-cell legacy hazard. **Only for migrated v1 levels.** | - |

Hazards, enemies, doors, keys, springs, saws, firebars, moving platforms, crumble and falling platforms are **entities, never tiles**. That is why a spike strip can never turn its wall into a hazard [B F6].

| Primitive | Rasterization rule |
|---|---|
| Flat segment | Ink top `y_top = y_centre − w/2`. Row `r = round(y_top)`. Cells `x ∈ [round(x0), round(x1))` in row r get `#` or `=`. **Exactly one row per platform** (v1 made 26-91% of surfaces double-thick [B F4]). |
| Ground | The surface row, plus a mass filled down to the world bottom that stops 1 row above any other surface beneath it. |
| Ceiling | One row. If it lies in the top 4 rows and is ≥ 4 cells long, a mass is filled up to row 0. |
| Slope | Endpoints snap to integer x and to the slope lattice. 1:1 becomes `/` or `\`; 1:2 becomes `ab` or `cd` pairs. Neighbouring segments share endpoints, so slopes have no seams or bumps. |
| Wall | Column `round(x_centre − 0.5)`, from `round(y_top)` down to its host row or the world bottom. Width is the fitted width rounded, minimum 1 cell. |
| Spike strip | Facing up on row r's top face: hitbox x ∈ [16·x0 + 2, 16·x1 − 2] px, y ∈ [16·r − 6, 16·r] px. Down, left and right use the same 6 px band on their face. The art teeth are 9 px, slightly larger than the hitbox, which is forgiving. v1 used a 32 px block [B F5]. |
| Enemy | AABB from `fit_creature` (≤ 2×2 cells, ≥ 0.75 cell). The feet sit exactly on the host top. The hurtbox is inset 2 px. |
| Goal | Trigger = the union of the flag and pole boxes, so touching the pole wins (as in Mario). The art is the kid's flag. **The engine never adds a second flag** [B F14]. |
| Coin | A 10 px circle centred on the dot centre, with no cell snapping, so art and pickup coincide [B F14]. |
| Moving / crumble / falling platform | A kinematic one-row AABB, one-way unless the kid drew it filled. The path is in cells. |

### 2.5 `level_hash`

`level_hash = "sha256:" + hex(sha256(canonical_json({world, rules, compiled.tiles, compiled.entities (gameplay fields only), compiled.triggers})))`

- **Canonical JSON:** sorted keys, numbers printed with at most 4 decimals, no whitespace.
- **Excluded:** `ink`, `objects`, `edits`, `design`, `meta`, `sprites`, and art fields (`sprite`, `origin`). A renderer change therefore never invalidates speedruns. A change to fitting that alters tiles does, which is correct because gameplay changed.
- **Publish check:** the server recomputes the hash from ink + graph0 + edit statuses and rejects a mismatch (§11.3).

### 2.6 Migration from v1

Migration runs at boot and is idempotent. The orchestration lives in `vision/app/migrate_v1.py`; the core does the work through the worker method `migrate_v1` (`web/src/core/build/migrate_v1.ts`). The v1 JSON is kept in `levels.json` and the v2 JSON is stored in `levels.json_v2`.

| v1 | v2 |
|---|---|
| `schema_version: 1`, `grid` 48×27 | `world.screens = 1` |
| `grid.rows` `'1'` | `#` tiles, plus synthesized terrain objects (one per maximal horizontal run, walls per vertical stack), emitted as `migrated` ink strokes so they can be remixed in the v2 editor |
| `'2'` runs with a solid neighbour | A spike strip on that host, facing the open side. Other `'2'` cells become `X` legacy tiles. |
| `player_start`, `goal`, `coin`, `checkpoint`, `key` + `door`, `bounce_pad`, `moving_platform` | The same entities, typed. A `bounce_pad` becomes a `spring` of strength 1.0. Zero-length paths are dropped with a warning (fixes [V 1]). |
| `enemy` + `patrol` | Under `v1-classic`: a `flyer` with a horizontal pattern, so it plays exactly as before (no gravity). After "Upgrade to v2": a `walker` with gravity, grounded by `snap`. |
| `rules` (`collect:`/`touch:`/`timer:` → `open:`/`win`/`lose`) | `compiled.triggers`, unchanged |
| `source.backdrop_url` | `source.sheets[0].sketch_url`. The art is re-traced from tiles (marching squares plus seeded wobble) and drawn by the v2 renderer, so there is one style. |
| physics | `rules.physics_profile = "v1-classic"` |

- **"Upgrade to v2" button.** It re-runs the level under `v2-standard` through the Faithful build and saves the result as a new version.
- **Acceptance.** Every v1 fixture and seeded level migrates, validates, and gives **the same reachable set as the v1 solver** under `v1-classic` (G23).
- **Classic game.** The v1 Starter World becomes the game "Classic Starter".

---

## 3. The level-design mind

### 3.1 The build function (pure, deterministic)

```
G1    = apply(G0, U-edits(perception, kid, library))                 // understanding
N     = normalize(G1)                     → EditRecords (class N), stable ids, statuses honoured
G2    = apply(G1, N accepted)
L     = compile(G2); R0 = bot.analyze(L, fast)
if repairUnsolvable and (!R0.solvable or R0.hardFlags):
   R   = repairSearch(G2, R0)             → class R edits (≤ 4 rounds)                         (§3.7)
D     = stored P/C/K edits for this tier, re-validated against G2+R; failures → status 'rejected' with reason
level = compile(apply(G2, R ∪ D accepted)); report = bot.analyze(level, full)
```

- **Inputs:** `{ink, graph0, edits (with statuses), rules, library, parent, tier, repairUnsolvable}`.
- **Determinism:** same inputs give byte-identical `level` and `report` in the browser and in Node, for the same `core_version`.
- **Toggling an edit** is a rebuild. Local rebuild budget: < 150 ms per screen with fast analyze; full metrics in ≤ 1 s in a Web Worker.

### 3.2 InkDoc (the only thing that crosses from seeing to building)

```ts
type InkColor = 'black' | 'red' | 'green' | 'blue' | 'pencil' | 'draft';   // pencil = designer, draft = prompt blue-line
type Origin   = 'kid' | 'parent' | 'designer' | 'library' | 'draft' | 'migrated';
interface InkStroke {
  id: string; color: InkColor; kind: 'line' | 'dot' | 'blob';
  pts: [number, number][];     // cells, 1/64 precision. line: centreline; blob: closed contour; dot: [centre]
  w: number[];                 // width per point in cells (dot: [diameter])
  closed: boolean; sheet: number; origin: Origin;
  stamp?: StampKind;           // canvas stamp: coin|big_coin|spikes|flag|checkpoint|spring|saw|walker|hopper|flyer|key|door|start|library
  label?: Role;                // kid chip, conf 1.0 ("pinned")
  rule?: Behavior;             // kid "What does it do?" chip
  lib?: { type_id: string; version: number };
  t?: number;                  // canvas creation order
}
interface InkComponent { id: number; color: InkColor; stroke_ids: string[]; bbox: [number, number, number, number]; area: number;
  f: { fill: number; circ: number; straight: number; zigN: number; zigAmp: number; aspect: number; holes: number;
       w: number; corners: number; spokes: number; bumps: number; is_dot: boolean } }
interface InkDoc { v: 2; source: 'canvas' | 'paper' | 'prompt' | 'migrated';
  world: { screens: number; w: number; h: 27 };
  strokes: InkStroke[]; components: InkComponent[];
  character: { strokes: InkStroke[] } | null;
  typed_rules: { text: string; target?: number }[];   // a rule typed while a stroke is selected carries its component id
  rules_ink: string[];                               // paper rules-box stroke ids
  sheets: { index: number; photo_url?: string; qr?: string; warnings: MessageRef[] }[];
  noise: { count: number };
  parent: { level_id: string; version: number; level_hash: string } | null }
```

**Canvas.**
- Pointer samples are resampled to 0.125 cell and simplified by RDP with ε 0.03 cell. Width comes from `pointer.pressure`.
- A **tap** (< 4 px of movement and < 250 ms) becomes a `dot` 0.875 cell (14 px) across [B F7].
- Components are unions of same-colour strokes that touch (gap ≤ 0.5·w), computed in TS with no image processing.

**Paper.** `vision/app/cv/vectorize.py` takes the v1 rectify and Lab classify output (kept, because it is reliable [M "Model vs deterministic"]) and does the following:
1. Builds per-colour masks **without** the cell/4 dilation [B F4].
2. Runs connected components.
3. Classifies a component as a dot when its max side is ≤ 0.9 cell and its fill is ≥ 0.5.
4. Classifies it as a blob when the distance transform exceeds 0.45 cell on ≥ 30% of skeleton pixels, giving a contour.
5. Otherwise skeletonizes it with `cv2.ximgproc.thinning` (Zhang-Suen).
6. Builds a skeleton graph. Junction clusters within 3 px are merged. Spurs shorter than max(0.4 cell, 1.5·w) are pruned.
7. At each junction, pairs edges by the straightest continuation (turn < 35°), so a pole on a floor stays its own stroke.
8. Simplifies with RDP ε 0.06 cell. Width = 2 × the median distance transform along the skeleton.
- **Never drop ink.** Marks ≥ 0.03 cell² are kept. Smaller marks are counted as `noise` and shown as "I ignored N tiny specks".
- **Raster ingest.** The same path ingests any drawing-area PNG with no rectification: v1 canvas drafts, golden PNGs and migration.

### 3.3 Perception: roles, relations, heuristic, model merge

**Roles** (22). "Collision" is the default; `set_collision` can change it.

| Role | Collision | Compiles to | Default behavior |
|---|---|---|---|
| `ground` | solid | fitted surface + mass to the world bottom | static |
| `platform` | **one-way** if a thin floating stroke (median w ≤ 0.9 cell, no ink below); solid if filled (fill ≥ 0.4) or attached to a wall | fitted surface, 1 row | static |
| `wall` | solid | column(s) | static |
| `ceiling` | solid | fitted underside (+ mass to row 0 if within the top 4 rows) | static |
| `spikes` | hazard band | spike strip `{host, face, x0..x1, facing}` | static |
| `lava` | hazard fill | `~` tiles in the pit | animated |
| `saw` | hazard | saw entity | static unless bound to move |
| `enemy` | creature | enemy with the kid's sprite (all parts) | **static in Faithful**; Polished `animate` → walker 2 c/s (§3.5 P7) |
| `coin` / `big_coin` | pickup | coin / big coin | - |
| `key` / `door` | pickup / solid until opened | key and door entities | a key requires `opens` |
| `spring` | solid top | spring | up, strength 1.0 |
| `checkpoint` / `goal` | trigger | checkpoint / goal (the pole becomes a scenery part) | - |
| `pole` | none | goal part (scenery) | - |
| `start_marker` | none | sets `player_start` | - |
| `text` / `arrow` | none | not built; feeds bindings; rendered as a graphite sign | - |
| `decoration` | none | soft art at 55% (§7.1) | - |
| `library_tag` | none | resolves to a library instance | - |
| `unknown` | **none** (D5) | decoration with an "Is this right?" chip | - |

**Relations** on each object:
- `rests_on: id`;
- `attached: {host, face: top|bottom|left|right}`;
- `points: up|down|left|right|none`;
- `part_of` / `parts`;
- `refers_to` (for text and arrows: the object they describe).

**Grouping**, which runs before roles (`core/scene/group.ts`, [GF 4.4] + [MF R-detach]):
1. **Containment.** A stroke whose bbox centre lies inside a closed loop, and whose bbox fits in the loop's bbox grown by 0.2 cell, is a part of the loop. This covers monster eyes and mouth [B F8].
2. **Flag and pole.** A green glyph within 0.4 cell of the top 40% of a near-vertical stroke (\|θ\| ≥ 70°, straight ≥ 0.85, len ≥ 1.2) forms `{flag, pole}`. An all-green "Γ" counts too (owner draft `d_b14b143e`).
3. **Trunk.** Near-vertical black strokes whose tops touch the underside of a closed loop join that loop. This is the tree [B F2].
4. **Text cluster.** Same-ink strokes with max side ≤ 1.6 cells, bottoms aligned within 0.6 cell and gaps ≤ 1.0 cell. Also a single stroke with ≥ 4 corners inside a 1.6-cell box.
5. **Arrow.** A straight shaft (len ≥ 1.5, straight ≥ 0.9) with 1-2 short strokes (len ≤ 1.2) at one end at 20-70°.
6. **Detach.** A text or arrow skeleton connected to terrain by one junction whose branch area is ≤ 3 cells² is split off with `detach`. This is the "j" descender wall [B F3].
7. **Collinear fragments.** Flat same-ink strokes with Δy ≤ 0.3 and gap ≤ 0.6 cell form one surface. This is the split ledge [M fail 5].

**Heuristic grammar** (`core/scene/grammar.ts`). Rules H1-H22 each score a glyph from 0 to 1. Role = argmax; `alt` = the next two. User labels and stamps always win with confidence 1.0.

| # | Ink | Signature (cells) | Role | Base conf | Fixes |
|---|---|---|---|---|---|
| H1 | blue | dot, or closed loop ⌀ ≤ 1.2 | coin | 0.95 | taps dropped 5/6 [B F7] |
| H2 | blue | loop ⌀ ≤ 1.5 + stem ≥ 0.8 (aspect ≥ 1.8) | key | 0.85 | |
| H3 | blue | 5-point star | big_coin | 0.85 | |
| H4 | green+any | flag-and-pole group | goal; pole = scenery | 0.95 | pole wall 6/6 [B F1] |
| H5 | green | area ≤ 6, ≥ 3 corners, no pole | goal (rightmost); others checkpoint | 0.80 | "largest green" [B F2] |
| H6 | green | closed scribble area > 6, or crown on a trunk | decoration (tree) | 0.80 (0.55 if it is the only green) | tree = goal [B F2] |
| H7 | red | closed loop/blob, circ ≥ 0.35, area 0.8-9; +0.1 with internal parts | enemy | 0.75-0.90 | [B F8] |
| H8 | red | zigN ≥ 1.5 per cell, ≥ 3 teeth, zigAmp 0.2-1.5 | spikes | 0.90 | [B F5] |
| H9 | red | straight (≥ 0.9) line within 1.5 cells of, and parallel to, a surface face | spikes (flat strip) | 0.75 | [V §0] red line floating |
| H10 | red | straight line or blob inside a pit (between two surface ends, below their tops) | lava | 0.80 | drawing 5 |
| H11 | red | circle with ≥ 5 radial ticks | saw | 0.6 | |
| H12 | black | zigN ≥ 1.5 per cell | decoration (grass) 0.55 / spikes alt 0.45 → **ask** | 0.55 | `d_dfbfe619` 1-cell walls [G §3.1] |
| H13 | black | closed loop with ≥ 5 spokes | decoration (sun) | 0.90 | sun = sky blocks [B F2] |
| H14 | any | bumpy loop (bumps ≥ 4) in the top 40%, no surface within 2 below | decoration (cloud) | 0.75 | |
| H15 | any | text cluster | text | 0.85 | "jump!" wall [B F3] |
| H16 | black | arrow group | arrow (+direction, `refers_to` nearest object within 2 cells of the tail) | 0.85 | arrow fused [B F3] |
| H17 | black | fitted \|θ\| ≤ 55°, len ≥ 2, residual ≤ 0.35 | ground if its lowest point is in the bottom 25% of the world or it spans ≥ 50% of a screen near the bottom; ceiling if in the top 30% with something hanging under it or capping two walls; else platform | 0.90 | |
| H18 | black | filled blob touching the world bottom | ground (mass) | 0.80 | |
| H19 | black | \|θ\| ≥ 75°, len ≥ 1.2, bottom within 0.6 of a surface or the world bottom; not a pole | wall | 0.85 (0.60 floating) | |
| H20 | black | full-height bar floor-to-ceiling while the level has exactly one key | door (link to the key) | 0.60 → ask | key → coin [M "v1 reproduction"] |
| H21 | any | circle 1-2.5 across with one inner glyph, or chamfer match ≤ 0.12 cell to a library symbol | library_tag / that type's role | 0.80 | §8.1 |
| H22 | any | nothing matched | **unknown → decoration (non-colliding)** | 0.30 → ask | never drop ink; D5 |

**Calibration.**
- `cli.ts calibrate` fits an isotonic table per rule (`core/scene/calibration.ts`, generated) on golden labels, so that **conf ≥ 0.75 means ≥ 95% precision**. In [M A], meaningful errors sat at 0.4-0.7 and 0.75 is the natural ask threshold.
- **Gate:** the heuristic gets ≥ 90% role accuracy on G01-G14 with the model off (P1).

**Start, relation and binding rules (deterministic).**
- **Start position:**
  - the lowest standable cell under or next to a `start_marker` or start stamp;
  - otherwise the lowest standable cell in the 8 leftmost columns with ≥ 3 free rows above, never a ceiling top and ≥ 0.5 cell from the world edge. This fixes the cave-roof spawn [M B] and the mid-level spawn [M v1].
- **Spikes host:** a face parallel to the strip within 1.5 cells perpendicular with ≥ 40% overlap. Otherwise the nearest surface below within 3 cells. Facing = away from the host [M fail 3].
- **Enemy host:** the surface below within 3 cells with ≥ 50% overlap. With no host, the enemy is a `flyer` hover.
- **Typed rules parser** (`core/scene/rules_parser.ts`, offline):
  - patterns: `<target> moves|slides [dir] [N]`, `<target> walks|hops|flies|shoots|chases|crushes`, `is bouncy`, `crumbles`, `key opens door`, `N seconds`, `make it easy|hard`;
  - adjectives narrow the target: high/top, low, left/first, right/last, big/long, small;
  - ground objects spanning > 60% of a screen are never `move` targets;
  - **when several objects match, it asks** ("Which platform moves? Tap it.") and never picks "the largest" [B F10];
  - a rule typed while a stroke is selected binds to that component, exactly.

**Model merge** (`core/scene/merge.ts`). The model's `Perception` becomes **perception edits** relative to G0, so every model change is visible and can be undone:
1. Ids are checked:
   - unknown or invented ids are dropped [M A: id 17];
   - a role not allowed for the ink colour is dropped (blue `wall`);
   - if > 30% of nodes are invalid, the whole perception is discarded.
2. Roles are reconciled by model confidence (enum: high = 0.9, medium = 0.75, low = 0.5):
   - the model's role wins when its confidence is ≥ medium, or when the heuristic confidence is < 0.75;
   - otherwise the heuristic stands and the model's role is offered as the first re-label chip.
3. Relations are validated geometrically: `rests_on` within 3 cells along the face, `part_of` within 2 cells. Failures become "unsure" chips.
4. Bindings come only from the model's typed union. A missing required field (a key with no door) becomes an **Ask card**, never a silent downgrade [M v1].
5. **The keyword parser runs only when there is no model answer for that sentence; it is never merged on top** [B F10].
6. Setpieces: the model names 1-4 (`"the spike valley"`). Offline fallback: every kid hazard, enemy, spring, key or door within 2 cells of the Faithful route is a geometric setpiece. Both feed invariant I3.
7. Any gameplay-relevant object whose final confidence is < 0.75 gets an "Is this right?" chip with one-tap re-labels.

### 3.4 Geometry fitting (`core/build/fit.ts`)

- **Top envelope.** Per 1 px column, take the top of the ink (the bottom for ceilings).
- **Piecewise fit.** Recursive splitting into ≤ 6 segments. Each segment angle snaps to {0°, ±26.57° (1:2), ±45° (1:1)}. A split is accepted only if the snapped fit deviates from the centreline by **> 0.35 cell**.
  - A wobbly near-horizontal line becomes one flat segment (4-13 bumps → 0 [B F4]).
  - A ~37° ramp becomes one slope, not a 9-row staircase (drawing 6).
  - 55-75° becomes slope 1:1 plus a wall, with conf 0.6 (ask). Above 75° it is a wall.
- **Snap.** `row = round(y_top)` adds ≤ 0.5 cell. Together with the ≤ 0.35 cell fit residual, the per-column shift from the ink top is ≤ 0.85 cell (13.6 px); it is typically ≤ 8 px. Thickness comes from the role, not from pixel coverage (§2.4).
- **close_gap.** Collinear same-role surfaces with a gap ≤ 1.0 cell and Δy ≤ 0.5 after snapping, with no hazard inside, are joined.
- **Collision mode** for floating platforms follows the role table. One-way removes the head-bonk in `d_b14b143e` [G §3.1].

### 3.5 The fixed edit vocabulary (43 ops)

Rules for every op:
- Each op is a typed variant in `core/edits/vocabulary.ts` with `precondition`, `apply`, `explain → reason_key` and **clamped bounds**, whoever proposes it.
- Targets are **object ids**.
- Added content goes **only into slot ids** from the bot's slot lists (`slot.cp.3`, `slot.enemy.7`).
- After every op, the invariants are checked and the affected segments are re-verified. Failure means status `rejected` plus a logged reason; the op never becomes a visible card.

**U · Understand.** Allowed at every dial position. Emitted by the heuristic, the model or the kid.

| Op | Params | Bounds and guards |
|---|---|---|
| U1 `set_role` | target, role | The role must be allowed for the ink colour (black: terrain, wall, ceiling, door, pole, decoration, text, arrow, spikes; red: hazards, enemy, text, decoration; green: goal, checkpoint, decoration; blue: coin, big_coin, key, decoration). It can never make the start's only support non-colliding or moving (this fixes the zero-length "moving ground" crash [V 1]). |
| U2 `group` | root, parts[] | Each part is ≤ 2 cells from the root. Parts move, animate and collide with the root [B F8]. |
| U3 `detach` | target, branch | Branch area ≤ 3 cells². Splits fused text or arrows from terrain. |
| U4 `bind` | target, behavior | Typed `Behavior` union (§5.7-5.8). Ground spanning > 60% of a screen cannot move. Paths are clipped to the world. |
| U5 `link` | key, door | Both exist; the door is wall-like. |
| U6 `set_start` | near | Resolves through N7. |
| U7 `use_library` | target, type_id, version | The type exists in the game library. |

**N · Normalize.** Always applied, at every dial position. Shown as grouped cards.

| Op | Params | Bounds |
|---|---|---|
| N1 `straighten` | target, mode flat\|slope_1_2\|slope_1_1 | per-column shift ≤ 0.85 cell (fit residual ≤ 0.35 + row snap ≤ 0.5) |
| N2 `close_gap` | a, b | gap ≤ 1.0 cell, Δy ≤ 0.5, same role family, no hazard in the gap |
| N3 `snap` | target, host, face | distance ≤ 2.5 cells (spikes), ≤ 3 (enemy, key, checkpoint, spring, door); clipped to the face extent; the face is explicit, never guessed [M fail 3] |
| N4 `orient` | target, facing | away from the host face (spikes, springs) |
| N5 `form_goal` | flag, pole? | the pole becomes scenery; trigger = flag ∪ pole; grounded ≤ 6 cells [B F1] |
| N6 `set_collision` | target, mode solid\|one_way\|none | thin floating platform → one_way; decoration, text, arrow and pole → none |
| N7 `place_start` | (computed) | the §3.3 start rule |
| N8 `clear_spawn` | (computed) | hazards ≥ 2 cells and enemy patrols ≥ 4 cells from the start and checkpoints. Moves the start ≤ 4 cells along its surface, otherwise trims the patrol. **Never deletes a hazard** [B F11]. |
| N9 `coin_from_dot` | target | blue dot of any size |
| N10 `dedupe` | keep, drop | same type within ≤ 0.75 cell; keeps the parent's (remix) |
| N11 `join_seam` | a, b | both ends within 0.75 cell of a sheet seam, Δy ≤ 1 cell |
| N12 `fix_behavior` | target, param, value | a degenerate path is fitted to the available room (≥ 2 cells); otherwise the behavior is dropped and a card explains why [V 1] |
| N13 `fit_creature` | target | hitbox from the glyph bbox, ≤ 2×2 cells keeping the aspect, ≥ 0.75 cell; feet on the host |

**R · Repair.** Faithful and above. Used **only while a hard constraint fails** (unsolvable, or a fairness flag).

| Op | Params | Bounds | Base cost |
|---|---|---|---|
| R1 `nudge` | group, dx, dy | \|dx\| ≤ 3, \|dy\| ≤ 3, \|dx\|+\|dy\| ≤ 3 per group; Σ ≤ 8 cell-moves per level; the whole `part_of` group and anything it carries moves together [M fail 5] | 1.0 per cell in x, 1.5 per cell in y |
| R2 `trim` | target, side, cells | 1-2 cells; result ≥ 2 cells long. Lowering a wall = trimming its top. | 1.2 per cell |
| R3 `extend` | target, side, cells | 1-3 cells into empty space (landings, runways) | 0.8 per cell |
| R4 `add_step` | slot, w | w 2-3, in designer pencil | 6 |
| R5 `add_spring` | slot, strength 0.6-1.4 | rejected if the route then skips a setpiece [M C bounce pad] | 8 |

**P · Polish.** Polished and above.

| Op | Params | Bounds |
|---|---|---|
| P1 `add_checkpoint` | slot | flat ≥ 3 cells; ≥ 3 cells from hazards and enemy paths; ≤ 1 per screen; none in the first 24 cells. Purpose: every segment F_s ≤ 30 s and T_s ≤ 40 s. |
| P2 `add_coin_trail` | action, n | n 3-7 coins on the bot's actual arc (100% valid in [M C]); ≤ 1 per required jump; over run-up gaps, jumps > 5 cells and blind jumps |
| P3 `add_coin` | slot | ≤ 10 coins per screen in total |
| P4 `add_big_coin` | slot | ≤ 3 per level; optional and returnable; detour p_death ≥ 0.1, or reachable only by a stomp bounce |
| P5 `add_hint_arrow` | slot, dir | ≤ 1 per screen; for blind drops and hidden routes |
| P6 `tune` | entity, param, step +1\|+2 | Moves to the next value on the param grid (§5.7, §5.8). **Raise only.** Never touches pinned params. In Polished, only while C ≤ 0.3. |
| P7 `animate` | enemy, archetype walker | A static drawn creature with a host ≥ 4 cells becomes a ledge-aware walker at 2 c/s ("Your monster walks now"). |
| P8 `set_par` | - | par = ceil_0.5(1.3 × bot fastest). Automatic. |

**C · Challenge.** Challenging only.

| Op | Params | Bounds |
|---|---|---|
| C1 `widen_gap` | gap, cells | +1 (Normal), +2 (Hard); never beyond `g_max(runway) − 1` |
| C2 `shrink_landing` | surface, side, cells | −1 or −2; the landing stays ≥ 2 cells |
| C3 `shift_platform` | group, dx, dy | Normal \|dx\|, \|dy\| ≤ 1; Hard ≤ 2 |
| C4 `add_spikes` | slot (host, face, x0..x1) | 1-6 cells; **undrawn faces only** (no kid ink within 1 cell); ≥ 3 cells from spawn and checkpoints; leaves a landing ≥ 2 |
| C5 `add_enemy` | slot, archetype | Normal: walker or hopper. Hard: also flyer, shooter, chaser, crusher. Walker and chaser need a flat ≥ 8 cells; hopper a flat ≥ 6 with headroom ≥ 4; flyer 3×3 of clear air. ≥ 6 cells from spawn and checkpoints. |
| C6 `add_hazard` | slot, kind | saw (Normal, Hard); firebar or lava fill (Hard). ≥ 1 cell clear of ink; saw path ≤ 8 cells |
| C7 `make_crumble` | surface | ≤ 6 cells; never the start, checkpoint or goal surface; the route must not revisit it |
| C8 `set_timer` | k ∈ {1.5, 1.75, 2.0} | × the bot's fastest time; only with `rules.timer_pressure` |
| C9 `reprise` | setpiece, slot, escalation faster\|plus_saw\|plus_spikes\|narrower | Levels ≥ 3 screens; ≥ 10 empty cells; 1 per level. A macro that expands into C/P atoms sharing a `group` id, shown as one card. |

**K · Kid.**

| Op | Params | Effect |
|---|---|---|
| K1 `make_mine` | target | A designer or draft object becomes kid ink (origin `kid`). It is still undoable, and I1 now protects it. |

Kid re-labels, chips and Ask answers are U-ops with `by: 'kid'`.

### 3.6 Intent cost and intent invariants

```
cost(e) = Σ_moved (|dx|·1.0 + |dy|·1.5) · size(o) · w_role(o)      size(o) = clamp(sqrt(len_cells/4), 0.75, 2)
        + 1.2·trim_cells + 0.8·extend_cells
        + 2.0·[role change on a kid object] + 1.5·[collision change on a kid object]
        + 3.0·[topology: opens a passage through a kid wall, or closes a kid gap > 1 cell]
        + 4.0·[detached pillar: lifts a wall or ledge off its support]
        + add: 0.5 pickup/checkpoint/arrow · 1.0 hazard/enemy · 6 add_step · 8 add_spring
        × 2 when any target is text-labelled or has pinned params
w_role: ground 2.0 · goal 2.0 · wall 1.5 · hazard 1.5 · enemy 1.5 · platform 1.0 · coin 0.3
ties → op order, then smaller x, then object id (deterministic in browser and Node)
```

The topology and pillar terms are what make "lower the wall by 2" beat "lift the wall into a floating pillar" [M B wobbly_cave].

| # | Invariant (checked after every edit; a violation rejects the edit) | Check |
|---|---|---|
| I1 | Every kid object survives with its role family. Roles change only through U-ops, which are shown. | multiset of (kid object id, role family) |
| I2 | Drift. N1/N2 terrain: ≤ 0.85 cell per object (§3.4). N3/N5/N8 placements stay within their own op bounds (≤ 2.5, 3, 6 and 4 cells). R: ≤ 3 per object and ≤ 8 per level, and only while a hard constraint fails. Exception: in Polished and above, an R1 of ≤ 2 cells is allowed to make a drawn pickup reachable (`unreachable_drawn`). Designer geometry: Polished 0, Normal ≤ 1, Hard ≤ 2 per object; ≤ 10 per level. | fitted-shape displacement vs the Faithful base |
| I3 | **Setpieces and route order.** Setpieces are the model-named ones (1-4), or geometric ones offline. They must appear on the new critical path in the same order (ordered subsequence), and no edit may create a route that passes a setpiece by more than 2 cells. | bot route vs the setpiece list |
| I4 | Text-pinned params never change ("slow platform", "the monster walks"). | `pinned` |
| I5 | Added content looks added: pencil ink, a card, undoable. | origin → render style |
| I6 | Solvable, and **no new hard flag** (§4.3): no edit may introduce a fairness flag the Faithful build did not have. R repairs try to clear Faithful's own flags first. | bot |
| I7 | **Never easier than drawn.** Designer tiers never shrink or remove kid hazards or enemies and never lower C below C_faithful. Repairs ease only what solvability or fairness requires. | metric and object diff |
| I8 | **The drawing stays the star.** Added non-coin objects ≤ max(2, ⌊0.5 × kid objects⌋) per level; ≤ 1 per screen in Polished and ≤ 3 per screen in Challenging. | count |

### 3.7 Normalize order and the repair search

**Normalize order** (deterministic; every step emits stable-id EditRecords):
1. U-edits from merge, the kid and the library.
2. N1 straighten every surface. **Height changes of 1 row between flat runs become 1:2 ramps (2 cells per row), never vertical steps**, unless the drawn ink turns steeper than 55° over ≥ 0.75 cell (a drawn step). Gentle wobbles and rises therefore produce 0 bumps [B F4, B sweep].
3. N2 close_gap and N11 join_seam.
4. N6 set_collision.
5. N3 snap, then N4 orient: spikes, enemies, keys, checkpoints, springs, doors.
6. N5 form_goal.
7. N12 fix_behavior and the structural validator (below).
8. N7 place_start, then N8 clear_spawn.
9. N10 dedupe (remix only).
10. N13 fit_creature.

**Structural validator** (`core/build/validate.ts`). It runs before any simulation. Each check either auto-fixes or blocks publishing with a message.

| Check | Auto-fix | Otherwise |
|---|---|---|
| The start is standable and not inside an entity | N7 | block |
| A moving path is ≥ 2 cells and inside the world | N12 | drop the behavior + card |
| A ground object spanning > 60% of a screen is not dynamic | drop the binding + card | - |
| Every key has a door and every door has a key | the orphan key becomes a coin + an Ask card | - |
| Exactly one goal exists | synthesize one at the rightmost standable cell in pencil (an edit) | - |
| No same-type entities within 0.5 cell of each other | N10 | - |

**Repair search** (`core/design/repair_search.ts`, [GF 5.2]). It runs only while the bot reports `unsolvable` or a hard flag:

```
for round in 1..4 while (!pt.solvable or pt.hardFlags):
  f = classify(pt.firstFailure)                    // the unreached setpiece nearest the frontier, in route order
  C = GENERATORS[f.kind](f)                        // ≤ 64 candidates, each 1-2 ops, all inside vocabulary bounds
  for c in C sorted by cost: sandbox = apply(c); local = analyze(sandbox, window = f.x ± 1.5 screens)
      keep c if local.frontier advanced and invariants(sandbox) hold
  choose cheapest c that makes the window solvable, else largest frontier gain per unit cost
  keep the 2 next-cheapest solvable options as an `alts` group for DESIGN (repair_choices)
if still failing: report in plain words ("I couldn't find a way across this 10-cell gap without moving your drawing more than 3 cells") + Fix-it menu
```

| Failure kind | Detected as | Candidate generators (cheapest first) |
|---|---|---|
| `gap_too_wide` | no policy lands on the next surface; gap g, runway r | R1 nudge the far surface closer by g − g_max(r) (≤ 3); R3 extend the near or far edge (≤ 3); R3 extend the runway to 3 cells; R4 add_step mid-gap |
| `ledge_too_high` | the landing top is Δ rows above the takeoff, beyond the envelope at the available speed | R1 nudge the target down (≤ 3); R4 add_step; R5 add_spring |
| `head_bonk` | the arc hits an overhang before its apex and loses ≥ 1 cell of reach (`d_b14b143e` bonks at frame 8 [G §3.1]) | N6 one-way (if the overhang is a thin platform); R2 trim the overhang (≤ 2); R1 nudge the overhang up (≤ 2) |
| `wall_too_tall` | wall height exceeds the max jumpable from the available speed | **R2 trim the top (≤ 2), preferred over lifting** (+4 detached-pillar penalty); R4 add_step at its base; R5 add_spring |
| `goal_unreachable` | no reachable trajectory touches the goal trigger | N5 ground the goal (≤ 6); R1 nudge its surface; R3 extend |
| `spawn_trapped` | < 4 reachable nodes | N7 on the next-lowest standable surface |
| `key_unreachable` | key unreachable with the door closed | the gap and ledge generators, aimed at the key's surface |
| `hard_flag` | tight window, blind jump or spawn danger on a required action | R3 extend the landing; R1 nudge closer; N8 |

**Ink-stage guarantee.** The Ink and Understood builds run with `repairUnsolvable: true`, so the child always gets a beatable level before any model output. The applied chain is ≤ 3 R-edits, shown as cards. The editor's ▶ test-play uses `repairUnsolvable: false`: it plays the drawing as drawn, with only the normalizers applied.

**Worked examples on the evidence** (the expected outcomes, encoded in the golden `expect.json`):

| Input | v1 outcome | v2 normalize | v2 repair |
|---|---|---|---|
| Drawings 1-6, flag pole | 4-5 cell wall; goal floating behind it [B F1] | H4 groups pole + flag; N5 pole = scenery, goal at the pole foot | none |
| Drawing 1 spike_hop | spikes as a 6×2 block; spawn 1 cell from spikes; tap dropped [B §1] | N3 snaps the strip onto platform 1 (dy ≤ 1), facing up; N8 moves the start ≥ 2 cells away; H1 tap → coin; gentle floor → flat + 1:2 ramp, 0 bumps | none |
| Drawing 2 spike_cave | 13 bumps; wall spikes made the wall a hazard; 2-row ceiling spikes [B §2] | N1 → 0 bumps; wall spikes face left on the wall face, wall solid; ceiling spikes face down | none |
| Drawing 3 monster_meadow | the tree is the goal; the trunk walls in 9 cells [B F2] | H6 tree (trunk is a part) = decoration; H13 sun = decoration; H4 the small flag = goal; H7 + containment: monster with eyes; "walks back and forth" → walker, pinned | none (the counterfactual has 58 reachable cells) |
| Drawing 4 model off | "jump!" + arrow became terrain; reachable 41 → 26 [B F3] | H15 text, U3 detach of the "j" descender, H16 arrow → `move` hint, cells = shaft length (≈ 8) | none |
| Drawing 5 big_leap | a 7-empty-cell gap ships silently [B F12] | H10 lava | v2 run-jump clears 8 cells with ≥ 3 cells of runway, so the drawn gap is solvable as drawn; if the runway is < 3, R3 extends it |
| Drawing 6 kid_full_level | 9-row staircase; spawn spikes walk; goal unreachable [B §6] | ramp → one slope; only the monster walks (no keyword merge); spikes snapped onto platform 2; N8 | `ledge_too_high` → R1 nudge goal platform ≤ 3 + R3 extend ≤ 2, or R4 one step; the cheapest by cost |
| Owner `d_b14b143e` | stepping stone 6 rows up; head bonk; floor became a moving platform [G §3.1, V §0] | N6 floating thin platforms are one-way (no bonk); H9 red line on the floor = spikes, H10 red in the pit = lava; green Γ = goal; U1 guard keeps the left floor static | **0 R edits expected** (the 5-cell pit is a run-gap). Polished: `unreachable_drawn` coins → R1 ≤ 2 nudges |
| Owner `d_dfbfe619` | black zigzag became 1-cell walls; 12 reachable cells [G §3.1] | H12 → decoration (asks "Is this grass or spikes?") | none |
| Owner `d_79eff85e` | 41-cell floating hazard slab, never on the route [G §3.1] | H8 → spike strip on the platform's top face (6 px band) | Challenging: the `skippable_setpiece` flag drives C2, C3 and C4 near it until the route passes it |
| [M B] wobbly_cave | spawn on the roof; 8-cell pit; 5-cell wall | N7 lowest standable start; N2 closes the 1-cell hole; N1 | 8-cell pit is run-jumpable; wall: **R2 trim 1** (cost 1.2) beats lifting it (1.5/cell × size × 1.5 + 4 pillar + 3 topology ≥ 9) |
| [M B] tower_key | one 4-row step; key behind a door bar | group rule 7 joins the 3 ledge fragments | none (walk apex 4.45 clears 4 rows); key/door from the text (model) or H20 ask (offline) |

### 3.8 The designer: menu, greedy, model picks, tiers

**Candidates** (`core/design/candidates.ts`). They are generated from the Understood (or Ink) build and its report. Each candidate is applied in a sandbox and checked against the invariants. It is fast-verified, which takes ≤ 20 ms per affected segment. The top 12 are then fully measured for dC, dT and dF. The menu holds ≤ 40 entries.

| Generator | Site (from report slots) | Ops | Predicted ΔC (analytic, used for ranking before measuring) |
|---|---|---|---|
| `fix_flag` | each flag (§4.3) | its fix ops | - |
| `checkpoint` | segments with F_s > 30 s or T_s > 40 s | P1 | ΔF |
| `trail` | run-up gaps, jumps > 5 cells, blind jumps | P2 | 0 (readability) |
| `risk_coin` | `risk_spots` (detour p_death ≥ 0.1, or stomp-bounce only) | P4 | 0 |
| `animate` | static kid creatures on a host ≥ 4 cells | P7 | phase window → +0.03 to +0.1 |
| `speed_up` | kid enemies and movers | P6 +1/+2 | φ ↓ |
| `tighten_jump` | a required jump with w > 12 f | C1 +1, C2 | Δw ≈ −16 px ÷ px-per-frame (−5.7 f running, −10 f walking) |
| `guard_flat` | a route flat ≥ 8 cells with no threat (`long_flat`) | C5 walker; hopper with headroom ≥ 4; chaser on long runs | +0.05 to +0.2 |
| `arm_landing` | an undrawn top face the route lands on | C4 on the far part, leaving ≥ 2 landing cells | L ↑ |
| `crumble_landing` | a landing ≤ 6 cells mid-segment | C7 | adds a timing action |
| `saw_window` | the apex region of a gap jump with ≥ 3 cells of clear air (Hard; Normal for saws only) | C6 saw on a 4-6 cell path | φ ≈ cycle × safe fraction |
| `matter` | `skippable_setpiece` | C2, C3 or C4 near it | L ↑ |
| `reprise` | an empty region ≥ 10 cells after a drawn setpiece (≥ 3 screens) | C9 | setpiece E × 1.3 |

Each menu row has these fields:
- `cid` = `op:target:hash6(params)`, stable across rebuilds and stages;
- `op`, `params`, `tiers` (the lowest tier that allows it), `alts` (mutually exclusive group);
- `summary_key` + args (kid-readable);
- `dC`, `dT_s`, `dF_s`, `drift`, `intent_cost`, `fixes: flag ids`.

**Greedy** (`core/design/greedy.ts`). This is the deterministic floor, the instant dial, and the offline designer.

```
for tier in [polished, normal, hard]:                      // nested: each tier starts from the previous tier's result
  loop until C ∈ target(tier) or budget(tier) spent or no candidate improves:
     score(c) = progress_toward_target(c) / max(0.25, intent_cost(c)) − 0.5·[same op used ≥ 3 times]
                + 0.2·[c sits in the later 60% of its segment]   // sawtooth preference
     apply best → invariants → analyze(affected segments) → commit; re-place checkpoints if any F_s > 30
  on overshoot (C > band max): pop ops from the end until inside the band
  if C < band min: reach[tier] = false, reason "This drawing goes up to {band} without changing what you drew"
```

- **Budgets:** Polished ≤ 2 P edits per screen (coins counted separately) and ≤ 4 `tune`; Normal/Hard ≤ 4 C edits per screen; I8 always applies.
- **Time:** ≤ 3 s in total for 4 tiers, using a `worker_threads` pool of 3.

**Model DESIGN pick** (§3.10). The model sees the menu and digests, never raw geometry. It returns:
- an ordered list of picks per tier, at most 1 per `alts` group;
- repair choices among `alts`;
- vetoes of non-required cosmetic normalizations (for example, "the bumpy cave floor is the point");
- ≤ 3 novel ops, typed and slot-addressed;
- Ask cards, a designer note (≤ 240 chars), ≤ 3 critique lines and a title.

**Apply per tier** (`core/design/picks.ts`). Tiers are nested (polished ⊂ normal ⊂ hard). For each tier:
1. Apply the picks of that tier and the tiers below, in model order, then the novel ops.
2. Check the invariants after every op.
3. Run the bot after every 3rd op and at the end. On failure, roll back the last op and mark it `rejected` with its reason.
4. On undershoot, greedy completes the tier. On overshoot, ops are popped from the end.

The result is 4 builds. **The dial swaps between them instantly on the client.**

**Speculative DESIGN and pick transfer** (D9). This is the latency lever.
1. As soon as the Ink build's tiers and menu exist (canvas ≈ 2 s, paper ≈ 4 s), DESIGN #1 is sent on that menu, in parallel with PERCEIVE.
2. When Understood lands, the menu is regenerated.
3. `transferPicks(plan, oldMenu, newMenu)` keeps every pick whose `cid` still exists. Cids are stable because object ids are `'o' + min component id` and params hash identically.
4. If ≥ 70% of picks transfer **and** no role on the route or setpiece changed, the plan is applied at once. Polished arrives at ≈ 13-14 s p50.
5. Otherwise DESIGN #2 is sent on the new menu, if elapsed time < 14 s. If not, the greedy tiers stand and DESIGN #2 runs async; its picks arrive as `suggestions`.
6. The env flag `DAL_SPECULATIVE_DESIGN=1` is the default. P0 measures the transfer rate on G01-G14; if it is < 50%, the default flips to 0.

**REFINE** (≤ 1 round). It runs if Normal or Hard misses its band, or if > 30% of picks were rejected, and elapsed time is < 20 s. The model receives the deltas, for example: "applied k03,k07; rejected k11: unsolvable; C 0.42, target 1.0-3.0". It returns more picks or "can't without changing the drawing". After 20 s, it runs async and returns suggestions.

**CRITIC** (on demand). It is triggered by the "Why is this hard?" button, or offered after 5 deaths in one segment during test-play.
- **Input:** the report, the creator's own telemetry (death positions, causes, frames, attempts, segment times) and a menu restricted to that segment (easier fairness fixes and harder variants).
- **Output:** ≤ 3 observations in kid words and ≤ 3 validated picks, shown as `suggestions`.

**Make it mine / Bake my fixes.**
- K1 converts designer or draft objects into kid ink.
- "Back to drawing" opens the editor with the current objects as editable vectors, and the edits are kept by object id. A toggle, "Bake my fixes into the drawing", writes the accepted N and R geometry back into the strokes.

### 3.9 Model vs deterministic code

| Task | Owner | Evidence |
|---|---|---|
| Strokes, components, features, grouping | code | v1 segmentation is reliable; v1's thresholding is the bug [B F4, F7] |
| Roles, relations, parts, text→behavior binding, setpieces, library tags, intent, safety | **model (low)** on every build with unpinned ink; heuristic offline and as the always-on first look | 95-97% roles, 75/76 relations, 37/38 non-geometry [M A] |
| Fit, snap, orient, ground, start, gaps, collision modes, compile | code | the model's coordinates are off by 1 [M A] |
| Reachability, windows, difficulty, fairness, invariants | code (bot) | the model was wrong 3/3 times without solver facts [M A, B] |
| Choosing among verified repairs and enhancements; kid-facing reasons; asks; designer note; title | **model (low)**; greedy offline and as the floor | minimal plans 4/4; taste 15/18 with every failure caught by re-solve [M B, C] |
| Where the creator struggles and what would help | **model (CRITIC, low)** over the bot facts plus telemetry | [MF] |
| Prompt → beat sequence | **model (low)**; keyword planner offline | 5/5 solvable; low = medium quality at 2.6× speed [M D] |
| Beat layout, rasterization, verification | code | - |

### 3.10 Model calls

**All runtime calls** use `claude-opus-5`, thinking omitted (adaptive is the default on Opus 5) and effort **low** [API]. `max_tokens` caps thinking plus output together, so each cap is about 5× the measured output; a stop on `max_tokens` therefore means a real failure.

| Call | When | Input | Output | max_tokens | Timeout |
|---|---|---|---|---|---|
| PERCEIVE | every build with ≥ 1 unpinned component or any text or typed rule; one per paper sheet or 2-screen canvas tile, in parallel | annotated tile JPEG (24 px/cell, magenta component ids, cell rulers, **taps included** [B F17]), compact component table (id, color, bbox, f), typed rules with target ids, library names + letters (+ a thumbnail strip if the library is non-empty), parent object summary (remix), 2-cell context strip from each neighbouring tile | `Perception` | 6000 | 20 s |
| DESIGN | speculative after the Ink menu; again after Understood if transfer < 70%; on "Redesign" | the drawing (≤ 2 screens per image, ≤ 2576 px long edge), graph digest (objects, roles, setpieces, intent, wish, pinned), level digest (route table: action, setpiece, w/h/φ frames, p_death; segments E/T/F_s; flags), `alts` groups, menu rows `cid · summary · tiers · dC · dT · cost · fixes`, tier targets, budgets | `DesignPlan` | 8000 | 15 s |
| REFINE | §3.8 | previous plan + applied/rejected with reasons + metric deltas + fresh menu | `DesignPlan` (picks and novel only) | 4000 | 10 s |
| CRITIC | on demand | report + telemetry + segment menu | `Critique` | 4000 | 20 s |
| PLAN | prompt-to-level | prompt, screens, rules summary, beat catalogue with physics numbers | `LevelPlan` | 6000 | 20 s |
| CREATURE | library studio text | name, sentence, creature image ≤ 512 px | `CreatureSpec` | 2000 | 10 s |
| MODERATE | publish when PERCEIVE never ran (stamp-only canvas) or new title/author text | render PNG 1024 px + texts | `Moderation` | 1500 | 10 s |
| LOOK | **eval only, never a runtime gate** | drawing + Polished render + change list | `LookScore` | 6000 (medium) | 60 s |

**Client** (`vision/app/mind/client.py`, the only module that talks to Anthropic). It follows the probe-validated call shape [M api]:

```python
MODEL = "claude-opus-5"; PRICE_IN, PRICE_OUT = 5.0, 25.0          # $/MTok; thinking bills as output
_client = anthropic.Anthropic()                                      # key from env only; never logged or returned

async def call(kind: CallKind, schema: type[T], content: list[dict], *, draft_id: str, deadline: float) -> MindResult[T]:
    spec = CALLS[kind]                                               # effort, max_tokens, timeout_s, system (prompts/<kind>.md, frozen)
    if not budget.allow(kind, draft_id):   return MindResult.skipped(kind, "budget")
    timeout = min(spec.timeout_s, deadline - time.monotonic())
    if timeout < 3:                         return MindResult.skipped(kind, "deadline")
    c = _client.with_options(timeout=timeout, max_retries=0)
    t0 = time.perf_counter()
    for attempt in (1, 2):
        try:
            resp = await asyncio.to_thread(c.beta.messages.parse,
                model=MODEL, max_tokens=spec.max_tokens,
                system=[{"type": "text", "text": spec.system, "cache_control": {"type": "ephemeral"}}],
                output_config={"effort": spec.effort},                  # "low" for every runtime call
                betas=["server-side-fallback-2026-07-01"], fallbacks="default",
                messages=[{"role": "user", "content": content}],
                output_format=schema)
            break
        except anthropic.APIStatusError as e:
            if e.status_code == 529 and attempt == 1 and deadline - time.monotonic() > 8: continue
            return MindResult.failed(kind, e, t0)
        except (anthropic.APIConnectionError, pydantic.ValidationError, ValueError) as e:   # timeout ⊂ connection error
            return MindResult.failed(kind, e, t0)
    if resp.stop_reason == "refusal":     return MindResult.refused(kind, resp, t0)    # checked BEFORE parsed_output
    if resp.stop_reason == "max_tokens":  return MindResult.truncated(kind, resp, t0)  # never partially applied
    if resp.parsed_output is None:        return MindResult.failed(kind, "no_parse", t0)
    fb = any(getattr(i, "type", None) == "fallback_message" for i in (resp.usage.iterations or []))
    ledger.record(kind, draft_id, resp, fb, t0)                      # tokens, $, latency, stop_reason, served_by, request id
    return MindResult.ok(kind, resp.parsed_output, resp, fb, t0)
```

- `MindResult[T] = {value: T | None, status: ok|failed|refused|truncated|skipped, latency_s, cost_usd, fallback_used, stop_reason, error}`. It **never raises**.
- The sync client runs in a thread, because that is the probe-validated path. P0 checks `AsyncAnthropic().beta.messages.parse` and switches to it if available.
- Every system prompt is ≥ 512 tokens, so it is cacheable on Opus 5. Cache reads bill at 0.1×.

**Prompt responsibilities** (`vision/app/mind/prompts/*.md`; each ≤ 1.5k tokens, frozen and versioned).

Per Opus 5 guidance [API], these prompts contain **no "double-check your answer" instructions** (they cause over-verification), **no "don't think" instructions**, and one conciseness line.

- **perceive.md**
  - What the sheet is: the magenta numbers are component ids and the rulers are cells. Colours are hints, not laws ("kids use black for words, poles and trees").
  - Every role with its in-game consequence ("decoration: the player walks through it").
  - Every relation with "say what the creator MEANT: spikes drawn slightly above a ledge rest on it".
  - Group the pieces of one thing (eyes into a monster, pole into a flag, words into a phrase, fragments into a ledge).
  - The flag convention: the rightmost flag is the goal, other flags are checkpoints.
  - Bind behaviors only from the typed union and only from text or arrows. A typed rule with a target id binds to that id.
  - Name 1-4 setpieces the child obviously cares about.
  - Set `difficulty_wish` from words ("super hard").
  - Ask when a gameplay-relevant role is uncertain, instead of guessing.
  - **Never judge distances, gaps or reachability; code does.**
  - Return every listed id exactly once and invent none.
  - Safety: flag sexual, hateful or graphically violent content. Spikes, monsters and lava are fine.
- **design.md**
  - "You are a senior platformer designer working for a child. The drawing is theirs and it is the boss."
  - Use teach → test → twist and sawtooth difficulty. Reward risk with big coins. Make few, strong moves.
  - Every candidate is already proven playable, so judge **taste and intent, not physics**. The deltas are the facts.
  - Never bypass a setpiece. Polished raises difficulty only to Easy, with tuning, checkpoints, trails and big coins.
  - Choose repair options that keep the child's shapes (lower a wall rather than lift it). Veto cosmetic normalizations only when the wobble is clearly the point.
  - At most 1 pick per alts group.
  - Every reason is ≤ 12 words, positive, and readable by a 7-year-old. The designer note is ≤ 2 sentences.
  - Ask instead of guessing when a pick would change what the drawing means.
- **refine.md:** close the gap to the band using only the fresh menu, or answer "can't without changing the drawing".
- **critic.md:** explain where and why the creator dies, from the telemetry and route facts. Suggest ≤ 3 picks. Never judge the child's skill.
- **plan.md:** compose beats from the catalogue in teach → test → twist → finale order, sized to the screens. The physics envelope is given as numbers; the model never exceeds it on purpose and never emits coordinates.
- **creature.md:** map the sentence to one archetype plus speed and spiky. "Spiky" means it cannot be stomped.
- **moderate.md:** safety only.

**Model-facing schemas** (`vision/app/mind/schemas.py`):
- The model-facing tier `polish` maps to the build tier `polished`; `normal` and `hard` are unchanged.
- They contain **enums and required fields only, no numeric bounds.** Structured outputs do not enforce min/max, and one bad number would reject the whole answer. Code clamps every integer.
- Behaviors and novel ops are **discriminated unions**, so a key cannot lose its door [M fail 2].
- P0 smoke-tests that the API accepts the unions. If it rejects them, the fallback is the flat "kind plus nullable fields" form proven in Probe B, validated per variant in code.

```python
Role = Literal["ground","platform","wall","ceiling","spikes","lava","saw","enemy","coin","big_coin","key","door","spring",
               "checkpoint","goal","pole","start_marker","text","arrow","decoration","library_tag","unknown"]
Face = Literal["top","bottom","left","right","none"]; Dir = Literal["up","down","left","right","none"]
Conf = Literal["high","medium","low"]                                    # → 0.9 / 0.75 / 0.5
Speed = Literal["slow","normal","fast"]                                  # → params grid (§5.7, §5.8)

class Node(BaseModel):            # slim: no free-text per node (≈30% fewer output tokens than Probe A)
    id: int; role: Role; conf: Conf
    on: int | None; att: int | None; face: Face; pts: Dir; part: int | None; ref: int | None

class BMove(BaseModel):     kind: Literal["move"];     target: int; dir: Literal["left","right","up","down"]; cells: int; speed: Speed; mode: Literal["pingpong","loop"]
class BEnemy(BaseModel):    kind: Literal["enemy"];    target: int; archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher","static"]; speed: Speed; spiky: bool
class BSpring(BaseModel):   kind: Literal["spring"];   target: int; dir: Literal["up","left","right"]; strength: Literal["small","normal","big"]
class BCrumble(BaseModel):  kind: Literal["crumble"];  target: int; falls: bool
class BSaw(BaseModel):      kind: Literal["saw"];      target: int; dir: Literal["left","right","up","down","none"]; cells: int; speed: Speed
class BKeyDoor(BaseModel):  kind: Literal["key_door"]; key: int; door: int                     # BOTH required [M v1]
class BCheckpoint(BaseModel): kind: Literal["checkpoint"]; target: int
class BStart(BaseModel):    kind: Literal["start"];    near: int                               # the "S", never "the ground" [M v1]
class BTimer(BaseModel):    kind: Literal["timer"];    seconds: int
class BLibrary(BaseModel):  kind: Literal["library"];  target: int; type_name: str
Binding = Annotated[BMove | BEnemy | BSpring | BCrumble | BSaw | BKeyDoor | BCheckpoint | BStart | BTimer | BLibrary,
                    Field(discriminator="kind")]
class Bound(BaseModel):     binding: Binding; pinned: list[Literal["speed","cells","dir","archetype","strength","seconds"]]; evidence: str
class Setpiece(BaseModel):  name: str; ids: list[int]; kind: Literal["jump","hazard_run","climb","enemy","puzzle","finale","other"]
class Ask(BaseModel):       about: int; kind: Literal["which_door","is_decoration","what_does_it_do","which_flag_is_goal","is_library","keep_or_fix"]; options: list[str]

class Perception(BaseModel):
    nodes: list[Node]; bindings: list[Bound]; setpieces: list[Setpiece]
    intent: str; difficulty_wish: Literal["none","easy","normal","hard"]
    transcript: str; title: str | None; asks: list[Ask]
    safety_ok: bool; safety_reason: str | None

Tier = Literal["polish","normal","hard"]
class Pick(BaseModel):          cid: str; tier: Tier; reason: str
class RepairChoice(BaseModel):  alts: str; cid: str; reason: str
class Veto(BaseModel):          edit_id: str; reason: str
class NEnemy(BaseModel):    op: Literal["add_enemy"];   slot: str; archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher"]; tier: Tier; reason: str
class NSpikes(BaseModel):   op: Literal["add_spikes"];  slot: str; tier: Tier; reason: str
class NBigCoin(BaseModel):  op: Literal["add_big_coin"]; slot: str; reason: str
class NCheck(BaseModel):    op: Literal["add_checkpoint"]; slot: str; reason: str
class NTune(BaseModel):     op: Literal["tune"]; target: str; param: Literal["speed","interval","range"]; step: Literal["+1","+2"]; tier: Tier; reason: str
class NCrumble(BaseModel):  op: Literal["make_crumble"]; target: str; tier: Tier; reason: str
class NReprise(BaseModel):  op: Literal["reprise"]; setpiece: str; slot: str; escalation: Literal["faster","plus_saw","plus_spikes","narrower"]; reason: str
NovelOp = Annotated[NEnemy | NSpikes | NBigCoin | NCheck | NTune | NCrumble | NReprise, Field(discriminator="op")]
class DesignAsk(BaseModel):     about: str; kind: Literal["is_door","keep_or_fix","which_way"]; options: list[str]
class DesignPlan(BaseModel):
    repair_choices: list[RepairChoice]; vetoes: list[Veto]; picks: list[Pick]; novel: list[NovelOp]
    asks: list[DesignAsk]; designer_note: str; critique: list[str]; title: str | None

class Observation(BaseModel):   segment: str; what: str
class Critique(BaseModel):      observations: list[Observation]; picks: list[Pick]; note: str

class CreatureSpec(BaseModel):  archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher","static"]
                                speed: Speed; spiky: bool; summary: str; safety_ok: bool
class Moderation(BaseModel):    safety: Literal["ok","flag"]; reason: str | None
class LookScore(BaseModel):     score: Literal[1,2,3,4,5]; per_edit: list[EditJudgement]   # {edit_id, keeps_intent: bool, why}
# LevelPlan: §8.3
```

**Sanitizer** (`vision/app/mind/sanitize.py`):
- **Drop** unknown ids, cids, slots and edit_ids.
- **Clamp** `cells` to 1-12 and `seconds` to 10-300.
- **Map** enums to numbers via `shared/spec/params.json`.
- **Truncate** free text: reasons to 90 chars, the note to 240, the intent to 160, rendered as text only and never as HTML.
- **Ignore oversize lists** beyond the first entries: > 3 novel ops or > 4 setpieces.
- **Priority on conflict:** kid > model > parser > heuristic.

### 3.11 Progressive streaming protocol (SSE)

`POST /api/v2/builds` returns `202 {build_id, draft_id, events_url}`. Then `GET /api/v2/builds/{build_id}/events` serves `text/event-stream`:
- headers `Cache-Control: no-cache` and `X-Accel-Buffering: no`;
- a heartbeat comment `: ping` every 10 s;
- each event's `id` is a monotonically increasing `seq`;
- events are persisted to `drafts/<draft_id>/events.jsonl`, so a `Last-Event-ID` reconnect replays everything after that seq.

**Polling fallback.** `GET /api/v2/drafts/{id}?since=<seq>` returns `{state, events: [...]}`. The client switches to it after 2 failed SSE reconnects.

| Event | Payload | Sent when |
|---|---|---|
| `hello` | `{build_id, draft_id, version, core_version, model: "live"\|"fake"\|"off"}` | first |
| `stage` | `{stage: upload\|cv\|ink\|perceive\|understood\|design\|designed\|refine\|critic, status: start\|done\|skipped\|failed\|late, t_ms, note_key?}` | each transition |
| `ink` | `{ink: InkDoc, graph0: SceneGraph}` | once, after CV (paper) or receipt (canvas) |
| `saw` | `{items: [{object_id, role, rel_key, rel_args, conf, bbox}]}` | ink, understood |
| `edits` | `{edits: EditRecord[]}` (upsert by id; carries `tier` and `status`) | each stage |
| `tier` | `{stage, tier: faithful\|polished\|normal\|hard, level: LevelV2 (ink replaced by "ink_ref"), report: PlaytestReport, edit_ids: string[], reach: bool, morphs: Morph[]}` | 4× per stage |
| `ask` | `{ask: AskCard}` | when created |
| `note` | `{designer_note, critique: string[], title_suggestion, source: "model"\|"greedy"}` | designed, critic |
| `suggestions` | `{edits: EditRecord[] (status "suggested"), source: "late_design"\|"refine"\|"critic"}` | late picks |
| `cost` | `{usd, calls, by_kind}` | after each model call |
| `warning` | `{message_key, args}` | e.g. `looked_closer_skipped`, `sheet_missing` |
| `error` | `{message_key, args, fatal: bool}` | |
| `done` | `{final_stage, total_ms}` | last |

`Morph = {object_id, from: Rect, to: Rect, kind: "move"|"relabel"|"appear"|"vanish"}`.

**Ordering for a canvas build (p50):**

| t | Events |
|---|---|
| 0 | `hello`, `stage(ink start)` |
| 0.5 s | `ink`, `saw`, `edits`, 4× `tier(stage:ink)` |
| 2 s | `stage(design start)` (speculative) |
| ≈ 11 s | `stage(perceive done)`, `edits`, `saw`, 4× `tier(stage:understood)`, `ask`* |
| ≈ 13.5 s | `stage(designed done)`, `edits`, 4× `tier(stage:designed)`, `note`, `cost`, `done` |
| ≤ 25 s | the deadline. If design is late: `stage(design late)`, the greedy tiers stand, then later `suggestions` |

**Never yank the level mid-jump.**
- If the child is playing when a new stage arrives, the engine swaps only at the next respawn, pause or goal, or when the child taps the toast "The designer polished your level: try it".
- In the preview (not playing), the swap is immediate, with 300 ms morphs.

### 3.12 Fallbacks (the game never waits on the model)

| Failure | Detection | Behavior | The child sees |
|---|---|---|---|
| No key, `DAL_FAKE_LLM=1`, offline | config / health | Heuristic perception + parser + greedy tiers. Keyword planner for prompts. Chips for creatures. | Badge "Quick look (offline)"; more "Is this right?" chips |
| PERCEIVE timeout (20 s), API error, max_tokens, parse error | MindResult | The Ink graph stands. DESIGN uses the Ink menu (no transfer is needed). | "I'll keep it as you drew it" (`warning looked_closer_skipped`) |
| PERCEIVE refusal (after the server-side fallback) | `stop_reason == "refusal"` | Same as a timeout, plus `safety: "held"`. Publishing is unlisted until MODERATE passes. | "Saved privately for now" |
| > 30% invalid nodes | merge | The whole perception is discarded | - |
| DESIGN late or failed | 25 s deadline | Greedy tiers ship. A late plan arrives as `suggestions`. | Badge "Polished (auto)" |
| A pick fails validation | apply | Rejected, with the reason logged in `meta.build` | not shown (count in "Rejected ideas") |
| Worker crash | broken pipe / 2 s RPC timeout | Restart (≤ 1 s) and retry once; otherwise 503 | "Builder is restarting, tap retry" |
| Core exception in the browser | try/catch | Fall back to a server build (`PUT /drafts/{id}/edits`) | - |
| Engine entity error | per-entity try/catch in create and update | The entity is disabled and `entity_error` is reported. **Publishing is blocked.** | "I couldn't build the moving platform near the start. I turned it off." |
| Budget exceeded | ledger | model-off path | "The designer is resting; quick look only" |
| SSE dropped | `EventSource` error ×2 | Polling with `since` | - |

### 3.13 Latency budget

All measurements are on the local server. Model latencies come from [M lat] and must be re-measured in P0.

| Step | Canvas p50 / p90 | Paper (1 sheet) p50 / p90 |
|---|---|---|
| ▶ test-play from the editor (local core) | **0.15 / 0.3 s** | - |
| Upload | 0.05 s | 0.5 / 1.5 s (2400 px JPEG, ≈ 600 KB) |
| CV v2 | - | 0.6 / 0.9 s (sheets in parallel) |
| **Ink build playable** | **0.5 / 0.9 s** (browser core) | **2.5 / 4 s** (≤ 8 s p95 gate) |
| Greedy tiers + menu | +1.2 / +3 s | +1.2 / +3 s |
| PERCEIVE (low) | 10 / 15 s from t=0.3 s | 10 / 15 s from CV done |
| **Understood** | **≈ 11 / 16 s** | **≈ 13 / 18 s** |
| DESIGN #1 (speculative, low) | 8 / 12 s from t≈2 s | 8 / 12 s from t≈4 s |
| **Designed (transfer ok)** | **≈ 13.5 / 18 s** | **≈ 15 / 20 s** |
| Designed (DESIGN #2 needed) | ≈ 22 s / deadline 25 s | ≈ 24 s / deadline 25 s |
| Dial move | instant (precomputed) | instant |
| Undo / redo toggle | < 150 ms per screen (local) | same |

### 3.14 Cost per scan (Opus 5: $5/MTok input, $25/MTok output, thinking billed as output)

| Item | Input tokens | Output tokens | $ |
|---|---|---|---|
| PERCEIVE, 1 tile, low | ≈ 4.5k (system cached) | ≈ 0.9k | ≈ 0.045 |
| DESIGN, low | ≈ 6k (menu ≈ 1.8k, image ≈ 1.5k) | ≈ 0.8k | ≈ 0.05 |
| **1-screen Polished scan (typical)** | | | **≈ 0.10** |
| Same, with DESIGN #2 (transfer < 70%) | | | ≈ 0.15 |
| + REFINE (≈ 30% of Challenging builds) | ≈ 5k | ≈ 0.6k | +0.04 |
| 4-sheet paper level (4 PERCEIVE + 1 DESIGN) | | | ≈ 0.24 |
| 4-screen canvas level (2 tiles + 1 DESIGN) | | | ≈ 0.14 |
| Stamp-only canvas level (PERCEIVE skipped) | | | ≈ 0.05 (DESIGN) + 0.02 MODERATE at publish |
| Prompt-to-level (PLAN + DESIGN) | | | ≈ 0.09 |
| CRITIC / CREATURE | | | ≈ 0.04 / ≈ 0.02 |
| Offline / budget exhausted | | | 0 |

Every call writes tokens, latency, `stop_reason`, `served_by`, `fallback_used` and cost to `model_calls` and `meta.build.model_calls`. **Gate:** mean ≤ $0.12 for a 1-screen Polished build and ≤ $0.30 for a 4-sheet build on the live golden run.

---

## 4. The playtest bot and the difficulty model

### 4.1 The bot (`web/src/core/bot/`)

The bot is the solver, upgraded to play like a careful designer. It calls the **same** `Sim.step` the engine uses (§5.2), so engine and solver cannot disagree.

| Aspect | v1 | v2 |
|---|---|---|
| World | `GAME_W`/`GAME_H` hard-coded [G §6, M D] | `world.w × world.h` from the level |
| Physics | Arcade port: no coyote, no buffer | the Sim itself: coyote, buffer, corner correction, slopes, one-way, step assist |
| Nodes | standing cells | (surface id, x at 4 px resolution, key/door bitmask, phase bucket near timed entities) |
| Jump policies | hold direction for the whole jump [G §11] | **start speed:** {stand, walk, run if runway ≥ 3 cells}<br>**hold:** {1, 3, 6, 9, 12, 16, 20, 30, 45} f<br>**direction release:** {never, at apex, apex + 6 f}<br>**air reverse-steer** for small landings<br>**double jump** at {8, 14, 20, 26} f when the ability is on |
| Other actions | walk, jump, drop | walk; drop; drop-through (Down + Jump on one-way); spring (held or not); stomp-bounce (held or not); ride; `wait k` (6 f steps) |
| Moving platforms | static bridges along the path [M D] | **time-exact**. A static pass runs first. Then, where the route crosses a timed entity, a local time-expanded search with 24 phase samples per cycle, refined to 1 frame by bisection. |
| Enemies | ignored | simulated; contact kills; stomp is an action |
| Camera | none | `cameraStep` (§6.2) replayed along the bot's input trace, used for `blind_jump` |

**Trajectory templates.**
- For each (profile, initial-speed bucket, hold, release), the core precomputes the free-flight body offsets for up to 3 s.
- At runtime a jump walks its template, testing only cells, hazards and entities along it. At the first contact it switches to exact `Sim.step` from that frame.
- A property test checks 10,000 random (node, action) pairs against full simulation; the outcomes must be identical [GF].

**Budgets** (Node, 1 core; phones are 2-3× slower):
- fast verify (reachability and route): ≤ 15 ms per screen;
- full metrics: ≤ 150 ms per screen;
- a 6-screen full analysis: ≤ 1 s;
- a local re-solve of ±1.5 screens inside the design loop: ≤ 60 ms.

The v1 solver measured < 11 ms per screen [M].

### 4.2 `PlaytestReport`

```ts
interface PlaytestReport {
  solvable: boolean; reason?: 'no_start' | 'no_goal' | 'goal_unreachable' | 'key_unreachable';
  frontier?: { reached: CellXY[]; blocking: { from: CellXY; to_object: string; kind: FailureKind; need: string; have: string } };
  route: RouteStep[];          // min expected-deaths route; ties → fewer actions → faster
  segments: { id: string; from: string; to: string; E: number; A: number; T_ms: number; F_s: number; actions: number }[];
  C: number; F: number; score: number; band: 'trivial' | 'easy' | 'normal' | 'hard' | 'expert';
  C_skilled: number; fastest_ms: number; par_ms: number; casual_clear_s: number;
  flags: Flag[];                // {code, severity, frame, at: CellXY, object_ids, fix_cids}
  reachable: string[];          // node keys (for the reach halo)
  setpiece_order: string[];     // setpieces in the order the route meets them (I3)
  slots: { checkpoint: Slot[]; coin: Slot[]; risk: Slot[]; enemy: Slot[]; hazard: Slot[]; spikes: Slot[]; step: Slot[]; spring: Slot[]; hint: Slot[] };
  engaged_enemies: number; actions_per_screen: number; trace: number[] /* bot input log, RLE */;
  level_hash: string; core_version: string;
}
interface RouteStep { i: number; kind: 'walk'|'jump'|'runjump'|'drop'|'dropthrough'|'spring'|'stomp'|'ride'|'wait'|'timed_pass';
  from: CellXY; to: CellXY; frames: number; w_f: number; h_f: number; phi_f: number | null; lethal: number;
  p_death_casual: number; p_death_skilled: number; blind: boolean; segment: string; setpiece: string | null }
```

### 4.3 Flags (designer-grade playtesting)

Severity rules:
- **hard:** a designer output may never introduce one (I6). Faithful repairs try to clear them.
- **block:** stops publishing.
- **warn / info:** shown as "Heads up" cards.

| Flag | Detects | Severity | Fixed by |
|---|---|---|---|
| `unsolvable` | goal unreachable, or key unreachable with the door closed. `frontier` names the blocking jump ("needs 9 cells; a run-jump does 9 with ≥ 3 cells of runway; you have 1") | **block** | repair search (§3.7) |
| `tight_window` | a required action with min(w, h, φ) < 4 f (casual) | hard | R3, R1, P6 (on a designer tune) |
| `blind_jump` | the landing is outside the camera rect at takeoff (§6.2) | hard | P2 trail, P5 arrow, R1 |
| `leap_of_faith` | a required drop whose landing is below the visible area | hard | P5, P2 |
| `spawn_unsafe` | a hazard ≤ 2 cells, or an enemy patrol ≤ 4 cells, from the start or a checkpoint | hard | N8 |
| `invisible_lethal` | a death with no visible hazard (pits always render an abyss scribble) | hard | art rule (§7.3) |
| `softlock` | a reachable region with no path to the goal and no lethal exit | hard (designer) / warn (drawn) | R5, R1; the HUD restart button always exists |
| `long_segment` | F_s > 30 s or T_s > 40 s | hard for Polished and above / warn in Faithful | P1 |
| `head_bonk` | a route jump hits a ceiling before its apex and loses ≥ 1 cell of reach | warn | N6, R2 |
| `unreachable_drawn` | a drawn coin, key or platform is never reached ("did you mean to reach this?") | warn | R1 ≤ 2 (Polished) |
| `skippable_setpiece` | a drawn hazard or enemy the route never comes within 2 cells of ("your spikes don't matter"; the `d_79eff85e` slab [G §3.1]) | info (Polished) / target (Challenging) | C2, C3, C4 near it |
| `trivial` | C < 0.05 | info | P6, P7 toward C ≥ 0.1 |
| `long_flat` | ≥ 16 cells or > 8 s of route with no required action | info / target (Challenging) | C5, C6 |
| `dead_end` | an off-route region that costs > 10 s to back out of | info | - |

Each flag carries its frame, its position and `fix_cids`, so "How it plays" can offer **Fix it** (apply the top candidate).

### 4.4 Metrics and formulas (`core/difficulty/model.ts`, formalizing [G §6])

Inputs per required route action i, measured by engine-exact simulation:
- **`w_i` takeoff window (frames).** Takeoff x is sampled in 2 px steps around the edge. Both ends of the successful interval are found by bisection, then converted to frames at the takeoff speed.
- **`h_i` hold window (frames).** Consecutive working hold values from the best takeoff, interpolated.
- **`φ_i` phase window (frames)** for timed entities: (working samples out of 24) × cycle_frames / 24. The player can wait, so this really is a window in frames.
- **`L_i` lethal share.** The fraction of failing samples (± 1 window width, all holds) that end in death rather than in a recoverable state.

```
miss(x)        = 2·Φ(−x / (2σ))              σ = 3 f (casual), 1.5 f (skilled); miss(∞) = 0
p_fail_i       = 1 − (1 − miss(w_i))·(1 − miss(h_i))·(1 − miss(φ_i))
d_i            = p_fail_i · L_i
E_s            = Σ_{i∈s} d_i                  expected deaths per attempt of segment s (segments split at checkpoints)
A_s            = 1 / Π_{i∈s} (1 − d_i)        expected attempts
F_s            = (A_s − 1) · T_s / 2          expected seconds lost to replays in s (T_s = bot fastest)
C              = max_s E_s + 0.25 · Σ_s E_s   challenge: the hardest segment dominates
F              = Σ_s F_s
score          = round(100 · (1 − e^(−C)))    0-100 badge
casual_clear_s = 1.6 · Σ_s T_s + Σ_s (A_s − 1) · (T_s/2 + 0.75)
par_ms         = ceil_to_500ms(1.3 · fastest_ms)
```

### 4.5 Bands and the kid-facing readout

| Band | C | Score | Measured references [G §3] |
|---|---|---|---|
| Trivial | < 0.05 | < 5 | all three v1 starters (0.000 / 0.004 / 0.000) |
| Easy | 0.05-0.3 | 5-26 | one 6-cell pit 0.049; owner's Synth 1 0.125 |
| Normal | 0.3-1.0 | 26-63 | - |
| Hard | 1.0-3.0 | 63-95 | 7 pillars over spikes 1.92 |
| Expert | > 3.0 | > 95 | never targeted by the designer |

**Readout.**
- The pill reads "Easy · about 1 fall in N tries · bot 0:31 · par 0:41", with N = round(1 / max_s E_s).
- When max E_s < 0.05 it reads "you'll rarely fall".
- The preview shows before and after: "Your drawing: Trivial → Polished: Easy (0.14)".

### 4.6 Dial targets (how the designer uses the model)

| Tier | Classes | C target | Segment shape | Edit budget (beyond N/R) | Ops order (cheapest intent cost per ΔC first) |
|---|---|---|---|---|---|
| **Faithful** | U N R | as drawn (C_f) | - | ≤ 5 R repairs (Σ ≤ 8 cells) | - |
| **Polished** (default) | + P | C ≥ max(C_f, 0.1), raised **by P6/P7 only** up to ≤ max(C_f, 0.3); every F_s ≤ 30 s, T_s ≤ 40 s. Never lowers C_f (I7). If C_f > 3, it *offers* "gentler" suggestion cards only. | - | ≤ 2 P per screen (+ coins), ≤ 4 `tune` | checkpoints → trails → big coins → par → tune/animate |
| **Challenging · Normal** | + C (Normal set) | C ∈ [0.3, 1.0), aim 0.6 | sawtooth | ≤ 4 C per screen; I8 | params → geometry ≤ 1 cell → additions → reprise |
| **Challenging · Hard** | + C (Hard set) | C ∈ [1.0, 3.0), aim 1.8 | sawtooth | ≤ 4 C per screen; I8 | same, geometry ≤ 2 |

**Sawtooth target** for segment k of n:

```
target_k = lo + (hi − lo) · (0.4 + 0.6 · k / max(1, n − 1))
```

- **Shape:** difficulty rises inside the level and falls after each checkpoint [G §5 principle 2].
- **Rest after a checkpoint:** the 6 cells after a checkpoint receive no additions.
- **Pacing goal:** Polished aims for no `long_flat`.
- **Difficulty wishes:** `difficulty_wish: hard` from the drawing ("make it SUPER hard") pre-selects Challenging·Hard, and `easy` caps Polished at C ≤ 0.3.

### 4.7 Calibration anchors (two-mode tests, [MF] + [PF])

1. **Legacy mode.** Profile `v1-classic` with `opts.legacy_measure = true`: hold the direction for the whole jump, no coyote or buffer modelling, σ = 3. It must reproduce `level_metrics.ts` within max(0.005, 10%):

   | Fixture | Expected E | Expected P(clear) |
   |---|---|---|
   | 4-cell spike pit | 0.000 | - |
   | 5-cell spike pit | 0.004 | - |
   | 6-cell spike pit | 0.049 | - |
   | 7 pillars | 1.92 | 9% |
   | Synth 1 | 0.125 | - |
   | v1 starters | 0.000 / 0.004 / 0.000 | - |

2. **Full mode.** Every E must be ≤ its legacy value, because the extra policies only widen windows. The ranking of the levels must not change.
3. **Envelope.** `v2-standard` must reproduce `proposed_physics_results.md` within 0.1 cell for every row of the table.

---

## 5. Gameplay systems (every constant)

### 5.1 Controls

| Input | Keyboard | Gamepad (browser API) | Touch (landscape) |
|---|---|---|---|
| Move | ←/→, A/D | d-pad / left stick | left thumb ◀ ▶ (slide between them without lifting) |
| Jump (variable height) | Space, Z, ↑, W | A | right thumb, large Jump button |
| Run | hold X or Shift | B / X | **auto-run after holding a direction for 0.5 s** [G §7.1]; setting "Always run" |
| Down: fast-fall; with Jump on a one-way platform: drop through | ↓ / S | down | small ↓ above Jump |
| Restart from checkpoint / pause | R / Esc | Select / Start | HUD buttons |

`navigator.vibrate(10)` fires on stomp and on death, where supported.

### 5.2 The simulation core (`web/src/core/sim/`)

- **Fixed 60 Hz steps.** The engine accumulates real time and interpolates rendering between the last two states, so 120 Hz screens stay smooth.
- **Determinism.**
  - State is float64.
  - Step code uses only `+ − × ÷ floor round min max abs sqrt`.
  - Rotations and sine paths use a 1024-entry table generated by exact arithmetic at module load.
  - The RNG is a seeded xorshift32. Time is an integer frame counter.
  - A lint test fails the build if `Math.sin|cos|tan|atan2|exp|pow|random`, `Date` or `performance` appear under `sim/`, `bot/` or `replay/` [GF].
- **Interface.** `Sim.step(input)` takes a 5-bit input: L R J RUN D. Hit-stop and the death sequence are counted in sim frames, so replays are exact.
- **Phaser's role.** Phaser renders, reads input, plays audio and runs particles. **Arcade bodies are not used.**

### 5.3 Physics profiles (game-wide, chosen on the rules sheet; `shared/spec/physics-profiles.json` is normative)

| Constant | **v2-standard** (default) | v2-gentle (young kids) | v2-snappy (experts) | v1-classic (migrated) |
|---|---|---|---|---|
| Walk max | 96 px/s (6 c/s) | 88 | 104 | 160 (no run) |
| Run max | 168 px/s (10.5 c/s) | 152 | 184 | - |
| Ground accel to walk / then to run | 1000 / 300 px/s² | 1100 / 260 | 1100 / 340 | instant |
| Friction (no input) / skid decel | 1400 / 2400 px/s² | 1600 / 2400 | 1400 / 2600 | instant |
| Air accel / drag with no input | 65% of ground / 200 px/s² | 85% / 300 | 60% / 150 | instant, full control |
| Jump launch | vy = −(340 + 0.25·\|vx\|) | −(330 + 0.25·\|vx\|) | −(350 + 0.25·\|vx\|) | −330 |
| Gravity: rising + held / apex (\|vy\| < 40, held) / otherwise | 900 / 450 / 1700 | 800 / 400 / 1300 | 950 / 475 / 1900 | 900 / 900 / 900 |
| Release cut | vy := max(vy, −220) | −200 | −230 | −120 |
| Max fall (fast-fall with Down) | 330 (450) px/s | 280 (400) | 360 (480) | 1200 |
| Coyote / buffer | 6 f / 7 f (100 / 120 ms) | 9 / 9 | 5 / 6 | 5 / 6 |
| Corner correction: ceiling nudge / ledge pop | 4 px / 3 px | 5 / 4 | 4 / 3 | 0 |
| Step assist (walk up a rise of ≤ N px) | 4 px | 4 | 4 | 0 |
| **Envelope: apex standing / walk / run** | **3.86 / 4.45 / 4.92 cells** | 4.14 / 4.70 / 5.15 | 3.88 / 4.48 / 4.99 | 3.61 |
| **Envelope: distance walk / run** | **4.9 / 9.1 cells** | 5.0 / 9.3 | 5.1 / 9.6 | 7.33 |
| Tap hop (1 f) | 1.1 cells | 1.2 | 1.1 | 0.77 |

**Derived design facts**, used by generators, messages and the C1 bound:
- **Runway.** Full run speed from rest takes **2.27 cells**: 4.6 px to reach walk speed at 1000 px/s², then 31.7 px more to reach run speed at 300 px/s². So **a run-gap needs ≥ 3 cells of runway** [GF; this fixes PF's 6-cell error, J].
- **Gap classes.** Gaps of 1-4 cells are walk-gaps; gaps of 5-8 cells are run-gaps. This split is the new core skill [G R1].
- **`g_max(runway)`**, the widest clearable gap for a given runway, is measured by the bot per profile. `cli.ts envelope` writes the table into `params.json`. For `v2-standard` the expected values are 4 cells with no runway and 8 cells with ≥ 3 cells of runway, with the bot-measured values in between.
- **Height.** Walls ≤ 3 cells are standing-jumpable. A 4-cell wall needs a walking jump.

**Abilities** (rules sheet):
- `run` (on), `stomp` (on), `fast_fall` (on).
- `double_jump` (off). The second jump has vy = −260, once per airtime. Measured from the apex of a full first jump, the reach is 6.1 cells standing; 6.7 high and 7.6 long walking; 7.2 high and 13.7 long running.
- Wall jump is deferred to v2.x.

### 5.4 Collision rules

1. **Resolution order.** Move along x and resolve against tiles. Then move along y and resolve, applying the slope floor height and one-way landing (land when the feet were at or above the platform top on the previous frame). Finally resolve against kinematic solids (moving platforms, doors, crumble, falling platforms), which carry riders by their per-frame delta.
2. **Slopes.**
   - Walkable at any speed, with uphill speed ×0.9 and downhill ×1.1.
   - The player sticks to a descending slope when the ground is within 6 px.
   - Fitted surfaces have no 1-row bumps (§3.7). Step assist absorbs ≤ 4 px seams.
3. **Generous hurtbox, strict level** [G §5 principle 6].
   - The collision box is 12 × 28 px (the v1 scale, so drawings keep their size).
   - The **hurtbox against hazards and enemies is 8 × 22** (inset 2 px at the sides and 6 px at the top).
   - Enemy hurtboxes are inset 2 px. Spike bands are 6 px. The lava hitbox is 4 px below its drawn top. Projectile hitboxes are 6 × 6.
4. **One-way drop-through.** Down + Jump ignores one-way tiles for 12 frames.

### 5.5 Damage, stomp, death, respawn, lives

- **Hits.**
  - By default a hit returns you to the last checkpoint (small-Mario model).
  - With `hearts` 2 or 3 on the rules sheet, a hit causes knockback (vx ±160, vy −200) and 1.0 s of blinking invulnerability.
  - Falling more than 2 cells below the world bottom kills.
- **Stomp.**
  - Condition: player vy > 0, the player's bottom on the previous frame ≤ the enemy's top on the previous frame + 4 px, and the enemy is not `spiky`.
  - Result: the enemy is squashed and the player bounces with vy **−280 (−380 if Jump is held)**. Hit-stop is 4 f.
  - **Stomp chain:** each further stomp without landing raises the stomp sound by 2 semitones and pays +1 coin for every chain step ≥ 2.
- **Death sequence.**
  - 6 f of hit-stop, then the character's ink shatters into shards over 250 ms.
  - The camera glides to the checkpoint (≤ 300 ms), and the character reassembles over 200 ms.
  - Total **0.75 s**. Pressing Jump after 250 ms skips the rest. The time counts toward the speedrun clock.
  - v1 used a 300 ms tint [G R5].
- **Respawn state** (deterministic). Entities reset to their initial state, with these exceptions:
  - enemies killed before the checkpoint was activated stay dead;
  - doors opened by keys collected before activation stay open;
  - regular coins stay collected;
  - **big coins that were not yet banked return to their spots** (the Celeste strawberry rule: a big coin counts once you reach the next checkpoint or the goal).
- **Lives.** Rules sheet `lives: off|3|5`, **default off** with a visible death counter (owner decision 3, §0).
  - With lives on, game over restarts the level with full lives.
  - 100 coins give +1 life.
  - Lives are per level.

### 5.6 Param grids (what `tune` steps through; what enums map to)

`shared/spec/params.json` is generated from `core/params.ts`.

| Param | Grid (a `+1` step = the next value) | Enum map: slow / normal / fast |
|---|---|---|
| walker, flyer speed (c/s) | 1, 1.5, 2, 2.5, 3, 4, 5, 6 | 1.5 / 2 / 3 |
| chaser speed (c/s) | 2, 2.5, 3, 4, 5, 5.5 (always < walk 6) | 3 / 4 / 5 |
| moving platform speed (c/s) | 1, 1.5, 2, 2.5, 3, 4, 5, 6 | 1.5 / 2 / 3.5 |
| saw speed on a path (c/s) | 1, 2, 3, 4, 5, 6 | 2 / 3 / 5 |
| hopper interval (s) | 3.0, 2.5, 2.0, 1.6, 1.3, 1.0 | 2.5 / 1.6 / 1.0 |
| shooter interval (s) | 5, 4, 3, 2.5, 2, 1.5 | 4 / 2.5 / 1.5 |
| crusher warn (s) | 0.8, 0.65, 0.5, 0.4, 0.3 | 0.8 / 0.5 / 0.3 |
| crumble delay (s) | 1.0, 0.8, 0.65, 0.5, 0.4, 0.3 | 0.8 / 0.5 / 0.3 |
| spring strength | 0.6, 0.8, 1.0, 1.2, 1.4 | small 0.8 / normal 1.0 / big 1.3 |
| firebar speed (°/s) | 45, 60, 90, 120, 180 | 60 / 90 / 150 |

### 5.7 Enemies: six archetypes, with gravity unless they fly (fixes [B F9], `Patroller.ts:38`)

| Archetype | Motion | Params: default (bounds) | Stompable | Telegraph | How the bot models it |
|---|---|---|---|---|---|
| `walker` | Walks with gravity. Turns at walls, at other enemies and, if `ledge_aware`, at ledges. | speed 2 (1-6) c/s; ledge_aware true (false on ground spanning the screen) | yes | 2-frame waddle | periodic in frames |
| `hopper` | Hops every interval with vy −380 (≈ 2.6 cells), drifting 1.5 c/s forward if `forward` | interval 1.6 (1.0-3.0) s; forward false | yes | 150 ms crouch | periodic |
| `flyer` | No gravity. Patterns: hover (bob 0.5 cell, 2 s), horizontal or vertical (range 2-10 cells), circle (r 1.5-4, period 3-6 s) | speed 2 (1-5) c/s | yes | wing flap | periodic |
| `shooter` | Stands with gravity. Fires an ink blob (6 × 6 hitbox) that dies on solid ground or after 16 cells. | interval 2.5 (1.5-5) s; blob 5 (3-8) c/s; facing left/right/toward_player | body yes | 0.4 s inflate | periodic; simulated for `toward_player` |
| `chaser` | Patrols at 1.5 c/s. When it sees the player (≤ sight cells horizontally, \|dy\| ≤ 3, no solid between), it accelerates at 600 px/s² toward them and hops 1-cell steps. It gives up 3 s after losing sight. Not ledge-aware. | speed 4 (2-5.5) c/s; sight 8 (4-12) | yes | eyes go red, "!" scribble | simulated with the player |
| `crusher` | Waits under a ceiling. Triggers when the player is within 1.5 cells horizontally below. Drops at 2500 px/s² (max 400), rests 0.8 s, rises at 2 (1-4) c/s. Lethal only while moving down onto the player; you can stand on it. | warn 0.5 (0.3-0.8) s | no (top is safe) | shakes, dust falls | simulated with the player |

- **`spiky` modifier** on any archetype: it cannot be stomped. Set by drawn spikes on the creature, or by text.
- **Drawn monster with no text:** Faithful `static` (a standing hazard); Polished+ `animate` → walker (P7, undoable).
- **Text pins:** "Sleeps", "doesn't move" and "stays" pin `static`.
- **Sprite and hitbox:** the sprite is the kid's strokes, all parts included. The hitbox comes from N13, and the feet sit on the host.

### 5.8 Hazards and platforms

| Type | From a drawing | Behavior and numbers | Art (§7.3) |
|---|---|---|---|
| Spike strip | red zigzag, or a red straight line on or near a surface | Host + face + facing. 6 px band, inset 2 px at the ends. Lethal. | kid's zigzag re-based onto the face, 9 px teeth |
| Lava | red fill or line in a pit; text "lava" | `~` tiles; hitbox 4 px below the top | wavy animated top, 2 bubbles/s |
| Saw | red circle with ≥ 5 teeth, or C6 | radius 0.75 / 1 / 1.5 cells; hitbox circle 0.8·r; static or on a `move` path ≤ 8 cells (designer); speed 3 (1-6) c/s | spinning scribble; whirr whose gain follows proximity |
| Firebar | text "fire bar", or C6 (Hard) | anchor + 3-6 balls (r 5 px); 90 (45-180) °/s; phase | ink fireballs |
| One-way platform | a thin floating stroke | land from above; drop with Down + Jump (12 f) | stroke + dotted underside |
| Slope | tilted strokes | 1:1 and 1:2 only | stroke along the slope |
| Moving platform | an arrow, or text "moves" | direction + 2-20 cells; speed 2 (1-6) c/s; ping-pong or loop; waits 0.3 s at each end; carries riders. Path clipped at solids, ≥ 2 cells, else N12. | kid's stroke + motion ticks |
| Crumble | "crumbles", or C7 | shakes for 0.5 (0.3-1.0) s after first contact, falls at g 1700, respawns after 3 (2-6) s once clear | paper bits fall |
| Falling platform | "falls" | falls 0.4 s after being stood on; resets on death | - |
| Spring | "bouncy", "spring", a coil doodle | Up: vy = −450·strength (0.6-1.4). **Jump held ≈ 7 cells, not held ≈ 3.7 cells** at strength 1.0 (holding is the skill). Side: vx ±400 locked for 20 f, vy −250. | coil squash, rings |
| Key / door | a blue key shape; text "door", "key opens door" | One key opens one door by id. The door stays solid until opened (puff + glide sound). Multiple pairs are allowed. | kid strokes |
| Checkpoint | any non-rightmost flag, or P1 | touch to activate (the flag unfurls); becomes the respawn point | kid flag or pencil flag |
| Goal | the rightmost flag | touch the flag or pole: win (0.5× slow motion for 400 ms, confetti) | kid flag waving; the pole is scenery |
| Coin / big coin | blue dot / blue star, or P2-P4 | coin magnet radius 6 px; ≤ 3 big coins, banked at the next checkpoint or goal | house ink coin in the kid's blue; hand-drawn star |

### 5.9 Checkpoints, scoring, timers, stamps

- **Speedrun clock.** Always on, top centre, `m:ss.cc`.
  - It counts sim frames from the first input until the goal is touched, including death and respawn frames and excluding pause.
  - The time is shown on the results card [G R5].
- **Lose timer.** Only from text ("60 seconds") or C8 (1.5-2.0 × bot fastest).
  - It is shown as a ring around the clock.
  - With 10 s left, the music speeds up 10% and the ring pulses. When it expires you lose and the level restarts.
  - v1 timers gave 11-15× slack [G §3].
- **Four stamps per level:**
  - Clear;
  - Collector (all big coins banked);
  - Speedy (≤ par = ceil_0.5 s(1.3 × bot fastest));
  - Flawless (0 deaths).

  There is also a "Beat the creator" badge when the creator has posted a run.
- **Coins.** Regular coins guide the player and fill the per-game "ink jar" counter. With lives on, 100 coins give a life. Collector counts big coins only.

---

## 6. Scrolling levels

### 6.1 World

- **Viewport.** It stays 48 × 27 cells (768 × 432 logical px), so the drawing scale is unchanged. The canvas is letterboxed to FIT.
- **World size.** `w = 48·screens`, screens 1..6 (up to 288 cells, about the length of SMB 1-1 in player-height units [G §7.3]), and **`h = 27`**.
- **Consequences of h = 27.** The full height is always visible, falls are always readable, and the camera only follows horizontally.
- **Parameterization.** Core, bot, engine bounds, tile rows, editor and CV stitching all read `world.w`. The hard-coded `GRID_W`/`GAME_W` are gone [G §6].

### 6.2 Camera (`core/sim/camera.ts`; one pure function shared by the engine and the bot's `blind_jump`)

- **Follow rule.**
  - Target x = player x + look-ahead.
  - Look-ahead is 6 cells in the facing direction while \|vx\| > 0.5 × walk speed. Otherwise it eases to the facing direction over 0.5 s.
  - Dead zone 4 cells wide around the target. The camera lerps 0.1 per frame.
  - It clamps to [0, world.w − 48].
  - There is no vertical movement.
- **Visibility guarantee.** While moving, ≥ 22 cells ahead are visible, so every run-jump landing (≤ 9.6 cells) is on screen at takeoff [G §7.3].
- **Optional rule `camera: no_backscroll`** (SMB mode): the camera never scrolls left past its max x or past the last checkpoint.
- **Events.**
  - On respawn, the camera glides to the checkpoint (≤ 300 ms).
  - On a win, zoom 1.1 with 0.5× slow motion for 400 ms.
  - Shake: death 6 px / 250 ms, crusher landing 4 px / 150 ms, stomp 2 px / 80 ms. Shake is off with `prefers-reduced-motion`.
- **Minimap strip** (HUD, top right): 1 px per cell, showing terrain, goal, checkpoints and the player dot. It appears for screens > 1.

### 6.3 Long-canvas editor (`web/src/editor/`)

| Feature | Spec |
|---|---|
| Surface | Vector strokes in cells on a 48·k × 27 strip; a dot grid every cell; dashed screen boundaries labelled 1..k (perforated lines). |
| Navigation | Two-finger pan, space-drag, middle-drag, horizontal wheel or trackpad. Pinch or Ctrl-wheel zoom 0.5-3×. At 1×, a cell is 16 CSS px on desktop and ≥ 12 px on a phone. "Fit screen" button. |
| Screens | "+ Add screen" on the right edge (≤ 6); delete or trim an empty last screen; a minimap of thumbnails at the bottom with a viewport box; tap to jump there. |
| Marker | 4 colours with icons (ground, spikes, goal, coin), **12 px (0.75 cell) wide** with pressure ±20%. |
| Tap | A press with < 4 px of movement and < 250 ms stamps a **14 px dot** (coin-sized) [B F7, V 5]. |
| Line | Holding still 400 ms at the end of a stroke straightens it (if the residual is < 0.4 cell). An optional row-snap toggle. |
| Eraser | Tap to delete a stroke; scrub to split strokes. |
| Select | Lasso or tap; move, delete, recolour; **"What does it do?"** (§7.11). |
| Stamps | coin, big coin, spikes, flag, checkpoint, spring, saw, walker, hopper, flyer, key, door, start, plus the game's library types. |
| Undo / redo | Command stack, 200 steps. Strokes may cross screen boundaries. |
| ▶ Test-play | Builds locally (Faithful, `repairUnsolvable: false`) in < 0.3 s and plays with the real camera and world. **Long-press ▶, or drag the player flag, to "play from here"** at a chosen standable cell. ✎ returns to the drawing. |

### 6.4 Multi-sheet paper

- **Template v2** (`shared/template_spec_v2.json`):
  - The v1 A4 layout is kept: ArUco markers, swatches, a 240 × 135 mm drawing area = 48 × 27 cells.
  - The header reads "Sheet n of k".
  - The character box and rules box appear on sheet 1 only.
  - **Seam marks:** the left and right edges of the drawing area carry gray row numbers 3, 6, …, 24 and arrows "← sheet n−1 | sheet n+1 →". Remix and continuation prints also show the neighbour's terrain end heights as gray dashes in the first and last cell columns.
- **QR grammar v2:** `dal2|p|<pack_id>|<n>/<k>`, `dal2|rules|<game_id>`, `dal2|lib|<game_id>`.
  - Regex: `^dal2\|(p|rules|lib)\|[A-Za-z0-9_-]{4,32}(\|[1-6]/[1-6])?$`.
  - The pack record on the server (`packs` table) knows the pack kind (`new`, `game`, `remix`, `extend`), `game_id`, `parent_id` and k. The QR stays small and printing is the only server dependency.
  - v1 `dal1|…` payloads are still read, as a 1-sheet pack.
- **Printing.** `POST /api/v2/packs {kind, k, game_id?, parent_id?}` returns `{pack_id, pdf_url}`. The PDF has k pages.
- **Scanning.**
  - The scan screen has a **pack tray**: sheets can be scanned in any order, with a checklist "Sheet 2 of 4 ✓".
  - Each sheet is rectified and calibrated independently. It maps to world x ∈ [48·(n−1), 48·n).
  - If two photos share an index, the latest wins.
  - A missing sheet becomes an empty screen with the warning "Sheet 2 of 3 is missing: scan it or continue without it".
  - **The level is playable as soon as the scanned sheets form a contiguous run from sheet 1. Publishing requires all k sheets and a goal.**
- **Seams.** N11 `join_seam` joins strokes that end within 0.75 cell of the seam on both sides with Δy ≤ 1 cell, as one stroke with the averaged seam point. Unmatched ends stay as real gaps.
- **Model.** PERCEIVE runs **per sheet, in parallel**, with a 2-cell context strip from each neighbour. A component that crosses a seam takes the id from the sheet holding most of its ink. Latency therefore stays flat as length grows; cost grows linearly (§3.14).

### 6.5 Remix across sheets, and re-scanning

- **Remix print.** The remix PDF prints k pages with the parent's ink in gray #B0B0B0 (the v1 background class).
  - **Parent coins, keys and goals print as gray *outline* glyphs**, never filled blue or green. They classify as gray and cannot turn into duplicates.
  - Scanning any subset of sheets changes only those screens; the others inherit the parent unchanged.
- **Object-level remix diff** (`core/scene/remix.ts`):
  - New ink objects are matched to parent objects by role and overlap (IoU ≥ 0.3, or centre within 1 cell). A match is the **same object** and keeps its id.
  - Only unmatched ink becomes new objects.
  - N10 de-duplicates same-type entities within 0.75 cell, keeping the parent's.
  - Test: re-scanning an untouched remix sheet yields **0 new objects** and an unchanged coin count (fixes "remix duplicates coins").
- **Extending a level.** Pack kind `extend` prints one blank sheet with the parent's last 2 columns in gray; it appends a screen.
- **Paper to screen.** A scanned level opens in the canvas editor as vector strokes, so a kid can scan, then tweak on screen. "Remix on screen" loads the parent's strokes locked in gray; unlocking allows moving or deleting them.

### 6.6 Performance for long worlds

- **Terrain ink** is rasterized into 1024 × 432 logical-px chunks at render scale r. Only chunks within the camera ± 1 are resident, held in an LRU of 4. At r = 2 that is ≈ 28 MB.
- **Entities** outside the camera + 4 cells are culled from rendering but still simulated (determinism).
- **The bot and designer** re-analyze only the segments that intersect an edit's bbox ± 10 cells.
- **Gate:** a 6-screen level runs at ≥ 55 fps on a mid phone (Pixel 6 / iPhone 12 class) with boil on.

---

## 7. Visual pipeline, art direction, and the preview UX

### 7.1 Art direction: "living ink on paper"

One renderer draws every level, thumbnail, seed and golden. That removes v1's three clashing styles: flat seed blocks, doodle entities and the raw photo [V 8]. It uses three inks, so a player can always tell who drew what.

| Ink | Who | Look | Use |
|---|---|---|---|
| **Marker** | the kid (and parent ink in remixes) | Solid and saturated. Canonical palette: ink #1F1B18, red #E0453A, green #3E9E4F, blue #2C7BE5. Their own strokes, cleaned and top-aligned. | everything they drew |
| **Pencil** | the designer | Coloured-pencil grain with a 45° hatch at 85% opacity. Graphite-violet #6A5ACD for neutral additions. Red pencil with a dark outline for hazards, so they stay clearly lethal. On first appearance, a 400 ms stroke-reveal animation. | every P, C, R4 and R5 addition (I5) |
| **Graphite / blue-line** | the world and prompt drafts | Graphite at ≤ 30% contrast for parallax and the sketch underlay. Non-photo blue #8FB8DE for prompt-to-level drafts. | backgrounds; drafts to draw over |

**Readability rules** (checked in the golden visual review):
1. Anything that hurts is red-family, has a dark outline and an animated tell: spikes shimmer 1 px, saws spin, lava waves.
2. Anything you can stand on has a crisp top edge that **is** the collision surface (§7.3).
3. **Anything that doesn't collide doesn't look solid.** Decoration renders at 55% opacity with a 20% watercolour wash inside closed shapes. Text and arrows render as graphite "signs" at 70%.
4. Gameplay ink always sits above parallax. Foreground tufts are never within 2 cells of a hazard.
5. The HUD sits on paper plates, never directly on ink.
6. A pit always has an "abyss scribble" at the world bottom, so falls are never invisible.

**Type.** "Patrick Hand" (OFL), **bundled** as woff2 in `web/public/fonts/` so it works offline. It is used for the HUD, buttons and headings; long text uses system-ui.

### 7.2 Stroke cleanup (`core/art/clean.ts`)

1. Resample to 0.125 cell. Apply 2 iterations of Chaikin smoothing **between detected corners** (turns > 60° are kept). Then RDP with ε 0.075 cell (1.2 px), which is finer than the physics fit, so the stroke keeps its character.
2. Smooth the width profile (window 9) and clamp it to 3-10 logical px. Taps render as dots ≥ 10 px.
3. Close near-touching ends (≤ 3 px) on closed shapes such as flags and creatures.
4. **Paper re-inking** (owner default on). Paper strokes are redrawn as vector marker strokes in the canonical palette, using the colour class from v1's swatch calibration. Every paper level then looks equally good in any lighting. The photo survives only as an optional "my original sketch" underlay at 15% opacity with linear filtering.

### 7.3 Art from geometry: what you see is what you stand on

**Top-edge alignment** (`core/art/terrain.ts`). For each terrain object:
- Compute `Δ(x) = collision_top(x) − ink_top(x)`. By construction \|Δ\| ≤ 0.85 cell (the N1 bound), and it is typically ≤ 8 px.
- Smooth Δ over 5 px, then apply y' = y + Δ(x) to every point of that object's strokes.
- The drawn line's top edge now lies **within 1 px** of the surface the player stands on. The line keeps its own width variation and lower-edge texture: "my drawing, tidied", not "redrawn by a machine" [J].
- This closes [B F13]: v1's mean offset was 5-14 px, and ≥ 4 px on 56-96% of surfaces.

| Role | Recipe |
|---|---|
| Ground | Aligned marker stroke. Below it, a 45° graphite hatch (7 px spacing, 1.2 px, 28% alpha) over a paper tint #EFE7D6 at 60%, filling exactly the solid cells. |
| One-way platform | Aligned stroke plus a dotted underside (3 dots per cell): "you can jump through". |
| Solid floating platform | Stroke plus 1 cell of light hatch underneath. |
| Wall / ceiling | The same rule on the colliding face, with hatch on the solid side. |
| Spikes | The kid's zigzag vertices projected onto the host face and normalized to 9 px teeth. A straight red line gets generated 8 px teeth. Fill #F6B3AD with a marker-red outline, pointing away from the host. |
| Enemy / key / door / spring / creature | The kid's vector strokes (every `part_of` part), baked into a sprite at render scale r. Crisp, never nearest-neighbour, **no raster crop and no whitening** [B F8, F15]. |
| Coin | A house coin: a 10 px ring in the kid's blue with a shine tick. **The kid's dot is not drawn again** [B F14]. |
| Big coin | The kid's star if drawn, otherwise the house star. Pulsing outline in the HUD until banked. |
| Goal | The kid's flag with a waving vertex wobble; the pole is scenery. **There is never a second engine flag** [B F14, V 8]. |
| Decoration | The kid's strokes at 55% + watercolour wash. |
| Text / arrow | The kid's handwriting at 70% graphite, as a sign. "jump!" stays visible and is never a wall. A bound arrow is hidden while its platform moves (undo shows it). |
| Designer additions | Pencil recipes, with house doodles: walker blob, hopper frog, flyer bat, shooter cannon, chaser angry blob, crusher block, plus a pencil checkpoint flag, coin trail, hint arrow, step and spring. |
| Prompt drafts | Blue-line strokes with seeded wobble. |
| Migrated v1 levels | Solid regions traced with marching squares, wobbled with seeded noise, drawn as marker. |

**Acceptance (automated).**
- For every walkable surface sample every 4 px, \|art_top − collision_top\| ≤ 1 px.
- 0 collision cells with no art above them.
- 0 strokes without an object.

### 7.4 Rendering technology

- **Phaser config** (`web/src/engine/index.ts`): `pixelArt: false`, `antialias: true`, `roundPixels: false`, WebGL. The Canvas renderer is a fallback without boil. This fixes [V 3] and [B F16].
- **Render scale r ∈ {1, 1.5, 2}.**
  - r is the smallest value ≥ min(2, devicePixelRatio × displayed CSS width / 768).
  - The backing store is 768r × 432r and the main camera zooms by r. Example: the measured 669 CSS px at DPR 2 gives r = 2, a 1536 px backing store shown with linear downscaling. v1 instead stretched 768 px by 1.74× with nearest-neighbour [V §1].
  - Physics stays in logical px.
  - On resize (debounced 250 ms), chunks re-rasterize at the new r without restarting the scene.
- **One art pipeline.**
  - `core/art/artdoc.ts` turns `(level, ink, theme, seed)` into an **ArtDoc**: pure data layers of paths with style ids, deterministic.
  - `web/src/render/canvas_ink.ts` rasterizes the ArtDoc into Canvas2D chunk textures with LINEAR filtering, for play, preview, thumbnails and seeds.
  - `core/art/svg.ts` serializes the same ArtDoc to SVG in Node, for golden baselines and the spec's reference images [GF].

| Depth | Layer | Scroll factor |
|---|---|---|
| 0 | paper (theme tile + vignette) | - |
| 10 / 20 | far / mid parallax | 0.2 / 0.5 |
| 30 | sketch underlay (optional) | - |
| 40 | decoration + signs | - |
| 50 | terrain chunks | - |
| 60 | entities | - |
| 70 | player + ghosts | - |
| 80 | particles | - |
| 90 | foreground tufts | 1.1 |
| 100 | preview overlays (ghosts, bot path, flags, reach halo), **in-scene** so they follow moving sprites [V §3] | - |

The HUD uses a separate camera with no zoom and no shake.

### 7.5 Living ink: boil, paper, parallax

- **Line boil.** `InkBoilFX` (`web/src/render/boil_fx.ts`) is a WebGL PostFX pipeline on the decoration, terrain and entity layers.
  - It displaces UVs by a tileable 3-frame noise texture (amplitude 0.7 logical px) and switches frame every 6 sim frames (10 fps).
  - It needs **no texture variants**, so memory does not grow. MF's 3-variant render textures were rejected [J].
  - It turns off under `prefers-reduced-motion`, when fps < 50 for 2 s (auto-degrade), and on the Canvas renderer.
  - Physics never boils.
- **Paper themes** (rules sheet). A procedural 512 × 512 fBm grain tile (4 octaves, ±4% luminance) is made once at boot. Every theme has a 12% vignette.

  | Theme | Look |
  |---|---|
  | sketchbook (default) | cream #FBF6EA with a 6% dot grid every 16 px |
  | notebook | blue rules every 32 px + a red margin |
  | graph | 10% blue 16 px grid |
  | kraft | #D9C2A0 with fibre noise; ink lightened 8% |

- **Parallax** (`core/art/parallax.ts`). It is deterministic from (level id, theme) and needs no assets.
  - Far layer: 2-3 graphite hill lines (sums of 3 sines from the sine table) and scalloped clouds every ~12 cells, drifting at 2 px/s.
  - Mid layer: bush, grass and tree doodles every 6-10 cells.
  - Foreground: tufts about 1 per 8 cells on terrain tops.
  - Everything stays at ≤ 30% contrast. Levels stop looking like "70% blank paper" [V §1].

### 7.6 Sprites that come alive from one drawing

**Rig extraction** (`core/art/rig.ts`). It runs for studio vectors and for paper character boxes, because CV v2 sends the character as strokes.
- **Body:** all strokes.
- **Legs:** 1-4 strokes whose lowest point is in the bottom 25% of the bbox, within 35° of vertical and ≥ 15% of the height long. If none are found, 2 stick legs are synthesized in the kid's main ink colour.
- **Arms:** strokes in the middle band that stick out past the body silhouette.
- **Eyes:** 1-2 small closed dark blobs (≤ 12% of the width) in the top half.
- **Sprite:** rendered from vectors at 4× (128 × 192 px) and displayed at 32 × 48 world px with LINEAR filtering. This fixes v1's 32 × 48 nearest-neighbour squeeze [V §2].

**Player animation** (`web/src/engine/views/PlayerView.ts`). It is driven only by sim state, so ghosts animate identically.

| State | Animation |
|---|---|
| Run | Legs swing ±28° at f = 1.8 + 0.12·speed (c/s) Hz in opposite phase. Arms swing ±20° against them. Body bobs 1.5 px at 2f. Lean 4° × v / vmax. |
| Skid | Lean back 10°, dust |
| Jump | Launch squash (scaleX 0.8, scaleY 1.25), easing to 1 over 120 ms. Apex (1.05, 0.95). Falling: legs together, arms up 30°. |
| Land | (1.25, 0.75) back to 1 over 140 ms, scaled by impact (vy / 330) |
| Idle | Breathing scaleY 1.00 ↔ 1.03 at 0.6 Hz. A 100 ms blink every 2.5-5 s (seeded) when eyes were found. Pupils shift 1 px toward the nearest enemy or coin within 6 cells. |
| Turn | 60 ms squash, then flip |
| Death | The sprite is cut into 12-16 precomputed Voronoi shards that fly with gravity and spin. Respawn plays it in reverse. |

**Enemies and objects.**
- Enemies waddle (±6° at 3 Hz, 1 px bob), watch the player with their eyes, and flash an angry outline within 4 cells. A stomp flattens them to 25% height, and they puff away over 300 ms.
- Flags wave.
- Moving platforms trail speed ticks above 2 c/s.
- Crumbles shake.

### 7.7 Juice

| Event | Hit-stop | Shake | Particles (pre-baked ink textures, ≤ 300 alive) | Sound | Extra |
|---|---|---|---|---|---|
| Jump | - | - | 5 dust specks | jump | squash |
| Land | - | - | 4-8 specks, scaled by impact | land | squash |
| Skid | - | - | 3 specks every 4 f | skid | lean |
| Coin | - | - | 6 sparkles; the coin flies to the HUD (bezier, 350 ms) | coin (combo pitch) | - |
| Big coin | 3 f | - | ring of 12 + 16 confetti | arpeggio | HUD slot pulses until banked |
| Stomp | 4 f | 2 px / 80 ms | 8 ink splats + ring | stomp (chain pitch) | enemy squash |
| Death | 6 f | 6 px / 250 ms | ink shards | death | camera glide to the checkpoint |
| Checkpoint | - | - | 10 sparkles | chime | flag unfurls |
| Spring | - | - | 2 shock rings | boing | coil squash |
| Crumble | - | - | 6-10 paper bits | crumble | shake |
| Door opens | 2 f | - | puff of 14 | glide | - |
| Goal | - | - | 60 confetti scribbles | jingle | 0.5× slow motion for 400 ms, zoom 1.1 |

### 7.8 Synthesized sound (WebAudio, no asset files; `web/src/audio/`)

v1 shipped with `noAudio: true` [G R8].

| Sound | Recipe |
|---|---|
| Jump | square 260 → 520 Hz, exponential over 90 ms; attack 2 ms, decay 120 ms; gain 0.18; ±3% random pitch (UI-side RNG, not sim) |
| Double jump | triangle 400 → 800 Hz over 80 ms |
| Land | noise burst through a 400 Hz lowpass, 60 ms; gain scaled by impact |
| Coin | triangle 988 Hz for 50 ms, then 1319 Hz for 120 ms; +1 semitone per coin within 1.2 s (cap +7) |
| Big coin | C6-E6-G6-C7 at 60 ms per note + shimmer (detuned triangles) |
| Stomp | square 180 → 80 Hz over 100 ms + noise click; +2 semitones per chain step |
| Death | sawtooth 440 → 110 Hz over 300 ms + 120 ms noise |
| Spring | FM: carrier 220 Hz, modulator 110 Hz, index 6 → 0 over 250 ms |
| Checkpoint | triangle chime 660 Hz then 880 Hz |
| Goal | C5 E5 G5 C6 G5 C6 on square + triangle, 900 ms |
| Crumble / skid / door / saw / UI tap | bandpass noise 1.2 kHz 150 ms / bandpass noise 2 kHz 80 ms / triangle 300 → 600 Hz 200 ms / looping filtered noise with gain = proximity / sine 880 Hz 30 ms |

**Music.**
- One generative loop per theme: sketchbook in C major pentatonic, notebook in D dorian, graph in G mixolydian, kraft in A minor pentatonic.
- 4 bars at 100 BPM: a triangle bass on beats 1 and 3, a 12.5%-duty square lead seeded by the level id, and noise hats.
- Mix: master 0.6, music 0.25. Music ducks 50% under jingles and speeds up 10% in the last 10 s of a timer.
- Mute with M or the HUD button; the setting is stored in localStorage.
- The AudioContext resumes on first input. The preview stays muted until Play.

### 7.9 HUD, results, chrome, thumbnails

- **HUD plates.** Paper rounded rectangles with a 2 px marker outline and ±1° rotation.
  - Left: coins + 3 big-coin slots.
  - Centre: the clock (and the timer ring when a timer rule exists).
  - Right: deaths (skull doodle), hearts and lives when enabled, the minimap, and mute / restart / pause.
- **One win moment** [V 9].
  - The canvas plays slow motion and confetti only. **`Hud.showBanner` is deleted.**
  - Then exactly one HTML results card appears (`[data-role=results]`). It shows the time large, with its delta to your PB; the four stamps slapping on one after another with a "thunk"; deaths, coins and big coins; the creator's time or the "beat my level" result.
  - Its buttons: Retry (R), Next level, Watch ghost, Challenge a friend, Remix.
- **Chrome.**
  - Paper cards with tape corners, marker underlines and marker-outlined pill buttons. The game canvas is always on light paper.
  - The dev footer and fixture links move to `#/dev` [V §1].
- **Thumbnails.**
  - The feed renders them with the same ArtDoc → Canvas2D path (entities, player and goal included) and caches them in IndexedDB by `id@version`.
  - At publish, the client uploads a 640 × 360 PNG for share cards. If no PNG is uploaded, the server stores an SVG from the worker's `art_svg`.
  - Remix-tree nodes outline new objects in pencil.

### 7.10 The preview: what I saw, what I changed, how it plays

**Layout.** On desktop the stage takes 70% and the report 30%. On a phone in landscape, the stage is full screen and the report is a swipe-up sheet with tabs *Saw · Changed · Plays*.

**Top strip.**
- Stage chips: "① Ink ✓ 0.5 s · ② Understood ⏳ · ③ Designed".
- The **dial**: Faithful | Polished | Challenging ▾ (Normal, Hard). Positions are precomputed, so the swap is instant. Added pieces sketch themselves in (400 ms pencil reveal) and removed ones erase.
- The **difficulty pill**: "Easy · ~1 fall in 6 tries · bot 0:31", plus 0-5 ink drops for the score.
- If a tier is unreachable: "This drawing goes up to Normal without changing what you drew".
- An editable title suggestion, **Play test**, and **Publish**.

**Designer note.** At the top of the report, in the model's voice, for example: "Your level is a race over a spike valley. I set your spikes on the platforms like you drew them and added a checkpoint after the hardest jump."

**Report sections.**
1. **What I saw.**
   - Objects grouped by role, each with an icon and a thumbnail of the kid's own strokes. Examples: "Ground ×3", "Spike strip on the left ledge, pointing up", "Monster (walks) with its eyes", "Flag = goal; pole is scenery", "2 coins from your dots", "'jump!' is a sign; you can walk through it".
   - Confidence shows as a solid or dotted chip border.
   - Items below 0.75 show "Is this right?" with one-tap re-labels from `alt` first (platform, wall, decoration, enemy, spikes, text). A re-label is a kid U1 edit that rebuilds in < 150 ms per screen.
   - Ignored specks are counted ("I ignored 3 tiny specks").
2. **What I changed.** Cards grouped as:
   - *I understood* (pole is scenery, tree is scenery);
   - *I fixed* (snapped spikes, smoothed 6 wobbly lines, planted the flag);
   - *I added* (designer pencil);
   - *Heads up* (flags).
3. **Questions.** Ask cards, such as "Which door does this key open? Tap it." or "Is this black bar a door?". The answer is a kid edit.
4. **How it plays.**
   - **Watch the bot:** a pencil ghost of the kid's own character runs the bot's route at 1×. Tight jumps get an orange ring and blind spots an eye icon.
   - Bot time and par.
   - A band bar per segment (the sawtooth).
   - Flags as plain sentences, each with **Fix it**. Example: "The jump after the second checkpoint is 9 cells. You need a long run-up there. Add a coin arc?"
   - **Why is this hard?** calls CRITIC with the creator's own deaths.

**Card anatomy.**
- An icon and a one-line reason (from the message template, or the model's reason for model picks).
- A badge: "fixed for you 🔧", "designer ✎" or "designer's pick ✨".
- A **Keep / Undo** toggle. Undo animates a ghost: the piece slides back to where it was drawn.
- Tapping the card draws stage ghosts: *before* as a dashed graphite outline, *after* as a solid pencil outline, with an arrow for moves.
- A "why?" disclosure with the number ("This jump was 9 squares. Running you can jump 8, so I moved the ledge 1 square closer.").
- Dependent cards grey out with "needs: …".
- `required` repairs show a lock note: "needed so the level can be finished". They can still be undone, but then publishing is blocked.
- **Make it mine** on designer objects.
- In the footer: **Undo all changes**, which shows the drawing exactly as drawn (Faithful minus repairs), and a "Rejected ideas (n)" disclosure for the curious.

**Toggles.** A toggle rebuilds and fast-verifies locally in the browser core (< 150 ms per screen) and morphs the stage. Full metrics refresh in a Web Worker in ≤ 1 s. Then `PUT /api/v2/drafts/{id}/edits` persists the statuses.

**Publish** is enabled only when all of these hold:
- the bot cleared the selected tier;
- the engine reports no `entity_error`;
- every Ask card is answered or defaulted;
- safety is `ok` (`held` publishes unlisted).

When Publish is disabled, it says why in one sentence and offers a fix button. Fairness flags that come from the kid's own drawing do **not** block publishing; they show as Heads up cards with Fix it.

**Text.** All text comes from `shared/spec/messages.json`: keys mapped to sentences of ≤ 12 words for reading age 7. **Raw codes never appear in the DOM** [V §3]. Excerpt:

| Key | Text |
|---|---|
| `norm.pole_scenery` | Your flag pole is scenery now, so it won't block you. Touch the flag to win! |
| `norm.goal_grounded` | Your flag was floating, so I planted it on the ground. |
| `norm.spikes_snapped` | These spikes were hovering, so I stuck them on the {host}, pointing {facing}. |
| `norm.tidy_lines` | I smoothed {n} wobbly lines so you won't trip. |
| `norm.oneway_platform` | Thin floating lines are jump-through. Jump up through them! |
| `norm.spawn_moved` | You started next to spikes, so I moved your start {cells} squares. |
| `understand.decoration` | That {what} is scenery. You can walk through it. |
| `understand.text_sign` | "{text}" is your note. It's a sign, not a wall. |
| `repair.ledge_nudged` | This ledge was {rise} rows up. The highest jump is {max}. I moved it {dy} down. |
| `repair.gap_nudged` | This jump was {gap} squares. Running jumps go {max}. I moved this ledge {dx} closer. |
| `repair.wall_trimmed` | This wall was too tall to jump. I made it {cells} shorter. |
| `polish.checkpoint` | I added a checkpoint so you don't replay {seconds} seconds. |
| `polish.coin_trail` | Coins show the jump. Run before this gap! |
| `polish.monster_walks` | Your monster walks now. |
| `flag.tight_window` | This jump is very tight. Most players will fall here. |
| `flag.skippable_setpiece` | Nobody will meet your spikes here. |
| `error.entity` | I couldn't build the {thing} near {where}. I turned it off. |

**Back to drawing.** It opens the editor with the current objects as editable vectors. Edits are kept by object id, and the toggle "Bake my fixes into the drawing" is available. v1 lost everything here [V §2].

### 7.11 The editor knows it is making a level

- **Live hints.** The core runs in a Web Worker, debounced 150 ms after each stroke. All hints switch off with "Hints off".
  - Role chips fade after 2 s and stay on selected objects.
  - A reach halo from the start shades reachable standing cells green.
  - Red dashed "too far" markers on unreachable gaps, with "needs a run-up" when a run-jump would make it.
  - Snap ghosts show where floating spikes will land.
  - The goal pulses while it is unreachable.
- **Rules attached to things.**
  - Select a stroke, then **"What does it do?"** opens chips over the fixed vocabulary:
    - moves ↔ or ↕ with a distance slider;
    - walks, hops, flies, shoots, chases or crushes;
    - bouncy, crumbles, falls;
    - key → tap a door; door; checkpoint; start here.
  - Each chip writes an explicit kid binding (U4/U5) into the stroke with confidence 1.0. Those components are **pinned**, and PERCEIVE skips them.
  - Free text typed while a stroke is selected carries that component id, so a typed rule can never bind the wrong object [B F10].
- **Character Studio** (fixes the half-wired character box [V §2]).
  - A 256 × 256 vector canvas with its **own** palette, tools and undo, and an onion-skin of the 12 × 28 body box scaled up.
  - A live mini-stage where the doodle runs, jumps and lands with its rig as you draw.
  - "Save to library as my player". The character is kept in the draft and restored on return.

---

## 8. Extensions

### 8.1 Object library per game

```ts
interface LibraryType {                       // shared/spec/library.schema.json; immutable per version
  id: string; game_id: string; version: number;
  name: string;                               // ≤ 16 chars, deterministic blocklist
  letter: string;                             // circled paper tag, unique per game, auto-assigned (first free letter of the name)
  kind: 'creature' | 'platform' | 'hazard' | 'pickup' | 'prop' | 'player';
  behavior: Behavior;                         // the same typed union as bindings (§5.7-5.8), numbers from the grids
  spiky: boolean; collision: 'solid' | 'one_way' | 'none';
  art: { strokes: InkStroke[]; size_cells: [number, number]; rig?: Rig };
  symbol: { samples: InkStroke[][] /* 3 */; color: InkColor } | null;
  author: string; created_at: string;
}
```

**Make one.**
1. **Creature Studio** ("Make a creature"): draw it, name it, then pick chips (walks, hops, flies, shoots, chases, crushes; spiky; slow ↔ fast) or type a sentence.
   - The CREATURE call (low, ≈ $0.02) pre-selects the chips. Offline, keywords do it.
   - A mini-stage shows it moving with gravity against a dummy player. Optionally, "draw its symbol 3 times" registers a paper symbol.
2. **From a level:** select any object, then "Save to library". Its strokes and behavior are kept.
3. **On paper:** the Library Sheet (`dal2|lib|<game>`) has 6 boxes, each with a drawing area, a name line, 9 behavior checkboxes and 3 symbol cells.
   - Checkboxes are read by OMR: ink fill > 15% of the eroded box interior. Two ticks in a single-choice group trigger an ask.
   - The name is read by PERCEIVE. Offline it becomes "Creature N" and the kid types the name.

**Place one.**

| Path | Mechanism | Deterministic? |
|---|---|---|
| Editor stamp | writes a stroke with `lib = {type_id, version}` (pinned) | yes |
| Paper symbol | H21: normalize the glyph to 32 × 32 (aspect kept); chamfer distance on rendered skeletons against the 3 samples ≤ 0.12 cell, same ink → match, conf 0.80 | yes |
| Paper circled letter or written name (within 2 cells of a blob) | PERCEIVE returns `BLibrary{target, type_name}`, matched case-insensitively | model |
| Uncertain or offline | Ask chip "Is this Grumpo?" with library thumbnails | kid |

- **Instance art.** An instance uses the type's art at its size by default. A per-instance toggle, "use my new drawing", switches to the new blob.
- **Overrides.** Per-instance speed and range overrides are allowed on the param grids.
- **Versioning.** Editing a type creates version n + 1. Levels pin their version, so a published level never changes silently. "Update levels to v3" rebuilds and re-verifies them explicitly and lists any that break.
- **Self-contained exports.** Exported and remixed levels embed the types they use (`embedded_library`).

### 8.2 Game rules sheet

```jsonc
// shared/spec/rules.schema.json (GameRules)
{ "version": 3,
  "physics_profile": "v2-standard",           // v2-gentle | v2-standard | v2-snappy | v1-classic (migrated only)
  "abilities": { "run": true, "stomp": true, "double_jump": false, "fast_fall": true },
  "lives": "off", "hearts": 1,                // lives off|3|5; hearts 1..3
  "theme": "sketchbook", "music": true,       // sketchbook | notebook | graph | kraft
  "timer_pressure": false,                    // lets Challenging add timers (C8)
  "camera": "follow",                         // follow | no_backscroll
  "default_dial": "polished", "default_band": "normal",
  "player_type": null }                       // the game's default character (library type id)
```

- **On screen** (`#/game/:id/rules`):
  - A printed-sheet-style screen with big checkboxes.
  - A mini-stage shows the jump arc for the selected profile and abilities, so "double jump" is visible before you commit to it.
- **On paper:** the Rules Sheet (`dal2|rules|<game>`) is a checkbox grid:
  - profile: Gentle / Standard / Snappy;
  - each ability;
  - lives and hearts;
  - the 4 theme swatches;
  - music on/off;
  - default dial.

  It is read **deterministically by OMR** with no model: box positions come from `template_spec_v2.json`; a box is ticked at > 15% fill; two ticks in a group trigger an ask. An optional "My world is…" line is read by PERCEIVE for the game title and blurb.
- **Effects.**
  - Rules are game-wide. Each level stores the **resolved snapshot** at publish (`level.rules`), so later changes never alter published levels or invalidate runs.
  - "Apply to all levels" dry-runs the bot over the game first (`POST /api/v2/games/{id}/rules/check`). It lists every level that would become unsolvable (for example, turning off *run* kills run-gaps). The change is then blocked, unless the creator lets the designer repair those levels with Faithful repairs (shown per level) or cancels.
  - The bot and the designer always use the game's rules.

### 8.3 Prompt-to-level: text → beats → verified draft you draw over

1. **PLAN** (low, ≈ 11 s and $0.036 measured [M D]). The model returns a `LevelPlan`: sections of **beats** from a fixed vocabulary, each carrying its teach / test / twist / finale / rest role. **The model chooses pacing and content; code chooses the exact geometry and proves it** [GF, J].

```python
class BeatFlat(BaseModel):    kind: Literal["flat"]; length: int; enemy: Literal["none","walker","hopper","chaser"]; coins: int; spikes: Literal["none","middle","far_end"]
class BeatGap(BaseModel):     kind: Literal["gap"]; width: int; floor: Literal["void","spikes","lava"]
class BeatStep(BaseModel):    kind: Literal["step"]; rise: int; length: int
class BeatStairs(BaseModel):  kind: Literal["stairs"]; n: int; rise: int; run: int
class BeatPillars(BaseModel): kind: Literal["pillars"]; n: int; spacing: int; hazard: Literal["void","spikes","lava"]
class BeatFloaters(BaseModel):kind: Literal["floaters"]; n: int; dy: int; spacing: int; oneway: bool
class BeatCeiling(BaseModel): kind: Literal["ceiling"]; length: int; spikes: bool; headroom: int
class BeatWall(BaseModel):    kind: Literal["wall"]; height: int; spikes: Literal["none","near_face"]
class BeatBridge(BaseModel):  kind: Literal["moving_bridge"]; gap: int; speed: Literal["slow","normal","fast"]; vertical: bool
class BeatCrumble(BaseModel): kind: Literal["crumble_run"]; n: int; floor: Literal["void","shallow"]
class BeatSaws(BaseModel):    kind: Literal["saw_corridor"]; length: int; saws: int
class BeatTower(BaseModel):   kind: Literal["tower"]; tiers: int; rise: int; oneway: bool
class BeatGauntlet(BaseModel):kind: Literal["enemy_gauntlet"]; archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher"]; n: int
class BeatSpringUp(BaseModel):kind: Literal["spring_up"]; height: int
class BeatKey(BaseModel):     kind: Literal["key"]; place: Literal["high","guarded","alcove"]
class BeatDoor(BaseModel):    kind: Literal["door"]
class BeatRest(BaseModel):    kind: Literal["rest"]; length: int
class BeatCheckpoint(BaseModel): kind: Literal["checkpoint"]
class BeatGoal(BaseModel):    kind: Literal["goal"]; style: Literal["flag","staircase"]
Beat = Annotated[BeatFlat | BeatGap | BeatStep | BeatStairs | BeatPillars | BeatFloaters | BeatCeiling | BeatWall | BeatBridge | BeatCrumble | BeatSaws
                 | BeatTower | BeatGauntlet | BeatSpringUp | BeatKey | BeatDoor | BeatRest | BeatCheckpoint | BeatGoal, Field(discriminator="kind")]
class Section(BaseModel):  role: Literal["teach","test","twist","finale","rest"]; beats: list[Beat]
class LevelPlan(BaseModel):
    title: str; theme: Literal["sketchbook","notebook","graph","kraft"]; screens: int
    band: Literal["easy","normal","hard"]; sections: list[Section]; kid_summary: str; safety_ok: bool
```

   **Integer clamps by band** (code, `core/generate/beats.ts`):

   | Beat | Easy | Normal | Hard |
   |---|---|---|---|
   | gap width | 2-4 (walk-gap) | 4-6; width ≥ 5 gets a runway of ≥ 4 cells | 6-8 with a runway of ≥ 3 cells |
   | step rise | 1-2 | 2-3 | 3-4 (needs a walking jump) |
   | floaters / pillars spacing | 2-3 | 3-4 | 4-6, landings 2 |
   | enemy_gauntlet n | 1 walker | 2 walkers / 1 hopper | 2-4, any archetype |
   | moving_bridge | 1 platform, slow | 2 platforms, normal | 3 platforms, fast + saw |
   | tower rise | 3 | 3 | 3-4 |

2. **Layout** (`core/generate/layout.ts`).
   - Beats are laid left to right along a ground spine (default top row 22), tracking rises and falls.
   - `flat` and `rest` stretch or trim so the level fills 48·screens. The latest key is linked to the next door.
   - Checkpoints are inserted per P1.
   - The output is an InkDoc of **blue-line strokes** with seeded wobble, `origin: 'draft'`, and `label` roles at confidence 1.0, so perception of a draft is exact and PERCEIVE is skipped.
3. **Verify.** Build, then run the bot.
   - If the level fails, a **deterministic fixer** runs up to 3 times: shrink the failing beat's width or rise by 1, or insert a `rest`.
   - Next, **one** PLAN retry, with the bot's frontier in plain words ("the jump in section 2 beat 3 needs 9 cells; max is 8 with a 3-cell runway").
   - After that, the greedy repair.
4. **Design pass** at the requested band ("medium" → Challenging·Normal).
5. **Draw over it.**
   - The draft opens in the editor as editable blue-line vectors and plays at once with ▶.
   - **Kid marker strokes that overlap a draft object (IoU ≥ 0.3) replace it: "your ground wins".** Draft objects can be moved or deleted.
   - "Ink it" turns the remaining draft strokes into marker (K1).
6. **Offline:** a keyword planner (lava, key, tower, spikes, moving, saw, easy/hard) picks one of 12 canned plans seeded by the text hash.
7. **Same generator for Starter World:** it is authored as `LevelPlan` JSON plus overrides through the same `core/generate`, so one generator is validated twice (§9).

### 8.4 Speedruns, replays, ghosts, "beat my level"

- **Replay** (`shared/spec/run.schema.json`):

  ```json
  {"v":1, "core":"2.0.0", "profile_hash":"sha256:…", "level_id":"…", "level_version":1, "level_hash":"sha256:…", "frames":3600, "input":"<base64 RLE>"}
  ```

  `input` is a base64 RLE of (u16 run, u8 bits L R J RUN D). A 60 s run is ≈ 0.3-0.8 KB. Physics is deterministic (§5.2), so the replay is the proof of the run.
- **Submit** with `POST /api/v2/levels/{id}/runs {player, replay, claimed: {time_ms, deaths, coins, big_coins}, vs_run_id?}`.
  - The worker's `verifyRun` re-simulates in ≤ 50 ms for a 2-minute run.
  - A run is accepted only if it reaches the goal and **every claimed number matches exactly**. Stamps are computed on the server. A tampered run returns 422.
  - Limits: 30 runs per minute per IP; logs over 20 min are rejected; names are ≤ 16 chars and pass the blocklist; there are no accounts (as in v1).
- **Boards.**
  - Per level: the top 10 verified **Any%** and **Collector** runs, each player's PB (name in localStorage), and the creator's best.
  - The feed sorts by New, Hot (plays in the last 7 days), Hard (score) and Most cleared.
  - Level cards show the difficulty badge, the measured clear rate from `attempts`, and the best time.
  - Runs against an older version are labelled "on an older version".
- **Ghosts.** Up to 3 at once: your PB, the leader and the challenger. Each is a 45%-alpha pencil copy of the runner's own character, stepped in lock-step from its replay.
- **Beat my level.**
  - After a clear, "Challenge a friend" makes `#/play/<id>?vs=<run_id>`, shared through the Web Share API or a copied link.
  - The friend sees "Maya cleared this in 0:41.20 with 2 deaths. Beat it!" and races her ghost.
  - The result reads "You beat Maya by 1.32 s!" (or "0.4 s to go!"), with a one-tap rematch.

### 8.5 Format v2 as a public spec

| Artifact | Content | Licence (owner default) |
|---|---|---|
| `docs/spec/level-format-v2.md` | normative prose: coordinates and units, InkDoc, LevelV2 blocks and what is normative for what, tile alphabet and rasterization (§2.4), entity semantics (§5.7-5.8), physics profiles, the camera function, the difficulty model, edit and rule vocabularies, `level_hash`, replay format, versioning | CC0 |
| `shared/spec/*.schema.json` | generated from Pydantic (D18): ink, scene, edits, level, report, events, rules, library, run, plan | CC0 |
| `shared/spec/physics-profiles.json`, `params.json` | generated from `core/sim/profiles.ts` and `core/params.ts`; **normative** | CC0 |
| `shared/spec/conformance/` | **30 levels + replays** with expected per-frame **state hashes at frames 60, 600 and end**, the expected tile-row hash, and the expected analyze summary (solvable, fastest frames, C within 0.01). An engine conforms if it reproduces them [MF]. | CC0 |
| `web/src/core/` | reference implementation | MIT |

- **Export.** `GET /api/v2/levels/{id}/export` and `GET /api/v2/games/{id}/export` return a zip containing the JSON, sprites, sketch and, for games, the game manifest, levels, library and rules.
- **Import.** `POST /api/v2/import` reverses it and must round-trip byte-identically apart from ids.
- **Credit and roadmap.** The credit chain comes from `parent_id`. GitHub mirroring stays on the roadmap.

---

## 9. Starter World v2 (the first impression)

v1's starters are a tutorial with no test. Each has 1-3 jumps and no hazard next to the route, the only enemy is decorative, and E[deaths] is 0.000 / 0.004 / 0.000. Every level is cleared in about 4-5 s [G §3, R6]. v2 replaces them with 5 long levels that follow **teach → test → twist → finale** inside each level and a rising sawtooth across the world [G §5, §7.4].

**Common settings.**
- Profile `v2-standard`; h = 27; the main ground top is row 22; the spawn is at x = 2.
- Checkpoints are placed so every segment has F_s ≤ 30 s.
- **3 big coins** per level, in risk spots. Each is optional and returnable, with a detour p_death ≥ 0.1.
- par = ceil_0.5 s(1.3 × bot fastest).
- **Authoring:** `shared/starter/L*.plan.json` (LevelPlan beats, the **same generator as prompt-to-level**, §8.3) plus `L*.overrides.json` (ordinary explicit edits). This produces blue-line → marker strokes with seeded wobble, so the levels look hand-drawn and go through the real renderer.
- **Build:** with `tier: faithful`. The designer never touches the hand-authored levels.
- **Commands:** `npm run starter:build` writes `shared/starter/dist/*.level.json`; `vision/app/seed_v2.py` seeds them as the game "Starter World".

| # | Level | Screens (w) | Intent (what the kid should feel) | Mechanics taught | Casual C target | Bot fastest | Casual clear (model) | Tightest required window | Engaged enemies | Actions per screen |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | **Doodle Meadow** | 3 (144) | "I can run, jump and stomp." | walk, jump, **run-up gap**, **stomp** | 0.10 ± 0.025 | 18-24 s | 40-60 s | ≥ 12 f | ≥ 1 on the required route | ≥ 6 |
| 2 | **Spike Garden** | 4 (192) | "Spikes point away from where they sit." | spike strips (up/down/side), one-way ledges, **tap hops**, hopper | 0.30 ± 0.075 | 24-32 s | 50-75 s | 8-14 f | ≥ 1 per screen from screen 2 | ≥ 8 |
| 3 | **Crumble Cliffs** | 4 (192) | "Keep moving, feel the rhythm." | crumble, ferry and lift, saws (phase windows) | 0.60 ± 0.15 | 26-34 s | 60-85 s | 8-12 f (φ ≥ 8 f) | ≥ 2 | ≥ 8 |
| 4 | **Keyhole Castle** | 5 (240) | "Find the key, survive the keep." | key/door, crusher, shooter, chaser, flyers; a faster reprise of L3 | 1.00 ± 0.25 | 32-40 s | 70-90 s | 6-10 f | ≥ 3 | ≥ 8 |
| 5 | **Ink Gauntlet** (bonus, unlocks after L4) | 3 (144) | "Everything, and tight." | stomp chains over pits, crumble + crusher combo, firebar | **1.80 ± 0.40** (Hard) | 24-30 s | 90 s+ | 5-8 f | ≥ 4 | ≥ 10 |

The "40-90 s per level" target in [G §10] is read as the **casual clear time**. A frame-perfect bot is about twice as fast as a casual player.

**Beat sheets** (x in cells).

- **L1 Doodle Meadow** (w = 144)
  - **Teach (0-47):**
    - flat start, then a 2-row step at x14-19;
    - a **safe 3-wide dip** at x23-25 (its floor is 2 rows down, so you walk out);
    - walker #1 at x36 on a 13-cell flat, with a 5-coin arc that draws the stomp bounce. The first enemy appears on safe flat ground, the SMB rule [G §5];
    - checkpoint at x45.
  - **Test (48-95):**
    - a 4-wide bottomless pit at x52-55;
    - 3 rising steps (2 rows each, 4 wide);
    - walker #2 at 2.5 c/s on the plateau, on the route;
    - a drop onto a **12-cell runway** with a kid-text sign "run! →", then a **7-wide gap** at x91-97 that only a run-up clears (runway ≥ 3);
    - big coin 1 one row above the run-jump apex.
  - **Twist + finale (96-143):**
    - two walkers 3 cells apart; a held stomp chain reaches **big coin 2**, 7 rows up;
    - checkpoint at x119;
    - 4 one-way ledges rising 3 rows each to a hill; goal flag at x141;
    - **big coin 3** on a high ledge off the staircase, reached by a precise run-jump.
- **L2 Spike Garden** (w = 192)
  - **Teach:**
    - a 3-cell spike strip on flat ground;
    - a platform half covered in spikes (land on the safe half);
    - a coin trail.
  - **Test:**
    - a zig-zag tower of 4 one-way ledges, 3 rows apart, over a spike floor;
    - a walker on ledge 3;
    - checkpoint on the top plateau.
  - **Twist:**
    - a ceiling-spike corridor with headroom set so that **tap hops** (≈ 1.1 cells) clear the 1-cell floor strips while full jumps hit the ceiling. The bot tunes the strip length until the window is ≥ 8 f;
    - hopper intro.
  - **Finale:**
    - one-way bridges over a spike pit with 2 walkers;
    - goal.
  - **Big coins:**
    - under a one-way ledge boxed in by spikes;
    - above the corridor on a hidden one-way route;
    - at the end of a spiky detour.
- **L3 Crumble Cliffs** (w = 192)
  - **Teach:**
    - a 4-tile crumble bridge over a **safe** shallow pit, with a spring back up;
    - then crumbles over a void.
  - **Test:**
    - a crumble run of 5 two-wide crumbles with 2-cell gaps (keep moving);
    - a horizontal ferry with 8 cells of travel at 2.5 c/s over a 10-wide pit;
    - checkpoint.
  - **Twist:**
    - static saws above a run-gap (jump low);
    - a vertical-path saw guarding a ledge, which creates a **phase window**;
    - a lift with saws beside it.
  - **Finale:**
    - wait for a saw, then sprint across crumbles;
    - ride a ferry past 2 path saws;
    - goal on a cliff.
  - **Big coins:** under the saw path, and off the ferry. Hold-spring height is the skill.
- **L4 Keyhole Castle** (w = 240)
  - **Teach:**
    - a corridor with 2 crushers and a clear shake telegraph;
    - the door is visible on the floor route.
  - **Test:**
    - shooters on ledges firing across a one-way tower;
    - checkpoint.
  - **Twist:**
    - the key detour goes up via springs and crumbles, guarded by a **chaser** that chases you back down a different crumble staircase, so there is no boring backtrack;
    - checkpoint after the key.
  - **Reprise:**
    - the L3 crumble + saw rhythm at saw speed 4 c/s, right before the **door**;
    - checkpoint after the door.
  - **Finale:**
    - a climb through circling flyer bats to the keep;
    - goal.
- **L5 Ink Gauntlet** (w = 144)
  - a stomp chain over a 12-wide spike pit (bounce off 3 flyers);
  - a crumble + crusher combo;
  - a firebar room with a one-way escape;
  - checkpoints about every 20 s (F_s ≤ 30).
  - Rising lava is deferred to v2.x (D13).

**Verification** (`npm run starter:verify`; it writes `shared/starter/report.md` and fails CI on any miss):
- C is within its tolerance, and C strictly increases from L1 to L5.
- 0 hard flags; every F_s ≤ 30 s; T_fast and casual clear times fall within their ranges.
- Engaged enemies:
  - L1 has an enemy on the required route;
  - L2-L5 have their engaged counts, where "engaged" means removing the enemy lowers the route's E by ≥ 0.02.
- **The first encounter with each mechanic has lethal share 0** (teach).
- **Sawtooth:** the max E_s is in the last 2 segments, and the last segment's E ≥ the first segment's E.
- 3 reachable, optional big coins per level; par present; actions per screen as in the table.
- **Designer proof** (cross-check): L1's skeleton with its authored enemies removed, put through Challenging·Normal, must land at C ∈ [0.3, 1.0].

**Seed games.**
- "Starter World": L1-L5.
- "Classic Starter": the migrated v1 levels under `v1-classic`.
- A v2 remix chain under L1:
  - "Doodle Meadow (Challenging)", built by the designer at Normal with designer ink visible (maya). This is the dial showcase on day one [MF].
  - "Doodle Meadow speedrun" (sam).

---

## 10. v1 fixes (all closed by v2)

| # | v1 issue | Root cause | v2 fix | Verified by |
|---|---|---|---|---|
| 1 | **Duplicate win banner** | `Hud.showBanner` canvas card (`hud.ts:115`) **and** the HTML `.win-overlay` (`play.ts:106`) [V 9] | One win moment: canvas confetti and slow motion only, then exactly one HTML results card. `showBanner` deleted (§7.9). | e2e/vitest: after a win, exactly one `[data-role=results]` exists and the scene has 0 text objects tagged `banner` |
| 2 | **Single brush tap too small to register** | 8 px brush (`canvas.ts:21`) < `MIN_AREA_CELLS = 0.3` (`components.py:19`); the tap is also erased from the art (`pipeline.py:170-178`) [B F7] | 12 px marker; a tap stamps a 14 px dot; never-drop rule (≥ 0.03 cell² kept); blue dots of any size become coins (H1, N9) | CV sweep: 6/8/10/12/20 px blue dots → coins on paper and raster ingest; G01-G06 coin counts exact |
| 3 | **Enemies hover in mid-air** | `setAllowGravity(false)` (`Patroller.ts:6, 38`) [B F9, G §2.2] | Gravity by default; N3/N13 put the feet on the host; ledge-aware walkers; only `flyer` hovers | sim test: an enemy compiled 2 cells above the ground lands and stays grounded for 600 f; G03/G06 enemy bottoms within ±1 px of the surface |
| 4 | **Crunchy photo backdrops** | `pixelArt: true` (`index.ts:68`) + a 768 × 432 store stretched with pixelated rendering [V 3, B F16] | `pixelArt: false`, render scale r, LINEAR filtering, vector re-ink; the photo is only an optional 15% underlay (§7.4) | unit: `game.config.pixelArt === false`; backing store ≥ 0.85 × displayed device px; the canvas CSS has no `pixelated`; visual checklist |
| 5 | **Handwriting becomes solid tiles when the model is off** | text removal depended only on the model's annotations (`compile.py:394-408`); the heuristic returns `[]` (`heuristic.py:200-207`) [B F3] | Deterministic grouping (text cluster, arrow, detach) + H15/H16/H22; text and arrows are signs with collision `none` | G04 model off: 0 colliding cells from text components; reachable ≥ the v1 model-on count (41); G16 ≥ 90% text strokes non-colliding |
| 6 | **Remix by re-scanning duplicates coins** | parent entities kept + new CV coins with no de-duplication (`compile.py` compose) | parent pickups printed as gray outlines; object-level remix diff (IoU ≥ 0.3 or centre ≤ 1 cell); N10 de-dup within 0.75 cell (§6.5) | re-scanning an untouched remix sheet of a 5-coin level → 5 coins, 0 new objects |
| 7 | **Canvas character box only partly wired** | shares the main tool colour (`canvas.ts:211-213`); 32 × 48 NEAREST squeeze (`scan.py:116`); not kept or previewed [V §2] | Character Studio: own palette, tools and undo; live mini-stage; rig; "save to library as my player"; persisted with the draft; sprite rendered at 4× with LINEAR filtering (§7.6, §7.11) | e2e: changing the main colour leaves the studio colour alone; the character survives back-to-draw; the rig has ≥ 2 legs (or synthesized legs); the sprite is 128 × 192 |

**Other v1 defects closed:**
- **Zero-length "moving ground" crash** (`MovingPlatform.ts:58` recursion [V 1]): fixed by the U1 guard, N12, the validator, per-entity try/catch and blocked publishing. Fuzz: 500 random levels → 0 exceptions.
- **Raw codes in the UI** (`goal_unreachable`): fixed by `messages.json`. A DOM test fails if a `snake_case` token is visible.
- **Publishing a broken level:** fixed by the publish gating in §7.10.
- **Typed rule binding the wrong object** (`interpret.py:154-155`, spawn spikes walking [B F10]): the parser is never merged on top of the model; selection binding; the parser asks on ambiguity.
- **Goal = the largest green** (`pipeline.py:142`): fixed by H4/H5.
- **Spawn on a cave roof or mid-level** [M B, M v1]: fixed by N7.
- **Key silently becoming a coin** [M v1]: fixed by `BKeyDoor` requiring both ids, plus an Ask card.
- **Art and collision disagreeing; coins and flag drawn twice; whitening ghosts and floor notch** [B F8, F13-F15]: fixed by §7.3.
- **Server never solves** (`compile.py:638`): every stage is analyzed by the worker, and publishing re-verifies.
- **Solver ignoring enemies, timing and coyote; fixed at 48 × 27**: fixed by §4.1.
- **No refusal fallback** (non-beta `messages.parse`): fixed by the beta parse with `fallbacks="default"`.
- **HUD over ink; dev footer; thumbnails without entities; static preview overlays** [V]: fixed by §7.9 and §7.10.

---

## 11. BUILD PLAN (multi-agent)

### 11.1 Rules of engagement

1. **Ownership.** A lane writes **only** inside the paths it owns (§11.2).
   - Contract files change only through a **contract PR**: an entry in `docs/v2/CONTRACTS.md` naming the affected lanes, regenerated artifacts (`cd vision && uv run --no-sync python ../scripts/gen_contracts.py`), and updated fixtures.
   - Lanes never edit each other's files. To ask for a change, a lane files `docs/v2/requests/<lane>-<n>.md` (each lane owns its own request files), and the owner answers in `docs/v2/CONTRACTS.md`.
2. **v1 keeps running.**
   - The servers are live (uvicorn `--reload`, Vite HMR). **Do not stop or restart them.**
   - Every saved file must import cleanly. `vision/app/main.py` mounts the v2 routers inside `try/except ImportError` (and `DAL_V2=1`, the default), so a broken v2 module logs and disables v2 instead of crashing v1.
   - v2 web lives at `web/v2.html`. v1 files are not modified before P6, except the additive lines listed in §11.2 (D: `main.py`, `config.py`; F: `package.json`, `vite.config.ts`, `tsconfig.json`).
3. **Secrets.** Never print, log or commit the API key. Live scripts run inside `vision/` after `set -a; source ../.env; set +a`. Every live script takes `--max-usd` (default 3) and logs to `model_calls`.
4. **Testing ports.** Tests use FastAPI `TestClient` and a spawned worker pool, never the running server's port.
5. **Tests stay green.** Every lane keeps its own test command green (§11.6). The phase gates run everything.

### 11.2 Lanes and exact file ownership (no overlaps)

| Lane | Owns (create/modify only these) | Delivers |
|---|---|---|
| **A · Sim & Bot** (TS) | `web/src/core/sim/**`, `web/src/core/bot/**`, `web/src/core/difficulty/**`, `web/src/core/replay/**`, `web/src/core/__tests__/{sim,bot,difficulty,replay,determinism,calibration,envelope,conformance}.*.test.ts`, `shared/spec/physics-profiles.json`, `shared/spec/conformance/replays/**` | profiles; the deterministic fixed-step Sim (tiles, slopes, one-way, kinematic solids, every §5.7-5.8 entity, stomp, hearts and lives, respawn snapshots, camera); `analyze` (reachability, timed search, templates, route, windows, flags, slots, camera pass); the difficulty model; replay codec + `verifyRun`; the conformance suite with state hashes |
| **B · Build & Design** (TS; **spec owner**) | `vision/app/spec/**`, `scripts/gen_contracts.py`, `shared/spec/*.schema.json`, `shared/spec/params.json`, `shared/spec/conformance/levels/**`, `shared/spec/legacy/**`, `docs/spec/level-format-v2.md`, `docs/v2/CONTRACTS.md`, `web/src/core/{index.ts,types.gen.ts,params.ts,tsconfig.json,cli.ts}`, `web/src/core/{util,ink,scene,build,edits,design,generate,worker}/**`, `web/src/core/__tests__/{contracts,scene,build,edits,design,generate,worker,golden,starter}.*.test.ts`, `shared/starter/**`, `shared/golden/*/expect.json`, `shared/golden/*/notes.md`, `shared/golden/report.{json,md}`, `vision/tests/test_spec_*.py`, `.gitignore` | contracts and codegen; InkDoc helpers; grouping, grammar, calibration, merge, rules parser, remix diff, symbol match; fit, raster, compile, validator, `level_hash`, migrate; the full vocabulary (apply, invariants, cost), normalize order, repair search; candidates, greedy tiers, `applyPlan`, `transferPlan`, digests; generator + keyword planner; the Node worker + pool + browser worker; CLI (selftest, golden, starter:build/verify, calibrate, envelope, gen-spec-data); Starter World content |
| **C · See** (Python) | new `vision/app/cv/{vectorize,features,scan_v2,raster_ingest,stitch,annotate,checkbox}.py`, new `vision/app/template/{generate_v2,spec_v2}.py`, `shared/template_spec_v2.json`, `vision/cli_v2.py`, `vision/tests/test_cv_v2_*.py`, `vision/tests/make_synthetic_v2.py`, `scripts/make_golden_inputs.py`, `shared/golden/*/{input.*,ink.json,strokes.json,prompt.txt}` | `run_scan_v2` → InkDoc (strokes, components, features, sheets, character, noise); raster ingest; seam stitching; QR v2; annotated tiles for PERCEIVE; rules and library sheet OMR; pack, remix, extend, rules and library PDFs; golden inputs (vector exports with the same seeds as `make_kid_drawings.py`, so rasters are byte-identical; the original script is not modified) |
| **D · Mind & Platform** (Python) | `vision/app/mind/**` (client, budget, ledger, schemas, sanitize, prompts/*.md, perceive, design, refine, critic, plan, creature, moderate, fake), `vision/app/build/**` (orchestrator, events, bridge, drafts), `vision/app/routers/v2/**`, `vision/app/db_v2.py`, `vision/app/migrate_v1.py`, `vision/app/seed_v2.py`, `vision/app/main.py` (guarded mount + lifespan only), `vision/app/config.py` (additive env only), `vision/pyproject.toml`, `vision/evals/**`, `vision/tests/test_{mind,sanitize,orchestrator,bridge,api_v2,runs,migrate,db_v2,budget}*.py`, `vision/tests/fixtures/model_replies/**`, `shared/spec/conformance/events/**`, `scripts/{golden_live.py,bench_build.py,latency_bakeoff.py,dev.sh}`, `docs/v2/latency.md`, `docs/v2/evals/**`, `README.md` (P6 only) | every model call with fallbacks, deadlines, budget and ledger; the staged orchestrator (speculative DESIGN, transfer, REFINE, CRITIC, 25 s deadline); SSE + polling; the worker bridge (pool of 2); every v2 HTTP endpoint; SQLite v2; publish verification; runs and boards; migration; seed; live golden eval + LOOK judge; latency bench |
| **E · Feel** (TS) | `web/src/core/art/**`, `web/src/core/__tests__/art.*.test.ts`, `web/src/engine/**`, `web/src/render/**`, `web/src/audio/**`, `web/public/fonts/**`, `web/scripts/golden_shots.ts`, `shared/golden/*/shots/**` | ArtDoc (clean, top-edge alignment, per-role recipes, pencil and blue-line, parallax, rig); SVG serializer; `mountGame` v2 on the core Sim with interpolation, input, touch, gamepad; camera view; PlayerView and entity views; juice; HUD plates; ghosts; in-scene overlays and morph swaps; render scale; chunked Canvas2D ink; `InkBoilFX`; paper themes; Canvas2D thumbnails; WebAudio SFX + music |
| **F · Studio** (TS) | `web/v2.html`, `web/src/editor/**`, `web/src/app/**` (router, screens, `api.ts`, `sse.ts`, `messages.ts`, `style.css`, golden review page, `#/dev` conformance page), `web/src/editor/__tests__/**`, `web/src/app/__tests__/**`, `shared/spec/messages.json`, `web/package.json`, `web/vite.config.ts`, `web/tsconfig.json`, `web/e2e/**` (optional Playwright) | the vector long-canvas editor (tools, taps, stamps, live hints via the browser worker, rules chips, Character and Creature Studio, ▶ and "play from here"); the scan pack tray; the preview design report (saw, cards, asks, dial, pill, bot ghost, Fix-it, Make it mine, designer note, publish gating); the play screen with results card, boards and challenge links; home feed, game, tree (with remix diff outlines), library, rules and prompt screens; paper and ink chrome; the golden review page |

A **P0 scaffold agent** creates the initial version of every contract file in every lane's area (§11.4). From the end of P0, the ownership above applies.

### 11.3 Cross-lane contracts (frozen at the end of P0)

**(a) Schemas and codegen (D18).**
- The Pydantic v2 modules in `vision/app/spec/` are the source of truth: `common, ink, scene, behavior, edits, level, report, events, rules, library, runs, plan, api`.
- `cd vision && uv run --no-sync python ../scripts/gen_contracts.py` does two things:
  1. writes `shared/spec/<name>.schema.json` via `TypeAdapter(...).json_schema(mode="serialization")`;
  2. runs `npx --prefix web json2ts` (devDependency `json-schema-to-typescript@15`, pinned) to write **one** file, `web/src/core/types.gen.ts`.
- Staleness tests regenerate both into a temp dir and diff them: `vision/tests/test_spec_fresh.py` and `web/src/core/__tests__/contracts.fresh.test.ts`.
- `jsonschema` validates `shared/spec/conformance/levels/{valid,invalid}/*.json` in Python, and `core.validateLevel()` checks the same files in TS.
- Model-facing schemas (`vision/app/mind/schemas.py`, §3.10) are separate, slim and enum-only. They are not part of the format.

**(b) TS core API** (`web/src/core/index.ts`; P0 lands every signature as a stub):

```ts
export type * from './types.gen.ts';               // InkDoc, SceneGraph, EditRecord, LevelV2, PlaytestReport, Candidate, GameRules, LibraryType, Replay, …
// ---- Lane B ----
export interface BuildInput { ink: InkDoc; graph0: SceneGraph; edits: EditRecord[]; rules: GameRules; library: LibraryType[];
                              parent: LevelV2 | null; tier: Tier; repairUnsolvable: boolean; seed: number }
export interface BuildResult { graph: SceneGraph; level: LevelV2; report: PlaytestReport; edits: EditRecord[]; rejected: EditRecord[]; ms: number }
export interface TierSet { faithful: BuildResult; polished: BuildResult; normal: BuildResult; hard: BuildResult;
                           reach: Record<'polished' | 'normal' | 'hard', boolean>; why?: MessageRef; menu: Candidate[] }
export function inkFromStrokes(strokes: InkStroke[], world: World, o?: { character?: InkStroke[]; typed_rules?: TypedRule[] }): InkDoc;
export function perceiveHeuristic(ink: InkDoc, ctx: { library: LibraryType[]; parent: LevelV2 | null }): SceneGraph;
export function mergePerception(g0: SceneGraph, perceptions: PerceptionJson[], ink: InkDoc):
  { edits: EditRecord[]; asks: AskCard[]; setpieces: Setpiece[]; dropped: string[]; discarded: boolean };
export function parseRules(text: string, g: SceneGraph): { edits: EditRecord[]; asks: AskCard[] };
export function build(i: BuildInput): BuildResult;
export function buildTiers(i: Omit<BuildInput, 'tier'>, o: { deadlineMs: number; band?: Band }): TierSet;
export function candidates(base: BuildResult, o: { max: number }): Candidate[];
export function applyPlan(i: Omit<BuildInput, 'tier'>, menu: Candidate[], plan: DesignPlanJson): TierSet & { rejected: { cid: string; why: string }[] };
export function transferPlan(plan: DesignPlanJson, oldMenu: Candidate[], newMenu: Candidate[], oldG: SceneGraph, newG: SceneGraph):
  { plan: DesignPlanJson; ratio: number; routeRolesChanged: boolean };
export function digest(r: BuildResult, menu: Candidate[]): { graph_digest: string; level_digest: string; menu_rows: string };
export function layoutPlan(plan: LevelPlanJson, rules: GameRules, seed: number): InkDoc;
export function keywordPlan(prompt: string, screens: number): LevelPlanJson;
export function remixDiff(parent: LevelV2, ink: InkDoc): { matched: Record<number, string>; added: number[] };
export function matchSymbol(glyph: InkStroke[], lib: LibraryType[]): { type_id: string; version: number; dist: number } | null;
export function migrateV1(v1: unknown): LevelV2;
export function levelHash(level: LevelV2): string;
export function validateLevel(x: unknown): { ok: true; level: LevelV2 } | { ok: false; errors: string[] };
// ---- Lane A ----
export const PROFILES: Record<ProfileId, PhysicsProfile>;
export function createSim(level: LevelV2, o?: { startAt?: CellXY; seed?: number }): Sim;
export interface Sim { readonly frame: number; step(input: number /* bits: L R J RUN D */): SimEvent[]; view(): SimView;
                       camera(): CameraState; snapshot(): SimSnapshot; restore(s: SimSnapshot): void; hash(): string }
export function cameraStep(c: CameraState, v: SimView, world: World): CameraState;
export function analyze(level: LevelV2, o: { mode: 'fast' | 'full'; profile?: 'casual' | 'skilled'; segments?: string[]; legacy_measure?: boolean }): PlaytestReport;
export function encodeReplay(inputs: Uint8Array): string;
export function decodeReplay(s: string): Uint8Array;
export function verifyRun(level: LevelV2, r: Replay): RunVerdict;      // {finished, frames, deaths, coins, big_coins, stamps}
// ---- Lane E ----
export function buildArt(level: LevelV2, ink: InkDoc, o: { theme: Theme; seed: number; boilFrame?: 0 | 1 | 2 }): ArtDoc;
export function artToSvg(doc: ArtDoc, view: RectCells, o?: { scale?: number }): string;
export function extractRig(strokes: InkStroke[]): Rig;
```

**Core rules** (enforced by `cli.ts selftest` and a lint test):
- every import uses the `.ts` suffix;
- type-only imports use `import type`;
- no DOM, no Phaser, no npm dependencies, no JSON imports.
- `web/src/core/tsconfig.json` sets `erasableSyntaxOnly`, `verbatimModuleSyntax`, `allowImportingTsExtensions`, `noEmit`, and `lib: ["ES2022"]`.
- `node web/src/core/cli.ts selftest` must pass on Node 24.

**(c) Worker RPC** (B implements, D calls).
- Process: `node web/src/core/worker/main.ts`.
- Request: `{"id": n, "method": m, "params": {...}}`, one JSON object per line on stdio.
- Response: `{"id": n, "ok": true, "result": …}` or `{"id": n, "ok": false, "error": {"code": "timeout|invalid|internal", "message": "…"}}`.
- A line may carry at most 32 MB.

| Method | Params | Result | Python timeout |
|---|---|---|---|
| `ping` | - | `{core_version, node}` | 1 s |
| `perceive_heuristic` | `{ink, library, parent}` | `{graph}` | 2 s |
| `merge_perception` | `{graph0, perceptions, ink}` | `{edits, asks, setpieces, dropped, discarded}` | 1 s |
| `parse_rules` | `{text, graph}` | `{edits, asks}` | 1 s |
| `build` | `BuildInput` | `BuildResult` | 3 s |
| `build_tiers` | `BuildInput − tier + {deadlineMs, band}` | `TierSet` | deadline + 1 s |
| `apply_plan` | `{input, menu, plan}` | `TierSet + rejected` | 4 s |
| `transfer_plan` | `{plan, oldMenu, newMenu, oldGraph, newGraph}` | `{plan, ratio, routeRolesChanged}` | 1 s |
| `digest` | `{result, menu}` | `{graph_digest, level_digest, menu_rows}` | 1 s |
| `analyze` | `{level, mode, profile}` | `{report}` | 3 s |
| `layout_plan` / `keyword_plan` | `{plan, rules, seed}` / `{prompt, screens}` | `{ink}` / `{plan}` | 2 s / 1 s |
| `remix_diff` | `{parent, ink}` | `{matched, added}` | 2 s |
| `migrate_v1` | `{level}` | `{level}` | 2 s |
| `verify_run` | `{level, replay}` | `RunVerdict` | 2 s |
| `level_hash` | `{level}` | `{hash}` | 1 s |
| `art_svg` | `{level, ink, theme, view}` | `{svg}` | 3 s |

The bridge (`vision/app/build/bridge.py`) exposes:
- `class CorePool: async def call(self, method: str, params: dict, timeout_s: float) -> dict`;
- 2 workers started in the FastAPI lifespan, assigned round robin;
- restart on exit or timeout, with 1 retry;
- the state is reported by `/api/v2/health`.

**(d) Python internal APIs.**

```python
# Lane C → D
def run_scan_v2(images: list[bytes], pack: PackInfo | None, work_dir: Path) -> ScanV2        # {ink: InkDoc, sheets: list[SheetInfo], warnings: list[MessageRef]}
def ingest_raster(png: bytes, screens: int = 1) -> InkDoc                                    # canvas PNG / golden / migration path
def render_annotated(ink: InkDoc, tile: Tile, px_per_cell: int = 24) -> bytes               # JPEG: magenta ids, rulers, taps included
def render_library_strip(types: list[LibraryType]) -> bytes
def read_rules_sheet(img: bytes) -> RulesSheetResult                                        # {patch, asks, story_crop}
def read_library_sheet(img: bytes) -> list[LibraryDraft]
def make_pack_pdf(pack: PackInfo, parent: dict | None) -> bytes
def make_rules_pdf(game_id: str) -> bytes
def make_library_pdf(game_id: str, types: list[LibraryType]) -> bytes
# Lane D (all async, never raise; MindResult §3.10)
async def perceive(ink: InkDoc, tile: Tile, ctx: PerceiveCtx) -> MindResult[Perception]
async def design(dig: DesignDigest, images: list[bytes], ctx: DesignCtx) -> MindResult[DesignPlan]
async def refine(dig: DesignDigest, prev: DesignPlan, deltas: str) -> MindResult[DesignPlan]
async def critic(dig: DesignDigest, telemetry: Telemetry) -> MindResult[Critique]
async def plan_level(prompt: str, screens: int, rules: GameRules) -> MindResult[LevelPlan]
async def creature(name: str, text: str, image: bytes) -> MindResult[CreatureSpec]
async def moderate(image: bytes, texts: list[str]) -> MindResult[Moderation]
async def run_build(req: BuildRequest, sink: EventSink) -> None                              # the orchestrator
class EventSink(Protocol):
    def emit(self, event: str, data: dict) -> int    # returns seq; persists to events.jsonl
    def closed(self) -> bool
```

**(e) HTTP API v2** (D provides, F consumes through `web/src/app/api.ts`). Bodies are JSON unless marked.

| Method and path | Body / query | Returns |
|---|---|---|
| `GET /api/v2/health` | - | `{ok, llm: "live"\|"fake"\|"off", worker: "ok"\|"down", core_version, budget_left_usd}` |
| `POST /api/v2/builds` | multipart: `ink` (InkDoc JSON, canvas) **or** `photos[]` (1-6, paper), `typed_rules?`, `parent_id?`, `game_id?`, `pack_id?`, `dial?` (default polished), `band?` | `202 {build_id, draft_id, events_url}` |
| `GET /api/v2/builds/{build_id}/events` | SSE, `Last-Event-ID` | §3.11 events |
| `GET /api/v2/drafts/{id}?since=<seq>` | - | `{state, events}` (polling fallback; full state when `since` is omitted) |
| `PUT /api/v2/drafts/{id}/edits` | `{statuses: {edit_id: "applied"\|"undone"}, kid_edits: EditOp[]}` | `{tiers: TierSet summary, rejected}` (the worker is authoritative) |
| `POST /api/v2/drafts/{id}/answers` | `{ask_id, choice}` | `{tiers}` |
| `POST /api/v2/drafts/{id}/dial` | `{tier}` | `{tier}` (persisted selection only; tiers are precomputed) |
| `POST /api/v2/drafts/{id}/redesign` | `{}` | `202 {build_id}` (a fresh DESIGN on the current graph) |
| `POST /api/v2/drafts/{id}/critic` | `{telemetry: {deaths: [{x, y, cause, frame, segment}], attempts, segment_times}}` | `202 {build_id}` (SSE `note` + `suggestions`) |
| `POST /api/v2/levels` | `{draft_id, tier, author, title?, statuses, level_hash}` | `{level}`, or `409 {message_key, args}` (unsolvable, entity error, unanswered ask, hash mismatch, safety flag) |
| `GET /api/v2/levels/{id}[?version=]` | - | `{level, stats: {plays, clears, clear_rate, best}, children}` |
| `GET /api/v2/levels/{id}/tree` | - | nested tree with authors, versions, changed objects |
| `POST /api/v2/levels/{id}/moderate` | - | `{safety}` |
| `POST /api/v2/levels/{id}/runs` | `{player, replay, claimed, vs_run_id?}` | `{run_id, verified, rank, pb, stamps, vs?: {beat, by_ms}}`, or 422 |
| `GET /api/v2/levels/{id}/runs?board=any\|collector&limit=10` | - | runs |
| `GET /api/v2/runs/{run_id}` | - | `{run, replay, sprite_url}` |
| `POST /api/v2/levels/{id}/attempts` | `{attempts, deaths, clears}` | 204 |
| `PUT /api/v2/levels/{id}/thumbnail` | PNG | 204 |
| `GET /api/v2/games?sort=new\|hot\|hard\|cleared`, `POST /api/v2/games`, `GET /api/v2/games/{id}` | - / `{title, author}` / - | feed / game / game + ordered levels |
| `GET /api/v2/games/{id}/rules`, `PUT /api/v2/games/{id}/rules`, `POST /api/v2/games/{id}/rules/check` | GameRules | rules (`version` + 1) / `{affected: [{level_id, reason_key}]}` |
| `POST /api/v2/scan/rules-sheet`, `POST /api/v2/scan/library-sheet` | multipart photo | `{patch, asks}` / `{drafts}` |
| `GET /api/v2/games/{id}/library`, `POST /api/v2/games/{id}/library`, `GET /api/v2/library/{type_id}?v=`, `POST /api/v2/library/{type_id}/versions` | LibraryType | types / a new immutable version |
| `POST /api/v2/library/interpret` | `{name, text, ink}` | `{spec: CreatureSpec, source: "model"\|"keywords"}` |
| `POST /api/v2/prompt-levels` | `{prompt, game_id?, screens, dial, band?}` | `202 {build_id, draft_id}` |
| `POST /api/v2/packs`, `GET /api/v2/packs/{id}` | `{kind, k, game_id?, parent_id?}` | `{pack_id, pdf_url}` / sheet status |
| `GET /api/v2/templates/pack/{pack_id}.pdf`, `GET /api/v2/templates/rules.pdf?game=`, `GET /api/v2/templates/library.pdf?game=` | - | PDF |
| `GET /api/v2/levels/{id}/export`, `GET /api/v2/games/{id}/export`, `POST /api/v2/import` | - / - / zip | zip / zip / ids |

v1 `/api/*` routes keep serving v1 JSON until P6, then become aliases.

**(f) SSE events.** The 13 names and payloads in §3.11 are frozen. Sample streams live in `shared/spec/conformance/events/*.jsonl` (D); F's UI tests replay them.

**(g) Engine and render API** (E provides, F consumes):

```ts
export function mountGame(el: HTMLElement, level: LevelV2, ink: InkDoc, o: {
  mode: 'play' | 'preview' | 'test' | 'thumbnail'; rules: GameRules; startAt?: CellXY;
  ghosts?: { replay: Replay; strokes?: InkStroke[]; label: string }[];      // ≤ 3
  overlays?: OverlaySpec;                                                    // edit ghosts, bot path, flags, reach halo; in-scene
  audio?: boolean; reducedMotion?: boolean; record?: boolean; debug?: boolean }): GameHandle;
export interface GameHandle {
  on(ev: 'ready' | 'win' | 'die' | 'coin' | 'big_coin' | 'checkpoint' | 'entity_error', fn: (p: any) => void): void;
  swapLevel(level: LevelV2, o?: { morphs?: Morph[]; when?: 'now' | 'safe' }): void;   // 'safe' = next respawn/pause/goal
  setOverlays(o: OverlaySpec): void; pause(): void; resume(): void;
  restart(from?: 'start' | 'checkpoint'): void; replay(): Replay; destroy(): void }
// 'win' payload: { frames, time_ms, deaths, coins, big_coins_banked, replay }; 'die': { cause, x, y, frame, segment }
export function renderThumbnail(c: HTMLCanvasElement, level: LevelV2, ink: InkDoc, o?: { view?: RectCells }): void;
export function drawInk(ctx: CanvasRenderingContext2D, doc: ArtDoc, view: RectCells, o?: { style?: 'final' | 'underlay' }): void;
```

**(h) SQLite** (`vision/app/db_v2.py`; additive migrations at startup; v1 tables are untouched apart from added columns):
- `games` + `rules_json TEXT`, `format INT`.
- `levels` + `format INT DEFAULT 1`, `version INT`, `json_v2 TEXT`, `level_hash TEXT`, `c_casual REAL`, `score INT`, `band TEXT`, `screens INT`, `verified BOOL`, `safety TEXT`, `par_ms INT`, `fastest_ms INT`.
- New tables:
  - `packs(id, kind, k, game_id, parent_id, sheets_json, created_at)`
  - `object_types(id, game_id, version, json, author, created_at, PRIMARY KEY(id, version))`
  - `runs(id, level_id, level_version, level_hash, player, frames, deaths, coins, big_coins, board, replay TEXT, verified, created_at)`
  - `attempts(level_id, day, attempts, deaths, clears)`
  - `builds(id, draft_id, kind, started_at, finished_at, final_stage, cost_usd)`
  - `model_calls(id, draft_id, kind, effort, latency_ms, in_tok, out_tok, cache_read_tok, cost_usd, stop_reason, served_by, fallback_used, ok, request_id, created_at)`

**(i) Draft files** in `vision/data/uploads/drafts/<draft_id>/`:
- `ink.json`, `graph0.json`;
- `perception/<tile>.json`, `plans/<n>.json`;
- `edits.json`, `tiers/<stage>.<tier>.json`;
- `events.jsonl`, `state.json`;
- `sheets/<n>.jpg`, `annotated/<tile>.jpg`.

**(j) Environment** (all optional):
- existing: `ANTHROPIC_API_KEY`, `DAL_FAKE_LLM`, `DAL_DATA_DIR`, `DAL_PORT`;
- new, with defaults:
  - `DAL_V2=1`;
  - `DAL_CORE_WORKERS=2`;
  - `DAL_NODE=node`;
  - `DAL_DAILY_BUDGET_USD=10`;
  - `DAL_DRAFT_BUDGET_USD=0.40`;
  - `DAL_SPECULATIVE_DESIGN=1`;
  - `DAL_DESIGN_DEADLINE_S=25`;
  - `DAL_FAST_MODE=0`;
  - `DAL_REQUIRE_MODERATION=0`.

### 11.4 Phase order and gates

A phase starts only when the previous gate passes. Inside its own files, a lane may start next-phase work early.

#### P0 Scaffold

A **single agent** lands every contract before any lane starts. Target: ≤ 1 day.

1. **Contracts.**
   - All Pydantic modules in `vision/app/spec/`, plus `scripts/gen_contracts.py`.
   - The generated `shared/spec/*.schema.json` and `web/src/core/types.gen.ts`.
   - `docs/v2/CONTRACTS.md` v1.0.
   - Conformance level fixtures (valid and invalid), including the §2.2 example as `example_2screen.json`.
2. **Core skeleton.**
   - Every directory in §1.4.
   - `index.ts` exports every §11.3(b) signature as a stub that throws `NotImplemented('<fn>')`, **except** `levelHash` (canonical JSON + a pure-TS SHA-256), `validateLevel`, `encodeReplay`/`decodeReplay` and `PROFILES`.
   - `params.ts` holds every constant in this document.
   - The core `tsconfig.json`.
   - Lint tests: `.ts` suffixes, `import type`, and the banned APIs.
3. **Worker.**
   - `worker/main.ts` serves `ping`. Every other method returns canned fixtures when `DAL_CORE_STUB=1`.
   - `cli.ts selftest`.
4. **Python platform.**
   - `bridge.py`: the pool plus ping.
   - `routers/v2/*` stubs:
     - `/health` is real;
     - `/builds` + SSE replay `shared/spec/conformance/events/sample_build.jsonl`;
     - every other route returns 501 with a message key.
   - The guarded mount in `main.py`.
   - `db_v2.py` with the additive migrations.
5. **Mind.**
   - `client.py`, `schemas.py`, `budget.py`, `ledger.py` and the prompt drafts.
   - **The latency bakeoff** `scripts/latency_bakeoff.py` (≤ 16 calls, ≤ $1.50) measures:
     - PERCEIVE (low) on the 4 [M] scenes with the slim schema: adaptive thinking vs `thinking: {"type": "disabled"}`;
     - DESIGN (low) on 2 hand-built menus;
     - whether the API accepts the discriminated unions;
     - whether `AsyncAnthropic().beta.messages.parse` exists;
     - fast mode, only with `DAL_FAST_MODE=1` (an owner decision).
   - The results go to `docs/v2/latency.md`.
6. **Web shell.**
   - `web/v2.html` + `web/src/app/main.ts` with stubbed routes.
   - A `mountGame` stub that draws compiled tiles as boxes and a rectangle player.
7. **Goldens.** G01-G15 inputs are copied (never moved) into `shared/golden/<id>/`, with `expect.json` skeletons from §11.5. `scripts/make_golden_inputs.py` exports vectors for G01-G06.
8. **Messages.** `shared/spec/messages.json` with every key this plan references.
9. **Package scripts and dev dependency.**
   - `web/package.json` scripts: `typecheck` (tsc + tsc -p src/core), `test`, `core:selftest`, `golden`, `golden:shots`, `starter:build`, `starter:verify`, `gen:spec-data`, `bench:core`.
   - The devDependency `json-schema-to-typescript`.

**P0 gate.**
- `cd vision && uv run --no-sync pytest -q tests/test_spec_*` is green.
- `cd web && npx tsc --noEmit && npx tsc -p src/core/tsconfig.json --noEmit && npx vitest run src/core/__tests__/contracts` is green.
- `node web/src/core/cli.ts selftest` passes (stub mode).
- TestClient: `/api/v2/health` is ok, and the SSE sample replays.
- The running v1 `GET /api/health` still answers.
- `docs/v2/latency.md` records the adoption decisions:
  - **thinking disabled** is adopted only if PERCEIVE role accuracy stays ≥ 0.93 **and** p50 drops ≥ 30%;
  - **DESIGN at low** is kept if p50 ≤ 10 s and ≥ 75% of picks validate. Otherwise DESIGN runs at medium on the async suggestions path only, and the greedy tiers are the synchronous Designed result.

#### P1 Foundations

All six lanes work in parallel, model off.

| Lane | Work |
|---|---|
| A | The Sim (tiles, slopes, one-way, kinematic solids, the v2 player + v1-classic); the camera; static `analyze`; templates; the determinism lint; envelope tests |
| B | InkDoc helpers; grouping; grammar H1-H22 with calibration; fit; raster; compile; the validator; the normalize order; `build`; the repair search for gap, ledge, bonk and wall; real worker methods; the browser worker; offline `cli.ts golden` |
| C | Vectorize (paper and raster ingest); features; annotate; QR v2; `ink.json` for G01-G15 |
| D | Client; the PERCEIVE call; the orchestrator Ink stage; SSE; bridge; `db_v2`; publish skeleton; fake mode from recorded replies |
| E | ArtDoc (clean, top alignment, spikes, sprites, coins, goal); Canvas2D chunks; render scale; `mountGame` on the core Sim; camera view; HUD plates; PlayerView basics; the SVG serializer |
| F | The vector editor (strokes, tap, line, eraser, select, undo/redo); the long canvas (pan, zoom, screens, minimap); local ▶ and "play from here"; the preview shell; `api.ts` and `sse.ts` |

**P1 gate** (model off):
- **G01-G06:** 6/6 solvable after the Ink build; 0 pole walls; 0 bumps on fitted surfaces; art offset ≤ 1 px; taps → coins 100%.
- Heuristic role accuracy ≥ 90% on G01-G14.
- Envelope within 0.1 cell; `v1-classic` gives 3.61 / 7.33.
- 10k random frames → identical `hash()` twice.
- Editor ▶ < 300 ms per screen.
- 60 fps on desktop for a 3-screen fixture.
- `cli.ts selftest` passes in real mode.

#### P2 Understanding and the Faithful build end to end

| Lane | Work |
|---|---|
| D | PERCEIVE per tile, live; merge via the worker; fallbacks, budget and ledger; the Understood stage; the paper path end to end; the polling fallback |
| B | Merge; U-ops; the full N and R vocabulary; invariants I1-I8 (I3 with setpieces); stable ids; byte-identical rebuild; the full repair-search table; the §3.7 worked examples as tests |
| C | Harsh-photo robustness (shadow gradient, 25° tilt, JPEG 60); a 2-sheet stitch prototype |
| E | Morph swap; in-scene overlays; the entity guard; pencil and blue-line inks; decoration and sign styles |
| F | What I saw; cards (Keep/Undo, ghosts, why, lock, dependents); Ask cards; local undo rebuild; publish gating; messages; Back to drawing with Bake |
| A | w, h and φ windows; flags; slots |

**P2 gate:**
- **Live G01-G10** (`scripts/golden_live.py --max-usd 3`): role accuracy ≥ 95%; 0 pole walls; goals grounded 100%; coins drawn == built; G06 has exactly one moving enemy.
- Understood p50 ≤ 15 s on canvas, and the paper Ink build p95 ≤ 8 s (`scripts/bench_build.py`).
- G04 model off: 0 text collision cells.
- Undoing then redoing every edit on G01-G14 rebuilds byte-identically.
- All the §3.7 worked examples pass.

#### P3 The designer

| Lane | Work |
|---|---|
| A | The full difficulty model; two-mode calibration; timed search; the camera pass / `blind_jump`; segment metrics |
| B | All candidate generators; greedy tiers; `applyPlan`, `transferPlan`, `digest`; budgets; reach messages |
| D | DESIGN, speculative DESIGN + transfer + DESIGN #2, REFINE, CRITIC; the 25 s deadline; suggestions; redesign |
| E | The pencil reveal; the bot ghost; dial swap animations |
| F | The dial; the difficulty pill; segment bars; Watch the bot; Fix it; Make it mine; the designer note; Rejected ideas; "Why is this hard?" |

**P3 gate:**
- **Latency:** Designed (model) p90 ≤ 25 s; greedy tiers ≤ 3 s after Ink; dial swap < 100 ms.
- **Deadline drill:** with the model stubbed to sleep 40 s, the greedy tiers ship at 25 s with `stage(design, late)`, and the late plan arrives as `suggestions`.
- **Bands:** Challenging·Normal lands in band on ≥ 80% of G01-G14 (the rest show the reach message), and Hard on ≥ 60%. Every tier is 100% solvable, with 0 new hard flags and I1-I8 held. The rejected-pick rate is ≤ 25%.
- **Owner drafts:**
  - G11 Faithful is solvable with ≤ 3 R edits, each ≤ 3 cells.
  - G13: the spike strip sits on the top face, and Challenging·Normal reaches C ≥ 0.3 with the route within 2 cells of the strip [G §10].
- **Calibration:** both modes pass.
- **Speculative transfer:** the rate is measured on G01-G14. Speculative DESIGN stays on only if it is ≥ 50%.

#### P4 Feel and content

| Lane | Work |
|---|---|
| A | Every Tier 1-2 entity (§5.7-5.8); stomp chains; hearts and lives; the respawn rules; replay recording |
| E | The juice table; SFX and music; rig animations; death shards; parallax; boil; themes; the win moment; ghosts; reduced motion |
| B | Starter World plans + overrides; `starter:build` and `starter:verify`; `migrate_v1` |
| D | `seed_v2` (Starter World, Classic Starter, the remix chain and showcase); the boot migration |
| F | The results card; the play screen; the home feed; the tree; chrome; the golden review page |

**P4 gate:**
- `npm run starter:verify` is green.
- L4 runs at ≥ 55 fps on a Pixel 6 / iPhone 12-class phone. The proxy is Chrome at DPR 2 with 4× CPU throttling, documented in `docs/v2/latency.md`.
- The visual checklist is signed for G01-G14.
- Reduced motion is respected; mute persists; exactly one win UI appears.

#### P5 Extensions

| Lane | Work |
|---|---|
| C | Pack PDFs; multi-sheet stitching; remix and extend sheets; rules and library sheet OMR and PDFs |
| D | Runs, boards, attempts; library + interpret; rules + check; prompt-levels (PLAN); export/import; moderate |
| B | `layoutPlan`, `keywordPlan`, `remixDiff`, `matchSymbol`; library instances; the rules re-verify helper |
| A | `verifyRun`; the conformance suite (30 levels + replays + state hashes) |
| E | Ghost rendering (≤ 3); thumbnails; the share card PNG |
| F | The pack tray; Library / Creature Studio; the rules, prompt and boards screens; challenge links; tree diff outlines; the `#/dev` conformance page |

**P5 gate:**
- Every extension acceptance criterion in §11.7 passes.
- 20 recorded runs verify identically in Node and in Chromium (the `#/dev` page). The reviewer checks Safari and Firefox manually.

#### P6 Hardening and switch-over

**Work:**
- **Fallback drills:** no key; injected timeouts; a mocked refusal; killing a worker; an exhausted budget; an SSE drop that falls back to polling.
- **Perf:** performance passes.
- **Docs:** the README and the spec doc.
- **Rehearsal:** the 60-second demo, run 3 times.
- **Switch-over:**
  - `web/index.html` boots `src/app/main.ts`;
  - v1 routes become aliases;
  - the v1 files in §11.8 are retired;
  - `seed.py` is replaced by `seed_v2.py`.

**P6 gate:** all of §11.7 is green, and the reviewer signs off.

**Integration points:**
- **P1 → P2:** A + B meet in `build`; C + D meet at `/builds`; E + F meet at `mountGame`.
- **P2 → P3:** D + B meet at `digest` / `applyPlan`; E + F meet at the overlays.

### 11.5 Golden drawings (the quality bar, `shared/golden/`)

Each golden is a kid-like drawing (or prompt, sheet or migration case) with an expected interpretation. Inputs are **copied** from the diagnosis folders and `vision/data/uploads/drafts/`, never moved. New inputs are generated by C's scripts.

| Id | Source | Must (offline unless marked "live") | Must not |
|---|---|---|---|
| G01 spike_hop | `docs/v2/diagnosis/build/inputs/1_spike_hop.png` (+ vector export) | solvable at every tier; the goal within 1 cell of the drawn flag and grounded; floor spikes facing up and the hovering strip snapped onto platform 1 (dy ≤ 1); 4 coins (tap kept); the 12 px floor gap closed; spawn ≥ 2 cells from spikes | pole collision; 2-row hazards; bumps |
| G02 spike_cave | `…/2_spike_cave.png` | ceiling spikes face down; wall spikes face left with the wall solid; the floor route to the flag is open; 0 bumps (v1 had 13); 4 coins | hazard over wall ink |
| G03 monster_meadow + "the monster walks back and forth" | `…/3_monster_meadow.png` | tree (canopy + trunk) and sun are decoration, non-colliding; goal = the small flag; the monster is a pinned walker with its eyes as parts, grounded ±1 px; floor art intact; ≥ 58 reachable standing cells | tree as goal; trunk wall; orphan eyes |
| G04 words_and_arrows (model on **and off**) | `…/4_words_and_arrows.png` | "jump!" and the arrow do not collide; the platform moves right ≈ 8 cells (model on: binding; off: arrow hint); the platform is 1 row; solvable in both modes | text tiles |
| G05 big_leap | `…/5_big_leap.png` | solvable as drawn (run-gap ≤ 8 with runway ≥ 3), else 1 R3; the bot note "needs a run-up"; lava at the pit bottom; 3 coins | silent impossibility |
| G06 kid_full_level + "the monster walks" | `…/6_kid_full_level.png` | the ramp is one slope (0 steps); **exactly 1 moving enemy** (the monster); spawn spikes static facing up + N8; spikes snapped onto platform 2; solvable with ≤ 3 R edits each ≤ 3 cells, or 1 add_step; 3/3 coins | staircase; walking spawn spikes |
| G07 floating_spikes | `docs/v2/diagnosis/model/inputs/canvas_floating_spikes/` | matches `gt.json`; goal grounded on G2; spikes snapped dy = +1; ceiling spikes down; the jumpable 5-cell gap is **not** edited | edits to the 5-cell gap |
| G08 wobbly_cave | `…/canvas_wobbly_cave/` | start on the floor (not the roof); the 1-cell hole closed; the 5-cell wall **trimmed, not lifted**; red "lava!" is a sign, not a hazard; 0 bumps | detached pillar |
| G09 tower_key | `…/canvas_tower_key/` | the 3 ledge fragments are 1 surface; "S" start honoured; live: key linked to the door bar, key reachable with the door closed, the door gates the goal; offline: a "which door?" Ask; tree decoration; wall spikes face left | key silently becomes a coin |
| G10 paper_synth_1 | `…/paper_synth_1/` (paper path) | "moves" + arrow → moving platform; solvable; paper Ink p90 ≤ 4 s | - |
| G11 owner `d_b14b143e` | `vision/data/uploads/drafts/d_b14b143e/drawing.png` | Faithful solvable with ≤ 3 R edits each ≤ 3 cells (expected 0); the stepping stone is one-way; **the left ground stays ground** (no zero-length mover); "the high platform moves" moves the highest platform; red lines = floor spikes + pit lava; green Γ = goal; 2 coins | head bonk; engine crash |
| G12 owner `d_dfbfe619` | `…/d_dfbfe619/photo.jpg` | the black zigzag → decoration with the ask "grass or spikes?"; solvable | 1-cell walls |
| G13 owner `d_79eff85e` | `…/d_79eff85e/photo.jpg` | the red zigzag → a 6 px spike band on the platform's top face; Challenging·Normal C ≥ 0.3 with the route within 2 cells of it | the 41-cell floating slab |
| G14 owner `d_45f50934` | `…/d_45f50934/photo.jpg` | pit spikes kept; Polished C ≥ Faithful C (≥ 0.07) (I7) | - |
| G15 owner `d_23962d19` (Synth 1, paper) | `…/d_23962d19/photo.jpg` | solvable; 0 new hard flags; Faithful E ≈ the measured risk (≥ 0.1) | - |
| G16 handwriting_heavy (new) | C: canvas with "the platform moves", "watch out!", an "S" and a scribbled sun inside the drawing area | model off: ≥ 90% of text strokes non-colliding; live: a move binding to the right platform; start at the "S" | words as walls |
| G17 kid_marathon (new) | C: a 4-screen long canvas (extends `make_kid_drawings.py` style) | per-tile PERCEIVE merge (live); 0 blind jumps; Polished in band; full analyze ≤ 600 ms; ≥ 55 fps | - |
| G18 three_sheets (new) | C: `make_synthetic_v2.py --sheets 3`, shuffled photo order | stitched w = 144; ground continuous across both seams (N11); the missing-sheet warning when one is removed; playable from contiguous sheets | - |
| G19 library_grumpo (new) | C: a studio creature "Grumpo" (hopper) + a canvas level with a circled "G" + a paper sheet with Grumpo's symbol | instances with Grumpo's art and behavior by stamp, symbol (chamfer) and letter (live); offline: "Is this Grumpo?" | - |
| G20 rules_sheet (new) | C: synthetic photo of a rules sheet (double jump, lives 3, notebook) | exact GameRules patch, OMR 100%; double jump makes a 6-row ledge reachable in the bot | - |
| G21 prompt_lava_key | "a lava cave where a key opens the exit, medium" (live + keyword) | solvable; key reachable with the door closed; the door gates the goal; C in Normal; a blue-line draft | - |
| G22 harsh_photo | G10 re-photographed: shadow gradient, 25° tilt, JPEG 60 | the same objects as G10 within ±1 cell; roles ≥ 90% | - |
| G23 v1_migration | all v1 fixtures + seeded remixes in `dal.sqlite` | migrate + validate; the same reachable set as the v1 solver under `v1-classic` | - |

**`expect.json` format.** Objects are addressed by a **near-cell locator**, so expectations survive id changes [MF, PF]:

```jsonc
{ "id": "G03", "mode": "canvas", "input": "input.png", "ink": "ink.json", "prompt": "the monster walks back and forth",
  "objects": [ { "near": [9, 17], "radius": 2, "color": "green", "role": "decoration", "collides": false },
               { "near": [9, 22], "radius": 2, "color": "black", "role": "decoration", "collides": false },
               { "near": [44, 21], "radius": 2, "role": "goal", "grounded": true },
               { "near": [20, 22], "radius": 2, "role": "enemy", "behavior": "walker", "pinned": ["archetype"], "grounded": true, "parts_min": 2 } ],
  "counts": { "coin": 4, "enemy": 1, "moving_enemy": 1 },
  "invariants": { "solvable_at": ["ink", "understood", "faithful", "polished", "normal"], "pole_walls": 0, "bumps": 0,
                  "art_offset_px_max": 1, "reachable_min": 58, "max_R_edits": 3, "max_R_cells": 3 },
  "difficulty": { "polished_C_min": 0.1, "normal_C": [0.3, 1.0] },
  "latency": { "ink_s_max": 0.9 },
  "model_off": { "solvable": true, "text_collision_cells": 0 },
  "model_only": ["objects[3].pinned"] }
```

**Screenshots (the "must look good" bar).**
- **Deterministic baselines.** `npm run golden:shots` (E) renders each golden's ArtDoc to SVG at r = 2 with boil frame 0. Each golden gets the stages ink, understood, polished and normal, each framed at the start, the middle and the goal. Files go to `shared/golden/<id>/shots/*.svg`. Baselines are committed after human approval; the CI diff is text-level, and any change needs re-approval.
- **In-app review.** `web/v2.html#/golden` (F) shows each golden as input | Ink | Understood | Polished | Normal, playable, with boil frozen at seed 1. A reviewer (or an agent allowed to use the browser pane) signs off at DPR 2.
- **Optional.** If Playwright is installed, `web/e2e/golden.spec.ts` saves PNGs.

**Visual checklist** (signed per golden):
1. Lines are crisp at DPR 2, with no stair-steps.
2. Feet touch the drawn line on every visited surface.
3. Spikes sit on their surface and point away from it.
4. There is exactly one flag (the kid's), and each coin is drawn once.
5. Enemies stand on surfaces.
6. Designer pencil reads as added, and decoration reads as soft.
7. The HUD sits on its plates, never on ink; there are no white cut-outs, notches or orphan eyes.
8. Side by side with the input, it "looks like my drawing, tidied".

**LOOK judge** (`vision/evals/judge.py`, medium effort, **eval only, never a gate**). It rates "looks like what the kid drew" from 1 to 5 and flags edits that do not keep intent. Target mean ≥ 4.0. The results are tracked in `docs/v2/evals/`.

### 11.6 Automated tests per lane

| Lane | Command | What it checks |
|---|---|---|
| A | `cd web && npx vitest run src/core/__tests__/{sim,bot,difficulty,replay,determinism,calibration,envelope,conformance}` | **Physics:** envelope ±0.1 cell for 4 profiles; v1-classic 3.61 / 7.33; coyote, buffer, corner correction, step assist; slopes; one-way drop-through; platform carry. **Determinism:** the lint; 10k random frames hash identically twice; templates ≡ full sim on 10k samples. **Bot:** v1 fixture parity (flat, too_wide_gap, too_tall_wall, key_door); v2 fixtures (one-way, slope, crumble timing, ferry phase, chaser); flags on crafted cases (blind jump, softlock, head bonk, tight window, skippable setpiece). **Calibration:** two-mode anchors. **Entities:** gravity, ledge-aware, stomp chain, hearts, respawn rules, big-coin banking. **Replays:** codec round-trip; verify accepts a recorded run and rejects a 1-frame alteration. **Budgets:** 3-screen full analyze ≤ 450 ms; 6 screens ≤ 1 s. |
| B | `cd web && npx vitest run src/core/__tests__/{contracts,scene,build,edits,design,generate,worker}` · `cd vision && uv run --no-sync pytest -q tests/test_spec_*` · `cd web && npm run golden && npm run starter:verify` · `node web/src/core/cli.ts selftest` | **Contracts:** fresh and conformance. **Build:** an 8 px line at every sub-cell phase gives exactly 1 surface row; rises of 16/32/64/128 px over 400 px give 1:2 ramps or a slope with 0 bumps (the [B sweep] inverted); spikes at gaps 0, 6-20 and 24-48 px give one strip on the host face that never overwrites the host; a pole becomes scenery; text does not collide; remix re-scan gives 0 new objects. **Ops:** bound clamps (1000 randomized cases); invariants I1-I8 positive and negative; stable ids; undo/redo **byte-identical**. **Design:** repair search on every §3.7 worked example; greedy reaches Normal on 3 synthetic flats; respect ratio; transfer keeps 100% of picks on an unchanged graph. **Generator:** 50 random plans → 100% solvable. **Worker:** RPC round trip and timeouts. **Goldens:** all offline `expect.json` assertions. |
| C | `cd vision && uv run --no-sync pytest -q tests/test_cv_v2_*` | Centreline RMS ≤ 0.1 cell and width ±0.05 cell on synthetic strokes; T-junction split ≥ 95%; dot sweep 6/8/10/12/20 px → coins (paper and raster); never-drop accounting; seam join; QR v2 grammar; checkbox OMR exact on 5 synthetic sheets; harsh-photo rectify; annotated tile contains taps. |
| D | `cd vision && uv run --no-sync pytest -q tests/test_{mind,sanitize,orchestrator,bridge,api_v2,runs,migrate,db_v2,budget}*` · live: `scripts/golden_live.py --max-usd 3`, `scripts/bench_build.py` | Recorded replies parse; unknown ids, cids and slots dropped; > 30% invalid → discarded; missing `key_door` field → Ask. Fake client paths for refusal, max_tokens, timeout and 529: `MindResult` never raises. Budget cap → model-off. Stage order; speculative transfer; DESIGN late → greedy at 25 s + suggestions; SSE resume and polling. Publish 409s (hash mismatch, unsolvable, ask, safety); runs tamper → 422; every v1 level migrates; export/import round-trip. |
| E | `cd web && npx vitest run src/core/__tests__/art src/engine src/render src/audio` · `npm run golden:shots` | Top alignment ≤ 1 px measured from ArtDoc paths; 0 collision without art; SVG deterministic; `mountGame` lifecycle; 200-level fuzz mount with 0 uncaught exceptions (bad entities → `entity_error`); exactly one win UI; `pixelArt === false`; reduced motion; chunk LRU memory bound. |
| F | `cd web && npx tsc --noEmit && npx tsc -p src/core/tsconfig.json --noEmit && npx vitest run src/editor src/app` | Tap → 14 px dot; add and trim screen; chips serialize as pinned labels; undo/redo 200; replaying sample SSE streams renders cards, asks and dial; publish gating; **no `snake_case` token in the DOM**; messages exist for every key; character studio colour is independent. |

### 11.7 Acceptance criteria (each is checkable by a final reviewer)

**Build quality**
1. `npm run golden` (model off): G01-G15 are solvable at the Ink stage, and every non-`model_only` assertion passes. G01-G06: 6/6 solvable, 0 pole walls, coins 22/22, 0 bumps, floating platforms exactly 1 row.
2. `scripts/golden_live.py`:
   - role accuracy ≥ 95% on G01-G10;
   - relations ≥ 95%;
   - the G03 goal is the flag;
   - G06 has exactly one moving enemy;
   - every `key_door` has both ids;
   - 0 invented ids applied.
3. Art equals physics: \|art_top − collision_top\| ≤ 1 px on 100% of surface samples; 0 collision cells without art; 0 orphan ink.

**The mind**

4. Every build streams `ink` → `understood` → `designed` stages (or `skipped`/`late` with reasons) over SSE. Reconnecting with `Last-Event-ID` replays exactly the missing events, and polling gives the same state.
5. **Latency** (`bench_build.py`, n ≥ 3 per golden):
   - canvas Ink build p50 ≤ 0.6 s;
   - paper Ink build p50 ≤ 3 s and p95 ≤ 8 s;
   - Understood p50 ≤ 15 s;
   - Designed p90 ≤ 25 s;
   - dial swap < 100 ms;
   - undo toggle < 150 ms per screen.
6. With the model stubbed to sleep 40 s, the greedy tiers ship at 25 s and the late picks arrive as `suggestions`.
7. Every edit card has a kid-readable reason, a ghost, Keep/Undo and a validator verdict. Undoing and redoing every edit on G01-G14 rebuilds byte-identically.
8. With `ANTHROPIC_API_KEY` unset, every flow works except model taste:
   - draw, ▶, build, Polished and Challenging (greedy);
   - publish (with the "not checked yet" badge);
   - play, runs;
   - prompt-to-level (keyword planner);
   - rules sheet (OMR).

**Gameplay and difficulty**

9. Envelope tests pass. A 7-cell gap cannot be cleared walking, but can with a 3-cell runway. Calibration anchors pass in both modes.
10. Each of the following has a vitest and a playable fixture on `#/dev`:
    - stomp (with chains);
    - all six archetypes, with gravity;
    - oriented spikes, one-way, slopes;
    - crumble, falling, springs (hold vs no hold);
    - moving platforms, saws, firebar, key/door;
    - checkpoints, big-coin banking, hearts, lives.
11. Designer:
    - Challenging·Normal lands in band on ≥ 80% of G01-G14, and Hard on ≥ 60% (the rest show the reach message);
    - every output across all tiers is solvable with 0 new hard flags;
    - I7: Polished never lowers C_faithful;
    - the readout shows the band and "~1 fall in N tries".

**Scrolling**

12. A 6-screen level runs at ≥ 55 fps on a mid phone (or the documented proxy). The camera look-ahead keeps every run-jump landing on screen (0 `blind_jump` in Starter World). The minimap works.
13. G18 stitches from shuffled photos with continuous ground. Re-scanning an untouched remix sheet creates 0 new objects.

**Visual**

14. The visual checklist is signed for G01-G23 SVGs and the in-app page. The canvas is not pixelated, and boil, paper themes, parallax, rig animation, particles and synth audio are present. Mute and reduced motion work.
15. There is exactly one win moment, and the results card shows time, PB, stamps, deaths, coins and the creator's time.

**Extensions**

16. Library: Grumpo is made in the studio, placed by stamp, paper symbol and circled letter, walks or hops with his own art (G19), and editing him creates v2 while published levels keep v1.
17. Rules: switching to `v2-gentle` + double jump changes the bot's reachable set and the mini-stage arc. G20 gives the exact patch. Turning *run* off on Starter World is blocked, with the affected levels listed.
18. Prompt-to-level:
    - live (G21): a solvable blue-line draft in ≤ 25 s;
    - keyword planner: in ≤ 2 s;
    - drawing ground over the draft replaces the draft ground;
    - the 4 Probe D prompts plus G21 are 5/5 solvable with the key logic correct.
19. Runs: a recorded clear verifies on the server; a tampered replay or claim is rejected; `?vs=` shows the ghost and "You beat Maya by X s".
20. Spec: `docs/spec/level-format-v2.md`, the schemas and the conformance suite are published. Conformance passes in Node and on the `#/dev` page in Chromium. Export → import round-trips byte-identically apart from ids. `level_hash` from the browser equals the server's recomputation for every golden.

**Starter World**

21. `npm run starter:verify` is green against every §9 criterion. L1 has an enemy on the required route.

**v1 fixes and robustness**

22. All seven §10 items, plus the extra defects, have passing tests.
23. Killing a worker mid-build shows "builder restarting" and recovers on retry. An injected degenerate entity never crashes the scene, and publishing is blocked with a sentence.
24. A mocked refusal produces `safety: held` and an unlisted publish. The budget cap switches to the model-off path. The fuzz test (500 random levels) produces 0 exceptions.

**Cost**

25. `model_calls` over the live golden run: mean ≤ $0.12 for a 1-screen Polished build and ≤ $0.30 for a 4-sheet build. A stamp-only canvas build makes 0 PERCEIVE calls.

### 11.8 v1 files retired at P6 (not before)

| v1 file(s) | Replaced by |
|---|---|
| `web/src/solver/*` | `web/src/core/bot` |
| `web/src/game/*` (LevelScene, Player, hud, tiles, behaviors/*) | `web/src/engine` + `web/src/render` + `web/src/core/sim` |
| `web/src/screens/*`, `web/src/main.ts`, `web/src/api.ts`, `web/src/types.ts` | `web/src/app`, `web/src/editor` |
| `vision/app/compile.py`, `vision/app/llm/*` | `web/src/core/{build,edits,design}`, `vision/app/mind` |
| `vision/app/routers/scan.py` | `vision/app/routers/v2/builds.py` |
| `vision/app/seed.py` | `vision/app/seed_v2.py` |
| `shared/level.schema.json` | kept as `shared/spec/legacy/level-v1.schema.json` |
| `shared/behaviors.md` | `docs/spec/level-format-v2.md` §Behaviors |

---

## 12. Risks and mitigations

| Risk | Likelihood / impact | Mitigation |
|---|---|---|
| **Model latency over budget.** PERCEIVE is 11.8 s p50 even with the measured verbose schema, and DESIGN at low effort is unmeasured [M lat]. | medium / medium | The Ink build is always playable (≤ 0.6 s canvas). Greedy tiers in ≤ 3 s. Speculative DESIGN + transfer. The 25 s hard deadline → greedy + suggestions. P0 bakeoff with explicit adoption rules: slim schema, thinking disabled, and fast mode as an owner-gated option. Per-tile parallel PERCEIVE. |
| **Structured outputs reject the discriminated unions.** | low / medium | P0 smoke test. Fallback to the flat "kind + nullable fields" form proven in Probe B, validated per variant in code. |
| **Heuristic perception is brittle on real kid drawings and phone photos.** The goldens are mostly synthetic [M caveats], and GF's grammar was the judges' main worry. | medium / high | The model perceives every build with unpinned ink. Isotonic-calibrated confidence → Ask chips below 0.75. Unknown ink → non-colliding decoration (D5). Thresholds live in `params.ts`. Collect 20 consented real phone photos in P2 for the eval set. G22 harsh photo. |
| **Replacing Arcade with a custom deterministic Sim** brings feel regressions and collision edge cases (slope transitions, one-way, carriers). | medium / high | Port v1's tile rules from `physicsSim.ts` (bit-compatible for `v1-classic`). Envelope and calibration tests from P1. Only two slope angles; transition unit tests; 4 px step assist. Engine and solver share the code, so they cannot disagree. |
| **Bot cost on 6-screen levels with timed entities.** | medium / medium | Trajectory templates (property-tested). A static pass first, then local time-expanded search only near timed entities. Segment-local re-analysis. A `worker_threads` pool. An 8-phase "approx" fallback that marks metrics `approx`. |
| **The designer drifts away from the drawing, or feels formulaic.** | medium / high | Menu pre-validation; I1-I8 with model-named setpieces; the topology and pillar penalties; the respect ratio; every card undoable; "Undo all" and "Make it mine"; LOOK judge tracking in evals. The vocabulary includes reprise, CRITIC and model asks; it grows only through spec PRs. |
| **Speculative DESIGN wasted** when perception changes the route. | medium / low | Stable cids make most picks transfer. The transfer rate is measured in P0/P3, and the flag turns off below 50%. Cost cap per draft $0.40. |
| **Difficulty bands come from a modeled σ, not from observed kids.** | medium / medium | Bands are relative and anchored to [G §3] measurements. Clear-rate counters (`attempts`) are stored from day 1, and the σ recalibration loop is deferred to v2.x. |
| **Top-edge alignment or paper re-inking makes the art feel "less mine".** | low / medium | Shifts ≤ 0.85 cell (typically ≤ 8 px); the stroke texture and lower edge are kept; the "my original sketch" underlay; Faithful shows exactly what moved; re-inking is an owner toggle. |
| **Two runtimes (browser and Node) drift.** | low / high | One core; the determinism lint; browser and server `level_hash` parity on every golden; state-hash conformance; `cli.ts selftest` in CI; `erasableSyntaxOnly` + `verbatimModuleSyntax` + `.ts` suffix lint. |
| **Node worker process management under uvicorn `--reload`.** | medium / low | The bridge owns its child processes, kills them on shutdown and restarts on demand. Health reporting. One retry. An explicit "builder restarting" message. The guarded v2 mount never takes down v1. |
| **New dev dependency (`json-schema-to-typescript`) needs a network install.** | low / low | Install it once in P0. The generated files are committed, so runtime and CI never need it unless contracts change. |
| **Scope: 6 lanes and many features.** | high / medium | Tiering (D29). P2 alone fixes "poor quality after I draw", P3 fixes "too easy", P4-P5 add breadth. Contracts frozen at P0. Numeric gates. Deferred list: tall levels, rising lava, wall jump, σ telemetry loop, GitHub mirror. |
| **Phone performance** (vector ink, boil, particles, long worlds). | medium / medium | Chunk LRU of 4 (≈ 28 MB at r = 2); PostFX boil with no texture variants; ≤ 300 particles; auto-degrade below 50 fps; DPR capped at 2. |
| **Cost creep** (long and multi-sheet levels, retries). | low / medium | A per-draft cap, a daily cap, PERCEIVE skipped for pinned ink, prompt caching (≥ 512-token system prompts), and every call in `model_calls`. |
