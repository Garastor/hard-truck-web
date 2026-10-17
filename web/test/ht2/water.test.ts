/** Вода HT2 (re/notes/ht2/upgrades.md §10): тригери 13 з даними (16, рівень) у кімнатах ENV/*.b3d. */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { waterTriggers } from '@ht2/vehicles/water';
import { HT2_DIR } from '../gameDirs';

const env = join(HT2_DIR, 'ENV');

describe('HT2: вода', () => {
  it.skipIf(!existsSync(join(env, 'aa.b3d')))('тригери води в усіх регіонах; озеро aa — 447 м, без площин', () => {
    const all = readdirSync(env)
      .filter((f) => /\.b3d$/i.test(f))
      .flatMap((f) => waterTriggers(parseB3d(new Uint8Array(readFileSync(join(env, f)))).blocks));
    expect(all.length).toBe(163);
    const aa = all.find((t) => t.room === 'room_aa_000');
    expect(aa?.level).toBe(447);
    expect(all.every((t) => Number.isFinite(t.level) && t.level >= -2 && t.level <= 447)).toBe(true);
    // Повені: тригери в гілках перемикачів Flood…Key — звичайний рівень (гілка 0) і на 3 м вище (1).
    const aw = all.filter((t) => t.room === 'room_aw_006');
    expect(aw.map((t) => [t.sw, t.level])).toEqual([['FloodAWKey#0', 14], ['FloodAWKey#1', 17]]);
    expect(all.filter((t) => t.sw).map((t) => t.sw.split('#')[0]).sort()).toEqual(
      ['FloodAQKey', 'FloodAQKey', 'FloodAWKey', 'FloodAWKey', ...Array(4).fill('FloodAX1Key'), ...Array(4).fill('FloodAX2Key')].sort(),
    );
  });
});
