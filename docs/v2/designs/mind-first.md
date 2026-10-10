# draw-a-level v2: "Mind-First" design

Status: proposal for build. Author: design lane "mind-first". Date: 2026-10-10.
Inputs: `PROJECT_CONTEXT.md`, `PLAN.md` (v1), `README.md`, and the four v2 diagnoses. Citation keys used throughout:

| Key | Source |
|---|---|
| `[BUILD Fn]` | `docs/v2/diagnosis/build.md`, failure catalogue row Fn (F1 to F17), plus `build/metrics.json`, `build/probe_sweeps.json` |
| `[PLAY §n]` | `docs/v2/diagnosis/gameplay.md` section n, plus `gameplay/results.md`, `gameplay/proposed_physics_results.md` |
| `[VIS §n]` | `docs/v2/diagnosis/visual.md` section n, plus `visual/notes.md` |
| `[MODEL x]` | `docs/v2/diagnosis/model.md` (Probe A perception, B repair, C enhancement, D prompt-to-level, Latency, API facts) |

---

## 0. Thesis and the shape of v2

**Thesis.** Separate *judgement* from *physics*, and give each to the party that is good at it. Claude is the senior level designer: it decides what the child meant (objects, roles, relations, setpieces, rules) and what would make the level great (which repair alternative keeps the drawing, which design moves to make, in what order, and how to explain them). Deterministic code is the physics department: it fits geometry, applies every edit, simulates the result with the *same* frame-exact simulation the game runs, and accepts or rejects. Claude never computes reachability and never emits geometry or code. It chooses from a **menu of moves that code has already proven playable**, so its taste is used at full strength while every outcome stays verified.

Why this produces phenomenal levels, from the evidence:
- v1 failed because nobody decided what anything *was*. 5 of 6 kid drawings built unbeatable, and in 3 of them the drawing was fine and the build broke it (flag pole wall, tree-as-goal) `[BUILD F1, F2]`. Claude labels roles at 95-97% and relations at 75/76 `[MODEL A]`. Perception is the single biggest quality lever.
- Claude is unreliable at physics from pixels (a jumpable 5-cell gap called impossible 3/3 times) but correct when given solver facts `[MODEL A, B]`. Its free-form additions broke 1 of 3 levels `[MODEL C]`. So the model only ever sees solver facts and pre-validated candidates. It never sees "estimate whether this works".
- "Too easy" is measurable: v1 starters have E[deaths] 0.000/0.004/0.000 and 16-44-frame takeoff windows `[PLAY §3]`. v2 has momentum physics, real threats, long levels, and a numeric difficulty model that the designer targets with a dial.
- Latency rules out a synchronous chain (A+B+C at medium is about 70 s `[MODEL Latency]`). v2 ships a deterministic Faithful build in about 2 s and streams the mind's upgrades. The menu design lets the model's design call run at **low** effort, because choosing from validated options needs less thinking than inventing geometry.

### 0.1 What changes from v1

| Area | v1 | v2 |
|---|---|---|
| Unit of meaning | 16 px cell decided by colour coverage `[BUILD F4]` | **object** with role, relations, fitted geometry; cells are derived |
| Perception | model reads words and arrows only; "never invent geometry" `[BUILD F17]` | Reflex (deterministic, always) + See (Claude, roles/relations/setpieces/rules), merged |
| Repair | none; `solvable: null` `[BUILD F12]` | fixed repair vocabulary, deterministic application, every change an undoable card |
| Design | none | Designer: candidate menu (code) -> picks per difficulty tier (Claude) -> apply and verify (code) -> dial |
| Physics | instant 10 c/s, no momentum, Arcade bodies `[PLAY §2.1]` | shared deterministic sim core (`web/src/sim`), v2 momentum profile, used by engine, solver, bot, replays |
| Solver | browser-only reachability, fixed 48x27, ignores enemies/timing `[PLAY §6]` | server playtest daemon + browser worker, any width, time-aware, exports windows and difficulty |
| Level size | one 48x27 screen | 48·k x 27, k = 1..6 (paper sheets stitched by QR; long canvas) |
| Art | nearest-neighbour photo + invisible tiles `[VIS §1]` | vector "living ink" rendered from the same fitted shapes as collision |
| Editor | raster, 8 px brush, no redo `[VIS §2]` | vector strokes, 14 px brush, stamps, live role chips, pan/zoom, library |
| Format | v1 grid JSON | v2 object JSON + derived collision cache; public spec + conformance suite; v1 migration |

### 0.2 Trust boundary (non-negotiable)

1. Every model output is JSON validated against a Pydantic schema (typed discriminated variants, required fields). Unknown ids are dropped, numbers are clamped to the op's bounds in code, free text is length-capped and rendered as text only (never HTML).
2. The model can only (a) label CV components, (b) relate them, (c) bind behaviors from the fixed list, (d) choose among alternatives code offers, (e) pick candidates from code's menu, (f) propose at most 3 "novel" ops per call **from the same vocabulary**, each validated exactly like a candidate.
3. Code applies every op, recomputes geometry, runs intent invariants, and runs the shared simulation. Anything that fails is rejected with a recorded reason. The level always builds, even with zero model output.
4. The child's handwriting is data. A sheet that says "ignore your rules" can at worst produce a strange but valid level.

### 0.3 Architecture

```
                 paper photo(s)                     canvas strokes (vector)        text prompt
                       |                                     |                          |
               [L1 CV: rectify, segment]                     |                  [L2 PROMPT2LEVEL]
                       |                                     |                          |
               [L1 vectorize: skeleton -> polylines] ---> StrokeSet  <---- skeleton strokes (pencil)
                                                             |
                    +----------------------------------------+-------------------------------+
                    |                                                                        |
          [L1 Reflex perception] (det, 50 ms)                                   [L2 SEE] (Claude, low, ~10 s)
                    |                                                                        |
                    +------------------> [L2 merge] <----------------------------------------+
                                             |  SceneGraph (objects, roles, relations, behaviors, setpieces)
                                             v
                         [L3 Builder] auto-repairs as Edit records, fit geometry, collision + art
                                             |  LevelV2 (faithful)
                                             v
                         [L4 Playtest daemon] (Node, shared sim) -> PlaytestReport (route, windows, C, F, flags)
                                             |
                       +---------------------+----------------------+
                       |                                            |
           [L3 Candidate generator] (det) -- validate_many -->  menu of verified moves
                       |                                            |
                       +------------> [L2 DESIGN] (Claude, low) <---+
                                             |  picks per tier + repair choices + reasons
                                             v
                     [L3 apply plan per tier + invariants] + [L4 verify] -> builds: faithful / polished / normal / hard
                                             |
                          SSE stream -> [L6 Preview: stage + design report + dial] -> [L5 Engine on the same sim]
```

---

## A. The level-design mind

### A.1 Stages, owners and outputs

| # | Stage | Owner | Effort / cost | Output | Runs |
|---|---|---|---|---|---|
| 1 | CV: rectify, calibrate, segment (v1 code kept) | det (L1) | 0.4-0.8 s | colour masks, label image | paper only |
| 2 | Vectorize: skeleton, polylines, widths, features | det (L1) | 0.2-0.5 s | `StrokeSet` | always (canvas sends vectors directly) |
| 3 | Reflex perception | det (L1) | < 0.1 s | `SceneGraph` (source=reflex) | always |
| 4 | Auto-repair + build (Faithful) | det (L3) | < 0.2 s | `LevelV2`, `Edit[]` | always |
| 5 | Playtest | det (L4 daemon) | 0.1-0.5 s | `PlaytestReport` | always |
| 6 | Quick polish (greedy designer) | det (L3+L4) | 0.5-2 s | polished-quick build | always (model-free baseline) |
| 7 | **SEE** perception | Claude, effort `low` | ~10 s, ~$0.04 | roles, relations, groups, behaviors, setpieces, intent, questions, safety | when model available |
| 8 | Merge + rebuild + replay | det (L2+L3+L4) | 0.4-1 s | updated graph, "I understood" edits | after 7 |
| 9 | Candidate menu | det (L3+L4) | 0.5-2 s | 15-40 validated `Candidate`s | after 8 |
| 10 | **DESIGN** | Claude, effort `low` | ~10 s, ~$0.07 | repair choices, vetoes, picks by tier, novel ops, reasons, designer note, critique, title | after 9 |
| 11 | Apply per tier + verify | det (L3+L4) | 0.5-1.5 s | 4 builds (faithful, polished, normal, hard) + metrics | after 10 |
| 12 | **REFINE** (optional, 1 round) | Claude, `low` | ~8 s, ~$0.04 | extra picks after metric deltas | only if a tier misses its band and elapsed < 28 s |
| 13 | **CRITIC** (on demand) | Claude, `low` | ~10 s | suggestions from the creator's own deaths + bot trace | button "Why is this hard?" or after 5 deaths in one segment |

What is model and what is deterministic follows `[MODEL "Model vs deterministic code"]` exactly, with one extension: the model also arbitrates repair alternatives and vetoes cosmetic repairs, because the probes showed intent decisions are where it beats rules (door-from-text, which ledge to move) `[MODEL B]`.

### A.2 Strokes: the geometry substrate (L1)

v1 jumped from pixels to cells `[BUILD F4]`. v2 keeps the v1 colour segmentation (it is reliable on fixtures) and inserts a vector layer.

`StrokeSet` (all coordinates in **world px**, 16 px per cell, origin top-left; paper working resolution 50 px/cell is scaled by 0.32):

```python
class Stroke(BaseModel):          # one centreline polyline
    id: str                       # "s3.12" = sheet 3, stroke 12 (canvas: "s1.n")
    component: int                # CV component id (global across sheets)
    color: Literal["black","red","green","blue"]
    points: list[tuple[float,float]]   # RDP-simplified (epsilon 0.75 px), >= 1 point (a dot)
    width: float                  # median stroke width px (2 x distance-transform at the skeleton)
    closed: bool
    provenance: Literal["paper","canvas","prompt","parent","library","designer"]

class ComponentFeatures(BaseModel):  # facts the model and reflex both read; never roles
    id: int; color: str; bbox_cells: tuple[int,int,int,int]; area_cells: float
    length_cells: float; width_px: float; angle_deg: float      # PCA of skeleton
    straightness: float           # 1 - rms residual of best line fit / length
    closed: bool; circularity: float; holes: int
    endpoints: int; junctions: int
    zigzag_reversals: int; zigzag_amp_cells: float
    touches: list[int]            # components within 0.3 cell
    nearest_surface_below: tuple[int, float] | None   # (id, gap cells)
    nearest_surface_above: tuple[int, float] | None
    is_dot: bool                  # area < 0.3 cell: v1 dropped these [BUILD F7]; v2 keeps them
```

Rules: **no ink is ever dropped silently**. Specks under 0.05 cell are counted as `noise` and listed in "What I saw" ("I ignored 3 tiny specks"). Dots between 0.05 and 0.3 cell (the 8 px tap that v1 lost in 5 of 6 drawings, `[BUILD F7]`) are real components. Skeleton: `cv2.ximgproc.thinning` (present in the installed opencv-contrib 5.0.0), traced into polylines between endpoints and junctions; spurs shorter than 0.4 x width are pruned. Canvas mode skips CV: the editor posts its vector strokes, and components are formed by colour plus contact (same 8-connectivity semantics at 2 px tolerance).

### A.3 Reflex perception (deterministic, always runs, L1)

Purpose: a good-enough scene graph in under 100 ms so the Faithful build never waits for the network, and a complete fallback when the model is off. Target accuracy on the golden set: role accuracy >= 0.85 (the model is 0.95-0.97 `[MODEL A]`). Rules run in order; each assigns `role`, relations and a confidence.

| Rule | Condition (thresholds in cells unless noted) | Result | Fixes |
|---|---|---|---|
| R-flag | green component area <= 6 touching (<= 0.4) the upper half of a black stroke with angle >= 70° and length >= 1.5 | group `goal_flag` {pole, flag}; pole non-colliding | `[BUILD F1]` (6/6 pole walls) |
| R-tree | green blob area > 6 whose bottom is within 1 of one or more near-vertical black strokes | group `decoration` (canopy + trunk) | `[BUILD F2]` canopy-as-goal, trunk wall |
| R-goal | goal = the `goal_flag` group; if several, the rightmost; if none, the green component with the smallest area that is not decoration; if no green, a designer-ink flag on the rightmost reachable surface (edit `add_goal`, shown) | one goal | v1 "largest green" `[BUILD F2]` |
| R-text | cluster of >= 2 components, each height 0.5-2.5, horizontal spacing <= 1.2, baselines within 0.6, total width >= 1.5, skeleton (endpoints+junctions)/length >= 1.5; or a single component <= 2.5 tall with >= 4 endpoints and >= 6 direction changes per 2 cells, touching terrain along <= 1 cell | `text` (sign, non-colliding) | `[BUILD F3]` "jump!" wall with the model off |
| R-arrow | shaft >= 1.5 with one junction within 1.2 of an endpoint where 2 spurs of 0.3-1.2 meet at 20-70° | `arrow` with direction and length; target = nearest terrain/object within 2 of the tail or alongside the shaft | `[BUILD F3]` arrow fused onto the platform |
| R-detach | text/arrow skeleton connected to a surface by one junction whose branch area <= 3 cells | split edit `detach` (the `j` descender case) | `[BUILD F3]` |
| R-surface | black, angle <= 60°, length >= 2 | `platform`; the lowest one spanning >= 30% of the world width or touching the bottom 4 rows is `ground` | |
| R-wall | black, angle > 60°, length >= 2, not a pole | `wall` | |
| R-ceiling | a surface with another surface 2-3 rows below it and spikes attached under it, or a surface in the top 8 rows spanning >= 40% width | `ceiling` | |
| R-deco | closed loop with >= 4 radial spokes, or circularity > 0.6 in the top 40% with no surface below within 6 | `decoration` (sun, cloud) | `[BUILD F2]` sun blocks |
| R-spikes | red, zigzag_reversals >= 3, amplitude 0.25-1.5 | `spike_strip`; host = nearest surface within 2.5 perpendicular to the strip axis; facing = away from host | `[BUILD F5, F6]` |
| R-enemy | red closed blob area >= 1 with dark components inside or touching its bbox | `enemy` + `enemy_part` children (eyes, mouth) | `[BUILD F8]` eyes left as tiles |
| R-lava | red near-straight stroke below the tops of two surfaces bounding a pit | `lava` filling the pit to the stroke's height | |
| R-redline | other red near-straight stroke within 2.5 of a surface | `spike_strip` facing away from the surface | `[VIS §1]` red line floating 2 rows |
| R-coin | blue, area <= 2, dot or circle | `coin` (centroid in px, not cell) | `[BUILD F7, F14]` |
| R-key | blue closed loop with an attached stem carrying >= 2 short teeth | `key` (conf 0.5, asks if unbound) | |
| R-tag | closed circle 1-2.5 across with one inner component | `library_tag` (letter unread offline; asks) | E.1 |
| R-rest | anything else | `decoration` (visible, non-colliding), listed with "I wasn't sure what this is" | never silent |

Relations computed by reflex for every placed object: `rests_on` (surface below within 2.5 cells, face top), `attached_to` (surface/wall whose face is within 2.5 cells on the side opposite the spike teeth), `part_of` (contact and containment), and `labels` (text within 2 cells of an object). These relations are what makes snapping deterministic.

### A.4 SEE: Claude perception (L2)

**Call:** `client.beta.messages.parse`, `model="claude-opus-5"`, thinking omitted (adaptive is the default on Opus 5), `output_config={"effort": "low"}`, `betas=["server-side-fallback-2026-07-01"]`, `fallbacks="default"`, `max_tokens=8000` (the cap covers thinking + output), client `timeout=20.0, max_retries=0`. `[MODEL API facts]` verified this exact call shape 23/23 times; low effort was as accurate as medium and 1.3x faster `[MODEL A]`.

