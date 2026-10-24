import * as THREE from 'three';
import { isList, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import type { Ht2Roads } from './roads';
import { toThree } from './world';

/**
 * Обвали, повені й ремонт мосту — `obstacle` у `ENV/mod_<регіон>.sch` (king.exe, re/notes/ht2/obstacles.md):
 * `(obstacle OBST_AC_1 REGULAR "ac" "FallAC1Key" "debris_ac10" "debris_ac11" "<закрито>" "<відкрито>" ("pos_work_…"))`
 * — ключ перемикача, два вузли WAY по краях завалу (дорога ІІ між ними, 0x480400), тексти на табло й місця катка.
 *
 * Поведінка (задача ObstaclesTask, 0x434780 → 0x42b3a0):
 * - раз на 600 + rand % 300 с — спроба: якщо діючий завал є і гравець ближче 500 м до нього — нічого; інакше до
 *   п'яти разів випадковий завал далі 500 м від гравця й від діючого — він стає єдиним діючим (0x42b170);
 * - увімкнення (0x42b060): текст «закрито», перемикач ключа → 1 (завал видно, колізії гілки 1), дорогу між вузлами
 *   позначено закритою (0x446ce0, прапорець 0x40 смуг) — маршрути ІІ перераховуються; на місцях `pos_work` — каток
 *   KATOK (`etrashboxes.sch`, клас roadwork; 0x41cff0);
 * - вимкнення — текст «відкрито», перемикач → 0, дорога відкрита, каток прибрано;
 * - на карті й мінікарті — значок I_debris у центрі завалу (0x4420b0 → 0x529890);
 * - стан кожного завалу зберігається з грою (0x4827f0), а з ним — і час останнього запуску задачі (0x68d108,
 *   зсув 0x480650): після завантаження відлік продовжується, а не починається заново; у новій грі перший запуск
 *   відкладено ще на 600 с (0x434780: 0x68d108 = зараз + 600) — перший завал за 1200…1499 с гри.
 * Позиція (для відстаней і значка) — як у king.exe 0x411b10: середина між вузлами завалу, а якщо є місця катка —
 * останнє з них (кожне по черзі перезаписує позицію).
 */
export interface Obstacle {
  id: string;
  region: string;
  /** Ключ перемикача (без `refer_`). */
  key: string;
  /** Вузли по краях завалу (Three.js); null — немає (ремонт мосту CLOSE_BD_*). */
  ends: [THREE.Vector3, THREE.Vector3] | null;
  closeText: string;
  openText: string;
  /** Місця катка (Three.js). */
  work: THREE.Vector3[];
  pos: THREE.Vector3;
}

/** Період задачі: 600 + rand % 300 с. */
const PERIOD = 600;
const PERIOD_RND = 300;
/** Не ближче до гравця й до діючого завалу, м (0x64b860). */
const MIN_DIST = 500;
const TRIES = 5;
/** Відкладення першого запуску в новій грі, с (0x64b870). */
const FIRST_DELAY = 600;

export function parseObstacles(mods: Iterable<{ sch: SExpr[] }>, ways: Iterable<{ way: Way }>): Obstacle[] {
  const nodes = new Map<string, THREE.Vector3>();
  for (const { way } of ways) for (const room of way.rooms) for (const n of room.nodes) nodes.set(n.name.toLowerCase(), toThree(...n.pos));
  const node = (e: SExpr | undefined) => nodes.get(str(e).toLowerCase()) ?? null;
  const out: Obstacle[] = [];
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'obstacle') continue;
      const a = node(e[5]);
      const b = node(e[6]);
      const work = (isList(e[9]) ? e[9] : []).map(node).filter((p): p is THREE.Vector3 => !!p);
      // 0x411b10: середина між вузлами, далі по черзі кожне місце катка — лишається останнє.
      const pos = work[work.length - 1] ?? (a && b ? a.clone().lerp(b, 0.5) : (a ?? b));
      if (!pos) continue;
      out.push({
        id: str(e[1]),
        region: str(e[3]),
        key: str(e[4]),
        ends: a && b ? [a, b] : null,
        closeText: str(e[7]),
        openText: str(e[8]),
        work,
        pos: pos.clone(),
      });
    }
  return out;
}

/**
 * Осі доріг між вузлами завалу: найкоротший ланцюжок осей мережі від осі біля одного вузла до осі біля іншого
 * (дорога ІІ king.exe між двома вузлами WAY може складатися з кількох сегментів RSEG).
 */
