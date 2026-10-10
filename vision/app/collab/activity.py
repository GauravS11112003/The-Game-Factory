"""Encouragement: activity feed, notifications, credits, badges, play milestones and player stats.

Feed items and notifications are returned with a `message_key` (collab.activity.<kind> / collab.notify.<kind>) and
`args` for the UI, plus the raw `data`.

Hooks other lanes call (all safe to call with anything; they never raise):
    on_attempts(request, level_id, attempts, clears)   runs.py, after POST /levels/{id}/attempts is stored:
                                                        "played 10/100/1000 times" and "<name> beat your level"
    on_creature_pinned(player_id, game_id, type_id)    lane 1, after a creature is saved to a game's library
    on_art(player_id, game_id, ref_id)                 lane 1, after generated art is kept in a game

Badges (CONTRACTS_V3): first_level, first_accept, creature_maker (5 creatures), quest_hero, featured (a level of
yours played 100 times), jam_entrant, helper (5 reviews).
"""
from __future__ import annotations

import logging
from typing import Any

from app.collab import db, identity

log = logging.getLogger("dal.v3.activity")

BADGES = ("first_level", "first_accept", "creature_maker", "quest_hero", "featured", "jam_entrant", "helper")
CREDIT_KINDS = ("level", "creature", "art", "quest", "review")
PLAY_MILESTONES = (10, 100, 1000)
FEATURED_PLAYS = 100
CREATURES_FOR_BADGE = 5
REVIEWS_FOR_BADGE = 5
FEED_MAX = 100


# ---- writes -------------------------------------------------------------------------------------------------------------


def record(kind: str, *, game_id: str | None = None, player_id: str | None = None,
           data: dict[str, Any] | None = None) -> None:
    try:
        db.insert("INSERT INTO activity (game_id, player_id, kind, data, created_at) VALUES (?, ?, ?, ?, ?)",
                  (game_id, player_id, kind, db.dumps(data or {}), db.now_iso()))
    except Exception:  # noqa: BLE001 - the feed never breaks an action
        log.exception("activity %s", kind)


def notify(player_id: str | None, kind: str, data: dict[str, Any] | None = None) -> None:
    if not player_id:
        return
    try:
        db.insert("INSERT INTO notifications (player_id, kind, data, read, created_at) VALUES (?, ?, ?, 0, ?)",
                  (player_id, kind, db.dumps(data or {}), db.now_iso()))
    except Exception:  # noqa: BLE001
        log.exception("notification %s", kind)


def notify_many(player_ids: list[str], kind: str, data: dict[str, Any] | None = None, *,
                exclude: str | None = None) -> None:
    for pid in dict.fromkeys(player_ids):
        if pid and pid != exclude:
            notify(pid, kind, data)


def credit(game_id: str | None, player_id: str | None, kind: str, ref_id: str | None) -> bool:
    """One credit per (game, player, kind, thing). True when new."""
    if not player_id or kind not in CREDIT_KINDS:
        return False
    try:
        return db.execute("INSERT OR IGNORE INTO credits (game_id, player_id, kind, ref_id, created_at) "
                          "VALUES (?, ?, ?, ?, ?)", (game_id or "", player_id, kind, str(ref_id or ""), db.now_iso())) == 1
    except Exception:  # noqa: BLE001
        log.exception("credit %s", kind)
        return False


def award(player_id: str | None, badge_id: str, *, game_id: str | None = None) -> bool:
    """Give a badge once (contract badges or a quest's custom reward). Notifies and posts to the feed when new."""
    if not player_id or not badge_id:
        return False
    try:
        new = db.execute("INSERT OR IGNORE INTO badges (player_id, badge_id, awarded_at, game_id) VALUES (?, ?, ?, ?)",
                         (player_id, badge_id, db.now_iso(), game_id)) == 1
    except Exception:  # noqa: BLE001
        log.exception("badge %s", badge_id)
        return False
    if new:
        notify(player_id, "badge", {"badge": badge_id, "game_id": game_id})
        record("badge", game_id=game_id, player_id=player_id, data={"badge": badge_id})
    return new


def milestone(ref_id: str, key: str) -> bool:
    """True the first time (ref, key) is reached."""
    try:
        return db.execute("INSERT OR IGNORE INTO milestones (ref_id, key, reached_at) VALUES (?, ?, ?)",
                          (ref_id, key, db.now_iso())) == 1
    except Exception:  # noqa: BLE001
        return False


def map_level(level_id: str, player_id: str, game_id: str | None) -> None:
    """Remember who published a level (the first publisher keeps it across versions)."""
    db.execute("INSERT OR IGNORE INTO player_levels (level_id, player_id, game_id, created_at) VALUES (?, ?, ?, ?)",
               (level_id, player_id, game_id, db.now_iso()))
    if game_id:
        db.execute("UPDATE player_levels SET game_id = ? WHERE level_id = ? AND game_id IS NULL", (game_id, level_id))


