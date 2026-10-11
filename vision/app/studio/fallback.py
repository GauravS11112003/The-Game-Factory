"""Keyword answers for the copilot when the model cannot answer (CONTRACTS_V6 §5.3): no key, fake mode without a
reply, over budget, a failed or refused call. Everything here returns raw edits that go through edits.validate_edits
exactly like the model's, and `source: "keywords"`.

Chat understands, and combines in one reply:
- "make / turn / reimagine … into / as <game kind>" for the nine kinds below: world preset, theme, HUD, counters and
  rules from a playbook, the maker's drawings re-purposed by their shapes (long lines become ground, circles near a
  box become wheels, the selected or biggest drawing becomes the hero), and ask_draw for what is missing (≤ 3);
- "make this / the blue blobs / the selection a <archetype>" (with "that shoot", "that chase me" modifiers);
- gravity off / low / high / flip / normal / sideways, and "space flips gravity";
- "N lives", "N health", "a sword", "can shoot", "double jump", "jump higher";
- theme words ("spooky", "neon", "watercolor forest") → set_theme with the best preset.
Otherwise it asks to rephrase with three suggestions. Recognize answers "What is this?" with no edits; theme picks
the best keyword preset, else Sketchbook.
"""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any

from app.mind.messages import say
from app.studio import assets, catalog
from app.studio.summary import COLOUR_WORDS, Shape, shape_of

NUMBER_WORDS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
                "ten": 10, "a": 1, "an": 1, "single": 1, "twenty": 20, "fifty": 50, "hundred": 100}
_NUM = r"(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty|hundred)"
# weak kind words ("race", "car", "space") only name a game kind with one of these around them
REIMAGINE = re.compile(r"\b(reimagine|re-imagine|into|transform|convert|game|style of)\b|\bas an? \b|\blike an? \b")


# ---- game kinds ---------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Kind:
    key: str
    world: str  # a catalog world preset (or a custom one built in _world_edit)
    theme: str
    strong: tuple[str, ...]
    weak: tuple[str, ...] = ()


KINDS: tuple[Kind, ...] = (
    Kind("racer", "hill climb racer", "desert_dunes",
         ("hill climb", "hill climber", "racer", "racing game", "racing", "car game", "driving game", "rally",
          "monster truck", "truck game", "drive"), ("race", "driving", "car", "cars")),
    Kind("fighter", "fighting game", "comic_pop",
         ("fighting game", "fighting", "fighter game", "street fighter", "brawler", "smash bros", "beat em up",
          "beat 'em up", "1v1", "versus game", "mortal kombat", "boxing game"), ("fight", "fighters", "versus", "duel")),
    Kind("shooter", "space shooter", "deep_space",
         ("space shooter", "shooter", "asteroids", "shoot em up", "shoot 'em up", "shmup", "galaga", "space invaders",
          "space game", "spaceship game"), ("space", "spaceship", "shooting")),
    Kind("platformer", "platformer", "crayon_kids",
         ("platformer", "platform game", "platforming", "mario", "jump and run", "sonic", "side scroller",
          "side-scroller"), ("jumping game",)),
    Kind("puzzle", "physics puzzle", "sketchbook",
         ("angry birds", "physics puzzle", "slingshot game", "slingshot", "puzzle game"), ("puzzle", "physics")),
    Kind("catch", "catch game", "candy",
         ("catch game", "catching game", "catch the", "falling stars", "fruit catcher"), ("catch", "catching")),
    Kind("flappy", "flappy", "pixel_retro", ("flappy bird", "flappy", "flap game"), ("flap", "flapping")),
    Kind("runner", "endless runner", "neon_arcade",
         ("endless runner", "runner", "temple run", "subway surfers", "dino game", "dino run", "auto runner",
          "infinite runner"), ("running game", "endless")),
    Kind("topdown", "top-down", "jungle",
         ("top-down", "top down", "topdown", "zelda", "rpg", "dungeon crawler", "dungeon", "pokemon", "maze game",
          "overhead"), ("adventure", "maze", "explore", "exploring")),
)

KIND_LABEL_KEYS = {k.key: f"ai.kind.{k.key}" for k in KINDS}


def _has(text: str, phrase: str) -> bool:
    return re.search(r"(?<![a-z0-9])" + re.escape(phrase) + r"(?![a-z0-9])", text) is not None


def detect_kind(text: str) -> tuple[Kind | None, str]:
    """(the game kind the message names, the phrase that named it)."""
    reimagine = bool(REIMAGINE.search(text))
    best: tuple[int, Kind | None, str] = (0, None, "")
    for k in KINDS:
        for p in k.strong:
            if _has(text, p) and len(p) + 100 > best[0]:
                best = (len(p) + 100, k, p)
        if reimagine:
            for p in k.weak:
                if _has(text, p) and len(p) > best[0]:
                    best = (len(p), k, p)
    return best[1], best[2]


# ---- archetypes ---------------------------------------------------------------------------------------------------

ARCH_WORDS: dict[str, tuple[str, ...]] = {
    "player": ("player", "main character", "character", "avatar"),
    "hero": ("hero",),
    "car": ("car", "truck", "vehicle", "buggy", "jeep", "kart", "go kart", "monster truck"),
    "wheel": ("wheel", "wheels", "tire", "tires", "tyre", "tyres"),
    "ship": ("ship", "spaceship", "space ship", "rocket", "spacecraft", "ufo", "starship"),
    "fighter": ("fighter", "fighters", "boxer", "ninja", "warrior", "samurai", "knight"),
    "enemy": ("enemy", "enemies", "monster", "monsters", "bad guy", "bad guys", "baddie", "baddies", "villain",
              "slime", "slimes", "zombie", "zombies", "goomba", "goombas"),
    "projectile": ("bullet", "bullets", "projectile", "projectiles", "fireball", "fireballs", "laser", "lasers",
                   "arrow", "arrows", "missile", "missiles"),
    "coin": ("coin", "coins", "collectible", "collectibles", "gem", "gems", "diamond", "diamonds", "treasure",
             "pickup", "pickups", "star to collect", "stars to collect"),
    "ground": ("ground", "terrain", "hill", "hills", "road", "track", "floor", "land"),
    "platform": ("platform", "platforms", "wall", "walls", "block", "blocks", "ledge", "ledges", "brick", "bricks",
                 "solid"),
    "crate": ("crate", "crates", "box you can push", "barrel", "barrels", "pushable"),
    "ball": ("ball", "balls"),
    "hazard": ("lava", "spike", "spikes", "danger", "dangerous", "hazard", "trap", "traps", "fire", "acid", "deadly",
               "poison"),
    "goal": ("goal", "flag", "finish line", "finish", "exit", "portal"),
    "spawner": ("spawner",),
    "zone": ("zone", "trigger"),
    "decoration": ("decoration", "decorations", "scenery", "decor", "background"),
}


