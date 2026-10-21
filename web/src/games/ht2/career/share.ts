import type { Ht2Career } from './career';

/**
 * Частка гравця X — «доля перевезень» (king.exe updateRating 0x41fcf0 кожні 8 с, 0x41b910/0x41b830;
 * re/notes/ht2/police.md «Частка X гравця»): вантажопідйомність флоту компанії (своя вантажівка + вантажівки
 * найманих; причепи й гроші не важать) ÷ сума вантажопідйомності всіх далекобійників. Від X залежать: інтерес мафії
 * (> 0,15), засідки мафії (> 0,2), прихований нелегальний товар (> 0,25), тариф найманого (1 + 4X), перемога
 * (X ≥ 0,51).
 *
 * Гіпотези порту: далекобійників ІІ — RIVALS (GAME.CNF `aitruck 50`), наймані гравця — з їхнього числа (шукачі
 * роботи в king.exe — звичайні далекобійники ІІ, company.md §2); решта їздять машинами класу trucker з evehicles.sch
 * (rivalLoad — середня вантажопідйомність цих моделей) і машин не міняють.
 */
export const RIVALS = 50;
/** Поріг перемоги «ринок захоплено» (0x66c710); після перемоги — 1,05, тобто більше не перевіряється. */
export const WIN_SHARE = 0.51;

/** Вантажопідйомність флоту гравця, кг: своя вантажівка й машини найманих. */
export function fleetLoad(c: Ht2Career, load: (carNode: string) => number): number {
  return load(c.truck) + (c.company ?? []).reduce((s, d) => s + load(d.truck), 0);
}

/** Флот гравця мережевої кар'єри: вантажопідйомність (своя машина + наймані), кг, і скільки найнято. */
export interface FleetStanding {
  load: number;
  hired: number;
}

/**
 * Частка X у мережевій кар'єрі (М6, «змагання за ринок» — власний режим порту; у king.exe мережевої кар'єри немає):
 * інші гравці — такі самі конкуренти, як гравець, поза пулом RIVALS; наймані будь-ким — з пулу далекобійників ІІ.
 * X_i = load_i ÷ (Σ load усіх гравців + max(0, RIVALS − Σ найнятих усіма)·rivalLoad) — однакова на всіх телефонах.
 */
export function netMarketShare(mine: FleetStanding, others: readonly FleetStanding[], rivalLoad: number, rivals = RIVALS): number {
  const players = [mine, ...others];
  const load = players.reduce((s, p) => s + p.load, 0);
  const hired = players.reduce((s, p) => s + p.hired, 0);
  const total = load + Math.max(0, rivals - hired) * rivalLoad;
  return total > 0 ? mine.load / total : 0;
}

/** Частка X 0…1; rivalLoad — вантажопідйомність машини далекобійника ІІ, кг. */
export function marketShare(c: Ht2Career, load: (carNode: string) => number, rivalLoad: number, rivals = RIVALS): number {
  const mine = fleetLoad(c, load);
  const others = Math.max(0, rivals - (c.company?.length ?? 0)) * rivalLoad;
  return mine + others > 0 ? mine / (mine + others) : 0;
}
