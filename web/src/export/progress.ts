/**
 * The player's progress in this browser: cleared levels and best times, per exported game. localStorage can be missing
 * or throw (private windows, blocked storage, sandboxed iframes on game portals), so every read and write is guarded
 * and the game simply starts fresh when it can't remember.
 */
export interface Progress {
  cleared: string[];
  best: Record<string, number>;
}

export class ProgressStore {
  private readonly key: string;
  private mem: Progress;

  constructor(gameId: string) {
    this.key = `drawplay:${gameId}:progress`;
    this.mem = this.read();
  }

  private read(): Progress {
    try {
      const raw = localStorage.getItem(this.key);
      const j = raw ? (JSON.parse(raw) as Partial<Progress>) : null;
      return {
        cleared: Array.isArray(j?.cleared) ? j.cleared.filter((x): x is string => typeof x === 'string') : [],
        best: j?.best && typeof j.best === 'object' ? { ...j.best } : {},
      };
    } catch {
      return { cleared: [], best: {} };
    }
  }

  private write(): void {
    try {
      localStorage.setItem(this.key, JSON.stringify(this.mem));
    } catch {
      /* storage blocked: progress lasts until the tab closes */
    }
  }

  cleared(id: string): boolean {
    return this.mem.cleared.includes(id);
  }

  get clearedCount(): number {
    return this.mem.cleared.length;
  }

  best(id: string): number | null {
    const b = this.mem.best[id];
    return typeof b === 'number' && Number.isFinite(b) ? b : null;
  }

  /** Records a clear; true when the time is a new best. */
  clear(id: string, timeMs: number | null, counts = true): boolean {
    if (!this.mem.cleared.includes(id)) this.mem.cleared.push(id);
    let pb = false;
    if (counts && timeMs !== null && Number.isFinite(timeMs)) {
      const prev = this.best(id);
      if (prev === null || timeMs < prev) {
        this.mem.best[id] = timeMs;
        pb = prev !== null;
      }
    }
    this.write();
    return pb;
  }

  reset(): void {
    this.mem = { cleared: [], best: {} };
    this.write();
  }
}
