import * as THREE from 'three';
import type { B3d } from '../engine/formats/b3d';

/**
 * Видимість кімнат через портали (план G3 «Не малювати невидиме») — як у king.exe (re/notes/ht2/rendering.md): світ
 * малюється лише від кімнати камери крізь портали.
 *
 * Регіон HT2 поділено на кімнати (блок 19, 100…300 м — відрізки доріг з місцевістю довкола), зʼєднані порталами
 * (блок 30: вертикальний прямокутник між кутами p1 і p2 — поперек дороги, 50…80 × 100 м, у тунелях ab/da — 8 м
 * заввишки). Портал до кімнати сусіднього регіону названо `<рег>:<кімната>`.
 *
 * Щокадру для кожної камери (основної й дзеркала):
 * - кімната камери — переходом через портали (king.exe 0x5fb9e0: обʼєкт, що перетнув площину порталу в його прорізі,
 *   переходить у кімнату-ціль); на старті й коли камера опинилася поза слідом своєї кімнати (телепорт) — за сіткою
 *   слідів кімнат на плані (біля межі кімнат клітинка належить обом — тоді стартові обидві);
 * - портал кімнати видно (0x5fb820), якщо камера з лицьового боку його площини і його многокутник, обрізаний
 *   поточною пірамідою огляду, не порожній; за ним — кімната-ціль з пірамідою, звуженою цим многокутником (площини
 *   через камеру й краї; 0x5b5710);
 * - решту кімнат сховано, а у видимих — і вміст (злиті меші, дерева, ореоли, рельєф aa), що не потрапляє в жодну з
 *   пірамід, крізь які кімнату видно.
 * Камера поза всіма кімнатами — малюємо все.
 *
 * Рухомі обʼєкти (машини трафіку, далекобійники, міліція, мафія, гелікоптери — `markMover`) теж належать кімнатам, як
 * обʼєкти типу 0x11 у king.exe: їх малює кімната, у якій вони стоять, а обʼєкт, що перетинає площину порталу,
 * отримує копію в кімнаті-цілі (0x5fb9e0). Тож обʼєкт видно, лише якщо його сфера потрапляє в піраміду, крізь яку
 * видно його кімнату (кімнати — за слідом на плані; біля межі клітинка належить обом — як копія на порталі). Без
 * цього машину за пагорбом чи будинком, повернутим до камери зворотним (однобічним, непомальованим) боком, було
 * видно крізь нього.
 *
 * Те, що видно над сусідніми кімнатами, але не крізь портали (вулиця на пагорбі за селом aj), оригінал теж не малює.
 */

export interface RoomPortal {
  /** Кімната за порталом (мале письмо, без префікса регіону). */
  to: string;
  /** Кути в Three.js: p1, (p2 по горизонталі, z p1), p2, (p1 по горизонталі, z p2). */
  corners: [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Vector3];
  /**
   * Нормаль площини порталу — у бік кімнати-цілі (у площині гри (−Δy, Δx) від p1 до p2: так у всіх 2112 порталах,
   * де бік визначено за центрами кімнат); null — горизонтальний портал (у даних HT2 немає).
   */
  normal: THREE.Vector3 | null;
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
        const flat = Math.abs(z2 - z1) < 0.5;
        const g = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y);
        const corners: RoomPortal['corners'] = flat
          ? [g(x1, y1, z1), g(x2, y1, z1), g(x2, y2, z1), g(x1, y2, z1)]
          : [g(x1, y1, z1), g(x2, y2, z1), g(x2, y2, z2), g(x1, y1, z2)];
        // (−Δy, Δx) гри → Three.js (x, 0, −y).
        const normal = flat ? null : new THREE.Vector3(-(y2 - y1), 0, -(x2 - x1)).normalize();
        const to = d.room.toLowerCase().replace(/^[a-z0-9]+:/, '');
        (out.get(room) ?? out.set(room, []).get(room)!).push({ to, corners, normal });
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

/** Кімната в клітинці сліду й висоти її трикутників над цією клітинкою (z гри, за обмежувальними коробками). */
export interface FootCell {
  room: string;
  z0: number;
  z1: number;
}

/** Сліди кімнат: клітинка плану → кімнати з висотами. */
export type Footprint = Map<number, FootCell[]>;

/**
 * Запас висоти, з яким рухомий обʼєкт належить кімнаті клітинки: нижче її трикутників — до BELOW, вище — до ABOVE м
 * (позиція обʼєкта — низ моделі; гелікоптер, що летить вище, — у найближчій за висотою кімнаті).
 */
