"""v7 AI art (docs/v7/CONTRACTS_V7.md §3): the SVG sanitizer, rendering helpers, the art direction (model and
keywords), art jobs with a fake client.call (draw → review → fix, terrain, backdrop), fallbacks, the copilot's
art_prompt / error, and the HTTP endpoints with their limits."""
from __future__ import annotations

import asyncio
import copy
import importlib
import json
import os
import time
from typing import Any, Iterator

import pytest
from fastapi.testclient import TestClient

from app.mind import budget, client
from app.mind.client import MindResult
from app.spec.studio import ArtDirectionResult, ArtJobStatus, Backdrop, ObjectArt, StudioChatResult, TerrainSkin
from app.studio import copilot
from app.studio.art import calls, direction, jobs, objects, procedural, render, svg as svgmod
from app.studio.art import palette as P
from tests import test_studio_fixtures as F

CAR = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 224"><defs><linearGradient id="g"><stop offset="0" '
       'stop-color="#ff5544"/><stop offset="1" stop-color="#aa2211"/></linearGradient></defs>'
       '<rect x="10" y="40" width="490" height="170" rx="30" fill="url(#g)" stroke="#1d1b2c" stroke-width="10"/></svg>')
STRIP = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 128"><rect x="0" y="32" width="512" height="40" '
         'fill="#aab"/></svg>')


@pytest.fixture(autouse=True)
def model_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("DAL_FAKE_LLM", raising=False)
    monkeypatch.setattr(calls, "RETRY_WAITS_S", (0.0, 0.0))


def racer() -> dict[str, Any]:
    doc = F.car_scene()
    objs = doc["scenes"][0]["objects"]
    objs[0]["physics"] = {**objs[0]["physics"], "body": "static", "shape": "line"}
    objs[0]["kind"] = "ground"
    objs[1].update(kind="car", player=1, joints=[{"type": "wheel", "to": "o3", "at": [-50, 60], "motor": True},
                                                {"type": "wheel", "to": "o4", "at": [50, 60], "motor": True}])
    objs[2]["kind"] = objs[3]["kind"] = "wheel"
    from app.spec.studio import GameDoc

    return GameDoc.model_validate(doc).model_dump(mode="json", by_alias=True)


# ---- the sanitizer ------------------------------------------------------------------------------------------------


def test_sanitizer_strips_everything_unsafe() -> None:
    evil = ('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
            'viewBox="0 0 100 50" onload="alert(1)"><script>alert(1)</script><style>rect{fill:red}</style>'
            '<foreignObject><div>x</div></foreignObject><image href="http://evil/x.png"/><text>HELLO</text>'
            '<a href="javascript:alert(1)"><rect width="10" height="10"/></a>'
            '<filter id="f"><feGaussianBlur stdDeviation="2"/><feImage href="http://evil"/></filter>'
            '<rect id="r" width="50" height="20" fill="url(#missing)" stroke="url(http://evil/#x)" filter="url(#f)" '
            'onclick="x()" style="fill-opacity:0.5;behavior:url(x.htc)"/>'
            '<use xlink:href="#r" x="5"/><use href="http://evil/a.svg#r"/>'
            '<circle cx="5" cy="5" r="3" fill="red" transform="javascript:x"/></svg>')
    out = svgmod.sanitize(evil, view=(100, 50), prefix="t_")
    assert out is not None
    low = out.lower()
    for bad in ("script", "style", "foreignobject", "<image", "feimage", "<text", "hello", "javascript", "onload",
                "onclick", "http://evil", "behavior", "<a "):
        assert bad not in low, bad
    assert 'viewBox="0 0 100 50"' in out and 'id="t_r"' in out and 'href="#t_r"' in out
    assert 'filter="url(#t_f)"' in out and "fill-opacity=\"0.5\"" in out
    assert 'fill="none"' in out  # a reference to a missing id is neutralised
    assert render.png(out, width=100) is not None


