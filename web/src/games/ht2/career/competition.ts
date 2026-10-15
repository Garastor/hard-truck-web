/**
 * Конкуренція за вантаж (G9 Б8; посібник: «ПОЗИЦИЯ N из M», премія першому, Ms.sch COMPETITOR_ARRIVED). Разом із
 * гравцем те саме замовлення беруть кілька далекобійників (names.sch); кожен їде своїм темпом: час у дорозі —
 * довжина маршруту мережею WAY / середня швидкість. Позиція гравця — скільки суперників пройшли більшу частку шляху.
 * Хто приїхав першим — премія. Скільки суперників, їхня швидкість, премія — гіпотези порту: як king.exe роздає
 * замовлення суперникам, не розібрано.
 */
export interface RivalRun {
  name: string;
  /** Час у дорозі до складу, с реального часу. */
  eta: number;
  /** Скільки вже їде, с (від’їжджає із затримкою — від’ємне на старті). */
  t: number;
  /** Відмовився (відкупились, мафія, «скинь вантаж»). */
  out?: boolean;
  /** Уже доїхав. */
  done?: boolean;
  /** Не бере хабарів («без шансів»). */
  stubborn?: boolean;
}

/** Ймовірність, що замовлення беруть і суперники; найбільше суперників. */
const CHANCE = 0.6;
const MAX_RIVALS = 3;
/** Середня швидкість суперника, м/с (≈ 55 км/год), розкид ±15 %. */
const SPEED = 55 / 3.6;
/** Премія першому — частка оплати. */
export const PREMIUM_SHARE = 0.25;

/** Суперники для нового замовлення (може бути порожньо): route — довжина маршруту, м. */
export function makeRivals(route: number, names: readonly string[], rnd = Math.random): RivalRun[] {
  if (!names.length || route <= 0 || rnd() > CHANCE) return [];
  const n = 1 + Math.floor(rnd() * MAX_RIVALS);
  const out: RivalRun[] = [];
  for (let i = 0; i < n; i++) {
    const v = SPEED * (0.85 + 0.3 * rnd());
    out.push({ name: names[Math.floor(rnd() * names.length)], eta: route / v, t: -(10 + 50 * rnd()), stubborn: rnd() < 0.35 });
  }
  return out;
}

/** Хто ще змагається. */
export function active(rivals: readonly RivalRun[]): RivalRun[] {
  return rivals.filter((r) => !r.out);
}

/** Частка шляху суперника 0…1. */
export function progress(r: RivalRun): number {
  return r.done ? 1 : Math.max(0, Math.min(1, r.t / r.eta));
}

/** Позиція гравця (частка шляху player) серед суперників у грі. */
export function place(rivals: readonly RivalRun[], player: number): { place: number; of: number } {
  const list = active(rivals);
  return { place: 1 + list.filter((r) => progress(r) > player).length, of: list.length + 1 };
}

/** Крок: суперники їдуть; повертає тих, хто щойно доїхав. */
export function advance(rivals: RivalRun[], dt: number): RivalRun[] {
  const arrived: RivalRun[] = [];
  for (const r of rivals) {
    if (r.out || r.done) continue;
    r.t += dt;
    if (r.t >= r.eta) {
      r.done = true;
      arrived.push(r);
    }
  }
  return arrived;
}
