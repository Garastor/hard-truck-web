import { describe, expect, it } from 'vitest';
import { parseSexpr } from '../../src/games/ht2/formats/sexpr';
import { dealerKinds, pickDealerKind, type DealerKind } from '../../src/games/ht2/career/market';

// Моделі, які порт «уміє водити» (selectable: запис vehicle.tech не причепа + модель у TRUCKS.B3D).
const trucks = {
  records: ['ZilR', 'Storm', 'Patrol', 'Fiat', 'Cayman', 'BmwM5police', 'STrailerM'].map((carNode) => ({ carNode, group: carNode === 'STrailerM' ? 'trailers' : 'x' })),
  asm: { block: () => ({}) },
} as never;

/** Генератор з зерна для повторюваних прогонів. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe('машини продавців на ринках HT2 (evehicles.sch, king.exe 0x42fa90 / 0x415940)', () => {
  const sch = parseSexpr(`(
    ( vehicle  FIAT_1  "Fiat"  0  car  dumb  32000  408 ())
    ( vehicle  JEEP_NISSAN_BLACK  "Patrol"  1  car ( dumb  trucker ) 42000  129 ())
    ( vehicle  CAYMAN  "Cayman"  0  car  mafia  46000  299 ())
    ( vehicle  BMW_M5_POLICE  "BmwM5police"  0  car  police  32000  408 ())
    ( vehicle  ZIL_LORRY2  "ZilR"  1  lorry  trucker  22000  250 ())
    ( vehicle  URAGAN_TRACTOR3  "Storm"  2  tractor  trucker  107000  700 ( URAGAN_SEMITRAILER ))
    ( vehicle  SEMITRAILER1  "STrailerM"  0  semitrailer  none  0  101 ()))`)[0] as never;
  const kinds = dealerKinds(sch, trucks);

  it('типи: dumb і trucker з фарбуванням; без мафії, міліції й напівпричепів; «Шторм» — є', () => {
    expect(kinds).toEqual([
      { carNode: 'Fiat', cluster: 0, car: true, trucker: false },
      { carNode: 'Patrol', cluster: 1, car: true, trucker: true },
      { carNode: 'ZilR', cluster: 1, car: false, trucker: true },
      { carNode: 'Storm', cluster: 2, car: false, trucker: true },
    ]);
  });

  it('до 52 % капіталу — лише типи з trucker; після — і «тупі» легковики', () => {
    const r = rng(1);
    const before = new Set(Array.from({ length: 400 }, () => pickDealerKind(kinds, false, 1, r)!.carNode));
    expect([...before].sort()).toEqual(['Patrol', 'Storm', 'ZilR']);
    const after = new Set(Array.from({ length: 400 }, () => pickDealerKind(kinds, true, 1, r)!.carNode));
    expect(after.has('Fiat')).toBe(true);
  });

  it('частка легковиків: kx/(1 + kx), k = 20/21; без трафіку — жодного', () => {
    const all: DealerKind[] = [
      { carNode: 'A', cluster: 0, car: true, trucker: true },
      { carNode: 'B', cluster: 0, car: false, trucker: true },
    ];
    const r = rng(7);
    const n = 20000;
    const cars = Array.from({ length: n }, () => pickDealerKind(all, true, 1, r)!.car).filter(Boolean).length;
    expect(cars / n).toBeCloseTo(20 / 41, 1);
    expect(Array.from({ length: 200 }, () => pickDealerKind(all, true, 0, r)!.car).some(Boolean)).toBe(false);
  });
});
