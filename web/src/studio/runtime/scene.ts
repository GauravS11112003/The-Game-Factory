/**
 * The Phaser 3 + Matter adapter for the Studio runtime (docs/v6/CONTRACTS_V6.md §4.2): builds bodies, joints, edges,
 * textures (renderDrawing) and parallax backgrounds for one scene, steps physics at a fixed 60 Hz, feeds contacts and
 * input to the pure World, and renders juice (squash/stretch, particles, shake, hit-stop, speech bubbles, health bars,
 * aim arcs). Everything the rules mean lives in world.ts / behaviors.ts; this file is only the engine glue.
 */
import Phaser from 'phaser';
import type { Drawing } from '../../core/types.gen.ts';
import { renderDrawing } from '../theme/render.ts';
import { backgroundLayers, layerPlacement, REF_H, REF_W } from '../theme/background.ts';
import { hexNum, mix, type FullTheme } from '../theme/color.ts';
import { hashStr } from '../theme/rng.ts';
import { Controls, launcherAim, stepBehaviors, wrapEnt, type InputState } from './behaviors.ts';
import type { NDoc, NObject, NScene } from './normalize.ts';
import { shapeFor, type Pt } from './shapes.ts';
import { World, type BodyIO, type Ent, type FxName, type Host, type RuntimeEventOut } from './world.ts';
import type { Sound } from './sound.ts';

// Matter's namespace ships inside Phaser (untyped there)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const M: Any = (Phaser.Physics.Matter as unknown as { Matter: Any }).Matter;

export const STEP_MS = 1000 / 60;
const G_PX = 1600; // px/s² per g
const MATTER_G = 0.001 * 1.6; // Matter force units per g (1 g = 1.6 × Matter's default gravity)

/** What the scene needs from the runner (index.ts). */
export interface SceneLink {
  doc: NDoc;
  sceneIndex: number;
  gameCounters: Record<string, number>;
  input: InputState;
  sound: Sound;
  theme: FullTheme;
  recolor: Map<string, string> | null;
  texScale: number;
  isPaused(): boolean;
  emit(e: RuntimeEventOut): void;
  counterChanged(subject: string, counter: string, value: number): void;
  win(text?: string): void;
  lose(text?: string): void;
  nextScene(): void;
  goScene(id: string): void;
  onWorld(w: World, scene: PlayScene): void;
  say(text: string): void;
}

interface View {
  c: Phaser.GameObjects.Container;
  inner: Phaser.GameObjects.Container;
  imgs: Phaser.GameObjects.Image[];
  sx: number;
  sy: number;
  flash: number;
  swing: number;
  flip: boolean;
  bar: Phaser.GameObjects.Graphics | null;
  color: number;
}

interface Joint {
  type: string;
  cons: Any[];
  a: Ent;
  b: Ent;
  length: number;
  motor: boolean;
  speed: number;
}

/** Matter body behind an entity, in the World's units (px, px/s, degrees, origin = the object's centre). */
class MatterIO implements BodyIO {
  kind: BodyIO['kind'];
  grounded = false;
  groundVx = 0;
  /** COM offset from the object origin, in the body's local (unrotated) frame, scaled. */
  ox = 0;
  oy = 0;
  kv: [number, number] = [0, 0];
  kav = 0;
  moved = false;
  fixedRot: boolean;
  wheelList: { body: BodyIO; radius: number; motor: boolean }[] = [];
  constructor(public b: Any, kind: BodyIO['kind'], public scene: PlayScene, public ent: Ent, fixedRot: boolean) {
    this.kind = kind;
    this.fixedRot = fixedRot;
  }
  private rot(): [number, number] {
    const a = this.b.angle;
    return [Math.cos(a), Math.sin(a)];
  }
  get x(): number {
    const [c, s] = this.rot();
    return this.b.position.x - (c * this.ox - s * this.oy);
  }
  get y(): number {
    const [c, s] = this.rot();
    return this.b.position.y - (s * this.ox + c * this.oy);
  }
  get angle(): number {
    return (this.b.angle * 180) / Math.PI;
  }
  get vx(): number {
    return this.kind === 'kinematic' ? this.kv[0] : this.b.velocity.x * 60;
  }
  get vy(): number {
    return this.kind === 'kinematic' ? this.kv[1] : this.b.velocity.y * 60;
  }
  get av(): number {
    return this.kind === 'kinematic' ? this.kav : (this.b.angularVelocity * 60 * 180) / Math.PI;
  }
  setVelocity(vx: number, vy: number): void {
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) return;
    if (this.kind === 'kinematic' || this.b.isStatic) {
      this.kv = [vx, vy];
      return;
    }
    M.Body.setVelocity(this.b, { x: vx / 60, y: vy / 60 });
  }
  setAngularVelocity(d: number): void {
    if (!Number.isFinite(d)) return;
    if (this.kind === 'kinematic' || this.b.isStatic) {
      this.kav = d;
      return;
    }
    if (this.fixedRot) return;
    M.Body.setAngularVelocity(this.b, (d * Math.PI) / 180 / 60);
  }
  setAngle(d: number): void {
    if (Number.isFinite(d)) M.Body.setAngle(this.b, (d * Math.PI) / 180, this.kind === 'kinematic');
  }
  setPosition(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const [c, s] = this.rot();
    M.Body.setPosition(this.b, { x: x + (c * this.ox - s * this.oy), y: y + (s * this.ox + c * this.oy) }, this.kind === 'kinematic');
    this.moved = true;
    if (this.kind === 'dynamic' && !this.b.isStatic) M.Body.setVelocity(this.b, { x: this.b.velocity.x, y: this.b.velocity.y });
  }
  setFrozen(f: boolean): void {
    if (this.kind !== 'dynamic') return;
    if (f === this.b.isStatic) return;
    M.Body.setStatic(this.b, f);
    if (!f && this.fixedRot) M.Body.setInertia(this.b, Infinity);
  }
  wheels(): { body: BodyIO; radius: number; motor: boolean }[] {
    return this.wheelList.filter((w) => (w.body as MatterIO).ent.alive);
  }
  probe(x: number, y: number): boolean {
    return this.scene.solidAt(x, y, this.b);
  }
  /** Kinematic bodies move by their own velocity each step. */
  integrate(dt: number): void {
    if (this.kind !== 'kinematic') return;
    if (!this.moved && (this.kv[0] || this.kv[1])) {
      M.Body.setPosition(this.b, { x: this.b.position.x + this.kv[0] * dt, y: this.b.position.y + this.kv[1] * dt }, true);
    } else if (!this.moved) M.Body.setVelocity(this.b, { x: 0, y: 0 });
    if (this.kav) M.Body.setAngle(this.b, this.b.angle + (this.kav * Math.PI) / 180 * dt, true);
    this.moved = false;
  }
}

/** Decoration (body none): no collisions, but behaviours can still move it. */
class FreeIO implements BodyIO {
  readonly kind = 'none' as const;
  grounded = false;
  groundVx = 0;
  vx = 0;
  vy = 0;
  av = 0;
  constructor(public x: number, public y: number, public angle: number) {}
  setVelocity(vx: number, vy: number): void {
    if (Number.isFinite(vx) && Number.isFinite(vy)) {
      this.vx = vx;
      this.vy = vy;
    }
  }
  setAngularVelocity(d: number): void {
    if (Number.isFinite(d)) this.av = d;
  }
  setAngle(d: number): void {
    if (Number.isFinite(d)) this.angle = d;
  }
  setPosition(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.x = x;
      this.y = y;
    }
  }
  integrate(dt: number): void {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.angle += this.av * dt;
  }
}

