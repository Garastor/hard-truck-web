import { BinReader } from '@engine/formats/binary';

/**
 * Дорожня мережа Дальнобойщиків 2 (`ENV/*.way`): чанки `тег[4] + u32 розмір + дані`, вирівняні до 4 байтів.
 * ```
 * WTWR ─ MNAM (імʼя ділянки, «aa»)
 *      └ GDAT ─ GROM × n ─ RNAM (кімната, «room_aa_000»)
 *                        ├ RNOD × k ─ NNAM, POSN (3×f64), FLAG (u32), [ORTN (4×3 f64)]
 *                        └ RSEG × m ─ ATTR (u32, f64, u32), [RTEN (рядок, «W005»)], WDTH (2×f64), VDAT (u32 n, n×3 f64)
 * ```
 * Структура — за специфікацією VldmrInt/HT2-WAY-Tool (`HT2_WAY_FORMAT.md` v0.2, MIT) і `WAY.bt` AlexKimov (MIT);
 * значення полів ATTR — гіпотези (див. там). Координати — у системі B3D (z — висота).
 */
export interface WayNode {
  name: string;
  pos: [number, number, number];
  flag: number;
  /** Орієнтація (ORTN): осі X, Y, Z і точка — 12 чисел; є не в усіх вузлах. */
  orient?: number[];
}

export interface WaySegment {
  /** ATTR: тип/режим сегмента (гіпотеза), значення, клас. */
  type: number;
  value: number;
  cls: number;
  /** RTEN — коротке імʼя сегмента («W005»; є не в усіх; значення невідоме). */
  label?: string;
  widthLeft: number;
  widthRight: number;
  /** Точки полілінії: x, y, z підряд. */
  points: Float64Array;
}

export interface WayRoom {
  name: string;
  nodes: WayNode[];
  segments: WaySegment[];
}

export interface Way {
  map: string;
  rooms: WayRoom[];
  /** Невідомі теги, що траплялися (для дослідження). */
  unknown: string[];
}

interface Chunk {
  tag: string;
  start: number;
  end: number;
}

function* chunks(bytes: Uint8Array, start: number, end: number): Generator<Chunk> {
  const r = new BinReader(bytes, start);
  while (r.pos + 8 <= end) {
    const tag = r.fourcc();
    const size = r.u32();
    const s = r.pos;
    if (s + size > end) throw new Error(`WAY: чанк ${tag} виходить за межі @${s - 8}`);
    yield { tag, start: s, end: s + size };
    r.pos = s + size + ((4 - (size % 4)) % 4);
  }
}

const cstr = (bytes: Uint8Array, c: Chunk): string => new BinReader(bytes, c.start).fixedStr(c.end - c.start);

export function parseWay(bytes: Uint8Array): Way {
  const way: Way = { map: '', rooms: [], unknown: [] };
  const unk = (t: string) => way.unknown.includes(t) || way.unknown.push(t);
  const top = [...chunks(bytes, 0, bytes.length)];
  if (top.length !== 1 || top[0].tag !== 'WTWR') throw new Error('WAY: немає WTWR');
  for (const c of chunks(bytes, top[0].start, top[0].end)) {
    if (c.tag === 'MNAM') way.map = cstr(bytes, c);
    else if (c.tag === 'GDAT') {
      for (const g of chunks(bytes, c.start, c.end)) {
        if (g.tag !== 'GROM') {
          unk(g.tag);
          continue;
        }
        const room: WayRoom = { name: '', nodes: [], segments: [] };
        for (const e of chunks(bytes, g.start, g.end)) {
          if (e.tag === 'RNAM') room.name = cstr(bytes, e);
          else if (e.tag === 'RNOD') room.nodes.push(readNode(bytes, e, unk));
          else if (e.tag === 'RSEG') room.segments.push(readSegment(bytes, e, unk));
          else unk(e.tag);
        }
        way.rooms.push(room);
      }
    } else unk(c.tag);
  }
  return way;
}

function readNode(bytes: Uint8Array, c: Chunk, unk: (t: string) => void): WayNode {
  const n: WayNode = { name: '', pos: [0, 0, 0], flag: 0 };
  for (const e of chunks(bytes, c.start, c.end)) {
    const r = new BinReader(bytes, e.start);
    if (e.tag === 'NNAM') n.name = cstr(bytes, e);
    else if (e.tag === 'POSN') n.pos = [r.f64(), r.f64(), r.f64()];
    else if (e.tag === 'FLAG') n.flag = r.u32();
    else if (e.tag === 'ORTN') n.orient = Array.from({ length: (e.end - e.start) / 8 }, () => r.f64());
    else unk(e.tag);
  }
  return n;
}

function readSegment(bytes: Uint8Array, c: Chunk, unk: (t: string) => void): WaySegment {
  const s: WaySegment = { type: 0, value: 0, cls: 0, widthLeft: 0, widthRight: 0, points: new Float64Array(0) };
  for (const e of chunks(bytes, c.start, c.end)) {
    const r = new BinReader(bytes, e.start);
    if (e.tag === 'ATTR') {
      s.type = r.u32();
      s.value = r.f64();
      s.cls = r.u32();
    } else if (e.tag === 'RTEN') {
      s.label = cstr(bytes, e);
    } else if (e.tag === 'WDTH') {
      s.widthLeft = r.f64();
      s.widthRight = r.f64();
    } else if (e.tag === 'VDAT') {
      const n = r.u32();
      s.points = new Float64Array(n * 3);
      for (let i = 0; i < n * 3; i++) s.points[i] = r.f64();
    } else unk(e.tag);
  }
  return s;
}
