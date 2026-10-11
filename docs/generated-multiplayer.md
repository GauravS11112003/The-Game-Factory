# Play a game you create with a friend

1. Open draw.play on your phone and describe a new game.
2. Select **Multiplayer** beside **Better graphics**. Artwork and multiplayer are independent choices; you can select both.
3. Generate the game. It will be designed for two human players, with versus or cooperative rules that fit your idea.
4. Tap **Play with a friend**, then **Invite a friend**. Send the invitation through Messages or any other chat. Both players open it, enter their names, and tap **Ready**.
5. Use the large controls below the game. The round pauses when either player disconnects. Reopen the same invitation to resume. After a result, both players tap **Play again** to rematch.

Multiplayer selection stays with saved creation drafts, retries, chat revisions, and new levels. You can switch it in the builder and apply the change. Existing single-player games remain single player until you regenerate them with multiplayer enabled.

## Inside iMessage

Browser invitations open the web game. To play inside the Messages window, both players install [Spectrum’s Messages app](https://apps.apple.com/app/id6777616651), and the deployment must have an active Photon iMessage project/line. After the project is connected, **Start in iMessage** composes `play d_<draft-id>` to the configured bot number. Send the command, open the returned game card, and forward it to your friend. A fresh bot card leaves both seats open, so moving from Safari into Spectrum doesn't occupy the host seat twice.

The bot also accepts `invite room_<24-hex-id> <invitation-token>`. Configure `DAL_SPECTRUM_NUMBER` only after verifying the receiving number assigned to the Photon project. A shared Photon line may vary by recipient; do not invent a universal contact. Without an activated project, browser play works and the app explains that Messages activation is pending.

## Developer contract

A generated multiplayer game returns `multiplayer_spec` with version 1, versus/cooperative mode and allowed action IDs. The isolated HTML exposes `window.drawPlayMultiplayer` with `start`, `input`, `snapshot`, `restore`, `pause`, and `result`. See [the generation contract](../vision/app/mind/prompts/multiplayer.md).

The trusted parent owns networking, invitation and player credentials, mobile controls, readiness, reconnects, and rematches. It communicates with the sandbox through a source-checked, nonce-bound message bridge. The generated iframe has scripts but no same-origin privileges, storage, navigation or network access. It receives neither tickets nor invitation secrets.

Player 1 simulates the shared world; Player 2 renders snapshots. The API derives input ownership from the authenticated socket and permits only Player 1 to publish worlds/results. Snapshots are bounded to 48 KB, published about ten times per second, and checkpointed in SQLite. This is casual friend play: host game outcomes are not independently verified or protected against a dishonest host.

Room creation pins a copy of the exact generated artifact. Later edits or new levels don't change an active session. Invitations expire after 24 hours. Player tickets are sent in the socket's first frame, never its URL. Rejoining uses a persistent per-browser claim, and a replacement connection invalidates the old socket. Both participants must be connected and ready before a three-second countdown; disconnects pause the simulation and clear held input. Both must agree to a rematch, which resets the seed, checkpoint, readiness, and round.

Endpoints: `POST /api/v2/play-rooms`, `POST /play-rooms/{id}/join`, `GET /play-rooms/{id}` (ticket or invite), `GET /play-rooms/{id}/game` (ticket), invitation `GET /play-rooms/{id}/card`, and authenticated `WS /play-rooms/{id}/socket`. Bot creation is idempotent using the existing service credential and request receipt. Results and subscription kind persist across messaging-worker restarts.

If a generated game lacks its adapter or cannot save/restore state, the room reports that it needs a multiplayer repair. Ask the builder to fix multiplayer controls or snapshots and create a new invitation for that revised build.
