import type { LevelV2 } from '../../core/types.gen.ts';
import { ApiError } from '../api.ts';
import { h, icon, toast } from '../dom.ts';
import { t } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';
import { raceApi, raceSession } from './api.ts';

export function raceButton(level: LevelV2): HTMLButtonElement {
  return h('button', { type: 'button', class: 'tool', onclick: async (event: Event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      const created = await raceApi.create(level, store.author());
      if (!created.token) throw new Error('Missing player ticket');
      raceSession(created.match.id, { token: created.token, seat: 1, invite: created.invite });
      navigate(`#/race/${created.match.id}`);
    } catch (error) {
      toast(t(error instanceof ApiError ? error.messageKey : 'error.network'));
      button.disabled = false;
    }
  } }, icon('ghost'), h('span', { class: 'lbl' }, t('race.play_friend')));
}

export async function shareRace(id: string, invite: string): Promise<void> {
  const url = new URL(`/api/v2/matches/${id}/card?invite=${encodeURIComponent(invite)}`, location.origin).href;
  if (navigator.share) {
    try { await navigator.share({ title: t('race.title'), text: t('race.invite_text'), url }); return; }
    catch (error) { if (error instanceof DOMException && error.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast(t('race.link_copied')); }
  catch { window.prompt(t('race.copy_link'), url); }
}
