# Complete tracked-file inventory

Assessed October 10, 2026. This lists every file tracked at the beginning of the assessment. Generated installations, the local `.env`, `vision/data/`, build outputs and the new assessment artifacts are excluded from the baseline.

A “present” file is not automatically a verified feature. File statuses identify the strongest applicable subsystem check and explicitly preserve incomplete behavioral coverage. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for feature-level details.

Baseline: **826 files** in **66 groups**; **0 missing**.

| Subsystem | Files |
|---|---:|
| `docs/checklist.md` | 1 |
| `docs/spec` | 1 |
| `docs/v2` | 2 |
| `docs/v2/designs` | 3 |
| `docs/v2/diagnosis` | 184 |
| `docs/v2/evals` | 2 |
| `docs/v2/requests` | 20 |
| `docs/v3` | 1 |
| `root and local launch configuration` | 12 |
| `scripts` | 5 |
| `shared/behaviors.md` | 1 |
| `shared/fixtures` | 1 |
| `shared/fixtures/cvresults` | 15 |
| `shared/fixtures/interpretations` | 4 |
| `shared/fixtures/levels` | 3 |
| `shared/fixtures/photos` | 10 |
| `shared/golden` | 74 |
| `shared/level.schema.json` | 1 |
| `shared/spec` | 16 |
| `shared/spec/conformance` | 26 |
| `shared/spec/legacy` | 1 |
| `shared/starter` | 11 |
| `shared/template_spec.json` | 1 |
| `shared/template_spec_v2.json` | 1 |
| `vision/app (application, storage and migration)` | 10 |
| `vision/app/build` | 11 |
| `vision/app/collab` | 10 |
| `vision/app/creative` | 9 |
| `vision/app/cv` | 14 |
| `vision/app/llm` | 4 |
| `vision/app/mind` | 30 |
| `vision/app/routers` | 5 |
| `vision/app/routers/v2` | 17 |
| `vision/app/spec` | 14 |
| `vision/app/template` | 5 |
| `vision/tests` | 17 |
| `web (configuration and scripts)` | 11 |
| `web/public/assets` | 1 |
| `web/public/fonts` | 1 |
| `web/src (legacy entry points)` | 5 |
| `web/src/app` | 61 |
| `web/src/audio` | 1 |
| `web/src/core (entry points and contracts)` | 5 |
| `web/src/core/__tests__` | 10 |
| `web/src/core/art` | 16 |
| `web/src/core/bot` | 9 |
| `web/src/core/build` | 11 |
| `web/src/core/design` | 10 |
| `web/src/core/difficulty` | 1 |
| `web/src/core/edits` | 7 |
| `web/src/core/generate` | 7 |
| `web/src/core/ink` | 3 |
| `web/src/core/replay` | 6 |
| `web/src/core/scene` | 11 |
| `web/src/core/sim` | 9 |
| `web/src/core/util` | 10 |
| `web/src/core/worker` | 6 |
| `web/src/dev` | 2 |
| `web/src/editor` | 17 |
| `web/src/engine` | 17 |
| `web/src/export` | 5 |
| `web/src/game` | 15 |
| `web/src/render` | 13 |
| `web/src/screens` | 8 |
| `web/src/solver` | 3 |
| `web/src/ui` | 3 |

## docs/checklist.md

| File | Status |
|---|---|
| [docs/checklist.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/checklist.md) | PRESENT: documentation; check current report for actual behavior |

## docs/spec

| File | Status |
|---|---|
| [docs/spec/level-format-v2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/spec/level-format-v2.md) | PRESENT: documentation; check current report for actual behavior |

## docs/v2

| File | Status |
|---|---|
| [docs/v2/CONTRACTS.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/CONTRACTS.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/latency.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/latency.md) | PRESENT: documentation; check current report for actual behavior |

## docs/v2/designs

| File | Status |
|---|---|
| [docs/v2/designs/geometry-first.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/designs/geometry-first.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/designs/mind-first.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/designs/mind-first.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/designs/player-first.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/designs/player-first.md) | PRESENT: documentation; check current report for actual behavior |

## docs/v2/diagnosis

