/**
 * #/dev — developer page (moved out of the kid chrome, §7.9): the entity showcase levels (a playable fixture for each
 * gameplay system, §11.7 item 10), the conformance levels validated and hashed by the browser core, and the bot on
 * any of them (solvable, bot time, par, C and band, flags). Developer text is plain English here by design.
 */
import { levelHash, validateLevel } from '../../core/index.ts';
import type { Entity, LevelV2, PlaytestReport } from '../../core/types.gen.ts';
import { api } from '../api.ts';
import { coreClient, CoreError } from '../core_client.ts';
import { card, h, toast } from '../dom.ts';
import { fmtClock } from '../messages.ts';
import { navigate } from '../router.ts';
import { store } from '../store.ts';
import { emptyInkFor, inkFromLevel } from '../ink.ts';
import { showcaseLevels } from '../showcase.ts';
import { Stage } from '../stage.ts';

const conformance = import.meta.glob('../../../../shared/spec/conformance/levels/*/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

function entityChips(level: LevelV2): HTMLElement {
  const counts = new Map<string, number>();
  for (const e of level.compiled.entities as Entity[]) {
    const k = e.type === 'enemy' ? `${e.spiky ? 'spiky ' : ''}${e.archetype}` : e.type === 'spikes' ? `spikes ${e.facing}` : e.type;
    if (k === 'player_start' || k === 'goal') continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const tiles = new Set(level.compiled.tiles.rows.join('').replace(/[0-9.#]/g, ''));
  const tileNames: Record<string, string> = { '=': 'one-way', '/': 'slope 1:1', '\\': 'slope 1:1', a: 'slope 1:2', b: 'slope 1:2', c: 'slope 1:2', d: 'slope 1:2', '~': 'lava', X: 'legacy X' };
  const named = new Set([...tiles].map((c) => tileNames[c]).filter(Boolean));
  const r = level.rules;
  const extras = [r.lives && r.lives !== 'off' ? `${r.lives} lives` : '', (r.hearts ?? 1) > 1 ? `${r.hearts} hearts` : '', r.physics_profile !== 'v2-standard' ? r.physics_profile ?? '' : ''].filter(Boolean);
  return h('div', { class: 'chips' },
    ...[...counts].map(([k, n]) => h('span', { class: 'beat-chip' }, n > 1 ? `${k} ×${n}` : k)),
    ...[...named].map((n) => h('span', { class: 'beat-chip tile' }, n)),
    ...extras.map((x) => h('span', { class: 'beat-chip rule' }, x)));
}

function reportLine(r: PlaytestReport, ms: number): HTMLElement {
  const flags = r.flags.filter((f) => f.severity !== 'info');
  return h('div', { class: 'small bot-line' },
    h('span', { class: r.solvable ? 'ok' : 'bad' }, r.solvable ? 'solvable' : `unsolvable (${r.reason ?? r.frontier?.blocking?.kind ?? '?'})`),
    r.solvable ? ` · bot ${fmtClock(r.fastest_ms)} · par ${fmtClock(r.par_ms)} · C ${r.C.toFixed(2)} (${r.band}) · score ${r.score}` : '',
    ` · ${r.route.length} route steps · ${r.segments.length} segments · ${Math.round(ms)} ms${r.approx ? ' · approx' : ''}`,
    flags.length ? h('div', { class: 'muted' }, `flags: ${flags.map((f) => `${f.code}/${f.severity}`).join(', ')}`) : '');
}

export function devScreen(root: HTMLElement): () => void {
  let stage: Stage | null = null;
  const stageBox = h('div', { class: 'dev-stage' });
  const showcase = card('dev-list', h('h2', null, 'Entity showcase levels'),
    h('p', { class: 'muted small' }, 'Compiled fixtures for each gameplay system. Play them in test mode, or run the bot (full mode) in the browser core.'));
  const conf = card('dev-list', h('h2', null, 'Conformance levels (browser core)'));
  const sample = h('button', {
    type: 'button', class: 'pill',
    onclick: async () => {
      sample.disabled = true;
      try {
        const form = new FormData();
        form.append('ink', new Blob(['{}'], { type: 'application/json' }), 'ink.json');
        const b = await api.createBuild(form);
        store.setDraftBuild(b.draft_id, { build_id: b.build_id, events_url: b.events_url });
        navigate(`#/preview/${encodeURIComponent(b.draft_id)}?b=${encodeURIComponent(b.build_id)}`);
      } catch {
        sample.disabled = false;
      }
    },
  }, 'Open the preview with a server build of an empty drawing');
  root.append(card(null, h('h2', null, 'Dev'),
    h('div', { class: 'row wrap' }, sample,
      h('a', { class: 'pill', href: '#/prompt' }, 'Prompt-to-level'),
      h('a', { class: 'pill', href: '#/library' }, 'Library'),
      h('a', { class: 'pill', href: '#/scan' }, 'Pack tray'))), stageBox, showcase, conf);

  const show = (level: LevelV2): void => {
    stage?.destroy();
    stage = new Stage('stage dev-stage');
    stageBox.replaceChildren(card(null, h('div', { class: 'row between' }, h('strong', null, level.title), h('button', { type: 'button', class: 'pill small', onclick: () => { stage?.destroy(); stage = null; stageBox.replaceChildren(); } }, 'close')), stage.el));
    stage.setMode('test');
    stage.show({ level, ink: level.ink ? inkFromLevel(level) : emptyInkFor(level) });
    stageBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const botButton = (level: LevelV2, out: HTMLElement): HTMLButtonElement => {
    const b = h('button', { type: 'button', class: 'pill small' }, 'run the bot');
    b.onclick = async () => {
      b.disabled = true;
      out.replaceChildren(h('span', { class: 'muted small' }, 'analyzing…'));
      try {
        const r = await coreClient().analyze({ level, mode: 'full' });
        out.replaceChildren(reportLine(r.report, r.ms));
      } catch (e) {
        out.replaceChildren(h('span', { class: 'bad small' }, e instanceof CoreError ? `${e.code}: ${e.message}` : String(e)));
      } finally {
        b.disabled = false;
      }
    };
    return b;
  };

  for (const s of showcaseLevels()) {
    const v = validateLevel(s.level);
    const out = h('div');
    showcase.append(h('div', { class: 'dev-row' },
      h('div', { class: 'row wrap between' },
        h('div', null, h('strong', null, s.title), ' ', h('span', { class: v.ok ? 'ok small' : 'bad small' }, v.ok ? 'valid' : 'INVALID'),
          h('span', { class: 'muted small' }, ` · ${s.level.world.screens} screen${s.level.world.screens > 1 ? 's' : ''} · ${s.level.meta.level_hash.slice(0, 19)}…`)),
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'pill small', onclick: () => show(s.level) }, 'play'),
          botButton(s.level, out),
          h('button', {
            type: 'button', class: 'pill small',
            onclick: () => void navigator.clipboard.writeText(JSON.stringify(s.level, null, 1)).then(() => toast('JSON copied'), () => toast('copy failed')),
          }, 'copy JSON'))),
      h('p', { class: 'small muted' }, s.what),
      entityChips(s.level),
      v.ok ? '' : h('pre', { class: 'small bad' }, v.errors.slice(0, 6).join('\n')),
      out));
  }

  for (const [path, doc] of Object.entries(conformance).sort()) {
    const name = path.split('/').slice(-2).join('/');
    const r = validateLevel(doc);
    const wantValid = name.startsWith('valid/');
    const out = h('div');
    const row = h('div', { class: 'dev-row' }, h('div', { class: 'row wrap' },
      h('span', { class: r.ok === wantValid ? 'ok' : 'bad' }, r.ok === wantValid ? 'ok' : 'MISMATCH'), ` ${name} `,
      h('span', { class: 'muted small' }, r.ok ? `${levelHash(r.level).slice(0, 19)}…` : r.errors[0] ?? '')), out);
    if (r.ok) {
      const level = r.level;
      row.firstElementChild!.append(h('button', { type: 'button', class: 'pill small', onclick: () => show(level) }, 'play'), botButton(level, out));
    }
    conf.append(row);
  }
  return () => stage?.destroy();
}
