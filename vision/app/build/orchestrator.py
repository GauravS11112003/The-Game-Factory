"""The staged build orchestrator (PLAN_V2 §1.1, §3.8, §3.11-3.13): Ink → Understood → Designed.

    t=0     hello, stage(ink start)             [paper: stage(upload done), stage(cv start/done) first]
            perceive_heuristic → graph0, ink event; typed rules → keyword parser (offline floor)
            PERCEIVE per tile starts now, in parallel, effort low (skipped at $0 when every component is pinned)
            build(faithful) ‖ build_tiers → saw, edits, 4× tier(ink), stage(ink done)          ≤ 0.6 s canvas
            speculative DESIGN #1 on the Ink menu, in parallel with PERCEIVE                     ≈ 2 s
    ≈11 s   PERCEIVE done → merge_perception (worker) → perception edits, asks, setpieces
            build_tiers(G0 + perception + kid edits) → edits, saw, 4× tier(understood), asks, stage(understood done)
    ≈13 s   Designed: transfer the speculative plan to the Understood menu by stable cid (≥ 70% and no route or
            setpiece role changed → apply it), else DESIGN #2 (only if t < 14 s), then REFINE (≤ 1 round, t < 20 s),
            → edits, 4× tier(designed), note, stage(designed done)
    25 s    hard deadline: the greedy tiers ship; a plan still in flight gives stage(design late) and arrives
            later as `suggestions` (validated by the core's applyPlan first), then `done`.

The P0 bakeoff made DESIGN asynchronous (`client.DESIGN_SYNCHRONOUS = False`, docs/v2/latency.md): the Designed
tiers never wait for the model. A speculative plan that is already back when Understood lands is still applied
(transfer ≥ 70%); otherwise the greedy tiers are the Designed result and the model's validated picks arrive as
`suggestions`. With `DESIGN_SYNCHRONOUS = True` the orchestrator waits for DESIGN up to the 25 s deadline.

Fallbacks (§3.12): no key / fake without a recorded reply / over budget → heuristic perception, keyword parser and
greedy tiers; PERCEIVE timeout, error, max_tokens or > 30% invalid nodes → the Ink graph stands
(`warning looked_closer_skipped`); a refusal additionally holds the draft (`safety: held`); a worker crash is
restarted and retried once by the bridge, otherwise `error.worker_down`. Every outcome ends with `done`.

Every core call goes through the worker bridge (`app.build.bridge.CorePool`); the orchestrator never builds
levels itself.
"""
from __future__ import annotations

import asyncio
import copy
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Literal

from app import db_v2
from app.build import drafts, present
from app.build.bridge import RPC_TIMEOUTS_S, TIERS_SLACK_S, CoreError, get_pool
from app.build.events import EventSink
from app.config import get_settings_v2
from app.mind import client, messages, render, sanitize
from app.mind import critic as mcritic
from app.mind import design as mdesign
from app.mind import digest as mdigest
from app.mind import perceive as mperceive
from app.mind.client import MindResult

log = logging.getLogger("dal.v2.orchestrator")

TIERS = drafts.TIERS
PERCEIVE_RESERVE_S = 3.0  # PERCEIVE must leave this much of the 25 s for the Understood build and Designed
LATE_CAP_S = 75.0  # late model work (suggestions) after this is cancelled and the build ends
ASYNC_DESIGN_HORIZON_S = 70.0  # deadline (from submit) for a DESIGN call whose answer can only become suggestions
APPLY_TIMEOUT_S = RPC_TIMEOUTS_S.get("apply_plan", 20)
TIERS_DEADLINE_MS = 3000  # greedy tiers ≤ 3 s (params DESIGN.greedy.max_s)
MERGE_TIMEOUT_S = 2.0


def _p(section: str) -> dict[str, Any]:
    return dict(sanitize.params().get(section) or {})


def design_params() -> dict[str, Any]:
    d = {"transfer_ok_ratio": 0.7, "design2_cutoff_s": 14, "deadline_s": 25,
         "refine": {"max_rounds": 1, "cutoff_s": 20, "rejected_frac": 0.3},
         "budgets": {"polished_P_per_screen": 2, "polished_tune": 4, "challenging_C_per_screen": 4},
         "greedy": {"max_s": 3}}
    d.update(_p("DESIGN"))
    return d


def dial_params() -> dict[str, Any]:
    d = {"polished": {"C_min": 0.1, "C_raise_max": 0.3, "max_F_s": 30}, "normal": {"C": [0.3, 1.0], "aim": 0.6},
         "hard": {"C": [1.0, 3.0], "aim": 1.8}}
    d.update(_p("DIAL"))
    return d


def default_rules() -> dict[str, Any]:
    from app.spec.rules import GameRules

    return GameRules(version=1).model_dump(mode="json")


@dataclass
class BuildRequest:
    build_id: str
    draft_id: str
    kind: Literal["canvas", "paper", "prompt", "redesign", "critic"] = "canvas"
    ink: dict[str, Any] | None = None
    photos: list[bytes] = field(default_factory=list)
    typed_rules: list[dict[str, Any]] = field(default_factory=list)
    parent_id: str | None = None
    game_id: str | None = None
    pack_id: str | None = None
    dial: str = "polished"
    band: str | None = None
    telemetry: dict[str, Any] | None = None
    prompt: str | None = None  # kind "prompt" (§8.3)
    screens: int = 1  # kind "prompt": the requested length


def _crop_sketch(sheet_jpg: Path, out: Path) -> bool:
    """The rectified sheet's drawing area (exactly one screen, 48 × 27 cells) as its own JPEG, for the "My original
    sketch" underlay (§7.2, E-2). False when lane C's template geometry or OpenCV is unavailable."""
    try:
        import cv2  # type: ignore[import-not-found]

        from app.template import spec_v2  # type: ignore[import-not-found]  # lane C

        img = cv2.imread(str(sheet_jpg), cv2.IMREAD_COLOR)
        if img is None:
            return False
        ax, ay, aw, ah = (int(v) for v in spec_v2.drawing_area_px())
        h, w = img.shape[:2]
        x0, y0, x1, y1 = max(0, ax), max(0, ay), min(w, ax + aw), min(h, ay + ah)
        if x1 - x0 < 48 or y1 - y0 < 27:
            return False
        crop = img[y0:y1, x0:x1]
        long_edge = max(crop.shape[:2])
        if long_edge > 2048:  # 48 cells at ≈ 42 px is plenty for a 15 % underlay
            k = 2048 / long_edge
            crop = cv2.resize(crop, (int(crop.shape[1] * k), int(crop.shape[0] * k)), interpolation=cv2.INTER_AREA)
        return bool(cv2.imwrite(str(out), crop, [cv2.IMWRITE_JPEG_QUALITY, 85]))
    except Exception as e:  # noqa: BLE001 - the underlay is optional
        log.info("sketch crop failed: %s", e)
        return False


def _as_dict(x: Any) -> Any:
    if x is None or isinstance(x, (dict, list, str, int, float, bool)):
        return x
    if hasattr(x, "model_dump"):
        return x.model_dump(mode="json", by_alias=True)
    if hasattr(x, "__dataclass_fields__"):
        from dataclasses import asdict

        return asdict(x)
    return x


_WORD = re.compile(r"[a-z0-9]{2,}")


def _covers(rule_text: str, evidence: str) -> bool:
    """Whether a model binding's evidence answers a typed sentence (≥ 50% of the sentence's words)."""
    a = set(_WORD.findall(rule_text.lower()))
    b = set(_WORD.findall(evidence.lower()))
    if not a:
        return False
    return len(a & b) / len(a) >= 0.5 or rule_text.lower().strip() in evidence.lower()