def test_sanitizer_rejects_non_svg_entities_and_empty() -> None:
    assert svgmod.sanitize("hello") is None
    assert svgmod.sanitize('<!DOCTYPE svg [<!ENTITY x "y">]><svg viewBox="0 0 1 1"><rect/></svg>') is None
    assert svgmod.sanitize('<svg viewBox="0 0 10 10"><script/></svg>') is None  # nothing drawable left
    assert svgmod.sanitize("<svg><rect width='1' height='1'/></svg>") is None  # no size and no view given
    assert svgmod.sanitize("```svg\n" + CAR + "\n```", view=(512, 224)) is not None


def test_sanitizer_forces_viewbox_and_caps_size() -> None:
    out = svgmod.sanitize('<svg viewBox="0 0 200 100"><rect width="200" height="100"/></svg>', view=(100, 100))
    assert out is not None and 'viewBox="0 0 100 100"' in out and "scale(0.5)" in out and "translate(0 25)" in out
    big = '<svg viewBox="0 0 10 10">' + "".join(
        f'<path d="M{i}.123456 1.987654 L{i}.55555 9.4444 Z" fill="#123456"/>' for i in range(3000)) + "</svg>"
    capped = svgmod.sanitize(big, view=(10, 10), max_chars=150_000, max_elements=5000)
    assert capped is not None and len(capped) <= 150_000 and ".123456" not in capped
    assert svgmod.sanitize(big, view=(10, 10), max_chars=1000, max_elements=5000) is None


def test_fit_and_mirror_tile() -> None:
    s = svgmod.sanitize(CAR, view=(512, 224))
    assert s is not None
    fitted = svgmod.fit(s, 160, 70)
    assert fitted is not None and 'viewBox="0 0 160 70"' in fitted and svgmod.size_of(fitted) == (160, 70)
    m = svgmod.mirror_tile(svgmod.sanitize(STRIP) or "", "x")
    assert m is not None and m[1:] == (1024, 128) and m[0].count("<use") == 2
    m2 = svgmod.mirror_tile(svgmod.sanitize(STRIP) or "", "xy")
    assert m2 is not None and m2[1:] == (1024, 256) and m2[0].count("<use") == 4
    assert render.png(m2[0], width=200) is not None


# ---- rendering helpers --------------------------------------------------------------------------------------------


def test_render_sketch_measure_and_seam() -> None:
    assert render.available()
    doc = racer()
    car = doc["scenes"][0]["objects"][1]
    s, vw, vh = render.sketch_svg(car)
    png = render.png(s, width=400)
    assert png and png.startswith(b"\x89PNG") and vw > 160 and vh > 70
    m = render.measure(render.png(svgmod.sanitize(CAR, view=(512, 224)) or "", width=512))
    assert m is not None and 0.6 < m.coverage < 0.8 and m.margins[0] < 0.03 and not m.empty
    assert render.hull_coverage(car) > 0.9  # a box drawing covers its box
    seamless = render.seam(render.png(procedural.backdrop(P.by_key("forest"), 1, "x")["layers"][1]["svg"], width=800))
    stripe = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 10"><rect width="100" height="10" '
              'fill="#000"/><rect x="50" width="50" height="10" fill="#fff"/></svg>')
    assert seamless is not None and seamless < 2.5
    assert (render.seam(render.png(stripe, width=100)) or 0) > 2.5


def test_procedural_fallbacks_are_valid_and_seamless() -> None:
    for fam in P.FAMILIES:
        skin = procedural.terrain(fam, [], 2, "g1")
        TerrainSkin.model_validate(skin)
        assert skin["surface_svg"] and skin["texture_svg"] and 1 <= len(skin["decor"]) <= 6
        assert (render.seam(render.png(skin["texture_svg"], width=256)) or 0) < 2.5
        bd = procedural.backdrop(fam, 2, "g1")
        Backdrop.model_validate(bd)
        assert len(bd["layers"]) == 3 and len(bd["sky"]) >= 2
    assert P.family_for("hill climb racing in space").key == "space"
    assert P.family_for("candy land").key == "candy"


