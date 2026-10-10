# dal-level format v2 (draft)

Status: **P0 skeleton** (lane B). This prose becomes normative at P6. Until then, the normative sources are listed
below; where this file and they disagree, they win. Licence of the spec, schemas and conformance suite: CC0.

| Topic | Normative source today |
|---|---|
| Coordinates and units (cells, 1/16; ink 1/64; origin top-left, y down; half-open bbox; feet line) | PLAN_V2 §2.1 |
| Level JSON (`dal-level`, `schema_version` 2) | `shared/spec/level.schema.json` (generated from `vision/app/spec/level.py`) |
| What is normative for what (`world`/`rules`/`compiled` play; `ink`/`objects`/`setpieces`/`edits` edit; `design`/`meta.build` informative) | PLAN_V2 §2.3 |
| InkDoc | `shared/spec/ink.schema.json`, PLAN_V2 §3.2 |
| Scene graph, roles, relations | `shared/spec/scene.schema.json`, PLAN_V2 §3.3 |
| Tile alphabet `.#=/\abcd~X`, RLE rows, rasterization | PLAN_V2 §2.4 |
| Entities (hazards, enemies, doors, keys, springs, saws, firebars, movers, crumble, falling) | `level.schema.json` `Entity`, PLAN_V2 §5.7-5.8 |
| Behaviors | `shared/spec/behavior.schema.json` |
| Edit vocabulary (43 ops) and edit records | `shared/spec/edits.schema.json`, PLAN_V2 §3.5 |
| Physics profiles (immutable by name) | `shared/spec/physics-profiles.json` |
| Tunable constants and param grids | `shared/spec/params.json` |
| Camera function | PLAN_V2 §6.2 (`core/sim/camera.ts`) |
| Difficulty model | PLAN_V2 §4.4-4.5 |
| `level_hash` (canonical JSON, gameplay fields only) | PLAN_V2 §2.5 + `docs/v2/CONTRACTS.md` §3.2 |
| Replays | `shared/spec/run.schema.json`, PLAN_V2 §8.4 |
| Game rules | `shared/spec/rules.schema.json`, PLAN_V2 §8.2 |
| Library types | `shared/spec/library.schema.json`, PLAN_V2 §8.1 |
| Prompt plans (beats) | `shared/spec/plan.schema.json`, PLAN_V2 §8.3 |
| Conformance | `shared/spec/conformance/` (levels now; replays + state hashes in P5) |
| Versioning (published levels immutable; minor versions only add optional fields; `x_*` extension keys) | PLAN_V2 §2.1, §2.3 |

Reference implementation: `web/src/core/` (MIT).

## Entity geometry (normative)

All values are cells (floats quantized to 1/16), origin top-left, y down.

| Entity | `(x, y)` means | Size |
|---|---|---|
| `player_start`, `checkpoint`, `spring`, `enemy` (every archetype) | x = centre, y = **feet line** (the top of the support) | enemy `w × h` is its AABB with the feet on y; `bounds` is the range of the centre x |
| `coin`, `big_coin`, `key`, `saw`, `firebar` (anchor), `hint_arrow` | centre | saw radius `r` ∈ {0.75, 1, 1.5}; its `path` lists centre positions |
| `door` | top-left | `w × h` |
| `moving_platform`, `crumble`, `falling_platform` | top-left | `w × 1` row; a moving platform's `path` lists top-left positions, the first equal to `(x, y)` |
| `goal` | x = pole (or flag) centre, y = feet line | `trigger` = the union of the flag and pole boxes, down to the feet: touching the pole wins |
| `spikes` | `x0..x1` run **along the face**, `y` is the **face line** | top/bottom faces: `x0..x1` is an x range and `y` the face's y; left/right faces: `x0..x1` is the **vertical** range and `y` is the face's x |

Spike strips are a 6 px band on their face, inset 2 px at both ends. A strip's `facing` is away from its host face.

## Rasterization details (normative, §2.4 made exact)

- **Surfaces** are lattice polylines: vertices at integer x, segments with slope 0, ±½ or ±1 (y down). A ½-slope
  segment spans an even number of columns, so every vertex height is an integer. For a column with left height `yl`
  and right height `yr`: `dy = 0` → `#` (or `=` for a one-way platform) in row `yl`; `dy = −1` → `/` in row `yr`;
  `dy = +1` → `\` in row `yl`; `dy = −½` → `a` (yl integer) or `b`; `dy = +½` → `c` (yl integer) or `d`. The tile sits in
  row `floor(min(yl, yr))`. A vertical step is two segments sharing an x.
- **Ground** fills below each surface tile with `#` down to the world bottom, stopping one row above any other floor
  beneath it in that column.
- **Platforms** are exactly one row (one-way `=` when thin and floating; `#` when solid). Sloped platform columns use
  the slope tiles.
- **Ceilings** are fitted on their underside line `y`; the solid row is `y − 1`. A ceiling in the top 4 rows that is
  ≥ 4 cells long is filled up to row 0.
- **Walls** fill columns `[x, x + w)` and rows `[y0, y1)`; a wall standing on a surface ends on that surface's top.
- **Lava** fills its pit with `~` from the drawn top row down to the first floor tile or the world bottom.
- Doors, moving/crumbling/falling platforms, hazards, enemies, keys, springs and pickups are entities, never tiles.


## InkDoc components and labels (normative)

- A component is a union of same-colour strokes that touch (centreline gap ≤ 0.5 · the wider pen). Three exceptions:
  a stamped stroke is always its own component; two `dot` strokes never unite (each tap is its own coin); two strokes
  carrying different `label`s never unite.
- A `label` is the creator's chip (or a prompt draft's exact role): the stroke's object takes that role with
  confidence 1.0 and the role is pinned. Labelled pieces are not merged with differently-labelled fragments and are
  never re-read as arrows, text or parts; a labelled `goal` / `checkpoint` flag pairs with a labelled `pole`.
- Prompt drafts (`source: 'prompt'`) are blue-line strokes: colour `draft`, origin `draft`, every stroke labelled,
  behaviours as `rule`, and `x_beat` naming the plan beat that drew them. Creator ink over a draft object of the same
  role family (IoU ≥ 0.3) replaces it.

## Fire bars

A `saw`-role object whose behaviour is `{kind: "firebar"}` compiles to a `firebar` entity anchored at the object's
centre (balls 3-6, speed 45-180 °/s, phase in degrees).
