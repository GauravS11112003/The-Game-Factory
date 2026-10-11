"""Studio games (docs/v6/CONTRACTS_V6.md): any 2D game, drawn by the maker and assembled with an AI copilot.

A game is scenes of objects. Every object is the maker's own drawing plus editable data: what it is (a free label),
physics (Matter.js bodies in the runtime), behaviours (components from a fixed catalog with parameters), rules scoped to
the object or to the whole game, and counters (health, fuel, coins: the inventory). Nothing here is code. Colours mean
nothing; a theme restyles the maker's strokes and paints the world. The catalog of behaviours, rule events and actions
with their parameters is shared/spec/studio_catalog.json (the runtime, the inspector and the copilot all read it), so
`type` fields are strings checked against the catalog and `params` are plain values.

Units: world pixels; +y is down; angles in degrees; times in seconds; gravity in g (1 = normal).
"""
from typing import Any, Literal

from pydantic import Field

from app.spec.common import Spec

_ID = r"^[A-Za-z0-9_-]{1,40}$"
_HEX = r"^#[0-9a-fA-F]{6}$"
_NAME = r"^[a-z][a-z0-9 _]{0,23}$"  # counter, tag and item names: "health", "fuel", "red gems"

Vec = tuple[float, float]
Param = Any  # a number, string, bool, or a list of those (the catalog says which)


# ---- drawings -----------------------------------------------------------------------------------


class Stroke(Spec):
    """One pen stroke, in object-local pixels with (0, 0) at the object's centre."""

    points: list[Vec] = Field(min_length=1, max_length=2000)
    color: str = Field(default="#1f1b18", pattern=_HEX)
    width: float = Field(default=6, gt=0, le=80)
    closed: bool = False
    fill: str | None = Field(default=None, pattern=_HEX)


class Drawing(Spec):
    strokes: list[Stroke] = Field(default_factory=list, max_length=400)
    w: float = Field(default=0, ge=0)  # local bounding box size (derived; kept so layouts need no recompute)
    h: float = Field(default=0, ge=0)


# ---- AI art (docs/v7/CONTRACTS_V7.md): the drawing is the blueprint, Claude draws the finished look ----------------

_SVG_MAX = 300_000  # characters of one sanitized SVG


class ArtVariant(Spec):
    """One finished drawing of an object by Claude: an SVG whose viewBox is `0 0 w h`, fitted to the object's drawing
    box (w, h = drawing.w, drawing.h), so it lines up with the physics shape made from the maker's strokes."""

    id: str = Field(pattern=_ID)
    svg: str = Field(max_length=_SVG_MAX)
    w: float = Field(gt=0)
    h: float = Field(gt=0)
    rev: int = 0  # the ArtDirection.rev it was drawn for
    note: str | None = Field(default=None, max_length=200)  # one line: what Claude made it into


class TerrainSkin(Spec):
    """How a ground line (physics shape "line") looks in the game view: solid land filled from the line down to the
    world's bottom, a surface band along the line, an optional tiled texture inside, and decorations along the top."""

    fill: list[str] = Field(default_factory=lambda: ["#8d6e63", "#5d4037"], min_length=1, max_length=4)  # top to bottom
    surface: str = Field(default="#3bb273", pattern=_HEX)  # the band drawn along the line
    surface_width: float = Field(default=14, ge=0, le=80)
    surface_svg: str | None = Field(default=None, max_length=_SVG_MAX)  # a horizontally tileable strip (grass, ice)
    texture_svg: str | None = Field(default=None, max_length=_SVG_MAX)  # a tileable pattern inside the land
    decor: list[ArtVariant] = Field(default_factory=list, max_length=6)  # rocks, craters, flowers
    decor_every: float = Field(default=220, ge=40, le=4000)  # average px between decorations
    rev: int = 0


class ObjectArt(Spec):
    """An object's look. `use` = which one plays: the maker's own strokes (cleaned up in the game view) or the chosen
    AI variant. Variants are kept so the maker can switch back and forth."""

    use: Literal["sketch", "ai"] = "sketch"
    chosen: str | None = Field(default=None, pattern=_ID)  # an ArtVariant id
    variants: list[ArtVariant] = Field(default_factory=list, max_length=6)
    terrain: TerrainSkin | None = None  # ground lines
    asked: bool = False  # the maker has seen the "AI or mine?" card for the current variants


class ArtDirection(Spec):
    """One game-wide style guide that every piece of AI art follows, so the whole game matches."""

    rev: int = Field(default=1, ge=1)  # bumps on every restyle
    prompt: str = Field(default="", max_length=300)  # the maker's words: "hill climb racing in space"
    summary: str = Field(default="", max_length=300)  # one line for the UI
    guide: str = Field(default="", max_length=6000)  # the full style guide (palette, line, shading, mood, rules)
    palette: list[str] = Field(default_factory=list, max_length=10)
    kinds: dict[str, str] = Field(default_factory=dict)  # object kind -> what it becomes ("car" -> "lunar rover")