# ---- a fake model -------------------------------------------------------------------------------------------------


class Fake:
    """client.call stand-in: answers by schema, records (kind, content), can fail chosen kinds."""

    def __init__(self, fail: set[str] | None = None, review_verdicts: list[str] | None = None) -> None:
        self.seen: list[tuple[str, list[dict[str, Any]]]] = []
        self.fail = fail or set()
        self.verdicts = list(review_verdicts or ["fix", "keep"])

    async def __call__(self, kind: str, schema: Any, content: list[dict[str, Any]], **_: Any) -> MindResult[Any]:
        self.seen.append((kind, content))
        if kind in self.fail:
            return MindResult[schema](kind=kind, status="failed", error="timeout after 1.0 s")
        v: Any
        if schema is calls.DirectionFlat:
            v = schema(summary="Lunar rover rally", guide="WORLD AND MOOD: moon. " * 30,
                       palette=["#f2f4f8", "#e0a526", "#2a2140", "#8d8aa3", "#5b3f8f", "#5ee7ff", "zzz"],
                       kinds=[calls.KindLook(kind="car", looks="a chunky white lunar rover")],
                       theme=calls.ThemeLite(preset="deep_space", name="Moon", bg="#05060f", ink="#e6e9ff",
                                             accent="#ffb703", accent2="#8ecae6", text="#e6e9ff", danger="#ff4d6d",
                                             good="#80ed99", background="space", background_colors=["#05060f"],
                                             stroke="marker", outline="", glow=True, particles="stars", font="clean",
                                             music="heroic"))
        elif schema is calls.ObjectArtFlat:
            v = schema(note="A shiny red rover", svg=CAR)
        elif schema is calls.ReviewFlat:
            fixed_already = "#ff7766" in content[-1].get("text", "")
            verdict = "keep" if fixed_already else "fix"
            v = schema(score=7 if verdict == "fix" else 9, problems=["too flat"] if verdict == "fix" else [],
                       verdict=verdict, svg=CAR.replace("#ff5544", "#ff7766") if verdict == "fix" else "", note="")
        elif schema is calls.TerrainFlat:
            v = schema(note="moon dust", fill=["#8d8aa3", "#5f5b78"], surface="#b9b6cc", surface_width=22,
                       surface_svg=STRIP, texture_svg="<svg viewBox='0 0 256 256'><script/></svg>",
                       decor=[calls.DecorFlat(name="crater", w=60, h=30, svg=CAR)], decor_every=300)
        elif schema is calls.TerrainReviewFlat:
            v = schema(score=9, problems=[], verdict="keep", fixed=[])
        elif schema is calls.LayerFlat:
            v = schema(note="hills", sky=["#0b0a24", "#2a1f5c"], svg=STRIP)
        elif schema is calls.BackdropReviewFlat:
            v = schema(score=8, problems=["far too bright"], verdict="fix", sky=["#000010", "#202040"],
                       fixes=[calls.LayerFix(layer="far", svg=STRIP.replace("#aab", "#99a"))])
        elif schema is copilot.ChatFlat:
            v = schema(edits=[copilot.FlatEdit(action="set_world", target="", scene="",
                                               data_json='{"kind": "moon racer", "gravity": [0, 0.3]}')],
                       reply="Blast off!", suggestions=["More fuel", "Faster"], art_prompt="")
        else:
            return MindResult[schema](kind=kind, status="failed", error="unexpected")
        return MindResult[schema](kind=kind, status="ok", value=v)


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> Fake:
    f = Fake()
    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", f)
    return f


