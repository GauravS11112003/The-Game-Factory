"""Template PDF endpoints (PLAN.md section 9). Owned by lane D (Backend + UI); rendering is lane A's app.template.generate.

GET /api/templates/blank.pdf?game_id=      -> PDF (QR dal1|blank or dal1|game|<id>)
GET /api/templates/remix/{level_id}.pdf    -> PDF with the gray overlay (QR dal1|lvl|<id>)

While the generator is a stub both answer 503 with a JSON detail.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlmodel import Session

from app.config import get_settings
from app.db import get_game, get_level, get_session
from app.template.generate import render_blank, render_remix, to_pdf_bytes

router = APIRouter(prefix="/api", tags=["templates"])

NOT_READY = "Printable sheets are not ready yet: the template generator is not implemented"


def _pdf_response(pdf: bytes, filename: str) -> Response:
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


def _local_path_for(url: str | None) -> str | None:
    """Map a public /uploads/... URL back to the file on disk, or None when it is not ours."""
    if not url:
        return None
    settings = get_settings()
    prefix = settings.public_uploads.rstrip("/") + "/"
    if not url.startswith(prefix):
        return None
    path = Path(settings.uploads_dir / url[len(prefix) :]).resolve()
    if settings.uploads_dir.resolve() not in path.parents or not path.is_file():
        return None
    return str(path)


@router.get("/templates/blank.pdf")
def blank_pdf(game_id: str | None = None, session: Session = Depends(get_session)) -> Response:
    game_id = (game_id or "").strip() or None
    if game_id and get_game(session, game_id) is None:
        raise HTTPException(status_code=404, detail="Game not found")
    payload = f"dal1|game|{game_id}" if game_id else "dal1|blank"
    try:
        pdf = to_pdf_bytes(render_blank(payload))
    except NotImplementedError as exc:
        raise HTTPException(status_code=503, detail=NOT_READY) from exc
    name = f"draw-a-level-{game_id}.pdf" if game_id else "draw-a-level-blank.pdf"
    return _pdf_response(pdf, name)


@router.get("/templates/remix/{level_id}.pdf")
def remix_pdf(level_id: str, session: Session = Depends(get_session)) -> Response:
    level = get_level(session, level_id)
    if level is None:
        raise HTTPException(status_code=404, detail="Level not found")
    try:
        pdf = to_pdf_bytes(render_remix(level, _local_path_for(level.source.backdrop_url)))
    except NotImplementedError as exc:
        raise HTTPException(status_code=503, detail=NOT_READY) from exc
    return _pdf_response(pdf, f"remix-{level_id}.pdf")
