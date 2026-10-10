# Behavior library (v1, fixed vocabulary)

This is the complete list of mechanics a drawing can ask for. The vision model
chooses only from this table and binds each behavior to a **numbered component**
found by CV (never to free coordinates). `compile.py` turns bindings into the
entities and rules of the level JSON (`shared/level.schema.json`). The system
prompt in `vision/app/llm/prompt.py` quotes this file.

Colors on the sheet: **black** = ground, **red** = spikes/enemies,
**green** = goal, **blue** = coins/keys. Anything written with letters, and any
arrow, is an *annotation* component: it is removed from the geometry and never
becomes a platform.

## Behaviors

| Behavior | Binds to | Params (defaults) | Allowed ranges | Compiles to | Trigger words (examples) |
|---|---|---|---|---|---|
| `move` | black component | `dx` (8), `dy` (0), `speed` cells/s (2) | `dx` 2 to 20 (sign = direction), `dy` -10 to 10, `speed` 1 to 6 | `moving_platform` entity with `path: [[x,y],[x+dx,y+dy]]`, ping-pong; its cells are cleared from the grid and its pixels are cropped to `comp_<id>.png` | "moves", "slides", an arrow next to a platform (`dx` is about the arrow's length in cells, in the arrow's direction) |
| `patrol` | red component | `dx` (6), `speed` (3) | `dx` 2 to 20, `speed` 1 to 6 | `enemy` entity that walks back and forth and flips at path ends; its hazard cells are cleared from the grid | "walks", "patrols", "moves back and forth" on spikes or a monster |
| `bounce` | black component | `strength` (1.0) | 0.5 to 2 | `bounce_pad` entity on that bbox; the tiles stay solid; landing on it sets `vy = BOUNCE_VY * strength` | "bouncy", "trampoline", "spring", "jump pad" |
| `key` | blue component | `opens_component_id` (required) | must be an existing black component bound to `door` | `key` entity (replaces that coin) plus rule `collect:<key id> -> open:<door id>` | "key", "opens the door" |
| `door` | black component | none | | `door` entity; its cells are removed from the grid; destroyed on `open:<id>` | "door", "gate", "wall opens" |
| `checkpoint` | any component | none | | `checkpoint` entity at the bbox bottom-center; respawn point after death | "checkpoint", "save", a flag drawing |
| `timer` | level (no component) | `seconds` (required) | 10 to 300 | rule `timer:N -> lose` plus a HUD countdown | "60 seconds", "timer", "hurry" |
| `start` | level, optional component | `component_id` or none | | `player_start` at that component's bbox bottom-center (default: on top of the leftmost ground column) | "S", "start", "begin here" |

Stretch, only if everything else is done: `gravity_flip` (zone on a blue
component), `crumble` (black platform falls 0.5 s after being stood on). They
are **not** part of v1 and the model must not emit them.

## Fixed point entities (from CV, not from bindings)

| Entity | Source |
|---|---|
| `goal` | largest green component, at its centroid cell; none drawn -> warning and goal on top of the rightmost ground column |
| `coin` | every blue component not bound as `key`, at its centroid cell |
| `player_start` | top of the leftmost solid column unless a `start` binding overrides it |

## Validation rules (`vision/app/compile.py`)

Every drop appends an entry to `meta.warnings`. **The level always compiles**,
even with an empty interpretation or no interpretation at all.

1. Unknown behaviors are dropped.
2. A binding whose `component_id` does not exist (in the scan or in the parent level when remixing) is dropped.
3. A color mismatch (for example `patrol` on a black component, `move` on a red one) is dropped.
4. `move` on a component larger than 60 cells is dropped (it is probably the floor).
5. A `key` without a valid `door` (missing `opens_component_id`, or that component is not bound as `door`) becomes a plain coin.
6. Params outside the allowed ranges are clamped to the range, not dropped.
7. `timer` below 10 s or above 300 s is clamped; a non-numeric timer is dropped.
8. Two bindings on the same component: the first one wins; the rest are dropped.
9. Annotation components (`annotation_component_ids`) are cleared from the grid before anything else, but only the cells where that component supplied the coverage.
10. Cells owned by a dynamic entity (`moving_platform`, `enemy`, `door`) are `0` in `grid.rows`.
11. If the vision model fails, times out (20 s) or refuses, the interpretation is `None`: the level compiles from CV alone and `meta.warnings` gets `"rules_not_read"`.
12. The safety check (`safety_ok == false`) does not block compilation; the API refuses to **publish** such a level and reports `safety_reason`.

## Rule vocabulary (`rules[]`)

- `when`: `collect:<entity id>`, `touch:<entity id>`, `timer:<seconds>`
- `then`: `open:<entity id>`, `win`, `lose`

## Physics the behaviors rely on (`web/src/game/constants.ts`)

Max jump height is about 3.8 cells (clears a 3-cell wall, not 4). Flat jump
distance is about 7.3 cells (clears a 6-cell gap, not 7). A bounce pad at
strength 1.0 sends the player about 12 cells up. Speeds are in cells per
second: default `move` 2, default `patrol` 3.
