"""dal-level v2 contracts: the single source of truth (PLAN_V2 D18, §11.3a).

scripts/gen_contracts.py turns these modules into shared/spec/<name>.schema.json and
web/src/core/types.gen.ts. Change them only through a contract PR (docs/v2/CONTRACTS.md).
"""
from types import ModuleType

from app.spec import api, behavior, common, edits, events, ink, level, library, plan, report, rules, runs, scene

SPEC_VERSION = "1.0"

# published schema name -> module (each module has EXPORTS and ROOT)
SCHEMA_MODULES: dict[str, ModuleType] = {
    "common": common,
    "behavior": behavior,
    "ink": ink,
    "edits": edits,
    "scene": scene,
    "report": report,
    "rules": rules,
    "library": library,
    "level": level,
    "events": events,
    "run": runs,
    "plan": plan,
    "api": api,
}

__all__ = ["SCHEMA_MODULES", "SPEC_VERSION"]
