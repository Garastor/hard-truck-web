/** Растрові шрифти оригіналу: MENU.FON (6×9) і large.fon (12×17). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseFon } from '../src/formats/fon';

const read = (n: string) => new Uint8Array(readFileSync(`../Game/Hard Truck/${n}`));
const cp = (ch: string) => new TextEncoder().encode(ch)[0] && ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0xc0 + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.indexOf(ch);

describe('FON', () => {
  // large.fon — лише великі кириличні, цифри й частина латиниці.
  it.each([
    ['MENU.FON', 6, 8, '0123456789ABCZ$%АБЯЖ'],
    ['large.fon', 12, 16, '0123456789BCZ$%АБЯЖ'],
  ])('%s: клітинка %i, висота %i; є цифри, латиниця й кирилиця', (name, cellW, height, chars) => {
    const f = parseFon(read(name));
    expect(f.cellW).toBe(cellW);
    expect(f.height).toBe(height);
    for (const ch of chars) {
      const g = f.glyphs[cp(ch)];
      expect(g, ch).not.toBeNull();
      expect(g!.width).toBeGreaterThan(0);
      expect(g!.width).toBeLessThanOrEqual(cellW);
      expect(g!.bits.some((b) => b === 1), ch).toBe(true);
    }
    expect(f.glyphs[32]).not.toBeNull(); // пробіл має ширину
  });
});
