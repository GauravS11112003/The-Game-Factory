/**
 * Build event stream (PLAN_V2 §3.11): EventSource with resume after the last seen seq (`?last=`, the server's alias for
 * Last-Event-ID), and after 2 failed reconnects the polling fallback `GET /drafts/{id}?since=<seq>`.
 * Events are delivered once, in seq order. Returns a stop function.
 */
import type { BuildEvent } from '../core/types.gen.ts';
import { LATENCY } from '../core/params.ts';
import { api } from './api.ts';

const EVENT_NAMES = ['hello', 'stage', 'ink', 'saw', 'edits', 'tier', 'ask', 'note', 'suggestions', 'cost', 'warning', 'error', 'done'] as const;

export interface FollowOptions {
  since?: number; // resume after this seq
  onState?: (s: 'live' | 'polling' | 'done' | 'failed') => void;
  pollMs?: number;
}

export function followBuild(eventsUrl: string | null, draftId: string, onEvent: (e: BuildEvent) => void, o: FollowOptions = {}): () => void {
  let seq = o.since ?? 0;
  let failures = 0;
  let stopped = false;
  let finished = false;
  let es: EventSource | null = null;
  let pollTimer = 0;
  const pollMs = o.pollMs ?? 900;

  const deliver = (e: BuildEvent): void => {
    if (stopped || e.seq <= seq) return;
    seq = e.seq;
    try {
      onEvent(e);
    } catch (err) {
      console.error('build event handler failed', e.event, err);
    }
    if (e.event === 'done') {
      finished = true;
      o.onState?.('done');
      stop();
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped) return;
    o.onState?.('polling');
    const r = await api.draft(draftId, seq).catch(() => null);
    for (const e of (r?.events ?? []).slice().sort((a, b) => a.seq - b.seq)) deliver(e);
    if (stopped) return;
    if (r && r.state !== 'running') {
      finished = true;
      o.onState?.(r.state === 'failed' ? 'failed' : 'done');
      return stop();
    }
    pollTimer = window.setTimeout(() => void poll(), pollMs);
  };

  const open = (): void => {
    if (stopped) return;
    if (!eventsUrl || typeof EventSource === 'undefined') {
      void poll();
      return;
    }
    const url = seq ? `${eventsUrl}${eventsUrl.includes('?') ? '&' : '?'}last=${seq}` : eventsUrl;
    es = new EventSource(url);
    es.onopen = () => o.onState?.('live');
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (m) => {
        const msg = m as MessageEvent<string>;
        let data: unknown;
        try {
          data = JSON.parse(msg.data);
        } catch {
          return;
        }
        failures = 0;
        deliver({ seq: Number(msg.lastEventId), event: name, data } as BuildEvent);
      });
    }
    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped || finished) return;
      if (++failures >= LATENCY.sse_failures_before_poll) void poll();
      else window.setTimeout(open, 500 * failures);
    };
  };

  function stop(): void {
    stopped = true;
    es?.close();
    es = null;
    window.clearTimeout(pollTimer);
  }

  open();
  return stop;
}
