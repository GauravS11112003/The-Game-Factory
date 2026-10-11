"""Turn the saved creator brief into context for drawing and prompt builds."""
import copy
import json
import re
from functools import lru_cache
from typing import Any

from app.config import SHARED_DIR


def brief_rules(game: dict[str, Any] | None) -> list[dict[str, str]]:
    brief = (game or {}).get("brief")
    if not isinstance(brief, dict):
        return []
    category = str(brief.get("category") or "").replace("rpg", "role-playing")
    rules = [{"text": f"Game category: {category}."}] if category else []
    for field, label in (("custom_definition", "Game concept"), ("theme", "Theme and setting"),
                         ("gameplay", "Player actions and goals"), ("details", "Design details")):
        value = brief.get(field)
        if value and (field != "custom_definition" or category == "custom"):
            rules.append({"text": f"{label}: {value}"})
    return rules


@lru_cache(maxsize=1)
def theme_catalog() -> dict[str, Any]:
    return json.loads((SHARED_DIR / "game-themes.json").read_text(encoding="utf-8"))


MECHANIC_WORDS = {
    "keys_doors": ("key", "keys", "door", "doors", "locked gate"),
    "moving_platforms": ("moving platform", "moving platforms", "moving stairs", "moving staircase", "moving bridge"),
    "crumbling_platforms": ("crumbling platform", "crumbling platforms", "crumbling ledge", "breakable block", "breakable blocks"),
    "bounce_pads": ("spring", "springs", "bounce pad", "bounce pads", "bouncy"),
    "coins": ("coin", "coins", "star", "stars", "gem", "gems", "ring", "rings", "collectible", "collectibles"),
    "enemies": ("enemy", "enemies", "monster", "monsters", "ghost", "ghosts", "bat", "bats"),
    "double_jump": ("double jump", "double jumping", "magical leap"),
    "checkpoint": ("checkpoint", "checkpoints"),
    "hazards": ("hazard", "hazards", "spike", "spikes", "lava", "saw", "saws"),
}


def resolve_guidance(brief: dict[str, Any] | None) -> dict[str, Any] | None:
    if not brief:
        return None
    context = [r["text"] for r in brief_rules({"brief": brief})]
    authored = " ".join(str(brief.get(k) or "") for k in ("theme", "custom_definition", "gameplay", "details"))
    text = re.sub(r"[^a-z0-9 ]", " ", authored.lower())
    theme = re.sub(r"[^a-z0-9 ]", " ", str(brief.get("theme") or "").lower())
    matches = [(source.find(alias), item) for source in (theme, text) for item in theme_catalog().values()
               for alias in item["aliases"] if re.search(r"\b" + re.escape(alias) + r"\b", source)]
    # A reference in the theme field takes priority over examples in other fields.
    theme_matches = [(theme.find(alias), item) for item in theme_catalog().values()
                     for alias in item["aliases"] if re.search(r"\b" + re.escape(alias) + r"\b", theme)]
    profile = min(theme_matches or matches, key=lambda pair: pair[0])[1] if matches else None
    if not authored.strip():
        return None
    mechanics = list(profile["mechanics"]) if profile else []
    excluded = []
    negative_clauses = re.findall(r"\b(?:no|without|avoid|exclude|disable|do not add|don['’]t add)\s+([^.!?;\n]+)", authored.lower())
    for mechanic, words in MECHANIC_WORDS.items():
        negative = any(re.search(r"(?:^|,|\band\b|\bor\b)\s*(?:no\s+)?(?:any\s+)?" + re.escape(word) + r"\b", clause)
                       for word in words for clause in negative_clauses)
        if negative:
            excluded.append(mechanic)
        elif any(re.search(r"\b" + re.escape(word) + r"\b", text) for word in words) and mechanic not in mechanics:
            mechanics.append(mechanic)
    return {
        "theme_name": profile["name"] if profile else str(brief.get("theme") or "Your world")[:80],
        "scene": profile["scene"] if profile else "custom",
        "setting": profile["setting"] if profile else str(brief.get("theme") or authored)[:500],
        "style_prompt": ". ".join(filter(None, [str(brief.get("theme") or ""), str(brief.get("details") or ""),
                                                   profile["style"] if profile else str(brief.get("custom_definition") or "")])),
        "mechanics": [m for m in mechanics if m not in excluded], "excluded_mechanics": excluded,
        "enemy_archetype": profile["enemy"] if profile else "walker",
        "palette": profile["palette"] if profile else ["#fbf6ea", "#b5c3ae", "#d0bea1", "#6a8f74"],
        "author_context": context,
    }


def rules_from_brief(rules: dict[str, Any], brief: dict[str, Any] | None) -> dict[str, Any]:
    guidance = resolve_guidance(brief)
    if guidance is None:
        return rules
    out = copy.deepcopy(rules)
    out["guidance"] = guidance
    if "double_jump" in guidance["mechanics"]:
        out.setdefault("abilities", {})["double_jump"] = True
    elif "double_jump" in guidance["excluded_mechanics"]:
        out.setdefault("abilities", {})["double_jump"] = False
    return out