# ---- design asks → AskCards ------------------------------------------------------------------------------


def design_ask_card(a: dict[str, Any], tierset: dict[str, Any] | None) -> dict[str, Any]:
    about, kind = a["about"], a["kind"]
    opts: list[dict[str, Any]]
    if kind == "is_door":
        opts = [{"id": "yes", "label_key": "ask.option.yes", "ops": [{"op": "set_role", "target": about, "role": "door"}]},
                {"id": "no", "label_key": "ask.option.no", "ops": []}]
        default = "no"
    elif kind == "which_way":
        opts = [{"id": d, "label_key": f"ask.option.{d}",
                 "ops": [{"op": "fix_behavior", "target": about, "param": "dir", "value": d}]}
                for d in ("left", "right", "up", "down")]
        default = None
    else:  # keep_or_fix
        undo = {}
        for t in TIERS:
            for e in ((tierset or {}).get(t) or {}).get("edits") or []:
                if e.get("class") == "N" and not e.get("required") and present.op_target(e.get("op") or {}) == about:
                    undo[e["id"]] = "undone"
        opts = [{"id": "keep", "label_key": "ask.option.keep", "ops": [], "x_statuses": undo},
                {"id": "fix", "label_key": "ask.option.fix", "ops": []}]
        default = "fix"
    for o in opts:
        o.setdefault("label_args", {})
        o.setdefault("tap_target", False)
    return {"id": f"ask_{about}_{kind}", "about": about, "kind": kind, "message_key": f"ask.{kind}", "args": {},
            "options": opts, "default_option": default, "answer": None, "by": "designer"}


# ---- the run ---------------------------------------------------------------------------------------------


