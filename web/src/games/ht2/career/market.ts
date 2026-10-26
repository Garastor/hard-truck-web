import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildTruckModel, visibleBox } from '../engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '../engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import type { TechRecord } from '../formats/tech';
import { drivable, selectable, truckDef, type Ht2Trucks } from '../vehicles/trucks';
import { toThree } from '../world/world';
import { ukName } from '../ui/uk';
import { recolor } from '../traffic/traffic';

/**
 * Ринки вантажівок HT2 — `parking` з `ENV/mod_<регіон>.sch`:
 * `(parking MARKET_AJ "Барахолка" 1 () ((node "node_car_0100") … (node "node_car_0104" 4 "Приозерск")) 10)` — назва,
 * номер, місця (вузли WAY), у вузла з прапорцем 4 — назва міста. Записи з номером −1 — безіменні стоянки-схованки:
 * `hidden_car_*`, `node_stolen_*`, `stolen_truck_*` (прапорець 8) і `old_car_*` (прапорець 32).
 *
 * Хто де стоїть (king.exe 0x421d90 createDealerForSale → 0x418c10 → фільтр місць 0x456460): ліміти GAME.CNF —
 * `forsale 25` нових, `forsale_used 5` вживаних, `forsale_stolen 5` крадених на весь світ. Нова — лише на місці без
 * прапорців 4|8|32 (місце-місто — для замовлених), вживана — на місці з 32, крадена — з 8; стоянку обирають ту, де
 * зайнято найменше (перша з рівних), місце на ній — випадкове вільне. Отже на звичайних ринках — лише нові, вживані
 * й крадені — на стоянках-схованках.
 *
 * Машина продавця — тип evehicles.sch (модель + фарбування; re/notes/ht2/company.md §5, `pickDealerKind`).
 *
 * Оновлення (king.exe задача updateDealers 0x422370, раз на 27,5 с; re/notes/ht2/company.md §6): продавець, що
 * простояв 900…1019 с і стоїть далі 2 км від гравця, зникає; групи дозаповнюються до лімітів на місцях далі 700 м.
 * Купівля — обмін машинами: продавець лишається на місці зі старою машиною гравця й зникає за тим самим правилом.
 * Шукачі роботи (forhire 20) чекають 1200…2699 с і йдуть, коли пул повний. Стан — у збереженні (`ParkingState`).
 *
 * Гіпотези порту: тип — випадковий з тими самими частками (king.exe — перемішаний список по колу); вживана дешевша
 * на 35 % і побита; шукачі роботи з'являються задачею оновлення (у king.exe — вільні далекобійники після доставки).
 */
const SHOW_R = 450;
/** Замовлену машину приганяють на ринок далі цієї відстані від абонента, м (0x64b860). */
const DELIVERY_MIN = 500;
/** Вікно продажу (king.exe 0x56fc10): ближче 20 м до машини, що продається (без умови швидкості). */
const NEAR_R = 20;
const USED_DISCOUNT = 0.65;
const STOLEN_DISCOUNT = 0.45;
export const USED_DAMAGE = 0.3;

export interface Market {
  id: number;
  name: string;
  town: string;
  spots: { pos: THREE.Vector3; heading: THREE.Vector3 }[];
  /** Місце з прапорцем 4 (вузол з назвою міста) — туди приганяють замовлену машину (king.exe 0x433660); −1 — немає. */
  townSpot: number;
  /** Останнє число запису `parking` (поле ринку +0x30, типово 4): плата за доставку замовленої машини — N · 300 $. */
  fee: number;
  /** Прапорці місць (4 — місто, 8 — для крадених, 32 — для вживаних). */
  flags: number[];
  /** Стоянка-схованка (номер −1 у даних; id порту — від HIDDEN_ID): не ринок на карті, без найму. */
  hidden: boolean;
}

/** Ліміти продавців з GAME.CNF. */
export interface SaleLimits {
  forsale: number;
  used: number;
  stolen: number;
}

const HIDDEN_ID = 1000;
/** Вид продавця: 0 нова, 1 вживана, 2 крадена. */
type SaleKind = 0 | 1 | 2;
/** Чи підходить місце з прапорцями f для виду (0x456460). */
const fits = (f: number, kind: SaleKind) => (kind === 0 ? (f & 0x2c) === 0 : kind === 1 ? (f & 0x20) !== 0 : (f & 8) !== 0);

