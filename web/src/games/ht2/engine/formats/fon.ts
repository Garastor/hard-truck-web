/**
 * Растрові шрифти оригіналу (MENU.FON — 6×9, large.fon — 12×17; HT2: matrix.fon — 7×12, icon.fon — 25×30).
 *
 * Формат — TGA з палітрою: заголовок (u16 при 0xC — ширина зображення, 0xE — висота; байт 0x11 — дескриптор),
 * пікселі — останні W·H байт файлу, по байту на піксель (0 — порожньо). Рядки знизу вгору (MENU.FON), а з бітом
 * 0x20 дескриптора — згори вниз (large.fon). Зображення — сітка 16×16 клітинок, символ з кодом c (cp1251) — у клітинці
 * (рядок c div 16, стовпчик c mod 16). Верхній рядок клітинки — смужка, довжина якої = ширина символу;
 * решта рядків — сам символ.
 * 16-бітні шрифти HT2 (байт 0x10 = 16: matrix.fon, icon.fon — табло) — TGA тип 2: пікселі по 2 байти одразу після
 * заголовка й поля ID, далі PFRM/ENDR; зафарбовано — будь-яке ненульове значення (у icon.fon символи 0x30–0x6F
 * намальовано майже чорним, 0xB0–0xEF — червоним; форма та сама).
 */
import { BinReader } from './binary';

export interface Glyph {
  /** Ширина символу (без проміжку), пікселів. */
  width: number;
  /** Пікселі символу: rows × cellW, 1 — зафарбовано. */
  bits: Uint8Array;
}

export interface BitmapFont {
  cellW: number;
  /** Висота символу (клітинка без рядка ширини). */
  height: number;
  glyphs: (Glyph | null)[];
}

export function parseFon(bytes: Uint8Array): BitmapFont {
  const r = new BinReader(bytes);
  r.pos = 0xc;
  const w = r.u16();
  const h = r.u16();
  const wide = bytes[0x10] === 16;
  const size = w * h * (wide ? 2 : 1);
  if (w % 16 || h % 16 || size > bytes.length) throw new Error(`FON: розмір ${w}×${h}`);
  const cellW = w / 16;
  const cellH = h / 16;
  const off = wide ? 18 + bytes[0] : bytes.length - size;
  const topDown = (bytes[0x11] & 0x20) !== 0;
  // Рядок y зображення (згори) лежить у файлі як рядок y (згори вниз) або (h − 1 − y) (знизу вгору).
  const row = (y: number) => (topDown ? y : h - 1 - y) * w;
  const px = wide
    ? (x: number, y: number) => bytes[off + (row(y) + x) * 2] | bytes[off + (row(y) + x) * 2 + 1]
    : (x: number, y: number) => bytes[off + row(y) + x];
  const glyphs: (Glyph | null)[] = [];
  for (let code = 0; code < 256; code++) {
    const cx = (code % 16) * cellW;
    const cy = Math.floor(code / 16) * cellH;
    let width = 0;
    while (width < cellW && px(cx + width, cy)) width++;
    const bits = new Uint8Array((cellH - 1) * cellW);
    let any = false;
    for (let y = 1; y < cellH; y++)
      for (let x = 0; x < cellW; x++) {
        const v = px(cx + x, cy + y) ? 1 : 0;
        bits[(y - 1) * cellW + x] = v;
        any ||= v === 1;
      }
    glyphs.push(width || any ? { width: width || cellW, bits } : null);
  }
  return { cellW, height: cellH - 1, glyphs };
}
