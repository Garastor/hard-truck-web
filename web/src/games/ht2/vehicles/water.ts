import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from '../world/world';

/**
 * Вода Дальнобойщиків 2 (king.exe 0x4ce300, 0x56ffd0; re/notes/ht2/upgrades.md §10 і «Вибування гравця»): тригери B3D
 * типу 13 з даними `(16, рівень h)` — `water_<регіон>_<nnn>`, ≈ 142 у `ENV/*.b3d`, рівні 0…33 м (аа — озеро 447 м).
 * Тригер лежить у кімнаті, часто в гілці дерева площин (блок 9): зона — кімната, обмежена площинами на шляху до
 * тригера. Машина нижче рівня (висота її початку координат < h) — утонула: кінець гри. Повітрозабірник опускає
 * межу на 1 м (сервер 0x4ce300; клієнтська перевірка 0x570885 поправки не має — котра перша, не зʼясовано, у порту
 * діє, як описано в посібнику).
 *
 * Повені (`obstacle` Flood…Key, world/obstacles.ts): тригери води кімнат aw_006, ax_012/013, ax_024/025, aq_024 лежать
 * у гілках перемикача `refer_Flood…Key` — гілка 0 (звичайний рівень) і 1 (на 3 м вище, повінь). Діє лише гілка
 * поточного стану перемикача (раніше бралися обидві — максимум, тобто «повінь» завжди й вода ≈ 2 м над дорогою).
 *
 * Гіпотези порту: кімната — за габаритами її геометрії (як заборонена зона); висота машини — центр тіла.
 */
interface Zone {
  region: LoadedRegion;
  box: THREE.Box3;
  /** Площини шляху (гра): [a, b, c, d] і бік (true — a·x + b·y + c·z + d ≥ 0). */
  planes: { v: [number, number, number, number]; front: boolean }[];
  level: number;
  /** Гілка перемикача (`<Ключ>#<гілка>`, без `refer_`); '' — діє завжди. */
  sw: string;
}

const CHECK_EVERY = 0.25;
const SNORKEL = 1;

/** Тригери води в блоках регіону: кімната, площини шляху, рівень. */
export function waterTriggers(blocks: readonly Block[]): { room: string; planes: Zone['planes']; level: number; sw: string }[] {
  const out: { room: string; planes: Zone['planes']; level: number; sw: string }[] = [];
  const walk = (b: Block, room: string, planes: Zone['planes'], sw: string) => {
    if (b.data.t === 13 && b.data.trigger.i1 === 16 && b.data.trigger.values.length) {
      const v = b.data.trigger.values;
      const level = new Float32Array(v.buffer, v.byteOffset, 1)[0];
      out.push({ room, planes, level, sw });
      return;
    }
    const plane = b.data.t === 9 && b.data.shape.kind === 5 ? (b.data.shape.v as [number, number, number, number]) : null;
    const key = b.data.t === 21 && b.name ? b.name.replace(/^refer_/i, '') : '';
    (b.groups ?? []).forEach((g, gi) => {
      const next = plane && gi < 2 ? [...planes, { v: plane, front: gi === 0 }] : planes;
      for (const c of g) walk(c, room, next, key ? `${key}#${gi}` : sw);
    });
  };
  for (const b of blocks) if (b.data.t === 19 && b.name) walk(b, b.name.toLowerCase(), [], '');
  return out;
}

export class Water {
  /** Стан перемикача світу за ключем (без `refer_`); за замовчуванням — 0. */
  constructor(private readonly switchState: (key: string) => number = () => 0) {}

  private timer = 0;
  private readonly seen = new WeakSet<LoadedRegion>();
  private readonly zones: Zone[] = [];

  /** Кадр: чи машина (центр тіла, Three.js) під водою; snorkel — повітрозабірник. */
  update(dt: number, loaded: Iterable<LoadedRegion>, pos: THREE.Vector3, snorkel: boolean): boolean {
    if ((this.timer -= dt) > 0) return false;
    this.timer = CHECK_EVERY;
    this.sync(loaded);
    const level = this.levelAt(pos);
    return level !== null && pos.y < level - (snorkel ? SNORKEL : 0);
  }

  /** Рівень води в точці (Three.js) чи null — не у воді. */
  levelAt(p: THREE.Vector3): number | null {
    const x = p.x;
    const y = -p.z;
    const z = p.y;
    let best: number | null = null;
    for (const w of this.zones) {
      const b = w.box;
      if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z) continue;
      if (!w.planes.every(({ v, front }) => v[0] * x + v[1] * y + v[2] * z + v[3] >= 0 === front)) continue;
      if (w.sw) {
        const [key, branch] = w.sw.split('#');
        if (this.switchState(key) !== Number(branch)) continue;
      }
      best = Math.max(best ?? -Infinity, w.level);
    }
    return best;
  }

  private sync(loaded: Iterable<LoadedRegion>): void {
    const live = new Set(loaded);
    for (let i = this.zones.length - 1; i >= 0; i--) if (!live.has(this.zones[i].region)) this.zones.splice(i, 1);
    for (const r of live) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      const trig = waterTriggers(r.built.assembler.b3d.blocks);
      if (!trig.length) continue;
      const boxes = new Map(r.built.rooms.map((g) => [g.name.toLowerCase(), g]));
      for (const t of trig) {
        const g = boxes.get(t.room);
        if (g) this.zones.push({ region: r, box: new THREE.Box3().setFromObject(g), planes: t.planes, level: t.level, sw: t.sw });
      }
    }
  }
}
