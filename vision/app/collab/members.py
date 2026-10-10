"""Game members and permissions.

Roles: owner (one per game) > maintainer > contributor. "Keepers" = owner and maintainers: they review submissions,
post quests, edit the bible and publish straight into the game. Managing members is the owner's job; a game without an
owner (the seeded games) lets its maintainers do it.

Who may take part (join, comment, vote, claim quests, submit levels): anyone with a profile when the bible says
`open_for: everyone` (the default); only members when it says `invite`.

Ownership of existing games (created before profiles, or by POST /games which knows only an author name): a game with
no owner is claimed by the first profile whose name matches the game's author (on join, bible edit, members or
publish), or by whoever publishes its first level within an hour of its creation. The seeded games are never claimed;
the first profile ever becomes their maintainer (seed_owner).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from app import db_v2
from app.collab import db, identity

ROLES = ("owner", "maintainer", "contributor")
KEEPERS = ("owner", "maintainer")
RANK = {"owner": 3, "maintainer": 2, "contributor": 1}
SEEDED_GAMES = ("game_world", "game_classic")
CLAIM_EMPTY_WITHIN = timedelta(hours=1)


def game(game_id: str | None) -> dict[str, Any] | None:
    """A v2 game, or None."""
    if not game_id:
        return None
    try:
        g = db_v2.get_game(str(game_id))
    except Exception:  # noqa: BLE001
        return None
    return g if g is not None and g.get("format") == 2 else None


def game_title(game_id: str | None) -> str:
    g = game(game_id)
    return str((g or {}).get("title") or "")


def role_of(game_id: str | None, player_id: str | None) -> str | None:
    if not game_id or not player_id:
        return None
    r = db.scalar("SELECT role FROM members WHERE game_id = ? AND player_id = ?", (game_id, player_id))
    return str(r) if r in ROLES else None


def is_keeper(game_id: str | None, player_id: str | None) -> bool:
    return role_of(game_id, player_id) in KEEPERS


def owner_of(game_id: str) -> str | None:
    r = db.scalar("SELECT player_id FROM members WHERE game_id = ? AND role = 'owner' LIMIT 1", (game_id,))
    return str(r) if r else None


def keepers(game_id: str) -> list[str]:
    return [str(r["player_id"]) for r in db.rows(
        "SELECT player_id FROM members WHERE game_id = ? AND role IN ('owner', 'maintainer') ORDER BY joined_at",
        (game_id,))]


def can_manage_members(game_id: str, player_id: str | None) -> bool:
    role = role_of(game_id, player_id)
    if role == "owner":
        return True
    return role == "maintainer" and owner_of(game_id) is None


def open_for(game_id: str) -> str:
    v = db.scalar("SELECT open_for FROM bibles WHERE game_id = ?", (game_id,))
    return "invite" if v == "invite" else "everyone"


def can_participate(game_id: str, player_id: str | None) -> bool:
    if not player_id:
        return False
    return open_for(game_id) == "everyone" or role_of(game_id, player_id) is not None


def membership(game_id: str, player_id: str) -> dict[str, Any] | None:
    r = db.row("SELECT game_id, player_id, role, joined_at, added_by FROM members WHERE game_id = ? AND player_id = ?",
               (game_id, player_id))
    if r is None:
        return None
    return {**r, "player": identity.get_player(player_id)}


def list_members(game_id: str) -> list[dict[str, Any]]:
    rs = db.rows("SELECT game_id, player_id, role, joined_at FROM members WHERE game_id = ?", (game_id,))
    players = identity.get_players([r["player_id"] for r in rs])
    out = [{"player": players.get(r["player_id"]), "player_id": r["player_id"], "role": r["role"],
            "joined_at": r["joined_at"]} for r in rs if r["player_id"] in players]
    out.sort(key=lambda m: (-RANK.get(m["role"], 0), str(m["joined_at"])))
    return out


def set_role(game_id: str, player_id: str, role: str, *, added_by: str | None = None, allow_downgrade: bool = False) -> str:
    """Add or change a membership. Never demotes an owner; never lowers a role unless `allow_downgrade`.
    Returns the role the player now has."""
    if role not in ROLES:
        raise ValueError("role")
    with db.tx() as conn:
        r = conn.execute("SELECT role FROM members WHERE game_id = ? AND player_id = ?", (game_id, player_id)).fetchone()
        if r is None:
            conn.execute("INSERT INTO members (game_id, player_id, role, joined_at, added_by) VALUES (?, ?, ?, ?, ?)",
                         (game_id, player_id, role, db.now_iso(), added_by))
            return role
        have = str(r[0])
        if have == "owner" or have == role:
            return have
        if RANK.get(role, 0) < RANK.get(have, 0) and not allow_downgrade:
            return have
        conn.execute("UPDATE members SET role = ? WHERE game_id = ? AND player_id = ?", (role, game_id, player_id))
        return role


def remove(game_id: str, player_id: str) -> bool:
    """Take a member out (never the owner). Their credits and levels stay."""
    return db.execute("DELETE FROM members WHERE game_id = ? AND player_id = ? AND role != 'owner'",
                      (game_id, player_id)) > 0


def games_of(player_id: str) -> list[dict[str, Any]]:
    out = []
    for r in db.rows("SELECT game_id, role, joined_at FROM members WHERE player_id = ? ORDER BY joined_at", (player_id,)):
        g = game(r["game_id"])
        if g is not None:
            out.append({"game_id": r["game_id"], "title": g.get("title"), "role": r["role"], "joined_at": r["joined_at"]})
    return out


def _created_recently(g: dict[str, Any]) -> bool:
    try:
        t = datetime.fromisoformat(str(g.get("created_at") or "").replace("Z", "+00:00"))
    except ValueError:
        return False
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return datetime.now(timezone.utc) - t <= CLAIM_EMPTY_WITHIN


def claimable(game_id: str, player: dict[str, Any] | None, *, publishing: bool = False) -> bool:
    """May this profile become the owner of this game (see the module docstring)?"""
    if player is None or game_id in SEEDED_GAMES:
        return False
    g = game(game_id)
    if g is None or owner_of(game_id) is not None:
        return False
    author = str(g.get("author") or "").strip().lower()
    if author and author == str(player.get("name") or "").strip().lower():
        return True
    if publishing and _created_recently(g):
        return not db_v2.latest_level_summaries(game_id=game_id, listed_only=False)
    return False


def claim_if_ownerless(game_id: str, player: dict[str, Any] | None, *, publishing: bool = False) -> bool:
    """Make the profile the owner when `claimable`. True when it became the owner now."""
    if not claimable(game_id, player, publishing=publishing):
        return False
    pid = str((player or {})["id"])
    with db.tx() as conn:
        if conn.execute("SELECT 1 FROM members WHERE game_id = ? AND role = 'owner'", (game_id,)).fetchone() is not None:
            return False
        r = conn.execute("SELECT role FROM members WHERE game_id = ? AND player_id = ?", (game_id, pid)).fetchone()
        if r is None:
            conn.execute("INSERT INTO members (game_id, player_id, role, joined_at, added_by) VALUES (?, ?, 'owner', ?, ?)",
                         (game_id, pid, db.now_iso(), "claim"))
        else:
            conn.execute("UPDATE members SET role = 'owner' WHERE game_id = ? AND player_id = ?", (game_id, pid))
    try:
        from app.collab import activity

        activity.record("claimed", game_id=game_id, player_id=pid, data={"game_title": game_title(game_id)})
    except Exception:  # noqa: BLE001
        pass
    return True


def viewer(game_id: str, player: dict[str, Any] | None) -> dict[str, Any]:
    """What the acting profile may do in this game (the UI shows or hides buttons with it)."""
    pid = (player or {}).get("id")
    role = role_of(game_id, pid)
    return {
        "player_id": pid, "role": role, "keeper": role in KEEPERS, "can_manage_members": bool(pid) and can_manage_members(game_id, pid),
        "can_participate": can_participate(game_id, pid), "claimable": claimable(game_id, player),
        "open_for": open_for(game_id),
    }
