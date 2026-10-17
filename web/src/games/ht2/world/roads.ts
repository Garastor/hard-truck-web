import * as THREE from 'three';
import type { WayLine } from '../engine/vehicle/autopilot';
import type { Way } from '../formats/way';
import { toThree } from './world';

/**
 * Дорожня мережа Дальнобойщиків 2 з файлів WAY (усі регіони); реверс king.exe — re/notes/ht2/traffic.md.
 *
 * Вісь дороги — сегмент RSEG: з бітом 1 в ATTR — кубічна крива Безьє з 4 точок (кінці й дві контрольні; king.exe
 * 0x406600), інакше — ламана. WDTH — повна ширина W (обидва числа в даних рівні). Рух правосторонній; смуг у кожному
 * напрямку n = ⌊(W/2 + 1,75) / 3,5⌋ (щонайменше одна), ширина смуги W/2 / n, центр смуги k — (k + 0,5)·ширина
 * праворуч від осі (king.exe 0x4d4620). Кожна смуга кожного напрямку — окрема лінія руху.
 *
 * Розділені шосе (гіпотеза порту): дві осі з бітами 4/8 впритул паралельно (≤ 6 м) — дві проїжджі частини; по кожній
 * їдуть лише в тому напрямку, де сусідня вісь ліворуч (на даних: у 136 парах біт 4 + біт 8 сусід з бітом 8 ліворуч від
 * осі з бітом 4). Інакше дороги двобічні.
 *
 * Зʼєднання — між кінцями осей (ближче за JOIN): з кінця напрямку на початок напрямку іншої осі, без розворотів (кут
 * понад TURN_MAX); смуга k → смуга k (обмежено кількістю смуг), крайня права — ще й на всі зайві праворуч. Між кінцем
 * лінії й початком наступної лишається проміжок (зсув смуг на повороті) — його проїжджають навпростець.
 *
 * Інтерфейс — як у WayNet першої гри (lines, nearest, advance): той самий AutoPilot їздить і тут.
 */
const JOIN = 6;
/** Найбільший поворот на стику, рад (більший — розворот, не продовження). */
const TURN_MAX = THREE.MathUtils.degToRad(100);
/** Розділене шосе: друга вісь не далі за це, м, і паралельна (|cos| > PAIR_COS). */
const PAIR_DIST = 6;
const PAIR_COS = 0.9;
/** Крок розгортання кривої Безьє, м. */
const BEZIER_STEP = 3;

export interface RoadLine extends WayLine {
  /** Повна ширина дороги W, м. */
  width: number;
  region: string;
  /** Індекс осі в `Ht2Roads.axes`. */
  road: number;
  /** Смуга від осі (0 — біля осі); −1 — сама вісь. */
  lane: number;
  /** Смуг у цьому напрямку і ширина смуги, м. */
  lanes: number;
  laneWidth: number;
  /** Прапорці ATTR сегмента. */
  flags: number;
  /** Клас ATTR (1/2/3; частота появи привидів ×1 / ×0,5 / ×0,25). */
  cls: number;
  /** Довжина, м. */
  length: number;
  /** Усі смуги того самого напрямку дороги за номером (для перестроювання); в осі — порожньо. */
  siblings: RoadLine[];
  /** Вузли мережі на початку й кінці лінії (індекси `Ht2Roads.nodes`; в осі — за напрямком точок). */
  startNode: number;
  endNode: number;
  /** Дорогу закрито завалом (world/obstacles.ts; king.exe прапорець 0x40 смуг): маршрути її оминають. */
  closed?: boolean;
}

/** Вузол мережі: точка, де сходяться кінці осей (ближче JOIN); перехрестя — якщо доріг три й більше. */
export interface RoadNode {
  pos: THREE.Vector3;
  /** Скільки доріг (осей) сходиться. */
  degree: number;
}

interface Directed {
  axis: number;
  /** 1 — уздовж точок осі, −1 — проти. */
  dir: 1 | -1;
  pts: THREE.Vector3[];
  lines: RoadLine[];
}

