/**
 * Колізії локацій з обʼєктів hit_road/hit_obj: підлога покриває дорогу (лінії way_*), по краю — бортики.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d, walk } from '@ht1/engine/formats/b3d';
import { floorCovers, levelCollision } from '@ht1/engine/physics/collision';
import { HT1_DIR } from '../gameDirs';

const GAME = HT1_DIR;
const LEVELS: [string, string][] = [
  ['CIRCUIT', 'CIRC2.B3D'],
  ['COUNT', 'COUNT2.B3D'],
  ['MENU3D', 'MENU3D2.B3D'],
  ['MOUNT', 'MOUNT2.B3D'],
  ['NIGHT', 'NIGHT2.B3D'],
  ['TRIAL', 'TRIAL2.B3D'],
];

describe.skipIf(!existsSync(GAME))('колізії hit_*', () => {
  it.each(LEVELS)('%s', (dir, file) => {
    const b3d = parseB3d(new Uint8Array(readFileSync(join(GAME, dir, file))));
    const col = levelCollision(b3d);
    expect(col.hasFloor).toBe(true);
    expect(col.walls.length).toBeGreaterThan(0);

    // Точки ліній руху ШІ мають лежати на колізійній підлозі.
    let total = 0;
    let onFloor = 0;
    for (const [blk] of walk(b3d.blocks)) {
      if (blk.data.t !== 20 || !/^way/i.test(blk.name)) continue;
      for (const p of blk.data.points) {
        total++;
        // Лінії ШІ йдуть на кілька метрів вище дороги: шукаємо підлогу в межах [z − 8, z + 2].
        if (floorCovers(col.floors, p[0], p[1], p[2] - 3, 5)) onFloor++;
      }
    }
    console.log(`${dir}: підлога ${col.floors.length}, стіни ${col.walls.length}, way ${onFloor}/${total}`, col.stats);
    if (total) expect(onFloor / total).toBeGreaterThan(0.95);
  });
});