/** Замовлена рацією машина (career/carOrder.ts): стоїть на місці ринку, доки її не куплять. */
export interface OrderedCar {
  market: number;
  spot: number;
  carNode: string;
  /** Фарбування — кластер TRUCKS.OVL з нуля. */
  cluster: number;
  stolen: boolean;
}

export interface ForSale {
  rec: TechRecord;
  used: boolean;
  /** Крадена (king.exe біт 2 машини, ціна × 0,45): без сканера не видно, міліція може вважати викраденою. */
  stolen?: boolean;
  price: number;
  spot: number;
  /** Фарбування машини — кластер TRUCKS.OVL з нуля (тип evehicles.sch продавця; переходить до покупця). */
  cluster?: number;
  /** Замовлена рацією. */
  ordered?: boolean;
  /** Машина водія, що шукає роботу (найм, careerMode.salePanel): його імʼя й фото. */
  hire?: boolean;
  name?: string;
  photo?: number;
  /** Пошкодження 0…1 (стара машина гравця, залишена продавцеві). */
  damage?: number;
}

export function parseMarkets(mods: Iterable<{ sch: SExpr[] }>, ways: Iterable<{ way: Way }>): Market[] {
  const nodes = new Map<string, { pos: [number, number, number]; dir: THREE.Vector3 }>();
  for (const { way } of ways)
    for (const room of way.rooms)
      for (const n of room.nodes) {
        // Напрям — уздовж найближчого сегмента дороги кімнати.
        let dir = new THREE.Vector3(0, 0, -1);
        let best = Infinity;
        for (const s of room.segments)
          for (let i = 0; i + 5 < s.points.length; i += 3) {
            const d = Math.hypot(s.points[i] - n.pos[0], s.points[i + 1] - n.pos[1]);
            if (d < best) {
              best = d;
              dir = toThree(s.points[i + 3] - s.points[i], s.points[i + 4] - s.points[i + 1], 0).normalize();
            }
          }
        nodes.set(n.name.toLowerCase(), { pos: n.pos, dir });
      }
  const out: Market[] = [];
  let hiddenId = HIDDEN_ID;
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'parking' || !isList(e[5])) continue;
      const hidden = num(e[3], -1) < 0;
      // Частина назв у даних — «??» (не заповнені): показуємо «Ринок»; схованки — без назви.
      const name = str(e[2]);
      const m: Market = {
        id: hidden ? hiddenId++ : num(e[3]),
        name: hidden ? '' : /^\?*$/.test(name) ? 'Ринок' : ukName(name),
        town: '',
        spots: [],
        townSpot: -1,
        fee: num(e[6], 4),
        flags: [],
        hidden,
      };
      for (const n of e[5]) {
        if (!isList(n)) continue;
        const node = nodes.get(str(n[1]).toLowerCase());
        if (n.length > 3) m.town = ukName(str(n[3]));
        if (!node) continue;
        const f = num(n[2], 0);
        if (m.townSpot < 0 && f & 4) m.townSpot = m.spots.length;
        m.spots.push({ pos: toThree(...node.pos), heading: node.dir });
        m.flags.push(f);
      }
      if (m.spots.length) out.push(m);
    }
  return out;
}

/** Тип машини продавця з evehicles.sch: модель, фарбування (кластер з нуля), легковик, чи має користувача trucker. */
export interface DealerKind {
  carNode: string;
  cluster: number;
  car: boolean;
  trucker: boolean;
}

/**
 * Типи для продавців (king.exe 0x42fa90 список 7 → копія для типу 9): записи з користувачем `dumb` чи `trucker`, крім
 * напівпричепів; лише моделі, які порт може водити (є запис vehicle.tech і модель).
 */
export function dealerKinds(sch: SExpr[], trucks: Ht2Trucks): DealerKind[] {
  const ok = new Set(selectable(trucks).map((r) => r.carNode));
  const out: DealerKind[] = [];
  for (const e of sch) {
    if (!isList(e) || e[0] !== 'vehicle' || e[4] === 'semitrailer') continue;
    const users = isList(e[5]) ? e[5] : [e[5]];
    const trucker = users.includes('trucker');
    const model = str(e[2]);
    if ((!trucker && !users.includes('dumb')) || !ok.has(model)) continue;
    out.push({ carNode: model, cluster: num(e[3]), car: e[4] === 'car', trucker });
  }
  return out;
}