| File | Status |
|---|---|
| [docs/v2/diagnosis/build.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/1_spike_hop/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/1_spike_hop/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/1_spike_hop/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/1_spike_hop/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/1_spike_hop/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/1_spike_hop/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/2_spike_cave/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/2_spike_cave/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/2_spike_cave/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/2_spike_cave/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/2_spike_cave/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/2_spike_cave/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/3_monster_meadow/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/3_monster_meadow/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/3_monster_meadow/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/3_monster_meadow/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/3_monster_meadow/comp_16.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/3_monster_meadow/comp_16.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/3_monster_meadow/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/3_monster_meadow/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/4_words_and_arrows/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/4_words_and_arrows/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/4_words_and_arrows/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/4_words_and_arrows/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/4_words_and_arrows/comp_4.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/4_words_and_arrows/comp_4.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/4_words_and_arrows/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/4_words_and_arrows/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/5_big_leap/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/5_big_leap/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/5_big_leap/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/5_big_leap/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/5_big_leap/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/5_big_leap/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/6_kid_full_level/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/6_kid_full_level/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/6_kid_full_level/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/6_kid_full_level/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/6_kid_full_level/comp_10.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/6_kid_full_level/comp_10.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/6_kid_full_level/comp_5.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/6_kid_full_level/comp_5.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/api_out/6_kid_full_level/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/api_out/6_kid_full_level/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/1_spike_hop_no_pole.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/1_spike_hop_no_pole.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/2_spike_cave_no_pole.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/2_spike_cave_no_pole.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/3_monster_meadow_intended.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/3_monster_meadow_intended.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/4_words_and_arrows_no_pole.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/4_words_and_arrows_no_pole.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/5_big_leap_no_pole.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/5_big_leap_no_pole.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/cf/6_kid_full_level_no_pole.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/cf/6_kid_full_level_no_pole.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_1.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_1.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_1_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_1_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_2.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_2.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_2_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_2_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_3.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_3.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_3_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_3_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_4.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_4.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_4_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_4_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_5.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_5.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_5_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_5_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_6.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_6.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/compare_6_model_off.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/compare_6_model_off.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/1_spike_hop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/1_spike_hop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/2_spike_cave.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/2_spike_cave.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/3_monster_meadow.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/3_monster_meadow.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/4_words_and_arrows.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/4_words_and_arrows.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/5_big_leap.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/5_big_leap.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/6_kid_full_level.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/6_kid_full_level.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/inputs/manifest.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/inputs/manifest.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/make_kid_drawings.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/make_kid_drawings.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/metrics.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/metrics.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/1_spike_hop/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/1_spike_hop/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/1_spike_hop/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/1_spike_hop/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/1_spike_hop/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/1_spike_hop/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/1_spike_hop/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/1_spike_hop/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/1_spike_hop/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/1_spike_hop/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/2_spike_cave/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/2_spike_cave/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/2_spike_cave/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/2_spike_cave/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/2_spike_cave/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/2_spike_cave/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/2_spike_cave/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/2_spike_cave/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/2_spike_cave/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/2_spike_cave/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/comp_16.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/comp_16.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/3_monster_meadow/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/3_monster_meadow/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/4_words_and_arrows/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/4_words_and_arrows/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/4_words_and_arrows/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/4_words_and_arrows/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/4_words_and_arrows/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/4_words_and_arrows/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/4_words_and_arrows/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/4_words_and_arrows/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/4_words_and_arrows/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/4_words_and_arrows/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/5_big_leap/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/5_big_leap/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/5_big_leap/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/5_big_leap/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/5_big_leap/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/5_big_leap/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/5_big_leap/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/5_big_leap/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/5_big_leap/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/5_big_leap/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/comp_10.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/comp_10.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/offline/6_kid_full_level/level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/offline/6_kid_full_level/level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/probe_sweeps.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/probe_sweeps.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/probe_sweeps.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/probe_sweeps.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/render_compare.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/render_compare.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/1_spike_hop.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/1_spike_hop.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/2_spike_cave.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/2_spike_cave.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/3_monster_meadow.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/3_monster_meadow.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/4_words_and_arrows.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/4_words_and_arrows.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/5_big_leap.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/5_big_leap.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/responses/6_kid_full_level.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/responses/6_kid_full_level.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/run_offline.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/run_offline.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/build/solve_levels.ts](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/build/solve_levels.ts) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/draft_d_23962d19.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/draft_d_23962d19.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/draft_d_45f50934.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/draft_d_45f50934.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/draft_d_79eff85e.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/draft_d_79eff85e.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/draft_d_b14b143e.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/draft_d_b14b143e.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/draft_d_dfbfe619.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/draft_d_dfbfe619.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/lvl_remix_maya.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/lvl_remix_maya.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/inputs/lvl_remix_sam.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/inputs/lvl_remix_sam.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/level_metrics.ts](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/level_metrics.ts) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/proposed_physics.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/proposed_physics.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/proposed_physics_results.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/proposed_physics_results.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/results.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/results.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/gameplay/results.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/gameplay/results.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/builder.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/builder.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/common.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/common.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/cv.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/cv.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/gt.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/input.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_floating_spikes/work/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/cv.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/cv.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/gt.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/input.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/work/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/work/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/work/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/work/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/work/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/work/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_tower_key/work/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_tower_key/work/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/cv.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/cv.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/gt.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/input.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/canvas_wobbly_cave/work/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/cv.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/cv.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/gt.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/input.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/work/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/work/annotated.jpg) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/work/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/work/backdrop.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/work/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/work/drawing.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/work/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/work/labels.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/inputs/paper_synth_1/work/player.png](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/inputs/paper_synth_1/work/player.png) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/probe_a.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/probe_a.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/probe_b.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/probe_b.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/probe_c.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/probe_c.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/probe_d.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/probe_d.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/probe_v1_latency.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/probe_v1_latency.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/render_inputs.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/render_inputs.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/rescore_b.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/rescore_b.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/calls.jsonl](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/calls.jsonl) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_b_canvas_floating_spikes_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_b_canvas_floating_spikes_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_b_canvas_tower_key_high.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_b_canvas_tower_key_high.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_b_canvas_tower_key_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_b_canvas_tower_key_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_b_canvas_wobbly_cave_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_b_canvas_wobbly_cave_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_b_paper_synth_1_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_b_paper_synth_1_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_c_floating.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_c_floating.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_c_tower.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_c_tower.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_c_wobbly.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_c_wobbly.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_d_gauntlet_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_d_gauntlet_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_d_lava_key_low.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_d_lava_key_low.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_d_lava_key_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_d_lava_key_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_d_tower_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_d_tower_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/log_d_tutorial_medium.txt](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/log_d_tutorial_medium.txt) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_a_scores.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_a_scores.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_canvas_floating_spikes_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_canvas_floating_spikes_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_canvas_tower_key_high.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_canvas_tower_key_high.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_canvas_tower_key_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_canvas_tower_key_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_canvas_wobbly_cave_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_canvas_wobbly_cave_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_paper_synth_1_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_paper_synth_1_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_b_rescored.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_b_rescored.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_c_canvas_floating_spikes_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_c_canvas_floating_spikes_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_c_canvas_tower_key_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_c_canvas_tower_key_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_c_canvas_wobbly_cave_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_c_canvas_wobbly_cave_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_d_gauntlet_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_d_gauntlet_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_d_lava_key_low.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_d_lava_key_low.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_d_lava_key_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_d_lava_key_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_d_tower_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_d_tower_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/probe_d_tutorial_medium.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/probe_d_tutorial_medium.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/results/summary.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/results/summary.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/score_a.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/score_a.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/solve_cli.ts](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/solve_cli.ts) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/model/summarize.py](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/model/summarize.py) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/visual.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/visual.md) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/diagnosis/visual/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/diagnosis/visual/notes.md) | HISTORICAL: prior evidence/script; not rerun as current verification |