def detect_archetype(text: str) -> tuple[str | None, str]:
    best: tuple[int, str | None, str] = (0, None, "")
    for kind, words in ARCH_WORDS.items():
        for w in words:
            if not _has(text, w) or len(w) <= best[0]:
                continue
            if archetype_mode(text, w) is None:  # "make the player jump" names no archetype to become
                continue
            best = (len(w), kind, w)
    return best[1], best[2]


def archetype_mode(text: str, phrase: str) -> str | None:
    """"become" for "make this a car" / "the blue blobs are enemies", "add" for "add a coin", else None."""
    w = re.escape(phrase)
    art = r"(?:a |an |the |some |more |my |\d+ )?"
    if re.search(r"\b(add|draw|put|create|need|place|want)\s+(?:in |me )?" + art + w + r"\b", text):
        return "add"
    if re.search(r"\b(a|an|into|as|be|become|becomes|is|are|like)\s+" + art + w + r"\b", text):
        return "become"
    if re.search(r"\b(this|it|that|these|those|them|selection|selected)\s+" + art + w + r"\b", text):
        return "become"
    return None


def archetype_fields(kind: str, *, world_kind: str = "") -> dict[str, Any]:
    """A partial ObjectDef for an archetype (behaviours with their params; the client keeps the drawing)."""
    if kind == "player" and "top" in world_kind:
        kind = "hero"
    a = catalog.archetypes().get(kind)
    if a is None:
        return {"kind": kind}
    out: dict[str, Any] = {"kind": a["kind"], "physics": copy.deepcopy(a.get("physics", {})),
                           "behaviors": [{"type": b["type"], "params": copy.deepcopy(b.get("params") or {})}
                                         for b in a.get("behaviors", [])],
                           "tags": list(a.get("tags", []))}
    if a.get("counters"):
        out["counters"] = dict(a["counters"])
    if a.get("player"):
        out["player"] = a["player"]
    if a.get("template"):
        out["template"] = True
    return out


# ---- the scene's drawings -----------------------------------------------------------------------------------------


@dataclass
class Item:
    obj: dict[str, Any]
    shape: Shape

    @property
    def id(self) -> str:
        return str(self.obj.get("id"))

    @property
    def x(self) -> float:
        return float(self.obj.get("x") or 0)

    @property
    def y(self) -> float:
        return float(self.obj.get("y") or 0)

    @property
    def kind(self) -> str:
        return str(self.obj.get("kind") or "thing").lower()


def scene_of(doc: dict[str, Any], scene_id: str) -> dict[str, Any]:
    scenes = doc.get("scenes") or [{}]
    return next((s for s in scenes if s.get("id") == scene_id), scenes[0])


def items_of(doc: dict[str, Any], scene_id: str) -> list[Item]:
    return [Item(o, shape_of(o)) for o in scene_of(doc, scene_id).get("objects") or [] if not o.get("template")]


class Roles:
    """The scene's drawings sorted by what their shapes suggest; `take` hands each one out once."""

    def __init__(self, items: list[Item], selection: list[str]):
        self.items = items
        self.sel = [i for s in selection for i in items if i.id == s]
        self.used: set[str] = set()

    def free(self) -> list[Item]:
        return [i for i in self.items if i.id not in self.used]

    def take(self, item: Item | None) -> Item | None:
        if item is not None:
            self.used.add(item.id)
        return item

    def by_kind(self, *kinds: str) -> Item | None:
        return next((i for i in self.free() if i.kind in kinds), None)

    def grounds(self) -> list[Item]:
        return [i for i in self.free() if i.shape.is_long or i.kind in ("ground", "terrain", "floor", "road", "hill")]

    def rounds(self) -> list[Item]:
        return [i for i in self.free() if i.shape.is_round and not i.shape.is_long]

    def boxes(self) -> list[Item]:
        return [i for i in self.free() if i.shape.is_box and not i.shape.is_long]

    def blobs(self) -> list[Item]:
        return [i for i in self.free() if not i.shape.is_long and not i.shape.is_round and not i.shape.is_box
                and i.shape.strokes > 0]

    def hero(self, *kinds: str) -> Item | None:
        """The selected drawing, a drawing already called one of `kinds`, else the biggest character-like one."""
        for i in self.sel:
            if i.id not in self.used and not i.shape.is_long:
                return self.take(i)
        k = self.by_kind(*kinds) if kinds else None
        if k is not None:
            return self.take(k)
        pool = self.blobs() or self.boxes() or self.rounds()
        return self.take(max(pool, key=lambda i: i.shape.area)) if pool else None


def _near(a: Item, b: Item, factor: float = 0.9) -> bool:
    reach = max(a.shape.w, a.shape.h) * factor + max(b.shape.w, b.shape.h) / 2
    return abs(a.x - b.x) <= reach and abs(a.y - b.y) <= reach


# ---- edit builders ------------------------------------------------------------------------------------------------


class Plan:
    """Raw edits plus the asks and sentences of one keyword reply."""

    def __init__(self, doc: dict[str, Any], scene_id: str):
        self.doc = doc
        self.scene_id = scene_id
        self.edits: list[dict[str, Any]] = []
        self.asks: list[str] = []  # prompts, in order
        self.sentences: list[str] = []
        self.suggestions: list[str] = []
        self.hud: list[dict[str, Any]] | None = None
        self.counters: dict[str, float] = {}

    @property
    def world_kind(self) -> str:
        return str((scene_of(self.doc, self.scene_id).get("world") or {}).get("kind") or "").lower()

    def add(self, action: str, target: str | None = None, data: dict[str, Any] | None = None) -> None:
        self.edits.append({"action": action, "target": target, "data": data or {}})

    def obj(self, oid: str, fields: dict[str, Any]) -> None:
        self.add("update_object", oid, fields)

    def ask(self, aid: str, prompt_key: str, fields: dict[str, Any]) -> bool:
        if len(self.asks) >= 3:
            return False
        prompt = say(prompt_key)
        self.add("ask_draw", None, {"id": aid, "prompt": prompt, "object": fields})
        self.asks.append(prompt)
        return True

    def invisible(self, oid: str, x: float, y: float, w: float, h: float, fields: dict[str, Any]) -> None:
        self.obj(oid, {"x": x, "y": y, "drawing": {"w": w, "h": h}, **fields})

    def hud_item(self, subject: str, counter: str, style: str, mx: float | None = None) -> None:
        if self.hud is None:
            self.hud = []
        if any(i["subject"] == subject and i["counter"] == counter for i in self.hud):
            return
        it: dict[str, Any] = {"subject": subject, "counter": counter, "style": style}
        if mx is not None:
            it["max"] = mx
        self.hud.append(it)

    def finish(self) -> None:
        if self.hud is not None:
            self.add("set_hud", None, {"items": self.hud[:8], "timer": False, "title": None})
        if self.counters:
            self.add("set_game_counters", None, {"counters": self.counters})


