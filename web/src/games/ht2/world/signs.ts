import * as THREE from 'three';
import { isList, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import { toThree } from './world';

/**
 * Дорожні вказівники HT2 — `nodeevent` з `ENV/mod_<регіон>.sch`:
 * `(nodeevent BASE00LEFT UNCONDITIONAL "store_00_left" NORTH "БАЗА ПРИОЗЕРСК НАЛЕВО, ЧЕРЕЗ 300 М")` — вузол WAY,
 * напрям руху, текст. Проїжджаємо вузол (ближче RADIUS) у цьому напрямку — текст на табло (гіпотеза: напрям —
 * куди їде машина; NORTH — +y гри). Події STATEBORDER (межі регіонів, без тексту) не показуємо.
 */
const RADIUS = 25;
const REARM = 80;

interface Sign {
  pos: THREE.Vector3;
  dir: string;
  text: string;
  armed: boolean;
}

export class Signs {
  private readonly list: Sign[] = [];

  constructor(mods: Iterable<{ sch: SExpr[] }>, ways: Iterable<{ way: Way }>) {
    const nodes = new Map<string, [number, number, number]>();
    for (const { way } of ways) for (const room of way.rooms) for (const n of room.nodes) nodes.set(n.name.toLowerCase(), n.pos);
    for (const { sch } of mods)
      for (const e of sch) {
        if (!isList(e) || e[0] !== 'nodeevent' || e[2] !== 'UNCONDITIONAL') continue;
        const pos = nodes.get(str(e[3]).toLowerCase());
        const text = str(e[5]);
        if (pos && text) this.list.push({ pos: toThree(...pos), dir: str(e[4]), text, armed: true });
      }
  }

  get count(): number {
    return this.list.length;
  }

  /** Текст вказівника, біля якого проїжджаємо в його напрямку (раз на проїзд), або null. */
  update(p: THREE.Vector3, forward: THREE.Vector3): string | null {
    // Напрям у системі гри: x — схід, y — північ (у Three.js північ — −z).
    const hx = forward.x;
    const hy = -forward.z;
    const along: Record<string, boolean> = { NORTH: hy > 0.5, SOUTH: hy < -0.5, EAST: hx > 0.5, WEST: hx < -0.5, ALL: true };
    let shown: string | null = null;
    for (const s of this.list) {
      const d = Math.hypot(s.pos.x - p.x, s.pos.z - p.z);
      if (d > REARM) s.armed = true;
      if (s.armed && d < RADIUS && along[s.dir]) {
        s.armed = false;
        shown = s.text;
      }
    }
    return shown;
  }
}
