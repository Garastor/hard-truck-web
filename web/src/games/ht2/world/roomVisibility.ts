import * as THREE from 'three';
import type { B3d } from '../engine/formats/b3d';

/**
 * Видимість кімнат через портали (план G3 «Не малювати невидиме»). Як в оригіналі: king.exe малює світ лише від
 * кімнати камери крізь портали, звужуючи піраміду огляду многокутником порталу (re/notes/ht2/rendering.md); порт —
 * прямокутником на екрані й без відсікання обʼєктів кімнати звуженою пірамідою.
 *
 * Регіон HT2 поділено на кімнати (блок 19, 100…300 м — відрізки доріг з місцевістю довкола), зʼєднані порталами
 * (блок 30: вертикальний прямокутник між кутами p1 і p2 — поперек дороги, 50…80 × 100 м, у містах ab/da — 8 м
 * заввишки). Портал до кімнати сусіднього регіону названо `<рег>:<кімната>`. Щокадру: кімнати камери (за сіткою
 * слідів трикутників кімнат на плані), далі обхід порталів — портал видно, якщо його прямокутник на екрані перетинає
 * поточний (спершу весь екран), і за ним — кімнату, з обрізаним прямокутником. Решту кімнат сховано (разом з їхніми
 * деревами й ореолами — `userData.room`). Камера поза всіма кімнатами — малюємо все.
 *
 * Обмеження: кімната видима вся, а не лише крізь портал; що в межах однієї кімнати (пагорб і дорога за ним) —
 * портали не ховають. Те, що видно над сусідніми кімнатами, але не крізь портали, не малює й оригінал.
 */

export interface RoomPortal {
  /** Кімната за порталом (мале письмо, без префікса регіону). */
  to: string;
  /** Кути в Three.js: p1, (p2 по горизонталі, z p1), p2, (p1 по горизонталі, z p2). */
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

/** Портали кімнат регіону з B3D: імʼя кімнати (мале письмо) → портали. */
export function readPortals(b3d: B3d): Map<string, RoomPortal[]> {
  const out = new Map<string, RoomPortal[]>();
  const walk = (blocks: B3d['blocks'], room: string) => {
    for (const b of blocks) {
      const d = b.data;
      if (d.t === 30) {
        const [x1, y1, z1] = d.p1;
        const [x2, y2, z2] = d.p2;
        // Горизонтальний портал (p1 і p2 на одній висоті) — прямокутник у площині xy; у даних HT2 не трапляється.
        const flat = Math.abs(z2 - z1) < 0.5;
        const g = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
        const corners: RoomPortal['corners'] = flat
          ? [g(x1, y1, z1), g(x2, y1, z1), g(x2, y2, z1), g(x1, y2, z1)]
          : [g(x1, y1, z1), g(x2, y2, z1), g(x2, y2, z2), g(x1, y1, z2)];
        const to = d.room.toLowerCase().replace(/^[a-z0-9]+:/, '');
        (out.get(room) ?? out.set(room, []).get(room)!).push({ to, corners });
      }
      if (b.groups) for (const grp of b.groups) walk(grp, room);
    }
  };
  for (const top of b3d.blocks) if (top.data.t === 19) walk([top], top.name.toLowerCase());
  return out;
}

/** Клітинка сітки слідів кімнат на плані, м. */
const CELL = 8;
const cellKey = (ix: number, iy: number): number => (ix + 32768) * 65536 + (iy + 32768);

/**
 * Сліди кімнат на плані: клітинка CELL × CELL → кімнати, чиї трикутники (за обмежувальним прямокутником) її
 * зачіпають. Біля межі кімнат клітинка належить обом — тоді обидві кімнати стартові (зайве малювання, але не дірка).
 * Будується частинами (pause — віддати кадр, як і решта завантаження регіону).
 */
export async function roomFootprints(rooms: THREE.Object3D[], root: THREE.Object3D, pause: () => Promise<void>): Promise<Map<number, string[]>> {
  const cells = new Map<number, string[]>();
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let work = 0;
  for (const room of rooms) {
    const name = room.name.toLowerCase();
    const meshes: THREE.Mesh[] = [];
    room.traverse((o) => {
      if (o instanceof THREE.Mesh && !(o instanceof THREE.InstancedMesh)) meshes.push(o);
    });
    for (const mesh of meshes) {
      // Система root — координати гри (x, y — план, z — угору).
      m.multiplyMatrices(toRoot, mesh.matrixWorld);
      const pos = mesh.geometry.getAttribute('position');
      const idx = mesh.geometry.getIndex();
      const n = idx ? idx.count : pos.count;
      for (let i = 0; i + 2 < n; i += 3) {
        a.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(m);
        b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1).applyMatrix4(m);
        c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2).applyMatrix4(m);
        const x0 = Math.floor(Math.min(a.x, b.x, c.x) / CELL);
        const x1 = Math.floor(Math.max(a.x, b.x, c.x) / CELL);
        const y0 = Math.floor(Math.min(a.y, b.y, c.y) / CELL);
        const y1 = Math.floor(Math.max(a.y, b.y, c.y) / CELL);
        for (let ix = x0; ix <= x1; ix++)
          for (let iy = y0; iy <= y1; iy++) {
            const k = cellKey(ix, iy);
            const list = cells.get(k);
            if (!list) cells.set(k, [name]);
            else if (list[list.length - 1] !== name && !list.includes(name)) list.push(name);
          }
        work += (x1 - x0 + 1) * (y1 - y0 + 1) + 4;
        if (work > 60000) {
          work = 0;
          await pause();
        }
      }
    }
  }
  return cells;
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface RoomEntry {
  group: THREE.Object3D;
  portals: RoomPortal[];
  /** Дерева, ореоли й рельєф кімнати поза її групою (userData.room). */
  members: THREE.Object3D[];
}

