"""Shared-world rooms pin builds and enforce seats, capabilities and round transitions."""
import json
import secrets
import time
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from app import config, db_v2, play_rooms as rooms
from app.build import imagine
from app.routers.v2 import play_rooms as routes

@pytest.fixture
def game(tmp_path, monkeypatch):
    monkeypatch.setenv('DAL_DATA_DIR', str(tmp_path))
    config.get_settings.cache_clear()
    monkeypatch.setattr(db_v2, 'db_path', lambda: tmp_path / 'dal.sqlite')
    state = {'draft_id': 'd_12345678', 'status': 'ready', 'title': 'New Duel', 'multiplayer': True,
             'multiplayer_spec': {'version': 1, 'mode': 'versus', 'actions': [{'id': 'right', 'label': 'Move'}, {'id': 'attack', 'label': 'Fire'}]}}
    imagine.save(state['draft_id'], state)
    path = imagine.artifact_path(state['draft_id'])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text('<html>original playable build</html>')
    yield state
    config.get_settings.cache_clear()

def seats(game):
    created = rooms.create(game['draft_id'])
    room_id = created['match']['id']
    guest = rooms.join(room_id, created['invite'], 'Friend', secrets.token_urlsafe(32))
    rooms.connect(room_id, created['token'], 'host')
    rooms.connect(room_id, guest['token'], 'guest')
    return room_id, created, guest

def play(room_id, host, guest):
    rooms.stream(room_id, host, 'host', {'type': 'ready', 'round': 1})
    state = rooms.stream(room_id, guest, 'guest', {'type': 'ready', 'round': 1})
    assert state['phase'] == 'countdown'
    with rooms.transaction() as conn:
        room = rooms.load(conn, room_id)
        room['start_at'] = time.time() - 1
        rooms.save(conn, room)
    assert rooms.stream(room_id, host, 'host')['phase'] == 'playing'

def test_pin_exact_build_and_hide_tickets(game):
    created = rooms.create(game['draft_id'])
    imagine.artifact_path(game['draft_id']).write_text('edited later')
    assert rooms.artifact_path(created['match']['id']).read_text() == '<html>original playable build</html>'
    public = json.dumps(created['match'])
    assert created['token'] not in public and created['invite'] not in public
    with pytest.raises(HTTPException) as denied:
        rooms.snapshot(created['match']['id'], invite='wrong')
    assert denied.value.status_code == 403

def test_idempotent_join_two_seats_and_bot_creation(game):
    created = rooms.create(game['draft_id'], reserve_host=False, request_key='test-bot-command')
    assert created['match']['players'] == [] and created['token'] is None
    assert rooms.create(game['draft_id'], reserve_host=False, request_key='test-bot-command')['invite'] == created['invite']
    claim = secrets.token_urlsafe(32)
    first = rooms.join(created['match']['id'], created['invite'], 'One', claim)
    assert rooms.join(created['match']['id'], created['invite'], 'One', claim)['token'] == first['token']
    second = rooms.join(created['match']['id'], created['invite'], 'Two', secrets.token_urlsafe(32))
    assert [first['seat'], second['seat']] == [0, 1]
    with pytest.raises(HTTPException) as full:
        rooms.join(created['match']['id'], created['invite'], 'Three', secrets.token_urlsafe(32))
    assert full.value.status_code == 409

def test_inputs_are_derived_from_authenticated_seat_and_world_is_host_only(game):
    room_id, host, guest = seats(game)
    play(room_id, host['token'], guest['token'])
    state = rooms.stream(room_id, guest['token'], 'guest', {'type': 'input', 'round': 1, 'seat': 0, 'actions': ['right']})
    assert state['inputs'] == [[], ['right']]
    for message, status in [({'type': 'world', 'world': {'x': 99}}, 403), ({'type': 'finish', 'result': {'winner': 1}}, 403), ({'type': 'input', 'actions': ['delete']}, 400)]:
        with pytest.raises(HTTPException) as denied:
            rooms.stream(room_id, guest['token'], 'guest', message | {'round': 1})
        assert denied.value.status_code == status
    state = rooms.stream(room_id, host['token'], 'host', {'type': 'world', 'round': 1, 'world': {'characters': [3, 7]}})
    assert state['world_seq'] == 1 and state['world']['characters'] == [3, 7]
    with pytest.raises(HTTPException) as too_big:
        rooms.stream(room_id, host['token'], 'host', {'type': 'world', 'round': 1, 'world': {'data': 'x' * 49000}})
    assert too_big.value.status_code == 413