**Input:** (1) the *original* drawing area (not v1's cleaned drawing, which had already erased taps `[BUILD F17]`) at up to 1536 px wide per 2 screens, with magenta component ids and a cell ruler; long levels are split into 2-screen tiles with a 2-cell overlap, one SEE call per tile **in parallel**, so latency does not grow with length; (2) `ComponentFeatures[]` as compact JSON; (3) parent components when remixing; (4) the game's library legend (letter, name, thumbnail strip as a second image); (5) the typed rules text. No reflex roles are sent, to avoid anchoring the model on reflex mistakes.

**System prompt responsibilities** (frozen string, cached with `cache_control`; the Opus 5 cache minimum is 512 tokens `[claude-api models.md]`):
- What the sheet is; colours are hints, not laws ("kids use black for words, poles and trees"); the role list with one-line definitions; the relation semantics ("say what the creator MEANT: spikes drawn slightly above a ledge rest on it").
- Group pieces of one thing with `part_of` (eyes into a monster, pole into a flag, words into a phrase, fragments of a split ledge) `[MODEL A]` (grouping correct at all efforts).
- Bind behaviors only from the typed list, and only when the drawing or text says so; arrows bind to the object they point from or along.
- Name 1-4 **setpieces**: the parts the child obviously cares about ("the spike valley", "the monster on the bridge"). Setpieces become intent invariants (A.9).
- `difficulty_wish` from words like "super hard", "easy".
- Ask a question (max 3) whenever a gameplay-relevant role has confidence < 0.75; the threshold comes from calibration (correct labels mean 0.86, meaningful errors at 0.4 and 0.7 `[MODEL A]`).
- **Do not judge physics** (jump distances, reachability); the solver does that `[MODEL A]` (3/3 wrong without solver facts).
- Safety check as in v1.

**Schema** (`vision/app/contracts/see.py`):

```python
Role = Literal["ground","platform","wall","ceiling","spike_strip","lava","enemy","enemy_part","goal_flag",
               "coin","big_coin","key","door","checkpoint_flag","spring","text","arrow","decoration",
               "library_tag","noise"]
Face = Literal["top","bottom","left","right","none"]
Dir  = Literal["up","down","left","right","none"]

class SeeNode(BaseModel):
    id: int                         # CV component id; unknown ids are dropped by code [MODEL A: invented id 17]
    role: Role
    part_of: int | None
    rests_on: int | None; rests_face: Face
    attached_to: int | None; attached_face: Face
    facing: Dir                     # spikes, arrows, springs
    conf: float                     # 0..1, clamped in code

class BMove(BaseModel):     kind: Literal["move"];     target: int; dx: int; dy: int; speed: float | None; mode: Literal["pingpong","loop"]; source: int | None
class BEnemy(BaseModel):    kind: Literal["enemy"];    target: int; archetype: Literal["walker","hopper","flyer","shooter","chaser","crusher"]; speed: float | None; range_cells: int | None; source: int | None
class BKeyDoor(BaseModel):  kind: Literal["key_door"]; key: int; door: int              # both required: fixes v1 silent key->coin [MODEL "v1 interpretation schema"]
class BSpring(BaseModel):   kind: Literal["spring"];   target: int; dir: Literal["up","left","right"]; strength: float | None
class BCrumble(BaseModel):  kind: Literal["crumble"];  target: int
class BCheckpoint(BaseModel): kind: Literal["checkpoint"]; target: int
class BStart(BaseModel):    kind: Literal["start"];    near: int                       # the "S" text, never "the ground" [MODEL "v1 'start' binding"]
class BTimer(BaseModel):    kind: Literal["timer"];    seconds: int
class BLibrary(BaseModel):  kind: Literal["library"];  target: int; letter: str
Behavior = Annotated[BMove | BEnemy | BKeyDoor | BSpring | BCrumble | BCheckpoint | BStart | BTimer | BLibrary,
                     Field(discriminator="kind")]

class Setpiece(BaseModel):  name: str; ids: list[int]; kind: Literal["jump","hazard_run","climb","enemy","puzzle","finale","other"]
class Question(BaseModel):  about: int; ask: str; options: list[Literal["ground","platform","wall","door","decoration",
                            "enemy","spikes","lava","coin","key","text","goal","checkpoint","spring"]]

class SeeOutput(BaseModel):
    nodes: list[SeeNode]
    behaviors: list[Behavior]
    setpieces: list[Setpiece]
    intent: str                     # <= 200 chars after trimming
    difficulty_wish: Literal["none","easy","normal","hard"]
    title: str | None
    transcript: str                 # everything handwritten, verbatim
    questions: list[Question]
    safety_ok: bool; safety_reason: str | None
```

The probe schema carried a `why` string per node and `problems_noticed`; both are dropped to cut output tokens (Probe A low averaged 1,158 output tokens `[MODEL Latency]`). Phase 0 verifies that the SDK and API accept the discriminated union under structured outputs; if not, the fallback is the flat "op + nullable fields" form that Probe B used successfully, with per-variant validation in code.

### A.5 Merge policy (L2)

| Situation | Winner | Recorded as |
|---|---|---|
| SEE node conf >= 0.6, passes structural validators | SEE | `set_role` / `group` edit, provenance `see`, kind `understood` |
| SEE node conf < 0.6 | reflex | SEE's role offered as a question chip if gameplay-relevant |
| Gameplay role conf < 0.75 either side | best guess, plus question | `Question` card ("Is this a door or a wall?") |
| SEE id unknown or wrong colour for role (e.g. blue `wall`) | dropped | log only |
| Structural validator fails: the support under the spawn becomes non-colliding or moving; a `move` on a component > 60 cells or with a zero-length path; a `key_door` whose door is not a surface | rejected | `rejected` edit with reason (fixes the zero-length moving floor crash `[VIS §1]`) |
| Typed prompt | SEE only. The keyword heuristic runs **only** when SEE is unavailable, never merged on top | fixes `[BUILD F10]` (spawn spikes walking) |

Questions never block play. The build uses the best guess; answering a chip is a `user` edit followed by a rebuild (< 300 ms), with no extra model call.

### A.6 Edits: one record for every change

Every automatic or suggested change is an `Edit`. **Edits are intents, not diffs.** They store op, targets and parameters, and the builder recomputes geometry on every build. Undoing "straighten platform 4" therefore re-snaps the spikes onto the unstraightened platform instead of leaving them floating.

```python
class Edit(BaseModel):
    id: str                          # "e07"
    op: OpName                       # one of the vocabulary below
    params: dict                     # validated against the op's typed model (OpParams union)
    targets: list[str]               # object ids
    kind: Literal["understood","fixed","added","tuned","heads_up"]
    provenance: Literal["reflex","see","builder","designer_model","designer_greedy","critic","user","migration"]
    tier: Literal["faithful","polish","normal","hard"]      # the lowest dial position that includes it
    state: Literal["applied","undone","rejected","suggested"]
    reason_code: str                 # key into shared/spec/messages.json
    reason_text: str                 # kid-facing, <= 100 chars (model-written or template)
    required: bool                   # true if undoing makes the level unsolvable or unfair
    depends_on: list[str]
    metric_delta: dict | None        # {"C": +0.18, "T_s": +2.1}
    ghost: dict | None               # before/after outlines for the stage overlay
    rejected_reason: str | None
```

Build is a pure function: `build(strokes, graph, rules, edits_with_states, dial) -> LevelV2`. Toggling an edit is a rebuild plus a playtest (< 300 ms for 6 screens). Byte-identical output for identical inputs is an acceptance test.

### A.7 The vocabulary (fixed; parameters and bounds enforced in code)

**Understanding ops** (kind `understood`; from reflex, SEE or the user)

| Op | Params (bounds) | Notes |
|---|---|---|
| `set_role` | object, role ∈ Role | cannot make the spawn's support non-colliding |
| `group` | members[], role | eyes into enemy, pole+flag into goal_flag, fragments into one platform (repairs then move groups `[MODEL "Fragmented components"]`) |
| `detach` | object, branch polyline, area <= 3 cells | split fused text/arrow from terrain |
| `bind` | typed `Behavior` | from SEE, chips or the reflex heuristic |
| `link` | key, door | required pair |
| `hide_ink` | object (arrow/text bound to a behavior) | the moving platform shows the meaning; undo shows the arrow |

**Repair ops** (kind `fixed`; deterministic geometry; together these are the Faithful dial)

| Op | Params (bounds) | Rule |
|---|---|---|
| `straighten` | surface, max residual <= 0.75 cell | piecewise-linear fit (segment >= 4 cells); angle < 10° flat, 10-30° slope 1:2, 30-55° slope 1:1, > 55° wall. Removes the 4-13 one-cell bumps per level `[BUILD F4]` |
| `close_gap` | a, b, width <= 1 cell, abs(dy) <= 1 cell | accidental pen lifts; 2+ cells is a pit (intent) |
| `seam_join` | a, b across a sheet seam, gap <= 1.5, abs(dy) <= 2 | multi-sheet (C.4) |
| `thin_to_oneway` | platform with width <= 0.6 cell (9.6 px) | jump-through; prevents head bonks like `d_b14b143e` `[PLAY §3.1]` |
| `snap_to_surface` | object, host, face ∈ top/bottom/left/right, distance <= 2.5 cells | face comes from the relation, never guessed `[MODEL "Ambiguous edit semantics"]` |
| `orient` | object, facing ∈ up/down/left/right | spikes, springs |
| `ground_goal` | goal, surface, x | goal at the pole base on the surface under it; pole is scenery `[BUILD F1]` |
| `fix_motion` | object, path | zero-length path -> default 4 cells in the arrow direction, else drop the behavior; path must not leave the world |
| `place_spawn` | x, y | lowest standable cell under or near the "S", else the lowest standable cell in columns 0-8 whose support is ground/platform (never a ceiling) `[MODEL B: cave roof spawn]`; >= 0.5 cell from the world edge `[VIS §1]` |
| `clear_spawn` | radius 3 cells horizontal, 2 vertical; enemy patrol >= 4 cells away | moves the spawn <= 4 cells along its surface; otherwise moves the enemy start, never deletes the hazard `[BUILD F11]` |
| `nudge` | object/group, dx, dy ∈ [-3, 3] | minimal-displacement search to make a required jump possible; alternatives offered to DESIGN |
| `lower_wall` | wall, by 1-3 cells | alternative to nudge for unjumpable walls (the probe's "lift the wall" was intent drift `[MODEL B]`) |
| `dedupe` | new object, parent object, distance <= 0.75 cell, same role | remix re-scan duplicates (G.6) |

**Designer ops** (kinds `added`/`tuned`; drawn in designer ink; from the menu or as novel ops)

| Op | Params (bounds) | Tier allowed | Constraint |
|---|---|---|---|
| `set_enemy_param` | enemy, speed 1-6 c/s, range 2 cells..host span, archetype walker<->hopper only | polish (speed <= +1), normal, hard | not if pinned by text (`[PLAY §9]` invariant 4) |
| `set_platform_param` | platform, speed 1-6, path_scale 0.5-1.5 | polish, normal, hard | |
| `widen_gap` | gap, +1..+2 cells, total <= 8, runway >= the run-up needed | normal (+1), hard (+2) | moves the landing side only |
| `shrink_landing` | platform, -1..-2, min 2 cells | normal, hard | |
| `raise_platform` | platform, dy ∈ {-1, +1} | normal, hard | |
| `add_spikes` | surface, x0..x1, facing | normal, hard | only undrawn spans of drawn surfaces; >= 2-cell landing zones kept; >= 3 cells from spawn/checkpoints |
| `add_enemy` | archetype ∈ walker/hopper/flyer/shooter, at, params | normal (<= 1/screen), hard (<= 2/screen) | flat empty stretch >= 8 cells; >= 6 cells from spawn/checkpoints |
| `add_hazard` | saw / firebar / lava_fill, at, params | hard (saw also normal) | empty space only, >= 1 cell from drawn ink |
| `add_crumble` | platform used once on the route | normal, hard | route must not revisit it |
| `add_checkpoint` | at | polish | flat ground; after any segment with F > 20 s; no hazard within 2 cells |
| `add_coin_trail` | jump ref, n 3-6 | polish | coins on the bot's actual arc (always valid; trails were 23/23 valid in `[MODEL C]`) |
| `add_big_coin` | at, max 3 per level | polish | risk spot: a reachable off-route cell with high local p_death |
| `add_spring` | at, dir, strength 0.5-1.5 | polish (dead-end fix only) | must not bypass a setpiece (the probe's spring skipped the whole climb `[MODEL C]`) |
| `set_timer` | seconds = k·T_bot, k ∈ [1.3, 2.0] | only if a timer was requested | |
| `set_par_time` | ceil(1.3·T_bot + 1 s) | auto, every tier | medal target |
| `twist_reprise` | setpiece, at, escalation ∈ faster/add_saw/wider | hard, levels >= 3 screens | copies a drawn obstacle pattern into empty space |

### A.8 Deterministic auto-repair order (Faithful build)

1. `detach`, `set_role`, `group`, `bind`, `link`, `hide_ink` (from the merged graph).
2. `straighten` all surfaces; classify slopes.
3. `close_gap` and `seam_join`.
4. `thin_to_oneway`.
5. `snap_to_surface` + `orient` for spike strips, enemies (feet on the host top), checkpoints and springs.
6. `ground_goal`.
7. `fix_motion` and the structural validators.
8. `place_spawn`, then `clear_spawn`.
9. Playtest. If unsolvable: `nudge`/`lower_wall` search near the failure frontier. Candidates are objects whose move could connect the frontier's reachable region to the next unreached standable region on the drawn route. Try displacements in order of total cells moved (1, then 2, then 3), apply each in a sandbox, keep the first that makes the goal reachable, and keep up to 3 alternatives for DESIGN to choose from.
10. `dedupe` (remix only).

Each step emits `Edit`s with `required` computed by re-solving without that edit (cached).

### A.9 Intent invariants (checked after every designer op; any violation rejects the op)

| ID | Invariant | Check |
|---|---|---|
| I1 | Every drawn gameplay object survives with its role | object ids and roles before vs after, except `understood` edits |
| I2 | Bounded drift | repairs: <= 3 cells (`nudge`), <= 2.5 (`snap`); designer: polish 0 cells (parameters and additions only), normal <= 1, hard <= 2 `[PLAY §9]` |
| I3 | Route order and setpieces preserved | the drawn setpieces on the Faithful route appear on the new route in the same order (ordered-subsequence check on route nodes); no op may create a path that skips a setpiece |
| I4 | Text pins | parameters bound from text or rules ("slow platform", "the monster walks") are locked |
| I5 | Additions look added | designer ink style; listed in "I added" |
| I6 | Always solvable and fair | playtest: solvable, and no `block` flags (A.11) |
| I7 | Never easier than drawn | designer tiers never shrink drawn hazards or remove drawn enemies; repairs may only ease what solvability or fairness requires |
| I8 | The drawing stays the star | designer additions <= 2 per screen in polish, <= 4 per screen in normal/hard |

### A.10 Designer: menu, DESIGN call, tiers and the dial

**Candidate generation (deterministic, L3).** From the Faithful level and its report:
- gaps on the route: `widen_gap` +1/+2 where runway allows;
- landings >= 4 cells: `shrink_landing`;
- flat empty stretches >= 8 cells: `add_enemy` (walker; hopper when a ceiling has >= 4 cells of headroom);
- undrawn surface spans next to route landings: `add_spikes`;
- open air over pits: `add_hazard saw` on a short path;
- each enemy and moving platform: `set_*_param` +1 and +2 speed;
- segments with F > 20 s: `add_checkpoint`;
- blind or risky jumps: `add_coin_trail`;
- off-route risky cells: `add_big_coin`;
- dead ends: `add_spring`;
- for levels of 3+ screens: `twist_reprise` of each setpiece into empty space.

Each candidate is applied in a sandbox and validated in one `validate_many` daemon call (worker pool of 4; about 40 candidates in 0.5-1 s). Survivors carry `effect = {dC, dT, flags}` and `intent_cost` (0.1 per parameter step, 0.3 per cell of displacement, 0.5 per addition, 0.8 per twist). The menu is capped at 40 items, ranked by dC/intent_cost within each tier.

**DESIGN call** (`effort="low"`, `max_tokens=12000`, timeout 18 s). Input:
1. the original drawing (for multi-screen levels, screens stacked 3 per row so the image stays within 2576 px);
2. the merged scene graph digest (objects, setpieces, intent, difficulty wish, pinned params);
3. the level digest (surfaces with spans; the route as a table of actions with windows and p_death; segments with T_s, E_s, F; flags);
4. repair alternatives (`nudge` options);
5. the menu as compact rows: `k07 | add_enemy walker @ screen2 x70-78 (flat after the spikes) | tiers normal,hard | dC +0.18 | dT +1.4s | cost 0.5`;
6. targets: polish C in [max(C_drawn, 0.1), max(C_drawn, 0.3)], normal [0.3, 1.0], hard [1.0, 3.0].

Output schema:

```python
class Pick(BaseModel):
    candidate: str                         # menu id; unknown ids dropped
    tier: Literal["polish","normal","hard"]
    value: float | None                    # optional parameter inside the candidate's declared range
    reason: str                            # kid-facing, <= 100 chars
class RepairChoice(BaseModel):  group: str; option: str; reason: str      # pick among nudge/lower_wall alternatives
class Veto(BaseModel):          edit: str; reason: str                    # only non-required cosmetic repairs (straighten, close_gap)
class DesignOutput(BaseModel):
    repair_choices: list[RepairChoice]
    vetoes: list[Veto]
    picks: list[Pick]                      # ordered; applied in this order within each tier
    novel: list[NovelOp]                   # <= 3; typed union of the designer ops above, each with tier + reason
    designer_note: str                     # <= 240 chars, to the child
    critique: list[str]                    # <= 3 observations tied to report flags, kid words
    title_suggestion: str | None
```

**System prompt responsibilities:** you are a senior platformer designer working for a child; the drawing is theirs; follow teach -> test -> twist and give sawtooth difficulty; reward risk with big coins; make few strong moves; candidates are already proven playable, so judge **taste and intent**, not physics; never bypass a setpiece; polish raises difficulty only up to band 1, and only with parameters, checkpoints, trails, big coins and par time; choose repair options that keep the child's shapes (lower a wall rather than lift it); veto cosmetic repairs only when the wobble is clearly the point ("a bumpy cave floor"); explain each pick in one sentence a 7-year-old understands.

**Applying tiers (L3):** tiers are nested, polish ⊂ normal ⊂ hard. For each tier: apply picks of that tier and below in order, then novel ops. Check invariants after every op and playtest after every third op and at the end; on failure roll back the last op and mark it `rejected`. If the band is not reached, finish greedily from the menu by dC/cost. On overshoot, pop ops from the end until C is inside the band. Result: four builds with metrics. **The dial is instant** because all positions are precomputed; moving it swaps builds client-side. If a tier cannot reach its band without breaking invariants, the dial shows "This drawing goes up to Normal without changing what you drew".

**REFINE** (optional): when normal or hard misses its band, or more than 30% of picks were rejected, and elapsed time is under 28 s, send the deltas ("applied k03, k07; rejected k11: unsolvable; C 0.42, target 1.0-3.0") and accept one more set of picks. This matches the gameplay plan's "up to 2 refinement rounds" `[PLAY §9]`, capped at 1 round inside the latency budget and 2 rounds for prompt-to-level.

**Dial semantics and defaults**

| Position | May do | Difficulty target |
|---|---|---|
| Faithful | understanding + repair ops only | C = as drawn; solvable; fairness flags clean |
| **Polished** (default) | + polish-tier designer ops | C >= 0.1 and <= max(C_drawn, 0.3); F <= 30 s per segment; par time and medals |
| Challenging · Normal | + normal-tier ops | C in [0.3, 1.0], sawtooth across segments |
| Challenging · Hard | + hard-tier ops | C in [1.0, 3.0]; offered only for levels >= 2 screens or when `difficulty_wish = hard` |

`difficulty_wish = "hard"` from the sheet ("make it SUPER hard") pre-selects Challenging · Hard; "easy" pre-selects Polished with a C cap of 0.3.

### A.11 Playtest verification (L4)

The daemon returns a `PlaytestReport` (schema in H.2). Flags:

| Code | Severity | Definition | Auto-suggestion |
|---|---|---|---|
| `unsolvable` | block | goal not reachable (with doors: key reachable with the door closed, goal not reachable with the door closed is OK) | nudge alternatives |
| `tight_window` | block | any route action with a casual window < 4 frames `[PLAY §6]` | `widen landing`, speed -1 |
| `blind_jump` | block | the landing is outside the camera rect (camera function, C.2) at takeoff | `add_coin_trail` (breadcrumb), or nudge |
| `hazard_near_spawn` / `hazard_near_checkpoint` | block | hazard within 2 cells | `clear_spawn` / move the checkpoint |
| `enemy_overlaps_spawn` | block | patrol range within 4 cells of the spawn | `clear_spawn` |
| `invisible_lethal` | block | death by a hazard with no art, or a fall into the world bottom with no pit art | add lava/pit art |
| `long_segment` | warn | F > 30 s | `add_checkpoint` |
| `dead_end` | warn | reachable region from which the goal is unreachable and the player cannot die or return (softlock) | `add_spring`, `nudge` |
| `unreachable_drawn` | warn | a drawn platform/coin/enemy no route can reach ("did you mean to reach this?") | `nudge` |
| `trivial` | info | C < 0.05 on Polished | suggests Challenging |
| `idle_stretch` | info | > 8 s of route without a required action | `add_enemy` candidate |

Publish is blocked on any `block` flag in the selected build. Play-testing is always allowed.

### A.12 The change list and dial UX (the delightful part)

The preview's design report has three tabs, each item tied to stage highlights rendered inside the Phaser scene, so overlays follow moving sprites `[VIS §3]`:

1. **What I saw.** One row per object: a thumbnail of the child's own stroke, a role chip ("spikes ↑ on the left ground"), and confidence shown as a solid or dotted chip border. Ignored specks are counted. Question chips appear inline: "Is this a door or a wall? [Door] [Wall]".
2. **What I changed.** Cards grouped as *I understood* (pole is scenery, tree is scenery), *I fixed* (snapped spikes, smoothed the floor, planted the flag), *I added* (designer ink), and *Heads up* (flags). Each card has:
   - an icon and the one-line reason, model-written or from the template table, e.g. "Your flag was floating, so I planted it on the ground. Touch the pole to win!";
   - **Keep / Undo** (a toggle with an animated ghost: the piece slides back to where it was drawn);
   - a "why?" disclosure with the number ("This jump was 9 squares. Running you can jump 8, so I moved the ledge 1 square closer.");
   - a lock icon on `required` edits ("Undo makes the level unbeatable"). Undo is still allowed, but publish is blocked;
   - **Undo all changes** in the footer, which equals Faithful minus repairs: the raw drawing, for curiosity.
3. **How it plays.** A **Watch me play** button replays the bot's route as a dotted ghost of the child's own character. It also shows time-to-beat, each jump rated safe/tight/blind on the stage, and the critique bullets from DESIGN. **Why is this hard?** calls CRITIC with the child's own death positions.

**The dial** is a 4-stop slider: Faithful · Polished · Challenging (Normal/Hard sub-toggle). Above it sits a live **difficulty meter**: 0-5 ink drops from `score = 100·(1 − e^(−C))`, a band word, "about 1 try in 3 makes it" (P(clear first try) for a casual player), and "~55 s". Moving the dial re-inks the stage: added pieces draw themselves in with a 400 ms pencil-stroke animation in designer ink (blue-grey hatched pencil), and removed ones erase. A **Make it mine** button on any designer-ink object converts it to normal ink (still undoable).

**Designer note** at the top of the report, in the model's voice: "Your level is a race over a spike valley. I set your spikes on the platforms like you drew them and added a checkpoint after the hardest jump."

All strings come from `shared/spec/messages.json` (code -> template with params) or from the model, which is validated to <= 100 chars with no markup. Raw codes such as `goal_unreachable` are never shown `[VIS §3]`.

### A.13 Latency budget and progressive UI

| t (p50, local server, canvas level) | Event (SSE) | What the child sees |
|---|---|---|
| 0.0 s | upload | strokes animate from wobbly to cleaned ("re-inking") |
| 0.3-1.0 s | `stage: perceived_reflex` | role chips pop in with a shimmer ("first look") |
| 1.0 s | SEE request sent as soon as features and the annotated image exist (per 2-screen tile, in parallel) | "Looking closer…" with a progress dot per object |
| **~1.5-2.5 s** (p90 4 s, cap 8 s) | `faithful` (build, report, edits, quick-polish build) | **Play** is enabled. Dial shows Faithful and Polished (quick), labelled "thinking more…" |
| **~11-13 s** (p90 17 s, cap 21 s) | `scene` (merged graph, new `understood` edits, rebuilt faithful) | relabels animate (the tree's collision outline fades: "That's a tree, so it won't block you") |
| ~12-14 s | DESIGN request sent | "Designing…" with candidate count ("trying 31 ideas") |
| **~22-26 s** (p90 35 s, cap 40 s) | `polished` (4 builds, picks, note, critique) | dial unlocks Challenging; Polished replaces the quick polish with the pencil animation; designer note appears |
| +8 s (only if needed) | `refined` | Challenging · Hard updated |

Paper scans add upload (~0.5-1.5 s on LAN) and rectification (~0.4 s), so Faithful lands at about 3-4 s, inside the 8 s requirement.

**While the child is playing**, the level never swaps underneath them. An arriving `scene` or `polished` event shows a toast ("Your designer has 4 ideas") and applies at the next restart or return to the preview.

Latency numbers for SEE and DESIGN are **targets to verify in phase 0**. Measured: perception at low effort p50 11.8 s with a verbose schema, prompt-to-level at low effort 11.4 s with about 940 output tokens `[MODEL Latency]`. The compact schemas aim for <= 10 s. Phase-0 levers, in order:
1. compact schema;
2. `thinking: {"type": "disabled"}` (allowed on Opus 5 at effort <= high); adopt only if golden role accuracy stays >= 0.93;
3. fast mode (`speed: "fast"`, beta `fast-mode-2026-02-01`, Claude API only, $10/$50 per MTok), only if it at least halves latency;
4. optional speculative DESIGN on the reflex graph, started at t = 2 s and discarded if SEE changes a role on the route (flag `DAL_SPECULATIVE_DESIGN`, off by default).

### A.14 Failure handling and fallbacks

| Failure | Behaviour |
|---|---|
| No key, `DAL_FAKE_LLM=1`, offline, or daily budget exhausted | reflex graph; deterministic repair; greedy designer for all tiers (labels "quick polish"); prompt-to-level from templates; library behaviors from keywords; `/api/v2/health` shows `llm: offline` |
| SEE timeout (20 s), API error, `max_tokens` stop | keep reflex graph; `warning: looked_closer_skipped`; DESIGN runs on the reflex graph immediately (after a timeout, Polished lands at about 32-38 s); if DESIGN cannot finish inside the 40 s cap, quick polish stands |
| DESIGN timeout (18 s) or error | greedy plan stands ("quick polish"); one retry only if elapsed < 20 s |
| `stop_reason == "refusal"` after server-side fallback (checked **before** reading `parsed_output`; `usage.iterations` entries of type `fallback_message` logged as served-by) | treated as a call failure; does not block publish (Opus 5 classifiers are cyber-focused, so a refusal on a drawing is a false positive); the safety gate is `safety_ok` only |
| Partially invalid output | items validated individually: unknown ids dropped, numbers clamped, wrong-colour roles dropped; if > 50% of items are invalid, the whole response is discarded |
| Playtest daemon down | Faithful still renders; the browser worker runs the same sim for the preview; DESIGN skipped (needs server validation); publish disabled with "Checking is offline, try again in a moment" |
| Engine behavior exception | per-entity try/catch; the entity is skipped and reported; the sim never recurses (fixes `MovingPlatform.startLeg` `[VIS §1]`) |

### A.15 Cost per scan

Opus 5 at $5/$25 per MTok `[MODEL Latency]`.

| Call | In tokens | Out tokens | $ | When |
|---|---|---|---|---|
| SEE (1 sheet / 2-screen tile) | ~4.0k (image ~1.7k) | ~0.9k | ~0.043 | every scan |
| DESIGN | ~8-9k | ~1.2k | ~0.075 | every scan with a model |
| REFINE | ~5k | ~0.6k | ~0.04 (x ~30% of scans) | conditional |
| **Typical single-screen scan** | | | **~$0.13** | |
| 4-screen level (2 SEE tiles + DESIGN + REFINE share) | | | ~$0.18 | |
| 6-sheet paper level (6 SEE + DESIGN) | | | ~$0.35 | |
| Prompt-to-level (low) | ~2.5k | ~1k | ~$0.04 | per prompt |
| CRITIC / LIBRARY | ~4k / ~1.5k | ~0.8k / ~0.3k | ~$0.04 / ~$0.015 | on demand |

Guards: `DAL_MODEL_BUDGET_USD_DAY` (default 5.00) and a per-draft cap of $0.60. Every call is logged to `model_calls` (latency, tokens, cost, stop_reason, served_by). System prompts carry `cache_control` (cache reads bill at 0.1x).

### A.16 Model client (the only code that talks to Claude)

```python
# vision/app/mind/client.py
def call(kind: CallKind, system: str, content: list[dict], schema: type[T], effort: str, timeout: float,
         max_tokens: int, draft_id: str) -> CallResult[T]:
    budget.check(kind, draft_id)                        # raises BudgetExceeded -> caller falls back
    client = anthropic.Anthropic().with_options(timeout=timeout, max_retries=0)
    t0 = time.perf_counter()
    try:
        resp = client.beta.messages.parse(
            model="claude-opus-5", max_tokens=max_tokens,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            output_config={"effort": effort},          # thinking omitted = adaptive (Opus 5 default)
            betas=["server-side-fallback-2026-07-01"], fallbacks="default",
            messages=[{"role": "user", "content": content}], output_format=schema)
    except (anthropic.APITimeoutError, anthropic.APIConnectionError, anthropic.APIStatusError, ValueError) as e:
        return CallResult.failed(kind, e, time.perf_counter() - t0)
    if resp.stop_reason == "refusal":       return CallResult.refused(resp)
    if resp.stop_reason == "max_tokens":    return CallResult.truncated(resp)
    served_by_fallback = any(getattr(i, "type", None) == "fallback_message" for i in (resp.usage.iterations or []))
    return CallResult.ok(resp.parsed_output, resp, served_by_fallback)
```

The API key is read from the environment only. It is never logged, never written, and never sent to the client.

### A.17 Every model call at a glance

| Call | Effort / max_tokens / timeout | Input | Output schema | Responsibilities (prompt) | Never asked to |
|---|---|---|---|---|---|
| SEE | low / 8000 / 20 s | original drawing tile with ids, `ComponentFeatures`, parent components, library legend, typed rules | `SeeOutput` (A.4) | roles, relations with faces, groups, typed behaviors, setpieces, intent, difficulty wish, questions below 0.75, transcript, title, safety | judge distances or reachability; emit coordinates |
| DESIGN | low / 12000 / 18 s | drawing, graph digest, level digest, route table with windows, flags, repair alternatives, menu, tier targets, pinned params | `DesignOutput` (A.10) | choose repair alternatives, veto cosmetic repairs, pick and order candidates per tier, <= 3 novel ops, kid-facing reasons, designer note, critique, title | invent geometry outside the vocabulary; decide feasibility |
| REFINE | low / 6000 / 12 s | DESIGN output + applied/rejected list with reasons + metric deltas | `DesignOutput` (picks/novel only) | close the gap to the band, or say it can't | override invariants |
| CRITIC | low / 6000 / 20 s | report + the creator's telemetry (death positions and causes, attempts, segment times) | `{observations: [{segment, what}], suggestions: [Pick or NovelOp with reason]}` | explain where and why the creator dies; suggest <= 3 fixes or harder variants, validated like candidates | judge the child's skill |
| PROMPT2LEVEL | low / 8000 / 20 s | text, screens, exact physics envelope, vocabulary | `LevelSkeleton` (E.3) | teach/test/twist beats, simple primitives, fair by the stated numbers | exceed physics limits on purpose |
| LIBRARY | low / 3000 / 12 s | name, description, thumbnail | `{base_role, behavior, modifiers, summary, safety_ok}` | map words to one archetype with bounded params | invent new mechanics |
| LOOK (eval only) | medium / 6000 / 60 s | original drawing + rendered Polished + change list | `{score_1_5, per_edit: [{edit, keeps_intent, why}]}` | art-director judgement for the golden eval | gate a build at runtime |

---

## B. Gameplay

### B.1 One deterministic simulation core (`web/src/sim/`, L4)

v1 had an Arcade-physics engine and a separate solver that ported Arcade's rules approximately. The solver did not model coyote time, the buffer, enemies or timing `[PLAY §6, MODEL "v1 solver"]`. v2 inverts this: **the simulation is the game**. A pure TypeScript module steps the world at a fixed 60 Hz. Phaser only renders interpolated states, plays audio and particles, and reads input.

- Same code in four places: the Phaser engine (browser), the solver and bot (browser worker for live editor feedback; Node daemon for the server), and speedrun replay verification (daemon).
- Determinism: float64 with only `+ − × ÷`, `floor`, `round` and `sqrt` inside `step()`. Sines and rotations (flyers, firebars) use a 4096-entry table generated by a fixed polynomial at module load, so results do not depend on the JS engine's `Math.sin`. No `Date` and no `Math.random` (seeded xorshift for any variation). The frame count is the only clock. Acceptance: the same input log yields the same state hash in Chrome, Safari and Node.
- The player and entities are kinematic AABBs against a tile world (swept per axis), with explicit one-way, slope and step-assist rules. Phaser Arcade bodies are no longer used for gameplay.
- Hit-stop and death freeze are sim frames (counted in time), so replays are exact.

### B.2 Player physics: profile `v2_standard` (numbers from `[PLAY §7.1]`, verified by `proposed_physics.py`)

| Constant | Value |
|---|---|
| Cell / body | 16 px; player AABB 12 x 28 px (unchanged so v1 drawings keep their scale) |
| Walk max | 96 px/s (6 c/s) |
| Run max (hold Run: Shift / X / gamepad B; touch: auto-run after holding a direction 0.5 s) | 168 px/s (10.5 c/s) |
| Ground accel | 1000 px/s² up to walk (≈ 6 frames), then 300 px/s² up to run (≈ 0.24 s more; run-up ≈ 2.3 cells from standstill) |
| Friction (no input) | 1400 px/s² (run to stop ≈ 7 frames) |
| Skid (input opposite to velocity) | 2400 px/s², with dust particles |
| Air accel | 65% of ground; air drag with no input 200 px/s² |
| Jump launch | vy = −(340 + 0.25·abs(vx)) px/s |
| Gravity | 900 rising with jump held; 450 when held and abs(vy) < 40 (apex hang); 1700 otherwise |
| Release cut | vy = max(vy, −220) on release |
| Max fall | 330 px/s; 450 with Down (fast-fall) |
| Coyote / buffer | 100 ms (6 f) / 120 ms (7 f) |
| Corner correction | ceiling corner: nudge up to 4 px sideways; ledge corner: up to 3 px up |
| Step assist (new) | walking into a rise <= 4 px steps up (absorbs residual sub-cell seams from slope tiles and straightening) |
| Spring | vy = −600 x strength (0.5-1.5); gravity 900 while rising from a spring regardless of the button |
| Double jump (rules option, off by default) | second jump vy = −300, once per airtime |
| Stomp bounce | −280; −380 with jump held |

Resulting envelope (`proposed_physics_results.md`): standing 3.86 cells high; walking 4.45 high / 4.9 long (clears a 4-cell gap); running 4.92 high / 9.1 long (clears 8); a 1-frame tap hops about 1.1 cells. **The walk-gap (<= 4) vs run-gap (5-8) split is the new skill** `[PLAY §7.1]`. Profiles in the rules sheet (E.2): `v2_standard`, `v2_floaty` (gravity x0.8), `v2_heavy` (x1.2), and `v1` (v1 constants exactly, for migrated levels).

### B.3 Collision world

Tile alphabet in `collision.rows` (derived from terrain shapes; a cache for fast solving and for v1 tooling):

| Char | Meaning |
|---|---|
| `0` | empty |
| `1` | solid |
| `3` | one-way (top surface only; drop through with Down + Jump) |
| `4` / `5` | slope 1:1 rising right / rising left |
| `6` `7` | slope 1:2 rising right, low half / high half |
| `8` `9` | slope 1:2 rising left, high half / low half |
| `2` | full-cell hazard: **migrated v1 levels only**; v2 hazards are objects with precise hitboxes |

Walls and ceilings are solid. Doors, crumble and moving platforms are entities with their own AABBs, not tiles.

### B.4 Damage, stomp, death, lives

- **Stomp:** contact while the player's vy > 0 and the player's bottom was above the enemy's top + 4 px on the previous frame. The enemy is defeated (flattened; ink splat), the player bounces, and there are 4 frames of hit-stop. Unstompable: crusher, shooter pellets, any enemy with a `spiky` modifier (spikes drawn on its top).
- **Damage:** any other contact with an enemy or hazard. Default is one hit -> death. Rules-sheet option `hearts: 1|2|3`: knockback (vx ±120, vy −200), 60 frames invulnerable with a blink.
- **Death:** 21-frame ink-splat (the drawn character shatters into its strokes), then the strokes reassemble at the checkpoint (15 frames); 36 frames ≈ 0.6 s total versus v1's 300 ms tint `[PLAY §2.2]`.
- **Lives:** rules sheet `off | 3 | 5`, default off with a visible death counter (Celeste model; user levels vary in fairness `[PLAY §7.2]`). With lives on, 100 coins = +1 life; 0 lives = restart the level from the start (not the game).

### B.5 Enemies (all obey gravity unless stated; fixes "enemies hover" `[BUILD F9]`, `[PLAY §2.2]`)

| Archetype | Motion | Params (default, bounds) | Stompable |
|---|---|---|---|
| `walker` | walks, turns at walls; `ledge_aware` turns at ledges | speed 2.5 (1-6) c/s; range = host span or 2-20; ledge_aware true | yes |
| `hopper` | hops in place or forward | interval 1.5 (0.8-3) s; height 2.5 (1-4) cells; step 0-2 cells per hop | yes |
| `flyer` | no gravity; sine on a patrol | amplitude 1.5 (0-4) cells; period 2 (1-4) s; dx 2-20; speed 2 (1-5) | yes |
| `shooter` | stands (or walks); fires an ink pellet forward | interval 2 (1.2-4) s; pellet 4 (3-7) c/s, range 12 cells, dies on solid | body yes, pellet no |
| `chaser` | walks toward the player within 8 (4-12) cells with line of sight; climbs 1-cell steps | speed 4.5 (3-7) c/s, always below run speed | yes |
| `crusher` | no gravity; drops when the player is within ±1.5 cells horizontally below; rests 1 s; rises at 2 c/s | fall 330 px/s | no; its top is solid |

Hitbox = the drawn sprite's bbox inset 15% per side (min 10 x 10 px). Spawn: feet on the host surface top (`snap_to_surface`). The art is the child's own enemy strokes including the eyes (one object), so moving it leaves nothing behind `[BUILD F8]`.

### B.6 Hazards and platforms

| Type | Geometry and hitbox | Params (bounds) | From drawing |
|---|---|---|---|
| `spike_strip` | on a host face (top/bottom/left/right), facing away; hitbox = a 6 px band from the face, inset 2 px at the ends; art = triangles 10 px tall, count = drawn teeth ±2 (or length/12 px) | x0..x1 on the host | red zigzag (`[BUILD F5]`: v1 always made 32 px blocks) |
| `lava` | fills a pit up to the drawn line; hitbox 4 px below the surface; wave ±1 px | — | red line in a pit |
| `saw` | circle, art 24 px, hitbox r = 9 px; static spin or on a path | speed 1-6 c/s, ping-pong/loop | red circle with teeth, or designer |
| `firebar` (tier 2) | anchor + capsule, length 3-6 cells, radius 4 px | 60-180 °/s | designer (hard) |
| `rising_lava` (tier 2) | level-wide rising line after a delay | 0.3-1.0 c/s, delay 2-10 s | rule text "the lava rises" |
| solid platform | from a thick or filled stroke (width > 0.6 cell) | thickness = round(width/16) rows, >= 1 | black |
| one-way platform | thin stroke (width <= 0.6 cell) | — | black (`thin_to_oneway`, fixes head bonks) |
| slope | 1:1 or 1:2 from fitted angle | — | tilted strokes (no more staircases `[BUILD F4]`) |
| `crumble` | shakes 0.3 s, falls 0.5 s after first stand, respawns 3 s | — | "crumbles", or designer |
| `moving` | carries the player; path ping-pong or loop | speed 1-6, path length >= 1 cell (validator), <= world | "moves" + arrow |
| `spring` | up/left/right | strength 0.5-1.5 | "bouncy", spring drawing |
| `door` / `key` | door is a solid entity; the key opens a linked door | link required | text "key opens door" |
| `checkpoint` | flag; activates on touch; respawn at its standing cell | — | drawn flag with "checkpoint", or designer |

### B.7 Checkpoints, scoring, timers, medals

- **Checkpoints** sized to frustration: every segment must satisfy F_s <= 30 s (block for Polished and above, warn for Faithful) `[PLAY §6]`. Coins collected before a death stay collected. **Big coins** (max 3, designer-placed on risky off-route spots) only count once you reach the next checkpoint or the goal ("carry to safety", the Celeste strawberry rule), which turns them into real risk and reward.
- **Speedrun timer** is always on the HUD (mm:ss.cc from sim frames) and on the results card, fixing "time never shown" `[PLAY §2.2]`.
- **Lose timer** only exists when drawn or written ("60 seconds") or set in the rules sheet. The designer clamps it to >= 1.3·T_bot (v1's timers gave 11-15x slack `[PLAY §3]`, which is no pressure).
- **Medals** per level: *Finished*, *All big coins*, *Par time* (ceil(1.3·T_bot + 1 s)), *Clean ink* (no deaths). Shown on the results card and the level card.
- **Goal:** touching the drawn flag pole wins; the grab height sets the confetti size (a flourish, no score).

### B.8 Difficulty model (computed by the shared sim; prototype `gameplay/level_metrics.ts`)

**Route.** The *intended route* is the fewest-expected-deaths path through the standing graph. With equal deaths, prefer the route through drawn setpieces in drawn order.

**Per required action i** (jump, run-jump, drop, ride, stomp, timed pass; plain walking is not an action):
- `w_i` takeoff window (frames). Sweep takeoff px positions on the source span at the speed the action uses. Run-jumps simulate the run-up from the runway start. Divide the contiguous succeeding px by px-per-frame at that speed.
- `h_i` hold window. The number of hold lengths 1..40 frames that succeed from the best takeoff. Policies include releasing the direction mid-air at frame k ∈ {4, 8, 12, 16}, which fixes the prototype's pessimism on small landings `[PLAY §11]`.
- `φ_i` phase window, for actions that interact with timed entities. Sample 24 phases per entity cycle and count successes x cycle_frames/24. Stomp counts as success.
- `L_i` lethal share: the fraction of failing samples that end in death (vs a safe miss).
- `p_i = 1 − Π_{x∈{w,h,φ} present} (1 − 2Φ(−x/(2σ)))`, with σ = 3 frames (casual) or 1.5 (skilled). Then `d_i = p_i·L_i`.

**Per segment s** (between checkpoints): `E_s = Σ d_i`, `T_s` = fastest frames/60.

**Level scores:** `C = max_s E_s + 0.25·Σ_s E_s`; `F = Σ_s E_s·T_s`; `score = round(100·(1 − e^(−C)))`. Expected casual clear time `≈ Σ_s T_s·(1 + E_s) + 0.6·Σ E_s`.

**Bands** (casual C), from `[PLAY §6]`: Trivial < 0.05, Easy 0.05-0.3, Normal 0.3-1.0, Hard 1.0-3.0, Expert > 3 (the designer never targets Expert).

**Solver algorithm** (bounded cost for 288 x 27):
1. Static pass: standing graph with walk, jump (3 holds x 3 dirs x 2 release policies), run-jump (runway-aware), drop, spring and one-way drop-through actions. Doors closed and open variants. Time-dependent entities ignored except as "possible support" (moving platforms) and "danger zones" (swept enemy volumes).
2. Timed pass, only where the static route crosses a moving platform or a danger zone: local time-expanded search with wait actions in 6-frame steps over 24 phase samples.
3. Metrics pass on the route (windows by sweeping).
4. Camera pass: the camera function (C.2) is simulated along the route, and blind jumps are flagged when the landing rect is not inside the camera view at takeoff.

Budget: one screen < 60 ms, six screens < 400 ms in the daemon; the browser worker is debounced 400 ms for editor halos.

**Calibration tests** (vitest, profile `v1`, σ = 3) run in two modes.
- `policies: "prototype"` (hold the direction for the whole jump, no coyote, as `level_metrics.ts` did) must reproduce the prototype within ±10%: 4/5/6-cell spike pit E = 0.000/0.004/0.049; pillars E = 1.92, P(clear) 9%; Synth 1 E = 0.125 `[PLAY §3]`.
- In full mode (mid-air release, coyote) every E must be <= the prototype value, because the extra policies only widen windows.

Profile `v2_standard` must reproduce the envelope table within 0.1 cell `[PLAY §10]`.

### B.9 How the dial uses the model

- The DESIGN menu carries dC per candidate, so the model trades difficulty against intent cost with real numbers.
- Tier targets are bands of C (A.10). Overshoot pops ops; undershoot runs greedy completion.
- **Sawtooth:** in Challenging, the generator prefers candidates that raise later segments. A soft objective: `E_{s+1} >= 0.8·E_s` until the last segment, and the first segment after a checkpoint gets a "rest" (the generator skips additions within 6 cells after a checkpoint).
- **Pacing:** Polished aims for no `idle_stretch` (> 8 s without a required action). Starter World requires >= 8 actions per screen on average (>= 6 in level 1) `[PLAY §10]`.
- The difficulty meter and the "Beat my level" badge show `score` and the band. Leaderboards sort by it.

---

## C. Scrolling levels

### C.1 World size

- The viewport stays 48 x 27 cells (768 x 432 world px) so the drawing scale is unchanged `[PLAY §7.3]`.
- World = 48·k x 27, with k = 1..6 screens (up to 288 cells, about SMB 1-1 length in player-height units `[PLAY §7.3]`). The schema allows h = 27·m with m <= 2 behind a feature flag (`DAL_TALL_LEVELS`), off for v2.0.
- Everything takes `world.w` / `world.h` from the level: sim, solver, renderer, editor and CV stitching. This removes the hard-coded `GAME_W`/`GRID_W` `[PLAY §6]`.

### C.2 Camera (a pure function in `sim/camera.ts`, shared by the engine and the blind-jump check)

| Rule | Value |
|---|---|
| Horizontal dead zone | 4 cells wide, centred |
| Look-ahead | 6 cells in the movement direction (facing when still), eased at lerp 0.1 per frame |
| Vertical | for h = 27 the camera is vertically fixed; for tall levels, platform-snap on landing (lerp 0.15) and follow while falling when the player leaves the middle 60% band |
| Clamp | world bounds |
| Optional rule `no_backscroll` | the camera never moves left of its max x (SMB mode), never past a checkpoint |

With run speed 10.5 c/s and a 9.1-cell max run jump, 6 cells of look-ahead plus half a screen (24 cells) keeps every legal landing on screen. The blind-jump flag catches drawings that break this.

### C.3 Long canvas editor (L6)

- **Vector strokes** in world px: `{id, color, width, points[], pressure[], meaning?, provenance}`; undo/redo 100 steps; select/move/delete; stroke-erase (tap deletes a stroke) and scrub-erase.
- **Navigation:** pan (two-finger drag, space-drag, or middle mouse); zoom 0.25x-3x (pinch, wheel); **+ Add screen** extends the world right (max 6); a minimap strip at the top shows the whole level with the viewport box; **Trim** removes empty trailing screens.
- **Brush:** 14 px marker with pressure; **a tap stamps a 16 px dot**, so coins register (fixes `[BUILD F7]`, `[VIS §2]`). Hold-to-straighten: holding still 400 ms at stroke end snaps to a line or arc. Row snap is optional (light magnet to cell rows).
- **Stamps:** coin, flag, spikes, enemy, spring, checkpoint, key, door, plus library objects. A stamp places vector strokes that are pre-tagged (provenance `canvas`, meaning set), so perception is trivial and reliable.
- **Live understanding:** 400 ms after each stroke, `POST /api/v2/reflex` (vectors only, < 100 ms) returns role chips per stroke. A browser worker runs the sim solver from the spawn to show a reach halo, red dashes on gaps wider than the run jump, and a "blind" eye icon.
- **Rules attached to strokes:** tap a stroke -> "What does it do?" chip picker over the fixed vocabulary (moves ↔ N cells, patrols, hops, flies, shoots, bounces, crumbles, door, key -> tap its door, checkpoint). This creates typed behaviors directly (provenance `user`, no model needed). Free text still goes to SEE.
- **Submit** sends `strokes.json`, the character strokes and the rules text. The server renders the annotated image for SEE from the vectors, so there is no lossy raster path.

### C.4 Multi-sheet paper

- **Template v2** (`shared/template_spec_v2.json`): the same A4 layout, drawing area 240 x 135 mm = one screen.
  - Both side edges get a 5 mm "seam margin" outside the drawing area with gray row ticks every 3 rows and arrows "← sheet n−1 | sheet n+1 →".
  - Remix and set sheets print the neighbour's last 2 cells in light gray inside the margin, so ground heights line up.
- **QR grammar v2** (v1 payloads still accepted): `dal2|set|<set_id>|<n>/<k>`, `dal2|rmx|<level_id>|<n>/<k>`, `dal2|gam|<game_id>|<n>/<k>`, `dal2|rul|<game_id>`, `dal2|lib|<game_id>`.
- **Sets:** `POST /api/v2/sets {k, game_id?, parent_id?}` returns a k-page PDF. Pages can be scanned in any order. The scan screen shows a checklist "Sheet 2 of 4 ✓". The level builds when all sheets are present; "Build with sheets 1-3" is allowed if they are contiguous from 1.
- **Stitching (L1 `stitch.py`):**
  - each sheet is rectified and colour-calibrated independently;
  - strokes are offset by 768·(n−1) world px;
  - component ids become global (`sheet·1000 + id`);
  - at each seam, terrain ends within 2 cells of the edge are matched by role and abs(dy) <= 2 cells and joined with `seam_join` (an explained edit: "I joined your ground across sheets 1 and 2");
  - unmatched ends are left as pits.
- **SEE per sheet** runs in parallel; DESIGN runs once for the whole level.

### C.5 Remix across sheets

- The remix PDF prints all k pages of the parent in gray with object numbers.
- The child may rescan only the pages they changed. Unchanged pages inherit the parent's strokes and graph. New ink on a page is added to the parent's scene with provenance `child`.
- The parent's applied edits are baked into the parent's geometry. The child's own edits are new.
- `parent_id` + `changed_sheets: [n]` are stored, and the tree view shows a per-sheet diff highlight.
- **Coin dedupe:** a new collectible within 0.75 cell of a parent collectible with the same role is the same object (`dedupe` edit, "This coin was already there"). Remix sheets also print parent coins as hollow gray circles, which the gray class already ignores.

---

## D. Visual quality: from a drawing to beautiful game art

### D.1 One source of truth: art is rendered from the fitted geometry

v1 showed a nearest-neighbour photo over an invisible tile grid that it derived separately. The drawn line top and the standing surface were off by 4 px or more on 56-96% of surface cells `[BUILD F13]`. v2 derives **both** collision and art from the same fitted object geometry (L3 `build/art.py` emits `ArtStroke[]`; L5 renders them):

| Object | Collision | Art |
|---|---|---|
| ground / solid platform | top edge = fitted polyline snapped to the cell boundary `y_c = round(ink_top/16)·16`; solid below (ground: to the world bottom; platform: `thickness` rows) | marker stroke whose **top edge lies exactly on `y_c`** (the hand feel stays in the lower edge's width variation from pressure/DT, ±1.5 px), plus a pencil cross-hatch fill below at 18% opacity, which says "solid" |
| one-way platform | top edge only | the stroke alone, with tiny plank ticks underneath, which says "jump through" |
| slope | slope tiles | straight fitted stroke on the tile diagonal |
| wall / ceiling | solid cells | stroke + hatch on the solid side |
| spike strip | 6 px band on the host face | regenerated triangles along the host face, facing away, teeth count ≈ drawn |
| coin / key | circle r 6 px | the child's dot/circle fitted to a circle (if circularity > 0.6) and filled, with a shine; keys keep their drawn strokes |
| goal flag | pole column win zone | the child's pole (straightened vertical) + flag strokes, planted on the surface; **no engine flag** `[BUILD F14]` |
| enemy | inset bbox | the child's strokes (body + eyes + mouth) rendered to a texture at 4x; **no raster crop and no whitening** (fixes the floor notch and dark fringes `[BUILD F8, F15]`) |
| decoration / text | none | lightly smoothed strokes in the scenery layer at 85% / signs at 70% |
| designer additions | per type | same shapes in **designer ink**: blue-grey pencil with hatch and a one-time sparkle |

**Nothing is erased from a backdrop**, because there is no backdrop: every stroke belongs to an object and is drawn once. Collected coins disappear, and dynamic objects carry their own art. The original photo is an optional "sketch" layer at 15% opacity (toggle "show my original") `[VIS §4a]`.

Acceptance (automated): for every walkable surface sample every 4 px, `abs(art_top − collision_top) <= 1 px`. Collision with no art above it = 0 cells. Art with no object = 0 strokes.

### D.2 Stroke cleanup

Per stroke:
1. RDP simplification (ε 0.75 px);
2. corner detection (keep vertices with turning angle > 60°);
3. Chaikin smoothing, 2 iterations, between corners only;
4. role-specific beautify (fitting for surfaces, circle fit for coins, vertical pole, triangle regeneration for spikes);
5. width profile from the distance transform (paper) or pressure (canvas), smoothed, with 20% end tapers.

Strokes keep their identity, so the child recognises "my line, but neat".

### D.3 Renderer (`web/src/render/`, L5)

- Phaser config: `pixelArt: false`, `antialias: true`. The canvas internal size = container CSS size x min(devicePixelRatio, 2). The camera zoom maps the 768 x 432 world screen onto it, so physics stays in 16 px cells and ink renders at native resolution. This fixes the 1.74x nearest-neighbour stretch `[VIS §1]`. Raster textures (character fallback, sketch layer) use LINEAR filtering.
- Ink is drawn with Phaser Graphics into RenderTextures in **chunks 1024 world px wide** (memory-safe for 6 screens) at the zoomed resolution, re-rendered on zoom changes.
- **Line boil:** 3 variants per chunk with seeded vertex jitter ±0.6 world px, cycled every 6 frames (10 fps) `[VIS §4a]`. Gameplay geometry never moves. With `prefers-reduced-motion`, 1 variant.
- **Paper:** a procedural fBm grain tile (512 px, 4% contrast) + 5 mm dot grid at 5% + 6% vignette. Theme tints (E.2).
- **Parallax:** 2 background layers of generated light-pencil doodles (seeded by level id + theme: hills/clouds, trees, stalactites, stars, lollipops) at scroll factors 0.25 and 0.5, 15-25% opacity. A foreground grass/ink-tuft layer at 1.1 only *below* ground surface tops, so it never hides gameplay.
- Layer order: paper < parallax < sketch (optional) < scenery/signs < terrain hatch < terrain strokes < objects < player < particles < foreground < HUD.

### D.4 Animation from one drawing (`render/rig.ts`)

**Player** (from the character box or the studio):
- Legs: if the bottom 30% of the ink has >= 2 near-vertical strokes, those are the legs, pivoting at their tops. Otherwise 2 stick legs are synthesised (v1 doodle style).
- Walk: legs swing ±18° at frequency speed/(2·0.6 cell); body bob 1 px at 2x that frequency; lean 4°·(vx/run).
- Squash and stretch: takeoff 0.85 x / 1.15 y over 5 f; apex 1.0; land 1.2 x / 0.8 y over 6 f, easing back over 7 f.
- Idle: breathing scaleY 1.00-1.03 at 0.5 Hz.
- Blink: if 2 small closed dark blobs sit in the upper half, they are eyes, rendered on their own layer and squashed to 10% for 6 f every 2.5-5 s.
- Turn: flipX with a 4 f squash. Skid pose: lean back 8° plus dust.

**Enemies:**
- waddle ±5° at 2 Hz; hopper squash before each hop;
- "angry" eye flash (scale 1.2) when the player is within 4 cells;
- stomped: scaleY 0.3, ink splat, gone after 18 f.

**World:**
- coins spin (scaleX cosine) and bob 2 px;
- springs compress on use;
- crumble shakes for 0.3 s before falling;
- saws rotate 360°/s;
- lava waves with bubbles;
- checkpoint flag unfurls on activation.

### D.5 Particles and juice (pre-baked ink-dot textures)

| Event | Effect |
|---|---|
| land (vy > 200) | 6 dust puffs, scaled by fall speed; camera shake 0 |
| skid / turn at run | 3 puffs per 4 f |
| jump | 4 puffs at the feet |
| coin | 8-dot sparkle; the coin flies to the HUD counter (300 ms ease-in) |
| big coin | ring burst + 2 f flash; rotating halo until banked |
| stomp | 4 f hit-stop, splat, "pop" rings |
| death | 4 f hit-stop; the character shatters into its strokes (21 f), reassembles at the checkpoint (15 f); shake 4 px for 10 f |
| spring | shock ring |
| checkpoint | flag unfurl + 12 confetti scribbles |
| goal | confetti of tiny scribbles (size by grab height), a fanfare; the HTML results card slides in after 45 f |

### D.6 Synthesised sound (`web/src/audio/sfx.ts`, WebAudio, no asset files)

The context is unlocked on first input; there is a mute toggle (persisted in localStorage); `noAudio` is removed `[PLAY §2.2]`.

| SFX | Recipe |
|---|---|
| jump | square 220 -> 660 Hz exponential over 120 ms; attack 5 ms, decay 110 ms; gain 0.25 |
| land | white noise, lowpass 400 Hz, 60 ms; gain by fall speed |
| coin | triangle 988 Hz 60 ms then 1319 Hz 90 ms; +1 semitone per coin within 1 s (cap +7) |
| big coin | coin arpeggio x3 + shimmer (sine 2637 Hz tremolo) |
| stomp | square 440 -> 110 Hz 80 ms + noise burst 40 ms |
| death | sawtooth 440 -> 55 Hz 400 ms + noise 120 ms |
| spring | FM "boing": carrier 300 Hz, modulator 30 Hz, index 8 -> 0 over 300 ms |
| checkpoint | triangle C5-E5-G5, 70 ms each |
| crumble | bandpass noise 1 kHz, crackle 250 ms |
| saw (loop) | filtered noise, gain by distance <= 8 cells |
| goal | C5-E5-G5-C6 (100/100/100/300 ms) square+triangle |

Optional music: a generative 4-bar loop per theme (pentatonic, 96 bpm), default on at 30% gain.

### D.7 HUD and the single win moment

- The HUD sits on a **paper plate** (rounded card, drop shadow) so it never collides with ceiling ink `[VIS §1]`. Left: time, coins x/y, big-coin slots, deaths (and hearts/lives when enabled). Right: pause, restart, mute. Bottom: a minimap strip for k > 1.
- Font: "Patrick Hand" (OFL), **bundled** in `web/public/fonts/` so it works offline. It is used across HUD and chrome.
- Win: the canvas only plays confetti and the fanfare. The **HTML results card** is the only text UI: time, PB, rank, coins, big coins, deaths, medals earned, a ghost of the best run, and buttons Next level / Retry / Remix / Leaderboard. `Hud.showBanner` is deleted (fixes the duplicate win banner, G.1).

### D.8 Preview UX (L6, `web/src/screens/preview.ts` rebuilt)

- Layout (desktop): stage 2/3 left, design report 1/3 right. Mobile: stage on top; the report is a bottom sheet with tabs *Saw · Changed · Plays*.
- Stage overlays live in a Phaser overlay layer (they follow sprites): selection glow, before/after ghosts, the bot route ghost, flag pins, reach halo.
- Header: title suggestion (editable), the dial, the difficulty meter, Play test, Publish.
- **Publish gating:**
  - disabled while a `block` flag exists, with plain-language reasons from the message table;
  - disabled on any build or engine failure ("I couldn't build the moving platform: its path has no length. [Fix it for me]");
  - disabled if `safety_ok = false`.
- **Status line** shows streaming stages ("First look · Looking closer · Designing · Done") with honest fallbacks ("Designer is offline, so I used quick polish").
- **Back to drawing** returns to the vector editor with all strokes. Accepted repairs can optionally be applied to the strokes ("Keep my fixes in the drawing"), so the child sees the cleaned lines in the editor.

### D.9 Chrome and thumbnails

- The app adopts the paper/ink identity: paper cards, marker underlines, tape corners, Patrick Hand. The dev footer and fixture links move to `#/dev` `[VIS §1]`.
- Thumbnails are rendered by the same ink renderer offscreen (first screen + minimap strip) and include entities, player and flag. Seeded levels use the same renderer, so there are no flat-block backdrops `[VIS §1]`.

---

## E. Library, rules sheet, prompt-to-level, social, open format

### E.1 Object library per game

```python
class LibraryObject(BaseModel):
    id: str; game_id: str; name: str                 # "Bob"
    letter: str                                      # paper tag letter, unique per game: "B"
    base_role: Literal["enemy","platform","hazard","collectible","spring","decoration"]
    behavior: Behavior | None                        # typed, same union as SEE (e.g. BEnemy hopper interval 2)
    modifiers: list[Literal["spiky","heavy","tiny","bouncy"]]
    strokes: list[Stroke]                            # the drawing, normalised to a 2x2-cell box
    sprite_url: str                                  # rendered at 4x from strokes
    author: str; created_at: str; uses: int
```

- **Creature studio** (`#/studio?game=`): a large vector canvas (the character box is unified here; see G.7), name field, "What does it do?" text, and a live mini-stage where the creature acts out its behavior on a test platform.
- **LIBRARY call** (Claude low, ~$0.015): text + thumbnail -> `{base_role, behavior, modifiers, summary <= 100 chars, safety_ok}`. Example: "It hops every 2 seconds and has spikes on top, so you can't jump on it." The child confirms with chips and can adjust parameters with sliders bounded by B.5. Offline: keyword mapping (hops/jumps -> hopper, flies -> flyer, shoots -> shooter, chases/follows -> chaser, falls/smash -> crusher, walks -> walker; "spiky" -> modifier).
- **Placement:**
  - Editor: library objects appear in the stamp palette; dropping one places an instance (provenance `library`).
  - Paper: the game's add-a-level template prints a **library legend** ("Ⓑ Bob · hopper"). The child draws a circled letter where the creature goes. Reflex detects `library_tag`; SEE reads the letter and binds `BLibrary`.
  - Sketch matching: if the child draws the creature itself, SEE gets the library thumbnails as a second image and may bind `BLibrary` with conf >= 0.75. Lower confidence becomes a question chip ("Is this Bob?").
  - Offline: tags become a question chip with a picker.
- Instances render the library art (cleaned once, consistent across levels) and use the library behavior; per-instance overrides of speed/range are allowed within bounds. Changing a library object re-verifies all levels that use it (batch playtest, the E.2 rule).

### E.2 Game rules sheet

```python
class GameRules(BaseModel):
    physics_profile: Literal["v2_standard","v2_floaty","v2_heavy","v1"] = "v2_standard"
    abilities: Abilities                 # run: bool=True, double_jump: bool=False, stomp: bool=True, fast_fall: bool=True
    lives: Literal["off","3","5"] = "off"
    hearts: Literal[1,2,3] = 1
    theme: Literal["paper","forest","cave","space","candy"] = "paper"
    camera: Literal["follow","no_backscroll"] = "follow"
    default_dial: Literal["faithful","polished","challenging_normal","challenging_hard"] = "polished"
    music: bool = True
```

- Editable in `#/game/:id/rules` (chips and toggles), or via a **printed rules sheet** (`dal2|rul|<game_id>`) with checkboxes for each ability, lives and hearts, 5 theme pictograms, and one free line "My world is…".
- Checkboxes are read deterministically: fill ratio > 35% inside known boxes from `template_spec_v2.json`. The free line goes to SEE (low) or keyword matching.
- **Safety rule:** a rules change re-runs the playtest for every level in the game, as a background job. Levels that become unsolvable (for example, turning off *run* makes run-gaps impossible) block the change and list the affected levels. The creator can either let the designer repair them (Faithful nudges, shown per level) or cancel.
- Themes set the paper tint, parallax doodle set, ambient particles (leaves, dust, stars, sprinkles), the music scale, and the designer-ink hue.

### E.3 Prompt-to-level

1. `POST /api/v2/prompt-level {text, screens?: 1-6, game_id?}` -> job (SSE).
2. **PROMPT2LEVEL call** (Claude low; Probe D: 5/5 skeletons solvable, low as good as medium and 2.6x faster `[MODEL D]`). Physics facts given exactly: walk gap <= 4, run gap <= 8 with runway >= 3, rise <= 4 while moving, 3 standing; enemies stand on surfaces; key reachable with the door closed.
   ```python
   class Beat(BaseModel): screen: int; kind: Literal["teach","test","twist","rest","finale"]; idea: str
   class TerrainPrim(BaseModel): kind: Literal["flat","platform","wall","step","pit_floor","ceiling"]; x0: int; x1: int; y: int; thickness: int; collision: Literal["solid","oneway"]
   class LevelSkeleton(BaseModel):
       title: str; screens: int; note: str; beats: list[Beat]
       terrain: list[TerrainPrim]; objects: list[SkeletonObject]   # typed union: enemy, spikes, saw, coin, big_coin, checkpoint, spring, crumble, moving, key, door, lava
       start: Point; goal: Point
   ```
3. Code rasterises the skeleton into **pencil strokes** (light blue-grey, slightly wobbly, provenance `prompt`) and a scene graph with roles already set (no SEE needed). It runs the normal build + repair + playtest. If unsolvable: deterministic nudge; if still failing, one retry call with the failure facts (the probe's "retry once" `[MODEL "Model vs deterministic"]`).
4. The draft opens in the long-canvas editor. The child draws over and around the pencil, erases what they don't want, and submits. The pipeline runs as for any canvas level. Skeleton strokes the child kept keep their roles; the child's strokes go through SEE.
5. Offline: 8 parametric templates (flat-teach, pits, tower, cave, gauntlet, key-door, enemy-parade, crumble-bridge) chosen by keywords, with seeded variation.

### E.4 Speedruns and "beat my level"

- Every attempt records an **input log** (per-frame button bitmask left/right/down/jump/run, run-length encoded; ~1-4 KB per minute).
- `POST /api/v2/levels/{id}/runs {player, input_log, claimed_frames}`: the daemon replays the log on the exact level version (`level_hash` = sha256 of the canonical level JSON + rules). The run is verified only if the replay reaches the goal at `claimed_frames`. Time = frames/60. This is cheat-resistant without accounts.
- Tables per level: top 10 verified, personal best (by name in localStorage), recent runs. Each run stores the replay trace, rendered as a translucent **ghost** of the runner's character in play.
- **Beat my level:** share `#/play/<id>?vs=<run_id>`. The challenger's ghost and time are shown at start; beating it shows "You beat maya by 1.42 s!" with a share link back. Level cards show the best time, difficulty score, band and medals earned.
- Edits create a new `level_hash`. Old runs stay attached to their version and are labelled "on an older version".

### E.5 Format v2 as a public spec, and v1 migration

- `shared/spec/README.md` is a human-readable spec for `dal-level` v2: coordinate system, units, every object type and its parameters and bounds, tile alphabet, physics profiles (exact constants), rule vocabulary, edit records, the camera function, the difficulty model formulas, and the input-log format.
- JSON Schemas are generated from the Pydantic contracts (`scripts/gen_contracts.sh`).
- **Conformance suite** `shared/spec/conformance/`: 30 levels + input logs + expected per-frame state hashes at frames 60/600/end + expected solver outputs. An implementation is conformant when it reproduces the hashes. This is what makes "anyone can build an engine" testable `[PROJECT_CONTEXT]`.
- Licence MIT (code) / CC0 (spec and Starter World).
- Versioning: `schema_version: 2`. Minor versions add optional fields only. Unknown `x_*` fields are allowed for extensions and must be ignored.
- **v1 migration** (`vision/app/format/migrate_v1.py`, deterministic, runs once at startup over the `levels` table; v1 JSON kept in `json_v1`):
  - maximal runs of `1` cells become solid terrain rects;
  - `2` cells become `spike_strip` objects with facing inferred from the adjacent solid (or tile `2` kept when ambiguous);
  - entities are mapped 1:1 (`enemy` -> walker with `gravity: false` kept for fidelity, flagged);
  - backdrop -> sketch layer;
  - `physics_profile: "v1"`, so the level plays exactly as before.
  - An **Upgrade to v2** button runs the Faithful designer on the migrated level under `v2_standard` and verifies it. Repairs and dial apply as for new scans.
- The v1 `/api/*` endpoints keep working (they return v1 JSON from `json_v1` for v1 levels); new clients use `/api/v2/*`.

---

## F. Starter World v2 (rebuilt; the first impression)

v1's starters are a tutorial with no test: 1-3 jumps, no hazard next to walkable ground, an optional enemy, E[deaths] 0.000/0.004/0.000 `[PLAY §3, §7.4]`. v2 replaces them with 5 hand-authored long levels on a rising sawtooth curve. Each level follows **teach -> test -> twist -> finale**, and each is verified by the playtest bot against its band.

| # | Title | Screens | Teaches | Target C (casual) | Accept C | Bot fastest | Big coins |
|---|---|---|---|---|---|---|---|
| 1 | Doodle Dash | 3 | run, jump, stomp | 0.10 | 0.07-0.15 | 18-25 s | 3 |
| 2 | Spike Garden | 4 | oriented spikes, one-way ledges | 0.30 | 0.22-0.38 | 22-32 s | 3 |
| 3 | Crumble Canyon | 4 | crumble, moving platforms, saws | 0.60 | 0.45-0.75 | 25-38 s | 3 |
| 4 | Key Keep | 5 | key and door, springs, shooter, chaser, crusher | 1.00 | 0.75-1.25 | 32-50 s | 3 |
| 5 | The Long Scribble (finale) | 6 | everything + firebar + rising lava | 1.60 | 1.20-2.00 | 40-60 s | 3 |

**Expected casual clear time 40-90 s per level** (bot fastest x ≈ 2 plus expected deaths x segment replay). This deliberately reads `[PLAY §10]`'s "40 to 90 s" as the casual human time, because a frame-perfect bot is about twice as fast as a casual player.

**Beat sheets** (x in cells from the level start; ground row 23 unless stated)

1. **Doodle Dash**
   - S1 *teach run+jump*: flat 0-14; 2-row step at 15; 3-cell lava pit 22-24 (walk gap) with a 4-coin trail over it; flat to 47.
   - S2 *teach stomp, test run-up*:
     - first walker on safe flat ground 56-70 (the SMB rule: first enemy on a safe flat `[PLAY §5]`);
     - 6-cell pit at 78-83 that needs a run-up (runway 64-77);
     - big coin 1 at the run-jump apex above the pit;
     - checkpoint at 88.
   - S3 *twist + finale*: a 3-tier one-way staircase (rise 3) with a walker on tier 2; big coin 2 on a high ledge reachable only by a stomp-bounce (−380 held); 2 walkers on a long flat before a 5-cell pit; flag on a hill at 138; big coin 3 in a pit alcove.
2. **Spike Garden**
   - S1 *teach*: a 3-cell up-facing spike patch on the floor with 3-cell clear landings either side; a low corridor (3 rows of headroom) with down-facing ceiling spikes that teaches the 1.1-cell tap hop.
   - S2 *test*: a one-way ledge tower (4 ledges, rise 3, alternating) beside a wall with left-facing spikes; a hopper on the top ledge; checkpoint after.
   - S3 *twist*: spike-topped platforms over a spike floor, with 3-cell landings between spike spans; a walker on a one-way bridge.
   - S4 *finale*: a 7-cell run-gap over spikes (fast route) vs a mid-air one-way ledge with a hopper (safe, slower route); flag.
3. **Crumble Canyon**
   - S1 *teach crumble* over a shallow non-lethal pit, then crumble over lava.
   - S2 *test*: a horizontal moving platform (3 c/s) over a 12-cell lava pit, with a saw on a vertical path by the landing; checkpoint at the start of S2.
   - S3 *twist*: rhythm crumble-crumble-saw, where the saw sweeps the third crumble's air space (a phase window); big coin under the saw path.
   - S4 *finale*: a vertical moving platform up a shaft with left/right wall spikes and a flyer; flag at the top; checkpoint at the start of S4.
4. **Key Keep**
   - S1 *teach*: a shooter on a ledge firing across a flat (dodge pellets with hops); a spring up to a ledge.
   - S2: the door at x ≈ 100 blocks the floor; the key route goes up via spring -> one-way tower with a hopper.
   - S3: the key at the top; return down a crumble staircase (a different path, no backtracking boredom); checkpoint after the key.
   - S4: through the door; a chaser activates in a corridor of crumbles; a side spring launches over a spike wall; checkpoint after.
   - S5 *finale*: 3 crushers over a flat (timing), flag on a hill.
5. **The Long Scribble**
   - S1-S5 twist reprises of levels 1-4, each escalated (faster walkers, wider run-gaps, saw + crumble, double shooter), plus a firebar room.
   - S6 *finale*: rising lava (0.5 c/s after 3 s) up a one-way tower to the flag.
   - Unlocked from the start; marked "Hard".

**Authoring and verification (L4).**
- `shared/fixtures/v2/starter/make_starter.py` uses a small DSL: `ground(x0, x1, y)`, `oneway(...)`, `spikes(host, x0, x1)`, `enemy("walker", x, host, **p)`, `checkpoint(x)`, `big_coin(x, y)`. It emits **vector strokes** with seeded hand wobble and pre-tagged meanings, so the levels look hand-drawn and go through the real pipeline (reflex + build, `dial=faithful`; the designer must not touch hand-authored levels).
- The daemon writes `levels/*.json` and `metrics.json`.
- CI (`starter.test.ts`) asserts for each level:
  - C within the accept band;
  - 0 block flags;
  - F_s <= 30 s for every segment;
  - sawtooth (the max E_s is in the last 2 segments);
  - >= 1 engaged enemy (the route intersects an enemy's swept volume) in levels 2-5;
  - >= 8 required actions per screen on average in levels 2-5 (>= 6 in level 1) `[PLAY §10]`;
  - 3 reachable big coins;
  - par time present.
- **Designer showcase:** the seed also publishes "Doodle Dash (Challenging)", built by the designer from level 1 at Normal with designer ink visible, as a remix under level 1. The remix tree then demonstrates the dial on day one.

---

## G. v1 review fixes

| # | v1 defect | v2 fix | Verified by |
|---|---|---|---|
| G.1 | Duplicate win banner (canvas card + HTML overlay) `[VIS §1]` | `Hud.showBanner` removed; the canvas plays confetti only; the HTML results card is the single win UI (D.7) | e2e: after a win, exactly one `[data-role=results]` element exists and the scene has no text objects tagged `banner` |
| G.2 | Single brush tap too small to register (8 px brush vs 0.3-cell minimum) `[BUILD F7]` | 14 px brush; a tap stamps a 16 px dot; CV keeps dots >= 0.05 cell; blue dot -> coin; nothing is dropped silently | sweep test: 6/8/10/12 px taps all become coins; golden G01-G06 coins drawn == built |
| G.3 | Enemies hover in mid-air (no gravity) `[BUILD F9]`, `[PLAY §2.2]` | gravity by default; `snap_to_surface` places feet on the host; only `flyer` hovers | sim test: a walker dropped 3 cells lands within 30 frames; golden G03/G06 enemies `on_surface = true` |
| G.4 | Crunchy photo backdrops from `pixelArt: true` `[BUILD F16]`, `[VIS §1]` | `pixelArt: false`, `antialias: true`, DPR-scaled internal canvas, vector ink, LINEAR raster filtering (D.3) | screenshot check at DPR 2: no stair-stepping (edge-orientation histogram test on rendered strokes); config unit test |
| G.5 | Handwriting becomes solid tiles when the model is off `[BUILD F3]` | reflex `R-text`, `R-arrow`, `R-detach` (A.3), independent of the model | golden G04 with `DAL_FAKE_LLM=1`: "jump!" and the arrow are non-colliding; reachable cells >= the model-on build |
| G.6 | Remix by re-scanning duplicates coins | parent coins printed as hollow gray (ignored by the gray class) + `dedupe` within 0.75 cell (C.5) | test: re-scan a remix sheet of a 5-coin level -> 5 coins |
| G.7 | Canvas character box only partly wired (shares the main colour, separate undo, 32x48 NEAREST squeeze) `[VIS §2]` | the character is a vector drawing in the studio (E.1) with its own palette, undo/redo and live run preview; the sprite renders from strokes at 4x (128 x 192) and displays at 32 x 48 world size with LINEAR filtering; the rig animates it (D.4) | e2e: draw a character -> the preview shows it running; the sprite file is 128 x 192 |
| G.8 | Zero-length moving floor crashed the scene (`MovingPlatform.startLeg` recursion) `[VIS §1]` | validator (A.5) + `fix_motion` + per-entity try/catch; the sim has no recursion | fuzz test: 500 random scene graphs -> no exception; regression fixture `d_b14b143e` |
| G.9 | Raw codes shown ("goal_unreachable"); publish allowed on broken builds `[VIS §3]` | message table; publish gating (D.8) | unit: every reason_code has a message; e2e: block flag -> publish disabled |
| G.10 | Start bound to the whole ground -> spawn mid-level; cave-roof spawn `[MODEL v1 'start' binding]` | `BStart.near` = the "S" component; `place_spawn` rule (A.7) | golden G09 tower_key spawn within 3 cells of the "S"; G08 spawn on the floor |
| G.11 | Key silently becomes a coin (params dict) `[MODEL "v1 interpretation schema"]` | `BKeyDoor` requires both ids; a missing door becomes a question chip, never a silent downgrade | golden G09: key opens the door; bot: key reachable with the door closed |
| G.12 | Typed rule merged on top of the model binds spawn spikes `[BUILD F10]` | heuristic only when SEE is unavailable | golden G06: exactly one walking enemy (the monster) |
| G.13 | Dev footer on home, fixture links `[VIS §1]` | moved to `#/dev` | e2e |

---

## H. Build plan (multi-agent)

### H.0 Rules of engagement

- Each lane writes only the files it owns (H.1). Shared contracts are frozen at the end of phase 0. Changes go through `docs/v2/contracts-changelog.md` (an entry plus acknowledgement by every consuming lane) and `scripts/gen_contracts.sh`.
- Pydantic models in `vision/app/contracts/` are the **single source of truth**. JSON Schemas (`shared/spec/*.schema.json`) and TS types (`web/src/contracts.gen.ts`, via the devDependency `json-schema-to-typescript`) are generated and committed. A test fails if the generated files are stale.
- v1 code stays runnable: v1 routes under `/api/*` keep working until phase 5. v2 lives under `/api/v2/*` and new modules.
- Every lane keeps a green `uv run pytest -q <its tests>` / `npx vitest run <its dir>`. Phase gates run everything.

### H.1 Lanes and file ownership

| Lane | Owns (create/modify) | Reads |
|---|---|---|
| **L1 Perception & Paper** (Python) | `vision/app/cv/` (v1 files + new `strokes.py`, `vectorize.py`, `features.py`, `stitch.py`, `checkboxes.py`), `vision/app/perceive/reflex.py`, `vision/app/template/` (v2 sheets: sets, seam margins, rules sheet, library legend), `shared/template_spec_v2.json`, `vision/tests/make_synthetic.py` (+ `--sheets k`), `vision/cli.py`, `vision/tests/test_vectorize.py`, `test_reflex.py`, `test_stitch.py`, `test_template_v2.py`, `test_checkboxes.py` | contracts |
| **L2 Mind** (Python) | `vision/app/mind/` (`client.py`, `budget.py`, `see.py`, `merge.py`, `design.py`, `refine.py`, `critic.py`, `prompt_level.py`, `library_ai.py`, `orchestrator.py`, `prompts/{see,design,refine,critic,prompt_level,library}.md`), `vision/app/llm/heuristic.py` (offline binder, adapted), `vision/evals/` (`golden.py`, `live_eval.py`, `judge.py`, `spikes/`), `shared/fixtures/v2/golden/` (drawings + `expectations.json`), `shared/fixtures/v2/model_replies/`, `vision/tests/test_mind_*.py`, `test_orchestrator.py` | everything |
| **L3 Builder & Format** (Python) | `vision/app/contracts/` (all contract models), `vision/app/build/` (`geometry.py`, `raster.py`, `art.py`, `scene_ops.py`, `repairs.py`, `designer_ops.py`, `invariants.py`, `candidates.py`, `greedy.py`, `plan.py`, `assemble.py`), `vision/app/format/migrate_v1.py`, `shared/spec/` (README, generated schemas, `conformance/README.md`), `scripts/gen_contracts.sh`, `web/src/contracts.gen.ts` (generated), `vision/tests/test_build_*.py`, `test_ops_bounds.py`, `test_invariants.py`, `test_edits_roundtrip.py`, `test_migrate.py` | sim report schema |
| **L4 Sim & Playtest** (TS + Python client) | `web/src/sim/` (`profile.ts`, `world.ts`, `collide.ts`, `player.ts`, `entities/*.ts`, `camera.ts`, `step.ts`, `trig.ts`, `replay.ts`, `hash.ts`, `solver/{graph,actions,timed,route}.ts`, `metrics.ts`, `difficulty.ts`, `report.ts`, `daemon.ts`, `worker.ts`, `**/*.test.ts`), `web/vite.sim.config.ts` (builds `web/dist-sim/playtestd.mjs`), `vision/app/playtest/client.py`, `shared/spec/conformance/` (data), `shared/fixtures/v2/starter/` (`make_starter.py`, levels, metrics), `web/src/sim/starter.test.ts` | contracts |
| **L5 Engine & Art** (TS) | `web/src/game/` (rewritten: `index.ts`, `LevelScene.ts`, `views/*.ts`, `overlay.ts`, `hud.ts`, `touch.ts`, `input.ts`), `web/src/render/` (`ink.ts`, `boil.ts`, `paper.ts`, `parallax.ts`, `rig.ts`, `particles.ts`, `themes.ts`, `thumbnails.ts`), `web/src/audio/` (`sfx.ts`, `music.ts`), `web/public/fonts/`, `web/src/game/**/*.test.ts`, `web/src/render/**/*.test.ts` | sim API, contracts |
| **L6 Create UX & Platform** (TS + Python) | `web/src/editor/` (`doc.ts`, `tools.ts`, `view.ts`, `stamps.ts`, `minimap.ts`, `live.ts`), `web/src/screens/` (all, incl. new `preview.ts`, `report.ts`, `dial.ts`, `studio.ts`, `rules.ts`, `prompt.ts`, `leaderboard.ts`, `sets.ts`, `dev.ts`), `web/src/api.ts`, `web/src/sse.ts`, `web/src/messages.ts`, `web/src/style.css`, `web/e2e/`, `web/scripts/golden_shots.ts`, `shared/spec/messages.json`, `vision/app/routers/v2_*.py`, `vision/app/jobs.py`, `vision/app/db.py`, `vision/app/seed.py`, `vision/app/main.py`, `vision/tests/test_api_v2.py`, `test_db_v2.py` | everything |

### H.2 Cross-lane contracts (phase 0, frozen)

**Contract modules** (`vision/app/contracts/`): `strokes.py` (Stroke, StrokeSet, ComponentFeatures), `scene.py` (SceneObject, SceneGraph, Behavior union, Setpiece, Question), `see.py` (SeeOutput), `ops.py` (OpName, per-op param models, OpParams union, Edit), `level_v2.py`, `report.py`, `design.py` (Candidate, DesignOutput, Pick, NovelOp, TierBuild), `rules.py`, `library.py`, `skeleton.py`, `runs.py` (InputLog, RunSubmission, ReplayResult), `draft.py` (DraftState, DraftChange), `events.py` (SSE payloads).

**Key shapes**

```python
class World(BaseModel): cell: Literal[16] = 16; w: int; h: int = 27; screens: int   # w = 48*screens (1..6); h = 27 (54 only with DAL_TALL_LEVELS)
class TerrainShape(BaseModel):
    id: str; role: Literal["ground","platform","wall","ceiling"]; collision: Literal["solid","oneway"]
    points: list[tuple[float,float]]          # fitted top/face polyline, world px
    thickness_rows: int; from_components: list[int]
    motion: Motion | None; crumble: bool; door_of: str | None            # dynamic terrain
class SceneObject(BaseModel):
    id: str; role: Role; components: list[int]; strokes: list[str]
    rel: Relations; behavior: Behavior | None; props: dict; conf: float
    source: Literal["reflex","see","merged","user","prompt","library","parent"]
class SceneGraph(BaseModel): objects: list[SceneObject]; setpieces: list[Setpiece]; intent: str; difficulty_wish: str
                             transcript: str; title: str | None; questions: list[Question]; safety_ok: bool; safety_reason: str | None
class LevelV2(BaseModel):
    format: Literal["dal-level"]; schema_version: Literal[2]
    id: str; game_id: str | None; parent_id: str | None; order_index: int; title: str; author: str; created_at: str
    source: SourceV2                          # kind paper|canvas|prompt|fixture|migrated_v1, sheets[], strokes_url, changed_sheets
    world: World; physics_profile: str | None
    terrain: list[TerrainShape]; objects: list[GameObject]     # GameObject = discriminated union by "type" (B.5, B.6)
    art: list[ArtStroke]                      # {id, object, layer, style: ink|designer|pencil|sketch, color, points, widths, closed, fill}
    collision: Collision                      # {"encoding": "rows", "rows": [...]} derived cache (B.3 alphabet)
    sprites: Sprites; rules: list[Rule]
    design: DesignState                       # dial, band, edits[], metrics, designer_note, par_ms
    meta: MetaV2                              # solvable, verified, flags[], warnings[], notes_transcript, level_hash, sim_version
class RouteAction(BaseModel):
    i: int; kind: Literal["jump","runjump","drop","dropthrough","spring","ride","stomp","wait","timed_pass"]
    from_cell: tuple[int,int]; to_cell: tuple[int,int]; frames: int
    takeoff_f: float; hold_f: float; phase_f: float | None; lethal: float
    p_death_casual: float; p_death_skilled: float; blind: bool; segment: int; setpiece: str | None
class PlaytestReport(BaseModel):
    solvable: bool; reason: str | None; reachable_count: int; route: list[RouteAction]; segments: list[Segment]
    C_casual: float; C_skilled: float; F: float; score: int; band: str
    fastest_frames: int; expected_casual_s: float; actions_per_screen: float; engaged_enemies: int
    coins_reachable: tuple[int,int]; big_coins_reachable: tuple[int,int]; key_check: KeyCheck | None
    flags: list[Flag]; trace: list[tuple[int,float,float]]; level_hash: str; sim_version: str
class Candidate(BaseModel):
    id: str; op: OpName; params: OpParams; tiers: list[Literal["polish","normal","hard"]]
    range: dict[str, tuple[float,float]] | None; where: str; dC: float; dT_s: float; intent_cost: float
class DraftState(BaseModel):
    draft_id: str; version: int; stage: Literal["perceived","faithful","scene","polished","refined","done"]
    graph: SceneGraph; edits: list[Edit]; dial: DialPos; questions: list[Question]
    builds: dict[DialPos, TierBuild]          # TierBuild = {level: LevelV2, report: PlaytestReport, edit_ids: list[str], reachable_band: bool}
    designer: DesignerInfo                    # note, critique, title_suggestion, source: model|greedy
    model_status: dict[str, Literal["pending","ok","failed","skipped","offline"]]; safety: Safety
```

**Python function signatures**

```python
# L1
def run_scan_v2(image: bytes | None, strokes_doc: bytes | None, mode: Literal["paper","canvas"], sheet_hint: SheetRef | None,
                work_dir: Path, debug: bool = False) -> ScanV2                    # CV (paper) + StrokeSet + features + annotated image
def stitch(sheets: list[ScanV2]) -> ScanV2
def reflex_perceive(scan: ScanV2, library: list[LibraryObject]) -> SceneGraph
def read_rules_sheet(image: bytes) -> tuple[GameRules, str]                       # rules + free-text line
# L2
def see(scan: ScanV2, ctx: SeeContext) -> SeeResult                              # never raises; .output None on failure
def merge(reflex: SceneGraph, see: SeeResult | None) -> tuple[SceneGraph, list[Edit]]
def design(level: LevelV2, report: PlaytestReport, menu: list[Candidate], ctx: DesignContext) -> DesignResult
def refine(state: PlanState, ctx: DesignContext) -> DesignResult
def run_scan_job(sink: JobSink, req: ScanRequest) -> None                         # the orchestrator
def run_prompt_job(sink: JobSink, req: PromptRequest) -> None
# L3
def build(scan: ScanV2, graph: SceneGraph, rules: GameRules, edits: list[Edit], dial: DialPos,
          parent: LevelV2 | None) -> BuildResult                                  # pure; {level, edits(with states), art}
def auto_repairs(scan, graph, rules, playtest: PlaytestFn) -> list[Edit]
def generate_candidates(level: LevelV2, report: PlaytestReport, graph: SceneGraph, playtest: PlaytestFn) -> list[Candidate]
def apply_plan(base: BuildInputs, picks: DesignOutput, menu: list[Candidate], playtest: PlaytestFn) -> dict[DialPos, TierBuild]
def greedy_plan(base: BuildInputs, menu: list[Candidate], playtest: PlaytestFn) -> dict[DialPos, TierBuild]
def check_invariants(before: LevelV2, after: LevelV2, ctx: IntentCtx) -> list[Violation]
def migrate_v1(level_v1: dict) -> LevelV2
def rebuild(draft_id: str, change: DraftChange) -> DraftState                     # edits/dial/answers/relabel, < 300 ms
# L4
class Playtest:                               # vision/app/playtest/client.py; manages the Node daemon
    def playtest(self, level: LevelV2, rules: GameRules, opts: PlaytestOpts = PlaytestOpts()) -> PlaytestReport
    def validate_many(self, levels: list[LevelV2], rules: GameRules) -> list[PlaytestReport]
    def replay(self, level: LevelV2, rules: GameRules, log: InputLog) -> ReplayResult
    def healthy(self) -> bool
# L6
class JobSink(Protocol):
    def emit(self, event: str, data: BaseModel) -> None
    def cancelled(self) -> bool
def start_job(kind: str, fn: Callable[[JobSink], None]) -> str                    # thread pool of 4; returns job_id
```

**Playtest daemon protocol** (`node web/dist-sim/playtestd.mjs`; dev: `npx vite-node web/src/sim/daemon.ts`). It is spawned by FastAPI at startup and restarted with backoff on exit. JSON lines over stdio; a `worker_threads` pool of min(4, cpus−1).

```
-> {"id":"r17","method":"playtest","params":{"level":{...},"rules":{...},"opts":{"sigmas":[3,1.5],"timed":true,"trace":true}}}
<- {"id":"r17","ok":true,"result":{PlaytestReport}}
methods: version | playtest (5 s) | validate_many {levels:[...]} (10 s) | replay {level, rules, log} (10 s) | reach {level, rules, from} (1 s)
errors:  {"id":"r17","ok":false,"error":{"code":"timeout|invalid_level|internal","message":"..."}}
```

**TS interfaces**

```ts
// web/src/sim (L4)
export const SIM_VERSION = '2.0.0';
export function createWorld(level: LevelV2, rules: GameRules): SimWorld;
export function initialState(world: SimWorld): SimState;
export function step(world: SimWorld, s: SimState, input: InputBits): StepEvents;   // mutates s; events drive SFX/particles
export function cameraStep(cam: CameraState, s: SimState, world: SimWorld): void;
export function stateHash(s: SimState): string;
export function playtest(level: LevelV2, rules: GameRules, opts?: PlaytestOpts): PlaytestReport;
// web/src/game (L5)
export function mountGame(el: HTMLElement, level: LevelV2, opts: { rules: GameRules; mode: 'play' | 'preview' | 'thumbnail';
  ghost?: RunTrace; overlays?: OverlaySpec; onEvent?: (e: GameEvent) => void }): GameHandle;
export interface GameHandle { destroy(): void; restart(): void; setLevel(l: LevelV2, o?: { atNextRestart: boolean }): void;
  setOverlays(o: OverlaySpec): void; playGhost(t: RunTrace): void; inputLog(): InputLog; on(ev: GameEventName, fn: (p: unknown) => void): void }
// web/src/editor (L6)
export interface StrokeDoc { version: 1; world: { screens: number }; strokes: EditorStroke[]; character: EditorStroke[];
  rules_text: string; chip_behaviors: Behavior[] }
```

**HTTP (v2)**

| Method and path | Body | Returns |
|---|---|---|
| `POST /api/v2/scan` | multipart: `image?` (paper), `strokes?` (StrokeDoc JSON), `mode`, `prompt?`, `parent_id?`, `game_id?`, `set_id?`, `sheet?` | `{job_id, draft_id}` (202) |
| `GET /api/v2/jobs/{job_id}/events` | — | SSE: `stage`, `faithful`, `scene`, `question`, `polished`, `refined`, `warning`, `error`, `done` (each with `seq`, `draft_version`) |
| `GET /api/v2/drafts/{id}` | — | `DraftState` |
| `POST /api/v2/drafts/{id}/edits/{edit_id}` | `{state: "applied" \| "undone"}` | `DraftState` |
| `POST /api/v2/drafts/{id}/dial` | `{position, band?}` | `DraftState` |
| `POST /api/v2/drafts/{id}/answers` | `{question_id, option}` | `DraftState` |
| `POST /api/v2/drafts/{id}/relabel` | `{object_id, role}` | `DraftState` |
| `POST /api/v2/drafts/{id}/critic` | `{telemetry: {deaths: [{x, y, cause, frame}], attempts, segment_times}}` | `{job_id}` |
| `POST /api/v2/reflex` | StrokeDoc | `{roles: [{stroke_id, role, conf}]}` (< 100 ms) |
| `POST /api/v2/prompt-level` | `{text, screens?, game_id?}` | `{job_id, draft_id}` |
| `POST /api/v2/sets` / `GET /api/v2/sets/{id}` / `POST /api/v2/sets/{id}/build` | `{k, game_id?, parent_id?}` | `{set_id, pdf_url}` / sheet status / `{job_id}` |
| `GET /api/v2/templates/{set\|rules\|library}/{id}.pdf` | — | PDF |
| `GET/POST /api/v2/games/{id}/library`, `PUT/DELETE /api/v2/library/{obj_id}`, `POST /api/v2/library/interpret` | LibraryObject / `{name, text, strokes}` | objects / proposal |
| `GET/PUT /api/v2/games/{id}/rules` | GameRules | rules + `{job_id}` re-verify |
| `POST /api/v2/levels` | `{draft_id, author, title?, dial}` | `{level}`; 409 + reasons on a block flag or failed safety |
| `GET /api/v2/levels/{id}` | — | `{level: LevelV2, author, likes, best_run, medals_stats, children}` |
| `POST /api/v2/levels/{id}/runs` / `GET .../runs?limit=10` / `GET /api/v2/runs/{id}` | `{player, input_log, claimed_frames}` | `{verified, time_ms, rank}` / list / run + trace |
| `GET /api/v2/health` | — | `{ok, llm: live\|fake\|offline, playtestd: up\|down, budget_left_usd}` |

**SQLite (L6 `db.py`, additive migrations at startup)**
- `games` + `rules_json`;
- `levels` + `format INT`, `json_v1 TEXT NULL`, `score INT`, `band TEXT`, `c_casual REAL`, `fastest_ms INT`, `par_ms INT`, `verified BOOL`, `screens INT`, `level_hash TEXT`;
- new `sheet_sets(id, k, game_id, parent_id, sheets_json, created_at)`;
- new `library_objects(id, game_id, name, letter, base_role, behavior_json, modifiers_json, strokes_json, sprite_url, author, uses, created_at)`;
- new `runs(id, level_id, level_hash, player, frames, deaths, coins, big_coins, input_log BLOB, verified, created_at)`;
- new `model_calls(id, draft_id, kind, effort, latency_ms, in_tok, out_tok, cost_usd, stop_reason, served_by, ok, created_at)`.

Drafts live in files at `vision/data/uploads/drafts/<draft_id>/`: `strokes.json`, `scan.json`, `graph.json`, `edits.json`, `builds/<dial>.json`, `reports/<dial>.json`, `draft.json`, images.

### H.3 Phase order

| Phase | Work (lane) | Done when |
|---|---|---|
| **0 Contracts + spikes** | L3 contracts + generator + messages skeleton; L4 sim skeleton (player + tiles) + daemon `version`; L2 API spikes: union-schema acceptance, SEE latency bakeoff on G01-G06 at {low adaptive, low thinking-disabled, fast mode} (budget $3), streaming check; L6 endpoint stubs + fake SSE; L1 vectorize prototype; L5 ink chunk + boil spike at DPR 2 | `gen_contracts.sh` clean; envelope test green (±0.1 cell vs `proposed_physics_results.md`); `docs/v2/spikes/latency.md` committed with the chosen SEE config |
| **1 Foundations** | L1 strokes/features/reflex; L3 geometry, repairs, art, collision, invariants, edits round-trip; L4 static solver + metrics + calibration + worker; L5 engine on the sim (player, camera, HUD, renderer) from hand-written LevelV2 fixtures; L6 vector editor (long canvas, stamps, live chips via `/reflex`), preview shell on a fixture DraftState; L2 SEE + merge + orchestrator with recorded replies | a fixture LevelV2 plays at 60 fps; reflex accuracy >= 0.85 on G01-G10; calibration tests green |
| **2 Faithful end to end** | integrate L1+L3+L4+L5+L6: `/api/v2/scan` -> `faithful` SSE -> preview -> play, canvas and paper | G01-G13 model-off Faithful: >= 12/13 solvable; AC4 alignment; G.2-G.5, G.8-G.10 verified; Faithful p50 <= 3 s |
| **3 The mind** | L2 SEE live, DESIGN, REFINE, CRITIC; L3 candidates, plan, greedy; L4 `validate_many`; L6 change list, ghosts, dial, meter, questions, publish gating | AC1, AC3, AC5, AC7, AC8 on a live golden eval |
| **4 Scale + extensions** | L4 timed solver, all archetypes and hazards, Starter World; L1 multi-sheet, stitch, rules sheet, tags; L2 prompt-to-level, library AI; L3 v1 migration; L6 sets UI, studio, rules UI, prompt UI | AC11, AC13-AC16, AC18 (migration part) |
| **5 Social + spec + polish** | L4 replay verify + conformance; L6 runs, leaderboards, challenge links, chrome; L5 juice, audio, themes, thumbnails, parallax; L3 spec README; all: golden screenshots, perf, fuzz, offline drill | all acceptance criteria |

The critical path is L4's sim: engine, solver, designer validation and replays all depend on it. L4 starts in phase 0 from v1's `physicsSim.ts` tile separation (kept bit-compatible for profile `v1`), then adds the v2 controller.

### H.4 Golden drawings (the quality bar)

`shared/fixtures/v2/golden/` holds input files plus `expectations.json`. Expected objects are bound to whatever ids CV assigns through **locators** (`{color, near_px: [x, y], radius_px}`).

| ID | Source | What it must prove |
|---|---|---|
| G01 | `diagnosis/build/inputs/1_spike_hop.png` | pole scenery and goal grounded at the pole base (x ≈ 44); floor spikes 1 band facing up; hovering spikes snapped onto platform 1 (abs(dy) <= 2 cells) facing up; 4 coins (tap included); 0 bumps; `close_gap` at cell ≈ 19; spawn >= 3 cells from spikes |
| G02 | `.../2_spike_cave.png` | ceiling spikes face down on the ceiling; wall spikes face left on the wall face and the wall stays solid (0 hazard over wall ink); 13 bumps -> 0; floor route to the flag open; 4 coins |
| G03 | `.../3_monster_meadow.png` + "the monster walks back and forth" | canopy + trunk + sun are decoration; goal = small flag; one walker = monster incl. eyes; no leftover parts; floor art intact; reachable standing cells >= 58 (counterfactual `cf/3_monster_meadow_intended.json`) |
| G04 | `.../4_words_and_arrows.png` (model on **and off**) | "jump!" is a non-colliding sign; the arrow is hidden and binds move +8 right; the platform is 1-row one-way; solvable; 4 coins |
| G05 | `.../5_big_leap.png` | the 7-cell gap is a v2 run-gap: solvable with no nudge (runway >= 3) or one nudge <= 1; Polished C >= 0.1 |
| G06 | `.../6_kid_full_level.png` + "the monster walks" | ramp -> slope tiles (0 bumps); exactly one walking enemy (the monster, with eyes); spawn spikes static facing up plus `clear_spawn`; spikes snapped onto platform 2; solvable at every dial position |
| G07 | `diagnosis/model/inputs/canvas_floating_spikes` | Probe B expectations: goal onto G2, spikes snapped dy = +1, ceiling spikes down, monster grounded, the 5-cell gap left alone |
| G08 | `.../canvas_wobbly_cave` | spawn on the floor (not the roof); 1-cell hole closed; red "lava!" is a sign, not a hazard; the 5-cell wall is resolved by `lower_wall` (not lifted) or by the v2 envelope |
| G09 | `.../canvas_tower_key` | spawn near "S"; key linked to the door bar; the key is reachable with the door closed and the door blocks the goal; tree decoration; top-ledge fragments grouped; wall spikes face left |
| G10 | `.../paper_synth_1` | "moves" + arrow -> moving platform; paper path works |
| G11 | owner draft `vision/data/uploads/drafts/d_b14b143e/` | Faithful solvable with <= 3 required edits, each <= 3 cells `[PLAY §10]`; the left floor stays ground; the high platform moves ±4; 2 tap coins |
| G12 | owner draft `d_dfbfe619` (black zigzag on a platform) | the zigzag never becomes 1-cell walls (decoration or spikes, with a question chip); solvable |
| G13 | owner draft `d_79eff85e` (red zigzag) | one spike band on top of the platform; Challenging · Normal makes the route cross it with C > 0.3 `[PLAY §10]` |
| G14 | new: 3-sheet synthetic paper set (`make_synthetic.py --sheets 3`) | random scan order; both seams joined; 3-screen route; 0 blind jumps |
| G15 | new: canvas with a circled "B" tag + library "Bob (hopper)" | instance of Bob (model on); question chip (model off) |
| G16 | new: handwriting-heavy canvas (sentences inside the drawing area) | model off: >= 90% of text strokes non-colliding |
| G17 | prompt "a lava cave where you need a key to open the exit" | skeleton solvable; key reachable with the door closed; door gates the goal |
| G18 | new: 4-screen long canvas `kid_marathon` (extend `make_kid_drawings.py`) | per-tile SEE merge; all four builds; Polished C in band; >= 55 fps |

**Screenshots** (`web/scripts/golden_shots.ts`, Playwright devDependency): for each golden at 1536 x 864, DPR 2, boil fixed to variant 0, it captures:
- the preview at Faithful and at Polished (with the report);
- play at t = 2 s;
- play at the route midpoint, driven by the bot's input log.

Baselines live in `docs/v2/golden/shots/` and are approved by a human reviewer. CI pixel-diffs them (tolerance 0.5%). The **must-look-good checklist** (a reviewer signs off per image):
1. walkable lines are smooth with no stair-steps;
2. spikes are triangles sitting on their surface, pointing away;
3. no white cut-outs, notches or orphan eyes;
4. one goal flag (the child's own) and each coin drawn once;
5. enemies stand on surfaces;
6. designer ink is clearly distinct;
7. the HUD sits on its plate with no overlaps;
8. the child's drawing is recognisable side by side.

Secondary signal: an LLM judge (`vision/evals/judge.py`, eval-only, never a gate on its own) rates "looks like what the kid drew" 1-5 and each edit keep/flag; the target mean is >= 4.0.

### H.5 Automated tests

| Suite | Lane | Content |
|---|---|---|
| `test_vectorize.py` | L1 | widths ±0.5 px on synthetic strokes; skeleton topology; dots kept; canvas StrokeDoc path |
| `test_reflex.py` | L1 | each R-rule unit case; golden role accuracy >= 0.85 |
| `test_stitch.py`, `test_template_v2.py`, `test_checkboxes.py` | L1 | seam join, QR grammar, seam margins, checkbox fill |
| `test_build_geometry.py` | L3 | straighten residual; one collision row at the ink top; slope classes at 9/12/32/58°; thickness rules; art top within 1 px |
| `test_ops_bounds.py` | L3 | every op: out-of-bounds params clamped or rejected (randomised, 1000 cases) |
| `test_invariants.py`, `test_edits_roundtrip.py` | L3 | I1-I8 positive/negative cases; toggle -> byte-identical rebuild |
| `test_candidates.py`, `test_greedy.py` | L3 | all menu items validated; none violates invariants; greedy reaches Normal on 3 synthetic flats |
| `test_migrate.py` | L3 | v1 fixtures + seeded remixes migrate; profile v1 reachable set == v1 solver's |
| `test_mind_schemas.py` | L2 | recorded replies parse; unknown ids dropped; > 50% invalid -> discarded; refusal / max_tokens / timeout paths |
| `test_orchestrator.py` | L2 | event order; SEE timeout -> reflex; DESIGN timeout -> greedy; budget exhausted -> offline; fake clock |
| `test_api_v2.py`, `test_db_v2.py` | L6 | scan -> SSE sequence; edits, dial, answers; publish gating; runs verify via daemon; tampered log rejected |
| `sim/*.test.ts` | L4 | envelope (v2 and v1); one-way, slopes, step assist, corner correction; entities (gravity, ledge-aware, stomp, crumble, carry, saw); determinism (hash stability, trig table) |
| `solver/*.test.ts` | L4 | calibration (`[PLAY §3]` ±10%); timed actions; blind-jump; key check; dead ends |
| `starter.test.ts`, `conformance.test.ts`, `daemon.test.ts` | L4 | F criteria; hashes; protocol and timeouts |
| `game/*.test.ts`, `render/*.test.ts` | L5 | mountGame lifecycle; per-entity failure isolation; ink chunking; reduced motion; single win UI |
| `editor/*.test.ts` | L6 | undo/redo; a tap stamps a 16 px dot; add/trim screen; chip behaviors serialise |
| `web/e2e/*.spec.ts` | L6 | draw -> preview -> undo -> dial -> play -> win (one results card); multi-sheet scan; leaderboard; offline run |
| `vision/evals/live_eval.py` | L2 | live golden run with `--budget 4.00`: role/relation accuracy, latency p50/p90 per call, cost, solvable per tier, invariant violations, rejected-pick rate -> `docs/v2/evals/<date>.md` |

### H.6 Acceptance criteria (reviewer-checkable)

| AC | Criterion | How to check |
|---|---|---|
| AC1 | Live, model on, G01-G13: Polished solvable 13/13; 0 pole walls; goal grounded 13/13; coins drawn == built; 0 one-cell bumps on fitted surfaces; spikes 1 band and oriented as expected; enemies on surfaces; no leftover parts | `live_eval.py` report |
| AC2 | Model off: Faithful solvable >= 12/13; G04 and G16 text non-colliding | `golden.py --offline` |
| AC3 | SEE role accuracy >= 0.93, relations >= 0.95 (G01-G10 GT); reflex >= 0.85 | eval report |
| AC4 | abs(art_top − collision_top) <= 1 px on >= 99% of surface samples; 0 collision cells without art; 0 orphan ink | `test_build_geometry.py` + golden |
| AC5 | Faithful p50 <= 3 s, p90 <= 8 s; Polished (model) p50 <= 25 s, p90 <= 40 s; offline quick polish p90 <= 4 s (local, canvas, n >= 3 per golden) | eval report |
| AC6 | Model cost <= $0.15 mean per single-screen scan, <= $0.40 per 6-sheet level | `model_calls` table |
| AC7 | Designer on G01-G13: Challenging · Normal reaches its band in >= 10/13 or explains why not; 0 invariant violations among accepted ops; rejected-pick rate <= 25%; 0 setpiece bypasses | eval report |
| AC8 | Every edit card has a message, a ghost and Keep/Undo; toggling round-trips byte-identically | e2e + `test_edits_roundtrip.py` |
| AC9 | Envelope within 0.1 cell; calibration within ±10% | vitest |
| AC10 | 20 recorded runs replay to identical hashes in Chromium, WebKit and Node | e2e + `conformance.test.ts` |
| AC11 | Starter World passes all section F criteria | `starter.test.ts` |
| AC12 | A 6-screen level runs >= 55 fps (Chrome, DPR 2, boil on) with <= 300 MB memory; 0 blind jumps in Starter World | perf script + report |
| AC13 | G14 builds from 3 photos in random order; a sheet-2-only remix inherits sheets 1 and 3 | e2e |
| AC14 | Bob created in the studio, placed by stamp and by paper tag; editing Bob re-verifies its levels | e2e |
| AC15 | Rules: turning *run* off on Starter World is blocked with the affected levels listed; a theme change re-themes all levels | e2e |
| AC16 | Prompt-to-level: the 4 Probe D prompts + G17 solvable 5/5, key logic correct; offline templates work | eval + e2e |
| AC17 | Runs: valid log verified, tampered log rejected, ghost plays, challenge link shows "beat by X s" | `test_api_v2.py` + e2e |
| AC18 | Spec: conformance passes in browser and daemon; schemas in sync; v1 levels migrate and stay solvable under profile v1 | CI |
| AC19 | Every v1 fix G.1-G.13 passes its test | CI |
| AC20 | Fuzz 500 random graphs/levels: 0 exceptions; publish blocked on block flags and on `safety_ok = false` | `test_fuzz.py` |
| AC21 | Network off + `DAL_FAKE_LLM=1`: scan -> Faithful + quick polish -> play -> publish, and prompt templates all work; fonts load locally | offline drill script |

### H.7 Risks and mitigations

| Risk | Mitigation |
|---|---|
| SEE/DESIGN latency above target (measured perception 11.8 s p50 with a verbose schema) | deterministic Faithful + quick polish ship first; phase-0 bakeoff of compact schema / thinking disabled / fast mode; per-tile parallel SEE; optional speculative DESIGN |
| Structured outputs reject the discriminated unions | phase-0 test; fallback to the flat nullable-field form proven in Probe B, validated per variant in code |
| Sim rewrite is the largest lane and on the critical path | start from v1 `physicsSim.ts` (bit-compatible profile v1); envelope and calibration tests from day 1; engine consumes the sim API early with stubs |
| Reflex accuracy on real paper (golden is mostly synthetic `[MODEL Caveats]`) | collect 20 real phone photos in phase 2 for the eval set; reflex questions instead of guesses below conf 0.6 |
| Slopes and one-way add collision edge cases | the 1:1 and 1:2 slope classes only; step assist; dedicated collide tests; the solver shares the code, so disagreement is impossible |
| Designer taste variance between calls | menu pre-validation; invariant checks; nested tiers; greedy fallback; the LLM judge tracks drift in evals |
| Cost creep with long levels | per-draft cap of $0.60; daily budget; tile SEE only for tiles with new ink (remix) |
| Mobile rendering performance with chunked RenderTextures and boil | 1024 px chunks; boil drops to 1 variant under 50 fps; DPR capped at 2 |
| Kids misalign multi-sheet seams | seam margins with ticks; `seam_join` tolerance 2 cells; explained edit |

