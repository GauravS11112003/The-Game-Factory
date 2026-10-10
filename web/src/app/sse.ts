/** Build event stream (PLAN_V2 §3.11): EventSource with Last-Event-ID resume; after 2 failures, poll /drafts/{id}. */
import type { BuildEvent } from '../core/types.gen.ts';
import { api } from './api.ts';

const EVENT_NAMES = ['hello', 'stage', 'ink', 'saw', 'edits', 'tier', 'ask', 'note', 'suggestions', 'cost', 'warning', 'error', 'done'] as const;

export function followBuild(eventsUrl: string, draftId: string, onEvent: (e: BuildEvent) => void): () => void {
  let seq = 0;
  let failures = 0;
  let stopped = false;
  let es: EventSource | null = null;
  const deliver = (e: BuildEvent): void => {
    if (e.seq <= seq) return;
    seq = e.seq;
    onEvent(e);
    if (e.event === 'done') stop();
  };
  const poll = async (): Promise<void> => {
    while (!stopped) {
      const r = await api.draft(draftId, seq).catch(() => null);
      for (const e of r?.events ?? []) deliver(e);
      if (r && r.state !== 'running') return stop();
      await new Promise((res) => setTimeout(res, 1000));
    }
  };
  const open = (): void => {
    es = new EventSource(seq ? `${eventsUrl}?last=${seq}` : eventsUrl);
    for (const name of EVENT_NAMES) {
      es.addEventListener(name, (m) => {
        const msg = m as MessageEvent<string>;
        deliver({ seq: Number(msg.lastEventId), event: name, data: JSON.parse(msg.data) } as BuildEvent);
      });
    }
    es.onerror = () => {
      es?.close();
      if (stopped) return;
      if (++failures >= 2) void poll();
      else setTimeout(open, 500);
    };
  };
  function stop(): void {
    stopped = true;
    es?.close();
  }
  open();
  return stop;
}
