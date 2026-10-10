# Cross-lane change requests

PLAN_V2 §11.1: lanes never edit each other's files. To ask for a change, a lane writes `docs/v2/requests/<lane>-<n>.md`
(for example `D-1.md`), each lane owning its own request files:

- what is needed and why (with the failing test or evidence),
- the files and contracts affected,
- the lanes affected.

The owner answers in `docs/v2/CONTRACTS.md` (contract changes) or in the request file, and closes it by noting the
commit/PR. Contract files change only through a contract PR: an entry in CONTRACTS.md, regenerated artifacts
(`cd vision && uv run --no-sync python ../scripts/gen_contracts.py`, `node web/src/core/cli.ts gen-spec-data`) and updated
fixtures.
