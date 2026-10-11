import { W, H, rect, circle, line, label, star, held, tapped, type Game, type Input } from './engine.ts';

export type KartTheme = 'coast' | 'alpine' | 'sunset';
type Item = 'boost' | 'pulse' | 'shield' | 'trap';
interface Segment { curve: number; height: number }
interface Rival { name: string; color: string; distance: number; lane: number; speed: number; stun: number; finishTime: number | null }
interface Pickup { segment: number; lane: number; kind: 'box' | 'coin' | 'pad' }
interface Trap { distance: number; lane: number; life: number }
interface Projection { x: number; y: number; w: number; scale: number; clip: number; index: number; z: number }
const SEGMENT = 200, ROAD = 1800, CAMERA = 1100, DEPTH = .9, VIEW = 170, MAX_SPEED = 5600;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const mod = (v: number, n: number): number => ((v % n) + n) % n;
const ITEM_NAMES: Record<Item, string> = { boost: 'TURBO', pulse: 'HOMING PULSE', shield: 'SHIELD', trap: 'SLIP POD' };
export const KART_THEMES: Record<KartTheme, { name: string; sky: string; haze: string; grass: string; grass2: string; road: string; road2: string; accent: string; mountain: string }> = {
  coast: { name: 'Azure Coast', sky: '#55bdf1', haze: '#d9f5ee', grass: '#5fc99b', grass2: '#55bd90', road: '#56637b', road2: '#5b6980', accent: '#ffcc60', mountain: '#67bfc4' },
  alpine: { name: 'Cloudpeak Pass', sky: '#8cb9ee', haze: '#ecf3ff', grass: '#deebfa', grass2: '#d0e1f3', road: '#59687d', road2: '#637187', accent: '#7fe6ff', mountain: '#94adc9' },
  sunset: { name: 'Starlight Circuit', sky: '#4b367b', haze: '#ffbca8', grass: '#9e6795', grass2: '#935c8c', road: '#4c4268', road2: '#544971', accent: '#ffd176', mountain: '#8c689d' },
};

