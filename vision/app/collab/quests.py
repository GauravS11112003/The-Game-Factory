"""Quests ("Need a lava level") and jams.

A quest is open → claimed (one profile works on it) → done. A claimed level/fix quest links to the claimer's next
submission to that game; accepting it completes the quest. A keeper who claims and publishes directly completes it at
once. Creature and art quests complete through the lane 1 hooks (activity.on_creature_pinned / on_art). A claim that
sat for CLAIM_STALE_DAYS without a submission can be taken by someone else.

Jams: a title, a theme and a time window, optionally tied to a game. Every level published (or submitted) during a
live jam, into its game when it has one, is an entry (badge jam_entrant).
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from app.collab import activity, db, identity, members
from app.collab.errors import CollabError

KINDS = ("level", "creature", "art", "fix")
STATUSES = ("open", "claimed", "done")
TITLE_CHARS = 60
DESCRIPTION_CHARS = 400
CLAIM_STALE_DAYS = 7
BADGE_CHARS = 32
JAM_TITLE_CHARS = 40
JAM_THEME_CHARS = 80
JAM_MAX_DAYS = 60


def _clean(s: Any, n: int) -> str:
    from app.mind import sanitize

    return sanitize.text(s, n)


def _blocked(*texts: str | None) -> bool:
    from app.mind import moderate

    return bool(moderate.blocklist_hit(list(texts)))


def _parse_time(s: Any, *, end: bool = False) -> datetime | None:
    if not isinstance(s, str) or not s.strip():
        return None
    t = s.strip()
    try:
        if len(t) == 10:  # a date: the start or the end of that day
            d = datetime.fromisoformat(t).replace(tzinfo=timezone.utc)
            return d + timedelta(days=1, seconds=-1) if end else d
        d = datetime.fromisoformat(t.replace("Z", "+00:00"))
    except ValueError:
        return None
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _iso(d: datetime) -> str:
    return d.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


# ---- quests -------------------------------------------------------------------------------------------------------------


def get(quest_id: str) -> dict[str, Any] | None:
    return db.row("SELECT * FROM quests WHERE id = ?", (quest_id,))


def out(q: dict[str, Any], players: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    if players is None:
        players = identity.get_players([q.get("claimed_by"), q.get("created_by"), q.get("done_by")])
    level_id = db.scalar("SELECT level_id FROM submissions WHERE id = ?", (q["submission_id"],)) \
        if q.get("submission_id") else None
    return {
        "level_id": level_id,
        "id": q["id"], "game_id": q["game_id"], "title": q["title"], "description": q.get("description") or "",
        "kind": q.get("kind") or "level", "status": q.get("status") or "open",
        "claimed_by": players.get(q.get("claimed_by") or ""), "claimed_at": q.get("claimed_at"),
        "submission_id": q.get("submission_id"), "reward_badge": q.get("reward_badge"),
        "created_by": players.get(q.get("created_by") or ""), "created_at": q.get("created_at"),
        "done_at": q.get("done_at"), "done_by": players.get(q.get("done_by") or ""),
        "message_key": f"collab.quest.kind.{q.get('kind') or 'level'}",
    }


def list_for_game(game_id: str, status: str | None = None) -> list[dict[str, Any]]:
    if status in STATUSES:
        rs = db.rows("SELECT * FROM quests WHERE game_id = ? AND status = ? ORDER BY created_at DESC", (game_id, status))
    else:
        rs = db.rows("SELECT * FROM quests WHERE game_id = ? ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'claimed' "
                     "THEN 1 ELSE 2 END, created_at DESC", (game_id,))
    players = identity.get_players([x for q in rs for x in (q.get("claimed_by"), q.get("created_by"), q.get("done_by"))])
    return [out(q, players) for q in rs]


def create(game_id: str, data: dict[str, Any], created_by: str | None, *, quiet: bool = False) -> dict[str, Any]:
    title = _clean(data.get("title"), TITLE_CHARS)
    if not title:
        raise CollabError(400, "error.bad_request", {"field": "title"})
    description = _clean(data.get("description"), DESCRIPTION_CHARS)
    kind = data.get("kind") or "level"
    if kind not in KINDS:
        raise CollabError(400, "error.bad_request", {"field": "kind"})
    badge = _clean(data.get("reward_badge"), BADGE_CHARS) or None
    if badge is not None:
        badge = "".join(ch for ch in badge.lower().replace(" ", "_") if ch.isalnum() or ch == "_")[:BADGE_CHARS] or None
    if _blocked(title, description, badge):
        raise CollabError(409, "publish.safety_flag")
    qid = f"qst_{secrets.token_hex(4)}"
    db.execute("INSERT INTO quests (id, game_id, title, description, kind, status, reward_badge, created_by, created_at) "
               "VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)",
               (qid, game_id, title, description, kind, badge, created_by, db.now_iso()))
    if not quiet:
        activity.record("quest_created", game_id=game_id, player_id=created_by,
                        data={"quest_id": qid, "quest": title, "kind": kind, "game_title": members.game_title(game_id)})
    return out(get(qid) or {})


def _stale(q: dict[str, Any]) -> bool:
    if q.get("submission_id"):
        return False
    t = _parse_time(q.get("claimed_at"))
    return t is None or datetime.now(timezone.utc) - t > timedelta(days=CLAIM_STALE_DAYS)


def claim(quest_id: str, player: dict[str, Any]) -> dict[str, Any]:
    q = get(quest_id)
    if q is None or members.game(q["game_id"]) is None:
        raise CollabError(404, "error.not_found", {"what": "quest"})
    pid = player["id"]
    if not members.can_participate(q["game_id"], pid):
        raise CollabError(403, "collab.invite_only")
    if q["status"] == "done":
        raise CollabError(409, "collab.quest_closed")
    if q["status"] == "claimed":
        if q.get("claimed_by") == pid:
            return out(q)
        if not _stale(q):
            raise CollabError(409, "collab.quest_taken")
    with db.tx() as conn:
        cur = conn.execute("UPDATE quests SET status = 'claimed', claimed_by = ?, claimed_at = ?, submission_id = NULL "
                           "WHERE id = ? AND status = ? AND COALESCE(claimed_by, '') = ?",
                           (pid, db.now_iso(), quest_id, q["status"], q.get("claimed_by") or ""))
        if not cur.rowcount:
            raise CollabError(409, "collab.quest_taken")
    gt = members.game_title(q["game_id"])
    data = {"quest_id": quest_id, "quest": q["title"], "game_id": q["game_id"], "game_title": gt, "by": pid}
    activity.notify_many(members.keepers(q["game_id"]) + ([q["created_by"]] if q.get("created_by") else []),
                         "quest_claimed", data, exclude=pid)
    activity.record("quest_claimed", game_id=q["game_id"], player_id=pid, data=data)
    if members.role_of(q["game_id"], pid) is None and members.open_for(q["game_id"]) == "everyone":
        members.set_role(q["game_id"], pid, "contributor", added_by="quest")
    return out(get(quest_id) or q)


def claimed_for(game_id: str, player_id: str, kinds: tuple[str, ...] = ("level", "fix")) -> dict[str, Any] | None:
    q = ",".join("?" for _ in kinds)
    return db.row(f"SELECT * FROM quests WHERE game_id = ? AND claimed_by = ? AND status = 'claimed' AND kind IN ({q}) "
                  "ORDER BY claimed_at LIMIT 1", (game_id, player_id, *kinds))


def link_submission(quest_id: str, submission_id: str) -> None:
    db.execute("UPDATE quests SET submission_id = ? WHERE id = ? AND status = 'claimed'", (submission_id, quest_id))


def complete(quest_id: str, player_id: str, *, submission_id: str | None = None) -> bool:
    """Mark a quest done by `player_id`: credit, badges (quest_hero + the quest's reward), notifications, feed."""
    q = get(quest_id)
    if q is None or q["status"] == "done":
        return False
    n = db.execute("UPDATE quests SET status = 'done', done_at = ?, done_by = ?, submission_id = COALESCE(?, submission_id) "
                   "WHERE id = ? AND status != 'done'", (db.now_iso(), player_id, submission_id, quest_id))
    if not n:
        return False
    gid = q["game_id"]
    activity.credit(gid, player_id, "quest", quest_id)
    activity.award(player_id, "quest_hero", game_id=gid)
    if q.get("reward_badge"):
        activity.award(player_id, str(q["reward_badge"]), game_id=gid)
    data = {"quest_id": quest_id, "quest": q["title"], "game_id": gid, "game_title": members.game_title(gid),
            "by": player_id}
    activity.notify(player_id, "quest_done", data)
    activity.notify_many(members.keepers(gid) + ([q["created_by"]] if q.get("created_by") else []), "quest_done", data,
                         exclude=player_id)
    activity.record("quest_done", game_id=gid, player_id=player_id, data=data)
    return True


def complete_claimed(game_id: str, player_id: str, *, kinds: tuple[str, ...], ref_id: str | None = None) -> bool:
    q = claimed_for(game_id, player_id, kinds)
    return complete(q["id"], player_id, submission_id=None) if q is not None else False


# ---- jams ---------------------------------------------------------------------------------------------------------------


def _jam_status(j: dict[str, Any], now: datetime) -> str:
    s, e = _parse_time(j.get("starts_at")), _parse_time(j.get("ends_at"))
    if s is not None and now < s:
        return "upcoming"
    if e is not None and now > e:
        return "ended"
    return "live"


def jam_out(j: dict[str, Any], players: dict[str, dict[str, Any]] | None = None,
            now: datetime | None = None) -> dict[str, Any]:
    now = now or datetime.now(timezone.utc)
    players = players if players is not None else identity.get_players([j.get("created_by")])
    entries = int(db.scalar("SELECT COUNT(*) FROM jam_entries WHERE jam_id = ?", (j["id"],), 0))
    entrants = int(db.scalar("SELECT COUNT(DISTINCT player_id) FROM jam_entries WHERE jam_id = ?", (j["id"],), 0))
    return {"id": j["id"], "title": j["title"], "theme": j.get("theme") or "", "game_id": j.get("game_id"),
            "game_title": members.game_title(j.get("game_id")) if j.get("game_id") else None,
            "starts_at": j["starts_at"], "ends_at": j["ends_at"], "created_by": players.get(j.get("created_by") or ""),
            "created_at": j.get("created_at"), "status": _jam_status(j, now), "entries": entries, "entrants": entrants}


def list_jams() -> list[dict[str, Any]]:
    rs = db.rows("SELECT * FROM jams ORDER BY starts_at DESC LIMIT 100")
    players = identity.get_players([j.get("created_by") for j in rs])
    now = datetime.now(timezone.utc)
    items = [jam_out(j, players, now) for j in rs]
    live = sorted((j for j in items if j["status"] == "live"), key=lambda j: j["ends_at"])
    upcoming = sorted((j for j in items if j["status"] == "upcoming"), key=lambda j: j["starts_at"])
    ended = sorted((j for j in items if j["status"] == "ended"), key=lambda j: j["ends_at"], reverse=True)
    return live + upcoming + ended


def create_jam(data: dict[str, Any], player: dict[str, Any]) -> dict[str, Any]:
    title = _clean(data.get("title"), JAM_TITLE_CHARS)
    theme = _clean(data.get("theme"), JAM_THEME_CHARS)
    if not title:
        raise CollabError(400, "error.bad_request", {"field": "title"})
    s, e = _parse_time(data.get("starts_at")), _parse_time(data.get("ends_at"), end=True)
    if s is None or e is None or e <= s or e - s > timedelta(days=JAM_MAX_DAYS):
        raise CollabError(400, "collab.bad_dates")
    gid = data.get("game_id") or None
    if gid is not None:
        if members.game(str(gid)) is None:
            raise CollabError(404, "error.not_found", {"what": "game"})
        if not members.is_keeper(str(gid), player["id"]):
            raise CollabError(403, "collab.not_keeper")
    if _blocked(title, theme):
        raise CollabError(409, "publish.safety_flag")
    jid = f"jam_{secrets.token_hex(4)}"
    db.execute("INSERT INTO jams (id, title, theme, game_id, starts_at, ends_at, created_by, created_at) "
               "VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (jid, title, theme, gid, _iso(s), _iso(e), player["id"], db.now_iso()))
    activity.record("jam_created", game_id=gid, player_id=player["id"],
                    data={"jam_id": jid, "jam": title, "theme": theme,
                          "game_title": members.game_title(gid) if gid else None})
    j = db.row("SELECT * FROM jams WHERE id = ?", (jid,)) or {}
    return jam_out(j)


def enter_live_jams(level_id: str, player_id: str, game_id: str | None, title: str) -> list[str]:
    """Count a newly published level as an entry of every live jam it fits. Returns the jam ids entered."""
    now = datetime.now(timezone.utc)
    entered = []
    for j in db.rows("SELECT * FROM jams WHERE game_id IS NULL OR game_id = ?", (game_id or "",)):
        if _jam_status(j, now) != "live":
            continue
        if db.execute("INSERT OR IGNORE INTO jam_entries (jam_id, level_id, player_id, created_at) VALUES (?, ?, ?, ?)",
                      (j["id"], level_id, player_id, db.now_iso())) == 1:
            entered.append(j["id"])
            activity.record("jam_entry", game_id=game_id, player_id=player_id,
                            data={"jam_id": j["id"], "jam": j["title"], "level_id": level_id, "title": title})
    if entered:
        activity.award(player_id, "jam_entrant", game_id=game_id)
    return entered
