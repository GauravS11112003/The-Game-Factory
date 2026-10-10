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
