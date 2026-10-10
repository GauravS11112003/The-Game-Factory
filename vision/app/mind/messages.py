"""Kid-facing sentences by key (shared/spec/messages.json, owned by lane F). Python renders a key only where a
payload needs plain text (the greedy designer note, menu summaries shown to the model); the UI renders keys itself."""
from __future__ import annotations

import json
import re
from functools import lru_cache
from typing import Any

from app.config import SHARED_DIR

_PLACEHOLDER = re.compile(r"\{([a-zA-Z0-9_]+)\}")


@lru_cache(maxsize=1)
def _messages() -> dict[str, str]:
    try:
        data = json.loads((SHARED_DIR / "spec" / "messages.json").read_text(encoding="utf-8"))
        msgs = data.get("messages", data)
        return {str(k): str(v) for k, v in msgs.items()} if isinstance(msgs, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def has(key: str) -> bool:
    return key in _messages()


def say(key: str, args: dict[str, Any] | None = None, default: str | None = None) -> str:
    """The sentence for `key` with `{name}` placeholders filled; `default` (or the key) when unknown."""
    tpl = _messages().get(key)
    if tpl is None:
        return default if default is not None else key
    a = args or {}
    return _PLACEHOLDER.sub(lambda m: str(a.get(m.group(1), m.group(0))), tpl)
