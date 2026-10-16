import { isList, num, str, type SExpr } from '../formats/sexpr';

/**
 * Штрафи, що «висять» на гравці, — запис гравця king.exe (+0xC8…+0x108; re/notes/ht2/police.md §0, §2, §4, §7).
 * Поки є хоч один, гравець розшукуваний: міліція, що його бачить, жене й зупиняє. Після затримання — одна картка
 * (9–14) чи підсумкова 15, сума списується з грошей (без перевірки на мінус), штрафи обнуляються.
 */
export interface Fines {
  /** Нелегальний вантаж (FINE_IM): Σ 15000 × коефіцієнт товару. */
  illegal: number;
  /** Відшкодування за ДТП (FINE_ACCIDENT) і біти порушень ПДР для картки 14. */
  accident: number;
  violations: number;
  /** Перевищення на посту (FINE_SPEEDING): 250 × ступінь. */
  speeding: number;
  /** Червоне світло (FINE_RED_LIGHT): 830 за проїзд. */
  redLight: number;
  /** Спроба підкупу (FINE_BRIBERY): 200 / 500 / 300. */
  bribery: number;
  /** Машина в угоні (FINE_STOLEN): 0,8 базової ціни моделі. */
  stolen: number;
}

export function noFines(): Fines {
  return { illegal: 0, accident: 0, violations: 0, speeding: 0, redLight: 0, bribery: 0, stolen: 0 };
}

/** Штраф за ступінь перевищення на посту (king.exe 0x4d1360). */
export const SPEEDING_PER_DEGREE = 250;
/** Проїзд на червоне за міліції в радіусі 200 м (0x64ff18). */
export const RED_LIGHT_FINE = 830;

/** Порядок полів, картка затримання з одним штрафом і рядок Ms.sch (0x430a80). */
const KINDS: [Exclude<keyof Fines, 'violations'>, 9 | 10 | 11 | 12 | 13 | 14, string][] = [
  ['illegal', 9, 'FINE_IM'],
  ['accident', 14, 'FINE_ACCIDENT'],
  ['speeding', 10, 'FINE_SPEEDING'],
  ['redLight', 12, 'FINE_RED_LIGHT'],
  ['bribery', 11, 'FINE_BRIBERY'],
  ['stolen', 13, 'FINE_STOLEN'],
];

/** Порушення ПДР (біти +0xD8) → ключ Ms.sch для картки 14. */
export const VIOLATIONS: [number, string][] = [
  [1, 'VIOLATION_WRONG_SIDE'],
  [2, 'VIOLATION_REVERSE_GEAR'],
  [4, 'VIOLATION_ILLEGAL_PARKING'],
  [8, 'VIOLATION_CROSSING_FULL_LINE'],
  [0x10, 'VIOLATION_CHANGING_LANE'],
  [0x20, 'VIOLATION_NEGLIGENCE'],
];

export function wanted(f: Fines): boolean {
  return KINDS.some(([k]) => f[k] > 0);
}

export function totalFine(f: Fines): number {
  return KINDS.reduce((s, [k]) => s + f[k], 0);
}

/**
 * Ступінь перевищення на посту з лімітом (км/год): 3 — понад ліміт + 35, 2 — понад + 15, інакше 1; 0 — не
 * перевищено (king.exe порівнює м/с із (ліміт − 5 + 40)/3,6 і (ліміт − 5 + 20)/3,6).
 */
export function speedDegree(kmh: number, limit: number): 0 | 1 | 2 | 3 {
  if (kmh <= limit) return 0;
  if (kmh > limit + 35) return 3;
  if (kmh > limit + 15) return 2;
  return 1;
}

export interface ArrestCard {
  card: 9 | 10 | 11 | 12 | 13 | 14 | 15;
  amount: number;
  /** Ключі Ms.sch з сумами (картка 15 — перелік, 14 — порушення). */
  lines: { key: string; amount?: number }[];
}

/** Картка затримання (0x430a80): один штраф — своя картка, кілька — 15 «Итого» з переліком рядків FINE_*. */
export function arrestCard(f: Fines): ArrestCard | null {
  const due = KINDS.filter(([k]) => f[k] > 0);
  if (!due.length) return null;
  const amount = totalFine(f);
  if (due.length > 1) return { card: 15, amount, lines: due.map(([k, , key]) => ({ key, amount: f[k] })) };
  const [, card] = due[0];
  const lines = card === 14 ? VIOLATIONS.filter(([bit]) => f.violations & bit).map(([, key]) => ({ key })) : [];
  return { card, amount, lines };
}

/**
 * Сума хабара міліції (queryBribeSum 0x4315f0): x − c (c = 200 за штраф, 500 за «дах»), округлена вгору до 10ⁿ,
 * n = min(2, ⌊lg − 0,302⌋). Гіпотеза: lg — від суми після віднімання. ≤ 0 — хабара не просять.
 */
export function bribeSum(x: number, c: number): number {
  const y = x - c;
  if (y <= 0) return 0;
  const n = Math.max(0, Math.min(2, Math.trunc(Math.log10(y) - 0.302)));
  const step = 10 ** n;
  return Math.ceil(y / step) * step;
}

/**
 * Чи бере хабар інспектор COP1…COP15 (names.sch: `("COP4" male police 4 1)` — біт 0 останнього числа; гіпотеза, що
 * king.exe перевіряє саме це поле, 0x474260). Повертає перелік за номером (індекс 0 — COP1).
 */
export function copsTakeBribes(names: SExpr[]): boolean[] {
  return names.filter((e): e is SExpr[] => isList(e) && e[2] === 'police' && /^COP\d+$/i.test(str(e[0]))).map((e) => (num(e[e.length - 1]) & 1) === 1);
}
