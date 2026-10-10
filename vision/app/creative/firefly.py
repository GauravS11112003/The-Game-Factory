"""Adobe Firefly Services client (async httpx). Implemented against the official docs (read 2026-10-10):

    Auth (IMS client credentials)  https://developer.adobe.com/firefly-services/docs/firefly-api/guides/
    Generate Image v3 (sync)       https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/firefly-generate-image-api-tutorial
    Async APIs + status polling    https://developer.adobe.com/firefly-services/docs/firefly-api/guides/how-tos/using-async-apis
    Structure image reference      https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/structure-image-reference/
    Style image reference          https://developer.adobe.com/firefly-services/docs/firefly-api/guides/concepts/style-image-reference/
    API reference (sizes, x-model-version)  https://developer.adobe.com/firefly-services/docs/firefly-api/api/
    Remove Background v2 (Photoshop / Firefly Services)
                                   https://developer.adobe.com/firefly-services/docs/photoshop/guides/remove-background/

Every call carries `x-api-key: <client id>` and `Authorization: Bearer <IMS token>` (app.creative.ims).

    upload    POST https://firefly-api.adobe.io/v2/storage/image   Content-Type: image/webp, binary body
              → {"images": [{"id": "<uploadId>"}]}
    generate  POST https://firefly-api.adobe.io/v3/images/generate-async   (default)
              {prompt, negativePrompt?, contentClass: "art", numVariations, size: {width, height}, seeds?,
               structure: {strength 1-100, imageReference: {source: {uploadId}}},
               style: {strength 1-100, imageReference: {source: {uploadId}}}}
              → {jobId, statusUrl, cancelUrl}; GET statusUrl (= /v3/status/{jobId}) until "succeeded" | "failed";
              succeeded → result.outputs[].image.url (pre-signed, fetched without auth headers)
              POST https://firefly-api.adobe.io/v3/images/generate (DAL_FIREFLY_SYNC=1) → outputs[].image.url
    remove-bg POST https://image.adobe.io/v2/remove-background  {image: {source: {url}}, mode: "cutout",
              output: {mediaType: "image/png"}} → {jobId, statusUrl}; poll statusUrl. The input must be a signed
              GET URL on an allowed domain (we pass Firefly's own pre-signed output URL). The docs do not show the
              succeeded body, so the first https URL in `result` is taken. Behind DAL_FIREFLY_REMOVE_BG=1; the
              default (and every failure) is the local OpenCV white-key cutout (app.creative.cutout).

Sizes: 2048×2048, 2304×1792, 1792×2304 and 2688×1536 are valid for both image3 and image4 models.
Errors raise FireflyError(key) with a `creative.*` message key; nothing here logs a token or a secret.
"""
from __future__ import annotations

import asyncio
import io
import logging
import random
import time
from typing import Any

from app.creative import ims
from app.creative.ims import httpx
from app.creative.settings import CreativeSettings

log = logging.getLogger("dal.v3.firefly")

FIREFLY_API = "https://firefly-api.adobe.io"
UPLOAD_URL = FIREFLY_API + "/v2/storage/image"
GENERATE_ASYNC_URL = FIREFLY_API + "/v3/images/generate-async"
GENERATE_SYNC_URL = FIREFLY_API + "/v3/images/generate"
STATUS_URL = FIREFLY_API + "/v3/status/{job_id}"
PS_REMOVE_BG_URL = "https://image.adobe.io/v2/remove-background"
PS_STATUS_URL = "https://image.adobe.io/v2/status/{job_id}"

SIZES: list[tuple[int, int]] = [(2048, 2048), (2304, 1792), (1792, 2304), (2688, 1536)]
WIDE = (2688, 1536)
MAX_PROMPT_CHARS = 1000
MAX_DOWNLOAD_BYTES = 40 * 1024 * 1024
POLL_S = 1.5
SPRITE_SUFFIX = "single object on a plain white background, 2D game sprite, side view"
BLOCK_WORDS = ("policy", "prohibited", "blocked", "nsfw", "inappropriate", "trademark", "guideline", "content_")


class FireflyError(Exception):
    def __init__(self, key: str, status: int | None = None, detail: str = "") -> None:
        super().__init__(f"{key} ({status}) {detail}"[:300])
        self.key = key
        self.status = status


