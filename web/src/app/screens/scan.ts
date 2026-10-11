/**
 * #/scan[?game=<id>&remix=<level id>&extend=<level id>&pack=<pack id>] — paper levels (§6.4, §6.5).
 *
 * 1. Print: a k-sheet pack (1-6 sheets, "Sheet n of k" with seam marks), a remix pack (the parent's ink in gray) or an
 *    extend sheet (one more screen). POST /api/v2/packs returns the PDF; the pack is remembered on this device.
 * 2. Scan: the pack tray. Sheets can be photographed in any order; each photo's QR (`dal2|p|<pack>|n/k`) is read in the
 *    browser when it can be (BarcodeDetector), otherwise the kid says which sheet it is. A checklist shows
 *    "Sheet 2 of 4 ✓"; two photos of one sheet keep the latest; a missing sheet says "scan it or continue without
 *    it". The level is playable as soon as the sheets form a run from sheet 1 (publishing needs all k).
 * Photos are resized to a 2400 px long edge JPEG and posted in sheet order to POST /api/v2/builds as `photos`.
 */
import type { LevelV2, PackCreate } from '../../core/types.gen.ts';
import { PAPER, WORLD } from '../../core/params.ts';
import { api, ApiError } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store, type StoredPack } from '../store.ts';
import { emptyDoc } from '../../editor/doc.ts';
import { graphicsOption } from '../graphics-option.ts';
import { docIdOf, setGameLife } from '../creative/session.ts';

async function downscale(file: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const long = Math.max(bmp.width, bmp.height);
    const k = Math.min(1, PAPER.photo_long_edge_px / long);
    if (k === 1 && file.type === 'image/jpeg') return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const ctx = c.getContext('2d');
    if (!ctx) return file;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/jpeg', 0.88));
    return blob ?? file;
  } catch {
    return file;
  }
}

// ---- QR (§6.4 grammar v2; v1 `dal1|…` reads as a 1-sheet pack) -----------------------------------------------------

export type Qr =
  | { kind: 'pack'; pack: string; n: number; k: number }
  | { kind: 'rules' | 'lib'; id: string }
  | { kind: 'v1' };

const QR_V2 = /^dal2\|(p|rules|lib)\|([A-Za-z0-9_-]{4,32})(\|([1-6])\/([1-6]))?$/;

export function parseQr(raw: string): Qr | null {
  const s = raw.trim();
  if (s.startsWith('dal1|')) return { kind: 'v1' };
  const m = QR_V2.exec(s);
  if (!m) return null;
  if (m[1] === 'p') {
    if (!m[4]) return { kind: 'pack', pack: m[2], n: 1, k: 1 };
    const n = Number(m[4]);
    const k = Number(m[5]);
    return n <= k ? { kind: 'pack', pack: m[2], n, k } : null;
  }
  return { kind: m[1] as 'rules' | 'lib', id: m[2] };
}

