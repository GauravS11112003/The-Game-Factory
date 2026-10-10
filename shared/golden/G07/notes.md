# G07 floating_spikes

- Mode: canvas. Input: input.png.
- Expectations: PLAN_V2 §11.5 row G07; `expect.json` is a P0 skeleton (status "skeleton"): lane B completes locators and assertions once `ink.json` exists (lane C, P1).
- Must not: edits to the 5-cell gap.
- `gt.json` is the [M] probe's hand-labelled ground truth (v1 cell bboxes; v1 role names such as spike_strip). The written "S" in G09 is a v2 `start_marker`.
