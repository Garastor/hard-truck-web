import { PAY_PER_M, type Goods, type Store } from './economy';

/**
 * Наймані водії — за king.exe (re/notes/ht2/company.md §2, 2а). Ліцензію дають за доставку першим серед конкурентів і
 * за перемогу на Кільці; вона має строк. Водій шукає роботу на стоянці ринку (вікно `BackJob`).
 * - тариф (0x477350) — (1 + 4·s) · ціна моделі / 1024 $/км, s — частка капіталу гравця;
 * - найм (0x476bc0) — ліцензія й гроші більше за 10·тариф + вартість машини водія: вартість машини й аванс 10·тариф
 *   ідуть водієві, машина лишається в нього;
 * - робота (0x423f40) — аванс −= тариф·d·0,001 (d — пройдені метри); вичерпано — роботодавець платить ще 10·тариф,
 *   нема чим — водій іде (NO_MONEY_FOR_ADVANCE); пальне — d·R·0,00002 $ з роботодавця (бака немає);
 * - замовлення — як у далекобійника ІІ (0x4185d0): порожнім — до найближчого складу, там 85 % місткості товару складу
 *   до іншого складу; оплата 12·(PAY_PER_M·L + (1,2 − k)·√(ціна·кількість)), з причепом ×1,5 — уся роботодавцю, без
 *   строків, неустойок і повідомлень (лічильник прибутку водія росте);
 * - звільнення (0x476f70) — водій повертає вартість машини, аванс лишає собі; аварій і поломок абстрактний рух не має.
 *
 * Гіпотези порту: R (витрата tech+0x9c, порт поля не читає) ≈ 3 · fuelConsumption (у ЗіЛа king.exe R = 12,33);
 * тягач найманого везе «з причепом» (×1,5).
 */
export interface HiredDriver {
  name: string;
  /** car_node машини водія. */
  truck: string;
  /** Тариф, $/км (до версії 2 збереження — $ за 10 км). */
  tariff: number;
  /** Номер фото escphotoNN. */
  photo: number;
  /** Пробіг, км. */
  km: number;
  /** Застарілі поля першої версії (оплата й доставка за кілометрами). */
  nextPay?: number;
  nextDelivery?: number;
  /** Залишок авансу, $ (вичерпано — роботодавець платить ще 10·тариф). */
  advance: number;
  /** Принесено роботодавцю, $. */
  profit: number;
  /** Вартість машини водія — повертає при звільненні, $. */
  value?: number;
  /** Рейс: склад-ціль і вантаж (є — везе до складу призначення). */
  trip?: { to: number; load?: { goods: string; units: number; pay: number } };
  /** Де водій на дорогах (career/hired.ts): лінія мережі, відстань уздовж неї, маршрут (імена ліній). */
  road?: { line: string; s: number; route?: string[] };
  /** Версія запису (2 — формули king.exe). */
  v?: 2;
}

/** Строк ліцензії, с ігрового часу (доба гри). */
export const LICENCE_TIME = 24 * 3600;
/** Оплата авансу — на 10 км уперед (0x423f40). */
const ADVANCE_KM = 10;
const FUEL_K = 0.00002;
const FUEL_R_PER_CONSUMPTION = 3;
/** Частка місткості, яку бере далекобійник (0x64b6f8). */
const LOAD_SHARE = 0.85;

/** Тариф найманого, $/км (0x477350). */
export function hireTariff(price: number, share: number): number {
  return ((1 + 4 * share) * price) / 1024;
}

/**
 * Пропозиція найму на ринку: один водій зі своєю машиною на ринок на день (ймовірність 0,75 — GAME.CNF forhire 20 на
 * 15 ринків) — на одному з вільних місць free (без машини на продаж; у king.exe шукачі роботи — окремі машини, тож на
 * ринку їх видно разом із тими, що продаються). Імʼя й фото — від ринку й дня, не від місця.
 */
export function hireOffer(market: number, day: number, free: readonly number[], names: readonly string[]): { spot: number; name: string; photo: number } | null {
  if (!names.length || !free.length) return null;
  const h = Math.abs((market * 7919 + day * 104729) ^ 0x5bd1e995);
  if (h % 4 === 0) return null;
  return { spot: free[h % free.length], name: names[h % names.length], photo: 1 + (h % 51) };
}

/** Новий найманий: аванс 10·тариф (уже виплачений при наймі). */
export function newDriver(o: { name: string; photo: number }, truck: string, tariff: number, value: number): HiredDriver {
  return { name: o.name, truck, tariff, photo: o.photo, km: 0, advance: ADVANCE_KM * tariff, profit: 0, value, v: 2 };
}

/** Старий запис (тариф за 10 км, без вартості машини) — на формули king.exe. */
export function upgradeDriver(d: HiredDriver, price: number, share: number): void {
  if (d.v === 2) return;
  d.tariff = hireTariff(price, share);
  d.advance = ADVANCE_KM * d.tariff;
  d.value ??= price;
  delete d.nextPay;
  delete d.nextDelivery;
  d.v = 2;
}

/**
 * Витрати за meters пройдених метрів (0x423f40): аванс і пальне з роботодавця. false — грошей немає, водій іде.
 * consumption — fuelConsumption з vehicle.tech.
 */
export function driverCosts(d: HiredDriver, meters: number, wallet: { money: number }, consumption: number): boolean {
  d.km += meters / 1000;
  d.advance -= d.tariff * meters * 0.001;
  wallet.money -= meters * FUEL_R_PER_CONSUMPTION * consumption * FUEL_K;
  if (d.advance < 0) {
    const due = ADVANCE_KM * d.tariff;
    if (wallet.money < due) return false;
    wallet.money -= due;
    d.advance += due;
  }
  return wallet.money >= 0;
}

/**
 * Вантаж на складі (0x4185d0, 0x41ba50): товар зі списку складу (легальний, не паливо), призначення — інший склад;
 * кількість — 85 % місткості за меншим обмеженням; оплата 12·(PAY_PER_M·L + (1,2 − k)·√(ціна·кількість)), з причепом ×1,5.
 */
export function hiredLoad(
  from: Store,
  stores: Store[],
  goods: Goods[],
  cap: { mass: number; volume: number },
  trailer: boolean,
  routeLength: (to: Store) => number,
  rnd = Math.random,
): { to: number; load: { goods: string; units: number; pay: number } } | null {
  // Вантаж для вантажівки (клас trucks): «замовлення, що підходить машині» (0x418400) — гіпотеза, легкові C_* — ні.
  const ok = (g: Goods) => !g.illegal && !g.fuel && g.trucks && g.price > 0 && g.mass > 0;
  const local = goods.filter((g) => ok(g) && from.goods.includes(g.id.toUpperCase()));
  const pool = local.length ? local : goods.filter(ok);
  const targets = stores.filter((x) => x.id !== from.id);
  if (!pool.length || !targets.length) return null;
  const g = pool[Math.floor(rnd() * pool.length)];
  const to = targets[Math.floor(rnd() * targets.length)];
  const units = LOAD_SHARE * Math.min(cap.mass / g.mass, g.volume > 0 ? cap.volume / g.volume : Infinity);
  if (!(units > 0)) return null;
  const L = routeLength(to);
  const pay = Math.round(12 * (PAY_PER_M * L + (1.2 - g.ratio) * Math.sqrt(g.price * units)) * (trailer ? 1.5 : 1));
  return { to: to.id, load: { goods: g.id, units, pay } };
}
