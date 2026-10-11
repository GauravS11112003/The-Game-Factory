"""Ordinary Auth0 login with opaque, revocable server sessions.

Auth0 tokens never reach JavaScript. Existing device profiles can be linked only
after proving possession of their device token and completing an Auth0 login.
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
import secrets
import time
from contextlib import closing
from dataclasses import dataclass
from functools import lru_cache
from urllib.parse import urlencode, urlsplit

from authlib.integrations.starlette_client import OAuth
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from app import db_v2
from app.collab import db, identity

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth")
COOKIE = "dp_session"
SESSION_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class AuthSettings:
    domain: str
    client_id: str
    client_secret: str
    session_secret: str
    base_url: str

    @property
    def enabled(self) -> bool:
        return bool(self.domain)

    @property
    def secure(self) -> bool:
        return self.base_url.startswith("https://")


@lru_cache(maxsize=1)
def settings() -> AuthSettings:
    values = [os.environ.get(k, "").strip() for k in (
        "AUTH0_DOMAIN", "AUTH0_CLIENT_ID", "AUTH0_CLIENT_SECRET", "AUTH0_SESSION_SECRET")]
    base = (os.environ.get("AUTH0_BASE_URL") or os.environ.get("DAL_PUBLIC_URL") or
            "http://localhost:5173").rstrip("/")
    if any(values):
        if not all(values) or len(values[3]) < 32:
            raise RuntimeError("Auth0 requires DOMAIN, CLIENT_ID, CLIENT_SECRET and a SESSION_SECRET of at least 32 characters")
        if not re.fullmatch(r"[a-zA-Z0-9.-]+", values[0]):
            raise RuntimeError("AUTH0_DOMAIN must be a hostname without https:// or a path")
        url = urlsplit(base)
        if url.scheme not in {"http", "https"} or not url.netloc or url.path or url.query or url.fragment or url.username:
            raise RuntimeError("AUTH0_BASE_URL must be an origin")
        if url.scheme == "http" and url.hostname not in {"localhost", "127.0.0.1"}:
            raise RuntimeError("Auth0 requires HTTPS outside localhost")
    return AuthSettings(*values, base)


@lru_cache(maxsize=1)
def oauth_client():
    s = settings()
    oauth = OAuth()
    return oauth.register(
        "auth0", client_id=s.client_id, client_secret=s.client_secret,
        server_metadata_url=f"https://{s.domain}/.well-known/openid-configuration",
        client_kwargs={"scope": "openid profile email", "code_challenge_method": "S256"},
    )


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def session_player(request):
    token = request.cookies.get(COOKIE, "")
    if not token or len(token) > 128:
        return None
    row = db.row("SELECT player_id FROM auth_sessions WHERE token_hash = ? AND expires_at > ?",
                 (_hash(token), time.time()))
    return identity.get_player(row["player_id"]) if row else None


def _account(subject: str, name: str, legacy_id: str | None = None):
    """Resolve by immutable OIDC subject; never link accounts by email or name."""
    db.ensure()
    with closing(db_v2.connect()) as conn, conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT player_id FROM auth_identities WHERE subject = ?", (subject,)).fetchone()
        if existing:
            return identity.get_player(existing["player_id"])
        if legacy_id:
            linked = conn.execute("SELECT subject FROM auth_identities WHERE player_id = ?", (legacy_id,)).fetchone()
            if linked:
                raise ValueError("profile_already_linked")
            player_id = legacy_id
        else:
            player_id = f"pl_{secrets.token_hex(5)}"
            try:
                clean = identity.clean_name(name)
            except identity.IdentityError:
                clean = "Player"
            conn.execute("INSERT INTO players (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)",
                         (player_id, clean, _hash(secrets.token_urlsafe(32)), db.now_iso()))
        conn.execute("INSERT INTO auth_identities (subject, player_id, created_at) VALUES (?, ?, ?)",
                     (subject, player_id, db.now_iso()))
    if not legacy_id:
        from app.collab import seed_owner
        seed_owner.on_player_created(player_id)
    return identity.get_player(player_id)


def _issue_session(player_id: str) -> str:
    token = secrets.token_urlsafe(32)
    db.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (time.time(),))
    db.execute("INSERT INTO auth_sessions (token_hash, player_id, expires_at) VALUES (?, ?, ?)",
               (_hash(token), player_id, time.time() + SESSION_SECONDS))
    return token


def _return_to(value: str) -> str:
    # The app uses hash routes. No arbitrary URLs or protocol-relative redirects.
    return value if value.startswith("/#/") and len(value) <= 2000 and not any(c in value for c in "\r\n\\") else "/#/studio"


@router.get("/session")
def get_session(request: Request):
    enabled = settings().enabled
    return JSONResponse({"enabled": enabled, "player": session_player(request) if enabled else None},
                        headers={"Cache-Control": "no-store"})


@router.post("/prepare")
async def prepare(request: Request):
    if not settings().enabled:
        return JSONResponse({"message_key": "auth.unavailable"}, status_code=503)
    try:
        body = await request.json()
        return_to = _return_to(str(body.get("return_to", "")))
    except (ValueError, AttributeError):
        return JSONResponse({"message_key": "error.bad_request"}, status_code=400)
    # The legacy header is accepted only here, as proof for migration.
    legacy = identity.player_from_token(request.headers.get(identity.HEADER))
    request.session.clear()
    request.session.update(return_to=return_to, legacy_id=legacy["id"] if legacy else None)
    return {"login_url": "/api/auth/login"}


@router.get("/login")
async def login(request: Request):
    if not settings().enabled:
        return JSONResponse({"message_key": "auth.unavailable"}, status_code=503)
    request.session.setdefault("return_to", "/#/studio")
    return await oauth_client().authorize_redirect(request, settings().base_url + "/api/auth/callback")


@router.get("/callback")
async def callback(request: Request):
    if not settings().enabled:
        return JSONResponse({"message_key": "auth.unavailable"}, status_code=503)
    return_to = _return_to(request.session.get("return_to", ""))
    legacy_id = request.session.get("legacy_id")
    try:
        # Authlib validates OAuth state and the ID token's signature, issuer,
        # audience, expiry and nonce before exposing userinfo.
        token = await oauth_client().authorize_access_token(request)
        user = token.get("userinfo")
        if not user or not isinstance(user.get("sub"), str) or not user["sub"]:
            raise ValueError("missing_subject")
        player = _account(user["sub"], user.get("nickname") or user.get("name") or "Player", legacy_id)
        session = _issue_session(player["id"])
    except Exception as error:
        # Never log codes, tokens, OAuth query strings or provider error descriptions.
        log.warning("Auth0 login failed (%s)", type(error).__name__)
        request.session.clear()
        return RedirectResponse(settings().base_url + "/?auth_error=1#/", status_code=303)
    request.session.clear()
    response = RedirectResponse(settings().base_url + return_to, status_code=303)
    response.set_cookie(COOKIE, session, max_age=SESSION_SECONDS, httponly=True,
                        secure=settings().secure, samesite="lax", path="/")
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/logout")
async def logout(request: Request):
    if not settings().enabled:
        return JSONResponse({"message_key": "auth.unavailable"}, status_code=503)
    token = request.cookies.get(COOKIE)
    if token:
        db.execute("DELETE FROM auth_sessions WHERE token_hash = ?", (_hash(token),))
    request.session.clear()
    s = settings()
    response = JSONResponse({"logout_url": f"https://{s.domain}/v2/logout?" + urlencode({
        "client_id": s.client_id, "returnTo": s.base_url})}, headers={"Cache-Control": "no-store"})
    response.delete_cookie(COOKIE, path="/", secure=s.secure, httponly=True, samesite="lax")
    return response


def _creator_write(path: str) -> bool:
    if path.startswith("/api/v2/"):
        tail = path.removeprefix("/api/v2/")
        if re.fullmatch(r"levels/[^/]+/(runs|attempts)", tail):
            return False
        return tail.split("/")[0] in {"games", "imagined-games", "builds", "drafts", "creative",
                                          "library", "prompt-levels", "scan", "packs", "import", "levels", "collab"}
    return path in {"/api/games", "/api/levels", "/api/scan"}


def install(app):
    s = settings()
    app.include_router(router)
    if not s.enabled:
        return
    app.add_middleware(SessionMiddleware, secret_key=s.session_secret, session_cookie="dp_oauth",
                       max_age=600, same_site="lax", https_only=s.secure)

    @app.middleware("http")
    async def protect(request: Request, call_next):
        if request.method not in {"GET", "HEAD", "OPTIONS"} and request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            cookie = request.cookies.get(COOKIE)
            auth_action = request.url.path.startswith("/api/auth/")
            creator = _creator_write(request.url.path)
            # A hostile site cannot send this custom header through our CORS
            # policy. Also reject explicit foreign origins, even with the header.
            if cookie or auth_action or creator:
                if (origin and origin != s.base_url) or (not origin and request.headers.get("X-DP-CSRF") != "1"):
                    return JSONResponse({"message_key": "auth.request_denied"}, status_code=403)
            if creator and not session_player(request):
                return JSONResponse({"message_key": "auth.sign_in_required"}, status_code=401)
        return await call_next(request)
