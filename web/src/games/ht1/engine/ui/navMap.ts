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
/** Довші відрізки ліній ділимо на шматки не довші за цей, м: колір (покриття) може змінитися посередині. */
const COLOR_STEP = 10;
/** Поворот карти за курсом — згладжений (1/с): без цього вона тремтіла б від дрібних змін курсу. */
const YAW_FOLLOW = 10;

/** Колір відрізка дороги на карті (null — як у попереднього); без функції — усі лінії HUD_CYAN. */
export type RoadColor = (a: THREE.Vector3, b: THREE.Vector3) => string | null;

export class NavMap {
  readonly el: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** Лінії доріг за кольором. */
  private readonly roads = new Map<string, Path2D>();
  private readonly colored: boolean;
  /** Пікселів полотна на одиницю карти (SIZE): полотно — у роздільності екрана, малюємо в одиницях SIZE. */
  private readonly res: number;
  private yaw: number | null = null;

  constructor(parent: HTMLElement, net: Pick<WayNet, 'lines'>, colorOf?: RoadColor) {
    this.el = document.createElement('canvas');
    this.el.className = 'pixel nav-map';
    const s = hudScale() * (matchMedia('(pointer: coarse)').matches ? 1.25 : 1);
    // Роздільність екрана (не більше ×2 — телефон), а не 96 px з розтягуванням: лінії рухаються плавно, не сходинками.
    this.res = s * Math.min(window.devicePixelRatio || 1, 2);
    this.el.width = this.el.height = Math.round(SIZE * this.res);
    this.el.style.width = this.el.style.height = `${SIZE * s}px`;
    this.ctx = this.el.getContext('2d')!;
    this.colored = !!colorOf;
    const path = (color: string) => {
      let p = this.roads.get(color);
      if (!p) this.roads.set(color, (p = new Path2D()));
      return p;
    };
    for (const line of net.lines) {
      if (!colorOf) {
        const p = path(HUD_CYAN);
        line.pts.forEach((q, i) => (i ? p.lineTo(q.x, q.z) : p.moveTo(q.x, q.z)));
        continue;
      }
      let color = HUD_CYAN;
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const a = line.pts[i];
        const b = line.pts[i + 1];
        const n = Math.max(1, Math.ceil(a.distanceTo(b) / COLOR_STEP));
        for (let j = 0; j < n; j++) {
          const pa = a.clone().lerp(b, j / n);
          const pb = a.clone().lerp(b, (j + 1) / n);
          color = colorOf(pa, pb) ?? color;
          const p = path(color);
          p.moveTo(pa.x, pa.z);
          p.lineTo(pb.x, pb.z);
        }
      }
    }
    parent.append(this.el);
  }

  /**
   * Перемальовуємо щокадру (раніше — 10 разів на секунду, карта рухалась ривками). target — куди їхати (зелена
   * точка; далі за край карти — на краю).
   */
  update(dt: number, me: THREE.Vector3, heading: THREE.Vector3, rivals: THREE.Vector3[], target?: THREE.Vector3 | null): void {
    const ctx = this.ctx;
    ctx.setTransform(this.res, 0, 0, this.res, 0, 0);
    frame(ctx, 0, 0, SIZE, SIZE);
    const c = SIZE / 2;
    const k = (SIZE / 2 - 4) / RANGE;
    // Повертаємо так, щоб напрям руху дивився вгору: у площині XZ (Z — до глядача) кут = atan2(x, -z).
    const want = Math.atan2(heading.x, -heading.z);
    if (this.yaw === null) this.yaw = want;
    else {
      let d = want - this.yaw;
      d -= Math.round(d / (2 * Math.PI)) * 2 * Math.PI;
      // Розворот на місці, рестарт — одразу.
      this.yaw = Math.abs(d) > 1.5 ? want : this.yaw + d * (1 - Math.exp(-dt * YAW_FOLLOW));
    }
    const yaw = this.yaw;
    ctx.save();
    ctx.beginPath();
    ctx.rect(2, 2, SIZE - 4, SIZE - 4);
    ctx.clip();
    ctx.translate(c, c);
    ctx.rotate(-yaw);
    ctx.scale(k, k);
    ctx.translate(-me.x, -me.z);
    ctx.lineWidth = 1.5 / k;
    // Кольорові лінії — окремими відрізками: круглі кінці, щоб на стиках не було щілин.
    ctx.lineCap = this.colored ? 'round' : 'butt';
    ctx.globalAlpha = 0.8;
    for (const [color, p] of this.roads) {
      ctx.strokeStyle = color;
      ctx.stroke(p);
    }
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
