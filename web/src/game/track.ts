import * as THREE from 'three';
import type { B3d, Block } from '@engine/formats/b3d';
import { g2t } from '@engine/physics/world';

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

/**
 * Горизонтальний портал — обидва кути на одній висоті: прямокутник по осях X/Z між ними (відкритий верх виїмки, як у
 * MOUNT room_004 ↔ room_902/900 над спуском до тунелю). Решта порталів — вертикальні: від a до b по горизонталі,
 * між їхніми висотами.
 */
export function isHorizontalPortal(p: Portal): boolean {
  return Math.abs(p.a.y - p.b.y) < 0.01;
}

/** Чотири кути прямокутника порталу (Three.js) у порядку обходу. */
export function portalCorners(p: Portal, out: THREE.Vector3[]): THREE.Vector3[] {
  const [a, b, c, d] = out;
  if (isHorizontalPortal(p)) {
    a.set(p.a.x, p.a.y, p.a.z);
    b.set(p.b.x, p.a.y, p.a.z);
    c.set(p.b.x, p.a.y, p.b.z);
    d.set(p.a.x, p.a.y, p.b.z);
  } else {
    a.set(p.a.x, p.a.y, p.a.z);
    b.set(p.b.x, p.a.y, p.b.z);
    c.set(p.b.x, p.b.y, p.b.z);
    d.set(p.a.x, p.b.y, p.a.z);
  }
  return out;
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

  /** Тупикові підкімнати без власних порталів (ніші подіумів, полиці з товаром) → кімната, з якої в них прохід. */
  private readonly parent = new Map<string, string>();

  constructor(b3d: B3d) {
    for (const b of b3d.blocks) if (b.data.t === 19) this.rooms.set(b.name, this.readRoom(b));
    for (const r of this.rooms.values())
      for (const p of r.portals) {
        const to = this.rooms.get(p.to);
        if (to && !to.portals.length && !this.parent.has(p.to)) this.parent.set(p.to, r.name);
      }
  }

  /**
   * Кімната, у якій «перебуває» машина: тупикова підкімната — частина своєї кімнати (з неї нічого не видно
   * крізь портали, а події зали записані в основній кімнаті).
   */
  canonical(room: string): string {
    return this.parent.get(room) ?? room;
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

/** Перетин відрізка з прямокутником порталу (вертикальним — у площині XZ Three.js + висота Y; горизонтальним — площина Y). */
function segmentCrossesPortal(p0: THREE.Vector3, p1: THREE.Vector3, portal: Portal): boolean {
  if (isHorizontalPortal(portal)) {
    const y = portal.a.y;
    const s0 = p0.y - y;
    const s1 = p1.y - y;
    if (s0 === 0 || Math.sign(s0) === Math.sign(s1)) return false;
    const t = s0 / (s0 - s1);
    const ix = p0.x + (p1.x - p0.x) * t;
    const iz = p0.z + (p1.z - p0.z) * t;
    // Той самий запас 5 %, що й уздовж вертикального порталу.
    const mx = Math.abs(portal.b.x - portal.a.x) * 0.05;
    const mz = Math.abs(portal.b.z - portal.a.z) * 0.05;
    return (
      ix >= Math.min(portal.a.x, portal.b.x) - mx && ix <= Math.max(portal.a.x, portal.b.x) + mx &&
      iz >= Math.min(portal.a.z, portal.b.z) - mz && iz <= Math.max(portal.a.z, portal.b.z) + mz
    );
  }
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
