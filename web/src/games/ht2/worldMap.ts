import * as THREE from 'three';
import type { RoadLine } from './roads';

/**
 * Карта світу HT2 (власний інтерфейс; як виглядала карта оригіналу, невідомо): усі дороги WAY, міста й склади,
 * СТО, заправки, ринки; гравець — жовта стрілка, ціль — зелене коло. Перетягування — пальцем чи мишею, масштаб —
 * двома пальцями чи колесом; «×» — закрити. Координати — площина XZ світу Three.js (північ — угору, −z).
 */
export interface MapPoint {
  pos: THREE.Vector3;
  kind: 'town' | 'sto' | 'fuel' | 'market';
  label?: string;
}

const COLORS: Record<MapPoint['kind'], string> = { town: '#ffd84a', sto: '#4ab8ff', fuel: '#ff8a3a', market: '#d070ff' };
const LEGEND: [MapPoint['kind'], string][] = [
  ['town', 'склад'],
  ['sto', 'СТО'],
  ['fuel', 'заправка'],
  ['market', 'ринок'],
];

export class WorldMap {
  readonly el = document.createElement('div');
  private readonly canvas = document.createElement('canvas');
  private readonly roads = new Path2D();
  private readonly bounds = new THREE.Box2();
  private center = new THREE.Vector2();
  private scale = 0.1;
  private me: { pos: THREE.Vector3; heading: THREE.Vector3 } | null = null;
  private target: THREE.Vector3 | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  onClose: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    lines: readonly RoadLine[],
    private readonly points: MapPoint[],
  ) {
    for (const l of lines) {
      l.pts.forEach((p, i) => {
        if (i) this.roads.lineTo(p.x, p.z);
        else this.roads.moveTo(p.x, p.z);
        this.bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
      });
    }
    this.el.className = 'ht2-worldmap';
    this.el.hidden = true;
    const close = document.createElement('button');
    close.className = 'ht2-worldmap-close';
    close.textContent = '×';
    close.setAttribute('aria-label', 'Закрити карту');
    close.addEventListener('click', () => this.close());
    const legend = document.createElement('div');
    legend.className = 'ht2-worldmap-legend';
    for (const [k, t] of LEGEND) {
      const i = document.createElement('span');
      i.innerHTML = `<b style="background:${COLORS[k]}"></b>${t}`;
      legend.append(i);
    }
    this.el.append(this.canvas, close, legend);
    parent.append(this.el);
    this.canvas.addEventListener('pointerdown', (e) => {
      this.canvas.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    this.canvas.addEventListener('pointermove', (e) => this.move(e));
    const up = (e: PointerEvent) => this.pointers.delete(e.pointerId);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoom(e.deltaY < 0 ? 1.2 : 1 / 1.2);
    });
    window.addEventListener('resize', this.onResize);
  }

  private readonly onResize = () => {
    if (!this.el.hidden) this.draw();
  };

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  /** Відкрити з центром на гравці. */
  open(me: THREE.Vector3, heading: THREE.Vector3, target: THREE.Vector3 | null): void {
    this.me = { pos: me.clone(), heading: heading.clone() };
    this.target = target?.clone() ?? null;
    this.center.set(me.x, me.z);
    // Початковий масштаб — ≈ 3 км на меншу сторону екрана.
    this.scale = Math.min(window.innerWidth, window.innerHeight) / 3000;
    this.el.hidden = false;
    this.draw();
  }

  close(): void {
    this.el.hidden = true;
    this.onClose?.();
  }

  private zoom(k: number): void {
    this.scale = THREE.MathUtils.clamp(this.scale * k, 0.01, 2);
    this.draw();
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    if (this.pointers.size === 2) {
      // Два пальці: масштаб за зміною відстані між ними.
      const other = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const before = Math.hypot(prev.x - other.x, prev.y - other.y);
      const after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
      if (before > 10) this.zoom(after / before);
    } else {
      this.center.x -= (e.clientX - prev.x) / this.scale;
      this.center.y -= (e.clientY - prev.y) / this.scale;
      this.center.clamp(this.bounds.min, this.bounds.max);
      this.draw();
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }

  private draw(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const ctx = this.canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = 'rgba(6, 14, 10, 0.94)';
    ctx.fillRect(0, 0, w, h);
    const k = this.scale;
    const toScreen = (p: THREE.Vector3) => [w / 2 + (p.x - this.center.x) * k, h / 2 + (p.z - this.center.y) * k] as const;
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(k, k);
    ctx.translate(-this.center.x, -this.center.y);
    ctx.strokeStyle = '#58c8b0';
    ctx.lineWidth = 2 / k;
    ctx.globalAlpha = 0.85;
    ctx.stroke(this.roads);
    ctx.restore();
    ctx.globalAlpha = 1;
    ctx.font = '600 12px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    for (const p of this.points) {
      const [x, y] = toScreen(p.pos);
      if (x < -50 || y < -20 || x > w + 50 || y > h + 20) continue;
      ctx.fillStyle = COLORS[p.kind];
      ctx.beginPath();
      ctx.arc(x, y, p.kind === 'town' ? 6 : 4, 0, Math.PI * 2);
      ctx.fill();
      if (p.label && (p.kind === 'town' || k > 0.15)) {
        ctx.fillStyle = '#000';
        ctx.fillText(p.label, x + 9, y + 1);
        ctx.fillStyle = COLORS[p.kind];
        ctx.fillText(p.label, x + 8, y);
      }
    }
    if (this.target) {
      const [x, y] = toScreen(this.target);
      ctx.strokeStyle = '#30ff30';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 11, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (this.me) {
      const [x, y] = toScreen(this.me.pos);
      const yaw = Math.atan2(this.me.heading.x, -this.me.heading.z);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(yaw);
      ctx.fillStyle = '#f8e000';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -11);
      ctx.lineTo(8, 8);
      ctx.lineTo(0, 4);
      ctx.lineTo(-8, 8);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
    }
    // Шкала: 1 км.
    const km = 1000 * k;
    ctx.strokeStyle = '#ddd';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(16, h - 24);
    ctx.lineTo(16 + km, h - 24);
    ctx.stroke();
    ctx.fillStyle = '#ddd';
    ctx.fillText('1 км', 20 + km, h - 24);
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
  }
}
