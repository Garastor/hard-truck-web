import * as THREE from 'three';
import type { WayNet } from '../vehicle/autopilot';
import { HUD_CYAN, frame, hudScale } from './pixelFont';

/**
 * Навігаційна система (запчастина «НС» — «карта з суперниками»): мінікарта ліній доріг `way_*`, повернута за
 * напрямком руху; гравець — жовта стрілка в центрі, суперники — червоні точки. Стиль — рамка табло оригіналу.
 * Як виглядала карта в оригіналі, невідомо (гіпотеза).
 */
const SIZE = 96;
/** Скільки метрів умістити від центру до краю карти. */
const RANGE = 260;

/**
 * Значки карти з ресурсів гри (перша гра: ic_trucy / ic_trucw / ic_flagw / ic_flagr — HTruck.exe малює їх на своїй
 * карті, re/notes/ht1/navmap.md). Без значка — власні фігури (стрілка, квадрат, коло).
 */
export interface NavIcons {
  me?: CanvasImageSource & { width: number; height: number };
  rival?: CanvasImageSource & { width: number; height: number };
}
/** Прапорець на карті: точка світу й значок (малюється прямо, не обертається з картою). */
export interface NavFlag {
  pos: THREE.Vector3;
  icon: CanvasImageSource & { width: number; height: number };
}

export class NavMap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roads = new Path2D();
  private timer = 0;

  /** Прапорці (старт, фініш) — значками поверх доріг. */
  flags: NavFlag[] = [];

  constructor(
    parent: HTMLElement,
    net: Pick<WayNet, 'lines'>,
    private readonly icons: NavIcons = {},
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'pixel nav-map';
    this.el.width = this.el.height = SIZE;
    const s = hudScale() * (matchMedia('(pointer: coarse)').matches ? 1.25 : 1);
    this.el.style.width = this.el.style.height = `${SIZE * s}px`;
    this.ctx = this.el.getContext('2d')!;
    for (const line of net.lines) {
      line.pts.forEach((p, i) => (i ? this.roads.lineTo(p.x, p.z) : this.roads.moveTo(p.x, p.z)));
    }
    parent.append(this.el);
  }

  /** Перемальовуємо 10 разів на секунду. target — куди їхати (зелена точка; далі за край карти — на краю). */
  update(dt: number, me: THREE.Vector3, heading: THREE.Vector3, rivals: THREE.Vector3[], target?: THREE.Vector3 | null): void {
    if ((this.timer -= dt) > 0) return;
    this.timer = 0.1;
    const ctx = this.ctx;
    frame(ctx, 0, 0, SIZE, SIZE);
    const c = SIZE / 2;
    const k = (SIZE / 2 - 4) / RANGE;
    // Повертаємо так, щоб напрям руху дивився вгору: у площині XZ (Z — до глядача) кут = atan2(x, -z).
    const yaw = Math.atan2(heading.x, -heading.z);
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, 2, SIZE - 4, SIZE - 4);
    ctx.clip();
    ctx.translate(c, c);
    ctx.rotate(-yaw);
    ctx.scale(k, k);
    ctx.translate(-me.x, -me.z);
    ctx.strokeStyle = HUD_CYAN;
    ctx.lineWidth = 1.5 / k;
    ctx.globalAlpha = 0.8;
    ctx.stroke(this.roads);
    ctx.globalAlpha = 1;
    if (!this.icons.rival) {
      ctx.fillStyle = '#e00000';
      for (const r of rivals) ctx.fillRect(r.x - 2.5 / k, r.z - 2.5 / k, 5 / k, 5 / k);
    }
    if (target) {
      const dx = target.x - me.x;
      const dz = target.z - me.z;
      const d = Math.hypot(dx, dz);
      const lim = (SIZE / 2 - 6) / k;
      const f = d > lim ? lim / d : 1;
      ctx.fillStyle = '#20e020';
      ctx.beginPath();
      ctx.arc(me.x + dx * f, me.z + dz * f, 4 / k, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
    // Значки — прямо (не обертаються з картою), цілими пікселями, центром у точці; за краєм рамки — не видно.
    const toMap = (p: THREE.Vector3) => {
      const dx = (p.x - me.x) * k;
      const dz = (p.z - me.z) * k;
      return { x: c + dx * Math.cos(yaw) + dz * Math.sin(yaw), y: c - dx * Math.sin(yaw) + dz * Math.cos(yaw) };
    };
    const icon = (img: NonNullable<NavIcons['me']>, x: number, y: number) => {
      const ix = Math.round(x - img.width / 2);
      const iy = Math.round(y - img.height / 2);
      if (ix < 2 || iy < 2 || ix + img.width > SIZE - 2 || iy + img.height > SIZE - 2) return;
      ctx.drawImage(img, ix, iy);
    };
    for (const f of this.flags) {
      const p = toMap(f.pos);
      icon(f.icon, p.x, p.y);
    }
    if (this.icons.rival) {
      for (const r of rivals) {
        const p = toMap(r);
        icon(this.icons.rival, p.x, p.y);
      }
    }
    if (this.icons.me) {
      icon(this.icons.me, c, c);
      return;
    }
    // Гравець — стрілка вгору в центрі.
    ctx.fillStyle = '#f8e000';
    ctx.beginPath();
    ctx.moveTo(c, c - 5);
    ctx.lineTo(c + 4, c + 4);
    ctx.lineTo(c - 4, c + 4);
    ctx.closePath();
    ctx.fill();
  }

  dispose(): void {
    this.el.remove();
  }
}
