/** Шрифт вікон HT2 (MENU.FON): символи поза cp1251 не стають «?». */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFon } from '@ht2/engine/formats/fon';
import { PixelFont } from '@ht2/engine/ui/pixelFont';
import { HT2_DIR } from '../../gameDirs';

describe.skipIf(!existsSync(join(HT2_DIR, 'MENU.FON')))('PixelFont HT2', () => {
  let font: PixelFont;
  let question: ReturnType<PixelFont['glyph']>;
  beforeAll(() => {
    font = new PixelFont(parseFon(new Uint8Array(readFileSync(join(HT2_DIR, 'MENU.FON')))));
    question = font.glyph('?');
  });

  it('стрілки й × — власні гліфи в межах клітинки', () => {
    for (const ch of '↑↗→↘↓↙←↖×') {
      const g = font.glyph(ch);
      expect(g, ch).not.toBe(question);
      expect(g!.width).toBeLessThanOrEqual(font.font.cellW);
      expect(g!.bits.some((b) => b === 1), ch).toBe(true);
    }
  });

  it('«−», «…», лапки, тире — наявними символами', () => {
    expect(font.measure('−')).toBe(font.measure('-'));
    expect(font.measure('a…')).toBeGreaterThanOrEqual(font.measure('a.'));
    expect(font.measure('«А»')).toBeGreaterThan(font.measure('А'));
  });
});
