/**
 * Конкуренція за вантаж (G9 Б8; посібник: «ПОЗИЦИЯ N из M», премія першому, Ms.sch COMPETITOR_ARRIVED). Разом із
 * гравцем те саме замовлення беруть кілька далекобійників (3–7 на повному трафіку).
 *
 * Як у king.exe (`provideCompetitionRegular` 0x4262a0 / `provideCompetitionSpecial` 0x425dd0, re/notes/ht2/company.md
 * §4): суперники — **справжні далекобійники світу** (traffic/fleet.ts), їм дають те саме замовлення (везуть до того
 * самого складу); маршрут гравця довший за SPECIAL_ROUTE — їх ставлять на дорогу гравця: `ahead` попереду через
 * SPACING м, решту позаду. Далеко від гравця вони їдуть «гумовою ниткою» (`rubber`, prescribeAdvance 0x41a9d0).
 * Тоді `RivalRun.member` — номер водія у Fleet, `left` — скільки йому лишилось дорогами.
 *
 * Без водія (`member` немає: старі збереження, світ без далекобійників) — як раніше, розрахунок часу: довжина маршруту
 * / середня швидкість (гіпотеза порту).
 *
 * Гіпотези порту: імовірність CHANCE, що замовлення взагалі беруть суперники (king.exe перевіряє поле замовлення
 * `+0x68` = 1 і прапорець складу — зміст не розібрано); x = 1 у формулі кількості; хто з водіїв іде в суперники —
 * найближчі до гравця (предикат king.exe не розібрано); знак «гумової нитки» (поле `+0x1f8` — гіпотеза: що лишилось).
 */
export interface RivalRun {
  name: string;
  /** Час у дорозі до складу, с реального часу (суперник без водія). */
  eta: number;
  /** Скільки вже їде, с (від’їжджає із затримкою — від’ємне на старті). */
  t: number;
  /** Відмовився (відкупились, мафія, «скинь вантаж»). */
  out?: boolean;
  /** Уже доїхав. */
  done?: boolean;
  /** Не бере хабарів («без шансів»). */
  stubborn?: boolean;
  /** Справжній водій: номер у Fleet.members (імʼя — name). */
  member?: number;
  /** Скільки водію лишилось дорогами до складу, м (оновлює careerMode). */
  left?: number;
  /** Затримати водія ще на стільки, с (міліція за хабар) — careerMode передає водію й обнуляє. */
  delay?: number;
  /** Множник швидкості водія («не поспішатиме»), 1 — як є. */
  slow?: number;
}

/** Ймовірність, що замовлення беруть і суперники (гіпотеза порту). */
const CHANCE = 0.6;
/** Суперник без водія: найбільше суперників, середня швидкість, м/с (≈ 55 км/год), розкид ±15 %. */
const MAX_RIVALS = 3;
const SPEED = 55 / 3.6;
/** Премія першому — частка оплати. */
export const PREMIUM_SHARE = 0.25;

/** king.exe: маршрут довший (0x64b730) — суперників ставлять на дорогу гравця (provideCompetitionSpecial), м. */
export const SPECIAL_ROUTE = 1000;
/** Крок між суперниками на дорозі (0x64b728), м; розкид — rand % 20 − 10 (0x64b780). */
export const SPACING = 150;
/** «Гумова нитка» (0x41a9d0): частка ±0,4 (0x66c6b8/0x66c6c0) на відставанні 300 м (0x66c708), не повільніше 35 км/год. */
const RUBBER_K = 0.4;
const RUBBER_RANGE = 300;
export const RUBBER_MIN = 9.722222222222221;

/**
 * Скільки суперників і скільки з них попереду (king.exe 0x425610): N = 3 + rand % (ftol(3,1·x + 4) − 2), x — густота
 * трафіку 0…1 (0x66c6f0 = повзунок trafs × частка за памʼяттю / 100 · 0,01, 0x515710 → 0x571f20) → повний трафік
 * 3…7, найменший 3…4; попереду — rand & 3 (0…3). Порожньо — замовлення без конкуренції.
 */
export function rivalPlan(density = 1, rnd = Math.random): { count: number; ahead: number } {
  if (rnd() > CHANCE) return { count: 0, ahead: 0 };
  const span = Math.floor(3.1 * Math.max(0, Math.min(1, density)) + 4) - 2;
  return { count: 3 + Math.floor(rnd() * span), ahead: Math.floor(rnd() * 4) };
}

/**
 * Зсуви суперників уздовж дороги від гравця, м (provideCompetitionSpecial 0x425dd0): k = ahead − i (k < 1 → k − 1),
 * зсув = k·SPACING + rand % 20 − 10; ближче SPACING — рівно ±SPACING. Перші `ahead` — попереду, решта — позаду.
 */
