/** Наймані водії за king.exe: тариф від ціни моделі, аванс на 10 км, пальне, рейс зі складу (company.md §2, 2а). */
import { describe, expect, it } from 'vitest';
import { driverCosts, hireOffer, hireTariff, hiredLoad, newDriver } from '@ht2/career/company';
import { PAY_PER_M, type Goods, type Store } from '@ht2/career/economy';

describe('HT2: наймані водії', () => {
  it('пропозиція найму — стала для ринку й дня, на одному з вільних місць', () => {
    const a = hireOffer(3, 10, [1, 3, 4], ['А', 'Б', 'В']);
    expect(hireOffer(3, 10, [1, 3, 4], ['А', 'Б', 'В'])).toEqual(a);
    if (a) expect([1, 3, 4]).toContain(a.spot);
    expect(hireOffer(3, 10, [], ['А'])).toBeNull();
  });

  it('тариф (1 + 4s)·ціна/1024 $/км; аванс 10·тариф; вичерпано — ще 10·тариф, нема чим — звільнення', () => {
    expect(hireTariff(76185.6, 0)).toBeCloseTo(74.4, 1);
    expect(hireTariff(1024, 0.25)).toBe(2);
    const d = newDriver({ name: 'А', photo: 1 }, 'Zil', 10, 18000);
    expect(d.advance).toBe(100);
    const wallet = { money: 1000 };
    // 10 км: аванс вичерпано рівно до нуля, пальне 10000·3·4,1·0,00002 ≈ 2,46 $.
    expect(driverCosts(d, 10000, wallet, 4.1)).toBe(true);
    expect(d.advance).toBeCloseTo(0);
    expect(wallet.money).toBeCloseTo(1000 - 2.46, 2);
    expect(driverCosts(d, 1000, wallet, 4.1)).toBe(true);
    expect(d.advance).toBeCloseTo(90);
    expect(wallet.money).toBeCloseTo(1000 - 2.46 - 0.246 - 100, 2);
    const poor = { money: 5 };
    d.advance = 0;
    expect(driverCosts(d, 1000, poor, 4.1)).toBe(false);
  });

  it('вантаж на складі: 85 % місткості, оплата 12·(PAY_PER_M·L + основа), з причепом ×1,5', () => {
    const g: Goods = { id: 'BREAD', name: 'Хліб', mass: 25, volume: 0.1, price: 70, ratio: 0.85, durability: 0.85, illegal: false, forMafia: false, trucks: true, fuel: false, cars: false, guilt: 0 };
    const a: Store = { id: 1, region: 'aj', town: 'А', goods: ['BREAD'], docks: [[0, 0, 0]], center: [0, 0, 0] };
    const b: Store = { id: 2, region: 'am', town: 'Б', goods: [], docks: [[1000, 0, 0]], center: [1000, 0, 0] };
    const t = hiredLoad(a, [a, b], [g], { mass: 10000, volume: 100 }, false, () => 1000, () => 0)!;
    expect(t.to).toBe(2);
    expect(t.load.units).toBeCloseTo(0.85 * 400);
    const base = (1.2 - 0.85) * Math.sqrt(70 * 0.85 * 400);
    expect(t.load.pay).toBe(Math.round(12 * (PAY_PER_M * 1000 + base)));
    const tr = hiredLoad(a, [a, b], [g], { mass: 10000, volume: 100 }, true, () => 1000, () => 0)!;
    expect(tr.load.pay).toBe(Math.round(12 * (PAY_PER_M * 1000 + base) * 1.5));
  });
});
