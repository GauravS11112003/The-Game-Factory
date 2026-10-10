# Latency and model decisions (lane D)

## P0 bakeoff (2026-10-10)

`scripts/latency_bakeoff.py`, run inside `vision/` with the key from `.env`, through the real `app.mind.client.call`
(AsyncAnthropic `beta.messages.parse`, `claude-opus-5`, effort `low`, `fallbacks="default"`, frozen system prompts
from `vision/app/mind/prompts/`, prompt caching on the system block). Every request is in `model_calls`
(`draft_id = 'bakeoff_p0'`). Raw records with parsed outputs and scores: `docs/v2/evals/bakeoff_p0.json` (pass 1) and
`docs/v2/evals/bakeoff_p0_pass2.json` (pass 2).

**Spend and call count.** 16 billed calls, **$0.83** in total (cap $1.50).
- Pass 1 (`--max-usd 1.50`) sent 16 requests. The 12 PERCEIVE requests were rejected at validation with HTTP 400:
  0 tokens, $0, about 0.3 s each. The 4 DESIGN calls were billed, at $0.19.
- Pass 2 (`--only perceive --perceive-schema flat --max-calls 12 --max-usd 1.30`) used the plan's union fallback
  (§3.10, §12) and billed 12 calls, at $0.64.
- Deviation, stated plainly: the plan's "≤ 16 calls" was applied to *billed* calls. Including the 12 zero-token
  rejections, 28 requests were sent. Without the second pass, PERCEIVE could not have been measured at all.

### What was measured

| Item | Result |
|---|---|
| `AsyncAnthropic().beta.messages.parse` exists (anthropic 1.13.0) | **yes** (sync and async). Every bakeoff call went through the async client, so `client.py` uses it directly, with no worker thread. |
| `thinking: {"type": "disabled"}` at effort `low` on Opus 5 | **accepted.** The claude-api skill docs say `disabled` is allowed only at effort `high` or lower; it is a 400 at `xhigh`/`max`. With structured outputs, neither documented failure mode (tool calls emitted as text, leaked thinking tags) appeared: 8/8 disabled calls parsed. |
| Discriminated union `Perception.bindings` (10 variants) | **rejected.** HTTP 400 `invalid_request_error`: "The compiled grammar is too large, which would cause performance issues." This happened 12/12 times in pass 1, at no cost. |
| Discriminated union `DesignPlan.novel` (7 variants) | **accepted** (4/4). |
| Flat fallback `PerceptionFlat` (one `FlatBinding` with sentinel values, validated per variant by `schemas.unflatten`) | **accepted** (12/12) |
| Fast mode | **not run** (`DAL_FAST_MODE` is not 1; owner decision 1 stays off) |
| Prompt caching | Works. Repeat calls read 4,646-4,846 cached tokens: the system prompt plus the injected output schema, which is about 3.7k tokens by itself. The first call of a kind paid 6.8-7.2k uncached input tokens. |

### PERCEIVE (effort low, slim schema with flat bindings, 4 [M] scenes, n = 6 per mode)

| Mode | p50 | p90 | max | mean out tok | mean $ | role acc (lenient) | role acc ("S" → start_marker) | relations | invented ids | over the 20 s timeout |
|---|---|---|---|---|---|---|---|---|---|---|
| thinking omitted (adaptive) | **15.2 s** | 22.3 s | 23.2 s | 1,491 | 0.056 | 0.899 | 0.919 | 42/47 | 0 | **2/6** (both tower_key, 22 components) |
| thinking disabled | **13.5 s** | 16.8 s | 16.9 s | 1,271 | 0.051 | 0.919 | 0.939 | 42/47 | 0 | 0/6 |

- **Scoring note.** `gt.json` predates the v2 roles: it labels the written "S" in tower_key as `text`. Under v2 that is a
  `start_marker`, which the model chose every time and also bound with `BStart`. The second accuracy column counts
  that as correct.
- **Errors that remain:**
  - the high ledge with spikes hanging under it was read as a platform, not a ceiling (also seen in [M A]);
  - the floating green goal star was read as a coin, decoration or big_coin, at low confidence and always with an
    ask;
  - the tower's two short ledge fragments were read as decoration (low confidence) in both adaptive tower_key runs.
- **Relations** stayed at 42/47 in both modes. The misses: an arrow's `att` to its platform, a goal's `on`, and the
  paper scene's coin/arrow anchors.
- **Bindings** behaved well in both modes:
  - key_door had both ids in 4/4 tower_key runs;
  - BStart pointed at the "S";
  - the "moves" plus arrow became `move right`;
  - the monster became `enemy`.

### DESIGN (effort low, 2 hand-built menus, n = 2 per mode)

