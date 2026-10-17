import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseAvi, pcmChannels } from '@ht2/formats/avi';
import { HT2_DIR } from '../gameDirs';

// Ролики подій і заставки (re/notes/ht2/video.md): кадрів — як у заголовку avih, звук — тієї ж тривалості.
const FILES: [string, number, number][] = [
  ['trp.bne', 145, 480],
  ['trml.bne', 200, 480],
  ['trmm.bne', 149, 480],
  ['TRw.bne', 103, 480],
  ['TRw1.bne', 80, 480],
  ['trbn.bne', 112, 480],
  ['TRirr.bne', 120, 480],
  ['kotr.avi', 1308, 480],
  ['kotrDemo.avi', 1848, 440],
];

describe.skipIf(!existsSync(join(HT2_DIR, 'trp.bne')))('AVI роликів HT2', () => {
  for (const [name, frames, height] of FILES)
    it(name, () => {
      const buf = readFileSync(join(HT2_DIR, name));
      const a = parseAvi(new Uint8Array(buf));
      expect(a.video).toEqual({ codec: 'IV50', width: 640, height, fps: 12 });
      expect(a.audio).toEqual({ format: 1, channels: 1, rate: 22050, bits: 16 });
      expect(a.frames.length).toBe(frames);
      expect(buf.readUInt32LE(buf.indexOf('avih') + 8 + 16)).toBe(frames);
      const pcm = pcmChannels(a);
      expect(Math.abs(pcm[0].length / 22050 - frames / 12)).toBeLessThan(1);
    });
});