class Run:
    def __init__(self, req: BuildRequest, sink: EventSink) -> None:
        self.req = req
        self.sink = sink
        self.id = req.draft_id
        self.t0 = time.monotonic()
        self.settings = get_settings_v2()
        self.mode = client.mode()
        self.deadline = self.t0 + float(self.settings.design_deadline_s)
        self.final_stage = "ink"
        self.late: list[asyncio.Task[Any]] = []
        self.owned: list[asyncio.Task[Any]] = []  # every model task this run started; cancelled when it ends
        self.warned: set[str] = set()
        self.state = drafts.load_state(self.id) or drafts.new_state(self.id, req.kind)
        self.ink: dict[str, Any] = {}
        self.graph0: dict[str, Any] = {}
        self.parent_level: dict[str, Any] | None = drafts.read_json(self.id, "parent.json") if drafts.exists(self.id) else None
        self.library: list[dict[str, Any]] = (drafts.read_json(self.id, "library.json") or []) if drafts.exists(self.id) else []

    # ---- plumbing ------------------------------------------------------------------------------

    def t_ms(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    def elapsed(self) -> float:
        return time.monotonic() - self.t0

    def emit(self, event: str, data: dict[str, Any]) -> int:
        return self.sink.emit(event, data)

    def stage(self, name: str, status: str, note_key: str | None = None) -> None:
        d: dict[str, Any] = {"stage": name, "status": status, "t_ms": self.t_ms()}
        if note_key:
            d["note_key"] = note_key
        self.emit("stage", d)

    def warn(self, key: str, args: dict[str, Any] | None = None, once: bool = True) -> None:
        if once and key in self.warned:
            return
        self.warned.add(key)
        self.emit("warning", {"message_key": key, "args": args or {}})
        self.mutate(lambda s: s["warnings"].append({"key": key, "args": args or {}})
                    if {"key": key, "args": args or {}} not in s["warnings"] else None)

    def mutate(self, fn: Callable[[dict[str, Any]], Any]) -> None:
        """Load the freshest state, apply `fn`, save (no await in between, so it is atomic in the event loop)."""
        s = drafts.load_state(self.id) or self.state
        fn(s)
        drafts.save_state(self.id, s)
        self.state = s

    def model_on(self) -> bool:
        return self.mode != "off"

    async def rpc(self, method: str, params: dict[str, Any], timeout_s: float | None = None) -> Any:
        pool = get_pool()
        if pool is None:
            raise CoreError("down", "the core worker pool is not running")
        return await pool.call(method, params, timeout_s)

    def record(self, r: MindResult[Any]) -> None:
        if r.status == "skipped":
            if r.error == "budget":
                self.warn("warning.budget_resting")
            return

        def f(s: dict[str, Any]) -> None:
            c = s["cost"]
            c["usd"] = round(float(c.get("usd", 0)) + r.cost_usd, 5)
            c["calls"] = int(c.get("calls", 0)) + 1
            c["by_kind"][r.kind] = round(float(c["by_kind"].get(r.kind, 0)) + r.cost_usd, 5)
            s["model_calls"].append(client.call_meta(r))

        self.mutate(f)
        c = self.state["cost"]
        self.emit("cost", {"usd": c["usd"], "calls": c["calls"], "by_kind": dict(c["by_kind"])})

    # ---- inputs --------------------------------------------------------------------------------

    def rules(self) -> dict[str, Any]:
        return self.state.get("rules") or default_rules()

    def base_input(self, edits: list[dict[str, Any]]) -> dict[str, Any]:
        return {"ink": self.ink, "graph0": graph_for_build(self.graph0, self.state), "edits": edits, "rules": self.rules(),
                "library": self.library, "parent": self.parent_level,
                "repairUnsolvable": True, "seed": int(self.state.get("seed") or 1)}

    def intent_edits(self, *, understood: bool) -> list[dict[str, Any]]:
        """The edits that state what the level IS (U-edits from perception, parser and kid; K edits; accepted
        suggestions) plus every record whose status the kid toggled. The core regenerates N/R and greedy P/C
        edits itself and honours the statuses by stable id."""
        known = drafts.read_json(self.id, "edits.json") if self.state.get("statuses") else None
        return intent_edits(self.state, understood=understood, known=known)

    async def tiers(self, edits: list[dict[str, Any]]) -> dict[str, Any]:
        params = {**self.base_input(edits), "deadlineMs": TIERS_DEADLINE_MS}
        if self.state.get("band"):
            params["band"] = self.state["band"]
        return await self.rpc("build_tiers", params, TIERS_DEADLINE_MS / 1000 + TIERS_SLACK_S)

    def emit_tiers(self, stage: str, ts: dict[str, Any], prev: dict[str, Any] | None,
                   only: tuple[str, ...] = TIERS) -> None:
        reach = ts.get("reach") or {}
        for t in only:
            if t not in ts:
                continue
            self.emit("tier", present.tier_payload(
                stage, t, ts[t], draft_id=self.id, reach=True if t == "faithful" else reach.get(t, True),
                morphs_=present.morphs((prev or {}).get(t), ts[t], self.ink)))

    def emit_asks(self, cards: list[dict[str, Any]]) -> None:
        known = {a["id"] for a in self.state.get("asks") or []}
        new = [a for a in cards if isinstance(a, dict) and a.get("id") and a["id"] not in known]
        if not new:
            return
        self.mutate(lambda s: s["asks"].extend(new))
        for a in new:
            self.emit("ask", {"ask": a})

    def save_stage(self, stage: str, ts: dict[str, Any]) -> None:
        drafts.save_tierset(self.id, stage, ts)
        drafts.save_tierset(self.id, "current", ts)
        summ = present.summary(ts)

        def f(s: dict[str, Any]) -> None:
            s["stage"] = stage
            s["current"] = {"stage": stage, **summ}
            s["stages"] = [x for x in s["stages"] if x.get("stage") != stage] + [{"stage": stage, "t_ms": self.t_ms()}]

        self.mutate(f)
        drafts.write_json(self.id, "edits.json", present.edits_union(ts, self.intent_edits(understood=True)))

    def images(self) -> list[bytes]:
        """DESIGN images: the sheet photos for paper (resized), the rendered drawing otherwise."""
        out: list[bytes] = []
        if self.ink.get("source") == "paper":
            for sh in sorted(self.ink.get("sheets") or [], key=lambda x: x.get("index", 0)):
                p = drafts.draft_dir(self.id) / "sheets" / f"{int(sh.get('index', 0)) + 1}.jpg"
                if p.exists():
                    out.append(render.resize_photo(p.read_bytes()))
        return out or render.drawing_images(self.ink)

    async def make_digest(self, ts: dict[str, Any], *, menu: list[dict[str, Any]] | None = None,
                          base_tier: str = "faithful") -> mdigest.DesignDigest:
        m = menu if menu is not None else ts.get("menu") or []
        try:
            rpc = await self.rpc("digest", {"result": ts.get(base_tier) or ts["faithful"], "menu": m})
        except CoreError as e:
            log.info("digest RPC failed (%s); using the Python digest", e)
            rpc = None
        undone = {k for k, v in (self.state.get("statuses") or {}).items() if v == "undone"}
        return mdigest.build_digest(rpc, ts, base_tier=base_tier, undone=undone, band=self.state.get("band"), menu=m)

    def design_ctx(self, deadline: float, note: str = "") -> mdesign.DesignCtx:
        return mdesign.DesignCtx(draft_id=self.id, deadline=deadline, dial=dial_params(), design=design_params(), note=note)

    async def design_call(self, ts: dict[str, Any], deadline: float, note: str = "") -> mdesign.PlanOut:
        dig = await self.make_digest(ts)
        out = await mdesign.design(dig, self.images(), self.design_ctx(deadline, note))
        self.record(out.result)
        if out.plan is not None:
            self.save_plan(out.plan, "design")
        return out

    def save_plan(self, plan: dict[str, Any], source: str) -> None:
        def f(s: dict[str, Any]) -> None:
            s["plans"] = int(s.get("plans", 0)) + 1
        self.mutate(f)
        drafts.write_json(self.id, f"plans/{self.state['plans']}.json", {"source": source, "plan": plan})

    async def transfer(self, plan: dict[str, Any], old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any] | None:
        """§3.8 pick transfer by stable cid: kept when ≥ 70% transfers and no route or setpiece role changed."""
        try:
            tr = await self.rpc("transfer_plan", {"plan": plan, "oldMenu": old.get("menu") or [],
                                                  "newMenu": new.get("menu") or [],
                                                  "oldGraph": (old.get("faithful") or {}).get("graph") or self.graph0,
                                                  "newGraph": (new.get("faithful") or {}).get("graph") or self.graph0})
        except CoreError as e:
            log.info("transfer_plan failed: %s", e)
            return None
        ratio = float(tr.get("ratio", 0) or 0)
        changed = bool(tr.get("routeRolesChanged", False))
        self.mutate(lambda s: s.__setitem__("transfer", {"ratio": round(ratio, 3), "routeRolesChanged": changed}))
        if ratio >= float(design_params().get("transfer_ok_ratio", 0.7)) and not changed:
            return tr.get("plan") or plan
        return None

    async def apply(self, plan: dict[str, Any], base: dict[str, Any], edits: list[dict[str, Any]]) -> dict[str, Any] | None:
        try:
            res = await self.rpc("apply_plan", {"input": self.base_input(edits), "menu": base.get("menu") or [],
                                                "plan": plan}, APPLY_TIMEOUT_S)
        except CoreError as e:
            log.info("apply_plan failed: %s", e)
            return None
        return res if isinstance(res, dict) and all(t in res for t in TIERS) else None

    async def refine_round(self, plan: dict[str, Any], applied: dict[str, Any], edits: list[dict[str, Any]],
                           deadline: float) -> tuple[dict[str, Any], dict[str, Any]] | None:
        """One REFINE round when Normal or Hard misses its band or > 30% of picks were rejected."""
        dp = design_params().get("refine") or {}
        missed = mdigest.band_missed(applied, dial_params())
        rejected = {r.get("cid") for r in applied.get("rejected") or [] if r.get("cid")}
        frac = len(rejected) / max(1, len(plan.get("picks") or []))
        if not missed and frac <= float(dp.get("rejected_frac", 0.3)):
            return None
        if not self.model_on():
            return None
        dig = await self.make_digest(applied)
        self.stage("refine", "start")
        out = await mdesign.refine(dig, plan, mdesign.deltas_text(plan, applied), self.design_ctx(deadline), rejected)
        self.record(out.result)
        if out.plan is None or not (out.plan.get("picks") or out.plan.get("novel")):
            self.stage("refine", "done" if out.result.ok else "failed")
            return None
        merged = sanitize.merge_plans(plan, out.plan)
        again = await self.apply(merged, applied, edits)
        self.stage("refine", "done" if again else "failed")
        if again is None:
            return None
        self.save_plan(merged, "refine")
        return merged, again

    def suggestions_from(self, model_ts: dict[str, Any], greedy_ts: dict[str, Any], plan: dict[str, Any]) -> list[dict[str, Any]]:
        """Edits the validated model plan adds over the greedy tiers, as `suggested` records with the model's
        reasons attached (by cid)."""
        greedy_ids = {e["id"] for t in TIERS for e in (greedy_ts.get(t) or {}).get("edits") or []
                      if e.get("status") == "applied"}
        reasons = {p["cid"]: p.get("reason") for p in plan.get("picks") or []}
        out: dict[str, dict[str, Any]] = {}
        for t in TIERS:
            for e in (model_ts.get(t) or {}).get("edits") or []:
                if e.get("status") != "applied" or e["id"] in greedy_ids or e["id"] in out:
                    continue
                if e.get("class") not in ("P", "C", "R"):
                    continue
                r = copy.deepcopy(e)
                r["status"] = "suggested"
                r["by"] = "model"
                r["tier"] = t if r.get("tier") in (None, "faithful") else r["tier"]
                cid = r.get("cid") or r["id"]
                if reasons.get(cid) and not r.get("reason_text"):
                    r["reason_text"] = reasons[cid]
                out[e["id"]] = r
        return list(out.values())

    def offer(self, records: list[dict[str, Any]], source: str) -> None:
        if not records:
            return

        def f(s: dict[str, Any]) -> None:
            have = {e["id"] for e in s["edits"]["suggestions"]}
            s["edits"]["suggestions"].extend(e for e in records if e["id"] not in have)

        self.mutate(f)
        self.emit("suggestions", {"edits": records, "source": source})

    def note(self, plan: dict[str, Any] | None, source: str, ts: dict[str, Any] | None = None) -> None:
        if plan is not None and source == "model":
            n = {"designer_note": plan.get("designer_note") or "", "critique": list(plan.get("critique") or []),
                 "title_suggestion": plan.get("title") or self.state.get("title"), "source": "model"}
        else:
            key = "note.greedy"
            pol = (ts or {}).get("polished") or {}
            if any(e.get("op", {}).get("op") == "add_checkpoint" and e.get("status") == "applied"
                   for e in pol.get("edits") or []):
                key = "note.greedy_checkpoint"
            n = {"designer_note": messages.say(key), "critique": [], "title_suggestion": self.state.get("title"),
                 "source": "greedy"}
        self.mutate(lambda s: s.__setitem__("note", n))
        self.emit("note", n)

    # ---- entry ---------------------------------------------------------------------------------

    async def run(self) -> None:
        try:
            if self.req.kind in ("canvas", "paper", "prompt"):
                await self.full()
            elif self.req.kind == "redesign":
                await self.redesign()
            elif self.req.kind == "critic":
                await self.critic()
            else:
                self.hello()
                self.emit("error", {"message_key": "error.not_implemented", "args": {"route": self.req.kind}, "fatal": True})
        except CoreError as e:
            log.warning("build %s: core %s", self.req.build_id, e)
            key = "error.worker_down" if e.code in ("down", "timeout") else "error.build_failed"
            self.emit("error", {"message_key": key, "args": {"why": e.code}, "fatal": True})
        except asyncio.CancelledError:
            self._finish()
            raise
        except Exception as e:  # noqa: BLE001 - a failed build is an event, never a crash
            log.exception("build %s failed", self.req.build_id)
            self.emit("error", {"message_key": "error.build_failed", "args": {"why": type(e).__name__}, "fatal": True})
        self._finish()

    def task(self, coro: Any) -> asyncio.Task[Any]:
        t = asyncio.create_task(coro)
        self.owned.append(t)
        return t

    def _finish(self) -> None:
        for t in self.late + self.owned:
            if not t.done():
                t.cancel()
        if not self.sink.closed():
            self.emit("done", {"final_stage": self.final_stage, "total_ms": self.t_ms()})
        try:
            db_v2.finish_build(self.req.build_id, self.final_stage, float(self.state.get("cost", {}).get("usd", 0)))
        except Exception as e:  # noqa: BLE001
            log.warning("finish_build: %s", e)

    def hello(self) -> None:
        pool = get_pool()
        self.emit("hello", {"build_id": self.req.build_id, "draft_id": self.id, "version": 1,
                            "core_version": (pool.core_version if pool else None) or "unknown", "model": self.mode})

    # ---- the full build (canvas / paper) ----------------------------------------------------------

    async def full(self) -> None:
        req = self.req
        self.mutate(lambda s: s.update({"model": self.mode, "dial": req.dial, "band": req.band,
                                        "builds": s["builds"] + [req.build_id]}))
        self.hello()
        await self.load_context()
        if req.kind == "paper":
            ink = await self.scan()
            if ink is None:
                return
        elif req.kind == "prompt":
            from app.build import prompt_flow

            ink = await prompt_flow.draft_ink(self)
            if ink is None:
                return
        else:
            ink = copy.deepcopy(req.ink or {})
        self.ink = merge_typed_rules(ink, req.typed_rules)
        if self.parent_level and not self.ink.get("parent"):
            pl = self.parent_level
            self.ink["parent"] = {"level_id": pl.get("id"), "version": pl.get("version", 1),
                                  "level_hash": (pl.get("meta") or {}).get("level_hash", "")}
        drafts.write_json(self.id, "ink.json", self.ink)

        # ---- ① Ink ----
        self.stage("ink", "start")
        # PERCEIVE needs only the ink, so it starts first and runs while the core builds (≈ t 0.3 s, §3.13)
        # a prompt draft's strokes carry their roles at confidence 1.0: perception is exact, PERCEIVE is skipped (§8.3)
        tiles = mperceive.plan_tiles(self.ink) if self.model_on() and req.kind != "prompt" else []
        perceive_tasks = self.start_perceive(tiles)
        g = await self.rpc("perceive_heuristic", {"ink": self.ink, "library": self.library, "parent": self.parent_level})
        self.graph0 = g.get("graph") if isinstance(g, dict) and "graph" in g else g
        drafts.write_json(self.id, "graph0.json", self.graph0)
        self.emit("ink", {"ink": self.ink, "graph0": self.graph0})
        noise = int((self.ink.get("noise") or {}).get("count", 0) or 0)
        if noise:
            self.warn("warning.specks_ignored", {"n": noise})
        if not perceive_tasks:
            self.stage("perceive", "skipped", "warning.model_offline" if not self.model_on() else None)
            if not self.model_on():
                self.warn("warning.model_offline")
            elif req.kind != "prompt":  # every component pinned by stamps or chips: the model has nothing to read
                self.mutate(lambda s: s.__setitem__("perceive_ran", False))
        await self.parse_typed_rules()

        edits0 = self.intent_edits(understood=False)
        faithful_t = self.task(self.rpc("build", {**self.base_input(edits0), "tier": "faithful"}))
        tiers_t = self.task(self.tiers(edits0))
        try:
            faithful = await faithful_t
        except CoreError:
            faithful = None
        if faithful is not None:
            self.emit("saw", {"items": present.saw_items(faithful.get("graph") or self.graph0, self.ink), "stage": "ink"})
            self.emit("edits", {"edits": present.edits_union({"faithful": faithful}, edits0)})
            self.emit_tiers("ink", {"faithful": faithful, "reach": {}}, None, only=("faithful",))
        ink_ts = await tiers_t  # a CoreError here is fatal: there is no playable level without the core
        if faithful is None:
            self.emit("saw", {"items": present.saw_items(ink_ts["faithful"].get("graph") or self.graph0, self.ink),
                              "stage": "ink"})
        self.emit("edits", {"edits": present.edits_union(ink_ts, edits0)})
        self.emit_tiers("ink", ink_ts, None, only=("polished", "normal", "hard") if faithful is not None else TIERS)
        self.save_stage("ink", ink_ts)
        self.final_stage = "ink"
        self.stage("ink", "done")
        self.emit_asks(list(self.state.get("parser_asks") or []))

        # speculative DESIGN #1 on the Ink menu, in parallel with PERCEIVE (D9)
        design1: asyncio.Task[mdesign.PlanOut] | None = None
        if self.model_on() and self.settings.speculative_design and ink_ts.get("menu"):
            horizon = self.deadline - 1 if client.DESIGN_SYNCHRONOUS else self.t0 + ASYNC_DESIGN_HORIZON_S
            self.stage("design", "start", "stage.design")
            design1 = self.task(self.design_call(
                ink_ts, horizon, note="speculative: computed on the quick look; ids are stable across re-reads"))

        # ---- ② Understood ----
        base_ts, base_stage = ink_ts, "ink"
        if perceive_tasks:
            und = await self.understood(perceive_tasks, ink_ts)
            if und is not None:
                base_ts, base_stage = und, "understood"
            else:
                await self.offline_asks()
        else:
            self.stage("understood", "skipped")
            await self.offline_asks()

        # ---- ③ Designed ----
        await self.designed(base_ts, base_stage, ink_ts, design1)
        await self.drain_late()

    async def offline_asks(self) -> None:
        """No model reading (off, over budget, failed): the heuristic perceiver's own questions ("Is this grass
        or spikes?", "Is this right?"), as `merge_perception(perceptions=[])` returns them (CONTRACTS §3.10)."""
        try:
            merged = await self.rpc("merge_perception", {"graph0": self.graph0, "perceptions": [], "ink": self.ink,
                                                         "library": self.library},
                                    MERGE_TIMEOUT_S)
        except CoreError as e:
            log.info("heuristic asks failed: %s", e)
            return
        self.emit_asks([a for a in (merged or {}).get("asks") or [] if isinstance(a, dict)])

    async def load_context(self) -> None:
        req = self.req
        rules, library, parent_level = None, [], None
        if req.game_id:
            game = db_v2.get_game(req.game_id)
            rules = (game or {}).get("rules")
            library = load_library(req.game_id)
        if req.parent_id:
            row = db_v2.get_level_row(req.parent_id)
            parent_level = (row or {}).get("level")
            if rules is None and parent_level:
                rules = parent_level.get("rules")
        self.parent_level, self.library = parent_level, library
        drafts.write_json(self.id, "parent.json", parent_level)
        drafts.write_json(self.id, "library.json", library)
        self.mutate(lambda s: s.update({"rules": rules or default_rules(), "game_id": req.game_id,
                                        "parent_id": req.parent_id, "pack_id": req.pack_id,
                                        "library_types": [{"type_id": t.get("id"), "version": t.get("version")}
                                                          for t in library]}))

    async def scan(self) -> dict[str, Any] | None:
        """Paper: lane C's `run_scan_v2` (sheets in parallel, any photo order) → one InkDoc. The rectified sheet n
        is kept as sheets/<n>.jpg (1-based, as SheetInfo.photo_url names it); the raw uploads as sheets/photo<i>.jpg."""
        req = self.req
        self.stage("upload", "done")
        for i, data in enumerate(req.photos):
            ext = "png" if render.media_type(data) == "image/png" else "jpg"
            drafts.write_bytes(self.id, f"sheets/photo{i}.{ext}", data)
        self.stage("cv", "start", "stage.cv")
        try:
            from app.cv import scan_v2  # type: ignore[import-not-found]  # lane C
        except Exception as e:  # noqa: BLE001
            log.warning("paper scan unavailable: %s", e)
            self.stage("cv", "failed")
            self.emit("error", {"message_key": "error.build_failed", "args": {"why": "scan_unavailable"}, "fatal": True})
            return None
        pack = pack_info(scan_v2, req.pack_id) if req.pack_id else None
        try:
            scan = await asyncio.to_thread(
                scan_v2.run_scan_v2, list(req.photos), pack, drafts.draft_dir(self.id) / "cv",
                pack_lookup=lambda pid: pack_info(scan_v2, pid), parent=self.parent_level,
                parent_lookup=lambda lid: (db_v2.get_level_row(lid) or {}).get("level"))
        except Exception as e:  # noqa: BLE001 - ScanV2Error carries the kid-facing message
            log.info("scan failed: %s", e)
            msg = _as_dict(getattr(e, "message", None))
            key = msg.get("key") if isinstance(msg, dict) and msg.get("key") else "error.no_drawing"
            # No printed template in the photo (a drawing on plain paper, a whiteboard, a screenshot of a game):
            # read the whole picture as a drawing instead of giving up.
            if key == "error.paper_missing" and len(req.photos) == 1:
                free = await self.scan_free_picture(req.photos[0])
                if free is not None:
                    return free
            self.stage("cv", "failed")
            self.emit("error", {"message_key": key, "args": (msg or {}).get("args") or {}, "fatal": True})
            return None
        ink = _as_dict(getattr(scan, "ink", None))
        if not isinstance(ink, dict) or not ink.get("strokes"):
            self.stage("cv", "failed")
            self.emit("error", {"message_key": "error.no_drawing", "args": {}, "fatal": True})
            return None
        for key, path in (getattr(scan, "files", None) or {}).items():
            kind, _, n = str(key).partition(":")
            if kind == "sheet" and n.isdigit():
                try:
                    drafts.write_bytes(self.id, f"sheets/{n}.jpg", Path(path).read_bytes())
                except OSError as err:
                    log.info("sheet image %s: %s", key, err)
        for sh in ink.get("sheets") or []:
            n = int(sh.get("index", 0)) + 1
            sheet_path = drafts.draft_dir(self.id) / "sheets" / f"{n}.jpg"
            if sheet_path.exists():
                sh["photo_url"] = f"/uploads/drafts/{self.id}/sheets/{n}.jpg"
                if await asyncio.to_thread(_crop_sketch, sheet_path, sheet_path.with_name(f"{n}.sketch.jpg")):
                    sh["x_sketch_url"] = f"/uploads/drafts/{self.id}/sheets/{n}.sketch.jpg"
        for w in getattr(scan, "warnings", None) or []:
            w = _as_dict(w)
            if isinstance(w, dict) and w.get("key"):
                self.warn(w["key"], w.get("args") or {}, once=False)
        pack_id = req.pack_id
        if getattr(scan, "pack", None) is not None and not req.pack_id:
            pid = getattr(scan.pack, "pack_id", None)
            if pid and pid != "legacy":
                pack_id = pid
                self.mutate(lambda st: st.__setitem__("pack_id", pid))
        # C-5 §1: a remix / extend pack stitched onto its parent: adopt that parent before perceive_heuristic and the
        # first build, so BuildInput.parent is set for paper remixes too
        sp = _as_dict(getattr(scan, "parent", None))
        if isinstance(sp, dict) and sp.get("id") and not self.parent_level:
            self.parent_level = sp
            drafts.write_json(self.id, "parent.json", sp)

            def adopt(st: dict[str, Any]) -> None:
                st["parent_id"] = sp.get("id")
                if not st.get("game_id") and sp.get("rules"):  # a game's rules win; else the parent's
                    st["rules"] = sp["rules"]

            self.mutate(adopt)
        # C-5 §2: the tray state (publishing needs all k sheets; playable from sheet 1)
        complete = bool(getattr(scan, "complete", True))
        playable = int(getattr(scan, "playable_screens", 1) or 1)
        self.mutate(lambda st: st.update({"scan_complete": complete, "playable_screens": playable}))
        pk = getattr(scan, "pack", None)
        if pk is not None:
            self.mutate(lambda st: st.__setitem__("pack", {"kind": getattr(pk, "kind", "new"), "k": int(getattr(pk, "k", 1)),
                                                          "parent_id": getattr(pk, "parent_id", None)}))
            if getattr(pk, "game_id", None) and not self.state.get("game_id"):  # a game pack: that game's rules and library
                game = db_v2.get_game(pk.game_id)
                if game is not None:
                    self.library = load_library(pk.game_id)
                    drafts.write_json(self.id, "library.json", self.library)
                    self.mutate(lambda st: st.update({"game_id": pk.game_id, "rules": game.get("rules") or st.get("rules")}))
            if pk.parent_id and not self.parent_level:  # a remix pack names its parent: build against it
                row = db_v2.get_level_row(pk.parent_id)
                if row is not None and row.get("level"):
                    self.parent_level = row["level"]
                    drafts.write_json(self.id, "parent.json", self.parent_level)
                    self.mutate(lambda st: st.__setitem__("parent_id", pk.parent_id))
        if pack_id:
            try:
                db_v2.record_pack_sheets(pack_id, [
                    {"n": int(sh.get("index", 0)) + 1, "draft_id": self.id, "photo_url": sh.get("photo_url"),
                     "scanned_at": db_v2.now_iso()} for sh in ink.get("sheets") or []])
            except Exception as e:  # noqa: BLE001 - the tray checklist is a convenience, never a failed build
                log.info("pack %s sheets not recorded: %s", pack_id, e)
        self.stage("cv", "done")
        return ink

    async def scan_free_picture(self, photo: bytes) -> dict[str, Any] | None:
        """Any picture without the printed sheet's markers → InkDoc via the raster path (screens from the aspect
        ratio). Returns None when the picture holds no usable ink."""
        try:
            from app.cv.raster_ingest import ingest_raster  # type: ignore[import-not-found]  # lane C
            ink_doc = await asyncio.to_thread(ingest_raster, photo, 0, source="paper")
        except Exception as e:  # noqa: BLE001 - fall through to the original paper error
            log.info("free-picture scan failed: %s", e)
            return None
        ink = _as_dict(ink_doc)
        if not isinstance(ink, dict) or not ink.get("strokes"):
            return None
        drafts.write_bytes(self.id, "sheets/1.jpg", photo)
        for sh in ink.get("sheets") or []:
            if int(sh.get("index", 0)) == 0:
                sh["photo_url"] = f"/uploads/drafts/{self.id}/sheets/1.jpg"
        self.mutate(lambda st: st.update({"scan_complete": True, "playable_screens": len(ink.get("sheets") or []) or 1}))
        self.warn("warning.free_picture", {}, once=True)
        self.stage("cv", "done")
        return ink

    async def parse_typed_rules(self) -> None:
        """The offline keyword parser, one typed sentence at a time (so a model answer can supersede it per
        sentence at Understood, §3.3 merge 5). Asks ("Which platform moves? Tap it.") are kept."""
        rules = self.ink.get("typed_rules") or []
        parser: dict[str, list[dict[str, Any]]] = {}
        asks: list[dict[str, Any]] = []
        for i, r in enumerate(rules):
            if not (r.get("text") or "").strip():
                continue
            try:
                res = await self.rpc("parse_rules", {"text": r["text"], "graph": self.graph0, "target": r.get("target")})
            except CoreError as e:
                log.info("parse_rules failed: %s", e)
                continue
            parser[str(i)] = [e for e in (res or {}).get("edits") or [] if isinstance(e, dict) and e.get("id")]
            asks.extend(a for a in (res or {}).get("asks") or [] if isinstance(a, dict))
        self.mutate(lambda s: (s["edits"].__setitem__("parser", parser), s.__setitem__("parser_asks", asks)))

    # ---- PERCEIVE + Understood -------------------------------------------------------------------

    def start_perceive(self, tiles: list[mperceive.TilePlan]) -> list[asyncio.Task[mperceive.PerceiveOut]]:
        if not tiles:
            return []
        deadline = min(self.deadline - PERCEIVE_RESERVE_S, time.monotonic() + client.CALLS["perceive"].timeout_s)
        lib = self.library
        strip = None
        if lib:
            try:
                from app.cv.annotate import render_library_strip  # type: ignore[import-not-found]  # lane C

                strip = render_library_strip(lib)
            except Exception:  # noqa: BLE001
                strip = None
        self.stage("perceive", "start", "stage.perceive")
        self.mutate(lambda s: s.__setitem__("perceive_ran", True))
        tasks = []
        for tp in tiles:
            ctx = mperceive.PerceiveCtx(draft_id=self.id, deadline=deadline, library=lib,
                                        parent=self.parent_level, library_strip=strip)
            tasks.append(self.task(mperceive.perceive(self.ink, tp, ctx)))
        return tasks

    async def understood(self, tasks: list[asyncio.Task[mperceive.PerceiveOut]], ink_ts: dict[str, Any]) -> dict[str, Any] | None:
        outs: list[mperceive.PerceiveOut] = list(await asyncio.gather(*tasks))
        perceptions: list[dict[str, Any]] = []
        refused = flagged = False
        dropped: list[str] = []
        for o in outs:
            self.record(o.result)
            if o.image:
                drafts.write_bytes(self.id, f"annotated/{o.tile}.jpg", o.image)
            if o.result.status == "refused":
                refused = True
            if o.value is not None and not o.discarded:
                perceptions.append(o.value)
                drafts.write_json(self.id, f"perception/{o.tile}.json", o.value)
                if not o.value.get("safety_ok", True):
                    flagged = True
            dropped += [f"{o.tile}:{d}" for d in o.dropped]
            if o.discarded:
                dropped.append(f"{o.tile}:discarded")
        if refused:
            self.mutate(lambda s: s.__setitem__("safety", "held"))
            self.warn("warning.safety_held")
        elif flagged:
            self.mutate(lambda s: s.__setitem__("safety", "flag"))
        elif perceptions and len(perceptions) == len(outs):
            self.mutate(lambda s: s.__setitem__("safety", "ok") if s.get("safety") in (None, "unchecked") else None)

        if not perceptions:
            all_skipped = all(o.result.status == "skipped" for o in outs)
            self.stage("perceive", "skipped" if all_skipped else "failed")
            if not all_skipped:
                self.warn("warning.looked_closer_skipped")
            self.mutate(lambda s: s["perception"].update({"status": "failed", "dropped": dropped}))
            self.stage("understood", "skipped")
            return None

        try:
            merged = await self.rpc("merge_perception", {"graph0": self.graph0, "perceptions": perceptions, "ink": self.ink,
                                                         "library": self.library},
                                    MERGE_TIMEOUT_S)
        except CoreError as e:
            log.info("merge_perception failed: %s", e)
            merged = None
        if not merged or merged.get("discarded"):
            self.stage("perceive", "failed")
            self.warn("warning.looked_closer_skipped")
            self.mutate(lambda s: s["perception"].update({"status": "discarded", "dropped": dropped, "discarded": True}))
            self.stage("understood", "skipped")
            return None
        self.stage("perceive", "done")

        p_edits = [e for e in merged.get("edits") or [] if isinstance(e, dict) and e.get("id")]
        superseded = self.superseded_rules(perceptions)
        title = next((p.get("title") for p in perceptions if p.get("title")), None)
        intent = next((p.get("intent") for p in perceptions if p.get("intent")), None)
        transcript = " ".join(p.get("transcript", "") for p in perceptions if p.get("transcript")).strip()

        def f(s: dict[str, Any]) -> None:
            s["edits"]["perception"] = p_edits
            s["perception"] = {"tiles": [p["tile"] for p in perceptions], "status": "ok",
                               "dropped": dropped + list(merged.get("dropped") or []), "discarded": False}
            s["superseded_rules"] = sorted(superseded)
            s["setpieces"] = merged.get("setpieces") or []
            s["title"] = s.get("title") or title
            s["intent"] = intent
            s["transcript"] = transcript

        self.mutate(f)
        edits1 = self.intent_edits(understood=True)
        try:
            und_ts = await self.tiers(edits1)
        except CoreError as e:  # the Ink level stands; never fail a build that is already playable
            log.warning("understood build failed: %s", e)
            self.mutate(lambda s: s["perception"].update({"status": "build_failed"}))
            self.warn("warning.looked_closer_skipped")
            self.stage("understood", "failed")
            return None
        self.emit("edits", {"edits": present.edits_union(und_ts, edits1)})
        self.emit("saw", {"items": present.saw_items(und_ts["faithful"].get("graph") or self.graph0, self.ink),
                          "stage": "understood"})
        self.emit_tiers("understood", und_ts, ink_ts)
        self.emit_asks([a for a in merged.get("asks") or [] if isinstance(a, dict)])
        self.save_stage("understood", und_ts)
        self.final_stage = "understood"
        self.stage("understood", "done")
        return und_ts

    def superseded_rules(self, perceptions: list[dict[str, Any]]) -> set[str]:
        """Typed sentences the model answered (a binding whose evidence covers it, or that binds the rule's
        target): their parser edits are dropped, never merged on top (§3.3 merge 5, [B F10])."""
        out: set[str] = set()
        rules = self.ink.get("typed_rules") or []
        bindings = [b for p in perceptions for b in p.get("bindings") or []]
        for i, r in enumerate(rules):
            txt = r.get("text") or ""
            tgt = r.get("target")
            for b in bindings:
                bb = b.get("binding") or {}
                ids = {bb.get("target"), bb.get("key"), bb.get("door"), bb.get("near")}
                if _covers(txt, b.get("evidence") or "") or (tgt is not None and tgt in ids):
                    out.add(str(i))
                    break
        return out

    # ---- Designed ---------------------------------------------------------------------------------

    async def designed(self, base_ts: dict[str, Any], base_stage: str, ink_ts: dict[str, Any],
                       design1: asyncio.Task[mdesign.PlanOut] | None) -> None:
        sync = client.DESIGN_SYNCHRONOUS
        dp = design_params()
        edits = self.intent_edits(understood=base_stage == "understood")
        plan: dict[str, Any] | None = None
        pending: asyncio.Task[mdesign.PlanOut] | None = None  # a DESIGN still in flight → suggestions later
        pending_base_is_ink = False

        if design1 is not None:
            if sync and not design1.done():
                try:
                    await asyncio.wait_for(asyncio.shield(design1), max(0.0, self.deadline - time.monotonic()))
                except asyncio.TimeoutError:
                    pass
            if design1.done():
                out1 = design1.result()
                if out1.plan is not None:
                    plan = out1.plan if base_ts is ink_ts else await self.transfer(out1.plan, ink_ts, base_ts)
                    if plan is None and self.model_on():
                        # transfer < 70% or a route role changed: DESIGN #2 on the new menu
                        if sync and self.elapsed() < float(dp.get("design2_cutoff_s", 14)):
                            self.stage("design", "start", "stage.design")
                            out2 = await self.design_call(base_ts, self.deadline - 1)
                            plan = out2.plan
                        else:
                            self.stage("design", "start", "stage.design")
                            pending = self.task(self.design_call(base_ts, self.t0 + ASYNC_DESIGN_HORIZON_S))
                elif out1.result.status not in ("skipped",):
                    self.stage("design", "failed")
                else:
                    self.stage("design", "skipped")
            else:
                pending, pending_base_is_ink = design1, base_ts is not ink_ts
        elif self.model_on() and base_ts.get("menu"):
            self.stage("design", "start", "stage.design")
            if sync:
                out = await self.design_call(base_ts, self.deadline - 1)
                plan = out.plan
            else:
                pending = self.task(self.design_call(base_ts, self.t0 + ASYNC_DESIGN_HORIZON_S))
        else:
            self.stage("design", "skipped")

        final_ts, source = base_ts, "greedy"
        if plan is not None:
            applied = await self.apply(plan, base_ts, edits)
            if applied is not None:
                final_ts, source = applied, "model"
                rc = dp.get("refine") or {}
                if self.elapsed() < float(rc.get("cutoff_s", 20)):
                    deadline = min(self.deadline - 1, time.monotonic() + client.CALLS["refine"].timeout_s)
                    ref = await self.refine_round(plan, applied, edits, deadline)
                    if ref is not None:
                        plan, final_ts = ref
                self.stage("design", "done")
                self.record_rejected(final_ts)
            else:
                self.stage("design", "failed")
                plan = None

        # emit Designed
        self.emit("edits", {"edits": present.edits_union(final_ts, edits)})
        self.emit_tiers("designed", final_ts, base_ts)
        if source == "model" and plan is not None:
            self.emit_asks([design_ask_card(a, final_ts) for a in plan.get("asks") or []])
        self.save_stage("designed", final_ts)
        self.mutate(lambda s: s.update({"design_source": source, "plan": plan if source == "model" else s.get("plan")}))
        self.final_stage = "designed"
        if pending is not None:
            self.stage("design", "late", "warning.design_late")
        self.note(plan, source, final_ts)
        self.stage("designed", "done")

        if pending is not None:
            self.late.append(asyncio.create_task(self.late_plan(pending, ink_ts if pending_base_is_ink else base_ts,
                                                                base_ts, final_ts, edits)))

    def record_rejected(self, ts: dict[str, Any]) -> None:
        rej = [{"cid": r.get("cid"), "why": r.get("why")} for r in ts.get("rejected") or [] if r.get("cid")]
        if rej:
            self.mutate(lambda s: s.__setitem__("rejected_picks", rej))

    async def late_plan(self, task: asyncio.Task[mdesign.PlanOut], plan_base: dict[str, Any], base_ts: dict[str, Any],
                        greedy_ts: dict[str, Any], edits: list[dict[str, Any]]) -> None:
        """A DESIGN answer that missed the Designed stage: transfer it to the final menu, validate it with the
        core, and offer the picks that survive as `suggestions` (never yanking the level)."""
        try:
            out = await task
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001
            log.info("late design failed: %s", e)
            return
        plan = out.plan
        if plan is None:
            self.stage("design", "failed")
            return
        if plan_base is not base_ts:
            moved = await self.transfer(plan, plan_base, base_ts)
            if moved is None:
                if not self.model_on() or time.monotonic() > self.t0 + ASYNC_DESIGN_HORIZON_S - client.MIN_CALL_S:
                    self.stage("design", "failed")
                    return
                out2 = await self.design_call(base_ts, self.t0 + ASYNC_DESIGN_HORIZON_S)
                if out2.plan is None:
                    self.stage("design", "failed")
                    return
                moved = out2.plan
            plan = moved
        applied = await self.apply(plan, base_ts, edits)
        if applied is None:
            self.stage("design", "failed")
            return
        self.stage("design", "done")
        self.record_rejected(applied)
        recs = self.suggestions_from(applied, greedy_ts, plan)
        self.offer(recs, "late_design")
        self.mutate(lambda s: s.__setitem__("late_plan", plan))
        self.note(plan, "model", applied)
        # REFINE on the async path: its extra picks are suggestions too
        deadline = min(self.t0 + LATE_CAP_S - 2, time.monotonic() + client.CALLS["refine"].timeout_s)
        ref = await self.refine_round(plan, applied, edits, deadline)
        if ref is not None:
            plan2, applied2 = ref
            have = {r["id"] for r in recs}
            extra = [r for r in self.suggestions_from(applied2, greedy_ts, plan2) if r["id"] not in have]
            self.offer(extra, "refine")
            self.mutate(lambda s: s.__setitem__("late_plan", plan2))

    async def drain_late(self) -> None:
        if not self.late:
            return
        left = self.t0 + LATE_CAP_S - time.monotonic()
        done, pending = await asyncio.wait(self.late, timeout=max(0.0, left))
        for t in pending:
            t.cancel()
        for t in done:
            if not t.cancelled() and t.exception() is not None:
                log.info("late task failed: %s", t.exception())
        if pending:
            self.stage("design", "failed")

    # ---- Redesign and CRITIC (later builds on the same draft) ----------------------------------------

    def load_draft(self) -> dict[str, Any] | None:
        self.ink = drafts.read_json(self.id, "ink.json") or {}
        self.graph0 = drafts.read_json(self.id, "graph0.json") or {}
        return drafts.load_current(self.id)

    async def redesign(self) -> None:
        """POST /drafts/{id}/redesign: a fresh DESIGN on the current graph; the kid asked and waits for it, so the
        validated plan becomes the Designed tiers directly (deadline: the DESIGN call's own timeout)."""
        self.mutate(lambda s: s.update({"builds": s["builds"] + [self.req.build_id]}))
        self.hello()
        base = self.load_draft()
        if base is None:
            self.emit("error", {"message_key": "error.not_found", "args": {"what": "draft"}, "fatal": True})
            return
        self.final_stage = "designed"
        if not self.model_on():
            self.warn("warning.model_offline")
            self.stage("design", "skipped")
            return
        self.stage("design", "start", "stage.design")
        out = await self.design_call(base, time.monotonic() + client.CALLS["design"].timeout_s)
        if out.plan is None:
            self.stage("design", "failed" if out.result.status != "skipped" else "skipped")
            return
        edits = self.intent_edits(understood=self.state.get("perception", {}).get("status") == "ok")
        applied = await self.apply(out.plan, base, edits)
        if applied is None:
            self.stage("design", "failed")
            return
        plan = out.plan
        ref = await self.refine_round(plan, applied, edits, time.monotonic() + client.CALLS["refine"].timeout_s)
        if ref is not None:
            plan, applied = ref
        self.stage("design", "done")
        self.record_rejected(applied)
        self.emit("edits", {"edits": present.edits_union(applied, edits)})
        self.emit_tiers("designed", applied, base)
        self.emit_asks([design_ask_card(a, applied) for a in plan.get("asks") or []])
        self.save_stage("designed", applied)
        self.mutate(lambda s: s.update({"design_source": "model", "plan": plan}))
        self.note(plan, "model", applied)
        self.stage("designed", "done")

    async def critic(self) -> None:
        """POST /drafts/{id}/critic: where and why the creator dies, with ≤ 3 validated picks as suggestions."""
        self.mutate(lambda s: s.update({"builds": s["builds"] + [self.req.build_id]}))
        self.hello()
        base = self.load_draft()
        if base is None:
            self.emit("error", {"message_key": "error.not_found", "args": {"what": "draft"}, "fatal": True})
            return
        self.final_stage = "critic"
        tier = self.state.get("dial") or "polished"
        if tier == "challenging":  # the build-time dial names the band, the preview dial names the tier
            tier = self.state.get("band") or "normal"
        tier = tier if tier in TIERS else "polished"
        result = base.get(tier) or base["polished"]
        telemetry = self.req.telemetry or {"deaths": [], "attempts": 0}
        s = mcritic.struggle(telemetry)
        seg_menu = mcritic.segment_menu(base.get("menu") or [], result, s.segment)
        edits = self.intent_edits(understood=self.state.get("perception", {}).get("status") == "ok")
        self.stage("critic", "start", "stage.critic")
        plan: dict[str, Any] | None = None
        observations: dict[str, Any] | None = None
        if self.model_on():
            dig = await self.make_digest(base, menu=seg_menu, base_tier=tier)
            out, observations = await mcritic.critic(
                dig, telemetry, self.design_ctx(time.monotonic() + client.CALLS["critic"].timeout_s))
            self.record(out.result)
            plan = out.plan
        source = "model" if plan is not None else "greedy"
        if plan is None:
            plan = mcritic.offline_critique(seg_menu, telemetry)
        recs: list[dict[str, Any]] = []
        if plan.get("picks"):
            applied = await self.apply(plan, base, edits)
            if applied is not None:
                recs = self.suggestions_from(applied, base, plan)
        self.offer(recs, "critic")
        if source == "model" and observations is not None:
            n = {"designer_note": observations.get("note") or "", "source": "model", "title_suggestion": None,
                 "critique": [o["what"] for o in observations.get("observations") or []]}
        else:
            key = "note.greedy_checkpoint" if any(r.get("op", {}).get("op") == "add_checkpoint" for r in recs) else "note.greedy"
            n = {"designer_note": messages.say(key), "critique": [], "title_suggestion": None, "source": "greedy"}
        self.emit("note", n)
        self.stage("critic", "done")


# ---- shared with the draft endpoints ----------------------------------------------------------------------


def graph_for_build(graph0: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """The G0 a build starts from. Once PERCEIVE was merged, the model's named setpieces ride in
    `graph0.setpieces` (I3, CONTRACTS §3.10 "Setpieces"); before that (the Ink stage, or the model off) the core
    derives geometric setpieces itself."""
    sp = state.get("setpieces") or []
    if not sp or (state.get("perception") or {}).get("status") != "ok" or not isinstance(graph0, dict):
        return graph0
    g = dict(graph0)
    g["setpieces"] = sp
    return g


def merge_typed_rules(ink: dict[str, Any], extra: list[dict[str, Any]]) -> dict[str, Any]:
    rules = list(ink.get("typed_rules") or [])
    have = {(r.get("text", "").strip().lower(), r.get("target")) for r in rules}
    for r in extra or []:
        t = sanitize.text(r.get("text", ""), 200)
        if not t:
            continue
        key = (t.lower(), r.get("target"))
        if key not in have:
            have.add(key)
            rules.append({"text": t, **({"target": int(r["target"])} if r.get("target") is not None else {})})
    ink["typed_rules"] = rules
    return ink


def intent_edits(state: dict[str, Any], *, understood: bool,
                 known: list[dict[str, Any]] | None = None) -> list[dict[str, Any]]:
    """See Run.intent_edits. Priority on conflict (kid > model > parser > heuristic) is expressed by order: later
    records of the same target and op override earlier ones in the core; kid records come last."""
    e = state.get("edits") or {}
    superseded = set(state.get("superseded_rules") or []) if understood else set()
    out: dict[str, dict[str, Any]] = {}
    for i, recs in sorted((e.get("parser") or {}).items(), key=lambda kv: int(kv[0])):
        if i in superseded:
            continue
        for r in recs:
            out[r["id"]] = r
    if understood:
        for r in e.get("perception") or []:
            out[r["id"]] = r
    for r in e.get("accepted") or []:
        out[r["id"]] = r
    for r in e.get("kid") or []:
        out[r["id"]] = r
    statuses = state.get("statuses") or {}
    known_by_id = {r["id"]: r for r in known or [] if isinstance(r, dict) and r.get("id")}
    result = []
    for rid, r in out.items():
        r = copy.deepcopy(r)
        if rid in statuses:
            r["status"] = statuses[rid]
        result.append(r)
    for rid, st in statuses.items():
        if rid not in out and rid in known_by_id:
            r = copy.deepcopy(known_by_id[rid])
            r["status"] = st
            result.append(r)
    return result


def pack_info(scan_v2: Any, pack_id: str | None) -> Any:
    """lane C's PackInfo for a pack id from the packs table (None when unknown)."""
    if not pack_id:
        return None
    from contextlib import closing

    try:
        with closing(db_v2.connect()) as conn:
            r = conn.execute("SELECT id, kind, k, game_id, parent_id FROM packs WHERE id = ?", (pack_id,)).fetchone()
        if r is None:
            return None
        return scan_v2.PackInfo(pack_id=r["id"], kind=r["kind"], k=int(r["k"]), game_id=r["game_id"],
                                parent_id=r["parent_id"])
    except Exception as e:  # noqa: BLE001
        log.info("pack lookup %s failed: %s", pack_id, e)
        return None


def load_library(game_id: str) -> list[dict[str, Any]]:
    """The game's object library: the latest version of every type (levels pin their own versions)."""
    import json
    from contextlib import closing

    try:
        with closing(db_v2.connect()) as conn:
            rows = conn.execute(
                "SELECT t.json FROM object_types t WHERE t.game_id = ? AND t.version = "
                "(SELECT MAX(version) FROM object_types x WHERE x.id = t.id)", (game_id,)).fetchall()
        return [json.loads(r[0]) for r in rows]
    except Exception as e:  # noqa: BLE001
        log.info("library load failed: %s", e)
        return []


async def run_build(req: BuildRequest, sink: EventSink) -> None:
    """§11.3d: the orchestrator. Never raises (a failure is an `error` event followed by `done`)."""
    await Run(req, sink).run()