def _world_edit(p: Plan, kind: Kind, follow: str | None) -> None:
    w = catalog.worlds().get(kind.world)
    if w is None:  # flappy: no catalog preset
        data: dict[str, Any] = {"kind": kind.world, "gravity": [0, 1], "edges": "none", "width": 1600, "height": 900,
                                "camera": {"mode": "fixed"}}
    else:
        data = {k: copy.deepcopy(v) for k, v in w.items() if k in ("kind", "gravity", "edges", "width", "height",
                                                                    "players", "camera")}
    data.setdefault("players", 1)
    cam = data.setdefault("camera", {})
    if cam.get("mode") == "follow" and follow:
        cam["target"] = follow
    p.add("set_world", None, data)


def _theme_edit(p: Plan, theme_id: str) -> str:
    t = assets.theme_by_id(theme_id) or assets.sketchbook()
    p.add("set_theme", None, {"preset": t.get("id") or theme_id})
    return str(t.get("name") or "Sketchbook")


def _ground(p: Plan, it: Item) -> None:
    f = archetype_fields("ground")
    if it.shape.closed and not it.shape.lines:  # a filled hill or a box: solid by its outline
        f["physics"] = {"body": "static", "shape": "auto", "friction": 0.9}
    p.obj(it.id, f)


def _platform(p: Plan, it: Item, kind: str = "platform") -> None:
    if it.shape.lines and not it.shape.closed:
        p.obj(it.id, {**archetype_fields("ground"), "kind": kind if kind != "platform" else "ground"})
    else:
        p.obj(it.id, {**archetype_fields("platform"), "kind": kind})


# ---- playbooks ----------------------------------------------------------------------------------------------------


def play_racer(p: Plan, r: Roles) -> str | None:
    car = r.take(r.by_kind("car", "truck", "vehicle", "buggy"))
    if car is None:
        boxes = r.boxes() + r.blobs()
        with_wheels = [b for b in boxes if sum(_near(b, c) for c in r.rounds()) >= 1]
        car = r.take(max(with_wheels, key=lambda i: i.shape.area) if with_wheels else None) or r.hero()
    grounds = r.grounds()
    car_fields = archetype_fields("car")
    car_fields["behaviors"][0]["params"]["fuel_counter"] = "fuel"
    car_fields["counters"] = {"fuel": 100, "coins": 0}
    car_fields["rules"] = [{"when": {"type": "counter", "params": {"subject": "self", "counter": "fuel", "op": "<=",
                                                                   "value": 0}},
                            "then": [{"type": "say", "params": {"text": say("ai.kw.out_of_fuel")}},
                                     {"type": "lose", "params": {}}], "once": True}]
    car_id = car.id if car else "car"
    if car is not None:
        p.obj(car.id, car_fields)
        w, h = car.shape.w or 160, car.shape.h or 80
        wheels = sorted([c for c in r.rounds() if _near(car, c)], key=lambda c: abs(c.x - car.x))[:2]
    else:
        p.ask("car", "ai.ask.car", car_fields)
        w, h, wheels = 160.0, 80.0, []
    for wi in wheels:
        r.take(wi)
        p.obj(wi.id, archetype_fields("wheel"))
        at = [round(wi.x - car.x, 1), round(wi.y - car.y, 1)] if car else [0, 0]
        p.add("add_joint", car_id, {"type": "wheel", "to": wi.id, "at": at, "motor": True})
    for n, side in enumerate(("back", "front")[len(wheels):]):
        wid = f"wheel_{side}"
        if p.ask(wid, f"ai.ask.wheel_{side}", archetype_fields("wheel")):
            x = -w * 0.33 if side == "back" else w * 0.33
            p.add("add_joint", car_id, {"type": "wheel", "to": wid, "at": [round(x, 1), round(h * 0.5, 1)],
                                        "motor": True})
    for g in grounds:
        r.take(g)
        _ground(p, g)
    if not grounds and not p.ask("ground", "ai.ask.hills", archetype_fields("ground")):
        world = catalog.worlds().get("hill climb racer", {})
        ww, wh = float(world.get("width", 12000)), float(world.get("height", 1400))
        p.invisible("floor", ww / 2, wh - 40, ww, 80, {"kind": "ground", "physics": {"body": "static", "shape": "box",
                                                                                     "friction": 0.9},
                                                       "tags": ["ground"]})
    for c in r.rounds():
        if c.shape.w <= 120:
            r.take(c)
            p.obj(c.id, archetype_fields("coin"))
    p.hud_item("player1", "fuel", "bar", 100)
    p.hud_item("player1", "coins", "number")
    return car_id


def play_fighter(p: Plan, r: Roles) -> str | None:
    fighters = []
    for _ in range(2):
        f = r.hero("fighter", "player", "hero", "boxer", "ninja")
        if f is not None:
            fighters.append(f)
    for n in (1, 2):
        fields = archetype_fields("fighter")
        fields["player"] = n
        fields["behaviors"].append({"type": "shooter", "params": {"key": "action2", "rate": 1, "speed": 700,
                                                                  "damage": 1}})
        if n == 2:
            fields["behaviors"].append({"type": "ai_fighter", "params": {"target": "player1", "skill": 0.5}})
        if len(fighters) >= n:
            p.obj(fighters[n - 1].id, fields)
        else:
            p.ask(f"fighter{n}", f"ai.ask.fighter{n}", fields)
        p.hud_item(f"player{n}", "health", "bar", 10)
    for g in r.grounds() + r.boxes():
        r.take(g)
        _platform(p, g)
    return fighters[0].id if fighters else None


