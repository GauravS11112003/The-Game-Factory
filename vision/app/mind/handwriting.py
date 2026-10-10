"""Reading handwritten lines on the printed sheets (PLAN_V2 §8.1 "The name is read by PERCEIVE", §8.2 "My world is…").

Lane C's OMR reads every checkbox deterministically and returns the handwriting as image crops: one per Library Sheet
box (the creature's name line) and the Rules Sheet's story line. This module transcribes those crops in one call
(effort low). Offline, over budget or on any failure the crops are simply not read: creatures keep "Creature N" and
the kid types the name, exactly as the plan's offline path says.
"""
from __future__ import annotations

import base64
import time
from typing import Any

from pydantic import BaseModel, ConfigDict

from app.mind import client, moderate, render, sanitize

KIND = "handwriting"  # client.CALLS["handwriting"]: effort low, 1500 tokens, 10 s
MAX_IMAGES = 8


class HandwritingRead(BaseModel):
    model_config = ConfigDict(extra="forbid")
    texts: list[str]
    safe: bool


async def read_lines(images: list[bytes], what: str, *, max_chars: int, deadline: float | None = None) -> list[str] | None:
    """One transcription per image (\"\" when blank or unsafe), or None when the model did not answer."""
    imgs = [b for b in images if b][:MAX_IMAGES]
    if not imgs or not client.available():
        return None
    content: list[dict[str, Any]] = []
    for i, b in enumerate(imgs, start=1):
        content.append({"type": "text", "text": f"Image {i}:"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": render.media_type(b),
                                                     "data": base64.standard_b64encode(b).decode()}})
    content.append({"type": "text", "text": f"These are {what}. Return one text per image, in order ({len(imgs)} in total)."})
    dl = deadline if deadline is not None else time.monotonic() + client.CALLS[KIND].timeout_s
    r = await client.call(KIND, HandwritingRead, content, draft_id=None, deadline=dl)
    if not r.ok or r.value is None:
        return None
    texts = [sanitize.text(t, max_chars) for t in (r.value.texts or [])][: len(imgs)]
    texts += [""] * (len(imgs) - len(texts))
    if not r.value.safe:  # never show a flagged line back to the child; they type the name instead
        return [""] * len(imgs)
    return ["" if moderate.blocklist_hit([t]) else t for t in texts]
