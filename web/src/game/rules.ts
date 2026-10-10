/**
 * Tiny when/then event bus (PLAN.md section 10, "Engine details").
 *
 * Behaviors emit `collect:<id>`, `touch:<id>` and `timer:<seconds>`; the scene
 * registers each level rule once and maps `then` to open:<id> / win / lose.
 */
export type RuleHandler = (payload?: unknown) => void;

export class RuleBus {
  private handlers = new Map<string, Set<RuleHandler>>();

  /** Subscribe; returns an unsubscribe function. */
  on(when: string, fn: RuleHandler): () => void {
    let set = this.handlers.get(when);
    if (!set) {
      set = new Set();
      this.handlers.set(when, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  }

  /** Returns true when at least one handler ran. */
  emit(when: string, payload?: unknown): boolean {
    const set = this.handlers.get(when);
    if (!set || set.size === 0) return false;
    for (const fn of Array.from(set)) fn(payload);
    return true;
  }

  clear(): void {
    this.handlers.clear();
  }
}

export type RuleAction = { kind: 'open'; id: string } | { kind: 'win' } | { kind: 'lose' };

/** `open:<id>` | `win` | `lose`; anything else is null (ignored with a console warning by the scene). */
export function parseAction(then: string): RuleAction | null {
  const t = then.trim();
  if (t === 'win') return { kind: 'win' };
  if (t === 'lose') return { kind: 'lose' };
  if (t.startsWith('open:') && t.length > 5) return { kind: 'open', id: t.slice(5) };
  return null;
}

/** `timer:60` -> 60; null when `when` is not a timer rule. */
export function parseTimerRule(when: string): number | null {
  const m = /^timer:(\d+(?:\.\d+)?)$/.exec(when.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}