/** A self-contained, perspective-projected kart racer with original procedural art. */
export class KartGame implements Game {
  score = 0; info = 'THREE LAPS · SIX RACERS'; over = false; won = false;
  theme: KartTheme; laps: number; segments: Segment[] = []; pickups: Pickup[] = [];
  distance = 0; lane = 0; speed = 0; countdown = 3; elapsed = 0; clock = 0;
  boost = 0; shield = 0; stun = 0; immunity = 0; driftCharge = 0; drifting = false; steer = 0; coins = 0;
  item: Item | null = null; itemSerial = 0; message = ''; messageTime = 0; finishPosition = 0;
  collected = new Set<string>(); traps: Trap[] = []; soundEvents: ('count' | 'go' | 'pickup' | 'boost' | 'hit' | 'finish')[] = [];
  rivals: Rival[] = ['PIP', 'NOVA', 'MILO', 'ZIGGY', 'LUNA'].map((name, n) => ({ name, color: ['#ff809b', '#a998ff', '#ffd66a', '#72e5ba', '#79cfff'][n], distance: 420 + n * 390, lane: [-.62, .28, -.12, .65, -.45][n], speed: 4540 + n * 115, stun: 0, finishTime: null }));
  constructor(theme: KartTheme = 'coast', laps = 3) {
    this.theme = theme; this.laps = clamp(Math.round(laps), 1, 5);
    // Curvature eases in/out; the course and its elevation join continuously at the finish.
    const bends = theme === 'alpine' ? [0, .75, -.95, .45, 1.05, -.75, 0, -.65] : theme === 'sunset' ? [0, -.7, .95, -.55, .8, -.95, .4, 0] : [0, .6, -.8, 0, .95, -.55, -.8, .3];
    for (let n = 0; n < 640; n++) {
      const section = Math.floor(n / 80), t = n % 80 / 80;
      const envelope = Math.sin(Math.PI * t) ** 2;
      this.segments.push({ curve: bends[section] * envelope, height: Math.sin(n / 640 * Math.PI * 4) * (theme === 'alpine' ? 1500 : 650) + Math.sin(n / 640 * Math.PI * 8) * 180 });
      if (n % 80 === 36) for (const lane of [-.65, 0, .65]) this.pickups.push({ segment: n, lane, kind: 'box' });
      if (n % 80 >= 52 && n % 80 <= 64 && n % 3 === 0) this.pickups.push({ segment: n, lane: Math.sign(bends[section] || 1) * .45, kind: 'coin' });
      if (n % 160 === 108) this.pickups.push({ segment: n, lane: section % 2 ? -.5 : .5, kind: 'pad' });
    }
  }
  get length(): number { return this.segments.length * SEGMENT; }
  get lap(): number { return Math.min(this.laps, Math.floor(this.distance / this.length) + 1); }
  get position(): number { return this.over ? this.finishPosition : 1 + this.rivals.filter(r => r.distance > this.distance).length; }
  segmentAt(distance: number): Segment { return this.segments[Math.floor(mod(distance, this.length) / SEGMENT)]; }
  heightAt(distance: number): number {
    const index = Math.floor(mod(distance, this.length) / SEGMENT), t = mod(distance, SEGMENT) / SEGMENT;
    return this.segments[index].height + (this.segments[(index + 1) % this.segments.length].height - this.segments[index].height) * t;
  }
  announce(message: string): void { this.message = message; this.messageTime = 1.7; }
  hit(): void {
    if (this.immunity > 0 || this.shield > 0) return;
    this.stun = .85; this.immunity = 2; this.speed *= .45; this.coins = Math.max(0, this.coins - 2); this.driftCharge = 0;
    this.announce('WATCH THE ROAD!'); this.soundEvents.push('hit');
  }
  useItem(): void {
    if (!this.item) return;
    const item = this.item; this.item = null;
    if (item === 'boost') { this.boost = 2.2; this.announce('TURBO TIME!'); this.soundEvents.push('boost'); }
    if (item === 'shield') { this.shield = 6; this.announce('SHIELD UP!'); this.soundEvents.push('pickup'); }
    if (item === 'trap') { this.traps.push({ distance: this.distance - 450, lane: this.lane, life: 18 }); this.announce('SLIP POD DEPLOYED'); }
    if (item === 'pulse') {
      const target = this.rivals.filter(r => r.distance > this.distance && r.finishTime === null).sort((a, b) => a.distance - b.distance)[0];
      if (target) { target.stun = 2.5; this.score += 150; this.announce(`${target.name} HIT!`); }
      else { this.boost = 1.2; this.announce('CLEAR ROAD · BONUS TURBO!'); }
      this.soundEvents.push('boost');
    }
  }
  update(dt: number, input: Input): void {
    if (this.over || !Number.isFinite(dt) || dt <= 0) return;
    dt = Math.min(dt, .1); this.clock += dt;
    if (this.countdown > 0) {
      const previous = Math.ceil(this.countdown); this.countdown = Math.max(0, this.countdown - dt);
      if (Math.ceil(this.countdown) !== previous) this.soundEvents.push(this.countdown === 0 ? 'go' : 'count');
      if (!this.countdown) this.announce('GO!');
      return;
    }
    this.elapsed += dt;
    for (const key of ['boost', 'shield', 'stun', 'immunity', 'messageTime'] as const) this[key] = Math.max(0, this[key] - dt);
    this.traps = this.traps.filter(t => (t.life -= dt) > 0);
    const turn = Number(held(input, 'ArrowRight', 'KeyD')) - Number(held(input, 'ArrowLeft', 'KeyA'));
    const gas = held(input, 'ArrowUp', 'KeyW'), brake = held(input, 'ArrowDown', 'KeyS');
    this.steer += (turn - this.steer) * Math.min(1, dt * 10);
    const wasDrifting = this.drifting;
    this.drifting = held(input, 'ShiftLeft', 'ShiftRight') && turn !== 0 && this.speed > MAX_SPEED * .35 && this.stun === 0 && Math.abs(this.lane) < 1;
    if (this.drifting) this.driftCharge = Math.min(2.2, this.driftCharge + dt);
    else if (wasDrifting) {
      if (this.driftCharge > .55) { this.boost = Math.max(this.boost, this.driftCharge > 1.4 ? 1.9 : 1); this.score += this.driftCharge > 1.4 ? 100 : 50; this.announce(this.driftCharge > 1.4 ? 'SUPER DRIFT!' : 'DRIFT BOOST!'); this.soundEvents.push('boost'); }
      this.driftCharge = 0;
    }
    if (tapped(input, 'Space', 'KeyE')) this.useItem();
    const offroad = Math.abs(this.lane) > 1;
    const targetSpeed = this.stun > 0 ? 1600 : offroad ? 2500 : this.boost > 0 ? 8100 : MAX_SPEED + this.coins * 45;
    const acceleration = brake ? -10500 : gas || this.boost > 0 ? 4400 : -2800;
    this.speed = clamp(this.speed + acceleration * dt, 0, targetSpeed);
    const ratio = this.speed / MAX_SPEED, curve = this.segmentAt(this.distance).curve;
    this.lane = clamp(this.lane + this.steer * dt * (this.drifting ? 1.32 : 1.05) * Math.min(1.2, ratio) - curve * ratio * ratio * .48 * dt, -1.65, 1.65);
    const oldDistance = this.distance;
    this.distance += this.speed * dt;
    for (const rival of this.rivals) {
      if (rival.finishTime !== null) continue;
      rival.stun = Math.max(0, rival.stun - dt);
      rival.lane += (Math.sin(this.elapsed * .4 + rival.speed) * .65 - rival.lane) * dt * .7;
      const rubber = clamp((this.distance - rival.distance) / this.length, -.12, .1);
      rival.distance += rival.speed * (1 + rubber) * (rival.stun > 0 ? .36 : 1) * dt;
      if (rival.distance >= this.length * this.laps) rival.finishTime = this.elapsed;
      if (Math.abs(rival.distance - this.distance) < 240 && Math.abs(rival.lane - this.lane) < .2) {
        if (this.shield > 0 || this.boost > 0) { rival.stun = 1; this.score += this.immunity <= 0 ? 50 : 0; this.immunity = .6; }
        else this.hit();
      }
      for (const trap of this.traps) if (trap.life > 0 && Math.abs(rival.distance - trap.distance) < 300 && Math.abs(rival.lane - trap.lane) < .24) { rival.stun = 2; trap.life = 0; this.score += 100; }
    }
    // Sweep across pickup planes so boost speed cannot skip a pickup between frames.
    for (const pickup of this.pickups) {
      const cycle = Math.floor(oldDistance / this.length);
      for (const lap of [cycle, cycle + 1]) {
        const distance = lap * this.length + pickup.segment * SEGMENT, key = `${lap}:${pickup.segment}:${pickup.lane}`;
        if (distance <= oldDistance || distance > this.distance || Math.abs(this.lane - pickup.lane) > (pickup.kind === 'pad' ? .32 : .25) || this.collected.has(key)) continue;
        this.collected.add(key);
        if (pickup.kind === 'coin') { this.coins = Math.min(10, this.coins + 1); this.score += 25; this.soundEvents.push('pickup'); }
        if (pickup.kind === 'pad') { this.boost = Math.max(this.boost, 1.4); this.announce('BOOST STRIP!'); this.soundEvents.push('boost'); }
        if (pickup.kind === 'box' && this.item === null) {
          const items: Item[] = this.position > 3 ? ['boost', 'pulse', 'shield', 'boost'] : ['shield', 'trap', 'boost', 'pulse'];
          this.item = items[this.itemSerial++ % items.length]; this.score += 50; this.announce(`${ITEM_NAMES[this.item]} · SPACE TO USE`); this.soundEvents.push('pickup');
        }
      }
    }
    if (Math.floor(oldDistance / this.length) < Math.floor(this.distance / this.length) && this.distance < this.length * this.laps) { this.score += 300; this.announce(this.lap === this.laps ? 'FINAL LAP!' : `LAP ${this.lap}`); }
    if (this.distance >= this.length * this.laps) {
      this.finishPosition = 1 + this.rivals.filter(r => r.finishTime !== null && r.finishTime <= this.elapsed).length;
      this.over = true; this.won = this.finishPosition === 1;
      this.score += (7 - this.finishPosition) * 500 + this.coins * 50;
      this.info = `${ordinal(this.finishPosition)} place · ${formatTime(this.elapsed)} · ${this.won ? 'You took the cup!' : 'Race again for the cup!'}`;
      this.soundEvents.push('finish');
    } else this.info = `${ordinal(this.position)} / 6 · LAP ${this.lap}/${this.laps} · ${formatTime(this.elapsed)}`;
    // Keep event memory bounded when running without the arcade's audio consumer.
    if (this.soundEvents.length > 32) this.soundEvents.splice(0, this.soundEvents.length - 32);
  }

