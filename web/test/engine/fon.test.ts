/** Растрові шрифти оригіналу: MENU.FON (6×9) і large.fon (12×17). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { parseFon } from '@engine/formats/fon';
import { join } from 'node:path';
import { HT1_DIR, HT2_DIR } from '../gameDirs';

const read = (n: string) => new Uint8Array(readFileSync(join(HT1_DIR, n)));
const cp = (ch: string) => new TextEncoder().encode(ch)[0] && ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 0xc0 + 'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ'.indexOf(ch);

// Без файлів гри (CI на GitHub) — пропускаємо.
describe.skipIf(!existsSync(join(HT1_DIR, 'MENU.FON')))('FON', () => {
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
    // Орієнтація: у «Т» найповніший рядок — верхній (large.fon зберігає рядки згори вниз, MENU.FON — знизу вгору).
    const t = f.glyphs[cp('Т')]!;
    const rows = Array.from({ length: f.height }, (_, y) => t.bits.slice(y * cellW, y * cellW + cellW).reduce((a, b) => a + b, 0));
    const firstInked = rows.findIndex((n) => n > 0);
    expect(rows[firstInked]).toBe(Math.max(...rows));
  });
});

// Табло Дальнобойщиків 2: 16-бітні шрифти (matrix.fon — підписи, icon.fon — цифри й значки табло).
describe.skipIf(!existsSync(join(HT2_DIR, 'icon.fon')))('FON HT2 (16 біт)', () => {
  const read2 = (n: string) => new Uint8Array(readFileSync(join(HT2_DIR, n)));
  it('matrix.fon: клітинка 7, висота 12; кирилиця й цифри', () => {
    const f = parseFon(read2('matrix.fon'));
    expect([f.cellW, f.height]).toEqual([7, 12]);
    for (const ch of '0129АПЯ') expect(f.glyphs[cp(ch)]?.bits.some((b) => b === 1), ch).toBe(true);
  });
  it('icon.fon: клітинка 25, висота 30; великі цифри 0x30, дрібні 0x40, ручник 0x5B–0x5C, стрілки 0x60', () => {
    const f = parseFon(read2('icon.fon'));
    expect([f.cellW, f.height]).toEqual([25, 30]);
    expect(f.glyphs[0x30]!.width).toBe(16);
    expect(f.glyphs[0x5b]!.width).toBe(25);
    for (const c of [0x30, 0x39, 0x40, 0x49, 0x4b, 0x50, 0x5a, 0x5b, 0x5c, 0x60]) expect(f.glyphs[c]?.bits.some((b) => b === 1), c.toString(16)).toBe(true);
  });
});
