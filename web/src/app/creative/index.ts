/**
 * Optional SVG artwork on the client. The screens call three hooks:
 * - draw.ts: mountCreativeDraw() groups strokes into objects, prefetches art in the background and docks the tray;
 * - preview.ts: mountCreativePreview() dresses the stage with the art and plays the fly-in reveal;
 * - preview.ts publish: showSubmission() when the level went to a game's review queue instead of going live.
 */
import './creative.css';
import type { GameRules } from '../../core/types.gen.ts';
import { groupSourceFromEditor, StrokeGrouper } from '../../editor/groups.ts';
import type { EditorHandle } from '../../editor/index.ts';
import { card, h, icon } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { navigate } from '../router.ts';
import { Prefetcher } from './prefetch.ts';
import { artAvailable, creativeDoc, creativeStatus, docIdOf } from './session.ts';
import { CreativeTray } from './tray.ts';
import type { CreativeStatus, Submission } from './types.ts';

export { mountCreativePreview } from './flyin.ts';
export { docIdOf } from './session.ts';

/** The draw screen's creative side: returns its teardown (call it before the editor is destroyed). */
export function mountCreativeDraw(o: { editor: EditorHandle; root: HTMLElement; rules: GameRules }): () => void {
  const { editor } = o;
  const data = editor.doc.data;
  if (!data.betterGraphics) return () => undefined;
  const hadId = !!docIdOf(data);
  const docId = docIdOf(data, true)!;
  if (!hadId) editor.doc.setMeta({}); // saves the new id with the working drawing
  const doc = creativeDoc(docId, data.gameId);
  let status: CreativeStatus | null = null;
  let stopped = false;
  let grouper: StrokeGrouper | null = null;
  let prefetch: Prefetcher | null = null;

  // a doc loaded in place (live drawing) keeps this id unless it brings its own
  const offLoad = editor.doc.on((why) => {
    if (why !== 'load') return;
    if (!docIdOf(editor.doc.data)) (editor.doc.data as typeof data & { id?: string }).id = docId;
  });

  const tray = new CreativeTray({ doc, mode: 'draw', strokes: () => editor.doc.data.strokes, status: () => status });
  const dock = o.root.querySelector('.ed-bottom');
  (dock ?? o.root).append(tray.el);

  void creativeStatus().then((s) => {
    if (stopped) return;
    status = s;
    tray.render();
    if (!artAvailable(s)) return; // no provider: the kid's ink stays and nothing runs
    grouper = new StrokeGrouper(groupSourceFromEditor(editor), { seed: doc.list().map((r) => ({ group_id: r.group_id, stroke_ids: r.stroke_ids })) });
    prefetch = new Prefetcher({
      doc, grouper,
      strokes: () => editor.doc.data.strokes,
      objects: () => editor.lastBuild()?.level.objects ?? null,
      screens: () => editor.doc.data.screens,
      theme: () => o.rules.guidance?.setting ?? o.rules.theme ?? null,
      status: () => status,
    });
    void doc.load().then(() => prefetch?.kick());
  });

  return () => {
    stopped = true;
    grouper?.flush(); // the kid pressed "Make my level!" right after drawing: send what is there
    prefetch?.destroy();
    grouper?.destroy();
    tray.destroy();
    offLoad();
  };
}

/**
 * Publishing into a game the kid doesn't maintain makes a submission (pending review): say where it went, with a
 * link to the game, instead of "Play it". Returns false for a normal publish. The collab lane's own "Sent" card wins
 * when it is already showing.
 */
export function showSubmission(res: unknown): boolean {
  const sub = (res as { submission?: Submission | null } | null)?.submission;
  if (!sub || typeof sub !== 'object' || !sub.game_id) return false;
  window.setTimeout(() => {
    if (document.querySelector('.collab-sent, .cr-sent')) return;
    const game = sub.game_title ? kidText(sub.game_title) : t('creative.this_game');
    const close = (): void => back.remove();
    const back = h('div', { class: 'modal-back' }, card('narrow celebrate cr-sent',
      h('h2', { class: 'marker-underline' }, t('creative.sent_title', { game })),
      h('p', { class: 'muted' }, t('creative.sent_body')),
      h('div', { class: 'row wrap end' },
        h('button', { type: 'button', class: 'pill', onclick: () => { close(); navigate('#/'); } }, icon('home'), t('ui.home')),
        h('button', { type: 'button', class: 'pill primary', onclick: () => { close(); navigate(`#/game/${encodeURIComponent(sub.game_id)}`); } },
          icon('next'), t('creative.open_game', { game })))));
    document.body.append(back);
  }, 200);
  return true;
}
