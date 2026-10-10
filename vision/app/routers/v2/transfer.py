"""Export and import (PLAN_V2 §8.5, §11.3e): self-contained zips that round-trip byte-identically apart from ids.

GET  /levels/{id}/export[?version=]   → zip: manifest.json, levels/<id>/v<n>.json (embedded_library filled), the
                                        thumbnail, sheet photos and the player sprite when they are on this server
GET  /games/{id}/export               → zip: manifest.json (the game, its rules and level order), every version of
                                        every level, every library type version, rules.json, the files
POST /import                          zip (body, or multipart `file`) → {ids: {old: new}, game_id, levels, types,
                                        rejected}

Import never trusts the zip:
- every level must validate as LevelV2 and its `meta.level_hash` must equal the hash of its own JSON (tampering);
- every id is new (levels `lvl_*`, the game `game_*`, library types `lt_*`), and references inside the import set
  are rewritten (parent_id, game_id, library refs, rules.player_type); a parent outside the set is kept when it exists
  here, else dropped;
- names and titles pass the blocklist; safety is "unchecked" (held or flagged levels stay unlisted);
- the bot re-checks each level (the worker's fast `analyze`); a level it cannot finish is stored unlisted.
Uploaded file URLs (thumbnail, sheets, sprite) are rewritten to their new place, which is the only other change.
"""
from __future__ import annotations

import asyncio
import copy
import io
import json
import logging
import re
import secrets
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.datastructures import UploadFile

from app import db_v2
from app.build import levels_io
from app.build.bridge import CoreError, get_pool
from app.config import get_settings
from app.mind import moderate, sanitize
from app.spec.level import level_hash
from app.spec.library import LibraryType
from app.spec.rules import GameRules

log = logging.getLogger("dal.v2.transfer")
router = APIRouter()

