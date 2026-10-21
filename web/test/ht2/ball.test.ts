/** Автобол мережевої гри (re/notes/ht2/tracks.md §3): ворота й стіни арени MTB, розстановка. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { levelCollision } from '@ht2/engine/physics/collision';
import { ballSlot, readGates, segmentDistance } from '@ht2/ball';
import { HT2_DIR } from '../gameDirs';

const tb = join(HT2_DIR, 'MTB', 'tb.b3d');

describe('HT2: Автобол', () => {
  it.skipIf(!existsSync(tb))('9 воріт з очками й лампами з огорож tb.b3d; огорожі поля — стіни колізій', () => {
    const b3d = parseB3d(new Uint8Array(readFileSync(tb)));
    const gates = readGates(b3d.blocks);
    expect(gates.map((g) => `${g.name}:${g.points}:${g.lamp}`).sort()).toEqual(
      [
        's_w1GATE:50:tbLamp8Key',
        's_w3GATE:50:tbLamp9Key',
        's_w7GATE:50:tbLamp7Key',
        's_w9GATE:50:tbLamp6Key',
        's_g2:200:tbLamp4Key',
        's_g8:200:tbLamp5Key',
        's_g4:400:tbLamp3Key',
        's_g6:400:tbLamp2Key',
        's_g10:100:tbLamp1Key',
      ].sort(),
    );
    // Ворота s_g10 — бік x = −30, y ±8,5.
    const g10 = gates.find((g) => g.name === 's_g10')!;
    expect(segmentDistance(-30, 0, g10.a, g10.b)).toBeCloseTo(0);
    // Обʼєктів hit_* немає — стіни поля (огорожі групи $$$Group_3_test) у кімнаті room_tb_000.
    const col = levelCollision(b3d);
    expect(col.walls.length).toBeGreaterThanOrEqual(18);
    expect(new Set(col.wallRoom)).toEqual(new Set(['room_tb_000']));
  });

  it('розстановка: парні ліворуч, непарні праворуч, через 10 м, обличчям до середини', () => {
    expect([0, 1, 2, 7].map(ballSlot)).toEqual([
      { x: -20, y: -40, dir: [1, 0] },
      { x: 20, y: -30, dir: [-1, 0] },
      { x: -20, y: -20, dir: [1, 0] },
      { x: 20, y: 30, dir: [-1, 0] },
    ]);
  });
});
