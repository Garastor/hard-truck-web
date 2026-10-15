/**
 * Інструмент (не тест): вивантаження графіки архіву RES/RMP у PNG — для реверсу інтерфейсу й перемальовування.
 *
 *   EXPORT_RES="D:/Games/Hard Truck 2/COMMON/esc16.RES" EXPORT_OUT="D:/…/exports/ingame/ht2" \
 *     npx vitest run test/ht2/tools/exportRes.test.ts
 *
 * Пише EXPORT_OUT/txr/*.png (текстури й фони), EXPORT_OUT/msk/*.png (маски; палітра — перша PLM архіву, якщо є) і
 * EXPORT_OUT/список.txt (оригінальне імʼя → розмір). «/» в імені → «__». Без EXPORT_RES — пропускається.
 * Результат — поза git (ресурси гри не публікувати).
 */
import { describe, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { parseRmp } from '@ht2/engine/formats/rmp';
import { parseTxr } from '@ht2/engine/formats/txr';
import { parseMsk } from '@ht2/engine/formats/msk';
import { parsePlm } from '@ht2/engine/formats/plm';

const CRC = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(b: Uint8Array): number {
  let c = -1;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** RGBA → PNG (без фільтрів). */
function png(w: number, h: number, rgba: Uint8ClampedArray): Buffer {
  const raw = new Uint8Array((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())]);
}

const RES = process.env.EXPORT_RES;
const OUT = process.env.EXPORT_OUT ?? 'export';

describe.runIf(!!RES)('вивантаження RES у PNG', () => {
  it(RES ?? '', () => {
    const a = parseRmp(new Uint8Array(readFileSync(RES!)));
    const plm = [...a.palettes.values()][0];
    const palette = plm ? parsePlm(plm).palette : undefined;
    const list: string[] = [];
    const save = (kind: 'txr' | 'msk', name: string, img: { width: number; height: number; data: Uint8ClampedArray }) => {
      mkdirSync(`${OUT}/${kind}`, { recursive: true });
      writeFileSync(`${OUT}/${kind}/${name.replace(/[\\/]/g, '__').replace(/\.\w+$/, '')}.png`, png(img.width, img.height, img.data));
      list.push(`${kind}\t${name}\t${img.width}×${img.height}`);
    };
    for (const map of [a.textures, a.backgrounds])
      for (const [name, bytes] of map) {
        try {
          save('txr', name, parseTxr(bytes));
        } catch (e) {
          list.push(`txr\t${name}\tпомилка: ${(e as Error).message}`);
        }
      }
    for (const [name, bytes] of a.masks) {
      try {
        save('msk', name, parseMsk(bytes, palette));
      } catch (e) {
        list.push(`msk\t${name}\tпомилка: ${(e as Error).message}`);
      }
    }
    mkdirSync(OUT, { recursive: true });
    writeFileSync(`${OUT}/список.txt`, list.join('\n'));
    console.log(`вивантажено ${list.length} → ${OUT}`);
  });
});
