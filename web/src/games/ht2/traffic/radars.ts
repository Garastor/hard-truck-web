import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from '../world/world';
import { brokenRadars } from '../world/objects';

/**
 * Стаціонарні камери-радари (king.exe 0x56ffd0, 0x573b70; re/notes/ht2/police.md «Камери»): тригери B3D типу 13 з
 * кодом 30 (0x1E) у дереві площин кімнати; i2 — номер радара (AnmObj0003) чи −1 (зона попередження); дані — 4 float:
 * ліміт км/год і напрям (x, y, z, гра). Лише машина гравця, курс · напрям > 0:
 * - зона −1 — сигнал радар-детектора 0,5;
 * - радар — без фарби Stealth сигнал детектора 0,5; швидкість понад ліміт і радар ще не спрацьовував — спалах і штраф
 *   250 × ступінь (+15 км/год — 2, +35 — 3) одразу з грошей, картка 16 (ліміт на картці — trunc(ліміт) − 5, швидкість —
 *   trunc(v·3,6)); кожна камера — один раз за гру (номер зберігається в кар'єрі). Міліції й погоні немає.
 * Збитий радар (удар P ≥ 5000, `+0x128 & 1`, world/objects.ts brokenRadars) не фотографує й не штрафує.
 * Гіпотези порту: кімната — за габаритами геометрії (як заборонена зона), точка — центр машини; спалах моделі
 * AnmObj0003 не перенесено.
 */
export interface RadarHit {
  id: number;
  limit: number;
  speedKmh: number;
  degree: 1 | 2 | 3;
}

interface RadarTree {
  region: LoadedRegion;
  box: THREE.Box3;
  root: Block;
}

const CHECK_EVERY = 0.1;
const SIGNAL = 0.5;

function isRadar(b: Block): boolean {
  return b.data.t === 13 && b.data.trigger.i1 === 30;
}

function hasRadar(b: Block): boolean {
  return isRadar(b) || (b.groups ?? []).some((g) => g.some(hasRadar));
}

/** Листок дерева площин для точки гри (x, y, z): тригер радара чи undefined. */
function leaf(blocks: readonly Block[], x: number, y: number, z: number): Block | undefined {
  for (const b of blocks) {
    if (isRadar(b)) return b;
    if (b.data.t === 9 && b.data.shape.kind === 5) {
      const [a, bb, c, d] = b.data.shape.v;
      const r = leaf(b.groups?.[a * x + bb * y + c * z + d >= 0 ? 0 : 1] ?? [], x, y, z);
      if (r) return r;
    } else if (b.groups) {
      for (const g of b.groups) {
        const r = leaf(g, x, y, z);
        if (r) return r;
      }
    }
  }
  return undefined;
}

/** Тригери радарів у блоках регіону: кімната (тип 19) і корені з радарами. */
export function radarTriggers(blocks: readonly Block[]): { room: string; root: Block; triggers: { id: number; limit: number; dir: [number, number, number] }[] }[] {
  const out: { room: string; root: Block; triggers: { id: number; limit: number; dir: [number, number, number] }[] }[] = [];
  for (const b of blocks) {
    if (b.data.t !== 19 || !b.name || !hasRadar(b)) continue;
    const triggers: { id: number; limit: number; dir: [number, number, number] }[] = [];
    const visit = (x: Block): void => {
      if (isRadar(x) && x.data.t === 13 && x.data.trigger.values.length >= 4) {
        const f = new Float32Array(x.data.trigger.values.buffer, x.data.trigger.values.byteOffset, 4);
        triggers.push({ id: x.data.trigger.i2 | 0, limit: f[0], dir: [f[1], f[2], f[3]] });
      }
      for (const g of x.groups ?? []) g.forEach(visit);
    };
    visit(b);
    out.push({ room: b.name.toLowerCase(), root: b, triggers });
  }
  return out;
}

export class Radars {
  private timer = 0;
  private readonly seen = new WeakSet<LoadedRegion>();
  private readonly trees: RadarTree[] = [];
  /** Сигнал для радар-детектора (0 — немає, 0,5 — у зоні камери). */
  signal = 0;

  /**
   * Кадр: камери під гравцем. pos і forward — Three.js; speed — м/с; fired — номери камер, що вже спрацювали (кар'єра);
   * stealth — фарба Stealth. Повертає спрацювання (штраф рахує гра).
   */
  update(dt: number, loaded: Iterable<LoadedRegion>, pos: THREE.Vector3, forward: THREE.Vector3, speed: number, fired: ReadonlySet<number>, stealth: boolean): RadarHit | null {
    if ((this.timer -= dt) > 0) return null;
    this.timer = CHECK_EVERY;
    this.sync(loaded);
    this.signal = 0;
    // Система гри: x, y — площина, z — угору.
    const x = pos.x;
    const y = -pos.z;
    const z = pos.y;
    for (const t of this.trees) {
      const b = t.box;
      if (pos.x < b.min.x || pos.x > b.max.x || pos.z < b.min.z || pos.z > b.max.z) continue;
      const trig = leaf([t.root], x, y, z);
      if (!trig || trig.data.t !== 13 || trig.data.trigger.values.length < 4) continue;
      const f = new Float32Array(trig.data.trigger.values.buffer, trig.data.trigger.values.byteOffset, 4);
      // Напрям камери (гра) → Three.js: (x, z, −y).
      const along = forward.x * f[1] + forward.y * f[3] - forward.z * f[2];
      if (along <= 0) continue;
      // i2 — беззнакове в даних: −1 (зона попередження) читається як 0xFFFFFFFF.
      const id = trig.data.trigger.i2 | 0;
      if (id < 0) {
        this.signal = SIGNAL;
        continue;
      }
      if (!stealth) this.signal = SIGNAL;
      const limit = f[0];
      const kmh = speed * 3.6;
      if (limit >= kmh || fired.has(id) || brokenRadars.has(id)) continue;
      const degree = speed > (limit + 35) / 3.6 ? 3 : speed > (limit + 15) / 3.6 ? 2 : 1;
      return { id, limit, speedKmh: kmh, degree };
    }
    return null;
  }

  private sync(loaded: Iterable<LoadedRegion>): void {
    const live = new Set(loaded);
    for (let i = this.trees.length - 1; i >= 0; i--) if (!live.has(this.trees[i].region)) this.trees.splice(i, 1);
    for (const r of live) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      const found = radarTriggers(r.built.assembler.b3d.blocks);
      if (!found.length) continue;
      const rooms = new Map(r.built.rooms.map((g) => [g.name.toLowerCase(), g]));
      for (const f of found) {
        const g = rooms.get(f.room);
        if (g) this.trees.push({ region: r, box: new THREE.Box3().setFromObject(g), root: f.root });
      }
    }
  }
}
