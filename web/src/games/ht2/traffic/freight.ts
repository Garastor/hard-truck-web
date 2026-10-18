import * as THREE from 'three';
import { makeOrders, type Goods, type Order, type Store } from '../career/economy';
import { Navigator } from '../world/navigator';
import { isPocket, type Ht2Roads, type RoadLine } from '../world/roads';
import { toThree } from '../world/world';
import { freightPenalty } from './driver';

/**
 * Рейси ботів-далекобійників (king.exe, re/notes/ht2/company.md §2а «Цикл роботи»: `actOnArrival` 0x419cb0,
 * `sendForSomething` 0x4194e0, `sendForClosestOrder` 0x4185d0). Подієвий цикл без таймера:
 * - порожній — до **найближчого складу** (пряма 3D-відстань), місце — до 100 спроб `rand % 9`, поки на місці не знайдеться
 *   замовлення, що підходить машині; туди порожняком (стан 3, `load`); не знайшлося — «блукає» (`roam`);
 * - прибув вантажитись — вантаж у причіп, пауза 1 с, маршрут до складу призначення (стан 4, `deliver`);
 * - прибув на склад призначення — розвантажився, пауза 1 с, знову порожній.
 * Ціль — місце складу (вузол `node_store_NNMM`): розвантаження — місце 00, вантаження — 01…04. Маршрут — найкоротший
 * мережею (Navigator з кінцевими лініями лише відрізка місця, не тупиковими: з місця треба виїхати).
 *
 * Відступи порту: замовлення бота — свої (makeOrders тих самих складів і товарів), не забирають карток гравця; «блукання»
 * — випадкові гілки ROAM с, а не випадкова точка; у черзі біля місця (стоїть ближче QUEUE_R понад QUEUE_WAIT с, напр.
 * за гравцем) — вважається, що прибув (не стоїть за гравцем без кінця).
 */
export type FreightPhase = 'load' | 'deliver' | 'roam';

export interface FreightJob {
  phase: FreightPhase;
  /** Склад цілі й номер місця (MM). */
  store: Store | null;
  place: number;
  /** Точка місця (Three.js); у `roam` — null. */
  goal: THREE.Vector3 | null;
  /** Замовлення (вибране на місці при відправленні; у `deliver` — вантаж у причепі). */
  order: Order | null;
  /** Пауза після вантаження/розвантаження, с (king.exe 0x477c10: 1 с); > 0 — стоїть. */
  pause: number;
  /** Скільки стоїть у черзі біля місця, с. */
  queued: number;
  /** Скільки ще «блукати», с (`roam`). */
  roam: number;
}

/** Що змінилось за крок: вантаж у машині (маса, кг) — бот перевантажує причіп. */
export interface FreightEvent {
  cargo: number;
}

/** Відрізок місця складу — лінії ближче за стільки від вузла, м (вузли — за 1,2–2 м від ліній). */
export const DOCK_LINE = 3;
/** Прибув: центр машини ближче за стільки від місця, і стоїть (швидкість < STILL_KMH), м. */
const ARRIVE_R = 5;
const STILL_KMH = 2;
/** Черга: стоїть ближче QUEUE_R від місця понад QUEUE_WAIT — прибув, м і с. */
const QUEUE_R = 30;
const QUEUE_WAIT = 10;
/** Пауза після вантаження й розвантаження, с (king.exe). */
export const LOAD_PAUSE = 1;
/** Спроб випадкового місця і «номерів місць» (king.exe 0x418400: 100 спроб rand % 9). */
const PLACE_TRIES = 100;
const PLACE_RANGE = 9;
/** «Блукає» без замовлення, с (порт). */
const ROAM = 60;
/** Штраф паркувальних кишень баз для маршруту бота, м (порт: тягач з причепом виписував ними зигзаги). */
const POCKET_COST = 1000;

/** Місткість машини бота: вантажопідйомність, обʼєм кузова; цистерна; з причепом. */
export interface FreightCapacity {
  mass: number;
  volume: number;
  tanker: boolean;
  trailer: boolean;
}

export class Freight {
  /** Маршрути до місць складів (кінцеві лінії — лише не тупикові). */
  private readonly navigator: Navigator;

  constructor(
    roads: Ht2Roads,
    readonly stores: Store[],
    readonly goodsList: Goods[],
    private readonly rnd: () => number = Math.random,
  ) {
    this.navigator = new Navigator(roads, (l) => freightPenalty(l) + (isPocket(l) ? POCKET_COST : 0), (l) => !roads.deadEnd(l));
  }

