import * as THREE from 'three';
import type { WayLine, WayNet } from '@engine/vehicle/autopilot';

/**
 * Положення в гонці вздовж маршруту: від лінії старту — ланцюжок ліній доріг (`way_*`, за напрямком руху; на
 * кільці — замкнений), для кожної машини — відстань від старту по ланцюжку з урахуванням кіл. Місце = порядок
 * за цією відстанню. (Раніше кожна машина накопичувала пройдене від власної точки старту — суперники на
 * решітці попереду гравця мали той самий нуль, а рестарти й зустрічні лінії збивали підсумок.)
 */
interface Seg {
  a: THREE.Vector3;
  b: THREE.Vector3;
  /** Відстань від старту маршруту до початку сегмента, м. */
  at: number;
  len: number;
}

/** Найбільший зсув положення між оновленнями (раз на 6 кроків ≈ 0,1 с), що вважається рухом, м. */
const MAX_STEP = 60;
/** Продовження далі за стільки метрів від машини — вона на іншій ділянці (рестарт). */
const FAR = 25;

export class RouteProgress {
  private readonly segs: Seg[] = [];
  /** Довжина маршруту (кола), м. */
  readonly length: number;
  /** Маршрут замкнений (кільце). */
  readonly ring: boolean;

  constructor(net: WayNet, start: THREE.Vector3, forward: THREE.Vector3) {
    const first = net.nearest(start, forward);
    let total = 0;
    let ring = false;
    if (first) {
      // Кільце — найкоротший (за кількістю ліній) шлях, що повертається в лінію старту; інакше — жадібне
      // продовження за напрямком (відгалуження-тупики, як way_099_1 на CIRCUIT, кільце не рвуть).
      const cycle = findCycle(first.line);
      const lines = cycle ?? greedyChain(first.line);
      ring = !!cycle;
      let startOffset = 0;
      lines.forEach((line, li) => {
        for (let i = li === 0 && !ring ? first.seg : 0; i + 1 < line.pts.length; i++) {
          const a = line.pts[i];
          const b = line.pts[i + 1];
          const len = a.distanceTo(b);
          if (len < 1e-3) continue;
          if (li === 0 && i === first.seg) startOffset = total + first.t * len;
          this.segs.push({ a, b, at: total, len });
          total += len;
        }
      });
      // Відлік — від точки старту гравця (на кільці частина першої лінії до старту — у кінці кола).
      for (const s of this.segs) s.at -= startOffset;
      if (ring) for (const s of this.segs) if (s.at < 0) s.at += total;
    }
    this.length = Math.max(1, total);
    this.ring = ring;
  }

  /**
   * Нове положення машини (м від старту, з колами) поблизу попереднього prev. Спершу — найближчий сегмент серед
   * тих, що дають стрибок не більше MAX_STEP (продовження руху); далекий стрибок (рестарт на іншу ділянку) —
   * лише якщо продовження далі за FAR від машини: інакше дорога, що проходить поруч сама з собою, переносила б
   * машину на інше місце кола.
   */
  update(pos: THREE.Vector3, prev: number): number {
    if (!this.segs.length) return prev;
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    let near = { at: prev, dist: Infinity };
    let any = { at: prev, dist: Infinity };
    for (const s of this.segs) {
      ab.subVectors(s.b, s.a);
      const t = THREE.MathUtils.clamp(ap.subVectors(pos, s.a).dot(ab) / (s.len * s.len), 0, 1);
      const dist = s.a.clone().addScaledVector(ab, t).distanceTo(pos);
      let at = s.at + t * s.len;
      if (this.ring) at += Math.round((prev - at) / this.length) * this.length;
      if (Math.abs(at - prev) <= MAX_STEP && dist < near.dist) near = { at, dist };
      if (dist < any.dist) any = { at, dist };
    }
    return near.dist <= FAR || any.dist >= near.dist ? (near.dist < Infinity ? near.at : prev) : any.at;
  }
}

/**
 * Замкнений шлях ліній від start назад до start (start — перший), або null: пошук у глибину, на кожній лінії
 * спершу продовження, що найкраще тримає напрям (як їде автопілот); тупики — повернення назад.
 */
function findCycle(start: WayLine): WayLine[] | null {
  const path: WayLine[] = [];
  const onPath = new Set<WayLine>();
  const dead = new Set<WayLine>();
  const walk = (l: WayLine): boolean => {
    path.push(l);
    onPath.add(l);
    for (const n of ordered(l)) {
      if (n === start) return true;
      if (onPath.has(n) || dead.has(n)) continue;
      if (path.length < 500 && walk(n)) return true;
    }
    path.pop();
    onPath.delete(l);
    dead.add(l);
    return false;
  };
  return walk(start) ? path : null;
}

/** Наступні лінії за тим, наскільки прямо вони продовжують кінець l. */
function ordered(l: WayLine): WayLine[] {
  const end = l.pts[l.pts.length - 1];
  const dir = end.clone().sub(l.pts[l.pts.length - 2]).setY(0).normalize();
  const score = (n: WayLine) => (n.pts.length < 2 ? -2 : n.pts[1].clone().sub(n.pts[0]).setY(0).normalize().dot(dir));
  return [...l.next].sort((a, b) => score(b) - score(a));
}

/** Лінії від start, щоразу — продовження, що найкраще тримає напрям кінця поточної. */
function greedyChain(start: WayLine): WayLine[] {
  const out: WayLine[] = [];
  const seen = new Set<WayLine>();
  let line: WayLine | undefined = start;
  while (line && !seen.has(line) && seen.size < 500) {
    seen.add(line);
    out.push(line);
    const end = line.pts[line.pts.length - 1];
    const dir = end.clone().sub(line.pts[line.pts.length - 2]).setY(0).normalize();
    let best: WayLine | undefined;
    let bestDot = -2;
    for (const n of line.next) {
      if (n.pts.length < 2) continue;
      const d = n.pts[1].clone().sub(n.pts[0]).setY(0).normalize().dot(dir);
      if (d > bestDot) [best, bestDot] = [n, d];
    }
    line = best;
  }
  return out;
}
