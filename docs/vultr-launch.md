# Launch draw.play on Vultr and play from your phone

Vultr runs the website, Python API with Node 24 game verification, and a separate
Node 24 Spectrum service. Photon Cloud handles iMessage delivery. You do not need
a Mac running on the server. HTTPS and live multiplayer use the same domain.
The deployment stores game data, uploads, message queues, and HTTPS certificates
in persistent Docker volumes and restarts services after a server reboot.

This guide assumes a Vultr Linux Cloud Compute server, Ubuntu 24.04 or another
Docker-supported Ubuntu version, SSH access, and a domain such as
`play.your-domain.com`. A server with 2 GB RAM or more is a practical starting
point; building the frontend may need additional memory on a smaller server.
An existing server already using ports 80/443 needs its current reverse proxy
adapted rather than a second proxy started on those ports.

The files are prepared for deployment. A successful local build does not establish
that your Vultr server, Photon account, or iPhone launcher has been connected.

## 1. Point your domain at Vultr

In your domain provider's DNS settings, add an **A** record for `play` pointing to
your Vultr server's public IPv4 address. Add an AAAA record only if the server's
IPv6 and firewall are configured too. Incorrect AAAA records can break HTTPS.
Initially use DNS-only mode if your DNS provider offers a proxy toggle.

In the Vultr firewall attached to the server, allow TCP **80** and **443** from
the internet, and preserve SSH access (usually TCP 22) from your own address.
UDP 443 is optional for HTTP/3. Apply equivalent rules in the server's firewall
if it has one. The API and messaging service have no public ports.