def run_job(body: dict[str, Any], ip: str = "t") -> dict[str, Any]:
    async def main() -> dict[str, Any]:
        jid = jobs.start(body, ip)
        for _ in range(2000):
            st = jobs.status(jid)
            assert st is not None
            if st["status"] != "running":
                return st
            await asyncio.sleep(0.01)
        raise AssertionError("job never finished")

    return asyncio.run(main())


# ---- direction ----------------------------------------------------------------------------------------------------


def test_art_calls_registered_and_never_budget_blocked() -> None:
    for kind in calls.ART_CALLS:
        spec = client.CALLS[kind]
        assert spec.effort == "high" and spec.max_tokens >= 24000 and spec.timeout_s >= 180
        assert budget.ESTIMATE_USD[kind] == float("-inf")
        assert client.system_prompt(kind)
    assert "CRAFT GUIDE" in client.system_prompt("studio_art_craft")


def test_direction_keywords_when_model_off() -> None:
    doc = racer()
    res = asyncio.run(direction.make({"game": doc, "prompt": "hill climb racing but in space"}))
    ArtDirectionResult.model_validate(res)
    d = res["direction"]
    assert res["source"] == "keywords" and res["theme"]["id"] == "deep_space"
    assert d["rev"] == 1 and d["prompt"] == "hill climb racing but in space"
    assert set(d["kinds"]) == {"ground", "car", "wheel"} and "rover" in d["kinds"]["car"]
    assert 6 <= len(d["palette"]) <= 10 and "LIGHT AND SHADING" in d["guide"]
    doc["art_direction"] = d
    assert asyncio.run(direction.make({"game": doc, "prompt": ""}))["direction"]["rev"] == 2


def test_direction_model(fake: Fake) -> None:
    res = asyncio.run(direction.make({"game": racer(), "prompt": "moon"}))
    ArtDirectionResult.model_validate(res)
    d = res["direction"]
    assert res["source"] == "model" and d["summary"] == "Lunar rover rally"
    assert d["palette"] == ["#f2f4f8", "#e0a526", "#2a2140", "#8d8aa3", "#5b3f8f", "#5ee7ff"]
    assert d["kinds"]["car"] == "a chunky white lunar rover" and {"ground", "wheel"} <= set(d["kinds"])
    assert res["theme"]["id"] == "deep_space"
    kind, content = fake.seen[0]
    assert kind == "studio_art_direction" and content[0]["cache_control"] == {"type": "ephemeral"}
    assert any(b["type"] == "image" for b in content)  # the scene's sketch
    assert "kinds" in content[-1]["text"] and "car" in content[-1]["text"]


def test_direction_model_failure_falls_back(monkeypatch: pytest.MonkeyPatch) -> None:
    f = Fake(fail={"studio_art_direction"})
    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", f)
    res = asyncio.run(direction.make({"game": racer(), "prompt": "candy land"}))
    assert res["source"] == "keywords" and res["theme"]["id"] == "candy"
    assert len([k for k, _ in f.seen if k == "studio_art_direction"]) == 2  # retried once


# ---- jobs ---------------------------------------------------------------------------------------------------------


