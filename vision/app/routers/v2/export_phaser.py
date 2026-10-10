"""Export to Phaser (docs/v3/CONTRACTS_V3.md, lane 7): any game as a standalone Phaser 3 project.

GET /games/{id}/export/phaser → `<slug>-phaser.zip`, built in memory:

    <slug>-phaser/
      README.md, CREDITS.md       how to run, host and keep coding; every author, art credit and helper
      game.json                   title, rules, credits and the levels in play order (LevelV2 with skins)
      assets/                     every image the levels reference (/uploads/… rewritten to relative paths)
      dist/                       the prebuilt player (web/dist-export) + game.json + assets/: host it as it is
      index.html, package.json, vite.config.js, tsconfig.json, .gitignore, .github/workflows/pages.yml
      src/main.ts                 the bootstrap (web/src/export/main.ts): how the game is loaded, how to extend it
      src/export/                 the player: title screen, level select, results, credits
      src/engine, src/core, …     the engine (the Phaser 3 scene) and the deterministic sim, as source
      shared/spec/messages.json   the sentences the engine draws

The source files are the player's import graph (web/src/export/main.ts and everything it imports, type-only
imports included); imports reaching outside src/ are rewritten for the new layout.

web/dist-export is rebuilt with `vite build --config vite.export.config.ts` (one build at a time) when it is missing
or older than any of those sources. Without Node: 503 {message_key: "export.node_missing"} (a stale build is still
used when there is one). A game with no playable levels: 409 "export.no_levels".
"""
from __future__ import annotations

import asyncio
import glob
import html
import importlib
import json
import logging
import os
import posixpath
import re
import shutil
import time
import zipfile
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse, Response

from app import db_v2
from app.config import PROJECT_ROOT, get_settings
from app.routers.v2 import games as games_api
from app.routers.v2 import transfer

log = logging.getLogger("dal.v2.export_phaser")
router = APIRouter()

WEB_DIR = PROJECT_ROOT / "web"
DIST_DIR = WEB_DIR / "dist-export"
BUILD_CONFIG = "vite.export.config.ts"
ENTRY = "src/export/main.ts"
ENTRY_HTML = "export.html"
STAMP = ".drawplay-build"
BUILD_TIMEOUT_S = 300.0
FORMAT = "drawplay-game"
FORMAT_V = 1
DEFAULT_LICENSE = "CC-BY-4.0"
TOOLS = {"firefly": "Adobe Firefly", "claude-svg": "Claude"}
STORED = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".woff", ".woff2", ".zip"}
SOURCE_EXT = (".ts", ".tsx", ".js", ".mjs")

_build_lock = asyncio.Lock()


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _slug(title: str | None, fallback: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (title or "").lower()).strip("-")[:40].strip("-")
    return s or re.sub(r"[^a-z0-9]+", "-", fallback.lower()).strip("-") or "game"


# ---- the player's sources (import graph) ----------------------------------------------------------------------------

_IMPORT = re.compile(r"""(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\bnew\s+URL\(\s*)(['"])(\.{1,2}/[^'"\n]+)\2""")


def _allowed(rel: str) -> bool:
    if "__tests__" in rel or re.search(r"\.(test|spec)\.[tj]s$", rel):
        return False
    return rel.startswith("src/") or rel.startswith("../shared/")


def _resolve(base: str, spec: str) -> str | None:
    """A relative import (from a web-relative directory) as a web-relative file path, or None."""
    joined = posixpath.normpath(posixpath.join(base, spec.split("?", 1)[0]))
    for cand in (joined, f"{joined}.ts", f"{joined}/index.ts", f"{joined}.js"):
        if _allowed(cand) and (WEB_DIR / cand).is_file():
            return cand
    return None


