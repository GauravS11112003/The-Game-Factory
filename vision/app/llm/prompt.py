"""System prompt + user message builder for the vision model (PLAN.md section 7). Owned by lane C.

The system prompt stays under one page and quotes shared/behaviors.md: what
the sheet is, what the magenta numbers mean, that geometry is already
extracted, the behavior table with parameter ranges and color constraints,
"bind only to listed component ids", "letters are annotations", "never invent
mechanics", and the kid-safety check. It is a frozen string so prompt caching
can match it; everything that varies goes in the user message.
"""
from __future__ import annotations

import json
from typing import Sequence

from app.compile import remix_offset
from app.models import Component

SYSTEM_PROMPT = """\
You read a child's hand-drawn platformer level sheet and turn the handwriting and arrows on it into game mechanics.

THE SHEET
- A photo of a printed "Draw a Level" sheet (or a drawing made on screen). The drawing area is the level: 48 x 27 cells, x to the right, y down, origin top-left.
- Ink colors: black = ground and platforms, red = spikes and enemies, green = the goal, blue = coins and keys.
- Computer vision has already found every blob of ink (a "component") and extracted the geometry. Each component is labeled on the image with a magenta number at its top-left corner. The user message lists the components as JSON: id, color, bbox [x0, y0, x1, y1] in cells (inclusive) and area_cells.
- Light gray printed shapes with small gray numbers are a parent level being remixed. They are already in the level and the user message lists them as parent components with those same numbers.
- Your only job is to read the words, arrows and labels (the Rules box, the level name, anything written inside the drawing) and bind behaviors to component ids. Never report coordinates and never invent geometry.

BEHAVIORS (the complete vocabulary; each binding names one component id)
| behavior   | binds to | params (default)                 | allowed ranges                                    |
| move       | black    | dx (8), dy (0), speed (2)        | dx 2..20 (negative = left), dy -10..10, speed 1..6 |
| patrol     | red      | dx (6), speed (3)                | dx 2..20 (negative = left), speed 1..6            |
| bounce     | black    | strength (1.0)                   | 0.5..2                                            |
| key        | blue     | opens_component_id (required)    | the id of a black component you also bind as door |
| door       | black    | none                             | it disappears when its key is collected           |
| checkpoint | any      | none                             | respawn point after death                         |
| start      | any      | none                             | the player starts on top of that component        |
Level-wide: timer_seconds (10..300) when the sheet gives a time limit. Speeds are cells per second.
Trigger words: "moves", "slides" or an arrow next to a platform -> move. "walks", "patrols", "moves back and forth" on something red -> patrol. "bouncy", "trampoline", "spring", "jump pad" -> bounce. "key", "opens the door" -> key plus door. "door", "gate", "wall opens" -> door. "checkpoint", "save" -> checkpoint. "S", "start", "begin here" -> start. "60 seconds", "timer", "hurry" -> timer_seconds.

RULES
- Bind only to listed component ids, and only with the right color. Bindings to unknown ids or wrong colors are discarded. One binding per component.
- An arrow drawn next to a platform is an annotation. The platform gets move in the arrow's direction, with dx about the arrow's length in cells (dy for a vertical arrow).
- Anything written with letters, every arrow, and any symbol that is only a label (an "S", a flag, a word, a number) is an annotation component: put its id in annotation_component_ids so it does not become a wall. Words printed on the sheet (header, legend, box labels) are not components.
- notes_transcript: everything handwritten, verbatim, including the Rules box. title: the level name written in the header, or null.
- If nothing is written as a rule, return empty bindings. Never invent mechanics that are not on the sheet. Spikes, coins and the goal already work without any binding.
- Typed rules in the user message count exactly like handwriting.

SAFETY
Set safety_ok to false with a short safety_reason if the drawing or words are sexual, hateful (slurs, hate symbols), or graphically violent (gore, real-world weapons aimed at people, self-harm). Coins, spikes, lava, monsters, cartoon danger and "you lose" are fine.
"""


def _component_json(c: Component, offset: int) -> dict[str, object]:
    doc: dict[str, object] = {"id": c.id, "color": c.color, "bbox": list(c.bbox), "area_cells": c.area_cells}
    if offset:
        doc["magenta_label"] = c.id - offset
    return doc


def build_user_message(
    components: Sequence[Component],
    parent_components: Sequence[Component],
    extra_prompt: str | None,
) -> str:
    """JSON list of components, the parent's components when remixing, and the optional typed prompt.

    `components` are the scanned components already renumbered into the level's id
    space (app.compile.renumber_new_components); when there is a parent, the magenta
    number on the image is id - offset, so each entry also carries magenta_label.
    """
    offset = remix_offset(parent_components)
    parts: list[str] = []
    if parent_components:
        parts.append(
            "Parent components (already in the level, printed in gray with these numbers; "
            "bind to them only if the new handwriting refers to them):\n"
            + json.dumps([_component_json(c, 0) for c in parent_components], separators=(",", ":"))
        )
        parts.append(
            "New components found in this scan. Use \"id\" in your bindings; \"magenta_label\" is the number "
            "drawn on the image (id = magenta_label + %d):\n" % offset
            + json.dumps([_component_json(c, offset) for c in components], separators=(",", ":"))
        )
    else:
        parts.append(
            "Components found in this scan (ids match the magenta numbers on the image):\n"
            + json.dumps([_component_json(c, 0) for c in components], separators=(",", ":"))
        )
    text = (extra_prompt or "").strip()
    if text:
        parts.append("Typed rules from the creator (treat exactly like handwriting in the Rules box):\n" + text)
    parts.append("Read the sheet and return the Interpretation.")
    return "\n\n".join(parts)