## docs/v2/evals

| File | Status |
|---|---|
| [docs/v2/evals/bakeoff_p0.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/evals/bakeoff_p0.json) | HISTORICAL: prior evidence/script; not rerun as current verification |
| [docs/v2/evals/bakeoff_p0_pass2.json](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/evals/bakeoff_p0_pass2.json) | HISTORICAL: prior evidence/script; not rerun as current verification |

## docs/v2/requests

| File | Status |
|---|---|
| [docs/v2/requests/A-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/A-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/A-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/A-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/B-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/B-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/B-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/B-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-3.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-3.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-4.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-4.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-5.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-5.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/C-6.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/C-6.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/D-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/D-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/D-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/D-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/E-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/E-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/E-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/E-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/F-1.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/F-1.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/F-2.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/F-2.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/F-3.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/F-3.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/F-4.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/F-4.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/F-5.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/F-5.md) | PRESENT: documentation; check current report for actual behavior |
| [docs/v2/requests/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v2/requests/README.md) | PRESENT: documentation; check current report for actual behavior |

## docs/v3

| File | Status |
|---|---|
| [docs/v3/CONTRACTS_V3.md](/Users/pranayjoshi/Desktop/projects/draw.play/docs/v3/CONTRACTS_V3.md) | PRESENT: documentation; check current report for actual behavior |

## root and local launch configuration

| File | Status |
|---|---|
| [.claude/launch.json](/Users/pranayjoshi/Desktop/projects/draw.play/.claude/launch.json) | PRESENT: configuration/support file; see subsystem report |
| [.env.example](/Users/pranayjoshi/Desktop/projects/draw.play/.env.example) | PRESENT: configuration/support file; see subsystem report |
| [.gitignore](/Users/pranayjoshi/Desktop/projects/draw.play/.gitignore) | PRESENT: configuration/support file; see subsystem report |
| [PLAN.md](/Users/pranayjoshi/Desktop/projects/draw.play/PLAN.md) | PRESENT: design/documentation; some claims are ahead of verification |
| [PLAN_V2.md](/Users/pranayjoshi/Desktop/projects/draw.play/PLAN_V2.md) | PRESENT: design/documentation; some claims are ahead of verification |
| [PROJECT_CONTEXT.md](/Users/pranayjoshi/Desktop/projects/draw.play/PROJECT_CONTEXT.md) | PRESENT: design/documentation; some claims are ahead of verification |
| [README.md](/Users/pranayjoshi/Desktop/projects/draw.play/README.md) | PRESENT: design/documentation; some claims are ahead of verification |
| [vision/cli.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/cli.py) | PRESENT: configuration/support file; see subsystem report |
| [vision/cli_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/cli_v2.py) | PRESENT: configuration/support file; see subsystem report |
| [vision/evals/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/evals/README.md) | PRESENT: configuration/support file; see subsystem report |
| [vision/pyproject.toml](/Users/pranayjoshi/Desktop/projects/draw.play/vision/pyproject.toml) | PRESENT: dependency configuration installed; development audit issues remain |
| [vision/uv.lock](/Users/pranayjoshi/Desktop/projects/draw.play/vision/uv.lock) | PRESENT: dependency configuration installed; development audit issues remain |

## scripts

| File | Status |
|---|---|
| [scripts/dev.sh](/Users/pranayjoshi/Desktop/projects/draw.play/scripts/dev.sh) | PRESENT: utility; dev/contracts paths exercised, other tools not fully run |
| [scripts/gen_contracts.py](/Users/pranayjoshi/Desktop/projects/draw.play/scripts/gen_contracts.py) | PRESENT: utility; dev/contracts paths exercised, other tools not fully run |
| [scripts/latency_bakeoff.py](/Users/pranayjoshi/Desktop/projects/draw.play/scripts/latency_bakeoff.py) | PRESENT: utility; dev/contracts paths exercised, other tools not fully run |
| [scripts/make_golden_inputs.py](/Users/pranayjoshi/Desktop/projects/draw.play/scripts/make_golden_inputs.py) | PRESENT: utility; dev/contracts paths exercised, other tools not fully run |
| [scripts/print_templates.sh](/Users/pranayjoshi/Desktop/projects/draw.play/scripts/print_templates.sh) | PRESENT: utility; dev/contracts paths exercised, other tools not fully run |

## shared/behaviors.md

| File | Status |
|---|---|
| [shared/behaviors.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/behaviors.md) | PRESENT: configuration/support file; see subsystem report |

## shared/fixtures

| File | Status |
|---|---|
| [shared/fixtures/make_levels.py](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/make_levels.py) | PRESENT: sample/fixture; related tests partly exercise it |

## shared/fixtures/cvresults

