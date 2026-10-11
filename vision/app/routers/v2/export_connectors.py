"""Connectors (docs/v4/CONTRACTS_V4.md §6): a game's levels in Tiled and Minecraft.

GET  /games/{id}/export/tiled              → `<slug>-tiled.zip`: one Tiled map (.tmj) per listed level + tileset.png
GET  /games/{id}/export/minecraft          → `<slug>-minecraft.zip`: a datapack, one .mcfunction per listed level
                                             (header X-Drawplay-Untranslated: the export4.mc.* keys, comma separated)
POST /games/{id}/export/minecraft/live     MinecraftBody → MinecraftResult
    Builds one level (level_id, or the game's first) in a running server over RCON. With `origin` the course is
    built at those block coordinates; without, at the nearest online player: a marker entity is summoned at them
    first and every command runs `execute at` that marker, so the course stays in one piece if they walk away.
    RCON outcomes answer 200 with ok false and a message key (export4.mc_unreachable, export4.mc_auth,
    export4.mc_no_player, export4.mc_failed); ok true with export4.mc_built, or export4.mc_partly when the server
    rejected some commands (an unloaded area, an older Minecraft).

The RCON password is used for the login packet only: never logged, echoed in an error, or stored. RCON reaches this
computer and the local network only (400 export4.mc_host_blocked otherwise) unless DAL_MC_HOSTS lists the host. A game
without exportable levels answers 409 export.no_levels.
"""
from __future__ import annotations

import asyncio
import ipaddress
import logging
import os
import secrets
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app import db_v2
from app.connectors import minecraft, rcon, tiled
from app.connectors.common import game_levels
from app.spec.api import MinecraftBody, MinecraftResult

log = logging.getLogger("dal.v4.connectors")
router = APIRouter()

LIVE_TIMEOUT_S = 180.0
SOCKET_TIMEOUT_S = 5.0
MARKER = "minecraft:marker"
MARKER_TAG = "drawplay_origin"
RCON_KEYS = {"unreachable": "export4.mc_unreachable", "auth": "export4.mc_auth", "no_player": "export4.mc_no_player",
             "failed": "export4.mc_failed"}


def err(status: int, key: str, args: dict[str, Any] | None = None) -> JSONResponse:
    return JSONResponse({"message_key": key, "args": args or {}}, status_code=status)


def _game(game_id: str) -> dict[str, Any] | None:
    g = db_v2.get_game(game_id)
    return g if g is not None and g.get("format") == 2 else None


def _zip(data: bytes, filename: str, extra: dict[str, str] | None = None) -> Response:
    headers = {"Content-Disposition": f'attachment; filename="{filename}"', "Cache-Control": "no-store", **(extra or {})}
    return Response(content=data, media_type="application/zip", headers=headers)


@router.get("/games/{game_id}/export/tiled")
async def export_tiled(game_id: str) -> Any:
    g = await asyncio.to_thread(_game, game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    res = await asyncio.to_thread(tiled.export_game, g)
    if res is None:
        return err(409, "export.no_levels")
    return _zip(*res)


@router.get("/games/{game_id}/export/minecraft")
async def export_minecraft(game_id: str) -> Any:
    g = await asyncio.to_thread(_game, game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    res = await asyncio.to_thread(minecraft.export_game, g)
    if res is None:
        return err(409, "export.no_levels")
    data, filename, missing = res
    return _zip(data, filename, {"X-Drawplay-Untranslated": ",".join(missing)})


def host_allowed(host: str) -> bool:
    """RCON only reaches this computer or the local network (loopback, private and link-local addresses, `localhost`)
    unless the host is listed in DAL_MC_HOSTS (comma separated), so the server never opens connections to arbitrary
    internet hosts on a request's behalf."""
    h = (host or "").strip().lower()
    extra = {x.strip().lower() for x in os.environ.get("DAL_MC_HOSTS", "").split(",") if x.strip()}
    if h in extra or h == "localhost":
        return True
    try:
        ip = ipaddress.ip_address(h.strip("[]"))
    except ValueError:
        return False
    return ip.is_loopback or ip.is_private or ip.is_link_local


def live_commands(level: dict[str, Any], origin: tuple[int, int, int] | None) -> tuple[list[str], list[str], int | None]:
    """(commands, untranslated keys, index of the command that must work) for the live build."""
    if origin is not None:
        cmds, missing = minecraft.level_commands(level, minecraft.absolute(origin))
        return cmds, missing, None
    cmds, missing = minecraft.level_commands(level, minecraft.rel)
    tag = f"{MARKER_TAG}_{secrets.token_hex(3)}"  # one marker per build: a stale one from a broken build never matches
    at = f"execute at @e[type={MARKER},tag={tag},limit=1] run "
    out = [f"execute at @p run summon {MARKER} ~ ~ ~ {{Tags:[\"{tag}\"]}}"]
    out += [at + c for c in cmds]
    out.append(f"kill @e[type={MARKER},tag={tag}]")
    return out, missing, 0


@router.post("/games/{game_id}/export/minecraft/live")
async def minecraft_live(game_id: str, request: Request) -> Any:
    g = _game(game_id)
    if g is None:
        return err(404, "error.not_found", {"what": "game"})
    try:
        raw = await request.json()
    except Exception:  # noqa: BLE001
        return err(400, "error.bad_request", {"field": "minecraft"})
    try:
        body = MinecraftBody.model_validate(raw)
    except ValidationError as e:  # never echo the input: it holds the password
        return err(400, "error.bad_request", {"field": "minecraft", "errors": min(e.error_count(), 99)})
    if not host_allowed(body.host):
        return err(400, "export4.mc_host_blocked")
    if body.level_id:
        row = db_v2.get_level_row(body.level_id)
        if row is None or row.get("game_id") != game_id or not isinstance(row.get("level"), dict):
            return err(404, "error.not_found", {"what": "level"})
        level = row["level"]
    else:
        entries = await asyncio.to_thread(game_levels, game_id)
        if not entries:
            return err(409, "export.no_levels")
        level = entries[0]["level"]
    origin = tuple(int(v) for v in body.origin) if body.origin is not None else None
    cmds, missing, must = live_commands(level, origin)  # type: ignore[arg-type]
    try:
        res = await asyncio.wait_for(asyncio.to_thread(
            rcon.send_all, body.host, body.port, body.password, cmds, timeout_s=SOCKET_TIMEOUT_S, must_work=must),
            LIVE_TIMEOUT_S)
    except rcon.RconError as e:
        log.info("minecraft live %s: %s", game_id, e.code)
        return MinecraftResult(ok=False, commands=0, message_key=RCON_KEYS.get(e.code, "export4.mc_failed"),
                               untranslated=missing).model_dump(mode="json")
    except asyncio.TimeoutError:
        log.info("minecraft live %s: timeout", game_id)
        return MinecraftResult(ok=False, commands=0, message_key="export4.mc_failed",
                               untranslated=missing).model_dump(mode="json")
    if res.failed:
        log.info("minecraft live %s: %d of %d commands rejected", game_id, res.failed, res.sent)
    return MinecraftResult(ok=True, commands=res.sent, message_key="export4.mc_partly" if res.failed else "export4.mc_built",
                           untranslated=missing).model_dump(mode="json")
