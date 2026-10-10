/**
 * #/bible/:game — the game book (v3 lane 5). The owner (and maintainers) write what the game is about, describe how it
 * works ("Describe how your game works"), make or upload the style picture (POST /api/v2/creative/style), pick the
 * starter creatures from the library, choose who can add levels (everyone / invite only), and manage the team
 * (make maintainer, make helper, remove, add a friend by their profile link). Everyone else sees it read-only.
 */
import type { LibraryType } from '../../core/types.gen.ts';
import { api, type GameCard } from '../api.ts';
import { card, h, icon, toast } from '../dom.ts';
import { kidText, t } from '../messages.ts';
import { typeThumb } from './library.ts';
import { collab, type Bible, type Member, type OpenFor } from '../collab/api.ts';
import { loadTeam, type GameTeam } from '../collab/roles.ts';
import { errText, note, playerChip, roleChip } from '../collab/ui.ts';

const enc = encodeURIComponent;

const EMPTY_BIBLE = (gameId: string): Bible => ({
  viewer: null, game_id: gameId, pitch: '', mechanics_text: '', style_id: null, style_prompt: null, style_image_url: null, starter_type_ids: [], open_for: 'everyone', owner_id: null,
});

export function bibleScreen(root: HTMLElement, gameId: string): () => void {
  let disposed = false;
  const body = h('div', { class: 'collab-screen bible-screen' }, card(null, note(t('ui.loading'))));
  root.append(body);
  void (async () => {
    let game: GameCard;
    try {
      game = await api.game(gameId);
    } catch (e) {
      if (!disposed) body.replaceChildren(card(null, note(errText(e, 'error.not_found'))));
      return;
    }
    const [team, lib] = await Promise.all([loadTeam(gameId), api.library(gameId).catch(() => [] as LibraryType[])]);
    if (disposed) return;
    const can = team.keeper || team.claimable;
    const bible = team.bible ?? EMPTY_BIBLE(gameId);
    const headCard = card('collab-head',
      h('div', { class: 'row between wrap' },
        h('div', null,
          h('h1', { class: 'marker-underline' }, '📖 ', t('collab.bible.title')),
          h('p', { class: 'muted' }, h('a', { href: `#/game/${enc(gameId)}` }, kidText(game.title || t('ui.untitled'))), ' · ',
            t(can ? 'collab.bible.help_owner' : 'collab.bible.help_reader'))),
        h('a', { class: 'pill', href: `#/game/${enc(gameId)}` }, icon('home'), t('ui.game'))));
    body.replaceChildren(headCard, can ? editor(game, bible, lib) : reader(bible, lib), teamCard(game, team, () => disposed));
  })();
  return () => {
    disposed = true;
  };
}

function reader(b: Bible, lib: LibraryType[]): HTMLElement {
  const starters = lib.filter((x) => b.starter_type_ids.includes(x.id));
  return card('collab-bible-read',
    b.style_image_url ? h('img', { class: 'collab-style-img', src: b.style_image_url, alt: t('collab.bible.style') }) : '',
    h('h3', null, t('collab.bible.pitch')), note(b.pitch ? kidText(b.pitch) : t('collab.bible.no_pitch'), b.pitch ? '' : 'muted'),
    h('h3', null, t('collab.bible.mechanics')), h('div', { class: 'collab-mechanics' }, b.mechanics_text ? kidText(b.mechanics_text) : t('collab.bible.no_mechanics')),
    starters.length ? h('div', null, h('h3', null, t('collab.bible.starters')), h('div', { class: 'row wrap' }, ...starters.map((s) => h('div', { class: 'collab-starter' }, typeThumb(s, 72, 60), h('span', { class: 'small' }, kidText(s.name)))))) : '',
    h('p', { class: 'small muted' }, t(b.open_for === 'invite' ? 'collab.bible.open_invite' : 'collab.bible.open_everyone')));
}

