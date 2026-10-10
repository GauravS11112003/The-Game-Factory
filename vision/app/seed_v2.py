"""Seed the v2 games (PLAN_V2 §9 "Seed games"). Idempotent; runs at boot after the v1 migration.

- **Classic Starter** (`game_classic`): the v1 Starter World levels migrated under `v1-classic`. The core's own
  migration of the three v1 levels is in `shared/starter/dist/classic/` (listed by `dist/index.json`, v1 ids kept);
  those files win over the boot migration's `json_v2` and a changed hash is published as a new version. The v1
  remixes (maya, sam) come from the boot migration and hang under their parents.
- **Starter World** (`game_world`): the levels `shared/starter/dist/index.json` lists for `game_world` (built by lane
  B's `starter:build` with `tier: faithful`), in order L1..L5. When a dist file changes (a new `level_hash`), the next
  boot publishes it as a new version, so the gallery always shows the current build. A level a seed put in the game
  that the index no longer lists is unlisted and taken out of the game (never deleted). L5 is the bonus level that unlocks after L4
  (`unlock_after` in the index; exposed per level by `sequence_meta()` for GET /games/{id}).
- Without `index.json` (an older starter build), every `dist/*.level.json` is Starter World, in file-name order.
- **The remix chain under L1**:
    "Doodle Meadow (Challenging)" by maya: L1 rebuilt by the designer at Challenging·Normal, designer ink visible
    (the dial showcase on day one);
    "Doodle Meadow speedrun" by sam: maya's level with a timer of ≈ 1.5 × the bot's fastest time.
  Both are built by the core worker and kept only when the bot can finish them. A failed attempt for a given L1 hash
  is remembered (data/seed_v2.json) so a reload loop never rebuilds it again and again.
"""
from __future__ import annotations

import copy
import json
import logging
import math
import re
from pathlib import Path
from typing import Any, Callable

from app import db_v2
from app.build import levels_io, present
from app.build.bridge import CoreError, CorePool, get_pool
from app.config import SHARED_DIR, get_settings
from app.spec.level import level_hash
from app.spec.rules import GameRules

log = logging.getLogger("dal.v2.seed")

CLASSIC_GAME = "game_classic"
WORLD_GAME = "game_world"
V1_STARTER_GAME = "game_starter"
TEAM = "team"
DIST = SHARED_DIR / "starter" / "dist"
WORLD_CREATED = "2026-10-10T00:00:00Z"
CLASSIC_CREATED = "2026-10-09T00:00:00Z"
MAYA_ID = "lvl_world_l1_maya"
SAM_ID = "lvl_world_l1_sam"
BUILD_TIMEOUT_S = 20.0
TIMER_K = 1.5
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
STARTER_NAMES = ["Doodle Meadow", "Spike Garden", "Crumble Cliffs", "Keyhole Castle", "Ink Gauntlet"]
SEED_AUTHORS = frozenset({TEAM, "Starter World"})  # who the seeded sequence levels are by


def _marker_path() -> Path:
    return get_settings().data_dir / "seed_v2.json"


def _marker() -> dict[str, Any]:
    try:
        d = json.loads(_marker_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_marker(d: dict[str, Any]) -> None:
    try:
        p = _marker_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(d, indent=1), encoding="utf-8")
        tmp.replace(p)
    except OSError as e:
        log.info("seed marker not written: %s", e)


def _rules(profile: str) -> dict[str, Any]:
    return GameRules(version=1, physics_profile=profile).model_dump(mode="json")  # type: ignore[arg-type]


# ---- Classic Starter ----------------------------------------------------------------------------------------------