def test_job_draws_reviews_and_fixes(fake: Fake) -> None:
    doc = racer()
    doc["art_direction"] = direction.keyword_direction(doc, "space", 3, ["car", "ground", "wheel"])["direction"]
    st = run_job({"game": doc, "scene": "s1", "objects": ["o1", "o2", "nope"], "backdrop": True, "variants": 2,
                  "images": {}})
    ArtJobStatus.model_validate(st)
    assert st["status"] == "done" and st["total"] == 3 and st["done"] == 3 and st["rev"] == 3
    by = {i["object_id"]: i for i in st["items"]}
    car = by["o2"]
    assert car["status"] == "done" and car["error"] is None
    art = ObjectArt.model_validate(car["art"])
    assert len(art.variants) == 2 and art.chosen == art.variants[0].id and art.use == "sketch" and not art.asked
    v = art.variants[0]
    assert v.w == 160 and v.h == 70 and v.rev == 3 and v.note == "A shiny red rover"
    assert 'viewBox="0 0 160 70"' in v.svg and "#ff7766" in v.svg  # the reviewer's fix won
    kinds = [k for k, _ in fake.seen]
    assert kinds.count("studio_art_object") == 2 and kinds.count("studio_art_review") == 4
    review = next(c for k, c in fake.seen if k == "studio_art_review")
    texts = " ".join(b.get("text", "") for b in review)
    assert "OVERLAY" in texts and "Measurements" in texts and "GAME SIZE" in texts
    assert sum(1 for b in review if b["type"] == "image") >= 4
    draw = next(c for k, c in fake.seen if k == "studio_art_object")
    dtext = " ".join(b.get("text", "") for b in draw)
    assert "wheel o3" in dtext and "Do not draw it" in dtext and 'viewBox="0 0 512 224"' in dtext
    ground = ObjectArt.model_validate(by["o1"]["art"])
    assert ground.terrain is not None and ground.terrain.surface_width == 22 and ground.terrain.texture_svg
    assert len(ground.terrain.decor) == 1 and ground.terrain.decor[0].w == 60
    bd = Backdrop.model_validate(by[None]["backdrop"])
    assert len(bd.layers) == 3 and bd.sky == ["#000010", "#202040"] and "#99a" in bd.layers[0].svg


def test_job_fallbacks_when_model_off() -> None:
    doc = racer()
    doc["scenes"][0]["objects"].append(F.obj("inv", 10, 10, [], 50, 50))
    st = run_job({"game": doc, "scene": "s1", "objects": ["o1", "o2", "inv"], "backdrop": True, "variants": 3,
                  "images": {}})
    ArtJobStatus.model_validate(st)
    by = {i["object_id"]: i for i in st["items"]}
    assert by["o2"]["status"] == "failed" and by["o2"]["error"] == "off" and by["o2"]["art"] is None
    assert by["inv"]["status"] == "failed" and by["inv"]["error"] == "empty"
    assert by["o1"]["status"] == "done" and by["o1"]["error"] == "off" and by["o1"]["art"]["terrain"]["surface_svg"]
    assert by[None]["status"] == "done" and len(by[None]["backdrop"]["layers"]) == 3
    assert st["status"] == "done"


def test_job_object_failure_is_failed_item(monkeypatch: pytest.MonkeyPatch) -> None:
    f = Fake(fail={"studio_art_object"})
    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", f)
    st = run_job({"game": racer(), "scene": "s1", "objects": ["o2"], "backdrop": False, "variants": 1,
                  "images": {}})
    assert st["status"] == "failed" and st["items"][0]["error"] == "timeout"
    assert [k for k, _ in f.seen].count("studio_art_object") == 3  # retried on transient failures


def test_broken_svg_from_model_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    f = Fake()

    async def call(kind: str, schema: Any, content: list[dict[str, Any]], **kw: Any) -> MindResult[Any]:
        if schema is calls.ObjectArtFlat:
            return MindResult[schema](kind=kind, status="ok", value=schema(note="x", svg="<svg><script/></svg>"))
        return await f(kind, schema, content, **kw)

    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", call)
    st = run_job({"game": racer(), "scene": "s1", "objects": ["o2"], "backdrop": False, "variants": 1,
                  "images": {}})
    assert st["items"][0]["status"] == "failed"


def test_pick_keeps_the_best_candidate() -> None:
    a = objects.Candidate("<svg/>", "a", score=8)
    b = objects.Candidate("<svg/>", "b", parent=0, score=6)
    c = objects.Candidate("<svg/>", "c", parent=1)
    assert objects.pick([a, b]) is a
    assert objects.pick([a, objects.Candidate("<svg/>", "d", parent=0)]).note == "d"  # an unscored fix is trusted
    assert objects.effective_score(c, [a, b, c]) == 6.5


