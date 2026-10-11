"""Art jobs (CONTRACTS_V7 §3): POST /studio/art/jobs starts one in-process asyncio task, GET polls its status.

    start(body, ip) → job id          (raises Busy when the IP already runs MAX_RUNNING_PER_IP jobs)
    status(job_id)  → ArtJobStatus dict | None

Items: one per requested object (variants, or a terrain skin when its physics shape is "line") plus the backdrop.
Items run concurrently and fill in as they finish. Object art that cannot be made is `failed` (the client keeps the
sketch); terrain and backdrop fall back to procedural art and are `done` with `error` naming why the model path
was not used. Jobs are kept in memory for an hour.
"""
from __future__ import annotations

import asyncio
import logging
import secrets
import time
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.spec.studio import ArtJobStatus, Backdrop, ObjectArt
from app.studio.art import backdrop as bdmod, brief, direction as dirmod, objects, terrain

log = logging.getLogger("dal.v7.art")

KEEP_S = 3600.0
MAX_RUNNING_PER_IP = 4
MAX_JOBS = 400


class Busy(Exception):
    pass


@dataclass
class Job:
    id: str
    ip: str
    rev: int
    items: list[dict[str, Any]]
    created: float = field(default_factory=time.monotonic)
    task: asyncio.Task[Any] | None = None
    finished: bool = False

    def running(self) -> bool:
        return not self.finished

    def to_status(self) -> dict[str, Any]:
        done = sum(1 for i in self.items if i["status"] in ("done", "failed"))
        if not self.finished:
            st = "running"
        else:
            st = "done" if any(i["status"] == "done" for i in self.items) or not self.items else "failed"
        return {"id": self.id, "status": st, "done": done, "total": len(self.items), "rev": self.rev,
                "items": [dict(i) for i in self.items]}


JOBS: dict[str, Job] = {}


def _prune() -> None:
    now = time.monotonic()
    for jid, j in list(JOBS.items()):
        if now - j.created > KEEP_S:
            if j.task is not None and not j.task.done():
                j.task.cancel()
            JOBS.pop(jid, None)
    while len(JOBS) > MAX_JOBS:
        oldest = min(JOBS.values(), key=lambda j: j.created)
        if oldest.task is not None and not oldest.task.done():
            oldest.task.cancel()
        JOBS.pop(oldest.id, None)


def running_for(ip: str) -> int:
    return sum(1 for j in JOBS.values() if j.ip == ip and j.running())


def _direction(doc: dict[str, Any]) -> dict[str, Any]:
    ad = doc.get("art_direction")
    if isinstance(ad, dict) and (ad.get("guide") or ad.get("summary")):
        return ad
    kinds = dirmod.game_kinds(doc)
    return dirmod.keyword_direction(doc, "", 1, kinds)["direction"]


def start(body: dict[str, Any], ip: str) -> str:
    """`body` is a validated ArtJobBody dict whose scene exists."""
    _prune()
    if running_for(ip) >= MAX_RUNNING_PER_IP:
        raise Busy()
    doc = body["game"]
    scene = brief.scene_of(doc, body.get("scene"))
    direction = _direction(doc)
    rev = int(direction.get("rev") or 1)
    by_id = {o.get("id"): o for o in scene.get("objects") or []}
    items: list[dict[str, Any]] = []
    plans: list[tuple[dict[str, Any], dict[str, Any] | None]] = []
    for oid in dict.fromkeys(str(x) for x in body.get("objects") or []):
        o = by_id.get(oid)
        if o is None:
            continue
        item: dict[str, Any] = {"object_id": oid, "status": "queued", "art": None, "backdrop": None, "error": None}
        if not brief.has_strokes(o):
            item.update(status="failed", error="empty")
        items.append(item)
        plans.append((item, o))
    if body.get("backdrop"):
        item = {"object_id": None, "status": "queued", "art": None, "backdrop": None, "error": None}
        items.append(item)
        plans.append((item, None))
    job = Job(id="aj_" + secrets.token_hex(8), ip=ip, rev=rev, items=items)
    JOBS[job.id] = job
    job.task = asyncio.get_running_loop().create_task(_run(job, body, doc, scene, direction, plans),
                                                      name=f"art job {job.id}")
    return job.id


def status(job_id: str) -> dict[str, Any] | None:
    _prune()
    j = JOBS.get(job_id)
    if j is None:
        return None
    return ArtJobStatus.model_validate(j.to_status()).model_dump(mode="json", by_alias=True)


async def _run(job: Job, body: dict[str, Any], doc: dict[str, Any], scene: dict[str, Any], direction: dict[str, Any],
               plans: list[tuple[dict[str, Any], dict[str, Any] | None]]) -> None:
    try:
        await asyncio.gather(*(_item(job, body, doc, scene, direction, item, o) for item, o in plans
                               if item["status"] == "queued"))
    except asyncio.CancelledError:
        for item, _ in plans:
            if item["status"] not in ("done", "failed"):
                item.update(status="failed", error="cancelled")
        raise
    finally:
        job.finished = True
        log.info("art job %s finished: %s", job.id, [(i["object_id"], i["status"]) for i in job.items])


async def _item(job: Job, body: dict[str, Any], doc: dict[str, Any], scene: dict[str, Any], direction: dict[str, Any],
                item: dict[str, Any], obj: dict[str, Any] | None) -> None:
    async def on_status(s: str) -> None:
        if item["status"] not in ("done", "failed"):
            item["status"] = s

    item["status"] = "drawing"
    try:
        if obj is None:
            bd, err, _ = await bdmod.backdrop_for(doc, scene, direction, job.rev, on_status)
            item["backdrop"] = Backdrop.model_validate(bd).model_dump(mode="json", by_alias=True)
            item.update(status="done", error=err)
            return
        old = obj.get("art") if isinstance(obj.get("art"), dict) else {}
        if brief.is_ground(obj):
            skin, err, _ = await terrain.skin_for(doc, scene, obj, direction, job.rev, on_status)
            art = {"use": old.get("use") or "sketch", "chosen": old.get("chosen"), "variants": [], "terrain": skin,
                   "asked": False}
            item["art"] = ObjectArt.model_validate(art).model_dump(mode="json", by_alias=True)
            item.update(status="done", error=err)
            return
        from app.studio.copilot import decode_png

        png = decode_png((body.get("images") or {}).get(str(obj.get("id"))))
        variants, err = await objects.draw_variants(doc, scene, obj, direction, int(body.get("variants") or 3),
                                                    job.rev, png, on_status)
        if not variants:
            item.update(status="failed", error=err or "failed")
            return
        art = {"use": old.get("use") or "sketch", "chosen": variants[0]["id"], "variants": variants,
               "terrain": None, "asked": False}
        item["art"] = ObjectArt.model_validate(art).model_dump(mode="json", by_alias=True)
        item.update(status="done", error=None)
    except asyncio.CancelledError:
        raise
    except (ValidationError, Exception) as e:  # noqa: BLE001 - one item never breaks the job
        log.warning("art item %s failed: %s: %s", item.get("object_id"), type(e).__name__, str(e)[:300])
        item.update(status="failed", error="failed")
