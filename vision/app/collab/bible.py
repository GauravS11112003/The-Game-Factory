"""The game bible: what a game is about, so contributors can add levels that fit.

    {game_id, pitch, mechanics_text, style_id, style_prompt, style_image_path, style_image_url, starter_type_ids,
     open_for: "everyone" | "invite", updated_at, updated_by}

`get_bible(game_id)` is the import surface for lane 1 (art prompts use style_id / style_prompt / style_image_path);
None when the game has no bible yet. `set_style(game_id, style_id, style_prompt)` lets the creative backend record the
game's style after POST /creative/style. The style image is resolved through lane 1's style store
(app.creative.style) when it exists; the bible never fails because of it.
"""
from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any

from app import db_v2
from app.collab import db

log = logging.getLogger("dal.v3.bible")

OPEN_FOR = ("everyone", "invite")
PITCH_CHARS = 280
MECHANICS_CHARS = 2000
STYLE_PROMPT_CHARS = 300
MAX_STARTERS = 24
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


_resolving = threading.local()


def _style_image(style_id: str | None, game_id: str) -> tuple[str | None, str | None, str | None]:
    """(local path, public url, effective style id) of the game's style reference image.

    Lane 1's store (app.creative.style) reads the bible back from `current()`, so a nested call made while this one
    runs skips the lookup (no recursion)."""
    if getattr(_resolving, "on", False):
        return None, None, style_id
    _resolving.on = True
    try:
        return _style_lookup(style_id, game_id)
    finally:
        _resolving.on = False


def _style_lookup(style_id: str | None, game_id: str) -> tuple[str | None, str | None, str | None]:
    try:
        from app.creative import style as cstyle  # lane 1; may not exist yet
    except Exception:  # noqa: BLE001
        cstyle = None
    info: Any = None
    if cstyle is not None:
        calls: list[tuple[str, Any]] = []
        if style_id:
            calls += [(n, style_id) for n in ("get_style", "load_style", "style_info", "read_style")]
        else:  # the game's current style in lane 1's store
            calls += [(n, game_id) for n in ("current", "style_for_game", "game_style")]
        for name, arg in calls:
            fn = getattr(cstyle, name, None)
            if not callable(fn):
                continue
            try:
                info = fn(arg)
            except Exception:  # noqa: BLE001
                info = None
            if info:
                break
    if isinstance(info, dict) and isinstance(info.get("style_id"), str) and not style_id:
        style_id = info["style_id"]
    path, url = _paths_of(info, style_id)
    return path, url, style_id


def _paths_of(info: Any, style_id: str | None) -> tuple[str | None, str | None]:
    path: str | None = None
    url: str | None = None
    if isinstance(info, (str, Path)):
        path = str(info)
    elif isinstance(info, dict):
        path = next((str(info[k]) for k in ("image_path", "path", "file") if info.get(k)), None)
        url = next((str(info[k]) for k in ("image_url", "url") if info.get(k)), None)
    elif info is not None:
        path = next((str(getattr(info, k)) for k in ("image_path", "path") if getattr(info, k, None)), None)
        url = next((str(getattr(info, k)) for k in ("image_url", "url") if getattr(info, k, None)), None)
    if path is None and url:
        try:
            from app.creative import settings as cset  # lane 1: /uploads/... → the file inside uploads/

            p = cset.path_of_url(url)
            path = str(p) if p else None
        except Exception:  # noqa: BLE001
            path = None
    if path is None and style_id and _ID.match(style_id):
        try:
            from app.config import get_settings

            up = get_settings().uploads_dir
            for rel in (f"styles/{style_id}.png", f"art/styles/{style_id}.png", f"styles/{style_id}/image.png",
                        f"art/{style_id}.png"):
                if (up / rel).is_file():
                    path = str(up / rel)
                    url = url or f"{get_settings().public_uploads}/{rel}"
                    break
        except Exception:  # noqa: BLE001
            pass
    if path is not None and url is None:
        try:
            from app.config import get_settings

            rel = Path(path).resolve().relative_to(get_settings().uploads_dir.resolve())
            url = f"{get_settings().public_uploads}/{rel.as_posix()}"
        except Exception:  # noqa: BLE001
            url = None
    return path, url


def _out(r: dict[str, Any]) -> dict[str, Any]:
    ids = db.loads(r.get("starter_type_ids"), [])
    path, url, style_id = _style_image(r.get("style_id"), str(r["game_id"]))
    return {
        "game_id": r["game_id"], "pitch": r.get("pitch") or "", "mechanics_text": r.get("mechanics_text") or "",
        "style_id": style_id, "style_prompt": r.get("style_prompt"), "style_image_path": path,
        "style_image_url": url, "starter_type_ids": ids if isinstance(ids, list) else [],
        "open_for": r.get("open_for") if r.get("open_for") in OPEN_FOR else "everyone",
        "updated_at": r.get("updated_at"), "updated_by": r.get("updated_by"),
    }