def test_jobs_rate_limit_and_expiry(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "JOBS", {})
    for i in range(jobs.MAX_RUNNING_PER_IP):
        jobs.JOBS[f"aj_{i:016x}"] = jobs.Job(id=f"aj_{i:016x}", ip="9.9.9.9", rev=1, items=[])
    with pytest.raises(jobs.Busy):
        asyncio.run(_start({"game": racer(), "scene": "s1", "objects": ["o2"], "backdrop": False}, "9.9.9.9"))
    old = jobs.Job(id="aj_" + "f" * 16, ip="1", rev=1, items=[], created=time.monotonic() - jobs.KEEP_S - 1)
    jobs.JOBS[old.id] = old
    assert jobs.status(old.id) is None


async def _start(body: dict[str, Any], ip: str) -> str:
    return jobs.start(body, ip)


# ---- the copilot --------------------------------------------------------------------------------------------------


def test_copilot_art_prompt_and_honest_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    body = {"game": racer(), "scene": "s1", "selection": [], "message": "reimagine as hill climb racing in space",
            "history": []}
    off = asyncio.run(copilot.chat(copy.deepcopy(body)))
    StudioChatResult.model_validate(off)
    assert off["source"] == "keywords" and off["error"] == "off" and off["art_prompt"]
    f = Fake()
    monkeypatch.setattr(client, "available", lambda: True)
    monkeypatch.setattr(client, "call", f)
    res = asyncio.run(copilot.chat(copy.deepcopy(body)))
    StudioChatResult.model_validate(res)
    assert res["source"] == "model" and res["art_prompt"] == "reimagine as hill climb racing in space"
    assert res.get("error") is None
    plain = asyncio.run(copilot.chat({**copy.deepcopy(body), "message": "jump higher please"}))
    assert plain["source"] == "model" and plain["art_prompt"] == "moon racer"  # the world kind changed
    f.fail = {"studio_chat"}
    slow = asyncio.run(copilot.chat({**copy.deepcopy(body), "message": "make it spooky"}))
    assert slow["source"] == "keywords" and slow["error"] == "timeout"
    assert slow["reply"].startswith("That took too long for me, so I only did the simple part:")
    assert slow["edits"] and slow["art_prompt"] == "make it spooky"
    none = asyncio.run(copilot.chat({**copy.deepcopy(body), "message": "qwzx"}))
    assert none["error"] == "timeout" and none["edits"] == [] and "too long" in none["reply"]
    assert client.CALLS["studio_chat"].timeout_s == 150 and client.CALLS["studio_recognize"].timeout_s == 30


def test_summary_ignores_art() -> None:
    from app.studio.summary import game_summary

    doc = racer()
    doc["art_direction"] = {"rev": 2, "prompt": "space", "summary": "Lunar rally", "guide": "SECRET GUIDE " * 100,
                            "palette": [], "kinds": {}}
    doc["scenes"][0]["objects"][1]["art"] = {"use": "ai", "chosen": "v1", "variants": [
        {"id": "v1", "svg": svgmod.sanitize(CAR), "w": 160, "h": 70}], "asked": True}
    doc["backdrop"] = procedural.backdrop(P.by_key("space"), 1, "x")
    text = game_summary(doc, "s1")
    assert "Art style: Lunar rally (asked: space)" in text
    assert "SECRET" not in text and "<svg" not in text and "linearGradient" not in text


# ---- HTTP ---------------------------------------------------------------------------------------------------------


