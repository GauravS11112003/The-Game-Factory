/**
 * InkBoilFX (PLAN_V2 §7.5): a WebGL PostFX pipeline on the camera that draws the decoration, terrain and entity
 * layers. It displaces UVs by a 3-frame noise field (amplitude 0.7 logical px) that switches frame every 6 sim frames
 * (10 fps). The noise is computed in the shader (periodic hashed value noise, anchored to world x), so it needs no
 * texture variants and memory never grows. Off under prefers-reduced-motion, when fps < 50 for 2 s, and on the
 * Canvas renderer. Physics never boils.
 */
import Phaser from 'phaser';

const FRAG = `
#define SHADER_NAME DAL_INK_BOIL_FS
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D uMainSampler;
uniform vec2 uResolution;
uniform vec2 uOffset;
uniform float uFrame;
uniform float uAmp;
uniform float uCell;
varying vec2 outTexCoord;

float hash(vec2 p) {
  p = mod(p, 256.0);
  p = fract(p * vec2(0.1031, 0.1030));
  p += dot(p, p.yx + 33.33);
  return fract((p.x + p.y) * p.x);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash(i);
  float b = hash(i + vec2(1.0, 0.0));
  float c = hash(i + vec2(0.0, 1.0));
  float d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
void main() {
  vec2 px = outTexCoord * uResolution;
  vec2 w = vec2(px.x + uOffset.x, uResolution.y - px.y + uOffset.y) / uCell + vec2(uFrame * 37.0, uFrame * 71.0);
  vec2 d = vec2(vnoise(w), vnoise(w + vec2(91.0, 17.0))) * 2.0 - 1.0;
  gl_FragColor = texture2D(uMainSampler, outTexCoord + d * uAmp / uResolution);
}
`;

export const INK_BOIL_KEY = 'InkBoilFX';

export class InkBoilFX extends Phaser.Renderer.WebGL.Pipelines.PostFXPipeline {
  boilFrame = 0;
  ampPx = 0.7; // logical px
  renderScale = 1;
  scrollPx = 0; // camera scroll, logical px (noise is anchored to the world)

  constructor(game: Phaser.Game) {
    super({ game, name: INK_BOIL_KEY, fragShader: FRAG });
  }

  override onPreRender(): void {
    const r = this.renderScale;
    const cell = 7 * r; // noise feature ≈ 7 logical px: a hand-drawn wobble, not a shimmer
    const period = cell * 256; // the hash repeats every 256 lattice cells: wrap the offset seamlessly
    const off = ((this.scrollPx * r) % period + period) % period;
    this.set1f('uFrame', this.boilFrame);
    this.set1f('uAmp', this.ampPx * r);
    this.set1f('uCell', cell);
    this.set2f('uResolution', this.renderer.width, this.renderer.height);
    this.set2f('uOffset', off, 0);
  }
}

/** Register the pipeline once per game; false on the Canvas renderer (no boil there). */
export function registerInkBoil(game: Phaser.Game): boolean {
  const r = game.renderer;
  if (!(r instanceof Phaser.Renderer.WebGL.WebGLRenderer)) return false;
  try {
    const pm = r.pipelines;
    if (!pm.postPipelineClasses.has(INK_BOIL_KEY)) pm.addPostPipeline(INK_BOIL_KEY, InkBoilFX);
    return true;
  } catch {
    return false;
  }
}
