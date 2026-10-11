import { W, H, rect, circle, line, label, held, tapped, type Game, type Input } from './engine.ts';

export const ARENA_COLS = 24, ARENA_ROWS = 18;
export const BLUEPRINT = { x: 168, y: 36, tile: 26 };
function defaultArena(): string[] {
  const a: string[][] = Array.from({ length: ARENA_ROWS }, (_, y) => Array.from({ length: ARENA_COLS }, (_, x) => x === 0 || y === 0 || x === ARENA_COLS - 1 || y === ARENA_ROWS - 1 ? '1' : '.'));
  const block = (x: number, y: number, w: number, h: number, tile: string): void => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) a[yy][xx] = tile; };
  block(8, 3, 4, 3, '1'); block(8, 6, 1, 5, '1'); block(6, 8, 2, 1, '1');
  block(12, 9, 3, 4, '2'); block(17, 7, 4, 2, '1'); block(20, 9, 1, 4, '1');
  block(4, 10, 2, 2, '3'); block(10, 14, 2, 2, '3'); block(15, 3, 2, 2, '3');
  block(4, 4, 1, 2, '2'); block(18, 12, 1, 1, '3'); block(2, 7, 1, 1, '3');
  a[3][6] = 'A'; a[4][20] = 'B'; a[14][3] = 'P';
  a[8][3] = 'D'; a[3][19] = 'D'; a[11][16] = 'D';
  return a.map(row => row.join(''));
}
export const SHOOTER_MAP = defaultArena();
export const solid = (tile: string | undefined): boolean => tile === undefined || '123#'.includes(tile);
export interface RayHit { distance: number; tile: string; side: number; u: number; x: number; y: number }
/** Grid DDA is shared by the renderer, hitscan weapons, and bot sight. */
export function castRay(map: readonly string[], x: number, y: number, angle: number, maxDistance = 40): RayHit {
  const dx = Math.cos(angle), dy = Math.sin(angle);
  let mx = Math.floor(x), my = Math.floor(y), side = 0;
  const deltaX = Math.abs(1 / (dx || 1e-10)), deltaY = Math.abs(1 / (dy || 1e-10));
  const sx = dx < 0 ? -1 : 1, sy = dy < 0 ? -1 : 1;
  let tx = (dx < 0 ? x - mx : mx + 1 - x) * deltaX;
  let ty = (dy < 0 ? y - my : my + 1 - y) * deltaY;
  let distance = 0;
  for (let n = 0; n < 150; n++) {
    if (tx < ty) { distance = tx; tx += deltaX; mx += sx; side = 0; }
    else { distance = ty; ty += deltaY; my += sy; side = 1; }
    if (solid(map[my]?.[mx]) || distance > maxDistance) break;
  }
  const hitX = x + dx * distance, hitY = y + dy * distance;
  const u = side ? hitX - Math.floor(hitX) : hitY - Math.floor(hitY);
  return { distance: Math.max(.01, distance), tile: map[my]?.[mx] ?? '1', side, u, x: hitX, y: hitY };
}
export interface Guard { x: number; y: number; homeX: number; homeY: number; hp: number; cooldown: number; alert: number; flash: number; path: { x: number; y: number }[]; pathTime: number; index: number }
interface Site { x: number; y: number; name: 'A' | 'B' }
interface Feed { text: string; time: number; color: string }
const FOV = 1.13, PROJECTION = W / (2 * Math.tan(FOV / 2));
const norm = (angle: number): number => Math.atan2(Math.sin(angle), Math.cos(angle));
const GUNS = {
  rifle: { name: 'VANGUARD RIFLE', magazine: 30, interval: .115, reload: 1.85, damage: 34 },
  pistol: { name: 'SIDEARM', magazine: 12, interval: .29, reload: 1.25, damage: 28 },
};
type Weapon = keyof typeof GUNS;

