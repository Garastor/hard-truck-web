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
/** Скільки цілей памʼятати (боти-далекобійники їдуть до різних місць складів). */
const CACHE = 32;
/** Кут, менший за цей, — «прямо», рад. */
const STRAIGHT = THREE.MathUtils.degToRad(25);

export class Navigator {
  private readonly prev = new Map<RoadLine, RoadLine[]>();
  private readonly length = new Map<RoadLine, number>();
  /** Відстані до останніх цілей (ключ — ціль, arrive і версія завалів), не більше CACHE. */
  private readonly cache = new Map<string, Map<RoadLine, number>>();

  /**
   * extra — додаткова «вартість» лінії, м (трафік: штраф за звивистість, traffic/driver.routePenalty); end — чи може
   * лінія біля цілі бути кінцевою (боти: не тупикова — з місця складу треба виїхати).
   */
  constructor(
    private readonly roads: Ht2Roads,
    extra?: (l: RoadLine) => number,
    private readonly end: (l: RoadLine) => boolean = () => true,
  ) {
    for (const l of roads.lines) {
      let len = 0;
      for (let i = 1; i < l.pts.length; i++) len += l.pts[i].distanceTo(l.pts[i - 1]);
      this.length.set(l, len + (extra?.(l) ?? 0));
      for (const n of l.next) (this.prev.get(n as RoadLine) ?? this.prev.set(n as RoadLine, []).get(n as RoadLine)!).push(l);
    }
  }

  /**
   * Відстані від кожної лінії до цілі (по мережі, з кінця лінії); кінцеві — лінії ближче arrive м від цілі (місце складу
   * для ботів — лише відрізок, на якому воно стоїть).
   */
  distances(target: THREE.Vector3, arrive = ARRIVE): Map<RoadLine, number> {
    const key = `${Math.round(target.x)},${Math.round(target.z)},${arrive},${this.roads.closedVersion}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
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
    for (const l of this.roads.lines) if (!l.closed && l.pts.some((p) => Math.hypot(p.x - target.x, p.z - target.z) < arrive) && this.end(l)) push(0, l);
    while (heap.length) {
      const [d, l] = pop();
      if (dist.has(l)) continue;
      dist.set(l, d);
      // Попередня лінія доходить до цілі через цю: + довжина цієї.
      for (const p of this.prev.get(l) ?? []) if (!dist.has(p) && !p.closed) push(d + this.length.get(l)!, p);
    }
    if (this.cache.size >= CACHE) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, dist);
    return dist;
  }

  /**
   * Продовження лінії найкоротшим шляхом до цілі (автопілот ботів-далекобійників, traffic/truckers.ts); null — з кінця
   * лінії шляху до цілі немає.
   */
  next(line: RoadLine, target: THREE.Vector3, arrive = ARRIVE): RoadLine | null {
    const dist = this.distances(target, arrive);
    let best: RoadLine | null = null;
    let bd = Infinity;
    for (const n of line.next as RoadLine[]) {
      const d = dist.get(n);
      if (d === undefined || (n.closed && !line.closed)) continue;
      const c = d + this.length.get(n)!;
      if (c < bd) (bd = c), (best = n);
    }
    return best;
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

  /**
   * Точка на найкоротшому шляху від pos до цілі через s метрів (суперники з тим самим вантажем на карті; null —
   * pos далеко від доріг чи шляху немає). Шлях довший за s закінчується в останній точці мережі перед ціллю.
   */
  pointAlong(pos: THREE.Vector3, heading: THREE.Vector3 | undefined, target: THREE.Vector3, s: number): THREE.Vector3 | null {
    const at = this.roads.nearest(pos, heading);
    if (!at || at.dist > 80) return null;
    const dist = this.distances(target);
    if (!dist.has(at.line)) return null;
    let line = at.line;
    let seg = at.seg;
    let from = line.pts[seg].clone().lerp(line.pts[seg + 1], at.t);
    for (let guard = 0; guard < 500; guard++) {
      for (; seg + 1 < line.pts.length; seg++) {
        const to = line.pts[seg + 1];
        const d = from.distanceTo(to);
        if (s <= d) return from.lerp(to, d > 0 ? s / d : 0);
        s -= d;
        from = to.clone();
      }
      // Кінець лінії: ціль поруч (відстань 0) — тут і стоїть; інакше — найкоротшим продовженням.
      const next = (line.next as RoadLine[]).filter((n) => dist.has(n));
      if (!next.length || dist.get(line) === 0) return from;
      line = next.reduce((a, b) => (dist.get(a)! + this.length.get(a)! <= dist.get(b)! + this.length.get(b)! ? a : b));
      seg = 0;
      from = line.pts[0].clone();
    }
    return from;
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
