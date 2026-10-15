/** Конкуренція за вантаж: суперники, позиція гравця, хто доїхав. */
import { describe, expect, it } from 'vitest';
import { advance, makeRivals, place, type RivalRun } from '@ht2/career/competition';

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
});