class BackdropLayer(Spec):
    svg: str = Field(max_length=_SVG_MAX)
    w: float = Field(gt=0)  # the SVG's viewBox size
    h: float = Field(gt=0)
    depth: float = Field(default=0.5, ge=0, le=1)  # parallax: 0 = fixed sky, 1 = moves with the world
    anchor: Literal["top", "bottom", "fill"] = "bottom"
    tile_x: bool = True
    height: float = Field(default=0.5, gt=0, le=1)  # share of the view height the layer covers


class Backdrop(Spec):
    rev: int = 0
    sky: list[str] = Field(default_factory=list, max_length=4)  # gradient behind the layers, top to bottom
    layers: list[BackdropLayer] = Field(default_factory=list, max_length=4)  # back to front


# ---- objects --------------------------------------------------------------------------------------


class PhysicsDef(Spec):
    body: Literal["none", "static", "dynamic", "kinematic"] = "static"
    shape: Literal["auto", "box", "circle", "line"] = "auto"  # auto: hull of the drawing; line: a ground stroke
    density: float = Field(default=1.0, ge=0.05, le=50)
    friction: float = Field(default=0.4, ge=0, le=2)
    bounce: float = Field(default=0.0, ge=0, le=1.5)
    fixed_rotation: bool = False
    sensor: bool = False  # overlaps but never collides (zones, pickups)
    gravity_scale: float = Field(default=1.0, ge=-5, le=5)


class BehaviorDef(Spec):
    id: str = Field(pattern=_ID)
    type: str = Field(pattern=r"^[a-z_]{2,32}$")  # a behaviour in the catalog
    params: dict[str, Param] = Field(default_factory=dict)
    off: bool | None = None


class Condition(Spec):
    """`subject` is "self", "game", "other" (the object an event involved) or an object id."""

    subject: str = Field(default="self", max_length=40)
    counter: str = Field(pattern=_NAME)
    op: Literal[">=", "<=", "==", "!=", ">", "<"] = ">="
    value: float = 0


class EventDef(Spec):
    type: str = Field(pattern=r"^[a-z_]{2,32}$")  # an event in the catalog
    params: dict[str, Param] = Field(default_factory=dict)


class ActionDef(Spec):
    type: str = Field(pattern=r"^[a-z_]{2,32}$")  # an action in the catalog
    params: dict[str, Param] = Field(default_factory=dict)


class RuleDef(Spec):
    id: str = Field(pattern=_ID)
    when: EventDef
    conditions: list[Condition] = Field(default_factory=list, max_length=4)
    then: list[ActionDef] = Field(min_length=1, max_length=8)
    once: bool = False
    off: bool | None = None
    text: str | None = Field(default=None, max_length=200)  # the maker's own words, shown on the rule card


class JointDef(Spec):
    type: Literal["wheel", "hinge", "rope", "weld", "spring"]
    to: str = Field(pattern=_ID)  # the other object
    at: Vec = (0, 0)  # anchor on this object (local px)
    to_at: Vec = (0, 0)  # anchor on the other object (local px)
    motor: bool = False  # wheel / hinge: driven by the object's `car` behaviour or a constant speed
    speed: float = 0  # deg/s for a constant motor
    length: float | None = None  # rope / spring rest length (px)
    stiffness: float = Field(default=0.5, ge=0, le=1)


class ObjectDef(Spec):
    id: str = Field(pattern=_ID)
    name: str = Field(default="", max_length=32)
    kind: str = Field(default="thing", max_length=24)  # free label: player, car, enemy, coin, wall, star…
    drawing: Drawing = Field(default_factory=Drawing)
    x: float = 0
    y: float = 0
    rotation: float = 0
    scale: float = Field(default=1.0, gt=0, le=20)
    layer: int = Field(default=0, ge=-10, le=10)
    physics: PhysicsDef = Field(default_factory=PhysicsDef)
    behaviors: list[BehaviorDef] = Field(default_factory=list, max_length=12)
    rules: list[RuleDef] = Field(default_factory=list, max_length=24)
    counters: dict[str, float] = Field(default_factory=dict)  # inventory and stats: {"health": 3, "fuel": 100}
    tags: list[str] = Field(default_factory=list, max_length=8)
    joints: list[JointDef] = Field(default_factory=list, max_length=8)
    template: bool = False  # not placed: spawners and shooters make copies of it
    hidden: bool = False
    player: Literal[0, 1, 2] = 0  # which player's controls drive its behaviours (0 = none / AI)
    art: ObjectArt | None = None  # v7: AI art variants and which look plays


