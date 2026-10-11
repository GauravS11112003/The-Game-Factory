# Raster art library

Imagine can select matching finished images from `*/manifest.json` before falling back to its configured art provider. No Firefly credentials are needed to use these packs. New artwork can be created with Codex's built-in image tool, saved here, and reused in subsequent games or revisions. This is a local asset library, not a connection from the running server to Codex's image tool.

Each manifest has a directory-matching `id`, `provider`, `style`, `perspective`, `tags`, and `assets`. Asset entries use `key`, `filename`, `kind` (`backdrop`, `sprite`, `texture`), `description`, `frames` (1–4) and `fps` (1–20). Animated sheets have one horizontal row of equal cells. Static scenery has one frame. PNG, WebP and JPEG are accepted; files must stay inside the pack folder. Backdrops retain their resolution. Sprites are keyed when necessary, aligned at their feet and packaged as 512px cells.

The heaven pack's background and axe were created with the built-in OpenAI image tool. The prompts are in `heaven-clash/prompts.json`. The updated local Heaven Clash game also uses third-party character renders; their source and rights notes live with that game's art manifest, rather than in this reusable library.
