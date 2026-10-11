"""Seed ownership (CONTRACTS_V3 "Identity"): the first profile ever created becomes maintainer of the seeded games
(Starter World, Classic Starter). Each seeded game also gets a bible (pitch + mechanics) and two open quests, so the
quest board is never empty on day one.

Runs lazily (the collab router calls `ensure_seed_collab()` on its requests; profile creation calls
`on_player_created`) because the v2 seeds create the games in the background after boot. Every step is guarded by a
collab_meta flag, so it happens once per database even across reloads, and a maintainer who later leaves is not
re-added.
"""
from __future__ import annotations

import logging
import threading
from typing import Any

from app.collab import activity, bible, db, members, quests

log = logging.getLogger("dal.v3.seed_owner")

SEEDED: dict[str, dict[str, Any]] = {
    "game_world": {
        "pitch": "A doodle adventure across five hand-drawn worlds. Draw a level and add it to the trip!",
        "mechanics_text": "Run with the arrow keys and jump with space or up.\n"
                          "Spikes and lava hurt. Coins are for collecting.\n"
                          "Monsters walk back and forth: jump on them or jump over them.\n"
                          "Keys open doors. Springs bounce you high. Crumbly platforms fall.\n"
                          "Reach the flag to win.",
        "quests": [
            {"title": "Need a lava level", "kind": "level", "reward_badge": "quest_hero",
             "description": "Draw a hot, fiery level with lava pits to jump over. Red scribbles make great lava!"},
            {"title": "Need a new enemy", "kind": "creature", "reward_badge": "quest_hero",
             "description": "Invent a new monster for this world in the Creature Studio. Give it a funny name!"},
        ],
    },
    "game_showcase": {  # v4: one level per mode, with written rules and v4 primitives
        "pitch": "Four ways to play one drawing: platformer, flappy, runner and top-down. Each level has its own rules.",
        "mechanics_text": "Upside Down: press space to flip gravity and walk on the ceiling.\n"
                          "Ghost Manor: tap jump to flap through the gaps.\n"
                          "Lava Run: you never stop running, so jump in time.\n"
                          "Pip's Garden: walk around from above and find five stars.\n"
                          "Write your own rules in the game workspace, like \"E makes you fast\".",
        "quests": [
            {"title": "Make a rule level", "kind": "level", "reward_badge": "quest_hero",
             "description": "Draw a level and write a rule for it, like \"touching the star flips gravity\"."},
            {"title": "Make a new block", "kind": "creature", "reward_badge": "quest_hero",
             "description": "Make a block anyone can use: a bouncy cloud, a portal, a talking friend."},
        ],
    },
    "game_classic": {
        "pitch": "The very first draw.play levels, with the classic floaty jumps. Add a level in the old style!",
        "mechanics_text": "Classic physics: big floaty jumps.\n"
                          "Walkers patrol back and forth.\n"
                          "Spikes hurt. Coins are for collecting.\n"
                          "Touch the flag to win.",
        "quests": [
            {"title": "Need a lava level", "kind": "level", "reward_badge": "quest_hero",
             "description": "Draw a classic level with lava pits and tricky jumps."},
            {"title": "Need a new enemy", "kind": "creature", "reward_badge": "quest_hero",
             "description": "Draw a new walker or flyer that fits the classic world."},
        ],
    },
}

_lock = threading.Lock()
_content_done: set[str] = set()
_maintainer_done: set[str] = set()


def first_player_id() -> str | None:
    r = db.scalar("SELECT id FROM players ORDER BY created_at, rowid LIMIT 1")
    return str(r) if r else None


def _seed_content(game_id: str, spec: dict[str, Any]) -> None:
    if bible.get_bible(game_id) is None:
        bible.ensure_bible(game_id, spec["pitch"], spec["mechanics_text"])
    if db.meta_claim(f"seed_quests:{game_id}", db.now_iso()):
        for q in spec["quests"]:
            quests.create(game_id, q, None, quiet=True)


def _seed_maintainer(game_id: str, player_id: str) -> None:
    if not db.meta_claim(f"seed_maintainer:{game_id}", player_id):
        return
    role = members.set_role(game_id, player_id, "maintainer", added_by="seed")
    title = members.game_title(game_id)
    activity.notify(player_id, "member", {"game_id": game_id, "game_title": title, "role": role})
    activity.record("member_added", game_id=game_id, player_id=player_id,
                    data={"game_title": title, "role": role, "by": player_id})


def ensure_seed_collab() -> None:
    """Idempotent and cheap once done: bibles, quests and the first maintainer for the seeded games that exist."""
    if len(_maintainer_done) == len(SEEDED) and len(_content_done) == len(SEEDED):
        return
    with _lock:
        first: str | None = None
        for game_id, spec in SEEDED.items():
            if game_id in _content_done and game_id in _maintainer_done:
                continue
            if members.game(game_id) is None:  # the v2 seeds have not created it yet
                continue
            try:
                if game_id not in _content_done:
                    _seed_content(game_id, spec)
                    _content_done.add(game_id)
                if game_id not in _maintainer_done:
                    if db.meta_get(f"seed_maintainer:{game_id}") is not None:
                        _maintainer_done.add(game_id)
                        continue
                    first = first or first_player_id()
                    if first is not None:
                        _seed_maintainer(game_id, first)
                        _maintainer_done.add(game_id)
            except Exception:  # noqa: BLE001 - seeds never break a request
                log.exception("collab seed for %s", game_id)


def on_player_created(player_id: str) -> None:  # noqa: ARG001 - the first profile is read from the table
    ensure_seed_collab()