def level_owner(level_id: str) -> str | None:
    r = db.scalar("SELECT player_id FROM player_levels WHERE level_id = ?", (level_id,))
    return str(r) if r else None


def count_credits(player_id: str, kind: str) -> int:
    return int(db.scalar("SELECT COUNT(*) FROM credits WHERE player_id = ? AND kind = ?", (player_id, kind), 0))


def check_count_badges(player_id: str, game_id: str | None = None) -> None:
    if count_credits(player_id, "creature") >= CREATURES_FOR_BADGE:
        award(player_id, "creature_maker", game_id=game_id)
    if count_credits(player_id, "review") >= REVIEWS_FOR_BADGE:
        award(player_id, "helper", game_id=game_id)


# ---- hooks for other lanes ----------------------------------------------------------------------------------------------


def on_attempts(request: Any, level_id: str, attempts: int, clears: int) -> None:
    """runs.py hook: play milestones and "someone beat your level" for the level's publisher."""
    try:
        owner = level_owner(level_id)
        if owner is None:
            return
        lv = db.level_game_and_title(level_id) or {}
        title = lv.get("title") or ""
        base = {"level_id": level_id, "title": title, "game_id": lv.get("game_id")}
        if attempts > 0:
            plays, _ = db.level_plays([level_id]).get(level_id, (0, 0))
            for m in PLAY_MILESTONES:
                if plays >= m and milestone(level_id, f"plays:{m}"):
                    notify(owner, "plays", {**base, "n": m})
                    if m >= FEATURED_PLAYS:
                        award(owner, "featured", game_id=lv.get("game_id"))
        if clears > 0:
            beater = identity.player_from_request(request) if request is not None else None
            if beater is not None:
                if beater["id"] != owner and milestone(level_id, f"beat:{beater['id']}"):
                    notify(owner, "beaten", {**base, "by": beater["id"], "by_name": beater["name"]})
            elif milestone(level_id, "first_clear"):
                notify(owner, "beaten", {**base, "by": None})
    except Exception:  # noqa: BLE001 - a play is never lost because of the feed
        log.exception("on_attempts %s", level_id)


def on_creature_pinned(player_id: str | None, game_id: str | None, type_id: str) -> None:
    """Lane 1 hook: a creature was saved to a game's library by this profile."""
    try:
        if not player_id:
            return
        if credit(game_id, player_id, "creature", type_id):
            record("creature", game_id=game_id, player_id=player_id, data={"type_id": type_id})
        check_count_badges(player_id, game_id)
        if game_id:
            from app.collab import quests

            quests.complete_claimed(game_id, player_id, kinds=("creature",), ref_id=type_id)
    except Exception:  # noqa: BLE001
        log.exception("on_creature_pinned %s", type_id)


def on_art(player_id: str | None, game_id: str | None, ref_id: str) -> None:
    """Lane 1 hook: generated art was kept in a game (a backdrop, a sprite)."""
    try:
        if not player_id:
            return
        credit(game_id, player_id, "art", ref_id)
        if game_id:
            from app.collab import quests

            quests.complete_claimed(game_id, player_id, kinds=("art",), ref_id=ref_id)
    except Exception:  # noqa: BLE001
        log.exception("on_art %s", ref_id)


# ---- reads --------------------------------------------------------------------------------------------------------------


def _badge_label(badge_id: str) -> str:
    try:
        from app.mind import messages

        return messages.say(f"collab.badge.{badge_id}", None, badge_id.replace("_", " "))
    except Exception:  # noqa: BLE001
        return badge_id


def _role_label(role: str) -> str:
    try:
        from app.mind import messages

        return messages.say(f"collab.role.{role}", None, role)
    except Exception:  # noqa: BLE001
        return role


def _args(data: dict[str, Any], players: dict[str, dict[str, Any]], actor: str | None) -> dict[str, Any]:
    a: dict[str, Any] = {k: v for k, v in data.items() if isinstance(v, (str, int, float)) and not isinstance(v, bool)}
    who = data.get("by") or actor
    if who and who in players:
        a["name"] = players[who]["name"]
    elif data.get("by_name"):
        a["name"] = data["by_name"]
    if data.get("game_title") is not None:
        a["game"] = data["game_title"]
    if data.get("badge"):
        a["badge"] = _badge_label(str(data["badge"]))
    if data.get("role"):
        a["role"] = _role_label(str(data["role"]))
    return a


