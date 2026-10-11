"""The game's style reference (POST /api/v2/creative/style): one image + a sentence that every sprite of the game is
generated against, so art by different kids looks like one game.

    create_from_description(game_id, description)  Firefly text-to-image style swatch when the provider is firefly;
                                                     otherwise a text-only style (image_url null: claude-svg uses the
                                                     words only)
    create_from_upload(game_id, image, description) an uploaded reference image (PNG/JPEG/WebP)
    resolve(game_id)        → {style_id, text, image_path | None, record} for the job runner (None when unstyled)
    firefly_upload_id(...)  the reference image's Firefly storage uploadId, re-uploaded when older than 6 h

Store: <data>/creative/styles.json {game_id: {current, styles: {style_id: record}}}; images are public under
/uploads/art/_styles/<game_id>/<style_id>.png. The game bible (lane 4, `app.collab.bible.get_bible(game_id)`) wins
when it exists: its `style_id` picks the current style and its `style_prompt` is the style text.
"""
from __future__ import annotations

import asyncio
import hashlib
import importlib
import json
import logging
import os
import re
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.creative import cutout
from app.creative import settings as cs
from app.creative.firefly import Firefly, FireflyError
from app.mind import sanitize

log = logging.getLogger("dal.v3.style")

STYLE_RE = re.compile(r"^sty_[0-9a-f]{8}$")
GAME_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
UPLOAD_TTL_S = 6 * 3600.0
DESCRIPTION_CHARS = 300
IMAGE_PX = 1024
MAX_UPLOAD_BYTES = 12 * 1024 * 1024


class StyleError(Exception):
    def __init__(self, key: str, status: int = 400) -> None:
        super().__init__(key)
        self.key = key
        self.status = status


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _store_path() -> Path:
    return cs.get().store_dir / "styles.json"


