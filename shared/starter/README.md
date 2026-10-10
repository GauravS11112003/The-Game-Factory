# Starter World v2 (lane B, PLAN_V2 §9)

Five levels authored with the prompt-to-level generator (§8.3), plus Classic Starter (the migrated v1 fixtures).

```sh
npm run starter:build            # (in web/) all levels → dist/*.level.json + dist/index.json
node web/src/core/cli.ts starter:build L2 L3      # rebuild some levels only (others are kept)
```

`starter:build` is a pure build: it lays out, builds (`tier: faithful`) and writes the levels, printing what the
bot measured. Verification against the §9 targets (`starter:verify`) is the owner's.

## Files

- `L1..L5.plan.json` — a `LevelPlan` (`shared/spec/plan.schema.json`): sections of beats. Starter plans are clamped
  by the physics envelope only (not by their band), so an easy level may still teach one 7-wide run-gap.
- `L1..L5.overrides.json` — what the beat catalogue cannot say:
  - `patches`: `[{beat: "<section>.<beat>", …recipe params}]`, plus `{beat: "*", stretch: false,
    auto_checkpoints: false}` for authored lengths and checkpoints. Recipe params by beat kind:
    `flat` enemy_speed, enemy_interval, enemy_at, spikes_w, coin_arc (stomp|row|jump) · `gap` runway, landing,
    coins · `step`/`stairs` coins · `pillars` pillar_w · `floaters` floater_w, over (void|spikes|ground), coins ·
    `ceiling` floor_strips, strip_every, strip_w, coins · `moving_bridge` platforms, speed_cs, saw, rise (lift) ·
    `crumble_run` gap, crumble_w, delay_s, spring · `saw_corridor` mode (vertical|high|mixed), speed_cs, r, path ·
    `tower` ledge_w, floor (safe|spikes), coins · `enemy_gauntlet` spacing, speed, interval, warn, headroom,
    over (pit|ground), hover_rows · `spring_up` strength · `key` ledge_rows · `rest` coins.
  - `draw`: extra drawn things — `big_coin`, `coin`, `coins` (row or arc), `platform` (solid, move, crumble),
    `sign` (text), `spikes` (face), `enemy` (arch, params), `spring`, `saw` (dir, cells, speed), `firebar`, `mass`,
    `wall`, `lava` — at `x, y` (absolute cells) or `beat` + `dx, dy` (relative to that beat's start and ground row).
  - `edits`: ordinary explicit EditOps applied as the kid's; object targets may be written `@<beat>:<role>[#k]`.
  - `seed`, `designer_note`, `rules` (a partial GameRules).
- `dist/` — generated: `L1..L5.level.json` (game `game_world`, ids `lvl_world_l1..l5`), `classic/1..3.level.json`
  (game `game_classic`, v1 ids), `index.json` (games, level order, L5's unlock).

Targets per level (casual C, times, windows, engaged enemies) are in `web/src/core/params.ts` `STARTER`.
