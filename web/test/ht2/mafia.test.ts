/** Мафія HT2 (Б10, re/notes/ht2/mafia.md): засідки з mod_*.sch, частка X гравця. */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSch } from '@ht2/formats/sexpr';
import { parseWay } from '@ht2/formats/way';
import { parseMafiaAmbushes } from '@ht2/traffic/mafia';
import { fleetLoad, marketShare, RIVALS, WIN_SHARE } from '@ht2/career/share';
import { newCareer } from '@ht2/career/career';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe('HT2: мафія', () => {
  it.skipIf(!has)('засідки MAFIA з mod_*.sch — 43, з вузлами WAY і мінами', () => {
    const env = join(HT2_DIR, 'ENV');
    const files = readdirSync(env);
    const mods = files.filter((f) => /^mod_.*\.sch$/i.test(f)).map((f) => ({ sch: readSch(new Uint8Array(readFileSync(join(env, f)))) }));
    const ways = files.filter((f) => /\.way$/i.test(f)).map((f) => ({ way: parseWay(new Uint8Array(readFileSync(join(env, f)))) }));
    const a = parseMafiaAmbushes(mods, ways);
    expect(a.length).toBe(43);
    expect(a.every((x) => Number.isFinite(x.pos.x) && Math.abs(x.heading.length() - 1) < 1e-6)).toBe(true);
    // Міни — імена реквізиту anmobj0001NNN.
    expect(a.some((x) => x.mines.length > 0)).toBe(true);
    expect(a.flatMap((x) => x.mines).every((n) => /^anmobj0001\d{3}$/.test(n))).toBe(true);
  });

  it('частка X: вантажопідйомність флоту (своя + наймані) серед далекобійників, гроші не важать', () => {
    const load = (n: string) => ({ ZilR: 6000, Kamaz: 10000 })[n] ?? 0;
    const c = newCareer('Тест', 'ZilR');
    expect(fleetLoad(c, load)).toBe(6000);
    // На старті — як кожен суперник: 1 / (RIVALS + 1).
    expect(marketShare(c, load, 6000)).toBeCloseTo(1 / (RIVALS + 1), 6);
    c.money = 10_000_000;
    expect(marketShare(c, load, 6000)).toBeCloseTo(1 / (RIVALS + 1), 6);
    // Наймані — з числа далекобійників: 25 найманих на Камазах — перемога (X ≥ 0,51).
    const d = { name: 'В', truck: 'Kamaz', tariff: 1, photo: 1, km: 0, advance: 0, profit: 0, value: 0, v: 2 as const };
    c.company = Array.from({ length: 25 }, () => ({ ...d }));
    expect(fleetLoad(c, load)).toBe(256000);
    const x = marketShare(c, load, 6000);
    expect(x).toBeCloseTo(256000 / (256000 + 25 * 6000), 6);
    expect(x).toBeGreaterThanOrEqual(WIN_SHARE);
  });
});
