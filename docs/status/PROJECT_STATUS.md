# Draw-a-Level: setup and project status

Assessed on October 10, 2026, in `/Users/pranayjoshi/Desktop/projects/draw.play`.

The project is running locally. Its central draw → build → preview → publish → play flow works on the samples checked. It is a substantial working prototype with incomplete verification tooling, failing tests, and several quality issues. This report distinguishes observed behavior from code that is merely present.

## What the project is

Draw-a-Level, also called draw.play, is a browser platformer creation tool. Draw black ground, red hazards or enemies, a green finish flag, and blue collectibles. Draw directly in the editor, photograph a printed drawing sheet, or describe a level in words. The app interprets the input, fits it into game objects, repairs some impossible layouts, and supplies four versions: Faithful, Polished, Challenging Normal, and Challenging Hard. You can play, publish locally, remix other levels, customize creatures and rules, and export a game.

The current repository contains three generations:

- **v1:** the original tile-based game and API; still accessible at `/v1.html`.
- **v2:** the default app, with an object-based drawing compiler, a deterministic simulation, a playtest bot, difficulty tiers, long levels, replays, and a library.
- **v3 additions:** optional generated art, device-token profiles, contribution reviews, quests, jams, live drawing rooms, and standalone Phaser export. These additions use `/api/v2/` routes rather than a separate v3 API.

The web app uses TypeScript, Vite and Phaser. The API uses Python, FastAPI and OpenCV. A pure TypeScript core runs both in the browser and in two Node workers controlled by Python. SQLite and files under `vision/data/` provide persistence. The early pitch in `PROJECT_CONTEXT.md` mentions Supabase/Postgres; that is not the storage used by the running implementation.

## Local setup

| Element | Current status |
|---|---|
| Web app | Running at http://localhost:5174/ |
| API | Running at http://localhost:8001/ |
| API documentation | http://localhost:8001/docs |
| Health through the web proxy | `/api/v2/health`: `ok=true`, `worker=ok`, core `2.0.0` |
| Node | Bundled Node `24.19.0`; the system default remains `20.17.0` |
| Python | Project virtual environment using Python `3.11.13` |
| Web dependencies | Installed from `web/package-lock.json` using `npm ci` |
| API dependencies | Installed from `vision/uv.lock` using `uv sync --locked` |
| Model | `off`; optional credentials are blank |
| Generated art | Provider `none`; original drawing remains usable |
| Core workers | Real workers; `DAL_CORE_STUB` is not enabled |
| Starter content | Generated all five v2 levels and three Classic levels; both games are loaded |
| Data | `vision/data/dal.sqlite`, uploads, drafts, live-room logs; git-ignored |
| Restart | Run `scripts/dev.sh` from the project root |

Ports 8000 and 5173 were already occupied by the separate PulseCheck project. The new git-ignored `.env` configures ports 8001/5174, the bundled Node executable and its PATH. `web/vite.config.ts` now reads `DAL_PORT` for its API and WebSocket proxy. That is the only application-source change made for setup. Your other project was left running.

The first cold API startup took tens of seconds while dependencies initialized; the launcher prints its URLs before API readiness. Subsequent startup was faster. The launcher prints “fake” when the Anthropic key is absent, but v2 health correctly reports **off**; “fake” is v1 terminology.

The assessment created local sample drafts, three paper packs, a sample level titled “Setup audit drawing,” an imported copy, a few replay records, and a room named `setup_audit`. These are local data, not external publications. No external model calls were made. Logs and evidence are saved alongside this report.

## Status of the product elements

**Verified** means exercised successfully on representative samples. **Partial** means a feature runs but coverage or quality is incomplete. **Present** means implementation exists but the complete flow was not exercised. **Unavailable** means local configuration prevents use. **Unfinished** means actual tooling or UI is a placeholder. A successful sample does not certify every possible input.

