/**
 * HUD: coins/total, timer countdown, deaths, restart (key R too) and a small
 * debug toggle when the game was mounted with debug on (PLAN.md section 10).
 * Drawn inside the Phaser canvas so it scales with the game.
 */
import Phaser from 'phaser';
import { GAME_H, GAME_W } from './constants';
import { INK, INK_SOFT, RED_DARK } from './tiles';

export const HUD_FONT = '"Chalkboard SE", "Comic Sans MS", "Marker Felt", "Segoe Print", cursive';

export interface HudOptions {
  totalCoins: number;
  hasTimer: boolean;
  debug: boolean;
  onRestart: () => void;
  onToggleDebug?: (on: boolean) => void;
}

const TEXT_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: HUD_FONT,
  fontSize: '16px',
  color: INK,
  stroke: '#ffffff',
  strokeThickness: 3,
};

export class Hud {
  private readonly scene: Phaser.Scene;
  private readonly opts: HudOptions;
  private readonly objects: Phaser.GameObjects.GameObject[] = [];
  private coinsText!: Phaser.GameObjects.Text;
  private deathsText!: Phaser.GameObjects.Text;
  private timerText: Phaser.GameObjects.Text | null = null;
  private debugText: Phaser.GameObjects.Text | null = null;
  private banner: Phaser.GameObjects.Container | null = null;
  private debugOn: boolean;

  constructor(scene: Phaser.Scene, opts: HudOptions) {
    this.scene = scene;
    this.opts = opts;
    this.debugOn = opts.debug;
    this.build();
  }

  private add<T extends Phaser.GameObjects.GameObject & Phaser.GameObjects.Components.Depth>(obj: T): T {
    obj.setDepth(1000);
    if ('setScrollFactor' in obj) (obj as unknown as Phaser.GameObjects.Components.ScrollFactor).setScrollFactor(0);
    this.objects.push(obj);
    return obj;
  }

  private build(): void {
    const s = this.scene;
    const coin = this.add(s.add.image(16, 15, 'coin'));
    coin.setScale(1.1);
    this.coinsText = this.add(s.add.text(27, 5, '', TEXT_STYLE));
    this.deathsText = this.add(s.add.text(100, 5, '', TEXT_STYLE));
    this.setCoins(0);
    this.setDeaths(0);

    if (this.opts.hasTimer) {
      this.timerText = this.add(s.add.text(GAME_W / 2, 5, '', { ...TEXT_STYLE, fontSize: '18px' }).setOrigin(0.5, 0));
    }

    const restart = this.add(s.add.text(GAME_W - 10, 5, '↻ restart', TEXT_STYLE).setOrigin(1, 0));
    restart.setInteractive({ useHandCursor: true });
    restart.on('pointerover', () => restart.setColor(RED_DARK));
    restart.on('pointerout', () => restart.setColor(INK));
    restart.on('pointerdown', () => this.opts.onRestart());

    if (this.opts.debug) {
      this.debugText = this.add(s.add.text(GAME_W - 110, 5, '', { ...TEXT_STYLE, fontSize: '13px' }).setOrigin(1, 0));
      this.debugText.setInteractive({ useHandCursor: true });
      this.debugText.on('pointerdown', () => {
        this.debugOn = !this.debugOn;
        this.renderDebug();
        this.opts.onToggleDebug?.(this.debugOn);
      });
      this.renderDebug();
    }

    s.input.keyboard?.on('keydown-R', this.opts.onRestart);
  }

  private renderDebug(): void {
    if (!this.debugText) return;
    this.debugText.setText(this.debugOn ? '[x] debug' : '[ ] debug');
    this.debugText.setColor(this.debugOn ? RED_DARK : INK_SOFT);
  }

  setCoins(n: number): void {
    this.coinsText.setText(`${n} / ${this.opts.totalCoins}`);
  }

  setDeaths(n: number): void {
    this.deathsText.setText(`✕ ${n}`);
  }

  /** Seconds left, or null to hide. */
  setTimer(seconds: number | null): void {
    if (!this.timerText) return;
    if (seconds === null) {
      this.timerText.setText('');
      return;
    }
    const s = Math.max(0, Math.ceil(seconds));
    const mm = Math.floor(s / 60);
    const ss = (s % 60).toString().padStart(2, '0');
    this.timerText.setText(`⏱ ${mm}:${ss}`);
    this.timerText.setColor(s <= 10 ? RED_DARK : INK);
  }

  /** Big centered message with a paper card behind it (win / out of time). */
  showBanner(title: string, subtitle?: string): void {
    this.hideBanner();
    const s = this.scene;
    const card = s.add.rectangle(0, 0, 320, subtitle ? 92 : 64, 0xfdfcf7, 0.94).setStrokeStyle(2, 0x1c1c1c);
    const t = s.add.text(0, subtitle ? -14 : 0, title, { ...TEXT_STYLE, fontSize: '28px', strokeThickness: 0 }).setOrigin(0.5);
    const children: Phaser.GameObjects.GameObject[] = [card, t];
    if (subtitle) {
      children.push(s.add.text(0, 20, subtitle, { ...TEXT_STYLE, fontSize: '15px', strokeThickness: 0, color: INK_SOFT }).setOrigin(0.5));
    }
    this.banner = this.add(s.add.container(GAME_W / 2, GAME_H / 2 - 20, children));
    this.banner.setScale(0.6);
    s.tweens.add({ targets: this.banner, scale: 1, duration: 220, ease: 'Back.Out' });
  }

  hideBanner(): void {
    if (!this.banner) return;
    this.banner.destroy();
    this.banner = null;
  }

  destroy(): void {
    this.scene.input.keyboard?.off('keydown-R', this.opts.onRestart);
    for (const o of this.objects) o.destroy();
    this.objects.length = 0;
    this.banner = null;
  }
}
