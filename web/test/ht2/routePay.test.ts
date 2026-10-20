/**
 * Відстань для оплати замовлень HT2: шлях дорогами WAY без зрізалок (navigator.remaining — справжні метри, штраф
 * зрізалок у них не входить), не пряма; оплата контрабанди 40–80 тис. за цією відстанню.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads } from '@ht2/world/roads';
import { Navigator } from '@ht2/world/navigator';
import { contrabandPay, findStores } from '@ht2/career/economy';
import { roadPlaces } from '@ht2/vehicles/presents';
import { hiddenPlaces } from '@ht2/vehicles/caches';
import { toThree } from '@ht2/world/world';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe('HT2: оплата контрабанди', () => {
  it('40 тис. поблизу, 80 тис. далеко, лінійно між ними', () => {
    expect(contrabandPay(500)).toBe(40_000);
    expect(contrabandPay(17_500)).toBe(60_000);
    expect(contrabandPay(60_000)).toBe(80_000);
  });
});

describe.skipIf(!has)('HT2: відстань замовлень дорогами', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);
  const nav = new Navigator(roads);
  const stores = findStores(regions);
  const flat = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  it('між складами — не коротше прямої й без штрафу зрізалок', () => {
    let n = 0;
    for (const a of stores)
      for (const b of stores) {
        if (a === b) continue;
        const L = nav.remaining(toThree(...a.center), undefined, toThree(...b.center));
        if (L === null) continue;
        n++;
        expect(L, `${a.id}→${b.id}`).toBeGreaterThanOrEqual(flat(a.center, b.center) * 0.9);
        expect(L, `${a.id}→${b.id}`).toBeLessThan(200_000);
      }
    expect(n).toBeGreaterThan(stores.length * 4);
  });

  it('місця причепів і схованок — біля доріг, шлях до складів знаходиться', () => {
    const places = [...roadPlaces(regions), ...hiddenPlaces(regions)];
    expect(roadPlaces(regions).length).toBe(22);
    expect(hiddenPlaces(regions).length).toBe(62);
    const Ls: number[] = [];
    for (const p of roadPlaces(regions))
      for (const s of stores) {
        const L = nav.remaining(p.pos, undefined, toThree(...s.center));
        if (L !== null) Ls.push(L);
      }
    Ls.sort((a, b) => a - b);
    expect(Ls.length).toBeGreaterThan(places.length);
    expect(Ls[Ls.length - 1]).toBeLessThan(200_000);
  });
});
