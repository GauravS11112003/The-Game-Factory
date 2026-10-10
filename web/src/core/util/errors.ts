/** Thrown by every core function that a lane has not implemented yet (P0 stubs). */
export class NotImplemented extends Error {
  readonly fn: string;
  constructor(fn: string) {
    super(`NotImplemented: ${fn}`);
    this.name = 'NotImplemented';
    this.fn = fn;
  }
}

export function isNotImplemented(e: unknown): e is NotImplemented {
  return e instanceof Error && e.name === 'NotImplemented';
}
