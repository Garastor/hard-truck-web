import type { Fines } from './law';
import type { Order } from './economy';
import type { RivalRun } from './competition';
import type { HiredDriver } from './company';
import type { SavedPresent, TrailerChoice } from '../vehicles/presents';
import type { OrderedCar } from './market';

/**
 * Кар'єра Дальнобойщиків 2 (перша версія): гроші, вантажівка, стан, поточне замовлення, ігровий час. Зберігається в
 * цьому браузері (localStorage `ht2.career.v1`) — окремо від кар'єр першої гри.
 *
 * Гіпотези порту: стартові гроші 5000 $; ремонт — 30 $ за відсоток пошкодження; неустойка за прострочення —
 * половина цінності вантажу, за пошкодження — частка цінності, що дорівнює частці пошкодження; пальне — $1 за літр
 * (restable.sch: PR_FUEL «Fuel» 100 — одиниці невідомі).
 */
export interface ActiveOrder extends Order {
  /** Ігровий час прийняття, с. */
  taken: number;
  /** Цілісність вантажу 0…1. */
  integrity: number;
  /** Конкуренти з тим самим замовленням (competition.ts), довжина маршруту мережею, м, і премія першому. */
  rivals?: RivalRun[];
  route?: number;
  premium?: number;
  /** Суперник доїхав раніше — премії не буде. */
  beaten?: boolean;
}

export interface Ht2Career {
  driver: string;
  /** Логотип (0…7, `d/logo1…8`) і фото (0…50, `d/photo01…51`) водія — меню «Водії» (king.exe .pl1). */
  logo?: number;
  photo?: number;
  money: number;
  truck: string;
  /** Пошкодження машини 0…1. */
  damage: number;
  /** Пальне в баку, л (null — повний бак, ще не їздили). */
  fuel: number | null;
  /** Ігровий час, с. */
  time: number;
  order: ActiveOrder | null;
  delivered: number;
  earned: number;
  /** Перевезено, т (рейтинг F2). */
  tons?: number;
  /** Ринок захоплено (частка X ≥ 0,51, вікно BackWin): більше не перевіряється (king.exe — поріг 1,05). */
  won?: boolean;
  /** Скільки разів доставлено першим серед конкурентів (ліцензії на найм — G9 Б7). */
  firsts?: number;
  /** Ліцензії на найм: ігровий час закінчення кожної. */
  licences?: number[];
  /** Наймані водії (company.ts). */
  company?: HiredDriver[];
  /** Встановлені покращення (`PR_ID:варіант`, див. upgrades.ts); переходять на нову вантажівку (гіпотеза). */
  upgrades?: string[];
  /** Протипожежна система: скільки зарядів витрачено (з 4; king.exe 0x5494c0). */
  fireUsed?: number;
  /** Вмʼятини за зонами кузова й шини (`W0`…, частки 0…1, dents.ts); ремонт на СТО скидає. */
  dents?: Partial<Record<string, number>>;
  /** Вмʼятини й шини напівпричепа (так само). */
  trailerDents?: Partial<Record<string, number>>;
  /** Напівпричіп тягача — підібраний на базі (vehicles/presents.ts); null — без причепа (тягач купується без нього). */
  trailer?: TrailerChoice | null;
  /** Причепи-presents (бази, дорожні місії, кинуті гравцем з вантажем) — vehicles/presents.ts. */
  presents?: SavedPresent[];
  /** Діючий завал (id `obstacle` з mod_*.sch, world/obstacles.ts); null — жодного. */
  obstacle?: string | null;
  /** Замовлені рацією машини, що чекають на ринках (career/carOrder.ts). */
  orderedCars?: OrderedCar[];
  /** Перемог у гонках на Кільці поспіль (career/races.ts: ліцензії за перемогу). */
  raceWins?: number;
  /** Штрафи, що висять на гравці (law.ts): розшук міліцією до затримання чи хабара. */
  fines?: Fines;
  /** Машина крадена (куплена на ринку як крадена): міліція з імовірністю 50 % вважає її викраденою. */
  stolen?: boolean;
  /** Камери-радари, що вже спрацювали (номери; кожна штрафує раз за гру — traffic/radars.ts). */
  radars?: number[];
  /** Ціна моделі нової — для відшкодування за крадену (0,8 ціни). */
  truckPrice?: number;
  /** Остання позиція (координати гри) і склад, де стоїмо. */
  pos?: [number, number, number];
  heading?: [number, number];
}

const KEY = 'ht2.career.v1';
export const START_MONEY = 5000;
export const REPAIR_PER_PERCENT = 30;
export const FUEL_PRICE = 1;
/**
 * Ігровий час (`time`, с від початку кар'єри) іде з темпом повзунка «тривалість доби» (settings.timeScale); старт —
 * 10:00, як в оригіналі (TRUCK.INI timestart=10).
 */

export function newCareer(driver: string, truck: string): Ht2Career {
  return { driver, money: START_MONEY, truck, damage: 0, fuel: null, time: 10 * 3600, order: null, delivered: 0, earned: 0 };
}

export function loadCareer(): Ht2Career | null {
  try {
    const s = localStorage.getItem(KEY);
    return s ? (JSON.parse(s) as Ht2Career) : null;
  } catch {
    return null;
  }
}

export function saveCareer(c: Ht2Career): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(c));
  } catch {
    /* приватний режим */
  }
}

export function clearCareer(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* приватний режим */
  }
}

/** Розрахунок доставки: оплата мінус неустойки. */
export function settle(o: ActiveOrder, now: number): { pay: number; late: boolean; damagePenalty: number; latePenalty: number } {
  const late = now - o.taken > o.deadline;
  const damagePenalty = Math.round(o.value * (1 - o.integrity));
  const latePenalty = late ? Math.round(o.value * 0.5) : 0;
  return { pay: Math.max(0, o.pay - damagePenalty - latePenalty), late, damagePenalty, latePenalty };
}

export function formatMoney(v: number): string {
  return `$${Math.round(v).toLocaleString('uk-UA')}`;
}

export function formatClock(t: number): string {
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
