"""heuristic_interpret on plain sentences, interpret() in fake mode, and the live code path with a stubbed client. Owned by lane C.

Live mode never reaches the network here: anthropic.Anthropic is replaced by a
stub that returns a canned ParsedMessage-shaped object or raises SDK errors.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

import anthropic
import httpx2
import pytest

import app.llm.interpret as interpret_module
from app.llm.heuristic import heuristic_interpret
from app.llm.interpret import interpret, is_fake_mode, merge_interpretations
from app.llm.prompt import SYSTEM_PROMPT, build_user_message
from app.models import Binding, Component, CVResult, Interpretation
from tests.test_compile import CVRESULTS_DIR, load_case, load_interpretation


@pytest.fixture
def rules_demo(tmp_path: Path) -> CVResult:
    return load_case("rules_demo", tmp_path / "work")


@pytest.fixture
def fake_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DAL_FAKE_LLM", "1")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


@pytest.fixture
def live_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    monkeypatch.setenv("DAL_FAKE_LLM", "0")


def bindings_of(interp: Interpretation) -> list[tuple[int, str]]:
    return [(b.component_id, b.behavior) for b in interp.bindings]


# ----------------------------------------------------------------------------- heuristic

# rules_demo components: 1 text (black, 6 cells), 2 platform (black, 9), 3 bar (black 1x4 near goal),
# 4 goal (green), 5 blue far left, 6 red 2x2, 7 blue near goal, 8 floor (black, 96 cells).
HEURISTIC_CASES = [
    ("The platform moves right 10 cells", [(2, "move")], {"dx": 10, "dy": 0}, None),
    ("it slides LEFT", [(2, "move")], {"dx": -8, "dy": 0}, None),
    ("the platform near the coin moves up 3", [(3, "move")], {"dx": 0, "dy": -3}, None),
    ("this one is a bouncy trampoline", [(3, "bounce")], {"strength": 1.0}, None),
    ("the enemy walks back and forth", [(6, "patrol")], {"dx": 6, "speed": 3}, None),
    ("the key opens the door", [(3, "door"), (5, "key")], {"opens_component_id": 3}, None),
    ("checkpoint halfway", [(2, "checkpoint")], {}, None),
    ("you have 90 seconds", [], {}, 90),
    ("hurry, there is a timer!", [], {}, 60),
    ("timer 45", [], {}, 45),
    ("time limit: 30", [], {}, 30),
    ("the platform moves right, timer 90", [(2, "move")], {"dx": 8, "dy": 0}, 90),
    ("start on the left", [(8, "start")], {}, None),
    ("the enemy moves", [(6, "patrol")], {"dx": 6, "speed": 3}, None),
    ("", [], {}, None),
]


@pytest.mark.parametrize("text,expected,params,timer", HEURISTIC_CASES, ids=[c[0] or "empty" for c in HEURISTIC_CASES])
def test_heuristic_sentences(rules_demo: CVResult, text: str, expected: list, params: dict, timer: int | None) -> None:
    interp = heuristic_interpret(rules_demo.components, text)
    assert bindings_of(interp) == expected
    if expected:
        last = interp.bindings[-1].params
        for name, value in params.items():
            assert last[name] == value, f"{name}: {last}"
    assert interp.timer_seconds == timer
    assert interp.notes_transcript == text
    assert interp.safety_ok and interp.annotation_component_ids == []


def test_heuristic_multiple_sentences_and_mentions(rules_demo: CVResult) -> None:
    text = "Platform 2 moves right 4. #1 slides down 2; the spikes patrol. 45 sec"
    interp = heuristic_interpret(rules_demo.components, text)
    assert bindings_of(interp) == [(2, "move"), (1, "move"), (6, "patrol")]
    assert interp.bindings[0].params == {"dx": 4, "dy": 0, "speed": 2}
    assert interp.bindings[1].params == {"dx": 0, "dy": 2, "speed": 2}
    assert interp.timer_seconds == 45


def test_heuristic_never_binds_a_component_twice(rules_demo: CVResult) -> None:
    interp = heuristic_interpret(rules_demo.components, "the platform moves. the platform moves. bouncy")
    # Largest free non-floor black each time: platform (9 cells), then the text blob (6), then the bar (4) bounces.
    assert bindings_of(interp) == [(2, "move"), (1, "move"), (3, "bounce")]


# ----------------------------------------------------------------------------- prompt


def test_prompt_and_user_message(rules_demo: CVResult) -> None:
    assert len(SYSTEM_PROMPT.splitlines()) < 60
    for needle in ("magenta", "move", "patrol", "bounce", "key", "door", "checkpoint", "start", "annotation", "never invent", "safety_ok"):
        assert needle.lower() in SYSTEM_PROMPT.lower(), needle

    msg = build_user_message(rules_demo.components, [], "the platform moves")
    assert '"id":2' in msg and '"color":"black"' in msg and '"bbox":[14,18,22,18]' in msg
    assert "magenta_label" not in msg and "already in the level" not in msg
    assert "Typed rules" in msg and "the platform moves" in msg

    parent = [Component(id=1, color="black", bbox=(0, 25, 47, 26), area_cells=96), Component(id=2, color="black", bbox=(20, 20, 25, 20), area_cells=6)]
    shifted = [c.model_copy(update={"id": c.id + 2}) for c in rules_demo.components]
    msg = build_user_message(shifted, parent, None)
    assert "already in the level" in msg
    assert '"id":4,"color":"black","bbox":[14,18,22,18],"area_cells":9,"magenta_label":2' in msg
    assert "id = magenta_label + 2" in msg
    assert "Typed rules" not in msg


# ----------------------------------------------------------------------------- fake mode


def test_fake_mode_detection(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)
    assert is_fake_mode()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test-not-a-real-key")
    assert not is_fake_mode()
    monkeypatch.setenv("DAL_FAKE_LLM", "1")
    assert is_fake_mode()


def test_fake_mode_returns_sha1_matched_fixture(fake_mode: None, rules_demo: CVResult) -> None:
    sha1 = hashlib.sha1(Path(rules_demo.annotated_path).read_bytes()).hexdigest()
    fixture = interpret_module.INTERPRETATIONS_DIR / f"{sha1}.json"
    assert fixture.is_file(), "run shared/fixtures/cvresults/make_cvresults.py to refresh the hashed fixtures"
    assert json.loads(fixture.read_text()) == json.loads((CVRESULTS_DIR / "rules_demo" / "interpretation.json").read_text())

    interp = interpret(rules_demo, [], None)
    assert interp == load_interpretation("rules_demo")
    assert interp.title == "Rules Demo" and interp.timer_seconds == 90


def test_fake_mode_falls_back_to_heuristic(fake_mode: None, rules_demo: CVResult) -> None:
    unknown = rules_demo.model_copy(update={"annotated_path": rules_demo.drawing_path})
    assert interpret(unknown, [], None) == heuristic_interpret(rules_demo.components, "")
    assert interpret(unknown, [], None).bindings == []

    interp = interpret(unknown, [], "the platform moves right 10 cells. 30 seconds")
    assert bindings_of(interp) == [(2, "move")] and interp.bindings[0].params["dx"] == 10
    assert interp.timer_seconds == 30 and interp.title is None
    assert interp.notes_transcript == "the platform moves right 10 cells. 30 seconds"

    missing = rules_demo.model_copy(update={"annotated_path": None})
    assert bindings_of(interpret(missing, [], "bouncy")) == [(3, "bounce")]


def test_fake_mode_merges_typed_prompt_with_fixture(fake_mode: None, rules_demo: CVResult) -> None:
    interp = interpret(rules_demo, [], "the platform moves left 5. start on the left")
    # The fixture already binds component 2 as move dx 10: the model wins the conflict.
    assert bindings_of(interp) == [(2, "move"), (6, "patrol"), (3, "door"), (5, "key"), (8, "start")]
    assert interp.bindings[0].params["dx"] == 10
    assert interp.timer_seconds == 90 and interp.title == "Rules Demo"
    assert interp.notes_transcript.endswith("\nthe platform moves left 5. start on the left")


def test_fake_mode_remix_uses_level_id_space(fake_mode: None, rules_demo: CVResult) -> None:
    parent = [Component(id=1, color="black", bbox=(0, 25, 47, 26), area_cells=96), Component(id=2, color="red", bbox=(10, 24, 10, 24), area_cells=1)]
    unknown = rules_demo.model_copy(update={"annotated_path": None})
    interp = interpret(unknown, parent, "the platform moves right. the big monster walks")
    # Scanned ids are shifted past the parent's max id 2: platform 2 -> 4, red blob 6 -> 8 (bigger than the parent's red).
    assert bindings_of(interp) == [(4, "move"), (8, "patrol")]
    interp = interpret(unknown, parent, "the monster walks")
    assert bindings_of(interp) == [(8, "patrol")]


def test_merge_interpretations() -> None:
    model = Interpretation(title="A", bindings=[Binding(component_id=1, behavior="move")], notes_transcript="moves", safety_ok=False, safety_reason="x")
    extra = Interpretation(bindings=[Binding(component_id=1, behavior="bounce"), Binding(component_id=2, behavior="door")], timer_seconds=30, notes_transcript="door. 30 seconds")
    merged = merge_interpretations(model, extra)
    assert bindings_of(merged) == [(1, "move"), (2, "door")]
    assert merged.timer_seconds == 30 and merged.title == "A"
    assert merged.notes_transcript == "moves\ndoor. 30 seconds"
    assert merged.safety_ok is False and merged.safety_reason == "x"


# ----------------------------------------------------------------------------- live mode, stubbed client


class _StubClient:
    """Mimics anthropic.Anthropic().with_options(...).messages.parse(...)."""

    calls: list[dict] = []
    outcome: object = None

    def __init__(self, *args: object, **kwargs: object) -> None:
        pass

    def with_options(self, **kwargs: object) -> "_StubClient":
        type(self).calls.append({"with_options": kwargs})
        return self

    @property
    def messages(self) -> "_StubClient":
        return self

    def parse(self, **kwargs: object) -> object:
        type(self).calls.append({"parse": kwargs})
        outcome = type(self).outcome
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome


@pytest.fixture
def stub_client(monkeypatch: pytest.MonkeyPatch) -> type[_StubClient]:
    _StubClient.calls = []
    _StubClient.outcome = None
    monkeypatch.setattr(anthropic, "Anthropic", _StubClient)
    return _StubClient


def _request() -> httpx2.Request:
    return httpx2.Request("POST", "https://api.anthropic.com/v1/messages")


def test_live_mode_success_and_request_shape(live_mode: None, stub_client: type[_StubClient], rules_demo: CVResult) -> None:
    answer = Interpretation(title="Live", bindings=[Binding(component_id=2, behavior="move", params={"dx": 6})], notes_transcript="moves")
    stub_client.outcome = SimpleNamespace(stop_reason="end_turn", stop_details=None, parsed_output=answer)

    interp = interpret(rules_demo, [], "bouncy")
    assert interp.title == "Live"
    assert bindings_of(interp) == [(2, "move"), (3, "bounce")], "typed prompt merged, model binding kept"

    options = next(c["with_options"] for c in stub_client.calls if "with_options" in c)
    assert options == {"timeout": 20.0, "max_retries": 0}
    call = next(c["parse"] for c in stub_client.calls if "parse" in c)
    assert call["model"] == "claude-opus-5" and call["max_tokens"] == 4000
    assert call["system"] == SYSTEM_PROMPT and call["output_format"] is Interpretation
    assert "thinking" not in call
    (message,) = call["messages"]
    assert message["role"] == "user"
    image, text = message["content"]
    assert image["type"] == "image" and image["source"]["media_type"] == "image/jpeg"
    assert image["source"]["type"] == "base64" and len(image["source"]["data"]) > 1000
    assert text["type"] == "text" and "bouncy" in text["text"] and '"id":2' in text["text"]


@pytest.mark.parametrize(
    "outcome",
    [
        lambda: anthropic.APITimeoutError(request=_request()),
        lambda: anthropic.APIConnectionError(request=_request()),
        lambda: anthropic.RateLimitError("slow down", response=httpx2.Response(429, request=_request()), body=None),
        lambda: anthropic.InternalServerError("boom", response=httpx2.Response(500, request=_request()), body=None),
        lambda: ValueError("could not parse the structured output"),
        lambda: SimpleNamespace(stop_reason="refusal", stop_details=SimpleNamespace(explanation="no"), parsed_output=None),
    ],
    ids=["timeout", "connection", "rate_limit", "server_error", "parse_error", "refusal"],
)
def test_live_mode_failures_return_none(live_mode: None, stub_client: type[_StubClient], rules_demo: CVResult, outcome) -> None:
    stub_client.outcome = outcome()
    assert interpret(rules_demo, [], "the platform moves") is None
