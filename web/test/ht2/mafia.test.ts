/** Мафія HT2 (Б10, re/notes/ht2/mafia.md): засідки з mod_*.sch, частка капіталу. */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSch } from '@ht2/formats/sexpr';
import { parseWay } from '@ht2/formats/way';
import { parseMafiaAmbushes } from '@ht2/traffic/mafia';
import { capitalOf, capitalShare, RIVALS } from '@ht2/career/capital';
import { newCareer, START_MONEY } from '@ht2/career/career';
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

  it('частка капіталу: гроші + машини (своя, найманих) серед суперників зі стартовим капіталом', () => {
    const price = (n: string) => ({ ZilR: 20000, Kamaz: 30000 })[n] ?? 0;
    const c = newCareer('Тест', 'ZilR');
    expect(capitalOf(c, price)).toBe(START_MONEY + 20000);
    // На старті — як кожен суперник: 1 / (RIVALS + 1).
    expect(capitalShare(c, price, 'ZilR')).toBeCloseTo(1 / (RIVALS + 1), 6);
    // Розбагатів: частка > 0,15 (інтерес мафії), > 0,2 (засідки).
    c.money = 300000;
    expect(capitalShare(c, price, 'ZilR')).toBeGreaterThan(0.2);
    c.money = -500;
    expect(capitalOf(c, price)).toBe(20000);
  });
});