const texKeys = new WeakMap<object, string>();
let texSeq = 0;

export class PlayScene extends Phaser.Scene {
  link!: SceneLink;
  world!: World;
  scn!: NScene;
  controls!: Controls;
  views = new Map<Ent, View>();
  bodyEnt = new Map<Any, Ent>();
  joints: Joint[] = [];
  bgLayer!: Phaser.GameObjects.Layer;
  worldLayer!: Phaser.GameObjects.Layer;
  bgSprites: { s: Phaser.GameObjects.TileSprite | Phaser.GameObjects.Image; layer: ReturnType<typeof backgroundLayers>[number] }[] = [];
  worldCam!: Phaser.Cameras.Scene2D.Camera;
  acc = 0;
  timeScale = 1;
  timeScaleLeft = 0;
  hitStop = 0;
  camTarget: Ent | null = null;
  camZoom = 1;
  camBaseZoom = 1;
  camX = 800;
  camY = 450;
  emitters: Record<string, Phaser.GameObjects.Particles.ParticleEmitter> = {};
  bubbles: { e: Ent | null; t: Phaser.GameObjects.Container; until: number }[] = [];
  aim!: Phaser.GameObjects.Graphics;
  bars!: Phaser.GameObjects.Graphics;
  edges: Any[] = [];
  groupSeq = 0;
  elapsed = 0;
  engineLevel = 0;

  constructor() {
    super({ key: 'play' });
  }

  init(data: { link: SceneLink }): void {
    this.link = data.link;
    this.views = new Map();
    this.bodyEnt = new Map();
    this.joints = [];
    this.bgSprites = [];
    this.bubbles = [];
    this.edges = [];
    this.emitters = {};
    this.acc = 0;
    this.timeScale = 1;
    this.timeScaleLeft = 0;
    this.hitStop = 0;
    this.elapsed = 0;
    this.camTarget = null;
  }

  create(): void {
    const L = this.link;
    this.scn = L.doc.scenes[L.sceneIndex] ?? L.doc.scenes[0];
    const wd = this.scn.world;
    (this.matter.world.engine as Any).gravity.x = 0;
    (this.matter.world.engine as Any).gravity.y = 0;
    this.matter.world.autoUpdate = false;
    this.bgLayer = this.add.layer();
    this.worldLayer = this.add.layer();
    // camera 1 paints the background at zoom 1; camera 2 shows the world
    const bgCam = this.cameras.main;
    bgCam.setBackgroundColor(L.theme.palette.bg);
    this.worldCam = this.cameras.add(0, 0, REF_W, REF_H, false, 'world');
    bgCam.ignore(this.worldLayer);
    this.worldCam.ignore(this.bgLayer);
    this.buildBackground();
    this.makeParticleTextures();
    this.aim = this.add.graphics();
    this.bars = this.add.graphics();
    this.aim.setDepth(1e6);
    this.bars.setDepth(1e6 + 1);
    this.worldLayer.add([this.aim, this.bars]);

    const world = new World(L.doc, this.scn, this.host(), { game: L.gameCounters });
    this.world = world;
    this.controls = new Controls(L.input, wd.players);
    for (const o of this.scn.objects) if (!o.template) this.createEnt(o, { vx: 0, vy: 0 });
    this.buildJoints();
    this.buildEdges();
    this.setupCamera();
    this.makeEmitters();
    this.setupPointer();
    this.matter.world.on('collisionstart', (ev: Any) => this.onPairs(ev.pairs, 'begin'));
    this.matter.world.on('collisionactive', (ev: Any) => this.onPairs(ev.pairs, 'active'));
    this.matter.world.on('collisionend', (ev: Any) => this.onPairs(ev.pairs, 'end'));
    world.start();
    L.onWorld(world, this);
    this.updateViews(0);
  }

  // ---- host (what the World asks for) ------------------------------------------------------------

  private host(): Host {
    const L = this.link;
    return {
      spawn: (def, o) => this.createEnt(def, o),
      destroy: (e, fx) => this.removeEnt(e, fx),
      setVisible: (e, shown) => this.setShown(e, shown),
      setSensor: (e, sensor) => this.setSensor(e, sensor),
      setGravity: () => undefined, // read from world.gravity every step
      flipGravity: () => this.shake(0.4),
      timeScale: (s, secs) => {
        this.timeScale = Math.max(0.1, Math.min(3, s));
        this.timeScaleLeft = Math.max(0.1, secs);
      },
      sound: (n) => L.sound.play(n),
      shake: (p) => this.shake(p),
      flash: (c) => {
        const n = hexNum(c);
        this.worldCam.flash(220, (n >> 16) & 255, (n >> 8) & 255, n & 255);
      },
      say: (e, text, secs) => this.say(e, text, secs),
      camera: (e, zoom) => {
        if (e) this.camTarget = e;
        this.camZoom = Math.max(0.2, Math.min(5, zoom));
      },
      win: (t) => L.win(t),
      lose: (t) => L.lose(t),
      nextScene: () => L.nextScene(),
      goScene: (id) => L.goScene(id),
      fx: (n, e, d) => this.fx(n, e, d),
      counterChanged: (s, c, v) => L.counterChanged(s, c, v),
      emit: (e) => L.emit(e),
      defaultProjectile: () => this.defaultProjectile(),
    };
  }

  private defaultProjectile(): NObject {
    const r = 7;
    const pts: [number, number][] = Array.from({ length: 10 }, (_, i) => [Math.cos((i / 10) * Math.PI * 2) * r, Math.sin((i / 10) * Math.PI * 2) * r]);
    return {
      id: 'shot', name: 'shot', kind: 'projectile',
      drawing: DEFAULT_SHOT_DRAWING(this.link.theme.palette.accent, pts) as Drawing,
      w: r * 2, h: r * 2, x: 0, y: 0, rotation: 0, scale: 1, layer: 3,
      physics: { body: 'dynamic', shape: 'circle', density: 0.2, friction: 0, bounce: 0, fixed_rotation: true, sensor: true, gravity_scale: 0 },
      behaviors: [], rules: [], counters: {}, tags: ['projectile'], joints: [], template: false, hidden: false, player: 0, order: 999,
    };
  }

  // ---- building ----------------------------------------------------------------------------------

