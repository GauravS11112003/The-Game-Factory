"""Session, migration, CSRF and callback boundaries for ordinary Auth0 accounts."""
import asyncio
import time
from types import SimpleNamespace

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app import auth
from app.collab import db, identity
from app.config import get_settings


@pytest.fixture
def client(tmp_path, monkeypatch):
    oauth_cache = auth.oauth_client
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("AUTH0_DOMAIN", "tenant.auth0.com")
    monkeypatch.setenv("AUTH0_CLIENT_ID", "test-client")
    monkeypatch.setenv("AUTH0_CLIENT_SECRET", "test-client-secret")
    monkeypatch.setenv("AUTH0_SESSION_SECRET", "s" * 48)
    monkeypatch.setenv("AUTH0_BASE_URL", "http://localhost:5173")
    auth.settings.cache_clear()
    oauth_cache.cache_clear()
    get_settings.cache_clear()
    from app.db import get_engine
    get_engine()
    app = FastAPI()

    @app.post("/api/v2/games")
    def create(request: Request):
        return {"player": identity.player_from_request(request)}

    @app.post("/api/v2/levels/test/runs")
    def run():
        return {"ok": True}

    from app.routers.v2.games import create_game
    app.post("/api/v2/games/new")(create_game)

    auth.install(app)
    with TestClient(app, base_url="http://localhost:5173", follow_redirects=False) as c:
        yield c
    auth.settings.cache_clear()
    oauth_cache.cache_clear()
    get_settings.cache_clear()


def login_cookie(client, subject="auth0|one"):
    player = auth._account(subject, "Maker")
    token = auth._issue_session(player["id"])
    client.cookies.set(auth.COOKIE, token)
    return player, token


def test_session_is_private_and_only_stores_a_hash(client):
    player, token = login_cookie(client)
    r = client.get("/api/auth/session")
    assert r.json() == {"enabled": True, "player": player}
    assert r.headers["cache-control"] == "no-store"
    row = db.row("SELECT * FROM auth_sessions")
    assert row["token_hash"] != token
    assert auth._hash(token) == row["token_hash"]


def test_expired_and_tampered_sessions_cannot_write(client):
    _, token = login_cookie(client)
    db.execute("UPDATE auth_sessions SET expires_at = ?", (time.time() - 1,))
    assert client.post("/api/v2/games", headers={"X-DP-CSRF": "1"}).status_code == 401
    client.cookies.set(auth.COOKIE, token + "x")
    assert client.get("/api/auth/session").json()["player"] is None


def test_public_play_is_available_but_creation_requires_login(client):
    assert client.post("/api/v2/levels/test/runs").status_code == 200
    assert client.post("/api/v2/games", headers={"X-DP-CSRF": "1"}).status_code == 401
    player, _ = login_cookie(client)
    assert client.post("/api/v2/games", headers={"X-DP-CSRF": "1"}).json()["player"] == player


def test_legacy_header_does_not_bypass_auth0(client):
    player, token = identity.create_player("Legacy")
    headers = {identity.HEADER: f"{player['id']}.{token}", "X-DP-CSRF": "1"}
    assert client.post("/api/v2/games", headers=headers).status_code == 401


def test_new_game_belongs_to_the_verified_account(client):
    from app.collab import members
    player, _ = login_cookie(client)
    r = client.post("/api/v2/games/new", headers={"X-DP-CSRF": "1"},
                    json={"title": "My game", "author": "Someone else"})
    assert r.status_code == 201
    game = r.json()["game"]
    assert game["author"] == player["name"]
    assert members.owner_of(game["id"]) == player["id"]


def test_cross_site_requests_and_missing_csrf_are_rejected(client):
    login_cookie(client)
    assert client.post("/api/v2/games").status_code == 403
    assert client.post("/api/auth/logout", headers={"Origin": "https://evil.example", "X-DP-CSRF": "1"}).status_code == 403
    assert client.post("/api/v2/games", headers={"Origin": "http://localhost:5173"}).status_code == 200


def test_logout_revokes_the_server_session(client):
    _, token = login_cookie(client)
    r = client.post("/api/auth/logout", headers={"X-DP-CSRF": "1"})
    assert r.status_code == 200
    assert "tenant.auth0.com/v2/logout" in r.json()["logout_url"]
    assert db.row("SELECT * FROM auth_sessions WHERE token_hash = ?", (auth._hash(token),)) is None
    assert client.get("/api/auth/session").json()["player"] is None