| File | Status |
|---|---|
| [shared/fixtures/cvresults/first_jump/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/annotated.jpg) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/first_jump/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/backdrop.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/first_jump/cvresult.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/cvresult.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/first_jump/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/drawing.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/first_jump/interpretation.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/interpretation.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/first_jump/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/first_jump/labels.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/hashes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/hashes.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/make_cvresults.py](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/make_cvresults.py) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/annotated.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/annotated.jpg) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/backdrop.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/backdrop.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/cvresult.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/cvresult.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/drawing.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/drawing.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/interpretation.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/interpretation.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/labels.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/labels.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/cvresults/rules_demo/sprite.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/cvresults/rules_demo/sprite.png) | PRESENT: sample/fixture; related tests partly exercise it |

## shared/fixtures/interpretations

| File | Status |
|---|---|
| [shared/fixtures/interpretations/27d847ff59efc23f45468937de941401e0138a31.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/interpretations/27d847ff59efc23f45468937de941401e0138a31.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/interpretations/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/interpretations/README.md) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/interpretations/d238c7bfdc86c30befabb0f51f512f7779109f65.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/interpretations/d238c7bfdc86c30befabb0f51f512f7779109f65.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/interpretations/default.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/interpretations/default.json) | PRESENT: sample/fixture; related tests partly exercise it |

## shared/fixtures/levels

| File | Status |
|---|---|
| [shared/fixtures/levels/starter_1_first_steps.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/levels/starter_1_first_steps.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/levels/starter_2_spike_valley.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/levels/starter_2_spike_valley.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/levels/starter_3_key_cave.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/levels/starter_3_key_cave.json) | PRESENT: sample/fixture; related tests partly exercise it |

## shared/fixtures/photos

| File | Status |
|---|---|
| [shared/fixtures/photos/.gitkeep](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/.gitkeep) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_1.canvas.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_1.canvas.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_1.expected.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_1.expected.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_1.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_1.jpg) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_2.canvas.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_2.canvas.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_2.expected.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_2.expected.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_2.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_2.jpg) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_3.canvas.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_3.canvas.png) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_3.expected.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_3.expected.json) | PRESENT: sample/fixture; related tests partly exercise it |
| [shared/fixtures/photos/synth_3.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/fixtures/photos/synth_3.jpg) | PRESENT: sample/fixture; related tests partly exercise it |

## shared/golden

| File | Status |
|---|---|
| [shared/golden/G01/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G01/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G01/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G01/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G01/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G01/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G01/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G01/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G02/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G02/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G02/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G02/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G02/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G02/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G02/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G02/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G03/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G03/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G03/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G03/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G03/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G03/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G03/prompt.txt](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G03/prompt.txt) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G03/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G03/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G04/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G04/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G04/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G04/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G04/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G04/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G04/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G04/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G05/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G05/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G05/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G05/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G05/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G05/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G05/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G05/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G06/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G06/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G06/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G06/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G06/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G06/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G06/prompt.txt](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G06/prompt.txt) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G06/strokes.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G06/strokes.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G07/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G07/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G07/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G07/gt.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G07/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G07/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G07/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G07/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G08/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G08/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G08/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G08/gt.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G08/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G08/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G08/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G08/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G09/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G09/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G09/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G09/gt.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G09/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G09/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G09/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G09/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G10/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G10/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G10/gt.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G10/gt.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G10/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G10/input.jpg) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G10/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G10/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G11/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G11/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G11/input.png](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G11/input.png) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G11/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G11/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G11/prompt.txt](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G11/prompt.txt) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G12/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G12/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G12/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G12/input.jpg) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G12/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G12/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G13/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G13/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G13/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G13/input.jpg) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G13/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G13/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G14/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G14/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G14/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G14/input.jpg) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G14/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G14/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G15/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G15/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G15/input.jpg](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G15/input.jpg) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G15/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G15/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G16/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G16/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G16/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G16/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G17/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G17/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G17/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G17/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G18/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G18/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G18/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G18/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G19/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G19/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G19/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G19/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G20/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G20/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G20/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G20/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G21/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G21/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G21/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G21/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G22/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G22/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G22/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G22/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G23/expect.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G23/expect.json) | PRESENT: quality fixture; golden runner unfinished, assertions not run |
| [shared/golden/G23/notes.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/golden/G23/notes.md) | PRESENT: quality fixture; golden runner unfinished, assertions not run |

## shared/level.schema.json

| File | Status |
|---|---|
| [shared/level.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/level.schema.json) | PRESENT: configuration/support file; see subsystem report |

## shared/spec

