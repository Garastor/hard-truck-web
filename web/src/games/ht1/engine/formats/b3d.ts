import { BinReader } from './binary';

/**
 * Сцена B3D (Hard Truck 1). Повний опис формату: Docs/formats/b3d.md.
 * Блок: 333, char[32] імʼя, u32 тип, дані, [u32 к-сть дочірніх, блоки з розділювачами груп 444], 555.
 */

export type Vec3 = [number, number, number];
/** Обмежувальна сфера: x, y, z, r. */
export type Sphere = [number, number, number, number];

export interface Polygon {
  /** format після XOR 1 (для типів 8/35). */
  format: number;
  unkF: number;
  unkI: number;
  material: number;
  indices: number[];
  /** UV першого набору для кожної вершини (якщо є) — u0,v0,u1,v1... */
  uvs: number[] | null;
  /** Нормалі вершин (якщо є повні vec3). */
  normals: number[] | null;
}

/** Геометрична «форма» тригерів і перемикачів (HTruck.exe 0x44ad24). */
export type Shape =
  | { kind: 0 }
  | { kind: 1 | 2 | 5; v: number[] }
  | { kind: 3 | 4; a: Vec3; b: Vec3; f: [number, number] }
  | { kind: 6; polys: Vec3[][] }
  | { kind: 7; points: Vec3[] };

export interface TriggerData {
  i1: number;
  i2: number;
  values: Uint32Array;
}

export type BlockData =
  | { t: 0; values: Float32Array }
  | { t: 1; name1: string; name2: string }
  | { t: 2; bound: Sphere; sphere2: Sphere }
  | { t: 3; bound: Sphere }
  | { t: 4; bound: Sphere; name1: string; name2: string }
  | { t: 5; bound: Sphere; name1: string }
  | { t: 6 | 7; bound: Sphere; name1: string; name2?: string; positions: Float32Array; uvs: Float32Array }
  | { t: 36 | 37; bound: Sphere; name1: string; name2?: string; format: number; positions: Float32Array; uvs: Float32Array; normals: Float32Array | null }
  | { t: 8 | 35; bound: Sphere; mtype?: number; material?: number; polys: Polygon[] }
  | { t: 9 | 10 | 11 | 22; bound: Sphere; shape: Shape }
  | { t: 12 | 13 | 14 | 15 | 16 | 17 | 23; bound: Sphere | null; shape: Shape; trigger: TriggerData }
  | { t: 18; bound: Sphere; space: string; object: string }
  | { t: 19 }
  | { t: 20; bound: Sphere; trigger: TriggerData; points: Vec3[] }
  | { t: 21; bound: Sphere; groupCount: number; i1: number }
  | { t: 24; matrix: [Vec3, Vec3, Vec3]; position: Vec3; flag: number }
  | { t: 25; i: [number, number, number]; sound: string; p1: Vec3; p2: Vec3; f: Float32Array }
  | { t: 26; bound: Sphere; v: Float32Array }
  | { t: 27; bound: Sphere; flag: number; p: Vec3; material: number }
  | { t: 28; bound: Sphere; center: Vec3; raw: Uint8Array }
  | { t: 29; bound: Sphere; flags: number; sphere2: Sphere; values: Float32Array }
  | { t: 30; bound: Sphere; room: string; p1: Vec3; p2: Vec3 }
  | { t: 31; bound: Sphere; sphere2: Sphere; i: number; p: Vec3; raw: Uint8Array }
  | { t: 33; bound: Sphere; i: [number, number, number]; p1: Vec3; p2: Vec3; f: Float32Array; rgb: Vec3 }
  | { t: 34; bound: Sphere; i: number; raw: Uint8Array }
  | { t: 39; bound: Sphere; i1: number; f: Vec3; i2: number }
  | { t: 40; bound: Sphere; name1: string; name2: string; i1: number; i2: number; values: Float32Array };

export interface Block {
  type: number;
  name: string;
  /** Зсув у файлі (початок імені), для налагодження. */
  offset: number;
  data: BlockData;
  /** Дочірні блоки по групах (розділювач 444). Для звичайних блоків — одна група. */
  groups: Block[][] | null;
}

export interface B3d {
  materials: string[];
  blocks: Block[];
}

