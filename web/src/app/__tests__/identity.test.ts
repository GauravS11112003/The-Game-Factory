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

describe('Auth0 accounts', () => {
  it('uses the server session and removes migrated device credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true, player: account.player }))));
    const identity = await import('../identity.ts');
    await identity.initializeIdentity();
    expect(identity.usesAuth0()).toBe(true);
    expect(identity.currentPlayer()?.id).toBe(account.player.id);
    expect(identity.authHeaders()).toEqual({ 'X-DP-CSRF': '1' });
    expect(identity.secretCode()).toBeNull();
    expect(data.has('dp.v3.player')).toBe(false);
  });

  it('does not treat a legacy device profile as an Auth0 session', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ enabled: true, player: null }))));
    const identity = await import('../identity.ts');
    await identity.initializeIdentity();
    expect(identity.currentPlayer()).toBeNull();
    // Keep the credential only until its owner completes migration.
    expect(data.has('dp.v3.player')).toBe(true);
    await expect(identity.useSecretCode('pl_pranay.saved-token')).rejects.toThrow('auth.sign_in_required');
  });

  it('sends legacy proof only when preparing login and restores the route', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { hash: '#/studio', assign } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, player: null })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login_url: '/api/auth/login' })));
    vi.stubGlobal('fetch', fetcher);
    const identity = await import('../identity.ts');
    await identity.initializeIdentity();
    await identity.signIn();
    expect(fetcher.mock.calls[1][1].headers['X-DP-Player']).toBe('pl_pranay.saved-token');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ return_to: '/#/studio' });
    expect(assign).toHaveBeenCalledWith('/api/auth/login');
  });

  it('clears an expired account session when refreshed', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, player: account.player })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, player: null }))));
    const identity = await import('../identity.ts');
    await identity.initializeIdentity();
    await identity.refreshPlayer();
    expect(identity.currentPlayer()).toBeNull();
  });

  it('revokes the session before navigating to Auth0 logout', async () => {
    const assign = vi.fn();
    vi.stubGlobal('window', { location: { assign } });
    const logoutUrl = 'https://tenant.auth0.com/v2/logout';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ enabled: true, player: account.player })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ logout_url: logoutUrl }))));
    const identity = await import('../identity.ts');
    await identity.initializeIdentity();
    await identity.signOut();
    expect(identity.currentPlayer()).toBeNull();
    expect(assign).toHaveBeenCalledWith(logoutUrl);
  });
});
