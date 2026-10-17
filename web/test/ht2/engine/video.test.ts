import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAvi } from '@ht2/formats/avi';
import { VideoDecoder5 } from '@ht2/engine/video/player';
import createIndeo5 from '@ht2/engine/video/indeo5.js';
import { HT2_DIR } from '../../gameDirs';

// Декодер Indeo 5 (wasm з FFmpeg, tools/video): кадрів з зображенням стільки ж, скільки в ffmpeg; кадр 60 trp.bne —
// середня яскравість як у ffmpeg (87,0; різниця з ним у середньому ≈ 1 рівень — інше згладжування кольору).
const WASM = join(__dirname, '../../../src/games/ht2/engine/video/indeo5.wasm');
// Кадрів з зображенням — як у ffprobe -count_frames (решта кадрів Indeo 5 — повтор попереднього).
const CLIPS: [string, number][] = [['trp.bne', 145], ['trml.bne', 200], ['trmm.bne', 149], ['TRw.bne', 103], ['TRw1.bne', 80], ['trbn.bne', 112], ['TRirr.bne', 113]];

describe.skipIf(!existsSync(join(HT2_DIR, 'trp.bne')))('Декодер Indeo 5', () => {
  for (const [name, pictures] of CLIPS)
    it(name, async () => {
      const m = await createIndeo5({ wasmBinary: readFileSync(WASM) });
      const avi = parseAvi(new Uint8Array(readFileSync(join(HT2_DIR, name))));
      const dec = await VideoDecoder5.open(avi, m);
      let decoded = 0;
      let mean = 0;
      for (let i = 0; i < avi.frames.length; i++) {
        const rgba = dec.decode();
        if (rgba) decoded++;
        if (i === 60 && rgba) {
          let s = 0;
          for (let k = 0; k < rgba.length; k++) if (k % 4 !== 3) s += rgba[k];
          mean = s / (rgba.length * 0.75);
        }
      }
      dec.close();
      expect(decoded).toBe(pictures);
      if (name === 'trp.bne') expect(mean).toBeCloseTo(87.0, 0);
    });
});