export function closedAxes(roads: Ht2Roads, ends: [THREE.Vector3, THREE.Vector3]): number[] {
  const na = roads.nearestAxis(ends[0]);
  const nb = roads.nearestAxis(ends[1]);
  if (!na || !nb) return [];
  if (na.axis.road === nb.axis.road) return [na.axis.road];
  // Дейкстра по осях: сусіди — осі зі спільним вузлом.
  const byNode = new Map<number, number[]>();
  for (const a of roads.axes) for (const n of [a.startNode, a.endNode]) (byNode.get(n) ?? byNode.set(n, []).get(n)!).push(a.road);
  const dist = new Map<number, number>([[na.axis.road, 0]]);
  const prev = new Map<number, number>();
  const open = new Set([na.axis.road]);
  while (open.size) {
    let cur = -1;
    for (const r of open) if (cur < 0 || dist.get(r)! < dist.get(cur)!) cur = r;
    open.delete(cur);
    if (cur === nb.axis.road) break;
    const ax = roads.axes[cur];
    const d = dist.get(cur)!;
    // Завал — коротка ділянка; далі 3 км не шукаємо.
    if (d > 3000) continue;
    for (const n of [ax.startNode, ax.endNode])
      for (const r of byNode.get(n) ?? []) {
        const nd = d + roads.axes[r].length;
        if (nd < (dist.get(r) ?? Infinity)) {
          dist.set(r, nd);
          prev.set(r, cur);
          open.add(r);
        }
      }
  }
  if (!dist.has(nb.axis.road)) return [na.axis.road, nb.axis.road];
  const path = [nb.axis.road];
  while (path[path.length - 1] !== na.axis.road) path.push(prev.get(path[path.length - 1])!);
  return path.reverse();
}

export interface ObstacleDeps {
  /** Позиція машини гравця (Three.js). */
  player(): THREE.Vector3;
  /** Увімкнути чи вимкнути завал (перемикач, дорога, каток, текст — on/off). */
  apply(o: Obstacle, on: boolean, announce: boolean): void;
  random?: () => number;
}

export class Obstacles {
  private timer: number;
  private current: Obstacle | null = null;

  constructor(
    readonly list: Obstacle[],
    private readonly deps: ObstacleDeps,
    /** Діючий завал зі збереження. */
    active?: string | null,
    /**
     * Залишок до наступного запуску задачі зі збереження, с; від'ємне — нова гра (перший запуск через
     * 600 + період), не задано — через період (вільна їзда, старі збереження).
     */
    timer?: number,
  ) {
    this.timer = timer === undefined ? this.period() : timer < 0 ? FIRST_DELAY + this.period() : timer;
    const o = active ? list.find((x) => x.id === active) : undefined;
    if (o) {
      this.current = o;
      deps.apply(o, true, false);
    }
  }

  /** Діючий завал (id) — для збереження. */
  get active(): string | null {
    return this.current?.id ?? null;
  }

  get activeObstacle(): Obstacle | null {
    return this.current;
  }

  /** Залишок до наступного запуску задачі, с — для збереження (у king.exe — час останнього запуску 0x68d108). */
  get remaining(): number {
    return Math.max(0, this.timer);
  }

  private rnd(): number {
    return (this.deps.random ?? Math.random)();
  }

  private period(): number {
    return PERIOD + Math.floor(this.rnd() * PERIOD_RND);
  }

  update(dt: number): void {
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = this.period();
    this.tick();
  }

  /** Спроба змінити діючий завал (0x42b3a0). */
  tick(): void {
    if (!this.list.length) return;
    const p = this.deps.player();
    const cur = this.current;
    if (cur && cur.pos.distanceTo(p) <= MIN_DIST) return;
    for (let i = 0; i < TRIES; i++) {
      const o = this.list[Math.floor(this.rnd() * this.list.length)];
      if (o.pos.distanceTo(p) <= MIN_DIST) continue;
      if (cur && o.pos.distanceTo(cur.pos) <= MIN_DIST) continue;
      this.set(o);
      return;
    }
  }

  /** Зробити завал o єдиним діючим (null — жодного). */
  set(o: Obstacle | null): void {
    if (this.current === o) return;
    if (this.current) this.deps.apply(this.current, false, true);
    this.current = o;
    if (o) this.deps.apply(o, true, true);
  }
}
