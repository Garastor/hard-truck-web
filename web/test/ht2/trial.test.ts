/** Тріал мережевої гри (re/notes/ht2/tracks.md §3): зони check_point_0…2 арени MTR і компас на табло. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { checkZones, compassSector, inZone } from '@ht2/race';
import { toThree } from '@ht2/world/world';
import { HT2_DIR } from '../gameDirs';

const tr = join(HT2_DIR, 'MTR', 'tr.b3d');

describe('HT2: Тріал', () => {
  it.skipIf(!existsSync(tr))('три зони-коробки в MTR/tr.b3d — центри з нотаток реверсу всередині, сусідні точки — ні', () => {
    const zones = checkZones(parseB3d(new Uint8Array(readFileSync(tr))).blocks);
    expect([...zones.keys()].sort()).toEqual([0, 1, 2]);
    // Центри зон (tracks.md §3), висота — земля арени ≈ 452 м.
    const centers: [number, number][] = [[2280, -3210], [4531, -5628], [2196, -3759]];
    centers.forEach(([x, y], i) => {
      expect(inZone(zones.get(i)!, toThree(x, y, 453))).toBe(true);
      expect(inZone(zones.get(i)!, toThree(x + 30, y, 453))).toBe(false);
    });
    // Решітка start1_1 (2270; −3220) — ще не в зоні 0.
    expect(inZone(zones.get(0)!, toThree(2270, -3220, 453))).toBe(false);
  });

  it('компас: 8 секторів за годинниковою стрілкою від «уперед»', () => {
    const f = new THREE.Vector3(0, 0, -1); // уперед — −Z Three.js
    const dir = (deg: number) => new THREE.Vector3(Math.sin((deg * Math.PI) / 180), 0, -Math.cos((deg * Math.PI) / 180));
    expect([0, 45, 90, 135, 180, 225, 270, 315].map((a) => compassSector(f, dir(a)))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