/** Частка капіталу гравця, з якої продавці мають і «тупі» легковики (king.exe 0x64b928, прапорець 0x68d1a0). */
export const DEALER_CARS_SHARE = 0.52;

/** Частка легковиків у списку типів 7/9 (0x42fa90): A береться, поки взято_A < взято_B · 0,952·x. */
const CAR_SHARE_K = 20 / 21;

/**
 * Тип машини нового продавця (king.exe 0x415940, гілка 9): з групи легковиків з імовірністю kx/(1 + kx), інакше з
 * решти; у групі кожен тип (тобто кожне фарбування) рівноймовірний. Приймається тип з `trucker`, а з `dumb` — лише
 * коли allCars (частка капіталу ≥ 52 %); відкинутий — наступна спроба (у king.exe — наступний у списку).
 */
export function pickDealerKind(kinds: readonly DealerKind[], allCars: boolean, density: number, rnd: () => number): DealerKind | null {
  const cars = kinds.filter((k) => k.car);
  const rest = kinds.filter((k) => !k.car);
  const x = CAR_SHARE_K * Math.max(0, Math.min(1, density));
  const pCar = !rest.length ? 1 : !cars.length ? 0 : x / (1 + x);
  for (let i = 0; i < 100; i++) {
    const group = rnd() < pCar ? cars : rest;
    if (!group.length) continue;
    const k = group[Math.floor(rnd() * group.length)];
    if (k.trucker || allCars) return k;
  }
  return kinds.find((k) => k.trucker || allCars) ?? null;
}

interface Shown {
  market: Market;
  /** Версія стану стоянок, з якою звірено показане, і набір машин (signature). */
  rev: number;
  sig: string;
  parts: { root: THREE.Object3D; body: RAPIER.RigidBody }[];
}

/**
 * Машина, що стоїть на місці стоянки: продавець (king.exe тип 9, стан 0x100) чи водій, що шукає роботу (тип 2, стан
 * 0x101). Зберігається в кар'єрі (`Ht2Career.parking`).
 */
export interface ParkedCar {
  market: number;
  spot: number;
  /** Група продавців (0 нова, 1 вживана, 2 крадена — 0x68ced0/ee0/ef0) чи 'hire' — шукач роботи. */
  group: SaleKind | 'hire';
  carNode: string;
  /** Фарбування — кластер TRUCKS.OVL з нуля. */
  cluster: number;
  /** Коли з'явився, с годинника стоянок (`ParkingState.clock`; king.exe поле особи `+0x3b0`). */
  born: number;
  /** Шукач роботи: імʼя й фото. */
  name?: string;
  photo?: number;
  /** Шукач роботи: до якого моменту годинника чекає (king.exe 0x419cb0: прибуття + 1200 + rand % 1500 с). */
  until?: number;
  /** Стара машина гравця, що лишилася продавцеві після купівлі (king.exe 0x4738c0): її стан. */
  traded?: { damage: number; stolen: boolean };
}

/** Стан стоянок у збереженні кар'єри. */
export interface ParkingState {
  /** Годинник стоянок, с реального часу гри (king.exe 0x401000 — секунди симуляції, не ігрова доба). */
  clock: number;
  /** До наступного запуску задачі updateDealers, с. */
  timer: number;
  cars: ParkedCar[];
}

/** Період задачі updateDealers, с (king.exe 0x434780: 27,5 — double 0x403b8000). */
export const DEALERS_PERIOD = 27.5;
/** Продавець старший за 900 + rand % 120 с (0x421c00) … */
export const DEALER_AGE = 900;
export const DEALER_AGE_RAND = 120;
/** … і далі 2000 м від гравця (0x64b758) — зникає. */
export const DEALER_GONE_R = 2000;
/** Нових ставлять не ближче 700 м від гравця (0x422370 → 0x4221d0, аргумент 700.0). */
export const DEALER_NEW_R = 700;
/** До 100 спроб дозаповнити кожну групу (0x4221d0). */
const REFILL_TRIES = 100;
/** Шукач роботи чекає 1200 + rand % 1500 с (0x419cb0 → 0x477bd0). */
export const SEEKER_WAIT = 1200;
export const SEEKER_WAIT_RAND = 1500;
/** Ціна машини мінус пошкодження × 5000 $ (0x473680, 0x64b848). */
export const DAMAGE_PRICE = 5000;

