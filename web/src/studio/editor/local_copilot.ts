/**
 * The copilot when the server cannot be reached (docs/v6/CONTRACTS_V6.md §6 "offline replies are marked"): a small
 * keyword helper so the Studio still answers the common asks on this device — "reimagine as <game kind>", "make this
 * a <thing>", gravity, lives, theme names. Lane A's server fallback is the real one; this only covers being offline.
 */
import type { StudioChatResult, StudioEdit, StudioTheme } from '../../core/types.gen.ts';
import { t } from '../../app/messages.ts';
import { CATALOG } from '../model/catalog.ts';
import { sceneOf } from '../model/doc.ts';
import { archetypeEdits } from '../model/edits.ts';
import type { SDoc } from '../model/types.ts';

const KINDS: [RegExp, string, string][] = [
  [/hill|racer|racing|drive|driving|\bcar\b/, 'hill climb racer', 'car'],
  [/fight|fighter|fighting|brawl/, 'fighting game', 'fighter'],
  [/vertical/, 'vertical shooter', 'ship'],
  [/space|asteroid|shooter|shmup/, 'space shooter', 'ship'],
  [/puzzle|angry|slingshot|launch/, 'physics puzzle', 'player'],
  [/catch|basket/, 'catch game', 'player'],
  [/runner|endless|dino/, 'endless runner', 'player'],
  [/top.?down|zelda|maze|rpg|dungeon/, 'top-down', 'hero'],
  [/platform|mario|jump/, 'platformer', 'player'],
];

const ARCH_WORDS: [RegExp, string][] = [
  [/wheel/, 'wheel'], [/\bcar\b|truck|vehicle/, 'car'], [/ship|rocket/, 'ship'], [/fighter/, 'fighter'], [/enemy|monster|bad guy|baddie/, 'enemy'],
  [/coin|gem|star|collect/, 'coin'], [/ground|floor|hill|terrain/, 'ground'], [/platform|wall|block/, 'platform'], [/crate|box/, 'crate'],
  [/ball/, 'ball'], [/lava|spike|danger|hazard/, 'hazard'], [/goal|flag|finish|door/, 'goal'], [/bullet|projectile|fireball/, 'projectile'],
  [/hero/, 'hero'], [/player|me\b|character/, 'player'], [/decor|cloud|tree|background/, 'decoration'], [/spawn/, 'spawner'],
];

export function localCopilot(message: string, doc: SDoc, sceneId: string, selection: string[], themes: StudioTheme[]): StudioChatResult {
  const m = message.toLowerCase();
  const sc = sceneOf(doc, sceneId);
  const edits: StudioEdit[] = [];
  const done: string[] = [];

  // "make this a car" (selection)
  const thisMatch = /\b(this|these|it|selection|selected)\b/.test(m) && selection.length;
  if (thisMatch) {
    const hit = ARCH_WORDS.find(([re]) => re.test(m));
    if (hit) {
      for (const id of selection) edits.push(...archetypeEdits(doc, sc.id, id, hit[1]));
      done.push(t('studio.local.made', { kind: hit[1] }));
    }
  }

  // "reimagine as a hill climb racer"
  if (!edits.length) {
    const kind = KINDS.find(([re]) => re.test(m));
    if (kind) {
      const p = CATALOG.worlds.find((w) => w.kind === kind[1]);
      if (p) {
        edits.push({ action: 'set_world', data: { kind: p.kind, gravity: p.gravity, camera: p.camera, edges: p.edges, width: p.width, height: p.height, players: p.players ?? 1 } });
        if (!doc.hud.items.length) edits.push({ action: 'set_hud', data: { items: [{ subject: 'game', counter: 'score', style: 'number', label: 'Score' }], timer: false } });
        const wide = sc.objects.filter((o) => o.drawing.strokes.length && o.drawing.w * o.scale > 600 && o.kind === 'thing');
        for (const o of wide) edits.push({ action: 'update_object', target: o.id, data: { kind: 'ground', physics: { body: 'static', shape: 'line', friction: 0.9 }, tags: ['ground'] } });
        const hasHero = sc.objects.some((o) => o.player === 1 || o.kind === kind[2]);
        if (!hasHero) {
          const a = CATALOG.archetypes.find((x) => x.kind === kind[2]);
          edits.push({
            action: 'ask_draw',
            data: { id: kind[2], prompt: t('studio.local.draw', { thing: a?.label.toLowerCase() ?? kind[2] }), object: { kind: kind[2], physics: a?.physics ?? {}, behaviors: a?.behaviors ?? [], tags: a?.tags ?? [], counters: a?.counters ?? {}, player: a?.player ?? 0 } },
          });
        }
        done.push(t('studio.local.world', { kind: p.kind }));
      }
    }
  }

  // gravity
  if (/gravity/.test(m)) {
    const g = /off|no gravity|zero|none|float/.test(m) ? [0, 0] : /flip|upside|up\b/.test(m) ? [0, -1] : /low|moon|less/.test(m) ? [0, 0.4] : /high|strong|more|heavy/.test(m) ? [0, 2] : null;
    if (g) { edits.push({ action: 'set_world', data: { gravity: g } }); done.push(t('studio.local.gravity')); }
  }

  // lives / health
  const lives = /(\d+)\s*(lives|life|hearts)/.exec(m);
  if (lives) {
    const n = Math.min(99, Number(lives[1]));
    edits.push({ action: 'set_game_counters', data: { counters: { lives: n } } });
    const items = [...doc.hud.items.filter((i) => i.counter !== 'lives'), { subject: 'game', counter: 'lives', style: 'hearts' }];
    edits.push({ action: 'set_hud', data: { items, timer: doc.hud.timer, title: doc.hud.title } });
    done.push(t('studio.local.lives', { n }));
  }
  const health = /(\d+)\s*(health|hp)/.exec(m);
  if (health && selection.length) {
    for (const id of selection) edits.push({ action: 'add_behavior', target: id, data: { type: 'health', params: { max: Number(health[1]) } } }, { action: 'set_counters', target: id, data: { counters: { health: Number(health[1]) } } });
    done.push(t('studio.local.health', { n: Number(health[1]) }));
  }

  // theme names
  const theme = themes.find((th) => th.id && (m.includes((th.name ?? '').toLowerCase()) || (th.name ?? '').toLowerCase().split(/\s+/).some((w) => w.length > 3 && m.includes(w))));
  if (theme && /look|theme|style|make it|like|colou?r|\bas\b/.test(m)) {
    edits.push({ action: 'set_theme', data: { preset: theme.id } });
    done.push(t('studio.local.theme', { name: theme.name }));
  }

  const suggestions = [t('studio.starter.racer'), t('studio.starter.fighting'), t('studio.starter.platformer')];
  if (!edits.length) return { reply: t('studio.local.rephrase'), edits: [], suggestions: suggestions as StudioChatResult['suggestions'], source: 'keywords' };
  return { reply: done.join(' '), edits, suggestions: [t('studio.suggest.lives'), t('studio.suggest.gravity'), t('studio.suggest.theme')] as StudioChatResult['suggestions'], source: 'keywords' };
}
