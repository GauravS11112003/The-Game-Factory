/**
 * The Copilot chat (docs/v6/CONTRACTS_V6.md §6): maker and copilot messages, starter chips on an empty game,
 * suggestions as chips, and for every reply with edits "Changed N things · Undo" with a plain sentence per edit.
 * The request carries the doc, scene, selection, the last 20 turns and a canvas snapshot. Offline, a small local
 * helper answers (marked subtly). The conversation is kept per game on this device.
 */
import type { ChatTurn, StudioChatBody, StudioChatResult } from '../../core/types.gen.ts';
import { h } from '../../app/dom.ts';
import { kidText, t } from '../../app/messages.ts';
import { isOffline, studioApi } from '../../app/studio_api.ts';
import { describeEdits } from '../model/describe.ts';
import { displayName } from '../model/doc.ts';
import { asGameDoc, type SDoc } from '../model/types.ts';
import { sicon } from './icons.ts';
import { localCopilot } from './local_copilot.ts';
import { snapshotPng } from './snapshot.ts';
import type { Studio } from './studio.ts';

interface Msg {
  role: 'user' | 'copilot';
  text: string;
  sentences?: string[];
  source?: 'model' | 'keywords' | 'offline';
  suggestions?: string[];
  pending?: boolean;
  after?: SDoc | null;
  undone?: boolean;
  error?: boolean;
}

const KEY = 'dp.studio.chat.';

export class CopilotChat {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private input: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private about: HTMLElement;
  private msgs: Msg[] = [];
  private busy = false;
  private ctl: AbortController | null = null;
  private undoButtons = new Map<Msg, HTMLButtonElement>();
  private off: () => void;
  private status: HTMLElement;