export class Ht2Roads {
  /** Лінії руху (смуги обох напрямків). */
  readonly lines: RoadLine[] = [];
  /** Осі доріг (по одній на сегмент; для карт і визначення узбіччя). */
  readonly axes: RoadLine[] = [];
  /** Вузли (стики осей); перехрестя — degree ≥ 3. */
  readonly nodes: RoadNode[] = [];
  private readonly grid = new Map<string, RoadLine[]>();
  private readonly axisGrid = new Map<string, RoadLine[]>();
  private readonly byRoad = new Map<string, RoadLine[]>();

  constructor(regions: Iterable<{ id: string; way: Way }>) {
    for (const { id, way } of regions)
      for (const room of way.rooms)
        for (const s of room.segments) {
          const n = s.points.length / 3;
          if (n < 2) continue;
          const raw: THREE.Vector3[] = [];
          for (let i = 0; i < n; i++) raw.push(toThree(s.points[i * 3], s.points[i * 3 + 1], s.points[i * 3 + 2]));
          const pts = dedupe(s.type & 1 && n === 4 ? bezier(raw) : raw);
          if (pts.length < 2) continue;
          const width = Math.max(s.widthLeft, s.widthRight);
          const hw = width / 2;
          const lanes = Math.max(1, Math.floor((hw + 1.75) / 3.5));
          const road = this.axes.length;
          this.axes.push({ name: `${room.name}#${road}`, pts, next: [], width, region: id, road, lane: -1, lanes, laneWidth: hw / lanes, flags: s.type, cls: s.cls, length: polyLength(pts), siblings: [], startNode: -1, endNode: -1 });
        }
    for (const a of this.axes) for (const k of cellsOf(a.pts)) push(this.axisGrid, k, a);
    this.buildNodes();

    // Напрямки руху осей.
    const dirs: Directed[] = [];
    for (const a of this.axes) {
      const ways = this.directions(a);
      for (const dir of ways) {
        const pts = dir === 1 ? a.pts : [...a.pts].reverse();
        const d: Directed = { axis: a.road, dir, pts, lines: [] };
        for (let k = 0; k < a.lanes; k++) {
          const line: RoadLine = {
            name: `${a.name}:${k}${dir === 1 ? '' : 'r'}`,
            pts: offsetRight(pts, (k + 0.5) * a.laneWidth),
            next: [],
            width: a.width,
            region: a.region,
            road: a.road,
            lane: k,
            lanes: a.lanes,
            laneWidth: a.laneWidth,
            flags: a.flags,
            cls: a.cls,
            length: a.length,
            siblings: d.lines,
            startNode: dir === 1 ? a.startNode : a.endNode,
            endNode: dir === 1 ? a.endNode : a.startNode,
          };
          d.lines.push(line);
          this.lines.push(line);
        }
        dirs.push(d);
      }
    }

    // Зʼєднання кінців напрямків з початками інших (за осями).
    const starts = new Map<string, Directed[]>();
    for (const d of dirs) push(starts, cellKey(d.pts[0]), d);
    const cosMax = Math.cos(TURN_MAX);
    for (const a of dirs) {
      const end = a.pts[a.pts.length - 1];
      const din = tangentEnd(a.pts);
      for (const b of nearCells(starts, end)) {
        if (b.axis === a.axis || b.pts[0].distanceTo(end) >= JOIN) continue;
        if (din.dot(tangentStart(b.pts)) < cosMax) continue;
        const na = a.lines.length;
        const nb = b.lines.length;
        for (let k = 0; k < na; k++) {
          a.lines[k].next.push(b.lines[Math.min(k, nb - 1)]);
          if (k === na - 1) for (let j = k + 1; j < nb; j++) a.lines[k].next.push(b.lines[j]);
        }
      }
    }
    for (const l of this.lines) {
      for (const k of cellsOf(l.pts)) push(this.grid, k, l);
      push(this.byRoad, String(l.road), l);
    }
  }

  /** Лінії руху дороги (усі смуги обох напрямків). */
  linesOf(road: number): RoadLine[] {
    return this.byRoad.get(String(road)) ?? [];
  }

  /** Лічильник змін закритих доріг (кеші маршрутів перераховуються). */
  closedVersion = 0;