function editor(game: GameCard, b: Bible, lib: LibraryType[]): HTMLElement {
  let styleId = b.style_id;
  let stylePrompt = b.style_prompt;
  let openFor: OpenFor = b.open_for;
  const starters = new Set(b.starter_type_ids);

  const pitch = h('textarea', { rows: 2, maxLength: 240, placeholder: t('collab.bible.pitch_placeholder'), value: b.pitch });
  const mech = h('textarea', { rows: 7, maxLength: 3000, class: 'collab-mech-in', placeholder: t('collab.bible.mechanics_placeholder'), value: b.mechanics_text });

  // ---- style picture ----
  const styleImg = h('div', { class: 'collab-style-box' });
  const showStyle = (url: string | null): void => {
    styleImg.replaceChildren(url ? h('img', { class: 'collab-style-img', src: url, alt: t('collab.bible.style') }) : h('div', { class: 'collab-style-empty' }, '🎨', h('span', { class: 'small muted' }, t('collab.bible.no_style'))));
  };
  showStyle(b.style_image_url);
  const styleDesc = h('input', { type: 'text', class: 'text', maxLength: 200, placeholder: t('collab.bible.style_placeholder'), value: b.style_prompt ?? '' });
  const styleStatus = h('span', { class: 'small muted' });
  const makeBtn = h('button', { type: 'button', class: 'pill accent' }, '✨ ', t('collab.bible.make_style'));
  const upIn = h('input', { type: 'file', accept: 'image/*', class: 'hidden' });
  const upBtn = h('button', { type: 'button', class: 'pill', onclick: () => upIn.click() }, icon('camera'), t('collab.bible.upload_style'));
  const busy = (on: boolean): void => {
    makeBtn.disabled = on;
    upBtn.disabled = on;
    styleStatus.textContent = on ? t('collab.bible.making_style') : '';
  };
  makeBtn.onclick = async () => {
    const d = styleDesc.value.trim();
    if (!d) {
      styleDesc.focus();
      toast(t('collab.bible.style_need_words'));
      return;
    }
    busy(true);
    try {
      const r = await collab.styleFromText(game.id, d);
      styleId = r.style_id || styleId;
      stylePrompt = d;
      showStyle(r.image_url);
      styleStatus.textContent = t('collab.bible.style_ready');
    } catch (e) {
      styleStatus.textContent = errText(e);
    } finally {
      makeBtn.disabled = false;
      upBtn.disabled = false;
    }
  };
  upIn.onchange = async () => {
    const f = upIn.files?.[0];
    upIn.value = '';
    if (!f) return;
    busy(true);
    try {
      const r = await collab.styleFromImage(game.id, f);
      styleId = r.style_id || styleId;
      showStyle(r.image_url ?? URL.createObjectURL(f));
      styleStatus.textContent = t('collab.bible.style_ready');
    } catch (e) {
      styleStatus.textContent = errText(e, 'error.upload_failed');
    } finally {
      makeBtn.disabled = false;
      upBtn.disabled = false;
    }
  };

  // ---- starter creatures ----
  const starterGrid = h('div', { class: 'collab-starters' });
  const renderStarters = (): void => {
    starterGrid.replaceChildren(...(lib.length
      ? lib.slice().sort((a, c) => a.name.localeCompare(c.name)).map((lt) => h('button', {
        type: 'button', class: `collab-starter pick${starters.has(lt.id) ? ' on' : ''}`, 'aria-pressed': String(starters.has(lt.id)),
        onclick: () => {
          if (starters.has(lt.id)) starters.delete(lt.id);
          else starters.add(lt.id);
          renderStarters();
        },
      }, typeThumb(lt, 72, 60), h('span', { class: 'small' }, starters.has(lt.id) ? '✓ ' : '', kidText(lt.name))))
      : [note(t('collab.bible.no_creatures'), 'small muted')]));
  };
  renderStarters();

  // ---- who can add levels ----
  const openBox = h('div', { class: 'collab-open-for' });
  const renderOpen = (): void => {
    openBox.replaceChildren(...(['everyone', 'invite'] as OpenFor[]).map((v) => h('button', {
      type: 'button', class: `check-box radio${openFor === v ? ' on' : ''}`, onclick: () => { openFor = v; renderOpen(); },
    }, h('span', { class: 'tick' }, openFor === v ? '✓' : ''),
    h('span', { class: 'cb-text' }, h('span', { class: 'cb-label' }, t(`collab.open_for.${v}`)), h('span', { class: 'small muted' }, t(`collab.bible.open_${v}`))))));
  };
  renderOpen();

  const saveBtn = h('button', { type: 'submit', class: 'pill primary big' }, icon('check'), t('collab.bible.save'));
  const saveStatus = h('span', { class: 'small muted' });
  const form = h('form', { class: 'collab-bible-form' },
    card(null,
      h('label', { class: 'field' }, h('span', null, '💡 ', t('collab.bible.pitch')), pitch),
      h('label', { class: 'field' }, h('span', null, '⚙️ ', t('collab.bible.mechanics')), h('span', { class: 'small muted' }, t('collab.bible.mechanics_help')), mech)),
    card(null,
      h('h3', null, '🎨 ', t('collab.bible.style')),
      h('p', { class: 'small muted' }, t('collab.bible.style_help')),
      h('div', { class: 'collab-style-row' }, styleImg,
        h('div', { class: 'collab-style-side' }, styleDesc, h('div', { class: 'row wrap' }, makeBtn, upBtn), styleStatus, upIn))),
    card(null,
      h('div', { class: 'row between wrap' }, h('h3', null, '🐾 ', t('collab.bible.starters')),
        h('a', { class: 'pill small', href: `#/game/${enc(game.id)}/library` }, icon('plus'), t('library.make'))),
      h('p', { class: 'small muted' }, t('collab.bible.starters_help')),
      starterGrid),
    card(null, h('h3', null, '🚪 ', t('collab.bible.who_can')), openBox),
    h('div', { class: 'row wrap end collab-save-row' }, saveStatus, saveBtn));
  form.onsubmit = async (e) => {
    e.preventDefault();
    saveBtn.disabled = true;
    saveStatus.textContent = t('ui.saving');
    try {
      await collab.putBible(game.id, {
        pitch: pitch.value.trim(), mechanics_text: mech.value.trim(), style_id: styleId, style_prompt: stylePrompt ?? (styleDesc.value.trim() || null),
        starter_type_ids: [...starters], open_for: openFor,
      });
      saveStatus.textContent = '';
      toast(t('collab.bible.saved'));
    } catch (err) {
      saveStatus.textContent = errText(err);
    } finally {
      saveBtn.disabled = false;
    }
  };
  return form;
}

