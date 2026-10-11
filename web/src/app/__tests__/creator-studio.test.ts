import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api.ts';
import { store } from '../store.ts';
import { creationInk, creationPrompt, type CreationDraft } from '../game-brief.ts';
import { emptyDoc } from '../../editor/doc.ts';

let data: Map<string, string>;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  data = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
  fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ games: [], levels: [] })));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('personal creator studio', () => {
  it('asks for personal games with encoded author and remembered modifications', async () => {
    store.setAuthor('Alex & Jo');
    store.rememberGame('game_edited');
    await api.games('new', true);
    const url = new URL(fetchMock.mock.calls[0][0], 'http://localhost');
    expect(url.searchParams.get('scope')).toBe('mine');
    expect(url.searchParams.get('author')).toBe('Alex & Jo');
    expect(url.searchParams.get('ids')).toBe('game_edited');
  });
  it('remembers a successful creation, and leaves ordinary reads out', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ game: { id: 'game_new', title: 'New' } })));
    await api.createGame('New', 'Alex');
    expect(store.studioGames()).toEqual(['game_new']);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ game: { id: 'game_other' } })));
    await api.game('game_other');
    expect(store.studioGames()).toEqual(['game_new']);
  });
  it('tracks accepted builds but does not track failed modifications', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ build_id: 'build', draft_id: 'draft' })));
    const form = new FormData();
    form.set('game_id', 'game_edited');
    await api.createBuild(form);
    expect(store.studioGames()).toEqual(['game_edited']);
    fetchMock.mockResolvedValue(new Response('{}', { status: 500 }));
    await expect(api.imagineGame({ ink: {} as never, game_id: 'game_failed', context: '', title: '' })).rejects.toThrow();
    expect(store.studioGames()).toEqual(['game_edited']);
  });
  it('keeps accurate level counts when a feed preview contains fewer levels', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ games: [{ id: 'g', level_count: 12, levels: [] }] })));
    expect((await api.games('new', true)).games[0].level_count).toBe(12);
  });
});

