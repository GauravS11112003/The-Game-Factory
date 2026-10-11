import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseCommand, resultText, HELP, type Command, type Match } from './commands.ts';

export interface Transport {
  send(spaceId: string, phone: string, content: { text: string } | { url: string; title?: string; browserUrl?: string }): Promise<void>;
}

interface Job {
  id: string; space: string; phone: string; command: string; prepared: string | null; attempts: number;
}
interface Subscription { match_id: string; space: string; phone: string; invite: string; sent_round: number; expires_at: number; endpoint: 'matches' | 'play-rooms' }

export class ApiFailure extends Error {
  readonly status: number;
  constructor(status: number) { super(`Game API returned ${status}`); this.status = status; }
}

export class GameApi {
  private base: string;
  private serviceSecret: string;
  constructor(base: string, serviceSecret: string) { this.base = base; this.serviceSecret = serviceSecret; }
  async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, endpoint: 'matches' | 'play-rooms' = 'matches'): Promise<T> {
    const response = await fetch(`${this.base.replace(/\/$/, '')}/api/v2/${endpoint}${path}`, {
      method, headers: { 'Content-Type': 'application/json', 'X-Spectrum-Service': this.serviceSecret, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new ApiFailure(response.status);
    return await response.json() as T;
  }
}

/** One worker per state database. An interrupted send may be retried (at-least-once delivery). */
export class MessageWorker {
  private busy = false;
  private db: DatabaseSync;
  private api: GameApi;
  private transport: Transport;
  private publicUrl: string;
  constructor(db: DatabaseSync, api: GameApi, transport: Transport, publicUrl: string) {
    this.db = db; this.api = api; this.transport = transport; this.publicUrl = publicUrl;
    db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS commands (
        id TEXT PRIMARY KEY, space TEXT NOT NULL, phone TEXT NOT NULL, command TEXT NOT NULL,
        prepared TEXT, attempts INTEGER NOT NULL DEFAULT 0, next_at REAL NOT NULL DEFAULT 0, done INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        match_id TEXT NOT NULL, space TEXT NOT NULL, phone TEXT NOT NULL, invite TEXT NOT NULL,
        sent_round INTEGER NOT NULL DEFAULT 0, expires_at REAL NOT NULL,
        PRIMARY KEY(match_id, space, phone)
      );`);
    const columns = db.prepare('PRAGMA table_info(subscriptions)').all() as { name: string }[];
    if (!columns.some(c => c.name === 'endpoint')) db.exec("ALTER TABLE subscriptions ADD COLUMN endpoint TEXT NOT NULL DEFAULT 'matches'");
  }

  enqueue(messageId: string, space: string, phone: string, text: string): boolean {
    const command = parseCommand(text);
    if (!command) return false;
    const id = createHash('sha256').update(`${phone}:${space}:${messageId}`).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO commands(id, space, phone, command) VALUES (?, ?, ?, ?)')
      .run(id, space, phone, JSON.stringify(command));
    return true;
  }

  private cardUrl(id: string, invite: string, endpoint = 'matches'): string {
    return `${this.publicUrl.replace(/\/$/, '')}/api/v2/${endpoint}/${id}/card?invite=${encodeURIComponent(invite)}`;
  }

  private async process(job: Job): Promise<void> {
    const command = JSON.parse(job.command) as Command;
    let prepared = job.prepared ? JSON.parse(job.prepared) as { url?: string; match?: Match; invite?: string; endpoint?: 'matches' | 'play-rooms' } : null;
    if (!prepared) {
      if (command.kind === 'play') {
        const created = await this.api.call<{ match: Match; invite: string }>('POST', '',
          { draft_id: command.draftId, reserve_host: false }, { 'X-Race-Request': job.id }, 'play-rooms');
        prepared = { match: created.match, invite: created.invite, url: this.cardUrl(created.match.id, created.invite, 'play-rooms'), endpoint: 'play-rooms' };
      } else if (command.kind === 'race') {
        const created = await this.api.call<{ match: Match; invite: string }>('POST', '',
          { level_id: command.levelId, reserve_host: false, ...(command.version ? { version: command.version } : {}) }, { 'X-Race-Request': job.id });
        prepared = { match: created.match, invite: created.invite, url: this.cardUrl(created.match.id, created.invite) };
      } else if (command.kind === 'invite') {
        const endpoint = command.matchId.startsWith('room_') ? 'play-rooms' : 'matches';
        const match = await this.api.call<Match>('GET', `/${command.matchId}`, undefined, { 'X-Race-Invite': command.invite }, endpoint);
        prepared = { match, invite: command.invite, url: this.cardUrl(match.id, command.invite, endpoint), endpoint };
      } else prepared = {};
      this.db.prepare('UPDATE commands SET prepared = ? WHERE id = ?').run(JSON.stringify(prepared), job.id);
    }
    if (prepared.url && prepared.match && prepared.invite) {
      const generated = prepared.endpoint === 'play-rooms';
      await this.transport.send(job.space, job.phone, { url: prepared.url, ...(generated ? {
        title: prepared.match.title ?? 'Play with a friend',
        browserUrl: `${this.publicUrl.replace(/\/$/, '')}/#/room/${prepared.match.id}?invite=${encodeURIComponent(prepared.invite)}`,
      } : {}) });
      this.db.prepare(`INSERT INTO subscriptions(match_id, space, phone, invite, expires_at, endpoint) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id, space, phone) DO UPDATE SET invite=excluded.invite, expires_at=excluded.expires_at`)
        .run(prepared.match.id, job.space, job.phone, prepared.invite, prepared.match.expires_at, prepared.endpoint ?? 'matches');
    } else await this.transport.send(job.space, job.phone, { text: HELP });
    this.db.prepare('UPDATE commands SET done = 1 WHERE id = ?').run(job.id);
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const now = Date.now() / 1000;
      const jobs = this.db.prepare('SELECT * FROM commands WHERE done = 0 AND next_at <= ? LIMIT 5').all(now) as unknown as Job[];
      for (const job of jobs) {
        try { await this.process(job); }
        catch (error) {
          if (error instanceof ApiFailure && [400, 403, 404, 409, 422].includes(error.status)) {
            try {
              await this.transport.send(job.space, job.phone, { text: 'That game invitation is unavailable. Open draw.play to invite your friend again.' });
              this.db.prepare('UPDATE commands SET done = 1 WHERE id = ?').run(job.id);
              continue;
            } catch { /* Retry the notification when connectivity returns. */ }
          }
          this.db.prepare('UPDATE commands SET attempts = attempts + 1, next_at = ? WHERE id = ?')
            .run(now + Math.min(60, 2 ** Math.min(job.attempts + 1, 6)), job.id);
          console.error('An iMessage command will retry.');
        }
      }
      const subscriptions = this.db.prepare('SELECT * FROM subscriptions WHERE expires_at > ? LIMIT 100').all(now) as unknown as Subscription[];
      for (const subscription of subscriptions) {
        try {
          const match = await this.api.call<Match>('GET', `/${subscription.match_id}`, undefined, { 'X-Race-Invite': subscription.invite }, subscription.endpoint);
          if (match.phase === 'finished' && match.round > subscription.sent_round) {
            await this.transport.send(subscription.space, subscription.phone, { text: resultText(match) });
            this.db.prepare('UPDATE subscriptions SET sent_round = ?, expires_at = ? WHERE match_id = ? AND space = ? AND phone = ?')
              .run(match.round, match.expires_at, subscription.match_id, subscription.space, subscription.phone);
          }
        } catch { /* Leave the subscription pending; do not print tokens, numbers or conversations. */ }
      }
    } finally { this.busy = false; }
  }
}
