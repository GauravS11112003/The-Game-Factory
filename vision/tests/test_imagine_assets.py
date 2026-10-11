"""Pack preparation, reuse, isolation, recovery, and transmission into generated games."""
import asyncio
import io
import json

import pytest
from PIL import Image, ImageDraw
from pydantic import ValidationError

from app import config
from app.build import imagine
from app.creative import imagine_assets as art
from app.creative import settings as cs
from app.mind import client


def request(key="hero", kind="sprite", frames=4, **kwargs):
    width, height = (1280, 720) if kind == "backdrop" else (256 * frames, 256)
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {width} {height}">'
           '<rect x="16" y="16" width="128" height="200" fill="#4080c0"/></svg>')
    return art.AssetRequest(key=key, kind=kind, description="An explorer in a blue cloak",
                            frames=frames, fps=8, reuse=False, svg=svg, **kwargs)


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setenv("DAL_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("DAL_IMAGINE_ART", "1")
    monkeypatch.setattr(client, "mode", lambda: "live")
    monkeypatch.setattr(cs, "provider", lambda: "claude-svg")
    monkeypatch.setattr(art.jobs, "can_spend", lambda amount: True)
    monkeypatch.setattr(art.jobs, "ledger_add", lambda *a, **kw: None)
    config.get_settings.cache_clear()
    yield tmp_path
    config.get_settings.cache_clear()


async def progress(*args):
    pass


def pack_with(asset):
    data, width, height = art._svg_image(asset)
    return {"version": 1, "style": "Moonlit painterly fantasy", "perspective": "side view",
            "provider": "claude-svg", "assets": [art._store(asset, data, width, height, "claude-svg")]}


def test_pack_schema_rejects_ambiguous_keys_and_animated_scenery():
    with pytest.raises(ValidationError):
        request(key="../hero")
    with pytest.raises(ValidationError):
        request(kind="backdrop", frames=4)
    with pytest.raises(ValidationError):
        art.ArtPlan(style="Fantasy", perspective="side", assets=[request(), request()])


def test_svg_sanitized_and_sheet_dimensions_checked():
    asset = request()
    asset.svg = asset.svg.replace("<rect", '<script>alert(1)</script><rect onload="evil()"')
    data, width, height = art._svg_image(asset)
    assert (width, height) == (1024, 256)
    assert b"script" not in data and b"onload" not in data
    asset.svg = asset.svg.replace("1024 256", "256 256")
    with pytest.raises(ValueError, match="dimensions"):
        art._svg_image(asset)


def test_frame_preparation_preserves_relative_size_and_aligns_feet():
    image = Image.new("RGB", (400, 200), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((30, 40, 70, 170), fill="#8040c0")
    draw.rectangle((130, 40, 170, 170), fill="#8040c0")
    draw.rectangle((230, 40, 270, 170), fill="#8040c0")
    draw.rectangle((330, 40, 370, 170), fill="#8040c0")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    data, width, height = art.prepare_image(buf.getvalue(), request())
    sheet = Image.open(io.BytesIO(data)).convert("RGBA")
    assert (width, height) == (1024, 256)
    assert sheet.getpixel((0, 0))[3] == 0
    bounds = [sheet.crop((i * 256, 0, (i + 1) * 256, 256)).getchannel("A").getbbox() for i in range(4)]
    assert all(b == bounds[0] for b in bounds)
    assert bounds[0][3] <= 248


def test_pack_embedded_before_code_and_removed_from_revision_prompt(workspace):
    pack = pack_with(request())
    html = '<!doctype html><html><head><script>window.game=true</script></head></html>'
    result = art.inject(html, pack)
    assert result.index('id="draw-play-art"') < result.index("window.game=true")
    assert "data:image/svg+xml;base64," in result
    assert art.strip_runtime(result) == html
    assert art.inject(result, pack).count('id="draw-play-art"') == 1
    instructions = art.instructions(pack)["text"]
    assert "hero" in instructions and '"frames": 4' in instructions
    assert "base64" not in instructions and "<svg" not in instructions
    assert "connect-src 'none'" in imagine.CSP


def test_manifest_paths_cannot_escape_cache(workspace):
    secret = workspace / "secret.svg"
    secret.write_text("private")
    assert art._asset_bytes({"file": "../secret.svg"}) is None
    assert art._asset_bytes({"file": str(secret)}) is None
    assert art.inject("<html><script></script></html>", {"assets": [{"file": "../secret.svg"}]}) == "<html><script></script></html>"


def test_art_pass_persists_pack_and_reuses_identical_frames(workspace, monkeypatch):
    calls = []
    asset = request()
    async def call(kind, schema, content, **kwargs):
        calls.append(content)
        return client.MindResult(kind=kind, status="ok", cost_usd=0.1,
                                 value=art.ArtPlan(style="Fantasy", perspective="side view", assets=[asset]))
    monkeypatch.setattr(client, "call", call)
    pack = asyncio.run(art.build("d_11111111", [], source_draft=None, deadline=float("inf"), progress=progress))
    assert len(pack["assets"]) == 1
    assert art.read_pack("d_11111111")["assets"] == pack["assets"]
    asset.reuse, asset.svg = True, None
    reused = asyncio.run(art.build("d_22222222", [], source_draft="d_11111111", deadline=float("inf"), progress=progress))
    assert reused["assets"][0]["file"] == pack["assets"][0]["file"]
    assert "PREVIOUS ART" in calls[-1][-1]["text"]
    assert len(list(art.cache_dir().glob("*.svg"))) == 1


def test_budget_fallback_reuses_pack_without_billing_old_cost(workspace, monkeypatch):
    pack = pack_with(request())
    pack["cost_usd"] = 0.9
    art._atomic(art.pack_path("d_11111111"), json.dumps(pack).encode())
    monkeypatch.setattr(art.jobs, "can_spend", lambda amount: False)
    recovered = asyncio.run(art.build("d_22222222", [], source_draft="d_11111111", deadline=float("inf"), progress=progress))
    assert recovered["assets"] == pack["assets"] and recovered["cost_usd"] == 0


def test_concurrent_art_requests_reserve_budget_before_starting(workspace, monkeypatch):
    monkeypatch.setattr(art, "_reserved_usd", 0)
    monkeypatch.setattr(art.jobs, "can_spend", lambda amount: amount <= 0.3)
    assert art._reserve(0.2)
    assert not art._reserve(0.2)
    art._release(0.2)
    assert art._reserve(0.2)
    art._release(0.2)
    assert art._reserved_usd == 0


def test_bad_asset_does_not_discard_good_asset(workspace, monkeypatch):
    good, bad = request(), request(key="bad", frames=1)
    bad.svg = "broken"
    async def call(*args, **kwargs):
        return client.MindResult(kind="imagine_art", status="ok",
                                 value=art.ArtPlan(style="Fantasy", perspective="side view", assets=[good, bad]))
    monkeypatch.setattr(client, "call", call)
    pack = asyncio.run(art.build("d_11111111", [], source_draft=None, deadline=float("inf"), progress=progress))
    assert [a["key"] for a in pack["assets"]] == ["hero"]


def test_generated_game_receives_manifest_and_packaged_images(workspace, monkeypatch):
    imagine.save("d_11111111", {"better_graphics": True})
    pack = pack_with(request())
    seen = []
    async def build(*args, **kwargs):
        await kwargs["progress"](1, 1)
        assert imagine.read("d_11111111")["phase"] == "painting"
        return {**pack, "cost_usd": 0.1}
    async def call(kind, schema, content, **kwargs):
        seen.extend(content)
        return client.MindResult(kind=kind, status="ok", cost_usd=0.2,
            value=imagine.ImaginedGame(title="Moon", summary="Explore", controls=["Arrows"],
                html='<html><body><script>/* drawPlayArt hero */' + "x" * 1100 + '</script></body></html>'))
    monkeypatch.setattr(art, "build", build)
    monkeypatch.setattr(client, "call", call)
    asyncio.run(imagine.generate("d_11111111", {"strokes": []}, None, "Explore the moon", ""))
    state = imagine.read("d_11111111")
    assert state["status"] == "ready" and state["cost_usd"] == pytest.approx(0.3)
    assert state["art"]["asset_count"] == 1
    assert art.read_pack("d_11111111")["assets"] == pack["assets"]
    assert "GENERATED ART PACK" in seen[-1]["text"]
    assert "data:image/svg+xml;base64," in imagine.artifact_path("d_11111111").read_text()


def test_art_timeout_recovers_completed_assets(workspace, monkeypatch):
    imagine.save("d_11111111", {"better_graphics": True})
    pack = pack_with(request())
    async def build(*args, **kwargs):
        art._atomic(art.pack_path("d_11111111"), json.dumps(pack).encode())
        raise TimeoutError()
    async def call(*args, **kwargs):
        return client.MindResult(kind="imagine", status="ok",
            value=imagine.ImaginedGame(title="Moon", summary="Explore", controls=[],
                html='<html><script>' + "/* content */" * 100 + '</script></html>'))
    monkeypatch.setattr(art, "build", build)
    monkeypatch.setattr(client, "call", call)
    asyncio.run(imagine.generate("d_11111111", {"strokes": []}, None, "Moon", ""))
    assert imagine.read("d_11111111")["status"] == "ready"
    assert "draw-play-art" in imagine.artifact_path("d_11111111").read_text()


def test_empty_interrupted_pack_preserves_previous_art_and_its_new_cost(workspace, monkeypatch):
    pack = pack_with(request())
    pack["cost_usd"] = 0.9
    art.save_pack("d_11111111", pack)
    imagine.save("d_22222222", {"revision_of": "d_11111111", "better_graphics": True})
    async def build(*args, **kwargs):
        art.save_pack("d_22222222", {"assets": [], "cost_usd": 0.05})
        raise TimeoutError()
    async def call(*args, **kwargs):
        return client.MindResult(kind="imagine", status="ok", cost_usd=0.2,
            value=imagine.ImaginedGame(title="Moon", summary="Explore", controls=[],
                html='<html><script>' + "/* content */" * 100 + '</script></html>'))
    monkeypatch.setattr(art, "build", build)
    monkeypatch.setattr(client, "call", call)
    asyncio.run(imagine.generate("d_22222222", {"strokes": []}, None, "Moon", ""))
    assert imagine.read("d_22222222")["cost_usd"] == pytest.approx(0.25)
    assert art.read_pack("d_22222222")["assets"] == pack["assets"]


def test_firefly_uses_scenery_as_shared_reference(workspace, monkeypatch):
    bg = request(key="scenery", kind="backdrop", frames=1)
    hero = request(frames=1)
    calls = []
    async def call(*args, **kwargs):
        return client.MindResult(kind="imagine_art", status="ok",
            value=art.ArtPlan(style="Moonlight", perspective="side view", assets=[bg, hero]))
    image = Image.new("RGB", (100, 100), "white")
    ImageDraw.Draw(image).rectangle((20, 20, 80, 80), fill="#4080c0")
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    class Firefly:
        def __init__(self, settings):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *args):
            pass
        async def generate(self, prompt, **kwargs):
            calls.append(kwargs)
            return ["https://example.test/image"]
        async def download(self, url):
            return buf.getvalue()
        async def upload(self, data, **kwargs):
            assert Image.open(io.BytesIO(data)).size == (1280, 720)
            return "shared-style"
    monkeypatch.setattr(client, "call", call)
    monkeypatch.setattr(cs, "provider", lambda: "firefly")
    monkeypatch.setattr(art, "Firefly", Firefly)
    pack = asyncio.run(art.build("d_11111111", [], source_draft=None, deadline=float("inf"), progress=progress))
    assert len(pack["assets"]) == 2
    assert calls[0]["style_upload"] is None and calls[1]["style_upload"] == "shared-style"
    assert all(a["file"].endswith(".webp") for a in pack["assets"])


def test_library_rejects_paths_outside_pack(workspace, monkeypatch):
    library = workspace / 'library'
    pack_dir = library / 'moon'
    pack_dir.mkdir(parents=True)
    Image.new('RGB', (32, 18), '#162546').save(workspace / 'private.png')
    (pack_dir / 'manifest.json').write_text(json.dumps({
        'id': 'moon', 'assets': [{'key': 'scenery', 'kind': 'backdrop', 'frames': 1,
                                 'description': 'Moon', 'filename': '../../private.png'}]}))
    monkeypatch.setattr(art.asset_library, 'ROOT', library)
    assert art.asset_library.catalog() == []
    assert art.asset_library.load('moon:scenery') is None
    (pack_dir / 'escape.png').symlink_to(workspace / 'private.png')
    manifest = json.loads((pack_dir / 'manifest.json').read_text())
    manifest['assets'][0]['filename'] = 'escape.png'
    (pack_dir / 'manifest.json').write_text(json.dumps(manifest))
    assert art.asset_library.load('moon:scenery') is None


def test_finished_raster_pack_needs_no_firefly_credentials(workspace, monkeypatch):
    library = workspace / 'library'
    pack_dir = library / 'moon'
    pack_dir.mkdir(parents=True)
    Image.new('RGB', (320, 180), '#162546').save(pack_dir / 'moon.png')
    (pack_dir / 'manifest.json').write_text(json.dumps({
        'id': 'moon', 'provider': 'openai-imagegen', 'style': 'Realistic moon',
        'assets': [{'key': 'scenery', 'kind': 'backdrop', 'frames': 1,
                    'description': 'Moon landscape', 'filename': 'moon.png'}]}))
    monkeypatch.setattr(art.asset_library, 'ROOT', library)
    monkeypatch.setattr(cs, 'provider', lambda: 'firefly')
    def forbidden(*args, **kwargs):
        pytest.fail('Saved images must not instantiate Firefly')
    monkeypatch.setattr(art, 'Firefly', forbidden)
    seen = []
    async def call(*args, **kwargs):
        seen.extend(args[2])
        asset = request(key='scenery', kind='backdrop', frames=1, library_asset='moon:scenery')
        asset.svg = None
        return client.MindResult(kind='imagine_art', status='ok', value=art.ArtPlan(
            style='Realistic moon', perspective='side view', assets=[asset]))
    monkeypatch.setattr(client, 'call', call)
    pack = asyncio.run(art.build('d_11111111', [], source_draft=None, deadline=float('inf'), progress=progress))
    assert pack['provider'] == 'image-library'
    assert pack['assets'][0]['provider'] == 'openai-imagegen'
    assert (pack['assets'][0]['width'], pack['assets'][0]['height']) == (320, 180)
    assert 'moon:scenery' in seen[-1]['text']
    html = art.inject('<html><head><script>window.game=true</script></head></html>', pack)
    assert 'data:image/webp;base64,' in html
    assert 'firefly' not in html


@pytest.mark.parametrize('selected', [False, True])
def test_only_opted_in_games_run_sonnet_svg_pass(workspace, monkeypatch, selected):
    imagine.save('d_11111111', {'better_graphics': selected})
    calls = []
    async def build(*args, **kwargs):
        calls.append(kwargs)
        return pack_with(request())
    async def call(kind, schema, content, **kwargs):
        assert ('Better graphics selected' if selected else 'Standard graphics') in str(content)
        return client.MindResult(kind=kind, status='ok', value=imagine.ImaginedGame(
            title='Forest Puzzle', summary='Find a key.', controls=['Arrows'],
            html='<html><script>' + '/* play */' * 150 + '</script></html>'))
    monkeypatch.setattr(art, 'build', build)
    monkeypatch.setattr(client, 'call', call)
    asyncio.run(imagine.generate('d_11111111', {'strokes': []}, None, 'Forest puzzle', ''))
    assert imagine.read('d_11111111')['status'] == 'ready'
    assert len(calls) == int(selected)
    if selected:
        assert calls[0]['provider'] == 'claude-svg' and calls[0]['use_library'] is False
    else:
        assert 'draw-play-art' not in imagine.artifact_path('d_11111111').read_text()
