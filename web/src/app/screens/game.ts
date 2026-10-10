/** #/game/:id — a game: its levels in order, "Add a level" (draw or scan), play from level 1, remix trees. */
import { api, ApiError } from '../api.ts';
import { card, h, icon, saveBlob, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { levelCardEl, lockedBy } from './home.ts';
import { loadHub, type Hub } from '../collab/hub.ts'; // v3 lane 5: the game's hub

export function gameScreen(root: HTMLElement, id: string): () => void {
  let disposed = false;
  let hub: Hub | null = null;
  const body = h('div', { class: 'game-screen' }, card(null, h('p', { class: 'muted' }, t('ui.loading'))));
  root.append(body);
  void (async () => {
    try {
      const g = await api.game(id);
      if (disposed) return;
      hub = await loadHub(g).catch(() => null);
      if (disposed) return;
      const gid = encodeURIComponent(g.id);
      const add = h('div', { class: 'row wrap' },
        hub ? hub.addButton : '',
        g.levels[0] ? h('a', { class: `pill${hub ? ' play' : ' primary'}`, href: `#/play/${encodeURIComponent(g.levels[0].id)}` }, icon('play'), t('game.play_from_start')) : '',
        hub ? '' : h('a', { class: 'pill', href: `#/draw?new=1&game=${gid}` }, icon('marker'), t('game.add_level')),
        h('a', { class: 'pill', href: `#/scan?game=${gid}` }, icon('camera'), t('game.scan_level')),
        h('a', { class: 'pill', href: `#/prompt?game=${gid}` }, icon('pencil'), t('game.prompt_level')));
      const tools = h('div', { class: 'row wrap' },
        h('a', { class: 'pill small', href: `#/game/${gid}/rules` }, icon('rules'), t('ui.rules_sheet')),
        h('a', { class: 'pill small', href: `#/game/${gid}/library` }, icon('star'), t('ui.library')),
        h('button', {
          type: 'button', class: 'pill small', title: t('export.game_help'),
          onclick: () => api.pdf(api.exportUrl('game', g.id)).then((b) => saveBlob(b, `${g.id}.zip`),
            (e) => toast(t(e instanceof ApiError ? e.messageKey : 'error.network'))),
        }, icon('share'), t('export.game')),
        // v3 lane 7: "Export to Phaser", the game as a standalone Phaser 3 project (zip)
        h('button', {
          type: 'button', class: 'pill small', title: t('export.phaser_help'),
          onclick: (ev: Event) => {
            const b = ev.currentTarget as HTMLButtonElement;
            b.disabled = true;
            const done = toast(t('export.phaser_working'), { ms: 60_000 });
            api.pdf(`${api.exportUrl('game', g.id)}/phaser`).then((z) => { saveBlob(z, `${g.id}-phaser.zip`); toast(t('export.phaser_done')); },
              (e) => toast(t(e instanceof ApiError ? e.messageKey : 'error.network'))).finally(() => { done(); b.disabled = false; });
          },
        }, icon('share'), t('export.phaser')));
      const remixes = g.remixes.length ? card(null, h('h3', null, t('game.remixes', { n: g.remixes.length })),
        h('div', { class: 'level-strip' }, ...g.remixes.map((l) => levelCardEl(l)))) : '';
      const list = h('ol', { class: 'level-list' }, ...g.levels.map((l, i) => h('li', null, levelCardEl(l, { index: i, locked: lockedBy(l, g.levels) }), hub ? hub.madeBy(l) : '',
        h('a', { class: 'small', href: `#/tree/${encodeURIComponent(l.id)}` }, icon('tree'), ` ${t('ui.tree')}`))));
      body.replaceChildren(
        card('game-head', h('h1', { class: 'marker-underline' }, kidText(g.title || t('ui.untitled'))),
          h('p', { class: 'muted' }, t('play.by', { author: g.author || t('ui.someone') }), ` · ${t('home.levels', { n: g.levels.length })}`), hub ? hub.bibleEl : '', add, tools),
        ...(hub ? [hub.tabs(h('div', null, g.levels.length ? list : card(null, h('p', null, t('game.no_levels'))), remixes))]
          : [g.levels.length ? list : card(null, h('p', null, t('game.no_levels'))), remixes]));
    } catch (e) {
      if (!disposed) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
    }
  })();
  return () => {
    disposed = true;
    hub?.dispose();
  };
}