def get_bible(game_id: str) -> dict[str, Any] | None:
    """The stored bible of a game, or None (lane 1's import surface)."""
    try:
        r = db.row("SELECT * FROM bibles WHERE game_id = ?", (game_id,))
    except Exception:  # noqa: BLE001 - a broken collab table never breaks art generation
        log.exception("bible of %s", game_id)
        return None
    return _out(r) if r is not None else None


def bible_or_default(game_id: str) -> dict[str, Any]:
    b = get_bible(game_id)
    if b is not None:
        return b
    return _out({"game_id": game_id, "pitch": "", "mechanics_text": "", "style_id": None, "style_prompt": None,
                 "starter_type_ids": "[]", "open_for": "everyone", "updated_at": None, "updated_by": None})


def _starters(game_id: str, raw: Any) -> list[str]:
    if not isinstance(raw, list):
        raise ValueError("starter_type_ids")
    want = []
    for x in raw:
        s = str(x or "").strip()
        if _ID.match(s) and s not in want:
            want.append(s)
    try:
        have = {str(t.get("id")) for t in db_v2.library_latest(game_id)}
        want = [s for s in want if s in have]
    except Exception:  # noqa: BLE001
        pass
    return want[:MAX_STARTERS]


def put_bible(game_id: str, data: dict[str, Any], player_id: str | None) -> dict[str, Any]:
    """Merge `data` into the bible (fields left out keep their value). ValueError(field) for bad input,
    ValueError("safety") when the blocklist hits."""
    from app.mind import moderate, sanitize

    raw = db.row("SELECT * FROM bibles WHERE game_id = ?", (game_id,)) or {}
    stored_ids = db.loads(raw.get("starter_type_ids"), [])
    cur = {"pitch": raw.get("pitch") or "", "mechanics_text": raw.get("mechanics_text") or "",
           "style_id": raw.get("style_id"), "style_prompt": raw.get("style_prompt"),
           "starter_type_ids": stored_ids if isinstance(stored_ids, list) else [],
           "open_for": raw.get("open_for") if raw.get("open_for") in OPEN_FOR else "everyone"}
    pitch = sanitize.text(data["pitch"], PITCH_CHARS) if "pitch" in data else cur["pitch"]
    mech_raw = data.get("mechanics_text") if "mechanics_text" in data else cur["mechanics_text"]
    mechanics = _multiline(mech_raw, MECHANICS_CHARS)
    style_id = cur["style_id"]
    if "style_id" in data:
        sid = str(data.get("style_id") or "").strip()
        if sid and not _ID.match(sid):
            raise ValueError("style_id")
        style_id = sid or None
    style_prompt = (sanitize.opt_text(data.get("style_prompt"), STYLE_PROMPT_CHARS) if "style_prompt" in data
                    else cur["style_prompt"])
    starters = _starters(game_id, data["starter_type_ids"]) if "starter_type_ids" in data else cur["starter_type_ids"]
    of = data.get("open_for") or cur["open_for"]
    if of not in OPEN_FOR:
        raise ValueError("open_for")
    if moderate.blocklist_hit([pitch, mechanics, style_prompt]):
        raise ValueError("safety")
    db.execute(
        "INSERT INTO bibles (game_id, pitch, mechanics_text, style_id, style_prompt, starter_type_ids, open_for, "
        "updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(game_id) DO UPDATE SET "
        "pitch = excluded.pitch, mechanics_text = excluded.mechanics_text, style_id = excluded.style_id, "
        "style_prompt = excluded.style_prompt, starter_type_ids = excluded.starter_type_ids, "
        "open_for = excluded.open_for, updated_at = excluded.updated_at, updated_by = excluded.updated_by",
        (game_id, pitch, mechanics, style_id, style_prompt, db.dumps(starters), of, db.now_iso(), player_id),
    )
    return get_bible(game_id) or bible_or_default(game_id)


def set_style(game_id: str, style_id: str | None, style_prompt: str | None = None,
              player_id: str | None = None) -> dict[str, Any]:
    """Record the game's style (lane 1 calls this after POST /creative/style)."""
    data: dict[str, Any] = {"style_id": style_id}
    if style_prompt is not None:
        data["style_prompt"] = style_prompt
    return put_bible(game_id, data, player_id)


def ensure_bible(game_id: str, pitch: str, mechanics_text: str) -> bool:
    """Create a bible when the game has none (seeds). True when created."""
    return db.execute(
        "INSERT OR IGNORE INTO bibles (game_id, pitch, mechanics_text, starter_type_ids, open_for, updated_at) "
        "VALUES (?, ?, ?, '[]', 'everyone', ?)", (game_id, pitch, mechanics_text, db.now_iso())) == 1


def _multiline(s: Any, n: int) -> str:
    """Plain text that keeps line breaks (mechanics are often a list)."""
    from app.mind import sanitize

    if s is None:
        return ""
    lines = [sanitize.text(line, n) for line in str(s).replace("\r\n", "\n").split("\n")]
    out = "\n".join(lines).strip()
    while "\n\n\n" in out:
        out = out.replace("\n\n\n", "\n\n")
    return out[:n]
