/**
 * Golden-тести парсерів на файлах Дальнобойщиків 2 (Game/Hard Truck 2 — junction на теку гри). Без гри — пропускаються.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseRmp, parseMaterial } from '../src/formats/rmp';
import { parsePlm } from '../src/formats/plm';
import { parseTxr } from '../src/formats/txr';
import { parseMsk } from '../src/formats/msk';
import { parseB3d, walk, type Block } from '../src/formats/b3d';
import { isSdte } from '../src/formats/sdte';
import { assoc, isList, num, readSch, str } from '../src/formats/sexpr';
import { parseWay } from '../src/formats/way';
import { parseTech } from '../src/formats/tech';
import { parseHeightmap } from '../src/formats/heightmap';
import { parseOvl } from '../src/formats/ovl';
import { decodeCp1251 } from '../src/formats/binary';
import { HT2_FILES, HT2_REGIONS, HT2_REQUIRED } from '../src/games/ht2/files';
import { detectGame } from '../src/games/registry';
import { findStores, orderPay, parseGoods } from '../src/games/ht2/economy';

const GAME = resolve(import.meta.dirname, '..', '..', 'Game', 'Hard Truck 2');
const has = existsSync(join(GAME, 'king.exe'));

function files(ext: RegExp, dir = GAME): string[] {
  if (!has) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(ext, p) : ext.test(n) ? [relative(GAME, p).replaceAll('\\', '/')] : [];
  });
}
const read = (rel: string) => new Uint8Array(readFileSync(join(GAME, rel)));

describe.skipIf(!has)('HT2: B3D', () => {
  it.each(files(/\.b3d$/i))('%s розбирається повністю', (rel) => {
    const b = parseB3d(read(rel));
    let verts = 0;
    let polys = 0;
    for (const [blk] of walk(b.blocks)) {
      const d = blk.data;
      if (d.t === 7 || d.t === 6 || d.t === 37 || d.t === 36) verts += d.positions.length / 3;
      if (d.t === 8 || d.t === 35) {
        polys += d.polys.length;
        for (const p of d.polys) expect(p.material).toBeLessThan(b.materials.length + 1);
      }
    }
    expect(verts).toBeGreaterThan(0);
    expect(polys).toBeGreaterThan(0);
  });
});

describe.skipIf(!has)('HT2: порядок вершин полігонів', () => {
  // Біт 0x80 формату — смуга трикутників («зигзаг»: вершини 1 і 3 по один бік діагоналі 0–2), без нього — опуклий
  // багатокутник по колу (віяло). На цьому тримається триангуляція в SceneAssembler.addPolys.
  it('TRUCKS.B3D: 4-кутники з 0x80 — зигзаг, без — по колу', () => {
    const b = parseB3d(read('COMMON/TRUCKS.B3D'));
    const count = { strip: [0, 0], plain: [0, 0] };
    const visit = (blk: Block, pos: Float32Array | number[] | null) => {
      const d = blk.data;
      const cur = d.t === 7 || d.t === 6 || d.t === 37 || d.t === 36 ? d.positions : pos;
      if ((d.t === 8 || d.t === 35) && cur)
        for (const p of d.polys) {
          if (p.indices.length !== 4) continue;
          const P = p.indices.map((i) => [cur[i * 3], cur[i * 3 + 1], cur[i * 3 + 2]]);
          const sub = (u: number[], v: number[]) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
          const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const diag = sub(P[2], P[0]);
          const s1 = cross(diag, sub(P[1], P[0]));
          const s3 = cross(diag, sub(P[3], P[0]));
          const zigzag = s1[0] * s3[0] + s1[1] * s3[1] + s1[2] * s3[2] > 0;
          count[p.format & 0x80 ? 'strip' : 'plain'][zigzag ? 0 : 1]++;
        }
      for (const g of blk.groups ?? []) for (const c of g) visit(c, cur);
    };
    for (const blk of b.blocks) visit(blk, null);
    // Зигзаг серед 0x80 — переважна більшість (решта — вироджені/неплоскі), серед інших — жодного.
    expect(count.strip[0]).toBeGreaterThan(count.strip[1] * 10);
    expect(count.plain[0]).toBe(0);
  });
});

describe.skipIf(!has)('HT2: RES + текстури + маски', () => {
  it.each(files(/\.res$/i))('%s', (rel) => {
    const a = parseRmp(read(rel));
    const plm = [...a.palettes.values()].map(parsePlm)[0];
    // Імена можуть повторюватися (той самий файл двічі, напр. ENV/ap.res) — дані однакові.
    expect(new Set(a.order.TEXTUREFILES).size).toBe(a.textures.size);
    for (const [name, bytes] of a.textures) {
      const t = parseTxr(bytes);
      expect(t.data.length, name).toBe(t.width * t.height * 4);
      if (t.bump) expect(name).toMatch(/bump/i);
    }
    for (const [name, bytes] of a.masks) {
      const m = parseMsk(bytes, plm?.palette);
      expect(m.data.length, name).toBe(m.width * m.height * 4);
    }
    for (const line of a.materials) expect(parseMaterial(line).name).toBeTruthy();
  });
});

describe.skipIf(!has)('HT2: SCH / CNF (SDTE)', () => {
  it.each([...files(/\.sch$/i), ...files(/^game\.cnf$/i)])('%s розшифровується й читається', (rel) => {
    const bytes = read(rel);
    expect(isSdte(bytes)).toBe(true);
    const list = readSch(bytes);
    expect(list.length).toBeGreaterThan(0);
  });

  it('merchandise.sch: хліб', () => {
    const goods = readSch(read('merchandise.sch'));
    const bread = goods.find((g) => isList(g) && g[0] === 'BREAD') as unknown[];
    expect(bread).toBeTruthy();
    expect(bread[1]).toBe('CRATE');
    expect(str(bread.at(-1) as never)).toBe('Хлеб');
  });

  it('ENV/GAME.CNF: стартова позиція й типи гравців', () => {
    const cnf = readSch(read('ENV/GAME.CNF'));
    const start = assoc(cnf, 'startposition')!;
    expect(start.slice(1)).toEqual([-3020, -4625, 20]);
    const types = assoc(cnf, 'playertypes')!;
    expect(num(assoc(types.slice(1), 'police')?.[1])).toBe(15);
  });
});

describe.skipIf(!has)('HT2: WAY', () => {
  it.each(files(/\.way$/i))('%s', (rel) => {
    const w = parseWay(read(rel));
    expect(w.map).toMatch(/^[a-z]{2}$/);
    expect(w.rooms.length).toBeGreaterThan(0);
    expect(w.unknown).toEqual([]);
    for (const room of w.rooms) {
      expect(room.name).toMatch(/^room_/);
      for (const s of room.segments) {
        expect(s.points.length % 3).toBe(0);
        expect(s.points.length).toBeGreaterThanOrEqual(6);
        expect(s.widthLeft).toBeGreaterThan(0);
      }
    }
  });
});

describe.skipIf(!has)('HT2: vehicle.tech', () => {
  const tech = has ? parseTech(read('vehicle.tech')) : { records: [] };
  it('43 записи, групи за порядком', () => {
    expect(tech.records.length).toBe(43);
    expect(new Set(tech.records.map((t) => t.group))).toEqual(new Set(['cars', 'lorries', 'tractors', 'trailers']));
  });
  it('Zil-тягач = [TECH1] першої гри', () => {
    const zil = tech.records.find((t) => t.group === 'tractors' && t.carNode === 'Zil')!;
    expect(zil.mass).toBe(4100);
    expect(zil.horsePower).toBe(185);
    expect(zil.price).toBe(18000);
    expect(zil.gears.map((g) => +g.toFixed(2))).toEqual([7.44, 4.1, 2.29, 1.47, 1]);
    expect(zil.tachMaxPower).toBeCloseTo(1200, 0);
    expect(zil.wheelRadius).toBeCloseTo(0.533, 3);
  });
  it('усі вантажівки мають передачі й колеса', () => {
    for (const t of tech.records.filter((t) => t.group !== 'trailers')) {
      expect(t.gears.length, t.carNode).toBeGreaterThan(2);
      expect(t.mass, t.carNode).toBeGreaterThan(500);
      expect(t.prefix, t.carNode).toBeTruthy();
    }
  });
});

describe.skipIf(!has)('HT2: RAW, OVL', () => {
  it.each(files(/\.raw$/i))('%s — 257×257', (rel) => {
    const h = parseHeightmap(read(rel));
    expect(h.size).toBe(257);
    expect(Math.max(...h.heights)).toBeLessThanOrEqual(1);
  });
  it('TRUCKS.OVL: кластери моделей', () => {
    const ovl = parseOvl(decodeCp1251(read('COMMON/TRUCKS.OVL')));
    expect(ovl.size).toBeGreaterThan(10);
    expect([...ovl.values()].flat().every((n) => /\.(txr|msk)$/.test(n))).toBe(true);
  });
});

describe.skipIf(!has)('HT2: набір файлів для пристрою', () => {
  it('усі потрібні файли є в грі', () => {
    for (const f of HT2_REQUIRED) expect(existsSync(join(GAME, f)), f).toBe(true);
  });
  it('шлях з архіву → канонічний', () => {
    expect(HT2_FILES.canonical('Hard Truck 2/ENV/AA.B3D')).toBe('ENV/aa.b3d');
    expect(HT2_FILES.canonical('x/COMMON/trucks1.res')).toBe('COMMON/TRUCKS1.RES');
    expect(HT2_FILES.canonical('ENV/aa.res')).toBeNull();
  });
  it('гра за списком файлів', () => {
    expect(detectGame(['Hard Truck 2/king.exe', 'Hard Truck 2/LOAD.RES'])).toBe('ht2');
    expect(detectGame(['HardTruck/COUNT/COUNT2.B3D', 'HardTruck/LOAD.RES'])).toBe('ht1');
    expect(detectGame(['readme.txt'])).toBeNull();
  });
});

describe.skipIf(!has)('HT2: TXR з міпмапами (LVMP перед PFRM)', () => {
  it('ce1.res: трава — 565 без альфи, ліс For22_01 — 4444 з альфою', () => {
    const a = parseRmp(read('ENV/ce1.res'));
    expect(parseTxr(a.textures.get('txr/grass_ce1.txr')!).hasAlpha).toBe(false);
    expect(parseTxr(a.textures.get('txr/for22_01.txr')!).hasAlpha).toBe(true);
  });
});

describe.skipIf(!has)('HT2: економіка', () => {
  it('товари з merchandise.sch', () => {
    const goods = parseGoods(readSch(read('merchandise.sch')));
    expect(goods.length).toBeGreaterThan(50);
    const bread = goods.find((g) => g.id === 'BREAD')!;
    expect(bread).toMatchObject({ name: 'Хлеб', mass: 25, volume: 0.1, price: 70 });
    expect(goods.find((g) => g.id === 'AKM')!.illegal).toBe(true);
  });
  it('склади з вузлів WAY: 11 баз, у кожної 5 місць', () => {
    const regions = HT2_REGIONS.map((id) => ({ id, way: parseWay(read(`ENV/${id}.way`)) }));
    const stores = findStores(regions);
    expect(stores.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // 10 (aa) — без землі в порту
    expect(stores.every((s) => s.docks.length === 5)).toBe(true);
    expect(stores.find((s) => s.id === 3)!.town).toBe('Южный');
  });
  it('оплата росте з відстанню й терміновістю', () => {
    const g = { id: 'X', name: 'X', mass: 10, volume: 0.1, price: 100, ratio: 0.8, illegal: false, forMafia: false };
    expect(orderPay(g, 100, 5000, false)).toBe(Math.round((5000 * 0.115 + 0.4 * 100) * 3));
    expect(orderPay(g, 100, 5000, true)).toBeGreaterThan(orderPay(g, 100, 5000, false));
  });
});
