/** Наймані водії: тариф кожні 10 км, прибуток з доставок, звільнення без грошей. */
import { describe, expect, it } from 'vitest';
import { hireOffer, newDriver, tickCompany } from '@ht2/career/company';

describe('HT2: наймані водії', () => {
  it('пропозиція найму — стала для ринку й дня, на одному з місць', () => {
    const a = hireOffer(3, 10, 5, ['А', 'Б', 'В']);
    expect(hireOffer(3, 10, 5, ['А', 'Б', 'В'])).toEqual(a);
    if (a) expect(a.spot).toBeLessThan(5);
    expect(hireOffer(3, 10, 1, ['А'])).toBeNull();
  });

  it('тариф на початку кожних 10 км, доставка приносить гроші, без грошей — звільнення', () => {
    const d = newDriver({ name: 'А', tariff: 100, photo: 1 }, 'Zil', () => 0);
    const wallet = { money: 1000 };
    tickCompany([d], 1, wallet, () => 0);
    expect(wallet.money).toBe(900);
    expect(d.advance).toBe(100);
    // 8 км (перша доставка) ≈ 576 с при 50 км/год.
    const ev = tickCompany([d], 600, wallet, () => 0);
    expect(ev.some((e) => e.kind === 'delivered')).toBe(true);
    const list = [d];
    const poor = { money: 0 };
    d.nextPay = d.km;
    expect(tickCompany(list, 1, poor).map((e) => e.kind)).toContain('quit');
    expect(list.length).toBe(0);
  });
});