def _top(d: dict[str, Any]) -> dict[str, Any]:
    """The ids a feed row links to, at the top level (the UI opens the level, submission, quest or jam)."""
    return {"level_id": d.get("level_id"), "level_title": d.get("title"), "submission_id": d.get("submission_id"),
            "quest_id": d.get("quest_id"), "quest_title": d.get("quest"), "jam_id": d.get("jam_id"),
            "badge": d.get("badge")}


def _game_titles(ids: set[str]) -> dict[str, str]:
    from app.collab import members

    return {g: members.game_title(g) for g in ids if g}


def feed(game_id: str | None = None, *, limit: int = 50, before: int | None = None) -> list[dict[str, Any]]:
    where, args = [], []
    if game_id:
        where.append("game_id = ?")
        args.append(game_id)
    if before:
        where.append("id < ?")
        args.append(int(before))
    sql = "SELECT * FROM activity" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY id DESC LIMIT ?"
    rs = db.rows(sql, (*args, max(1, min(FEED_MAX, int(limit)))))
    ids: set[str] = set()
    for r in rs:
        d = db.loads(r["data"], {}) or {}
        r["_data"] = d if isinstance(d, dict) else {}
        ids.update(x for x in (r.get("player_id"), r["_data"].get("by")) if x)
    players = identity.get_players(list(ids))
    titles = _game_titles({str(r["game_id"]) for r in rs if r.get("game_id")})
    out = []
    for r in rs:
        d = dict(r["_data"])
        if r.get("game_id") and "game_title" not in d:
            d["game_title"] = titles.get(str(r["game_id"]), "")
        kind = str(r["kind"])
        key = f"collab.activity.{kind}"
        if kind == "published" and not r.get("game_id"):
            key = "collab.activity.published_loose"
        out.append({"id": r["id"], "kind": kind, "game_id": r.get("game_id"), "game_title": d.get("game_title"),
                    "player": players.get(r.get("player_id") or ""), "data": d, "created_at": r["created_at"],
                    "message_key": key, "args": _args(d, players, r.get("player_id")), **_top(d)})
    return out


def notifications(player_id: str, *, limit: int = 50, unread_only: bool = False) -> tuple[list[dict[str, Any]], int]:
    sql = "SELECT * FROM notifications WHERE player_id = ?" + (" AND read = 0" if unread_only else "") + \
          " ORDER BY id DESC LIMIT ?"
    rs = db.rows(sql, (player_id, max(1, min(FEED_MAX, int(limit)))))
    ids: set[str] = set()
    for r in rs:
        d = db.loads(r["data"], {}) or {}
        r["_data"] = d if isinstance(d, dict) else {}
        if r["_data"].get("by"):
            ids.add(str(r["_data"]["by"]))
    players = identity.get_players(list(ids))
    out = []
    for r in rs:
        d = r["_data"]
        kind = str(r["kind"])
        key = f"collab.notify.{kind}"
        if kind == "beaten" and not d.get("by"):
            key = "collab.notify.beaten_someone"
        out.append({"id": r["id"], "kind": kind, "data": d, "read": bool(r["read"]), "created_at": r["created_at"],
                    "message_key": key, "args": _args(d, players, None),
                    "player": players.get(str(d.get("by") or "")), "game_id": d.get("game_id"),
                    "game_title": d.get("game_title"), **_top(d)})
    unread = int(db.scalar("SELECT COUNT(*) FROM notifications WHERE player_id = ? AND read = 0", (player_id,), 0))
    return out, unread


def mark_read(player_id: str, ids: list[int] | None = None) -> int:
    if ids:
        clean = [int(i) for i in ids if isinstance(i, (int, str)) and str(i).isdigit()][:500]
        if not clean:
            return 0
        q = ",".join("?" for _ in clean)
        return db.execute(f"UPDATE notifications SET read = 1 WHERE player_id = ? AND id IN ({q})", (player_id, *clean))
    return db.execute("UPDATE notifications SET read = 1 WHERE player_id = ? AND read = 0", (player_id,))


def badges_of(player_id: str) -> list[dict[str, Any]]:
    return [{"id": r["badge_id"], "awarded_at": r["awarded_at"], "game_id": r.get("game_id"),
             "message_key": f"collab.badge.{r['badge_id']}", "help_key": f"collab.badge.{r['badge_id']}_help"}
            for r in db.rows("SELECT badge_id, awarded_at, game_id FROM badges WHERE player_id = ? ORDER BY awarded_at",
                             (player_id,))]


def player_level_ids(player_id: str) -> list[str]:
    return [str(r["level_id"]) for r in db.rows(
        "SELECT level_id FROM player_levels WHERE player_id = ? ORDER BY created_at DESC", (player_id,))]


