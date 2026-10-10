"""Wide parallax backdrop for an N-screen level (POST /api/v2/creative/backdrop), from the theme and the game style.

firefly     one 2688×1536 (16:9, valid for image3 and image4) image from the theme + style text, with the game's
            style image as style reference; it becomes a seamless strip N screens wide by mirror tiling
            (image, mirrored image, image...), 1024×576 per screen, JPEG. A parallax layer scrolls slower than the
            level, so N screens of width is always enough.
claude-svg  Claude paints one tileable SVG, viewBox 1600·N × 900 (app.creative.claude_svg.backdrop).

run(job) → {url, label, prompt, tool, cost_usd}; raises BackdropError(key) on failure.
"""
from __future__ import annotations

import asyncio
import io
import secrets
from pathlib import Path
from typing import Any

from app.creative import claude_svg, cutout
from app.creative import settings as cs
from app.creative.firefly import WIDE, Firefly, FireflyError
from app.mind import sanitize

SCREEN_PX = (1024, 576)
DEFAULT_THEME = "a sunny meadow with soft rolling hills and fluffy clouds"


class BackdropError(Exception):
    def __init__(self, key: str) -> None:
        super().__init__(key)
        self.key = key


def firefly_prompt(theme: str | None, style_text: str | None) -> str:
    t = sanitize.text(theme, 200) or DEFAULT_THEME
    st = sanitize.text(style_text, 200)
    return (f"{t}, wide side-scrolling platformer game background, layered parallax landscape, calm muted colours, "
            f"soft low-contrast lower half, no characters, no text, no ground line"
            + (f", {st}" if st else "") + ", 2D game art")[:1000]


def wide_strip(data: bytes, screens: int, screen_px: tuple[int, int] = SCREEN_PX) -> bytes:
    """One 16:9 image → a JPEG `screens` screens wide, mirror-tiled so every seam matches."""
    from PIL import Image, ImageOps

    img = Image.open(io.BytesIO(data))
    img.load()
    img = img.convert("RGB")
    sw, sh = screen_px
    scale = max(sw / img.width, sh / img.height)
    img = img.resize((max(sw, round(img.width * scale)), max(sh, round(img.height * scale))),
                     Image.Resampling.LANCZOS)
    left, top = (img.width - sw) // 2, (img.height - sh) // 2
    tile = img.crop((left, top, left + sw, top + sh))
    flipped = ImageOps.mirror(tile)
    n = max(1, min(6, screens))
    out = Image.new("RGB", (sw * n, sh))
    for i in range(n):
        out.paste(tile if i % 2 == 0 else flipped, (i * sw, 0))
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=86, optimize=True)
    return buf.getvalue()


async def run(job: dict[str, Any], out_dir: Path, *, provider: str, style_info: dict[str, Any] | None,
              can_spend: Any, ledger_add: Any) -> dict[str, Any]:
    s = cs.get()
    screens = max(1, min(6, int(job.get("screens") or 1)))
    theme = job.get("theme")
    style_text = (style_info or {}).get("text")
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = secrets.token_hex(3)
    if provider == "firefly":
        if not can_spend(s.usd_per_image):
            raise BackdropError("creative.budget")
        prompt = firefly_prompt(theme, style_text)
        try:
            async with Firefly(s) as ff:
                from app.creative import style as cstyle

                style_up = await cstyle.firefly_upload_id(style_info, ff)
                urls = await ff.generate(prompt, size=WIDE, n=1, style_upload=style_up, style_strength=40,
                                         negative="characters, people, animals, text, watermark, frame, border, "
                                                  "user interface", content_class="art")
                ledger_add("firefly", s.usd_per_image * len(urls), ref=job.get("job_id"))
                data = await ff.download(urls[0])
            jpg = await asyncio.to_thread(wide_strip, data, screens)
        except FireflyError as e:
            if e.key == "creative.blocked" or not cs.claude_available():
                raise BackdropError(e.key) from e
            provider = "claude-svg"  # Firefly is down or unauthorised: Claude paints it instead
        except (OSError, ValueError, cutout.CutoutError) as e:
            raise BackdropError("creative.failed") from e
        else:
            path = out_dir / f"bg_{job['job_id']}_{tag}.jpg"
            path.write_bytes(jpg)
            return {"url": cs.public_url(path), "label": sanitize.text(theme, 32) or "backdrop", "prompt": prompt,
                    "tool": "Adobe Firefly", "provider": "firefly"}
    if provider != "claude-svg":
        raise BackdropError("creative.off")
    if not can_spend(0.15):
        raise BackdropError("creative.budget")
    o = await claude_svg.backdrop(theme=theme, style_text=style_text, screens=screens)
    ledger_add("claude", o.cost_usd, ref=job.get("job_id"))
    if not o.svg:
        raise BackdropError(o.error_key or "creative.failed")
    path = out_dir / f"bg_{job['job_id']}_{tag}.svg"
    path.write_text(o.svg, encoding="utf-8")
    return {"url": cs.public_url(path), "label": o.label or sanitize.text(theme, 32) or "backdrop",
            "prompt": sanitize.text(theme, 200) or DEFAULT_THEME, "tool": "Claude", "provider": "claude-svg"}
