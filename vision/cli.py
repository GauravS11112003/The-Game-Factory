"""Photo -> level JSON on the command line (PLAN.md section 1). Owned by lane A.

Run from the vision/ folder:

    uv run python cli.py photo.jpg [--mode paper|canvas] [--out level.json] [--debug DIR] [--prompt "..."]
    uv run python cli.py --blank-template out.pdf            # just print a blank sheet

The level JSON is printed to stdout (warnings go to stderr) and written to
--out. Glue: run_scan -> interpret -> compile_level. The vision model is
optional (no key -> fake mode) and compile_level may still be a stub while
lane C works; then a minimal CV-only level is assembled here so the CLI
always produces something the engine can play.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import shutil
import sys
import tempfile
from pathlib import Path

from app.cv.pipeline import ScanError, run_scan
from app.models import Component, CVResult, Entity, Grid, Interpretation, Level, Meta, Source, Sprites


def _warn(msg: str) -> None:
    print(msg, file=sys.stderr)


def _interpret(cv: CVResult, prompt: str | None) -> Interpretation | None:
    try:
        from app.llm.interpret import interpret
    except Exception as exc:  # noqa: BLE001 - lane C's module may be mid-edit
        _warn(f"interpret unavailable ({exc}); compiling without rules")
        return None
    try:
        return interpret(cv, [], prompt)
    except NotImplementedError:
        _warn("interpret is still a stub; compiling without rules")
    except Exception as exc:  # noqa: BLE001 - interpret promises not to raise, but never block the CLI on it
        _warn(f"interpret failed ({exc}); compiling without rules")
    return None


def _entity_url(public_prefix: str, path: str | None) -> str | None:
    return None if path is None else f"{public_prefix}/{Path(path).name}"


def minimal_level(cv: CVResult, author: str, level_id: str, uploads_dir: str, public_prefix: str) -> Level:
    """CV-only level: grid, components, goal, coins and start. Used when compile_level is a stub."""
    uploads = Path(uploads_dir)
    uploads.mkdir(parents=True, exist_ok=True)
    for src in (cv.backdrop_path, cv.sprite_path):
        if src and Path(src).exists() and Path(src).parent != uploads:
            shutil.copy2(src, uploads / Path(src).name)
    entities = [
        Entity(id="start", type="player_start", x=cv.player_start[0], y=cv.player_start[1]),
    ]
    if cv.goal is not None:
        entities.append(Entity(id="goal", type="goal", x=cv.goal[0], y=cv.goal[1]))
    for i, (x, y) in enumerate(cv.coins, start=1):
        entities.append(Entity(id=f"c{i}", type="coin", x=x, y=y))
    return Level(
        id=level_id,
        title="Untitled level",
        author=author,
        created_at=dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        source=Source(kind=cv.mode, backdrop_url=_entity_url(public_prefix, cv.backdrop_path)),
        grid=Grid(rows=cv.grid_rows),
        sprites=Sprites(player=_entity_url(public_prefix, cv.sprite_path)),
        components=[Component(**c.model_dump(exclude={"cells"})) for c in cv.components],
        entities=entities,
        rules=[],
        meta=Meta(warnings=list(cv.warnings) + ["rules_not_read", "compiled_without_compile_level"]),
    )


def build_level(
    cv: CVResult,
    interp: Interpretation | None,
    author: str,
    level_id: str,
    uploads_dir: str,
    public_prefix: str,
) -> Level:
    try:
        from app.compile import compile_level
    except Exception as exc:  # noqa: BLE001
        _warn(f"compile_level unavailable ({exc}); using the minimal CV-only assembly")
        return minimal_level(cv, author, level_id, uploads_dir, public_prefix)
    try:
        return compile_level(cv, interp, None, author, None, level_id, uploads_dir, public_prefix)
    except NotImplementedError:
        _warn("compile_level is still a stub; using the minimal CV-only assembly")
        return minimal_level(cv, author, level_id, uploads_dir, public_prefix)


def write_blank_template(out: Path) -> None:
    from app.template.generate import render_blank, to_pdf_bytes

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(to_pdf_bytes(render_blank("dal1|blank")))
    _warn(f"wrote {out}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Turn a photo of a sheet into a level JSON")
    parser.add_argument("image", nargs="?", help="photo (paper mode) or canvas PNG")
    parser.add_argument("--out", default="level.json")
    parser.add_argument("--mode", choices=["paper", "canvas"], default="paper")
    parser.add_argument("--debug", default=None, help="folder for intermediate images")
    parser.add_argument("--prompt", default=None, help="extra text for the vision model")
    parser.add_argument("--author", default="cli")
    parser.add_argument("--level-id", default="lvl_cli")
    parser.add_argument("--blank-template", default=None, metavar="OUT_PDF", help="write a blank sheet PDF")
    args = parser.parse_args(argv)

    if args.blank_template:
        write_blank_template(Path(args.blank_template))
        if not args.image:
            return 0
    if not args.image:
        parser.error("an image is required unless --blank-template is given")

    work_dir = args.debug or tempfile.mkdtemp(prefix="dal_")
    Path(work_dir).mkdir(parents=True, exist_ok=True)
    image_bytes = Path(args.image).read_bytes()

    try:
        cv = run_scan(image_bytes, args.mode, work_dir, debug=bool(args.debug))
    except ScanError as exc:
        _warn(f"scan failed: {exc}")
        return 2
    interp = _interpret(cv, args.prompt)
    # The level's assets get their own folder: compile_level copies player.png and
    # backdrop.png into uploads_dir, which must not be where run_scan wrote them.
    uploads_dir = str(Path(work_dir) / "level")
    level = build_level(cv, interp, args.author, args.level_id, uploads_dir, "file://" + uploads_dir)

    text = level.model_dump_json(indent=2)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(text + "\n")
    print(text)
    _warn(f"wrote {args.out} (work dir {work_dir})")
    warnings = sorted(set(cv.warnings) | set(level.meta.warnings))
    if warnings:
        _warn("warnings: " + json.dumps(warnings))
    return 0


if __name__ == "__main__":
    sys.exit(main())