/** The team: owner, maintainers and helpers. The owner can promote, demote, remove and add by profile link. */
function teamCard(game: GameCard, team: GameTeam, gone: () => boolean): HTMLElement {
  let members = team.members.slice();
  const isOwner = team.canManage;
  const listEl = h('div', { class: 'collab-members' });
  const set = async (run: () => Promise<Member[] | void>): Promise<void> => {
    try {
      const r = await run();
      if (gone()) return;
      if (Array.isArray(r) && r.length) members = r;
      else members = await collab.members(game.id).catch(() => members);
      render();
    } catch (e) {
      toast(errText(e));
    }
  };
  const render = (): void => {
    const order = { owner: 0, maintainer: 1, contributor: 2 } as const;
    members.sort((a, b) => order[a.role] - order[b.role]);
    listEl.replaceChildren(...(members.length ? members.map((m) => h('div', { class: 'collab-member' },
      playerChip(m.player, { size: 34 }), roleChip(m.role),
      isOwner && m.role !== 'owner' ? h('div', { class: 'row wrap collab-member-actions' },
        m.role === 'contributor'
          ? h('button', { type: 'button', class: 'pill small', onclick: () => void set(() => collab.addMember(game.id, m.player.id, 'maintainer')) }, '⭐ ', t('collab.bible.make_maintainer'))
          : h('button', { type: 'button', class: 'pill small', onclick: () => void set(() => collab.addMember(game.id, m.player.id, 'contributor')) }, t('collab.bible.make_helper')),
        h('button', {
          type: 'button', class: 'pill small',
          onclick: () => confirm(t('collab.bible.remove_confirm', { name: m.player.name })) && void set(() => collab.removeMember(game.id, m.player.id)),
        }, icon('close'), t('collab.bible.remove'))) : ''))
      : [note(t('collab.bible.no_members'), 'small muted')]));
  };
  render();
  const addIn = h('input', { type: 'text', class: 'text', placeholder: t('collab.bible.add_placeholder') });
  const add = h('form', { class: 'row wrap collab-add-member' }, addIn, h('button', { type: 'submit', class: 'pill small' }, icon('plus'), t('collab.bible.add_member')));
  add.onsubmit = (e) => {
    e.preventDefault();
    const raw = addIn.value.trim();
    const id = raw.includes('#/profile/') ? decodeURIComponent(raw.split('#/profile/')[1].split(/[?&#/]/)[0]) : raw;
    if (!id) return;
    void set(async () => {
      const r = await collab.addMember(game.id, id, 'contributor');
      addIn.value = '';
      toast(t('collab.bible.added'));
      return r;
    });
  };
  const link = `${location.origin}${location.pathname}#/game/${enc(game.id)}`;
  return card('collab-team',
    h('h2', null, '👥 ', t('collab.bible.team')),
    listEl,
    isOwner ? h('div', null, h('p', { class: 'small muted' }, t('collab.bible.add_help')), add) : '',
    h('div', { class: 'row wrap' },
      h('button', {
        type: 'button', class: 'pill small',
        onclick: () => void navigator.clipboard?.writeText(link).then(() => toast(t('ui.link_copied')), () => undefined),
      }, icon('share'), t('collab.bible.invite_link'))));
}
