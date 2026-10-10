"""Paper packs and printable templates (PLAN_V2 §6.4-6.5, §8.1-8.2, §11.3e).

POST /packs {kind: new|game|remix|extend, k, game_id?, parent_id?} → 201 {pack_id, pdf_url, k, kind}
    new, game: k blank sheets ("Sheet n of k"); remix: k sheets with the parent's ink in gray (k defaults to the
    parent's screens and is at least that); extend: one sheet with the parent's last 2 columns in gray.
GET  /packs/{id} → {pack_id, kind, k, game_id, parent_id, pdf_url, sheets: [{n, status, draft_id, photo_url,
                   scanned_at}], scanned, complete}       (the scan screen's pack tray checklist)
GET  /templates/pack/{pack_id}.pdf          the pack's PDF (k pages, QR dal2|p|<pack>|<n>/<k> on each)
GET  /templates/rules.pdf?game=<id>         the Rules Sheet (dal2|rules|<game>)
GET  /templates/library.pdf?game=<id>       the Library Sheet (dal2|lib|<game>)

The QR carries only the pack id and n/k; the pack record here knows the kind, game and parent, so printing is the only
server dependency (§6.4). PDFs are rendered by lane C's generator and cached under /uploads/packs/.
"""
from __future__ import annotations

import asyncio
import logging
import re
import secrets
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app import db_v2
from app.config import get_settings
from app.routers.v2.library import lane_c
from app.spec.api import PackCreate

log = logging.getLogger("dal.v2.packs")
router = APIRouter()

PACK_ID = re.compile(r"^[A-Za-z0-9_-]{4,32}$")
GAME_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_SHEETS = 6


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def pdf_url(pack_id: str) -> str:
    return f"/api/v2/templates/pack/{pack_id}.pdf"


def packs_dir() -> Any:
    d = get_settings().uploads_dir / "packs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _pdf(data: bytes, name: str) -> Response:
    return Response(content=data, media_type="application/pdf",
                    headers={"Content-Disposition": f'inline; filename="{name}"', "Cache-Control": "no-cache"})


@router.post("/packs", status_code=201)
async def create_pack(request: Request) -> Any:
    try:
        body = PackCreate.model_validate(await request.json())
    except ValidationError as e:
        return err(400, "error.bad_request", {"field": "pack", "errors": min(e.error_count(), 99)})
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request")
    k = body.k
    game_id = body.game_id
    parent_id = body.parent_id
    if body.kind == "game" and not game_id:
        return err(400, "error.bad_request", {"field": "game_id"})
    if game_id:
        g = db_v2.get_game(game_id)
        if g is None or g.get("format") != 2:
            return err(404, "error.not_found", {"what": "game"})
    if body.kind in ("remix", "extend"):
        if not parent_id:
            return err(400, "error.bad_request", {"field": "parent_id"})
        row = db_v2.get_level_row(parent_id)
        if row is None or row.get("level") is None:
            return err(404, "error.not_found", {"what": "level"})
        screens = int(((row["level"].get("world") or {}).get("screens")) or 1)
        game_id = game_id or row.get("game_id")
        if body.kind == "extend":
            if screens >= MAX_SHEETS:
                return err(409, "error.bad_request", {"field": "k", "max": MAX_SHEETS})
            k = 1
        else:
            k = max(k, screens)
    elif parent_id:
        parent_id = None  # only remix and extend packs have a parent
    pack_id = f"p{secrets.token_hex(4)}"
    db_v2.insert_pack(pack_id, body.kind, int(k), game_id, parent_id)
    return JSONResponse({"pack_id": pack_id, "pdf_url": pdf_url(pack_id), "k": int(k), "kind": body.kind},
                        status_code=201)


