/**
 * Undo / redo as doc snapshots (docs/v6/CONTRACTS_V6.md §6). Docs are immutable, so a snapshot is just a reference.
 * Changes that share a coalesce key within `windowMs` (a drag, a slider scrub, typing a name) become one step.
 */
export interface HistoryEntry<T> { doc: T; label: string }

export class History<T> {
  private past: HistoryEntry<T>[] = [];
  private future: HistoryEntry<T>[] = [];
  private lastKey: string | null = null;
  private lastAt = 0;

  constructor(private readonly limit = 200, private readonly windowMs = 1200, private readonly now: () => number = () => Date.now()) {}

  /**
   * Record that `before` is being replaced. With the same `coalesce` key as the previous push (within the window)
   * nothing new is recorded, so the earlier snapshot stays the undo point.
   */
  push(before: T, label = '', coalesce: string | null = null): void {
    const at = this.now();
    if (coalesce && coalesce === this.lastKey && at - this.lastAt <= this.windowMs && this.past.length) {
      this.lastAt = at;
      this.future = [];
      return;
    }
    this.past.push({ doc: before, label });
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.lastKey = coalesce;
    this.lastAt = at;
  }

  /** End any coalescing run (a pointer-up, a blur). */
  seal(): void {
    this.lastKey = null;
  }

  undo(current: T): HistoryEntry<T> | null {
    const e = this.past.pop();
    if (!e) return null;
    this.future.push({ doc: current, label: e.label });
    this.lastKey = null;
    return e;
  }

  redo(current: T): HistoryEntry<T> | null {
    const e = this.future.pop();
    if (!e) return null;
    this.past.push({ doc: current, label: e.label });
    this.lastKey = null;
    return e;
  }

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string | null { return this.past[this.past.length - 1]?.label ?? null; }

  clear(): void {
    this.past = [];
    this.future = [];
    this.lastKey = null;
  }
}
