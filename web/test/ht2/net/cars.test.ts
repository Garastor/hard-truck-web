/** Машини й суперники мережевої гри HT2 (net/cars.ts) і місця 9…23 мережевої решітки (race.ts extraSlot). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { MAX_RIVALS, NET_MODELS, brandPhoto, carName, carPhoto, clampRivals, pickRivals } from '@ht2/net/cars';
import { DEFAULT_SETUP, type NetSetup } from '@ht2/net/peer';
import { parseTech } from '@ht2/formats/tech';
import { normName, parseRmp } from '@ht2/engine/formats/rmp';
import { parseWay } from '@ht2/formats/way';
import { GRID_SLOTS, NET_GRID, extraSlot } from '@ht2/race';
import { toThree } from '@ht2/world/world';
import { HT2_DIR } from '../../gameDirs';

const setup = (o: Partial<NetSetup>): NetSetup => ({ ...DEFAULT_SETUP, ...o });

describe('машини мережевої гри', () => {
  it('тягач і кузовний варіант — окремі записи з різними фото', () => {
    expect(carName('DafR')).toBe('DAF — кузовна');
    expect(carName('Daf')).toBe('DAF — тягач');
    expect(carPhoto('DafR', 0)).toBe('m16\\DafR1.msk');
    expect(carPhoto('Daf', 3)).toBe('m16\\Daf4.msk');
    // Без esc16.RES — одна картинка марки (LOAD.RES) для обох варіантів.
    expect(brandPhoto('Daf', 2)).toBe('n/daf2.msk');
    expect(brandPhoto('DafR', 2)).toBe('n/daf2.msk');
    expect(new Set(NET_MODELS.map((c) => c.truck)).size).toBe(NET_MODELS.length);
  });

  const tech = join(HT2_DIR, 'vehicle.tech');
  it.skipIf(!existsSync(tech))('кожна модель є у vehicle.tech і має 4 фото в esc16.RES', () => {
    const nodes = new Set(parseTech(new Uint8Array(readFileSync(tech))).records.map((r) => r.carNode));
    for (const c of NET_MODELS) expect(nodes.has(c.truck), c.truck).toBe(true);
    const esc = join(HT2_DIR, 'COMMON', 'esc16.RES');
    if (!existsSync(esc)) return;
    const masks = parseRmp(new Uint8Array(readFileSync(esc))).masks;
    for (const c of NET_MODELS) for (let k = 0; k < 4; k++) expect(masks.has(normName(carPhoto(c.truck, k))), carPhoto(c.truck, k)).toBe(true);
  });
});

describe('суперники мережевої гонки', () => {
  it('рівно вибране число 0…15 у Кільці й Тріалі, без легкових і Storm, спершу машини, яких немає в гравців', () => {
    for (const n of [0, 1, 6, 15]) expect(pickRivals(setup({ track: 'ring', rivals: n }), [])).toHaveLength(n);
    const r = pickRivals(setup({ track: 'trial', rivals: MAX_RIVALS }), ['RenaultR', 'Mack']);
    expect(r).toHaveLength(15);
    expect(new Set(r.map((c) => c.truck)).size).toBe(15);
    expect(r.some((c) => c.truck === 'RenaultR' || c.truck === 'Mack')).toBe(false);
    expect(r.some((c) => /^(Storm|Sobol|BmwM5|Patrol|Gazelle|Cayman)/.test(c.truck))).toBe(false);
  });

  it('Автобол і кар’єра — без суперників; число обмежене 0…15', () => {
    expect(pickRivals(setup({ track: 'ball', rivals: 9 }), [])).toEqual([]);
    expect(pickRivals(setup({ track: 'career', rivals: 9 }), [])).toEqual([]);
    expect(pickRivals(setup({ rivals: 40 }), [])).toHaveLength(15);
    expect([clampRivals(-3), clampRivals(7.6), clampRivals(NaN), clampRivals(99)]).toEqual([0, 8, 0, 15]);
  });
});

describe('мережева решітка: місця 9…23', () => {
  /** Вузли start1_k арени (координати Three.js). */
  const nodesOf = (file: string) => {
    const w = parseWay(new Uint8Array(readFileSync(join(HT2_DIR, file))));
    const m = new Map<number, THREE.Vector3>();
    for (const r of w.rooms) for (const n of r.nodes) if (/^start1_\d$/.test(n.name)) m.set(Number(n.name.slice(7)), toThree(...n.pos));
    return m;
  };
  const dir = toThree(1, 0, 0);
  const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
  /** Найменша відстань між машинами вздовж (≥ along) або впоперек (≥ across) — інакше перетин. */
  const clear = (ps: THREE.Vector3[], along: number, across: number) => {
    for (let a = 0; a < ps.length; a++)
      for (let b = a + 1; b < ps.length; b++) {
        const d = ps[b].clone().sub(ps[a]);
        const ok = Math.abs(d.dot(dir)) >= along || Math.abs(d.dot(side)) >= across;
        if (!ok) return `${a + 1} і ${b + 1}`;
      }
    return null;
  };

  it.skipIf(!existsSync(join(HT2_DIR, 'MENV', 'dr.way')))('Кільце: 23 місця, сусіди в ряду — ≥ 7,5 м, ряди — 3,5 м, не далі ніж 60 м за start1_8', () => {
    const nodes = nodesOf('MENV/dr.way');
    const base = (k: number) => nodes.get(k)?.clone().addScaledVector(side, k % 2 ? 1.75 : -1.75);
    const all = Array.from({ length: NET_GRID }, (_, i) => (i < GRID_SLOTS ? base(i + 1) : extraSlot('ring', i + 1, base, dir, side))!);
    expect(all.every(Boolean)).toBe(true);
    expect(clear(all, 7.4, 3.4)).toBeNull();
    const back = Math.min(...all.map((p) => p.clone().sub(nodes.get(8)!).dot(dir)));
    expect(back).toBeGreaterThanOrEqual(-60);
    expect(extraSlot('ring', NET_GRID + 1, base, dir, side)).toBeUndefined();
  });

  it.skipIf(!existsSync(join(HT2_DIR, 'MTR', 'tr.way')))('Тріал: 23 місця без перетинів (машини до 12 м), не далі 140 м за решіткою', () => {
    const nodes = nodesOf('MTR/tr.way');
    const base = (k: number) => nodes.get(k)?.clone();
    const all = Array.from({ length: NET_GRID }, (_, i) => (i < GRID_SLOTS ? base(i + 1) : extraSlot('trial', i + 1, base, dir, side))!);
    expect(all.every(Boolean)).toBe(true);
    expect(clear(all, 12, 8)).toBeNull();
    // Рівне поле за решіткою — до x ≈ 2090 (далі пагорб).
    expect(Math.min(...all.map((p) => p.x))).toBeGreaterThan(2090);
  });
});