# ---- world, hud, theme ----------------------------------------------------------------------------


class CameraDef(Spec):
    mode: Literal["fixed", "follow", "auto_scroll"] = "fixed"
    target: str | None = Field(default=None, pattern=_ID)  # follow: this object (default: player 1's object)
    axis: Literal["x", "y", "xy"] = "xy"
    speed: float = Field(default=120, ge=0, le=2000)  # auto_scroll px/s
    zoom: float = Field(default=1.0, gt=0.1, le=5)


class WorldDef(Spec):
    kind: str = Field(default="", max_length=60)  # what the maker called it: "hill climb racer"
    width: float = Field(default=1600, ge=320, le=40000)
    height: float = Field(default=900, ge=240, le=20000)
    gravity: Vec = (0, 1)
    camera: CameraDef = Field(default_factory=CameraDef)
    edges: Literal["none", "walls", "wrap", "floor"] = "walls"
    players: Literal[1, 2] = 1


class HudItem(Spec):
    subject: str = Field(default="game", max_length=40)  # "game", "player1", "player2" or an object id
    counter: str = Field(pattern=_NAME)
    label: str | None = Field(default=None, max_length=24)
    style: Literal["number", "bar", "hearts", "icons"] = "number"
    max: float | None = None


class HudDef(Spec):
    items: list[HudItem] = Field(default_factory=list, max_length=8)
    timer: bool = False
    title: str | None = Field(default=None, max_length=40)


class BackgroundDef(Spec):
    style: Literal[
        "paper", "solid", "gradient", "stars", "grid", "city", "hills", "clouds", "neon_grid", "halftone", "waves",
        "dunes", "forest", "space",
    ] = "paper"
    colors: list[str] = Field(default_factory=list, max_length=6)  # #rrggbb, back to front
    parallax: bool = True


class StrokeStyleDef(Spec):
    style: Literal["ink", "marker", "neon", "pixel", "chalk", "comic", "crayon", "watercolor"] = "marker"
    outline: str | None = Field(default=None, pattern=_HEX)  # a dark outline drawn behind every stroke
    width_scale: float = Field(default=1.0, gt=0.2, le=4)
    glow: bool = False
    fill_closed: bool = True  # closed shapes get filled with a palette colour near their stroke colour
    halftone: bool = False
    wobble: float = Field(default=0.0, ge=0, le=1)  # hand-drawn jitter


class StudioTheme(Spec):
    id: str | None = Field(default=None, pattern=_ID)
    name: str = Field(default="Sketchbook", max_length=40)
    palette: dict[str, str] = Field(default_factory=dict)  # bg, ink, accent, accent2, text, danger, good: #rrggbb
    background: BackgroundDef = Field(default_factory=BackgroundDef)
    stroke: StrokeStyleDef = Field(default_factory=StrokeStyleDef)
    recolor: bool = False  # map the maker's stroke colours onto the palette (keeps which strokes differ)
    particles: Literal["none", "dust", "sparks", "stars", "bubbles", "confetti", "embers", "snow"] = "dust"
    font: Literal["hand", "comic", "pixel", "clean", "serif"] = "hand"
    music: Literal["none", "calm", "upbeat", "spooky", "heroic", "chiptune", "racing"] = "upbeat"


# ---- the game -------------------------------------------------------------------------------------


class SceneDef(Spec):
    id: str = Field(pattern=_ID)
    name: str = Field(default="Level 1", max_length=40)
    world: WorldDef = Field(default_factory=WorldDef)
    objects: list[ObjectDef] = Field(default_factory=list, max_length=600)
    rules: list[RuleDef] = Field(default_factory=list, max_length=48)  # scene-wide rules


class GameDoc(Spec):
    format: Literal["drawplay-studio"] = "drawplay-studio"
    version: Literal[1] = 1
    id: str = Field(pattern=_ID)
    title: str = Field(default="Untitled game", max_length=60)
    author: str | None = Field(default=None, max_length=32)
    theme: StudioTheme = Field(default_factory=StudioTheme)
    hud: HudDef = Field(default_factory=HudDef)
    rules: list[RuleDef] = Field(default_factory=list, max_length=48)  # game-wide rules (every scene)
    counters: dict[str, float] = Field(default_factory=dict)  # game counters: score, lives, time
    scenes: list[SceneDef] = Field(min_length=1, max_length=40)
    look: Literal["game", "sketch"] = "game"  # v7: play with the finished art, or show the raw sketch everywhere
    art_direction: ArtDirection | None = None  # v7
    backdrop: Backdrop | None = None  # v7: AI-painted parallax world behind everything (replaces theme.background)
    created_at: str | None = None
    updated_at: str | None = None


