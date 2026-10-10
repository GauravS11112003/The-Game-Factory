"""Claude call, fake mode, refusal/failure -> None (PLAN.md section 7). Owned by lane C.

Modes, decided from the environment at call time:
- live: ANTHROPIC_API_KEY is set and DAL_FAKE_LLM is not on. One
  client.messages.parse call with the annotated image, a 20 s timeout and no
  retries. API error, timeout, unparsable output or stop_reason "refusal" -> None,
  and the caller compiles the level from CV alone with the "rules_not_read" warning.
- fake: no key, or DAL_FAKE_LLM=1. Answer from
  shared/fixtures/interpretations/<sha1 of the annotated image bytes>.json when it
  exists, else from heuristic.py over the typed prompt (empty prompt -> empty answer).

In both modes a typed prompt (canvas/prompt path) is also read by the heuristic
and merged in: the model's bindings win per component.

Binding ids are in the level's id space (app.compile): parent components keep
their ids and the scanned components follow them.
"""
from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from pathlib import Path

import anthropic

from app.compile import renumber_new_components
from app.config import FIXTURES_DIR
from app.llm.heuristic import heuristic_interpret
from app.llm.prompt import SYSTEM_PROMPT, build_user_message
from app.models import Component, CVResult, Interpretation

log = logging.getLogger(__name__)

MODEL = "claude-opus-5"
MAX_TOKENS = 4000
TIMEOUT_SECONDS = 20.0
INTERPRETATIONS_DIR = FIXTURES_DIR / "interpretations"


def is_fake_mode() -> bool:
    flag = os.environ.get("DAL_FAKE_LLM", "").strip().lower() in {"1", "true", "yes", "on"}
    return flag or not os.environ.get("ANTHROPIC_API_KEY")


def _read_image(path: str | None) -> tuple[bytes, str] | None:
    if not path or not Path(path).is_file():
        return None
    data = Path(path).read_bytes()
    media = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return data, media


def merge_interpretations(model: Interpretation, extra: Interpretation) -> Interpretation:
    """Model answer first; the typed-prompt heuristic only fills components the model left alone."""
    bound = {b.component_id for b in model.bindings}
    bindings = list(model.bindings) + [b for b in extra.bindings if b.component_id not in bound]
    notes = model.notes_transcript or ""
    typed = (extra.notes_transcript or "").strip()
    if typed and typed not in notes:
        notes = f"{notes}\n{typed}".strip()
    return Interpretation(
        title=model.title or extra.title,
        annotation_component_ids=sorted(set(model.annotation_component_ids) | set(extra.annotation_component_ids)),
        bindings=bindings,
        timer_seconds=model.timer_seconds if model.timer_seconds is not None else extra.timer_seconds,
        notes_transcript=notes,
        safety_ok=model.safety_ok and extra.safety_ok,
        safety_reason=model.safety_reason or extra.safety_reason,
    )


def _fixture_for(image: tuple[bytes, str] | None) -> Interpretation | None:
    if image is None:
        return None
    path = INTERPRETATIONS_DIR / f"{hashlib.sha1(image[0]).hexdigest()}.json"
    if not path.is_file():
        return None
    try:
        return Interpretation.model_validate(json.loads(path.read_text()))
    except (OSError, ValueError) as exc:
        log.warning("fixture interpretation %s is invalid: %s", path.name, exc)
        return None


def _call_model(
    image: tuple[bytes, str] | None,
    components: list[Component],
    parent_components: list[Component],
    extra_prompt: str | None,
) -> Interpretation | None:
    content: list[dict] = []
    if image is not None:
        content.append(
            {
                "type": "image",
                "source": {"type": "base64", "media_type": image[1], "data": base64.standard_b64encode(image[0]).decode("ascii")},
            }
        )
    content.append({"type": "text", "text": build_user_message(components, parent_components, extra_prompt)})
    try:
        client = anthropic.Anthropic().with_options(timeout=TIMEOUT_SECONDS, max_retries=0)
        # Thinking is on by default for this model; the structured output is parsed by the SDK.
        response = client.messages.parse(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": content}],
            output_format=Interpretation,
        )
    except anthropic.APITimeoutError:
        log.warning("vision model timed out after %.0fs", TIMEOUT_SECONDS)
        return None
    except anthropic.APIConnectionError as exc:
        log.warning("vision model connection error: %s", exc)
        return None
    except anthropic.APIStatusError as exc:
        log.warning("vision model API error %s: %s", exc.status_code, exc.message)
        return None
    except (anthropic.APIError, ValueError) as exc:  # ValueError covers pydantic/JSON parse failures
        log.warning("vision model call failed: %s", exc)
        return None
    if response.stop_reason == "refusal":
        log.warning("vision model refused: %s", getattr(response.stop_details, "explanation", None))
        return None
    if response.stop_reason != "end_turn":
        log.warning("vision model stopped with %s", response.stop_reason)
    return response.parsed_output


def interpret(
    cv: CVResult,
    parent_components: list[Component],
    extra_prompt: str | None,
) -> Interpretation | None:
    """Read handwritten rules and arrows from cv.annotated_path; never raises, never blocks past 20 s."""
    parents = list(parent_components or [])
    new_components: list[Component] = list(renumber_new_components(cv.components, parents))
    all_components = parents + new_components
    image = _read_image(cv.annotated_path)
    typed = (extra_prompt or "").strip()

    if is_fake_mode():
        result = _fixture_for(image)
        if result is None:
            return heuristic_interpret(all_components, typed)
    else:
        result = _call_model(image, new_components, parents, typed or None)
        if result is None:
            return None

    if typed:
        result = merge_interpretations(result, heuristic_interpret(all_components, typed))
    return result
