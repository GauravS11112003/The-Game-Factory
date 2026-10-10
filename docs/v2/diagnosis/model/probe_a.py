"""Probe A - PERCEPTION. Annotated image + CV component list -> scene graph.

Usage (inside vision/, after `set -a; source ../.env; set +a`):
  uv run --no-sync python ../docs/v2/diagnosis/model/probe_a.py <scene> <effort>
"""
from __future__ import annotations

import json
import sys
from typing import Literal

from pydantic import BaseModel

from common import HERE, call, image_block

Role = Literal["ground", "platform", "wall", "ceiling", "spike_strip", "enemy", "decoration", "text", "arrow",
               "goal", "coin", "key", "door", "character", "unknown"]
Dir = Literal["up", "down", "left", "right", "none"]


class SceneNode(BaseModel):
    id: int
    role: Role
    rests_on: int | None
    attached_to: int | None
    points: Dir
    part_of: int | None
    confidence: float
    why: str


class SceneGraph(BaseModel):
    nodes: list[SceneNode]
    creator_intent: str
    problems_noticed: list[str]


SYSTEM = """\
You are the perception stage of a level-design assistant for a kids' "draw a platformer level" game.
Computer vision has already split the drawing into numbered ink blobs ("components"); each one is boxed and
labeled with a magenta number on the image. The level grid is 48 x 27 cells, x to the right, y DOWN, origin
top-left; the magenta rulers on the image are in cells. Ink colors: black = ground/platforms (but kids also
use black for words, arrows, and decoration), red = spikes and enemies (and sometimes words), green = goal,
blue = coins and keys.

For EVERY listed component return one node:
- role: ground (long floor near the bottom), platform (a ledge to stand on), wall (vertical blocker), ceiling,
  spike_strip (a row of spikes or a lava strip), enemy (a creature/monster), decoration (scenery that should not
  collide: clouds, sun, trees, birds), text (letters, words, a written "S"), arrow, goal, coin, key, door,
  character, unknown.
- rests_on: the id of the component it sits on top of (spikes on a platform, an enemy standing on ground, a goal on
  a floor), even when it is drawn slightly floating above it - say what the creator MEANT. null if it truly floats.
- attached_to: the id it hangs from or is fixed to (spikes under a ceiling or on a wall's face, an arrow that refers
  to a platform, a word that labels something). null if none.
- points: the direction spikes point, or an arrow points; "none" otherwise.
- part_of: when several components are pieces of one thing (letters of one word, pieces of one tree, a platform
  split in two by something drawn over it), the id of the largest piece; else null.
- confidence 0..1, and a few words of why.
Then: creator_intent (1-2 sentences: what the creator is going for) and problems_noticed (short list of things that
will play badly if built literally: floating objects, words that would become walls, impossible jumps, ...).
Use the component ids exactly as listed. Do not invent components.
"""


def run(scene: str, effort: str) -> dict:
    d = HERE / "inputs" / scene
    cv = json.loads((d / "cv.json").read_text())
    comps = [{k: c[k] for k in ("id", "color", "bbox", "area_cells")} for c in cv["components"]]
    text = ("Components (bbox = [x0, y0, x1, y1] in cells, inclusive):\n" + json.dumps(comps, separators=(",", ":"))
            + "\n\nReturn the scene graph.")
    return call(f"A:{scene}", "A", effort, SYSTEM, [image_block(d / "annotated.jpg"), {"type": "text", "text": text}], SceneGraph)


if __name__ == "__main__":
    run(sys.argv[1], sys.argv[2])
