import * as THREE from 'three';
import type { Ht2Roads, RoadLine } from '../world/roads';
import type { HiredDriver } from './company';

/**
 * Наймані водії на дорогах (king.exe, re/notes/ht2/company.md §2): найнятий — звичайний далекобійник ІІ, що їздить
 * світом — далеко від гравця абстрактно (уздовж ліній мережі), ближче — машиною (traffic/truckers.ts: syncHired).
 * На карті й мінікарті — значок `I_tr_myc` (0x529890).
 *
 * Гіпотези порту: абстрактна швидкість — та сама, що в company.ts (≈ 50 км/год); на розвилці — випадкова наступна
 * лінія (у king.exe водій їде за своїм замовленням, 0x4185d0 — не розібрано); новий найманий стає на найближчу до
 * гравця дорогу (наймають на стоянці, де стоїть гравець).
 */
export const HIRED_SPEED = 50 / 3.6;

export class HiredOnRoads {
  private readonly byName = new Map<string, RoadLine>();

  constructor(private readonly roads: Ht2Roads) {
    for (const l of roads.lines) this.byName.set(l.name, l);
  }

  /** Поставити на найближчу до точки лінію. */
  place(d: HiredDriver, p: THREE.Vector3): void {
    const n = this.roads.nearest(p);
    if (!n) return;
    let s = 0;
    for (let i = 0; i < n.seg; i++) s += n.line.pts[i].distanceTo(n.line.pts[i + 1]);
    s += n.line.pts[n.seg].distanceTo(n.line.pts[n.seg + 1]) * n.t;
    d.road = { line: n.line.name, s };
  }

  /** Абстрактний рух на meters уздовж мережі (на кінці лінії — випадкова наступна). */
  advance(d: HiredDriver, meters: number, rnd = Math.random): void {
    let line = d.road && this.byName.get(d.road.line);
    if (!line || !d.road) return;
    let s = d.road.s + meters;
    for (let guard = 0; guard < 50 && s > line.length; guard++) {
      s -= line.length;
      const next = line.next.filter((l) => (l as RoadLine).length > 0) as RoadLine[];
      if (!next.length) {
        s = 0;
        break;
      }
      line = next[Math.floor(rnd() * next.length)];
    }
    d.road = { line: line.name, s: Math.min(s, line.length) };
  }

  /** Точка й напрям водія на дорозі (Three.js). */
  at(d: HiredDriver): { pos: THREE.Vector3; forward: THREE.Vector3 } | null {
    const line = d.road && this.byName.get(d.road.line);
    if (!line || !d.road) return null;
    let left = d.road.s;
    for (let i = 0; i + 1 < line.pts.length; i++) {
      const a = line.pts[i];
      const b = line.pts[i + 1];
      const len = a.distanceTo(b);
      if (left <= len || i + 2 === line.pts.length) {
        const t = len > 0 ? Math.min(1, left / len) : 0;
        return { pos: a.clone().lerp(b, t), forward: b.clone().sub(a).setY(0).normalize() };
      }
      left -= len;
    }
    return null;
  }
}