  private textureFor(d: Drawing): { key: string; tiles: { key: string; x: number; y: number }[] } | null {
    if (!d?.strokes?.length) return null;
    let base = texKeys.get(d);
    if (!base) {
      base = `d${++texSeq}`;
      texKeys.set(d, base);
    }
    const L = this.link;
    const themeKey = hashStr(JSON.stringify([L.theme.palette, L.theme.stroke, L.theme.recolor])).toString(36);
    const key = `${base}_${themeKey}_${L.texScale}`;
    const meta = this.registry.get(`tiles:${key}`) as { key: string; x: number; y: number }[] | undefined;
    if (meta) return { key, tiles: meta };
    // bounding box of the ink
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxW = 6;
    for (const s of d.strokes) {
      maxW = Math.max(maxW, s.width ?? 6);
      for (const p of s.points ?? []) {
        minX = Math.min(minX, p[0]);
        minY = Math.min(minY, p[1]);
        maxX = Math.max(maxX, p[0]);
        maxY = Math.max(maxY, p[1]);
      }
    }
    const margin = maxW * 2 + 30;
    const big = (maxX - minX + margin * 2) * L.texScale > 4000 || (maxY - minY + margin * 2) * L.texScale > 4000;
    const tiles: { key: string; x: number; y: number }[] = [];
    try {
      if (!big) {
        const c = renderDrawing(d, L.theme as never, { scale: L.texScale, pad: 6, recolorMap: L.recolor });
        if (!this.textures.exists(key)) this.textures.addCanvas(key, c);
        tiles.push({ key, x: 0, y: 0 });
      } else {
        const scale = 1;
        const T = 1800;
        const x0 = minX - margin;
        const y0 = minY - margin;
        for (let ty = y0; ty < maxY + margin; ty += T) {
          for (let tx = x0; tx < maxX + margin; tx += T) {
            const h = Math.min(T, maxY + margin - ty);
            const w = Math.min(T, maxX + margin - tx);
            if (!inkIn(d, tx - maxW, ty - maxW, w + maxW * 2, h + maxW * 2)) continue;
            const c = renderDrawing(d, L.theme as never, { scale, recolorMap: L.recolor, region: { x: tx, y: ty, w, h } });
            const k = `${key}_${tiles.length}`;
            if (!this.textures.exists(k)) this.textures.addCanvas(k, c);
            tiles.push({ key: k, x: tx + w / 2, y: ty + h / 2 });
          }
        }
      }
    } catch {
      return null;
    }
    if (L.theme.stroke.style === 'pixel') for (const t of tiles) this.textures.get(t.key)?.setFilter(Phaser.Textures.FilterMode.NEAREST);
    this.registry.set(`tiles:${key}`, tiles);
    return { key, tiles };
  }

  private makeView(e: Ent): View {
    const def = e.def;
    const c = this.add.container(e.x, e.y);
    const inner = this.add.container(0, def.h / 2);
    c.add(inner);
    const imgs: Phaser.GameObjects.Image[] = [];
    const tex = this.textureFor(def.drawing);
    if (tex) {
      const big = tex.tiles.length > 1 || tex.tiles[0].key !== tex.key;
      for (const t of tex.tiles) {
        const img = this.add.image(t.x, t.y - def.h / 2, t.key);
        img.setScale(big ? 1 : 1 / this.link.texScale);
        inner.add(img);
        imgs.push(img);
      }
    }
    c.setScale(def.scale);
    c.setRotation((def.rotation * Math.PI) / 180);
    c.setDepth(def.layer * 1000 + def.order);
    this.worldLayer.add(c);
    const flip = e.behaviors.some((b) => ['platformer', 'patrol', 'ai_fighter', 'follow'].includes(b.def.type)) && def.physics.body !== 'static';
    const firstColor = def.drawing?.strokes?.find((s) => s.fill)?.fill ?? def.drawing?.strokes?.[0]?.color ?? this.link.theme.palette.accent;
    const bar = e.behaviors.some((b) => b.def.type === 'health' && b.def.params.bar === true) ? this.add.graphics() : null;
    if (bar) {
      bar.setDepth(1e6 - 1);
      this.worldLayer.add(bar);
    }
    return { c, inner, imgs, sx: 1, sy: 1, flash: 0, swing: 0, flip, bar, color: hexNum(firstColor) };
  }

  /** Entity + view + body for an object (initial objects and copies). */
  createEnt(def: NObject, o: { vx: number; vy: number; angle?: number }): Ent | null {
    try {
      const e = this.world.addEnt(def);
      const v = this.makeView(e);
      this.views.set(e, v);
      e.body = this.makeBody(e);
      if (o.vx || o.vy) e.body?.setVelocity(o.vx, o.vy);
      if (!e.shown) this.setShown(e, false);
      if (this.world.t > 0 && e.shown) {
        // pop in
        v.sx = 0.6;
        v.sy = 0.6;
      }
      return e;
    } catch {
      return null;
    }
  }

  private makeBody(e: Ent): BodyIO {
    const def = e.def;
    const ph = def.physics;
    if (ph.body === 'none') return new FreeIO(e.x, e.y, def.rotation);
    const spec = shapeFor(def.drawing, ph.shape, ph.body, def.w, def.h);
    const s = def.scale;
    const parts: Any[] = [];
    const sc = (p: Pt): Pt => [p[0] * s, p[1] * s];
    const mkPoly = (poly: Pt[]): Any | null => {
      const verts = poly.map((p) => ({ x: p[0] * s, y: p[1] * s }));
      if (verts.length < 3) return null;
      const c = M.Vertices.centre(verts);
      const b = M.Bodies.fromVertices(c.x, c.y, [verts], {}, false);
      return b && b.vertices?.length ? b : null;
    };
    if (spec.kind === 'circle') parts.push(M.Bodies.circle(spec.cx * s, spec.cy * s, spec.r * s));
    else if (spec.kind === 'box') parts.push(M.Bodies.rectangle(spec.cx * s, spec.cy * s, spec.w * s, spec.h * s, { chamfer: { radius: Math.min(spec.w, spec.h) * s * 0.12 } }));
    else if (spec.kind === 'poly') for (const p of spec.parts) {
      const b = mkPoly(p);
      if (b) parts.push(b);
    }
    else {
      for (const p of spec.parts ?? []) {
        const b = mkPoly(p);
        if (b) parts.push(b);
      }
      const joints = new Set<string>();
      for (const seg of spec.segments) {
        const a = sc(seg.a);
        const b = sc(seg.b);
        const r = seg.r * s;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len > 0.5) {
          parts.push(M.Bodies.rectangle((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, len, r * 2, { angle: Math.atan2(b[1] - a[1], b[0] - a[0]) }));
        }
        for (const p of [a, b]) {
          const k = `${Math.round(p[0])},${Math.round(p[1])}`;
          if (joints.has(k)) continue;
          joints.add(k);
          parts.push(M.Bodies.circle(p[0], p[1], r, {}, 8));
        }
      }
    }
    if (!parts.length) parts.push(M.Bodies.rectangle(0, 0, Math.max(8, e.w), Math.max(8, e.h)));
    const isStatic = ph.body === 'static' || ph.body === 'kinematic';
    const body = parts.length === 1 ? parts[0] : M.Body.create({ parts });
    const com = { x: body.position.x, y: body.position.y };
    M.Body.setStatic(body, false);
    M.Body.setDensity(body, 0.001 * ph.density);
    // bodies driven by a controller set their own speed: contact friction would only eat it
    const driven = e.behaviors.some((b) => ['platformer', 'patrol', 'ai_fighter', 'move_keys', 'follow'].includes(b.def.type));
    body.friction = driven ? 0 : Math.min(1, ph.friction);
    body.frictionStatic = driven ? 0 : 0.5 + ph.friction;
    body.restitution = Math.min(1, ph.bounce);
    body.frictionAir = 0.002; // Matter's 0.01 makes throws and jumps feel floaty
    body.slop = 0.04;
    for (const p of body.parts) p.isSensor = ph.sensor;
    body.isSensor = ph.sensor;
    const fixedRot = ph.fixed_rotation || e.behaviors.some((b) => ['platformer', 'ai_fighter', 'move_keys'].includes(b.def.type));
    if (fixedRot && !isStatic) M.Body.setInertia(body, Infinity);
    M.Body.rotate(body, (def.rotation * Math.PI) / 180, { x: 0, y: 0 });
    M.Body.translate(body, { x: e.x, y: e.y });
    if (isStatic) M.Body.setStatic(body, true);
    this.matter.world.add(body);
    this.bodyEnt.set(body, e);
    const io = new MatterIO(body, ph.body, this, e, fixedRot);
    io.ox = com.x;
    io.oy = com.y;
    return io;
  }