  /** Закрити чи відкрити дорогу (вісь і всі її смуги). */
  setClosed(road: number, closed: boolean): void {
    const axis = this.axes[road];
    if (!axis || !!axis.closed === closed) return;
    axis.closed = closed;
    for (const l of this.linesOf(road)) l.closed = closed;
    this.closedVersion++;
  }

  /** Вузли: кінці осей ближче JOIN — один вузол (позиція — середня), degree — скільки осей. */
  private buildNodes(): void {
    const grid = new Map<string, number[]>();
    const sums: THREE.Vector3[] = [];
    const counts: number[] = [];
    const node = (p: THREE.Vector3): number => {
      for (const i of nearCells(grid, p)) if (this.nodes[i].pos.distanceTo(p) < JOIN) return i;
      const i = this.nodes.length;
      this.nodes.push({ pos: p.clone(), degree: 0 });
      sums.push(new THREE.Vector3());
      counts.push(0);
      push(grid, cellKey(p), i);
      return i;
    };
    for (const a of this.axes) {
      a.startNode = node(a.pts[0]);
      a.endNode = node(a.pts[a.pts.length - 1]);
      for (const i of [a.startNode, a.endNode]) {
        this.nodes[i].degree++;
        sums[i].add(i === a.startNode ? a.pts[0] : a.pts[a.pts.length - 1]);
        counts[i]++;
      }
    }
    this.nodes.forEach((n, i) => n.pos.copy(sums[i]).divideScalar(counts[i] || 1));
  }

  /** Перехрестя (три дороги й більше). */
  isJunction(node: number): boolean {
    return node >= 0 && (this.nodes[node]?.degree ?? 0) >= 3;
  }

  /** Напрямки руху осі: розділене шосе — один (сусідня вісь ліворуч), інакше обидва. */
  private directions(a: RoadLine): (1 | -1)[] {
    if (!(a.flags & 12)) return [1, -1];
    const i = Math.floor((a.pts.length - 1) / 2);
    const p = a.pts[i].clone().lerp(a.pts[i + 1], 0.5);
    const t = a.pts[i + 1].clone().sub(a.pts[i]).setY(0).normalize();
    let side = 0;
    let best = PAIR_DIST;
    for (const b of nearCells(this.axisGrid, p)) {
      if (b === a || !(b.flags & 12)) continue;
      const q = closestOn(b.pts, p);
      if (!q) continue;
      const d = Math.hypot(q.point.x - p.x, q.point.z - p.z);
      if (d < 0.5 || d >= best || Math.abs(q.tangent.dot(t)) < PAIR_COS) continue;
      best = d;
      // Ліворуч від напрямку t (вісь Y угору): cross(t, rel).y > 0.
      side = t.z * (q.point.x - p.x) - t.x * (q.point.z - p.z) > 0 ? 1 : -1;
    }
    return side === 0 ? [1, -1] : side > 0 ? [1] : [-1];
  }

