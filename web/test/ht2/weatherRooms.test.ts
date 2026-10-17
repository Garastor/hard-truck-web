import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { weatherTriggers } from '@ht2/world/weatherRooms';
import { Weather } from '@ht2/world/weather';
import { decodeCp1251 } from '@ht2/engine/formats/binary';
import { HT2_DIR } from '../gameDirs';

// Події weather_change (блок 13, i1 = 23) за модулями — re/notes/ht2/weather.md «Набори WEATHER1…8».
const EXPECT: Record<string, Record<number, number>> = {
  aa: { 7: 2 },
  ab: { 8: 5 },
  da: { 8: 4 },
  db: { 6: 3, 5: 6 },
  dr: { 5: 5 },
  af: {},
};

describe.skipIf(!existsSync(join(HT2_DIR, 'ENV/aa.b3d')))('Погода кімнат HT2', () => {
  for (const [mod, sets] of Object.entries(EXPECT))
    it(`weather_change у ${mod}`, () => {
      const t = weatherTriggers(parseB3d(new Uint8Array(readFileSync(join(HT2_DIR, `ENV/${mod}.b3d`)))).blocks);
      const count: Record<number, number> = {};
      for (const w of t) {
        count[w.set] = (count[w.set] ?? 0) + 1;
        // Площина: одинична нормаль у площині землі (ab — (1, −1, 0)).
        expect(Math.hypot(w.plane[0], w.plane[1])).toBeGreaterThan(0.99);
        expect(w.room).toMatch(new RegExp(`^room_${mod}_`));
      }
      expect(count).toEqual(sets);
    });

  it('прапорці наборів: тунелі 5 і 8 без дощу, сонця й грому', () => {
    const w = Weather.parse(decodeCp1251(readFileSync(join(HT2_DIR, 'WEATHER.INI'))));
    expect(w.flags(1)).toEqual({ rain: true, sun: true, thund: true });
    expect(w.flags(5)).toEqual({ rain: false, sun: false, thund: false });
    expect(w.flags(8)).toEqual({ rain: false, sun: false, thund: false });
    expect(w.flags(6)).toEqual({ rain: true, sun: true, thund: true });
  });

  it('змішування зі спецнабором: k = 0 — звичайна, k = 1 — спецнабір', () => {
    const w = Weather.parse(decodeCp1251(readFileSync(join(HT2_DIR, 'WEATHER.INI'))));
    const base = w.at(14, 0, 1);
    const tun = w.at(14, 0, 5);
    expect(w.at(14, 0, 1, { set: 5, k: 0 }).fogFar).toBe(base.fogFar);
    expect(w.at(14, 0, 1, { set: 5, k: 1 }).fogFar).toBe(tun.fogFar);
    expect(w.at(14, 0, 1, { set: 5, k: 0.5 }).fogFar).toBeCloseTo((base.fogFar + tun.fogFar) / 2, 5);
    // У тунелі сонця на довкілля немає (sunenv не задано — 0 0 0).
    expect(tun.sun.getHex()).toBe(0);
  });
});
