import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const account = { player: { id: 'pl_pranay', name: 'Pranay', avatar_url: null }, token: 'saved-token' };
let data: Map<string, string>;

beforeEach(() => {
  vi.resetModules();
  data = new Map([['dp.v3.player', JSON.stringify(account)]]);
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('remembered identity', () => {
  it('restores the account and creator name after a reload', async () => {
    const identity = await import('../identity.ts');
    expect(identity.currentPlayer()?.name).toBe('Pranay');
    expect(identity.authHeaders()['X-DP-Player']).toBe('pl_pranay.saved-token');
    expect(JSON.parse(data.get('dal.v2.author')!)).toBe('Pranay');
  });

  it('keeps the saved account while offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const identity = await import('../identity.ts');
    await identity.refreshPlayer();
    expect(identity.currentPlayer()?.id).toBe(account.player.id);
    expect(data.has('dp.v3.player')).toBe(true);
  });

  it('does not let an old rejected login check sign out a newer session', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ player: account.player }), { status: 200 })));
    const identity = await import('../identity.ts');
    const refreshing = identity.refreshPlayer();
    await identity.useSecretCode('pl_pranay.new-token');
    finish(new Response(null, { status: 401 }));
    await refreshing;
    expect(identity.secretCode()).toBe('pl_pranay.new-token');
    expect(JSON.parse(data.get('dp.v3.player')!).token).toBe('new-token');
  });
});