def player_stats(player_id: str) -> dict[str, Any]:
    ids = player_level_ids(player_id)
    plays = db.level_plays(ids)
    total_plays = sum(p for p, _ in plays.values())
    total_clears = sum(c for _, c in plays.values())
    subs = {str(r["status"]): int(r["n"]) for r in db.rows(
        "SELECT status, COUNT(*) AS n FROM submissions WHERE player_id = ? GROUP BY status", (player_id,))}
    credits_by = {str(r["kind"]): int(r["n"]) for r in db.rows(
        "SELECT kind, COUNT(*) AS n FROM credits WHERE player_id = ? GROUP BY kind", (player_id,))}
    return {
        "levels_published": len(ids), "submitted": sum(subs.values()), "accepted": subs.get("accepted", 0),
        "pending": subs.get("pending", 0), "plays": total_plays, "clears": total_clears,
        "clear_rate": round(total_clears / total_plays, 4) if total_plays else None,
        "creatures": credits_by.get("creature", 0), "art": credits_by.get("art", 0),
        "quests_done": credits_by.get("quest", 0), "reviews": credits_by.get("review", 0),
        "games": int(db.scalar("SELECT COUNT(*) FROM members WHERE player_id = ?", (player_id,), 0)),
    }


def player_levels(player_id: str, *, include_unlisted: bool = False, limit: int = 60) -> list[dict[str, Any]]:
    """The levels a profile published, newest first (unlisted ones only for the profile itself)."""
    from app.collab import members

    ids = player_level_ids(player_id)[: max(1, limit * 2)]
    plays = db.level_plays(ids)
    subs = {str(r["level_id"]): r for r in db.rows(
        "SELECT level_id, id, status, note FROM submissions WHERE player_id = ? ORDER BY created_at", (player_id,))}
    try:
        from app.routers.v2.runs import thumbnail_url
    except Exception:  # noqa: BLE001
        thumbnail_url = None  # type: ignore[assignment]
    out = []
    titles: dict[str, str] = {}
    for lid in ids:
        lv = db.level_game_and_title(lid)
        if lv is None:
            continue
        listed = bool(lv.get("listed"))
        if not listed and not include_unlisted:
            continue
        gid = lv.get("game_id")
        if gid and gid not in titles:
            titles[gid] = members.game_title(gid)
        p, c = plays.get(lid, (0, 0))
        s = subs.get(lid)
        out.append({"id": lid, "version": lv.get("version"), "title": lv.get("title"), "game_id": gid,
                    "game_title": titles.get(gid or "", None), "parent_id": lv.get("parent_id"), "listed": listed,
                    "plays": p, "clears": c, "clear_rate": round(c / p, 4) if p else None,
                    "thumbnail_url": thumbnail_url(lid, lv.get("version")) if thumbnail_url else None,
                    "submission": {"id": s["id"], "status": s["status"], "note": s.get("note")} if s else None})
        if len(out) >= limit:
            break
    return out


def game_credits(game_id: str) -> dict[str, Any]:
    """{contributors: [{player, role, levels, creatures, art, quests, reviews, total}], authors: [names]}."""
    from app import db_v2
    from app.collab import members

    counts: dict[str, dict[str, int]] = {}
    for r in db.rows("SELECT player_id, kind, COUNT(*) AS n FROM credits WHERE game_id = ? GROUP BY player_id, kind",
                     (game_id,)):
        counts.setdefault(str(r["player_id"]), {})[str(r["kind"])] = int(r["n"])
    roles = {str(r["player_id"]): str(r["role"]) for r in db.rows(
        "SELECT player_id, role FROM members WHERE game_id = ?", (game_id,))}
    players = identity.get_players(list(set(counts) | set(roles)))
    out = []
    for pid, p in players.items():
        c = counts.get(pid, {})
        item = {"player": p, "role": roles.get(pid), "levels": c.get("level", 0), "creatures": c.get("creature", 0),
                "art": c.get("art", 0), "quests": c.get("quest", 0), "reviews": c.get("review", 0)}
        item["total"] = sum(item[k] for k in ("levels", "creatures", "art", "quests", "reviews"))
        if item["total"] or item["role"] in members.KEEPERS:
            out.append(item)
    out.sort(key=lambda x: (0 if x["role"] == "owner" else 1, -x["total"], str(x["player"]["name"]).lower()))
    names = {str(p["name"]).lower() for p in players.values()}
    authors: list[str] = []
    try:
        for r in db_v2.latest_level_summaries(game_id=game_id):
            a = str(r.get("author") or "").strip()
            if a and a.lower() not in names and a not in authors:
                authors.append(a)
    except Exception:  # noqa: BLE001
        pass
    return {"game_id": game_id, "contributors": out, "authors": authors}
