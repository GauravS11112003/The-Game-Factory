"""API v2 with TestClient (PLAN_V2 §11.3e, P0 gate): health, the guarded mount, the SSE sample replay with
Last-Event-ID resume, the polling fallback and 501 stubs. v1 /api/health keeps answering."""
from __future__ import annotations

import importlib
import os
from pathlib import Path
from typing import Iterator

import pytest
from fastapi.testclient import TestClient


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    os.environ["DAL_DATA_DIR"] = str(tmp_path_factory.mktemp("dal_v2"))
    os.environ.pop("ANTHROPIC_API_KEY", None)
    from app import config, db

    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()
    db._engine_for.cache_clear()
    main = importlib.reload(importlib.import_module("app.main"))
    with TestClient(main.create_app()) as c:
        yield c


def _events(text: str) -> list[tuple[int, str]]:
    out = []
    for block in text.strip().split("\n\n"):
        fields = dict(line.split(": ", 1) for line in block.splitlines() if ": " in line and not line.startswith(":"))
        if "event" in fields:
            out.append((int(fields["id"]), fields["event"]))
    return out


def test_v1_health_still_answers(client: TestClient) -> None:
    assert client.get("/api/health").json()["ok"] is True


def test_v2_health(client: TestClient) -> None:
    h = client.get("/api/v2/health").json()
    assert h["ok"] is True and h["worker"] == "ok" and h["core_version"] == "2.0.0"
    assert h["llm"] == "off" and h["budget_left_usd"] > 0


def test_build_streams_the_sample_and_resumes(client: TestClient) -> None:
    r = client.post("/api/v2/builds", files={"ink": ("ink.json", b"{}", "application/json")})
    assert r.status_code == 202
    b = r.json()
    with client.stream("GET", b["events_url"]) as s:
        assert s.headers["content-type"].startswith("text/event-stream")
        assert s.headers["cache-control"] == "no-cache" and s.headers["x-accel-buffering"] == "no"
        events = _events("".join(s.iter_text()))
    assert events[0] == (1, "hello") and events[-1][1] == "done"
    assert [i for i, _ in events] == list(range(1, len(events) + 1))
    assert {e for _, e in events} >= {"hello", "stage", "ink", "saw", "edits", "tier", "ask", "note", "suggestions",
                                      "cost", "warning", "error", "done"}
    with client.stream("GET", b["events_url"], headers={"Last-Event-ID": str(len(events) - 3)}) as s:
        tail = _events("".join(s.iter_text()))
    assert [i for i, _ in tail] == [len(events) - 2, len(events) - 1, len(events)]
    poll = client.get(f"/api/v2/drafts/{b['draft_id']}", params={"since": len(events) - 1}).json()
    assert poll["state"] == "done" and [e["seq"] for e in poll["events"]] == [len(events)]
    full = client.get(f"/api/v2/drafts/{b['draft_id']}").json()
    assert len(full["events"]) == len(events)
    hello = full["events"][0]["data"]
    assert hello["build_id"] == b["build_id"] and hello["draft_id"] == b["draft_id"]
    assert Path(os.environ["DAL_DATA_DIR"], "uploads", "drafts", b["draft_id"], "events.jsonl").exists()


def test_unknown_build_and_draft_are_404(client: TestClient) -> None:
    assert client.get("/api/v2/builds/b_00000000/events").status_code == 404
    assert client.get("/api/v2/builds/../../etc/events").status_code == 404
    assert client.get("/api/v2/drafts/d_00000000").status_code == 404


@pytest.mark.parametrize("method,path", [("PUT", "/api/v2/drafts/d_12345678/edits"), ("POST", "/api/v2/levels"),
                                         ("GET", "/api/v2/games"), ("GET", "/api/v2/templates/pack/p1.pdf"),
                                         ("POST", "/api/v2/import")])
def test_not_yet_routes_answer_501_with_a_message_key(client: TestClient, method: str, path: str) -> None:
    r = client.request(method, path)
    assert r.status_code == 501
    assert r.json()["message_key"] == "error.not_implemented"
