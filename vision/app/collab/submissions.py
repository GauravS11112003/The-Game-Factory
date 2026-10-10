"""Submissions, reviews, comments and votes, and the collab side of publishing.

Publishing (app/build/publish.py calls `publish_mode` before storing and `after_publish` after):
- no X-DP-Player, or a level outside any game → "direct", today's behaviour;
- the game has no owner yet and the publisher may claim it (members.claimable) → they become owner;
- owner / maintainer → "direct" (listed, credit, feed);
- the game has no keepers at all (an old game nobody claimed) → "direct" (nobody could review it);
- an update of a level already listed in that game (the draft that published it) → "direct";
- an invite-only game and not a member → 403 collab.invite_only;
- a remix of a level of that game (it hangs under its parent, outside the sequence) → "direct";
- otherwise → "submit": stored unlisted, a pending submission (or the open one of that level is reopened), keepers
  notified, the publisher joins as contributor, and their claimed level quest is linked.

Review (keepers): accept → the level is listed (unless moderation held it), appended to the end of the game's
sequence, credited, badges (first_accept), linked quest completed, contributor notified. changes → stays unlisted with
the note (publishing the draft again reopens it). decline → stays unlisted. Every decision is a review credit for the
reviewer (helper badge at 5).
"""
from __future__ import annotations

import logging
import secrets
from typing import Any

from app import db_v2
from app.collab import activity, db, identity, members, quests
from app.collab.errors import CollabError

log = logging.getLogger("dal.v3.submissions")

STATUSES = ("pending", "changes", "accepted", "declined")
DECISIONS = {"accept": "accepted", "changes": "changes", "decline": "declined"}
REOPEN = ("pending", "changes", "declined")
NOTE_CHARS = 280
COMMENT_CHARS = 280
MAX_COMMENTS = 100


def _clean(s: Any, n: int) -> str:
    from app.mind import sanitize

    return sanitize.text(s, n)


def _blocked(*texts: str | None) -> bool:
    from app.mind import moderate

    return bool(moderate.blocklist_hit(list(texts)))


def _thumb(level_id: str, version: Any) -> str | None:
    try:
        from app.routers.v2.runs import thumbnail_url

        return thumbnail_url(level_id, version)
    except Exception:  # noqa: BLE001
        return None


# ---- reads --------------------------------------------------------------------------------------------------------------


def get(sub_id: str) -> dict[str, Any] | None:
    return db.row("SELECT * FROM submissions WHERE id = ?", (sub_id,))


def comments_of(sub_id: str) -> list[dict[str, Any]]:
    rs = db.rows("SELECT * FROM comments WHERE submission_id = ? ORDER BY created_at, id LIMIT ?", (sub_id, MAX_COMMENTS))
    players = identity.get_players([r["player_id"] for r in rs])
    return [{"id": r["id"], "submission_id": sub_id, "player": players.get(r["player_id"]), "text": r["text"],
             "created_at": r["created_at"]} for r in rs]


def out(s: dict[str, Any], players: dict[str, dict[str, Any]] | None = None, *, with_comments: bool = False,
        viewer_id: str | None = None) -> dict[str, Any]:
    if players is None:
        players = identity.get_players([s.get("player_id"), s.get("decided_by")])
    lv = db.level_game_and_title(s["level_id"]) or {}
    q = quests.get(s["quest_id"]) if s.get("quest_id") else None
    item = {
        "id": s["id"], "game_id": s["game_id"], "game_title": members.game_title(s["game_id"]),
        "level_id": s["level_id"], "level_version": s.get("level_version") or lv.get("version"),
        "title": lv.get("title"), "author": lv.get("author"), "safety": lv.get("safety"),
        "thumbnail_url": _thumb(s["level_id"], lv.get("version")),
        "player": players.get(s.get("player_id") or ""), "status": s["status"], "note": s.get("note"),
        "votes": int(s.get("votes") or 0), "quest_id": s.get("quest_id"), "quest_title": (q or {}).get("title"),
        "created_at": s["created_at"], "updated_at": s.get("updated_at"), "decided_at": s.get("decided_at"),
        "decided_by": players.get(s.get("decided_by") or ""),
        "comments_count": int(db.scalar("SELECT COUNT(*) FROM comments WHERE submission_id = ?", (s["id"],), 0)),
        "message_key": f"collab.submission.{s['status']}",
    }
    if viewer_id:
        item["voted"] = bool(db.scalar("SELECT value FROM votes WHERE submission_id = ? AND player_id = ?",
                                       (s["id"], viewer_id), 0))
    if with_comments:
        item["comments"] = comments_of(s["id"])
    return item