  /** Лінії в клітинці точки й сусідніх. */
  private near(p: THREE.Vector3): RoadLine[] {
    return [...new Set(nearCells(this.grid, p))];
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

  /** Відстань по горизонталі до найближчої осі дороги й сама вісь (null — доріг поблизу немає). */
  nearestAxis(p: THREE.Vector3): { axis: RoadLine; dist: number; point: THREE.Vector3 } | null {
    let best: { axis: RoadLine; dist: number; point: THREE.Vector3 } | null = null;
    for (const a of new Set(nearCells(this.axisGrid, p))) {
      const q = closestOn(a.pts, p);
      if (!q) continue;
      const dist = Math.hypot(q.point.x - p.x, q.point.z - p.z);
      if (!best || dist < best.dist) best = { axis: a, dist, point: q.point };
    }
    return best;
  }

  /** Точка поза проїжджою частиною (далі від осі, ніж половина ширини W, з запасом). */
  offRoad(p: THREE.Vector3, margin = 0.5): boolean {
    const n = this.nearestAxis(p);
    return !!n && n.dist > n.axis.width / 2 + margin;
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
        // Проміжок між смугами на стику — навпростець до другої точки наступної лінії.
        i = 1;
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

/** Розвилка: продовження ведуть на різні дороги (а не лише в різні смуги однієї). */
export function isFork(line: RoadLine): boolean {
  const roads = new Set((line.next as RoadLine[]).map((n) => n.road));
  return roads.size > 1;
}

function hashPick(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** Кубічна крива Безьє (P0, P1, P2, P3) — ламана з кроком ≈ BEZIER_STEP; пряма (контрольні на хорді) — два кінці. */
function bezier(p: THREE.Vector3[]): THREE.Vector3[] {
  const [p0, p1, p2, p3] = p;
  const chord = new THREE.Line3(p0, p3);
  const tmp = new THREE.Vector3();
  const off = Math.max(chord.closestPointToPoint(p1, true, tmp).distanceTo(p1), chord.closestPointToPoint(p2, true, tmp).distanceTo(p2));
  if (off < 0.05) return [p0.clone(), p3.clone()];
  const len = p0.distanceTo(p1) + p1.distanceTo(p2) + p2.distanceTo(p3);
  const n = THREE.MathUtils.clamp(Math.ceil(len / BEZIER_STEP), 4, 64);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(
      new THREE.Vector3()
        .addScaledVector(p0, u * u * u)
        .addScaledVector(p1, 3 * u * u * t)
        .addScaledVector(p2, 3 * u * t * t)
        .addScaledVector(p3, t * t * t),
    );
  }
  return out;
}

function polyLength(pts: THREE.Vector3[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  return len;
}

/** Без повторних точок (нульові відрізки ламають дотичні). */
function dedupe(pts: THREE.Vector3[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const p of pts) if (!out.length || out[out.length - 1].distanceTo(p) > 0.01) out.push(p);
  return out;
}

function tangentEnd(pts: THREE.Vector3[]): THREE.Vector3 {
  return pts[pts.length - 1].clone().sub(pts[pts.length - 2]).setY(0).normalize();
}

function tangentStart(pts: THREE.Vector3[]): THREE.Vector3 {
  return pts[1].clone().sub(pts[0]).setY(0).normalize();
}

/** Найближча до p точка ламаної (по горизонталі) і дотична там. */
function closestOn(pts: THREE.Vector3[], p: THREE.Vector3): { point: THREE.Vector3; tangent: THREE.Vector3 } | null {
  let best: { point: THREE.Vector3; tangent: THREE.Vector3; d: number } | null = null;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const ab = pts[i + 1].clone().sub(a).setY(0);
    const len2 = ab.lengthSq();
    if (!len2) continue;
    const t = THREE.MathUtils.clamp(((p.x - a.x) * ab.x + (p.z - a.z) * ab.z) / len2, 0, 1);
    const point = a.clone().lerp(pts[i + 1], t);
    const d = Math.hypot(point.x - p.x, point.z - p.z);
    if (!best || d < best.d) best = { point, tangent: ab.normalize(), d };
  }
  return best;
}

function cellKey(p: THREE.Vector3): string {
  return `${Math.floor(p.x / 200)},${Math.floor(p.z / 200)}`;
}

/** Клітинки, які зачіпає ламана (з точками на відрізках, щоб довгі прямі не пропускали клітинок). */
function cellsOf(pts: THREE.Vector3[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < pts.length; i++) {
    out.add(cellKey(pts[i]));
    if (i + 1 < pts.length) {
      const steps = Math.ceil(pts[i].distanceTo(pts[i + 1]) / 100);
      for (let s = 1; s < steps; s++) out.add(cellKey(pts[i].clone().lerp(pts[i + 1], s / steps)));
    }
  }
  return out;
}

function nearCells<T>(grid: Map<string, T[]>, p: THREE.Vector3): T[] {
  const cx = Math.floor(p.x / 200);
  const cz = Math.floor(p.z / 200);
  const out: T[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(grid.get(`${cx + dx},${cz + dz}`) ?? []));
  return out;
}

function push<T>(grid: Map<string, T[]>, k: string, v: T): void {
  const list = grid.get(k);
  if (list) list.push(v);
  else grid.set(k, [v]);
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
