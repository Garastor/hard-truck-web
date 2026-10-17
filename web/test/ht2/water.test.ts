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
  });
});
