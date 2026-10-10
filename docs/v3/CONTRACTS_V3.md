# draw.play v3: Adobe + collaboration contracts

Seven lanes build these features in parallel. This file is the handshake: code against it, not against
another lane's internals. If you must change a contract, append a dated note at the bottom of this file.

## Product decisions

- **Firefly timing.** Generation runs silently in the background while the kid draws (a tray counter shows
  "3 ready"). The **fly-in reveal happens on Build**: in the preview, sprites fly from the creative tray onto
  their objects one at a time (≈350 ms apart). Objects still generating fly in when they finish.
- **Art never changes gameplay.** Collision, entities and `level_hash` come only from ink and the designer.
  Generated art is a `skin`; `levelHash` already hashes gameplay only (`web/src/core/build/hash.ts`).
- **Providers.** `firefly` when `FIREFLY_CLIENT_ID` + `FIREFLY_CLIENT_SECRET` are set in `.env`; otherwise
  `claude-svg` (Claude writes a clean SVG sprite from the object description + stroke outline). If neither is
  available, `none` (the kid's ink stays). The UI never blocks on art.
- **Ownership toggle.** Per object and per game: "My drawing" / "Bring to life". Default: Bring to life when
  a provider is available.
- **Identity.** No passwords. A profile is `{id, name, avatar_url}` plus a secret device token kept in
  localStorage. The first profile created on a server becomes maintainer of seeded games (Starter World,
  Classic Starter).
- **Contribution.** Publishing to a game you don't maintain creates a **submission** (pending review);
  the level is stored unlisted until accepted. Owners/maintainers publish directly.

## Environment (.env, all optional)

```
FIREFLY_CLIENT_ID=        # Adobe Developer Console, Firefly Services (OAuth server-to-server)
FIREFLY_CLIENT_SECRET=
DAL_ART_PROVIDER=auto     # auto | firefly | claude-svg | none
DAL_ART_BUDGET_USD=5      # daily cap for art generation (Claude SVG cost; Firefly counted in images)
```

## Identity (lane 4 backend, lane 5 frontend)

- Header on every request that acts as someone: `X-DP-Player: <player_id>.<token>`.
- `web/src/app/identity.ts` (lane 5) exports:
  ```ts
  export interface Player { id: string; name: string; avatar_url: string | null }
  export function currentPlayer(): Player | null;
  export function authHeaders(): Record<string, string>;   // {} when no profile yet
  export function ensurePlayer(): Promise<Player>;           // opens the "Who are you?" sheet if needed
  ```
- Python (lane 4) `vision/app/collab/identity.py`:
  `def player_from_request(request) -> dict | None` and FastAPI dependency `current_player`.

## Skin on levels (lane 1 owns the spec change)

`LevelV2.skin` (optional, NOT part of level_hash):

```jsonc
"skin": {
  "provider": "firefly",               // firefly | claude-svg
  "style_id": "sty_ab12",              // the game's style used, if any
  "backdrop": { "url": "/uploads/art/…/bg.png", "credit": {"by": "Maya", "tool": "Adobe Firefly"} } | null,
  "objects": [
    { "stroke_ids": ["s3","s4"],        // the drawing strokes this art replaces
      "object_id": "o7" | null,         // filled when the build is known
      "url": "/uploads/art/…/o7.png",   // transparent PNG or SVG
      "label": "slime monster",
      "credit": {"by": "Maya", "tool": "Adobe Firefly", "prompt": "…"},
      "mode": "life" }                  // life | ink  (ink = kid chose "My drawing")
  ]
}
```

The renderer (lane 3) places each `life` entry over the level object whose `strokes` overlap
`stroke_ids` most: scaled to the object's fitted bbox, feet on the bottom for enemies/player, centered
otherwise. The kid's ink for those strokes is hidden (kept for "My drawing").

## Creative API (lane 1 backend, lane 2 frontend). Prefix `/api/v2/creative`

| Method & path | Body | Returns |
|---|---|---|
| `GET /status` | - | `{provider: "firefly"\|"claude-svg"\|"none", budget_left_usd}` |
| `POST /jobs` | multipart: `crop` (PNG of the strokes on white, ≤512 px), `doc_id`, `stroke_ids` (JSON array), `game_id?`, `hint?` (role chip or typed label), `bbox_cells` (JSON [x0,y0,x1,y1]) | `202 {job_id}`; identical fingerprint (crop hash + game style) → returns the cached job |
| `GET /jobs?doc_id=` | - | `{jobs: Job[]}` |
| `GET /jobs/{job_id}` | - | `Job` |
| `POST /jobs/{job_id}/reroll` | `{}` | `202 {job_id}` (3 variations; Job.variants) |
| `POST /jobs/{job_id}/choose` | `{variant: n}` | `Job` |
| `POST /jobs/{job_id}/pin` | `{game_id, name}` | `{type_id}` (saved to the game's creature library with this art) |
| `POST /backdrop` | `{doc_id, game_id?, theme?, screens}` | `202 {job_id}` (wide parallax backdrop) |
| `POST /style` | `{game_id, description}` or multipart `image` | `{style_id, image_url}` (the game's style reference) |
| `PUT /api/v2/drafts/{draft_id}/skin` | `skin` object | `{ok: true}`; stored in draft state `skin`, copied into the level on publish |

`Job = {job_id, doc_id, status: "queued"|"working"|"done"|"failed", label, prompt, url|null, variants: [{url}], stroke_ids, bbox_cells, provider, error_key|null, credit}`

Prompts: a Claude call (existing `vision/app/mind/client.py`, effort low) names the object and writes the
art prompt from the crop + hint + game style text. Firefly: structure reference = the crop, style reference
= the game's style image, "single object on a plain white background, 2D game sprite, side view".
Background removal: Photoshop API remove-background when available, else a local OpenCV white-key cutout.

## Collaboration API (lane 4 backend, lane 5 frontend). Prefix `/api/v2/collab`

| Method & path | Body | Returns |
|---|---|---|
| `POST /players` | `{name, avatar_png?}` | `{player, token}` |
| `GET /players/me` | header | `{player, badges, stats}` |
| `GET /players/{id}` | - | `{player, badges, stats, levels}` |
| `GET /games/{id}/bible` / `PUT` | `{pitch, mechanics_text, style_id?, style_prompt?, starter_type_ids[], open_for: "everyone"\|"invite"}` | bible |
| `GET /games/{id}/members` / `POST` (owner) / `DELETE /games/{id}/members/{player_id}` | `{player_id, role: "maintainer"\|"contributor"}` | members |
| `POST /games/{id}/join` | - | membership (contributor) |
| `GET /games/{id}/submissions?status=` | - | submissions |
| `POST /submissions/{id}/review` | `{decision: "accept"\|"changes"\|"decline", note}` | submission (accept → level listed + appended to the game's sequence, credits recorded) |
| `POST /submissions/{id}/comments` | `{text}` | comment |
| `POST /submissions/{id}/vote` | `{value: 1}` | `{votes}` |
| `GET /games/{id}/quests` / `POST` (maintainers) | `{title, description, kind: "level"\|"creature"\|"art"\|"fix", reward_badge?}` | quests |
| `POST /quests/{id}/claim` | - | quest |
| `GET /games/{id}/credits` | - | `{contributors: [{player, levels, creatures, art, quests}]}` |
| `GET /activity?game_id=` | - | feed items |
| `GET /notifications` / `POST /notifications/read` | header | items / ok |
| `GET /jams` / `POST /jams` | `{title, theme, starts_at, ends_at, game_id?}` | jams |

Publish (`POST /api/v2/levels`, lane 4 owns `vision/app/build/publish.py`): with `X-DP-Player`, publishing
into a game the player doesn't maintain returns `{level, submission: {id, status: "pending", game_id,
game_title}}` and stores the level unlisted. Publishing copies draft state `skin` into `level.skin`.
Notifications: new submission → maintainers; review decision → contributor; level played 10/100 times, beaten,
quest claimed/filled → relevant players.

Badges (ids): `first_level`, `first_accept`, `creature_maker` (5 pinned), `quest_hero`, `featured`,
`jam_entrant`, `helper` (5 reviews).

## Live drawing (lane 6). WebSocket `GET /api/v2/live/{room}` (Vite proxies ws)

Messages (JSON): `hello {player, color}`, `presence [{player, color, cursor}]`, `stroke_add {stroke}`,
`stroke_remove {id}`, `cursor {x, y}`, `chat {text}` (emoji reactions only in UI). The server keeps an
append-only op log per room and replays it on join. Room id = the editor doc id. Share link:
`#/draw?live=<room>&game=<id>`.

## Phaser export (lane 7)

`GET /api/v2/games/{id}/export/phaser` → zip: a standalone Phaser 3 project (`package.json`, `index.html`,
`src/` player bootstrap, prebuilt `dist/`), `game.json` (the ordered levels with skins and rules), `assets/`
(sprites, backdrops), `CREDITS.md` (every contributor and Firefly credit), `README.md`.
Web: an "Export to Phaser" button on the game page.

## Lanes and file ownership

| Lane | Owns |
|---|---|
| 1 Creative backend | `vision/app/creative/**`, `vision/app/routers/v2/creative.py`, `vision/app/mind/art_prompt.py`, `vision/app/mind/prompts/art_*.md`, spec change for `skin` in `vision/app/spec/level.py` + regenerate (`cd vision && uv run --no-sync python ../scripts/gen_contracts.py`), `.env.example` |
| 2 Creative UI | `web/src/app/creative/**` (tray, fly-in, prefetch, api), creative hooks in `web/src/app/screens/draw.ts` and `web/src/app/screens/preview.ts`, `web/src/editor/groups.ts` |
| 3 Skin rendering | `web/src/engine/**`, `web/src/render/**`, `web/src/core/art/**` (skin support, backdrop image layer, thumbnails) |
| 4 Collab backend | `vision/app/collab/**`, `vision/app/routers/v2/collab.py`, `vision/app/build/publish.py`, `vision/app/routers/v2/levels.py` (publish response), seed ownership |
| 5 Collab UI | `web/src/app/identity.ts`, `web/src/app/collab/**`, new screens `web/src/app/screens/{bible,review,quests,profile,activity,credits,jams}.ts`, routes in `web/src/app/main.ts`, collab buttons in `home.ts`, `game.ts`, `play.ts`, `style.css` (append only, prefixed sections) |
| 6 Live drawing | `vision/app/routers/v2/live.py`, `web/src/editor/live.ts`, `web/src/app/live/**`, minimal hooks in `web/src/editor/index.ts` and `draw.ts`, `ws: true` in `web/vite.config.ts` |
| 7 Phaser export | `web/src/export/**`, `web/export.html`, `web/vite.export.config.ts`, `vision/app/routers/v2/export_phaser.py`, export button in `web/src/app/screens/game.ts` (small, append) |

`shared/spec/messages.json`: every lane may add keys (prefix with its area: `creative.`, `collab.`, `live.`,
`export.`); edit with a fresh read and a single insertion, never reformat the file.
New routers are picked up automatically from `vision/app/routers/v2/` (check `__init__.py`).

## Changelog
- 2026-10-10 v3.0 initial.
- 2026-10-10 lane 2 (note for lane 3, optional): the preview's fly-in needs an object's on-screen rect. If the engine
  can, add to `GameHandle` (viewport CSS px, `{x, y, w, h}` or null when not on stage)
  `objectScreenRect?(objectId: string)` and/or `worldToScreen?(rect: RectCells)`. Lane 2 calls them when present and
  otherwise computes the rect from the Phaser canvas box (48 × 27 cells) and the preview camera at spawn
  (`initCamera`), which drifts if the camera has moved. Lane 2 shows the art by `stage.show()` with `level.skin` holding
  only the objects that have landed so far (one swap per landing, ≈350 ms apart), so `swapLevel` with a changed
  `skin` should re-skin in place. Doc id: `EditorDocData.id` (same reading as `editor/live.ts docIdOf`).
- 2026-10-10 lane 3: `GameHandle.setSkin(skin | null)` re-skins in place (only changed pictures; the sim never restarts),
  and `swapLevel` with a level that differs only in `skin` takes the same path. `GameHandle.objectScreenRect(id)` (scene
  object id, entity id or `'player'`; moving things where they are now) and `worldToScreen(rect: RectCells)` return
  viewport CSS px as a DOMRect that also has `w`/`h`, null when unknown or not ready. `setCredits(on)` /
  `MountOptions.credits` toggle the "Art: Adobe Firefly · drawn by …" pill. `renderThumbnail` now returns
  `Promise<boolean>` (true after repainting with skin pictures: await it before caching a thumbnail). For a flicker-free
  landing, call `loadSkinImage(url)` (from `engine/index.ts`) when a job is done; `skinTargetOf(level, ink, stroke_ids,
  object_id?)` gives the object id a fly-in should aim at.
- 2026-10-10 v3.1 (integration): live protocol extended beyond the contract table (`sync`, `ack`, `reject`, `meta`, `pencil`, `ping`/`pong`, `error`, batched `strokes`/`ids`; join via `?player=<id>.<token>&name=&cid=`); full spec in the `vision/app/routers/v2/live.py` docstring. `GET /creative/style?game_id=` added; style `image_url` may be null without Firefly. `request()` in `web/src/app/api.ts` sends `authHeaders()` on every call. Publish accepts `quest_id`; live jams are entered automatically.
