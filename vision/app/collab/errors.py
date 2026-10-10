"""The one error type of the collab modules: an HTTP status and a message key (the router turns it into
{message_key, args}; publish turns it into a DraftError)."""
from __future__ import annotations

from typing import Any


class CollabError(Exception):
    def __init__(self, status: int, key: str, args: dict[str, Any] | None = None) -> None:
        super().__init__(key)
        self.status = status
        self.key = key
        self.args_ = args or {}
