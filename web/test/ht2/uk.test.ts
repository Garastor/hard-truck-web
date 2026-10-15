/** Тексти з файлів гри українською: повідомлення Ms.sch, товари, міста, ринки, дорожні написи. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isList, readSch, str } from '@ht2/formats/sexpr';
import { parseGoods, parseTowns } from '@ht2/career/economy';
import { HT2_MOD_REGIONS } from '@ht2/files';
import { ukMessage, ukName, ukSign } from '@ht2/ui/uk';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'Ms.sch'));
const read = (n: string) => new Uint8Array(readFileSync(join(HT2_DIR, n)));
/** Літери, яких немає в українській абетці. */
const RU = /[ЫЭЪЁыэъё]/;

describe.skipIf(!has)('HT2: переклад текстів гри', () => {
  it('усі повідомлення Ms.sch перекладено', () => {
    for (const m of readSch(read('Ms.sch'))) {
      if (!isList(m) || typeof m[0] !== 'string') continue;
      const ru = str(m[m.length - 1]);
      if (!/[А-Яа-я]/.test(ru)) continue; // англійські службові (PLAYER_ROBBED_*) — теж є в словнику
      expect(ukMessage(m[0], ''), m[0]).not.toBe('');
      expect(RU.test(ukMessage(m[0], ru)), m[0]).toBe(false);
    }
  });

  it('товари, міста й ринки — без російських літер', () => {
    for (const g of parseGoods(readSch(read('merchandise.sch')))) expect(RU.test(g.name), g.name).toBe(false);
    const mods = HT2_MOD_REGIONS.map((region) => ({ region, sch: readSch(read(`ENV/mod_${region}.sch`)) }));
    for (const t of parseTowns(mods).values()) expect(RU.test(t.name), t.name).toBe(false);
    expect(ukName('Хлеб')).toBe('Хліб');
  });

  it('дорожні написи mod_*.sch', () => {
    expect(ukSign('БАЗА БОРОВОЕ НАЛЕВО, ЧЕРЕЗ 300 М')).toBe('БАЗА БОРОВЕ ЛІВОРУЧ, ЧЕРЕЗ 300 М');
    expect(ukSign('БАЗА КЛЮЧИ ЧЕРЕЗ 50 М')).toBe('БАЗА КЛЮЧІ, ЧЕРЕЗ 50 М');
    expect(ukSign('ТРАССА ШАХТЫ - БОРОВОЕ ЗАКРЫТА')).toBe('ТРАСУ ШАХТИ - БОРОВЕ ЗАКРИТО');
    for (const region of HT2_MOD_REGIONS)
      for (const e of readSch(read(`ENV/mod_${region}.sch`)))
        if (isList(e) && e[0] === 'nodeevent' && e[2] === 'UNCONDITIONAL') {
          const t = ukSign(str(e[5]));
          expect(RU.test(t) || /НАЛЕВО|НАПРАВО|ТРАССА|ЧЕРЕЗ \d+ М$/.test(t) && !/^БАЗА/.test(t), t).toBe(false);
        }
  });
});