  private buildJoints(): void {
    // union-find so everything joined does not collide with itself
    const parent = new Map<Ent, Ent>();
    const find = (x: Ent): Ent => {
      let r = x;
      while (parent.get(r) && parent.get(r) !== r) r = parent.get(r)!;
      return r;
    };
    for (const e of this.world.ents) {
      if (!e.alive) continue;
      for (const j of e.def.joints) {
        const other = this.world.byId.get(j.to);
        if (!other || other === e || !other.alive) continue; // dangling joints are ignored
        const A = e.body as MatterIO;
        const B = other.body as MatterIO;
        if (!(A instanceof MatterIO) || !(B instanceof MatterIO)) continue;
        parent.set(find(e), find(other));
        const s1 = e.def.scale;
        const s2 = other.def.scale;
        const anchor = (io: MatterIO, p: [number, number], s: number): { x: number; y: number } => {
          const a = io.b.angle;
          const lx = p[0] * s - io.ox;
          const ly = p[1] * s - io.oy;
          return { x: Math.cos(a) * lx - Math.sin(a) * ly, y: Math.sin(a) * lx + Math.cos(a) * ly };
        };
        const pA = anchor(A, j.at, s1);
        const pB = anchor(B, j.to_at, s2);
        const wA = { x: A.b.position.x + pA.x, y: A.b.position.y + pA.y };
        const wB = { x: B.b.position.x + pB.x, y: B.b.position.y + pB.y };
        const dist = Math.hypot(wA.x - wB.x, wA.y - wB.y);
        const cons: Any[] = [];
        const add = (opts: Any): void => {
          const c = M.Constraint.create({ bodyA: A.b, bodyB: B.b, ...opts });
          this.matter.world.add(c);
          cons.push(c);
        };
        let length = 0;
        switch (j.type) {
          case 'wheel':
          case 'hinge':
            add({ pointA: pA, pointB: pB, length: 0, stiffness: j.type === 'wheel' ? 0.5 : 0.9, damping: 0.15 });
            break;
          case 'rope':
            length = j.length ?? dist;
            add({ pointA: pA, pointB: pB, length, stiffness: 0.8, damping: 0.05 });
            break;
          case 'spring':
            length = j.length ?? dist;
            add({ pointA: pA, pointB: pB, length, stiffness: 0.004 + j.stiffness * 0.08, damping: 0.04 });
            break;
          case 'weld': {
            add({ pointA: pA, pointB: pB, length: 0, stiffness: 0.9, damping: 0.1 });
            const off = { x: 24, y: 0 };
            const pA2 = { x: pA.x + off.x, y: pA.y + off.y };
            const w2 = { x: wA.x + off.x, y: wA.y + off.y };
            const pB2 = { x: w2.x - B.b.position.x, y: w2.y - B.b.position.y };
            add({ pointA: pA2, pointB: pB2, length: 0, stiffness: 0.9, damping: 0.1 });
            break;
          }
        }
        this.joints.push({ type: j.type, cons, a: e, b: other, length, motor: j.motor, speed: j.speed });
        if (j.type === 'wheel') {
          A.wheelList.push({ body: B, radius: wheelRadius(other), motor: j.motor });
          if (!other.rules.length && !other.behaviors.length) other.root = e;
        } else if (j.type === 'weld' && !other.rules.length && !other.behaviors.length) other.root = e;
      }
    }
    for (const e of this.world.ents) {
      if (!parent.has(e)) continue;
      const r = find(e);
      let g = (r as Ent & { __group?: number }).__group;
      if (!g) {
        g = -(++this.groupSeq);
        (r as Ent & { __group?: number }).__group = g;
      }
      const io = e.body as MatterIO;
      if (io instanceof MatterIO) io.b.collisionFilter.group = g;
    }
  }

  private buildEdges(): void {
    const { width: W, height: H, edges } = this.scn.world;
    const T = 400;
    const wall = (x: number, y: number, w: number, h: number): void => {
      const b = M.Bodies.rectangle(x, y, w, h, { isStatic: true, friction: 0.4, label: 'edge' });
      this.matter.world.add(b);
      this.edges.push(b);
    };
    if (edges === 'walls') {
      wall(W / 2, -T / 2, W + T * 2, T);
      wall(-T / 2, H / 2, T, H + T * 2);
      wall(W + T / 2, H / 2, T, H + T * 2);
    }
    if (edges === 'walls' || edges === 'floor') wall(W / 2, H + T / 2, W + T * 2, T);
  }

  private buildBackground(): void {
    const layers = backgroundLayers(this.link.doc.theme);
    for (const layer of layers) {
      const key = `bg_${hashStr(String(layers.indexOf(layer)) + JSON.stringify(this.link.theme.background) + this.link.theme.id + JSON.stringify(this.link.theme.palette))}`;
      if (!this.textures.exists(key)) this.textures.addCanvas(key, layer.canvas);
      let s: Phaser.GameObjects.TileSprite | Phaser.GameObjects.Image;
      if (!layer.tileX && !layer.tileY) s = this.add.image(0, 0, key).setOrigin(0, 0).setDisplaySize(REF_W, REF_H);
      else s = this.add.tileSprite(0, 0, REF_W, layer.anchor === 'fill' ? REF_H : layer.canvas.height, key).setOrigin(0, 0);
      this.bgLayer.add(s);
      this.bgSprites.push({ s, layer });
    }
  }

  private updateBackground(): void {
    const cam = { x: this.worldCam.scrollX + (REF_W - REF_W / this.worldCam.zoom) / 2, y: this.worldCam.scrollY + (REF_H - REF_H / this.worldCam.zoom) / 2,
      zoom: this.worldCam.zoom };
    const par = this.link.theme.background.parallax;
    for (const { s, layer } of this.bgSprites) {
      if (!(s instanceof Phaser.GameObjects.TileSprite)) continue;
      const p = layerPlacement(layer, this.scn.world, cam, { w: REF_W, h: REF_H }, par);
      s.setPosition(p.x, p.y);
      s.setSize(p.w, layer.anchor === 'fill' ? p.h : layer.canvas.height * p.tileScale);
      s.setTileScale(p.tileScale, p.tileScale);
      s.tilePositionX = p.tileX;
      s.tilePositionY = p.tileY;
    }
  }

  // ---- camera --------------------------------------------------------------------------------------

  private setupCamera(): void {
    const wd = this.scn.world;
    const cam = wd.camera;
    if (cam.mode === 'fixed') this.camBaseZoom = Math.min(REF_W / wd.width, REF_H / wd.height);
    else this.camBaseZoom = 1;
    this.camZoom = cam.zoom;
    const target = (cam.target && this.world.byId.get(cam.target)) || this.world.playerEnt(1);
    this.camTarget = cam.mode === 'follow' ? target ?? null : null;
    if (cam.mode === 'fixed') {
      this.camX = wd.width / 2;
      this.camY = wd.height / 2;
    } else if (cam.mode === 'auto_scroll') {
      const vw = REF_W / (this.camBaseZoom * this.camZoom);
      const vh = REF_H / (this.camBaseZoom * this.camZoom);
      this.camX = cam.axis === 'y' ? wd.width / 2 : vw / 2;
      this.camY = cam.axis === 'y' ? wd.height - vh / 2 : target ? target.y : wd.height - vh / 2;
      if (cam.axis !== 'y') this.camY = Math.min(wd.height - vh / 2, Math.max(vh / 2, this.camY));
    } else if (target) {
      this.camX = target.x;
      this.camY = target.y;
    }
    this.applyCamera(0, true);
  }