def _source_graph() -> list[str]:
    """Every file the player imports, transitively (web-relative paths, e.g. 'src/engine/index.ts')."""
    seen: set[str] = set()
    stack = [ENTRY]
    while stack:
        rel = stack.pop()
        if rel in seen or not (WEB_DIR / rel).is_file():
            continue
        seen.add(rel)
        if not rel.endswith(SOURCE_EXT):
            continue
        try:
            text = (WEB_DIR / rel).read_text("utf-8", errors="replace")
        except OSError:
            continue
        base = posixpath.dirname(rel)
        for m in _IMPORT.finditer(text):
            t = _resolve(base, m.group(3))
            if t and t not in seen:
                stack.append(t)
    return sorted(seen)


def _zip_src_path(rel: str) -> str | None:
    """Where a web-relative source lives in the exported project."""
    if rel == ENTRY:
        return "src/main.ts"
    if rel.startswith("src/"):
        return rel
    if rel.startswith("../shared/"):
        return rel[len("../"):]
    return None


def _rewrite_imports(rel: str, text: str) -> str:
    """Point relative imports at the new layout (src/main.ts moved up, ../../../shared → ../../shared)."""
    zpath = _zip_src_path(rel)
    if zpath is None:
        return text
    base_web, base_zip = posixpath.dirname(rel), posixpath.dirname(zpath)

    def fix(m: re.Match[str]) -> str:
        spec = m.group(3)
        target = _resolve(base_web, spec)
        tz = _zip_src_path(target) if target else None
        if not tz or posixpath.normpath(posixpath.join(base_zip, spec)) == tz:
            return m.group(0)
        new = posixpath.relpath(tz, base_zip or ".")
        if not new.startswith("."):
            new = f"./{new}"
        return f"{m.group(1)}{m.group(2)}{new}{m.group(2)}"

    return _IMPORT.sub(fix, text)


# ---- the prebuilt player (web/dist-export) ---------------------------------------------------------------------------


def _built_at() -> float | None:
    for name in (STAMP, "index.html"):
        p = DIST_DIR / name
        if p.is_file():
            return p.stat().st_mtime
    return None


def _dist_fresh(graph: list[str]) -> bool:
    if not (DIST_DIR / "index.html").is_file():
        return False
    built = _built_at()
    if built is None:
        return False
    deps = [WEB_DIR / r for r in graph] + [WEB_DIR / ENTRY_HTML, WEB_DIR / BUILD_CONFIG, WEB_DIR / "package.json"]
    for p in deps:
        try:
            if p.stat().st_mtime > built:
                return False
        except OSError:
            continue
    return True


def _node() -> str | None:
    cands = [os.environ.get("DAL_NODE"), shutil.which("node"), "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
    cands += sorted(glob.glob(os.path.expanduser("~/.nvm/versions/node/*/bin/node")), reverse=True)
    cands += sorted(glob.glob(os.path.expanduser("~/.volta/bin/node")))
    for c in cands:
        if c and os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


def _build_cmd() -> tuple[list[str], dict[str, str]] | None:
    env = dict(os.environ)
    vite_js = WEB_DIR / "node_modules" / "vite" / "bin" / "vite.js"
    node = _node()
    if node and vite_js.is_file():
        env["PATH"] = os.pathsep.join([str(Path(node).parent), env.get("PATH", "")])
        return [node, str(vite_js), "build", "--config", BUILD_CONFIG, "--logLevel", "warn"], env
    npx = shutil.which("npx")
    if npx and node:
        env["PATH"] = os.pathsep.join([str(Path(node).parent), env.get("PATH", "")])
        return [npx, "--no-install", "vite", "build", "--config", BUILD_CONFIG, "--logLevel", "warn"], env
    return None


async def _ensure_dist(graph: list[str]) -> str | None:
    """Rebuild web/dist-export when stale. Call with _build_lock held. Returns a message key when it could not."""
    if _dist_fresh(graph):
        return None
    cmd = _build_cmd()
    if cmd is None:
        log.warning("export: node/vite not found; cannot build %s", DIST_DIR)
        return "export.node_missing"
    args, env = cmd
    started = time.time()
    log.info("export: building the Phaser player (%s)", " ".join(args[1:]))
    try:
        proc = await asyncio.create_subprocess_exec(*args, cwd=str(WEB_DIR), env=env,
                                                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    except OSError as e:
        log.warning("export: could not start the build: %s", e)
        return "export.node_missing"
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), BUILD_TIMEOUT_S)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        log.warning("export: the player build timed out")
        return "export.build_failed"
    if proc.returncode != 0 or not (DIST_DIR / "index.html").is_file():
        log.warning("export: the player build failed (%s):\n%s", proc.returncode, (out or b"").decode("utf-8", "replace")[-4000:])
        return "export.build_failed"
    stamp = DIST_DIR / STAMP
    stamp.write_text(f"built {time.strftime('%Y-%m-%dT%H:%M:%S', time.localtime(started))}\n", "utf-8")
    os.utime(stamp, (started, started))  # sources edited while it built count as newer
    log.info("export: player built in %.1f s", time.time() - started)
    return None


