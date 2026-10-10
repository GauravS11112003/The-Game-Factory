"""Mind client (PLAN_V2 §3.10): MindResult never raises; refusal and max_tokens are checked before parsed_output;
529 retries once; no key / budget / deadline skip the call. Uses a fake Anthropic client (no network)."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import pytest

from app.mind import client as mind
from app.mind.schemas import Moderation


class FakeMessages:
    def __init__(self, outcomes: list[Any]) -> None:
        self.outcomes = outcomes
        self.calls: list[dict[str, Any]] = []

    async def parse(self, **kw: Any) -> Any:
        self.calls.append(kw)
        o = self.outcomes.pop(0)
        if isinstance(o, Exception):
            raise o
        return o


class FakeClient:
    def __init__(self, outcomes: list[Any]) -> None:
        self.beta = SimpleNamespace(messages=FakeMessages(outcomes))

    def with_options(self, **_: Any) -> "FakeClient":
        return self


def resp(stop: str, parsed: Any = None) -> Any:
    usage = SimpleNamespace(input_tokens=1000, output_tokens=200, cache_creation_input_tokens=0, cache_read_input_tokens=0,
                            iterations=None)
    return SimpleNamespace(stop_reason=stop, parsed_output=parsed, usage=usage, model="claude-opus-5", _request_id="req_1")


def status_error(code: int) -> anthropic.APIStatusError:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    return anthropic.APIStatusError("boom", response=httpx2.Response(code, request=request), body=None)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-not-a-key")
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    from app import config

    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()


def go(fake: FakeClient, monkeypatch: pytest.MonkeyPatch, deadline_s: float = 30) -> mind.MindResult[Moderation]:
    monkeypatch.setattr(mind, "_get_client", lambda: fake)
    return asyncio.run(mind.call("moderate", Moderation, [{"type": "text", "text": "hi"}], draft_id="d_00000001",
                                 deadline=time.monotonic() + deadline_s))


def test_ok(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = FakeClient([resp("end_turn", Moderation(safety="ok", reason=None))])
    r = go(fake, monkeypatch)
    assert r.status == "ok" and r.value and r.value.safety == "ok" and r.cost_usd == pytest.approx(0.01)
    kw = fake.beta.messages.calls[0]
    assert kw["model"] == "claude-opus-5" and kw["fallbacks"] == "default" and "thinking" not in kw
    assert kw["output_config"] == {"effort": "low"} and kw["betas"] == [mind.FALLBACK_BETA]


@pytest.mark.parametrize("stop,status", [("refusal", "refused"), ("max_tokens", "truncated")])
def test_stop_reason_checked_before_parsed_output(monkeypatch: pytest.MonkeyPatch, stop: str, status: str) -> None:
    r = go(FakeClient([resp(stop, Moderation(safety="ok", reason=None))]), monkeypatch)
    assert r.status == status and r.value is None


def test_529_retries_once_then_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    assert go(FakeClient([status_error(529), resp("end_turn", Moderation(safety="ok", reason=None))]), monkeypatch).ok
    r = go(FakeClient([status_error(529), status_error(529)]), monkeypatch)
    assert r.status == "failed" and "529" in (r.error or "")


def test_errors_never_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    request = httpx2.Request("POST", "https://api.anthropic.com/v1/messages")
    for exc in (anthropic.APITimeoutError(request=request), status_error(400), ValueError("bad"), RuntimeError("x")):
        assert go(FakeClient([exc]), monkeypatch).status == "failed"
    assert go(FakeClient([resp("end_turn", None)]), monkeypatch).error == "no_parse"


def test_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    assert go(FakeClient([]), monkeypatch, deadline_s=1).error == "deadline"
    monkeypatch.delenv("ANTHROPIC_API_KEY")
    assert go(FakeClient([]), monkeypatch).error == "no_key"


def test_budget_cap_skips(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DAL_DAILY_BUDGET_USD", "0.001")
    from app import config

    config.get_settings_v2.cache_clear()
    assert go(FakeClient([]), monkeypatch).error == "budget"


def test_prompts_exist_for_every_call() -> None:
    for kind in mind.CALLS:
        assert len(mind.system_prompt(kind).split()) >= 380, kind