const SWITCH_SHAPE: Record<number, 1 | 3 | 5> = { 9: 5, 10: 1, 11: 3, 22: 5 };
const TRIGGER_SHAPE: Record<number, number> = { 12: 5, 13: 0, 14: 1, 15: 2, 16: 3, 17: 4, 23: 6 };
const MAX = 1_000_000;

export function parseB3d(bytes: Uint8Array): B3d {
  const r = new BinReader(bytes);
  if (r.fourcc() !== 'b3d\0') throw new Error('B3D: bad magic');
  r.u32();
  const matOfs = r.u32() * 4;
  r.u32();
  const dataOfs = r.u32() * 4;
  const dataLen = r.u32() * 4;
  r.pos = matOfs;
  const nmat = r.u32();
  const materials: string[] = [];
  for (let i = 0; i < nmat; i++) materials.push(r.fixedStr(32));

  r.pos = dataOfs;
  expect(r, 111);
  const blocks: Block[] = [];
  const end = dataOfs + dataLen;
  while (r.pos < end) {
    const m = r.view.getUint32(r.pos, true);
    if (m === 222) {
      r.pos += 4;
      break;
    }
    blocks.push(readBlock(r));
  }
  return { materials, blocks };
}

function expect(r: BinReader, v: number): void {
  const got = r.u32();
  if (got !== v) throw new Error(`B3D: expected ${v} @${r.pos - 4}, got ${got}`);
}

function count(r: BinReader, what: string): number {
  const n = r.u32();
  if (n > MAX) throw new Error(`B3D: ${what} count ${n} @${r.pos - 4}`);
  return n;
}

function readBlock(r: BinReader): Block {
  let m = r.u32();
  while (m === 444) m = r.u32();
  if (m !== 333) throw new Error(`B3D: expected 333 @${r.pos - 4}, got ${m}`);
  const offset = r.pos;
  const name = r.fixedStr(32);
  const type = r.u32();
  let data: BlockData;
  let hasChildren: boolean;
  try {
    [data, hasChildren] = readData(r, type);
  } catch (e) {
    throw new Error(`B3D: block type ${type} "${name}" @${offset}: ${(e as Error).message}`);
  }
  let groups: Block[][] | null = null;
  if (hasChildren) {
    const n = count(r, 'children');
    groups = [[]];
    let read = 0;
    while (read < n) {
      const marker = r.view.getUint32(r.pos, true);
      if (marker === 444) {
        r.pos += 4;
        groups.push([]);
        continue;
      }
      groups[groups.length - 1].push(readBlock(r));
      read++;
    }
  }
  let e = r.u32();
  while (e === 444) {
    groups?.push([]);
    e = r.u32();
  }
  if (e !== 555) throw new Error(`B3D: block type ${type} "${name}" @${offset} ends with ${e} @${r.pos - 4}`);
  return { type, name, offset, data, groups };
}

function sphere(r: BinReader): Sphere {
  return [r.f32(), r.f32(), r.f32(), r.f32()];
}

function shape(r: BinReader, kind: number, presetCount = 0): Shape {
  switch (kind) {
    case 0:
      return { kind: 0 };
    case 1:
    case 2:
    case 5:
      return { kind, v: [r.f32(), r.f32(), r.f32(), r.f32()] };
    case 3:
    case 4:
      return { kind, a: r.vec3(), b: r.vec3(), f: [r.f32(), r.f32()] };
    case 6: {
      const n = count(r, 'shape polys');
      const polys: Vec3[][] = [];
      for (let i = 0; i < n; i++) {
        const k = count(r, 'shape verts');
        const pts: Vec3[] = [];
        for (let j = 0; j < k; j++) pts.push(r.vec3());
        polys.push(pts);
      }
      return { kind: 6, polys };
    }
    case 7: {
      const points: Vec3[] = [];
      for (let i = 0; i < presetCount; i++) points.push(r.vec3());
      return { kind: 7, points };
    }
  }
  throw new Error(`unknown shape kind ${kind}`);
}

function trigger(r: BinReader): TriggerData {
  const i1 = r.u32();
  const i2 = r.u32();
  const n = count(r, 'trigger values');
  const values = new Uint32Array(n);
  for (let i = 0; i < n; i++) values[i] = r.u32();
  return { i1, i2, values };
}

