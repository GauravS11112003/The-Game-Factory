import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { parseCommand, resultText, type Match } from './commands.ts';
import { GameApi, MessageWorker, type Transport } from './worker.ts';

const matchId = 'r_' + 'a'.repeat(24);
const invite = 'b'.repeat(43);
function match(): Match {
  return { id: matchId, title: 'Meadow', phase: 'waiting', round: 1, winner: null, expires_at: Date.now() / 1000 + 86400, players: [] };
}

class FakeApi extends GameApi {
  creates = 0;
  lastBody: unknown;
  current = match();
  constructor() { super('http://unused.example', 'test-secret'); }
  override async call<T>(method: string, _path?: string, body?: unknown): Promise<T> {
    if (method === 'POST') { this.creates++; this.lastBody = body; return { match: this.current, invite } as T; }
    return this.current as T;
  }
}

test('commands ignore unrelated messages and validate invitation structure', () => {
  assert.deepEqual(parseCommand('race lvl_world_l1'), { kind: 'race', levelId: 'lvl_world_l1' });
  assert.deepEqual(parseCommand('race lvl_world_l1 v3'), { kind: 'race', levelId: 'lvl_world_l1', version: 3 });
  assert.equal(parseCommand('race lvl_world_l1 v0'), null);
  assert.deepEqual(parseCommand(`invite ${matchId} ${invite}`), { kind: 'invite', matchId, invite });
  assert.equal(parseCommand('race ../../private'), null);
  assert.equal(parseCommand('invite r_invalid token'), null);
  assert.equal(parseCommand('Are you free tonight?'), null);
  assert.deepEqual(parseCommand('HELP'), { kind: 'help' });
});

test('duplicate delivery creates and sends one game card', async () => {
  const db = new DatabaseSync(':memory:');
  const api = new FakeApi();
  const sent: unknown[] = [];
  const transport: Transport = { async send(_space, _phone, content) { sent.push(content); } };
  const worker = new MessageWorker(db, api, transport, 'https://draw.example');
  worker.enqueue('message-1', 'chat', 'line', 'race lvl_world_l1');
  worker.enqueue('message-1', 'chat', 'line', 'race lvl_world_l1');
  await worker.tick();
  await worker.tick();
  assert.equal(api.creates, 1);
  assert.deepEqual(sent, [{ url: `https://draw.example/api/v2/matches/${matchId}/card?invite=${invite}` }]);
  db.close();
});

test('a Messages launch pins the selected version and leaves both seats open', async () => {
  const db = new DatabaseSync(':memory:');
  const api = new FakeApi();
  const worker = new MessageWorker(db, api, { async send() {} }, 'https://draw.example');
  worker.enqueue('version-message', 'chat', 'line', 'race lvl_world_l1 v3');
  await worker.tick();
  assert.deepEqual(api.lastBody, { level_id: 'lvl_world_l1', reserve_host: false, version: 3 });
  db.close();
});

test('an interrupted send retries the prepared card without creating another match', async () => {
  const db = new DatabaseSync(':memory:');
  const api = new FakeApi();
  let attempts = 0;
  const transport: Transport = { async send() { if (++attempts === 1) throw new Error('offline'); } };
  const worker = new MessageWorker(db, api, transport, 'https://draw.example');
  worker.enqueue('message-1', 'chat', 'line', 'race lvl_world_l1');
  await worker.tick();
  db.prepare('UPDATE commands SET next_at = 0').run();
  await worker.tick();
  assert.equal(api.creates, 1);
  assert.equal(attempts, 2);
  assert.equal((db.prepare('SELECT done FROM commands').get() as { done: number }).done, 1);
  db.close();
});

test('result notifications survive a service restart and publish each round once', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'draw-imessage-'));
  const file = join(directory, 'state.sqlite');
  const api = new FakeApi();
  const sent: unknown[] = [];
  const transport: Transport = { async send(_space, _phone, content) { sent.push(content); } };
  let db = new DatabaseSync(file);
  let worker = new MessageWorker(db, api, transport, 'https://draw.example');
  worker.enqueue('message-1', 'chat', 'line', `invite ${matchId} ${invite}`);
  await worker.tick();
  db.close();
  db = new DatabaseSync(file);
  worker = new MessageWorker(db, api, transport, 'https://draw.example');
  api.current = { ...api.current, phase: 'finished', winner: 1, players: [
    { seat: 1, name: 'Maya', forfeit: false, result: { elapsed_ms: 5100, verified: true } },
    { seat: 2, name: 'Sam', forfeit: false, result: { elapsed_ms: 6000, verified: true } },
  ] };
  await worker.tick();
  await worker.tick();
  assert.equal(sent.length, 2);
  assert.match((sent[1] as { text: string }).text, /Maya wins!/);
  api.current = { ...api.current, round: 2, winner: 2 };
  await worker.tick();
  assert.equal(sent.length, 3);
  db.close();
  rmSync(directory, { recursive: true });
});

test('a forfeited race does not invent verified times', () => {
  const text = resultText({ ...match(), phase: 'finished', players: [{ seat: 1, name: 'Maya', result: null, forfeit: true }] });
  assert.match(text, /Neither player finished/);
  assert.doesNotMatch(text, /\(verified\)/);
});