const MOVER_BELOW = 3;
const MOVER_ABOVE = 8;

/**
 * Сліди кімнат на плані: клітинка CELL × CELL → кімнати, чиї трикутники (за обмежувальним прямокутником) її
 * зачіпають, з діапазоном висот цих трикутників. Будується частинами (pause — віддати кадр, як і решта завантаження
 * регіону).
 */
export async function roomFootprints(rooms: THREE.Object3D[], root: THREE.Object3D, pause: () => Promise<void>): Promise<Footprint> {
  const cells: Footprint = new Map();
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
        const z0 = Math.min(a.z, b.z, c.z);
        const z1 = Math.max(a.z, b.z, c.z);
        for (let ix = x0; ix <= x1; ix++)
          for (let iy = y0; iy <= y1; iy++) {
            const k = cellKey(ix, iy);
            const list = cells.get(k);
            if (!list) cells.set(k, [{ room: name, z0, z1 }]);
            else {
              const e = list[list.length - 1].room === name ? list[list.length - 1] : list.find((f) => f.room === name);
              if (!e) list.push({ room: name, z0, z1 });
              else {
                if (z0 < e.z0) e.z0 = z0;
                if (z1 > e.z1) e.z1 = z1;
              }
            }
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

/** Обʼєкт кімнати, що відсікається пірамідами порталів: сфера у світі (обʼєкти нерухомі). */
interface Cullable {
  obj: THREE.Object3D;
  sphere: THREE.Sphere;
}

interface RoomEntry {
  group: THREE.Object3D;
  portals: RoomPortal[];
  /** Злиті меші кімнати, її дерева, ореоли й рельєф (userData.room). */
  parts: Cullable[];
}

/** Піраміда огляду — площини (нормалі всередину). */
type Planes = THREE.Plane[];

/** Запас прорізу порталу для переходу камери між кімнатами, м (king.exe 0x5fb7d0 — теж із запасом). */
const CROSS_MARGIN = 1;
/** Обмеження обходу за кадр: глибина ланцюжка, пірамід на кімнату, переходів. */
const MAX_DEPTH = 32;
const MAX_FRUSTA = 8;
const MAX_STEPS = 3000;

export class RoomVisibility {
  private readonly rooms = new Map<string, RoomEntry>();
  private readonly footprints = new Map<string, Footprint>();
  /** Кімнати регіону (для вивантаження). */
  private readonly byRegion = new Map<string, string[]>();
  /** Кімнати кожної камери з минулого кадру й де вона була. */
  private readonly trackers = new WeakMap<THREE.Camera, { rooms: string[]; prev: THREE.Vector3 }>();
  /** Видимі в останньому update кімнати; null — показано все. */
  visible: Set<string> | null = null;
  /** Вимкнути (налагодження): усе видно. */
  enabled = true;

  /**
   * Сцена, діти якої з `userData.mover` (радіус сфери навколо `position`, м — `markMover`) — рухомі обʼєкти, видимі
   * лише з кімнатою, у якій стоять.
   */
  movers: THREE.Object3D | null = null;
  private readonly frustum = new THREE.Frustum();
  private readonly vp = new THREE.Matrix4();
  private readonly reached = new Map<string, Planes[]>();

  addRegion(id: string, rooms: THREE.Object3D[], portals: Map<string, RoomPortal[]>, footprint: Footprint, root: THREE.Object3D): void {
    root.updateMatrixWorld(true);
    const names: string[] = [];
    for (const g of rooms) {
      const name = g.name.toLowerCase();
      names.push(name);
      const parts: Cullable[] = [];
      // Злиті меші (mergeStatic) — прямі діти кімнати; решту (перемикачі, спрайти, окремі меші) не чіпаємо.
      for (const c of g.children) if (c instanceof THREE.Mesh && c.name.startsWith('merged:')) parts.push(cullable(c));
      this.rooms.set(name, { group: g, portals: portals.get(name) ?? [], parts });
    }
    root.traverse((o) => {
      const r = o.userData.room as string | undefined;
      if (r) this.rooms.get(r.toLowerCase())?.parts.push(cullable(o));
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
    for (const f of this.footprints.values()) for (const e of f.get(k) ?? []) if (!out.includes(e.room)) out.push(e.room);
    return out;
  }

  /**
   * Кімнати рухомого обʼєкта в точці гри (x, y, z): зі сліду — лише ті, чиї трикутники над клітинкою сягають його
   * висоти (MOVER_BELOW/ABOVE). Кімнати на плані перекриваються по висоті (плато над урвищем ak над схилом і річкою):
   * без висоти машину на плато малювала видима нижня кімната — крізь незамальоване плато («рентген»). Жодна не
   * сягає — найближча за висотою.
   */
  moverRoomsAt(x: number, y: number, z: number): string[] {
    const k = cellKey(Math.floor(x / CELL), Math.floor(y / CELL));
    const out: string[] = [];
    let near: string | null = null;
    let nearD = Infinity;
    for (const f of this.footprints.values())
      for (const e of f.get(k) ?? []) {
        const d = z < e.z0 ? e.z0 - z : z > e.z1 ? z - e.z1 : 0;
        if ((z >= e.z0 - MOVER_BELOW && z <= e.z1 + MOVER_ABOVE) || d === 0) {
          if (!out.includes(e.room)) out.push(e.room);
        } else if (d < nearD) {
          nearD = d;
          near = e.room;
        }
      }
    return out.length || !near ? out : [near];
  }

  /** Кімнати камери: перехід через портал своєї кімнати; поза слідом своєї кімнати чи вперше — за слідами. */
  private follow(camera: THREE.Camera): string[] {
    const pos = camera.position;
    const here = this.roomsAt(pos.x, -pos.z).filter((n) => this.rooms.has(n));
    let t = this.trackers.get(camera);
    if (!t) this.trackers.set(camera, (t = { rooms: [], prev: pos.clone() }));
    let rooms = t.rooms.filter((n) => this.rooms.has(n));
    if (rooms.length) {
      cross: for (const n of rooms)
        for (const p of this.rooms.get(n)!.portals)
          if (this.rooms.has(p.to) && crosses(p, t.prev, pos)) {
            rooms = [p.to];
            break cross;
          }
      // Телепорт чи збій: камера не в сліді жодної зі своїх кімнат — заново за слідами.
      if (here.length && !rooms.some((n) => here.includes(n))) rooms = here;
    } else rooms = here;
    t.rooms = rooms;
    t.prev.copy(pos);
    return rooms;
  }

  update(camera: THREE.PerspectiveCamera): void {
    const start = this.enabled ? this.follow(camera) : [];
    if (!start.length) {
      this.visible = null;
      for (const r of this.rooms.values()) show(r, null);
      this.showMovers(null);
      return;
    }
    camera.updateMatrixWorld();
    this.vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.vp);
    // Бічні площини й дальня (0…4); ближня не потрібна — бічні площини сходяться в камері, позаду неї нічого.
    const far = this.frustum.planes[4];
    const base = this.frustum.planes.slice(0, 5);
    const cam = camera.position;
    const reached = this.reached;
    reached.clear();
    const queue: [string, Planes, number][] = [];
    for (const n of start) {
      reached.set(n, [base]);
      queue.push([n, base, 0]);
    }
    let steps = 0;
    for (let qi = 0; qi < queue.length && steps < MAX_STEPS; qi++) {
      const [room, planes, depth] = queue[qi];
      if (depth >= MAX_DEPTH) continue;
      for (const p of this.rooms.get(room)?.portals ?? []) {
        steps++;
        if (!this.rooms.has(p.to)) continue;
        // Камера з лицьового боку площини порталу (нормаль — у бік цілі).
        if (p.normal && D.subVectors(p.corners[0], cam).dot(p.normal) <= 0) continue;
        const poly = clipPolygon(p.corners, planes);
        if (poly.length < 3) continue;
        const sub = portalFrustum(cam, poly, far);
        const list = reached.get(p.to);
        if (list && list.length >= MAX_FRUSTA) continue;
        if (list) list.push(sub);
        else reached.set(p.to, [sub]);
        queue.push([p.to, sub, depth + 1]);
      }
    }
    this.visible = new Set(reached.keys());
    for (const [name, r] of this.rooms) show(r, reached.get(name) ?? []);
    this.showMovers(reached);
  }

  /** Рухомі обʼєкти: видно, якщо сфера в піраміді будь-якої з кімнат під ним; поза слідами кімнат — видно. */
  private showMovers(reached: Map<string, Planes[]> | null): void {
    for (const o of this.movers?.children ?? []) {
      const radius = o.userData.mover as number | undefined;
      if (radius === undefined) continue;
      let v = true;
      if (reached) {
        const p = o.position;
        const rooms = this.moverRoomsAt(p.x, -p.z, p.y);
        if (rooms.length) {
          S.center.copy(p);
          S.radius = radius;
          v = rooms.some((n) => reached.get(n)?.some((f) => sphereIn(S, f)) ?? false);
        }
      }
      if (o.visible !== v) o.visible = v;
    }
  }
}

const S = new THREE.Sphere();

/**
 * Позначити рухомий обʼєкт (дитину сцени світу): малюється лише з кімнатою, у якій стоїть (RoomVisibility.movers).
 * Радіус — півдіагональ видимої коробки з запасом (центр коробки не збігається з `position` — низом моделі).
 */
export function markMover(obj: THREE.Object3D, size?: THREE.Vector3): void {
  size ??= new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
  obj.userData.mover = size.length() / 2 + 2;
}

/** Показати кімнату (frusta — піраміди, крізь які її видно; null — усю, як без порталів; [] — сховати). */
function show(r: RoomEntry, frusta: Planes[] | null): void {
  const on = frusta === null || frusta.length > 0;
  if (r.group.visible !== on) r.group.visible = on;
  for (const c of r.parts) {
    const v = on && (frusta === null || frusta.some((f) => sphereIn(c.sphere, f)));
    if (c.obj.visible !== v) c.obj.visible = v;
  }
}

function sphereIn(s: THREE.Sphere, planes: Planes): boolean {
  for (const p of planes) if (p.distanceToPoint(s.center) < -s.radius) return false;
  return true;
}

/** Сфера обʼєкта у світі: меш (з інстансами — їхня сфера), спрайт — за позицією й розміром. */
function cullable(o: THREE.Object3D): Cullable {
  const sphere = new THREE.Sphere();
  if (o instanceof THREE.InstancedMesh) {
    if (!o.boundingSphere) o.computeBoundingSphere();
    sphere.copy(o.boundingSphere!).applyMatrix4(o.matrixWorld);
  } else if (o instanceof THREE.Mesh) {
    if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
    sphere.copy(o.geometry.boundingSphere!).applyMatrix4(o.matrixWorld);
  } else {
    o.getWorldPosition(sphere.center);
    const s = new THREE.Vector3();
    o.getWorldScale(s);
    sphere.radius = Math.max(s.x, s.y, s.z, 1);
  }
  return { obj: o, sphere };
}

const D = new THREE.Vector3();
const A = new THREE.Vector3();
const B = new THREE.Vector3();

/** Многокутник, обрізаний площинами (лишається частина з додатного боку кожної). */
function clipPolygon(src: readonly THREE.Vector3[], planes: Planes): THREE.Vector3[] {
  let poly = src.map((v) => v.clone());
  for (const pl of planes) {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      const da = pl.distanceToPoint(a);
      const db = pl.distanceToPoint(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) out.push(a.clone().lerp(b, da / (da - db)));
    }
    poly = out;
    if (poly.length < 3) return poly;
  }
  return poly;
}

/** Піраміда від камери крізь опуклий многокутник: площини через камеру й кожен край, плюс дальня. */
function portalFrustum(cam: THREE.Vector3, poly: THREE.Vector3[], far: THREE.Plane): Planes {
  const c = new THREE.Vector3();
  for (const v of poly) c.add(v);
  c.divideScalar(poly.length);
  const planes: Planes = [far];
  for (let i = 0; i < poly.length; i++) {
    A.subVectors(poly[i], cam);
    B.subVectors(poly[(i + 1) % poly.length], cam);
    const n = new THREE.Vector3().crossVectors(A, B);
    if (n.lengthSq() < 1e-10) continue;
    n.normalize();
    const pl = new THREE.Plane().setFromNormalAndCoplanarPoint(n, cam);
    if (pl.distanceToPoint(c) < 0) pl.negate();
    planes.push(pl);
  }
  return planes;
}

/** Відрізок a → b перетинає площину порталу з боку джерела в бік цілі в межах прорізу (з запасом). */
function crosses(p: RoomPortal, a: THREE.Vector3, b: THREE.Vector3): boolean {
  if (!p.normal) return false;
  const o = p.corners[0];
  const da = D.subVectors(a, o).dot(p.normal);
  const db = D.subVectors(b, o).dot(p.normal);
  if (!(da < 0 && db >= 0)) return false;
  const q = A.copy(a).lerp(b, da / (da - db));
  // Проріз: уздовж порталу (кут 0 → 1) і по висоті (кут 0 → 3).
  B.subVectors(p.corners[1], o);
  const len = B.length();
  const along = D.subVectors(q, o).dot(B) / (len || 1);
  const y0 = Math.min(o.y, p.corners[3].y);
  const y1 = Math.max(o.y, p.corners[3].y);
  return along > -CROSS_MARGIN && along < len + CROSS_MARGIN && q.y > y0 - CROSS_MARGIN && q.y < y1 + CROSS_MARGIN;
}
