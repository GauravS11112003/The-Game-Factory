"""Creative settings (docs/v3/CONTRACTS_V3.md, "Environment"). All optional:

    FIREFLY_CLIENT_ID          Adobe Developer Console → project → Firefly Services API → OAuth Server-to-Server
    FIREFLY_CLIENT_SECRET      (same credential). Both set → provider "firefly"
    DAL_ART_PROVIDER           auto | firefly | claude-svg | none   (default auto)
    DAL_ART_BUDGET_USD         daily cap for art generation, UTC day (default 5)
    DAL_FIREFLY_REMOVE_BG      1 → Photoshop API remove-background v2 on Firefly output (default 0: local cutout)
    DAL_FIREFLY_SYNC           1 → POST /v3/images/generate (sync) instead of generate-async + status polling
    DAL_FIREFLY_MODEL          x-model-version header (image3, image4_standard, ...); unset → the server default
    DAL_FIREFLY_USD_PER_IMAGE  what one Firefly image counts against the art budget (default 0.04)

Values come from the process environment first, then from <root>/.env (re-read when it changes), so adding Firefly
credentials to .env works without restarting the API. Secrets are never logged, returned or put in a repr.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.config import PROJECT_ROOT, get_settings

Provider = Literal["firefly", "claude-svg", "none"]
ENV_KEYS = (
    "FIREFLY_CLIENT_ID", "FIREFLY_CLIENT_SECRET", "DAL_ART_PROVIDER", "DAL_ART_BUDGET_USD", "DAL_FIREFLY_REMOVE_BG",
    "DAL_FIREFLY_SYNC", "DAL_FIREFLY_MODEL", "DAL_FIREFLY_USD_PER_IMAGE",
)
_DOTENV = PROJECT_ROOT / ".env"
_dotenv_cache: tuple[float, dict[str, str]] = (-1.0, {})


def _dotenv() -> dict[str, str]:
    """Only the creative keys of <root>/.env (cached by mtime). Never logged."""
    global _dotenv_cache
    try:
        mtime = _DOTENV.stat().st_mtime
    except OSError:
        return {}
    if mtime == _dotenv_cache[0]:
        return _dotenv_cache[1]
    out: dict[str, str] = {}
    try:
        for line in _DOTENV.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            if line.startswith("export "):
                line = line[7:].lstrip()
            k, v = line.split("=", 1)
            k = k.strip()
            if k not in ENV_KEYS:
                continue
            v = v.strip()
            if v[:1] in ("'", '"') and v[-1:] == v[:1] and len(v) >= 2:
                v = v[1:-1]
            else:
                v = v.split(" #", 1)[0].strip()  # inline comment
            out[k] = v
    except OSError:
        return {}
    _dotenv_cache = (mtime, out)
    return out


def env(name: str, default: str = "") -> str:
    v = os.environ.get(name)
    if v is not None and v.strip() != "":
        return v.strip()
    return _dotenv().get(name, default) or default


def _float(name: str, default: float) -> float:
    try:
        return float(env(name, "") or default)
    except ValueError:
        return default


def _flag(name: str) -> bool:
    return env(name, "").lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class CreativeSettings:
    firefly_client_id: str = field(repr=False)
    firefly_client_secret: str = field(repr=False)
    provider_pref: str
    budget_usd: float
    remove_bg_api: bool
    firefly_sync: bool
    firefly_model: str | None
    usd_per_image: float

    @property
    def has_firefly(self) -> bool:
        return bool(self.firefly_client_id and self.firefly_client_secret)

    @property
    def uploads_dir(self) -> Path:
        return get_settings().uploads_dir

    @property
    def art_dir(self) -> Path:
        """Public (served under /uploads/art): crops, sprites, backdrops, style images, job records."""
        return self.uploads_dir / "art"

    @property
    def store_dir(self) -> Path:
        """Private: fingerprint index, style store, budget ledger."""
        return get_settings().data_dir / "creative"


def get() -> CreativeSettings:
    pref = env("DAL_ART_PROVIDER", "auto").lower()
    if pref not in ("auto", "firefly", "claude-svg", "none"):
        pref = "auto"
    return CreativeSettings(
        firefly_client_id=env("FIREFLY_CLIENT_ID"),
        firefly_client_secret=env("FIREFLY_CLIENT_SECRET"),
        provider_pref=pref,
        budget_usd=max(0.0, _float("DAL_ART_BUDGET_USD", 5.0)),
        remove_bg_api=_flag("DAL_FIREFLY_REMOVE_BG"),
        firefly_sync=_flag("DAL_FIREFLY_SYNC"),
        firefly_model=env("DAL_FIREFLY_MODEL") or None,
        usd_per_image=max(0.0, _float("DAL_FIREFLY_USD_PER_IMAGE", 0.04)),
    )


def claude_available() -> bool:
    from app.mind import client

    return client.available()


def provider(s: CreativeSettings | None = None) -> Provider:
    """firefly when its credentials are set, else claude-svg when a model call can run, else none (the kid's ink
    stays). An explicit DAL_ART_PROVIDER is honoured when it can run and degrades the same way when it cannot."""
    s = s or get()
    pref = s.provider_pref
    if pref == "none":
        return "none"
    if pref in ("auto", "firefly") and s.has_firefly:
        return "firefly"
    if claude_available():
        return "claude-svg"
    return "none"


def public_url(path: Path) -> str:
    """A file under uploads/ → its URL (/uploads/...)."""
    st = get_settings()
    rel = path.resolve().relative_to(st.uploads_dir.resolve())
    return st.public_uploads.rstrip("/") + "/" + rel.as_posix()


def path_of_url(url: str) -> Path | None:
    """/uploads/... → the file, only when it really lies inside uploads/ (never a path escape)."""
    st = get_settings()
    prefix = st.public_uploads.rstrip("/") + "/"
    if not isinstance(url, str) or not url.startswith(prefix):
        return None
    p = (st.uploads_dir / url[len(prefix):]).resolve()
    try:
        p.relative_to(st.uploads_dir.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None