| Element | Status | Evidence and limitations |
|---|---|---|
| Home feed and sorting | Verified | New, Hot, Hard and Most Cleared APIs answered 200; browser showed the seeded games. |
| Game detail and sequence | Verified | Both games returned their levels; Starter World browser page showed five levels and two remixes. |
| Bonus-level unlock | Partial | Level 5 is visibly locked until Keyhole Castle is cleared; a full player unlock journey was not completed. |
| Long drawing editor | Partial | Browser editor rendered tools, undo/redo, zoom, minimap, character studio and build controls. Representative InkDoc submitted to the API built successfully. Every tool interaction was not exercised. |
| Marker roles, stamps and role chips | Present/partial | Implementations and UI exist; the basic editor loaded. All stamps and disambiguation options were not tested. |
| Local editor play test | Partial | Preview Play Test entered and exited a running Phaser game without captured browser errors. Direct “Play from here” editor behavior was not exercised. |
| Drawing perception and geometry fitting | Verified on samples | Core selftest and valid canvas/paper builds passed. Accuracy across all golden drawings remains unverified. |
| Ground, spikes, goals and collectibles | Verified on samples | Sample levels compiled and were solved; schemas and existing CV tests passed. All color/shape ambiguities were not tested. |
| Intent-preserving repairs and designer | Partial | Four tiers were produced and solvable on sample inputs. Hard sometimes reported `reach=false`, so requesting Hard does not always achieve the target. |
| Faithful/Polished/Normal/Hard dial | Verified on samples | Browser radio controls enabled after build; API dial selection returned 200. Target-band success rates across the golden set are unknown. |
| Preview interpretation cards | Partial | Browser displayed ground, coins, monster and goal interpretation cards. All question-answer cards were not exercised. |
| Edits, Keep/Undo and rebuild | Partial | Edits API rebuilt a sample successfully; exhaustive undo/redo byte equality was not tested. |
| Progressive build stream | Verified on samples | Canvas, paper and prompt streams ended in `done`; polling agreed. Resuming just before the last event returned only the missing `done` event. |
| Difficulty readout | Partial; UI defect | Bands and bot times display. The preview visibly leaks `{C}` in its before/after sentence. |
| Automated playtest bot | Verified on samples | Real-mode selftest and generated starters were solvable; a recorded bot trace re-simulated to a clear. Complete gameplay calibration tests are missing. |
| Physics profiles and abilities | Partial | Core profiles validated; rules screen showed Gentle/Standard/Snappy, run, stomp, double jump and fast fall. Every interaction was not manually played. |
| Enemy archetypes | Present/partial | Walker, hopper, flyer, shooter, chaser and crusher are implemented. Individual behavior tests required by the plan are absent. |
| Advanced platforms and hazards | Present/partial | Moving, one-way, crumble/falling platforms, springs, saws, firebars, keys/doors and checkpoints exist. Existing v1 compilation tests passed; comprehensive v2 interaction coverage is absent. |
| Hearts, lives, scoring and timers | Present/partial | Rules, simulation, HUD and result implementations exist. All damage/respawn/banking edge cases were not exercised. |
| Scrolling and camera | Partial | Generated content spans 3–5 screens; engine rendered sample levels. Six-screen phone performance and blind-jump guarantees were not measured. |
| Keyboard/touch controls | Partial | Gameplay renderer and controls loaded. Real touch-device testing was not performed. |
| Results, sounds and music | Partial | HUD and mute/music/restart/pause controls rendered; WebAudio implementation exists. Audible output and every results field were not verified. |
| Paper capture/CV | Verified on synthetic inputs | All existing segmentation, rectification and pipeline tests passed; synthetic JPEG built a solvable v2 draft. Real camera, handwriting and lighting reliability remain unverified. |
| Printable new/remix/extend packs | Verified | All three pack types created and returned actual PDF bytes; tray metadata returned 200. |
| Multi-sheet stitching and re-scan | Present/partial | Stitching and QR identification exist; shuffled real multi-sheet packs and unchanged-remix zero-delta behavior were not exercised. |
| Rules/library paper sheets | Partial | Both printable PDFs returned 200. Actual filled-sheet v2 reading was not exercised in this assessment. |
| Publish | Verified on sample | Server rebuild and hash check accepted the sample canvas draft; stored level detail returned 200. |
| Moderation | Partial/offline | Deterministic text blocklist and safety states exist. Model checks are unavailable without a key; publish can remain unchecked under current defaults. |
| Play screen and Phaser renderer | Partial | Preview play test rendered and responded to start/stop. Full manual clear of a seeded multi-screen level was not completed. |
| Replay codec and verification | Verified with caveat | Codec tests and real selftest passed. A 625-frame clear was accepted; a 100 ms altered claim and malformed RLE were rejected. A 1 ms change is accepted by frame-rounding policy and the stored time is recomputed. One old test incorrectly forbids the valid RESTART bit. |
| Leaderboards and ghosts | Partial | Verified runs were stored and retrieved, board APIs returned 200. Ghost visualization and complete friend-race result wording were not manually exercised. |
| Remix lineage and trees | Partial | Seeded remixes and trees returned 200; Starter World displayed two remixes. Creating and playing a new full remix was not exercised. |
| Creature Studio and library | Partial | Library read API and offline “it hops and is spiky” interpretation returned 200. Creature drawing, versioning and updating pinned levels were not fully exercised. |
| Game rules | Partial | Rules API and browser form loaded. “Turn run off” dry-run checked the game and returned 200 in ~37.9 seconds. Applying rules and repairing every affected level were not exercised. |
| Text-to-level generation | Verified offline on sample | Browser prompt generated “Monster March” in about 2.6 s, with a playable preview. API keyword planner produced solvable tiers. Complex key/door prompts and live model output are unverified. |
| Level/game ZIP export | Verified | Both starter games exported valid ZIPs; a published sample level exported and imported successfully. |
| ZIP import | Verified on sample | Imported a sample level, changed its ID and preserved its gameplay hash; no items were rejected. Whole-game and adversarial import cases were not exhaustively checked. |
| Standalone Phaser export | Verified artifact | API returned a 149-entry ZIP containing source, assets and prebuilt `dist/index.html`; standalone export build passed. The downloaded ZIP was not independently hosted and played. |
| Live shared drawing | Verified protocol | Two clients received hello/sync, exchanged a stroke with an acknowledgment, and recovered it on reconnect. Multi-user browser gestures, chat and pass-the-pencil were not exercised. |
| Profiles and device-token identity | Present | Implementation and browser entry point exist. Profile creation/authentication was not exercised, to preserve the first-user maintainer assignment for you. |
| Game book and membership | Partial/read only | Both games’ game-book and membership APIs returned 200. Write permissions, invitation/join behavior and ownership changes were not tested. |
| Contributor submissions/reviews | Partial/read only | Submission lists returned 200. Submission creation, acceptance, change requests, votes and comments were not exercised. |
| Quests, badges and credits | Partial/read only | Quests and credits APIs returned 200 and seeded quests appeared. Claim/completion/reward journeys were not exercised. |
| Activity and notifications | Partial | Activity endpoint returned 200; notifications/mark-read and authenticated bell behavior were not exercised. |
| Jams | Partial/read only | Jams list returned 200. Jam creation, timed participation and entries were not exercised. |
| Claude perception/design/critic | Unavailable locally | Code, prompts, budget and fallback exist; Anthropic credentials are blank. Fake-client budget/refusal/retry tests largely passed. Live output quality, latency and cost are unknown. |
| Firefly/Claude SVG art | Unavailable locally | Provider reported `none`. Art jobs, cutout, backdrops, styling, rerolls and fly-in reveal code exist; external generation was not exercised. |
| Generated skin rendering | Present/partial | Skin render/export code exists. No real generated skin was produced for validation. |
| Core worker pool/recovery | Verified by existing checks | Real worker round trip passed; Python dead-worker restart/retry test passed. A stale bridge assertion expecting a stub failed. |
| Database/migrations/v1 upgrade | Partial/verified basics | SQLite migration test passed; automatic Classic migration succeeded. Explicit upgrade button and every version/backward-compatibility path were not exercised. |
| Public schemas/shared contracts | Verified checks | 23 conformance files passed the real selftest; schema, freshness and cross-runtime hash tests passed. Browser-side conformance page was not exhaustively exercised. |
| Legacy v1 | Partial/verified backend | All existing v1 API tests passed, including scan, publish, remix, likes and templates. Legacy game was not manually played in this assessment. |
| Dev page | Present | Routes and scene/object inspection tools exist; every planned gameplay fixture is not present as a dedicated verified test. |
| Golden browser page | Unfinished | `#/golden` is explicitly wired to a “not implemented” screen. |
| Golden/benchmark commands | Unfinished | `golden`, `starter:verify`, `bench:core` and `golden:shots` all exit 2. |
| Deployment/CI | Missing from this checkout | No project-level CI workflow, deployment setup or container configuration found. Exported Phaser projects include a hosting workflow template. Production operation was not tested. |