/**
 * Камера ближче до прямокутника порталу (м) — кімната за ним видима (увесь поточний прямокутник): камера ззаду
 * (12 м за машиною) буває вже за межею кімнат, а слід кімнати ще не той; дерева сусідньої кімнати біля межі.
 */
const NEAR_PORTAL = 15;
/** Обмеження обходу за кадр. */
const MAX_STEPS = 3000;

export class RoomVisibility {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly footprints = new Map<string, Map<number, string[]>>();
  /** Кімнати регіону (для вивантаження). */
  private readonly byRegion = new Map<string, string[]>();
  /** Видимі в останньому update кімнати; null — показано все. */
  visible: Set<string> | null = null;
  /** Вимкнути (налагодження): усе видно. */
  enabled = true;
  /** Портал ближче за near м — пропускає весь поточний прямокутник. */
  near = NEAR_PORTAL;
  /** Запас довкола екранного прямокутника порталу (частка NDC). */
  margin = 0;

  private readonly vp = new THREE.Matrix4();
  private readonly clipped: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());
  private readonly tmp: THREE.Vector4[] = Array.from({ length: 8 }, () => new THREE.Vector4());
  private readonly reached = new Map<string, Rect>();

  addRegion(id: string, rooms: THREE.Object3D[], portals: Map<string, RoomPortal[]>, footprint: Map<number, string[]>, root: THREE.Object3D): void {
    const names: string[] = [];
    for (const g of rooms) {
      const name = g.name.toLowerCase();
      names.push(name);
      this.rooms.set(name, { group: g, portals: portals.get(name) ?? [], members: [] });
    }
    root.traverse((o) => {
      const r = o.userData.room as string | undefined;
      if (r) this.rooms.get(r.toLowerCase())?.members.push(o);
    });
    this.byRegion.set(id, names);
    this.footprints.set(id, footprint);
  }

  removeRegion(id: string): void {
    for (const n of this.byRegion.get(id) ?? []) this.rooms.delete(n);
    this.byRegion.delete(id);
    this.footprints.delete(id);
  }

  /** Кімнати, у сліді яких точка гри (x, y). */
  roomsAt(x: number, y: number): string[] {
    const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    const out: string[] = [];
    for (const f of this.footprints.values()) for (const n of f.get(k) ?? []) if (!out.includes(n)) out.push(n);
    return out;
  }

  private setAll(on: boolean, except?: Set<string>): void {
    for (const [name, r] of this.rooms) {
      const v = except ? except.has(name) : on;
      if (r.group.visible !== v) r.group.visible = v;
      for (const o of r.members) if (o.visible !== v) o.visible = v;
    }
  }

  update(camera: THREE.PerspectiveCamera): void {
    const cam = camera.position;
    const start = this.enabled ? this.roomsAt(cam.x, -cam.z).filter((n) => this.rooms.has(n)) : [];
    if (!start.length) {
      this.visible = null;
      return this.setAll(true);
    }
    camera.updateMatrixWorld();
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const reached = this.reached;
    reached.clear();
    const queue: [string, Rect][] = [];
    for (const n of start) {
      const full = { x0: -1, y0: -1, x1: 1, y1: 1 };
      reached.set(n, full);
      queue.push([n, full]);
    }
    let steps = 0;
    for (let qi = 0; qi < queue.length && steps < MAX_STEPS; qi++) {
      const [room, rect] = queue[qi];
      for (const p of this.rooms.get(room)?.portals ?? []) {
        steps++;
        if (!this.rooms.has(p.to)) continue;
        const d = portalDistance(p, cam);
        if (d > camera.far) continue;
        const sub = d < this.near ? { ...rect } : this.portalRect(p, rect, camera.near);
        if (!sub) continue;
        const had = reached.get(p.to);
        if (had && had.x0 <= sub.x0 && had.y0 <= sub.y0 && had.x1 >= sub.x1 && had.y1 >= sub.y1) continue;
        // Кімнату вже досягнуто меншим прямокутником — іти далі з обʼєднаним (з запасом, зате без повторів).
        const r = had ? { x0: Math.min(had.x0, sub.x0), y0: Math.min(had.y0, sub.y0), x1: Math.max(had.x1, sub.x1), y1: Math.max(had.y1, sub.y1) } : sub;
        reached.set(p.to, r);
        queue.push([p.to, r]);
      }
    }
    const vis = new Set(reached.keys());
    this.visible = vis;
    this.setAll(false, vis);
  }

  /** Прямокутник порталу на екрані (NDC), обрізаний поточним; null — портал не видно. */
  private portalRect(p: RoomPortal, clip: Rect, near: number): Rect | null {
    // Кути — у простір відсікання; многокутник обрізаємо площиною w = near (перед камерою), далі — у NDC.
    let n = 0;
    for (const c of p.corners) {
      this.tmp[n++].set(c.x, c.y, c.z, 1).applyMatrix4(this.vp);
    }
    const minW = Math.max(near, 1e-3);
    let m = 0;
    for (let i = 0; i < n; i++) {
      const a = this.tmp[i];
      const b = this.tmp[(i + 1) % n];
      const ina = a.w >= minW;
      const inb = b.w >= minW;
      if (ina) this.clipped[m++].copy(a);
      if (ina !== inb) {
        const t = (minW - a.w) / (b.w - a.w);
        this.clipped[m++].copy(a).lerp(b, t);
      }
    }
    if (!m) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < m; i++) {
      const q = this.clipped[i];
      const x = q.x / q.w;
      const y = q.y / q.w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const e = this.margin;
    const r = { x0: Math.max(x0 - e, clip.x0), y0: Math.max(y0 - e, clip.y0), x1: Math.min(x1 + e, clip.x1), y1: Math.min(y1 + e, clip.y1) };
    return r.x0 < r.x1 && r.y0 < r.y1 ? r : null;
  }
}

const U = new THREE.Vector3();
const V = new THREE.Vector3();
const D = new THREE.Vector3();

/** Відстань від точки до прямокутника порталу (кути 0, 1, 3 задають сторони). */
export function portalDistance(p: RoomPortal, q: THREE.Vector3): number {
  const [c0, c1, , c3] = p.corners;
  U.subVectors(c1, c0);
  V.subVectors(c3, c0);
  D.subVectors(q, c0);
  const lu = U.lengthSq();
  const lv = V.lengthSq();
  const su = lu > 0 ? THREE.MathUtils.clamp(D.dot(U) / lu, 0, 1) : 0;
  const sv = lv > 0 ? THREE.MathUtils.clamp(D.dot(V) / lv, 0, 1) : 0;
  return D.sub(U.multiplyScalar(su)).sub(V.multiplyScalar(sv)).length();
}
