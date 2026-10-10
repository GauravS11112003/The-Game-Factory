# Conformance levels (lane B)

- `valid/*.json` must pass `shared/spec/level.schema.json` (Python `jsonschema`), Pydantic `LevelV2` and
  `core.validateLevel()`. When `meta.level_hash` is a full `sha256:<64 hex>`, `core.levelHash()` and the Python
  `level_hash()` must both reproduce it. `example_2screen.json` is the PLAN_V2 §2.2 example verbatim (its hashes are
  placeholders).
- `invalid/*.json` must be rejected by all three. Files named `semantic_*` are valid against the JSON schema and
  rejected only by the semantic checks JSON Schema cannot express (w = 48·screens, tile rows decode to w × h).

Tests: `vision/tests/test_spec_conformance.py`, `web/src/core/__tests__/contracts.conformance.test.ts`, `cli.ts selftest`.
