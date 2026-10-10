/**
 * Client for the browser core worker. One worker per page; requests are answered in order. If a Worker cannot start
 * (old browser, CSP), the same tasks run inline on the main thread so editing and test-play still work.
 */
import type { InkDoc, LevelV2 } from '../core/types.gen.ts';
import type {
  AnalyzeParams, AnalyzeResult, CoreErrorInfo, CoreMethod, CoreRequest, CoreResponse, DryRow, HintsParams, HintsResult,
  InkParams, LibraryCheckParams, LocalBuildParams, LocalBuildResult, MenuResult, PlanParams, PlanResult, RemixParams,
  RemixResult, RulesCheckParams, VerifyParams, VerifyResult,
} from './core_types.ts';

export class CoreError extends Error {
  readonly code: CoreErrorInfo['code'];
  readonly fn?: string;
  constructor(info: CoreErrorInfo) {
    super(info.message);
    this.name = 'CoreError';
    this.code = info.code;
    this.fn = info.fn;
  }
  get notImplemented(): boolean {
    return this.code === 'not_implemented';
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

class CoreClient {
  private worker: Worker | null = null;
  private inline: ((r: CoreRequest) => CoreResponse) | null = null;
  private inlineLoading: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  private ensure(): void {
    if (this.worker || this.inline || this.inlineLoading) return;
    try {
      this.worker = new Worker(new URL('./core.worker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e: MessageEvent<CoreResponse>) => this.settle(e.data);
      this.worker.onerror = (e) => {
        console.warn('core worker failed; running the core inline', e.message);
        this.worker?.terminate();
        this.worker = null;
        this.loadInline();
      };
    } catch {
      this.loadInline();
    }
  }

  private loadInline(): void {
    this.inlineLoading = import('./core_run.ts').then((m) => {
      this.inline = m.runTask;
      // Re-send whatever was waiting on the dead worker.
      const waiting = [...this.queued];
      this.queued = [];
      for (const r of waiting) this.settle(m.runTask(r));
    });
  }

  private queued: CoreRequest[] = [];

  private settle(res: CoreResponse): void {
    const p = this.pending.get(res.id);
    if (!p) return;
    this.pending.delete(res.id);
    this.queued = this.queued.filter((q) => q.id !== res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new CoreError(res.error));
  }

  call<T>(method: CoreMethod, params: unknown): Promise<T> {
    this.ensure();
    const req: CoreRequest = { id: this.nextId++, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(req.id, { resolve: resolve as (v: unknown) => void, reject });
      this.queued.push(req);
      if (this.inline) {
        const run = this.inline;
        setTimeout(() => this.settle(run(req)), 0);
      } else if (this.worker) {
        this.worker.postMessage(req);
      } // else: inline is loading; loadInline() drains `queued`.
    });
  }

  ink(p: InkParams & { allowBare?: boolean }): Promise<InkDoc> {
    return this.call<InkDoc>('ink', p);
  }

  build(p: LocalBuildParams): Promise<LocalBuildResult> {
    return this.call<LocalBuildResult>('build', p);
  }

  menu(p: LocalBuildParams & { max: number }): Promise<MenuResult> {
    return this.call<MenuResult>('menu', p);
  }

  hash(level: LevelV2): Promise<string> {
    return this.call<string>('hash', { level });
  }

  analyze(p: AnalyzeParams): Promise<AnalyzeResult> {
    return this.call<AnalyzeResult>('analyze', p);
  }

  rulesCheck(p: RulesCheckParams): Promise<DryRow[]> {
    return this.call<DryRow[]>('rulesCheck', p);
  }

  libraryCheck(p: LibraryCheckParams): Promise<DryRow[]> {
    return this.call<DryRow[]>('libraryCheck', p);
  }

  plan(p: PlanParams): Promise<PlanResult> {
    return this.call<PlanResult>('plan', p);
  }

  remix(p: RemixParams): Promise<RemixResult> {
    return this.call<RemixResult>('remix', p);
  }

  verify(p: VerifyParams): Promise<VerifyResult> {
    return this.call<VerifyResult>('verify', p);
  }

  // ---- hints: at most one in flight and one waiting; older revisions are dropped -------------------------------
  private hintsBusy = false;
  private hintsNext: { p: HintsParams; resolve: (r: HintsResult | null) => void; reject: (e: unknown) => void } | null = null;

  /** Resolves with null when a newer request replaced this one before it ran. */
  hints(p: HintsParams): Promise<HintsResult | null> {
    return new Promise((resolve, reject) => {
      if (this.hintsNext) this.hintsNext.resolve(null);
      this.hintsNext = { p, resolve, reject };
      void this.pumpHints();
    });
  }

  private async pumpHints(): Promise<void> {
    if (this.hintsBusy || !this.hintsNext) return;
    const job = this.hintsNext;
    this.hintsNext = null;
    this.hintsBusy = true;
    try {
      job.resolve(await this.call<HintsResult>('hints', job.p));
    } catch (e) {
      job.reject(e);
    } finally {
      this.hintsBusy = false;
      void this.pumpHints();
    }
  }
}

let client: CoreClient | null = null;

export function coreClient(): CoreClient {
  client ??= new CoreClient();
  return client;
}
