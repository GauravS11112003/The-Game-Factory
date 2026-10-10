"""Every §11.3(e) route that is not live yet answers 501 with a message key (never a raw code in the UI)."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

# (method, path) for every §11.3(e) endpoint except /health, POST /builds, GET /builds/{id}/events, GET /drafts/{id}.
NOT_YET: list[tuple[str, str]] = [
    ("PUT", "/drafts/{draft_id}/edits"),
    ("POST", "/drafts/{draft_id}/answers"),
    ("POST", "/drafts/{draft_id}/dial"),
    ("POST", "/drafts/{draft_id}/redesign"),
    ("POST", "/drafts/{draft_id}/critic"),
    ("POST", "/levels"),
    ("GET", "/levels/{level_id}"),
    ("GET", "/levels/{level_id}/tree"),
    ("POST", "/levels/{level_id}/moderate"),
    ("POST", "/levels/{level_id}/runs"),
    ("GET", "/levels/{level_id}/runs"),
    ("GET", "/runs/{run_id}"),
    ("POST", "/levels/{level_id}/attempts"),
    ("PUT", "/levels/{level_id}/thumbnail"),
    ("GET", "/levels/{level_id}/export"),
    ("GET", "/games"),
    ("POST", "/games"),
    ("GET", "/games/{game_id}"),
    ("GET", "/games/{game_id}/rules"),
    ("PUT", "/games/{game_id}/rules"),
    ("POST", "/games/{game_id}/rules/check"),
    ("GET", "/games/{game_id}/library"),
    ("POST", "/games/{game_id}/library"),
    ("GET", "/games/{game_id}/export"),
    ("POST", "/scan/rules-sheet"),
    ("POST", "/scan/library-sheet"),
    ("GET", "/library/{type_id}"),
    ("POST", "/library/{type_id}/versions"),
    ("POST", "/library/interpret"),
    ("POST", "/prompt-levels"),
    ("POST", "/packs"),
    ("GET", "/packs/{pack_id}"),
    ("GET", "/templates/pack/{pack_id}.pdf"),
    ("GET", "/templates/rules.pdf"),
    ("GET", "/templates/library.pdf"),
    ("POST", "/import"),
]


def _make(method: str, path: str):  # noqa: ANN202
    async def not_implemented() -> JSONResponse:
        return JSONResponse(
            {"message_key": "error.not_implemented", "args": {"route": f"{method} /api/v2{path}"}}, status_code=501,
        )

    not_implemented.__name__ = f"v2_{method.lower()}_{path.strip('/').replace('/', '_').replace('{', '').replace('}', '').replace('.', '_')}"
    return not_implemented


for _method, _path in NOT_YET:
    router.add_api_route(_path, _make(_method, _path), methods=[_method], status_code=501, include_in_schema=True)
