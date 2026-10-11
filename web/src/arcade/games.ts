import { ShooterGame } from './shooter.ts';
import type { ArcadeLevel } from './levels.ts';
import { W, H, rect, circle, line, label, gradient, star, cloud, held, tapped, Particles, type Game, type Input, type GameId } from './engine.ts';

interface Fighter { x: number; y: number; vy: number; hp: number; color: string; facing: number; attack: number; cooldown: number; hurt: number; block: boolean; round: number; kick: boolean }
export class FighterGame implements Game {
  score = 0; info = 'ROUND 1 · FIRST TO 2'; over = false; won = false; timer = 60; roundPause = 0; roundMessage = ''; particles = new Particles();
  players: Fighter[] = [this.player(280, '#a7e8f5', 1), this.player(680, '#ff8278', -1)];
  starts = [280, 680]; roundDuration = 60; roundsToWin = 2;
  constructor(public twoPlayer = false) {}
  player(x: number, color: string, facing: number): Fighter { return { x, y: 416, vy: 0, hp: 100, color, facing, attack: 0, cooldown: 0, hurt: 0, block: false, round: 0, kick: false }; }
  update(dt: number, i: Input): void {
    if (this.over) return; this.particles.update(dt);
    if (this.roundPause > 0) { this.roundPause -= dt; if (this.roundPause <= 0) { this.players.forEach((p, n) => Object.assign(p, { x: this.starts[n], y: 416, vy: 0, hp: 100, attack: 0, cooldown: .4 })); this.timer = this.roundDuration; this.info = `ROUND ${this.players[0].round + this.players[1].round + 1} · FIRST TO ${this.roundsToWin}`; } return; }
    this.timer -= dt;
    // Resolve both guards before either attack, so simultaneous input is fair.
    this.players.forEach((p, n) => { p.block = !n || this.twoPlayer ? held(i, n ? 'ArrowDown' : 'KeyS') : this.players[0].attack > 0 && Math.sin(this.timer * 7) > .1; });
    this.players.forEach((p, n) => {
      const other = this.players[1 - n]; p.facing = other.x > p.x ? 1 : -1;
      p.cooldown = Math.max(0, p.cooldown - dt); p.attack = Math.max(0, p.attack - dt); p.hurt = Math.max(0, p.hurt - dt);
      let move = 0, jump = false, punch = false, kick = false;
      if (!n || this.twoPlayer) {
        move = (held(i, n ? 'ArrowRight' : 'KeyD') ? 1 : 0) - (held(i, n ? 'ArrowLeft' : 'KeyA') ? 1 : 0);
        jump = tapped(i, n ? 'ArrowUp' : 'KeyW'); punch = tapped(i, n ? 'KeyK' : 'KeyF'); kick = tapped(i, n ? 'KeyL' : 'KeyG'); p.block = held(i, n ? 'ArrowDown' : 'KeyS');
      } else {
        const dist = Math.abs(p.x - other.x); move = dist > 95 ? p.facing : 0;
        punch = dist < 108 && p.cooldown === 0; kick = Math.sin(this.timer * 3) > .4; p.block = other.attack > 0 && Math.sin(this.timer * 7) > .1;
        jump = other.attack > 0 && Math.sin(this.timer * 4) > .8;
      }
      if (!p.block && p.hurt <= 0) p.x += move * 230 * dt;
      p.x = Math.max(55, Math.min(905, p.x));
      if (jump && p.y >= 416) p.vy = -590;
      p.vy += 1550 * dt; p.y += p.vy * dt; if (p.y > 416) { p.y = 416; p.vy = 0; }
      if ((punch || kick) && p.cooldown === 0 && !p.block && p.hurt <= 0) {
        p.kick = kick; p.attack = kick ? .26 : .18; p.cooldown = kick ? .65 : .4;
        const reach = kick ? 125 : 100;
        if (Math.abs(p.x - other.x) < reach && Math.abs(p.y - other.y) < 75) {
          const damage = other.block ? 2 : kick ? 16 : 10; other.hp = Math.max(0, other.hp - damage); other.hurt = other.block ? .07 : .18;
          other.x += p.facing * (other.block ? 8 : 25); this.particles.burst((p.x + other.x) / 2, other.y - 57, other.block ? '#b8fd8e' : '#fff092');
          if (!n) this.score += damage * 10;
        }
      }
    });
    const [a, b] = this.players;
    if (a.hp <= 0 || b.hp <= 0 || this.timer <= 0) {
      const winner = a.hp === b.hp ? -1 : a.hp > b.hp ? 0 : 1;
      if (winner >= 0) this.players[winner].round++;
      this.roundMessage = winner < 0 ? 'DRAW!' : `${winner === 0 ? 'BLUE' : 'CORAL'} WINS THE ROUND`;
      if (a.round >= this.roundsToWin || b.round >= this.roundsToWin) { this.over = true; this.won = a.round >= this.roundsToWin; this.info = this.twoPlayer ? `${a.round >= this.roundsToWin ? 'Blue' : 'Coral'} wins the match!` : this.won ? 'Champion! You won the match.' : 'Coral takes the match. Rematch?'; }
      else this.roundPause = 2;
    }
  }
  draw(c: CanvasRenderingContext2D, time: number): void {
    gradient(c, '#614ab0', '#efa691');
    circle(c, 730, 135, 68, '#ffda99');
    for (let i = 0; i < 16; i++) { const x = i * 69; const h = 80 + Math.sin(i * 5) * 55; rect(c, x, 320 - h, 60, h + 120, '#665a9b'); for (let j = 0; j < 4; j++) rect(c, x + 12, 330 - h + j * 25, 8, 11, '#d5b1b7'); }
    rect(c, 0, 346, W, 28, '#524267'); rect(c, 0, 374, W, 180, '#322c48'); rect(c, 0, 418, W, 9, '#eaba8f');
    for (let x = 0; x < W; x += 80) line(c, [[x, 427], [480 + (x - 480) * 1.7, H]], '#4c4059');
    for (const y of [452, 491, 538]) line(c, [[0, y], [W, y]], '#4c4059');
    for (let n = 0; n < 2; n++) {
      const p = this.players[n]; c.save(); c.globalAlpha = .25; c.beginPath(); c.ellipse(p.x, 423, 39, 8, 0, 0, Math.PI * 2); c.fillStyle = '#101422'; c.fill(); c.restore();
      c.save(); c.translate(p.x, p.y); c.scale(p.facing, 1); const bob = p.y === 416 ? Math.sin(time * 5 + n) * 2 : 0; c.translate(0, bob);
      line(c, [[-14, -29], [-24, -8], [-34, -4]], '#211e39', 15); line(c, p.attack > 0 && p.kick ? [[12, -29], [55, -40], [86, -54]] : [[12, -29], [20, -8], [29, -4]], '#211e39', 15);
      rect(c, -23, -74, 45, 52, p.hurt > 0 ? '#fff' : p.color, 13); rect(c, -24, -35, 48, 8, '#f9d271', 3);
      circle(c, 0, -92, 24, '#ffd9b3'); rect(c, -24, -114, 48, 14, n ? '#a83854' : '#35748f', 7); rect(c, 18, -110, 28, 5, p.color, 3);
      rect(c, 6, -94, 4, 5, '#302a45', 2);
      const arm = p.attack > 0 && !p.kick ? 70 : p.block ? 28 : 34;
      line(c, [[12, -66], [arm - 12, -57], [arm, -65]], p.color, 16); circle(c, arm, -65, 12, '#ffd9b3');
      line(c, [[-13, -66], [-25, -48], [2, -43]], p.color, 14); circle(c, 3, -43, 10, '#ffd9b3');
      if (p.block) { c.strokeStyle = '#b8fd8e'; c.lineWidth = 4; c.beginPath(); c.arc(10, -59, 46, -1.3, 1.3); c.stroke(); }
      c.restore();
    }
    rect(c, 40, 34, 355, 24, '#312d4b', 8); rect(c, 565, 34, 355, 24, '#312d4b', 8);
    rect(c, 44, 38, 347 * this.players[0].hp / 100, 16, '#a7e8f5', 5); const rw = 347 * this.players[1].hp / 100; rect(c, 916 - rw, 38, rw, 16, '#ff8278', 5);
    label(c, 'BLUE', 42, 83, 14); label(c, this.twoPlayer ? 'CORAL · P2' : 'CORAL · CPU', 918, 83, 14, '#fff', 'right');
    label(c, String(Math.max(0, Math.ceil(this.timer))).padStart(2, '0'), 480, 64, 40, '#fff4ce', 'center');
    this.players.forEach((p, n) => { for (let j = 0; j < 2; j++) circle(c, n ? 900 - j * 22 : 59 + j * 22, 104, 6, j < p.round ? '#fce388' : '#71617e'); });
    this.particles.draw(c);
    if (this.roundPause > 0) { rect(c, 210, 220, 540, 80, '#29233ee8', 16); label(c, this.roundMessage, 480, 269, 26, '#ffe193', 'center'); }
  }
}

