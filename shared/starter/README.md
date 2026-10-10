# Starter World v2 (lane B, P4)

PLAN_V2 §9. `L1..L5.plan.json` (LevelPlan beats, `shared/spec/plan.schema.json`) + `L1..L5.overrides.json` (explicit edits)
→ `npm run starter:build` → `dist/*.level.json`; `npm run starter:verify` writes `report.md` and fails CI on any miss.
Targets per level live in `web/src/core/params.ts` (`STARTER`). Empty at P0.
