import * as THREE from 'three';
import type { EscArt } from './escArt';
import type { RoadLine } from '../world/roads';
import type { MapPoint } from '../world/worldMap';

/**
 * Карта на Tab, як у king.exe (0x529890, re/notes/ht2/ui.md §5): малюється поверх їзди (гра не зупиняється).
 * Перше натискання — увесь світ, вписаний в екран з полями 80 по x і 130 по y; друге — удвічі більший масштаб з
 * центром на гравці й рамкою по кутах; третє — сховати. Значки `m_16\I_*.msk`: склад-місто `I_city0` з назвою,
 * заправка `I_fuel0`, у збільшеному масштабі ще СТО `I_repair` і стоянки-ринки `I_park`; гравець `I_tr_myc`,
 * далекобійники `I_tr_opp`. Ціль блимає (`I_city1…3` чи `I_fuel1…3` по колу — гіпотеза: так виглядають ці стани).
 * Колір доріг у king.exe не розібрано — світло-бірюзовий табла (гіпотеза).
 */
export type TabMapState = 0 | 1 | 2;

const ROAD = 'rgba(123, 255, 255, 0.75)';
const ROAD_EDGE = 'rgba(0, 0, 0, 0.55)';
const LABEL = 'rgb(240, 232, 150)';
/** Поля огляду, CSS px (king.exe: ширина − 80, висота − 130). */
const MARGIN_X = 80;
const MARGIN_Y = 130;

export class TabMap {
  readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly roads = new Path2D();
  private readonly bounds = new THREE.Box2();
  state: TabMapState = 0;
  private blink = 0;

  constructor(
    private readonly art: EscArt,
    parent: HTMLElement,
    lines: readonly RoadLine[],
    private readonly points: readonly MapPoint[],
  ) {
    for (const l of lines)
      l.pts.forEach((p, i) => {
        if (i) this.roads.lineTo(p.x, p.z);
        else this.roads.moveTo(p.x, p.z);
        this.bounds.expandByPoint(new THREE.Vector2(p.x, p.z));
      });
    this.canvas.className = 'ht2-tabmap';
    this.canvas.hidden = true;
    this.ctx = this.canvas.getContext('2d')!;
    parent.append(this.canvas);
  }

  /** Наступний стан: огляд → збільшено → сховано. */
  cycle(): TabMapState {
    this.state = ((this.state + 1) % 3) as TabMapState;
    this.canvas.hidden = this.state === 0;
    return this.state;
  }

  hide(): void {
    this.state = 0;
    this.canvas.hidden = true;
  }

  /** Кадр: me — гравець, rivals — далекобійники, target — ціль (склад чи заправка). */
  draw(dt: number, me: THREE.Vector3, rivals: readonly THREE.Vector3[], target: THREE.Vector3 | null): void {
    if (this.state === 0) return;
    this.blink = (this.blink + dt * 4) % 3;
    const dpr = window.devicePixelRatio || 1;
    const W = window.innerWidth;
    const H = window.innerHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) {
      this.canvas.width = Math.round(W * dpr);
      this.canvas.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const top = parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0;
    const size = this.bounds.getSize(new THREE.Vector2());
    let k = Math.min((W - MARGIN_X) / size.x, (H - top - MARGIN_Y) / size.y);
    let cx = (this.bounds.min.x + this.bounds.max.x) / 2;
    let cz = (this.bounds.min.y + this.bounds.max.y) / 2;
    if (this.state === 2) {
      k *= 2;
      cx = me.x;
      cz = me.z;
    }
    const ox = W / 2 - cx * k;
    const oy = top + (H - top) / 2 - cz * k;
    const at = (p: THREE.Vector3) => [ox + p.x * k, oy + p.z * k] as const;
    // Дороги: темна облямівка й лінія (видно на будь-якому тлі).
    ctx.save();
    ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * ox, dpr * oy);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = ROAD_EDGE;
    ctx.lineWidth = 3 / k;
    ctx.stroke(this.roads);
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = 1.2 / k;
    ctx.stroke(this.roads);
    ctx.restore();
    if (this.state === 2) this.frame(W, H, top);
    const icon = (name: string, p: THREE.Vector3) => {
      const img = this.art.canvas(`m_16\\${name}.msk`);
      if (!img) return;
      const [x, y] = at(p);
      ctx.drawImage(img, Math.round(x - img.width / 2), Math.round(y - img.height / 2));
    };
    const step = Math.floor(this.blink) + 1;
    const isTarget = (p: THREE.Vector3) => !!target && p.distanceTo(target) < 30;
    for (const pt of this.points) {
      if (pt.kind === 'town') {
        icon(isTarget(pt.pos) ? `I_city${step}` : 'I_city0', pt.pos);
        if (pt.label && this.art.matrix) {
          const [x, y] = at(pt.pos);
          const t = pt.label.toUpperCase();
          this.art.matrix.draw(ctx, t, Math.round(x - this.art.matrix.measure(t) / 2), Math.round(y + 8), LABEL);
        }
      } else if (pt.kind === 'fuel') icon(isTarget(pt.pos) ? `I_fuel${step}` : 'I_fuel0', pt.pos);
      else if (this.state === 2) icon(pt.kind === 'sto' ? 'I_repair' : 'I_park', pt.pos);
    }
    for (const r of rivals) icon('I_tr_opp', r);
    icon('I_tr_myc', me);
  }

  /** Рамка збільшеного масштабу — кутики (king.exe малює чотири відрізки). */
  private frame(W: number, H: number, top: number): void {
    const ctx = this.ctx;
    const x0 = W / 20;
    const x1 = W - W / 20;
    const y0 = top + (H - top) / 8;
    const y1 = H - (H - top) / 8;
    const l = Math.min(W, H) / 8;
    ctx.strokeStyle = ROAD;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const [x, y, dx, dy] of [
      [x0, y0, 1, 1],
      [x1, y0, -1, 1],
      [x0, y1, 1, -1],
      [x1, y1, -1, -1],
    ]) {
      ctx.moveTo(x + dx * l, y + 0.5);
      ctx.lineTo(x + 0.5, y + 0.5);
      ctx.lineTo(x + 0.5, y + dy * l);
    }
    ctx.stroke();
  }

  dispose(): void {
    this.canvas.remove();
  }
}