function simpleVerts(r: BinReader): { positions: Float32Array; uvs: Float32Array } {
  const n = count(r, 'verts');
  const positions = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    positions[i * 3] = r.f32();
    positions[i * 3 + 1] = r.f32();
    positions[i * 3 + 2] = r.f32();
    uvs[i * 2] = r.f32();
    uvs[i * 2 + 1] = r.f32();
  }
  return { positions, uvs };
}

function complexVerts(r: BinReader) {
  const formatRaw = r.u32();
  const fmt = formatRaw & 0xff;
  const extraUv = formatRaw >>> 8;
  const fullNormal = fmt === 1 || fmt === 2;
  const n = count(r, 'cverts');
  const positions = new Float32Array(n * 3);
  const uvs = new Float32Array(n * 2);
  const normals = fullNormal ? new Float32Array(n * 3) : null;
  for (let i = 0; i < n; i++) {
    positions[i * 3] = r.f32();
    positions[i * 3 + 1] = r.f32();
    positions[i * 3 + 2] = r.f32();
    uvs[i * 2] = r.f32();
    uvs[i * 2 + 1] = r.f32();
    r.skip(8 * extraUv);
    if (normals) {
      normals[i * 3] = r.f32();
      normals[i * 3 + 1] = r.f32();
      normals[i * 3 + 2] = r.f32();
    } else r.skip(4);
  }
  return { format: formatRaw, positions, uvs, normals };
}

function polygon8(r: BinReader): Polygon {
  const format = r.u32() ^ 1;
  const unkF = r.f32();
  const unkI = r.u32();
  const material = r.u32();
  const nv = count(r, 'poly verts');
  const useUv = (format & 2) !== 0;
  const useNormal = (format & 0x30) === 0x30;
  const uvCount = ((format >> 8) & 0xff) + (useUv ? 1 : 0);
  const fullNormal = (format & 1) !== 0;
  const indices: number[] = [];
  const uvs: number[] | null = useUv ? [] : null;
  const normals: number[] | null = useNormal && fullNormal ? [] : null;
  for (let i = 0; i < nv; i++) {
    indices.push(r.u32());
    if (useUv) {
      uvs!.push(r.f32(), r.f32());
      r.skip(8 * (uvCount - 1));
    }
    if (useNormal) {
      if (fullNormal) normals!.push(r.f32(), r.f32(), r.f32());
      else r.skip(4);
    }
  }
  return { format, unkF, unkI, material, indices, uvs, normals };
}

function skipPolygon28(r: BinReader): void {
  const format = r.u32();
  r.skip(12);
  const nv = count(r, 'poly28 verts');
  const useUv = (format & 2) !== 0;
  const uvCount = ((format >> 8) & 0xff) + 1;
  r.skip(nv * (8 + (useUv ? 8 * uvCount : 0)));
}

