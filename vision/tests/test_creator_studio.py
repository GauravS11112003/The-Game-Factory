"""The studio lists created or modified games, rather than the public feed."""
import sqlite3
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import db_v2
from app.collab import db, identity, members
from app.routers.v2 import games


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    path = tmp_path / 'studio.sqlite'
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE games (id TEXT PRIMARY KEY, title TEXT, author TEXT, created_at TEXT)')
        conn.execute('CREATE TABLE levels (id TEXT PRIMARY KEY, json TEXT)')
    monkeypatch.setattr(db_v2, 'db_path', lambda: path)
    app = FastAPI()
    app.include_router(games.router, prefix='/api/v2')
    return TestClient(app)


def create(client, author='Alice'):
    response = client.post('/api/v2/games', json={'title': f'{author} game', 'author': author})
    assert response.status_code == 201
    return response.json()['game']['id']


def listed(client, **params):
    response = client.get('/api/v2/games', params={'scope': 'mine', **params})
    assert response.status_code == 200
    assert response.json()['levels'] == []
    return {g['id']: g for g in response.json()['games']}


def profile():
    pid, token = 'pl_0123456789', 'studio_test_token_0123456789'
    db.execute('INSERT INTO players (id, name, token_hash, created_at) VALUES (?, ?, ?, ?)',
               (pid, 'Alice', identity.hash_token(token), db.now_iso()))
    return pid, {'X-DP-Player': f'{pid}.{token}'}


def test_empty_device_does_not_show_community_games(client):
    create(client)
    create(client, 'Bob')
    assert listed(client) == {}
    assert len(client.get('/api/v2/games').json()['games']) == 2


def test_anonymous_legacy_games_and_remembered_edits(client):
    mine, other, untouched = create(client), create(client, 'Bob'), create(client, 'Carol')
    result = listed(client, author='alice', ids=other)
    assert set(result) == {mine, other}
    assert result[mine]['studio_relation'] == 'created'
    assert result[other]['studio_relation'] == 'modified'
    assert untouched not in result


def test_contribution_beyond_feed_preview_is_included(client, monkeypatch):
    other = create(client, 'Bob')
    rows = [{'id': f'level_{i}', 'author': 'Alice' if i == 10 else 'Bob', 'order_index': i}
            for i in range(12)]
    original = db_v2.latest_level_summaries
    monkeypatch.setattr(db_v2, 'latest_level_summaries',
                        lambda **kw: rows if kw.get('game_id') == other else original(**kw))
    result = listed(client, author='Alice')
    assert result[other]['studio_relation'] == 'modified'
    assert result[other]['level_count'] == 12
    assert len(result[other]['levels']) == 8


def test_membership_alone_does_not_count_as_modification(client):
    other = create(client, 'Bob')
    pid, headers = profile()
    members.set_role(other, pid, 'maintainer')
    client.headers.update(headers)
    assert listed(client) == {}
    db.execute('INSERT INTO player_levels (level_id, player_id, game_id, created_at) VALUES (?, ?, ?, ?)',
               ('a_level', pid, other, db.now_iso()))
    assert listed(client)[other]['studio_relation'] == 'modified'


def test_authenticated_creation_assigns_owner_and_survives_rename(client):
    pid, headers = profile()
    client.headers.update(headers)
    mine = create(client)
    assert members.owner_of(mine) == pid
    db.execute('UPDATE players SET name = ? WHERE id = ?', ('Renamed', pid))
    assert listed(client)[mine]['studio_relation'] == 'created'


def test_seeded_games_are_not_claimed_by_matching_author_names(client):
    db_v2.create_game('game_world', 'Starter World', 'Alice', games.default_rules())
    assert listed(client, author='Alice') == {}
    assert listed(client, author='Alice', ids='game_world')['game_world']['studio_relation'] == 'modified'


def test_profile_name_does_not_override_another_players_ownership(client):
    other = create(client)
    pid, headers = profile()
    members.set_role(other, 'another_player', 'owner')
    client.headers.update(headers)
    assert listed(client, author='Alice') == {}


def test_invalid_scope_is_rejected(client):
    assert client.get('/api/v2/games?scope=unknown').status_code == 400
