<div align="center">

<img src="docs/assets/hero.jpg" alt="The Game Factory home screen: 'What would you play?' prompt box with idea cards" width="100%">

# The Game Factory

**Dream up a world. We'll help you make it playable.**

Describe a game, sketch your level, and get a game you can play in the browser and share with friends.

![TypeScript](https://img.shields.io/badge/TypeScript-Vite-3178C6?logo=typescript&logoColor=white)
![Python](https://img.shields.io/badge/Python-FastAPI-009688?logo=fastapi&logoColor=white)
![Claude](https://img.shields.io/badge/AI-Claude-D97757?logo=anthropic&logoColor=white)
![Phaser](https://img.shields.io/badge/Engine-Phaser-8B5CF6)

</div>

---

## How it works

<table>
<tr>
<td width="50%" valign="top">

### 1. Describe it ✏️
Pick a genre, write your idea, and sketch the world if you like. **Black** ink becomes ground, **red** becomes spikes and enemies, **blue** becomes coins, and **green** becomes the goal.

</td>
<td width="50%"><img src="docs/assets/idea-desk.jpg" alt="Idea desk with a written prompt and a sketched level"></td>
</tr>
<tr>
<td width="50%"><img src="docs/assets/agents.jpg" alt="Agents building the game"></td>
<td width="50%" valign="top">

### 2. Watch it build 🤖
A team of agents designs the UI, physics, and graphics, then saves your game. Turn on **Better graphics** for richer art, or **Multiplayer** to play with a friend on separate phones.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 3. Play & share 🎮
Play right away, then refine the game in chat, add levels, remix it, or send it to a friend. You can also race over iMessage.

</td>
<td width="50%"><img src="docs/assets/gameplay.gif" alt="Super Jump gameplay"></td>
</tr>
</table>

## The arcade

Start with six built-in games: **Pocket Brawl**, **Pac-Man**, **Super Jump**, **Hill Climb**, **Pac-Man Neon**, and **Breach Point**. Each one runs on phones and desktops.

<img src="docs/assets/arcade.jpg" alt="The arcade: six playable games" width="100%">

---

## Quick start

**You need:** [Node.js 24+](https://nodejs.org), [Python 3.11+](https://www.python.org), and [uv](https://docs.astral.sh/uv/).

```bash
# 1. Install dependencies
(cd vision && uv sync)
(cd web && npm ci)

# 2. Add your Claude API key
cp .env.example .env        # then set ANTHROPIC_API_KEY in .env

# 3. Run the app
bash scripts/dev.sh
```

**4. Open [localhost:5173](http://localhost:5173)** 🎉

> [!TIP]
> - **Play on your phone:** the startup output prints a LAN address. Open it on any phone on the same Wi-Fi.
> - **No API key?** The arcade and the sketch-to-platformer builder still work. Only AI game generation needs the key.
> - **Is the API up?** Check [localhost:8000/api/v2/health](http://localhost:8000/api/v2/health).

Optional settings for Auth0 sign-in, Firefly art, and iMessage play are documented in [`.env.example`](.env.example).

## Tests

```bash
(cd web && npm run typecheck && npm test && npm run build)
(cd vision && uv run pytest)
```

## What's inside

| Folder | What it does |
| --- | --- |
| [`web/`](web) | TypeScript + Vite frontend, arcade games, Phaser platformer engine, and sketch editor |
| [`vision/`](vision) | Python + FastAPI backend, Claude game generation, paper-scan pipeline, and SQLite storage |
| [`shared/`](shared) | Schemas, starter levels, and art packs |
| [`messaging/`](messaging) | Optional iMessage service (Photon Spectrum) |
| [`deploy/vultr/`](deploy/vultr) | Docker Compose + Caddy production deploy |

Generated games run in an isolated browser sandbox.

**More guides:** [Deploying](docs/vultr-launch.md) · [Multiplayer](docs/generated-multiplayer.md) · [iMessage races](docs/imessage.md) · [Level format](docs/spec/level-format-v2.md)

## Team

Built by **Pranay Joshi**, **Gaurav Shrivastava**, and **Kavya Gupta**.
