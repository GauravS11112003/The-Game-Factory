"""Adobe IMS server-to-server access token (OAuth client credentials), cached until shortly before it expires.

Docs: https://developer.adobe.com/firefly-services/docs/firefly-api/guides/  (Quickstart, "Retrieve an access token")

    POST https://ims-na1.adobelogin.com/ims/token/v3
    Content-Type: application/x-www-form-urlencoded
    grant_type=client_credentials & client_id & client_secret
    & scope=openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis
    → {"access_token": "...", "token_type": "bearer", "expires_in": 86399}

The token and the secret are never logged or returned. A 401 from Firefly calls `invalidate()` and the caller retries
once with a fresh token.
"""
from __future__ import annotations

import asyncio
import hashlib
import time
from typing import Any

try:  # the venv ships httpx2 (anthropic's HTTP client); plain httpx when present
    import httpx  # type: ignore[import-not-found]
except ImportError:  # pragma: no cover
    import httpx2 as httpx  # type: ignore[no-redef]

IMS_TOKEN_URL = "https://ims-na1.adobelogin.com/ims/token/v3"
SCOPES = "openid,AdobeID,session,additional_info,read_organizations,firefly_api,ff_apis"
REFRESH_MARGIN_S = 300.0  # refresh 5 minutes before expiry
TIMEOUT_S = 20.0


class TokenError(Exception):
    def __init__(self, key: str, status: int | None = None) -> None:
        super().__init__(key)
        self.key = key
        self.status = status


class TokenCache:
    def __init__(self) -> None:
        self._token: str | None = None
        self._expires_at = 0.0  # time.monotonic()
        self._cred_key: str | None = None
        self._lock: asyncio.Lock | None = None
        self._loop: asyncio.AbstractEventLoop | None = None

    def _get_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._loop is not loop:
            self._lock, self._loop = asyncio.Lock(), loop
        return self._lock

    @staticmethod
    def _cred_fingerprint(client_id: str, client_secret: str) -> str:
        return hashlib.sha256(f"{client_id}\0{client_secret}".encode()).hexdigest()

    def invalidate(self) -> None:
        self._token, self._expires_at = None, 0.0

    async def get(self, client_id: str, client_secret: str, *, force: bool = False) -> str:
        key = self._cred_fingerprint(client_id, client_secret)
        if not force and self._token and self._cred_key == key and time.monotonic() < self._expires_at:
            return self._token
        async with self._get_lock():
            if not force and self._token and self._cred_key == key and time.monotonic() < self._expires_at:
                return self._token
            data = await _fetch(client_id, client_secret)
            tok = data.get("access_token")
            if not isinstance(tok, str) or not tok:
                raise TokenError("creative.firefly_auth")
            try:
                ttl = float(data.get("expires_in") or 3600)
            except (TypeError, ValueError):
                ttl = 3600.0
            self._token, self._cred_key = tok, key
            self._expires_at = time.monotonic() + max(60.0, ttl - REFRESH_MARGIN_S)
            return tok


async def _fetch(client_id: str, client_secret: str) -> dict[str, Any]:
    form = {"grant_type": "client_credentials", "client_id": client_id, "client_secret": client_secret,
            "scope": SCOPES}
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as http:
            r = await http.post(IMS_TOKEN_URL, data=form,
                                headers={"Content-Type": "application/x-www-form-urlencoded"})
    except httpx.HTTPError as e:
        raise TokenError("creative.firefly_unreachable") from e
    if r.status_code in (400, 401, 403):
        raise TokenError("creative.firefly_auth", r.status_code)
    if r.status_code >= 400:
        raise TokenError("creative.firefly_unreachable", r.status_code)
    try:
        body = r.json()
    except ValueError as e:
        raise TokenError("creative.firefly_auth", r.status_code) from e
    return body if isinstance(body, dict) else {}


CACHE = TokenCache()