@pytest.fixture(scope="module")
def api(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    os.environ["DAL_DATA_DIR"] = str(tmp_path_factory.mktemp("dal_v7"))
    os.environ.pop("ANTHROPIC_API_KEY", None)
    os.environ.pop("DAL_FAKE_LLM", None)
    from app import config, db

    config.get_settings.cache_clear()
    config.get_settings_v2.cache_clear()
    db._engine_for.cache_clear()
    main = importlib.reload(importlib.import_module("app.main"))
    with TestClient(main.create_app()) as c:
        yield c


def test_http_direction_and_job_flow(api: TestClient) -> None:
    doc = racer()
    r = api.post("/api/v2/studio/art/direction", json={"game": doc, "prompt": "in space"})
    assert r.status_code == 200, r.text
    res = ArtDirectionResult.model_validate(r.json())
    assert res.source == "keywords" and res.direction.kinds
    doc["art_direction"] = r.json()["direction"]
    r = api.post("/api/v2/studio/art/jobs", json={"game": doc, "scene": "s1", "objects": ["o1", "o2"],
                                                  "backdrop": True})
    assert r.status_code == 202, r.text
    jid = r.json()["id"]
    for _ in range(500):
        st = api.get(f"/api/v2/studio/art/jobs/{jid}").json()
        if st["status"] != "running":
            break
        time.sleep(0.02)
    ArtJobStatus.model_validate(st)
    assert st["status"] == "done" and st["done"] == st["total"] == 3
    assert api.get("/api/v2/studio/art/jobs/aj_0000000000000000").status_code == 404
    assert api.get("/api/v2/studio/art/jobs/../../x").status_code == 404


def test_http_bad_requests(api: TestClient) -> None:
    doc = racer()
    r = api.post("/api/v2/studio/art/jobs", json={"game": doc, "scene": "nope", "objects": ["o2"]})
    assert r.status_code == 400 and r.json()["error"]["args"]["field"] == "scene"
    r = api.post("/api/v2/studio/art/jobs", json={"game": doc, "scene": "s1", "objects": ["ghost"]})
    assert r.status_code == 400 and r.json()["error"]["key"] == "ai.err.bad_object"
    r = api.post("/api/v2/studio/art/jobs", json={"game": doc, "scene": "s1", "objects": [], "variants": 9})
    assert r.status_code == 400
    r = api.post("/api/v2/studio/art/direction", content=b"{nope", headers={"content-type": "application/json"})
    assert r.status_code == 400 and r.json()["error"]["key"] == "ai.err.bad_request"
    from app.routers.v2 import studio

    r = api.post("/api/v2/studio/art/jobs", content=b"x", headers={"content-type": "application/json",
                                                                   "content-length": str(studio.MAX_ART_BYTES + 1)})
    assert r.status_code == 413 and r.json()["error"]["key"] == "ai.err.too_big"
    assert studio.MAX_DOC_BYTES == 24 * 1024 * 1024 and studio.MAX_CHAT_BYTES > studio.MAX_DOC_BYTES


def test_http_rate_limit(api: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(jobs, "JOBS", {})
    for i in range(jobs.MAX_RUNNING_PER_IP):
        jobs.JOBS[f"aj_{i:016x}"] = jobs.Job(id=f"aj_{i:016x}", ip="testclient", rev=1, items=[])
    r = api.post("/api/v2/studio/art/jobs", json={"game": racer(), "scene": "s1", "objects": ["o2"]})
    assert r.status_code == 429 and r.json()["error"]["key"] == "ai.err.art_busy"


def test_messages_exist() -> None:
    data = json.loads((F.__file__ and open(os.path.join(os.path.dirname(__file__), "..", "..", "shared", "spec",
                                                        "messages-v6", "ai.json"), encoding="utf-8").read()))
    msgs = data["messages"]
    for k in ("ai.err.art_busy", "ai.chat.err.timeout", "ai.chat.err.timeout_partial", "ai.chat.err.failed",
              "ai.chat.err.failed_partial", "ai.chat.err.budget", "ai.chat.err.budget_partial", "ai.art.err.timeout",
              "ai.art.err.failed", "ai.art.err.off", "ai.art.err.empty", "ai.art.fallback"):
        assert k in msgs