def list_for_game(game_id: str, status: str | None = None, *, viewer_id: str | None = None) -> list[dict[str, Any]]:
    if status in STATUSES:
        rs = db.rows("SELECT * FROM submissions WHERE game_id = ? AND status = ? ORDER BY votes DESC, created_at",
                     (game_id, status))
    else:
        rs = db.rows("SELECT * FROM submissions WHERE game_id = ? ORDER BY CASE status WHEN 'pending' THEN 0 "
                     "WHEN 'changes' THEN 1 WHEN 'accepted' THEN 2 ELSE 3 END, COALESCE(updated_at, created_at) DESC "
                     "LIMIT 200", (game_id,))
    players = identity.get_players([x for s in rs for x in (s.get("player_id"), s.get("decided_by"))])
    return [out(s, players, with_comments=True, viewer_id=viewer_id) for s in rs]


def list_for_player(player_id: str, *, limit: int = 60) -> list[dict[str, Any]]:
    """A profile's own submissions, newest first (its profile page and "my submissions")."""
    rs = db.rows("SELECT * FROM submissions WHERE player_id = ? ORDER BY COALESCE(updated_at, created_at) DESC LIMIT ?",
                 (player_id, max(1, min(200, limit))))
    players = identity.get_players([x for s in rs for x in (s.get("player_id"), s.get("decided_by"))])
    return [out(s, players, with_comments=True, viewer_id=player_id) for s in rs]


def open_for_level(level_id: str) -> dict[str, Any] | None:
    return db.row("SELECT * FROM submissions WHERE level_id = ? AND status IN ('pending', 'changes', 'declined') "
                  "ORDER BY created_at DESC LIMIT 1", (level_id,))


# ---- publish flow -------------------------------------------------------------------------------------------------------


def publish_mode(game_id: str | None, player: dict[str, Any] | None, *, level_id: str | None,
                 parent_id: str | None) -> str:
    """"direct" or "submit" for a publish by `player` into `game_id` (see the module docstring)."""
    if player is None or not game_id or members.game(game_id) is None:
        return "direct"
    pid = player["id"]
    members.claim_if_ownerless(game_id, player, publishing=True)
    if members.is_keeper(game_id, pid):
        return "direct"
    if not members.keepers(game_id):
        return "direct"
    if level_id:
        lv = db.level_game_and_title(level_id)
        if lv is not None and lv.get("game_id") == game_id and lv.get("listed"):
            return "direct"
    if members.open_for(game_id) == "invite" and members.role_of(game_id, pid) is None:
        raise CollabError(403, "collab.invite_only")
    if parent_id:
        p = db.level_game_and_title(parent_id)
        if p is not None and p.get("game_id") == game_id:
            return "direct"
    return "submit"


def _quest_for(game_id: str, player_id: str, quest_id: Any) -> dict[str, Any] | None:
    if isinstance(quest_id, str) and quest_id:
        q = quests.get(quest_id)
        if q is not None and q["game_id"] == game_id and q["status"] != "done" and \
                q.get("claimed_by") in (None, player_id) and q.get("kind") in ("level", "fix"):
            if q["status"] == "open":
                try:
                    quests.claim(quest_id, {"id": player_id})
                except CollabError:
                    return None
            return quests.get(quest_id)
    return quests.claimed_for(game_id, player_id)