## Automated checks

| Check | Result |
|---|---|
| `npm run typecheck` | PASS: app and isolated core type checks |
| `npm run build` | PASS: all four app entry points built |
| `node src/core/cli.ts selftest --real` | PASS: 26 API functions, zero stubs; 106 native module imports, 120-file lint, conformance, real/fake workers and example build |
| `npm test` | FAIL: 86 tests passed, 3 assertions failed; one additional suite failed to load. 8 files passed, 4 failed. |
| `uv run --no-sync pytest -q` | FAIL: 137 passed, 8 failed |
| `npm run starter:build` | PASS generation: 5 v2 + 3 Classic levels solvable; quality warnings below |
| `npm run build:export` | PASS |
| `npm run golden` | Unfinished: exit 2 |
| `npm run starter:verify` | Unfinished: exit 2 |
| `npm run golden:shots` | Unfinished: exit 2 |
| `npm run bench:core` | Unfinished: exit 2 |
| `npm audit` | 3 affected package entries: 1 moderate, 2 critical, all development/test tooling |
| `npm audit --omit=dev` | Zero reported runtime dependency vulnerabilities |

Web failures:

1. `editor/__tests__/tap.test.ts` imports the editor and thereby Phaser in a Node environment: `window is not defined`. The suite never loads.
2. `core/__tests__/art.api.test.ts` expects art functions to throw `NotImplemented`, although they are implemented.
3. `core/__tests__/contracts.api.test.ts` treats input byte 32 as invalid; the current codec explicitly supports it as RESTART.
4. `core/__tests__/worker.rpc.test.ts` expects `NotImplemented: build`; invalid dummy input now reaches the real builder and raises a TypeError.

