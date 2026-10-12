import type { Order } from './economy';

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
}

export interface Ht2Career {
  driver: string;
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
  /** Встановлені покращення (`PR_ID:варіант`, див. upgrades.ts); переходять на нову вантажівку (гіпотеза). */
  upgrades?: string[];
  /** Вмʼятини за зонами кузова (0…1, dents.ts); ремонт на СТО скидає. */
  dents?: Partial<Record<string, number>>;
  /** Остання позиція (координати гри) і склад, де стоїмо. */
  pos?: [number, number, number];
  heading?: [number, number];
}

const KEY = 'ht2.career.v1';
export const START_MONEY = 5000;
export const REPAIR_PER_PERCENT = 30;
export const FUEL_PRICE = 1;
/**
 * Ігровий час іде вдесятеро швидше за реальний (доба — 2,4 год гри; гіпотеза: TRUCK.INI [EFFECTS] timetemp=0.2,
 * timestart=10 — темп і година старту, одиниці невідомі). Терміни доставки — в ігровому часі.
 */
export const TIME_SCALE = 10;

/** Пора доби за годиною (WEATHER.INI: night, srise, day, sset). */
export function dayTime(t: number): 'night' | 'srise' | 'day' | 'sset' {
  const h = (t / 3600) % 24;
  return h < 5 || h >= 22 ? 'night' : h < 8 ? 'srise' : h < 19 ? 'day' : 'sset';
}

export function newCareer(driver: string, truck: string): Ht2Career {
  return { driver, money: START_MONEY, truck, damage: 0, fuel: null, time: 8 * 3600, order: null, delivered: 0, earned: 0 };
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
