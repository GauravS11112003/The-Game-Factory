import { startGeneratedRoom } from '../rooms/api.ts';
/** #/game/:id — a visual game preview with play and level-building controls. */
import { api, ApiError, type ImaginedGameStatus, type LevelCard } from '../api.ts';
import { card, h, icon, saveBlob, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { lockedBy } from './home.ts';
import { loadHub, type Hub } from '../collab/hub.ts';
import { briefCard } from '../game-brief.ts';
import { levelThumb } from '../thumbs.ts';
import { renderThumbnail } from '../../engine/index.ts';
import { inkFromLevel } from '../ink.ts';
import { gameInputTools, generatedGuidelines } from '../game-inputs.ts';

const enc = encodeURIComponent;
function action(label: string, glyph: string, href: string, cls = ''): HTMLAnchorElement {
  return h('a', { class: `game-action ${cls}`, href, title: label, 'aria-label': label }, icon(glyph));
}

export function gameScreen(root: HTMLElement, id: string): () => void {
  let disposed = false;
  let hub: Hub | null = null;
  let selection = 0;
  let inputs: ReturnType<typeof gameInputTools> | undefined;
  let guidelines: ReturnType<typeof generatedGuidelines> | undefined;
  const body = h('div', { class: 'game-screen' }, h('div', { class: 'game-loading', role: 'status', 'aria-label': t('ui.loading') }, icon('play')));
  root.append(body);
  void (async () => {
    try {
      const g = await api.game(id, new URLSearchParams(location.hash.split('?')[1]).has('published'));
      if (disposed) return;
      const gid = enc(g.id);
      const generatedLevels = g.generated_levels?.length ? g.generated_levels : g.generated ? [g.generated] : [];
      const addHref = g.generated ? `#/create?newlevel=1&game=${gid}` : `#/draw?new=1&game=${gid}`;
      const first = g.levels[0];
      const latest = g.levels.at(-1);
      const preview = h('div', { class: 'game-preview' });
      const generatedHref = g.generated ? `#/imagine/${enc(g.generated.draft_id)}` : null;
      const play = h('a', { class: 'game-play', href: generatedHref ?? (first ? `#/play/${enc(first.id)}` : addHref) },
        icon(first || generatedHref ? 'play' : 'plus'), t(first || generatedHref ? 'ui.play' : 'game.add_level'));
      const latestPlay = latest ? action(t('game.play_latest'), 'next', `#/play/${enc(latest.id)}`) : null;
      if (latest && latestPlay) latestPlay.addEventListener('click', e => {
        const locked = lockedBy(latest, g.levels);
        if (locked) { e.preventDefault(); toast(t('game.locked_after', { title: locked })); }
      });
      const editHref = g.generated ? `#/imagine/${enc(g.generated.draft_id)}`
        : first ? `#/draw?edit=${enc(first.id)}&game=${gid}` : addHref;
      const edit = action(t('game.edit_level'), 'pencil', editHref);
      const more = h('details', { class: 'game-more' });
      const extras = h('div', { class: 'game-extra-content' });
      more.append(h('summary', { class: 'game-action', title: t('game.more'), 'aria-label': t('game.more') }, icon('more')), extras);
      let loadedExtras = false;
      const exportButton = (phaser: boolean): HTMLElement => h('button', {
        type: 'button', class: 'pill small', title: t(phaser ? 'export.phaser_help' : 'export.game_help'),
        onclick: async (ev: Event) => {
          const b = ev.currentTarget as HTMLButtonElement;
          b.disabled = true;
          try {
            const blob = await api.pdf(`${api.exportUrl('game', g.id)}${phaser ? '/phaser' : ''}`);
            saveBlob(blob, `${g.id}${phaser ? '-phaser' : ''}.zip`);
          } catch (e) { toast(t(e instanceof ApiError ? e.messageKey : 'error.network')); }
          finally { b.disabled = false; }
        },
      }, icon('share'), t(phaser ? 'export.phaser' : 'export.game'));
      more.addEventListener('toggle', () => {
        if (!more.open || loadedExtras) return;
        loadedExtras = true;
        extras.append(h('div', { class: 'row wrap' },
          h('a', { class: 'pill small', href: `#/scan?game=${gid}` }, icon('camera'), t('game.scan_level')),
          h('a', { class: 'pill small', href: `#/prompt?game=${gid}` }, icon('pencil'), t('game.prompt_level')),
          exportButton(false), exportButton(true)), g.brief ? briefCard(g.brief) : '');
        void loadHub(g).then((loaded) => {
          if (disposed) { loaded.dispose(); return; }
          hub = loaded;
          const remixes = h('div', { class: 'game-remix-grid' }, ...g.remixes.map(l => h('div', null,
            h('a', { href: `#/play/${enc(l.id)}`, title: kidText(l.title), 'aria-label': kidText(l.title || t('ui.play')) }, levelThumb(l)),
            action(t('game.edit_level'), 'pencil', `#/draw?edit=${enc(l.id)}&game=${gid}`))));
          extras.append(hub.bibleEl, hub.tabs(remixes));
        }).catch(() => undefined);
      });
      const sourceTools = h('div', { class: 'game-generated-tools' });
      const publication = h('span', { class: 'small muted', role: 'status' });
      const publish = h('button', { class: 'pill primary game-publish', type: 'button', hidden: !g.generated }, t('imagine.publish'));
      const levelStrip = h('div', { class: 'game-levels', role: 'group', 'aria-label': t('game.levels') });
      const selectors: HTMLButtonElement[] = [];
      const select = async (l: LevelCard): Promise<void> => {
        const request = ++selection;
        sourceTools.replaceChildren(action(t('ui.rules_sheet'), 'rules', `#/game/${gid}/rules`)); inputs?.dispose(); guidelines?.dispose(); publish.hidden = true; publication.textContent = '';
        const locked = lockedBy(l, g.levels);
        selectors.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.level === l.id)));
        play.href = `#/play/${enc(l.id)}`;
        play.setAttribute('aria-disabled', String(!!locked));
        play.title = locked ? t('game.locked_after', { title: locked }) : t('ui.play');
        edit.href = `#/draw?edit=${enc(l.id)}&game=${gid}`;
        preview.replaceChildren(levelThumb(l));
        try {
          const level = l.level ?? (await api.level(l.id, l.version)).level;
          if (disposed || request !== selection) return;
          const canvas = h('canvas', { width: 1600, height: 900, role: 'img', 'aria-label': kidText(l.title || t('game.preview')) });
          preview.replaceChildren(canvas);
          await renderThumbnail(canvas, level, inkFromLevel(level));
        } catch { /* Keep the thumbnail when a live preview is unavailable. */ }
      };
      play.addEventListener('click', e => {
        if (play.getAttribute('aria-disabled') === 'true') { e.preventDefault(); toast(play.title); }
      });
      let selectedGenerated: ImaginedGameStatus | undefined;
      function selectGenerated(level: ImaginedGameStatus): void {
        ++selection;
        selectedGenerated = level;
        inputs?.dispose(); guidelines?.dispose();
        guidelines = generatedGuidelines(level.title, level.summary ?? '', level.controls ?? []);
        inputs = gameInputTools(level.draft_id, `Level ${level.level_number ?? generatedLevels.indexOf(level) + 1} · ${level.title}`);
        sourceTools.replaceChildren(guidelines.element, inputs.element, ...(level.multiplayer && level.status === 'ready' ? [h('button', { class: 'pill primary', type: 'button', onclick: (event: Event) => void startGeneratedRoom(level.draft_id, event.currentTarget as HTMLButtonElement) }, 'Play with a friend')] : []));
        const key = level.level_id ?? level.draft_id;
        selectors.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.level === key)));
        play.href = `#/imagine/${enc(level.draft_id)}`;
        play.removeAttribute('aria-disabled'); play.title = t('ui.play');
        edit.href = `#/imagine/${enc(level.draft_id)}`;
        publish.hidden = false;
        publish.disabled = level.status !== 'ready' || level.publication === 'published';
        publish.textContent = t(level.publication === 'published' ? 'imagine.published_short' : (level.level_number ?? 1) > 1 ? 'imagine.publish_level' : 'imagine.publish');
        publication.textContent = `Level ${level.level_number ?? generatedLevels.indexOf(level) + 1} · ${t(level.publication === 'published' ? 'imagine.published_short' : 'imagine.draft_short')}`;
        preview.replaceChildren(level.status === 'ready' ? h('iframe', { class: 'imagined-game',
          title: level.title, src: level.play_url, sandbox: 'allow-scripts', referrerPolicy: 'no-referrer' }) :
          h('a', { class: 'game-empty-art', href: play.href }, t(level.status === 'failed' ? 'imagine.failed_title' : 'imagine.working')));
      }
      publish.addEventListener('click', async () => {
        const level = selectedGenerated;
        if (!level) return;
        publish.disabled = true; publish.textContent = t('imagine.publishing');
        try {
          const published = await api.publishImaginedGame(level.draft_id);
          Object.assign(level, published);
          if (!disposed && selectedGenerated === level) {
            publish.textContent = t('imagine.published_short'); publication.textContent = t('imagine.published');
          }
        } catch (error) {
          if (!disposed && selectedGenerated === level) {
            publish.disabled = false; publish.textContent = t((level.level_number ?? 1) > 1 ? 'imagine.publish_level' : 'imagine.publish');
            publication.textContent = t(error instanceof ApiError ? error.messageKey : 'imagine.publish_failed');
          }
        }
      });
      for (const [i, level] of generatedLevels.entries()) {
        const key = level.level_id ?? level.draft_id;
        const number = level.level_number ?? i + 1;
        const pick = h('button', { type: 'button', class: 'game-level-pick', data: { level: key },
          'aria-label': `Level ${number}: ${level.title}`, 'aria-pressed': 'false', onclick: () => selectGenerated(level) },
          h('div', { class: 'game-generated-thumb' }, icon('play'), h('span', null, kidText(level.title))),
          h('span', { class: 'game-level-number' }, String(number)),
          h('span', { class: 'game-level-caption' }, `Level ${number}`));
        selectors.push(pick);
        levelStrip.append(h('div', { class: 'game-level-tile' }, pick,
          action(`${t('game.edit_level')}: ${level.title}`, 'pencil', `#/imagine/${enc(level.draft_id)}`, 'game-level-edit')));
      }
      for (const [i, l] of g.levels.entries()) {
        const locked = lockedBy(l, g.levels);
        const name = kidText(l.title || t('ui.untitled'));
        const pick = h('button', {
          type: 'button', class: 'game-level-pick', data: { level: l.id },
          'aria-label': `${i + generatedLevels.length + 1}. ${name}`, 'aria-pressed': String(i === 0), title: name,
          onclick: () => void select(l),
        }, levelThumb(l), h('span', { class: 'game-level-number' }, locked ? icon('lock') : String(i + generatedLevels.length + 1)));
        selectors.push(pick);
        levelStrip.append(h('div', { class: 'game-level-tile' }, pick,
          action(`${t('game.edit_level')}: ${name}`, 'pencil', `#/draw?edit=${enc(l.id)}&game=${gid}`, 'game-level-edit')));
      }
      levelStrip.append(action(t('game.add_level'), 'plus', addHref, 'game-level-add'));
      const rail = h('nav', { class: 'game-actions', 'aria-label': t('game.tools') },
        action(t('game.add_level'), 'plus', addHref, 'game-action-add'),
        latestPlay,
        edit,
        g.generated ? sourceTools : action(t('ui.rules_sheet'), 'rules', `#/game/${gid}/rules`),
        action(t('ui.library'), 'star', `#/game/${gid}/library`),
        h('button', { type: 'button', class: 'game-action', title: t('game.more'), 'aria-label': t('game.more'), 'aria-expanded': 'false', onclick: (e: Event) => {
          more.open = !more.open;
          (e.currentTarget as HTMLButtonElement).setAttribute('aria-expanded', String(more.open));
        } }, icon('more')));
      body.replaceChildren(
        h('header', { class: 'game-heading' }, action(t('ui.home'), 'back', '#/'), h('h1', null, kidText(g.title || t('ui.untitled')))),
        h('section', { class: 'game-showcase', 'aria-label': t('game.preview') }, h('div', { class: 'game-preview-wrap' }, preview, h('div', { class: 'game-play-dock' }, play, publish, publication)), rail),
        levelStrip, more);
      if (generatedLevels.length) selectGenerated(generatedLevels.find(level => (level.level_id ?? level.draft_id) === new URLSearchParams(location.hash.split('?')[1]).get('level')) ?? generatedLevels[0]!);
      else if (first) void select(first);
      else preview.append(h('a', { class: 'game-empty-art', href: addHref, 'aria-label': t('game.add_level') }, icon('marker'), icon('plus')));
      if (new URLSearchParams(location.hash.split('?')[1]).has('tab')) more.open = true;
    } catch (e) {
      if (!disposed) body.replaceChildren(card(null, h('p', null, t(e instanceof ApiError ? e.messageKey : 'error.not_found'))));
    }
  })();
  return () => { disposed = true; ++selection; hub?.dispose(); inputs?.dispose(); guidelines?.dispose(); };
}