FORMAT = "dal-export"
FORMAT_V = 1
MAX_ZIP_BYTES = 60 * 1024 * 1024
MAX_UNPACKED_BYTES = 200 * 1024 * 1024
MAX_ENTRIES = 600
MAX_JSON_BYTES = 12 * 1024 * 1024
MAX_FILE_BYTES = 15 * 1024 * 1024
MAX_LEVELS = 120
ANALYZE_TIMEOUT_S = 12.0
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_SAFE_NAME = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _dumps(x: Any) -> bytes:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _upload_path(url: str | None) -> Path | None:
    """The local file behind an /uploads URL (None for anything else, or anything outside the uploads folder)."""
    s = get_settings()
    if not url or not isinstance(url, str):
        return None
    prefix = s.public_uploads.rstrip("/") + "/"
    if not url.startswith(prefix):
        return None
    rel = url[len(prefix):].split("?", 1)[0]
    p = (s.uploads_dir / rel).resolve()
    try:
        p.relative_to(s.uploads_dir.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def _level_files(level: dict[str, Any]) -> list[tuple[str, Path, str]]:
    """(zip path, local path, role) for the uploaded files a level references."""
    lid = level.get("id") or "level"
    out: list[tuple[str, Path, str]] = []
    thumb = get_settings().uploads_dir / "thumbs" / f"{lid}.png"
    if thumb.is_file():
        out.append((f"files/{lid}/thumbnail.png", thumb, "thumbnail"))
    for sh in (level.get("source") or {}).get("sheets") or []:
        for key in ("photo_url", "sketch_url"):
            p = _upload_path(sh.get(key))
            if p is not None:
                out.append((f"files/{lid}/{key}{int(sh.get('index', 0))}{p.suffix.lower()}", p, f"{key}:{int(sh.get('index', 0))}"))
    player = ((level.get("compiled") or {}).get("sprites") or {}).get("player") or {}
    p = _upload_path(player.get("url") if isinstance(player, dict) else None)
    if p is not None:
        out.append((f"files/{lid}/player{p.suffix.lower()}", p, "sprite"))
    return out


def _zip(manifest: dict[str, Any], entries: list[tuple[str, bytes]], files: list[tuple[str, Path, str]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", _dumps(manifest))
        for name, data in entries:
            z.writestr(name, data)
        seen: set[str] = set()
        for name, path, _ in files:
            if name in seen:
                continue
            seen.add(name)
            try:
                z.write(path, name)
            except OSError as e:
                log.info("export: %s skipped (%s)", path, e)
    return buf.getvalue()


def _zip_response(data: bytes, name: str) -> Response:
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _core_version() -> str | None:
    pool = get_pool()
    return pool.core_version if pool else None


def _export_level_doc(row: dict[str, Any]) -> dict[str, Any]:
    level = copy.deepcopy(row["level"])
    level["embedded_library"] = levels_io.embedded_library(level, row.get("game_id"))
    return level


@router.get("/levels/{level_id}/export")
def export_level(level_id: str, version: int | None = Query(default=None, ge=1)) -> Any:
    if not _ID.match(level_id):
        return err(404, "error.not_found", {"what": "level"})
    row = db_v2.get_level_row(level_id, version)
    if row is None or row.get("level") is None:
        return err(404, "error.not_found", {"what": "level"})
    if not row.get("listed", True) or row.get("safety") in ("held", "flag"):
        return err(403, "publish.safety_flag")
    level = _export_level_doc(row)
    path = f"levels/{level_id}/v{int(level.get('version') or 1)}.json"
    files = _level_files(level)
    manifest = {"format": FORMAT, "v": FORMAT_V, "kind": "level", "exported_at": db_v2.now_iso(),
                "core_version": _core_version(), "game": None,
                "levels": [{"id": level_id, "version": int(level.get("version") or 1), "path": path,
                            "listed": True, "order_index": int(level.get("order_index") or 0)}],
                "library": [], "files": [{"path": p, "for": level_id, "role": r} for p, _, r in files]}
    return _zip_response(_zip(manifest, [(path, _dumps(level))], files), f"{level_id}.dal.zip")


@router.get("/games/{game_id}/export")
def export_game(game_id: str) -> Any:
    if not _ID.match(game_id):
        return err(404, "error.not_found", {"what": "game"})
    g = db_v2.get_game(game_id)
    if g is None or g.get("format") != 2:
        return err(404, "error.not_found", {"what": "game"})
    entries: list[tuple[str, bytes]] = []
    files: list[tuple[str, Path, str]] = []
    mlevels: list[dict[str, Any]] = []
    for s in db_v2.latest_level_summaries(game_id=game_id, listed_only=True):
        for row in db_v2.level_rows_all_versions(s["id"]):
            if row.get("level") is None or row.get("safety") in ("held", "flag"):
                continue
            level = _export_level_doc(row)
            v = int(level.get("version") or 1)
            path = f"levels/{row['id']}/v{v}.json"
            entries.append((path, _dumps(level)))
            mlevels.append({"id": row["id"], "version": v, "path": path, "listed": bool(row.get("listed", True)),
                            "order_index": int(row.get("order_index") or 0), "parent_id": row.get("parent_id")})
        latest = db_v2.get_level_row(s["id"])
        if latest is not None and latest.get("level") is not None:
            files += _level_files(latest["level"])
    mlib: list[dict[str, Any]] = []
    for t in db_v2.library_all_versions(game_id):
        path = f"library/{t['id']}/v{int(t['version'])}.json"
        entries.append((path, _dumps(t)))
        mlib.append({"id": t["id"], "version": int(t["version"]), "path": path})
    rules = g.get("rules") or GameRules(version=1).model_dump(mode="json")
    entries.append(("rules.json", _dumps(rules)))
    manifest = {"format": FORMAT, "v": FORMAT_V, "kind": "game", "exported_at": db_v2.now_iso(),
                "core_version": _core_version(),
                "game": {"id": g["id"], "title": g["title"], "author": g["author"], "created_at": g["created_at"],
                         "rules": rules},
                "levels": mlevels, "library": mlib,
                "files": [{"path": p, "for": p.split("/")[1], "role": r} for p, _, r in files]}
    return _zip_response(_zip(manifest, entries, files), f"{game_id}.dal.zip")


# ---- import -----------------------------------------------------------------------------------------------------


class ImportError_(Exception):
    def __init__(self, key: str, args: dict[str, Any] | None = None) -> None:
        super().__init__(key)
        self.key = key
        self.args = args or {}


def _read_zip(data: bytes) -> tuple[zipfile.ZipFile, dict[str, Any]]:
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ImportError_("error.upload_failed") from None
    infos = z.infolist()
    if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_UNPACKED_BYTES:
        raise ImportError_("error.bad_request", {"field": "zip"})
    try:
        manifest = json.loads(z.read("manifest.json"))
    except (KeyError, json.JSONDecodeError):
        raise ImportError_("error.bad_request", {"field": "manifest"}) from None
    if not isinstance(manifest, dict) or manifest.get("format") != FORMAT or int(manifest.get("v") or 0) != FORMAT_V:
        raise ImportError_("error.bad_request", {"field": "manifest"})
    return z, manifest


def _read_json(z: zipfile.ZipFile, name: str) -> Any:
    try:
        info = z.getinfo(name)
    except KeyError:
        raise ImportError_("error.bad_request", {"field": name}) from None
    if info.file_size > MAX_JSON_BYTES:
        raise ImportError_("error.bad_request", {"field": name})
    try:
        return json.loads(z.read(info))
    except json.JSONDecodeError:
        raise ImportError_("error.bad_request", {"field": name}) from None


def _remap_lib_refs(x: Any, type_ids: dict[str, str]) -> None:
    """Rewrite every {type_id, version} library reference (strokes, objects) in place."""
    if isinstance(x, dict):
        for k, v in list(x.items()):
            if k == "lib" and isinstance(v, dict) and v.get("type_id") in type_ids:
                v["type_id"] = type_ids[v["type_id"]]
            else:
                _remap_lib_refs(v, type_ids)
    elif isinstance(x, list):
        for v in x:
            _remap_lib_refs(v, type_ids)


async def _verify(levels: list[dict[str, Any]]) -> list[bool | None]:
    pool = get_pool()
    if pool is None:
        raise CoreError("down", "no pool")
    sem = asyncio.Semaphore(2)

    async def one(level: dict[str, Any]) -> bool | None:
        async with sem:
            try:
                res = await pool.call("analyze", {"level": level, "mode": "fast"}, ANALYZE_TIMEOUT_S)
            except CoreError as e:
                if e.code == "down":
                    raise
                return None
        rep = (res or {}).get("report") if isinstance(res, dict) else None
        return bool(rep and rep.get("solvable"))

    return list(await asyncio.gather(*(one(lv) for lv in levels)))


def _copy_file(z: zipfile.ZipFile, name: str, dest: Path) -> bool:
    try:
        info = z.getinfo(name)
    except KeyError:
        return False
    if info.file_size > MAX_FILE_BYTES:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(z.read(info))
    return True


async def import_zip(data: bytes) -> dict[str, Any]:
    z, manifest = _read_zip(data)
    kind = manifest.get("kind")
    if kind not in ("level", "game"):
        raise ImportError_("error.bad_request", {"field": "kind"})
    mlevels = [m for m in manifest.get("levels") or [] if isinstance(m, dict)][:MAX_LEVELS]
    if not mlevels:
        raise ImportError_("error.bad_request", {"field": "levels"})

    ids: dict[str, str] = {}
    type_ids: dict[str, str] = {}
    new_game: str | None = None
    rejected: list[dict[str, Any]] = []

    # ---- library types (game exports) ----
    types_in: list[dict[str, Any]] = []
    if kind == "game":
        for m in manifest.get("library") or []:
            t = _read_json(z, str(m.get("path")))
            try:
                LibraryType.model_validate(t)
            except Exception:  # noqa: BLE001
                rejected.append({"what": "library", "id": t.get("id") if isinstance(t, dict) else None, "why": "invalid"})
                continue
            if moderate.blocklist_hit([t.get("name"), t.get("author")]):
                rejected.append({"what": "library", "id": t.get("id"), "why": "safety"})
                continue
            types_in.append(t)
        for t in types_in:
            type_ids.setdefault(str(t["id"]), f"lt_{secrets.token_hex(4)}")

    # ---- levels: read, check, assign ids ----
    docs: list[tuple[dict[str, Any], dict[str, Any]]] = []
    for m in mlevels:
        doc = _read_json(z, str(m.get("path")))
        if not isinstance(doc, dict) or not _ID.match(str(doc.get("id") or "")):
            rejected.append({"what": "level", "id": m.get("id"), "why": "invalid"})
            continue
        errors = levels_io.validate(doc)
        if errors:
            rejected.append({"what": "level", "id": doc.get("id"), "why": "invalid", "errors": errors[:2]})
            continue
        if level_hash(doc) != (doc.get("meta") or {}).get("level_hash"):
            rejected.append({"what": "level", "id": doc.get("id"), "why": "level_hash"})
            continue
        if moderate.blocklist_hit([doc.get("title"), doc.get("author"), (doc.get("meta") or {}).get("transcript")]):
            rejected.append({"what": "level", "id": doc.get("id"), "why": "safety"})
            continue
        ids.setdefault(str(doc["id"]), f"lvl_{secrets.token_hex(4)}")
        docs.append((m, doc))
    if not docs:
        raise ImportError_("error.bad_request", {"field": "levels", "rejected": len(rejected)})

    if kind == "game":
        g = manifest.get("game") or {}
        title = sanitize.text(g.get("title"), 40) or "Imported game"
        author = sanitize.text(g.get("author"), 16) or "someone"
        if moderate.blocklist_hit([title, author]):
            raise ImportError_("publish.safety_flag")
        rules_doc = g.get("rules")
        try:
            rules_doc = _read_json(z, "rules.json")
        except ImportError_:
            pass
        try:
            rules = GameRules.model_validate(rules_doc or {"version": 1}).model_dump(mode="json")
        except Exception:  # noqa: BLE001
            rules = GameRules(version=1).model_dump(mode="json")
        if rules.get("player_type") in type_ids:
            rules["player_type"] = type_ids[rules["player_type"]]
        new_game = f"game_{secrets.token_hex(4)}"
        db_v2.create_game(new_game, title, author, rules)
        for t in sorted(types_in, key=lambda t: (str(t["id"]), int(t.get("version") or 1))):
            nt = copy.deepcopy(t)
            nt["id"] = type_ids[str(t["id"])]
            nt["game_id"] = new_game
            db_v2.insert_type(nt)  # versions are re-numbered 1..n in order, as they were

    # ---- rewrite and store (parents before children, versions in order) ----
    prepared: list[dict[str, Any]] = []
    for m, doc in docs:
        nd = copy.deepcopy(doc)
        old = str(doc["id"])
        nd["id"] = ids[old]
        nd["game_id"] = new_game
        pid = doc.get("parent_id")
        if pid in ids:
            nd["parent_id"] = ids[pid]
        elif pid and db_v2.get_level_row(str(pid)) is not None:
            nd["parent_id"] = pid
        else:
            nd["parent_id"] = None
        if type_ids:
            _remap_lib_refs(nd.get("ink"), type_ids)
            _remap_lib_refs(nd.get("objects"), type_ids)
            for t in nd.get("embedded_library") or []:
                if t.get("id") in type_ids:
                    t["id"] = type_ids[t["id"]]
                    t["game_id"] = new_game
            if (nd.get("rules") or {}).get("player_type") in type_ids:
                nd["rules"]["player_type"] = type_ids[nd["rules"]["player_type"]]
        old_safety = (doc.get("meta") or {}).get("safety")
        safety = old_safety if old_safety in ("held", "flag") else "unchecked"
        nd.setdefault("meta", {})["safety"] = safety
        prepared.append({"m": m, "old": old, "doc": nd, "safety": safety})

    try:
        solvable = await _verify([p["doc"] for p in prepared])
    except CoreError:
        raise ImportError_("error.worker_down") from None

    s = get_settings()
    order = sorted(range(len(prepared)), key=lambda i: (prepared[i]["doc"].get("parent_id") in ids.values(),
                                                         prepared[i]["old"], int(prepared[i]["doc"].get("version") or 1)))
    stored_ids: list[str] = []
    seen_versions: dict[str, set[int]] = {}
    for i in order:
        p = prepared[i]
        nd = p["doc"]
        v = int(nd.get("version") or 1)
        if v in seen_versions.setdefault(nd["id"], set()):
            continue
        seen_versions[nd["id"]].add(v)
        # uploaded files: copy and point the level at their new place
        for f in manifest.get("files") or []:
            if not isinstance(f, dict) or f.get("for") != p["old"]:
                continue
            name = str(f.get("path") or "")
            base = name.rsplit("/", 1)[-1]
            if not _SAFE_NAME.match(base):
                continue
            role = str(f.get("role") or "")
            if role == "thumbnail":
                _copy_file(z, name, s.uploads_dir / "thumbs" / f"{nd['id']}.png")
                continue
            dest = s.uploads_dir / "imports" / nd["id"] / base
            if not _copy_file(z, name, dest):
                continue
            url = f"{s.public_uploads}/imports/{nd['id']}/{base}"
            if role.startswith(("photo_url:", "sketch_url:")):
                key, _, idx = role.partition(":")
                for sh in (nd.get("source") or {}).get("sheets") or []:
                    if str(sh.get("index", 0)) == idx:
                        sh[key] = url
            elif role == "sprite":
                pl = ((nd.get("compiled") or {}).get("sprites") or {}).get("player")
                if isinstance(pl, dict):
                    pl["url"] = url
        ok = solvable[i]
        listed = bool(p["m"].get("listed", True)) and p["safety"] not in ("held", "flag") and ok is not False
        report = {"solvable": bool(ok)} if ok is not None else None
        levels_io.store(nd, report=report, listed=listed, safety=p["safety"])
        if nd["id"] not in stored_ids:
            stored_ids.append(nd["id"])
    return {"ids": {**ids, **type_ids}, "game_id": new_game, "levels": stored_ids,
            "types": sorted(set(type_ids.values())), "rejected": rejected}


@router.post("/import")
async def post_import(request: Request) -> Any:
    ctype = request.headers.get("content-type", "")
    data: bytes | None = None
    if ctype.startswith("multipart/"):
        form = await request.form()
        for key in ("file", "zip", "export"):
            v = form.get(key)
            if isinstance(v, UploadFile):
                data = await v.read(MAX_ZIP_BYTES + 1)
                break
    else:
        data = await request.body()
    if not data:
        return err(400, "error.upload_failed")
    if len(data) > MAX_ZIP_BYTES:
        return err(413, "error.bad_request", {"field": "zip"})
    try:
        return JSONResponse(await import_zip(data), status_code=201)
    except ImportError_ as e:
        status = 503 if e.key == "error.worker_down" else 409 if e.key == "publish.safety_flag" else 400
        return err(status, e.key, e.args)
