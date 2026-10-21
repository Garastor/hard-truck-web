/** Мережева кар'єра HT2 (М6, «змагання за ринок»): спільна частка ринку. */
import { describe, expect, it } from 'vitest';
import { RIVALS, marketShare, netMarketShare } from '@ht2/career/share';

describe('HT2: мережева кар\u02bcєра — частка ринку', () => {
  it('без інших гравців — як в одиночній кар\u02bcєрі', () => {
    const load = (n: string) => (n === 'ZilR' ? 6000 : 10000);
    const single = marketShare({ driver: 'a', money: 0, truck: 'ZilR', damage: 0, fuel: null, time: 0, order: null, delivered: 0, earned: 0, company: [{ truck: 'Kamaz' } as never] }, load, 8000);
    expect(netMarketShare({ load: 16000, hired: 1 }, [], 8000)).toBeCloseTo(single);
  });

  it('однакова на всіх телефонах: частки гравців у сумі з далекобійниками — 1', () => {
    const a = { load: 20000, hired: 2 };
    const b = { load: 9000, hired: 0 };
    const c = { load: 40000, hired: 5 };
    const sa = netMarketShare(a, [b, c], 8000);
    const sb = netMarketShare(b, [a, c], 8000);
    const sc = netMarketShare(c, [a, b], 8000);
    const ai = ((RIVALS - 7) * 8000) / (a.load + b.load + c.load + (RIVALS - 7) * 8000);
    expect(sa + sb + sc + ai).toBeCloseTo(1);
    expect(sc).toBeGreaterThan(sa);
  });

  it('усіх далекобійників найнято — частка лише серед гравців', () => {
    expect(netMarketShare({ load: 30000, hired: 30 }, [{ load: 10000, hired: 30 }], 8000)).toBeCloseTo(0.75);
  });
});