export function specialOffsets(count: number, ahead: number, rnd = Math.random): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    let k = ahead - i;
    if (k < 1) k -= 1;
    let off = k * SPACING + Math.floor(rnd() * 20) - 10;
    if (off > -SPACING && off < 0) off = -SPACING;
    else if (off > 0 && off < SPACING) off = SPACING;
    out.push(off);
  }
  return out;
}

/**
 * Швидкість суперника, що далеко (абстрактно), м/с: playerSpeed — згладжена швидкість гравця; behind — на скільки
 * суперникові лишилось більше, ніж гравцеві, м (> 0 — відстає: швидше, < 0 — попереду: повільніше).
 */
export function rubber(playerSpeed: number, behind: number): number {
  const x = Math.min(1, Math.abs(behind) / RUBBER_RANGE);
  return Math.max(RUBBER_MIN, playerSpeed * (behind > 0 ? 1 + RUBBER_K * x : 1 - RUBBER_K * x));
}

/** Доповнення суперників до N — задача king.exe кожні 30 с (0x434780 → provideCompetitionRegular), с. */
export const TOP_UP_EVERY = 30;
/** Новий суперник при доповненні — не ближче за стільки до гравця вздовж маршруту (0x66c6b0), м. */
export const TOP_UP_AWAY = 400;

/**
 * Крок між суперниками, яких доповнено (0x4262a0): ahead < 2 — 20 м; інакше clamp(min(400·(ahead − 1),
 * 0,33·route), 400, 3000) / (ahead − 1) (0x64b7e8 = 0,33, 0x64b768 = 400, 0x64b7e0 = 3000; route — поле замовлення
 * `+0x70`, гіпотеза: довжина маршруту). Новий стає за TOP_UP_AWAY + rand % крок + (скільки вже є) · крок.
 */
export function topUpSpacing(ahead: number, route: number): number {
  if (ahead < 2) return 20;
  const d = Math.min(400 * (ahead - 1), 0.33 * route);
  return Math.max(400, Math.min(3000, d)) / (ahead - 1);
}

/**
 * Скільки суперників доповнити й як (0x4262a0): рахуються ті, хто змагається, і ті, хто вже доїхав (`0x68d164`);
 * зійшли — ні. Нікого в грі й маршрут гравця довший за SPECIAL_ROUTE — увесь набір знову довкола гравця
 * (`special`, provideCompetitionSpecial); інакше — від складу відправлення далі TOP_UP_AWAY від гравця.
 */
export function topUpPlan(rivals: readonly RivalRun[], target: number, playerLeft: number | null): { missing: number; special: boolean; live: number } {
  const live = rivals.filter((r) => !r.out).length;
  const racing = rivals.filter((r) => !r.out && !r.done).length;
  const missing = Math.max(0, target - live);
  return { missing, live, special: missing > 0 && racing === 0 && live === 0 && (playerLeft ?? 0) > SPECIAL_ROUTE };
}

/** Суперники без водіїв для нового замовлення (може бути порожньо): route — довжина маршруту, м. */
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

/** Частка шляху суперника 0…1 (з водієм — за тим, що лишилось, від маршруту route). */
export function progress(r: RivalRun, route = 0): number {
  if (r.done) return 1;
  if (r.member !== undefined) return r.left === undefined || route <= 0 ? 0 : Math.max(0, Math.min(1, 1 - r.left / route));
  return Math.max(0, Math.min(1, r.t / r.eta));
}

/** Позиція гравця (частка шляху player) серед суперників у грі. */
export function place(rivals: readonly RivalRun[], player: number, route = 0): { place: number; of: number } {
  const list = active(rivals);
  return { place: 1 + list.filter((r) => progress(r, route) > player).length, of: list.length + 1 };
}

/** Крок суперників без водіїв: їдуть за часом; повертає тих, хто щойно доїхав. */
export function advance(rivals: RivalRun[], dt: number): RivalRun[] {
  const arrived: RivalRun[] = [];
  for (const r of rivals) {
    if (r.out || r.done || r.member !== undefined) continue;
    r.t += dt;
    if (r.t >= r.eta) {
      r.done = true;
      arrived.push(r);
    }
  }
  return arrived;
}

/** Міліція затримує суперника (рація, хабар): без водія — +s до часу в дорозі, з водієм — стоїть s. */
export function delayRival(r: RivalRun, s: number): void {
  if (r.member !== undefined) r.delay = (r.delay ?? 0) + s;
  else r.eta += s;
}

/** «Не поспішатиме» (рація суперникові): у 1,3 раза повільніше. */
export function slowRival(r: RivalRun): void {
  if (r.member !== undefined) r.slow = (r.slow ?? 1) / 1.3;
  else r.eta *= 1.3;
}