def seed_classic() -> int:
    """The v1 Starter World as the v2 game "Classic Starter". Returns the number of level versions added.

    The three sequence levels come from the core's migration in `dist/classic/` (v1 ids kept) when the starter build
    has it; the v1 remixes, and the sequence levels when there is no dist, from the boot migration (`json_v2`)."""
    n = _seed_game(CLASSIC_GAME, "Classic Starter", CLASSIC_CREATED, "v1-classic", lambda i: f"lvl_starter{i + 1}")
    rows = [r for r in db_v2.v1_level_rows(missing_v2_only=False)
            if r.get("game_id") == V1_STARTER_GAME and r.get("json_v2")]
    if not rows:
        return n
    db_v2.ensure_game(CLASSIC_GAME, "Classic Starter", TEAM, _rules("v1-classic"), CLASSIC_CREATED)
    for r in sorted(rows, key=lambda r: (r.get("parent_id") is not None, str(r.get("created_at") or ""), r["id"])):
        if db_v2.level_versions(str(r["id"])):
            continue
        try:
            level = json.loads(r["json_v2"])
        except (TypeError, json.JSONDecodeError):
            continue
        level["game_id"] = CLASSIC_GAME
        level["version"] = 1
        meta = dict(level.get("meta") or {})
        meta["safety"] = "ok"  # the team's own levels
        level["meta"] = meta
        report = {"C": r.get("c_casual"), "score": r.get("score"), "band": r.get("band"), "par_ms": r.get("par_ms"),
                  "fastest_ms": r.get("fastest_ms"), "solvable": bool(r.get("verified"))}
        if levels_io.validate({**level, "meta": {**meta, "level_hash": meta.get("level_hash") or "x"}}):
            continue
        parent = None
        if level.get("parent_id"):
            prow = db_v2.get_level_row(str(level["parent_id"]))
            parent = (prow or {}).get("level")
        levels_io.store(level, report=report, listed=True, safety="ok",
                        changed=levels_io.changed_objects(parent, level) if parent else None, parent_version=1 if parent else None)
        n += 1
    return n


# ---- Starter World v2 -----------------------------------------------------------------------------------------------


def dist_files() -> list[Path]:
    if not DIST.is_dir():
        return []
    return sorted(p for p in DIST.glob("*.level.json") if p.is_file())


