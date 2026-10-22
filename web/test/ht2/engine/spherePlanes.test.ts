// Площина 12 у групі 0 вузла-сфери (10) діє лише всередині сфери — на даних регіону ak (кімната ak_096 над річкою).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { levelCollision } from '@ht2/engine/physics/collision';
import { HT2_DIR } from '../../gameDirs';

const file = join(HT2_DIR, 'ENV', 'ak.b3d');

describe.skipIf(!existsSync(file))('HT2: площини 12 у сферах (ak_096)', () => {
  const col = levelCollision(parseB3d(new Uint8Array(readFileSync(file))));
  const flat = col.floors.filter((p, i) => col.floorRoom[i].toLowerCase() === 'room_ak_096' && p.every((q) => Math.abs(q[2] - 30) < 1e-3) && p.length > 8);

  it('майданчик z = 30 — коло радіусом ≈ 45 м довкола (−2300, −650), а не вся кімната', () => {
    expect(flat.length).toBe(1);
    for (const q of flat[0]) expect(Math.hypot(q[0] + 2300, q[1] + 650)).toBeLessThan(47);
  });

  it('над руслом (−2209, −610,5), де машина «висіла», підлоги на 30 м немає', () => {
    const inside = (p: number[][], x: number, y: number) => {
      let s = 0;
      for (let i = 0; i < p.length; i++) {
        const a = p[i], b = p[(i + 1) % p.length];
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
        if (c !== 0) {
          if (s === 0) s = Math.sign(c);
          else if (Math.sign(c) !== s) return false;
        }
      }
      return true;
    };
    const over = col.floors.filter((p) => p.every((q) => q[2] > 25) && inside(p, -2209, -610.5));
    expect(over).toEqual([]);
  });
});