  private applyCamera(dt: number, snap = false): void {
    const wd = this.scn.world;
    const cam = wd.camera;
    const zoom = this.camBaseZoom * this.camZoom;
    const z = snap ? zoom : this.worldCam.zoom + (zoom - this.worldCam.zoom) * Math.min(1, dt * 4);
    this.worldCam.setZoom(z);
    const vw = REF_W / z;
    const vh = REF_H / z;
    if (cam.mode === 'auto_scroll' && !this.world.over) {
      if (cam.axis === 'y') this.camY -= cam.speed * dt * this.timeScale;
      else this.camX += cam.speed * dt * this.timeScale;
      const p = this.world.playerEnt(1);
      if (p && cam.axis === 'x') this.camY += (Math.min(wd.height - vh / 2, p.y) - this.camY) * Math.min(1, dt * 2);
      if (p && cam.axis === 'y') this.camX += (p.x - this.camX) * Math.min(1, dt * 2);
    } else if (this.camTarget && this.camTarget.alive) {
      const t = this.camTarget;
      const look = Math.max(-220, Math.min(220, (t.body?.vx ?? 0) * 0.3));
      const tx = t.x + look;
      const ty = t.y - vh * 0.08;
      const dzx = vw * 0.06;
      const dzy = vh * 0.08;
      const k = snap ? 1 : 1 - Math.exp(-dt * 5);
      if (cam.axis !== 'y') {
        const dx = tx - this.camX;
        if (Math.abs(dx) > dzx) this.camX += (dx - Math.sign(dx) * dzx) * k;
      }
      if (cam.axis !== 'x') {
        const dy = ty - this.camY;
        if (Math.abs(dy) > dzy) this.camY += (dy - Math.sign(dy) * dzy) * k;
      } else if (snap) this.camY = ty;
    }
    // clamp to the world (centre it when it is smaller than the view)
    const cx = wd.width <= vw ? wd.width / 2 : Math.max(vw / 2, Math.min(wd.width - vw / 2, this.camX));
    const cy = wd.height <= vh ? wd.height / 2 : Math.max(vh / 2, Math.min(wd.height - vh / 2, this.camY));
    if (cam.mode !== 'auto_scroll' || cam.axis === 'y') this.camX = cx;
    else this.camX = Math.min(this.camX, Math.max(vw / 2, wd.width - vw / 2));
    if (cam.mode !== 'auto_scroll' || cam.axis === 'x') this.camY = cy;
    else this.camY = Math.max(this.camY, vh / 2);
    this.worldCam.centerOn(this.camX, this.camY);
    this.world.view = { x: this.camX - vw / 2, y: this.camY - vh / 2, w: vw, h: vh };
  }

  shake(power: number): void {
    const p = Math.max(0.1, Math.min(5, power));
    this.worldCam.shake(120 + p * 90, 0.0025 * p + 0.002);
  }

  // ---- input ----------------------------------------------------------------------------------------

