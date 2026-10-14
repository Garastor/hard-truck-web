import { BinReader, type RgbaImage } from './binary';
import { maskConverter, readPfrmAt } from './txr';

/**
 * Маска/спрайт MSK (HUD, прилади, краплі, меню). Заголовок: fourcc, u16 ширина, u16 висота.
 * - MASK, MSK8: + палітра 256×RGB, далі RLE з 1-байтовими пікселями
 * - MSKR: RLE з 1-байтовими пікселями без палітри (потрібна зовнішня, з PLM)
 * - MS16: RLE з 2-байтовими пікселями, після даних PFRM (маски каналів) і ENDR
 * RLE: байт n; n ≤ 127 — далі n пікселів; інакше n−128 прозорих пікселів.
 * Перевірено на всіх 5721 масках гри.
 */
export type MskKind = 'MASK' | 'MSK8' | 'MSKR' | 'MS16';

export interface Msk extends RgbaImage {
  kind: MskKind;
}

export function parseMsk(bytes: Uint8Array, externalPalette?: Uint8Array): Msk {
  const r = new BinReader(bytes);
  const kind = r.fourcc() as MskKind;
  const width = r.u16();
  const height = r.u16();
  const total = width * height;
  const data = new Uint8ClampedArray(total * 4);

  if (kind === 'MS16') {
    // Спершу пройдемо RLE, щоб знайти PFRM за даними.
    const start = r.pos;
    let n = 0;
    while (n < total) {
      const c = r.u8();
      if (c <= 127) {
        r.skip(c * 2);
        n += c;
      } else n += c - 128;
    }
    const masks = readPfrmAt(bytes, r.pos) ?? { r: 0xf800, g: 0x07e0, b: 0x001f, a: 0 };
    const conv = maskConverter(masks);
    r.pos = start;
    n = 0;
    while (n < total) {
      const c = r.u8();
      if (c <= 127) {
        for (let i = 0; i < c; i++, n++) conv(r.u16(), data, n * 4);
      } else n += c - 128;
    }
    return { kind, width, height, data };
  }

  let palette: Uint8Array;
  if (kind === 'MASK' || kind === 'MSK8') palette = r.bytesN(768);
  else if (kind === 'MSKR') {
    if (!externalPalette) throw new Error('MSKR потребує зовнішньої палітри');
    palette = externalPalette;
  } else throw new Error(`MSK: unknown kind ${kind}`);

  let n = 0;
  while (n < total) {
    const c = r.u8();
    if (c <= 127) {
      for (let i = 0; i < c; i++, n++) {
        const ci = r.u8();
        const o = n * 4;
        data[o] = palette[ci * 3];
        data[o + 1] = palette[ci * 3 + 1];
        data[o + 2] = palette[ci * 3 + 2];
        data[o + 3] = 255;
      }
    } else n += c - 128;
  }
  return { kind, width, height, data };
}