def size_for_aspect(aspect: float | None) -> tuple[int, int]:
    """The supported output size closest to w/h."""
    if not aspect or aspect <= 0:
        return SIZES[0]
    return min(SIZES, key=lambda s: abs((s[0] / s[1]) / aspect - 1))


def to_webp(data: bytes, *, long_side: int | None = None, canvas_aspect: float | None = None) -> bytes:
    """Any image → lossless WebP (the docs' upload type). Optionally padded on white to `canvas_aspect` (a
    structure reference should have the output's aspect) and scaled so its long side is `long_side`."""
    from PIL import Image

    img = Image.open(io.BytesIO(data))
    img.load()
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[-1])
        img = bg
    else:
        img = img.convert("RGB")
    if canvas_aspect:
        w, h = img.size
        if w / h < canvas_aspect:
            cw, ch = round(h * canvas_aspect), h
        else:
            cw, ch = w, round(w / canvas_aspect)
        canvas = Image.new("RGB", (max(cw, 1), max(ch, 1)), (255, 255, 255))
        canvas.paste(img, ((canvas.width - w) // 2, (canvas.height - h) // 2))
        img = canvas
    if long_side:
        scale = long_side / max(img.size)
        if abs(scale - 1) > 0.01:
            img = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))),
                             Image.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="WEBP", lossless=True)
    return buf.getvalue()


def _first_url(obj: Any) -> str | None:
    """The first https URL in a status `result` (image.url, destination.url, url, href...)."""
    if isinstance(obj, str):
        return obj if obj.startswith("https://") and "/status/" not in obj and "/cancel/" not in obj else None
    if isinstance(obj, dict):
        for k in ("image", "destination", "output", "outputs", "url", "href"):
            if k in obj:
                u = _first_url(obj[k])
                if u:
                    return u
        for v in obj.values():
            u = _first_url(v)
            if u:
                return u
    if isinstance(obj, list):
        for v in obj:
            u = _first_url(v)
            if u:
                return u
    return None


def _error_key(status: int, text: str) -> str:
    t = (text or "").lower()
    if status == 451 or (status in (400, 403, 422) and any(w in t for w in BLOCK_WORDS)):
        return "creative.blocked"
    if status in (401, 403):
        return "creative.firefly_auth"
    if status == 429:
        return "creative.firefly_busy"
    return "creative.firefly_failed"


