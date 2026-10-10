"""Boot migration of v1 levels to dal-level v2 (PLAN_V2 §2.6). Lane D orchestrates; the core worker method
`migrate_v1` does the work. Idempotent: the v1 JSON stays in levels.json, v2 goes to levels.json_v2.
P0: skeleton only (lands in P4).
"""
from __future__ import annotations


async def migrate_all() -> int:
    """Migrate every v1 level that has no json_v2 yet. Returns the number migrated."""
    return 0
