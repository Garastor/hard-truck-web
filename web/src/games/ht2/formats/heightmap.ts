/**
 * Карта висот Дальнобойщиків 2 (`MTR/terrain*.raw`): 257 × 257 значень u16 (little-endian), без заголовка.
 * У файлах обидва байти значення однакові (0x8888, 0x8a8a…) — фактично 8 біт висоти (`RAW.bt` AlexKimov, MIT).
 * Масштаб висоти у світі невідомий (гіпотеза: задає код траси).
 */
export interface Heightmap {
  size: number;
  /** Висоти 0…1 рядками. */
  heights: Float32Array;
}

export function parseHeightmap(bytes: Uint8Array): Heightmap {
  const size = Math.round(Math.sqrt(bytes.length / 2));
  if (size * size * 2 !== bytes.length) throw new Error(`RAW: розмір ${bytes.length} — не квадрат u16`);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const heights = new Float32Array(size * size);
  for (let i = 0; i < heights.length; i++) heights[i] = v.getUint16(i * 2, true) / 65535;
  return { size, heights };
}
