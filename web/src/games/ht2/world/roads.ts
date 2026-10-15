import * as THREE from 'three';
import type { WayLine } from '../engine/vehicle/autopilot';
import type { Way } from '../formats/way';
import { toThree } from './world';

/**
 * Дорожня мережа Дальнобойщиків 2 з файлів WAY (усі регіони): сегменти RSEG — осьові лінії доріг з шириною
 * WDTH (ліворуч/праворуч, у даних однакові — повна ширина, 3…14 м). Рух правосторонній: кожен сегмент — дві лінії
 * (уперед і назад), зсунуті на середину правої половини дороги. Лінії зʼєднуються, якщо кінець
 * однієї ближче за JOIN до початку іншої (сегменти сусідніх кімнат і регіонів сходяться в одній точці).
 *
 * Інтерфейс — як у WayNet першої гри (lines, nearest, advance): той самий AutoPilot їздить і тут.
 */
const JOIN = 6;

export interface RoadLine extends WayLine {
  width: number;
  region: string;
}

export class Ht2Roads {
  readonly lines: RoadLine[] = [];
  private readonly grid = new Map<string, RoadLine[]>();
  private static readonly CELL = 200;

  constructor(regions: Iterable<{ id: string; way: Way }>) {
    for (const { id, way } of regions)
      for (const room of way.rooms)
        for (const s of room.segments) {
          const n = s.points.length / 3;
          if (n < 2) continue;
          const center: THREE.Vector3[] = [];
          for (let i = 0; i < n; i++) center.push(toThree(s.points[i * 3], s.points[i * 3 + 1], s.points[i * 3 + 2]));
          // WDTH ліворуч/праворуч у даних однакові й дорівнюють повній ширині дороги (13 м на шосе ap —
          // перевірено на вигляді): середина правої половини — чверть ширини.
          const half = Math.max(1.5, Math.max(s.widthLeft, s.widthRight) / 4);
          const name = `${room.name}#${this.lines.length}`;
          const width = Math.max(s.widthLeft, s.widthRight);
          this.lines.push({ name, pts: offsetRight(center, half), next: [], width, region: id });
          this.lines.push({ name: `${name}r`, pts: offsetRight([...center].reverse(), half), next: [], width, region: id });
        }
    for (const l of this.lines) this.cellsOf(l).forEach((k) => (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(l));
    for (const a of this.lines) {
      const end = a.pts[a.pts.length - 1];
      for (const b of this.near(end)) if (b !== a && b.pts[0].distanceTo(end) < JOIN && !isReverseOf(a, b)) a.next.push(b);
    }
  }

  private cellsOf(l: RoadLine): Set<string> {
    const out = new Set<string>();
    for (const p of l.pts) out.add(`${Math.floor(p.x / Ht2Roads.CELL)},${Math.floor(p.z / Ht2Roads.CELL)}`);
    return out;
  }

  /** Лінії в клітинці точки й сусідніх. */
  private near(p: THREE.Vector3): RoadLine[] {
    const cx = Math.floor(p.x / Ht2Roads.CELL);
    const cz = Math.floor(p.z / Ht2Roads.CELL);
    const out = new Set<RoadLine>();
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const l of this.grid.get(`${cx + dx},${cz + dz}`) ?? []) out.add(l);
    return [...out];
  }

  nearest(p: THREE.Vector3, heading?: THREE.Vector3): { line: RoadLine; seg: number; t: number; dist: number } | null {
    let best: { line: RoadLine; seg: number; t: number; dist: number } | null = null;
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const line of this.near(p)) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const a = line.pts[i];
        ab.subVectors(line.pts[i + 1], a);
        const len2 = ab.lengthSq();
        if (!len2) continue;
        const t = THREE.MathUtils.clamp(ap.subVectors(p, a).dot(ab) / len2, 0, 1);
        let dist = q.copy(a).addScaledVector(ab, t).distanceTo(p);
        // Лінії проти руху штрафуємо — їдемо своєю смугою, не розвертаємось.
        if (heading && ab.setY(0).normalize().dot(heading) < 0.2) dist += 30;
        if (!best || dist < best.dist) best = { line, seg: i, t, dist };
      }
    }
    return best;
  }

  /** Точка на відстані `ahead` уздовж мережі; на розвилках — випадкова гілка, але стала для лінії (без смикання). */
  advance(line: RoadLine, seg: number, t: number, ahead: number): THREE.Vector3 {
    let cur = line.pts[seg].clone().lerp(line.pts[seg + 1], t);
    let left = ahead;
    let l: RoadLine = line;
    let i = seg + 1;
    for (let guard = 0; guard < 400; guard++) {
      if (i >= l.pts.length) {
        if (!l.next.length) return cur;
        l = l.next[hashPick(l.name, l.next.length)] as RoadLine;
        i = 1;
        cur = l.pts[0].clone();
        continue;
      }
      const d = cur.distanceTo(l.pts[i]);
      if (d >= left) return cur.lerp(l.pts[i], left / d);
      left -= d;
      cur = l.pts[i].clone();
      i++;
    }
    return cur;
  }
}

function hashPick(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** Та сама дорога у зворотному напрямку (не «продовження»). */
function isReverseOf(a: RoadLine, b: RoadLine): boolean {
  return a.name === `${b.name}r` || b.name === `${a.name}r`;
}

/** Ламана, зсунута праворуч (у площині XZ Three.js) на d. */
function offsetRight(pts: THREE.Vector3[], d: number): THREE.Vector3[] {
  const up = new THREE.Vector3(0, 1, 0);
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dir = b.clone().sub(a).setY(0);
    if (dir.lengthSq() < 1e-6) return p.clone();
    const right = new THREE.Vector3().crossVectors(dir.normalize(), up);
    return p.clone().addScaledVector(right, d);
  });
}