def play_shooter(p: Plan, r: Roles) -> str | None:
    ship = r.hero("ship", "spaceship", "rocket", "player")
    fields = archetype_fields("ship")
    fields["behaviors"].append({"type": "health", "params": {"max": 3, "on_zero": "lose"}})
    fields["counters"] = {"health": 3}
    if ship is not None:
        p.obj(ship.id, fields)
    else:
        p.ask("ship", "ai.ask.ship", fields)
    rock_fields = {"kind": "asteroid", "physics": {"body": "dynamic", "gravity_scale": 0, "friction": 0},
                   "behaviors": [{"type": "rotate", "params": {"speed": 40}},
                                 {"type": "damage", "params": {"to": "player", "amount": 1}},
                                 {"type": "health", "params": {"max": 1, "on_zero": "destroy"}},
                                 {"type": "lifetime", "params": {"seconds": 14}}],
                   "counters": {"health": 1}, "tags": ["enemy"],
                   "rules": [{"when": {"type": "destroyed", "params": {}},
                              "then": [{"type": "add", "params": {"subject": "game", "counter": "score",
                                                                  "amount": 10}},
                                       {"type": "sound", "params": {"name": "boom"}}]}]}
    rocks = r.blobs() + r.rounds() + r.boxes()
    rock_id = "asteroid"
    if rocks:
        first = r.take(rocks[0])
        rock_id = first.id
        p.obj(first.id, {**rock_fields, "template": True})
        for other in rocks[1:]:
            r.take(other)
            p.obj(other.id, {**rock_fields, "behaviors": rock_fields["behaviors"][:3]})
    else:
        p.ask("asteroid", "ai.ask.asteroid", {**rock_fields, "template": True})
    p.invisible("rock_spawner", 800, 60, 200, 80, {"kind": "spawner", "physics": {"body": "none"},
                                                  "behaviors": [{"type": "spawner", "params": {
                                                      "template": rock_id, "every": 1.6, "max": 8, "area": "top",
                                                      "velocity": [0, 140], "jitter": 300}}],
                                                  "tags": ["spawner"]})
    p.counters["score"] = 0
    p.hud_item("game", "score", "number")
    p.hud_item("player1", "health", "hearts", 3)
    return ship.id if ship else "ship"


def play_platformer(p: Plan, r: Roles) -> str | None:
    hero = r.hero("player", "hero", "character")
    fields = archetype_fields("player")
    fields["counters"] = {"health": 3, "coins": 0}
    if hero is not None:
        p.obj(hero.id, fields)
    else:
        p.ask("player", "ai.ask.player", fields)
    for g in r.grounds():
        r.take(g)
        _ground(p, g)
    for b in r.boxes():
        r.take(b)
        _platform(p, b)
    goal = r.take(r.by_kind("goal", "flag", "door", "exit"))
    if goal is not None:
        p.obj(goal.id, {**archetype_fields("goal"), "kind": goal.kind})
    for c in r.rounds():
        r.take(c)
        p.obj(c.id, archetype_fields("coin"))
    for e in r.blobs():
        r.take(e)
        p.obj(e.id, archetype_fields("enemy"))
    if goal is None:
        p.ask("flag", "ai.ask.flag", {**archetype_fields("goal"), "kind": "flag"})
    p.hud_item("player1", "health", "hearts", 3)
    p.hud_item("player1", "coins", "number")
    return hero.id if hero else "player"


def play_puzzle(p: Plan, r: Roles) -> str | None:
    pool = [i for i in r.sel if not i.shape.is_long] or sorted(r.rounds() + r.blobs(), key=lambda i: i.x)
    bird = r.take(pool[0]) if pool else None
    fields = {"kind": "bird", "physics": {"body": "dynamic", "shape": "circle", "density": 1.5, "bounce": 0.3},
              "behaviors": [{"type": "launcher", "params": {"power": 1.2, "shots_counter": "shots"}}],
              "tags": ["player"], "player": 1}
    if bird is not None:
        p.obj(bird.id, fields)
    else:
        p.ask("bird", "ai.ask.bird", fields)
    for g in r.grounds():
        r.take(g)
        _ground(p, g)
    for b in r.boxes():
        r.take(b)
        p.obj(b.id, archetype_fields("crate"))
    pig = {"kind": "pig", "physics": {"body": "dynamic", "density": 1},
           "behaviors": [{"type": "health", "params": {"max": 2, "on_zero": "destroy"}}],
           "counters": {"health": 2}, "tags": ["enemy"]}
    pigs = r.blobs() + r.rounds()
    for e in pigs:
        r.take(e)
        p.obj(e.id, pig)
    if not pigs:
        p.ask("pig", "ai.ask.pig", pig)
    p.counters["shots"] = 3
    p.add("add_rule", "@game", {"when": {"type": "all_gone", "params": {"tag": "enemy"}},
                                "then": [{"type": "win", "params": {}}], "once": True})
    p.hud_item("game", "shots", "number")
    return None


def play_catch(p: Plan, r: Roles) -> str | None:
    sel = [i for i in r.sel]
    pool = sel or sorted(r.boxes() + r.blobs() + r.grounds(), key=lambda i: -(i.shape.w / max(i.shape.h, 1)))
    paddle = r.take(pool[0]) if pool else None
    fields = {"kind": "paddle", "physics": {"body": "dynamic", "gravity_scale": 0, "fixed_rotation": True,
                                            "friction": 0},
              "behaviors": [{"type": "move_keys", "params": {"axes": "x", "speed": 520}}], "tags": ["player"],
              "player": 1}
    if paddle is not None:
        p.obj(paddle.id, fields)
    else:
        p.ask("paddle", "ai.ask.paddle", fields)
    star = {"kind": "star", "physics": {"body": "dynamic", "sensor": True, "gravity_scale": 0},
            "behaviors": [{"type": "pickup", "params": {"item": "score", "amount": 1, "to": "player"}},
                          {"type": "lifetime", "params": {"seconds": 7}}], "tags": ["star"], "template": True}
    stars = r.rounds() + r.blobs()
    star_id = "star"
    if stars:
        s = r.take(stars[0])
        star_id = s.id
        p.obj(s.id, star)
    else:
        p.ask("star", "ai.ask.star", star)
    bomb = {"kind": "bomb", "physics": {"body": "dynamic", "sensor": True, "gravity_scale": 0},
            "behaviors": [{"type": "lifetime", "params": {"seconds": 7}}], "tags": ["bomb"], "template": True,
            "rules": [{"when": {"type": "overlap", "params": {"with": "player"}},
                       "then": [{"type": "add", "params": {"subject": "game", "counter": "lives", "amount": -1}},
                                {"type": "shake", "params": {"power": 1}}, {"type": "sound", "params": {"name": "boom"}},
                                {"type": "destroy", "params": {"target": "self"}}]}]}
    p.ask("bomb", "ai.ask.bomb", bomb)
    p.invisible("star_spawner", 800, 40, 400, 60, {"kind": "spawner", "physics": {"body": "none"}, "behaviors": [
        {"type": "spawner", "params": {"template": star_id, "every": 1.1, "max": 8, "area": "top",
                                       "velocity": [0, 170]}}]})
    p.invisible("bomb_spawner", 800, 40, 400, 60, {"kind": "spawner", "physics": {"body": "none"}, "behaviors": [
        {"type": "spawner", "params": {"template": "bomb", "every": 2.8, "max": 3, "area": "top",
                                       "velocity": [0, 210]}}]})
    p.counters.update({"score": 0, "lives": 3})
    p.add("add_rule", "@game", {"when": {"type": "counter", "params": {"subject": "game", "counter": "lives",
                                                                       "op": "<=", "value": 0}},
                                "then": [{"type": "lose", "params": {}}], "once": True})
    p.hud_item("game", "score", "number")
    p.hud_item("game", "lives", "hearts", 3)
    return None