  /** Найближчий склад до точки (пряма 3D-відстань до центру; king.exe 0x40b0d0). */
  closest(pos: THREE.Vector3): Store | null {
    let best: Store | null = null;
    let bd = Infinity;
    for (const s of this.stores) {
      const d = toThree(...s.center).distanceTo(pos);
      if (d < bd) (bd = d), (best = s);
    }
    return best;
  }

  /** Точка місця place складу (Three.js) чи null. */
  dock(s: Store, place: number): THREE.Vector3 | null {
    const i = s.places ? s.places.indexOf(place) : place < s.docks.length ? place : -1;
    return i >= 0 ? toThree(...s.docks[i]) : null;
  }

  /**
   * Порожній (sendForClosestOrder 0x4185d0): найближчий склад, місце з замовленням, що підходить машині (до 100 спроб
   * rand % 9; місце 00 — розвантаження, замовлень там немає) — туди порожняком. Не знайшлося — блукати.
   */
  sendEmpty(pos: THREE.Vector3, cap: FreightCapacity): FreightJob {
    const s = this.closest(pos);
    if (s)
      for (let i = 0; i < PLACE_TRIES; i++) {
        const place = Math.floor(this.rnd() * PLACE_RANGE);
        const goal = place > 0 ? this.dock(s, place) : null;
        if (!goal || !this.reachable(goal)) continue;
        const order = makeOrders(s, this.stores, this.goodsList, cap, this.rnd, 1, cap.tanker, 0, cap.trailer)[0];
        if (order) return job('load', s, place, goal, order);
      }
    return { ...job('roam', null, 0, null, null), roam: ROAM };
  }

  /** З вантажем — до місця 00 складу призначення (розвантаження); немає такого місця — до першого. */
  sendLoaded(order: Order): FreightJob | null {
    const s = this.stores.find((x) => x.id === order.to);
    const place = s && (s.places?.includes(0) ? 0 : (s.places?.[0] ?? 0));
    const goal = s && this.dock(s, place!);
    return s && goal && this.reachable(goal) ? job('deliver', s, place!, goal, order) : null;
  }

  /** Продовження лінії до цілі роботи (AutoPilot.choose); null — як завжди (випадкова стала гілка). */
  route(j: FreightJob): ((l: RoadLine) => RoadLine | null) | null {
    const goal = j.goal;
    if (!goal) return null;
    return (l) => this.navigator.next(l, goal, DOCK_LINE);
  }

  /**
   * Крок роботи: прибуття (стоїть біля місця чи в черзі поруч), пауза, наступна робота. Повертає нову роботу (чи ту
   * саму) і подію зміни вантажу.
   */
  step(j: FreightJob, pos: THREE.Vector3, speedKmh: number, dt: number, cap: FreightCapacity): { job: FreightJob; event: FreightEvent | null } {
    if (j.phase === 'roam') {
      j.roam -= dt;
      return { job: j.roam > 0 ? j : this.sendEmpty(pos, cap), event: null };
    }
    if (j.pause > 0) {
      j.pause -= dt;
      if (j.pause > 0) return { job: j, event: null };
      // Пауза минула: навантажений — до призначення, розвантажений — знову порожній.
      if (j.phase === 'load' && j.order) return { job: this.sendLoaded(j.order) ?? this.sendEmpty(pos, cap), event: null };
      return { job: this.sendEmpty(pos, cap), event: null };
    }
    const goal = j.goal!;
    const d = Math.hypot(goal.x - pos.x, goal.z - pos.z);
    const still = speedKmh < STILL_KMH;
    j.queued = still && d < QUEUE_R ? j.queued + dt : 0;
    if (!((still && d < ARRIVE_R) || j.queued > QUEUE_WAIT)) return { job: j, event: null };
    j.pause = LOAD_PAUSE;
    j.queued = 0;
    // Вантаження (loadOrder 0x443d50, кількість +10⁶ — скільки влізе) чи розвантаження (−10⁶ — усе).
    const cargo = j.phase === 'load' && j.order ? j.order.goods.mass * j.order.units : 0;
    return { job: j, event: { cargo } };
  }

  /** Чи є з мережі шлях до місця (є кінцеві не тупикові лінії). */
  private reachable(goal: THREE.Vector3): boolean {
    return this.navigator.distances(goal, DOCK_LINE).size > 0;
  }
}

function job(phase: FreightPhase, store: Store | null, place: number, goal: THREE.Vector3 | null, order: Order | null): FreightJob {
  return { phase, store, place, goal, order, pause: 0, queued: 0, roam: 0 };
}