export const MAZE = [
  '#####################',
  '#o........#........o#',
  '#.###.###.#.###.###.#',
  '#...................#',
  '#.###.#.#####.#.###.#',
  '#.....#...#...#.....#',
  '#####.###.#.###.#####',
  '#.....#.......#.....#',
  '#.###.#.##.##.#.###.#',
  '#...#...#...#...#...#',
  '###.#.#.#####.#.#.###',
  '#.....#... ...#.....#',
  '#.###.###.#.###.###.#',
  '#o........#........o#',
  '#####################',
];
interface MazeActor { x: number; y: number; dir: number; target: { x: number; y: number } | null; color: string; homeX: number; homeY: number }
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
export class MazeGame implements Game {
  score = 0; info = 'COLLECT EVERY DOT'; over = false; won = false; lives = 3; power = 0; invincible = 2; tick = 0; desired = 0; pellets = new Map<string, boolean>(); particles = new Particles();
  player = this.actor(10, 11, '#ffe04d'); ghosts = [this.actor(9, 7, '#ff7288'), this.actor(10, 7, '#67e6eb'), this.actor(11, 7, '#c79bff'), this.actor(10, 9, '#ffa66b')];
  maze = MAZE.slice();
  constructor(public neon = false) { this.maze.forEach((row, y) => [...row].forEach((v, x) => { if (v === '.' || v === 'o') this.pellets.set(`${x},${y}`, v === 'o'); })); }
  actor(x: number, y: number, color: string): MazeActor { return { x, y, dir: 0, target: null, color, homeX: x, homeY: y }; }
  wall(x: number, y: number): boolean { return this.maze[y]?.[x] === '#' || this.maze[y]?.[x] === undefined; }
  move(a: MazeActor, dt: number, speed: number, choose: () => void): void {
    let remaining = dt * speed;
    while (remaining > 0) {
      if (!a.target) { choose(); const [dx, dy] = DIRS[a.dir]; if (this.wall(Math.round(a.x) + dx, Math.round(a.y) + dy)) break; a.target = { x: Math.round(a.x) + dx, y: Math.round(a.y) + dy }; }
      const dx = a.target.x - a.x, dy = a.target.y - a.y, d = Math.hypot(dx, dy);
      if (d <= remaining) { a.x = a.target.x; a.y = a.target.y; a.target = null; remaining -= d; if (d === 0) break; }
      else { a.x += dx / d * remaining; a.y += dy / d * remaining; remaining = 0; }
    }
  }
  resetActors(): void { for (const a of [this.player, ...this.ghosts]) { a.x = a.homeX; a.y = a.homeY; a.target = null; a.dir = 0; } this.desired = 0; this.invincible = 2; this.power = 0; }
  update(dt: number, i: Input): void {
    if (this.over) return; this.tick += dt; this.power = Math.max(0, this.power - dt); this.invincible = Math.max(0, this.invincible - dt); this.particles.update(dt);
    for (const [d, keys] of [['0', ['ArrowRight', 'KeyD']], ['1', ['ArrowDown', 'KeyS']], ['2', ['ArrowLeft', 'KeyA']], ['3', ['ArrowUp', 'KeyW']]] as const) if (held(i, ...keys) || tapped(i, ...keys)) this.desired = Number(d);
    // Allow immediate reversal between intersections; all other turns are buffered.
    if (this.player.target && this.desired === (this.player.dir + 2) % 4) { const [dx, dy] = DIRS[this.desired]; this.player.target = { x: dx ? (dx > 0 ? Math.ceil(this.player.x) : Math.floor(this.player.x)) : Math.round(this.player.x), y: dy ? (dy > 0 ? Math.ceil(this.player.y) : Math.floor(this.player.y)) : Math.round(this.player.y) }; this.player.dir = this.desired; }
    this.move(this.player, dt, 5.8, () => { const [dx, dy] = DIRS[this.desired]; if (!this.wall(Math.round(this.player.x) + dx, Math.round(this.player.y) + dy)) this.player.dir = this.desired; });
    const key = `${Math.round(this.player.x)},${Math.round(this.player.y)}`;
    if (this.pellets.has(key)) { const power = this.pellets.get(key); this.pellets.delete(key); this.score += power ? 50 : 10; if (power) { this.power = 7; this.particles.burst(165 + this.player.x * 30, 58 + this.player.y * 30, '#ffe481'); } }
    this.ghosts.forEach((g, n) => {
      this.move(g, dt, this.power > 0 ? 2.7 : this.neon ? 4.7 : 3.8, () => {
        let choices = DIRS.map(([dx, dy], d) => ({ d, x: Math.round(g.x) + dx, y: Math.round(g.y) + dy })).filter(p => !this.wall(p.x, p.y));
        if (choices.length > 1) choices = choices.filter(p => p.d !== (g.dir + 2) % 4);
        const scatter = Math.floor(this.tick / 6) % 3 === 0;
        const tx = scatter ? n % 2 ? 19 : 1 : this.player.x + (n === 1 ? DIRS[this.player.dir][0] * 3 : 0), ty = scatter ? n < 2 ? 1 : 13 : this.player.y;
        choices.sort((a, b) => (Math.hypot(a.x - tx, a.y - ty) - Math.hypot(b.x - tx, b.y - ty)) * (this.power ? -1 : 1)); if (choices[0]) g.dir = choices[0].d;
      });
      if (Math.hypot(g.x - this.player.x, g.y - this.player.y) < .66) {
        if (this.power > 0) { this.score += 200; g.x = g.homeX; g.y = g.homeY; g.target = null; }
        else if (this.invincible <= 0) { this.lives--; this.resetActors(); if (!this.lives) { this.over = true; this.info = 'The ghosts got you. Try another route!'; } }
      }
    });
    if (!this.pellets.size) { this.over = true; this.won = true; this.score += 1000; this.info = 'Maze cleared! A perfect little escape.'; }
    else if (!this.over) this.info = `${this.pellets.size} DOTS LEFT · ${this.lives} LIVES${this.power > 0 ? ' · POWER UP!' : ''}`;
  }
  draw(c: CanvasRenderingContext2D, time: number): void {
    gradient(c, this.neon ? '#170f34' : '#0c2031', this.neon ? '#241847' : '#122e40');
    for (let i = 0; i < 38; i++) circle(c, (i * 137) % W, (i * 79) % H, 1.2, this.neon ? '#8270ac' : '#36536a');
    const ox = 165, oy = 58, tile = 30;
    rect(c, ox - 13, oy - 13, 626, 446, this.neon ? '#0f0925' : '#081725', 18);
    this.maze.forEach((row, y) => [...row].forEach((v, x) => {
      if (v === '#') { const col = this.neon ? '#784ae4' : '#2774b7'; rect(c, ox + x * tile - 12, oy + y * tile - 12, 24, 24, col, 6); rect(c, ox + x * tile - 9, oy + y * tile - 9, 18, 18, this.neon ? '#241442' : '#102b43', 4); }
    }));
    for (const [key, power] of this.pellets) { const [x, y] = key.split(',').map(Number); circle(c, ox + x * tile, oy + y * tile, power ? 6 + Math.sin(time * 5) * 1.5 : 2.4, power ? '#ffdb5b' : this.neon ? '#f6bdd9' : '#f2d7a3'); }
    const p = this.player;
    if (this.invincible <= 0 || Math.sin(time * 18) > -.2) {
      c.save(); c.translate(ox + p.x * tile, oy + p.y * tile); c.rotate(p.dir * Math.PI / 2);
      const mouth = .13 + Math.abs(Math.sin(time * 11)) * .55;
      c.fillStyle = this.neon ? '#aafa84' : '#ffdb42'; c.beginPath(); c.moveTo(0, 0); c.arc(0, 0, 12, mouth, Math.PI * 2 - mouth); c.closePath(); c.fill(); circle(c, 1, -6, 1.7, '#182831'); c.restore();
    }
    this.ghosts.forEach(g => {
      const x = ox + g.x * tile, y = oy + g.y * tile, color = this.power > 0 ? (this.power < 2 && Math.sin(time * 12) > 0 ? '#fff' : '#5575d8') : g.color;
      circle(c, x, y - 2, 11, color); rect(c, x - 11, y - 2, 22, 12, color); for (let j = 0; j < 3; j++) circle(c, x - 7 + j * 7, y + 9 + Math.sin(time * 9 + j) * 1.5, 4, color);
      circle(c, x - 4, y - 3, 4, '#fff'); circle(c, x + 5, y - 3, 4, '#fff'); const [dx, dy] = DIRS[g.dir]; circle(c, x - 4 + dx * 1.4, y - 3 + dy * 1.4, 2, '#152339'); circle(c, x + 5 + dx * 1.4, y - 3 + dy * 1.4, 2, '#152339');
    });
    label(c, this.neon ? 'NEON' : 'MAZE', 60, 230, 21, this.neon ? '#aafa84' : '#ffdb42'); label(c, 'RUN', 60, 258, 21, '#fff');
    for (let j = 0; j < this.lives; j++) circle(c, 67 + j * 18, 289, 6, '#ffdb42');
    label(c, 'HIGH', 833, 230, 15, '#718ba4'); label(c, 'SCORE', 833, 252, 15, '#718ba4'); label(c, String(this.score).padStart(5, '0'), 833, 280, 21, '#fff');
    if (this.power > 0) rect(c, ox, 511, 600 * this.power / 7, 4, '#ffdb42', 2);
    this.particles.draw(c);
  }
}

