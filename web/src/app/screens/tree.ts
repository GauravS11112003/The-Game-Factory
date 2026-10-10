/**
 * #/tree/:id — the remix family tree (§6.5, §7.9): from the root level down, who remixed what, the versions, and the
 * objects each remix changed vs its parent. Every node draws the whole level through the engine's thumbnail path and
 * outlines its remix diff in pencil: new objects with a solid pencil box, changed objects with a dashed one, removed
 * ones as a gray dashed box. Each node can be played or remixed (on screen or on paper); the level you came from is
 * marked.
 */
import type { LevelV2 } from '../../core/types.gen.ts';
import { ART } from '../../core/params.ts';
import { renderThumbnail } from '../../engine/index.ts';
import { api, ApiError, type TreeNode } from '../api.ts';
import { card, h, icon } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { drawLevelThumb } from '../thumbs.ts';

const THUMB_W = 480;

function countNodes(n: TreeNode): number {
  return 1 + n.children.reduce((s, c) => s + countNodes(c), 0);
}

/** The level drawn whole (every screen), with its changed objects outlined. */
function diffThumb(n: TreeNode): HTMLCanvasElement {
  const screens = Math.max(1, n.screens);
  const c = h('canvas', { width: THUMB_W, height: Math.round((THUMB_W * 27) / (48 * screens)), class: 'tree-thumb' });
  void api.level(n.id, n.version).then(({ level }: { level: LevelV2 }) => {
    const w = level.world.w;
    c.height = Math.round((THUMB_W * 27) / w);
    try {
      renderThumbnail(c, level, level.ink ?? null, { view: [0, 0, w, 27] });
    } catch {
      drawLevelThumb(c, level);
    }
    const ctx = c.getContext('2d');
    if (!ctx || !n.changed_objects.length) return;
    const s = c.width / w;
    ctx.save();
    for (const o of n.changed_objects) {
      const [x0, y0, x1, y1] = o.bbox;
      ctx.lineWidth = 2;
      ctx.strokeStyle = o.kind === 'removed' ? 'rgba(138,129,120,0.9)' : ART.palette.pencil_violet;
      ctx.setLineDash(o.kind === 'added' ? [] : [4, 3]);
      const pad = 0.35;
      ctx.beginPath();
      ctx.roundRect((x0 - pad) * s, (y0 - pad) * s, (x1 - x0 + pad * 2) * s, (y1 - y0 + pad * 2) * s, 4);
      ctx.stroke();
      if (o.kind === 'added') {
        ctx.fillStyle = 'rgba(106,90,205,0.10)';
        ctx.fill();
      }
    }
    ctx.restore();
  }).catch(() => undefined);
  return c;
}

function summary(n: TreeNode): string {
  const added = n.changed_objects.filter((o) => o.kind === 'added').length;
  const changed = n.changed_objects.filter((o) => o.kind === 'changed').length;
  const removed = n.changed_objects.filter((o) => o.kind === 'removed').length;
  if (added + changed + removed) return t('tree.diff', { added, changed, removed });
  return n.changed !== null ? t('tree.changed', { n: n.changed }) : '';
}

function nodeEl(n: TreeNode, focus: string, depth: number): HTMLElement {
  const isFocus = n.current || n.id === focus;
  return h('li', { class: isFocus ? 'focus' : '' },
    h('div', { class: 'tree-node card paper' },
      h('a', { href: `#/play/${encodeURIComponent(n.id)}`, class: 'thumb-link' }, diffThumb(n)),
      h('div', { class: 'row between' },
        h('div', { class: 'title' }, kidText(n.title || t('ui.untitled'))),
        isFocus ? h('span', { class: 'badge' }, t('tree.you_are_here')) : ''),
      h('div', { class: 'small muted' }, t('play.by', { author: n.author || t('ui.someone') }),
        ` · ${n.versions.length > 1 ? t('tree.versions', { list: n.versions.map((v) => `v${v}`).join(' ') }) : `v${n.version}`}`,
        n.band ? ` · ${t(`band.${n.band}`)}` : ''),
      depth > 0 ? h('div', { class: 'small pencil-text' }, summary(n)) : h('div', { class: 'small muted' }, t('tree.original')),
      h('div', { class: 'row wrap' },
        h('a', { class: 'pill small', href: `#/play/${encodeURIComponent(n.id)}` }, icon('play'), t('ui.play')),
        h('a', { class: 'pill small', href: `#/draw?remix=${encodeURIComponent(n.id)}` }, icon('remix'), t('remix.on_screen')),
        h('a', { class: 'pill small', href: `#/scan?remix=${encodeURIComponent(n.id)}` }, icon('rules'), t('remix.on_paper')))),
    n.children.length ? h('ul', null, ...n.children.map((k) => nodeEl(k, focus, depth + 1))) : '');
}

export function treeScreen(root: HTMLElement, id: string): () => void {
  let disposed = false;
  const body = h('div', { class: 'tree-screen' }, card(null, h('p', { class: 'muted' }, t('ui.loading'))));
  root.append(body);
  api.tree(id).then((tree) => {
    if (disposed) return;
    body.replaceChildren(card(null,
      h('h1', { class: 'marker-underline' }, t('tree.title')),
      h('p', { class: 'muted' }, t('tree.help')),
      h('div', { class: 'row wrap small tree-legend' },
        h('span', { class: 'lg lg-added' }), t('tree.legend_added'),
        h('span', { class: 'lg lg-changed' }), t('tree.legend_changed'),
        h('span', { class: 'lg lg-removed' }), t('tree.legend_removed'),
        h('span', { class: 'muted' }, ` · ${t('tree.count', { n: countNodes(tree) })}`))),
    h('ul', { class: 'tree' }, nodeEl(tree, id, 0)));
  }, (e) => {
    if (!disposed) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
  });
  return () => {
    disposed = true;
  };
}
