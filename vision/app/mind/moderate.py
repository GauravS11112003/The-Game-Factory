"""Safety at publish (PLAN_V2 D27, §3.10 MODERATE).

- `safety_ok` comes from PERCEIVE; MODERATE runs at publish only when PERCEIVE never ran (a stamp-only canvas) or
  when the title / author text is new. A refusal holds the level as unlisted.
- With the model offline, a level publishes with the "not checked yet" badge unless `DAL_REQUIRE_MODERATION=1`.
- A deterministic blocklist always runs on names and titles (and on the drawing's transcript): sexual words,
  profanity, hate symbols and personal information (phone numbers, e-mail addresses, street addresses).
"""
from __future__ import annotations

import base64
import re
import unicodedata
from typing import Any

from app.mind import client, render
from app.mind import schemas as ms
from app.mind.client import MindResult

_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "|": "i"})

# Whole words only (after leetspeak folding and removing separators inside a word). Kept short and generic: the
# blocklist is a floor under MODERATE, not a replacement for it.
_BLOCK_WORDS = {
    "fuck", "fucker", "fucking", "motherfucker", "shit", "bullshit", "bitch", "bastard", "cunt", "cock", "dick", "dickhead",
    "pussy", "penis", "vagina", "boobs", "tits", "porn", "porno", "sex", "sexy", "nude", "nudes", "naked", "rape",
    "rapist", "whore", "slut", "nazi", "nazis", "hitler", "kkk", "suicide", "killyourself", "kys",
    "retard", "retarded", "fag", "faggot", "dyke", "tranny", "nigger", "nigga", "chink", "spic", "kike", "wetback",
}
_PHONE = re.compile(r"(?:\+?\d[\s().-]?){9,}")
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_SPELLED = re.compile(r"(?:\b[a-z]\b[^a-z]{0,2}){3,}")
_ADDRESS = re.compile(r"\b\d{1,5}\s+\w+(?:\s+\w+)?\s+(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|way)\b", re.I)


def _fold(s: str) -> str:
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    return s.lower().translate(_LEET)


def blocklist_hit(texts: list[str | None]) -> str | None:
    """The reason a text is blocked ("words" | "personal_info"), or None."""
    for raw in texts:
        if not raw:
            continue
        if _EMAIL.search(raw) or _PHONE.search(raw) or _ADDRESS.search(raw):
            return "personal_info"
        folded = _fold(raw)
        words = re.findall(r"[a-z]+", folded)
        if any(w in _BLOCK_WORDS for w in words):
            return "words"
        # letters spelled apart ("f.u.c.k", "k y s"): join runs of single letters, never substrings of real words
        for run in _SPELLED.findall(folded):
            if "".join(re.findall(r"[a-z]", run)) in _BLOCK_WORDS:
                return "words"
    return None


async def moderate(image: bytes, texts: list[str], *, draft_id: str | None, deadline: float) -> MindResult[Any]:
    """§11.3d `moderate`: the render (≤ 1024 px PNG) + the attached texts → Moderation. Never raises."""
    listed = "\n".join(f"- {t}" for t in texts if t) or "- (no text)"
    content = [
        {"type": "image", "source": {"type": "base64", "media_type": render.media_type(image),
                                     "data": base64.standard_b64encode(image).decode()}},
        {"type": "text", "text": f"Texts attached to this level:\n{listed}\n\nIs it safe to show publicly to children?"},
    ]
    return await client.call("moderate", ms.Moderation, content, draft_id=draft_id, deadline=deadline)
