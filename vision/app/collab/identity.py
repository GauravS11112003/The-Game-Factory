"""Profiles without passwords (CONTRACTS_V3 "Identity").

A profile is {id, name, avatar_url}; creating one returns a random secret token that the browser keeps in
localStorage. Only its SHA-256 is stored. Every request that acts as someone carries

    X-DP-Player: <player_id>.<token>

`player_from_request(request)` checks it and returns the public profile (or None). FastAPI dependencies:
`current_player` (optional, None when absent or wrong) and `require_player` (401 {message_key: collab.need_profile}
under `detail`; the collab router itself answers {message_key, args} at the top level like every v2 route).
Avatars are PNGs saved under uploads/players/<id>.png.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import logging
import re
import secrets
from typing import Any

from fastapi import HTTPException, Request

from app.collab import db
from app.config import get_settings

log = logging.getLogger("dal.v3.identity")

HEADER = "X-DP-Player"
PLAYER_ID = re.compile(r"^pl_[0-9a-f]{10}$")
TOKEN = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
NAME_CHARS = 16
MAX_AVATAR_BYTES = 1024 * 1024
PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class IdentityError(Exception):
    def __init__(self, status: int, key: str, args: dict[str, Any] | None = None) -> None:
        super().__init__(key)
        self.status = status
        self.key = key
        self.args_ = args or {}


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def players_dir() -> Any:
    d = get_settings().uploads_dir / "players"
    d.mkdir(parents=True, exist_ok=True)
    return d


def avatar_url(r: dict[str, Any]) -> str | None:
    rel = r.get("avatar_path")
    if not rel:
        return None
    try:
        p = get_settings().uploads_dir / str(rel)
        v = int(p.stat().st_mtime) if p.exists() else 0
    except OSError:
        v = 0
    return f"{get_settings().public_uploads}/{rel}?v={v}"


def public(r: dict[str, Any] | None) -> dict[str, Any] | None:
    """The public profile (never the token hash)."""
    if r is None:
        return None
    return {"id": r["id"], "name": r["name"], "avatar_url": avatar_url(r), "created_at": r.get("created_at")}


def decode_avatar(value: Any) -> bytes | None:
    """`avatar_png`: base64 PNG or a data URL. None when absent; IdentityError when it is not a PNG."""
    if value is None or value == "":
        return None
    if not isinstance(value, str):
        raise IdentityError(400, "collab.bad_avatar")
    s = value.strip()
    if s.startswith("data:"):
        head, _, s = s.partition(",")
        if "base64" not in head:
            raise IdentityError(400, "collab.bad_avatar")
    if len(s) > MAX_AVATAR_BYTES * 4 // 3 + 16:
        raise IdentityError(400, "collab.bad_avatar")
    try:
        data = base64.b64decode(s, validate=False)
    except (binascii.Error, ValueError):
        raise IdentityError(400, "collab.bad_avatar") from None
    if not data.startswith(PNG_MAGIC) or len(data) > MAX_AVATAR_BYTES:
        raise IdentityError(400, "collab.bad_avatar")
    return data


def _save_avatar(player_id: str, data: bytes) -> str:
    path = players_dir() / f"{player_id}.png"
    tmp = path.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return f"players/{player_id}.png"


def clean_name(name: Any) -> str:
    from app.mind import moderate, sanitize

    n = sanitize.text(name, NAME_CHARS)
    if not n or not any(ch.isalnum() for ch in n):
        raise IdentityError(400, "collab.bad_name")
    if moderate.blocklist_hit([n]):
        raise IdentityError(409, "publish.safety_flag")
    return n


def create_player(name: Any, avatar_png: Any = None) -> tuple[dict[str, Any], str]:
    """A new profile and its secret token (shown once). The first profile ever becomes maintainer of the seeded
    games (seed_owner)."""
    clean = clean_name(name)
    data = decode_avatar(avatar_png)
    pid = f"pl_{secrets.token_hex(5)}"
    token = secrets.token_urlsafe(24)
    rel = _save_avatar(pid, data) if data else None
    created = db.now_iso()
    db.execute("INSERT INTO players (id, name, avatar_path, token_hash, created_at) VALUES (?, ?, ?, ?, ?)",
               (pid, clean, rel, hash_token(token), created))
    try:
        from app.collab import seed_owner

        seed_owner.on_player_created(pid)
    except Exception:  # noqa: BLE001 - seeds never block a profile
        log.exception("seed ownership for %s", pid)
    return public({"id": pid, "name": clean, "avatar_path": rel, "created_at": created}) or {}, token


def update_player(player_id: str, *, name: Any = None, avatar_png: Any = None) -> dict[str, Any] | None:
    sets, args = [], []
    if name is not None:
        sets.append("name = ?")
        args.append(clean_name(name))
    data = decode_avatar(avatar_png)
    if data:
        sets.append("avatar_path = ?")
        args.append(_save_avatar(player_id, data))
    if sets:
        db.execute(f"UPDATE players SET {', '.join(sets)} WHERE id = ?", (*args, player_id))
    return get_player(player_id)


def get_player(player_id: str | None) -> dict[str, Any] | None:
    if not player_id or not PLAYER_ID.match(str(player_id)):
        return None
    return public(db.row("SELECT id, name, avatar_path, created_at FROM players WHERE id = ?", (player_id,)))


def get_players(ids: list[str | None] | set[str | None]) -> dict[str, dict[str, Any]]:
    """{id: public profile} for many ids at once (feeds, credits)."""
    want = sorted({str(i) for i in ids if i})
    out: dict[str, dict[str, Any]] = {}
    for i in range(0, len(want), 400):
        chunk = want[i:i + 400]
        q = ",".join("?" for _ in chunk)
        for r in db.rows(f"SELECT id, name, avatar_path, created_at FROM players WHERE id IN ({q})", chunk):
            p = public(r)
            if p is not None:
                out[r["id"]] = p
    return out


def parse_header(value: str | None) -> tuple[str, str] | None:
    if not value:
        return None
    pid, sep, token = value.strip().partition(".")
    if not sep or not PLAYER_ID.match(pid) or not TOKEN.match(token):
        return None
    return pid, token


def player_from_request(request: Any) -> dict[str, Any] | None:
    """The profile named by X-DP-Player when its token matches, else None."""
    from app import auth
    if auth.settings().enabled:
        return auth.session_player(request)
    try:
        value = request.headers.get(HEADER)
    except Exception:  # noqa: BLE001 - anything without headers is anonymous
        return None
    return player_from_token(value)


def player_from_token(value: str | None) -> dict[str, Any] | None:
    """The same check for an X-DP-Player value given another way (the live-drawing WebSocket's ?player=)."""
    parsed = parse_header(value) if isinstance(value, str) else None
    if parsed is None:
        return None
    pid, token = parsed
    r = db.row("SELECT id, name, avatar_path, token_hash, created_at FROM players WHERE id = ?", (pid,))
    if r is None or not hmac.compare_digest(str(r["token_hash"]), hash_token(token)):
        return None
    return public(r)


def current_player(request: Request) -> dict[str, Any] | None:
    """FastAPI dependency: the acting profile or None."""
    return player_from_request(request)


def require_player(request: Request) -> dict[str, Any]:
    """FastAPI dependency: the acting profile, or 401 collab.need_profile."""
    p = player_from_request(request)
    if p is None:
        raise HTTPException(status_code=401, detail={"message_key": "collab.need_profile", "args": {}})
    return p
