import * as THREE from 'three';
import type { Ht2Roads, RoadLine } from '../world/roads';
import type { HiredDriver } from './company';

/**
 * Наймані водії на дорогах (king.exe, re/notes/ht2/company.md §2): найнятий — звичайний далекобійник ІІ, що їздить
 * світом — далеко від гравця абстрактно (уздовж ліній мережі), ближче — машиною (traffic/truckers.ts: syncHired).
 * На карті й мінікарті — значок `I_tr_myc` (0x529890).
 *
 * Абстрактна швидкість (prescribeAdvance 0x41a9d0): max(13,89 м/с; згладжена швидкість гравця), від машини не
 * залежить. Їде найкоротшим шляхом мережею до складу рейсу (company.ts), без маршруту — випадковою наступною лінією.
 * Гіпотеза порту: новий найманий стає на дорогу біля гравця (наймають на стоянці, де стоїть гравець).
 */
export const HIRED_MIN_SPEED = 13.89;
/** Лінії біля цілі маршруту, м. */
const ARRIVE_R = 80;

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

  /** Абстрактний рух на meters уздовж мережі: за маршрутом, без нього — випадкова наступна лінія. */
  advance(d: HiredDriver, meters: number, rnd = Math.random): void {
    const start = d.road && this.byName.get(d.road.line);
    if (!start || !d.road) return;
    let line: RoadLine = start;
    const route = d.road.route ? [...d.road.route] : undefined;
    let s = d.road.s + meters;
    for (let guard = 0; guard < 50 && s > line.length; guard++) {
      const planned = route?.length ? this.byName.get(route[0]) : undefined;
      if (planned && line.next.includes(planned)) {
        route!.shift();
        s -= line.length;
        line = planned;
        continue;
      }
      if (route) {
        // Кінець маршруту — стоїть у кінці лінії.
        s = line.length;
        break;
      }
      s -= line.length;
      // Зрізалками (world/roads markShortcuts) наймані не їздять — лише гравець.
      const next = line.next.filter((l) => (l as RoadLine).length > 0 && !(l as RoadLine).shortcut) as RoadLine[];
      // Тупик — розворот: лінія, що починається біля кінця цієї (зустрічна), інакше — на місці.
      const pool = next.length ? next : this.startsNear(line.pts[line.pts.length - 1], line);
      if (!pool.length) {
        s = line.length;
        break;
      }
      line = pool[Math.floor(rnd() * pool.length)];
    }
    d.road = { line: line.name, s: Math.min(s, line.length), ...(route ? { route } : {}) };
  }

  /** Лінії, що починаються ближче 25 м від точки (крім except). */
  private startsNear(p: THREE.Vector3, except: RoadLine): RoadLine[] {
    return this.roads.lines.filter((l) => l !== except && l.length > 0 && !l.shortcut && l.pts[0].distanceTo(p) < 25);
  }

  /**
   * Маршрут найкоротшим шляхом мережі (Дейкстра за довжиною ліній) від поточної лінії до будь-якої лінії, що проходить
   * ближче ARRIVE_R від target (найближча лінія буває недосяжною в один бік). Немає шляху — false.
   */
  routeTo(d: HiredDriver, target: THREE.Vector3): boolean {
    const from = d.road && this.byName.get(d.road.line);
    if (!from || !d.road) return false;
    const goals = new Set(this.roads.lines.filter((l) => l.pts.some((p) => p.distanceTo(target) < ARRIVE_R)));
    if (!goals.size) {
      const n = this.roads.nearest(target)?.line;
      if (n) goals.add(n);
    }
    if (goals.has(from)) {
      d.road.route = [];
      return true;
    }
    const dist = new Map<RoadLine, number>([[from, 0]]);
    const prev = new Map<RoadLine, RoadLine>();
    const heap: [number, RoadLine][] = [[0, from]];
    const push = (e: [number, RoadLine]) => {
      heap.push(e);
      for (let i = heap.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        [heap[p], heap[i]] = [heap[i], heap[p]];
        i = p;
      }
    };
    const pop = (): [number, RoadLine] => {
      const top = heap[0];
      const last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1;
          const r = l + 1;
          let m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    let to: RoadLine | null = null;
    while (heap.length) {
      const [dl, cur] = pop();
      if (goals.has(cur)) {
        to = cur;
        break;
      }
      if (dl > (dist.get(cur) ?? Infinity)) continue;
      for (const n of cur.next as RoadLine[]) {
        if (n.shortcut && !goals.has(n)) continue;
        const nd = dl + cur.length;
        if (nd < (dist.get(n) ?? Infinity)) {
          dist.set(n, nd);
          prev.set(n, cur);
          push([nd, n]);
        }
      }
    }
    if (!to || !prev.has(to)) return false;
    const route: string[] = [];
    for (let l: RoadLine | undefined = to; l && l !== from; l = prev.get(l)) route.unshift(l.name);
    d.road.route = route;
    return true;
  }

  /** Маршрут пройдено: на останній лінії маршруту (біля цілі) і в її кінці. */
  routeDone(d: HiredDriver): boolean {
    const line = d.road && this.byName.get(d.road.line);
    return !!line && !!d.road && d.road.route?.length === 0 && d.road.s >= line.length - 1;
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
