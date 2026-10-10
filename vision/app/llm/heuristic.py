"""Rule-based stand-in for the vision model (PLAN.md section 7). Owned by lane C.

Used in fake mode (no API key) and for typed rules from the canvas/prompt path.
It reads plain sentences, case-insensitively, and binds behaviors to the most
plausible component by color, size and position. It never sees the image, so
it cannot flag annotations; it returns the text verbatim as notes_transcript.
"""
from __future__ import annotations

import re
from typing import Callable, Sequence

from app.models import Binding, Component, Interpretation

FLOOR_AREA_CELLS = 60
LEVEL_CENTER = (23.5, 13.0)
DEFAULT_TIMER = 60

_MENTION = re.compile(r"(?:#|\b(?:component|number|no\.?|blob|platform|shape|thing)\s*)(\d+)\b", re.I)
_PATROL = re.compile(
    r"\bpatrol\w*|\bwalk\w*|\b(?:enem(?:y|ies)|monsters?|spikes?|red\b[\w\s]{0,12})\s+(?:\w+\s+){0,2}?mov\w*", re.I
)
_MOVE = re.compile(r"\b(?:mov(?:e|es|ing)|slid(?:e|es|ing))\b", re.I)
_BOUNCE = re.compile(r"bounc|spring|trampoline|jump\s*pad", re.I)
_KEY = re.compile(r"\bkeys?\b", re.I)
_DOOR = re.compile(r"\bdoors?\b|\bgates?\b|wall opens", re.I)
_CHECKPOINT = re.compile(r"checkpoint|\bsave\b|respawn", re.I)
_TIMER_N = re.compile(r"\b(\d+)\s*(?:s|secs?|seconds?)\b", re.I)
# "timer 90", "time limit: 45", "countdown of 30": the number follows the word.
_TIMER_AFTER = re.compile(r"\b(?:timer|time\s*limit|countdown)\b\s*(?:of|:|=|is)?\s*(\d+)\b", re.I)
_TIMER_WORD = re.compile(r"\btimer\b|\bhurry\b|time\s*limit|countdown|\bseconds?\b", re.I)
_START = re.compile(r"\bstart\b|\bbegin\s+here\b|\bbegin\b|\bspawn\b", re.I)
_DIRECTION = re.compile(r"\b(left|right|up|down)\b", re.I)
_NUMBER = re.compile(r"(?<![\w.#])(\d+)(?!\s*(?:s|secs?|seconds?)\b)", re.I)
_NEAR_COIN = re.compile(r"\b(?:under|below|near|next to|beside|by|above|over)\s+(?:the\s+|a\s+)?(?:coins?|blue)\b", re.I)
_CLAUSE_SPLIT = re.compile(r"[.;\n!?]+")


def _center(c: Component) -> tuple[float, float]:
    x0, y0, x1, y1 = c.bbox
    return ((x0 + x1) / 2, (y0 + y1) / 2)


def _dist2(a: tuple[float, float], b: tuple[float, float]) -> float:
    return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2


def _is_floor(c: Component) -> bool:
    return c.color == "black" and c.bbox[3] >= 26 and c.area_cells > FLOOR_AREA_CELLS


def _height(c: Component) -> int:
    return c.bbox[3] - c.bbox[1] + 1


