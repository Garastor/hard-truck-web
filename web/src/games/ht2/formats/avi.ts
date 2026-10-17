/**
 * Контейнер AVI (RIFF) роликів HT2 — `*.bne` і заставки `kotr*.avi` (re/notes/ht2/video.md): відео Indeo 5 (`IV50`),
 * звук PCM. Розбір — заголовок `avih`, потоки `strl` (`strh` + `strf`), кадри списку `movi` (`00dc`/`00db` — відео,
 * `01wb` — звук; `JUNK` і `rec ` пропускаються), індекс `idx1` — лише пропустити (кадри йдуть по порядку).
 */

export interface AviVideo {
  /** FourCC стиснення (`IV50`). */
  codec: string;
  width: number;
  height: number;
  /** Кадрів за секунду (dwRate / dwScale). */
  fps: number;
}

export interface AviAudio {
  /** Формат WAVE (1 — PCM). */
  format: number;
  channels: number;
  rate: number;
  bits: number;
}

export interface Avi {
  video: AviVideo;
  audio: AviAudio | null;
  /** Стиснені кадри відео по порядку; порожній (довжина 0) — повторити попередній. */
  frames: Uint8Array[];
  /** Звук — шматки потоку 1 підряд (для PCM — сирі відліки). */
  sound: Uint8Array[];
}

const fourcc = (d: DataView, o: number) => String.fromCharCode(d.getUint8(o), d.getUint8(o + 1), d.getUint8(o + 2), d.getUint8(o + 3));

export function parseAvi(buf: ArrayBuffer | Uint8Array): Avi {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fourcc(d, 0) !== 'RIFF' || fourcc(d, 8) !== 'AVI ') throw new Error('AVI: не RIFF AVI');
  const end = Math.min(bytes.length, 8 + d.getUint32(4, true));
  let video: AviVideo | null = null;
  let audio: AviAudio | null = null;
  const frames: Uint8Array[] = [];
  const sound: Uint8Array[] = [];
  let streamType = '';
  let streams = 0;
  let rate = 0;
  let scale = 1;
  // Обхід вкладених списків: LIST розкривається (вміст — від o + 12), інші шматки — за типом.
  const walk = (from: number, to: number) => {
    let o = from;
    while (o + 8 <= to) {
      const id = fourcc(d, o);
      const size = d.getUint32(o + 4, true);
      const body = o + 8;
      if (body + size > to) throw new Error(`AVI: шматок ${id} за межами (${o})`);
      if (id === 'LIST') walk(body + 4, body + size);
      else if (id === 'strh') {
        streamType = fourcc(d, body);
        scale = d.getUint32(body + 20, true) || 1;
        rate = d.getUint32(body + 24, true);
        streams++;
      } else if (id === 'strf') {
        if (streamType === 'vids')
          video = {
            codec: fourcc(d, body + 16),
            width: d.getInt32(body + 4, true),
            height: Math.abs(d.getInt32(body + 8, true)),
            fps: rate / scale,
          };
        else if (streamType === 'auds')
          audio = {
            format: d.getUint16(body, true),
            channels: d.getUint16(body + 2, true),
            rate: d.getUint32(body + 4, true),
            bits: d.getUint16(body + 14, true),
          };
      } else if (/^\d\d(dc|db)$/.test(id)) frames.push(bytes.subarray(body, body + size));
      else if (/^\d\dwb$/.test(id)) sound.push(bytes.subarray(body, body + size));
      // Шматки вирівняні на парну довжину.
      o = body + size + (size & 1);
    }
  };
  walk(12, end);
  if (!video) throw new Error('AVI: немає відеопотоку');
  if (streams === 0) throw new Error('AVI: немає потоків');
  return { video, audio, frames, sound };
}

/** Звук PCM 16 біт → відліки −1…1 по каналах (для AudioBuffer). */
export function pcmChannels(a: Avi): Float32Array[] {
  if (!a.audio || a.audio.format !== 1 || a.audio.bits !== 16) return [];
  const total = a.sound.reduce((s, c) => s + (c.length >> 1), 0);
  const ch = a.audio.channels;
  const out = Array.from({ length: ch }, () => new Float32Array(Math.floor(total / ch)));
  let i = 0;
  for (const c of a.sound) {
    const v = new DataView(c.buffer, c.byteOffset, c.byteLength);
    for (let o = 0; o + 1 < c.length; o += 2, i++) {
      const k = Math.floor(i / ch);
      if (k < out[0].length) out[i % ch][k] = v.getInt16(o, true) / 32768;
    }
  }
  return out;
}
