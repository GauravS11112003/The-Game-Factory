/**
 * Scripted players for the templates (dev page only): each bot plays its template headlessly through the real runtime
 * (keyboard events and pointer input, physics and rules), to check every template can be beaten. Run from the console
 * on /studio-dev.html: `await studioDev.playtest()` (all) or `await studioDev.playtest('flappy')`.
 */
import type { World, Ent } from '../runtime/world.ts';

export interface BotHost {
  load(name: string): Promise<void>;
  step(n: number, bot?: (w: never, i: number) => unknown): number;
  key(code: string, type: 'keydown' | 'keyup'): boolean;
  runner(): { world: unknown; state: string; input: { pointerDown(x: number, y: number): void; pointerMove(x: number, y: number): void; pointerUp(): void } } | null;
}

type Bot = (h: BotHost) => Promise<string>;

function keys(h: BotHost): { set(k: string, v: boolean): void; release(): void } {
  const st: Record<string, boolean> = {};
  return {
    set(k, v) {
      if (!!st[k] !== v) {
        h.key(k, v ? 'keydown' : 'keyup');
        st[k] = v;
      }
    },
    release() {
      for (const k of Object.keys(st)) if (st[k]) h.key(k, 'keyup');
    },
  };
}

const alive = (w: World, f: (e: Ent) => boolean): Ent[] => w.ents.filter((e) => e.alive && !e.def.template && f(e));