Python failures:

1. `test_api_v2.py::test_build_streams_the_sample_and_resumes` sends empty `{}` ink and expects 202. The real API correctly validates and rejects it with 400. Valid ink and SSE resume passed the separate live checks.
2. Five `test_not_yet_routes_answer_501_with_a_message_key` cases expect placeholder 501 responses from routes which now implement validation or successful reads.
3. `test_bridge.py::test_pool_pings_and_hashes` expects a stub error for an implemented builder.
4. `test_mind_client.py::test_prompts_exist_for_every_call` requires each prompt to have at least 380 words; handwriting has 282. That assertion does not itself demonstrate a runtime handwriting failure.

These failures mostly show that the scaffold tests were not updated as implementation progressed. They still prevent a clean test gate, and broader gameplay coverage remains absent.

## Starter content quality

Values below are printed by the real starter builder. C is the bot’s difficulty measure; “authored target” is the intended C, not an achieved guarantee.

| Level | Screens | Solvable | C / authored target | Band | Bot fastest | Significant flags |
|---|---:|---|---|---|---|---|
| L1 Doodle Meadow | 3 | Yes | 0.26 / 0.10 | Easy | 19.0 s | None |
| L2 Spike Garden | 4 | Yes | 0.93 / 0.30 | Normal | 28.1 s | None |
| L3 Crumble Cliffs | 4 | Yes | 2.17 / 0.60 | Hard | 28.3 s | `tight_window`; generator dropped beat `3.4` |
| L4 Keyhole Castle | 5 | Yes | 1.09 / 1.00 | Hard | 35.1 s | `tight_window`, `invisible_lethal` |
| L5 Ink Gauntlet | 3 | Yes | 0.95 / 1.80 | Normal | 16.3 s | None; bonus unlock after L4 |
| Classic First Steps | 1 | Yes | Legacy physics | — | — | Builder reported successful migration |
| Classic Spike Valley | 1 | Yes | Legacy physics | — | — | Builder reported successful migration |
| Classic Key Cave | 1 | Yes | Legacy physics | — | — | Builder reported successful migration |

## Outstanding work, in practical order