Caddy obtains and renews HTTPS certificates once the domain resolves to this
server and ports 80/443 are reachable. No separate certificate purchase is needed.
References: [Vultr firewalls](https://docs.vultr.com/firewall-quickstart-for-vultr-cloud-servers),
[Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https).

## 2. Install Docker and check out the release branch

Connect to the server using the SSH user and address shown in your Vultr account.
Install Docker Engine and the Compose plugin using
[Docker's Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/).
If your Vultr image already includes Docker, check both tools first:

```bash
sudo docker version
sudo docker compose version
```

Commit and push your latest changes to `codex/imessage-vultr-launch`. On the
**Vultr server**, clone the repository and select that branch:

```bash
git clone --branch codex/imessage-vultr-launch \
  https://github.com/GauravS11112003/draw.play.git ~/draw-play
cd ~/draw-play
git log -1 --format='%h %s'
```

For a private repository, use an existing GitHub deploy key or transfer a Git
bundle of the committed branch over SSH; do not store a personal GitHub token
in the repository URL. Keep `shared/starter/dist/` in the checkout. It contains
the starter levels the API seeds on first launch. This creates a fresh server database. To carry over
your existing local games, stop the local API and migrate its complete data folder
separately before starting the server; copying just the SQLite file misses assets.

## 3. Configure and launch the website

On the **Vultr server**:

```bash
cd ~/draw-play/deploy/vultr
cp -n .env.example .env
chmod 600 .env
nano .env
```

Set `APP_DOMAIN` to your actual domain, without `https://` or a trailing slash.
Leave Photon fields blank for this first website check. Add your Anthropic key
only if you want game generation; existing starter games and races work without
it. Firefly credentials are optional. All credentials stay on the server.

```bash
sudo sh ./launch.sh
sudo docker compose ps
```

The first build downloads dependencies and can take several minutes. `api` should
be healthy and `web` running. Open these addresses, replacing the example domain:

- `https://play.your-domain.com/` — the game app.
- `https://play.your-domain.com/api/v2/health` — expect `"ok":true` and `"worker":"ok"`.
- `https://play.your-domain.com/api/v2/levels/lvl_world_l1` — should return a starter level
  after the background seed finishes. Give the first launch a little time.

Troubleshooting:

```bash
sudo docker compose logs --tail=80 api web
```

If the website cannot obtain HTTPS, check DNS, both firewalls, and whether another
program owns ports 80/443. If the build is killed for lack of memory, add swap or
use a larger server to build. Keep one API service and one messaging service for
this release; the databases are designed for a single server.

## 4. Connect Photon

Open [Photon's dashboard](https://app.photon.codes), create/select your Spectrum
project, and obtain its **project ID** and **project secret**. Set up the iMessage
connection and test recipient through the dashboard. Shared-pool numbers may vary
by recipient; dedicated lines have one stable number for your project.

Our service uses the cloud provider, which runs on Linux through Node.js and
automatically discovers project lines and renews their tokens.
[Photon cloud setup](https://photon.codes/docs/spectrum-ts/providers/imessage),
[line routing](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing).

Confirm that your plan/project supports **Spectrum launcher app cards**. Photon's
pricing places custom mini apps and dedicated lines under Business; do not assume
that all card features are included on Free. If unavailable, use the ordinary-link
mode below to send playable browser invitations through iMessage instead.
[Photon pricing](https://photon.codes/pricing).

On the server, generate a separate credential for bot-to-API requests:

```bash
openssl rand -hex 32
```

Put that generated value and your Photon credentials into `deploy/vultr/.env`:

```dotenv
SPECTRUM_PROJECT_ID=your-project-id
SPECTRUM_PROJECT_SECRET=your-project-secret
DAL_SPECTRUM_SERVICE_SECRET=your-generated-random-value
DAL_SPECTRUM_NUMBER=your-photon-number-with-country-code
DAL_SPECTRUM_DELIVERY=card
```

Keep `DAL_SPECTRUM_NUMBER` blank if Photon has not supplied a number suitable for
this setup. The website button uses this number; you can still text the race
command in your dashboard-provided Photon conversation. Do not substitute your
personal number. For browser-link delivery, set `DAL_SPECTRUM_DELIVERY=link`.
The service still responds to commands and reports results, but games open in
the browser rather than inside Messages.

Start the messaging service and apply the new environment to the API:

```bash
sudo sh ./launch.sh --profile imessage
sudo docker compose --profile imessage ps
sudo docker compose logs --tail=80 messaging
```

Expect `draw.play iMessage service is ready.` The service listens for recognized
inbound commands; it does not send unsolicited invitations. Text `help` from the
test iPhone's Photon conversation to check delivery. Restart `messaging` after
adding/changing project lines so discovery picks them up immediately:

```bash
sudo docker compose restart messaging
```

## 5. Launch on your iPhone

First check the browser game:

1. Open `https://play.your-domain.com/` in Safari. You can use cellular data; the
   phone does not need to be on the server's Wi-Fi.
2. Open a **Starter World** platformer and choose **Play with a friend**.
3. Share the invitation with a friend. They open it and enter their name.
4. Both choose **I'm ready**. Play after the countdown; both choose **Rematch**
   after the result if you want another round.

To play **inside iMessage**:

1. Both iPhone users install
   [Spectrum – Apps in Messages](https://apps.apple.com/app/id6777616651).
2. In your Photon conversation, send `race lvl_world_l1`. The bot should reply
   with a game card. Alternatively, from the website lobby choose **Start a race
   in iMessage**, if your Photon number is configured, and send the prefilled text.
3. Tap the returned card. It opens through Spectrum inside Messages. Enter your
   name to claim the first seat.
4. Share that **same card** to your friend through Spectrum's sharing flow. Your
   friend taps it, opens it inside Messages, and enters their name for the second
   seat. Sending a second `race` command creates a different match.
5. Both choose **I'm ready** and keep the game open through the countdown. Use
   the on-screen controls to race. Results appear when both finish or forfeit.
6. Both choose **Rematch** to race again in the same lobby.

Photon documents the one-time launcher installation and in-conversation card
opening in [its app-card guide](https://photon.codes/docs/spectrum-ts/content/app).
An ordinary URL opens in the browser; installing Spectrum does not automatically
turn ordinary URLs into native app cards. Android users can play through browser
invitations, but cannot use Apple's iMessage launcher.

The iMessage command creates a fresh two-seat match. A host seat claimed in Safari
does not transfer automatically into Messages. Claim both seats inside the app
card. Results return to the bot conversation that requested the card; a friend
who only receives a forwarded card sees the result in the game.

The initial mode supports faithful platformer races. Generated Imagine games
still need their own multiplayer adapters. Two real iPhones must be tested for
launcher opening, touch controls, background/reopening, reconnecting, and rematches
before calling the in-Messages flow verified.

## Updates and saved data

Push committed updates to the release branch, then on the server:

```bash
cd ~/draw-play
git pull --ff-only origin codex/imessage-vultr-launch
cd deploy/vultr
sudo sh ./launch.sh --profile imessage
```

This preserves the named volumes. If you have not enabled Photon, omit
`--profile imessage`. Updates can interrupt active races, so apply them between
games. Do not use `docker compose down -v`: it deletes the saved volumes.

`launch.sh` refuses uncommitted changes and labels every image with the branch
and exact commit. To check what the running website actually hosts:

```bash
docker inspect "$(docker compose ps -q web)" --format \
  '{{index .Config.Labels "org.opencontainers.image.ref.name"}} {{index .Config.Labels "org.opencontainers.image.revision"}}'
```

Before an important update, make a consistent backup while the writers are stopped:

```bash
mkdir -p backups
chmod 700 backups
sudo docker compose stop api messaging
sudo docker compose run --rm --no-deps --entrypoint tar api -czf - -C /data . > backups/games.tar.gz
sudo docker compose --profile imessage run --rm --no-deps --entrypoint tar messaging -czf - -C /data . > backups/messaging.tar.gz
sudo docker compose --profile imessage up -d
chmod 600 backups/*.tar.gz
```

Use only the API backup and omit messaging from stop/start if it is not enabled.
Keep a copy of the backups somewhere outside the server. Keep the server `.env`
separately in your password manager so it can be restored too.
