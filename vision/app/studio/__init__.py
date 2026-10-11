"""v6 Studio backend (docs/v6/CONTRACTS_V6.md §5): storage of Studio games, templates and themes, and the AI copilot.

    catalog.py   shared/spec/studio_catalog.json: lookups, param clamps and the compact rendering the model reads
    assets.py    shared/studio/templates/*.json and shared/studio/themes.json (with a built-in fallback)
    store.py     the studio_games table and its CRUD
    summary.py   the game summary the copilot reads (never raw strokes) and the shape guesses behind it
    edits.py     server-side validation of StudioEdit lists (§5.2)
    fallback.py  keyword answers when the model cannot answer
    copilot.py   chat, recognize and theme through app.mind.client
"""