  constructor(private readonly studio: Studio, private readonly gameId: () => string) {
    this.list = h('div', { class: 'st-chat-list', role: 'log', 'aria-live': 'polite' });
    this.input = h('textarea', { class: 'st-chat-in', rows: 1, maxLength: 2000, placeholder: t('studio.chat.placeholder'), 'aria-label': t('studio.chat.placeholder') });
    this.sendBtn = h('button', { type: 'submit', class: 'st-send', title: t('studio.chat.send'), 'aria-label': t('studio.chat.send') }, sicon('send'));
    this.about = h('div', { class: 'st-chat-about' });
    this.status = h('span', { class: 'st-chat-status' });
    const form = h('form', { class: 'st-chat-form' }, this.about, h('div', { class: 'st-chat-box' }, this.input, this.sendBtn));
    form.onsubmit = (e) => { e.preventDefault(); void this.send(this.input.value); };
    this.input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(this.input.value); }
    };
    this.input.oninput = () => this.grow();
    this.el = h('div', { class: 'st-chat' },
      h('div', { class: 'st-panel-head' }, h('span', { class: 'st-copilot-mark', 'aria-hidden': 'true' }, sicon('sparkle')), h('span', { class: 'st-panel-title' }, t('studio.chat.title')), this.status,
        h('button', { type: 'button', class: 'st-ibtn small', title: t('studio.chat.clear'), 'aria-label': t('studio.chat.clear'), onclick: () => this.clear() }, sicon('restart'))),
      this.list, form);
    this.load();
    this.render();
    this.off = studio.on((c) => {
      if (c.kind === 'doc') this.syncUndo();
      if (c.kind === 'selection' || c.kind === 'doc') this.renderAbout();
    });
    this.renderAbout();
  }

  private grow(): void {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(160, this.input.scrollHeight)}px`;
    this.input.style.overflowY = this.input.scrollHeight > 160 ? 'auto' : 'hidden';
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(KEY + this.gameId());
      const v = raw ? (JSON.parse(raw) as Msg[]) : [];
      this.msgs = Array.isArray(v) ? v.filter((m) => m && (m.role === 'user' || m.role === 'copilot') && typeof m.text === 'string').map((m) => ({ ...m, pending: false, after: null })) : [];
    } catch {
      this.msgs = [];
    }
  }

  private save(): void {
    try {
      const keep = this.msgs.filter((m) => !m.pending).slice(-40).map(({ after: _a, ...m }) => m);
      localStorage.setItem(KEY + this.gameId(), JSON.stringify(keep));
    } catch {
      /* storage off */
    }
  }

  private clear(): void {
    this.msgs = [];
    this.save();
    this.render();
  }

  private renderAbout(): void {
    const sel = this.studio.selected;
    if (!sel.length) { this.about.replaceChildren(); this.about.hidden = true; return; }
    this.about.hidden = false;
    this.about.replaceChildren(sicon('cursor'), h('span', null, t('studio.chat.about', { names: sel.slice(0, 3).map(displayName).join(', ') + (sel.length > 3 ? '…' : '') })));
  }

  /** Offline indicator in the header. */
  setOffline(offline: boolean): void {
    this.status.textContent = offline ? t('studio.chat.offline_badge') : '';
    this.status.classList.toggle('on', offline);
  }

  private render(): void {
    this.undoButtons.clear();
    const kids: HTMLElement[] = [];
    if (!this.msgs.length) kids.push(this.welcome());
    const lastCopilot = [...this.msgs].reverse().find((m) => m.role === 'copilot' && !m.pending);
    for (const m of this.msgs) kids.push(this.bubble(m, m === lastCopilot));
    this.list.replaceChildren(...kids);
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  private welcome(): HTMLElement {
    const empty = this.studio.doc.scenes.every((s) => !s.objects.length);
    const starters = empty
      ? ['studio.starter.racer', 'studio.starter.fighting', 'studio.starter.space', 'studio.starter.platformer']
      : ['studio.starter.reimagine', 'studio.starter.what', 'studio.starter.lives', 'studio.starter.theme'];
    return h('div', { class: 'st-welcome' },
      h('div', { class: 'st-welcome-mark', 'aria-hidden': 'true' }, sicon('sparkle')),
      h('p', { class: 'st-welcome-title' }, t('studio.chat.hello')),
      h('p', { class: 'st-welcome-text' }, t(empty ? 'studio.chat.hello_empty' : 'studio.chat.hello_drawn')),
      h('div', { class: 'st-chips col' }, ...starters.map((k) => h('button', { type: 'button', class: 'st-suggest', onclick: () => void this.send(t(k)) }, sicon('sparkle'), t(k)))));
  }

  private bubble(m: Msg, last: boolean): HTMLElement {
    if (m.role === 'user') return h('div', { class: 'st-msg user' }, h('div', { class: 'st-msg-text' }, m.text));
    if (m.pending) return h('div', { class: 'st-msg copilot pending', 'aria-label': t('studio.chat.thinking') }, h('span', { class: 'st-typing' }, h('i'), h('i'), h('i')));
    const kids: HTMLElement[] = [h('div', { class: `st-msg-text${m.error ? ' err' : ''}` }, kidText(m.text))];
    if (m.sentences?.length) {
      const undo = h('button', { type: 'button', class: 'st-undo-link' }, sicon('undo'), t('studio.chat.undo'));
      undo.onclick = () => this.undoReply(m);
      this.undoButtons.set(m, undo);
      kids.push(h('details', { class: 'st-changes' },
        h('summary', null, sicon('check', 'ico st-changes-ico'), h('span', null, m.undone ? t('studio.chat.undone') : t(m.sentences.length === 1 ? 'studio.chat.changed_one' : 'studio.chat.changed', { n: m.sentences.length })), m.undone ? null : undo),
        h('ul', null, ...m.sentences.map((s) => h('li', null, s)))));
    }
    if (m.source === 'offline' || m.source === 'keywords') kids.push(h('span', { class: 'st-msg-src' }, t(m.source === 'offline' ? 'studio.chat.src_offline' : 'studio.chat.src_keywords')));
    if (last && m.suggestions?.length) kids.push(h('div', { class: 'st-chips' }, ...m.suggestions.map((s) => h('button', { type: 'button', class: 'st-suggest', onclick: () => void this.send(s) }, kidText(s)))));
    const el = h('div', { class: 'st-msg copilot' }, ...kids);
    this.syncUndoFor(m);
    return el;
  }

  private syncUndoFor(m: Msg): void {
    const b = this.undoButtons.get(m);
    if (!b) return;
    const can = !m.undone && !!m.after && this.studio.doc === m.after;
    b.disabled = !can;
    b.title = can ? t('studio.chat.undo_help') : t('studio.chat.undo_later');
  }

  private syncUndo(): void {
    for (const m of this.undoButtons.keys()) this.syncUndoFor(m);
  }

  private undoReply(m: Msg): void {
    if (!m.after || this.studio.doc !== m.after) return;
    this.studio.undo();
    m.undone = true;
    this.save();
    this.render();
  }

  /** Send a message (optionally about specific objects, e.g. "No, it's…" from the recognize bubble). */
  async send(raw: string, o: { selection?: string[] } = {}): Promise<void> {
    const text = raw.trim().slice(0, 2000);
    if (!text || this.busy) return;
    this.busy = true;
    this.sendBtn.disabled = true;
    this.input.value = '';
    this.grow();
    const s = this.studio;
    s.finishPending(false);
    const history: ChatTurn[] = this.msgs.filter((m) => !m.pending && !m.error).slice(-20).map((m) => ({ role: m.role, text: m.text.slice(0, 4000) }));
    this.msgs.push({ role: 'user', text });
    const pending: Msg = { role: 'copilot', text: '', pending: true };
    this.msgs.push(pending);
    this.render();
    const selection = o.selection ?? s.selection;
    const body: StudioChatBody = {
      game: asGameDoc(s.doc), scene: s.sceneId, selection: selection.slice(0, 50), message: text,
      history: history as StudioChatBody['history'], snapshot_png: snapshotPng(s.doc, s.scene),
    };
    let res: StudioChatResult;
    let source: Msg['source'];
    let error = false;
    this.ctl = new AbortController();
    try {
      res = await studioApi.chat(body, this.ctl.signal);
      source = res.source;
      this.setOffline(false);
    } catch (e) {
      if (isOffline(e)) {
        res = localCopilot(text, s.doc, s.sceneId, selection, s.themes);
        source = 'offline';
        this.setOffline(true);
      } else {
        res = { reply: t('studio.chat.error'), edits: [], suggestions: [], source: 'keywords' };
        error = true;
      }
    }
    this.ctl = null;
    const msg: Msg = { role: 'copilot', text: res.reply || t('studio.chat.done'), source, suggestions: (res.suggestions ?? []).slice(0, 4), error };
    if (Array.isArray(res.edits) && res.edits.length) {
      const before = s.doc;
      s.apply(res.edits.slice(0, 40), { label: 'copilot' });
      s.seal();
      msg.after = s.doc;
      msg.sentences = describeEdits(res.edits.slice(0, 40), s.doc, before, s.sceneId, s.themes);
    }
    const i = this.msgs.indexOf(pending);
    if (i >= 0) this.msgs[i] = msg;
    else this.msgs.push(msg);
    this.busy = false;
    this.sendBtn.disabled = false;
    this.save();
    this.render();
  }

  focus(): void {
    this.input.focus();
  }

  dispose(): void {
    this.ctl?.abort();
    this.off();
  }
}