def play_flappy(p: Plan, r: Roles) -> str | None:
    bird = r.hero("bird", "player")
    fields = {"kind": "bird", "physics": {"body": "dynamic", "fixed_rotation": True},
              "behaviors": [{"type": "health", "params": {"max": 1, "on_zero": "lose"}}], "counters": {"health": 1},
              "tags": ["player"], "player": 1,
              "rules": [{"when": {"type": "key_down", "params": {"key": "space"}},
                         "then": [{"type": "velocity", "params": {"target": "self", "x": 0, "y": -520}},
                                  {"type": "sound", "params": {"name": "jump"}}]},
                        {"when": {"type": "out_of_bounds", "params": {}}, "then": [{"type": "lose", "params": {}}]}]}
    if bird is not None:
        p.obj(bird.id, {**fields, "x": 400})
    else:
        p.ask("bird", "ai.ask.flappy_bird", fields)
    pipe = {"kind": "pipe", "physics": {"body": "dynamic", "gravity_scale": 0, "sensor": True, "fixed_rotation": True},
            "behaviors": [{"type": "hazard", "params": {"to": "player"}}, {"type": "lifetime", "params": {"seconds": 10}}],
            "tags": ["pipe"], "template": True}
    pipes = r.boxes() + r.grounds() + r.blobs()
    pipe_id = "pipe"
    if pipes:
        pp = r.take(pipes[0])
        pipe_id = pp.id
        p.obj(pp.id, pipe)
    else:
        p.ask("pipe", "ai.ask.pipe", pipe)
    p.invisible("pipe_spawner", 1600, 450, 80, 600, {"kind": "spawner", "physics": {"body": "none"}, "behaviors": [
        {"type": "spawner", "params": {"template": pipe_id, "every": 1.8, "max": 6, "area": "right",
                                       "velocity": [-240, 0], "jitter": 250}}]})
    p.counters["score"] = 0
    p.add("add_rule", "@game", {"when": {"type": "every", "params": {"seconds": 1.8}},
                                "then": [{"type": "add", "params": {"subject": "game", "counter": "score",
                                                                    "amount": 1}}]})
    p.hud_item("game", "score", "number")
    return None


def play_runner(p: Plan, r: Roles) -> str | None:
    hero = r.hero("player", "runner", "hero")
    fields = {**archetype_fields("player"), "kind": "runner"}
    fields["behaviors"] = [{"type": "platformer", "params": {"speed": 320, "jump": 720}},
                           {"type": "health", "params": {"max": 1, "on_zero": "lose"}}]
    fields["counters"] = {"health": 1}
    fields["rules"] = [{"when": {"type": "out_of_bounds", "params": {}}, "then": [{"type": "lose", "params": {}}]}]
    if hero is not None:
        p.obj(hero.id, fields)
    else:
        p.ask("runner", "ai.ask.runner", fields)
    for g in r.grounds():
        r.take(g)
        _ground(p, g)
    world = catalog.worlds().get("endless runner", {})
    ww, wh = float(world.get("width", 20000)), float(world.get("height", 900))
    p.invisible("floor", ww / 2, wh - 30, ww, 60, {"kind": "ground", "physics": {"body": "static", "shape": "box",
                                                                                 "friction": 0.6},
                                                   "tags": ["ground"]})
    obstacle = {"kind": "obstacle", "physics": {"body": "dynamic", "fixed_rotation": True, "density": 5},
                "behaviors": [{"type": "hazard", "params": {"to": "player"}},
                              {"type": "lifetime", "params": {"seconds": 20}}], "tags": ["obstacle"], "template": True}
    obs = r.boxes() + r.blobs() + r.rounds()
    obs_id = "obstacle"
    if obs:
        o = r.take(obs[0])
        obs_id = o.id
        p.obj(o.id, obstacle)
    else:
        p.ask("obstacle", "ai.ask.obstacle", obstacle)
    p.invisible("obstacle_spawner", 1500, 600, 80, 200, {"kind": "spawner", "physics": {"body": "none"}, "behaviors": [
        {"type": "spawner", "params": {"template": obs_id, "every": 2.2, "max": 6, "area": "right"}}]})
    p.counters["score"] = 0
    p.add("add_rule", "@game", {"when": {"type": "every", "params": {"seconds": 1}},
                                "then": [{"type": "add", "params": {"subject": "game", "counter": "score",
                                                                    "amount": 1}}]})
    p.hud_item("game", "score", "number")
    return hero.id if hero else "runner"


def play_topdown(p: Plan, r: Roles) -> str | None:
    hero = r.hero("hero", "player", "character")
    fields = archetype_fields("hero")
    fields["counters"] = {"health": 3, "keys": 0}
    if hero is not None:
        p.obj(hero.id, fields)
    else:
        p.ask("hero", "ai.ask.hero", fields)
    for w in r.grounds() + r.boxes():
        r.take(w)
        p.obj(w.id, {**archetype_fields("platform"), "kind": "wall"})
    key = {"kind": "key", "physics": {"body": "static", "sensor": True},
           "behaviors": [{"type": "pickup", "params": {"item": "keys", "amount": 1, "to": "player"}},
                         {"type": "float", "params": {}}], "tags": ["key"]}
    keys = r.rounds()
    for k in keys:
        r.take(k)
        p.obj(k.id, key)
    if not keys:
        p.ask("key", "ai.ask.key", key)
    door = {"kind": "door", "physics": {"body": "static"}, "tags": ["door"],
            "rules": [{"when": {"type": "collide", "params": {"with": "player"}},
                       "conditions": [{"subject": "other", "counter": "keys", "op": ">=", "value": 1}],
                       "then": [{"type": "take", "params": {"from": "other", "item": "keys", "amount": 1}},
                                {"type": "sound", "params": {"name": "ding"}},
                                {"type": "destroy", "params": {"target": "self"}}]}]}
    d = r.take(r.by_kind("door", "gate"))
    if d is not None:
        p.obj(d.id, door)
    else:
        p.ask("door", "ai.ask.door", door)
    p.hud_item("player1", "health", "hearts", 3)
    p.hud_item("player1", "keys", "icons")
    return hero.id if hero else "hero"


