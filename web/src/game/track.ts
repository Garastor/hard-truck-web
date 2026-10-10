import * as THREE from 'three';
import type { B3d, Block } from '../formats/b3d';
import { g2t } from '../physics/world';

/**
 * Траса як граф «кімнат» (блоки 19) з порталами (30) та подіями (13).
 * Події (поле trigger.i1): 11 — точка рестарту (values: позиція xyz, напрям xyz, імʼя кімнати),
 * 666 — фініш, 4 — дощ (тунель). Портал: вертикальний прямокутник між кутами p1, p2 (система гри).
 */
export interface Portal {
  from: string;
  to: string;
  /** Кути в системі Three.js. */
  a: THREE.Vector3;
  b: THREE.Vector3;
}

export interface Room {
  name: string;
  portals: Portal[];
  restart: { position: THREE.Vector3; forward: THREE.Vector3 } | null;
  events: { name: string; type: number; param: number }[];
}

export const EVENT_RESTART = 11;
export const EVENT_FINISH = 666;
export const EVENT_RAIN = 4;
export const EVENT_CHECKPOINT = 7;
/** Загибель (вода, прірва): лише рестарт. */
export const EVENT_DEATH = 3264;

export class Track {
  readonly rooms = new Map<string, Room>();

  constructor(b3d: B3d) {
    for (const b of b3d.blocks) if (b.data.t === 19) this.rooms.set(b.name, this.readRoom(b));
  }

  private readRoom(block: Block): Room {
    const room: Room = { name: block.name, portals: [], restart: null, events: [] };
    const visit = (b: Block) => {
      const d = b.data;
      if (d.t === 30) room.portals.push({ from: block.name, to: d.room, a: g2t(d.p1), b: g2t(d.p2) });
      if (d.t === 13) {
        room.events.push({ name: b.name, type: d.trigger.i1, param: d.trigger.i2 });
        if (d.trigger.i1 === EVENT_RESTART && d.trigger.values.length >= 6) {
          const f = new Float32Array(d.trigger.values.buffer, d.trigger.values.byteOffset, 6);
          room.restart = { position: g2t([f[0], f[1], f[2]]), forward: g2t([f[3], f[4], f[5]]).setY(0).normalize() };
        }
      }
      if (b.groups) for (const g of b.groups) for (const c of g) visit(c);
    };
    if (block.groups) for (const g of block.groups) for (const c of g) visit(c);
    return room;
  }

  /** Найімовірніша кімната для точки: найближча точка рестарту. */
  guessRoom(p: THREE.Vector3): string | null {
    let best: string | null = null;
    let bestD = Infinity;
    for (const r of this.rooms.values()) {
      if (!r.restart) continue;
      const d = r.restart.position.distanceToSquared(p);
      if (d < bestD) {
        bestD = d;
        best = r.name;
      }
    }
    return best;
  }

  /** Якщо відрізок prev→cur перетинає портал поточної кімнати — повертає нову кімнату. */
  crossPortal(room: string, prev: THREE.Vector3, cur: THREE.Vector3): string | null {
    const r = this.rooms.get(room);
    if (!r) return null;
    for (const p of r.portals) if (segmentCrossesPortal(prev, cur, p)) return p.to;
    return null;
  }

  hasEvent(room: string, type: number): boolean {
    return this.rooms.get(room)?.events.some((e) => e.type === type) ?? false;
  }
}

/** Перетин відрізка з вертикальним прямокутником порталу (у площині XZ Three.js + висота Y). */
function segmentCrossesPortal(p0: THREE.Vector3, p1: THREE.Vector3, portal: Portal): boolean {
  const ax = portal.a.x;
  const az = portal.a.z;
  const bx = portal.b.x;
  const bz = portal.b.z;
  const side = (x: number, z: number) => (bx - ax) * (z - az) - (bz - az) * (x - ax);
  const s0 = side(p0.x, p0.z);
  const s1 = side(p1.x, p1.z);
  if (s0 === 0 || Math.sign(s0) === Math.sign(s1)) return false;
  const t = s0 / (s0 - s1);
  const ix = p0.x + (p1.x - p0.x) * t;
  const iz = p0.z + (p1.z - p0.z) * t;
  const iy = p0.y + (p1.y - p0.y) * t;
  const len2 = (bx - ax) ** 2 + (bz - az) ** 2;
  const u = ((ix - ax) * (bx - ax) + (iz - az) * (bz - az)) / len2;
  const ylo = Math.min(portal.a.y, portal.b.y) - 2;
  const yhi = Math.max(portal.a.y, portal.b.y) + 2;
  return u >= -0.05 && u <= 1.05 && iy >= ylo && iy <= yhi;
}
