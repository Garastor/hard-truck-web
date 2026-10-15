/**
 * Наймані водії (G9 Б7; посібник «Наемные водители», Ms.sch LICENCES_EXPIRED, NO_LICENCES, NO_MONEY_TO_HIRE,
 * NO_MONEY_FOR_ADVANCE). Ліцензію дають за доставку першим серед конкурентів; вона має строк. Водій шукає роботу на
 * стоянці ринку (вікно `BackJob`): найм — ліцензія й викуп його машини. Далі водій їздить сам: контракт
 * продовжується щоразу на 10 км (тариф з твого рахунку; нічим платити — звільняється), прибуток з кожної доставки —
 * тобі. Порт веде водіїв без моделі на дорозі (на карті їх ще немає). Строк ліцензії, тариф, швидкість, частота й
 * оплата доставок — гіпотези.
 */
export interface HiredDriver {
  name: string;
  /** car_node машини водія. */
  truck: string;
  /** Тариф за 10 км, $. */
  tariff: number;
  /** Номер фото escphotoNN. */
  photo: number;
  km: number;
  /** На якому кілометрі наступна оплата контракту й наступна доставка. */
  nextPay: number;
  nextDelivery: number;
  /** Уже виплачено водієві (аванс) і принесено прибутку, $. */
  advance: number;
  profit: number;
}

/** Строк ліцензії, с ігрового часу (доба гри). */
export const LICENCE_TIME = 24 * 3600;
/** Швидкість найманого водія, км/с реального часу (≈ 50 км/год). */
const SPEED = 50 / 3600;
/** Частка оплати доставки, що дістається компанії. */
const SHARE = 0.6;

/** Пропозиція найму на місці ринку: одне місце на ринок на день (ймовірність 0,75 — GAME.CNF forhire 20 на 15 ринків). */
export function hireOffer(market: number, day: number, spots: number, names: readonly string[]): { spot: number; name: string; tariff: number; photo: number } | null {
  if (!names.length || spots < 2) return null;
  const h = Math.abs((market * 7919 + day * 104729) ^ 0x5bd1e995);
  if (h % 4 === 0) return null;
  return { spot: h % spots, name: names[h % names.length], tariff: 50 + (h % 11) * 10, photo: 1 + (h % 51) };
}

export function newDriver(o: { name: string; tariff: number; photo: number }, truck: string, rnd = Math.random): HiredDriver {
  return { name: o.name, truck, tariff: o.tariff, photo: o.photo, km: 0, nextPay: 0, nextDelivery: 8 + 17 * rnd(), advance: 0, profit: 0 };
}

export type CompanyEvent = { kind: 'delivered'; driver: HiredDriver; income: number } | { kind: 'quit'; driver: HiredDriver };

/**
 * Крок компанії (реальний час dt, с): водії їдуть; на початку кожних 10 км — тариф (не вистачає — водій іде);
 * доставка — прибуток за формулою оплати замовлення (economy.orderPay: 0,115 $/м + основа) × частка.
 */
export function tickCompany(drivers: HiredDriver[], dt: number, wallet: { money: number }, rnd = Math.random): CompanyEvent[] {
  const events: CompanyEvent[] = [];
  for (let i = drivers.length - 1; i >= 0; i--) {
    const d = drivers[i];
    d.km += SPEED * dt;
    if (d.km >= d.nextPay) {
      if (wallet.money < d.tariff) {
        drivers.splice(i, 1);
        events.push({ kind: 'quit', driver: d });
        continue;
      }
      wallet.money -= d.tariff;
      d.advance += d.tariff;
      d.nextPay += 10;
    }
    if (d.km >= d.nextDelivery) {
      const distM = (8 + 17 * rnd()) * 1000;
      const income = Math.round((distM * 0.115 + 100) * 3 * SHARE);
      wallet.money += income;
      d.profit += income;
      d.nextDelivery = d.km + 8 + 17 * rnd();
      events.push({ kind: 'delivered', driver: d, income });
    }
  }
  return events;
}