def test_subject_mapping_survives_repeated_login_and_does_not_match_names(client):
    first = auth._account("auth0|one", "Same name")
    second = auth._account("auth0|two", "Same name")
    assert first["id"] != second["id"]
    assert auth._account("auth0|one", "New name")["id"] == first["id"]


def test_legacy_link_preserves_profile_and_prevents_reassignment(client):
    player, _ = identity.create_player("Legacy")
    assert auth._account("auth0|one", "New name", player["id"])["id"] == player["id"]
    with pytest.raises(ValueError):
        auth._account("auth0|two", "Other", player["id"])


def test_prepare_requires_valid_device_proof_and_safe_return_route(client, monkeypatch):
    player, token = identity.create_player("Legacy")
    client.post("/api/auth/prepare", headers={"X-DP-CSRF": "1", identity.HEADER: f"{player['id']}.{token}"},
                json={"return_to": "https://evil.example"})
    async def access_token(request):
        return {"userinfo": {"sub": "auth0|one", "name": "New"}}
    monkeypatch.setattr(auth, "oauth_client", lambda: SimpleNamespace(authorize_access_token=access_token))
    r = client.get("/api/auth/callback")
    assert r.headers["location"] == "http://localhost:5173/#/studio"
    assert client.get("/api/auth/session").json()["player"]["id"] == player["id"]
    cookie = r.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=lax" in cookie


def test_callback_error_does_not_issue_session(client, monkeypatch):
    async def bad_token(request):
        raise ValueError("invalid_token")
    monkeypatch.setattr(auth, "oauth_client", lambda: SimpleNamespace(authorize_access_token=bad_token))
    r = client.get("/api/auth/callback?state=bad&code=bad")
    assert "auth_error=1" in r.headers["location"]
    assert auth.COOKIE not in client.cookies


def test_real_oauth_callback_rejects_missing_state(client):
    r = client.get("/api/auth/callback?state=forged&code=forged")
    assert "auth_error=1" in r.headers["location"]
    assert auth.COOKIE not in client.cookies


@pytest.mark.parametrize("bad_claim", [None, "iss", "aud", "exp", "nonce", "signature"])
def test_oidc_validation_checks_signature_issuer_audience_expiry_and_nonce(client, monkeypatch, bad_claim):
    from joserfc import jwt
    from joserfc.jwk import RSAKey
    key = RSAKey.generate_key(2048)
    signing_key = RSAKey.generate_key(2048) if bad_claim == "signature" else key
    provider = auth.oauth_client()
    async def metadata():
        return {"issuer": "https://tenant.auth0.com/", "id_token_signing_alg_values_supported": ["RS256"]}
    async def jwks(**kwargs):
        return {"keys": [{**key.as_dict(private=False), "kid": "test"}]}
    monkeypatch.setattr(provider, "load_server_metadata", metadata)
    monkeypatch.setattr(provider, "fetch_jwk_set", jwks)
    claims = {"sub": "auth0|one", "iss": "https://tenant.auth0.com/", "aud": "test-client",
              "exp": int(time.time()) + 300, "iat": int(time.time()), "nonce": "expected"}
    if bad_claim in {"iss", "aud", "nonce"}:
        claims[bad_claim] = "wrong"
    elif bad_claim == "exp":
        claims["exp"] = int(time.time()) - 300
    token = {"id_token": jwt.encode({"alg": "RS256", "kid": "test"}, claims, signing_key)}
    if bad_claim:
        with pytest.raises(Exception):
            asyncio.run(provider.parse_id_token(token, nonce="expected", leeway=0))
    else:
        assert asyncio.run(provider.parse_id_token(token, nonce="expected", leeway=0))["sub"] == "auth0|one"


def test_incomplete_config_and_insecure_production_origin_fail_closed(client, monkeypatch):
    monkeypatch.setenv("AUTH0_CLIENT_SECRET", "")
    auth.settings.cache_clear()
    with pytest.raises(RuntimeError):
        auth.settings()
    monkeypatch.setenv("AUTH0_CLIENT_SECRET", "secret")
    monkeypatch.setenv("AUTH0_BASE_URL", "http://example.com")
    auth.settings.cache_clear()
    with pytest.raises(RuntimeError):
        auth.settings()