def starter_index() -> dict[str, Any] | None:
    """`shared/starter/dist/index.json` (games, level files in order, L5's unlock), or None."""
    try:
        d = json.loads((DIST / "index.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("games"), list) else None


def _index_game(game_id: str) -> dict[str, Any] | None:
    idx = starter_index()
    for g in (idx or {}).get("games") or []:
        if isinstance(g, dict) and g.get("id") == game_id and isinstance(g.get("levels"), list):
            return g
    return None


def _read_level(path: Path) -> dict[str, Any] | None:
    try:
        lv = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        log.warning("starter %s unreadable: %s", path.name, e)
        return None
    return lv if isinstance(lv, dict) else None


def _entries(game_id: str) -> list[dict[str, Any]]:
    """[{id, title, file: Path, unlock_after, bonus, level}] in play order for a seeded game (index first)."""
    g = _index_game(game_id)
    out: list[dict[str, Any]] = []
    if g is not None:
        for e in sorted(g["levels"], key=lambda e: int(e.get("order_index") or 0)):
            path = DIST / str(e.get("file") or "")
            if not path.is_file() or ".." in str(e.get("file") or ""):
                continue
            lv = _read_level(path)
            if lv is not None:
                out.append({"id": str(e.get("id") or ""), "title": e.get("title"), "unlock_after": e.get("unlock_after"),
                            "bonus": bool(e.get("bonus")), "level": lv})
        return out
    if game_id != WORLD_GAME:
        return []
    for path in dist_files():  # an older starter build without index.json
        lv = _read_level(path)
        if lv is not None:
            out.append({"id": str(lv.get("id") or ""), "title": lv.get("title"), "unlock_after": None, "bonus": False,
                        "level": lv})
    return out


def _slot_id(game_id: str, wanted: str, i: int, fallback: str) -> str:
    """A stable id per slot: the level a seed already put at order i keeps its id across rebuilds (its runs stay on
    its board); otherwise the index id when it is free, else `fallback`."""
    for r in db_v2.latest_level_summaries(game_id=game_id, listed_only=True):
        if r.get("parent_id") is None and int(r.get("order_index") or 0) == i and _seeded(r):
            return str(r["id"])
    if _ID.match(wanted) and wanted not in ("lvl_migrated", "level"):
        row = db_v2.get_level_row(wanted)
        if row is None or row.get("game_id") == game_id:
            return wanted
    return fallback


def _seeded(r: dict[str, Any]) -> bool:
    """A level the seeds wrote (no draft behind it, a seed author), as opposed to one a kid published in the game."""
    return not r.get("draft_id") and str(r.get("author") or "") in SEED_AUTHORS


def _publish_seed(level: dict[str, Any], lid: str, game_id: str, i: int, e: dict[str, Any], created: str) -> bool:
    """Store the seed level as a new version when its gameplay hash changed. True when a version was added."""
    level = copy.deepcopy(level)
    level.update({"id": lid, "game_id": game_id, "parent_id": None, "order_index": i,
                  "author": level.get("author") or TEAM, "title": e.get("title") or level.get("title") or f"Level {i + 1}",
                  "created_at": created})
    level.pop("ink_ref", None)
    for k in ("x_unlock_after", "x_bonus"):
        level.pop(k, None)
    if e.get("unlock_after_id"):
        level["x_unlock_after"] = e["unlock_after_id"]
    if e.get("bonus"):
        level["x_bonus"] = True
    meta = dict(level.get("meta") or {})
    meta["safety"] = "ok"  # the team's own levels
    meta.setdefault("core_version", "unknown")
    meta.setdefault("transcript", "")
    level["meta"] = meta
    h = level_hash(level)
    if db_v2.latest_level_hash(lid) == h:
        if not db_v2.level_listed(lid):
            db_v2.set_level_listed(lid, True)  # re-listed after a retire
        return False
    level["version"] = db_v2.next_level_version(lid)
    meta["level_hash"] = h
    errors = levels_io.validate(level)
    if errors:
        log.warning("starter %s is not a valid level: %s", lid, errors[:2])
        return False
    levels_io.store(level, listed=True, safety="ok")  # C, band, par and fastest come from the design block
    return True


def _retire(game_id: str, keep: set[str]) -> int:
    """Take sequence levels a seed put in the game that the index no longer lists out of the game: unlisted and
    detached, never deleted (so rules checks and exports skip them). Kids' levels are never touched."""
    n = 0
    for r in db_v2.latest_level_summaries(game_id=game_id, listed_only=False):
        if r.get("parent_id") is None and r["id"] not in keep and _seeded(r):
            db_v2.retire_level(str(r["id"]))
            n += 1
    if n:
        log.info("seed: %d stale %s level(s) retired", n, game_id)
    return n


def _seed_game(game_id: str, title: str, created: str, default_profile: str, id_of: Callable[[int], str]) -> int:
    entries = _entries(game_id)
    if not entries:
        return 0
    g = _index_game(game_id) or {}
    rules = entries[0]["level"].get("rules") or _rules(default_profile)
    db_v2.ensure_game(game_id, str(g.get("title") or title), TEAM, copy.deepcopy(rules), created)
    ids = [_slot_id(game_id, e["id"], i, id_of(i)) for i, e in enumerate(entries)]
    by_index_id = {e["id"]: ids[i] for i, e in enumerate(entries) if e["id"]}
    n = 0
    for i, e in enumerate(entries):
        if e.get("unlock_after"):
            e["unlock_after_id"] = by_index_id.get(str(e["unlock_after"]))
        stamp = f"{created[:11]}00:{i:02d}:00Z"
        n += _publish_seed(e["level"], ids[i], game_id, i, e, stamp)
    _retire(game_id, set(ids))
    return n


def seed_world() -> int:
    """Starter World from the dist files. Returns the number of level versions added."""
    return _seed_game(WORLD_GAME, "Starter World", WORLD_CREATED, "v2-standard", lambda i: f"lvl_world_l{i + 1}")


def sequence_meta(game_id: str) -> dict[str, dict[str, Any]]:
    """Per level of a seeded game: {unlock_after: <level id> | None, bonus: bool} (§9: L5 unlocks after L4).
    Read from the stored level JSON (x_unlock_after / x_bonus) and, for levels seeded before those keys existed, from
    the index slot. Empty for games the seeds do not own."""
    if game_id not in (WORLD_GAME, CLASSIC_GAME):
        return {}
    rows = [r for r in db_v2.latest_level_summaries(game_id=game_id, listed_only=True) if r.get("parent_id") is None]
    slot = {int(r.get("order_index") or 0): str(r["id"]) for r in rows if _seeded(r)}
    g = _index_game(game_id) or {}
    index_order = {str(e.get("id")): int(e.get("order_index") or 0) for e in g.get("levels") or [] if isinstance(e, dict)}
    out: dict[str, dict[str, Any]] = {}
    for e in g.get("levels") or []:
        if not isinstance(e, dict):
            continue
        lid = slot.get(int(e.get("order_index") or 0))
        if lid is None:
            continue
        after = e.get("unlock_after")
        out[lid] = {"unlock_after": slot.get(index_order.get(str(after), -1)) if after else None,
                    "bonus": bool(e.get("bonus"))}
    return out


# ---- the remix chain under L1 ------------------------------------------------------------------------------------------


def _remix_level(built: dict[str, Any], parent: dict[str, Any], *, lid: str, title: str, author: str,
                 created_at: str) -> dict[str, Any]:
    out = copy.deepcopy(built)
    out.pop("ink_ref", None)
    out.update({"id": lid, "version": 1, "game_id": WORLD_GAME, "parent_id": parent["id"],
                "order_index": int(parent.get("order_index") or 0), "title": title, "author": author,
                "created_at": created_at, "license": parent.get("license", "CC-BY-4.0")})
    if not out.get("ink"):
        out["ink"] = copy.deepcopy(parent.get("ink"))
    meta = dict(out.get("meta") or {})
    meta.update({"safety": "ok", "transcript": meta.get("transcript", ""), "level_hash": meta.get("level_hash") or ""})
    meta.setdefault("core_version", (parent.get("meta") or {}).get("core_version", "unknown"))
    out["meta"] = meta
    return out


async def _build_remix(pool: CorePool, parent: dict[str, Any], *, tier: str | None = None,
                       extra: list[dict[str, Any]] | None = None) -> tuple[dict[str, Any], dict[str, Any]] | None:
    inp = levels_io.rebuild_input(parent, tier=tier, extra_edits=extra, parent=parent,
                                  library=list(parent.get("embedded_library") or []))
    inp["ink"]["parent"] = {"level_id": parent["id"], "version": int(parent.get("version") or 1),
                            "level_hash": (parent.get("meta") or {}).get("level_hash", "")}
    try:
        res = await pool.call("build", inp, BUILD_TIMEOUT_S)
    except CoreError as e:
        if e.code == "down":
            raise
        log.info("remix seed build failed: %s", e)
        return None
    level = (res or {}).get("level") if isinstance(res, dict) else None
    report = (res or {}).get("report") or {}
    if not isinstance(level, dict) or not report.get("solvable"):
        return None
    return level, report


async def seed_remix_chain(pool: CorePool | None = None) -> int:
    pool = pool or get_pool()
    if pool is None:
        return 0
    seq = [r for r in db_v2.latest_level_summaries(game_id=WORLD_GAME, listed_only=False) if r.get("parent_id") is None]
    if not seq:
        return 0
    l1row = db_v2.get_level_row(sorted(seq, key=lambda r: (int(r.get("order_index") or 0), r["id"]))[0]["id"])
    if l1row is None or l1row.get("level") is None:
        return 0
    l1 = l1row["level"]
    marker = _marker()
    failed = marker.setdefault("remix_failed", {})
    key = str(l1row.get("level_hash"))
    n = 0
    maya_row = db_v2.get_level_row(MAYA_ID)
    if maya_row is None:
        if failed.get(f"maya:{key}"):
            return 0
        built = await _build_remix(pool, l1, tier="normal")
        if built is None:
            failed[f"maya:{key}"] = db_v2.now_iso()
            _save_marker(marker)
            return 0
        level, report = built
        maya = _remix_level(level, l1, lid=MAYA_ID, title=f"{l1.get('title') or 'Doodle Meadow'} (Challenging)",
                            author="maya", created_at="2026-10-10T01:00:00Z")
        if levels_io.validate({**maya, "meta": {**maya["meta"], "level_hash": "x"}}):
            failed[f"maya:{key}"] = db_v2.now_iso()
            _save_marker(marker)
            return 0
        levels_io.store(maya, report=report, listed=True, safety="ok", changed=levels_io.changed_objects(l1, maya),
                        parent_version=int(l1.get("version") or 1))
        maya_row = db_v2.get_level_row(MAYA_ID)
        n += 1
    if db_v2.get_level_row(SAM_ID) is None and maya_row is not None and maya_row.get("level"):
        maya_level = maya_row["level"]
        mkey = str(maya_row.get("level_hash"))
        if failed.get(f"sam:{mkey}"):
            return n
        fastest_s = float((maya_level.get("design") or {}).get("fastest_ms") or maya_row.get("fastest_ms") or 30000) / 1000
        seconds = max(20, min(300, int(math.ceil(TIMER_K * fastest_s / 5.0) * 5)))
        op = {"op": "set_timer", "k": 2.0, "x_seconds": seconds}
        timer = present.kid_record(op, "designed", reason_key="challenge.set_timer", reason_args={"seconds": seconds})
        timer["class"] = "U"
        built = await _build_remix(pool, maya_level, extra=[timer])
        if built is None:
            failed[f"sam:{mkey}"] = db_v2.now_iso()
            _save_marker(marker)
            return n
        level, report = built
        sam = _remix_level(level, maya_level, lid=SAM_ID, title=f"{l1.get('title') or 'Doodle Meadow'} speedrun",
                           author="sam", created_at="2026-10-10T02:00:00Z")
        sam["meta"]["transcript"] = f"beat it in {seconds} seconds"
        if not levels_io.validate({**sam, "meta": {**sam["meta"], "level_hash": "x"}}):
            levels_io.store(sam, report=report, listed=True, safety="ok",
                            changed=levels_io.changed_objects(maya_level, sam),
                            parent_version=int(maya_level.get("version") or 1))
            n += 1
    return n


async def seed_all(pool: CorePool | None = None) -> dict[str, int]:
    out = {"classic": 0, "world": 0, "remix": 0}
    try:
        out["classic"] = seed_classic()
    except Exception:  # noqa: BLE001 - seeds never stop the app
        log.exception("Classic Starter seed failed")
    try:
        out["world"] = seed_world()
    except Exception:  # noqa: BLE001
        log.exception("Starter World seed failed")
    try:
        out["remix"] = await seed_remix_chain(pool)
    except CoreError as e:
        log.info("remix chain seed postponed: %s", e)
    except Exception:  # noqa: BLE001
        log.exception("remix chain seed failed")
    if any(out.values()):
        log.info("v2 seeds: %s", out)
    return out


def seed_v2_if_empty() -> bool:
    """Synchronous part of the seeds (no worker needed): Classic Starter and Starter World. True when it seeded."""
    a = seed_classic()
    b = seed_world()
    return bool(a or b)