class Firefly:
    """One instance per job step: `async with Firefly(settings) as ff: ...`."""

    def __init__(self, s: CreativeSettings) -> None:
        if not s.has_firefly:
            raise FireflyError("creative.firefly_auth", None, "no credentials")
        self.s = s
        self.http: Any = None

    async def __aenter__(self) -> "Firefly":
        self.http = httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=15.0))
        return self

    async def __aexit__(self, *exc: Any) -> None:
        if self.http is not None:
            await self.http.aclose()
            self.http = None

    async def _token(self, force: bool = False) -> str:
        try:
            return await ims.CACHE.get(self.s.firefly_client_id, self.s.firefly_client_secret, force=force)
        except ims.TokenError as e:
            raise FireflyError(e.key, e.status, "ims") from e

    async def _headers(self, content_type: str | None = "application/json", *, force: bool = False,
                       model: bool = False) -> dict[str, str]:
        h = {"x-api-key": self.s.firefly_client_id, "Authorization": f"Bearer {await self._token(force)}",
             "Accept": "application/json"}
        if content_type:
            h["Content-Type"] = content_type
        if model and self.s.firefly_model:
            h["x-model-version"] = self.s.firefly_model
        return h

    async def _send(self, method: str, url: str, *, json: Any = None, content: bytes | None = None,
                    content_type: str | None = "application/json", timeout: float = 60.0,
                    model: bool = False) -> Any:
        """One authenticated request; a 401 refreshes the token once, a 429/5xx waits and retries once."""
        assert self.http is not None
        force, refreshed = False, False
        for attempt in (1, 2, 3):
            headers = await self._headers(content_type, force=force, model=model)
            force = False  # a forced refresh happens once, not on every later retry
            try:
                r = await self.http.request(method, url, json=json, content=content, headers=headers, timeout=timeout)
            except httpx.TimeoutException as e:
                raise FireflyError("creative.timeout", None, f"{method} {url}") from e
            except httpx.HTTPError as e:
                if attempt < 3:
                    await asyncio.sleep(1.0)
                    continue
                raise FireflyError("creative.firefly_unreachable", None, type(e).__name__) from e
            if r.status_code == 401 and not refreshed:
                ims.CACHE.invalidate()
                force = refreshed = True
                continue
            if (r.status_code == 429 or r.status_code >= 500) and attempt < 3:
                try:
                    wait = float(r.headers.get("retry-after") or 2.0)
                except ValueError:
                    wait = 2.0
                await asyncio.sleep(min(max(wait, 1.0), 8.0))
                continue
            if r.status_code >= 400:
                text = r.text[:500] if hasattr(r, "text") else ""
                raise FireflyError(_error_key(r.status_code, text), r.status_code, text[:200])
            try:
                return r.json()
            except ValueError as e:
                raise FireflyError("creative.firefly_failed", r.status_code, "not json") from e
        raise FireflyError("creative.firefly_failed", None, "retries exhausted")

    # ---- storage --------------------------------------------------------------------------------------------

    async def upload(self, image: bytes, *, long_side: int | None = None,
                     canvas_aspect: float | None = None) -> str:
        """Upload an image to Firefly storage (as WebP); returns the uploadId used by structure/style references."""
        try:
            webp = await asyncio.to_thread(to_webp, image, long_side=long_side, canvas_aspect=canvas_aspect)
        except Exception as e:  # noqa: BLE001 - a broken crop is the caller's error, not Firefly's
            raise FireflyError("creative.bad_crop", None, f"{type(e).__name__}") from e
        body = await self._send("POST", UPLOAD_URL, content=webp, content_type="image/webp", timeout=60.0)
        imgs = body.get("images") if isinstance(body, dict) else None
        uid = None
        if isinstance(imgs, list) and imgs and isinstance(imgs[0], dict):
            uid = imgs[0].get("id")
        uid = uid or (body.get("id") or body.get("uploadId") if isinstance(body, dict) else None)
        if not isinstance(uid, str) or not uid:
            raise FireflyError("creative.firefly_failed", None, "upload: no id")
        return uid

    # ---- generate -------------------------------------------------------------------------------------------

    def _generate_body(self, prompt: str, *, negative: str | None, size: tuple[int, int], n: int,
                       structure_upload: str | None, structure_strength: int, style_upload: str | None,
                       style_strength: int, content_class: str, seeds: list[int] | None) -> dict[str, Any]:
        body: dict[str, Any] = {
            "prompt": prompt[:MAX_PROMPT_CHARS],
            "contentClass": content_class,
            "numVariations": max(1, min(4, n)),
            "size": {"width": size[0], "height": size[1]},
        }
        if negative:
            body["negativePrompt"] = negative[:MAX_PROMPT_CHARS]
        if seeds:
            body["seeds"] = seeds[: body["numVariations"]]
        if structure_upload:
            body["structure"] = {"strength": max(1, min(100, structure_strength)),
                                 "imageReference": {"source": {"uploadId": structure_upload}}}
        if style_upload:
            body["style"] = {"strength": max(1, min(100, style_strength)),
                             "imageReference": {"source": {"uploadId": style_upload}}}
        return body

    async def generate(self, prompt: str, *, negative: str | None = None, size: tuple[int, int] = SIZES[0],
                       n: int = 1, structure_upload: str | None = None, structure_strength: int = 60,
                       style_upload: str | None = None, style_strength: int = 50, content_class: str = "art",
                       seeds: list[int] | None = None, deadline_s: float = 150.0) -> list[str]:
        """Generate n images; returns their pre-signed URLs. A request rejected only because of negativePrompt
        (not every model accepts it) is retried once without it."""
        body = self._generate_body(prompt, negative=negative, size=size, n=n, structure_upload=structure_upload,
                                   structure_strength=structure_strength, style_upload=style_upload,
                                   style_strength=style_strength, content_class=content_class, seeds=seeds)
        try:
            return await self._generate(body, deadline_s)
        except FireflyError as e:
            if "negativePrompt" in body and e.key == "creative.firefly_failed" and e.status in (400, 422):
                body.pop("negativePrompt", None)
                return await self._generate(body, deadline_s)
            raise

    async def _generate(self, body: dict[str, Any], deadline_s: float) -> list[str]:
        deadline = time.monotonic() + deadline_s
        if self.s.firefly_sync:
            res = await self._send("POST", GENERATE_SYNC_URL, json=body, timeout=min(deadline_s, 120.0), model=True)
            urls = self._output_urls(res)
        else:
            job = await self._send("POST", GENERATE_ASYNC_URL, json=body, timeout=30.0, model=True)
            status_url = job.get("statusUrl") if isinstance(job, dict) else None
            job_id = job.get("jobId") if isinstance(job, dict) else None
            if not status_url and job_id:
                status_url = STATUS_URL.format(job_id=job_id)
            if not isinstance(status_url, str) or not status_url.startswith("https://"):
                raise FireflyError("creative.firefly_failed", None, "no statusUrl")
            done = await self._poll(status_url, deadline)
            urls = self._output_urls(done.get("result") if isinstance(done.get("result"), dict) else done)
        if not urls:
            raise FireflyError("creative.firefly_failed", None, "no outputs")
        return urls

    @staticmethod
    def _output_urls(res: Any) -> list[str]:
        outs = res.get("outputs") if isinstance(res, dict) else None
        urls: list[str] = []
        for o in outs or []:
            u = ((o or {}).get("image") or {}).get("url") if isinstance(o, dict) else None
            if isinstance(u, str) and u.startswith("https://"):
                urls.append(u)
        return urls

    async def _poll(self, status_url: str, deadline: float) -> dict[str, Any]:
        while True:
            if time.monotonic() > deadline:
                raise FireflyError("creative.timeout", None, "status polling")
            st = await self._send("GET", status_url, content_type=None, timeout=30.0)
            status = str((st or {}).get("status") or "").lower() if isinstance(st, dict) else ""
            if status == "succeeded":
                return st
            if status in ("failed", "canceled", "cancelled"):
                text = str(st.get("error") or st.get("message") or st)[:400]
                raise FireflyError(_error_key(400, text) if any(w in text.lower() for w in BLOCK_WORDS)
                                   else "creative.firefly_failed", None, text[:200])
            await asyncio.sleep(POLL_S + random.random() * 0.5)

    # ---- downloads and background removal --------------------------------------------------------------------

    async def download(self, url: str) -> bytes:
        """A pre-signed output URL: fetched WITHOUT the auth headers."""
        assert self.http is not None
        if not url.startswith("https://"):
            raise FireflyError("creative.firefly_failed", None, "bad output url")
        try:
            r = await self.http.get(url, timeout=60.0, follow_redirects=True)
        except httpx.HTTPError as e:
            raise FireflyError("creative.firefly_unreachable", None, "download") from e
        if r.status_code >= 400:
            raise FireflyError("creative.firefly_failed", r.status_code, "download")
        data = r.content
        if not data or len(data) > MAX_DOWNLOAD_BYTES:
            raise FireflyError("creative.firefly_failed", None, "download size")
        return data

    async def remove_background(self, image_url: str, *, deadline_s: float = 90.0) -> bytes:
        """Photoshop API remove-background v2 (cutout PNG) for a signed GET URL; the cut-out bytes."""
        body = {"image": {"source": {"url": image_url}}, "mode": "cutout", "output": {"mediaType": "image/png"},
                "trim": True}
        job = await self._send("POST", PS_REMOVE_BG_URL, json=body, timeout=30.0)
        if isinstance(job, dict) and job.get("status") == "succeeded":
            done = job
        else:
            status_url = job.get("statusUrl") if isinstance(job, dict) else None
            job_id = job.get("jobId") if isinstance(job, dict) else None
            if not status_url and job_id:
                status_url = PS_STATUS_URL.format(job_id=job_id)
            if not isinstance(status_url, str) or not status_url.startswith("https://"):
                raise FireflyError("creative.firefly_failed", None, "remove-bg: no statusUrl")
            done = await self._poll(status_url, time.monotonic() + deadline_s)
        url = _first_url(done.get("result") if isinstance(done, dict) and "result" in done else done)
        if not url or url == image_url:
            raise FireflyError("creative.firefly_failed", None, "remove-bg: no output url")
        return await self.download(url)