  private setupPointer(): void {
    const inp = this.link.input;
    const toWorld = (p: Phaser.Input.Pointer): { x: number; y: number } => this.worldCam.getWorldPoint(p.x, p.y);
    const tapKey = this.tapToSpace();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      this.link.sound.resume();
      const w = toWorld(p);
      inp.pointerDown(w.x, w.y);
      const hit = this.world.hitTest(w.x, w.y, 6);
      if (hit) this.world.clicked(hit);
      if (tapKey) {
        inp.keyDown('Space');
        this.world.key('key_down', 'Space');
      }
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      const w = toWorld(p);
      inp.pointerMove(w.x, w.y);
    });
    const up = (): void => {
      inp.pointerUp();
      if (tapKey && inp.down.has('Space')) {
        inp.keyUp('Space');
        this.world.key('key_up', 'Space');
      }
    };
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', up);
  }

  /** Games played with the space key and no pointer controls: a tap anywhere is space (flappy on a phone). */
  private tapToSpace(): boolean {
    const objs = this.scn.objects;
    const pointerUsed = objs.some((o) => o.behaviors.some((b) => b.type === 'launcher' || b.type === 'draggable'
      || (b.type === 'shooter' && (b.params.key === 'click' || b.params.direction === 'mouse')))
      || o.rules.some((r) => r.when.type === 'clicked'));
    if (pointerUsed) return false;
    const rules = [...this.link.doc.rules, ...this.scn.rules, ...objs.flatMap((o) => o.rules)];
    return rules.some((r) => r.when.type === 'key_down' && r.when.params.key === 'space');
  }

  // ---- stepping ---------------------------------------------------------------------------------------

  override update(_time: number, delta: number): void {
    if (this.link.isPaused()) return;
    const dtFrame = Math.min(0.1, delta / 1000);
    this.elapsed += dtFrame;
    if (this.hitStop > 0) {
      this.hitStop -= dtFrame;
      this.updateViews(dtFrame * 0.2);
      return;
    }
    if (this.timeScaleLeft > 0) {
      this.timeScaleLeft -= dtFrame;
      if (this.timeScaleLeft <= 0) this.timeScale = 1;
    }
    this.acc += Math.min(100, delta);
    let steps = 0;
    while (this.acc >= STEP_MS && steps < 4) {
      this.acc -= STEP_MS;
      steps++;
      this.fixedStep((STEP_MS / 1000) * this.timeScale);
    }
    if (steps >= 4) this.acc = 0;
    this.applyCamera(dtFrame);
    this.updateBackground();
    this.updateViews(dtFrame);
    this.updateEngineSound();
  }

  private fixedStep(dt: number): void {
    const w = this.world;
    // sync entity state from bodies
    for (const e of w.ents) {
      if (!e.alive || !e.body) continue;
      e.x = e.body.x;
      e.y = e.body.y;
      e.angle = e.body.angle;
      e.vx = e.body.vx;
      e.vy = e.body.vy;
    }
    stepBehaviors(w, this.controls, dt);
    // motors without a car, ropes go slack
    for (const j of this.joints) {
      if (!j.a.alive || !j.b.alive) continue;
      if (j.motor && j.speed && !w.hasBeh(j.a, 'car')) j.b.body?.setAngularVelocity(j.speed);
      if (j.type === 'rope') {
        const c = j.cons[0];
        const pa = M.Constraint.pointAWorld(c);
        const pb = M.Constraint.pointBWorld(c);
        c.stiffness = Math.hypot(pa.x - pb.x, pa.y - pb.y) > j.length ? 0.8 : 0.000001;
      }
    }
    // gravity per body (gravity_scale), kinematic and free movement
    const [gx, gy] = w.gravity;
    for (const e of w.ents) {
      if (!e.alive || !e.body) continue;
      const b = e.body;
      if (b instanceof MatterIO) {
        if (b.kind === 'kinematic') b.integrate(dt);
        else if (!b.b.isStatic && e.shown) {
          const k = b.b.mass * MATTER_G * e.def.physics.gravity_scale;
          b.b.force.x += gx * k;
          b.b.force.y += gy * k;
        }
        b.grounded = false;
      } else if (b instanceof FreeIO) b.integrate(dt);
    }
    this.matter.world.step(STEP_MS * this.timeScale);
    // world edges
    const wd = this.scn.world;
    for (const e of w.ents) {
      if (!e.alive || !e.body || e.def.template) continue;
      const b = e.body;
      if (b.kind === 'static') continue;
      if (wd.edges === 'wrap' && !w.hasBeh(e, 'wrap')) wrapEnt(w, e);
      const below = gy >= 0 ? b.y > wd.height + 400 : b.y < -400;
      const side = wd.edges === 'none' && (b.x < -600 || b.x > wd.width + 600);
      let behind = false;
      if (wd.camera.mode === 'auto_scroll' && b.kind !== 'none') {
        const v = w.view;
        behind = wd.camera.axis === 'y' ? b.y - e.h / 2 > v.y + v.h + 60 : b.x + e.w / 2 < v.x - 60;
      }
      if (below || side || behind) w.outOfBounds(e);
    }
    w.tick(dt);
    w.processEvents();
    this.link.input.endStep();
  }

  // ---- contacts -------------------------------------------------------------------------------------

  private onPairs(pairs: Any[], kind: 'begin' | 'active' | 'end'): void {
    const seen = new Set<string>();
    const gx = this.world.gravity[0];
    const gy = this.world.gravity[1];
    const gl = Math.hypot(gx, gy);
    const gdx = gl ? gx / gl : 0;
    const gdy = gl ? gy / gl : 1;
    for (const pair of pairs) {
      const pa = pair.bodyA;
      const pb = pair.bodyB;
      const A = this.bodyEnt.get(pa.parent);
      const B = this.bodyEnt.get(pb.parent);
      // grounding (also against the world's edge walls)
      if (kind !== 'end' && !pair.isSensor && pair.collision) {
        let nx = pair.collision.normal.x;
        let ny = pair.collision.normal.y;
        if (nx * (pb.position.x - pa.position.x) + ny * (pb.position.y - pa.position.y) < 0) {
          nx = -nx;
          ny = -ny;
        }
        // n points from A to B
        if (A && A.body instanceof MatterIO && nx * gdx + ny * gdy > 0.6) {
          A.body.grounded = true;
          A.body.groundVx = B?.body ? B.body.vx : 0;
        }
        if (B && B.body instanceof MatterIO && -nx * gdx - ny * gdy > 0.6) {
          B.body.grounded = true;
          B.body.groundVx = A?.body ? A.body.vx : 0;
        }
        if (A && B) this.contactPair(kind, A, B, false, nx, ny, seen);
        continue;
      }
      if (A && B) {
        let nx = 0;
        let ny = 0;
        if (pair.collision) {
          nx = pair.collision.normal.x;
          ny = pair.collision.normal.y;
          if (nx * (pb.position.x - pa.position.x) + ny * (pb.position.y - pa.position.y) < 0) {
            nx = -nx;
            ny = -ny;
          }
        }
        this.contactPair(kind, A, B, !!pair.isSensor, nx, ny, seen);
      }
    }
  }

  private contactPair(kind: 'begin' | 'active' | 'end', a0: Ent, b0: Ent, sensor: boolean, nx: number, ny: number, seen: Set<string>): void {
    // wheels and welded parts count as the thing they belong to
    const a = a0.root && a0.root.alive ? a0.root : a0;
    const b = b0.root && b0.root.alive ? b0.root : b0;
    if (a === b) return;
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    let speed = 0;
    if (kind === 'begin') {
      const va = a0.body;
      const vb = b0.body;
      speed = Math.hypot((va?.vx ?? 0) - (vb?.vx ?? 0), (va?.vy ?? 0) - (vb?.vy ?? 0));
    }
    this.world.contact(kind, a, b, sensor, nx, ny, speed);
  }

  /** Something solid at a point (patrol ledge checks). */
  solidAt(x: number, y: number, except: Any): boolean {
    const bodies = (this.matter.world.localWorld as Any).bodies.filter((b: Any) => b !== except && !b.isSensor);
    return M.Query.point(bodies, { x, y }).length > 0;
  }

  // ---- entity changes ---------------------------------------------------------------------------------

  private removeEnt(e: Ent, fx: 'poof' | 'quiet'): void {
    const v = this.views.get(e);
    if (e.body instanceof MatterIO) {
      const b = e.body.b;
      for (const j of this.joints) if (j.a === e || j.b === e) for (const c of j.cons) this.matter.world.remove(c);
      this.matter.world.remove(b);
      this.bodyEnt.delete(b);
    }
    if (v) {
      if (fx === 'poof') {
        this.burst('poof', e.x, e.y, 12, v.color);
        this.link.sound.play('poof');
      }
      this.tweens.add({ targets: v.c, scale: v.c.scale * (fx === 'poof' ? 1.25 : 0.6), alpha: 0, duration: fx === 'poof' ? 160 : 220,
        onComplete: () => v.c.destroy() });
      v.bar?.destroy();
      this.views.delete(e);
    }
  }

  private setShown(e: Ent, shown: boolean): void {
    const v = this.views.get(e);
    if (v) v.c.setVisible(shown);
    if (e.body instanceof MatterIO) {
      const b = e.body.b;
      b.collisionFilter.mask = shown ? 0xffffffff : 0;
    }
  }

  private setSensor(e: Ent, sensor: boolean): void {
    if (e.body instanceof MatterIO) {
      e.body.b.isSensor = sensor;
      for (const p of e.body.b.parts) p.isSensor = sensor;
    }
  }

  // ---- juice ------------------------------------------------------------------------------------------

  private makeParticleTextures(): void {
    if (this.textures.exists('p_dot')) return;
    const g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1);
    g.fillCircle(8, 8, 8);
    g.generateTexture('p_dot', 16, 16);
    g.clear();
    g.fillStyle(0xffffff, 1);
    g.fillRect(0, 0, 10, 6);
    g.generateTexture('p_rect', 10, 6);
    g.clear();
    g.fillStyle(0xffffff, 1);
    const star: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? 4 : 10;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      star.push(10 + Math.cos(a) * r, 10 + Math.sin(a) * r);
    }
    g.fillPoints(star.reduce<Phaser.Math.Vector2[]>((acc, _, i) => (i % 2 ? acc : [...acc, new Phaser.Math.Vector2(star[i], star[i + 1])]), []), true);
    g.generateTexture('p_star', 20, 20);
    g.clear();
    g.lineStyle(2, 0xffffff, 1);
    g.strokeCircle(8, 8, 6);
    g.generateTexture('p_ring', 16, 16);
    g.destroy();
  }

  private makeEmitters(): void {
    const P = this.link.theme.palette;
    const mk = (key: string, tex: string, cfg: Phaser.Types.GameObjects.Particles.ParticleEmitterConfig): void => {
      const em = this.add.particles(0, 0, tex, { emitting: false, ...cfg });
      em.setDepth(1e6 - 2);
      this.worldLayer.add(em);
      this.emitters[key] = em;
    };
    const dust = mix(P.bg, P.ink, 0.35);
    mk('dust', 'p_dot', { speed: { min: 30, max: 140 }, angle: { min: 180, max: 360 }, scale: { start: 0.7, end: 0 }, alpha: { start: 0.6, end: 0 },
      lifespan: 420, gravityY: -40, tint: hexNum(dust) });
    mk('sparks', 'p_rect', { speed: { min: 160, max: 520 }, scale: { start: 0.9, end: 0 }, lifespan: 300, rotate: { min: 0, max: 360 },
      tint: [hexNum(P.accent), 0xffffff, hexNum(P.accent2)], blendMode: 'ADD' });
    mk('stars', 'p_star', { speed: { min: 80, max: 300 }, scale: { start: 0.9, end: 0 }, lifespan: 600, rotate: { min: 0, max: 360 },
      tint: [hexNum(P.accent), hexNum(P.accent2), 0xffffff], gravityY: 300 });
    mk('poof', 'p_dot', { speed: { min: 40, max: 220 }, scale: { start: 1, end: 0 }, alpha: { start: 0.9, end: 0 }, lifespan: 380 });
    mk('confetti', 'p_rect', { speed: { min: 200, max: 700 }, angle: { min: 220, max: 320 }, gravityY: 700, rotate: { min: 0, max: 360 },
      scale: { start: 1.2, end: 0.6 }, lifespan: 2200, tint: [hexNum(P.accent), hexNum(P.accent2), hexNum(P.good), hexNum(P.danger), 0xffe36e] });
    mk('flame', 'p_dot', { speed: { min: 60, max: 160 }, scale: { start: 0.7, end: 0 }, alpha: { start: 0.9, end: 0 }, lifespan: 300,
      tint: [0xffd166, 0xff7b00, hexNum(P.accent)], blendMode: 'ADD' });
    mk('ring', 'p_ring', { speed: 0, scale: { start: 0.5, end: 4 }, alpha: { start: 0.8, end: 0 }, lifespan: 380, tint: 0xffffff });
    // ambient weather for some themes
    const amb = this.link.theme.particles;
    if (amb === 'snow' || amb === 'embers' || amb === 'bubbles') {
      const em = this.add.particles(0, 0, amb === 'bubbles' ? 'p_ring' : 'p_dot', {
        x: { min: 0, max: REF_W }, y: amb === 'snow' ? -10 : REF_H + 10, lifespan: 7000, frequency: 160,
        speedY: amb === 'snow' ? { min: 40, max: 90 } : { min: -90, max: -40 }, speedX: { min: -20, max: 20 },
        scale: amb === 'bubbles' ? { min: 0.5, max: 1.4 } : { min: 0.15, max: 0.45 }, alpha: { start: 0.8, end: 0.1 },
        tint: amb === 'embers' ? [0xff7b00, 0xffd166] : 0xffffff, blendMode: amb === 'embers' ? 'ADD' : 'NORMAL',
      });
      em.setScrollFactor(0);
      this.bgLayer.add(em);
    }
  }

  burst(kind: string, x: number, y: number, n: number, tint?: number): void {
    const em = this.emitters[kind];
    if (!em) return;
    if (tint !== undefined) em.setParticleTint(tint);
    em.explode(n, x, y);
  }

  private themeBurst(x: number, y: number, n: number): void {
    const p = this.link.theme.particles;
    const kind = p === 'none' ? '' : p === 'confetti' ? 'stars' : p === 'snow' || p === 'bubbles' || p === 'embers' ? 'sparks' : p;
    if (kind) this.burst(kind, x, y, n);
  }

  fx(name: FxName, e: Ent, d: { x?: number; y?: number; power?: number; other?: Ent } = {}): void {
    const v = this.views.get(e);
    const snd = this.link.sound;
    const feet = e.y + e.h / 2;
    switch (name) {
      case 'jump':
        if (v) {
          v.sx = 0.78;
          v.sy = 1.25;
        }
        if (this.link.theme.particles !== 'none') this.burst('dust', e.x, feet, 6);
        snd.play('jump', { pitch: d.power === 2 ? 1.25 : 1 });
        break;
      case 'land': {
        const p = Math.min(1.6, 0.5 + (d.power ?? 1) * 0.5);
        if (v) {
          v.sx = 1 + 0.28 * p;
          v.sy = 1 - 0.24 * p;
        }
        if (this.link.theme.particles !== 'none') this.burst('dust', e.x, feet, Math.round(4 + p * 6));
        snd.play('land', { gain: p });
        break;
      }
      case 'hit':
        if (v) {
          v.flash = 0.12;
          v.sx = 1.2;
          v.sy = 0.85;
        }
        this.burst('sparks', e.x, e.y, 14);
        this.shake(e.player > 0 ? 1 : 0.5);
        this.hitStop = e.player > 0 || (d.other && d.other.player > 0) ? 0.06 : 0.03;
        snd.play('hit');
        break;
      case 'pickup':
        this.themeBurst(e.x, e.y, 10);
        this.burst('ring', e.x, e.y, 1);
        this.floatText(e.x, e.y - e.h / 2, '+', this.link.theme.palette.accent);
        snd.play('coin');
        break;
      case 'swing':
        if (v) v.swing = 1;
        this.burst('ring', e.x + e.facing * (e.w / 2 + 20), e.y, 1);
        snd.play('swing');
        break;
      case 'shoot':
        this.burst('sparks', d.x ?? e.x, d.y ?? e.y, 4);
        if (v) {
          v.sx = 0.9;
          v.sy = 1.08;
        }
        snd.play('zap', { pitch: 0.9 + Math.random() * 0.2, gain: 0.6 });
        break;
      case 'launch':
        if (v) {
          v.sx = 1.3;
          v.sy = 0.75;
        }
        this.shake(0.4 + (d.power ?? 0.5));
        snd.play('whoosh');
        break;
      case 'boing':
        if (v) {
          v.sx = 1.3;
          v.sy = 0.7;
        }
        if (d.other) {
          const ov = this.views.get(d.other);
          if (ov) {
            ov.sx = 0.75;
            ov.sy = 1.3;
          }
        }
        snd.play('boing');
        break;
      case 'checkpoint':
        if (v) this.tweens.add({ targets: v.inner, angle: { from: -12, to: 0 }, duration: 600, ease: 'Elastic.Out' });
        this.themeBurst(e.x, e.y - e.h / 2, 12);
        snd.play('checkpoint');
        break;
      case 'goal':
        this.burst('confetti', e.x, e.y, 40);
        break;
      case 'spawn':
        if (v) {
          v.sx = 0.5;
          v.sy = 0.5;
        }
        break;
      case 'heal':
        this.burst('stars', e.x, e.y, 8, hexNum(this.link.theme.palette.good));
        snd.play('heal');
        break;
      case 'respawn':
        if (v) {
          v.sx = 0.4;
          v.sy = 1.6;
        }
        this.burst('ring', e.x, e.y, 1);
        snd.play('spawn');
        break;
      case 'thrust': {
        const a = ((e.body?.angle ?? e.angle) * Math.PI) / 180;
        this.burst('flame', e.x - Math.sin(a) * e.h * 0.5, e.y + Math.cos(a) * e.h * 0.5, 2);
        snd.play('thrust', { gain: 0.5 });
        break;
      }
      case 'poof':
        this.burst('poof', e.x, e.y, 10, v?.color);
        snd.play('poof');
        break;
    }
  }

  floatText(x: number, y: number, text: string, color: string): void {
    const t = this.add.text(x, y, text, { fontFamily: 'Patrick Hand, sans-serif', fontSize: '34px', color, stroke: '#000000', strokeThickness: 3 })
      .setOrigin(0.5).setDepth(1e6 + 2);
    this.worldLayer.add(t);
    this.tweens.add({ targets: t, y: y - 60, alpha: 0, duration: 700, ease: 'Cubic.Out', onComplete: () => t.destroy() });
  }

  say(e: Ent | null, text: string, secs: number): void {
    if (!e) {
      this.link.say(text);
      return;
    }
    // one bubble per speaker
    for (const b of this.bubbles.filter((x) => x.e === e)) b.t.destroy();
    this.bubbles = this.bubbles.filter((x) => x.e !== e);
    const P = this.link.theme.palette;
    const txt = this.add.text(0, 0, text, { fontFamily: 'Patrick Hand, Comic Sans MS, sans-serif', fontSize: '28px', color: '#1f1b18',
      wordWrap: { width: 340 }, align: 'center' }).setOrigin(0.5, 1);
    const w = txt.width + 28;
    const h = txt.height + 18;
    const g = this.add.graphics();
    g.fillStyle(0xffffff, 0.96);
    g.lineStyle(3, hexNum(P.ink), 1);
    g.fillRoundedRect(-w / 2, -h - 10, w, h, 14);
    g.strokeRoundedRect(-w / 2, -h - 10, w, h, 14);
    g.fillTriangle(-10, -11, 10, -11, 0, 2);
    g.lineBetween(-10, -10, 0, 2);
    g.lineBetween(10, -10, 0, 2);
    txt.setPosition(0, -19);
    const c = this.add.container(e.x, e.y - e.h / 2 - 8, [g, txt]).setDepth(1e6 + 3);
    c.setScale(0.3);
    this.tweens.add({ targets: c, scale: 1, duration: 220, ease: 'Back.Out' });
    this.worldLayer.add(c);
    this.bubbles.push({ e, t: c, until: this.elapsed + secs });
    this.link.sound.play('blip');
  }

  // ---- per-frame view update -------------------------------------------------------------------------

  private updateViews(dt: number): void {
    const w = this.world;
    const k = 1 - Math.exp(-dt * 14);
    this.bars.clear();
    for (const [e, v] of this.views) {
      if (!e.alive) continue;
      v.c.setPosition(e.body ? e.body.x : e.x, (e.body ? e.body.y : e.y) + e.bob);
      const ang = e.faceAngle !== null ? e.faceAngle : e.body ? e.body.angle : e.angle;
      v.c.setRotation((ang * Math.PI) / 180);
      v.sx += (1 - v.sx) * k;
      v.sy += (1 - v.sy) * k;
      const fl = v.flip ? e.facing : 1;
      v.inner.setScale(v.sx * fl, v.sy);
      if (v.swing > 0) {
        v.swing = Math.max(0, v.swing - dt * 5);
        v.inner.setAngle(Math.sin(v.swing * Math.PI) * 18 * e.facing);
      } else if (v.inner.angle !== 0 && !this.tweens.isTweening(v.inner)) v.inner.setAngle(0);
      if (v.flash > 0) {
        v.flash -= dt;
        for (const img of v.imgs) img.setTintFill(0xffffff);
        if (v.flash <= 0) for (const img of v.imgs) img.clearTint();
      }
      v.c.setAlpha(e.invuln > 0 ? (Math.sin(this.elapsed * 40) > 0 ? 1 : 0.35) : 1);
      if (v.bar) this.drawBar(v.bar, e);
    }
    // launcher aim arcs
    this.aim.clear();
    for (const e of w.ents) {
      if (!e.alive) continue;
      const a = launcherAim(e);
      if (!a) continue;
      const vx = -a.px * a.k;
      const vy = -a.py * a.k;
      const g = w.gravity[1] * G_PX * e.def.physics.gravity_scale;
      this.aim.lineStyle(4, hexNum(this.link.theme.palette.ink), 0.55);
      this.aim.lineBetween(a.ax, a.ay, a.ax + a.px, a.ay + a.py);
      this.aim.fillStyle(hexNum(this.link.theme.palette.ink), 0.6);
      for (let i = 1; i < 26; i++) {
        const t = i * 0.06;
        this.aim.fillCircle(a.ax + a.px + vx * t, a.ay + a.py + vy * t + 0.5 * g * t * t, Math.max(2, 6 - i * 0.18));
      }
    }
    for (const b of this.bubbles) {
      if (b.e && b.e.alive) b.t.setPosition(b.e.x, b.e.y - b.e.h / 2 - 8 + b.e.bob);
      if (this.elapsed > b.until || (b.e && !b.e.alive)) {
        const t = b.t;
        this.tweens.add({ targets: t, alpha: 0, scale: 0.8, duration: 180, onComplete: () => t.destroy() });
        b.until = Infinity;
        b.e = null;
      }
    }
    this.bubbles = this.bubbles.filter((b) => b.until !== Infinity);
  }

  private drawBar(g: Phaser.GameObjects.Graphics, e: Ent): void {
    g.clear();
    const max = this.world.healthMax(e);
    const hp = Math.max(0, e.counters.health ?? 0);
    const w = Math.max(50, Math.min(140, e.w));
    const x = e.x - w / 2;
    const y = e.y - e.h / 2 - 22 + e.bob;
    const P = this.link.theme.palette;
    g.fillStyle(0x000000, 0.35);
    g.fillRoundedRect(x - 2, y - 2, w + 4, 12, 6);
    g.fillStyle(hexNum(hp / max > 0.35 ? P.good : P.danger), 1);
    g.fillRoundedRect(x, y, Math.max(0, (w * hp) / max), 8, 4);
  }

  private updateEngineSound(): void {
    const car = this.world.ents.find((e) => e.alive && e.player > 0 && e.behaviors.some((b) => b.on && b.def.type === 'car'));
    if (!car) {
      if (this.engineLevel) this.link.sound.engine(0);
      this.engineLevel = 0;
      return;
    }
    const thr = Math.abs(Number(car.behaviors.find((b) => b.def.type === 'car')?.s.throttle ?? 0));
    const target = this.world.over ? 0 : 0.15 + thr * 0.6 + Math.min(0.25, Math.abs(car.body?.vx ?? 0) / 3000);
    this.engineLevel += (target - this.engineLevel) * 0.1;
    this.link.sound.engine(this.engineLevel);
  }
}

function wheelRadius(e: Ent): number {
  return Math.max(4, (Math.max(e.def.w, e.def.h) * e.def.scale) / 2);
}

function inkIn(d: Drawing, x: number, y: number, w: number, h: number): boolean {
  for (const s of d.strokes ?? []) {
    const pts = s.points ?? [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      if (p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h) return true;
      const q = pts[i + 1];
      if (q && Math.min(p[0], q[0]) <= x + w && Math.max(p[0], q[0]) >= x && Math.min(p[1], q[1]) <= y + h && Math.max(p[1], q[1]) >= y) return true;
    }
  }
  return false;
}

const shotDrawings = new Map<string, Drawing>();
function DEFAULT_SHOT_DRAWING(color: string, pts: [number, number][]): Drawing {
  let d = shotDrawings.get(color);
  if (!d) {
    d = { strokes: [{ points: pts as [[number, number], ...[number, number][]], color, width: 4, closed: true, fill: color }], w: 14, h: 14 };
    shotDrawings.set(color, d);
  }
  return d;
}
