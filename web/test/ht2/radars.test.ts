/** Камери-радари HT2 (re/notes/ht2/police.md «Камери»): тригери 13 з кодом 30 у кімнатах ENV/*.b3d. */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { radarTriggers } from '@ht2/traffic/radars';
import { HT2_DIR } from '../gameDirs';

const env = join(HT2_DIR, 'ENV');

describe('HT2: камери-радари', () => {
  it.skipIf(!existsSync(join(env, 'ap.b3d')))('58 тригерів: ліміти 45/65/85 км/год, напрям — одиничний', () => {
    const all = readdirSync(env)
      .filter((f) => /\.b3d$/i.test(f))
      .flatMap((f) => radarTriggers(parseB3d(new Uint8Array(readFileSync(join(env, f)))).blocks).flatMap((r) => r.triggers));
    expect(all.length).toBe(58);
    expect(new Set(all.map((t) => Math.round(t.limit)))).toEqual(new Set([45, 65, 85]));
    expect(all.every((t) => Math.abs(Math.hypot(...t.dir) - 1) < 0.05)).toBe(true);
    // Камери (номер ≥ 0) і зони попередження (−1).
    expect(all.some((t) => t.id < 0)).toBe(true);
    expect(all.some((t) => t.id >= 3000)).toBe(true);
  });
});
