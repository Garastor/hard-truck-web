import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from '../world/world';

/**
 * Місця біля складу (king.exe, re/notes/ht2/career-misc.md §1): вікно запускають не вузли WAY, а тригери B3D у
 * будівлі `store_<регіон>` — блоки 13 `store_NNMM` з `i1 = 17` і `i2 = NN·100 + MM` (NN — склад, MM — місце 00…04).
 * Зона — гілка дерева площин (блоки 9) у системі будівлі: |y| < 5 м, по x смуги по 15 м (під'їзна смуга й 10 м до
 * будівлі). Висоту, швидкість і орієнтацію гра не перевіряє; подія живе кадр — вийшов із зони, вікно зникає.
 * Місце 00 — розвантаження (є вантаж для цього складу), 01…04 — картка замовлення цього місця.
 *
 * Гіпотеза порту: тестується центр машини (у exe — точка біля камери, матриця viewer+0x208 × матриця машини).
 */
interface Zone {
  region: LoadedRegion;
  /** Світ (гра) → система будівлі. */
  inv: THREE.Matrix4;
  planes: { v: [number, number, number, number]; front: boolean }[];
  store: number;
  place: number;
}

/** Тригери складу в шаблоні будівлі (координати будівлі). */
function triggers(tpl: Block): { planes: Zone['planes']; store: number; place: number }[] {
  const out: { planes: Zone['planes']; store: number; place: number }[] = [];
  const walk = (b: Block, planes: Zone['planes']) => {
    if (b.data.t === 13 && b.data.trigger.i1 === 17) {
      const code = b.data.trigger.i2;
      out.push({ planes, store: Math.floor(code / 100), place: code % 100 });
      return;
    }
    const plane = b.data.t === 9 && b.data.shape.kind === 5 ? (b.data.shape.v as [number, number, number, number]) : null;
    (b.groups ?? []).forEach((g, gi) => {
      const next = plane && gi < 2 ? [...planes, { v: plane, front: gi === 0 }] : planes;
      for (const c of g) walk(c, next);
    });
  };
  walk(tpl, []);
  return out;
}

export class StoreZones {
  private readonly zones: Zone[] = [];
  private readonly seen = new WeakSet<LoadedRegion>();

  /** Місце складу, у якому точка (Three.js), чи null. */
  at(loaded: Iterable<LoadedRegion>, p: THREE.Vector3): { store: number; place: number } | null {
    this.sync(loaded);
    const g = new THREE.Vector3(p.x, -p.z, p.y);
    const l = new THREE.Vector3();
    for (const z of this.zones) {
      l.copy(g).applyMatrix4(z.inv);
      if (z.planes.every(({ v, front }) => v[0] * l.x + v[1] * l.y + v[2] * l.z + v[3] >= 0 === front)) return { store: z.store, place: z.place };
    }
    return null;
  }

  private sync(loaded: Iterable<LoadedRegion>): void {
    const live = new Set(loaded);
    for (let i = this.zones.length - 1; i >= 0; i--) if (!live.has(this.zones[i].region)) this.zones.splice(i, 1);
    for (const r of live) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      const asm = r.built.assembler;
      for (const b of walkAll(asm.b3d.blocks)) {
        const d = b.data;
        if (d.t !== 18 || !/^store_/i.test(d.object) || /hit/i.test(d.object)) continue;
        const tpl = asm.block(d.object);
        const m = asm.space(d.space);
        if (!tpl || !m) continue;
        const inv = m.clone().invert();
        for (const t of triggers(tpl)) this.zones.push({ region: r, inv, ...t });
      }
    }
  }
}

function* walkAll(blocks: readonly Block[]): Generator<Block> {
  for (const b of blocks) {
    yield b;
    for (const g of b.groups ?? []) yield* walkAll(g);
  }
}
