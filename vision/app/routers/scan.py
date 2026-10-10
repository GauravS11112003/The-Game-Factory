"""POST /api/scan (PLAN.md section 9). Owned by lane D (Backend + UI).

multipart: image, mode (paper|canvas), prompt?, parent_id? (overrides QR),
game_id?, debug?, character? (canvas path: the 128x128 character drawing)
  ->  {draft_id, level, parent_hint, game_hint, warnings, safety, debug?}

Flow: run_scan -> QR hints -> interpret -> compile_level into uploads/drafts/<draft_id>/.
ScanError (or an undecodable image) -> 422 with the message. A lane whose
function is still a stub (NotImplementedError) -> 503 so the UI can say
"scanner not ready" instead of crashing. The vision model is optional: any
failure there compiles the level from CV alone with the "rules_not_read" warning.

GET /api/drafts/{draft_id} returns a stored draft so #/play/draft/:id works.
"""
from __future__ import annotations

import io
import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlmodel import Session

from app.compile import compile_level
from app.config import get_settings
from app.cv.pipeline import run_scan
from app.db import get_game, get_level, get_session
from app.llm.interpret import interpret
from app.models import Component, Interpretation, Level

try:  # lane A defines ScanError next to run_scan; fall back so this module always imports
    from app.cv.pipeline import ScanError
except ImportError:  # pragma: no cover

    class ScanError(ValueError):  # type: ignore[no-redef]
        pass


router = APIRouter(prefix="/api", tags=["scan"])

DRAFT_ID_RE = re.compile(r"^d_[0-9a-f]{8}$")
QR_RE = re.compile(r"^dal1\|(blank|game\|(?P<game>[A-Za-z0-9_-]+)|lvl\|(?P<lvl>[A-Za-z0-9_-]+))$")
PHOTO_MAX_EDGE = 2000
SPRITE_W, SPRITE_H = 32, 48


def new_draft_id() -> str:
    return "d_" + secrets.token_hex(4)


def draft_dir(draft_id: str) -> Path:
    if not DRAFT_ID_RE.match(draft_id):
        raise HTTPException(status_code=404, detail="Draft not found")
    return get_settings().drafts_dir / draft_id


def draft_public_prefix(draft_id: str) -> str:
    return f"{get_settings().public_uploads}/drafts/{draft_id}"


def load_draft(draft_id: str) -> tuple[Level, dict[str, Any]]:
    """The draft Level plus the scan metadata written next to it (parent/game hints, safety)."""
    work_dir = draft_dir(draft_id)
    level_path = work_dir / "level.json"
    if not level_path.is_file():
        raise HTTPException(status_code=404, detail="Draft not found")
    level = Level.model_validate(json.loads(level_path.read_text()))
    meta_path = work_dir / "draft.json"
    meta = json.loads(meta_path.read_text()) if meta_path.is_file() else {}
    return level, meta


def parse_qr(payload: str | None) -> tuple[str | None, str | None]:
    """dal1|lvl|<id> -> (parent id, None); dal1|game|<id> -> (None, game id); anything else -> (None, None)."""
    if not payload:
        return None, None
    m = QR_RE.match(payload.strip())
    if not m:
        return None, None
    return m.group("lvl"), m.group("game")


def _decode_image(data: bytes) -> Image.Image:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as exc:
        raise ScanError("Couldn't read that image. Try a JPEG or PNG photo of the whole sheet.") from exc
    return ImageOps.exif_transpose(img) or img


def _save_photo(img: Image.Image, work_dir: Path) -> Path:
    photo = img.convert("RGB")
    photo.thumbnail((PHOTO_MAX_EDGE, PHOTO_MAX_EDGE))
    out = work_dir / "photo.jpg"
    photo.save(out, "JPEG", quality=88)
    return out


def _save_character(data: bytes, work_dir: Path) -> Path | None:
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError):
        return None
    out = work_dir / "character.png"
    img.convert("RGBA").save(out, "PNG")
    return out