# ---- copilot and studio API (docs/v6/CONTRACTS_V6.md §5) --------------------------------------------

EditAction = Literal[
    "set_world", "set_theme", "set_hud", "set_title", "add_scene", "update_object", "delete_object",
    "duplicate_object", "add_behavior", "update_behavior", "remove_behavior", "add_rule", "update_rule", "remove_rule",
    "add_joint", "set_counters", "set_game_counters", "ask_draw",
    "set_art", "set_art_direction", "set_backdrop", "set_look",  # v7
]


class StudioEdit(Spec):
    """One change the copilot proposes. `target` is an object id, a rule/behaviour owner, or null for game level.
    `data` is shaped by the action (CONTRACTS_V6 §5.2). The client applies edits as one undoable step."""

    action: EditAction
    target: str | None = None
    scene: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)


class ChatTurn(Spec):
    role: Literal["user", "copilot"]
    text: str = Field(max_length=4000)


class StudioChatBody(Spec):
    game: GameDoc
    scene: str  # the scene the maker is looking at
    selection: list[str] = Field(default_factory=list, max_length=50)
    message: str = Field(min_length=1, max_length=2000)
    history: list[ChatTurn] = Field(default_factory=list, max_length=20)
    snapshot_png: str | None = None  # optional base64 PNG of the canvas, for the copilot to look at


class StudioChatResult(Spec):
    reply: str
    edits: list[StudioEdit]
    suggestions: list[str] = Field(default_factory=list, max_length=4)  # next things the maker could say
    source: Literal["model", "keywords"]
    art_prompt: str | None = Field(default=None, max_length=300)  # v7: the look changed; restyle the art with this
    error: str | None = None  # v7: why the model path failed ("timeout", "budget") when source is keywords


class RecognizeBody(Spec):
    game: GameDoc
    scene: str
    object_id: str
    image_png: str  # base64 PNG of the new drawing alone


class RecognizeResult(Spec):
    """What the copilot thinks the maker just drew; the UI asks before applying."""

    question: str  # "Is this your car?"
    name: str
    kind: str
    edits: list[StudioEdit]  # what applying it would change (physics, behaviours, joints, counters)
    source: Literal["model", "keywords"]


class ThemeBody(Spec):
    text: str = Field(min_length=1, max_length=300)
    game_kind: str | None = None


class ThemeResult(Spec):
    theme: StudioTheme
    source: Literal["model", "keywords"]


# ---- v7 art API (docs/v7/CONTRACTS_V7.md section 3) ------------------------------------------------------------------


class ArtDirectionBody(Spec):
    game: GameDoc
    prompt: str = Field(default="", max_length=300)  # empty: from the game's kind, title and theme


class ArtDirectionResult(Spec):
    direction: ArtDirection
    theme: StudioTheme | None = None  # a matching palette, font and particles for the HUD and the sketch view
    source: Literal["model", "keywords"]


class ArtJobBody(Spec):
    game: GameDoc
    scene: str
    objects: list[str] = Field(default_factory=list, max_length=80)  # ids to draw (each gets variants or a skin)
    backdrop: bool = False
    variants: int = Field(default=3, ge=1, le=4)
    images: dict[str, str] = Field(default_factory=dict)  # object id -> base64 PNG of the maker's drawing


class ArtJobItem(Spec):
    object_id: str | None = None  # null for the backdrop
    status: Literal["queued", "drawing", "reviewing", "done", "failed"]
    art: ObjectArt | None = None  # variants (or terrain) when done
    backdrop: Backdrop | None = None
    error: str | None = None


class ArtJobStatus(Spec):
    id: str
    status: Literal["running", "done", "failed"]
    done: int
    total: int
    rev: int
    items: list[ArtJobItem]


class StudioGameCard(Spec):
    id: str
    title: str
    author: str | None
    kind: str
    theme_name: str
    scenes: int
    objects: int
    published: bool
    updated_at: str | None
    thumbnail_url: str | None = None


EXPORTS: list[Any] = [
    Stroke, Drawing, PhysicsDef, BehaviorDef, Condition, EventDef, ActionDef, RuleDef, JointDef, ObjectDef, CameraDef,
    WorldDef, HudItem, HudDef, BackgroundDef, StrokeStyleDef, StudioTheme, SceneDef, GameDoc, StudioEdit, ChatTurn,
    StudioChatBody, StudioChatResult, RecognizeBody, RecognizeResult, ThemeBody, ThemeResult, StudioGameCard,
    ArtVariant, TerrainSkin, ObjectArt, ArtDirection, BackdropLayer, Backdrop, ArtDirectionBody, ArtDirectionResult,
    ArtJobBody, ArtJobItem, ArtJobStatus,
]
ROOT = GameDoc