def _load() -> dict[str, Any]:
    try:
        d = json.loads(_store_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save(d: dict[str, Any]) -> None:
    p = _store_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=p.parent, prefix=".styles.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(d, f, separators=(",", ":"))
    os.replace(tmp, p)


def _images_dir(game_id: str) -> Path:
    return cs.get().art_dir / "_styles" / game_id


def bible_of(game_id: str | None) -> dict[str, Any] | None:
    """Lane 4's game bible when that module exists (it may not yet)."""
    if not game_id:
        return None
    try:
        m = importlib.import_module("app.collab.bible")
        fn = getattr(m, "get_bible", None)
        if not callable(fn):
            return None
        b = fn(game_id)
        if hasattr(b, "model_dump"):
            b = b.model_dump(mode="json")
        return b if isinstance(b, dict) else None
    except Exception as e:  # noqa: BLE001 - a missing or half-built bible never blocks art
        log.debug("bible unavailable: %s", e)
        return None


def _with_path(rec: dict[str, Any] | None) -> dict[str, Any] | None:
    """The record plus `image_path` (the local file), the shape lane 4's bible reads."""
    if not isinstance(rec, dict):
        return None
    p = cs.path_of_url(rec["image_url"]) if rec.get("image_url") else None
    return {**rec, "image_path": str(p) if p else None}


def get_style(style_id: str) -> dict[str, Any] | None:
    if not STYLE_RE.match(style_id or ""):
        return None
    for g in _load().values():
        rec = ((g or {}).get("styles") or {}).get(style_id)
        if isinstance(rec, dict):
            return _with_path(rec)
    return None


def current(game_id: str | None, bible: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """The game's style record: the bible's style_id when this store holds it, else the last one created here.
    (lane 4's bible calls this back while building a bible; it guards that re-entry on its side.)"""
    if not game_id or not GAME_RE.match(game_id):
        return None
    g = _load().get(game_id) or {}
    styles = g.get("styles") or {}
    if not styles:
        return None
    bible = bible if bible is not None else (bible_of(game_id) or {})
    bid = bible.get("style_id")
    if isinstance(bid, str) and bid in styles:
        return _with_path(styles[bid])
    cur = g.get("current")
    return _with_path(styles.get(cur)) if isinstance(cur, str) else None


def public(rec: dict[str, Any] | None) -> dict[str, Any] | None:
    if not rec:
        return None
    return {k: rec.get(k) for k in ("style_id", "game_id", "description", "image_url", "source", "created_at",
                                    "x_error_key") if k != "x_error_key" or rec.get(k)}


def resolve(game_id: str | None) -> dict[str, Any] | None:
    """What a job needs: the style id (part of the fingerprint), the style text, the reference image path."""
    bible = bible_of(game_id) or {}
    rec = current(game_id, bible)
    text = sanitize.text(bible.get("style_prompt"), DESCRIPTION_CHARS) or sanitize.text(
        (rec or {}).get("description"), DESCRIPTION_CHARS)
    if game_id and not text:
        from app import db_v2
        from app.game_brief import resolve_guidance

        game = db_v2.get_game(game_id)
        guidance = ((game or {}).get("rules") or {}).get("guidance") or resolve_guidance((game or {}).get("brief"))
        if guidance:
            text = sanitize.text(guidance["style_prompt"], DESCRIPTION_CHARS)
    path: Path | None = Path(rec["image_path"]) if rec and rec.get("image_path") else None
    if path is None and isinstance(bible.get("style_image_path"), str):  # a bible style this store doesn't hold
        bp = Path(bible["style_image_path"])
        path = bp if bp.is_file() else None
    if rec is None and not text and path is None:
        return None
    bid = bible.get("style_id")
    style_id = (rec or {}).get("style_id") or (bid if isinstance(bid, str) else "")
    if not style_id and text:  # a bible-only style still separates fingerprints
        style_id = "txt_" + hashlib.sha256(text.encode()).hexdigest()[:8]
    return {"style_id": style_id, "text": text, "image_path": path, "record": rec}


def _put(game_id: str, rec: dict[str, Any]) -> None:
    d = _load()
    g = d.setdefault(game_id, {})
    g.setdefault("styles", {})[rec["style_id"]] = rec
    g["current"] = rec["style_id"]
    _save(d)


def _patch(game_id: str, style_id: str, **fields: Any) -> None:
    d = _load()
    rec = ((d.get(game_id) or {}).get("styles") or {}).get(style_id)
    if isinstance(rec, dict):
        rec.update(fields)
        _save(d)


def _style_prompt(description: str) -> str:
    return (f"Game art style sample: {description}. A small cheerful hero character, a cute monster, a floating "
            "platform and a gold coin side by side on a plain light background, 2D side-scrolling platformer game "
            "art, consistent colour palette, clean shapes, no text")[:1000]


async def create_from_description(game_id: str, description: str, *, by: str | None = None) -> dict[str, Any]:
    from app.creative import jobs

    if not GAME_RE.match(game_id or ""):
        raise StyleError("error.bad_request")
    desc = sanitize.text(description, DESCRIPTION_CHARS)
    if not desc:
        raise StyleError("error.bad_request")
    s = cs.get()
    sid = f"sty_{secrets.token_hex(4)}"
    rec: dict[str, Any] = {"style_id": sid, "game_id": game_id, "description": desc, "image_url": None,
                           "source": "text", "by": sanitize.opt_text(by, 24), "created_at": _now()}
    if cs.provider(s) == "firefly" and jobs.can_spend(s.usd_per_image):
        try:
            async with Firefly(s) as ff:
                urls = await ff.generate(_style_prompt(desc), size=(2048, 2048), n=1, content_class="art",
                                         deadline_s=120.0)
                jobs.ledger_add("firefly", s.usd_per_image * len(urls), ref=sid)
                data = await ff.download(urls[0])
            png = await asyncio.to_thread(cutout.fit_png, data, max_px=IMAGE_PX)
            d = _images_dir(game_id)
            d.mkdir(parents=True, exist_ok=True)
            path = d / f"{sid}.png"
            path.write_bytes(png)
            rec.update(image_url=cs.public_url(path), source="firefly")
        except (FireflyError, cutout.CutoutError, OSError) as e:
            log.info("style image not generated: %s", e)
            rec["x_error_key"] = getattr(e, "key", "creative.failed")
    _put(game_id, rec)
    return rec


async def create_from_upload(game_id: str, data: bytes, *, description: str | None = None,
                             by: str | None = None) -> dict[str, Any]:
    if not GAME_RE.match(game_id or ""):
        raise StyleError("error.bad_request")
    if not data or len(data) > MAX_UPLOAD_BYTES:
        raise StyleError("error.upload_failed")
    try:
        png = await asyncio.to_thread(cutout.fit_png, data, max_px=IMAGE_PX)
    except cutout.CutoutError as e:
        raise StyleError("error.upload_failed") from e
    sid = f"sty_{secrets.token_hex(4)}"
    d = _images_dir(game_id)
    d.mkdir(parents=True, exist_ok=True)
    path = d / f"{sid}.png"
    path.write_bytes(png)
    rec = {"style_id": sid, "game_id": game_id, "description": sanitize.text(description, DESCRIPTION_CHARS),
           "image_url": cs.public_url(path), "source": "upload", "by": sanitize.opt_text(by, 24),
           "created_at": _now()}
    _put(game_id, rec)
    return rec


async def firefly_upload_id(info: dict[str, Any] | None, ff: Firefly) -> str | None:
    """The style image's uploadId (cached ~6 h; Firefly storage is temporary). None when there is no image or the
    upload fails: the sprite is then generated from the prompt's style words alone."""
    rec = (info or {}).get("record") or {}
    path = (info or {}).get("image_path")
    if not path:
        return None
    up = rec.get("x_upload") or {}
    if isinstance(up, dict) and up.get("id") and time.time() - float(up.get("at") or 0) < UPLOAD_TTL_S:
        return str(up["id"])
    try:
        uid = await ff.upload(Path(path).read_bytes(), long_side=1024)
    except (FireflyError, OSError) as e:
        log.info("style upload failed: %s", e)
        return None
    if rec.get("style_id"):
        _patch(str(rec.get("game_id")), str(rec.get("style_id")), x_upload={"id": uid, "at": time.time()})
    return uid


def record_in_bible(game_id: str, rec: dict[str, Any], player_id: str | None = None) -> None:
    """Tell lane 4's bible about the new style (app.collab.bible.set_style) when that module exists."""
    try:
        m = importlib.import_module("app.collab.bible")
        fn = getattr(m, "set_style", None)
        if callable(fn):
            fn(game_id, rec.get("style_id"), rec.get("description") or None, player_id)
    except Exception as e:  # noqa: BLE001 - the style is stored either way
        log.info("bible style not recorded: %s", e)