@router.get("/packs/{pack_id}")
def get_pack(pack_id: str) -> Any:
    if not PACK_ID.match(pack_id):
        return err(404, "error.not_found", {"what": "pack"})
    p = db_v2.get_pack(pack_id)
    if p is None:
        return err(404, "error.not_found", {"what": "pack"})
    k = int(p["k"])
    seen = {int(s.get("n", 0)): s for s in p.get("sheets") or [] if isinstance(s, dict)}
    sheets = []
    for n in range(1, k + 1):
        s = seen.get(n)
        sheets.append({"n": n, "status": "scanned" if s else "missing", "draft_id": (s or {}).get("draft_id"),
                       "photo_url": (s or {}).get("photo_url"), "scanned_at": (s or {}).get("scanned_at")})
    scanned = sum(1 for s in sheets if s["status"] == "scanned")
    # playable as soon as sheet 1 onward is contiguous; publishing needs all k (remix/extend: missing sheets inherit)
    contiguous = 0
    for s in sheets:
        if s["status"] != "scanned":
            break
        contiguous += 1
    return {"pack_id": p["id"], "kind": p["kind"], "k": k, "game_id": p.get("game_id"), "parent_id": p.get("parent_id"),
            "pdf_url": pdf_url(p["id"]), "created_at": p.get("created_at"), "sheets": sheets, "scanned": scanned,
            "playable": contiguous >= 1, "complete": scanned == k or p["kind"] in ("remix", "extend") and scanned >= 1}


@router.get("/templates/pack/{pack_id}.pdf")
async def pack_pdf(pack_id: str) -> Any:
    if not PACK_ID.match(pack_id):
        return err(404, "error.not_found", {"what": "pack"})
    p = db_v2.get_pack(pack_id)
    if p is None:
        return err(404, "error.not_found", {"what": "pack"})
    cached = packs_dir() / f"{pack_id}.pdf"
    if cached.exists():
        return _pdf(cached.read_bytes(), f"draw-a-level-{pack_id}.pdf")
    try:
        from app.cv.scan_v2 import PackInfo
        from app.template.generate_v2 import make_pack_pdf
    except Exception as e:  # noqa: BLE001
        log.warning("pack PDF generator unavailable: %s", e)
        return err(501, "error.not_implemented", {"route": "GET /api/v2/templates/pack"})
    parent = None
    if p.get("parent_id"):
        row = db_v2.get_level_row(str(p["parent_id"]))
        parent = (row or {}).get("level")
    info = PackInfo(pack_id=p["id"], kind=p["kind"], k=int(p["k"]), game_id=p.get("game_id"), parent_id=p.get("parent_id"))
    try:
        data = await asyncio.to_thread(make_pack_pdf, info, parent)
    except Exception as e:  # noqa: BLE001
        log.warning("pack PDF %s failed: %s", pack_id, e)
        return err(500, "error.build_failed", {"why": "pdf"})
    tmp = cached.with_suffix(".tmp")
    tmp.write_bytes(data)
    tmp.replace(cached)
    return _pdf(data, f"draw-a-level-{pack_id}.pdf")


async def _game_pdf(fn_name: str, game_id: str, *, with_types: bool) -> Any:
    if not GAME_ID.match(game_id or ""):
        return err(400, "error.bad_request", {"field": "game"})
    g = db_v2.get_game(game_id)
    if g is None or g.get("format") != 2:
        return err(404, "error.not_found", {"what": "game"})
    fn = lane_c(fn_name)
    if fn is None:
        return err(501, "error.not_implemented", {"route": f"GET /api/v2/templates/{fn_name}"})
    try:
        if with_types:
            data = await asyncio.to_thread(lambda: fn(game_id, db_v2.library_latest(game_id), title=g.get("title")))
        else:
            data = await asyncio.to_thread(lambda: fn(game_id, current=g.get("rules"), title=g.get("title")))
    except Exception as e:  # noqa: BLE001
        log.warning("%s(%s) failed: %s", fn_name, game_id, e)
        return err(500, "error.build_failed", {"why": "pdf"})
    return _pdf(data, f"draw-a-level-{'library' if with_types else 'rules'}-{game_id}.pdf")


@router.get("/templates/rules.pdf")
async def rules_pdf(game: str = Query(default="")) -> Any:
    return await _game_pdf("make_rules_pdf", game, with_types=False)


@router.get("/templates/library.pdf")
async def library_pdf(game: str = Query(default="")) -> Any:
    return await _game_pdf("make_library_pdf", game, with_types=True)