  draw(c: CanvasRenderingContext2D, time: number): void {
    const palette = KART_THEMES[this.theme], horizon = 218;
    const sky = c.createLinearGradient(0, 0, 0, horizon + 90); sky.addColorStop(0, palette.sky); sky.addColorStop(1, palette.haze);
    c.fillStyle = sky; c.fillRect(0, 0, W, H);
    const parallax = Math.sin(this.distance / this.length * Math.PI * 2) * 130;
    c.save(); c.globalAlpha = .2; circle(c, 720 - parallax * .2, 102, 73, '#fff4ca'); c.globalAlpha = 1; circle(c, 720 - parallax * .2, 102, 42, '#fff2cb'); c.restore();
    if (this.theme === 'sunset') for (let n = 0; n < 35; n++) circle(c, mod(n * 137, W), mod(n * 73, 175), n % 3 ? 1 : 2, '#ffe7e7');
    for (let n = -1; n < 7; n++) {
      const x = n * 210 - parallax * .25, y = 62 + mod(n * 47, 92);
      c.save(); c.globalAlpha = .55; ellipse(c, x, y, 42, 11, '#fff'); ellipse(c, x + 26, y - 7, 29, 17, '#fff'); ellipse(c, x + 54, y, 35, 10, '#fff'); c.restore();
    }
    for (let layer = 0; layer < 2; layer++) {
      const points: number[][] = [[0, 310]];
      for (let x = -80; x <= W + 80; x += 80) points.push([x, horizon + layer * 28 - Math.sin((x + parallax * (layer + 1)) / 200) * 32 - Math.abs(Math.sin((x + parallax) / 140)) * (layer ? 35 : 90)]);
      points.push([W, 310]); polygon(c, points, layer ? palette.mountain : `${palette.mountain}99`);
    }
    c.fillStyle = palette.grass; c.fillRect(0, horizon + 48, W, H);
    if (this.theme === 'coast') { const ocean = c.createLinearGradient(0, horizon, 0, H); ocean.addColorStop(0, '#62d5df'); ocean.addColorStop(1, '#279fbd'); c.fillStyle = ocean; c.fillRect(0, horizon + 30, W, H); }
    const base = Math.floor(this.distance / SEGMENT), fraction = mod(this.distance, SEGMENT) / SEGMENT;
    const cameraY = CAMERA + this.heightAt(this.distance);
    let worldX = 0, curveDelta = -this.segmentAt(this.distance).curve * fraction, clip = H;
    const projected: Projection[] = [];
    for (let n = 0; n < VIEW; n++) {
      const index = mod(base + n, this.segments.length), segment = this.segments[index], z = (n - fraction) * SEGMENT + 650;
      const scale = DEPTH / z;
      const p: Projection = { x: W / 2 + scale * (worldX - this.lane * ROAD) * W / 2, y: horizon - scale * (segment.height - cameraY) * H / 2, w: scale * ROAD * W / 2, scale, clip, index, z };
      worldX += curveDelta * 8; curveDelta += segment.curve;
      projected.push(p);
      if (n === 0 || p.y >= clip || p.y < 0) continue;
      const prev = projected[n - 1], alternate = Math.floor(index / 3) % 2 === 0;
      // Each horizontal band is painted front to back with hill clipping.
      rect(c, 0, p.y, W, clip - p.y + 1, alternate ? palette.grass : palette.grass2);
      quad(c, prev, p, 1.26, alternate ? '#e8dcbb' : '#f8efd6');
      quad(c, prev, p, 1.1, alternate ? '#fff5ec' : this.theme === 'sunset' ? '#ff88c7' : '#ef7d86');
      quad(c, prev, p, 1, alternate ? palette.road : palette.road2);
      if (alternate) for (const lane of [-1 / 3, 1 / 3]) polygon(c, [[prev.x + prev.w * (lane - .007), prev.y], [prev.x + prev.w * (lane + .007), prev.y], [p.x + p.w * (lane + .007), p.y], [p.x + p.w * (lane - .007), p.y]], '#e5edf18c');
      if (index < 3) for (let tile = 0; tile < 12; tile++) polygon(c, [[prev.x - prev.w + prev.w * tile / 6, prev.y], [prev.x - prev.w + prev.w * (tile + 1) / 6, prev.y], [p.x - p.w + p.w * (tile + 1) / 6, p.y], [p.x - p.w + p.w * tile / 6, p.y]], (tile + index) % 2 ? '#f5f8ff' : '#243347');
      // Distant geometry blends gently into the sky rather than popping in.
      c.save(); c.globalAlpha = (n / VIEW) ** 3 * .62; rect(c, 0, p.y, W, clip - p.y, palette.haze); c.restore();
      clip = p.y;
    }
    // Scenery and racers share depth order and are clipped by intervening hills.
    for (let n = projected.length - 1; n >= 1; n--) {
      const p = projected[n]; if (p.y >= p.clip || p.y > H + 200) continue;
      c.save(); c.beginPath(); c.rect(0, 0, W, Math.max(0, p.clip)); c.clip();
      const s = p.scale * W / 2;
      if (p.index % 12 === 0) {
        for (const side of [-1, 1]) this.drawScenery(c, p.x + p.w * side * (1.65 + (p.index % 3) * .3), p.y, s, p.index + (side > 0 ? 7 : 0));
      }
      if (p.index % 80 === 18) this.drawSign(c, p.x + p.w * 1.38, p.y, s, this.segments[mod(p.index + 24, this.segments.length)].curve < 0 ? '‹‹‹' : '›››');
      if (p.index === 8) this.drawGate(c, p.x, p.y, s);
      for (const pickup of this.pickups) {
        if (pickup.segment !== p.index) continue;
        const cycle = Math.floor((this.distance + n * SEGMENT) / this.length), key = `${cycle}:${pickup.segment}:${pickup.lane}`;
        if (!this.collected.has(key)) this.drawPickup(c, p.x + p.w * pickup.lane, p.y, s, pickup.kind, time);
      }
      for (const rival of this.rivals) {
        const ahead = mod(rival.distance - this.distance, this.length);
        if (ahead < 150 || ahead > VIEW * SEGMENT || Math.floor((ahead + mod(this.distance, SEGMENT)) / SEGMENT) !== n) continue;
        drawKart(c, p.x + p.w * rival.lane, p.y, s * 3.1, rival.color, Math.sin(time * 3 + rival.speed) * .05, rival.stun > 0 ? time * 12 : 0, false);
        if (s > .025) label(c, rival.name, p.x + p.w * rival.lane, p.y - 380 * s, Math.max(9, 105 * s), '#fff', 'center');
      }
      for (const trap of this.traps) {
        const ahead = mod(trap.distance - this.distance, this.length);
        if (Math.floor((ahead + mod(this.distance, SEGMENT)) / SEGMENT) === n) this.drawPickup(c, p.x + p.w * trap.lane, p.y, s, 'trap', time);
      }
      c.restore();
    }
    const bounce = Math.sin(time * (this.speed > 0 ? 28 : 3)) * (this.speed > 0 ? 1.5 : .5);
    const kartX = W / 2 + this.steer * 18, kartY = 467 + bounce;
    if (this.boost > 0) {
      for (const x of [-30, 30]) { ellipse(c, kartX + x, kartY + 7, 12, 33 + Math.sin(time * 40) * 10, '#ffb951'); ellipse(c, kartX + x, kartY + 4, 6, 21, '#fff5bf'); }
      c.save(); c.globalAlpha = .38;
      for (let n = 0; n < 22; n++) { const a = n * Math.PI * 2 / 22, radius = 250 + mod(time * 450 + n * 83, 190); line(c, [[480 + Math.cos(a) * radius, 280 + Math.sin(a) * radius * .6], [480 + Math.cos(a) * (radius + 65), 280 + Math.sin(a) * (radius + 65) * .6]], '#fff', 2); } c.restore();
    }
    if (Math.abs(this.lane) > 1 && this.speed > 500) for (let n = 0; n < 8; n++) { const age = mod(time * 6 + n / 8, 1); ellipse(c, kartX + (n % 2 ? -50 : 50) + age * this.steer * 25, kartY + age * 40, 4 + age * 14, 3 + age * 9, '#ddcfaaa0'); }
    drawKart(c, kartX, kartY, .8, '#ff655e', this.steer * (this.drifting ? -.22 : -.06), this.stun > 0 ? this.clock * 14 : 0, true);
    if (this.drifting) for (const side of [-1, 1]) for (let n = 0; n < 8; n++) { const age = mod(time * 9 + n / 8, 1); star(c, kartX + side * (50 + age * 32), kartY + age * 36 - 12, 2 + age * 4, this.driftCharge > 1.4 ? '#ffb450' : '#7defff'); }
    if (this.shield > 0) { c.save(); c.strokeStyle = '#97faff'; c.lineWidth = 3; c.shadowColor = '#7af6ff'; c.shadowBlur = 18; c.beginPath(); c.ellipse(kartX, kartY - 36, 78, 70, 0, 0, Math.PI * 2); c.stroke(); c.restore(); }
    this.drawHud(c);
    if (this.clock > 0 && this.countdown > 0) {
      rect(c, 387, 160, 186, 148, '#192a4ad9', 28); label(c, String(Math.ceil(this.countdown)), 480, 269, 98, '#fff5cb', 'center');
    } else if (this.messageTime > 0) {
      const width = Math.min(650, this.message.length * 13 + 50); rect(c, 480 - width / 2, 133, width, 43, '#172943d9', 14); label(c, this.message, 480, 161, 20, '#fff4cc', 'center');
    }
  }