def sprite_from_character(character_png: Path, out_path: Path) -> bool:
    """Canvas-path fallback for the paper sprite step: ink = opaque and not near-white.

    Keeps the drawing's aspect ratio inside 32x48 with nearest-neighbour scaling
    (the doodle look), feet at the bottom. Returns False when the box is empty.
    """
    img = Image.open(character_png).convert("RGBA")
    px = img.load()
    w, h = img.size
    mask = Image.new("L", (w, h), 0)
    mpx = mask.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 40 and (r + g + b) < 720:
                mpx[x, y] = 255
    bbox = mask.getbbox()
    if bbox is None:
        return False
    cropped = img.crop(bbox)
    cropped.putalpha(mask.crop(bbox))
    cw, ch = cropped.size
    scale = min(SPRITE_W / cw, SPRITE_H / ch)
    nw, nh = max(1, round(cw * scale)), max(1, round(ch * scale))
    small = cropped.resize((nw, nh), Image.Resampling.NEAREST)
    sprite = Image.new("RGBA", (SPRITE_W, SPRITE_H), (0, 0, 0, 0))
    sprite.paste(small, ((SPRITE_W - nw) // 2, SPRITE_H - nh), small)
    sprite.save(out_path, "PNG")
    return True


def _unique(items: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


@router.post("/scan")
def scan(
    image: UploadFile = File(...),
    mode: str = Form("paper"),
    prompt: str | None = Form(None),
    parent_id: str | None = Form(None),
    game_id: str | None = Form(None),
    debug: bool = Form(False),
    character: UploadFile | None = File(None),
    session: Session = Depends(get_session),
) -> dict[str, Any]:
    if mode not in ("paper", "canvas"):
        raise HTTPException(status_code=422, detail="mode must be 'paper' or 'canvas'")
    settings = get_settings()
    settings.ensure_dirs()

    data = image.file.read()
    if not data:
        raise HTTPException(status_code=422, detail="No image was uploaded")
    try:
        decoded = _decode_image(data)
    except ScanError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    draft_id = new_draft_id()
    work_dir = settings.drafts_dir / draft_id
    work_dir.mkdir(parents=True, exist_ok=True)
    prefix = draft_public_prefix(draft_id)
    _save_photo(decoded, work_dir)
    character_path = _save_character(character.file.read(), work_dir) if character is not None else None

    try:
        cv = run_scan(data, mode, str(work_dir), debug=debug)  # type: ignore[arg-type]
    except NotImplementedError as exc:
        raise HTTPException(status_code=503, detail="Scanner not ready yet: the CV pipeline is not implemented") from exc
    except ScanError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"Couldn't read that drawing: {exc}") from exc

    qr_parent, qr_game = parse_qr(cv.qr_payload)
    parent_hint = (parent_id or "").strip() or qr_parent
    game_hint = (game_id or "").strip() or qr_game

    parent: Level | None = None
    if parent_hint:
        parent = get_level(session, parent_hint)
        if parent is None:
            raise HTTPException(status_code=422, detail=f"Parent level {parent_hint} was not found")
        if game_hint is None:
            game_hint = parent.game_id
    if game_hint and get_game(session, game_hint) is None:
        raise HTTPException(status_code=422, detail=f"Game {game_hint} was not found")

    warnings: list[str] = list(cv.warnings)
    parent_components: list[Component] = list(parent.components) if parent else []
    interp: Interpretation | None
    try:
        interp = interpret(cv, parent_components, (prompt or "").strip() or None)
    except Exception:  # noqa: BLE001 - the model is optional; never block the scan on it
        interp = None
    if interp is None:
        warnings.append("rules_not_read")

    try:
        level = compile_level(cv, interp, parent, "draft", game_hint, draft_id, str(work_dir), prefix)
    except NotImplementedError as exc:
        raise HTTPException(status_code=503, detail="Scanner not ready yet: the level compiler is not implemented") from exc

    level.id = draft_id
    level.parent_id = parent_hint
    level.game_id = game_hint
    level.source.kind = mode  # type: ignore[assignment]
    level.source.photo_url = f"{prefix}/photo.jpg"
    if level.sprites.player is None and character_path is not None:
        if sprite_from_character(character_path, work_dir / "player.png"):
            level.sprites.player = f"{prefix}/player.png"
    level.meta.warnings = _unique([*level.meta.warnings, *warnings])
    level = Level.model_validate(level.model_dump(mode="json"))

    safety = {
        "ok": True if interp is None else bool(interp.safety_ok),
        "reason": None if interp is None else interp.safety_reason,
    }
    draft_meta = {
        "draft_id": draft_id,
        "mode": mode,
        "prompt": prompt,
        "parent_hint": parent_hint,
        "game_hint": game_hint,
        "qr_payload": cv.qr_payload,
        "safety": safety,
        "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    (work_dir / "level.json").write_text(level.model_dump_json(indent=2) + "\n")
    (work_dir / "draft.json").write_text(json.dumps(draft_meta, indent=2) + "\n")

    out: dict[str, Any] = {
        "draft_id": draft_id,
        "level": level.model_dump(mode="json"),
        "parent_hint": parent_hint,
        "game_hint": game_hint,
        "warnings": level.meta.warnings,
        "safety": safety,
    }
    if debug:
        out["debug"] = {
            p.name: f"{prefix}/{p.name}" for p in sorted(work_dir.iterdir()) if p.is_file() and p.name != "level.json"
        }
    return out


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: str) -> dict[str, Any]:
    level, meta = load_draft(draft_id)
    return {
        "draft_id": draft_id,
        "level": level.model_dump(mode="json"),
        "parent_hint": meta.get("parent_hint"),
        "game_hint": meta.get("game_hint"),
        "warnings": level.meta.warnings,
        "safety": meta.get("safety", {"ok": True, "reason": None}),
    }
