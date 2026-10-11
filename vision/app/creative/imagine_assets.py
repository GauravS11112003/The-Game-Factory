"""Dedicated art pass, cached images, and a network-free runtime for Imagine games.

Manifests live beside the private game artifact. Artwork is content-addressed in the
creative store and injected as data URLs AFTER code generation, never into model tokens.
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import io
import json
import logging
import os
import re
import tempfile
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Awaitable, Callable, Literal

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.build import drafts
from app.config import get_settings
from app.creative import asset_library, claude_svg, cutout, jobs
from app.creative import settings as cs
from app.creative.firefly import Firefly, FireflyError, WIDE
from app.mind import budget, client

client.CALLS.setdefault("imagine_art", client.CallSpec("low", 16000, 100))
budget.ESTIMATE_USD.setdefault("imagine_art", 0.25)
ART_TIMEOUT_S = 120
MAX_PACK_BYTES = 8 * 1024 * 1024
RUNTIME_ID = "draw-play-art"
RUNTIME = Path(__file__).with_name("imagine_runtime.js").read_text()
log = logging.getLogger("dal.imagine.art")
_reserved_usd = 0.0


def _reserve(usd: float) -> bool:
    # No await between checking and reserving: concurrent packs share the same daily cap.
    global _reserved_usd
    if not jobs.can_spend(usd + _reserved_usd):
        return False
    _reserved_usd += usd
    return True


def _release(usd: float) -> None:
    global _reserved_usd
    _reserved_usd = max(0.0, _reserved_usd - usd)


class AssetRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: str = Field(pattern=r"^[a-z][a-z0-9_]{0,47}$")
    kind: Literal["backdrop", "sprite", "texture"]
    description: str = Field(min_length=1, max_length=600)
    frames: int = Field(ge=1, le=4)
    fps: int = Field(ge=1, le=20)
    reuse: bool
    svg: str | None = Field(max_length=100_000)
    library_asset: str | None = Field(default=None, max_length=130)

    @model_validator(mode="after")
    def static_scenery(self) -> "AssetRequest":
        if self.kind != "sprite" and self.frames != 1:
            raise ValueError("Only sprites may have animation frames")
        return self


class ArtPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    style: str = Field(min_length=1, max_length=600)
    perspective: str = Field(min_length=1, max_length=120)
    assets: list[AssetRequest] = Field(min_length=1, max_length=5)

    @model_validator(mode="after")
    def unique_keys(self) -> "ArtPlan":
        if len({a.key for a in self.assets}) != len(self.assets):
            raise ValueError("Duplicate asset keys")
        return self


def cache_dir() -> Path:
    return cs.get().store_dir / "imagine-assets"


def pack_path(draft_id: str) -> Path:
    if not drafts.DRAFT_RE.fullmatch(draft_id):
        raise ValueError("draft_id")
    return get_settings().data_dir / "generated-games" / draft_id / "art.json"


def read_pack(draft_id: str | None) -> dict[str, Any]:
    try:
        value = json.loads(pack_path(draft_id or "").read_text())
        return value if isinstance(value, dict) else {}
    except (ValueError, OSError):
        return {}


def _atomic(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix=".art-")
    try:
        with os.fdopen(fd, "wb") as file:
            file.write(data)
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save_pack(draft_id: str, pack: dict[str, Any]) -> None:
    _atomic(pack_path(draft_id), json.dumps(pack).encode())


def _asset_bytes(asset: dict[str, Any]) -> bytes | None:
    filename = asset.get("file", "")
    if not isinstance(filename, str) or not re.fullmatch(r"[0-9a-f]{64}\.(?:svg|webp)", filename):
        return None
    try:
        data = (cache_dir() / filename).read_bytes()
        return data if 0 < len(data) <= MAX_PACK_BYTES else None
    except OSError:
        return None


def metadata(pack: dict[str, Any]) -> dict[str, Any]:
    return {"style": pack.get("style"), "perspective": pack.get("perspective"),
            "assets": [{k: a[k] for k in ("key", "kind", "description", "width", "height", "frames", "fps")}
                       for a in pack.get("assets", []) if _asset_bytes(a)]}


def strip_runtime(html: str) -> str:
    """Keep megabytes of packaged image data out of revision/next-level prompts."""
    return re.sub(r'<script id="draw-play-art">.*?</script>', "", html, flags=re.S)


def inject(html: str, pack: dict[str, Any]) -> str:
    assets: dict[str, Any] = {}
    size = 0
    for asset in pack.get("assets", []):
        data = _asset_bytes(asset)
        if not data:
            continue
        size += len(data)
        if size > MAX_PACK_BYTES:
            raise ValueError("art_pack_too_large")
        mime = "image/svg+xml" if asset["file"].endswith(".svg") else "image/webp"
        assets[asset["key"]] = {k: asset[k] for k in ("kind", "width", "height", "frames", "fps")}
        assets[asset["key"]]["src"] = "data:" + mime + ";base64," + base64.b64encode(data).decode()
    html = strip_runtime(html)
    if not assets:
        return html
    # Escape '<' even though asset keys/values are validated; no JSON can close the script.
    manifest = json.dumps(assets, separators=(",", ":")).replace("<", "\\u003c")
    script = f'<script id="{RUNTIME_ID}">window.__drawPlayAssetManifest={manifest};\n{RUNTIME}</script>'
    # Before ALL author scripts, including scripts placed before the head.
    first_script = re.search(r"<script\b", html, re.I)
    assert first_script is not None
    return html[:first_script.start()] + script + html[first_script.start():]


def instructions(pack: dict[str, Any]) -> dict[str, Any]:
    return {"type": "text", "text": "GENERATED ART PACK (already supplied by the server; do not recreate it)\n" +
            json.dumps(metadata(pack), ensure_ascii=False) + "\nUse window.drawPlayArt. Await drawPlayArt.ready before "
            "starting or marking drawPlayGame.ready. drawPlayArt.draw(ctx,key,x,y,width,height,{time,frame,flip,alpha,rotation}) "
            "draws one frame; time is milliseconds, frame is an optional explicit index, flip mirrors horizontally. "
            "Coordinates are top-left; rotation is radians about the center. Returns false if unavailable. "
            "drawPlayArt.images[key] is a loaded Image for createPattern/custom rendering; manifest[key] has dimensions "
            "and frames. Use all supplied assets prominently in actual gameplay. Use animated sprite frames for moving "
            "subjects and an explicit idle frame when stopped. Keep collision shapes independent of art. Build depth "
            "with scenery, shadows, atmospheric particles, camera movement and palette-matched foreground details. "
            "Do not paint an opaque procedural background over supplied scenery or replace sprites with basic shapes. "
            "Provide a procedural fallback if an image fails. No fetch, asset URLs or image data in your response."}


def _svg_image(asset: AssetRequest) -> tuple[bytes, int, int]:
    width, height = (1280, 720) if asset.kind == "backdrop" else (256 * asset.frames, 256)
    svg = claude_svg.sanitize_svg(asset.svg or "", view=(width, height))
    if not svg:
        raise ValueError("invalid_art_svg")
    root = ET.fromstring(svg)
    if root.get("viewBox") != f"0 0 {width} {height}":
        raise ValueError("invalid_art_dimensions")
    return svg.encode(), width, height


def prepare_image(data: bytes, asset: AssetRequest, *, sprite_px: int = 256,
                  align_feet: bool = False, backdrop_size: tuple[int, int] | None = (1280, 720)) -> tuple[bytes, int, int]:
    """Opaque scenery or aligned transparent sprite frames, encoded as compact WebP."""
    image = Image.open(io.BytesIO(data))
    image.load()
    if asset.kind == "sprite":
        if image.width % asset.frames:
            raise ValueError("Sprite sheet must have equal-width cells")
        # Key each equal cell separately, then apply ONE scale and align feet across frames.
        cells = []
        for i in range(asset.frames):
            cell = image.crop((i * image.width // asset.frames, 0, (i + 1) * image.width // asset.frames, image.height))
            buf = io.BytesIO()
            cell.save(buf, format="PNG")
            rgba = Image.open(io.BytesIO(cutout.white_key(buf.getvalue(), max_px=1024, pad=3))).convert("RGBA")
            cells.append(rgba)
        anchors = []
        for cell in cells:
            foot = cell.getchannel("A").crop((0, int(cell.height * .88), cell.width, cell.height)).getbbox()
            anchors.append((foot[0] + foot[2]) / 2 if align_feet and foot else cell.width / 2)
        margin = sprite_px / 32
        extent = max(max(anchor, cell.width - anchor) for cell, anchor in zip(cells, anchors)) * 2
        scale = min((sprite_px - margin * 2) / extent,
                    (sprite_px - margin * 2) / max(c.height for c in cells), 1)
        image = Image.new("RGBA", (sprite_px * asset.frames, sprite_px))
        for i, (cell, anchor) in enumerate(zip(cells, anchors)):
            cell = cell.resize((max(1, round(cell.width * scale)), max(1, round(cell.height * scale))), Image.Resampling.LANCZOS)
            image.paste(cell, (round(i * sprite_px + sprite_px / 2 - anchor * scale), round(sprite_px - margin) - cell.height))
    else:
        image = image.convert("RGB")
        size = backdrop_size if asset.kind == "backdrop" else (256, 256)
        if size:
            image = image.resize(size, Image.Resampling.LANCZOS)
    output = io.BytesIO()
    image.save(output, format="WEBP", quality=90, method=4)
    return output.getvalue(), image.width, image.height


def _store(asset: AssetRequest, data: bytes, width: int, height: int, provider: str) -> dict[str, Any]:
    filename = hashlib.sha256(data).hexdigest() + (".svg" if provider == "claude-svg" else ".webp")
    _atomic(cache_dir() / filename, data)
    return {**asset.model_dump(exclude={"svg", "reuse"}), "file": filename,
            "width": width, "height": height, "provider": provider}


async def build(draft_id: str, content: list[dict[str, Any]], *, source_draft: str | None,
                deadline: float, progress: Callable[[int, int], Awaitable[None]],
                provider: str | None = None, use_library: bool = True) -> dict[str, Any]:
    provider = provider or cs.provider()
    if cs.env("DAL_IMAGINE_ART", "1").lower() in {"0", "false", "off"} or provider == "none" or client.mode() != "live":
        return {}
    previous = read_pack(source_draft)
    library = asset_library.catalog() if use_library else []
    if not _reserve(0.25):
        return {**previous, "cost_usd": 0}
    try:
        result = await client.call("imagine_art", ArtPlan, [*content, {"type": "text", "text":
            f"ART PROVIDER: {provider}\nPREVIOUS ART:\n{json.dumps(metadata(previous))}\n"
            f"AVAILABLE RASTER ART LIBRARY:\n{json.dumps(library)}"}],
            draft_id=None, deadline=min(deadline, time.monotonic() + 100),
            model=os.environ.get("DAL_SONNET_MODEL") or "claude-sonnet-5-5")
        jobs.ledger_add("claude", result.cost_usd, ref=draft_id)
    finally:
        _release(0.25)
    if not result.ok or result.value is None:
        return {**previous, "cost_usd": result.cost_usd}
    plan = result.value
    pack: dict[str, Any] = {"version": 1, "style": plan.style, "perspective": plan.perspective, "assets": [],
                            "cost_usd": result.cost_usd, "provider": provider}
    old = {a["key"]: a for a in previous.get("assets", []) if _asset_bytes(a)}
    pending = []
    for asset in plan.assets:
        cached = old.get(asset.key)
        if asset.reuse and cached and cached["kind"] == asset.kind and cached["frames"] == asset.frames:
            pack["assets"].append({**cached, "fps": asset.fps})
        else:
            pending.append(asset)
    await progress(len(pack["assets"]), len(plan.assets))
    _atomic(pack_path(draft_id), json.dumps(pack).encode())

    async def save_asset(asset: AssetRequest, data: bytes, width: int, height: int, actual_provider: str) -> None:
        pack["assets"].append(_store(asset, data, width, height, actual_provider))
        _atomic(pack_path(draft_id), json.dumps(pack).encode())
        await progress(len(pack["assets"]), len(plan.assets))

    # Loading library images requires no Firefly credentials or image-generation budget.
    for asset in list(pending):
        if not use_library or not asset.library_asset:
            continue
        loaded = asset_library.load(asset.library_asset)
        if not loaded or loaded[0]["kind"] != asset.kind or loaded[0]["frames"] != asset.frames:
            continue
        entry, raw = loaded
        try:
            data, width, height = await asyncio.to_thread(prepare_image, raw, asset, sprite_px=512,
                                                         align_feet=True, backdrop_size=None)
            await save_asset(asset, data, width, height, str(entry["provider"]))
            pending.remove(asset)
        except (ValueError, OSError, cutout.CutoutError):
            log.info("unusable library asset %s", asset.library_asset)

    if provider == "claude-svg":
        for asset in pending:
            try:
                data, width, height = _svg_image(asset)
                await save_asset(asset, data, width, height, provider)
            except ValueError:
                log.info("unusable SVG asset %s for %s", asset.key, draft_id)
    elif pending:
        # Generate scenery first; use it as the common visual reference for remaining images.
        async with Firefly(cs.get()) as ff:
            style_upload = None
            semaphore = asyncio.Semaphore(2)
            async def generate_asset(asset: AssetRequest) -> None:
                async with semaphore:
                    image_cost = cs.get().usd_per_image
                    if time.monotonic() >= deadline or not _reserve(image_cost):
                        return
                    suffix = ("wide game scenery, opaque, no characters, no UI, no text" if asset.kind == "backdrop" else
                              "seamless repeating game material texture, opaque, no text" if asset.kind == "texture" else
                              f"isolated game sprite on pure white, no text, {plan.perspective}, " +
                              (f"animation sheet, exactly {asset.frames} equal cells in ONE horizontal row, same character "
                               "and scale in every cell, consistent feet baseline" if asset.frames > 1 else "one object, complete silhouette"))
                    prompt = f"{asset.description}, {suffix}, {plan.style}"[:1000]
                    try:
                        urls = await ff.generate(prompt, size=WIDE if asset.kind == "backdrop" or asset.frames > 1 else (2048, 2048),
                                                 style_upload=style_upload, style_strength=45,
                                                 deadline_s=max(1, deadline - time.monotonic()))
                        cost = cs.get().usd_per_image * len(urls)
                        jobs.ledger_add("firefly", cost, ref=draft_id)
                        pack["cost_usd"] += cost
                        raw = await ff.download(urls[0])
                        data, width, height = await asyncio.to_thread(prepare_image, raw, asset)
                        await save_asset(asset, data, width, height, provider)
                    except (FireflyError, ValueError, OSError, cutout.CutoutError) as error:
                        log.info("image asset %s unavailable: %s", asset.key, type(error).__name__)
                    finally:
                        _release(image_cost)
                        _atomic(pack_path(draft_id), json.dumps(pack).encode())
            scenery = next((a for a in pending if a.kind == "backdrop"), None)
            if scenery:
                await generate_asset(scenery)
                pending.remove(scenery)
            reference = next((a for a in pack["assets"] if a["kind"] == "backdrop"), None)
            if reference:
                try:
                    style_upload = await ff.upload(_asset_bytes(reference) or b"", long_side=1024)
                except FireflyError:
                    pass
            await asyncio.gather(*(generate_asset(a) for a in pending))
    if not pack["assets"]:
        return {**previous, "cost_usd": pack["cost_usd"]}
    if all(a.get("library_asset") for a in pack["assets"]):
        pack["provider"] = "image-library"
    elif any(a.get("library_asset") for a in pack["assets"]):
        pack["provider"] = "mixed"
    _atomic(pack_path(draft_id), json.dumps(pack).encode())
    return pack