  drawHud(c: CanvasRenderingContext2D): void {
    const accent = KART_THEMES[this.theme].accent;
    panel(c, 22, 20, 142, 94); label(c, ordinal(this.position).toUpperCase(), 41, 71, 43, accent); label(c, 'POSITION / 6', 43, 96, 11, '#b9cede');
    panel(c, 179, 20, 240, 68); label(c, KART_THEMES[this.theme].name.toUpperCase(), 195, 45, 13, '#fff'); label(c, `LAP ${this.lap} / ${this.laps}`, 195, 72, 20, accent); label(c, formatTime(this.elapsed), 401, 72, 16, '#e4efff', 'right');
    panel(c, 839, 20, 99, 102); this.drawItemIcon(c, 889, 65, this.item, 1); label(c, this.item ? 'SPACE / E' : 'ITEM BOX', 889, 105, 11, '#bed2e3', 'center');
    panel(c, 23, 463, 196, 56); label(c, String(Math.round(this.speed / MAX_SPEED * 160)).padStart(3, '0'), 39, 501, 32, '#fff'); label(c, 'km/h', 103, 501, 12, '#b8cfdd'); circle(c, 164, 490, 10, '#ffd362'); label(c, `${this.coins}/10`, 181, 496, 13, '#ffe6a3');
    if (this.driftCharge > 0) { rect(c, 355, 502, 250, 8, '#193b58', 4); rect(c, 355, 502, 250 * this.driftCharge / 2.2, 8, this.driftCharge > 1.4 ? '#ffb450' : '#7defff', 4); label(c, 'RELEASE SHIFT TO BOOST', 480, 491, 11, '#fff', 'center'); }
    else label(c, '↑ GAS   ← → STEER   SHIFT DRIFT   SPACE ITEM', 480, 519, 11, '#fff', 'center');
    this.drawMinimap(c);
  }
  drawMinimap(c: CanvasRenderingContext2D): void {
    panel(c, 804, 344, 134, 175); label(c, 'CIRCUIT', 871, 366, 10, '#b9cede', 'center');
    const point = (distance: number): number[] => {
      const a = mod(distance, this.length) / this.length * Math.PI * 2 - Math.PI / 2;
      return [871 + Math.cos(a) * (39 + 7 * Math.sin(a * 3)), 440 + Math.sin(a) * 53];
    };
    const path = Array.from({ length: 81 }, (_, n) => point(n / 80 * this.length)); line(c, path, '#a1bacd', 9); line(c, path, '#466077', 5);
    rect(c, 866, 382, 10, 7, '#fff', 1);
    for (const rival of this.rivals) { const [x, y] = point(rival.distance); circle(c, x, y, 3.6, rival.color); }
    const [x, y] = point(this.distance); circle(c, x, y, 6, '#fff'); circle(c, x, y, 4, '#ff655e');
  }
  drawItemIcon(c: CanvasRenderingContext2D, x: number, y: number, item: Item | null, s: number): void {
    c.save(); c.translate(x, y); c.scale(s, s);
    if (item === 'boost') { polygon(c, [[5, -24], [-17, 4], [-2, 4], [-7, 25], [19, -7], [4, -7]], '#ffd36a'); }
    else if (item === 'shield') { polygon(c, [[0, -24], [22, -14], [17, 13], [0, 27], [-17, 13], [-22, -14]], '#78e5f3'); line(c, [[-10, 0], [-2, 9], [12, -9]], '#efffff', 5); }
    else if (item === 'pulse') { circle(c, 0, 0, 20, '#b5a2ff'); circle(c, 0, 0, 12, '#f2eaff'); circle(c, 0, 0, 5, '#8b70f2'); for (const side of [-1, 1]) line(c, [[side * 23, -11], [side * 30, 0], [side * 23, 11]], '#cbbcff', 3); }
    else if (item === 'trap') { ellipse(c, 0, 8, 23, 13, '#ffae83'); circle(c, 0, -4, 14, '#ffdb8a'); circle(c, -5, -7, 3, '#fff4d5'); }
    else { rect(c, -22, -22, 44, 44, '#344c66', 10); label(c, '?', 0, 12, 32, '#94acc3', 'center'); }
    c.restore();
  }
  drawPickup(c: CanvasRenderingContext2D, x: number, y: number, s: number, kind: Pickup['kind'] | 'trap', time: number): void {
    if (kind === 'pad') {
      c.save(); c.translate(x, y); c.scale(s, s); polygon(c, [[-440, 0], [440, 0], [320, -85], [-320, -85]], '#48efd5');
      for (let n = 0; n < 3; n++) line(c, [[-180 + n * 160, -10], [-140 + n * 160, -37], [-180 + n * 160, -65]], '#eaffde', 18); c.restore(); return;
    }
    c.save(); c.translate(x, y); c.scale(s, s); ellipse(c, 0, -4, 110, 22, '#172d4533');
    if (kind === 'coin') { c.translate(0, -155 + Math.sin(time * 5) * 22); c.scale(.55 + Math.abs(Math.sin(time * 3)) * .45, 1); circle(c, 0, 0, 65, '#d59636'); circle(c, 0, -3, 54, '#ffe27b'); star(c, 0, -3, 28, '#e5ae42'); }
    else if (kind === 'trap') { this.drawItemIcon(c, 0, -40, 'trap', 5); }
    else {
      c.translate(0, -150 + Math.sin(time * 3 + x) * 20); c.rotate(Math.sin(time * 2) * .16);
      polygon(c, [[-85, -70], [25, -100], [90, -55], [-20, -25]], '#d9d0ff'); polygon(c, [[-85, -70], [-20, -25], [-20, 92], [-85, 45]], '#6c80e8'); polygon(c, [[-20, -25], [90, -55], [90, 63], [-20, 92]], '#a1b7ff');
      line(c, [[-85, -70], [25, -100], [90, -55], [90, 63], [-20, 92], [-85, 45], [-85, -70]], '#e6ffff', 5); label(c, '?', 33, 49, 105, '#fff', 'center');
    }
    c.restore();
  }
  drawScenery(c: CanvasRenderingContext2D, x: number, y: number, s: number, seed: number): void {
    c.save(); c.translate(x, y); c.scale(s, s);
    if (this.theme === 'coast' && seed % 3 !== 0) {
      line(c, [[0, 0], [20, -210], [-30, -470]], '#a98260', 28);
      for (let n = 0; n < 6; n++) { const a = n * Math.PI / 3; c.strokeStyle = n % 2 ? '#268e78' : '#43b88d'; c.lineWidth = 40; c.beginPath(); c.moveTo(-30, -470); c.quadraticCurveTo(-30 + Math.cos(a) * 150, -500 + Math.sin(a) * 40, -30 + Math.cos(a) * 240, -385 + Math.sin(a) * 85); c.stroke(); }
      circle(c, -36, -441, 22, '#bf925e'); circle(c, -6, -450, 20, '#e0af70');
    } else if (this.theme === 'alpine') {
      rect(c, -17, -280, 34, 280, '#6f7992');
      for (let n = 0; n < 3; n++) { const y = -260 - n * 110, w = 145 - n * 32; polygon(c, [[-w, y + 125], [0, y - 100], [w, y + 125]], n % 2 ? '#4b8d91' : '#3c767e'); polygon(c, [[-w * .62, y + 35], [0, y - 100], [w * .62, y + 35], [35, y + 13], [0, y + 40], [-45, y + 14]], '#f5fbff'); }
    } else {
      line(c, [[0, 0], [0, -310]], '#706580', 27); circle(c, -85, -340, 105, this.theme === 'sunset' ? '#f8a7bd' : '#30a884'); circle(c, 74, -340, 114, this.theme === 'sunset' ? '#ef8baf' : '#4ebf91'); circle(c, 0, -425, 120, this.theme === 'sunset' ? '#ffc4c3' : '#76d3a0');
      circle(c, -37, -465, 45, this.theme === 'sunset' ? '#ffdad1' : '#a1e3aa');
    }
    if (seed % 4 === 0) { ellipse(c, 200, -420, 48, 62, '#ff8c99'); line(c, [[200, -358], [200, -275]], '#fff1d1', 3); rect(c, 181, -275, 38, 26, '#ba825c', 5); }
    c.restore();
  }
  drawSign(c: CanvasRenderingContext2D, x: number, y: number, s: number, text: string): void {
    c.save(); c.translate(x, y); c.scale(s, s); line(c, [[0, 0], [0, -330]], '#d5e8e9', 14); rect(c, -135, -420, 270, 135, '#263b56', 20); label(c, text, 0, -322, 114, KART_THEMES[this.theme].accent, 'center'); c.restore();
  }
  drawGate(c: CanvasRenderingContext2D, x: number, y: number, s: number): void {
    c.save(); c.translate(x, y); c.scale(s, s); line(c, [[-ROAD * 1.13, 0], [-ROAD * 1.13, -1050], [ROAD * 1.13, -1050], [ROAD * 1.13, 0]], '#eef9ff', 70);
    rect(c, -ROAD * 1.13, -1050, ROAD * 2.26, 230, '#233b57', 30); label(c, 'POCKET KART  /  GRAND PRIX', 0, -893, 155, '#fff2c9', 'center');
    for (let n = 0; n < 20; n++) rect(c, -ROAD * 1.1 + n * ROAD * .11, -1090, ROAD * .11, 40, n % 2 ? '#233b57' : '#fff'); c.restore();
  }
}