/**
 * Вартість машини (king.exe 0x473680): ціна моделі × 0,65 вживана / × 0,45 крадена (0x473600) мінус пошкодження
 * 0…1 × 5000 $; не менше нуля. Покращення порт переносить на нову машину, тож тут їх немає.
 */
export function carValue(price: number, o: { used?: boolean; stolen?: boolean; damage?: number }): number {
  const base = price * (o.used ? USED_DISCOUNT : o.stolen ? STOLEN_DISCOUNT : 1);
  return Math.max(0, Math.round(base - (o.damage ?? 0) * DAMAGE_PRICE));
}

export class Markets {
  private readonly shown = new Map<number, Shown>();
  /** Замовлені рацією машини (зберігаються в кар'єрі). */
  ordered: OrderedCar[] = [];
  /** Типи машин продавців з evehicles.sch (dealerKinds). */
  kinds: DealerKind[] = [];
  /** Густота трафіку 0…1 (частка легковиків серед продавців). */
  density = 1;
  /** Продавці мають і «тупі» легковики (king.exe 0x68d1a0: частка капіталу гравця ≥ 52 %) — для нових продавців. */
  allCars = false;
  /** Ліміт шукачів роботи на весь світ (GAME.CNF `forhire`, 0x68d150). */
  forhire = 20;
  /** Імена, з яких беруться шукачі роботи (далекобійники світу без найнятих гравцем — company.hirableNames). */
  hirable: () => readonly string[] = () => [];
  /** Стан стоянок (зберігається в кар'єрі). */
  state: ParkingState = { clock: 0, timer: DEALERS_PERIOD, cars: [] };
  /** Лічильник змін стану (перебудова показаних ринків). */
  private rev = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly trucks: Ht2Trucks,
    readonly list: Market[],
    private readonly ground: (p: THREE.Vector3) => number,
    private readonly limits: SaleLimits = { forsale: 25, used: 5, stolen: 5 },
    private readonly rnd: () => number = Math.random,
  ) {}

  /**
   * Стан зі збереження. Немає (нова кар'єра чи збереження до 2026-10-26) — заповнити стоянки, як на старті king.exe
   * (0x4221d0 до лімітів, 0x423ad0 — шукачі роботи), без умови відстані: машин ще не видно.
   */
  restore(saved: ParkingState | undefined): void {
    if (saved && Array.isArray(saved.cars) && Number.isFinite(saved.clock)) {
      const known = new Set(this.list.map((m) => m.id));
      this.state = {
        clock: saved.clock,
        timer: Number.isFinite(saved.timer) ? saved.timer : DEALERS_PERIOD,
        cars: saved.cars.filter((c) => known.has(c.market) && this.list.find((m) => m.id === c.market)!.spots[c.spot]),
      };
    } else this.state = { clock: 0, timer: DEALERS_PERIOD, cars: [] };
    if (!this.state.cars.length) this.refill(null);
    this.changed();
  }

  /**
   * Годинник і задача updateDealers (king.exe 0x422370, раз на 27,5 с): продавці й шукачі роботи, що простояли
   * 900…1019 с і далі 2 км від гравця, зникають (0x421c00); групи дозаповнюються до лімітів на місцях далі 700 м
   * (0x4221d0). Повертає, чи змінився стан.
   */
  tick(dt: number, player: THREE.Vector3): boolean {
    const s = this.state;
    s.clock += dt;
    if ((s.timer -= dt) > 0) return false;
    s.timer = DEALERS_PERIOD;
    const before = s.cars.length;
    s.cars = s.cars.filter((c) => {
      if (c.group === 'hire') return true;
      // Межа віку — щоразу нове випадкове (0x421c00: rand % 120 на кожного продавця при кожному запуску).
      const age = DEALER_AGE + Math.floor(this.rnd() * DEALER_AGE_RAND);
      if (s.clock - c.born <= age) return true;
      return this.spotPos(c).distanceTo(player) <= DEALER_GONE_R;
    });
    // Шукач роботи, що відчекав, іде, коли пул повний (king.exe 0x41ae60: тих, що чекають, ≥ forhire; 0x45d1b0:
    // > forhire − 2 — випадковий із відчеклих). Порт — один випадковий за запуск задачі.
    const seekers = s.cars.filter((c) => c.group === 'hire');
    const done = seekers.filter((c) => (c.until ?? 0) <= s.clock);
    if (done.length && seekers.length > this.forhire - 2) s.cars.splice(s.cars.indexOf(done[Math.floor(this.rnd() * done.length)]), 1);
    const removed = s.cars.length !== before;
    const added = this.refill(player);
    if (removed || added) this.changed();
    return removed || added;
  }

  /** Позиція місця машини. */
  private spotPos(c: { market: number; spot: number }): THREE.Vector3 {
    return this.list.find((m) => m.id === c.market)!.spots[c.spot].pos;
  }

  /** Зайняті місця ринку: машини стоянок і замовлені. */
  private occupied(m: Market): Set<number> {
    const t = new Set<number>();
    for (const c of this.state.cars) if (c.market === m.id) t.add(c.spot);
    for (const o of this.ordered) if (o.market === m.id) t.add(o.spot);
    return t;
  }

  /**
   * Місце для нової машини (0x418c10 findAppropriateParkingPlace): стоянка, де зайнято найменше і є вільне придатне
   * місце далі minR від гравця (перша з рівних), місце — випадкове з придатних.
   */
  private place(kind: SaleKind, player: THREE.Vector3 | null, minR: number): { market: number; spot: number } | null {
    let best: Market | null = null;
    let bestN = Infinity;
    let free: number[] = [];
    for (const m of this.list) {
      const t = this.occupied(m);
      if (t.size >= bestN) continue;
      const f = m.flags
        .map((fl, i) => (fits(fl, kind) && !t.has(i) && (!player || m.spots[i].pos.distanceTo(player) > minR) ? i : -1))
        .filter((i) => i >= 0);
      if (f.length) [best, bestN, free] = [m, t.size, f];
    }
    return best ? { market: best.id, spot: free[Math.floor(this.rnd() * free.length)] } : null;
  }

  /** Дозаповнити групи продавців і шукачів роботи (player null — старт, без умови відстані). */
  private refill(player: THREE.Vector3 | null): boolean {
    const s = this.state;
    let added = false;
    const groups: [SaleKind, number][] = [[0, this.limits.forsale], [1, this.limits.used], [2, this.limits.stolen]];
    for (const [kind, limit] of groups)
      for (let i = 0; i < REFILL_TRIES && s.cars.filter((c) => c.group === kind).length < limit; i++) {
        const at = this.place(kind, player, DEALER_NEW_R);
        const k = at && this.dealerKind();
        if (!at || !k) break;
        s.cars.push({ ...at, group: kind, carNode: k.carNode, cluster: k.cluster, born: s.clock });
        added = true;
      }
    // Шукачі роботи (king.exe goHireIt 0x419030: далекобійник ІІ на вільне місце групи нових, ліміт forhire). Там
    // ним стає вільний далекобійник після доставки й доїжджає до місця; порт рейсів ботів до стоянок не веде —
    // дозаповнює тією самою задачею [Г] і ставить одразу, далі 700 м від гравця (не на очах).
    for (let i = 0; i < REFILL_TRIES && s.cars.filter((c) => c.group === 'hire').length < this.forhire; i++) {
      const taken = new Set(s.cars.map((c) => c.name).filter(Boolean));
      const names = this.hirable().filter((n) => !taken.has(n));
      const at = names.length ? this.place(0, player, DEALER_NEW_R) : null;
      const k = at && this.seekerKind();
      if (!at || !k) break;
      const name = names[Math.floor(this.rnd() * names.length)];
      s.cars.push({ ...at, group: 'hire', carNode: k.carNode, cluster: k.cluster, born: s.clock, name, photo: 1 + Math.floor(this.rnd() * 51), until: s.clock + SEEKER_WAIT + Math.floor(this.rnd() * SEEKER_WAIT_RAND) });
      added = true;
    }
    return added;
  }

  /** Тип машини нового продавця (pickDealerKind), без даних — модель з vehicle.tech у першому фарбуванні. */
  private dealerKind(): { carNode: string; cluster: number } | null {
    const k = pickDealerKind(this.kinds, this.allCars, this.density, this.rnd);
    if (k && this.trucks.records.some((r) => r.carNode === k.carNode)) return k;
    const pool = this.pool();
    const r = pool[Math.floor(this.rnd() * pool.length)];
    return r ? { carNode: r.carNode, cluster: 0 } : null;
  }

  /** Машина шукача роботи — вантажівка далекобійника (king.exe тип 2) у своєму фарбуванні. */
  private seekerKind(): { carNode: string; cluster: number } | null {
    const pool = this.pool();
    const ks = this.kinds.filter((k) => k.trucker && !k.car && pool.some((r) => r.carNode === k.carNode));
    if (ks.length) return ks[Math.floor(this.rnd() * ks.length)];
    const r = pool[Math.floor(this.rnd() * pool.length)];
    return r ? { carNode: r.carNode, cluster: 0 } : null;
  }

  private pool(): TechRecord[] {
    return drivable(this.trucks).filter((r) => !/^Storm/i.test(r.carNode));
  }

  private changed(): void {
    this.rev++;
  }

  /** Що стоїть на ринку (чи стоянці-схованці) зараз. */
  stock(m: Market): ForSale[] {
    const out: ForSale[] = [];
    // Замовлена машина стоїть на своєму місці, доки її не куплять (king.exe 0x433b60: звичайна машина на продаж).
    for (const own of this.ordered) {
      const rec = own.market === m.id && this.trucks.records.find((r) => r.carNode === own.carNode);
      if (rec) out.push({ rec, used: false, stolen: own.stolen, price: Math.round(rec.price * (own.stolen ? STOLEN_DISCOUNT : 1)), spot: own.spot, cluster: own.cluster, ordered: true });
    }
    for (const c of this.state.cars) {
      const rec = c.market === m.id && !out.some((o) => o.spot === c.spot) && this.trucks.records.find((r) => r.carNode === c.carNode);
      if (!rec) continue;
      if (c.group === 'hire') {
        out.push({ rec, used: false, price: rec.price, spot: c.spot, hire: true, cluster: c.cluster, name: c.name, photo: c.photo });
        continue;
      }
      const used = c.group === 1;
      const stolen = c.group === 2 || !!c.traded?.stolen;
      const price = carValue(rec.price, { used, stolen, damage: c.traded?.damage });
      out.push({ rec, used, stolen, price, spot: c.spot, cluster: c.cluster, damage: c.traded?.damage });
    }
    return out;
  }

  /**
   * Купівля (king.exe 0x4738c0): продавець і гравець міняються машинами — продавець лишається на місці зі старою
   * машиною гравця (той самий вік: зникне з наступним оновленням, коли простоїть свій строк). Без старої — місце
   * звільняється. Найм (0x476bc0 → 0x419760) — шукач роботи йде з місця.
   */
  sell(m: Market, item: ForSale, old?: { carNode: string; cluster: number; damage: number; stolen: boolean } | null): void {
    if (item.ordered) {
      this.ordered.splice(0, this.ordered.length, ...this.ordered.filter((o) => !(o.market === m.id && o.spot === item.spot)));
      // Замовлена — теж продавець (0x433b60): стара машина гравця лишається на цьому місці.
      if (old && !item.hire) this.state.cars.push({ market: m.id, spot: item.spot, group: 0, carNode: old.carNode, cluster: old.cluster, born: this.state.clock, traded: { damage: old.damage, stolen: old.stolen } });
    } else {
      const i = this.state.cars.findIndex((c) => c.market === m.id && c.spot === item.spot);
      if (i >= 0) {
        const c = this.state.cars[i];
        if (old && !item.hire) this.state.cars[i] = { ...c, carNode: old.carNode, cluster: old.cluster, traded: { damage: old.damage, stolen: old.stolen } };
        else this.state.cars.splice(i, 1);
      }
    }
    this.changed();
    this.hide(m.id);
  }

  /**
   * Куди пригнати замовлену машину (king.exe 0x433660): ринок з місцем-містом (прапорець 4) далі 500 м від абонента,
   * найближчий.
   */
  deliveryFor(from: THREE.Vector3): Market | null {
    let best: Market | null = null;
    let bd = Infinity;
    for (const m of this.list) {
      if (m.townSpot < 0) continue;
      const d = m.spots[m.townSpot].pos.distanceTo(from);
      if (d > DELIVERY_MIN && d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  /** Ринок, найближчий до точки (плата за доставку в продавця — N · 300 $ того ринку). */
  nearest(p: THREE.Vector3): Market | null {
    let best: Market | null = null;
    let bd = Infinity;
    for (const m of this.list)
      for (const s of m.spots) {
        const d = s.pos.distanceTo(p);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
    return best;
  }

  /** Поставити замовлену машину на місце-місто ринку (машину, що там стояла, прибирають — killPlayer 0x4466a0). */
  deliver(m: Market, car: Omit<OrderedCar, 'market' | 'spot'>): void {
    const spot = m.townSpot;
    this.ordered.splice(0, this.ordered.length, ...this.ordered.filter((o) => !(o.market === m.id && o.spot === spot)), { market: m.id, spot, ...car });
    this.state.cars = this.state.cars.filter((c) => !(c.market === m.id && c.spot === spot));
    this.changed();
    this.hide(m.id);
  }

  /** Ринок, біля місць якого стоїть вантажівка. */
  at(p: THREE.Vector3): Market | null {
    return this.list.find((m) => m.spots.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < NEAR_R)) ?? null;
  }

  /**
   * Машина на продаж, ближча за 20 м до точки (king.exe 0x56fc10: щокадру обхід машин із прапорцем «продається» чи
   * «шукає роботу», відстань між машинами < 20 м — подія 0x12/0x18, вікно «ПРОДАЁТСЯ» / «ИЩУ РАБОТУ»; швидкість не
   * перевіряється). Найближча з тих, що поруч.
   */
  nearSale(p: THREE.Vector3): { market: Market; item: ForSale } | null {
    let best: { market: Market; item: ForSale } | null = null;
    let bd = NEAR_R;
    for (const m of this.list) {
      if (!m.spots.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < NEAR_R + 5)) continue;
      for (const item of this.stock(m)) {
        const d = m.spots[item.spot].pos.distanceTo(p);
        if (d < bd) {
          bd = d;
          best = { market: m, item };
        }
      }
    }
    return best;
  }

  /** Показати машини на ринках поблизу (і сховати далекі); змінився набір машин ринку — перебудувати. */
  update(p: THREE.Vector3): void {
    for (const m of this.list) {
      const d = Math.min(...m.spots.map((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z)));
      const cur = this.shown.get(m.id);
      if (cur && (d > SHOW_R * 1.2 || (cur.rev !== this.rev && cur.sig !== this.signature(m)))) this.hide(m.id);
      else if (cur) cur.rev = this.rev;
      if (d < SHOW_R && !this.shown.has(m.id)) this.show(m);
    }
  }

  /** Що стоїть на ринку — рядком (чи треба перебудувати показані машини). */
  private signature(m: Market): string {
    return this.stock(m)
      .map((s) => `${s.spot}:${s.rec.carNode}#${s.cluster ?? 0}`)
      .join(',');
  }

  private show(m: Market): void {
    const parts: Shown['parts'] = [];
    for (const item of this.stock(m)) {
      const def = truckDef(this.trucks, item.rec);
      const model = def && buildTruckModel(this.trucks.asm, def, false);
      if (!model) continue;
      if (item.cluster) recolor(model.root, this.trucks, item.cluster + 1);
      const spot = m.spots[item.spot];
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      frame.add(model.root);
      const root = new THREE.Group();
      root.add(frame);
      root.updateMatrixWorld(true);
      const box = visibleBox(model.root);
      frame.position.y = -box.min.y;
      const at = spot.pos.clone();
      at.y = this.ground(spot.pos);
      root.position.copy(at);
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), spot.heading, new THREE.Vector3(0, 1, 0)));
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z).setRotation(root.quaternion));
      this.rapier.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setTranslation(center.x, center.y - box.min.y, center.z)
          .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        body,
      );
      this.scene.add(root);
      parts.push({ root, body });
    }
    this.shown.set(m.id, { market: m, rev: this.rev, sig: this.signature(m), parts });
  }

  private hide(id: number): void {
    const s = this.shown.get(id);
    if (!s) return;
    for (const p of s.parts) {
      this.scene.remove(p.root);
      this.rapier.removeRigidBody(p.body);
    }
    this.shown.delete(id);
  }

  dispose(): void {
    for (const id of [...this.shown.keys()]) this.hide(id);
  }
}
