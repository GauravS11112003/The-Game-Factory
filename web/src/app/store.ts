/**
 * Per-device memory: the author name, personal bests, the editor's working drawing (and one snapshot per draft so
 * "Back to drawing" restores exactly what was drawn), hint and mute settings, and an IndexedDB thumbnail cache keyed
 * by `id@version` (§7.9). Every access is guarded: storage can be unavailable (private mode, quota).
 */
import type { Replay } from '../core/types.gen.ts';
import type { EditorDocData } from '../editor/doc.ts';

const P = 'dal.v2.';

function get<T>(k: string): T | null {
  try {
    const v = localStorage.getItem(P + k);
    return v === null ? null : (JSON.parse(v) as T);
  } catch {
    return null;
  }
}

function set(k: string, v: unknown): void {
  try {
    if (v === null || v === undefined) localStorage.removeItem(P + k);
    else localStorage.setItem(P + k, JSON.stringify(v));
  } catch {
    /* quota or disabled storage: the app still works for this session */
  }
}

export const store = {
  author: (): string => get<string>('author') ?? '',
  setAuthor: (name: string): void => set('author', name.trim().slice(0, 16)),

  editorDoc: (slot = 'current'): EditorDocData | null => get<EditorDocData>(`editor.${slot}`),
  setEditorDoc: (doc: EditorDocData | null, slot = 'current'): void => set(`editor.${slot}`, doc),

  draftDoc: (draftId: string): EditorDocData | null => get<EditorDocData>(`draft.${draftId}`),
  setDraftDoc: (draftId: string, doc: EditorDocData): void => set(`draft.${draftId}`, doc),

  draftBuild: (draftId: string): { build_id: string; events_url: string } | null => get(`build.${draftId}`),
  setDraftBuild: (draftId: string, b: { build_id: string; events_url: string }): void => set(`build.${draftId}`, b),

  /** Edit statuses kept from the previous draft of the same drawing ("Back to drawing", §7.10). */
  draftKept: (draftId: string): Record<string, 'applied' | 'undone'> | null => get(`kept.${draftId}`),
  setDraftKept: (draftId: string, v: Record<string, 'applied' | 'undone'>): void => set(`kept.${draftId}`, v),

  pb: (levelId: string, version: number): { time_ms: number; replay: Replay | null } | null => get(`pb.${levelId}@${version}`),
  setPb: (levelId: string, version: number, v: { time_ms: number; replay: Replay | null }): void => set(`pb.${levelId}@${version}`, v),

  flag: (name: 'hintsOff' | 'rowSnap' | 'muted' | 'hideChanges'): boolean => get<boolean>(name) === true,
  setFlag: (name: 'hintsOff' | 'rowSnap' | 'muted' | 'hideChanges', v: boolean): void => set(name, v),

  /** Packs printed on this device (newest first, ≤ 12), so the scan tray knows k without reading a QR (§6.4). */
  packs: (): StoredPack[] => (get<StoredPack[]>('packs') ?? []).filter((p) => p && typeof p.pack_id === 'string'),
  addPack(p: StoredPack): void {
    const rest = store.packs().filter((x) => x.pack_id !== p.pack_id);
    set('packs', [p, ...rest].slice(0, 12));
  },

  /** Which ghosts the player wants on a level (§8.4: your PB, the leader, the challenger; ≤ 3). */
  ghostPrefs: (): GhostPrefs => ({ pb: true, leader: false, vs: true, ...(get<Partial<GhostPrefs>>('ghosts') ?? {}) }),
  setGhostPrefs: (g: GhostPrefs): void => set('ghosts', g),

  /** Levels this device has finished (any version): unlocks bonus levels (§9: L5 after L4). */
  cleared: (levelId: string): boolean => (get<string[]>('cleared') ?? []).includes(levelId),
  setCleared(levelId: string): void {
    const all = get<string[]>('cleared') ?? [];
    if (!all.includes(levelId)) set('cleared', [...all, levelId].slice(-500));
  },

  /** The run id of this device's best saved run on a level (for "Challenge a friend" links). */
  bestRun: (levelId: string): { run_id: string; time_ms: number; version: number } | null => get(`run.${levelId}`),
  setBestRun: (levelId: string, v: { run_id: string; time_ms: number; version: number }): void => set(`run.${levelId}`, v),
};

export interface StoredPack {
  pack_id: string;
  pdf_url: string;
  kind: 'new' | 'game' | 'remix' | 'extend';
  k: number;
  game_id: string | null;
  parent_id: string | null;
  created_at: string;
}

export interface GhostPrefs {
  pb: boolean;
  leader: boolean;
  vs: boolean;
}

// ---- IndexedDB thumbnail cache ------------------------------------------------------------------------------

let dbp: Promise<IDBDatabase | null> | null = null;

function db(): Promise<IDBDatabase | null> {
  dbp ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open('dal-v2', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('thumbs');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbp;
}

export async function thumbGet(key: string): Promise<string | null> {
  const d = await db();
  if (!d) return null;
  return new Promise((resolve) => {
    try {
      const r = d.transaction('thumbs').objectStore('thumbs').get(key);
      r.onsuccess = () => resolve(typeof r.result === 'string' ? r.result : null);
      r.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export async function thumbPut(key: string, dataUrl: string): Promise<void> {
  const d = await db();
  if (!d) return;
  try {
    d.transaction('thumbs', 'readwrite').objectStore('thumbs').put(dataUrl, key);
  } catch {
    /* ignore */
  }
}