def after_publish(level: dict[str, Any], player: dict[str, Any] | None, *, mode: str, listed: bool,
                  quest_id: Any = None) -> dict[str, Any]:
    """Credits, feed, notifications and the submission for a stored level. Returns {submission} for "submit"."""
    lid = str(level["id"])
    version = int(level.get("version") or 1)
    gid = level.get("game_id") or None
    title = str(level.get("title") or "")
    gt = members.game_title(gid) if gid else None
    base = {"level_id": lid, "title": title, "game_id": gid, "game_title": gt}
    is_remix = bool(level.get("parent_id"))
    if player is None:
        if version == 1 and listed:
            activity.record("remixed" if is_remix else "published", game_id=gid,
                            data={**base, "by_name": level.get("author") or ""})
        return {}
    pid = player["id"]
    activity.map_level(lid, pid, gid)
    activity.award(pid, "first_level", game_id=gid)
    if mode != "submit":
        if version == 1:
            if listed:
                activity.record("remixed" if is_remix else "published", game_id=gid, player_id=pid, data=base)
                quests.enter_live_jams(lid, pid, gid, title)
        elif listed:
            activity.record("updated", game_id=gid, player_id=pid, data=base)
            if gid and not members.is_keeper(gid, pid):
                activity.notify_many(members.keepers(gid), "level_updated", {**base, "by": pid}, exclude=pid)
        if gid:
            activity.credit(gid, pid, "level", lid)
            if version == 1 and not is_remix:
                q = _quest_for(gid, pid, quest_id)
                if q is not None:
                    quests.complete(q["id"], pid)
        return {}

    assert gid is not None
    now = db.now_iso()
    existing = open_for_level(lid)
    if existing is not None:
        sub_id = str(existing["id"])
        db.execute("UPDATE submissions SET status = 'pending', level_version = ?, updated_at = ?, decided_at = NULL, "
                   "decided_by = NULL WHERE id = ?", (version, now, sub_id))
        q_id = existing.get("quest_id")
        activity.notify_many(members.keepers(gid), "submission_updated", {**base, "submission_id": sub_id, "by": pid},
                             exclude=pid)
        activity.record("resubmitted", game_id=gid, player_id=pid, data={**base, "submission_id": sub_id})
    else:
        sub_id = f"sub_{secrets.token_hex(5)}"
        q = _quest_for(gid, pid, quest_id)
        q_id = q["id"] if q is not None else None
        db.execute("INSERT INTO submissions (id, game_id, level_id, level_version, player_id, status, votes, quest_id, "
                   "created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)",
                   (sub_id, gid, lid, version, pid, q_id, now, now))
        if q_id:
            quests.link_submission(q_id, sub_id)
        if members.role_of(gid, pid) is None:
            members.set_role(gid, pid, "contributor", added_by="submission")
        activity.notify_many(members.keepers(gid), "submission_new", {**base, "submission_id": sub_id, "by": pid},
                             exclude=pid)
        activity.record("submitted", game_id=gid, player_id=pid, data={**base, "submission_id": sub_id})
        quests.enter_live_jams(lid, pid, gid, title)
    return {"submission": {"id": sub_id, "status": "pending", "game_id": gid, "game_title": gt, "level_id": lid,
                           "quest_id": q_id, "message_key": "collab.submitted"}}


# ---- review, comments, votes ----------------------------------------------------------------------------------------------


def _append_to_sequence(game_id: str, level_id: str) -> None:
    """Accepted levels go to the end of the game's playable sequence (remixes stay under their parent)."""
    rows = db_v2.latest_level_summaries(game_id=game_id, listed_only=False)
    ids = {r["id"] for r in rows}
    me = next((r for r in rows if r["id"] == level_id), None)
    if me is None or (me.get("parent_id") is not None and me["parent_id"] in ids):
        return
    listed_roots = [r for r in rows if r["id"] != level_id and r.get("listed")
                    and (r.get("parent_id") is None or r["parent_id"] not in ids)]
    nxt = max((int(r.get("order_index") or 0) for r in listed_roots), default=-1) + 1
    if int(me.get("order_index") or 0) != nxt:
        db.set_order_index(level_id, nxt)


