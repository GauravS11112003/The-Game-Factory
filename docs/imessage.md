# Two-player races in iMessage

The first multiplayer mode races two players through the same faithful platformer
level. It works in the web app and is designed to open inside Messages through
Photon's Spectrum launcher. Generated Imagine HTML games do not yet implement
this multiplayer protocol.

## Try a race locally

Use Node 24 or newer, then start the app with `scripts/dev.sh`. If your default
Node is older, set `DAL_NODE` to the Node 24 executable for the Python core workers
and put that Node on PATH for the web and messaging services.

Open a platformer at `#/play/<level-id>` and choose **Play with a friend**. Share
the invitation with another browser or phone on the same network. The friend
enters a name and joins. Both players choose **I'm ready**. A shared countdown
starts the race, and the screen shows both players' progress. Results are checked
by replaying each player's inputs on the server. Both choose **Rematch** for the
next round.

The existing Starter World levels are supported (for example `lvl_world_l1`).
For local sharing between phones, open the host's LAN address rather than
`localhost` before copying the invitation.

## Connect Photon

For a complete server and phone walkthrough, use [the Vultr launch guide](vultr-launch.md).
The deployment files run the website, API, and messaging service on one Linux server.

1. Create a Spectrum project and provision an iMessage line in
   [Photon's dashboard](https://app.photon.codes).
2. Deploy the web app and Python API behind one public HTTPS origin, with
   `/api` and `/uploads` routed to the API and WebSocket upgrades enabled.
   Set `DAL_PUBLIC_URL` to this origin in both processes.
3. Set the following values in the git-ignored root `.env`. Keep these secrets
   server-side; no browser code uses Photon credentials.

   ```dotenv
   DAL_PUBLIC_URL=https://your-public-game-host.example
   DAL_API_URL=http://127.0.0.1:8000
   SPECTRUM_PROJECT_ID=your-project-id
   SPECTRUM_PROJECT_SECRET=your-project-secret
   DAL_SPECTRUM_SERVICE_SECRET=your-separate-random-service-secret
   DAL_SPECTRUM_NUMBER=your-provisioned-iMessage-number
   DAL_SPECTRUM_DELIVERY=card
   ```

   `DAL_SPECTRUM_SERVICE_SECRET` authenticates idempotent bot requests to the
   Python API. Generate at least 32 random bytes, and set the same value in both
   services. `DAL_SPECTRUM_NUMBER` exposes the **Start a race in iMessage** button
   in the lobby. Use the number Photon assigned; do not use a personal number.
   Free/Pro shared-pool numbers can differ between recipients. Leave this value
   unset unless Photon provides a suitable number for your setup, and use your
   existing Photon conversation to send the race command instead.
4. In `messaging`, run `npm ci`, then `npm start` with Node 24 or newer. The command
   reads the root `.env`. Run one messaging process per messaging state database.
5. In a lobby, choose **Start a race in iMessage** and send the prefilled command
   to the bot. It creates a new two-seat lobby for that exact level version and
   replies with a Spectrum game card. Open it, enter your name, and forward the
   card to your friend. Both seats are claimed inside Messages, so the host's
   browser ticket does not need to transfer between apps. The original browser
   lobby stays separate and expires if unused. Alternatively, text
   `race lvl_world_l1` (latest version), or `race lvl_world_l1 v1` (version 1).
   Text `help` for instructions.
6. Players install
   [Spectrum – Apps in Messages](https://apps.apple.com/app/id6777616651) once to
   open app cards inside Messages. An ordinary invitation link opens in a browser.

Confirm that your Photon project can send Spectrum launcher app cards before
testing inside Messages. Photon lists custom mini apps and dedicated lines under
Business on [its pricing page](https://photon.codes/pricing). If app cards are not
enabled, set `DAL_SPECTRUM_DELIVERY=link` and restart the messaging service: the
same bot commands send ordinary invitations that open the multiplayer game in
the browser. This mode does not require the launcher.

The service only responds to recognized inbound commands. It never initiates a
conversation with a guessed phone number. Results return to chats that requested
the card; a friend who only received a forwarded card sees results in the game.
Each player can request the card from the bot to receive their own result message.
Group creation and membership features require a dedicated Photon line; the
initial implementation works through DMs and forwarded cards.

## Match behavior

- Matches pin a complete snapshot of the level and its version. Editing a level
  cannot change an active race.
- A shared invitation can claim an available seat. Each player gets a separate
  private ticket. Repeated join requests from the same browser return the same
  seat. An invitation does not authenticate the host.
- WebSocket tickets travel in the first message, rather than a logged URL.
  Opening the same player ticket in another tab supersedes the old connection.
- The timer starts on the server after both players are connected and ready.
  Finishing time is measured from that start to the server's receipt of a valid
  replay, including idle time, pauses, and network delivery. This is a casual race:
  replay verification proves a valid completion, not a full anti-cheat system.
- Progress indicators are provisional; they never determine the winner.
- A player's replay is saved in session storage approximately once per second
  and when leaving the page. Reopening the same browser context restores it.
  Storage persistence across the Photon launcher must still be verified on devices.
- Presence expires after 15 seconds without a client heartbeat. After another
  45 seconds without reconnecting, the player forfeits. Races last at most ten
  minutes. Invitations to unused matches expire after 24 hours.
- Results settle when both players finish or forfeit. The earliest verified
  server finish wins. If neither finishes, neither wins. Both players must request
  a rematch; the same private tickets continue into the next round.
- Match data is stored in `DAL_DATA_DIR/dal.sqlite`. The messaging queue and result
  subscriptions persist under `DAL_SPECTRUM_DATA_DIR`, defaulting to
  `vision/data/messaging`. Multiple Python workers can share the same local SQLite
  file. Multiple hosts require shared storage and a different database design.
- Duplicate inbound delivery creates one match. Outbound delivery is at least
  once: a crash between sending and saving the receipt may repeat a card or result.
  New result messages are used; in-place app-card edits are not implemented yet.

## Verification

```bash
cd vision
DAL_NODE=/path/to/node24 .venv/bin/python -m pytest tests/test_races.py -q
cd ../web
npm run typecheck
npm run build
cd ../messaging
npm run typecheck
npm test
```

Before opening the service to users, test two actual iPhones inside Messages:
launcher installation, touch controls, sound activation, sharing, simultaneous
joins, background/reopen behavior, network loss, expiry, verified results, and
rematches. Public hosting and live Photon delivery require the credentials above;
automated local tests do not establish those device behaviors.

Official references:
[Spectrum iMessage provider](https://photon.codes/docs/spectrum-ts/providers/imessage),
[app cards](https://photon.codes/docs/spectrum-ts/content/app),
[line routing and groups](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).