def _dist_files() -> list[tuple[str, Path]]:
    out = []
    for p in sorted(DIST_DIR.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(DIST_DIR).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        out.append((rel, p))
    return out


# ---- the game: levels, assets, credits ------------------------------------------------------------------------------


def _game_levels(game_id: str) -> list[dict[str, Any]]:
    """The playable sequence, in order: {id, title, author, unlock_after, bonus, level} (level = an export copy)."""
    rows = db_v2.latest_level_summaries(game_id=game_id, listed_only=True)
    seq, _ = games_api._sequence(rows)
    unlocks = games_api._unlocks(game_id)
    out = []
    for s in seq:
        row = db_v2.get_level_row(s["id"])
        if row is None or row.get("level") is None or row.get("safety") in ("held", "flag"):
            continue
        level = transfer._export_level_doc(row)
        level.pop("ink_ref", None)
        meta = games_api._with_unlock({"id": s["id"]}, unlocks, level)
        out.append({"id": level.get("id") or s["id"], "title": level.get("title") or "", "author": level.get("author") or "",
                    "unlock_after": meta.get("unlock_after"), "bonus": bool(meta.get("bonus")), "level": level})
    # an unlock that points outside the exported set would lock a level forever
    ids = {e["id"] for e in out}
    for e in out:
        if e["unlock_after"] not in ids:
            e["unlock_after"] = None
    return out


_SEG = re.compile(r"[^A-Za-z0-9._-]+")
_ABS = re.compile(r"^https?://[^/]+(/.*)$")


class Assets:
    """Copies every /uploads file a level references into assets/ and rewrites the level to the relative path."""

    def __init__(self) -> None:
        s = get_settings()
        self.prefix = s.public_uploads.rstrip("/") + "/"
        self.by_file: dict[Path, str] = {}
        self.names: set[str] = set()
        self.missing: set[str] = set()

    def _local(self, url: str) -> tuple[str, Path] | None:
        u = url.strip()
        m = _ABS.match(u)
        if m and m.group(1).startswith(self.prefix):
            u = m.group(1)
        if not u.startswith(self.prefix):
            return None
        p = transfer._upload_path(u)
        if p is None:
            self.missing.add(url)
            return None
        return u[len(self.prefix):].split("?", 1)[0].split("#", 1)[0], p

    def _name(self, rel: str, path: Path) -> str:
        if path in self.by_file:
            return self.by_file[path]
        segs = [_SEG.sub("_", s) for s in rel.split("/") if s not in ("", ".", "..")]
        segs = [s for s in segs if s.strip("._")] or [path.name]
        name = "assets/" + "/".join(segs)
        stem, dot, ext = name.rpartition(".")
        n = 2
        while name in self.names:
            name = f"{stem}-{n}.{ext}" if dot else f"{name}-{n}"
            n += 1
        self.names.add(name)
        self.by_file[path] = name
        return name

    def rewrite(self, x: Any) -> Any:
        if isinstance(x, dict):
            return {k: self.rewrite(v) for k, v in x.items()}
        if isinstance(x, list):
            return [self.rewrite(v) for v in x]
        if isinstance(x, str) and ("/" in x) and len(x) < 2048:
            hit = self._local(x)
            if hit is not None:
                return self._name(*hit)
        return x

    def files(self) -> list[tuple[str, Path]]:
        return sorted(((name, p) for p, name in self.by_file.items()), key=lambda t: t[0])


def _n(x: Any) -> int:
    if isinstance(x, bool):
        return int(x)
    if isinstance(x, (int, float)):
        return int(x)
    if isinstance(x, (list, tuple, dict)):
        return len(x)
    return 0


def _collab_credits(game_id: str) -> dict[str, Any] | None:
    """app.collab's credits for the game ({contributors, authors}), when collaboration is installed."""
    try:
        mod = importlib.import_module("app.collab.activity")
    except Exception:  # noqa: BLE001 - collaboration is optional
        return None
    fn = getattr(mod, "game_credits", None)
    if not callable(fn):
        return None
    try:
        res = fn(game_id)
        return res if isinstance(res, dict) else None
    except Exception:  # noqa: BLE001
        log.info("export: collab credits unavailable for %s", game_id, exc_info=True)
        return None


def _credits(g: dict[str, Any], entries: list[dict[str, Any]], collab: dict[str, Any] | None) -> dict[str, Any]:
    authors: list[str] = []

    def add(name: Any) -> None:
        n = str(name or "").strip()
        if n and n not in authors:
            authors.append(n)

    add(g.get("author"))
    levels, art, library = [], [], []
    seen_art: set[tuple[str, str, str]] = set()
    seen_lib: set[tuple[str, str]] = set()
    for i, e in enumerate(entries):
        lv = e["level"]
        add(lv.get("author"))
        levels.append({"index": i + 1, "id": lv.get("id"), "title": lv.get("title") or "", "author": lv.get("author") or "",
                       "license": lv.get("license") or DEFAULT_LICENSE})
        skin = lv.get("skin") if isinstance(lv.get("skin"), dict) else {}
        pieces: list[tuple[str, Any]] = []
        bd = skin.get("backdrop")
        if isinstance(bd, dict) and bd.get("url"):
            pieces.append(("Backdrop", bd.get("credit")))
        for ob in skin.get("objects") or []:
            if isinstance(ob, dict) and ob.get("url") and (ob.get("mode") or "life") == "life":
                pieces.append((str(ob.get("label") or ""), ob.get("credit")))
        for label, cr in pieces:
            cr = cr if isinstance(cr, dict) else {}
            by = str(cr.get("by") or lv.get("author") or "").strip()
            tool = cr.get("tool") or TOOLS.get(str(skin.get("provider") or ""))
            key = (by.lower(), str(tool or "").lower(), label.lower())
            if not by or key in seen_art:
                continue
            seen_art.add(key)
            art.append({"by": by, "tool": tool, "label": label or None, "level": lv.get("title") or None,
                        "prompt": cr.get("prompt") or None})
        for t in lv.get("embedded_library") or []:
            if not isinstance(t, dict) or not t.get("name"):
                continue
            k = (str(t.get("id") or t["name"]), str(t.get("author") or ""))
            if k in seen_lib:
                continue
            seen_lib.add(k)
            library.append({"name": t["name"], "author": t.get("author") or "", "kind": t.get("kind")})
    contributors = []
    for c in (collab or {}).get("contributors") or []:
        if not isinstance(c, dict):
            continue
        p = c.get("player") if isinstance(c.get("player"), dict) else {}
        name = str(p.get("name") or c.get("name") or "").strip()
        if not name:
            continue
        contributors.append({"name": name, "role": c.get("role"), "levels": _n(c.get("levels")),
                             "creatures": _n(c.get("creatures")), "art": _n(c.get("art")), "quests": _n(c.get("quests")),
                             "reviews": _n(c.get("reviews"))})
    return {"authors": authors, "levels": levels, "art": art, "library": library, "contributors": contributors}


def _game_doc(g: dict[str, Any], entries: list[dict[str, Any]], collab: dict[str, Any] | None,
              assets: Assets) -> dict[str, Any]:
    levels = [{**e, "level": assets.rewrite(e["level"])} for e in entries]
    return {
        "format": FORMAT, "v": FORMAT_V, "exported_at": db_v2.now_iso(),
        "game": {"id": g["id"], "title": g.get("title") or "", "author": g.get("author") or "",
                 "created_at": g.get("created_at")},
        "rules": assets.rewrite(g.get("rules")) if g.get("rules") else None,
        "levels": levels,
        "credits": _credits(g, entries, collab),
    }


# ---- the project skeleton -------------------------------------------------------------------------------------------


def _web_json(name: str) -> dict[str, Any]:
    try:
        j = json.loads((WEB_DIR / name).read_text("utf-8"))
        return j if isinstance(j, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _package_json(slug: str, title: str) -> str:
    web = _web_json("package.json")
    deps = {**(web.get("dependencies") or {}), **(web.get("devDependencies") or {})}
    pj = {
        "name": slug,
        "private": True,
        "version": "1.0.0",
        "type": "module",
        "description": f"{title}: a platformer drawn in draw.play, exported as a Phaser 3 project.",
        "scripts": {
            "dev": "vite --host",
            "build": "vite build",
            "preview": "vite preview --host",
            "typecheck": "tsc --noEmit",
        },
        "dependencies": {"phaser": deps.get("phaser", "^3.90.0")},
        "devDependencies": {"@types/node": deps.get("@types/node", "^24.0.0"), "typescript": deps.get("typescript", "^5.9.0"),
                            "vite": deps.get("vite", "^7.0.0")},
    }
    return json.dumps(pj, indent=2) + "\n"


def _tsconfig() -> str:
    tc = _web_json("tsconfig.json")
    opts = tc.get("compilerOptions") if isinstance(tc.get("compilerOptions"), dict) else None
    if not opts:
        opts = {"target": "ES2022", "module": "ESNext", "moduleResolution": "bundler", "lib": ["ES2022", "DOM", "DOM.Iterable"],
                "strict": True, "resolveJsonModule": True, "esModuleInterop": True, "isolatedModules": True,
                "allowImportingTsExtensions": True, "skipLibCheck": True, "noEmit": True, "types": ["vite/client"]}
    return json.dumps({"compilerOptions": opts, "include": ["src"]}, indent=2) + "\n"


VITE_CONFIG = """\
// Vite config for this Phaser 3 project. `npm run dev` serves index.html + src/ with live reload; game.json and
// assets/ sit next to index.html and are served as they are. `npm run build` writes dist/ (relative URLs, so it
// works from any folder or sub-path) and copies game.json and assets/ into it.
import { cpSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

function gameData() {
  return {
    name: 'game-data',
    apply: 'build',
    closeBundle() {
      cpSync(resolve(root, 'game.json'), resolve(root, 'dist', 'game.json'));
      if (existsSync(resolve(root, 'assets'))) cpSync(resolve(root, 'assets'), resolve(root, 'dist', 'assets'), { recursive: true });
    },
  };
}

export default defineConfig({
  base: './',
  server: { host: true, port: 5173 },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'player',
    chunkSizeWarningLimit: 4096,
  },
  plugins: [gameData()],
});
"""

GITIGNORE = "node_modules/\n.DS_Store\n"

PAGES_WORKFLOW = """\
# Publish this game on GitHub Pages: push to main, then Settings → Pages → Source: "GitHub Actions".
name: Deploy to GitHub Pages
on:
  push:
    branches: [main]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist
      - id: deployment
        uses: actions/deploy-pages@v4
"""


def _index_html(title: str, *, built: str | None = None) -> str:
    """The project's index.html (from web/export.html) or, with `built`, the prebuilt dist/index.html, titled."""
    src = built
    if src is None:
        try:
            src = (WEB_DIR / ENTRY_HTML).read_text("utf-8")
        except OSError:
            src = ('<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="utf-8" />\n'
                   '    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />\n'
                   '    <title>draw.play game</title>\n  </head>\n  <body>\n    <div id="app"></div>\n'
                   '    <script type="module" src="/src/export/main.ts"></script>\n  </body>\n</html>\n')
        src = src.replace("/src/export/main.ts", "/src/main.ts")
    return re.sub(r"<title>.*?</title>", f"<title>{html.escape(title)}</title>", src, count=1, flags=re.S)


def _md(s: Any) -> str:
    return re.sub(r"([\\`*_\[\]<>|#])", r"\\\1", str(s or "").strip())


def _readme(title: str, author: str, slug: str, n_levels: int, n_assets: int) -> str:
    by = f" by {_md(author)}" if author else ""
    return f"""# {_md(title)}

A platformer{by}, drawn in **draw.play** and exported as a standalone **Phaser 3** project:
{n_levels} level{'s' if n_levels != 1 else ''}, {n_assets} image{'s' if n_assets != 1 else ''}, no server needed.

## Play it now (no install)

`dist/` is the finished game. It needs a web server (browsers don't run game code from a double-clicked file):

```sh
npx serve dist                         # Node
python3 -m http.server -d dist 8080    # or Python, then open http://localhost:8080
```

Controls: ← → (or A D) to move, Space / ↑ / Z / W to jump, X or Shift to run, ↓ to drop, R to go back to the last
checkpoint, P or Esc to pause, M to mute. Phones and tablets get touch buttons (hold the device sideways).

## Keep coding

```sh
npm install
npm run dev        # http://localhost:5173 with live reload
npm run build      # rebuild dist/ from src/
```

| Where | What |
|---|---|
| `src/main.ts` | The bootstrap: loads `game.json` and starts the player. Hooks for level start / clear / game clear. |
| `src/export/player.ts` | Title screen, level select, results card, credits. |
| `src/engine/` | The Phaser 3 side: `index.ts` (`mountGame`), `scene.ts` (the scene), `views/` (player, enemies, HUD…). |
| `src/core/` | The deterministic simulation (physics, enemies, coins) the scene steps at 60 Hz. |
| `src/render/`, `src/audio/` | The paper look, the ink renderer, sounds and music. |
| `game.json` | The game: title, rules, credits, and every level (`levels[].level` is a full `dal-level` JSON). |
| `assets/` | Images the levels use (art skins, backdrops, sprites, sheet photos). |

Ideas: change the game's theme in `game.json` → `rules.theme` (`sketchbook`, `notebook`, `graph`, `kraft`),
give every level 3 lives with `transformLevel` in `src/main.ts`, reorder or remove levels in `game.json`,
open every level at once with `unlockAll: true`, or jump to one level with `?level=2` in the URL.
`npm run typecheck` checks the TypeScript.

## Put it online

**itch.io**
1. Zip the *contents* of `dist/` (so `index.html` is at the top of the zip).
2. On itch.io: *Create new project* → Kind of project: **HTML** → upload the zip →
   tick **This file will be played in the browser**.
3. Embed options: viewport **960 × 540**, tick **Mobile friendly** (landscape) and **Fullscreen button**.

**GitHub Pages**
1. Push this folder to a GitHub repository (branch `main`).
2. Settings → Pages → Source: **GitHub Actions**. `.github/workflows/pages.yml` builds and publishes `dist/`.
   (No Actions? Copy what is inside `dist/` into a repository's root or `docs/` folder and publish that branch.)

**Anywhere else** (Netlify, Vercel, your own server): upload `dist/` as it is. All paths are relative.

Progress (cleared levels, best times) is saved in each player's browser.

## Credits

See [CREDITS.md](CREDITS.md). The levels are shared under Creative Commons Attribution (CC BY 4.0): when you share
or remix this game, keep the credits. Phaser is MIT licensed (https://phaser.io).
"""


def _credits_md(doc: dict[str, Any], has_fonts: bool) -> str:
    g, c = doc["game"], doc["credits"]
    lines = [f"# Credits: {_md(g['title'] or 'My game')}", ""]
    if g.get("author"):
        lines += [f"A game by **{_md(g['author'])}**, made with draw.play.", ""]
    lines += ["## Levels", ""]
    for lv in c["levels"]:
        lines.append(f"{lv['index']}. **{_md(lv['title'] or 'A level')}** by {_md(lv['author'] or 'someone')}"
                     f" ({_md(lv.get('license') or DEFAULT_LICENSE)})")
    lines.append("")
    if c["art"]:
        lines += ["## Art", ""]
        for a in c["art"]:
            what = f"**{_md(a['label'])}**" if a.get("label") else "Art"
            tool = f", made with {_md(a['tool'])}" if a.get("tool") else ""
            where = f" (level \"{_md(a['level'])}\")" if a.get("level") else ""
            lines.append(f"- {what} by {_md(a['by'])}{tool}{where}")
            if a.get("prompt"):
                lines.append(f"  - prompt: {_md(str(a['prompt'])[:300])}")
        lines.append("")
    if c["library"]:
        lines += ["## Creatures and objects", ""]
        for t in c["library"]:
            kind = f" ({_md(t['kind'])})" if t.get("kind") else ""
            who = f" by {_md(t['author'])}" if t.get("author") else ""
            lines.append(f"- **{_md(t['name'])}**{kind}{who}")
        lines.append("")
    if c["contributors"]:
        lines += ["## Helpers", ""]
        for p in c["contributors"]:
            bits = [f"{p[k]} {label}" for k, label in (("levels", "levels"), ("creatures", "creatures"), ("art", "art"),
                                                       ("quests", "quests"), ("reviews", "reviews")) if p.get(k)]
            role = f" ({_md(p['role'])})" if p.get("role") else ""
            lines.append(f"- {_md(p['name'])}{role}" + (f": {', '.join(bits)}" if bits else ""))
        lines.append("")
    if c["authors"]:
        lines += ["## Everyone who made a level", "", ", ".join(_md(a) for a in c["authors"]), ""]
    licenses = sorted({lv.get("license") or DEFAULT_LICENSE for lv in c["levels"]})
    lines += ["## License", "",
              f"The levels and their art are shared under {', '.join(_md(x) for x in licenses)}: share and remix them, "
              "and keep these names with them.", "",
              "## Software", "",
              "- draw.play engine and player (`src/`), the paper renderer and the deterministic simulation.",
              "- [Phaser 3](https://phaser.io) by Phaser Studio Inc., MIT License."]
    if has_fonts:
        lines.append("- Patrick Hand font by Patrick Wagesreiter, SIL Open Font License.")
    lines.append("")
    return "\n".join(lines)


# ---- the zip ---------------------------------------------------------------------------------------------------------


def _write(z: zipfile.ZipFile, name: str, data: bytes | str) -> None:
    raw = data.encode("utf-8") if isinstance(data, str) else data
    ext = posixpath.splitext(name)[1].lower()
    info = zipfile.ZipInfo(name, date_time=time.localtime()[:6])
    info.external_attr = 0o644 << 16  # rw-r--r-- once unzipped
    info.compress_type = zipfile.ZIP_STORED if ext in STORED else zipfile.ZIP_DEFLATED
    z.writestr(info, raw)


def _build_zip(g: dict[str, Any], entries: list[dict[str, Any]], collab: dict[str, Any] | None,
               graph: list[str]) -> tuple[bytes, str]:
    title = str(g.get("title") or "").strip() or "My game"
    slug = f"{_slug(title, str(g['id']))}-phaser"
    assets = Assets()
    doc = _game_doc(g, entries, collab, assets)
    if assets.missing:
        log.info("export %s: %d referenced files not on this server", g["id"], len(assets.missing))
    game_json = json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n"
    files = assets.files()
    dist = _dist_files()
    has_fonts = any(rel.startswith("fonts/") for rel, _ in dist)

    buf = BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        r = f"{slug}/"
        _write(z, f"{r}README.md", _readme(title, str(g.get("author") or ""), slug, len(entries), len(files)))
        _write(z, f"{r}CREDITS.md", _credits_md(doc, has_fonts))
        _write(z, f"{r}game.json", game_json)
        _write(z, f"{r}package.json", _package_json(slug, title))
        _write(z, f"{r}vite.config.js", VITE_CONFIG)
        _write(z, f"{r}tsconfig.json", _tsconfig())
        _write(z, f"{r}index.html", _index_html(title))
        _write(z, f"{r}.gitignore", GITIGNORE)
        _write(z, f"{r}.github/workflows/pages.yml", PAGES_WORKFLOW)
        # the player and engine sources
        for rel in graph:
            zp = _zip_src_path(rel)
            if zp is None:
                continue
            p = WEB_DIR / rel
            try:
                if rel.endswith(SOURCE_EXT):
                    _write(z, f"{r}{zp}", _rewrite_imports(rel, p.read_text("utf-8")))
                else:
                    _write(z, f"{r}{zp}", p.read_bytes())
            except OSError as e:
                log.info("export: source %s skipped (%s)", rel, e)
        # the images, at the top and inside dist/
        for name, p in files:
            try:
                data = p.read_bytes()
            except OSError as e:
                log.info("export: asset %s skipped (%s)", p, e)
                continue
            _write(z, f"{r}{name}", data)
            _write(z, f"{r}dist/{name}", data)
        # the prebuilt player
        for rel, p in dist:
            if rel == "game.json" or rel.startswith("assets/"):
                continue
            data = p.read_bytes()
            if rel == "index.html":
                data = _index_html(title, built=data.decode("utf-8", "replace")).encode("utf-8")
            _write(z, f"{r}dist/{rel}", data)
        _write(z, f"{r}dist/game.json", game_json)
    return buf.getvalue(), f"{slug}.zip"


@router.get("/games/{game_id}/export/phaser")
async def export_phaser(game_id: str) -> Any:
    if not transfer._ID.match(game_id):
        return err(404, "error.not_found", {"what": "game"})
    g = await asyncio.to_thread(db_v2.get_game, game_id)
    if g is None or g.get("format") != 2:
        return err(404, "error.not_found", {"what": "game"})
    entries = await asyncio.to_thread(_game_levels, game_id)
    if not entries:
        return err(409, "export.no_levels")
    collab = await asyncio.to_thread(_collab_credits, game_id)
    async with _build_lock:
        graph = await asyncio.to_thread(_source_graph)
        key = await _ensure_dist(graph)
        if key is not None:
            if not (DIST_DIR / "index.html").is_file():
                return err(503, key)
            log.warning("export %s: using the existing player build (%s)", game_id, key)
        try:
            data, filename = await asyncio.to_thread(_build_zip, g, entries, collab, graph)
        except Exception:  # noqa: BLE001
            log.exception("export %s: packing the zip failed", game_id)
            return err(500, "export.build_failed")
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store"}
    if key is not None:
        headers["X-Drawplay-Player"] = "stale"
    return Response(content=data, media_type="application/zip", headers=headers)