interface Platform { x: number; y: number; w: number; h: number }
export class PlatformGame implements Game {
  score = 0; info = 'REACH THE FLAG'; over = false; won = false; x = 75; y = 390; vx = 0; vy = 0; grounded = false; coyote = 0; buffer = 0; camera = 0; lives = 3; invincible = 0; time = 0; checkpoint = 75; particles = new Particles();
  platforms: Platform[] = [{ x: 0, y: 450, w: 680, h: 160 }, { x: 790, y: 450, w: 600, h: 160 }, { x: 1510, y: 450, w: 660, h: 160 }, { x: 2290, y: 450, w: 780, h: 160 }, { x: 320, y: 350, w: 160, h: 30 }, { x: 550, y: 265, w: 140, h: 30 }, { x: 850, y: 330, w: 150, h: 30 }, { x: 1160, y: 350, w: 150, h: 30 }, { x: 1390, y: 350, w: 120, h: 30 }, { x: 1680, y: 330, w: 140, h: 30 }, { x: 1900, y: 265, w: 130, h: 30 }, { x: 2165, y: 345, w: 130, h: 30 }, { x: 2540, y: 350, w: 200, h: 30 }];
  coins = Array.from({ length: 38 }, (_, n) => ({ x: 210 + n * 72, y: n >= 4 && n <= 7 ? 222 : n >= 20 && n <= 24 ? 223 : n % 7 < 3 ? 310 : 392, taken: false }));
  enemies = [480, 1020, 1760, 2420, 2790].map((x, n) => ({ x, home: x, y: 450, alive: true, phase: n }));
  finish = 2950;
  die(): void { this.lives--; if (!this.lives) { this.over = true; this.info = 'Out of hearts. Adventure awaits again!'; } else { this.x = this.checkpoint; this.y = 340; this.vx = this.vy = 0; this.invincible = 2; } }
  update(dt: number, i: Input): void {
    if (this.over) return; this.time += dt; this.invincible = Math.max(0, this.invincible - dt); this.particles.update(dt);
    const dir = (held(i, 'ArrowRight', 'KeyD') ? 1 : 0) - (held(i, 'ArrowLeft', 'KeyA') ? 1 : 0);
    const speed = held(i, 'ShiftLeft', 'ShiftRight') ? 340 : 270;
    this.vx += (dir * speed - this.vx) * Math.min(1, dt * (this.grounded ? 15 : 7));
    if (tapped(i, 'Space', 'ArrowUp', 'KeyW')) this.buffer = .14; else this.buffer = Math.max(0, this.buffer - dt);
    this.coyote = this.grounded ? .12 : Math.max(0, this.coyote - dt);
    if (this.buffer > 0 && this.coyote > 0) { this.vy = -640; this.grounded = false; this.coyote = 0; this.buffer = 0; }
    if (!held(i, 'Space', 'ArrowUp', 'KeyW') && this.vy < -260) this.vy += 1700 * dt;
    const oldY = this.y; this.vy += 1700 * dt; this.x = Math.max(14, this.x + this.vx * dt); this.y += this.vy * dt; this.grounded = false;
    for (const p of this.platforms) {
      if (this.x + 15 > p.x && this.x - 15 < p.x + p.w && oldY <= p.y + 2 && this.y >= p.y && this.vy >= 0) { this.y = p.y; this.vy = 0; this.grounded = true; }
      else if (this.x + 13 > p.x && this.x - 13 < p.x + p.w && this.y > p.y + 8 && this.y - 42 < p.y + p.h) {
        if (oldY - 42 >= p.y + p.h && this.vy < 0) { this.y = p.y + p.h + 42; this.vy = 30; }
        else if (this.x < p.x + p.w / 2) { this.x = p.x - 15; this.vx = 0; } else { this.x = p.x + p.w + 15; this.vx = 0; }
      }
    }
    for (const coin of this.coins) if (!coin.taken && Math.hypot(this.x - coin.x, this.y - 24 - coin.y) < 32) { coin.taken = true; this.score += 100; this.particles.burst(coin.x, coin.y, '#ffe06a', 8); }
    for (const e of this.enemies) {
      if (!e.alive) continue; e.x = e.home + Math.sin(this.time * 1.3 + e.phase) * 65;
      if (Math.abs(this.x - e.x) < 30 && Math.abs(this.y - e.y) < 40) {
        if (this.vy > 0 && oldY <= e.y - 20) { e.alive = false; this.vy = -430; this.score += 200; this.particles.burst(e.x, e.y - 15, '#c6a3f4'); }
        else if (this.invincible <= 0) this.die();
      }
    }
    if (this.x > 1600 && this.checkpoint < 1600 && this.grounded) this.checkpoint = 1570;
    if (this.y > 630) this.die();
    if (this.x > this.finish - 20) { this.over = true; this.won = true; this.score += this.lives * 500; this.info = 'Flag reached! The meadow is yours.'; }
    this.camera += (Math.max(0, Math.min(Math.max(0, this.finish - 830), this.x - 300)) - this.camera) * Math.min(1, dt * 6);
    if (!this.over) this.info = `${this.coins.filter(v => v.taken).length}/${this.coins.length} COINS · ${this.lives} HEARTS${this.checkpoint > 75 ? ' · CHECKPOINT' : ''}`;
  }
  draw(c: CanvasRenderingContext2D, time: number): void {
    gradient(c, '#86cfed', '#dbf0ce'); circle(c, 795 - this.camera * .05, 87, 40, '#fff2b7');
    for (let n = 0; n < 8; n++) cloud(c, n * 270 - this.camera * .25, 65 + n % 3 * 45, .8 + n % 2 * .3);
    for (let n = 0; n < 10; n++) { const x = n * 240 - this.camera * .45; circle(c, x, 480, 155 + n % 2 * 45, n % 2 ? '#91c99c' : '#aad7a9'); }
    c.save(); c.translate(-this.camera, 0);
    for (const p of this.platforms) {
      rect(c, p.x, p.y, p.w, p.h, p.h > 30 ? '#c99466' : '#daaa74', p.h > 30 ? 0 : 5); rect(c, p.x, p.y, p.w, 13, '#79b863', 4); rect(c, p.x, p.y + 10, p.w, 5, '#589c51');
      for (let x = p.x + 10; x < p.x + p.w; x += 33) { rect(c, x, p.y + 25, 14, 5, '#b9855e', 2); if (p.h > 40) rect(c, x + 10, p.y + 55, 11, 7, '#deb388', 2); }
    }
    for (let n = 0; n < 36; n++) { const x = n * 85 + 22; if (this.platforms.some(p => p.h > 40 && x >= p.x && x < p.x + p.w)) { line(c, [[x, 450], [x, 431]], '#5d9f53', 3); circle(c, x, 430, 5, n % 2 ? '#ffd36d' : '#f394a2'); circle(c, x, 430, 2, '#fff5c3'); } }
    for (const coin of this.coins) if (!coin.taken) { c.save(); c.translate(coin.x, coin.y + Math.sin(time * 4 + coin.x) * 3); c.scale(.7 + Math.abs(Math.cos(time * 3)) * .3, 1); circle(c, 0, 0, 10, '#cf982c'); circle(c, 0, -1, 8, '#ffdc5e'); line(c, [[0, -5], [0, 4]], '#e4b137', 3); c.restore(); }
    for (const e of this.enemies) if (e.alive) { circle(c, e.x, e.y - 17, 18, '#b697d5'); rect(c, e.x - 19, e.y - 15, 38, 13, '#b697d5', 5); circle(c, e.x - 6, e.y - 21, 5, '#fff'); circle(c, e.x + 6, e.y - 21, 5, '#fff'); circle(c, e.x - 5, e.y - 20, 2, '#473b66'); circle(c, e.x + 5, e.y - 20, 2, '#473b66'); rect(c, e.x - 21, e.y - 4, 15, 5, '#665579', 3); rect(c, e.x + 6, e.y - 4, 15, 5, '#665579', 3); }
    line(c, [[1620, 450], [1620, 350]], '#fffde8', 5); rect(c, 1622, 352, 42, 27, this.checkpoint > 75 ? '#e8bd50' : '#aac0a0', 3);
    line(c, [[this.finish, 450], [this.finish, 210]], '#fffce9', 6); circle(c, this.finish, 206, 8, '#ffdc65'); c.fillStyle = '#ed7794'; c.beginPath(); c.moveTo(this.finish + 3, 216); c.lineTo(this.finish + 80, 240); c.lineTo(this.finish + 3, 263); c.fill();
    if (this.invincible <= 0 || Math.sin(time * 20) > -.3) {
      c.save(); c.translate(this.x, this.y); if (this.vx < -5) c.scale(-1, 1);
      const walk = this.grounded ? Math.sin(time * 15) * Math.min(7, Math.abs(this.vx) / 30) : 4;
      rect(c, -13 + walk, -8, 15, 8, '#443f5b', 4); rect(c, 3 - walk, -8, 15, 8, '#443f5b', 4);
      rect(c, -12, -27, 26, 21, '#447a98', 5); rect(c, -17, -37, 34, 19, '#f38f7f', 7); circle(c, 0, -45, 17, '#ffddb0'); rect(c, -17, -62, 34, 12, '#ed796e', 5); rect(c, 7, -52, 20, 5, '#ed796e', 2); circle(c, 9, -43, 2, '#3d4650'); rect(c, -17, -32, 7, 16, '#ffddb0', 4); rect(c, 11, -32, 7, 16, '#ffddb0', 4); c.restore();
    }
    this.particles.draw(c); c.restore();
    rect(c, 28, 24, 170, 43, '#fff9eae8', 12); label(c, 'MEADOW  01', 48, 52, 17, '#406458');
    rect(c, 714, 24, 218, 43, '#fff9eae8', 12); circle(c, 738, 45, 10, '#ffdc5e'); label(c, `${this.coins.filter(v => v.taken).length}/${this.coins.length}`, 757, 51, 16, '#91733a');
    for (let n = 0; n < 3; n++) { const x = 843 + n * 25, y = 45; c.fillStyle = n < this.lives ? '#ed7993' : '#d2d9c3'; c.beginPath(); c.moveTo(x,y+9); c.bezierCurveTo(x-22,y-4,x-5,y-18,x,y-7); c.bezierCurveTo(x+5,y-18,x+22,y-4,x,y+9); c.fill(); }
  }
}

