# Mounted API operation inventory

Assessed October 10, 2026. The running API mounts **95 HTTP operations** plus **one live-drawing WebSocket route**. This inventory comes from its actual OpenAPI schema, rather than a planned list.

“Observed” reports the responses to representative requests; successful responses do not prove all authorization/error paths. A 400/422 caused by deliberately invalid input is a validation result, not automatically a failure. No live Claude/Firefly jobs or authenticated collaboration writes were exercised.

| Method | Route | Current status |
|---|---|---|
| GET | `/api/health` | Observed HTTP 200; 1 request(s) |
| POST | `/api/scan` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/drafts/{draft_id}` | Mounted; existing v1 API suite passed; not individually live-probed |
| POST | `/api/levels` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/levels/{level_id}` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/levels/{level_id}/tree` | Mounted; existing v1 API suite passed; not individually live-probed |
| POST | `/api/levels/{level_id}/like` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/fixtures` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/fixtures/{name}` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/games` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/games/{game_id}` | Mounted; existing v1 API suite passed; not individually live-probed |
| POST | `/api/games/{game_id}/levels` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/templates/blank.pdf` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/templates/remix/{level_id}.pdf` | Mounted; existing v1 API suite passed; not individually live-probed |
| GET | `/api/v2/health` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/builds` | Observed HTTP 202, 400; 3 request(s) |
| GET | `/api/v2/builds/{build_id}/events` | Observed HTTP 200; 6 request(s) |
| GET | `/api/v2/drafts/{draft_id}` | Observed HTTP 200; 3 request(s) |
| PUT | `/api/v2/drafts/{draft_id}/edits` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/drafts/{draft_id}/answers` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/drafts/{draft_id}/dial` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/drafts/{draft_id}/redesign` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/drafts/{draft_id}/critic` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/levels` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/levels/{level_id}/moderate` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/levels/{level_id}/upgrade` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/levels/{level_id}` | Observed HTTP 200; 13 request(s) |
| GET | `/api/v2/levels/{level_id}/tree` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/levels/{level_id}/runs` | Observed HTTP 200, 422; 4 request(s) |
| GET | `/api/v2/levels/{level_id}/runs` | Observed HTTP 200; 2 request(s) |
| GET | `/api/v2/runs/{run_id}` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/levels/{level_id}/attempts` | Mounted implementation; no live request in this assessment |
| PUT | `/api/v2/levels/{level_id}/thumbnail` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/games` | Observed HTTP 200; 4 request(s) |
| POST | `/api/v2/games` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/games/{game_id}` | Observed HTTP 200; 2 request(s) |
| GET | `/api/v2/games/{game_id}/library` | Observed HTTP 200; 2 request(s) |
| POST | `/api/v2/games/{game_id}/library` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/library/{type_id}` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/library/{type_id}/versions` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/library/{type_id}/update-levels` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/library/interpret` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/scan/library-sheet` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/games/{game_id}/rules` | Observed HTTP 200; 2 request(s) |
| PUT | `/api/v2/games/{game_id}/rules` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/games/{game_id}/rules/check` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/scan/rules-sheet` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/prompt-levels` | Observed HTTP 202; 1 request(s) |
| POST | `/api/v2/packs` | Observed HTTP 201; 3 request(s) |
| GET | `/api/v2/packs/{pack_id}` | Observed HTTP 200; 3 request(s) |
| GET | `/api/v2/templates/pack/{pack_id}.pdf` | Observed HTTP 200; 3 request(s) |
| GET | `/api/v2/templates/rules.pdf` | Observed HTTP 200; 1 request(s) |
| GET | `/api/v2/templates/library.pdf` | Observed HTTP 200; 1 request(s) |
| GET | `/api/v2/levels/{level_id}/export` | Observed HTTP 200; 1 request(s) |
| GET | `/api/v2/games/{game_id}/export` | Observed HTTP 200; 2 request(s) |
| POST | `/api/v2/import` | Observed HTTP 201; 1 request(s) |
| GET | `/api/v2/creative/status` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/creative/jobs` | Mounted; external provider-dependent flows unavailable locally |
| GET | `/api/v2/creative/jobs` | Mounted; external provider-dependent flows unavailable locally |
| GET | `/api/v2/creative/jobs/{job_id}` | Mounted; external provider-dependent flows unavailable locally |
| POST | `/api/v2/creative/jobs/{job_id}/reroll` | Mounted; external provider-dependent flows unavailable locally |
| POST | `/api/v2/creative/jobs/{job_id}/choose` | Mounted; external provider-dependent flows unavailable locally |
| POST | `/api/v2/creative/jobs/{job_id}/pin` | Mounted; external provider-dependent flows unavailable locally |
| POST | `/api/v2/creative/backdrop` | Mounted; external provider-dependent flows unavailable locally |
| POST | `/api/v2/creative/style` | Mounted; external provider-dependent flows unavailable locally |
| GET | `/api/v2/creative/style` | Mounted; external provider-dependent flows unavailable locally |
| PUT | `/api/v2/drafts/{draft_id}/skin` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/collab/players` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/players/me` | Mounted implementation; no live request in this assessment |
| PUT | `/api/v2/collab/players/me` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/players/{player_id}` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/collab/games/{game_id}/bible` | Observed HTTP 200; 2 request(s) |
| PUT | `/api/v2/collab/games/{game_id}/bible` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/games/{game_id}/members` | Observed HTTP 200; 2 request(s) |
| POST | `/api/v2/collab/games/{game_id}/members` | Mounted; authenticated write workflow unverified |
| DELETE | `/api/v2/collab/games/{game_id}/members/{player_id}` | Mounted; authenticated write workflow unverified |
| POST | `/api/v2/collab/games/{game_id}/join` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/games/{game_id}/submissions` | Observed HTTP 200; 2 request(s) |
| GET | `/api/v2/collab/submissions/{sub_id}` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/collab/submissions/{sub_id}/review` | Mounted; authenticated write workflow unverified |
| POST | `/api/v2/collab/submissions/{sub_id}/comments` | Mounted; authenticated write workflow unverified |
| POST | `/api/v2/collab/submissions/{sub_id}/vote` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/games/{game_id}/quests` | Observed HTTP 200; 2 request(s) |
| POST | `/api/v2/collab/games/{game_id}/quests` | Mounted; authenticated write workflow unverified |
| POST | `/api/v2/collab/quests/{quest_id}/claim` | Mounted; authenticated write workflow unverified |
| POST | `/api/v2/collab/quests/{quest_id}/done` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/games/{game_id}/credits` | Observed HTTP 200; 2 request(s) |
| GET | `/api/v2/collab/activity` | Observed HTTP 200; 1 request(s) |
| GET | `/api/v2/collab/notifications` | Mounted implementation; no live request in this assessment |
| POST | `/api/v2/collab/notifications/read` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/collab/jams` | Observed HTTP 200; 1 request(s) |
| POST | `/api/v2/collab/jams` | Mounted; authenticated write workflow unverified |
| GET | `/api/v2/live/{room}/info` | Observed HTTP 200; 1 request(s) |
| GET | `/api/v2/live/{room}/qr.svg` | Mounted implementation; no live request in this assessment |
| GET | `/api/v2/games/{game_id}/export/phaser` | Observed HTTP 200; 1 request(s) |
| WS | `/api/v2/live/{room}` | Verified two clients, hello/sync, stroke broadcast/ack and reconnect |

The canvas 400 in the evidence was from an incorrectly formed audit request (`world.cell` in InkDoc). A corrected canvas request returned 202 and completed. Replay rejection checks returned 422 as expected.