PLAYBOOKS = {"racer": play_racer, "fighter": play_fighter, "shooter": play_shooter, "platformer": play_platformer,
             "puzzle": play_puzzle, "catch": play_catch, "flappy": play_flappy, "runner": play_runner,
             "topdown": play_topdown}


def reimagine(p: Plan, kind: Kind, selection: list[str]) -> None:
    r = Roles(items_of(p.doc, p.scene_id), selection)
    p.hud = []
    follow = PLAYBOOKS[kind.key](p, r)
    _world_edit(p, kind, follow if follow and not follow.startswith("@") else None)
    _theme_edit(p, kind.theme)
    if str(p.doc.get("title") or "").strip() in ("", "Untitled game"):
        p.add("set_title", None, {"title": say(f"ai.title.{kind.key}")})
    label = say(KIND_LABEL_KEYS[kind.key])
    first = say("ai.kw.reimagine", {"kind": label})
    p.sentences.append(first + (" " + p.asks[0] + "!" if p.asks else ""))
    p.suggestions += [say(f"ai.sug.{kind.key}.{n}") for n in (1, 2, 3)]


# ---- smaller intents ----------------------------------------------------------------------------------------------


def _number(s: str) -> int | None:
    if s.isdigit():
        return int(s)
    return NUMBER_WORDS.get(s)


def targets_for(text: str, doc: dict[str, Any], scene_id: str, selection: list[str], phrase: str = "") -> list[Item]:
    """The drawings a message points at: colour words ("the blue blobs"), names or kinds, else the selection."""
    items = items_of(doc, scene_id)
    found: list[Item] = []
    for word, names in COLOUR_WORDS.items():
        if _has(text, word):
            found += [i for i in items if set(i.shape.colour_names[:2]) & names and i not in found]
    if found:
        return found
    for i in items:
        name = str(i.obj.get("name") or "").lower()
        if (name and _has(text, name)) or (i.kind not in ("thing", "") and _has(text, i.kind) and i.kind != phrase):
            found.append(i)
    if found:
        return found
    return [i for s in selection for i in items if i.id == s]


def apply_archetype(p: Plan, text: str, arch: str, phrase: str, selection: list[str], *,
                    ask_only: bool = False) -> None:
    targets = [] if ask_only else targets_for(text, p.doc, p.scene_id, selection, phrase)
    fields = archetype_fields(arch, world_kind=p.world_kind)
    a = catalog.archetypes().get(fields.get("kind", arch), {})
    label = say(f"ai.arch.{fields.get('kind', arch)}", default=str(a.get("label") or arch).lower())
    shoots = bool(re.search(r"\b(shoot|shoots|shooting|fire|fires|firing)\b", text))
    chases = bool(re.search(r"\b(chase|chases|chasing|follow|follows|following|hunt|hunts)\b", text))
    flies = bool(re.search(r"\b(fly|flies|flying|float|floats|floating)\b", text))
    if shoots and not any(b["type"] == "shooter" for b in fields.get("behaviors", [])):
        if fields.get("player"):
            fields.setdefault("behaviors", []).append({"type": "shooter", "params": {"key": "space"}})
        else:
            fields.setdefault("behaviors", []).append({"type": "shooter", "params": {
                "key": "auto", "direction": "player", "rate": 0.8, "speed": 500}})
    if chases and not fields.get("player"):
        fields["behaviors"] = [b for b in fields.get("behaviors", []) if b["type"] != "patrol"]
        fields["behaviors"].append({"type": "follow", "params": {"target": "player", "speed": 140, "axes": "xy" if flies
                                                                  else "x"}})
    if flies:
        fields.setdefault("physics", {})["gravity_scale"] = 0
    if not targets:
        aid = re.sub(r"[^a-z0-9_]", "_", fields.get("kind", arch))[:30] or "thing"
        prompt_key = f"ai.ask.{arch}" if say(f"ai.ask.{arch}", default="") else "ai.ask.generic"
        p.add("ask_draw", None, {"id": aid, "prompt": say(prompt_key, {"what": phrase or label}), "object": fields})
        p.asks.append(say(prompt_key, {"what": phrase or label}))
        p.sentences.append(say("ai.kw.archetype_ask", {"prompt": p.asks[-1], "what": label}))
        return
    for t in targets[:20]:
        p.obj(t.id, copy.deepcopy(fields))
    if a.get("camera") and len(targets) == 1:
        p.add("set_world", None, {"camera": {"mode": "follow", "target": targets[0].id}})
    if a.get("wheels") and len(targets) == 1:
        car = targets[0]
        rest = [i for i in items_of(p.doc, p.scene_id) if i.id != car.id and i.shape.is_round and _near(car, i)]
        rest = sorted(rest, key=lambda c: abs(c.x - car.x))[:2]
        for wi in rest:
            p.obj(wi.id, archetype_fields("wheel"))
            p.add("add_joint", car.id, {"type": "wheel", "to": wi.id, "at": [round(wi.x - car.x, 1),
                                                                             round(wi.y - car.y, 1)], "motor": True})
        for side in ("back", "front")[len(rest):]:
            wid = f"wheel_{side}"
            if p.ask(wid, f"ai.ask.wheel_{side}", archetype_fields("wheel")):
                x = car.shape.w * (-0.33 if side == "back" else 0.33)
                p.add("add_joint", car.id, {"type": "wheel", "to": wid, "at": [round(x, 1), round(car.shape.h / 2, 1)],
                                            "motor": True})
    if len(targets) > 1:
        done = say("ai.kw.archetype_many", {"n": len(targets), "what": label})
    else:
        done = say("ai.kw.archetype", {"who": str(targets[0].obj.get("name") or "") or say("ai.kw.this"),
                                       "what": label})
    p.sentences.append(done + (" " + p.asks[0] + "!" if p.asks else ""))
    p.suggestions += [say("ai.sug.archetype.1"), say("ai.sug.archetype.2")]


