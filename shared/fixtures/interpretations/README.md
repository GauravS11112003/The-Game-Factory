# Fake vision-model outputs

When `DAL_FAKE_LLM=1`, or when `ANTHROPIC_API_KEY` is unset (fake mode turns
on automatically), `vision/app/llm/interpret.py` does not call the model. It
answers from this folder instead:

1. Compute `sha1` of the **annotated image bytes** (`CVResult.annotated_path`,
   the JPEG with magenta component numbers that the model would have seen).
   `interpret()` only receives the CVResult, so this is the one image it can
   hash deterministically.
2. If `<sha1 hex>.json` exists here, return it.
3. Otherwise run the rule-based `vision/app/llm/heuristic.py` over the typed
   prompt, if any. With no typed prompt that is an empty `Interpretation`
   (the same as `default.json`, which is kept as documentation of the shape).

In both fake and live mode a typed prompt (canvas / prompt path) is also read
by the heuristic and merged in; the model's (or fixture's) bindings win on a
per-component conflict.

Each file is a JSON document matching the `Interpretation` Pydantic model in
`vision/app/models.py`:

```json
{
  "title": "Lava Cave",
  "annotation_component_ids": [7],
  "bindings": [
    { "component_id": 3, "behavior": "move", "params": { "dx": 10, "speed": 2 } },
    { "component_id": 5, "behavior": "patrol", "params": { "dx": 6, "speed": 3 } },
    { "component_id": 8, "behavior": "key", "params": { "opens_component_id": 9 } },
    { "component_id": 9, "behavior": "door", "params": {} }
  ],
  "timer_seconds": null,
  "notes_transcript": "the platform moves right. door opens with key",
  "safety_ok": true,
  "safety_reason": null
}
```

Component ids are in the level's id space: in a remix the parent's components
keep their ids and the newly scanned ones follow the parent's highest id
(`app.compile.remix_offset`). Without a parent they equal the magenta numbers.

To add a rehearsal answer for a real photo, scan it once with `?debug=1`
(or `python -m vision.cli photo.jpg --debug ./dbg`) to get `annotated.jpg`:

```
shasum dbg/annotated.jpg
cp my_interpretation.json shared/fixtures/interpretations/<sha1>.json
```

The synthetic cases in `../cvresults/` get their hashed files written by
`../cvresults/make_cvresults.py` (`hashes.json` there tracks them).
