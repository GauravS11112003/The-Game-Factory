# Draw-a-Level

Draw a platformer on screen or on paper, and play it seconds later with your own doodle as the character. Black ink
is ground, red is spikes and enemies, green is the goal, blue is coins and keys. Background and pitch:
[PROJECT_CONTEXT.md](PROJECT_CONTEXT.md).

## What v2 is

v2 is a rebuild of how a drawing becomes a level, and of how the level plays. The design and the source of truth is
[PLAN_V2.md](PLAN_V2.md); decisions made while building it are in [docs/v2/CONTRACTS.md](docs/v2/CONTRACTS.md).

- **Ink becomes objects, not cells.** Strokes are grouped into typed objects (ground, spikes, enemy, flag…), fitted
  to clean geometry, and compiled. Art and collision come from the same fitted shapes, so what you see is what you
  stand on.
- **A level-design mind.** A deterministic perceiver reads every drawing; Claude (when a key is set) reads it too
  and its reading is merged in. An intent-preserving repair search makes an impossible level beatable with the fewest
  changes. A designer then offers four nested tiers: Faithful, Polished (default), Challenging·Normal and
  Challenging·Hard. Every change is a card with a reason and an Undo.
- **A frame-exact bot plays every build** before you see it, on the same deterministic 60 Hz simulation the game
  runs. It measures difficulty (C, deaths, clear time) and flags unfair jumps.
- **Real platforming.** Momentum physics with a run, stomps, hearts and lives (game rules), six enemy archetypes,
  and levels up to 6 screens long with a scrolling camera.
- **One TypeScript core** (`web/src/core`) does everything after strokes. It runs in the browser (a Web Worker)
  and in 2 Node workers the Python API talks to.

v1 still exists: open `/v1.html`. The v1 `/api/*` routes keep working.

## Run

```bash
# one-time setup
cd vision && uv venv --python 3.11 && uv sync && cd ..
cd web && npm install && cd ..

# the model key (optional; without it everything works offline with the deterministic perceiver)
cp .env.example .env        # then set ANTHROPIC_API_KEY=... in .env (git-ignored)

# both servers: API on :8000, web on :5173 (prints the LAN URL for phones)
scripts/dev.sh
```

Open http://localhost:5173/ (v2). Health: `curl localhost:8000/api/v2/health` reports the model mode
(`live`, `fake` or `off`), the core workers and the budget left.

Node 24 is required: it runs the core's `.ts` files natively, with no build step. On the first boot the API migrates
the v1 levels and seeds **Starter World** (5 levels; the bonus level 5 unlocks after level 4) and **Classic Starter**
(the three v1 levels, playable under v1 physics with an "Upgrade to v2" button), plus a remix chain under Starter
World level 1.

Environment (all optional): `ANTHROPIC_API_KEY`; `DAL_FAKE_LLM=1` (recorded model replies); `DAL_DATA_DIR` (default
`vision/data`: `dal.sqlite` and `uploads/`); `DAL_DAILY_BUDGET_USD` (10) and `DAL_DRAFT_BUDGET_USD` (0.40);
`DAL_DESIGN_DEADLINE_S` (25); `DAL_CORE_WORKERS` (2); `DAL_FAST_MODE` (0); `DAL_REQUIRE_MODERATION` (0); `DAL_V2=0`
turns v2 off.

## The main flows

- **Draw** (`#/draw`): a long-canvas editor (1-6 screens). Marker colors, stamps and role chips; live hints from the
  core; ▶ test-plays locally, or "Play from here". Build → the preview.
- **Preview** (`#/preview/<draft>`): what the builder saw, every change as a card with Undo, questions ("Is this
  grass or spikes?"), the bot's path, the difficulty pill, and the **dial** (Faithful / Polished / Challenging·Normal
  / Challenging·Hard) that swaps tiers instantly. "Make it mine" undoes the designer, "Back to drawing" returns to
  the editor.