interface Detector {
  detect(src: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}

/** Read the sheet's QR in the browser when the platform can (Chrome/Android, Safari 17+); null otherwise. */
async function readQr(blob: Blob): Promise<Qr | null> {
  const BD = (globalThis as unknown as { BarcodeDetector?: new (o: { formats: string[] }) => Detector }).BarcodeDetector;
  if (!BD) return null;
  try {
    const det = new BD({ formats: ['qr_code'] });
    const bmp = await createImageBitmap(blob);
    for (const c of await det.detect(bmp)) {
      const q = parseQr(c.rawValue);
      if (q) return q;
    }
  } catch {
    /* unsupported format or a decode failure: the kid picks the sheet number */
  }
  return null;
}

// ---- PDFs ------------------------------------------------------------------------------------------------------

/** Open a PDF in a new tab; a missing template shows a sentence instead of a raw error page. */
export async function openPdf(url: string): Promise<boolean> {
  const win = window.open('', '_blank');
  try {
    const blob = await api.pdf(url);
    const href = URL.createObjectURL(blob);
    if (win && !win.closed) win.location.href = href;
    else {
      const a = h('a', { href, download: 'draw-a-level.pdf' });
      document.body.append(a);
      a.click();
      a.remove();
    }
    window.setTimeout(() => URL.revokeObjectURL(href), 120_000);
    return true;
  } catch (e) {
    win?.close();
    toast(t(e instanceof ApiError ? e.messageKey : 'error.network', e instanceof ApiError ? e.args : {}));
    return false;
  }
}

// ---- the screen -------------------------------------------------------------------------------------------------

interface Photo {
  id: number;
  blob: Blob;
  url: string;
  n: number; // sheet index, 1-based
  qr: Qr | null;
}

export function scanScreen(root: HTMLElement, query: URLSearchParams): () => void {
  let disposed = false;
  const gameId = query.get('game');
  const graphics = graphicsOption(false, () => undefined);
  const remixId = query.get('remix');
  const extendId = query.get('extend');
  const parentId = remixId ?? extendId;
  let parent: LevelV2 | null = null;
  const packs = store.packs();
  let pack: StoredPack | null = packs.find((p) => p.pack_id === query.get('pack')) ?? null;
  let photos: Photo[] = [];
  let nextPhoto = 1;
  let printKind: PackCreate['kind'] = remixId ? 'remix' : extendId ? 'extend' : gameId ? 'game' : 'new';
  let printK = 1;
  let busy = false;

  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'hidden' });
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden' });
  const printCard = card('print-card');
  const packRow = h('div', { class: 'chips' });
  const tray = h('ol', { class: 'pack-tray' });
  const trayNote = h('p', { class: 'small' });
  const rules = h('textarea', { class: 'text', rows: 2, maxLength: 300, placeholder: t('editor.rule_placeholder') });
  const go = h('button', { type: 'button', class: 'pill primary big', disabled: true }, icon('check'), t('scan.read_it'));
  const addBtn = h('button', { type: 'button', class: 'pill big', onclick: () => file.click() }, icon('plus'), t('scan.add_photos'));
  const camBtn = h('button', { type: 'button', class: 'pill big', onclick: () => camera.click() }, icon('camera'), t('scan.take_photo'));

  /** How many sheets the tray expects: the pack's k, else as many as there are photos (≥ 1). */
  const k = (): number => pack?.k ?? Math.min(WORLD.max_screens, Math.max(1, ...photos.map((p) => p.n)));

  // ---- print --------------------------------------------------------------------------------------------------
  function renderPrint(): void {
    const kinds: { kind: PackCreate['kind']; label: string; show: boolean }[] = [
      { kind: 'new', label: t('pack.kind_new'), show: true },
      { kind: 'game', label: t('pack.kind_game'), show: !!gameId },
      { kind: 'remix', label: t('pack.kind_remix', { title: kidText(parent?.title || t('ui.untitled')) }), show: !!remixId },
      { kind: 'extend', label: t('pack.kind_extend', { title: kidText(parent?.title || t('ui.untitled')) }), show: !!extendId },
    ];
    const fixedK = printKind === 'extend' ? 1 : printKind === 'remix' ? parent?.world.screens ?? printK : null;
    const kNow = fixedK ?? printK;
    const sheets = h('div', { class: 'sheet-picker', role: 'group', 'aria-label': t('pack.how_many') },
      ...Array.from({ length: WORLD.max_screens }, (_, i) => h('button', {
        type: 'button', class: `sheet-icon${i < kNow ? ' on' : ''}`, disabled: fixedK !== null, title: t('pack.sheets', { k: i + 1 }),
        onclick: () => { printK = i + 1; renderPrint(); },
      }, String(i + 1))));
    const print = h('button', { type: 'button', class: 'pill primary', disabled: busy }, icon('rules'), t('pack.print', { k: kNow }));
    print.onclick = () => void doPrint(kNow);
    printCard.replaceChildren(
      h('h2', null, h('span', { class: 'step-num' }, '1'), ' ', t('pack.print_title')),
      h('p', { class: 'muted' }, t('pack.print_help')),
      h('div', { class: 'chips' }, ...kinds.filter((x) => x.show).map((x) => h('button', {
        type: 'button', class: `chip big${printKind === x.kind ? ' on' : ''}`, onclick: () => { printKind = x.kind; renderPrint(); },
      }, x.label))),
      h('div', { class: 'row wrap' }, h('span', { class: 'small muted' }, t('pack.how_many')), sheets, h('span', { class: 'small' }, t('pack.screens_long', { k: kNow }))),
      h('div', { class: 'row wrap' }, print,
        h('button', { type: 'button', class: 'link', onclick: () => void openPdf('/api/templates/blank.pdf') }, t('pack.one_old_sheet'))));
  }

  async function doPrint(kk: number): Promise<void> {
    busy = true;
    renderPrint();
    try {
      const p = await api.createPack({ kind: printKind, k: kk, game_id: gameId, parent_id: parentId });
      const stored: StoredPack = { pack_id: p.pack_id, pdf_url: p.pdf_url || `/api/v2/templates/pack/${p.pack_id}.pdf`, kind: p.kind, k: p.k, game_id: p.game_id, parent_id: p.parent_id, created_at: new Date().toISOString() };
      store.addPack(stored);
      pack = stored;
      photos = photos.filter((ph) => ph.n <= stored.k);
      renderPacks();
      renderTray();
      await openPdf(stored.pdf_url);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.network', e instanceof ApiError ? e.args : {}));
    } finally {
      busy = false;
      renderPrint();
    }
  }

  // ---- which pack ------------------------------------------------------------------------------------------------
  function renderPacks(): void {
    const mine = store.packs().filter((p) => !gameId || !p.game_id || p.game_id === gameId).slice(0, 6);
    packRow.replaceChildren(h('span', { class: 'small muted' }, t('pack.which')),
      h('button', { type: 'button', class: `chip${pack ? '' : ' on'}`, onclick: () => setPack(null) }, t('pack.no_pack')),
      ...mine.map((p) => h('button', {
        type: 'button', class: `chip${pack?.pack_id === p.pack_id ? ' on' : ''}`, onclick: () => setPack(p),
      }, t('pack.pack_label', { k: p.k, when: new Date(p.created_at).toLocaleDateString() }))));
  }

  function setPack(p: StoredPack | null): void {
    pack = p;
    if (p) for (const ph of photos) if (ph.n > p.k) ph.n = firstFree() ?? p.k;
    renderPacks();
    renderTray();
  }

  function firstFree(): number | null {
    const used = new Set(photos.map((p) => p.n));
    for (let n = 1; n <= (pack?.k ?? WORLD.max_screens); n++) if (!used.has(n)) return n;
    return null;
  }

  // ---- photos ------------------------------------------------------------------------------------------------------
  async function addFiles(files: FileList | null): Promise<void> {
    if (!files?.length) return;
    for (const f of Array.from(files).slice(0, WORLD.max_screens)) {
      const blob = await downscale(f);
      if (disposed) return;
      const qr = await readQr(blob);
      let n: number | null = null;
      if (qr?.kind === 'rules' || qr?.kind === 'lib') {
        toast(t('warning.not_a_drawing_sheet', { i: photos.length + 1 }));
        continue;
      }
      if (qr?.kind === 'pack') {
        if (!pack || pack.pack_id !== qr.pack) {
          const known = store.packs().find((p) => p.pack_id === qr.pack);
          if (!pack && photos.length === 0) pack = known ?? { pack_id: qr.pack, pdf_url: '', kind: 'new', k: qr.k, game_id: gameId, parent_id: parentId, created_at: new Date().toISOString() };
          else if (pack && pack.pack_id !== qr.pack) toast(t('warning.other_pack', { n: qr.n }));
        }
        n = qr.n;
      }
      if (n === null) n = firstFree() ?? (pack?.k ?? photos.length + 1);
      if (pack && n > pack.k) {
        toast(t('warning.sheet_out_of_pack', { n, k: pack.k }));
        continue;
      }
      const dup = photos.find((p) => p.n === n);
      if (dup) {
        // two photos of one sheet: the latest wins
        URL.revokeObjectURL(dup.url);
        photos = photos.filter((p) => p !== dup);
        toast(t('scan.replaced', { n }));
      }
      photos.push({ id: nextPhoto++, blob, url: URL.createObjectURL(blob), n, qr });
    }
    renderPacks();
    renderTray();
  }

  file.onchange = () => void addFiles(file.files).finally(() => { file.value = ''; });
  camera.onchange = () => void addFiles(camera.files).finally(() => { camera.value = ''; });

  function contiguousRun(): number {
    const have = new Set(photos.map((p) => p.n));
    let n = 0;
    while (have.has(n + 1)) n++;
    return n;
  }

  function renderTray(): void {
    const kk = k();
    const slots = Array.from({ length: kk }, (_, i) => i + 1);
    tray.replaceChildren(...slots.map((n) => {
      const ph = photos.find((p) => p.n === n);
      const select = ph && ph.qr?.kind !== 'pack' ? h('select', {
        class: 'text small', title: t('scan.which_sheet'),
        onchange: (e: Event) => {
          const v = Number((e.target as HTMLSelectElement).value);
          const other = photos.find((p) => p.n === v && p !== ph);
          if (other) other.n = ph.n;
          ph.n = v;
          renderTray();
        },
      }, ...Array.from({ length: pack?.k ?? WORLD.max_screens }, (_, i) => h('option', { value: String(i + 1), selected: i + 1 === n }, t('scan.sheet_n', { n: i + 1 })))) : null;
      return h('li', { class: `tray-slot${ph ? ' ok' : ''}` },
        h('div', { class: 'tray-title' }, ph ? '✓ ' : '○ ', t('scan.sheet_n_of_k', { n, k: kk })),
        ph ? h('img', { src: ph.url, alt: t('scan.your_photo') }) : h('div', { class: 'tray-empty' }, icon('camera')),
        ph ? h('div', { class: 'row' }, select,
          ph.qr?.kind === 'pack' ? h('span', { class: 'small muted' }, t('scan.qr_read')) : '',
          h('button', {
            type: 'button', class: 'tool small', title: t('ui.delete'),
            onclick: () => { URL.revokeObjectURL(ph.url); photos = photos.filter((p) => p !== ph); renderTray(); },
          }, icon('close'))) : '');
    }));
    const run = contiguousRun();
    const missing = slots.filter((n) => !photos.some((p) => p.n === n));
    const notes: string[] = [];
    if (!photos.length) notes.push(t('scan.no_photo'));
    else if (!photos.some((p) => p.n === 1)) notes.push(t('scan.need_sheet_1'));
    else {
      for (const n of missing) notes.push(t('warning.sheet_missing', { n, k: kk }));
      if (missing.length) notes.push(t('scan.playable_run', { n: run }));
      else notes.push(t('scan.all_sheets', { k: kk }));
    }
    trayNote.replaceChildren(...notes.map((s) => h('span', { class: 'note-line' }, s)));
    go.disabled = run === 0 || busy;
  }

  go.onclick = async () => {
    if (!photos.some((p) => p.n === 1)) return;
    go.disabled = true;
    busy = true;
    const form = new FormData();
    for (const p of photos.slice().sort((a, b) => a.n - b.n)) form.append('photos', p.blob, `sheet${p.n}.jpg`);
    const text = rules.value.trim();
    if (text) form.append('typed_rules', JSON.stringify(text.split(/\n+/).filter(Boolean).map((line) => ({ text: line, target: null }))));
    if (gameId ?? pack?.game_id) form.append('game_id', (gameId ?? pack?.game_id)!);
    if (parentId ?? pack?.parent_id) form.append('parent_id', (parentId ?? pack?.parent_id)!);
    if (pack?.pack_id) form.append('pack_id', pack.pack_id);
    try {
      const b = await api.createBuild(form);
      store.setDraftBuild(b.draft_id, { build_id: b.build_id, events_url: b.events_url });
      const artGameId = gameId ?? pack?.game_id ?? null;
      const doc = emptyDoc({ gameId: artGameId, betterGraphics: graphics.input.checked });
      docIdOf(doc, true); setGameLife(artGameId, graphics.input.checked);
      store.setDraftDoc(b.draft_id, doc);
      navigate(`#/preview/${encodeURIComponent(b.draft_id)}?b=${encodeURIComponent(b.build_id)}`);
    } catch (e) {
      toast(t(e instanceof ApiError ? e.messageKey : 'error.upload_failed', e instanceof ApiError ? e.args : {}));
      busy = false;
      renderTray();
    }
  };

  root.append(
    card('scan-head', h('h1', { class: 'marker-underline' }, t('scan.title')), h('p', null, t('scan.help'))),
    printCard,
    card('scan',
      h('h2', null, h('span', { class: 'step-num' }, '2'), ' ', t('scan.scan_title')),
      packRow,
      h('div', { class: 'row wrap' }, camBtn, addBtn),
      tray,
      trayNote,
      h('label', { class: 'small' }, t('editor.rules')), rules, graphics.element,
      h('div', { class: 'row end' }, go),
      file, camera));
  renderPrint();
  renderPacks();
  renderTray();

  const packParam = query.get('pack');
  if (packParam && !pack) {
    // a pack printed on another device: ask the server how many sheets it has
    api.pack(packParam).then((p) => {
      if (disposed || pack) return;
      pack = { pack_id: p.pack_id, pdf_url: p.pdf_url, kind: p.kind, k: p.k, game_id: p.game_id, parent_id: p.parent_id, created_at: new Date().toISOString() };
      store.addPack(pack);
      renderPacks();
      renderTray();
    }).catch(() => undefined);
  }

  if (parentId) {
    api.level(parentId).then((r) => {
      if (disposed) return;
      parent = r.level;
      if (printKind === 'remix') printK = r.level.world.screens;
      renderPrint();
    }).catch(() => undefined);
  }

  return () => {
    disposed = true;
    for (const p of photos) URL.revokeObjectURL(p.url);
  };
}
