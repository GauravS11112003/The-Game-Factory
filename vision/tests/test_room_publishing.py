"""A local invitation must upload its pinned build before it can be shared remotely."""
import hashlib
import json
import secrets
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from app import config, db_v2, play_rooms as rooms, room_publishing as publishing
from app.build import imagine
from app.routers.v2 import play_rooms as routes, matches

@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv('DAL_DATA_DIR', str(tmp_path))
    monkeypatch.setenv('DAL_REMOTE_PUBLISH_SECRET', 'owner-upload-secret')
    monkeypatch.delenv('DAL_REMOTE_PUBLIC_URL', raising=False)
    config.get_settings.cache_clear()
    monkeypatch.setattr(db_v2, 'db_path', lambda: tmp_path / 'dal.sqlite')
    app = FastAPI(); app.include_router(routes.router, prefix='/api/v2'); app.include_router(matches.router, prefix='/api/v2')
    spec = {'version': 1, 'mode': 'versus', 'actions': [{'id': 'right', 'label': 'Move'}]}
    html = '<html><script>window.drawPlayMultiplayer={version:1};</script>' + 'a' * 1000 + '</html>'
    yield TestClient(app), spec, html, tmp_path
    config.get_settings.cache_clear()

def test_import_is_private_idempotent_and_keeps_artwork_and_local_games(setup):
    client, spec, html, _ = setup
    old = {'draft_id': 'd_12345678', 'status': 'ready', 'title': 'Existing', 'multiplayer': True, 'multiplayer_spec': spec}
    imagine.save(old['draft_id'], old)
    painted = html.replace('<script>', '<script id="draw-play-art">' + 'a' * 310000 + '</script><script>', 1)
    body = {'title': 'My new game', 'spec': spec, 'html': painted, 'request_key': hashlib.sha256(b'build').hexdigest()}
    assert client.post('/api/v2/play-rooms/import', json=body).status_code == 403
    headers = {'X-Draw-Play-Publish': 'owner-upload-secret'}
    response = client.post('/api/v2/play-rooms/import', json=body, headers=headers)
    assert response.status_code == 201
    created = response.json()
    assert created['match']['draft_id'] != old['draft_id'] and not created['match']['players']
    assert imagine.read(old['draft_id'])['title'] == 'Existing'
    assert imagine.artifact_path(created['match']['draft_id']).read_text() == painted
    assert rooms.artifact_path(created['match']['id']).read_text() == painted
    repeated = client.post('/api/v2/play-rooms/import', json=body, headers=headers).json()
    assert repeated['invite'] == created['invite'] and repeated['match']['id'] == created['match']['id']
    # The bot's existing play <draft-id> path can create a fresh card with both seats open.
    assert rooms.create(created['match']['draft_id'], reserve_host=False)['match']['players'] == []

def test_import_rejects_invalid_adapters_specs_and_large_payloads(setup):
    client, spec, html, _ = setup
    headers = {'X-Draw-Play-Publish': 'owner-upload-secret'}
    body = {'title': 'New', 'spec': spec, 'html': html, 'request_key': 'a' * 64}
    assert client.post('/api/v2/play-rooms/import', json=body | {'html': html.replace('drawPlayMultiplayer','other')}, headers=headers).status_code == 422
    assert client.post('/api/v2/play-rooms/import', json=body | {'spec': spec | {'version': 2}}, headers=headers).status_code == 422
    assert client.post('/api/v2/play-rooms/import', content='x' * (publishing.MAX_BUILD_BYTES + 1_000_001), headers=headers).status_code == 413

def test_only_host_can_publish_and_receipt_is_cached_without_leaking_key(setup, monkeypatch):
    client, spec, html, tmp = setup
    private = tmp / 'messaging' / 'publishing.json'; private.parent.mkdir()
    private.write_text(json.dumps({'public_url': 'https://games.example', 'secret': 'private-deploy-key', 'imessage_number': '+15551234567'}))
    state = {'draft_id': 'd_12345678', 'status': 'ready', 'title': 'New', 'multiplayer': True, 'multiplayer_spec': spec}
    imagine.save(state['draft_id'], state)
    path = imagine.artifact_path(state['draft_id']);path.parent.mkdir(parents=True);path.write_text(html)
    created = rooms.create(state['draft_id']); room_id = created['match']['id']
    guest = rooms.join(room_id, created['invite'], 'Friend', secrets.token_urlsafe(32))
    calls = []
    remote = {'match': {'id': 'room_' + 'b' * 24, 'draft_id': 'd_87654321'}, 'invite': 'i' * 43}
    def send(url, secret, payload):
        calls.append((url, secret, payload));return publishing.links(remote, url)
    monkeypatch.setattr(publishing, 'send_build', send)
    endpoint = f'/api/v2/play-rooms/{room_id}/publish'
    assert client.post(endpoint).status_code == 403
    assert client.post(endpoint, headers={'Authorization': 'Bearer ' + guest['token']}).status_code == 403
    headers = {'Authorization': 'Bearer ' + created['token']}
    result = client.post(endpoint, headers=headers)
    assert result.status_code == 200 and result.json()['card_url'].startswith('https://games.example/')
    assert client.post(endpoint, headers=headers).json() == result.json() and len(calls) == 1
    assert calls[0][2]['html'] == html
    exposed = client.get('/api/v2/matches/config').text + result.text
    assert 'private-deploy-key' not in exposed and 'local_publishing' in exposed

def test_publishing_never_accepts_insecure_or_credential_urls(setup, monkeypatch):
    for url in ['http://localhost:8000', 'https://owner:secret@games.example', 'https://games.example?token=a', 'https://games.example/path']:
        monkeypatch.setenv('DAL_REMOTE_PUBLIC_URL', url)
        assert publishing.client_configuration()['local_publishing'] is False