- **Scan paper** (`#/scan`): print a pack of 1-6 sheets (each with a QR code), draw, then add photos in any order.
  The tray shows which sheets are in; you can play once sheet 1 is in, and publish once all are.
- **Publish** from the preview: the server rebuilds the level from your ink and edits, checks the hash and re-runs
  the bot before it goes live.
- **Play** (`#/play/<id>`): boards (Any% and Collector), the creator's best, up to 3 ghosts (your best, the leader,
  a challenger), and the results card.
- **Remix** from the play screen: on screen (the parent's ink in gray), on paper (a printed remix sheet), or "add a
  screen" (an extend sheet). The remix tree (`#/tree/<id>`) outlines what each remix added, changed or removed.
- **Library** (`#/game/<id>/library`): draw a creature, name it, describe what it does in words ("it hops and is
  spiky"), and it plays everywhere in the game. Stamp it in the editor, or circle its letter on paper. Changing a
  creature saves version n+1; "Update levels" re-checks every level first.
- **Rules** (`#/game/<id>/rules`): physics profile, abilities (run, double jump, stomp), hearts and lives, theme,
  music, timers. "Save for new levels", or "Apply to all levels", which first lists the levels that would break and
  the designer's fixes. A paper rules sheet can be scanned too.
- **Tell me a level** (`#/prompt`): type "a lava cave with a key and two hard jumps". The model (or, offline, a
  keyword planner) picks beats. The core lays them out, proves them with the bot and fixes what fails. You get a
  blue-line draft to draw over.
- **Challenges**: after a clear, "Challenge a friend" shares `#/play/<id>?vs=<run>`. The friend races your ghost,
  and the result reads "You beat Maya by 1.32 s!". Runs are re-simulated on the server from their input replay.
- **Download / Open a file**: export a level or a whole game as a zip, and import it again.

## Where things live

```
PLAN_V2.md                 the v2 design (source of truth)
docs/v2/CONTRACTS.md       contract decisions; docs/v2/requests/ cross-lane requests; docs/spec/level-format-v2.md
shared/spec/               generated JSON Schemas, params.json, physics-profiles.json, messages.json (every sentence)
shared/starter/            Starter World plans + overrides, and dist/ (built levels, index.json)
web/src/core/              the pure-TS core: ink, scene (perception), build, edits, design, generate, sim, bot,
                           difficulty, replay, art, worker; cli.ts (selftest, starter:build, envelope, plan, validate)
web/src/engine/            Phaser engine on the core Sim (camera, views, ghosts, juice, HUD)
web/src/render/, audio/    thumbnails, share cards, themes; WebAudio sound and music
web/src/editor/            the long-canvas editor, Character and Creature Studio
web/src/app/               the v2 app: router, screens, api.ts, sse.ts
web/index.html             v2 app (v2.html is an alias); web/v1.html is the v1 app
vision/app/routers/v2/     the /api/v2 endpoints
vision/app/build/          the build orchestrator, SSE events, the Node worker bridge, publish
vision/app/mind/           every Claude call (perceive, design, plan, creature, moderate…), budget and ledger
vision/app/cv/             paper: rectify, vectorize, stitch multi-sheet packs, rules / library sheet readers
vision/app/template/       printable PDFs (packs, remix and extend sheets, rules and library sheets)
vision/app/spec/           Pydantic contracts → shared/spec/*.schema.json + web/src/core/types.gen.ts
vision/app/db_v2.py, migrate_v1.py, seed_v2.py   SQLite v2 tables, v1 migration, seeds
```

Regenerate the contracts after a change in `vision/app/spec/`: `cd vision && uv run --no-sync python
../scripts/gen_contracts.py`. Rebuild Starter World after a change in `shared/starter/`: `cd web && npm run
starter:build` (the next API boot publishes changed levels as new versions). Core self-check: `node
web/src/core/cli.ts selftest`.