1. Update stale tests and isolate editor tests from Phaser’s browser-only initialization. Establish a clean test gate before using it to judge changes.
2. Implement the golden runner, starter verifier, screenshot baselines and benchmark commands; add the missing gameplay tests. Current “zero stubs” core selftest does not cover these tools.
3. Rebalance starter difficulty and resolve the L3/L4 bot flags. Solvable is a weaker claim than fair and appropriately difficult.
4. Correct the preview `{C}` substitution. Restore the intended Patrick Hand font: only `.gitkeep` is present under `web/public/fonts/`; the build warns that the referenced WOFF2 is missing and rendering falls back.
5. Address development dependency advisories with a deliberate Vitest upgrade and compatibility checks. The audit proposes a major version change; no forced dependency update was made.
6. Exercise authenticated contribution/review/quest flows, real camera scans, multi-sheet packs and generated art once appropriate credentials and test inputs are available.
7. Measure phone performance and build latency on the required corpus. The full rules dry-run took ~37.9 s in this local check. Large production chunks (~1.2–1.3 MB each before gzip) deserve a mobile loading measurement.

## Coverage against the plan

`PLAN_V2.md` lists 25 acceptance criteria. None should be treated as fully signed off merely because code exists.

| Criterion | Current assessment |
|---:|---|
| 1 Golden drawing quality | Unverified: golden runner unfinished |
| 2 Live perception accuracy | Unverified: no credentials; referenced `scripts/golden_live.py` absent |
| 3 Art/collision equality | Unverified: no exhaustive surface-sampling run |
| 4 Streaming/poll/resume | Verified on three samples; failure and late-design paths not exhaustively covered |
| 5 Latency percentiles | Unverified: benchmark tooling/corpus not run |
| 6 Slow model and late suggestions | Unverified |
| 7 Every edit’s undo/rebuild equality | Partial: sample rebuild passed; exhaustive golden undo not run |
| 8 All model-off flows | Partial: main creation/publish/play/replay flows passed; rules OMR and full library flow unverified |
| 9 Envelope/calibration anchors | Partial: profile/selftest checks passed; specified anchor suite absent |
| 10 Every mechanic has tests and fixtures | Incomplete: required dedicated v2 gameplay tests absent |
| 11 Designer success rates/invariants | Unverified: some sample tiers miss the requested reach target |
| 12 Six-screen phone frame rate | Unverified |
| 13 Shuffled sheets and unchanged remix | Unverified |
| 14 Signed visual checklist | Incomplete: golden screenshots unfinished; missing font and placeholder observed |
| 15 Win/results correctness | Partial: bot/replay clear verified; full manual results journey unverified |
| 16 Grumpo library/versioning flow | Unverified |
| 17 Rules and run-off blocking | Partial: rule dry-run responds; full specified blocking/OMR scenarios not checked |
| 18 Prompt corpus and timing | Partial: one offline prompt works; live/complex corpus unverified |
| 19 Run acceptance/tamper/challenge | Partial: honest clear and tamper rejection verified; browser friend challenge unverified |
| 20 Spec/export/import cross-runtime | Partial: schema/hash tests and sample ZIP hash roundtrip pass; every golden/browser combination unverified |
| 21 Starter verifier | Incomplete: command exits 2; starter quality flags remain |
| 22 All prior defects covered by tests | Unverified/incomplete: test suite fails and coverage is limited |
| 23 Recovery/degenerate levels | Partial: worker restart test passes; full UI/degenerate fuzz behavior unverified |
| 24 Refusal/budget/fuzz robustness | Partial: fake-client budget/refusal tests pass; 500-level fuzz test absent |
| 25 Live model cost | Unverified: no live calls |

## Complete inventories and evidence

- [PROJECT_INVENTORY.md](PROJECT_INVENTORY.md): every one of the 826 files tracked when assessment began, grouped by subsystem, with presence and validation status. A file-level status reflects its subsystem’s checks; it is not a claim that every branch in that file was tested.
- [API_INVENTORY.md](API_INVENTORY.md): all 95 mounted HTTP operations plus the live-drawing WebSocket, with the observed response statuses where exercised.
- [smoke-results.json](smoke-results.json), [extra-smoke-results.json](extra-smoke-results.json), [run-validation.json](run-validation.json): reproducible facts from live checks.
- Build/test logs, both dependency audit outputs, the mounted OpenAPI snapshot, and [preview.jpg](preview.jpg) are in this directory.

The initial canvas smoke request was rejected because the audit input mistakenly included `world.cell`, which belongs to LevelV2 but not InkDoc. The corrected request passed. That 400 is preserved in the evidence and is not a product bug.
