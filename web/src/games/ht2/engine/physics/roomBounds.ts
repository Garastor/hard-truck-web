import RAPIER from '@dimforge/rapier3d-compat';
import { addCollisionPolys } from './world';
import type { Poly } from './collision';

/** Як часто (у кроках фізики) заново шукати кімнату тіла. */
const RECHECK_STEPS = 10;
/** Підлога кімнати тіла — найвища під центром, не вище центру + RISE і не нижче центру − DROP, м. */
const RISE = 1.5;
const DROP = 60;
/** Поточна кімната лишається, поки її підлога під центром тіла не нижче за KEEP, м. */
const KEEP = 4;

interface Room {
  /** Підлога кімнати (система гри). */
  floors: Poly[];
  /** Охоплюючий прямокутник підлоги на плані: x0, y0, x1, y1. */
  box: [number, number, number, number];
}

/** Колайдер кімнати: її ключ, імʼя (без регіону) і чи це підлога. */
interface Owned {
  key: string;
  name: string;
  floor: boolean;
}

/**
 * Колізії кімнат лише для машин у цій кімнаті. King.exe перевіряє зіткнення корпусу лише з колізіями кімнати, у якій
 * машина (обʼєкт-батько тіла; сусідня — лише якщо відрізок руху кроку перетинає портал; 0x5855a0, 0x4e6059) —
 * re/notes/ht2/physics.md «Колізії кімнат». Порт тримав колайдери всіх кімнат завантажених регіонів разом, і стіни
 * однієї кімнати, що перетинають дорогу сусідньої (межа-огорожа кільця dr_000 на дорозі dr_099, межі ar_046…049),
 * ставали невидимими стінами посеред дороги; так само підлога — схил ґрунту av_050 піднімається на 2 м над дорогою
 * aw_001 (−2470, −1590 у Three.js) і зупиняв машину. Тут стіни й підлога кожної кімнати — окремі колайдери з фільтром
 * пар контакту: тіло стикається зі стінами, лише коли його кімната — ця, а з підлогою — ще й сусідніх через портал
 * (наближення «кімнати за порталом» king.exe: на переході колеса вже над підлогою сусідньої кімнати). Промені коліс
 * фільтрує `groundFilter` за тим самим правилом. Кімната тіла — поточна, поки її підлога (`hit_road`) під центром,
 * інакше — найвища підлога під центром; без підлоги під собою (стрибок, вихід за межі) тіло лишається в останній
 * знайденій кімнаті, як в оригіналі (кімната змінюється лише переходом).
 *
 * Хуки Rapier 0.20 діють лише в кроці з чергою подій — крок світу робити через `step()`.
 */
export class RoomBounds {
  private static readonly byWorld = new WeakMap<RAPIER.World, RoomBounds>();

  /** Фільтр променів коліс тіла (`undefined` — у світі немає кімнат). */
  static groundFilter(world: RAPIER.World, body: RAPIER.RigidBody): ((c: RAPIER.Collider) => boolean) | undefined {
    const rb = RoomBounds.byWorld.get(world);
    if (!rb) return undefined;
    const handle = body.handle;
    return (c) => rb.sees(handle, c.handle);
  }

  /** Кімнати з підлогою: `<регіон>/<кімната>`. */
  private readonly rooms = new Map<string, Room>();
  /** Колайдер стін чи підлоги кімнати → кімната. */
  private readonly owned = new Map<number, Owned>();
  /** Сусіди кімнати через портали (імена без регіону, мале письмо; в обидва боки, з самою кімнатою). */
  private readonly near = new Map<string, Set<string>>();
  /** Тіло → [крок пошуку, кімната]. */
  private readonly bodies = new Map<number, [number, string | null]>();
  private readonly events = new RAPIER.EventQueue(false);
  private steps = 0;

  constructor(private readonly world: RAPIER.World) {
    RoomBounds.byWorld.set(world, this);
  }

