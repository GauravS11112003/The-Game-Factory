"""v7 AI art (docs/v7/CONTRACTS_V7.md §3): the drawing is the blueprint, Claude draws the finished look.

    svg.py         the SVG allow-list sanitizer, re-framing and mirror tiling
    render.py      resvg rasterizing, the maker's strokes as pictures, render measurements
    calls.py       call kinds, flat output schemas, prompt blocks, the patient call wrapper
    brief.py       what the calls read about the game and each object
    palette.py     colours and the world families behind the fallbacks
    direction.py   the game-wide art direction (+ keyword fallback)
    objects.py     object variants: draw → render → review → fix
    terrain.py     terrain skins for ground lines (+ procedural fallback)
    backdrop.py    the 3-layer parallax backdrop (+ procedural fallback)
    procedural.py  the procedural terrain and backdrop art
    preview.py     composed previews for the review calls
    jobs.py        in-memory art jobs
"""