export class ShooterGame implements Game {
  score = 0; info = 'Buy gear, then press Enter to deploy.'; over = false; won = false;
  map = SHOOTER_MAP.slice(); x = 3.5; y = 14.5; angle = -Math.PI / 2; pitch = 0;
  hp = 100; armor = 40; money = 2400; weapon: Weapon = 'rifle'; rifleOwned = true;
  ammo = { rifle: 30, pistol: 12 }; reserve = { rifle: 90, pistol: 48 };
  reloadTime = 0; reloading: Weapon | null = null; cooldown = 0; recoil = 0; flash = 0; hurt = 0; hitMarker = 0; headMarker = false;
  phase: 'buy' | 'active' | 'result' = 'buy'; phaseTime = 6; roundDuration = 90; timer = 90; round = 1; roundsToWin = 3; wins = 0; losses = 0; roundMessage = '';
  plantProgress = 0; bomb: Site | null = null; bombTimer = 25; defuseProgress = 0; defuser: Guard | null = null;
  guards: Guard[] = []; sites: Site[] = []; feed: Feed[] = []; shots = 0; moving = false; moveTime = 0; noise = 0;
  soundEvents: ('shot' | 'reload' | 'hit' | 'plant' | 'round' | 'hurt')[] = [];
  private textures: HTMLCanvasElement[] | null = null;
  private depth = new Float32Array(W);
  constructor(map = SHOOTER_MAP) { this.setMap(map); }
  setMap(map: readonly string[]): void {
    this.map = map.slice(); this.sites = []; this.guards = [];
    this.map.forEach((row, yy) => [...row].forEach((v, xx) => {
      if (v === 'P') { this.x = xx + .5; this.y = yy + .5; }
      if (v === 'A' || v === 'B') this.sites.push({ x: xx + .5, y: yy + .5, name: v });
      if (v === 'D') this.guards.push({ x: xx + .5, y: yy + .5, homeX: xx + .5, homeY: yy + .5, hp: 85, cooldown: 1 + this.guards.length * .35, alert: 0, flash: 0, path: [], pathTime: 0, index: this.guards.length });
    }));
    this.angle = -Math.PI / 2;
  }
  free(x: number, y: number, radius = .21): boolean {
    return [[-radius, -radius], [radius, -radius], [-radius, radius], [radius, radius]].every(([dx, dy]) => !solid(this.map[Math.floor(y + dy)]?.[Math.floor(x + dx)]));
  }
  move(actor: { x: number; y: number }, dx: number, dy: number): void {
    if (this.free(actor.x + dx, actor.y)) actor.x += dx;
    if (this.free(actor.x, actor.y + dy)) actor.y += dy;
  }
  sight(x: number, y: number, targetX: number, targetY: number): boolean {
    return castRay(this.map, x, y, Math.atan2(targetY - y, targetX - x)).distance > Math.hypot(targetX - x, targetY - y) - .1;
  }
  /** Shortest walking route around buildings and crates. */
  route(x: number, y: number, goalX: number, goalY: number): { x: number; y: number }[] {
    const start = Math.floor(y) * ARENA_COLS + Math.floor(x), end = Math.floor(goalY) * ARENA_COLS + Math.floor(goalX);
    const parents = new Map<number, number>([[start, -1]]), queue = [start];
    for (let n = 0; n < queue.length; n++) {
      const at = queue[n]; if (at === end) break;
      const xx = at % ARENA_COLS, yy = Math.floor(at / ARENA_COLS);
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = xx + dx, ny = yy + dy, key = ny * ARENA_COLS + nx;
        if (nx < 0 || nx >= ARENA_COLS || ny < 0 || ny >= ARENA_ROWS || solid(this.map[ny]?.[nx]) || parents.has(key)) continue;
        parents.set(key, at); queue.push(key);
      }
    }
    if (!parents.has(end)) return [];
    const path = []; let at = end;
    while (at !== start) { path.unshift({ x: at % ARENA_COLS + .5, y: Math.floor(at / ARENA_COLS) + .5 }); at = parents.get(at)!; }
    return path;
  }
  notify(text: string, color = '#e9dfbb'): void { this.feed.unshift({ text, time: 4, color }); this.feed = this.feed.slice(0, 3); }
  reload(): void {
    const gun = GUNS[this.weapon];
    if (this.reloading || this.ammo[this.weapon] >= gun.magazine || this.reserve[this.weapon] <= 0) return;
    this.reloading = this.weapon; this.reloadTime = gun.reload; this.soundEvents.push('reload');
  }
  shoot(): void {
    if (this.phase !== 'active' || this.hp <= 0 || this.reloading || this.cooldown > 0 || this.plantProgress > 0) return;
    if (this.ammo[this.weapon] <= 0) { this.reload(); return; }
    const gun = GUNS[this.weapon]; this.ammo[this.weapon]--; this.cooldown = gun.interval; this.flash = .065;
    const spread = .0018 + this.recoil * .017 + (this.moving ? .022 : 0);
    const angle = this.angle + Math.sin(++this.shots * 2.39996) * spread;
    this.recoil = Math.min(3, this.recoil + .38); this.noise = 2; this.soundEvents.push('shot');
    const wall = castRay(this.map, this.x, this.y, angle);
    let nearest: Guard | null = null, nearestDistance = wall.distance;
    for (const guard of this.guards) {
      if (guard.hp <= 0) continue;
      const dx = guard.x - this.x, dy = guard.y - this.y;
      const distance = dx * Math.cos(angle) + dy * Math.sin(angle);
      const offset = Math.abs(dy * Math.cos(angle) - dx * Math.sin(angle));
      const height = .5 + (H * .49 + this.pitch - H / 2) * distance / PROJECTION;
      if (distance > .1 && distance < nearestDistance && offset < .25 && height > .08 && height < 1.02) { nearest = guard; nearestDistance = distance; }
    }
    if (nearest) {
      const height = .5 + (H * .49 + this.pitch - H / 2) * nearestDistance / PROJECTION;
      const headshot = height > .73; nearest.hp = Math.max(0, nearest.hp - (headshot ? 100 : gun.damage));
      this.hitMarker = .18; this.headMarker = headshot; this.soundEvents.push('hit');
      if (this.defuser === nearest) { this.defuseProgress = 0; this.defuser = null; }
      if (!nearest.hp) { this.score += headshot ? 150 : 100; this.money = Math.min(9000, this.money + 300); this.notify(`${headshot ? 'HEADSHOT' : 'ELIMINATED'}  /  GUARD ${nearest.index + 1}`, headshot ? '#ffd97f' : '#a9e0cb'); }
    }
  }
  finishRound(win: boolean, message: string): void {
    if (this.phase !== 'active') return;
    this.phase = 'result'; this.phaseTime = 3; this.roundMessage = message; this.plantProgress = 0; this.reloading = null;
    if (win) { this.wins++; this.score += 500; this.money = Math.min(9000, this.money + 2700); }
    else { this.losses++; this.money = Math.min(9000, this.money + 1900); }
    this.soundEvents.push('round');
    this.info = message;
    if (this.wins >= this.roundsToWin || this.losses >= this.roundsToWin) { this.over = true; this.won = this.wins >= this.roundsToWin; this.info = this.won ? 'Operation complete. The district is yours.' : 'The defenders held the district. Try a new route.'; }
  }
  nextRound(): void {
    const survived = this.hp > 0; this.round++; this.setMap(this.map);
    this.hp = 100; this.armor = survived ? this.armor : 0; this.rifleOwned = survived && this.rifleOwned;
    this.weapon = this.rifleOwned ? 'rifle' : 'pistol'; this.ammo = { rifle: 30, pistol: 12 }; this.reserve = { rifle: 90, pistol: 48 };
    this.phase = 'buy'; this.phaseTime = 6; this.timer = this.roundDuration; this.pitch = 0;
    this.bomb = null; this.bombTimer = 25; this.defuseProgress = 0; this.defuser = null; this.reloading = null; this.reloadTime = 0;
    this.cooldown = this.recoil = this.flash = this.hurt = this.hitMarker = this.plantProgress = 0;
    this.feed = []; this.info = 'Buy gear, then press Enter to deploy.';
  }
  buy(input: Input): void {
    if (tapped(input, 'Digit1')) {
      if (!this.rifleOwned && this.money >= 1600) { this.money -= 1600; this.rifleOwned = true; }
      if (this.rifleOwned) this.weapon = 'rifle'; else this.notify('Rifle costs $1600');
    }
    if (tapped(input, 'Digit2')) this.weapon = 'pistol';
    if (tapped(input, 'Digit3') && this.armor < 80) {
      if (this.money >= 600) { this.money -= 600; this.armor = 80; this.notify('ARMOR EQUIPPED', '#a9e0cb'); }
      else this.notify('Armor costs $600');
    }
  }
  update(dt: number, input: Input): void {
    if (this.over) return;
    this.feed = this.feed.filter(f => (f.time -= dt) > 0);
    this.cooldown = Math.max(0, this.cooldown - dt); this.recoil = Math.max(0, this.recoil - dt * 2.5);
    this.flash = Math.max(0, this.flash - dt); this.hurt = Math.max(0, this.hurt - dt); this.hitMarker = Math.max(0, this.hitMarker - dt); this.noise = Math.max(0, this.noise - dt);
    if (this.phase === 'result') { this.phaseTime -= dt; if (this.phaseTime <= 0) this.nextRound(); return; }
    if (this.phase === 'buy') {
      if (input.look) input.look.x = input.look.y = 0;
      this.buy(input); this.phaseTime -= dt;
      if (this.phaseTime <= 0 || tapped(input, 'Enter')) { this.phase = 'active'; this.timer = this.roundDuration; this.info = 'Clear the defenders or plant at A / B.'; }
      return;
    }
    if (this.hp > 0) {
      const look = input.look;
      if (look) { this.angle += look.x * .003; this.pitch = Math.max(-140, Math.min(140, this.pitch - look.y * .65)); look.x = look.y = 0; }
      const turn = (held(input, 'ArrowRight') ? 1 : 0) - (held(input, 'ArrowLeft') ? 1 : 0);
      const quickTurn = (tapped(input,'ArrowRight')&&!held(input,'ArrowRight') ? .08 : 0) - (tapped(input,'ArrowLeft')&&!held(input,'ArrowLeft') ? .08 : 0);
      this.angle = norm(this.angle + turn * dt * 1.9 + quickTurn);
      const forward = (held(input, 'KeyW', 'ArrowUp') ? 1 : 0) - (held(input, 'KeyS', 'ArrowDown') ? 1 : 0);
      const strafe = (held(input, 'KeyD') ? 1 : 0) - (held(input, 'KeyA') ? 1 : 0);
      this.moving = forward !== 0 || strafe !== 0; const speed = (held(input, 'ShiftLeft', 'ShiftRight') ? 1.45 : 2.6) * dt / (Math.hypot(forward, strafe) || 1);
      this.move(this, (Math.cos(this.angle) * forward - Math.sin(this.angle) * strafe) * speed, (Math.sin(this.angle) * forward + Math.cos(this.angle) * strafe) * speed);
      if (this.moving) this.moveTime += dt * (held(input, 'ShiftLeft', 'ShiftRight') ? 5 : 9);
      if (tapped(input, 'Digit1', 'Digit2') && !this.reloading) { if (tapped(input, 'Digit1') && this.rifleOwned) this.weapon = 'rifle'; if (tapped(input, 'Digit2')) this.weapon = 'pistol'; this.cooldown = .2; }
      if (tapped(input, 'KeyR')) this.reload();
      if (this.reloading) {
        this.reloadTime -= dt;
        if (this.reloadTime <= 0) { const w = this.reloading, add = Math.min(GUNS[w].magazine - this.ammo[w], this.reserve[w]); this.ammo[w] += add; this.reserve[w] -= add; this.reloading = null; }
      }
      const site = this.sites.find(s => Math.hypot(s.x - this.x, s.y - this.y) < 1.25);
      const firing = held(input, 'Mouse0', 'Space') || tapped(input, 'Mouse0', 'Space');
      if (!this.bomb && site && held(input, 'KeyE') && !firing && !this.reloading && !this.moving) {
        this.plantProgress += dt;
        if (this.plantProgress >= 3) { this.bomb = { ...site }; this.plantProgress = 0; this.score += 200; this.soundEvents.push('plant'); this.notify(`DEVICE PLANTED AT ${site.name}  /  HOLD THE SITE`, '#ffd97f'); }
      } else this.plantProgress = 0;
      if (firing) this.shoot();
      this.info = this.bomb ? `Defend site ${this.bomb.name}. ${Math.ceil(this.bombTimer)} seconds remaining.` : site ? `Hold E for 3 seconds to plant at ${site.name}.` : 'Clear the defenders or plant at A / B.';
    } else this.info = 'You are down. Watching the planted device…';
    this.timer -= dt;
    this.updateGuards(dt);
    if (this.guards.every(g => g.hp <= 0)) { this.finishRound(true, 'AREA SECURED'); return; }
    if (this.bomb) {
      this.bombTimer -= dt;
      const defuser = this.guards.find(g => g.hp > 0 && Math.hypot(g.x - this.bomb!.x, g.y - this.bomb!.y) < .85);
      if (defuser) { if (this.defuser !== defuser) this.defuseProgress = 0; this.defuser = defuser; this.defuseProgress += dt; }
      else { this.defuser = null; this.defuseProgress = 0; }
      if (this.bombTimer <= 0) this.finishRound(true, 'OBJECTIVE COMPLETE');
      else if (this.defuseProgress >= 6) this.finishRound(false, 'DEVICE DEFUSED');
    } else if (this.hp <= 0 || this.timer <= 0) this.finishRound(false, this.hp <= 0 ? 'ROUND LOST' : 'TIME EXPIRED');
  }
  private updateGuards(dt: number): void {
    for (const g of this.guards) {
      if (g.hp <= 0) continue;
      g.flash = Math.max(0, g.flash - dt); g.cooldown -= dt; g.pathTime -= dt;
      const distance = Math.hypot(g.x - this.x, g.y - this.y);
      const sees = this.hp > 0 && distance < 9 && this.sight(g.x, g.y, this.x, this.y);
      g.alert = sees ? g.alert + dt : Math.max(0, g.alert - dt * 2);
      if (sees && g.alert > .75 && g.cooldown <= 0) {
        g.flash = .08; g.cooldown = 1.0 - Math.min(.25, this.wins * .07);
        // Long-range fire and moving targets are less reliable; bots visibly telegraph attacks.
        const shot = Math.floor(this.timer * 2 + g.index * 3);
        if (shot % (this.moving ? 3 : 5) !== 0) {
          const damage = distance < 3 ? 14 : 9, absorbed = Math.min(this.armor, Math.ceil(damage * .65));
          this.armor -= absorbed; this.hp = Math.max(0, this.hp - damage + absorbed); this.hurt = .18; this.soundEvents.push('hurt');
        }
      }
      const goal = this.bomb ?? (sees || (this.noise > 0 && distance < 10) ? this : { x: g.homeX, y: g.homeY });
      if (this.bomb && Math.hypot(g.x - goal.x, g.y - goal.y) < .7) continue;
      if (sees && distance < 4 && !this.bomb) continue;
      if (g.pathTime <= 0) { g.path = this.route(g.x, g.y, goal.x, goal.y); g.pathTime = .6; }
      const target = g.path[0]; if (!target) continue;
      const dx = target.x - g.x, dy = target.y - g.y, d = Math.hypot(dx, dy), step = Math.min(d, dt * (this.bomb ? 1.9 : 1.1 + this.wins * .1));
      if (d < .08) g.path.shift(); else this.move(g, dx / d * step, dy / d * step);
    }
  }
  private makeTextures(): HTMLCanvasElement[] {
    return [0, 1, 2, 3].map(kind => {
      const texture = document.createElement('canvas'); texture.width = texture.height = 64; const c = texture.getContext('2d')!;
      rect(c, 0, 0, 64, 64, kind === 2 ? '#688894' : kind === 3 ? '#b28a55' : '#d9bc83');
      for (let y = 0; y < 64; y += 16) {
        line(c, [[0, y], [64, y]], kind === 2 ? '#527782' : '#bda071', 1);
        for (let x = y % 32 ? 16 : 0; x < 64; x += 32) line(c, [[x, y], [x, y + 16]], kind === 2 ? '#567782' : '#c6a879', 1);
      }
      for (let n = 0; n < 120; n++) { const x = (n * 37) % 64, y = (n * 19 + Math.floor(n / 8)) % 64; rect(c, x, y, 1 + n % 3, 1, n % 2 ? '#ffffff16' : '#50381714'); }
      if (kind === 3) { rect(c, 0, 0, 64, 6, '#806848'); rect(c, 0, 58, 64, 6, '#806848'); rect(c, 0, 0, 6, 64, '#806848'); rect(c, 58, 0, 6, 64, '#806848'); line(c, [[6, 6], [58, 58]], '#96764c', 7); line(c, [[58, 6], [6, 58]], '#96764c', 7); for (const x of [4, 60]) for (const y of [4, 60]) circle(c, x, y, 1.5, '#e1c48d'); }
      else { rect(c, 12, 5, 40, 2, '#ffffff20'); if (kind === 2) { rect(c, 14, 10, 36, 34, '#456773', 3); line(c, [[24, 10], [24, 44]], '#94a9a6', 2); line(c, [[38, 10], [38, 44]], '#94a9a6', 2); } }
      return texture;
    });
  }
  draw(c: CanvasRenderingContext2D, time: number): void {
    this.textures ??= this.makeTextures();
    const horizon = H * .49 + this.pitch + (this.moving ? Math.sin(this.moveTime) * 2 : 0);
    const sky = c.createLinearGradient(0, 0, 0, Math.max(1, horizon)); sky.addColorStop(0, '#5689a0'); sky.addColorStop(1, '#cfddc3'); c.fillStyle = sky; c.fillRect(0, 0, W, H);
    circle(c, 748 - Math.sin(this.angle) * 160, 92 + this.pitch, 30, '#fff1c8');
    for (let n = -1; n < 7; n++) { const x = ((n * 231 - this.angle * 160) % 1400 + 1400) % 1400 - 150; rect(c, x, horizon - 32 - n % 3 * 15, 150, 60 + n % 3 * 15, '#a5b3a4'); rect(c, x + 45, horizon - 62 - n % 3 * 15, 35, 30, '#9fafa1'); }
    const floor = c.createLinearGradient(0, Math.max(0, horizon), 0, H); floor.addColorStop(0, '#c6b18a'); floor.addColorStop(1, '#a89571'); c.fillStyle = floor; c.fillRect(0, horizon, W, H);
    // Perspective stone paving follows the same camera projection as walls.
    for (let yy = Math.max(0, Math.floor(horizon + 12)); yy < H; yy += 5) {
      const d = .5 * PROJECTION / (yy - horizon), left = this.angle - Math.atan(W / 2 / PROJECTION), right = this.angle + Math.atan(W / 2 / PROJECTION);
      const lx = this.x + Math.cos(left) * d / Math.cos(left - this.angle), ly = this.y + Math.sin(left) * d / Math.cos(left - this.angle);
      const rx = this.x + Math.cos(right) * d / Math.cos(right - this.angle), ry = this.y + Math.sin(right) * d / Math.cos(right - this.angle);
      for (let xx = 0; xx < W; xx += 8) {
        const wx = lx + (rx - lx) * xx / W, wy = ly + (ry - ly) * xx / W;
        const fracX = wx - Math.floor(wx), fracY = wy - Math.floor(wy);
        if (fracX < .04 || fracY < .04) rect(c, xx, yy, 8, 5, '#645c4830');
        else if ((Math.floor(wx) + Math.floor(wy)) % 2 === 0) rect(c, xx, yy, 8, 5, '#ffffff07');
      }
    }
    const stride = 3;
    for (let screenX = 0; screenX < W; screenX += stride) {
      const rayAngle = this.angle + Math.atan((screenX - W / 2) / PROJECTION), hit = castRay(this.map, this.x, this.y, rayAngle);
      const distance = hit.distance * Math.cos(rayAngle - this.angle), size = PROJECTION / distance;
      const top = horizon - size * .5, bottom = horizon + size * .5;
      const texture = this.textures[hit.tile === '3' ? 3 : hit.tile === '2' ? 2 : 1];
      c.drawImage(texture, Math.min(63, Math.floor(hit.u * 64)), 0, 1, 64, screenX, top, stride + 1, bottom - top);
      rect(c, screenX, top, stride + 1, size, `rgba(32,40,43,${Math.min(.74, distance * .028 + (hit.side ? .15 : 0))})`);
      if (hit.tile !== '3') { rect(c, screenX, top, stride + 1, Math.max(1, size * .025), '#eee2bc'); rect(c, screenX, bottom - size * .055, stride + 1, size * .055, '#978b69'); }
      for (let xx = screenX; xx < Math.min(W, screenX + stride); xx++) this.depth[xx] = distance;
    }
    const entities: { x: number; y: number; guard?: Guard; site?: Site; bomb?: boolean }[] = [
      ...this.guards.filter(g => g.hp > 0).map(guard => ({ x: guard.x, y: guard.y, guard })),
      ...this.sites.map(site => ({ x: site.x, y: site.y, site })),
      ...(this.bomb ? [{ x: this.bomb.x, y: this.bomb.y, bomb: true }] : []),
    ];
    entities.sort((a, b) => Math.hypot(b.x - this.x, b.y - this.y) - Math.hypot(a.x - this.x, a.y - this.y));
    for (const e of entities) {
      const dx = e.x - this.x, dy = e.y - this.y, forward = dx * Math.cos(this.angle) + dy * Math.sin(this.angle), side = dy * Math.cos(this.angle) - dx * Math.sin(this.angle);
      if (forward < .15) continue;
      const sx = W / 2 + side / forward * PROJECTION, scale = PROJECTION / forward, halfWidth = scale * (e.guard ? .3 : .28);
      if (sx + halfWidth < 0 || sx - halfWidth > W) continue;
      c.save(); c.beginPath();
      for (let xx = Math.max(0, Math.floor(sx - halfWidth)); xx < Math.min(W, sx + halfWidth); xx += 3) if (forward < this.depth[xx] + .02) c.rect(xx, 0, 3, H);
      c.clip();
      if (e.guard) this.drawGuard(c, e.guard, sx, horizon, scale, time);
      else if (e.bomb) {
        rect(c, sx - scale * .12, horizon + scale * .27, scale * .24, scale * .14, '#293c3e', scale * .02);
        circle(c, sx, horizon + scale * .3, Math.max(2, scale * .015), Math.sin(time * 10) > 0 ? '#ff725a' : '#9d3e39');
      } else if (e.site) {
        const yy = horizon + scale * .4; c.strokeStyle = '#f5d693'; c.lineWidth = Math.max(2, scale * .018); c.beginPath(); c.ellipse(sx, yy, scale * .28, scale * .07, 0, 0, Math.PI * 2); c.stroke();
        rect(c, sx - scale * .11, horizon - scale * .15, scale * .22, scale * .22, '#e8bb7080', 3); label(c, e.site.name, sx, horizon + scale * .015, Math.max(10, scale * .18), '#fff1c5', 'center');
      }
      c.restore();
    }
    this.drawWeapon(c, time); this.drawHUD(c, time);
    if (this.hurt > 0) { c.strokeStyle = `rgba(218,94,69,${this.hurt * 3})`; c.lineWidth = 18; c.strokeRect(9, 9, W - 18, H - 18); }
  }
  private drawGuard(c: CanvasRenderingContext2D, g: Guard, x: number, horizon: number, size: number, time: number): void {
    c.save(); c.translate(x, horizon + size * .5); c.scale(size / 100, size / 100);
    c.globalAlpha = .2; c.fillStyle = '#233334'; c.beginPath(); c.ellipse(0, 0, 23, 5, 0, 0, Math.PI * 2); c.fill(); c.globalAlpha = 1;
    const walk = g.path.length ? Math.sin(time * 7 + g.index) * 4 : 0;
    line(c, [[-10, -39], [-11 + walk, -15], [-15 + walk, -2]], '#294c59', 13); line(c, [[10, -39], [11 - walk, -15], [16 - walk, -2]], '#294c59', 13);
    rect(c, -19, -75, 38, 40, '#3b6976', 7); rect(c, -17, -69, 34, 29, '#294957', 3);
    for (const xx of [-10, 2]) rect(c, xx, -57, 8, 13, '#5d7a7b', 2);
    circle(c, 0, -84, 12, '#b3b5a0'); rect(c, -14, -99, 28, 12, '#244b5b', 7); rect(c, -12, -87, 24, 8, '#142f3c', 3);
    line(c, [[-18, -68], [-24, -54], [-2, -60]], '#406e79', 11); line(c, [[18, -68], [24, -52], [5, -51]], '#406e79', 11);
    rect(c, -6, -65, 29, 8, '#1e3036', 2); rect(c, 5, -58, 5, 13, '#1e3036', 2); line(c, [[-6, -60], [-21, -54]], '#25373b', 7);
    if (g.flash > 0) { c.fillStyle = '#fff0a0'; c.beginPath(); c.moveTo(28, -67); c.lineTo(49, -71); c.lineTo(36, -60); c.lineTo(48, -51); c.lineTo(27, -55); c.fill(); }
    if (g.alert > .4) { label(c, '!', 0, -111, 18, '#f3b18b', 'center'); }
    c.restore();
  }
  private drawWeapon(c: CanvasRenderingContext2D, time: number): void {
    if (this.hp <= 0) return;
    const bob = this.moving ? Math.sin(this.moveTime) * 5 : Math.sin(time * 1.7) * 1.3;
    const reload = this.reloading ? Math.sin(Math.PI * (1 - this.reloadTime / GUNS[this.reloading].reload)) * 120 : 0;
    c.save(); c.translate(W / 2 + 140 + bob, H + 25 + this.recoil * 6 + reload); c.rotate(this.recoil * -.006);
    // Gloves and forearms frame a deliberately original weapon silhouette.
    c.fillStyle = '#a89471'; c.beginPath(); c.moveTo(170, 0); c.lineTo(105, -137); c.lineTo(50, -119); c.lineTo(85, 0); c.fill();
    rect(c, 50, -153, 71, 56, '#3e5352', 13); line(c, [[54, -148], [87, -159], [117, -140]], '#62766b', 9);
    if (this.weapon === 'rifle') {
      c.fillStyle = '#253b40'; c.beginPath(); c.moveTo(-46, -16); c.lineTo(-66, -120); c.lineTo(-100, -216); c.lineTo(-69, -224); c.lineTo(-10, -119); c.lineTo(55, -15); c.fill();
      c.fillStyle = '#3d5156'; c.beginPath(); c.moveTo(-66, -120); c.lineTo(-93, -216); c.lineTo(-56, -222); c.lineTo(45, -114); c.lineTo(18, -88); c.fill();
      line(c, [[-82, -216], [-101, -258]], '#25373e', 13); line(c, [[-102, -258], [-107, -274]], '#172d36', 8);
      line(c, [[-52, -185], [27, -112]], '#70827e', 7); rect(c, -67, -201, 29, 12, '#152d36', 3);
      c.fillStyle = '#e0ae68'; c.beginPath(); c.moveTo(-61, -142); c.lineTo(-25, -164); c.lineTo(13, -121); c.lineTo(-9, -99); c.fill();
      for (let n = 0; n < 5; n++) line(c, [[-51 + n * 7, -142 + n * 7], [-29 + n * 7, -155 + n * 7]], '#a67f4e', 3);
      rect(c, -9, -113, 34, 58, '#253b40', 5); line(c, [[-7, -71], [26, -69]], '#657675', 3);
      rect(c, -65, -218, 8, 14, '#a8c9b8', 2);
    } else {
      c.fillStyle = '#334b50'; c.beginPath(); c.moveTo(-17, -110); c.lineTo(-63, -188); c.lineTo(-41, -203); c.lineTo(6, -150); c.lineTo(33, -122); c.fill();
      line(c, [[-58, -191], [-44, -201]], '#9aa8a0', 5); rect(c, -22, -132, 24, 55, '#293e43', 4);
    }
    rect(c, -30, -104, 45, 66, '#47615b', 12); line(c, [[-19, -88], [-10, -99], [1, -88]], '#6c8375', 7);
    if (this.flash > 0) { const x = this.weapon === 'rifle' ? -107 : -55, y = this.weapon === 'rifle' ? -283 : -201; c.fillStyle = '#ffe89a'; c.beginPath(); for (let n = 0; n < 10; n++) { const a = n * Math.PI / 5, r = n % 2 ? 9 : 28; const xx = x + Math.cos(a) * r, yy = y + Math.sin(a) * r; n ? c.lineTo(xx, yy) : c.moveTo(xx, yy); } c.closePath(); c.fill(); }
    c.restore();
  }
  private drawHUD(c: CanvasRenderingContext2D, time: number): void {
    const ink = '#142c35e8', gold = '#f0d599', pale = '#dfede4';
    rect(c, 363, 16, 234, 57, ink, 9); label(c, 'RAIDERS', 379, 33, 9, '#afccc0'); label(c, 'DEFENDERS', 581, 33, 9, '#afccc0', 'right');
    label(c, String(this.wins), 391, 58, 24, '#f4d287'); label(c, String(this.losses), 568, 58, 24, '#86bdd0', 'right');
    const timer = this.phase === 'buy' ? this.phaseTime : this.bomb ? this.bombTimer : this.timer;
    label(c, `${Math.floor(Math.ceil(Math.max(0, timer)) / 60)}:${String(Math.ceil(Math.max(0, timer)) % 60).padStart(2, '0')}`, 480, 48, 23, this.bomb ? '#ffb278' : pale, 'center');
    label(c, `ROUND ${this.round}  /  FIRST TO ${this.roundsToWin}`, 480, 65, 8, '#9ab4b3', 'center');
    this.drawRadar(c, 20, 20, 5.2);
    rect(c, 20, H - 58, 196, 40, ink, 7); label(c, '+', 33, H - 32, 22, '#a9d9bd'); label(c, String(this.hp).padStart(3, '0'), 57, H - 32, 22, pale); label(c, 'ARMOR', 125, H - 40, 8, '#93aaa6'); label(c, String(this.armor), 126, H - 25, 16, pale);
    const gun = GUNS[this.weapon]; rect(c, W - 228, H - 58, 208, 40, ink, 7); label(c, this.reloading ? 'RELOADING' : gun.name, W - 210, H - 42, 8, '#afc8bf'); label(c, String(this.ammo[this.weapon]), W - 210, H - 23, 23, pale); label(c, `/ ${this.reserve[this.weapon]}`, W - 166, H - 24, 13, '#9cb8ae'); label(c, `$${this.money}`, W - 34, H - 26, 13, gold, 'right');
    for (let n = 0; n < this.feed.length; n++) { const f = this.feed[n]; rect(c, W - 278, 91 + n * 26, 258, 22, ink, 4); label(c, f.text, W - 32, 106 + n * 26, 10, f.color, 'right'); }
    label(c, this.hp <= 0 ? 'SPECTATING OBJECTIVE' : 'OLD QUARTER', 24, 136, 10, gold);
    const alive = this.guards.filter(g => g.hp > 0).length; label(c, `${alive} DEFENDERS REMAIN`, 24, 152, 8, '#b4c8bf');
    const cross = this.hitMarker > 0 ? this.headMarker ? '#ffd173' : '#ffffff' : '#c9f0c4';
    if (this.hp > 0) {
      const gap = 6 + this.recoil * 4 + (this.moving ? 4 : 0);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) line(c, [[W / 2 + dx * gap, H / 2 + dy * gap], [W / 2 + dx * (gap + 7), H / 2 + dy * (gap + 7)]], '#17352b', 4);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) line(c, [[W / 2 + dx * gap, H / 2 + dy * gap], [W / 2 + dx * (gap + 7), H / 2 + dy * (gap + 7)]], cross, 2);
      circle(c, W / 2, H / 2, 1.2, cross);
      if (this.hitMarker > 0) { for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) line(c, [[480 + dx * 8, 270 + dy * 8], [480 + dx * 13, 270 + dy * 13]], cross, 2); }
    }
    if (this.phase === 'buy') {
      rect(c, 230, 178, 500, 156, '#142c35f0', 12); label(c, 'BREACH POINT', 480, 210, 29, gold, 'center'); label(c, 'BUY PHASE  /  YOUR NEXT MOVE MATTERS', 480, 235, 10, '#adc7bc', 'center');
      label(c, '1  Rifle · $1600     2  Sidearm · FREE     3  Armor · $600', 480, 262, 12, pale, 'center');
      label(c, 'ENTER to deploy   •   WASD move   •   Mouse aim / click fire', 480, 290, 11, '#b8ccc4', 'center');
      label(c, 'R reload   •   E plant   •   Arrow keys turn   •   Stop for accuracy', 480, 310, 10, '#91aba5', 'center');
    } else if (this.phase === 'result' || this.over) {
      rect(c, 270, 196, 420, 110, '#142c35ef', 12); label(c, this.roundMessage, 480, 240, 29, this.roundMessage.includes('COMPLETE') || this.roundMessage.includes('SECURED') ? '#b7dfbb' : gold, 'center'); label(c, `${this.wins} — ${this.losses}`, 480, 276, 23, pale, 'center');
    } else {
      const site = this.sites.find(s => Math.hypot(s.x - this.x, s.y - this.y) < 1.25);
      if (this.plantProgress > 0 || this.defuseProgress > 0) {
        const progress = this.plantProgress > 0 ? this.plantProgress / 3 : this.defuseProgress / 6;
        rect(c, 350, 361, 260, 42, ink, 7); label(c, this.plantProgress > 0 ? 'PLANTING DEVICE' : 'DEFENDER IS DEFUSING', 480, 377, 10, gold, 'center'); rect(c, 363, 389, 234, 4, '#4a615e', 2); rect(c, 363, 389, 234 * progress, 4, gold, 2);
      } else if (site && !this.bomb) { rect(c, 320, 370, 320, 31, ink, 7); label(c, `SITE ${site.name}  /  HOLD E OR PLANT TO ARM DEVICE`, 480, 390, 10, gold, 'center'); }
      if (this.bomb) { rect(c, 372, 80, 216, 28, ink, 6); circle(c, 387, 94, 3, Math.sin(time * 8) > 0 ? '#f1b07b' : '#864a35'); label(c, `SITE ${this.bomb.name}  /  DEFEND THE DEVICE`, 404, 98, 9, gold); }
      if (this.hp > 0 && this.round === 1 && this.timer > this.roundDuration - 9) { rect(c, 234, 450, 492, 25, '#142c35cf', 5); label(c, 'CLICK ARENA TO AIM  ·  WASD MOVE  ·  SPACE / CLICK FIRE  ·  R RELOAD', 480, 467, 9, '#d2dec9', 'center'); }
    }
  }
  private drawRadar(c: CanvasRenderingContext2D, ox: number, oy: number, tile: number): void {
    rect(c, ox - 7, oy - 7, ARENA_COLS * tile + 14, ARENA_ROWS * tile + 14, '#142c35e8', 8);
    this.map.forEach((row, y) => [...row].forEach((v, x) => { if (solid(v)) rect(c, ox + x * tile, oy + y * tile, tile - .5, tile - .5, v === '3' ? '#9e8355' : '#637e7d'); }));
    for (const site of this.sites) label(c, site.name, ox + site.x * tile, oy + site.y * tile + 3, 8, '#f4d48a', 'center');
    for (const g of this.guards) if (g.hp > 0 && g.alert > .2) circle(c, ox + g.x * tile, oy + g.y * tile, 2, '#f29a78');
    circle(c, ox + this.x * tile, oy + this.y * tile, 2.7, '#b5efbb'); line(c, [[ox + this.x * tile, oy + this.y * tile], [ox + (this.x + Math.cos(this.angle) * 1.3) * tile, oy + (this.y + Math.sin(this.angle) * 1.3) * tile]], '#b5efbb', 1.5);
    if (this.bomb) circle(c, ox + this.bomb.x * tile, oy + this.bomb.y * tile, 3, '#f7cf74');
  }
  drawBlueprint(c: CanvasRenderingContext2D): void {
    rect(c, 0, 0, W, H, '#203b43'); const { x: ox, y: oy, tile } = BLUEPRINT;
    this.map.forEach((row, y) => [...row].forEach((v, x) => {
      const color = v === '3' ? '#ae8954' : v === '2' ? '#638895' : solid(v) ? '#cfb27d' : '#526967';
      rect(c, ox + x * tile + 1, oy + y * tile + 1, tile - 2, tile - 2, color, 2);
      if (v === 'A' || v === 'B') { circle(c, ox + (x + .5) * tile, oy + (y + .5) * tile, 10, '#e8c580'); label(c, v, ox + (x + .5) * tile, oy + (y + .5) * tile + 4, 13, '#314343', 'center'); }
      if (v === 'P' || v === 'D') { circle(c, ox + (x + .5) * tile, oy + (y + .5) * tile, 7, v === 'P' ? '#b5edbc' : '#ee9e80'); label(c, v, ox + (x + .5) * tile, oy + (y + .5) * tile + 3, 8, '#203b43', 'center'); }
    }));
    label(c, 'OLD', 28, 225, 20, '#e8c580'); label(c, 'QUARTER', 28, 251, 16, '#e8c580'); label(c, 'TACTICAL MAP', 28, 281, 9, '#b5c6be');
    label(c, 'P  ENTRY', 830, 218, 10, '#b5edbc'); label(c, 'D  GUARD', 830, 247, 10, '#ee9e80'); label(c, 'A / B  SITES', 830, 276, 10, '#e8c580');
  }
}