const BOTS: Record<string, Bot> = {
  async flappy(h) {
    const k = keys(h);
    let up = false;
    h.step(60 * 90, (w: World) => {
      const b = w.byId.get('bird');
      if (!b || h.runner()!.state !== 'playing') return false;
      if (up) {
        k.set('Space', false);
        up = false;
      }
      const pipe = alive(w, (e) => e.templateId === 'pipes' && e.x + 70 > b.x - 30).sort((a, c) => a.x - c.x)[0];
      if ((b.y > (pipe ? pipe.y + 35 : 450) && (b.body?.vy ?? 0) > -60) || w.gravity[1] === 0) {
        k.set('Space', true);
        up = true;
      }
      return undefined;
    });
    k.release();
    return '';
  },
  async runner(h) {
    const k = keys(h);
    let hold = 0;
    let dj = false;
    h.step(60 * 80, (w: World) => {
      const p = w.byId.get('runner');
      if (!p || h.runner()!.state !== 'playing') return false;
      const hz = alive(w, (e) => (e.tags.has('hazard') || e.tags.has('block')) && e.x + 60 > p.x).sort((a, c) => a.x - c.x)[0];
      const d = hz ? hz.x - p.x : 9999;
      const g = p.body?.grounded ?? false;
      if (g) dj = false;
      if (hold > 0) {
        hold--;
        if (!hold) k.set('Space', false);
      } else if (d < 170 && d > 30 && g) {
        k.set('Space', true);
        hold = 20;
      } else if (!g && !dj && (p.body?.vy ?? 0) > 0 && d < 120 && d > -20 && hz && p.y > hz.y - 150) {
        k.set('Space', true);
        hold = 15;
        dj = true;
      }
      return undefined;
    });
    k.release();
    return '';
  },
  async catch(h) {
    const k = keys(h);
    h.step(60 * 120, (w: World) => {
      const b = w.byId.get('basket');
      if (!b || h.runner()!.state !== 'playing') return false;
      const star = alive(w, (e) => e.templateId === 'star' && e.y < b.y - 10).sort((a, c) => c.y - a.y)[0];
      let tx = star ? star.x : b.x;
      for (const bo of alive(w, (e) => e.templateId === 'bomb' && e.y < b.y && e.y > b.y - 300)) if (Math.abs(bo.x - tx) < 120) tx = bo.x + (bo.x > b.x ? -200 : 200);
      k.set('ArrowRight', tx > b.x + 25);
      k.set('ArrowLeft', tx < b.x - 25);
      return undefined;
    });
    k.release();
    return '';
  },
  async space_shooter(h) {
    const k = keys(h);
    h.step(60 * 150, (w: World) => {
      const s = w.byId.get('ship');
      if (!s || h.runner()!.state !== 'playing') return false;
      const t = alive(w, (e) => e.tags.has('asteroid')).sort((a, c) => Math.hypot(a.x - s.x, a.y - s.y) - Math.hypot(c.x - s.x, c.y - s.y))[0];
      k.set('Space', true);
      if (t) {
        const want = (Math.atan2(t.x - s.x, -(t.y - s.y)) * 180) / Math.PI;
        const diff = ((want - (s.body?.angle ?? 0) + 540) % 360) - 180;
        k.set('ArrowRight', diff > 6);
        k.set('ArrowLeft', diff < -6);
        k.set('ArrowUp', Math.hypot(t.x - s.x, t.y - s.y) > 500 && Math.abs(diff) < 30);
      }
      return undefined;
    });
    k.release();
    return '';
  },
  async platformer(h) {
    const k = keys(h);
    const pits = [[900, 1080], [1640, 1820], [2500, 2640]];
    let hold = 0;
    k.set('ArrowRight', true);
    h.step(60 * 60, (w: World, i: number) => {
      const p = w.byId.get('hero');
      if (!p || h.runner()!.state !== 'playing') return false;
      const slime = alive(w, (e) => e.tags.has('enemy') && e.x > p.x - 10 && e.x - p.x < 200)[0];
      const pit = pits.find(([a]) => p.x < a && a - p.x < 100);
      if (hold > 0) {
        hold--;
        if (!hold) k.set('Space', false);
      } else if (p.body?.grounded && (slime || pit || (Math.abs(p.body.vx) < 30 && i > 30))) {
        k.set('Space', true);
        hold = 40;
      }
      return undefined;
    });
    k.release();
    return '';
  },
  async top_down(h) {
    const k = keys(h);
    const wps = [[200, 900], [1200, 900], [1200, 690], [1500, 690], [1500, 200], [1500, 690], [2150, 690], [2150, 560], [2150, 380]];
    let wi = 0;
    h.step(60 * 60, (w: World) => {
      const p = w.byId.get('hero');
      if (!p || h.runner()!.state !== 'playing') return false;
      const [tx, ty] = wps[wi];
      const dx = tx - p.x;
      const dy = ty - p.y;
      if (Math.hypot(dx, dy) < 20 && wi < wps.length - 1) wi++;
      k.set('ArrowRight', dx > 8);
      k.set('ArrowLeft', dx < -8);
      k.set('ArrowDown', dy > 8);
      k.set('ArrowUp', dy < -8);
      return undefined;
    });
    k.release();
    return '';
  },
  async hill_climb(h) {
    const k = keys(h);
    h.step(60 * 80, (w: World) => {
      const c = w.byId.get('car');
      if (!c || h.runner()!.state !== 'playing') return false;
      const ang = ((((c.body?.angle ?? 0) % 360) + 540) % 360) - 180;
      const air = !(c.body?.wheels?.() ?? []).some((x) => x.body.grounded);
      const tooUp = ang < (air ? -25 : -60);
      k.set('ArrowRight', !tooUp);
      k.set('ArrowLeft', tooUp);
      return undefined;
    });
    k.release();
    return '';
  },
  async fighter(h) {
    const k = keys(h);
    let tap = 0;
    h.step(60 * 90, (w: World, i: number) => {
      const a = w.byId.get('fighter1');
      const b = w.byId.get('fighter2');
      if (!a || !b || h.runner()!.state !== 'playing') return false;
      const dx = b.x - a.x;
      k.set('ArrowRight', dx > 90);
      k.set('ArrowLeft', dx < -90);
      if (tap > 0) {
        tap--;
        if (!tap) {
          k.set('KeyE', false);
          k.set('KeyQ', false);
        }
      } else if (Math.abs(dx) < 120 && Math.abs(b.y - a.y) < 80 && i % 12 === 0) {
        k.set('KeyE', true);
        tap = 3;
      } else if (Math.abs(dx) > 350 && i % 40 === 0) {
        k.set('KeyQ', true);
        tap = 3;
      }
      return undefined;
    });
    k.release();
    return '';
  },
  async physics_puzzle(h) {
    const r = h.runner()!;
    h.step(120);
    let high = false;
    let last = '';
    for (let s = 0; s < 5 && r.state === 'playing'; s++) {
      const w = r.world as World;
      const bird = w.byId.get('bird')!;
      const sling = bird.behaviors.find((b) => b.def.type === 'launcher')!;
      for (let i = 0; i < 600 && sling.s.state !== 'ready' && r.state === 'playing'; i++) h.step(1);
      if (r.state !== 'playing') break;
      const pig = alive(w, (e) => e.tags.has('pig')).sort((a, c) => a.x - c.x)[0];
      if (!pig) break;
      if (pig.id !== last) high = false;
      last = pig.id;
      const ax = sling.s.ax as number;
      const ay = sling.s.ay as number;
      const pull = 170;
      const k = Number(sling.def.params.power) * 12;
      let best: [number, number] | null = null;
      for (let th = high ? 0.8 : 0.05; th < (high ? 1.4 : 0.8); th += 0.003) {
        const px = -Math.cos(th) * pull;
        const py = Math.sin(th) * pull;
        let x = ax + px;
        let y = ay + py;
        let vx = -px * k;
        let vy = -py * k;
        let md = 1e9;
        for (let i = 0; i < 300 && y < 900; i++) {
          vx *= 0.998;
          vy = vy * 0.998 + 26.67;
          x += vx / 60;
          y += vy / 60;
          md = Math.min(md, Math.hypot(x - pig.x, y - pig.y));
        }
        if (!best || md < best[1]) best = [th, md];
      }
      const th = best![0];
      const px = -Math.cos(th) * pull;
      const py = Math.sin(th) * pull;
      const before = alive(w, (e) => e.tags.has('pig')).length;
      r.input.pointerDown(ax, ay);
      h.step(2);
      for (let i = 1; i <= 10; i++) {
        r.input.pointerMove(ax + (px * i) / 10, ay + (py * i) / 10);
        h.step(1);
      }
      r.input.pointerUp();
      h.step(60 * 5);
      if (alive(w, (e) => e.tags.has('pig')).length === before) high = !high;
    }
    h.step(120);
    return '';
  },
};

/** Play one template (or all of them) with its bot; returns "name: won/lost/playing (score…)" lines. */
export async function playtest(h: BotHost, only?: string): Promise<string> {
  const out: string[] = [];
  for (const [name, bot] of Object.entries(BOTS)) {
    if (only && name !== only) continue;
    await h.load(name);
    const t0 = performance.now();
    await bot(h);
    const r = h.runner();
    const w = r?.world as World | undefined;
    out.push(`${name}: ${r?.state} after ${w?.t.toFixed(1)} game s (${Math.round(performance.now() - t0)} ms) ${JSON.stringify(w?.game ?? {})}`);
  }
  return out.join('\n');
}