def test_pause_resume_checkpoint_and_replaced_socket(game):
    room_id, host, guest = seats(game)
    play(room_id, host['token'], guest['token'])
    rooms.stream(room_id, host['token'], 'host', {'type': 'world', 'round': 1, 'world': {'x': 8}})
    rooms.disconnect(room_id, guest['token'], 'guest')
    state = rooms.stream(room_id, host['token'], 'host')
    assert state['phase'] == 'paused' and state['world'] == {'x': 8} and state['inputs'] == [[], []]
    rooms.connect(room_id, guest['token'], 'guest-new')
    with pytest.raises(HTTPException):
        rooms.stream(room_id, guest['token'], 'guest', {'type': 'ping', 'round': 1})
    rooms.disconnect(room_id, guest['token'], 'guest') # Old close cannot evict a replacement.
    state = rooms.stream(room_id, guest['token'], 'guest-new', {'type': 'ready', 'round': 1})
    assert state['phase'] == 'countdown' and state['world'] == {'x': 8}

def test_results_and_rematch_require_current_round(game):
    room_id, host, guest = seats(game)
    play(room_id, host['token'], guest['token'])
    state = rooms.stream(room_id, host['token'], 'host', {'type': 'finish', 'round': 1, 'result': {'winner': 1, 'scores': [2, 5], 'text': 'Friend wins!'}})
    assert state['phase'] == 'finished' and state['winner'] == 1
    rooms.stream(room_id, host['token'], 'host', {'type': 'rematch', 'round': 1})
    state = rooms.stream(room_id, guest['token'], 'guest', {'type': 'rematch', 'round': 1})
    assert state['round'] == 2 and state['phase'] == 'waiting' and state['world'] is None
    assert not any(p['ready'] or p['rematch'] for p in state['players'])
    with pytest.raises(HTTPException) as stale:
        rooms.stream(room_id, host['token'], 'host', {'type': 'world', 'round': 1, 'world': {}})
    assert stale.value.status_code == 409

def test_endpoint_artifact_requires_ticket_and_socket_auth(game):
    app = FastAPI(); app.include_router(routes.router, prefix='/api/v2')
    with TestClient(app) as client:
        response = client.post('/api/v2/play-rooms', json={'draft_id': game['draft_id']})
        assert response.status_code == 201
        created = response.json(); room_id = created['match']['id']
        assert client.get(f'/api/v2/play-rooms/{room_id}/game').status_code == 403
        artifact = client.get(f'/api/v2/play-rooms/{room_id}/game', headers={'Authorization': f"Bearer {created['token']}"})
        assert "connect-src 'none'" in artifact.headers['content-security-policy']
        assert client.get(created['card_url']).status_code == 200
        assert 'surface=messages' in client.get(created['card_url']).text
        with client.websocket_connect(f'/api/v2/play-rooms/{room_id}/socket') as ws:
            ws.send_json({'type': 'auth', 'token': created['token']})
            assert ws.receive_json() == {'type': 'authenticated', 'seat': 0}
            ws.send_json({'type': 'ready', 'round': 1})
            assert ws.receive_json()['room']['players'][0]['ready']

def test_safari_handoff_preserves_seat_world_and_revokes_old_session(game):
    room_id, host, guest = seats(game)
    play(room_id, host['token'], guest['token'])
    rooms.stream(room_id, host['token'], 'host', {'type': 'world', 'round': 1, 'world': {'x': 8}})
    code = rooms.handoff(room_id, host['token'])['handoff']
    assert code not in json.dumps(rooms.snapshot(room_id, host['token']))
    claim = secrets.token_urlsafe(32)
    resumed = rooms.resume(room_id, code, claim)
    assert resumed['seat'] == 0 and len(resumed['match']['players']) == 2
    assert resumed['invite'] == host['invite']
    assert resumed['match']['phase'] == 'paused'
    assert rooms.join(room_id, host['invite'], 'Safari', claim)['token'] == resumed['token']
    with pytest.raises(HTTPException) as replay:
        rooms.resume(room_id, code, secrets.token_urlsafe(32))
    assert replay.value.status_code == 403
    with pytest.raises(HTTPException):
        rooms.connect(room_id, host['token'], 'old-host')
    rooms.connect(room_id, resumed['token'], 'safari')
    assert rooms.stream(room_id, resumed['token'], 'safari')['world'] == {'x': 8}

def test_safari_handoff_requires_membership_and_expires(game, monkeypatch):
    app = FastAPI(); app.include_router(routes.router, prefix='/api/v2')
    created = rooms.create(game['draft_id'])
    room_id = created['match']['id']
    with TestClient(app) as client:
        assert client.post(f'/api/v2/play-rooms/{room_id}/handoff').status_code == 403
        result = client.post(f'/api/v2/play-rooms/{room_id}/handoff', headers={'Authorization': f"Bearer {created['token']}"})
        assert result.status_code == 200
        future = time.time() + 121
        monkeypatch.setattr(rooms.time, 'time', lambda: future)
        expired = client.post(f'/api/v2/play-rooms/{room_id}/resume', json={'handoff': result.json()['handoff'], 'claim': secrets.token_urlsafe(32)})
        assert expired.status_code == 403