describe('single game prompt', () => {
  const draft = (): CreationDraft => ({ title: '', author: '', gameId: null, doc: emptyDoc(),
    brief: { category: 'adventure', custom_definition: '', theme: 'Wizard school', gameplay: 'Find stars', details: 'No enemies' } });
  it('preserves all ideas from the previous form and removes duplicate context', () => {
    const saved = draft();
    saved.doc.imaginationContext = 'Wizard school with moving stairs';
    expect(creationPrompt(saved)).toBe('Wizard school with moving stairs\n\nFind stars\n\nNo enemies');
  });
  it('preserves older full-length context alongside the other brief fields', () => {
    const saved = draft();
    saved.doc.imaginationContext = 'Moving stairs. '.repeat(260);
    const prompt = creationPrompt(saved);
    expect(prompt).toContain(saved.doc.imaginationContext.trim());
    expect(prompt).toContain(saved.brief.theme);
    expect(prompt).toContain(saved.brief.gameplay);
    expect(prompt).toContain(saved.brief.details);
  });
  it('respects edits that replace or clear a migrated prompt', () => {
    const saved = draft();
    saved.prompt = 'Race on the moon';
    expect(creationPrompt(saved)).toBe(saved.prompt);
    saved.prompt = '';
    expect(creationPrompt(saved)).toBe('');
    expect(creationPrompt(null)).toBe('');
  });
  it('sends the complete prompt and chosen category without requiring ink', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_game', status: 'building' })));
    const context = 'A moon racing game. ' + 'Jump over craters. '.repeat(70);
    await api.imagineGame({ game_id: 'game_new', category: 'racing', context, title: '' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toEqual({ game_id: 'game_new', category: 'racing', context, title: '' });
    expect(store.studioGames()).toEqual(['game_new']);
  });
});

describe('draft creation and publication', () => {
  it('sends a chat change with creator access and carries access to the revision', async () => {
    store.setDraftToken('d_original', 'creator-secret');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_revision', game_id: 'game_original', status: 'building' })));
    const revision = await api.refineImaginedGame('d_original', 'Add double jump');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/v2/imagined-games/d_original/refine');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message: 'Add double jump', token: 'creator-secret' });
    expect(store.draftToken(revision.draft_id)).toBe('creator-secret');
    expect(store.studioGames()).toEqual(['game_original']);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_retry', status: 'building' })));
    await api.retryImaginedGame('d_revision');
    expect(fetchMock.mock.calls[1][1].headers['X-DP-Draft']).toBe('creator-secret');
    expect(store.draftToken('d_retry')).toBe('creator-secret');
  });
  it('keeps unsent chat changes separate for each draft', () => {
    store.setChatInput('d_one', 'Add a timer');
    store.setChatInput('d_two', 'Make it blue');
    expect(store.chatInput('d_one')).toBe('Add a timer');
    expect(store.chatInput('d_two')).toBe('Make it blue');
    store.setChatInput('d_one', '');
    expect(store.chatInput('d_one')).toBe('');
    expect(store.chatInput('d_two')).toBe('Make it blue');
  });
  it.each(['Make these platforms move', ''])('sends canvas updates with an optional message: %s', async (message) => {
    const doc = emptyDoc({ screens: 2, rules: [{ id: 'rule1', text: 'Platforms move', strokeId: null }] });
    doc.strokes = [{ id: 's2', color: 'blue', kind: 'line', pts: [[4, 8], [30, 8]], w: [0.6], closed: false, sheet: 0, origin: 'kid' }];
    store.setDraftToken('d_canvas', 'canvas-secret');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_canvas_revision', status: 'building', canvas_updated: true })));
    const ink = creationInk(doc);
    const revision = await api.refineImaginedGame('d_canvas', message, ink);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ message, ink, token: 'canvas-secret' });
    expect(revision.canvas_updated).toBe(true);
    expect(store.draftToken(revision.draft_id)).toBe('canvas-secret');
  });
  it('keeps pending canvases separate from accepted inputs and other drafts', () => {
    const accepted = emptyDoc({ screens: 2 });
    const updated = emptyDoc({ screens: 3 });
    store.setDraftDoc('d_one', accepted);
    store.setChatCanvas('d_one', updated);
    store.setChatCanvas('d_two', emptyDoc({ screens: 4 }));
    expect(store.chatCanvas('d_one')).toEqual(updated);
    expect(store.draftDoc('d_one')).toEqual(accepted);
    store.setChatCanvas('d_one', null);
    expect(store.chatCanvas('d_one')).toBeNull();
    expect(store.draftDoc('d_one')).toEqual(accepted);
    expect(store.chatCanvas('d_two')?.screens).toBe(4);
  });
  it('keeps the draft private when creating a game', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ game: { id: 'game_draft', draft: true } })));
    const game = await api.createGame('New game', 'Alex', undefined, true);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).draft).toBe(true);
    expect(game.draft).toBe(true);
  });
  it('keeps the publication token locally and supplies it only when publishing', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_created', publish_token: 'creator-secret' })));
    await api.imagineGame({ game_id: 'game_new', context: 'Moon racing', title: '', category: 'racing' });
    expect(store.draftToken('d_created')).toBe('creator-secret');
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_created', publication: 'published' })));
    await api.publishImaginedGame('d_created');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v2/imagined-games/d_created/publish');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ token: 'creator-secret' });
  });
  it('sends the latest canvas, character and notes without converting shapes to game objects', () => {
    const doc = emptyDoc({ screens: 3, rules: [{ id: 'rule1', text: 'This arrow is wind', strokeId: null }] });
    const stroke = { id: 's1', color: 'blue', kind: 'line', pts: [[1, 2], [3, 4]], w: [0.6], closed: false, sheet: 0, origin: 'kid' } as const;
    doc.strokes = [JSON.parse(JSON.stringify(stroke))];
    doc.character = [JSON.parse(JSON.stringify({ ...stroke, id: 'c1' }))];
    const ink = creationInk(doc);
    expect(ink.world).toEqual({ screens: 3, w: 144, h: 27 });
    expect(ink.strokes).toEqual(doc.strokes);
    expect(ink.character?.strokes).toEqual(doc.character);
    expect(ink.typed_rules).toEqual([{ text: 'This arrow is wind' }]);
    expect(ink.components).toEqual([]);
  });
});

describe('generated game levels', () => {
  it('appends to the same game and retains the accepted level slot and publication token', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_second', level_id: 'd_second', level_number: 2, publish_token: 'level-secret' })));
    const result = await api.imagineGame({ game_id: 'game_original', append_level: true, category: 'adventure', context: 'An ice cave', title: '', ink: creationInk(emptyDoc()) });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).append_level).toBe(true);
    expect(result.level_number).toBe(2);
    expect(store.draftToken(result.draft_id)).toBe('level-secret');
    expect(store.studioGames()).toEqual(['game_original']);
  });
  it('preserves the initial level and selected edit identity in game responses', async () => {
    const first = { draft_id: 'd_first', level_id: 'level_one', level_number: 1, status: 'ready' };
    const second = { draft_id: 'd_second', level_id: 'level_two', level_number: 2, status: 'ready' };
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ game: { id: 'game_original', generated: first, generated_levels: [first, second] }, levels: [] })));
    const game = await api.game('game_original');
    expect(game.generated?.draft_id).toBe('d_first');
    expect(game.generated_levels?.map(level => level.level_id)).toEqual(['level_one', 'level_two']);
    expect(game.level_count).toBe(2);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_edit', level_id: 'level_two', level_number: 2 })));
    await api.imagineGame({ game_id: game.id, level_id: 'level_two', context: 'A brighter ice cave', title: '' });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).level_id).toBe('level_two');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).append_level).toBeUndefined();
  });
});