function ordinal(n: number): string { return `${n}${n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'}`; }
function formatTime(seconds: number): string { return `${Math.floor(seconds / 60)}:${(seconds % 60).toFixed(2).padStart(5, '0')}`; }
function ellipse(c: CanvasRenderingContext2D, x: number, y: number, rx: number, ry: number, color: string): void { c.fillStyle = color; c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2); c.fill(); }
function polygon(c: CanvasRenderingContext2D, points: number[][], color: string | CanvasGradient): void { c.fillStyle = color; c.beginPath(); points.forEach(([x, y], n) => n ? c.lineTo(x, y) : c.moveTo(x, y)); c.closePath(); c.fill(); }
function quad(c: CanvasRenderingContext2D, a: Projection, b: Projection, width: number, color: string): void { polygon(c, [[a.x - a.w * width, a.y + 1], [a.x + a.w * width, a.y + 1], [b.x + b.w * width, b.y - .5], [b.x - b.w * width, b.y - .5]], color); }
function panel(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void { rect(c, x, y + 3, w, h, '#13213b22', 16); rect(c, x, y, w, h, '#192e49e8', 16); rect(c, x + 12, y, w - 24, 2, '#ffffff35', 1); }
function drawKart(c: CanvasRenderingContext2D, x: number, y: number, s: number, color: string, steer: number, spin: number, player: boolean): void {
  c.save(); c.translate(x, y); c.scale(s, s); ellipse(c, 0, 8, 89, 19, '#10233455'); c.rotate(steer + Math.sin(spin) * (spin ? .3 : 0));
  // Layered tires, axle, body panels, seat, helmet, spoiler, and lit exhausts.
  for (const side of [-1, 1]) {
    rect(c, side * 65 - 17, -65, 32, 38, '#1b2538', 9); rect(c, side * 65 - 13, -65, 9, 34, '#45546b', 4);
    rect(c, side * 78 - 21, -25, 42, 44, '#182134', 11); rect(c, side * 78 - 16, -23, 10, 37, '#43546a', 4);
    for (let n = 0; n < 3; n++) line(c, [[side * 78 - 17, -15 + n * 9], [side * 78 + 17, -15 + n * 9]], '#2c3c53', 2);
  }
  rect(c, -83, -13, 166, 9, '#99acbb', 4);
  polygon(c, [[-54, -88], [54, -88], [74, -4], [60, 13], [-60, 13], [-74, -4]], '#9f3546');
  const paint = c.createLinearGradient(0, -85, 0, 12); paint.addColorStop(0, '#fff3cf'); paint.addColorStop(.13, color); paint.addColorStop(1, color); polygon(c, [[-51, -85], [51, -85], [68, -10], [53, 5], [-53, 5], [-68, -10]], paint);
  line(c, [[-43, -73], [-55, -15]], '#ffffff6b', 4); line(c, [[43, -73], [55, -15]], '#ffffff6b', 4);
  rect(c, -31, -91, 62, 65, '#263750', 17); rect(c, -25, -80, 50, 35, '#41546d', 10);
  // The original driver wears a cream racing suit and a coral helmet.
  rect(c, -29, -91, 58, 31, '#fff3dd', 11); line(c, [[-25, -88], [-44, -63]], '#fff3dd', 15); line(c, [[25, -88], [44, -63]], '#fff3dd', 15);
  circle(c, 0, -117, 34, '#953d51'); circle(c, 0, -123, 33, player ? '#ff8273' : color); ellipse(c, -9, -136, 15, 9, '#ffffff65'); rect(c, -7, -154, 14, 52, '#fff3d6', 5);
  rect(c, -49, -28, 98, 38, color, 11); rect(c, -26, -20, 52, 18, '#273951', 5);
  for (const side of [-1, 1]) { rect(c, side * 40 - 10, -19, 20, 9, '#fff1b6', 4); circle(c, side * 29, 9, 10, '#26354b'); circle(c, side * 29, 9, 6, '#b2c4d0'); }
  line(c, [[-52, -43], [-57, -69]], '#bacdd6', 6); line(c, [[52, -43], [57, -69]], '#bacdd6', 6); rect(c, -73, -77, 146, 13, '#233c56', 5); rect(c, -71, -80, 142, 7, '#ffeed4', 3);
  c.restore();
}
