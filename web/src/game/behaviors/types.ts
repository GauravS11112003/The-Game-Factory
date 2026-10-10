/**
 * Every behavior is a small class built from one entity (or one rule) with an
 * optional per-frame update and a destroy. The scene owns the list.
 */
export interface Behavior {
  update?(time: number, delta: number): void;
  destroy(): void;
}