describe('independent game and level drafts', () => {
  const draft = (prompt: string, gameId: string | null = null): CreationDraft => ({
    kind: gameId ? 'level' : 'game', prompt, gameId, title: '', author: 'Creator', doc: emptyDoc({ gameId }),
    brief: { category: 'action', custom_definition: '', theme: '', gameplay: '', details: '' },
  });
  it('keeps a new game separate from new levels and edits in different games', () => {
    store.setCreationDraft(draft('New fighting game'));
    store.setLevelCreationDraft('game_a', 'new', draft('Ice caves', 'game_a'));
    store.setLevelCreationDraft('game_a', 'level_one', draft('Edit the first level', 'game_a'));
    store.setLevelCreationDraft('game_b', 'new', draft('Moon race', 'game_b'));
    expect(store.creationDraft()?.prompt).toBe('New fighting game');
    expect(store.creationDraft()?.gameId).toBeNull();
    expect(store.levelCreationDraft('game_a', 'new')?.prompt).toBe('Ice caves');
    expect(store.levelCreationDraft('game_a', 'level_one')?.prompt).toBe('Edit the first level');
    expect(store.levelCreationDraft('game_b', 'new')?.prompt).toBe('Moon race');
    store.setLevelCreationDraft('game_a', 'new', null);
    expect(store.creationDraft()?.prompt).toBe('New fighting game');
    expect(store.levelCreationDraft('game_a', 'level_one')?.prompt).toBe('Edit the first level');
    store.setCreationDraft(null);
    expect(store.levelCreationDraft('game_b', 'new')?.prompt).toBe('Moon race');
  });
  it('never loads a legacy level into Create game and recovers it only for its original level', () => {
    const old = { ...draft('Saved level drawing', 'game_a'), kind: undefined, levelId: 'level_one' };
    data.set('dal.v2.creation', JSON.stringify(old));
    expect(store.creationDraft()).toBeNull();
    expect(store.levelCreationDraft('game_b', 'level_one')).toBeNull();
    expect(store.levelCreationDraft('game_a', 'new')).toBeNull();
    expect(store.levelCreationDraft('game_a', 'level_one')?.prompt).toBe('Saved level drawing');
    store.setLevelCreationDraft('game_a', 'level_one', null);
    expect(store.levelCreationDraft('game_a', 'level_one')).toBeNull();
    expect(JSON.parse(data.get('dal.v2.creation.legacy-backup')!).prompt).toBe('Saved level drawing');
  });
  it('routes a stale level save away from the new-game draft and keeps the canvases isolated', () => {
    const game = draft('New game');
    game.doc.strokes = [{ id: 'game-stroke' } as never];
    store.setCreationDraft(game);
    const level = { ...draft('Level draft', 'game_a'), appendLevel: true };
    level.doc.strokes = [{ id: 'level-stroke' } as never];
    store.setCreationDraft(level);
    expect(store.creationDraft()?.doc.strokes[0].id).toBe('game-stroke');
    expect(store.levelCreationDraft('game_a', 'new')?.doc.strokes[0].id).toBe('level-stroke');
    expect(store.creationDraft()?.levelId).toBeUndefined();
  });
});

describe('opt-in graphics', () => {
  it('preserves a draft graphics choice and sends it explicitly to creation', async () => {
    const saved: CreationDraft = { kind: 'game', title: '', author: '', prompt: 'Ocean race', gameId: null,
      doc: emptyDoc({ betterGraphics: true }), brief: { category: 'racing', custom_definition: '', theme: '', gameplay: '', details: '' } };
    store.setCreationDraft(saved);
    expect(store.creationDraft()?.doc.betterGraphics).toBe(true);
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_svg', game_id: null })));
    await api.imagineGame({ context: 'Ocean race', title: '', game_id: null, better_graphics: true });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).better_graphics).toBe(true);
  });
  it('allows selecting or disabling graphics on the next chat build', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ draft_id: 'd_new', game_id: null })));
    await api.refineImaginedGame('d_old', '', undefined, false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).better_graphics).toBe(false);
  });
});

it('keeps automatic faithful SVG generation off until explicitly selected', async () => {
  vi.doMock('../../engine/index.ts', () => ({ loadSkinImage: vi.fn() }));
  const { gameLife, setGameLife } = await import('../creative/session.ts');
  expect(gameLife(null)).toBe(false);
  setGameLife(null, true);
  expect(gameLife(null)).toBe(true);
  setGameLife(null, false);
  expect(gameLife(null)).toBe(false);
});