GRAVITY = (
    (re.compile(r"\b(no|zero|without|turn off|disable|remove|off)\s+(the\s+)?gravity\b|\bgravity\s+(off|0|zero|none)\b"),
     [0, 0], "ai.kw.gravity_off"),
    (re.compile(r"\b(flip|flips|flipped|reverse|reversed|invert|inverted|upside[- ]down)\s+(the\s+)?gravity\b|"
                r"\bgravity\s+(up|upside down|flipped|reversed|inverted)\b"), [0, -1], "ai.kw.gravity_flip"),
    (re.compile(r"\b(low|lower|less|weak|weaker|moon|light|lighter|floaty)\s+gravity\b|\bgravity\s+(low|lower|weaker)\b"),
     [0, 0.4], "ai.kw.gravity_low"),
    (re.compile(r"\b(high|higher|more|strong|stronger|heavy|heavier|double)\s+gravity\b|"
                r"\bgravity\s+(high|higher|stronger|heavier)\b"), [0, 2], "ai.kw.gravity_high"),
    (re.compile(r"\bgravity\s+(sideways|to the right|right)\b|\bsideways\s+gravity\b"), [1, 0], "ai.kw.gravity_side"),
    (re.compile(r"\bgravity\s+(to the left|left)\b"), [-1, 0], "ai.kw.gravity_side"),
    (re.compile(r"\b(normal|regular|default|turn on|add|real)\s+gravity\b|\bgravity\s+(on|back|normal)\b"), [0, 1],
     "ai.kw.gravity_normal"),
)
GRAVITY_KEY = re.compile(r"\b(press|presses|pressing|tap|taps|hit|key|space|click|clicks)\b.{0,40}\b(flip|flips|"
                         r"reverse|reverses|switch|switches)\b.{0,12}gravity|\b(flip|flips|reverse|reverses|switch|"
                         r"switches)\b.{0,12}gravity.{0,40}\b(press|pressing|tap|key|space|click)")


def gravity_intent(p: Plan, text: str) -> bool:
    if GRAVITY_KEY.search(text):
        key = "space" if "space" in text or "click" not in text else "space"
        p.add("add_rule", "@game", {"when": {"type": "key_down", "params": {"key": key}},
                                    "then": [{"type": "flip_gravity", "params": {}},
                                             {"type": "sound", "params": {"name": "whoosh"}}],
                                    "text": text[:200]})
        p.sentences.append(say("ai.kw.gravity_key"))
        return True
    for rx, g, key in GRAVITY:
        if rx.search(text):
            p.add("set_world", None, {"gravity": g})
            p.sentences.append(say(key))
            return True
    return False


def _pending_fields(p: Plan, oid: str) -> dict[str, Any] | None:
    """The fields of an update_object this reply already makes for `oid` (the last one), if any."""
    for e in reversed(p.edits):
        if e["action"] == "update_object" and e["target"] == oid:
            return e["data"]
    return None


def set_behavior(p: Plan, it: Item, btype: str, params: dict[str, Any], *, add: dict[str, Any] | None = None) -> bool:
    """Change `btype` params on an object, looking first at the behaviours this reply already sets for it, then at
    the document. With `add` (the params of a new one), a missing behaviour is added. True when something changed."""
    pend = _pending_fields(p, it.id)
    if pend is not None and "behaviors" in pend:
        b = next((b for b in pend["behaviors"] if b.get("type") == btype), None)
        if b is not None:
            b.setdefault("params", {}).update(params)
            return True
        if add is not None:
            pend["behaviors"].append({"type": btype, "params": dict(add)})
            return True
        return False
    b = next((b for b in it.obj.get("behaviors") or [] if b.get("type") == btype), None)
    if b is not None:
        p.add("update_behavior", it.id, {"id": b.get("id"), "params": params})
        return True
    if add is not None:
        p.add("add_behavior", it.id, {"type": btype, "params": dict(add)})
        return True
    return False


def behavior_params(p: Plan, it: Item, btype: str) -> dict[str, Any] | None:
    pend = _pending_fields(p, it.id)
    pool = pend["behaviors"] if pend is not None and "behaviors" in pend else it.obj.get("behaviors") or []
    b = next((b for b in pool if b.get("type") == btype), None)
    return None if b is None else dict(b.get("params") or {})


def _subjects(p: Plan, selection: list[str]) -> list[Item]:
    """Who "the player" / "it" means: the selection, else player objects (including ones this reply sets up)."""
    items = items_of(p.doc, p.scene_id)
    sel = [i for s in selection for i in items if i.id == s]
    if sel:
        return sel
    out = []
    for i in items:
        pend = _pending_fields(p, i.id) or {}
        if pend.get("player") or i.obj.get("player") or "player" in (pend.get("tags") or i.obj.get("tags") or []):
            out.append(i)
    return out


def counters_intent(p: Plan, text: str, selection: list[str]) -> bool:
    hit = False
    m = re.search(_NUM + r"\s+(?:extra\s+|more\s+)?(lives|life|hearts?)\b", text)
    if m and _number(m.group(1)):
        n = max(1, min(99, _number(m.group(1)) or 3))
        p.counters["lives"] = n
        p.hud_item("game", "lives", "hearts", n)
        rules = p.doc.get("rules") or []
        if not any((r.get("when") or {}).get("type") == "counter" and (r.get("when") or {}).get("params", {}).get(
                "counter") == "lives" for r in rules):
            p.add("add_rule", "@game", {"when": {"type": "counter", "params": {"subject": "game", "counter": "lives",
                                                                               "op": "<=", "value": 0}},
                                        "then": [{"type": "lose", "params": {}}], "once": True})
        for t in _subjects(p, selection):
            set_behavior(p, t, "health", {"on_zero": "respawn"})
        p.sentences.append(say("ai.kw.lives", {"n": n}))
        hit = True
    m = re.search(_NUM + r"\s+(?:max\s+)?(health|hp|hit points|hits)\b", text)
    if m and _number(m.group(1)):
        n = max(1, min(10000, _number(m.group(1)) or 3))
        targets = _subjects(p, selection)
        for t in targets:
            pend = _pending_fields(p, t.id) or {}
            on_zero = "lose" if (pend.get("player") or t.obj.get("player")) else "destroy"
            set_behavior(p, t, "health", {"max": n}, add={"max": n, "on_zero": on_zero, "bar": True})
            if pend:
                pend["counters"] = {**(pend.get("counters") or {}), "health": n}
            else:
                p.add("set_counters", t.id, {"counters": {"health": n}})
        if targets:
            p.sentences.append(say("ai.kw.health", {"n": n}))
            hit = True
    return hit


def abilities_intent(p: Plan, text: str, selection: list[str], skip_shoot: bool) -> bool:
    hit = False
    targets = _subjects(p, selection)
    if not targets:
        return False
    if re.search(r"\b(sword|swords|punch|punches|kick|kicks|melee|axe|hammer|fists?|swing)\b", text):
        for t in targets:
            set_behavior(p, t, "melee", {}, add={"key": "action", "damage": 1})
        p.sentences.append(say("ai.kw.melee"))
        hit = True
    if not skip_shoot and re.search(r"\b(shoot|shoots|shooting|gun|blaster|fireballs?|lasers?)\b", text):
        for t in targets:
            set_behavior(p, t, "shooter", {}, add={"key": "space"})
        p.sentences.append(say("ai.kw.shoot"))
        hit = True
    if re.search(r"\bdouble[- ]?jump\b", text):
        if any([set_behavior(p, t, "platformer", {"double_jump": True}) for t in targets]):
            p.sentences.append(say("ai.kw.double_jump"))
            hit = True
    elif re.search(r"\bjump\s+(higher|more|further)\b|\bhigher\s+jumps?\b|\bbigger\s+jumps?\b", text):
        done = False
        for t in targets:
            cur = behavior_params(p, t, "platformer")
            if cur is not None:
                done = set_behavior(p, t, "platformer", {"jump": round(float(cur.get("jump", 640)) * 1.35)}) or done
        if done:
            p.sentences.append(say("ai.kw.jump_higher"))
            hit = True
    return hit


