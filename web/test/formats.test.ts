/**
 * Golden-тести парсерів на реальних файлах гри (Game/Hard Truck). Без файлів гри — пропускаються.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseRmp, parseMaterial } from '@engine/formats/rmp';
import { parsePlm } from '@engine/formats/plm';
import { parseTxr } from '@engine/formats/txr';
import { parseMsk } from '@engine/formats/msk';
import { parseB3d, walk } from '@engine/formats/b3d';
import { parseIni, iniNum, iniNums } from '@engine/formats/ini';
import { decodeCp1251 } from '@engine/formats/binary';

const GAME = resolve(import.meta.dirname, '..', '..', 'Game', 'Hard Truck');
const has = existsSync(GAME);
const LEVELS = ['CIRCUIT', 'COUNT', 'MENU3D', 'MOUNT', 'NIGHT', 'TRIAL'];

function files(ext: RegExp): string[] {
  if (!has) return [];
  const out: string[] = [];
  for (const lvl of LEVELS) {
    const dir = join(GAME, lvl);
    for (const f of readdirSync(dir)) if (ext.test(f) && statSync(join(dir, f)).isFile()) out.push(join(lvl, f));
  }
  return out;
}

const read = (rel: string) => new Uint8Array(readFileSync(join(GAME, rel)));

describe.skipIf(!has)('RMP/RES + текстури + маски + палітри', () => {
  const archives = [...files(/\.rmp$/i), 'LOAD.RES'];

  it.each(archives)('%s', (rel) => {
    const a = parseRmp(read(rel));
    const plm = [...a.palettes.values()].map(parsePlm)[0];
    expect(a.order.TEXTUREFILES.length).toBe(a.textures.size);

    for (const [name, bytes] of [...a.textures, ...a.backgrounds]) {
      const t = parseTxr(bytes);
      expect(t.data.length, name).toBe(t.width * t.height * 4);
    }
    for (const [name, bytes] of a.masks) {
      const m = parseMsk(bytes, plm?.palette);
      expect(m.data.length, name).toBe(m.width * m.height * 4);
    }
    for (const line of a.materials) expect(parseMaterial(line).name).toBeTruthy();
    for (const [, wav] of a.sounds) expect(String.fromCharCode(...wav.subarray(0, 4))).toBe('RIFF');
  });
});

describe.skipIf(!has)('B3D', () => {
  it.each(files(/\.b3d$/i))('%s розбирається повністю', (rel) => {
    const b = parseB3d(read(rel));
    let blocks = 0;
    let verts = 0;
    let polys = 0;
    for (const [blk] of walk(b.blocks)) {
      blocks++;
      const d = blk.data;
      if (d.t === 7 || d.t === 6 || d.t === 37 || d.t === 36) verts += d.positions.length / 3;
      if (d.t === 8 || d.t === 35) {
        polys += d.polys.length;
        for (const p of d.polys) expect(p.material).toBeLessThan(b.materials.length + 1);
      }
    }
    expect(b.materials.length).toBeGreaterThan(300);
    expect(blocks).toBeGreaterThan(8000);
    expect(verts).toBeGreaterThan(0);
    expect(polys).toBeGreaterThan(0);
  });
});

describe.skipIf(!has)('TCH / INI', () => {
  it('TRUCK.TCH: параметри техніки', () => {
    const ini = parseIni(decodeCp1251(read('TRUCK.TCH')));
    expect(iniNum(ini, 'TECH1', 'mass', 0)).toBe(4100);
    expect(iniNum(ini, 'TECH1', 'gear_trans_coeff1', 0)).toBeCloseTo(7.44);
    expect(iniNums(ini, 'TECH1', 'driving_wheels')).toEqual([0, 0, 1, 1]);
    expect(iniNum(ini, 'NODES1', 'TachScale', 0)).toBe(50);
  });
});
