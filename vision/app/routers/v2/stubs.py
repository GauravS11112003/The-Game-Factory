"""Every §11.3(e) route that is not live yet answers 501 with a message key (never a raw code in the UI)."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()

# (method, path) for every §11.3(e) endpoint not implemented yet. Each route that depends on another lane's part that
# is not there yet (lane C's sheet readers and rules/library PDFs, the core's layout_plan) answers its own 501 with
# error.not_implemented instead, so it starts working the moment that part lands.
NOT_YET: list[tuple[str, str]] = []  # every §11.3(e) route is live (lane D, wave 2)


def _make(method: str, path: str):  # noqa: ANN202
    async def not_implemented() -> JSONResponse:
        return JSONResponse(
            {"message_key": "error.not_implemented", "args": {"route": f"{method} /api/v2{path}"}}, status_code=501,
        )

    not_implemented.__name__ = f"v2_{method.lower()}_{path.strip('/').replace('/', '_').replace('{', '').replace('}', '').replace('.', '_')}"
    return not_implemented


for _method, _path in NOT_YET:
    router.add_api_route(_path, _make(_method, _path), methods=[_method], status_code=501, include_in_schema=True)