/** Повертає [дані, чи є дочірні]. */
function readData(r: BinReader, t: number): [BlockData, boolean] {
  if (t in SWITCH_SHAPE) {
    const bound = sphere(r);
    return [{ t: t as 9, bound, shape: shape(r, SWITCH_SHAPE[t]) }, true];
  }
  if (t in TRIGGER_SHAPE) {
    const k = TRIGGER_SHAPE[t];
    if (k === 6) {
      const trig = trigger(r);
      return [{ t: t as 23, bound: null, shape: shape(r, 6), trigger: trig }, false];
    }
    const bound = sphere(r);
    const sh = shape(r, k);
    return [{ t: t as 12, bound, shape: sh, trigger: trigger(r) }, false];
  }
  switch (t) {
    case 0:
      return [{ t, values: r.f32s(11) }, false];
    case 1:
      return [{ t, name1: r.fixedStr(32), name2: r.fixedStr(32) }, false];
    case 2:
      return [{ t, bound: sphere(r), sphere2: sphere(r) }, true];
    case 3:
      return [{ t, bound: sphere(r) }, true];
    case 4:
      return [{ t, bound: sphere(r), name1: r.fixedStr(32), name2: r.fixedStr(32) }, true];
    case 5:
      return [{ t, bound: sphere(r), name1: r.fixedStr(32) }, true];
    case 6: {
      const bound = sphere(r);
      const name1 = r.fixedStr(32);
      const name2 = r.fixedStr(32);
      return [{ t, bound, name1, name2, ...simpleVerts(r) }, true];
    }
    case 7: {
      const bound = sphere(r);
      const name1 = r.fixedStr(32);
      return [{ t, bound, name1, ...simpleVerts(r) }, true];
    }
    case 36: {
      const bound = sphere(r);
      const name1 = r.fixedStr(32);
      const name2 = r.fixedStr(32);
      return [{ t, bound, name1, name2, ...complexVerts(r) }, true];
    }
    case 37: {
      const bound = sphere(r);
      const name1 = r.fixedStr(32);
      return [{ t, bound, name1, ...complexVerts(r) }, true];
    }
    case 8:
    case 35: {
      const bound = sphere(r);
      let mtype: number | undefined;
      let material: number | undefined;
      if (t === 35) {
        mtype = r.u32();
        material = r.u32();
      }
      const n = count(r, 'polys');
      const polys: Polygon[] = [];
      for (let i = 0; i < n; i++) polys.push(polygon8(r));
      return [{ t, bound, mtype, material, polys }, false];
    }
    case 18:
      return [{ t, bound: sphere(r), space: r.fixedStr(32), object: r.fixedStr(32) }, false];
    case 19:
      return [{ t }, true];
    case 20: {
      const bound = sphere(r);
      const n = count(r, 'way points');
      const trig = trigger(r);
      const points: Vec3[] = [];
      for (let i = 0; i < n; i++) points.push(r.vec3());
      return [{ t, bound, trigger: trig, points }, false];
    }
    case 21:
      return [{ t, bound: sphere(r), groupCount: r.u32(), i1: r.u32() }, true];
    case 24: {
      const matrix: [Vec3, Vec3, Vec3] = [r.vec3(), r.vec3(), r.vec3()];
      return [{ t, matrix, position: r.vec3(), flag: r.u32() }, true];
    }
    case 25:
      return [{ t, i: [r.u32(), r.u32(), r.u32()], sound: r.fixedStr(32), p1: r.vec3(), p2: r.vec3(), f: r.f32s(5) }, false];
    case 26:
      return [{ t, bound: sphere(r), v: r.f32s(9) }, true];
    case 27:
      return [{ t, bound: sphere(r), flag: r.u32(), p: r.vec3(), material: r.u32() }, false];
    case 28: {
      const bound = sphere(r);
      const center = r.vec3();
      const start = r.pos;
      const n = count(r, 'poly28');
      for (let i = 0; i < n; i++) skipPolygon28(r);
      return [{ t, bound, center, raw: r.bytes.subarray(start, r.pos) }, false];
    }
    case 29: {
      const bound = sphere(r);
      const n = count(r, 'floats');
      const flags = r.u32();
      const sphere2 = sphere(r);
      return [{ t, bound, flags, sphere2, values: r.f32s(n) }, true];
    }
    case 30:
      return [{ t, bound: sphere(r), room: r.fixedStr(32), p1: r.vec3(), p2: r.vec3() }, false];
    case 31: {
      const bound = sphere(r);
      const n = count(r, 'pairs');
      const sphere2 = sphere(r);
      const i = r.u32();
      const p = r.vec3();
      return [{ t, bound, sphere2, i, p, raw: r.bytesN(8 * n) }, false];
    }
    case 33: {
      const bound = sphere(r);
      const i: [number, number, number] = [r.u32(), r.u32(), r.u32()];
      return [{ t, bound, i, p1: r.vec3(), p2: r.vec3(), f: r.f32s(6), rgb: r.vec3() }, true];
    }
    case 34: {
      const bound = sphere(r);
      const i = r.u32();
      const n = count(r, 'items');
      return [{ t, bound, i, raw: r.bytesN(16 * n) }, false];
    }
    case 39:
      return [{ t, bound: sphere(r), i1: r.u32(), f: r.vec3(), i2: r.u32() }, true];
    case 40: {
      const bound = sphere(r);
      const name1 = r.fixedStr(32);
      const name2 = r.fixedStr(32);
      const i1 = r.u32();
      const i2 = r.u32();
      return [{ t, bound, name1, name2, i1, i2, values: r.f32s(count(r, 'floats')) }, false];
    }
  }
  throw new Error(`unknown block type ${t}`);
}

/** Обхід дерева блоків у глибину. */
export function* walk(blocks: Block[], depth = 0): Generator<[Block, number]> {
  for (const b of blocks) {
    yield [b, depth];
    if (b.groups) for (const g of b.groups) yield* walk(g, depth + 1);
  }
}
