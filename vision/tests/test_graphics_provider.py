"""Sonnet SVG requests never depend on Firefly credentials or an example pack."""
import asyncio

import pytest

from app.creative import jobs
from app.mind import art_prompt, client


def test_svg_art_uses_the_configured_sonnet_for_sprites_and_scenery(monkeypatch):
    monkeypatch.setenv('DAL_SONNET_MODEL', 'configured-sonnet')
    calls = []
    async def call(kind, schema, content, **kwargs):
        calls.append((kind, kwargs))
        return client.MindResult(kind=kind, status='skipped')
    monkeypatch.setattr(client, 'call', call)
    asyncio.run(art_prompt.art_svg(b'png', hint='Explorer', style_text='Woodland', view_w=256, view_h=256))
    asyncio.run(art_prompt.art_backdrop(theme='Forest', style_text='Woodland', view_w=1600, view_h=900, screens=1))
    assert [kind for kind, _ in calls] == ['art_svg', 'art_backdrop']
    assert all(kwargs['model'] == 'configured-sonnet' for _, kwargs in calls)


def test_explicit_svg_provider_does_not_fall_back_to_firefly(monkeypatch):
    monkeypatch.setattr(jobs.cs, 'provider', lambda: 'firefly')
    monkeypatch.setattr(jobs, 'budget_left', lambda: 5)
    monkeypatch.setattr(client, 'available', lambda: True)
    assert jobs._provider_or_raise('claude-svg') == 'claude-svg'
    monkeypatch.setattr(client, 'available', lambda: False)
    with pytest.raises(jobs.CreativeError, match='creative.off'):
        jobs._provider_or_raise('claude-svg')