  /** Підлога кімнати (для пошуку кімнати тіла). */
  addFloors(region: string, room: string, floors: Poly[]): void {
    const box: Room['box'] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of floors)
      for (const q of p) {
        box[0] = Math.min(box[0], q[0]);
        box[1] = Math.min(box[1], q[1]);
        box[2] = Math.max(box[2], q[0]);
        box[3] = Math.max(box[3], q[1]);
      }
    if (floors.length) this.rooms.set(`${region}/${room.toLowerCase()}`, { floors, box });
  }

  /**
   * Колайдер підлоги кімнати: діє лише на тіла в цій кімнаті та в сусідніх через портал. Кімната без `addFloors` —
   * звичайний колайдер.
   */
  addFloorCollider(region: string, room: string, floors: Poly[], surfaces: readonly number[]): RAPIER.Collider | null {
    const c = addCollisionPolys(this.world, floors, 1.0, surfaces);
    const key = `${region}/${room.toLowerCase()}`;
    if (c && this.rooms.has(key)) this.own(c, key, true);
    return c;
  }

  /**
   * Стіни кімнати — колайдер, що діє лише на тіла в цій кімнаті. Кімната без підлоги (`hit_road` немає) — звичайний
   * колайдер: у неї тіло не «потрапить».
   */
  addWalls(region: string, room: string, walls: Poly[]): RAPIER.Collider | null {
    const c = addCollisionPolys(this.world, walls, 0.4);
    const key = `${region}/${room.toLowerCase()}`;
    if (c && this.rooms.has(key)) this.own(c, key, false);
    return c;
  }

  /** Портали кімнати: імена кімнат за ними (сусідство — в обидва боки). */
  addPortals(room: string, to: readonly string[]): void {
    const a = room.toLowerCase();
    for (const t of to) {
      const b = t.toLowerCase();
      for (const [x, y] of [[a, b], [b, a]]) (this.near.get(x) ?? this.near.set(x, new Set([x])).get(x)!).add(y);
    }
  }

  /** Забути регіон (його колайдери прибирає власник). */
  removeRegion(region: string, colliders: readonly RAPIER.Collider[]): void {
    for (const c of colliders) this.owned.delete(c.handle);
    for (const k of [...this.rooms.keys()]) if (k.startsWith(`${region}/`)) this.rooms.delete(k);
  }

  /**
   * Крок світу з фільтром пар контакту. Кімнати тіл — до кроку: під час кроку хук не може звертатися до тіл
   * (WASM-світ зайнятий — виняток, і пару контакту Rapier відкидає).
   */
  step(): void {
    this.steps++;
    if (this.owned.size) this.world.forEachRigidBody((b) => void (b.isFixed() || this.roomOf(b)));
    this.world.step(this.events, this.hooks);
  }

  /** Кімната тіла (`<регіон>/<кімната>`) або null — ще не знайдено (налагодження). */
  roomOf(body: RAPIER.RigidBody): string | null {
    const known = this.bodies.get(body.handle);
    if (known && this.steps - known[0] < RECHECK_STEPS) return known[1];
    const t = body.translation();
    // Кімната змінюється лише виходом з-під її підлоги (в оригіналі — переходом через портал): де підлоги кімнат
    // перекриваються (дорога dr_099 заходить на кільце dr_000), машина лишається в тій, з якої приїхала.
    const cur = known?.[1] ? this.rooms.get(known[1]) : undefined;
    const fz = cur ? floorUnder(cur.floors, t.x, -t.z, t.y + RISE) : null;
    const stay = fz !== null && t.y - fz < KEEP;
    const room = stay ? known![1] : (this.roomAt(t.x, -t.z, t.y) ?? known?.[1] ?? null);
    if (this.bodies.size > 2048) this.bodies.clear();
    this.bodies.set(body.handle, [this.steps, room]);
    return room;
  }

  /** Кімната найвищої підлоги під точкою (система гри) не вище z + RISE. */
  roomAt(x: number, y: number, z: number): string | null {
    let best: string | null = null;
    let bestZ = z - DROP;
    for (const [key, room] of this.rooms) {
      const [x0, y0, x1, y1] = room.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      const fz = floorUnder(room.floors, x, y, z + RISE);
      if (fz !== null && fz > bestZ) {
        bestZ = fz;
        best = key;
      }
    }
    return best;
  }

  private own(c: RAPIER.Collider, key: string, floor: boolean): void {
    c.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
    this.owned.set(c.handle, { key, name: key.slice(key.indexOf('/') + 1), floor });
  }

  /** Чи діє колайдер на тіло: чужі колайдери й тіла, чию кімнату ще не знайдено, — так. */
  private sees(body: number, collider: number): boolean {
    const o = this.owned.get(collider);
    if (!o) return true;
    const at = this.bodies.get(body)?.[1] ?? null;
    // Кімнату ще не знайдено (тіло над місцем без підлоги від самого початку) — колізії діють, як раніше.
    if (at === null || at === o.key) return true;
    if (!o.floor) return false;
    return this.near.get(at.slice(at.indexOf('/') + 1))?.has(o.name) ?? false;
  }

  private readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2, b1, b2) => {
      const [collider, body] = this.owned.has(c1) ? [c1, b2] : [c2, b1];
      if (body === null || body === undefined) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      return this.sees(body, collider) ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null;
    },
    filterIntersectionPair: () => true,
  };
}

/** Найвища висота підлоги під (x, y) не вище top; null — немає. */
function floorUnder(floors: Poly[], x: number, y: number, top: number): number | null {
  let best: number | null = null;
  for (const p of floors)
    for (let k = 1; k + 1 < p.length; k++) {
      const a = p[0];
      const b = p[k];
      const c = p[k + 1];
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-9) continue;
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / det;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / det;
      const w = 1 - u - v;
      if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
      const fz = u * a[2] + v * b[2] + w * c[2];
      if (fz <= top && (best === null || fz > best)) best = fz;
    }
  return best;
}
