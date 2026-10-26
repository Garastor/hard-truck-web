/**
 * Машини мережевої гри: кожен варіант моделі — окремий запис зі своїм фото. Фото — ті самі, що у вікні замовлення
 * машини в продавця (`m16\<car_node><колір 1–4>.msk` з COMMON/esc16.RES, career/carOrder.ts): у тягача й кузовного
 * варіанта вони різні (`m16\Daf1.msk` — тягач, `m16\DafR1.msk` — кузовна). Без esc16.RES — картинка марки з екрана
 * «Мережева гра» оригіналу (`n/<марка><колір 0–3>.msk` з LOAD.RES, одна на марку).
 *
 * Набір — моделі вікна замовлення (ORDER_MODELS), що є в vehicle.tech (Toyota там немає). Порядок — за марками,
 * варіанти поруч: стрілки гортають «Renault — кузовна» → «Renault — тягач» → наступна марка.
 */
import type { NetCar, NetSetup } from './peer';

export type CarKind = 'lorry' | 'tractor' | 'car';

export interface NetModel {
  /** car_node (vehicle.tech) — він же імʼя фото `m16\<truck><колір>.msk`. */
  truck: string;
  /** Марка для запасної картинки `n/<brand><колір>.msk` (LOAD.RES); null — такої немає. */
  brand: string | null;
  name: string;
  kind: CarKind;
}

const m = (truck: string, brand: string | null, name: string, kind: CarKind): NetModel => ({ truck, brand, name, kind });

export const NET_MODELS: readonly NetModel[] = [
  m('RenaultR', 'reno', 'Renault', 'lorry'),
  m('Renault', 'reno', 'Renault', 'tractor'),
  m('VolvoR', 'volvo', 'Volvo', 'lorry'),
  m('Volvo', 'volvo', 'Volvo', 'tractor'),
  m('ScaniaR', 'scania', 'Scania', 'lorry'),
  m('Scania', 'scania', 'Scania', 'tractor'),
  m('MercedesR', 'mers', 'Mercedes', 'lorry'),
  m('Mercedes', 'mers', 'Mercedes', 'tractor'),
  m('DafR', 'daf', 'DAF', 'lorry'),
  m('Daf', 'daf', 'DAF', 'tractor'),
  m('KamazR', 'kamaz', 'КамАЗ', 'lorry'),
  m('Kamaz', 'kamaz', 'КамАЗ', 'tractor'),
  m('ZilR', 'zil', 'ЗіЛ', 'lorry'),
  m('Zil', 'zil', 'ЗіЛ', 'tractor'),
  m('StormR', 'storm', 'Storm', 'lorry'),
  m('Storm', 'storm', 'Storm', 'tractor'),
  m('Mack', 'mack', 'Mack', 'tractor'),
  m('Kenworth', 'kenw', 'Kenworth', 'tractor'),
  m('Freightliner', 'frei', 'Freightliner', 'tractor'),
  m('Peterbilt', 'peter', 'Peterbilt', 'tractor'),
  m('International', 'inter', 'International', 'tractor'),
  m('Sobol', 'sobol', 'Соболь', 'lorry'),
  m('Gazelle', 'gaz', 'ГАЗель', 'car'),
  m('Patrol', 'patrol', 'Nissan Patrol', 'car'),
  m('BmwM5', 'bmw', 'BMW M5', 'car'),
  m('Cayman', null, 'Porsche Cayman', 'car'),
];

export const KIND_NAME: Record<CarKind, string> = { lorry: 'кузовна', tractor: 'тягач', car: 'легкова' };

/** Типова машина — RenaultR (`live 1 "RenaultR"` у MENV/GAME.CNF). */
export const DEFAULT_CAR: NetCar = { truck: 'RenaultR', color: 0 };

export function netModel(truck: string): NetModel | undefined {
  return NET_MODELS.find((c) => c.truck === truck);
}

/** «Renault — кузовна», «Mack — тягач». */
export function carName(truck: string): string {
  const c = netModel(truck);
  return c ? `${c.name} — ${KIND_NAME[c.kind]}` : truck;
}

/** Фото варіанта в esc16.RES (колір 0…3 → 1…4, як у вікні замовлення). */
export function carPhoto(truck: string, color: number): string {
  return `m16\\${truck}${(color & 3) + 1}.msk`;
}

/** Запасна картинка марки в LOAD.RES (null — немає). */
export function brandPhoto(truck: string, color: number): string | null {
  const b = netModel(truck)?.brand;
  return b ? `n/${b}${color & 3}.msk` : null;
}

/** Найбільше суперників на автопілоті в мережевій гонці (точне число з екрана налаштувань). */
export const MAX_RIVALS = 15;

/** Кількість суперників у межах 0…MAX_RIVALS (ціле). */
export function clampRivals(n: number): number {
  return Math.max(0, Math.min(MAX_RIVALS, Math.round(Number.isFinite(n) ? n : 0)));
}

/** Чи бувають суперники на автопілоті в цьому режимі (Автобол — ні, як у king.exe; кар'єра — далекобійники світу). */
export function hasRivals(track: NetSetup['track']): boolean {
  return track === 'ring' || track === 'trial';
}

/**
 * Суперники господаря (перед стартом): рівно setup.rivals машин (Автобол і кар'єра — жодної). Вантажівки й тягачі без
 * Storm (12 м і більше — довгі для решітки), спершу ті, яких немає в гравців; кольори по колу.
 */
export function pickRivals(setup: NetSetup, taken: readonly string[]): NetCar[] {
  if (!hasRivals(setup.track)) return [];
  const pool = NET_MODELS.filter((c) => c.kind !== 'car' && c.truck !== 'Sobol' && !c.truck.startsWith('Storm')).map((c) => c.truck);
  const busy = new Set(taken);
  const from = [...spread(pool.filter((t) => !busy.has(t))), ...spread(pool.filter((t) => busy.has(t)))];
  return Array.from({ length: clampRivals(setup.rivals) }, (_, i) => ({ truck: from[i % from.length], color: i % 4 }));
}

/** Список вразбивку (крок, взаємно простий із довжиною): сусідні суперники — різних марок. */
function spread<T>(a: T[]): T[] {
  const gcd = (x: number, y: number): number => (y ? gcd(y, x % y) : x);
  const step = [5, 7, 3, 1].find((s) => gcd(s, a.length) === 1) ?? 1;
  return a.map((_, i) => a[(i * step) % a.length]);
}
