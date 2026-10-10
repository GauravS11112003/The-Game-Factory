"""CV v2 on the command line (PLAN_V2 §3.2, §6.4). Lane C. Run from vision/:

    uv run --no-sync python cli_v2.py scan photo1.jpg [photo2.jpg ...] --out ink.json [--work DIR] [--pack-id ID --k K --kind new|game|remix|extend --parent level.json]
    uv run --no-sync python cli_v2.py ingest drawing.png [--screens N] [--source canvas|migrated] --out ink.json
    uv run --no-sync python cli_v2.py annotate ink.json --out-dir DIR [--ppc 24] [--plain]
    uv run --no-sync python cli_v2.py template --out pack.pdf [--pack-id ID --k K --kind new|game|remix|extend --parent level.json]
    uv run --no-sync python cli_v2.py template --out rules.pdf --kind rules --game-id ID [--current rules.json]
    uv run --no-sync python cli_v2.py template --out library.pdf --kind library --game-id ID [--types types.json]
    uv run --no-sync python cli_v2.py rules-sheet photo.jpg [--work DIR] [--rules current.json]
    uv run --no-sync python cli_v2.py library-sheet photo.jpg [--work DIR] [--out drafts.json]
    uv run --no-sync python cli_v2.py library-strip types.json --out strip.jpg
    uv run --no-sync python cli_v2.py qr "dal2|p|abcd1234|2/3"

`scan` and `ingest` print a one-line summary per sheet and every warning key to stderr; the InkDoc JSON goes to --out
(or stdout). `annotate` writes one JPEG per tile plus <tile>.components.jsonl (the PERCEIVE component table).
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path


def _write_doc(doc_json: str, out: str | None) -> None:
    if out:
        Path(out).parent.mkdir(parents=True, exist_ok=True)
        Path(out).write_text(doc_json)
        print(f"wrote {out}", file=sys.stderr)
    else:
        print(doc_json)


def _summary(ink) -> str:  # noqa: ANN001 - InkDoc
    kinds: dict[str, int] = {}
    for s in ink.strokes:
        kinds[s.kind] = kinds.get(s.kind, 0) + 1
    colors: dict[str, int] = {}
    for c in ink.components:
        colors[c.color] = colors.get(c.color, 0) + 1
    return (
        f"screens={ink.world.screens} strokes={len(ink.strokes)} {kinds} components={len(ink.components)} {colors} "
        f"rules_ink={len(ink.rules_ink)} character={'yes' if ink.character else 'no'} noise={ink.noise.count}"
    )


def cmd_scan(args: argparse.Namespace) -> int:
    from app.cv.scan_v2 import PackInfo, ScanV2Error, run_scan_v2

    images = [Path(p).read_bytes() for p in args.photos]
    parent = json.loads(Path(args.parent).read_text()) if args.parent else None
    pack = (PackInfo(pack_id=args.pack_id, kind=args.kind, k=args.k, parent_id=(parent or {}).get("id"))
            if args.pack_id else None)
    work = Path(args.work) if args.work else Path(tempfile.mkdtemp(prefix="scan_v2_"))
    try:
        res = run_scan_v2(images, pack, work, parent=parent, parent_lookup=lambda _pid: None)
    except ScanV2Error as e:
        print(f"scan failed: {e.message.key} {e.message.args}", file=sys.stderr)
        return 2
    print(_summary(res.ink), file=sys.stderr)
    for s in res.scans:
        print(f"  sheet {s.n} (screen {s.screen + 1}, placed by {s.n_source}): photo {s.photo_index + 1}, "
              f"qr={s.payload!r}, markers={s.markers}, "
              f"lighting_fixed={s.lighting_fixed}, calibrated={s.calibrated}, ms={ {k: round(v) for k, v in s.ms.items()} }",
              file=sys.stderr)
    for sr in res.seams:
        print(f"  seam x={sr.seam_x:g}: {len(sr.pairs)} join candidates, {len(sr.unmatched)} black ends unmatched",
              file=sys.stderr)
    print(f"  complete={res.complete} playable_screens={res.playable_screens}", file=sys.stderr)
    for w in res.warnings:
        print(f"  warning {w.key} {w.args}", file=sys.stderr)
    print(f"  files in {work}", file=sys.stderr)
    _write_doc(res.ink.model_dump_json(exclude_none=True), args.out)
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    from app.cv.raster_ingest import ingest_raster
    from app.cv.scan_v2 import ScanV2Error

    try:
        ink = ingest_raster(Path(args.image).read_bytes(), args.screens, source=args.source, origin=args.origin)
    except ScanV2Error as e:
        print(f"ingest failed: {e.message.key}", file=sys.stderr)
        return 2
    print(_summary(ink), file=sys.stderr)
    _write_doc(ink.model_dump_json(exclude_none=True), args.out)
    return 0


def cmd_annotate(args: argparse.Namespace) -> int:
    from app.cv.annotate import component_rows, component_table, render_annotated, tiles_for
    from app.spec.ink import InkDoc

    ink = InkDoc.model_validate_json(Path(args.ink).read_text())
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    tiles = tiles_for(ink)
    for t in tiles:
        jpg = render_annotated(ink, t, args.ppc, labels=not args.plain, tiles=tiles)
        (out / f"{t.id}.jpg").write_bytes(jpg)
        rows = component_rows(ink, t, tiles)
        (out / f"{t.id}.components.jsonl").write_text(component_table(rows) + "\n")
        print(f"{t.id}: x {t.x0:g}-{t.x1:g}, {len(rows)} components, {len(jpg) // 1024} KB", file=sys.stderr)
    return 0


def cmd_template(args: argparse.Namespace) -> int:
    from app.cv.scan_v2 import PackInfo
    from app.template.generate_v2 import (
        make_library_pdf,
        make_pack_pdf,
        make_rules_pdf,
        render_blank_v2,
        sheet_png_bytes,
        to_pdf_bytes,
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    if args.kind in ("rules", "library"):
        if not args.game_id:
            print("--game-id is required for rules and library sheets", file=sys.stderr)
            return 2
        if args.kind == "rules":
            current = json.loads(Path(args.current).read_text()) if args.current else None
            out.write_bytes(make_rules_pdf(args.game_id, current=current))
        else:
            types = json.loads(Path(args.types).read_text()) if args.types else []
            out.write_bytes(make_library_pdf(args.game_id, types))
    elif not args.pack_id:
        img = render_blank_v2()
        out.write_bytes(sheet_png_bytes(img) if out.suffix.lower() == ".png" else to_pdf_bytes([img]))
    else:
        parent = json.loads(Path(args.parent).read_text()) if args.parent else None
        out.write_bytes(make_pack_pdf(PackInfo(pack_id=args.pack_id, kind=args.kind, k=args.k), parent))
    print(f"wrote {out}", file=sys.stderr)
    return 0


def cmd_rules_sheet(args: argparse.Namespace) -> int:
    from app.cv.checkbox import apply_rules_patch, read_rules_sheet_detail
    from app.cv.scan_v2 import ScanV2Error

    try:
        res = read_rules_sheet_detail(Path(args.photo).read_bytes(), Path(args.work) if args.work else None)
    except ScanV2Error as e:
        print(f"rules sheet failed: {e.message.key} {e.message.args}", file=sys.stderr)
        return 2
    for g in res.rows:
        fills = " ".join(f"{b.id}={b.fill:.2f}{'*' if b.ticked else '?' if b.unsure else ''}{'' if b.found else '!'}"
                         for b in g.boxes)
        print(f"  {g.group:15s} {g.status:6s} {fills}", file=sys.stderr)
    print(f"  game={res.game_id} story_ink={res.story_has_ink} boxes_found={res.found_ratio:.0%}", file=sys.stderr)
    for a in res.result.asks:
        print(f"  ask {a.key} {a.args}", file=sys.stderr)
    for w in res.warnings:
        print(f"  warning {w.key} {w.args}", file=sys.stderr)
    out: dict = {"patch": res.result.patch}
    if args.rules:
        out["rules"] = apply_rules_patch(json.loads(Path(args.rules).read_text()), res.result.patch)
    print(json.dumps(out, indent=2))
    return 0


def cmd_library_sheet(args: argparse.Namespace) -> int:
    from app.cv.checkbox import drafts_json, read_library_sheet_detail
    from app.cv.scan_v2 import ScanV2Error

    try:
        res = read_library_sheet_detail(Path(args.photo).read_bytes(), Path(args.work) if args.work else None)
    except ScanV2Error as e:
        print(f"library sheet failed: {e.message.key} {e.message.args}", file=sys.stderr)
        return 2
    for b in res.boxes:
        if b.draft is None:
            print(f"  box {b.index}: empty", file=sys.stderr)
            continue
        d = b.draft
        ticks = " ".join(f"{k}={v:.2f}" for k, v in d.ticks.items() if v > 0.03)
        print(f"  box {b.index}: {len(d.art.strokes)} strokes size={d.art.size_cells} archetype={d.archetype} "
              f"speed={d.speed} spiky={d.spiky} symbol={d.symbol_samples}/3 name_ink={d.name_has_ink} [{ticks}]",
              file=sys.stderr)
        for a in d.asks:
            print(f"    ask {a.key} {a.args}", file=sys.stderr)
        for w in d.warnings:
            print(f"    warning {w.key} {w.args}", file=sys.stderr)
    print(f"  game={res.game_id} calibrated={res.calibrated}", file=sys.stderr)
    _write_doc(json.dumps({"drafts": drafts_json(res.drafts)}, indent=2), args.out)
    return 0


def cmd_library_strip(args: argparse.Namespace) -> int:
    from app.cv.annotate import render_library_strip

    data = json.loads(Path(args.types).read_text())
    types = data.get("types", data) if isinstance(data, dict) else data
    jpg = render_library_strip(types)
    Path(args.out).write_bytes(jpg)
    print(f"wrote {args.out} ({len(jpg) // 1024} KB)", file=sys.stderr)
    return 0


def cmd_qr(args: argparse.Namespace) -> int:
    from app.template.spec_v2 import parse_qr

    info = parse_qr(args.payload)
    print(json.dumps(None if info is None else info.__dict__, default=str))
    return 0 if info is not None else 1


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="draw-a-level CV v2")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("scan", help="paper photos -> InkDoc")
    s.add_argument("photos", nargs="+")
    s.add_argument("--out")
    s.add_argument("--work")
    s.add_argument("--pack-id")
    s.add_argument("--k", type=int, default=1)
    s.add_argument("--kind", choices=["new", "game", "remix", "extend"], default="new")
    s.add_argument("--parent", help="parent LevelV2 JSON (remix, extend)")
    s.set_defaults(fn=cmd_scan)

    i = sub.add_parser("ingest", help="drawing-area image -> InkDoc")
    i.add_argument("image")
    i.add_argument("--screens", type=int, default=0, help="0 = infer from the aspect ratio")
    i.add_argument("--source", choices=["canvas", "migrated"], default="canvas")
    i.add_argument("--origin", choices=["kid", "migrated", "parent"], default="kid")
    i.add_argument("--out")
    i.set_defaults(fn=cmd_ingest)

    a = sub.add_parser("annotate", help="InkDoc -> annotated PERCEIVE tiles")
    a.add_argument("ink")
    a.add_argument("--out-dir", required=True)
    a.add_argument("--ppc", type=int, default=24)
    a.add_argument("--plain", action="store_true", help="no component ids (the DESIGN image)")
    a.set_defaults(fn=cmd_annotate)

    t = sub.add_parser("template", help="print a v2 sheet, pack, rules or library PDF")
    t.add_argument("--out", required=True)
    t.add_argument("--pack-id")
    t.add_argument("--k", type=int, default=1)
    t.add_argument("--kind", choices=["new", "game", "remix", "extend", "rules", "library"], default="new")
    t.add_argument("--parent")
    t.add_argument("--game-id")
    t.add_argument("--current", help="GameRules JSON (rules sheet: marks the current choices)")
    t.add_argument("--types", help="JSON list of LibraryType (library sheet: adds the reference page)")
    t.set_defaults(fn=cmd_template)

    r = sub.add_parser("rules-sheet", help="read a Rules Sheet photo (OMR) -> GameRules patch")
    r.add_argument("photo")
    r.add_argument("--work")
    r.add_argument("--rules", help="current GameRules JSON: also print the merged result")
    r.set_defaults(fn=cmd_rules_sheet)

    lb = sub.add_parser("library-sheet", help="read a Library Sheet photo -> LibraryDrafts")
    lb.add_argument("photo")
    lb.add_argument("--work")
    lb.add_argument("--out")
    lb.set_defaults(fn=cmd_library_sheet)

    ls = sub.add_parser("library-strip", help="LibraryType JSON list -> the PERCEIVE library strip JPEG")
    ls.add_argument("types")
    ls.add_argument("--out", required=True)
    ls.set_defaults(fn=cmd_library_strip)

    q = sub.add_parser("qr", help="parse a sheet QR payload")
    q.add_argument("payload")
    q.set_defaults(fn=cmd_qr)

    args = p.parse_args(argv)
    return int(args.fn(args))


if __name__ == "__main__":
    sys.exit(main())
