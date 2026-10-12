import { BinReader, type RgbaImage } from './binary';

/**
 * Текстура TXR = TGA.
 * - 8 біт: TGA тип 1 (палітра 256×BGR24), після пікселів може бути чанк LVMP (міпмапи) — ігноруємо.
 * - 16 біт: TGA тип 2; поле ID (12 байт) = чанк LOFF (зсув до PFRM); після пікселів PFRM з масками
 *   каналів (565 або 4444), далі ENDR.
 * - HT2: PFRM з нульовими масками — карта нерівностей (`bump_*.txr`, du/dv для рельєфного відбиття D3D):
 *   молодший байт — du, старший — dv (зі знаком). Розкладаємо в RG навколо 128 (B = 255), `bump: true`.
 */
export interface Txr extends RgbaImage {
  bpp: 8 | 16;
  /** Чи є в текстурі альфа-канал (16 біт з alpha-маскою). */
  hasAlpha: boolean;
  /** Карта нерівностей du/dv (HT2), не колір. */
  bump?: boolean;
}

export interface ChannelMasks {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseTxr(bytes: Uint8Array): Txr {
  const r = new BinReader(bytes);
  const idLength = r.u8();
  const colorMapType = r.u8();
  const imageType = r.u8();
  const cmFirst = r.u16();
  const cmLength = r.u16();
  const cmDepth = r.u8();
  r.skip(4); // x, y origin
  const width = r.u16();
  const height = r.u16();
  const bpp = r.u8();
  const descriptor = r.u8();
  const topDown = (descriptor & 0x20) !== 0;
  const idField = r.bytesN(idLength);
  const data = new Uint8ClampedArray(width * height * 4);

  if (imageType === 1 && colorMapType === 1 && bpp === 8) {
    if (cmDepth !== 24) throw new Error(`TXR: palette depth ${cmDepth}`);
    const pal = r.bytesN(cmLength * 3);
    const px = r.bytesN(width * height);
    for (let y = 0; y < height; y++) {
      const dy = topDown ? y : height - 1 - y;
      for (let x = 0; x < width; x++) {
        const ci = px[y * width + x] - cmFirst;
        const o = (dy * width + x) * 4;
        data[o] = pal[ci * 3 + 2];
        data[o + 1] = pal[ci * 3 + 1];
        data[o + 2] = pal[ci * 3];
        data[o + 3] = 255;
      }
    }
    return { width, height, data, bpp: 8, hasAlpha: false };
  }

  if (imageType === 2 && bpp === 16) {
    const pixStart = r.pos;
    r.skip(width * height * 2);
    const masks = findPfrm(bytes, idField, r.pos) ?? { r: 0x7c00, g: 0x03e0, b: 0x001f, a: 0x8000 };
    const v = new DataView(bytes.buffer, bytes.byteOffset + pixStart, width * height * 2);
    if (!masks.r && !masks.g && !masks.b) {
      for (let y = 0; y < height; y++) {
        const dy = topDown ? y : height - 1 - y;
        for (let x = 0; x < width; x++) {
          const o = (dy * width + x) * 4;
          data[o] = 128 + v.getInt8((y * width + x) * 2);
          data[o + 1] = 128 + v.getInt8((y * width + x) * 2 + 1);
          data[o + 2] = 255;
          data[o + 3] = 255;
        }
      }
      return { width, height, data, bpp: 16, hasAlpha: false, bump: true };
    }
    const conv = maskConverter(masks);
    for (let y = 0; y < height; y++) {
      const dy = topDown ? y : height - 1 - y;
      for (let x = 0; x < width; x++) {
        conv(v.getUint16((y * width + x) * 2, true), data, (dy * width + x) * 4);
      }
    }
    return { width, height, data, bpp: 16, hasAlpha: masks.a !== 0 };
  }
  throw new Error(`TXR: unsupported TGA type=${imageType} bpp=${bpp}`);
}

function findPfrm(bytes: Uint8Array, idField: Uint8Array, after: number): ChannelMasks | null {
  let pos = after;
  if (idField.length >= 12 && String.fromCharCode(...idField.subarray(0, 4)) === 'LOFF') {
    pos = new DataView(idField.buffer, idField.byteOffset).getUint32(8, true);
  }
  return readPfrmAt(bytes, pos);
}

/** Читає чанк PFRM за зсувом (або null). */
export function readPfrmAt(bytes: Uint8Array, pos: number): ChannelMasks | null {
  if (pos + 24 > bytes.length) return null;
  const r = new BinReader(bytes, pos);
  if (r.fourcc() !== 'PFRM') return null;
  r.u32();
  return { r: r.u32(), g: r.u32(), b: r.u32(), a: r.u32() };
}

/** Повертає функцію, що розкладає 16-бітний піксель за масками в RGBA8. */
export function maskConverter(m: ChannelMasks): (px: number, out: Uint8ClampedArray, o: number) => void {
  const ch = (mask: number) => {
    if (!mask) return null;
    let shift = 0;
    while (!((mask >> shift) & 1)) shift++;
    const max = mask >> shift;
    return { mask, shift, scale: 255 / max };
  };
  const R = ch(m.r)!;
  const G = ch(m.g)!;
  const B = ch(m.b)!;
  const A = ch(m.a);
  return (px, out, o) => {
    out[o] = ((px & R.mask) >> R.shift) * R.scale;
    out[o + 1] = ((px & G.mask) >> G.shift) * G.scale;
    out[o + 2] = ((px & B.mask) >> B.shift) * B.scale;
    out[o + 3] = A ? ((px & A.mask) >> A.shift) * A.scale : 255;
  };
}
