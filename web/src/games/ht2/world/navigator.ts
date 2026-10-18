import * as THREE from 'three';
import { isFork, type Ht2Roads, type RoadLine } from './roads';

/**
 * Навігатор (покращення на СТО; king.exe `updateNavigator`): стрілка на табло — куди повертати на найближчій
 * розвилці дорожньої мережі WAY, щоб доїхати до цілі найкоротшим шляхом (лише з замовленням). Шлях — зворотний
 * пошук найкоротших відстаней від цілі по лініях (Дейкстра; рахується раз на ціль); у русі — від лінії машини вперед
 * найкоротшими продовженнями до першої розвилки. Як саме king.exe вибирає шлях і з якої відстані показує стрілку, не
 * розібрано (гіпотеза: найкоротший шлях, розвилка до NEAR м).
 */
export type NavTurn = 'left' | 'straight' | 'right';

/** Розвилка далі за цю відстань — стрілки ще немає, м. */
const NEAR = 400;
/** Лінії, що проходять ближче за це до цілі, — кінцеві, м. */
const ARRIVE = 80;
/** Кут, менший за цей, — «прямо», рад. */
const STRAIGHT = THREE.MathUtils.degToRad(25);

export class Navigator {
  private readonly prev = new Map<RoadLine, RoadLine[]>();
  private readonly length = new Map<RoadLine, number>();
  private dist: Map<RoadLine, number> | null = null;
  private targetKey = '';

  /** extra — додаткова «вартість» лінії, м (трафік: штраф за звивистість, traffic/driver.routePenalty). */
  constructor(
    private readonly roads: Ht2Roads,
    extra?: (l: RoadLine) => number,
  ) {
    for (const l of roads.lines) {
      let len = 0;
      for (let i = 1; i < l.pts.length; i++) len += l.pts[i].distanceTo(l.pts[i - 1]);
      this.length.set(l, len + (extra?.(l) ?? 0));
      for (const n of l.next) (this.prev.get(n as RoadLine) ?? this.prev.set(n as RoadLine, []).get(n as RoadLine)!).push(l);
    }
  }

  /** Відстані від кожної лінії до цілі (по мережі, з кінця лінії). */
  distances(target: THREE.Vector3): Map<RoadLine, number> {
    const key = `${Math.round(target.x)},${Math.round(target.z)},${this.roads.closedVersion}`;
    if (this.dist && key === this.targetKey) return this.dist;
    const dist = new Map<RoadLine, number>();
    const heap: [number, RoadLine][] = [];
    const push = (d: number, l: RoadLine) => {
      heap.push([d, l]);
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
          const a = 2 * i + 1;
          const b = a + 1;
          let m = i;
          if (a < heap.length && heap[a][0] < heap[m][0]) m = a;
          if (b < heap.length && heap[b][0] < heap[m][0]) m = b;
          if (m === i) break;
          [heap[m], heap[i]] = [heap[i], heap[m]];
          i = m;
        }
      }
      return top;
    };
    for (const l of this.roads.lines) if (!l.closed && l.pts.some((p) => Math.hypot(p.x - target.x, p.z - target.z) < ARRIVE)) push(0, l);
    while (heap.length) {
      const [d, l] = pop();
      if (dist.has(l)) continue;
      dist.set(l, d);
      // Попередня лінія доходить до цілі через цю: + довжина цієї.
      for (const p of this.prev.get(l) ?? []) if (!dist.has(p) && !p.closed) push(d + this.length.get(l)!, p);
    }
    this.dist = dist;
    this.targetKey = key;
    return dist;
  }

  /** Скільки лишилось дорогами до цілі, м (null — машина далеко від доріг чи шляху немає). */
  remaining(pos: THREE.Vector3, heading: THREE.Vector3 | undefined, target: THREE.Vector3): number | null {
    const at = this.roads.nearest(pos, heading);
    if (!at || at.dist > 80) return null;
    const d = this.distances(target).get(at.line);
    if (d === undefined) return null;
    let rest = at.line.pts[at.seg].distanceTo(at.line.pts[at.seg + 1]) * (1 - at.t);
    for (let i = at.seg + 1; i + 1 < at.line.pts.length; i++) rest += at.line.pts[i].distanceTo(at.line.pts[i + 1]);
    return d + rest;
  }

  /** Поворот на найближчій розвилці по шляху до цілі (null — розвилки поблизу немає чи шляху не знайдено). */
  turn(pos: THREE.Vector3, heading: THREE.Vector3, target: THREE.Vector3): NavTurn | null {
    const at = this.roads.nearest(pos, heading);
    if (!at || at.dist > 40) return null;
    const dist = this.distances(target);
    let line = at.line;
    // Скільки лишилось до кінця поточної лінії.
    let ahead = line.pts[at.seg].distanceTo(line.pts[at.seg + 1]) * (1 - at.t);
    for (let i = at.seg + 1; i + 1 < line.pts.length; i++) ahead += line.pts[i].distanceTo(line.pts[i + 1]);
    for (let guard = 0; guard < 50 && ahead < NEAR; guard++) {
      const next = (line.next as RoadLine[]).filter((n) => dist.has(n));
      if (!next.length) return null;
      const best = next.reduce((a, b) => (dist.get(a)! + this.length.get(a)! <= dist.get(b)! + this.length.get(b)! ? a : b));
      if (isFork(line)) return turnOf(line, best);
      line = best;
      ahead += this.length.get(line)!;
    }
    return null;
  }
}

/** Куди з кінця лінії a на початок b: кут між останнім напрямком a і першими метрами b. */
function turnOf(a: RoadLine, b: RoadLine): NavTurn {
  const n = a.pts.length;
  const din = a.pts[n - 1].clone().sub(a.pts[Math.max(0, n - 2)]).setY(0).normalize();
  const far = b.pts[Math.min(b.pts.length - 1, 2)];
  const dout = far.clone().sub(b.pts[0]).setY(0).normalize();
  const cross = din.x * dout.z - din.z * dout.x;
  const angle = Math.atan2(cross, din.dot(dout));
  if (Math.abs(angle) < STRAIGHT) return 'straight';
  return angle > 0 ? 'right' : 'left';
}
