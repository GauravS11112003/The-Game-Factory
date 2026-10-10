# G09 tower_key

- Mode: canvas. Input: input.png.
- Expectations: PLAN_V2 §11.5 row G09; `expect.json` is a P0 skeleton (status "skeleton"): lane B completes locators and assertions once `ink.json` exists (lane C, P1).
- Must not: key silently becomes a coin.
- `gt.json` is the [M] probe's hand-labelled ground truth (v1 cell bboxes; v1 role names such as spike_strip). The written "S" in G09 is a v2 `start_marker`.