def review(sub_id: str, reviewer: dict[str, Any], decision: Any, note: Any) -> dict[str, Any]:
    s = get(sub_id)
    if s is None:
        raise CollabError(404, "error.not_found", {"what": "submission"})
    gid, lid, rid = s["game_id"], s["level_id"], reviewer["id"]
    if not members.is_keeper(gid, rid):
        raise CollabError(403, "collab.not_keeper")
    if decision not in DECISIONS:
        raise CollabError(400, "error.bad_request", {"field": "decision"})
    if s["status"] == "accepted":
        raise CollabError(409, "collab.already_decided")
    status = DECISIONS[decision]
    text = _clean(note, NOTE_CHARS) or None
    if text and _blocked(text):
        raise CollabError(409, "publish.safety_flag")
    now = db.now_iso()
    n = db.execute("UPDATE submissions SET status = ?, note = ?, decided_at = ?, decided_by = ?, updated_at = ? "
                   "WHERE id = ? AND status != 'accepted'", (status, text, now, rid, now, sub_id))
    if not n:
        raise CollabError(409, "collab.already_decided")
    lv = db.level_game_and_title(lid) or {}
    contributor = s["player_id"]
    base = {"level_id": lid, "title": lv.get("title") or "", "game_id": gid, "game_title": members.game_title(gid),
            "submission_id": sub_id, "note": text or "", "decision": decision}
    if status == "accepted":
        listed = (lv.get("safety") or "unchecked") not in ("held", "flag")
        db_v2.set_level_listed(lid, listed)
        if listed:
            _append_to_sequence(gid, lid)
        activity.credit(gid, contributor, "level", lid)
        activity.award(contributor, "first_level", game_id=gid)
        activity.award(contributor, "first_accept", game_id=gid)
        members.set_role(gid, contributor, "contributor", added_by=rid)
        q = quests.get(s["quest_id"]) if s.get("quest_id") else quests.claimed_for(gid, contributor)
        if q is not None and q.get("status") != "done":
            quests.complete(q["id"], contributor, submission_id=sub_id)
        activity.notify(contributor, "accepted", {**base, "by": rid})
        activity.record("accepted", game_id=gid, player_id=contributor, data={**base, "by": contributor,
                                                                              "reviewer": rid})
    else:
        activity.notify(contributor, status, {**base, "by": rid})
        if status == "declined" and s.get("quest_id"):
            db.execute("UPDATE quests SET submission_id = NULL WHERE id = ? AND status = 'claimed'", (s["quest_id"],))
    activity.credit(gid, rid, "review", sub_id)
    activity.check_count_badges(rid, gid)
    return out(get(sub_id) or s, with_comments=True, viewer_id=rid)


def comment(sub_id: str, player: dict[str, Any], text: Any) -> dict[str, Any]:
    s = get(sub_id)
    if s is None:
        raise CollabError(404, "error.not_found", {"what": "submission"})
    pid = player["id"]
    if not members.can_participate(s["game_id"], pid):
        raise CollabError(403, "collab.invite_only")
    t = _clean(text, COMMENT_CHARS)
    if not t:
        raise CollabError(400, "collab.empty_text")
    if _blocked(t):
        raise CollabError(409, "publish.safety_flag")
    cid = f"cmt_{secrets.token_hex(5)}"
    now = db.now_iso()
    db.execute("INSERT INTO comments (id, submission_id, player_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
               (cid, sub_id, pid, t, now))
    lv = db.level_game_and_title(s["level_id"]) or {}
    data = {"submission_id": sub_id, "level_id": s["level_id"], "title": lv.get("title") or "",
            "game_id": s["game_id"], "game_title": members.game_title(s["game_id"]), "by": pid}
    if pid != s["player_id"]:
        activity.notify(s["player_id"], "comment", data)
        activity.credit(s["game_id"], pid, "review", sub_id)
        activity.check_count_badges(pid, s["game_id"])
    else:
        activity.notify_many(members.keepers(s["game_id"]), "comment", data, exclude=pid)
    return {"id": cid, "submission_id": sub_id, "player": player, "text": t, "created_at": now}


def vote(sub_id: str, player: dict[str, Any], value: Any) -> int:
    s = get(sub_id)
    if s is None:
        raise CollabError(404, "error.not_found", {"what": "submission"})
    pid = player["id"]
    if not members.can_participate(s["game_id"], pid):
        raise CollabError(403, "collab.invite_only")
    if pid == s["player_id"]:
        raise CollabError(409, "collab.own_vote")
    v = 1 if value in (1, True, "1") else 0
    with db.tx() as conn:
        conn.execute("INSERT INTO votes (submission_id, player_id, value, created_at) VALUES (?, ?, ?, ?) "
                     "ON CONFLICT(submission_id, player_id) DO UPDATE SET value = excluded.value",
                     (sub_id, pid, v, db.now_iso()))
        total = int(conn.execute("SELECT COALESCE(SUM(value), 0) FROM votes WHERE submission_id = ?",
                                 (sub_id,)).fetchone()[0])
        conn.execute("UPDATE submissions SET votes = ? WHERE id = ?", (total, sub_id))
    if v and activity.milestone(sub_id, f"vote:{pid}"):
        lv = db.level_game_and_title(s["level_id"]) or {}
        activity.notify(s["player_id"], "vote", {"submission_id": sub_id, "level_id": s["level_id"],
                                                 "title": lv.get("title") or "", "game_id": s["game_id"],
                                                 "game_title": members.game_title(s["game_id"]), "by": pid})
    return total