class _Picker:
    """Chooses components for bindings, never binding the same component twice."""

    def __init__(self, components: Sequence[Component]):
        self.components = list(components)
        self.bound: set[int] = set()
        green = [c for c in self.components if c.color == "green"]
        self.goal = _center(max(green, key=lambda c: c.area_cells)) if green else (47.0, 13.0)

    def free(self, color: str | None = None, where: Callable[[Component], bool] | None = None) -> list[Component]:
        return [
            c
            for c in self.components
            if c.id not in self.bound and (color is None or c.color == color) and (where is None or where(c))
        ]

    def mentioned(self, clause: str, color: str | None) -> Component | None:
        for m in _MENTION.finditer(clause):
            cid = int(m.group(1))
            for c in self.free(color):
                if c.id == cid:
                    return c
        return None

    def platform(self, clause: str) -> Component | None:
        """Largest black component that is not the floor; nearest to a coin when the text says so."""
        picked = self.mentioned(clause, "black")
        if picked:
            return picked
        candidates = self.free("black", lambda c: not _is_floor(c) and c.area_cells <= FLOOR_AREA_CELLS)
        if not candidates:
            candidates = self.free("black")
        if not candidates:
            return None
        coins = [c for c in self.components if c.color == "blue"]
        if coins and _NEAR_COIN.search(clause):
            return min(candidates, key=lambda c: min(_dist2(_center(c), _center(k)) for k in coins))
        return max(candidates, key=lambda c: c.area_cells)

    def smallest_black(self, clause: str) -> Component | None:
        picked = self.mentioned(clause, "black")
        if picked:
            return picked
        candidates = self.free("black", lambda c: not _is_floor(c)) or self.free("black")
        return min(candidates, key=lambda c: c.area_cells) if candidates else None

    def largest_red(self, clause: str) -> Component | None:
        picked = self.mentioned(clause, "red")
        if picked:
            return picked
        candidates = self.free("red")
        return max(candidates, key=lambda c: c.area_cells) if candidates else None

    def door(self, clause: str) -> Component | None:
        """Black component nearest the goal that spans at least 3 cells vertically."""
        picked = self.mentioned(clause, "black")
        if picked:
            return picked
        tall = self.free("black", lambda c: _height(c) >= 3 and not _is_floor(c))
        return min(tall, key=lambda c: _dist2(_center(c), self.goal)) if tall else None

    def far_blue(self, clause: str) -> Component | None:
        picked = self.mentioned(clause, "blue")
        if picked:
            return picked
        blues = self.free("blue")
        return max(blues, key=lambda c: _dist2(_center(c), self.goal)) if blues else None

    def central(self, clause: str) -> Component | None:
        picked = self.mentioned(clause, None)
        if picked:
            return picked
        candidates = self.free()
        return min(candidates, key=lambda c: _dist2(_center(c), LEVEL_CENTER)) if candidates else None

    def leftmost(self, clause: str) -> Component | None:
        picked = self.mentioned(clause, None)
        if picked:
            return picked
        candidates = self.free("black") or self.free()
        return min(candidates, key=lambda c: (c.bbox[0], c.bbox[1])) if candidates else None

    def bind(self, comp: Component | None, behavior: str, **params: float | int) -> Binding | None:
        if comp is None or comp.id in self.bound:
            return None
        self.bound.add(comp.id)
        return Binding(component_id=comp.id, behavior=behavior, params=dict(params))  # type: ignore[arg-type]


def _move_params(clause: str) -> dict[str, float | int]:
    direction = (_DIRECTION.search(clause) or [None, "right"])[1].lower()
    # Component mentions and timer phrases carry numbers that are not a distance.
    without_mentions = _TIMER_AFTER.sub(" ", _TIMER_N.sub(" ", _MENTION.sub(" ", clause)))
    n = _NUMBER.search(without_mentions)
    cells = int(n.group(1)) if n else 8
    cells = min(max(cells, 2), 20)
    if direction in ("up", "down"):
        return {"dx": 0, "dy": -cells if direction == "up" else cells, "speed": 2}
    return {"dx": -cells if direction == "left" else cells, "dy": 0, "speed": 2}


def heuristic_interpret(components: Sequence[Component], text: str) -> Interpretation:
    """Bind behaviors from plain sentences; empty text gives an empty interpretation."""
    picker = _Picker(components)
    bindings: list[Binding] = []
    timer: int | None = None

    def add(b: Binding | None) -> None:
        if b is not None:
            bindings.append(b)

    for clause in (c.strip() for c in _CLAUSE_SPLIT.split(text or "")):
        if not clause:
            continue
        # Patrol phrases ("the enemy moves") must not also read as a platform move.
        patrol_hit = _PATROL.search(clause)
        move_text = _PATROL.sub(" ", clause)
        if patrol_hit:
            add(picker.bind(picker.largest_red(clause), "patrol", dx=6, speed=3))
        if _MOVE.search(move_text):
            add(picker.bind(picker.platform(move_text), "move", **_move_params(move_text)))
        if _BOUNCE.search(clause):
            add(picker.bind(picker.smallest_black(clause), "bounce", strength=1.0))
        has_key, has_door = bool(_KEY.search(clause)), bool(_DOOR.search(clause))
        if has_key or has_door:
            door = picker.door(clause)
            door_binding = picker.bind(door, "door")
            add(door_binding)
            if has_key:
                key = picker.far_blue(clause)
                if door_binding is not None or (door is not None and door.id in picker.bound):
                    add(picker.bind(key, "key", opens_component_id=door.id))  # type: ignore[union-attr]
                else:
                    add(picker.bind(key, "key"))
        if _CHECKPOINT.search(clause):
            add(picker.bind(picker.central(clause), "checkpoint"))
        if _START.search(clause):
            add(picker.bind(picker.leftmost(clause), "start"))
        n = _TIMER_N.search(clause) or _TIMER_AFTER.search(clause)
        if n:
            timer = int(n.group(1))
        elif timer is None and _TIMER_WORD.search(clause):
            timer = DEFAULT_TIMER

    return Interpretation(
        title=None,
        annotation_component_ids=[],
        bindings=bindings,
        timer_seconds=timer,
        notes_transcript=text or "",
        safety_ok=True,
        safety_reason=None,
    )
