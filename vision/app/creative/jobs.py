"""Creative jobs: the on-disk store, the fingerprint cache, a bounded worker queue and the art budget ledger.

Store      <data>/uploads/art/<doc_id>/<job_id>.json   the job record (served under /uploads/art, nothing secret)
           <data>/uploads/art/<doc_id>/<job_id>_crop.png  the kid's crop (strokes on white, ≤ 512 px)
           <data>/uploads/art/<doc_id>/<job_id>_<tag><k>.png|svg   outputs (a fresh tag per run: no stale caches)
Cache      <data>/creative/fingerprints.json  sha256(crop bytes + style id + provider) → job_id. The same crop for
           the same doc returns the same job; another doc gets a clone of a finished job (no new generation).
Queue      asyncio.Queue + MAX_CONCURRENT workers, started lazily on the first job (the router has no lifespan
           hook). After a reload, queued/working jobs from the last hours are picked up again.
Ledger     <data>/creative/ledger.jsonl  {at, kind: firefly|claude, usd, ref}; budget = DAL_ART_BUDGET_USD per UTC
           day. Claude calls cost what MindResult says; a Firefly image counts DAL_FIREFLY_USD_PER_IMAGE.

Job (wire): {job_id, doc_id, status: queued|working|done|failed, label, prompt, url|null, variants: [{url}],
             stroke_ids, bbox_cells, provider, error_key|null, credit, kind: object|backdrop, role_guess, chosen,
             game_id, style_id, created_at, updated_at}

Provider flow for an object: firefly → (art_prompt call) → upload crop (structure reference) + style image (style
reference) → generate → cut out (Photoshop API behind DAL_FIREFLY_REMOVE_BG, else the local white key) → PNG.
If Firefly fails for any reason but a content block or the budget, the job falls back to claude-svg.
claude-svg → one SVG call (label + svg), sanitized. Reroll makes 3 variants (one Firefly request with
numVariations 3, or 3 SVG calls with different variation notes).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import random
import re
import secrets
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.creative import backdrop as cbackdrop
from app.creative import claude_svg, cutout
from app.creative import settings as cs
from app.creative import style as cstyle
from app.creative.firefly import Firefly, FireflyError, size_for_aspect
from app.mind import art_prompt, sanitize

log = logging.getLogger("dal.v3.creative")

JOB_RE = re.compile(r"^aj_[0-9a-f]{12}$")
DOC_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")  # never "_styles" (style images live there)
STROKE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
MAX_CONCURRENT = 3
MAX_CROP_BYTES = 4 * 1024 * 1024
CROP_MAX_PX = 512
REROLL_N = 3
RESUME_WINDOW_S = 6 * 3600
SVG_CALL_USD = 0.12
PROMPT_CALL_USD = 0.02
STRUCTURE_STRENGTH = 55
STYLE_STRENGTH = 50
VARIATIONS = (
    "new, brighter colours and a happy expression",
    "a different surface texture and pattern, same colours",
    "a bolder, chunkier cartoon look with thicker outlines",
)
ACTIVE = ("queued", "working")


class CreativeError(Exception):
    def __init__(self, key: str, status: int = 400, args: dict[str, Any] | None = None) -> None:
        super().__init__(key)
        self.key = key
        self.status = status
        self.args_ = args or {}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


# ---- budget ledger -----------------------------------------------------------------------------------------------


def _ledger_path() -> Path:
    return cs.get().store_dir / "ledger.jsonl"


def ledger_add(kind: str, usd: float, *, ref: str | None = None) -> None:
    """Append one spend row; a ledger failure is logged, never raised into a job."""
    try:
        usd = round(max(0.0, float(usd or 0.0)), 5)
        if usd <= 0:
            return
        p = _ledger_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"at": _now(), "kind": kind, "usd": usd, "ref": ref}) + "\n")
    except Exception as e:  # noqa: BLE001
        log.warning("art ledger write failed: %s", e)


def spent_today() -> float:
    day = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    total = 0.0
    try:
        with _ledger_path().open(encoding="utf-8") as f:
            for line in f:
                if not line.startswith('{"at": "' + day):
                    continue
                try:
                    total += float(json.loads(line).get("usd") or 0.0)
                except (ValueError, json.JSONDecodeError):
                    continue
    except OSError:
        return 0.0
    return total


def budget_left() -> float:
    return round(max(0.0, cs.get().budget_usd - spent_today()), 4)


def can_spend(usd: float) -> bool:
    return budget_left() >= max(0.0, usd)


# ---- store -------------------------------------------------------------------------------------------------------


def doc_dir(doc_id: str) -> Path:
    if not DOC_RE.match(doc_id or ""):
        raise CreativeError("error.bad_request", 400, {"field": "doc_id"})
    return cs.get().art_dir / doc_id


def _job_path(doc_id: str, job_id: str) -> Path:
    return doc_dir(doc_id) / f"{job_id}.json"


_where: dict[str, str] = {}  # job_id → doc_id


def save(job: dict[str, Any]) -> None:
    job["updated_at"] = _now()
    _atomic_write(_job_path(job["doc_id"], job["job_id"]), json.dumps(job, separators=(",", ":")))
    _where[job["job_id"]] = job["doc_id"]


def load(job_id: str) -> dict[str, Any] | None:
    if not JOB_RE.match(job_id or ""):
        return None
    doc = _where.get(job_id)
    paths = [_job_path(doc, job_id)] if doc else []
    if not paths or not paths[0].exists():
        paths = list(cs.get().art_dir.glob(f"*/{job_id}.json"))[:1]
    for p in paths:
        try:
            job = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(job, dict) and job.get("job_id") == job_id:
            _where[job_id] = str(job.get("doc_id"))
            return job
    return None


def list_doc(doc_id: str) -> list[dict[str, Any]]:
    d = doc_dir(doc_id)
    out = []
    for p in d.glob("aj_*.json") if d.is_dir() else []:
        try:
            job = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(job, dict) and job.get("job_id"):
            _where[job["job_id"]] = doc_id
            out.append(job)
    out.sort(key=lambda j: str(j.get("created_at") or ""))
    return out


def public(job: dict[str, Any]) -> dict[str, Any]:
    return {
        "job_id": job["job_id"], "doc_id": job["doc_id"], "status": job.get("status", "queued"),
        "label": job.get("label") or "", "prompt": job.get("prompt") or "", "url": job.get("url"),
        "variants": list(job.get("variants") or []), "stroke_ids": list(job.get("stroke_ids") or []),
        "bbox_cells": job.get("bbox_cells"), "provider": job.get("provider"), "error_key": job.get("error_key"),
        "credit": job.get("credit"), "kind": job.get("kind", "object"), "role_guess": job.get("role_guess"),
        "chosen": job.get("chosen"), "game_id": job.get("game_id"), "style_id": job.get("style_id") or None,
        "screens": job.get("screens"), "created_at": job.get("created_at"), "updated_at": job.get("updated_at"),
    }


# ---- fingerprint cache -------------------------------------------------------------------------------------------


def _fp_path() -> Path:
    return cs.get().store_dir / "fingerprints.json"


def _fp_load() -> dict[str, str]:
    try:
        d = json.loads(_fp_path().read_text(encoding="utf-8"))
        return d if isinstance(d, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _fp_put(fp: str, job_id: str) -> None:
    d = _fp_load()
    d[fp] = job_id
    if len(d) > 20000:  # keep the index bounded: drop the oldest half (insertion order)
        d = dict(list(d.items())[-10000:])
    _atomic_write(_fp_path(), json.dumps(d, separators=(",", ":")))


def fingerprint(data: bytes, style_id: str, provider: str, kind: str = "object") -> str:
    h = hashlib.sha256()
    h.update(kind.encode() + b"\0")
    h.update(data)
    h.update(b"\0" + (style_id or "").encode() + b"\0" + provider.encode())
    return h.hexdigest()


# ---- queue -------------------------------------------------------------------------------------------------------

_queue: asyncio.Queue[tuple[str, str]] | None = None
_workers: list[asyncio.Task[None]] = []
_loop: asyncio.AbstractEventLoop | None = None
_inflight: set[str] = set()


def _ensure_workers() -> None:
    global _queue, _loop, _workers
    loop = asyncio.get_running_loop()
    if _queue is not None and _loop is loop and _workers and all(not w.done() for w in _workers):
        return
    _queue, _loop = asyncio.Queue(), loop
    _inflight.clear()
    _workers = [loop.create_task(_worker(i), name=f"creative worker {i}") for i in range(MAX_CONCURRENT)]
    _resume_stale()


def enqueue(job_id: str, op: str) -> None:
    _ensure_workers()
    if job_id in _inflight:
        return
    _inflight.add(job_id)
    assert _queue is not None
    _queue.put_nowait((job_id, op))


def _resume_stale() -> None:
    """Jobs left queued/working by a restart (uvicorn --reload) are picked up again; old ones are failed."""
    try:
        cutoff = time.time() - RESUME_WINDOW_S
        for p in cs.get().art_dir.glob("*/aj_*.json"):
            try:
                job = json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(job, dict) or job.get("status") not in ACTIVE:
                continue
            if p.stat().st_mtime < cutoff:
                job.update(status="failed", error_key="creative.failed")
                save(job)
                continue
            jid = str(job.get("job_id"))
            if jid not in _inflight and _queue is not None:
                _inflight.add(jid)
                _queue.put_nowait((jid, str(job.get("op") or "generate")))
    except Exception as e:  # noqa: BLE001
        log.warning("creative resume scan failed: %s", e)


async def _worker(i: int) -> None:  # noqa: ARG001
    assert _queue is not None
    q = _queue
    while True:
        job_id, op = await q.get()
        try:
            await _run(job_id, op)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - one broken job never stops the worker
            log.exception("creative job %s crashed", job_id)
            job = load(job_id)
            if job is not None and job.get("status") in ACTIVE:
                job.update(status="failed", error_key="creative.failed")
                save(job)
        finally:
            _inflight.discard(job_id)
            q.task_done()


# ---- creating jobs -----------------------------------------------------------------------------------------------


def _clean_ids(ids: Any) -> list[str]:
    return [str(x) for x in (ids or []) if isinstance(x, (str, int)) and STROKE_RE.match(str(x))][:200]


def _clean_bbox(b: Any) -> list[float] | None:
    if not isinstance(b, (list, tuple)) or len(b) != 4:
        return None
    try:
        x0, y0, x1, y1 = (float(v) for v in b)
    except (TypeError, ValueError):
        return None
    if not all(abs(v) < 1e5 for v in (x0, y0, x1, y1)):
        return None
    return [min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)]


def _aspect(job: dict[str, Any], crop: bytes | None) -> float | None:
    b = job.get("bbox_cells")
    if isinstance(b, list) and len(b) == 4 and b[2] - b[0] > 0.05 and b[3] - b[1] > 0.05:
        return max(0.2, min(5.0, (b[2] - b[0]) / (b[3] - b[1])))
    return cutout.crop_aspect(crop) if crop else None


def normalize_crop(data: bytes) -> bytes:
    """The uploaded crop as an RGB-on-white PNG, long side ≤ 512 (raises CreativeError on garbage)."""
    if not data or len(data) > MAX_CROP_BYTES:
        raise CreativeError("creative.bad_crop", 400)
    import io

    from PIL import Image, UnidentifiedImageError

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (UnidentifiedImageError, OSError, ValueError) as e:
        raise CreativeError("creative.bad_crop", 400) from e
    if img.width < 4 or img.height < 4 or img.width * img.height > 40_000_000:
        raise CreativeError("creative.bad_crop", 400)
    img = img.convert("RGBA")
    bg = Image.new("RGB", img.size, (255, 255, 255))
    bg.paste(img, mask=img.split()[-1])
    s = min(1.0, CROP_MAX_PX / max(bg.size))
    if s < 1.0:
        bg = bg.resize((max(1, round(bg.width * s)), max(1, round(bg.height * s))), Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    bg.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def _new_job(kind: str, doc_id: str, provider: str, **fields: Any) -> dict[str, Any]:
    now = _now()
    job = {"job_id": f"aj_{secrets.token_hex(6)}", "doc_id": doc_id, "kind": kind, "status": "queued",
           "label": "", "prompt": "", "url": None, "variants": [], "stroke_ids": [], "bbox_cells": None,
           "provider": provider, "error_key": None, "credit": None, "role_guess": None, "chosen": None,
           "game_id": None, "style_id": None, "op": "generate", "created_at": now, "updated_at": now}
    job.update(fields)
    return job


def _clone(prev: dict[str, Any], doc_id: str, **fields: Any) -> dict[str, Any]:
    keep = {k: prev.get(k) for k in ("label", "prompt", "negative_prompt", "url", "variants", "credit", "role_guess",
                                     "chosen", "style_id", "hint", "screens", "theme", "x_aspect", "x_prompt_source")}
    job = _new_job(str(prev.get("kind") or "object"), doc_id, str(prev.get("provider")), **keep)
    job.update(status="done", x_clone_of=prev["job_id"], crop_file=prev.get("crop_file"), **fields)
    return job


def _provider_or_raise(provider: str | None = None) -> str:
    if provider == "claude-svg":
        if not art_prompt.client.available():
            raise CreativeError("creative.off", 409)
        prov = "claude-svg"
    else:
        prov = cs.provider()
    if prov == "none":
        raise CreativeError("creative.off", 409)
    if budget_left() <= 0:
        raise CreativeError("creative.budget", 429)
    return prov


def create_object_job(crop_raw: bytes, *, doc_id: str, stroke_ids: Any, bbox_cells: Any, game_id: str | None,
                      hint: str | None, by: str | None, provider: str | None = None) -> tuple[dict[str, Any], bool]:
    """→ (job, cached). Raises CreativeError (off, budget, bad crop, bad doc id)."""
    prov = _provider_or_raise(provider)
    ddir = doc_dir(doc_id)
    crop = normalize_crop(crop_raw)
    st = cstyle.resolve(game_id)
    style_id = (st or {}).get("style_id") or ""
    fp = fingerprint(crop_raw, style_id, prov)
    ids, bbox = _clean_ids(stroke_ids), _clean_bbox(bbox_cells)
    prev_id = _fp_load().get(fp)
    prev = load(prev_id) if prev_id else None
    if prev is not None and prev.get("status") != "failed":
        if prev.get("doc_id") == doc_id:
            if (ids and ids != prev.get("stroke_ids")) or (bbox and bbox != prev.get("bbox_cells")):
                prev.update(stroke_ids=ids or prev.get("stroke_ids"), bbox_cells=bbox or prev.get("bbox_cells"))
                save(prev)
            if prev.get("status") in ACTIVE:
                enqueue(prev["job_id"], str(prev.get("op") or "generate"))  # no-op when already in flight
            return prev, True
        if prev.get("status") == "done":
            job = _clone(prev, doc_id, stroke_ids=ids, bbox_cells=bbox, game_id=game_id)
            save(job)
            return job, True
    job = _new_job("object", doc_id, prov, stroke_ids=ids, bbox_cells=bbox, game_id=game_id, style_id=style_id,
                   hint=sanitize.text(hint, 60), by=sanitize.opt_text(by, 24), fingerprint=fp)
    ddir.mkdir(parents=True, exist_ok=True)
    crop_path = ddir / f"{job['job_id']}_crop.png"
    crop_path.write_bytes(crop)
    job["crop_file"] = crop_path.name
    job["x_aspect"] = _aspect(job, crop)
    save(job)
    _fp_put(fp, job["job_id"])
    enqueue(job["job_id"], "generate")
    return job, False


def create_backdrop_job(*, doc_id: str, game_id: str | None, theme: str | None, screens: Any,
                        by: str | None, provider: str | None = None) -> tuple[dict[str, Any], bool]:
    prov = _provider_or_raise(provider)
    doc_dir(doc_id).mkdir(parents=True, exist_ok=True)
    try:
        n = max(1, min(6, int(screens or 1)))
    except (TypeError, ValueError):
        n = 1
    th = sanitize.text(theme, 200)
    st = cstyle.resolve(game_id)
    style_id = (st or {}).get("style_id") or ""
    fp = fingerprint(f"{th}\0{n}\0{game_id or ''}".encode(), style_id, prov, kind="backdrop")
    prev_id = _fp_load().get(fp)
    prev = load(prev_id) if prev_id else None
    if prev is not None and prev.get("status") != "failed":
        if prev.get("doc_id") == doc_id:
            if prev.get("status") in ACTIVE:
                enqueue(prev["job_id"], "backdrop")
            return prev, True
        if prev.get("status") == "done":
            job = _clone(prev, doc_id, game_id=game_id)
            save(job)
            return job, True
    job = _new_job("backdrop", doc_id, prov, game_id=game_id, style_id=style_id, theme=th, screens=n,
                   by=sanitize.opt_text(by, 24), op="backdrop", fingerprint=fp)
    save(job)
    _fp_put(fp, job["job_id"])
    enqueue(job["job_id"], "backdrop")
    return job, False


def reroll(job_id: str) -> dict[str, Any]:
    job = load(job_id)
    if job is None:
        raise CreativeError("error.not_found", 404, {"what": "job"})
    if job.get("status") in ACTIVE:
        raise CreativeError("creative.busy", 409)
    prov = _provider_or_raise()
    if job.get("kind") != "backdrop" and not _crop_path(job).exists():
        raise CreativeError("creative.bad_crop", 409)
    op = "backdrop" if job.get("kind") == "backdrop" else "reroll"
    job.update(status="queued", error_key=None, op=op, provider=prov)
    save(job)
    enqueue(job_id, op)
    return job


def choose(job_id: str, variant: Any) -> dict[str, Any]:
    job = load(job_id)
    if job is None:
        raise CreativeError("error.not_found", 404, {"what": "job"})
    variants = job.get("variants") or []
    try:
        n = int(variant)
    except (TypeError, ValueError) as e:
        raise CreativeError("creative.no_variant", 400) from e
    if not 0 <= n < len(variants) or not (variants[n] or {}).get("url"):
        raise CreativeError("creative.no_variant", 400)
    job.update(url=variants[n]["url"], chosen=n)
    save(job)
    return job


# ---- running jobs ------------------------------------------------------------------------------------------------


def _crop_path(job: dict[str, Any]) -> Path:
    name = str(job.get("crop_file") or f"{job['job_id']}_crop.png")
    if "/" in name or "\\" in name or name.startswith("."):
        name = f"{job['job_id']}_crop.png"
    p = doc_dir(job["doc_id"]) / name
    if not p.exists() and job.get("x_clone_of"):  # a clone keeps its source's crop
        src = load(str(job["x_clone_of"]))
        if src is not None and src.get("doc_id") != job.get("doc_id"):
            p = doc_dir(src["doc_id"]) / str(src.get("crop_file") or f"{src['job_id']}_crop.png")
    return p


async def _run(job_id: str, op: str) -> None:
    job = load(job_id)
    if job is None or job.get("status") not in ACTIVE:
        return
    job.update(status="working", error_key=None)
    save(job)
    try:
        if op == "backdrop" or job.get("kind") == "backdrop":
            await _run_backdrop(job)
        else:
            await _run_object(job, REROLL_N if op == "reroll" else 1)
        job["status"] = "done"
    except (CreativeError, FireflyError, cbackdrop.BackdropError) as e:
        log.info("creative job %s failed: %s", job_id, e)
        job.update(status="failed", error_key=e.key)
    except cutout.CutoutError as e:
        log.info("creative job %s cutout failed: %s", job_id, e)
        job.update(status="failed", error_key="creative.failed")
    job["op"] = None
    save(job)


def _credit(job: dict[str, Any], tool: str) -> dict[str, Any]:
    c: dict[str, Any] = {"by": job.get("by"), "tool": tool}
    if job.get("prompt"):
        c["prompt"] = job["prompt"]
    return c


def _store_outputs(job: dict[str, Any], urls: list[str], *, reroll: bool) -> None:
    variants = [{"url": u} for u in urls]
    if reroll:
        job["variants"] = variants
        if not job.get("url"):
            job.update(url=urls[0], chosen=0)
        else:
            job["chosen"] = None
    else:
        job.update(url=urls[0], variants=variants, chosen=0)


async def _run_object(job: dict[str, Any], n: int) -> None:
    crop_path = _crop_path(job)
    try:
        crop = crop_path.read_bytes()
    except OSError as e:
        raise CreativeError("creative.bad_crop") from e
    st = cstyle.resolve(job.get("game_id"))
    if job.get("provider") == "firefly":
        try:
            await _object_firefly(job, crop, st, n)
            return
        except FireflyError as e:
            if e.key in ("creative.blocked", "creative.budget", "creative.bad_crop") or not cs.claude_available():
                raise
            log.info("firefly failed for %s (%s); falling back to claude-svg", job["job_id"], e.key)
            job.update(provider="claude-svg", x_fallback_from="firefly", x_fallback_key=e.key)
            save(job)
    if job.get("provider") != "claude-svg":
        raise CreativeError("creative.off")
    await _object_svg(job, crop, st, n)


async def _object_firefly(job: dict[str, Any], crop: bytes, st: dict[str, Any] | None, n: int) -> None:
    s = cs.get()
    first = not job.get("prompt") or not job.get("x_prompt_source")  # an SVG job's prompt is no Firefly prompt
    if not can_spend(s.usd_per_image * n + (PROMPT_CALL_USD if first else 0.0)):
        raise CreativeError("creative.budget")
    style_text = (st or {}).get("text")
    if first:
        idea, r = await art_prompt.art_prompt(crop, hint=job.get("hint"), style_text=style_text)
        if r is not None:
            ledger_add("claude", r.cost_usd, ref=job["job_id"])
        job.update(label=idea["label"], role_guess=idea["role_guess"], prompt=idea["prompt"],
                   negative_prompt=idea["negative_prompt"], x_prompt_source=idea.get("source"))
        save(job)  # the tray shows the label while Firefly paints
    size = size_for_aspect(job.get("x_aspect") or _aspect(job, crop))
    seeds = [random.randint(1, 999_999) for _ in range(n)] if n > 1 else None
    tag = secrets.token_hex(3)
    out_dir = doc_dir(job["doc_id"])
    urls: list[str] = []
    async with Firefly(s) as ff:
        structure_id = await ff.upload(crop, long_side=1024, canvas_aspect=size[0] / size[1])
        style_up = await cstyle.firefly_upload_id(st, ff)
        outs = await ff.generate(job["prompt"], negative=job.get("negative_prompt"), size=size, n=n,
                                 structure_upload=structure_id, structure_strength=STRUCTURE_STRENGTH,
                                 style_upload=style_up, style_strength=STYLE_STRENGTH, content_class="art",
                                 seeds=seeds)
        ledger_add("firefly", s.usd_per_image * len(outs), ref=job["job_id"])
        for k, u in enumerate(outs):
            png: bytes | None = None
            if s.remove_bg_api:
                try:
                    cut = await ff.remove_background(u)
                    png = await asyncio.to_thread(cutout.trim, cut)
                except (FireflyError, cutout.CutoutError) as e:
                    log.info("remove-background fell back to the local cutout: %s", e)
            if png is None:
                data = await ff.download(u)
                png = await asyncio.to_thread(cutout.white_key, data)
            path = out_dir / f"{job['job_id']}_{tag}{k}.png"
            path.write_bytes(png)
            urls.append(cs.public_url(path))
    if not urls:
        raise CreativeError("creative.failed")
    _store_outputs(job, urls, reroll=n > 1)
    job["credit"] = _credit(job, "Adobe Firefly")


async def _object_svg(job: dict[str, Any], crop: bytes, st: dict[str, Any] | None, n: int) -> None:
    if not can_spend(SVG_CALL_USD * n):
        raise CreativeError("creative.budget")
    style_text = (st or {}).get("text")
    aspect = job.get("x_aspect") or _aspect(job, crop)
    colors = await asyncio.to_thread(cutout.ink_colors, crop)
    hint = job.get("hint") or job.get("label") or None
    variations: list[str | None] = [None] if n == 1 else list(VARIATIONS[:n])
    outcomes = await asyncio.gather(*[
        claude_svg.sprite(crop, hint=hint, style_text=style_text, aspect=aspect, colors=colors, variation=v)
        for v in variations
    ])
    for o in outcomes:
        ledger_add("claude", o.cost_usd, ref=job["job_id"])
    good = [o for o in outcomes if o.svg]
    if not good:
        raise CreativeError(outcomes[0].error_key or "creative.failed")
    tag = secrets.token_hex(3)
    out_dir = doc_dir(job["doc_id"])
    urls = []
    for k, o in enumerate(good):
        path = out_dir / f"{job['job_id']}_{tag}{k}.svg"
        path.write_text(o.svg or "", encoding="utf-8")
        urls.append(cs.public_url(path))
    if not job.get("label"):
        job["label"] = good[0].label or sanitize.text(job.get("hint"), 32) or "my drawing"
    if not job.get("prompt"):
        desc = sanitize.text(job.get("hint"), 60) or job["label"]
        job["prompt"] = sanitize.text(f"{desc}; {style_text}" if style_text else desc, 300)
    _store_outputs(job, urls, reroll=n > 1)
    job["credit"] = _credit(job, "Claude")


async def _run_backdrop(job: dict[str, Any]) -> None:
    st = cstyle.resolve(job.get("game_id"))
    res = await cbackdrop.run(job, doc_dir(job["doc_id"]), provider=str(job.get("provider")), style_info=st,
                              can_spend=can_spend, ledger_add=ledger_add)
    job.update(label=res["label"], prompt=res["prompt"], provider=res["provider"])
    job["variants"] = [{"url": res["url"]}]
    job.update(url=res["url"], chosen=0)
    job["credit"] = _credit(job, res["tool"])
