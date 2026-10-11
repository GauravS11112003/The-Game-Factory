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
    out: dict[str, str] = {}
    # messages.json, then the v4 lane files merged over it (docs/v4/CONTRACTS_V4.md §8)
    paths = [SHARED_DIR / "spec" / "messages.json", *sorted((SHARED_DIR / "spec" / "messages-v4").glob("*.json"))]
    for path in paths:
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        msgs = data.get("messages", data)
        if isinstance(msgs, dict):
            out.update({str(k): str(v) for k, v in msgs.items() if not str(k).startswith("$")})
    return out


def has(key: str) -> bool:
    return key in _messages()


def say(key: str, args: dict[str, Any] | None = None, default: str | None = None) -> str:
    """The sentence for `key` with `{name}` placeholders filled; `default` (or the key) when unknown."""
    tpl = _messages().get(key)
    if tpl is None:
        return default if default is not None else key
    a = args or {}
    return _PLACEHOLDER.sub(lambda m: str(a.get(m.group(1), m.group(0))), tpl)
