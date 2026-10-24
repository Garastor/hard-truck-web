/**
 * Golden-тести парсерів на файлах Дальнобойщиків 2 (Game/Hard Truck 2 — junction на теку гри). Без гри — пропускаються.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseRmp, parseMaterial } from '@ht2/engine/formats/rmp';
import { parsePlm } from '@ht2/engine/formats/plm';
import { parseTxr } from '@ht2/engine/formats/txr';
import { parseMsk } from '@ht2/engine/formats/msk';
import { parseB3d, walk, type Block } from '@ht2/engine/formats/b3d';
import { isSdte } from '@ht2/formats/sdte';
import { assoc, isList, num, readSch, str } from '@ht2/formats/sexpr';
import { parseWay } from '@ht2/formats/way';
import { parseTech } from '@ht2/formats/tech';
import { parseHeightmap } from '@ht2/formats/heightmap';
import { parseOvl } from '@ht2/formats/ovl';
import { decodeCp1251 } from '@ht2/engine/formats/binary';
import { HT2_FILES, HT2_REGIONS, HT2_REQUIRED } from '@ht2/files';
import { detectGame } from '@app/registry';
import { HT2_DIR } from '../gameDirs';
import { PAY_PER_M, cargoHit, findStores, hideIllegal, orderPay, parseGoods, parseServices, parseTowns } from '@ht2/career/economy';
import { HT2_MOD_REGIONS } from '@ht2/files';
import { install, parseUpgrades, tireGrip, tuning } from '@ht2/career/upgrades';
import { parseMarkets } from '@ht2/career/market';
import { TERRAIN, terrainHeightAt, terrainHeights } from '@ht2/world/terrain';
import { defaultSettings, timeScale } from '@ht2/ui/settings';
import { parseIni } from '@ht2/engine/formats/ini';

const GAME = HT2_DIR;
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
  it('розділи за межами із заголовка: CARS 0…16, LORRIES 17…25 (з Sobol), TRACTORS 26…38, SEMI-TRAILERS 39…42', () => {
    const at = (s: string) => tech.records.filter((t) => t.section === s).map((t) => t.index);
    expect(at('cars')).toEqual(Array.from({ length: 17 }, (_, i) => i));
    expect(at('lorries')).toEqual(Array.from({ length: 9 }, (_, i) => 17 + i));
    expect(at('tractors')).toEqual(Array.from({ length: 13 }, (_, i) => 26 + i));
    expect(at('semitrailers')).toEqual([39, 40, 41, 42]);
    expect(tech.records.find((t) => t.carNode === 'Sobol')).toMatchObject({ group: 'cars', section: 'lorries' });
  });
  it('Zil-тягач = [TECH1] першої гри', () => {
    const zil = tech.records.find((t) => t.group === 'tractors' && t.carNode === 'Zil')!;
    expect(zil.mass).toBe(4100);
    expect(zil.horsePower).toBe(185);
    expect(zil.price).toBe(18000);
    expect(zil.gears.map((g) => +g.toFixed(2))).toEqual([7.44, 4.1, 2.29, 1.47, 1, 0.71]);
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
    // Повні текстури — потрібні, половинні — запасні (імпортовані раніше), чверть — не беремо.
    expect(HT2_FILES.canonical('x/COMMON/trucks.res')).toBe('COMMON/TRUCKS.RES');
    expect(HT2_FILES.canonical('x/COMMON/trucks1.res')).toBe('COMMON/TRUCKS1.RES');
    expect(HT2_FILES.canonical('ENV/aa.res')).toBe('ENV/aa.res');
    expect(HT2_FILES.canonical('ENV/aa1.res')).toBe('ENV/aa1.res');
    expect(HT2_FILES.canonical('ENV/aa2.res')).toBeNull();
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
    expect(bread).toMatchObject({ name: 'Хліб', mass: 25, volume: 0.1, price: 70 });
    expect(goods.find((g) => g.id === 'AKM')!.illegal).toBe(true);
  });
  it('склади з вузлів WAY: 11 баз, у кожної 5 місць', () => {
    const regions = HT2_REGIONS.map((id) => ({ id, way: parseWay(read(`ENV/${id}.way`)) }));
    const stores = findStores(regions);
    expect(stores.map((s) => s.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // 10 — «Алмазный» на рельєфі aa
    expect(stores.every((s) => s.docks.length === 5)).toBe(true);
    expect(stores.find((s) => s.id === 3)!.town).toBe('Південний');
  });
  it('удар по вантажу за king.exe: міцність з merchandise.sch, поріг 2, d = (1 − міцність)·H·0,02', () => {
    const goods = parseGoods(readSch(read('merchandise.sch')));
    const by = new Map(goods.map((x) => [x.id, x]));
    expect(by.get('EGGS')!.durability).toBe(0.21);
    expect(by.get('COTTONWOOL')!.durability).toBe(0.96);
    expect(by.get('RDIAMOND')!.durability).toBe(0.95); // відрізняється від внутрішнього 0,6
    expect(by.get('AKM')!.durability).toBe(1);
    expect(cargoHit(1, 0.21, 1.9, 1)).toBeNull(); // слабший за поріг вмʼятин
    expect(cargoHit(1, 0.21, 10, 1)).toBeCloseTo(1 - 0.79 * 10 * 0.02);
    expect(cargoHit(1, 0.21, 6, 0.3)).toBeNull(); // пневмопідвіска: 6·0,3 = 1,8 ≤ 2
    expect(cargoHit(0.5, 0.96, 10, 1)).toBe(0.5); // d = 0,008 < 0,01 — без шкоди
    expect(cargoHit(1, 0.21, 80, 1)).toBe(0); // d > 1 — розбито
    expect(cargoHit(1, 1, 30, 1)).toBe(1); // нелегальне не псується
  });
  it('оплата гравцю за king.exe: ×14,4, з причепом ×21,6', () => {
    const g = { id: 'X', name: 'X', mass: 10, volume: 0.1, price: 100, ratio: 0.8, durability: 0.8, illegal: false, forMafia: false, trucks: true, fuel: false, cars: false, guilt: 0 };
    expect(orderPay(g, 100, 5000, false)).toBe(Math.round((5000 * PAY_PER_M + 0.4 * 100) * 14.4));
    expect(orderPay(g, 100, 5000, true)).toBe(Math.round((5000 * PAY_PER_M + 0.4 * 100) * 21.6));
  });
  it('прихований нелегальний товар: лише illegal + trucks, коефіцієнт штрафу з merchandise.sch', () => {
    const goods = parseGoods(readSch(read('merchandise.sch')));
    const byId = new Map(goods.map((x) => [x.id, x]));
    expect(byId.get('RWASTE')!.guilt).toBe(1.2);
    expect(byId.get('AKM')!.guilt).toBe(0.7);
    expect(byId.get('BREAD')!.guilt).toBe(0);
    const seen = new Set<string>();
    let n = 0;
    for (let i = 0; i < 2000; i++) {
      const h = hideIllegal(goods, Math.random);
      if (h) (n++, seen.add(h.id));
    }
    expect([...seen].sort()).toEqual(['CHWASTE', 'RWASTE']);
    expect(n / 2000).toBeGreaterThan(0.15);
    expect(n / 2000).toBeLessThan(0.25);
  });
});

describe.skipIf(!has)('HT2: покращення (restable.sch)', () => {
  it('ціни й ключі з файла, взаємовиключні варіанти', () => {
    const ups = parseUpgrades(readSch(read('restable.sch')));
    const by = Object.fromEntries(ups.map((u) => [u.key, u]));
    expect(by['PR_FORCED_ENGINE:1'].price).toBe(12500);
    expect(by['PR_FORCED_ENGINE:1'].original).toBe('Forced engine');
    expect(by['PR_BRAKES:1'].price).toBe(4500);
    expect(by['PR_TIRES:1'].price).toBe(2000);
    expect(by['PR_EXTRA_TANK:1'].price).toBe(500);
    expect(ups.length).toBe(17);
    const owned = install(['PR_TIRES:2', 'PR_ABS:1'], by['PR_TIRES:1']);
    expect(owned).toEqual(['PR_ABS:1', 'PR_TIRES:1']);
    expect(tuning(owned).tires).toBe(1);
    expect(tuning([]).torque).toBe(1);
    // king.exe (upgrades.md): форсований ×1,4, з присадкою ще ×1,25; шини — відношення μ до звичайних на асфальті.
    expect(tuning(['PR_FORCED_ENGINE:1', 'PR_OIL_ADDITIVE:1']).torque).toBeCloseTo(1.75, 6);
    expect(tireGrip(1, false, 1)).toBeCloseTo(0.8 / 0.6, 6);
    expect(tireGrip(2, false, 2)).toBeCloseTo(0.8 / 0.55, 6);
    expect(tireGrip(0, true, 1)).toBe(1);
  });
});

describe.skipIf(!has)('HT2: описи регіонів (ENV/mod_*.sch)', () => {
  const mods = (has ? HT2_MOD_REGIONS : []).map((region) => ({ region, sch: readSch(read(`ENV/mod_${region}.sch`)) }));
  it('міста: назви й товари складів', () => {
    const towns = parseTowns(mods);
    expect(towns.get(0)?.name).toBe('Приозерськ');
    expect(towns.get(4)?.name).toBe('Ключі');
    expect(towns.get(10)?.region).toBe('aa');
    expect(towns.get(0)?.goods).toContain('BREAD');
    // АЗС (вузли node_car_fuel*) — не склади.
    expect([...towns.values()].some((t) => /АЗС/.test(t.name))).toBe(false);
    const goods = new Set(parseGoods(readSch(read('merchandise.sch'))).map((g) => g.id.toUpperCase()));
    // Більшість товарів міст — відомі в merchandise.sch (C_* — контейнерні, окремий список).
    const all = [...towns.values()].flatMap((t) => t.goods.filter((g) => !g.startsWith('C_')));
    expect(all.filter((g) => goods.has(g)).length / all.length).toBeGreaterThan(0.8);
  });
  it('товари: вантажівкам — (trucks), легковим — C_* (cars), паливо — цистерна', () => {
    const goods = new Map(parseGoods(readSch(read('merchandise.sch'))).map((g) => [g.id.toUpperCase(), g]));
    expect(goods.get('BREAD')?.trucks).toBe(true);
    expect(goods.get('C_PIZZA')?.trucks).toBe(false);
    expect(goods.get('FUEL')?.fuel).toBe(true);
  });
  it('ринки вантажівок: parking MARKET_* з місцями-вузлами WAY', () => {
    const ways = HT2_REGIONS.map((id) => ({ way: parseWay(read(`ENV/${id}.way`)) }));
    const all = parseMarkets(mods, ways);
    const markets = all.filter((m) => !m.hidden);
    expect(markets.length).toBe(15);
    // Стоянки-схованки (номер −1): місця крадених (прапорець 8) і вживаних (32).
    const hidden = all.filter((m) => m.hidden);
    expect(hidden.length).toBe(15);
    expect(hidden.flatMap((m) => m.flags).filter((f) => f & 8).length).toBe(13);
    // У mod_*.sch їх 12, але одного вузла old_car у WAY немає.
    expect(hidden.flatMap((m) => m.flags).filter((f) => f & 32).length).toBe(11);
    const aj = markets.find((m) => m.id === 1)!;
    expect(aj.name).toBe('Барахолка');
    expect(aj.town).toBe('Приозерськ');
    expect(aj.spots.length).toBe(5);
    expect(markets.some((m) => m.name === '??')).toBe(false);
  });
  it('СТО: покращення за вузлом, шини — біти варіантів', () => {
    const sto = parseServices(mods);
    expect(sto.get('sto_ac')?.has('PR_TIRES:1')).toBe(true);
    expect(sto.get('sto_ac')?.has('PR_TIRES:2')).toBe(true);
    expect(sto.get('sto_ak')?.has('PR_TIRES:1')).toBe(false);
    expect(sto.get('sto_ak')?.has('PR_EXTRA_TANK:1')).toBe(true);
  });
});

describe.skipIf(!has)('HT2: налаштування одиночної гри (TRUCK.INI)', () => {
  it('повзунки з [EFFECTS]: trafs, days, weats, arcad', () => {
    // Гра сама переписує TRUCK.INI, коли гравець змінює налаштування (arcad=1 після «Аркадный») — звіряємо з файлом.
    const ini = parseIni(decodeCp1251(read('TRUCK.INI')));
    const s = defaultSettings(ini);
    expect(s.arcade).toBe(/^arcad\s*=\s*1/m.test(decodeCp1251(read('TRUCK.INI'))));
    for (const v of [s.traffic, s.dayLength, s.weather]) expect(v >= 0 && v <= 1).toBe(true);
    // Доба — timetemp = days · 0,005 + 0,02 реальних годин (king.exe): days=50 → 16,2 хв.
    expect((86400 / timeScale({ ...s, dayLength: 0.5 }) / 60).toFixed(1)).toBe('16.2');
  });
});

describe.skipIf(!has)('HT2: процедурний рельєф aa (ENV/terrain0–2.raw)', () => {
  it('дороги WAY регіону лежать на рельєфі (крок і початок сітки — підібрані)', () => {
    const heights = terrainHeights([0, 1, 2].map((i) => parseHeightmap(read(`ENV/terrain${i}.raw`))));
    expect(heights.length).toBe(TERRAIN.n * TERRAIN.n);
    const way = parseWay(read('ENV/aa.way'));
    const errs: number[] = [];
    for (const r of way.rooms)
      for (const s of r.segments)
        for (let i = 0; i < s.points.length; i += 3) errs.push(Math.abs(terrainHeightAt(heights, s.points[i], s.points[i + 1]) - s.points[i + 2]));
    errs.sort((a, b) => a - b);
    // Медіана розбіжності — сантиметри, 90 % точок — у межах 0,5 м (поодинокі — мости й насипи).
    expect(errs[Math.floor(errs.length / 2)]).toBeLessThan(0.2);
    expect(errs[Math.floor(errs.length * 0.9)]).toBeLessThan(0.5);
  });
});
