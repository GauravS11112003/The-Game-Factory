"""Project-owned raster art packs usable by Imagine without image-provider credentials."""
from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from app.config import SHARED_DIR

ROOT = SHARED_DIR / "art-packs"
KEY = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MAX_IMAGE_BYTES = 20 * 1024 * 1024


def _entries() -> list[dict[str, Any]]:
    entries = []
    for manifest in sorted(ROOT.glob("*/manifest.json")):
        try:
            pack = json.loads(manifest.read_text())
            pack_id = pack["id"]
            if not KEY.fullmatch(pack_id) or pack_id != manifest.parent.name:
                continue
            for asset in pack.get("assets", []):
                key, filename = asset["key"], asset["filename"]
                if not KEY.fullmatch(key) or asset["kind"] not in {"backdrop", "sprite", "texture"}:
                    continue
                if not isinstance(filename, str) or Path(filename).suffix.lower() not in {".png", ".webp", ".jpg", ".jpeg"}:
                    continue
                path = (manifest.parent / filename).resolve()
                if not path.is_relative_to(manifest.parent.resolve()) or not path.is_file():
                    continue
                if not 0 < path.stat().st_size <= MAX_IMAGE_BYTES:
                    continue
                frames, fps = int(asset.get("frames", 1)), int(asset.get("fps", 8))
                if not 1 <= frames <= 4 or not 1 <= fps <= 20 or (asset["kind"] != "sprite" and frames != 1):
                    continue
                entries.append({"id": f"{pack_id}:{key}", "key": key, "kind": asset["kind"],
                                "description": str(asset["description"])[:600], "frames": frames, "fps": fps,
                                "style": str(pack.get("style", ""))[:600],
                                "perspective": str(pack.get("perspective", ""))[:120],
                                "tags": pack.get("tags", [])[:20], "path": path,
                                "provider": pack.get("provider", "imported-image")})
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return entries


def catalog() -> list[dict[str, Any]]:
    return [{k: v for k, v in entry.items() if k != "path"} for entry in _entries()]


def load(asset_id: str) -> tuple[dict[str, Any], bytes] | None:
    for entry in _entries():
        if entry["id"] == asset_id:
            try:
                return {k: v for k, v in entry.items() if k != "path"}, entry["path"].read_bytes()
            except OSError:
                return None
    return None
