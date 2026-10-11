# Draw-a-Level

Sketch a game, describe its world, and let Sonnet turn the whole canvas and your brief into a playable browser game.
Create supports ten game categories plus a custom definition, theme references, gameplay goals, and visual details.
The optional faithful builder creates platformer levels with fixed marker roles: black ground, red hazards, green
goals, and blue collectibles. Background and pitch:
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

To host the app and Photon service on your Vultr server, follow
[the server and phone launch guide](docs/vultr-launch.md).

```bash
# one-time setup
cd vision && uv venv --python 3.11 && uv sync && cd ..
cd web && npm install && cd ..

# the model key (required for Imagine; the faithful builder also works offline)
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

Imagine uses `DAL_SONNET_MODEL=claude-sonnet-5-5` by default. The model receives clean images spanning the entire
canvas, any character sketch, the original creation brief, canvas notes, and extra author instructions. It writes
a complete self-contained game with original graphics and mechanics. Imagine first creates a shared art direction
and up to five SVG assets when the author selects **Better graphics**: scenery, terrain textures, transparent sprites,
and horizontal animation sheets. The option is off by default and is available in new-game modals, level creation,
legacy drawing, prompt and paper creation, and the saved game's chat. It uses the existing `ANTHROPIC_API_KEY` and
`DAL_SONNET_MODEL` for a dedicated SVG art pass, not Firefly or an example-specific image library. Standard Imagine
builds skip the extra art call and draw directly in Canvas. Saved drafts, retries, revisions and new levels retain
the selected setting; turning it off for a revision skips further art generation while keeping existing artwork.
Faithful platformer builds retain their verified geometry and apply optional SVG skins through the creative preview.

The game receives an asset manifest and drawing helpers, while the server embeds image bytes after code generation,
keeping artwork out of the code response budget. Image failures preserve completed assets and fall back to procedural
drawing. Art generation is bounded to two minutes within the overall six-minute build limit and uses the existing
daily art budget. `DAL_IMAGINE_ART=0` disables the extra Imagine art pass globally. The saved raster library remains
available to other integrations, but Better graphics generates SVGs for the actual prompt. Medium effort and a compact-game prompt keep the model focused
on finishing the playable artifact. Generation streams from Sonnet;
the creation page shows elapsed time and switches to the writing stage as output arrives. A six-minute limit,
bounded status requests, and explicit connection/timeout recovery prevent an endless loading screen. Generation jobs hold a shared process lock and save their model inputs.
After a server reload, the creator’s next status check resumes the same draft, up to two times;
other API processes can poll the active job without declaring it interrupted or creating a duplicate. Retry uses
the saved canvas and details, and repeated retry requests follow the same active job. Generated games are saved in
`DAL_DATA_DIR/generated-games/`, served with a restrictive sandbox policy, and displayed in an isolated iframe
with network access blocked. They have their own controls and win/restart logic; the faithful builder's deterministic
physics, bot proofs, leaderboards, and export formats apply to faithful levels only.

## The main flows

- **Race a friend**: open a faithful platformer and choose "Play with a friend". Share its two-seat lobby, ready up,
  race from a shared countdown, and rematch after the server verifies both finishes. The optional Photon Spectrum
  service sends app cards designed to open inside iMessage and reports results back to the chat. Setup and device
  validation requirements: [docs/imessage.md](docs/imessage.md). Imagine games need multiplayer adapters first.

- **Create** (`#/create`): one game-creation workspace with category, theme, gameplay, details, extra context, and a
  drawing board (1-6 screens). "Create game" builds from all of these together and also works without drawing.
  "Creative with Sonnet" is the default; "Follow my design closely" uses the faithful platformer builder.
  After submission, the creation modal expands into a chat workspace with a playable preview.
  Edit the sketch from that workspace to revisit the original canvas and context.
  The old plain `#/draw` entry also opens Create; specialized faithful level-editing links remain compatible.
- **Imagine** (`#/imagine/<draft>`): a saved conversation beside a playable preview. Send follow-up requests
  to add features, change art, or fix mechanics; each revision receives the current game HTML, conversation,
  and original sketch. The previous version stays playable while an update runs. Retry keeps the same change
  request and level slot. Publish the latest completed revision directly from the workspace. Saved games
  reopen with their conversation, and unsent messages stay on this device.
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