# behaviour → its speed params (a "faster" / "slower" message scales them)
SPEED_PARAMS = {"platformer": {"speed": 280}, "move_keys": {"speed": 260}, "car": {"max_speed": 900, "power": 0.6},
                "thrust_ship": {"thrust": 600, "max_speed": 700}, "patrol": {"speed": 120}, "follow": {"speed": 150},
                "rotate": {"speed": 90}, "conveyor": {"speed": 150}}
FASTER = re.compile(r"\b(faster|quicker|speedier|speed (it |them )?up|more speed)\b")
SLOWER = re.compile(r"\b(slower|slow (it |them )?down|less speed)\b")


def speed_intent(p: Plan, text: str, selection: list[str]) -> bool:
    up, down = FASTER.search(text), SLOWER.search(text)
    if not up and not down:
        return False
    factor = 1.5 if up else 0.67
    if re.search(r"\b(scroll|scrolling|camera|screen)\b", text):
        cam = (scene_of(p.doc, p.scene_id).get("world") or {}).get("camera") or {}
        p.add("set_world", None, {"camera": {"speed": round(float(cam.get("speed") or 120) * factor)}})
        p.sentences.append(say("ai.kw.faster" if up else "ai.kw.slower"))
        return True
    targets = targets_for(text, p.doc, p.scene_id, selection) or _subjects(p, selection)
    done = False
    for t in targets[:20]:
        for btype, keys in SPEED_PARAMS.items():
            cur = behavior_params(p, t, btype)
            if cur is None:
                continue
            ps = {k: round(float(cur.get(k, d)) * factor, 2) for k, d in keys.items()}
            done = set_behavior(p, t, btype, ps) or done
    for i in items_of(p.doc, p.scene_id):  # "make the asteroids faster": spawners of matching templates
        sp = behavior_params(p, i, "spawner")
        if sp and any(t.id == sp.get("template") for t in targets):
            v = sp.get("velocity") or [0, 0]
            done = set_behavior(p, i, "spawner", {"velocity": [round(float(v[0]) * factor, 1),
                                                               round(float(v[1]) * factor, 1)]}) or done
    if done:
        p.sentences.append(say("ai.kw.faster" if up else "ai.kw.slower"))
    return done


KEY_PHRASE = re.compile(r"\b(press|pressing|presses|hit|hits|tap|taps|push|hold)\s+(the\s+)?space(\s*bar|\s+key)?\b|"
                        r"\bspace\s*(bar|key)\b")
THEME_HINT = re.compile(r"\b(theme|style|styled|look|looks|looking|vibe|colou?rs?|palette|aesthetic|feel)\b")


def theme_intent(p: Plan, text: str, *, require_hint: bool) -> bool:
    if require_hint and not THEME_HINT.search(text):
        return False
    t, score = assets.match_theme(KEY_PHRASE.sub(" ", text))
    if t is None or score < 2:
        return False
    if any(e["action"] == "set_theme" for e in p.edits):
        p.edits = [e for e in p.edits if e["action"] != "set_theme"]
    p.add("set_theme", None, {"preset": t.get("id")})
    p.sentences.append(say("ai.kw.theme", {"theme": t.get("name", "")}))
    return True


# ---- entry points -------------------------------------------------------------------------------------------------


def chat(doc: dict[str, Any], scene_id: str, selection: list[str], message: str) -> dict[str, Any]:
    """{reply, edits (raw, still to validate), suggestions} for one maker message."""
    text = re.sub(r"\s+", " ", str(message or "").lower().replace("’", "'")).strip()
    p = Plan(doc, scene_id)
    kind, phrase = detect_kind(text)
    arch, arch_phrase = detect_archetype(text)
    mode = archetype_mode(text, arch_phrase) if arch else None
    if kind is not None and mode is not None:
        # "make this a car" names an archetype; "make it a car game" / "reimagine as a racer" name a kind
        explicit = _has(text, "game") or re.search(r"\b(reimagine|re-imagine|canvas|everything|whole|world)\b", text)
        if not explicit and (phrase in kind.weak or phrase == arch_phrase):
            kind = None
    if kind is not None:
        reimagine(p, kind, selection)
        rest = text.replace(phrase, " ")
        theme_intent(p, rest, require_hint=False)
    elif mode is not None and arch is not None:
        apply_archetype(p, text, arch, arch_phrase, selection, ask_only=mode == "add")
        theme_intent(p, text, require_hint=True)
    else:
        theme_intent(p, text, require_hint=False)
    gravity_intent(p, text)
    counters_intent(p, text, selection)
    speed_intent(p, text, selection)
    abilities_intent(p, text, selection, skip_shoot=arch is not None and kind is None)
    p.finish()
    if not p.edits:
        return {"reply": say("ai.kw.rephrase"), "edits": [],
                "suggestions": [say("ai.sug.rephrase.1"), say("ai.sug.rephrase.2"), say("ai.sug.rephrase.3")]}
    sentences = re.split(r"(?<=[.!?])\s+", " ".join(p.sentences).strip())
    reply = " ".join(sentences[:2]) or say("ai.chat.done")
    sugg = list(dict.fromkeys(s for s in p.suggestions if s))[:4]
    if len(sugg) < 2:
        sugg += [say("ai.sug.rephrase.1"), say("ai.sug.rephrase.2")]
    return {"reply": reply, "edits": p.edits, "suggestions": sugg[:4]}


def recognize() -> dict[str, Any]:
    return {"question": say("ai.recognize.what"), "name": "", "kind": "thing", "edits": []}


def theme(text: str, game_kind: str | None = None) -> dict[str, Any]:
    """The best keyword preset for the words (and the game kind), else Sketchbook."""
    t, score = assets.match_theme(text)
    if (t is None or score < 1) and game_kind:
        k, _ = detect_kind(str(game_kind).lower() + " game")
        if k is not None:
            t = assets.theme_by_id(k.theme)
    return t or assets.theme_by_id(assets.DEFAULT_THEME_ID) or assets.sketchbook()