| Mode | p50 | p90 | mean out tok | mean $ | picks valid | repair choice (wobbly_cave) |
|---|---|---|---|---|---|---|
| thinking omitted | **14.9 s** (18.6 s with a cold cache, 11.1 s warm) | 17.9 s | 954 | 0.050 | 0.95 (one second pick in an `alts` group) | trim the wall 1 (cheapest; keeps the shape) |
| thinking disabled | **11.3 s** | 12.3 s | 706 | 0.044 | 1.00 | trim the wall 1 |

- **Taste was good in all 4 plans:**
  - Polished stayed gentle: checkpoint, coin trail over the run-gap, big coin, "your monster walks";
  - hard was saved for saws and crumbles;
  - both plans vetoed straightening the wavy cave floor and roof ("the wavy ground is the fun cave shape");
  - every reason was 12 words or fewer, and every designer note was 2 sentences.
- **Sanitizer findings:**
  - `DesignAsk.about` came back as free text ("o5 red text "lava!" near the pit") instead of an object id, so the
    sanitizer must map it to an id or drop it;
  - the second pick in an `alts` group must be dropped (already in the §3.10 rules).

## Adoption decisions (P0 gate rules, §11.4)

1. **Thinking disabled: NOT adopted.** The rule requires PERCEIVE role accuracy ≥ 0.93 **and** a p50 drop ≥ 30%.
   - Accuracy passed only with the start_marker correction (0.939).
   - p50 dropped only **11%** (15.2 s → 13.5 s).
   - Every runtime call keeps thinking omitted (adaptive, the Opus 5 default). `CallSpec.thinking` stays `None`.
2. **DESIGN at low: NOT kept as the synchronous designer.** The rule requires p50 ≤ 10 s and ≥ 75% of picks valid.
   - Picks were valid (0.95).
   - p50 was **14.9 s**, with one call at 18.6 s, over the 15 s timeout.
   - Per the rule, **DESIGN runs at medium on the async suggestions path only, and the greedy tiers are the synchronous
     Designed result.**
   - Recorded in `vision/app/mind/client.py`: `DESIGN_SYNCHRONOUS = False`, `CALLS["design"] = medium / 8000 / 45 s`.
   - Recorded in `web/src/core/params.ts` `MODEL.calls.design` (→ `shared/spec/params.json`).
   - Contract note in `docs/v2/CONTRACTS.md`: model picks reach the client as `suggestions` events, and the
     `designed` tiers are greedy.
3. **PERCEIVE output schema: flat bindings.** The 10-variant `Binding` union is rejected by the API.
   - `vision/app/mind/schemas.py` keeps the §3.10 union classes for typing. It sends `PerceptionFlat`
     (`SCHEMAS["perceive"]`).
   - `unflatten()` re-validates each binding as its typed variant. A key without a door yields `None`, which becomes
     an Ask card, never a silent coin.
   - The wire contract to the core (`PerceptionJson` in `vision/app/spec/api.py`) is unchanged: it keeps the
     discriminated union.
4. **Async client: adopted.** `client.py` awaits `AsyncAnthropic().beta.messages.parse`, with no thread hop.
5. **Fast mode: not measured.** It stays off; this is owner decision 1, and `DAL_FAST_MODE` was not set.

## Risks raised for P2/P3

- **PERCEIVE p50 is ≈ 15 s, not the planned 10 s, and p90 is ≈ 22 s.**
  - Large tiles (22 components) exceed the 20 s timeout 1 time in 3 with adaptive thinking.
  - Mean output is about 1.5k tokens; the plan assumed ≈ 0.9k.
  - Levers, cheapest first:
    - split tiles to fewer components;
    - shorter enums in `Node` (for example, drop `face` when `att` is null);
    - let the heuristic pin high-confidence components so PERCEIVE skips them;
    - reconsider the timeout. `bench_build.py` must confirm "Understood p50 ≤ 15 s" in P2.
- **Cost.**
  - PERCEIVE ≈ $0.04-0.08 per tile: cold-cache calls cost more because the output schema adds about 3.7k input
    tokens.
  - DESIGN at medium will cost more than the $0.05 low estimate; [M] measured ≈ $0.07 at medium.
  - The 1-screen Polished gate of ≤ $0.12 still looks reachable, because DESIGN is async and skippable on budget.
- **Ground truth.** The [M] `gt.json` files predate v2 roles (start_marker, pole). Relabel them when the goldens'
  `expect.json` files are finalized (lane B).

## Budgets this file tracks (from PLAN_V2 §3.13 / §11.7)

| Gate | Target | Status |
|---|---|---|
| canvas Ink build p50 | ≤ 0.6 s | P1 (core not built yet) |
| paper Ink build p50 / p95 | ≤ 3 s / ≤ 8 s | P2 |
| Understood p50 | ≤ 15 s | at risk: PERCEIVE alone is ≈ 15.2 s p50 (above) |
| Designed p90 | ≤ 25 s | now greedy-synchronous; the model plan is async suggestions |
| dial swap | < 100 ms | P3 |
| L4 at ≥ 55 fps (Chrome DPR 2, 4× CPU throttle proxy) | P4 | - |
