/** Конкуренція за вантаж: суперники, позиція гравця, хто доїхав. */
import { describe, expect, it } from 'vitest';
import { advance, delayRival, makeRivals, place, progress, rivalPlan, rubber, RUBBER_MIN, slowRival, specialOffsets, topUpPlan, topUpSpacing, type RivalRun } from '@ht2/career/competition';

/** Передбачуваний генератор 0…1. */
function seq(...v: number[]): () => number {
  let i = 0;
  return () => v[i++ % v.length];
}

describe('HT2: конкуренція', () => {
  it('суперники лише з імовірністю, 1–3, час у дорозі — маршрут / швидкість', () => {
    expect(makeRivals(10000, ['А'], seq(0.9))).toEqual([]);
    const r = makeRivals(10000, ['А', 'Б'], seq(0.1, 0.99, 0.5, 0.5, 0.5, 0.9));
    expect(r.length).toBe(3);
    for (const x of r) expect(x.eta).toBeGreaterThan(10000 / (55 / 3.6) / 1.2);
  });

  it('позиція й прибуття', () => {
    const r: RivalRun[] = [
      { name: 'А', eta: 100, t: 0 },
      { name: 'Б', eta: 200, t: 0 },
    ];
    expect(place(r, 0)).toEqual({ place: 1, of: 3 });
    advance(r, 60);
    expect(place(r, 0.4)).toEqual({ place: 2, of: 3 });
    expect(advance(r, 50).map((x) => x.name)).toEqual(['А']);
    expect(place(r, 0.9)).toEqual({ place: 2, of: 3 });
    r[1].out = true;
    expect(place(r, 0.9)).toEqual({ place: 2, of: 2 });
  });

  it('king.exe: 3–7 суперників (повний трафік), попереду 0–3; зсуви на дорозі через 150 м, попереду й позаду', () => {
    expect(rivalPlan(1, seq(0.9)).count).toBe(0);
    expect(rivalPlan(1, seq(0.1, 0, 0))).toEqual({ count: 3, ahead: 0 });
    expect(rivalPlan(1, seq(0.1, 0.99, 0.99))).toEqual({ count: 7, ahead: 3 });
    // Найменший трафік: ftol(4) − 2 = 2 → 3–4.
    expect(rivalPlan(0, seq(0.1, 0.99, 0)).count).toBe(4);
    // ahead 2 з 5: 300, 150 попереду, далі −150, −300, −450 (розкид rand % 20 − 10; ближче 150 — рівно 150).
    expect(specialOffsets(5, 2, seq(0.5))).toEqual([300, 150, -150, -300, -450]);
    expect(specialOffsets(2, 1, seq(0))).toEqual([150, -160]);
  });

  it('гумова нитка: відстає — швидше до +40 % на 300 м, попереду — повільніше, не менше 35 км/год', () => {
    expect(rubber(20, 0)).toBeCloseTo(20);
    expect(rubber(20, 150)).toBeCloseTo(24);
    expect(rubber(20, 900)).toBeCloseTo(28);
    expect(rubber(20, -300)).toBeCloseTo(12);
    expect(rubber(0, -300)).toBeCloseTo(RUBBER_MIN);
  });

  it('суперник-водій: частка шляху — за тим, що лишилось; рація — затримка й «не поспішатиме»', () => {
    const r: RivalRun = { name: 'А', member: 3, eta: 0, t: 0 };
    expect(progress(r, 1000)).toBe(0);
    r.left = 250;
    expect(progress(r, 1000)).toBeCloseTo(0.75);
    expect(place([r], 0.5, 1000)).toEqual({ place: 2, of: 2 });
    expect(advance([r], 100)).toEqual([]);
    delayRival(r, 120);
    slowRival(r);
    expect(r.delay).toBe(120);
    expect(r.slow).toBeCloseTo(1 / 1.3);
    const old: RivalRun = { name: 'Б', eta: 100, t: 0 };
    delayRival(old, 120);
    expect(old.eta).toBe(220);
  });

  it('доповнення до N: зійшли — не рахуються, доїхали — рахуються; нікого й далеко — знову довкола гравця', () => {
    const r = (o: Partial<RivalRun>): RivalRun => ({ name: 'А', member: 0, eta: 0, t: 0, ...o });
    expect(topUpPlan([r({}), r({ done: true }), r({ out: true })], 4, 5000)).toEqual({ missing: 2, live: 2, special: false });
    expect(topUpPlan([r({}), r({}), r({})], 3, 5000).missing).toBe(0);
    expect(topUpPlan([r({ out: true }), r({ out: true })], 3, 5000)).toEqual({ missing: 3, live: 0, special: true });
    expect(topUpPlan([r({ out: true })], 3, 800).special).toBe(false);
    // Крок: попереду < 2 — 20 м; інакше 400 (до 3000) / (ahead − 1).
    expect(topUpSpacing(1, 10000)).toBe(20);
    expect(topUpSpacing(2, 10000)).toBe(400);
    expect(topUpSpacing(3, 10000)).toBe(400);
    expect(topUpSpacing(3, 900)).toBe(200);
  });
});
