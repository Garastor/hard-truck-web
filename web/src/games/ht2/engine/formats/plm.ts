import { BinReader } from './binary';

/**
 * Палітра PLM: "PLM\0" u32 розмір, далі чанки (id[4], u32 розмір, дані).
 * PALT — 256×RGB; OPAC/FOG/INTE — таблиці програмного рендеру (не потрібні).
 */
export interface Plm {
  /** 256×RGB */
  palette: Uint8Array;
  chunks: Map<string, Uint8Array>;
}

export function parsePlm(bytes: Uint8Array): Plm {
  const r = new BinReader(bytes);
  if (r.fourcc() !== 'PLM\0') throw new Error('PLM: bad magic');
  const end = 8 + r.u32();
  const chunks = new Map<string, Uint8Array>();
  while (r.pos < end) {
    const id = r.fourcc().replace(/\0/g, '');
    chunks.set(id, r.bytesN(r.u32()));
  }
  const palette = chunks.get('PALT');
  if (!palette || palette.length !== 768) throw new Error('PLM: no PALT');
  return { palette, chunks };
}
