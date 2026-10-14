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

export class NavMap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roads = new Path2D();
  private timer = 0;

  constructor(parent: HTMLElement, net: Pick<WayNet, 'lines'>) {
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
    ctx.fillStyle = '#e00000';
    for (const r of rivals) ctx.fillRect(r.x - 2.5 / k, r.z - 2.5 / k, 5 / k, 5 / k);
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