export function terrain(x: number): number { return 380 + Math.sin(x / 180) * 47 + Math.sin(x / 390) * 44 + Math.sin(x / 78) * 12; }
export class RacingGame implements Game {
  ground = terrain; finish = 4500;
  score = 0; info = 'GO THE DISTANCE'; over = false; won = false; x = 100; y = this.ground(100) - 34; vx = 0; vy = 0; angle = Math.atan((this.ground(130) - this.ground(70)) / 60); spin = 0; fuel = 100; flipped = 0; camera = 0; grounded = true; particles = new Particles();
  pickups = Array.from({ length: 55 }, (_, n) => ({ x: 350 + n * 80, taken: false, fuel: n % 12 === 8 }));
  update(dt: number, i: Input): void {
    if (this.over) return; this.particles.update(dt);
    const gas = held(i, 'ArrowRight', 'KeyD'), brake = held(i, 'ArrowLeft', 'KeyA');
    const floor = this.ground(this.x) - 34, slope = Math.atan((this.ground(this.x + 26) - this.ground(this.x - 26)) / 52);
    if (this.grounded) {
      this.vx += ((gas && this.fuel > 0 ? 220 : 0) - (brake ? 290 : 0) + Math.sin(slope) * 240 - this.vx * .42) * dt;
      this.vx = Math.max(-110, Math.min(460, this.vx)); this.spin += Math.sin(slope - this.angle) * 21 * dt; this.spin *= Math.exp(-7 * dt);
      this.vy = (this.ground(this.x + this.vx * dt) - this.ground(this.x)) / dt;
      if (gas && tapped(i, 'Space')) { this.vy = -270; this.grounded = false; }
    } else { this.vy += 720 * dt; this.spin += ((gas ? -.9 : 0) + (brake ? .9 : 0)) * dt; }
    const oldFloor = floor; this.x = Math.max(60, this.x + this.vx * dt); const nextFloor = this.ground(this.x) - 34;
    if (this.grounded && this.vy < -140 && nextFloor > oldFloor + this.vy * dt + 1.8) this.grounded = false;
    if (this.grounded) this.y = nextFloor; else { this.y += this.vy * dt; if (this.y >= nextFloor && this.vy >= 0) { this.y = nextFloor; this.vy = 0; this.grounded = true; this.particles.burst(this.x, this.y + 25, '#dfbb8d', 8); } }
    this.angle += this.spin * dt; this.angle = Math.atan2(Math.sin(this.angle), Math.cos(this.angle));
    if (this.grounded && Math.abs(this.angle - slope) > 1.8) this.flipped += dt; else this.flipped = Math.max(0, this.flipped - dt);
    this.fuel = Math.max(0, this.fuel - dt * (gas ? 2.3 : .4));
    for (const p of this.pickups) if (!p.taken && Math.abs(this.x - p.x) < 38 && Math.abs(this.y - (this.ground(p.x) - 44)) < 75) { p.taken = true; if (p.fuel) this.fuel = Math.min(100, this.fuel + 45); else this.score += 50; this.particles.burst(p.x, this.ground(p.x) - 44, p.fuel ? '#fc8073' : '#ffe178', 8); }
    this.camera = Math.max(0, this.x - 250);
    if (this.flipped > 1.2 || (this.fuel <= 0 && Math.abs(this.vx) < 10)) { this.over = true; this.info = this.flipped > 1.2 ? 'Oops, rolled over! Find your balance.' : 'Out of fuel. Watch for red fuel cans!'; }
    if (this.x >= this.finish) { this.over = true; this.won = true; this.score += Math.round(this.fuel) * 10; this.info = 'Summit reached! What a ride.'; }
    if (!this.over) this.info = `${Math.floor((this.x - 100) / 10)} / ${Math.round((this.finish - 100) / 10)} m · FUEL ${Math.ceil(this.fuel)}%`;
  }
  draw(c: CanvasRenderingContext2D, time: number): void {
    gradient(c, '#f7c57e', '#ffe2b3'); circle(c, 770, 120, 65, '#fff1bc');
    for (let layer = 0; layer < 3; layer++) {
      c.fillStyle = ['#dec19d', '#b9bca0', '#91aa89'][layer]; c.beginPath(); c.moveTo(0, H);
      for (let px = 0; px <= W + 20; px += 20) { const xx = px + this.camera * (.1 + layer * .15); const y = 320 + layer * 40 - Math.abs(Math.sin(xx / (240 - layer * 30))) * (140 - layer * 20); c.lineTo(px, y); } c.lineTo(W, H); c.fill();
    }
    for (let n = 0; n < 12; n++) cloud(c, n * 350 - this.camera * .15, 65 + n % 3 * 25, .6);
    c.save(); c.translate(-this.camera, 0);
    c.fillStyle = '#b78359'; c.beginPath(); c.moveTo(this.camera - 10, H); for (let x = this.camera - 10; x < this.camera + W + 20; x += 8) c.lineTo(x, this.ground(x)); c.lineTo(this.camera + W + 20, H); c.fill();
    const path = []; for (let x = this.camera - 10; x < this.camera + W + 20; x += 8) path.push([x, this.ground(x)]); line(c, path, '#e7d099', 15); line(c, path.map(([x, y]) => [x, y - 5]), '#7d9b61', 6);
    for (let n = Math.floor(this.camera / 150); n < (this.camera + W) / 150; n++) { const x = n * 150 + 70; line(c, [[x, this.ground(x) + 30], [x + 20, this.ground(x) + 33]], '#9e714e', 4); }
    for (const p of this.pickups) if (!p.taken && Math.abs(p.x - this.camera - 480) < 550) {
      const y = this.ground(p.x) - 44 + Math.sin(time * 3 + p.x) * 3;
      if (p.fuel) { rect(c, p.x - 10, y - 14, 20, 28, '#ec7a69', 4); line(c, [[p.x - 4, y - 14], [p.x - 4, y - 20], [p.x + 6, y - 20], [p.x + 6, y - 14]], '#6f6354', 3); label(c, '+', p.x, y + 6, 19, '#fff6d8', 'center'); }
      else { circle(c, p.x, y, 11, '#d69d39'); circle(c, p.x, y - 1, 9, '#ffe086'); star(c, p.x, y - 1, 5, '#d7a441'); }
    }
    const flagY = this.ground(this.finish); line(c, [[this.finish, flagY], [this.finish, flagY - 150]], '#fff8d5', 6); rect(c, this.finish + 3, flagY - 148, 70, 40, '#ec7a69'); label(c, 'FINISH', this.finish + 10, flagY - 123, 15);
    c.save(); c.translate(this.x, this.y); c.rotate(this.angle);
    rect(c, -45, -20, 90, 32, '#4e9d9a', 9); rect(c, -30, -48, 54, 35, '#5eb6af', 9); rect(c, -23, -42, 39, 22, '#d5ece1', 5); rect(c, -2, -42, 4, 24, '#488f8f'); rect(c, -48, 5, 96, 7, '#426764', 3); rect(c, 32, -14, 10, 6, '#ffe6a7', 2);
    circle(c, -29, 13, 20, '#37464b'); circle(c, 30, 13, 20, '#37464b');
    for (const x of [-29, 30]) { circle(c, x, 13, 11, '#bbc3b2'); c.save(); c.translate(x, 13); c.rotate(this.x / 20); for (let a = 0; a < 6; a++) { const an = a * Math.PI / 3; line(c, [[0, 0], [Math.cos(an) * 10, Math.sin(an) * 10]], '#6b7776', 3); } c.restore(); circle(c, x, 13, 3, '#e7e9d7'); }
    c.restore(); this.particles.draw(c); c.restore();
    rect(c, 28, 25, 215, 55, '#fff8e8ee', 13); label(c, 'FUEL', 45, 48, 12, '#657362'); rect(c, 88, 37, 133, 13, '#e2debf', 5); rect(c, 88, 37, 133 * this.fuel / 100, 13, this.fuel < 25 ? '#e87968' : '#6c9d73', 5); label(c, `${Math.floor(Math.max(0, this.x - 100) / 10)} m`, 46, 67, 13, '#657362');
  }
}
export function createGame(id: GameId, twoPlayer = false, level?: ArcadeLevel | null): Game {
  let game: Game;
  switch (id) { case 'fighter': game = new FighterGame(twoPlayer); break; case 'pacman': game = new MazeGame(); break; case 'neon': game = new MazeGame(true); break; case 'platformer': game = new PlatformGame(); break; case 'racing': game = new RacingGame(); break; case 'shooter': game = new ShooterGame(); break; }
  if (!level || level.game !== id) return game;
  if (game instanceof MazeGame && level.maze) {
    game.maze = level.maze.slice(); game.pellets.clear();
    game.maze.forEach((row,y) => [...row].forEach((v,x) => { if (v === '.' || v === 'o') game.pellets.set(`${x},${y}`, v === 'o'); }));
  }
  if (game instanceof PlatformGame) {
    if (level.platforms) game.platforms = level.platforms.map(p => ({...p}));
    if (level.coins) game.coins = level.coins.map(p => ({...p, taken:false}));
    if (level.enemies) game.enemies = level.enemies.map((p,n) => ({...p,home:p.x,alive:true,phase:n}));
    game.finish = level.finish ?? 2950;
  }
  if (game instanceof RacingGame) {
    if (level.hills) {
      const points = level.hills;
      game.ground = x => {
        if (x <= points[0].x) return points[0].y;
        const b = points.findIndex(p => p.x >= x);
        if (b < 0) return points.at(-1)!.y;
        const a = points[b-1], end = points[b], t = (x-a.x)/(end.x-a.x);
        return a.y + (end.y-a.y)*t;
      };
    }
    if (level.pickups) game.pickups = level.pickups.map(p => ({...p,taken:false}));
    game.finish = level.finish ?? 4500; game.y = game.ground(100)-34; game.angle = Math.atan((game.ground(130)-game.ground(70))/60);
  }
  if (game instanceof FighterGame) {
    game.starts = level.spawns?.slice() ?? [280,680]; game.players.forEach((p,n) => {p.x=game.starts[n];});
    game.roundDuration = level.duration ?? 60; game.timer = game.roundDuration; game.roundsToWin = level.rounds ?? 2; game.info = `ROUND 1 · FIRST TO ${game.roundsToWin}`;
  }
  if (game instanceof ShooterGame) {
    if (level.arena) game.setMap(level.arena);
    game.roundDuration = level.duration ?? 90; game.timer = game.roundDuration; game.roundsToWin = level.rounds ?? 3;
  }
  return game;
}