| File | Status |
|---|---|
| [shared/spec/api.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/api.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/behavior.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/behavior.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/common.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/common.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/edits.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/edits.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/events.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/events.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/ink.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/ink.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/level.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/level.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/library.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/library.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/messages.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/messages.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/params.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/params.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/physics-profiles.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/physics-profiles.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/plan.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/plan.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/report.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/report.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/rules.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/rules.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/run.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/run.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |
| [shared/spec/scene.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/scene.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |

## shared/spec/conformance

| File | Status |
|---|---|
| [shared/spec/conformance/events/sample_build.jsonl](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/events/sample_build.jsonl) | PASS: sample event contract checked; not a real build guarantee |
| [shared/spec/conformance/levels/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/README.md) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/bad_role.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/bad_role.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/bad_schema_version.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/bad_schema_version.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/bad_tile_char.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/bad_tile_char.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/bad_trigger.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/bad_trigger.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/conf_above_1.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/conf_above_1.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/edit_unknown_op.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/edit_unknown_op.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/missing_format.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/missing_format.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/nudge_out_of_bounds.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/nudge_out_of_bounds.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/screens_7.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/screens_7.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/semantic_row_count.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/semantic_row_count.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/semantic_row_width.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/semantic_row_width.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/semantic_w_mismatch.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/semantic_w_mismatch.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/spikes_missing_face.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/spikes_missing_face.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/unknown_entity_type.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/unknown_entity_type.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/unknown_top_key.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/unknown_top_key.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/uppercase_extension_key.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/uppercase_extension_key.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/invalid/world_h_30.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/invalid/world_h_30.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/entity_zoo_1screen.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/entity_zoo_1screen.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/example_2screen.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/example_2screen.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/migrated_v1_classic.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/migrated_v1_classic.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/minimal_1screen.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/minimal_1screen.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/six_screens.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/six_screens.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/levels/valid/x_extensions.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/levels/valid/x_extensions.json) | PASS: conformance fixture included in checks |
| [shared/spec/conformance/replays/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/conformance/replays/README.md) | PRESENT: configuration/support file; see subsystem report |

## shared/spec/legacy

| File | Status |
|---|---|
| [shared/spec/legacy/level-v1.schema.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/spec/legacy/level-v1.schema.json) | PASS: shared contract/freshness checks; no exhaustive semantic claim |

## shared/starter

| File | Status |
|---|---|
| [shared/starter/L1.overrides.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L1.overrides.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L1.plan.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L1.plan.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L2.overrides.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L2.overrides.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L2.plan.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L2.plan.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L3.overrides.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L3.overrides.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L3.plan.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L3.plan.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L4.overrides.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L4.overrides.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L4.plan.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L4.plan.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L5.overrides.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L5.overrides.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/L5.plan.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/L5.plan.json) | PRESENT: all plans built; quality flags/target mismatches remain |
| [shared/starter/README.md](/Users/pranayjoshi/Desktop/projects/draw.play/shared/starter/README.md) | PRESENT: all plans built; quality flags/target mismatches remain |

## shared/template_spec.json

| File | Status |
|---|---|
| [shared/template_spec.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/template_spec.json) | PRESENT: configuration/support file; see subsystem report |

## shared/template_spec_v2.json

| File | Status |
|---|---|
| [shared/template_spec_v2.json](/Users/pranayjoshi/Desktop/projects/draw.play/shared/template_spec_v2.json) | PRESENT: configuration/support file; see subsystem report |

## vision/app (application, storage and migration)

| File | Status |
|---|---|
| [vision/app/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/__init__.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/compile.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/compile.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/config.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/config.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/db.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/db.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/db_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/db_v2.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/main.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/main.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/migrate_v1.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/migrate_v1.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/models.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/models.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/seed.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/seed.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/seed_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/seed_v2.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |

## vision/app/build

| File | Status |
|---|---|
| [vision/app/build/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/__init__.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/bridge.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/bridge.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/drafts.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/drafts.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/events.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/events.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/levels_io.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/levels_io.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/orchestrator.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/orchestrator.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/present.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/present.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/prompt_flow.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/prompt_flow.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/publish.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/publish.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/rebuild.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/rebuild.py) | PRESENT: live build/SSE/publish exercised on samples |
| [vision/app/build/runner.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/build/runner.py) | PRESENT: live build/SSE/publish exercised on samples |

## vision/app/collab

| File | Status |
|---|---|
| [vision/app/collab/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/__init__.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/activity.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/activity.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/bible.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/bible.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/db.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/db.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/errors.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/errors.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/identity.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/identity.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/members.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/members.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/quests.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/quests.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/seed_owner.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/seed_owner.py) | PRESENT: read APIs checked; authenticated writes unverified |
| [vision/app/collab/submissions.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/collab/submissions.py) | PRESENT: read APIs checked; authenticated writes unverified |

## vision/app/creative

| File | Status |
|---|---|
| [vision/app/creative/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/__init__.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/backdrop.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/backdrop.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/claude_svg.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/claude_svg.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/cutout.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/cutout.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/firefly.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/firefly.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/ims.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/ims.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/jobs.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/jobs.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/settings.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/settings.py) | PRESENT: imported; provider none locally; external generation unverified |
| [vision/app/creative/style.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/creative/style.py) | PRESENT: imported; provider none locally; external generation unverified |

## vision/app/cv

| File | Status |
|---|---|
| [vision/app/cv/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/__init__.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/annotate.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/annotate.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/calibrate.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/calibrate.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/checkbox.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/checkbox.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/components.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/components.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/features.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/features.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/pipeline.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/pipeline.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/raster_ingest.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/raster_ingest.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/rectify.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/rectify.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/scan_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/scan_v2.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/segment.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/segment.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/sprite.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/sprite.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/stitch.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/stitch.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |
| [vision/app/cv/vectorize.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/cv/vectorize.py) | PRESENT: synthetic CV suite passes; real paper/v2 multi-sheet coverage limited |

## vision/app/llm

| File | Status |
|---|---|
| [vision/app/llm/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/llm/__init__.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/llm/heuristic.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/llm/heuristic.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/llm/interpret.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/llm/interpret.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |
| [vision/app/llm/prompt.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/llm/prompt.py) | PRESENT: API boot/storage/migration exercised; behavior coverage varies |

## vision/app/mind

| File | Status |
|---|---|
| [vision/app/mind/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/__init__.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/art_prompt.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/art_prompt.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/budget.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/budget.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/client.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/client.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/creature.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/creature.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/critic.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/critic.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/design.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/design.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/digest.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/digest.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/fake.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/fake.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/handwriting.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/handwriting.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/ledger.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/ledger.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/messages.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/messages.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/moderate.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/moderate.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/perceive.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/perceive.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/plan.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/plan.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/art_backdrop.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/art_backdrop.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/art_prompt.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/art_prompt.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/art_svg.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/art_svg.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/creature.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/creature.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/critic.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/critic.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/design.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/design.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/handwriting.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/handwriting.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/look.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/look.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/moderate.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/moderate.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/perceive.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/perceive.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/plan.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/plan.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/prompts/refine.md](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/prompts/refine.md) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/render.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/render.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/sanitize.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/sanitize.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |
| [vision/app/mind/schemas.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/mind/schemas.py) | PRESENT: offline/fake-client paths partly checked; live model unverified |

## vision/app/routers

| File | Status |
|---|---|
| [vision/app/routers/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/__init__.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/games.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/games.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/levels.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/levels.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/scan.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/scan.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/templates.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/templates.py) | PRESENT: mounted; see API inventory for operation checks |

## vision/app/routers/v2

| File | Status |
|---|---|
| [vision/app/routers/v2/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/__init__.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/builds.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/builds.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/collab.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/collab.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/creative.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/creative.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/drafts.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/drafts.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/export_phaser.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/export_phaser.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/games.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/games.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/health.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/health.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/levels.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/levels.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/library.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/library.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/live.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/live.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/packs.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/packs.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/prompts.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/prompts.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/rules.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/rules.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/runs.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/runs.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/stubs.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/stubs.py) | PRESENT: mounted; see API inventory for operation checks |
| [vision/app/routers/v2/transfer.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/routers/v2/transfer.py) | PRESENT: mounted; see API inventory for operation checks |

## vision/app/spec

| File | Status |
|---|---|
| [vision/app/spec/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/__init__.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/api.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/api.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/behavior.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/behavior.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/common.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/common.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/edits.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/edits.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/events.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/events.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/ink.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/ink.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/level.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/level.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/library.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/library.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/plan.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/plan.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/report.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/report.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/rules.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/rules.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/runs.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/runs.py) | PASS: schema generation/freshness and contract checks |
| [vision/app/spec/scene.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/spec/scene.py) | PASS: schema generation/freshness and contract checks |

## vision/app/template

| File | Status |
|---|---|
| [vision/app/template/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/template/__init__.py) | PRESENT: new/remix/extend/rules/library PDF outputs exercised |
| [vision/app/template/generate.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/template/generate.py) | PRESENT: new/remix/extend/rules/library PDF outputs exercised |
| [vision/app/template/generate_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/template/generate_v2.py) | PRESENT: new/remix/extend/rules/library PDF outputs exercised |
| [vision/app/template/spec.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/template/spec.py) | PRESENT: new/remix/extend/rules/library PDF outputs exercised |
| [vision/app/template/spec_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/app/template/spec_v2.py) | PRESENT: new/remix/extend/rules/library PDF outputs exercised |

## vision/tests

| File | Status |
|---|---|
| [vision/tests/__init__.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/__init__.py) | PRESENT: configuration/support file; see subsystem report |
| [vision/tests/conftest.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/conftest.py) | PRESENT: configuration/support file; see subsystem report |
| [vision/tests/make_synthetic.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/make_synthetic.py) | PRESENT: configuration/support file; see subsystem report |
| [vision/tests/test_api.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_api.py) | PASS: existing Python test module |
| [vision/tests/test_api_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_api_v2.py) | FAIL: six stale scaffold assertions |
| [vision/tests/test_bridge.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_bridge.py) | PARTIAL: restart/retry passes; stale stub assertion fails |
| [vision/tests/test_compile.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_compile.py) | PASS: existing Python test module |
| [vision/tests/test_db_v2.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_db_v2.py) | PASS: existing Python test module |
| [vision/tests/test_interpret.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_interpret.py) | PASS: existing Python test module |
| [vision/tests/test_mind_client.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_mind_client.py) | PARTIAL: fallback/budget checks pass; word-count assertion fails |
| [vision/tests/test_pipeline.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_pipeline.py) | PASS: existing Python test module |
| [vision/tests/test_rectify.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_rectify.py) | PASS: existing Python test module |
| [vision/tests/test_schema.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_schema.py) | PASS: existing Python test module |
| [vision/tests/test_segment.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_segment.py) | PASS: existing Python test module |
| [vision/tests/test_spec_conformance.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_spec_conformance.py) | PASS: existing Python test module |
| [vision/tests/test_spec_fresh.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_spec_fresh.py) | PASS: existing Python test module |
| [vision/tests/test_spec_models.py](/Users/pranayjoshi/Desktop/projects/draw.play/vision/tests/test_spec_models.py) | PASS: existing Python test module |

## web (configuration and scripts)

| File | Status |
|---|---|
| [web/dev.html](/Users/pranayjoshi/Desktop/projects/draw.play/web/dev.html) | PRESENT: configuration/support file; see subsystem report |
| [web/export.html](/Users/pranayjoshi/Desktop/projects/draw.play/web/export.html) | PRESENT: configuration/support file; see subsystem report |
| [web/index.html](/Users/pranayjoshi/Desktop/projects/draw.play/web/index.html) | PRESENT: configuration/support file; see subsystem report |
| [web/package-lock.json](/Users/pranayjoshi/Desktop/projects/draw.play/web/package-lock.json) | PRESENT: dependency configuration installed; development audit issues remain |
| [web/package.json](/Users/pranayjoshi/Desktop/projects/draw.play/web/package.json) | PRESENT: dependency configuration installed; development audit issues remain |
| [web/scripts/golden_shots.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/scripts/golden_shots.ts) | UNFINISHED: command exits 2 |
| [web/tsconfig.json](/Users/pranayjoshi/Desktop/projects/draw.play/web/tsconfig.json) | PRESENT: configuration/support file; see subsystem report |
| [web/v1.html](/Users/pranayjoshi/Desktop/projects/draw.play/web/v1.html) | PRESENT: configuration/support file; see subsystem report |
| [web/v2.html](/Users/pranayjoshi/Desktop/projects/draw.play/web/v2.html) | PRESENT: configuration/support file; see subsystem report |
| [web/vite.config.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/vite.config.ts) | PRESENT: configuration/support file; see subsystem report |
| [web/vite.export.config.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/vite.export.config.ts) | PRESENT: configuration/support file; see subsystem report |

## web/public/assets

| File | Status |
|---|---|
| [web/public/assets/default_player.png](/Users/pranayjoshi/Desktop/projects/draw.play/web/public/assets/default_player.png) | PRESENT: static asset; visual coverage limited |

## web/public/fonts

| File | Status |
|---|---|
| [web/public/fonts/.gitkeep](/Users/pranayjoshi/Desktop/projects/draw.play/web/public/fonts/.gitkeep) | PLACEHOLDER: expected font files absent |

## web/src (legacy entry points)

| File | Status |
|---|---|
| [web/src/api.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/api.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/main.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/main.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/style.css](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/style.css) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/vite-env.d.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/vite-env.d.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/app

| File | Status |
|---|---|
| [web/src/app/__tests__/messages.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/__tests__/messages.test.ts) | PASS: existing web test file |
| [web/src/app/api.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/api.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/arcs.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/arcs.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/api.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/api.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/bell.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/bell.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/contribute.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/contribute.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/hub.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/hub.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/roles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/roles.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/collab/ui.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/collab/ui.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/core.worker.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/core.worker.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/core_client.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/core_client.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/core_run.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/core_run.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/core_tasks.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/core_tasks.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/core_types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/core_types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/api.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/api.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/creative.css](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/creative.css) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/flyin.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/flyin.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/prefetch.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/prefetch.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/session.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/session.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/tray.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/tray.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creative/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creative/types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/creature_words.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/creature_words.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/dom.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/dom.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/draft.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/draft.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/handoff.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/handoff.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/identity.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/identity.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/ink.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/ink.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/live/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/live/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/live/style.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/live/style.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/live/text.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/live/text.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/main.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/main.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/messages.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/messages.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/readout.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/readout.ts) | PARTIAL: UI observed; {C} placeholder remains |
| [web/src/app/results.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/results.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/router.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/router.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/rules.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/rules.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/activity.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/activity.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/bible.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/bible.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/credits.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/credits.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/dev.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/dev.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/draw.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/draw.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/game.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/game.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/home.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/home.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/jams.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/jams.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/library.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/library.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/play.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/play.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/preview.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/preview.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/profile.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/profile.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/prompt.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/prompt.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/quests.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/quests.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/review.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/review.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/rules.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/rules.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/scan.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/scan.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/screens/tree.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/screens/tree.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/showcase.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/showcase.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/sse.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/sse.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/stage.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/stage.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/store.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/store.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/style.css](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/style.css) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/app/thumbs.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/app/thumbs.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/audio

| File | Status |
|---|---|
| [web/src/audio/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/audio/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/core (entry points and contracts)

| File | Status |
|---|---|
| [web/src/core/cli.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/cli.ts) | PARTIAL: real selftest/starter build work; golden/verify/bench unfinished |
| [web/src/core/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/params.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/params.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/tsconfig.json](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/tsconfig.json) | PRESENT: configuration/support file; see subsystem report |
| [web/src/core/types.gen.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/types.gen.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/__tests__

| File | Status |
|---|---|
| [web/src/core/__tests__/art.api.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/art.api.test.ts) | FAIL: stale stub expectation |
| [web/src/core/__tests__/contracts.api.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/contracts.api.test.ts) | FAIL: stale replay bit-32 expectation |
| [web/src/core/__tests__/contracts.conformance.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/contracts.conformance.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/contracts.fresh.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/contracts.fresh.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/contracts.lint.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/contracts.lint.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/contracts.messages.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/contracts.messages.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/determinism.lint.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/determinism.lint.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/helpers.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/helpers.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/__tests__/replay.codec.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/replay.codec.test.ts) | PASS: existing web test file |
| [web/src/core/__tests__/worker.rpc.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/__tests__/worker.rpc.test.ts) | FAIL: stale build stub expectation |

## web/src/core/art

| File | Status |
|---|---|
| [web/src/core/art/anim.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/anim.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/artdoc.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/artdoc.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/clean.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/clean.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/frame.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/frame.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/geom.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/geom.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/outline.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/outline.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/parallax.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/parallax.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/player.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/player.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/rig.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/rig.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/skin.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/skin.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/sprites.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/sprites.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/styles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/styles.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/svg.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/svg.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/terrain.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/terrain.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/art/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/art/types.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/bot

| File | Status |
|---|---|
| [web/src/core/bot/context.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/context.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/envelope.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/envelope.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/explore.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/explore.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/flags.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/flags.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/frontier.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/frontier.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/measure.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/measure.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/route.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/route.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/bot/slots.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/bot/slots.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/build

| File | Status |
|---|---|
| [web/src/core/build/build.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/build.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/compile.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/compile.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/fit.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/fit.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/hash.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/hash.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/level.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/level.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/migrate_v1.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/migrate_v1.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/normalize.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/normalize.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/runner.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/runner.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/tiles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/tiles.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/build/validate.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/build/validate.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/design

| File | Status |
|---|---|
| [web/src/core/design/candidates.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/candidates.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/context.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/context.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/digest.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/digest.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/playtest.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/playtest.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/repair_search.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/repair_search.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/rules_check.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/rules_check.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/sites.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/sites.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/tiers.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/tiers.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/design/transfer.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/design/transfer.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/difficulty

| File | Status |
|---|---|
| [web/src/core/difficulty/model.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/difficulty/model.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/edits

| File | Status |
|---|---|
| [web/src/core/edits/apply.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/apply.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/cost.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/cost.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/envelope.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/envelope.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/invariants.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/invariants.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/slots.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/slots.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/vocabulary.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/vocabulary.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/edits/work.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/edits/work.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/generate

| File | Status |
|---|---|
| [web/src/core/generate/beats.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/beats.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/draw.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/draw.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/generate.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/generate.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/keyword.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/keyword.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/layout.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/layout.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/generate/starter.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/generate/starter.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/ink

| File | Status |
|---|---|
| [web/src/core/ink/features.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/ink/features.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/ink/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/ink/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/ink/stroke.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/ink/stroke.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/replay

| File | Status |
|---|---|
| [web/src/core/replay/codec.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/codec.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/replay/ghost.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/ghost.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/replay/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/replay/record.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/record.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/replay/run.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/run.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/replay/verify.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/replay/verify.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/scene

| File | Status |
|---|---|
| [web/src/core/scene/asks.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/asks.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/calibration.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/calibration.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/grammar.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/grammar.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/group.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/group.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/merge.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/merge.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/perceive.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/perceive.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/remix.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/remix.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/roles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/roles.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/rules_parser.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/rules_parser.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/scene/symbol.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/scene/symbol.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/sim

| File | Status |
|---|---|
| [web/src/core/sim/camera.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/camera.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/core.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/core.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/index.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/profiles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/profiles.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/rng.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/rng.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/tiles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/tiles.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/trig.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/trig.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/types.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/sim/world.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/sim/world.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/util

| File | Status |
|---|---|
| [web/src/core/util/base64.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/base64.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/canonical.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/canonical.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/errors.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/errors.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/geom.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/geom.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/ids.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/ids.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/lint.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/lint.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/schema.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/schema.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/sha256.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/sha256.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/utf8.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/utf8.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/util/version.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/util/version.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/core/worker

| File | Status |
|---|---|
| [web/src/core/worker/dispatch.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/dispatch.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/worker/main.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/main.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/worker/pool.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/pool.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/worker/stub.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/stub.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/worker/thread.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/thread.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |
| [web/src/core/worker/web.worker.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/core/worker/web.worker.ts) | PRESENT: core import/type/lint checks pass; per-function behavior partly exercised |

## web/src/dev

| File | Status |
|---|---|
| [web/src/dev/fixtures.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/dev/fixtures.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/dev/main.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/dev/main.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/editor

| File | Status |
|---|---|
| [web/src/editor/__tests__/tap.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/__tests__/tap.test.ts) | FAIL: suite cannot load; window undefined |
| [web/src/editor/chips.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/chips.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/creature.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/creature.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/creature_stage.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/creature_stage.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/doc.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/doc.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/geom.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/geom.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/groups.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/groups.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/live.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/live.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/minimap.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/minimap.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/paint.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/paint.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/render.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/render.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/sketchpad.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/sketchpad.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/stamps.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/stamps.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/studio.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/studio.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/tools.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/tools.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/editor/view.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/editor/view.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/engine

| File | Status |
|---|---|
| [web/src/engine/chrome.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/chrome.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/gfx.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/gfx.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/input.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/input.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/morphs.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/morphs.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/scene.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/scene.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/simhost.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/simhost.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/entities.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/entities.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/ghosts.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/ghosts.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/hud.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/hud.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/juice.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/juice.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/lava.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/lava.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/overlays.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/overlays.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/player.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/player.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/skin.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/skin.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/engine/views/underlay.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/engine/views/underlay.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/export

| File | Status |
|---|---|
| [web/src/export/main.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/export/main.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/export/player.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/export/player.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/export/progress.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/export/progress.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/export/style.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/export/style.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/export/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/export/types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/game

| File | Status |
|---|---|
| [web/src/game/LevelScene.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/LevelScene.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/Player.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/Player.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/BouncePad.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/BouncePad.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/Checkpoint.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/Checkpoint.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/KeyDoor.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/KeyDoor.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/MovingPlatform.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/MovingPlatform.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/Patroller.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/Patroller.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/Timer.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/Timer.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/behaviors/types.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/behaviors/types.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/constants.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/constants.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/hud.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/hud.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/rules.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/rules.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/tiles.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/tiles.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/game/touch.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/game/touch.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/render

| File | Status |
|---|---|
| [web/src/render/boil_fx.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/boil_fx.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/canvas_ink.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/canvas_ink.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/fonts.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/fonts.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/index.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/index.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/paper.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/paper.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/paper2d.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/paper2d.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/pencilize.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/pencilize.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/rig2d.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/rig2d.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/sharecard.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/sharecard.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/skin.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/skin.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/text.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/text.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/themes.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/themes.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/render/thumbnail.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/render/thumbnail.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/screens

| File | Status |
|---|---|
| [web/src/screens/canvas.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/canvas.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/game.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/game.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/home.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/home.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/play.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/play.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/preview.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/preview.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/remix.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/remix.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/scan.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/scan.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/screens/tree.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/screens/tree.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/solver

| File | Status |
|---|---|
| [web/src/solver/physicsSim.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/solver/physicsSim.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/solver/solve.test.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/solver/solve.test.ts) | PASS: existing web test file |
| [web/src/solver/solve.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/solver/solve.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |

## web/src/ui

| File | Status |
|---|---|
| [web/src/ui/dom.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/ui/dom.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/ui/router.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/ui/router.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
| [web/src/ui/thumbnails.ts](/Users/pranayjoshi/Desktop/projects/draw.play/web/src/ui/thumbnails.ts) | PRESENT: web typecheck/build pass; behavior coverage varies by feature |
