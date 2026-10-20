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

/**
 * Стіни кімнат лише для машин у цій кімнаті. King.exe перевіряє зіткнення корпусу лише з колізіями кімнати, у якій
 * машина (обʼєкт-батько тіла; сусідня — лише якщо відрізок руху кроку перетинає портал; 0x5855a0, 0x4e6059) —
 * re/notes/ht2/physics.md «Колізії кімнат». Порт тримав колайдери всіх кімнат завантажених регіонів разом, і стіни
 * однієї кімнати, що перетинають дорогу сусідньої (межа-огорожа кільця dr_000 на дорозі dr_099, межі ar_046…049),
 * ставали невидимими стінами посеред дороги. Тут стіни кожної кімнати — окремий колайдер із фільтром пар контакту:
 * тіло стикається з ними, лише коли його кімната — ця. Кімната тіла — поточна, поки її підлога (`hit_road`) під
 * центром, інакше — найвища підлога під центром; без підлоги під собою (стрибок, вихід за межі) тіло лишається в останній знайденій кімнаті, як в
 * оригіналі (кімната змінюється лише переходом).
 *
 * Підлогу не фільтруємо: колеса — промені (хуки на них не діють), а кімнати з однаковою підлогою не перетинаються.
 * Хуки Rapier 0.20 діють лише в кроці з чергою подій — крок світу робити через `step()`.
 */
export class RoomBounds {
  /** Кімнати з підлогою: `<регіон>/<кімната>`. */
  private readonly rooms = new Map<string, Room>();
  /** Колайдер стін → кімната. */
  private readonly walls = new Map<number, string>();
  /** Тіло → [крок пошуку, кімната]. */
  private readonly bodies = new Map<number, [number, string | null]>();
  private readonly events = new RAPIER.EventQueue(false);
  private steps = 0;

  constructor(private readonly world: RAPIER.World) {}

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
   * Стіни кімнати — колайдер, що діє лише на тіла в цій кімнаті. Кімната без підлоги (`hit_road` немає) — звичайний
   * колайдер: у неї тіло не «потрапить».
   */
  addWalls(region: string, room: string, walls: Poly[]): RAPIER.Collider | null {
    const c = addCollisionPolys(this.world, walls, 0.4);
    const key = `${region}/${room.toLowerCase()}`;
    if (!c || !this.rooms.has(key)) return c;
    c.setActiveHooks(RAPIER.ActiveHooks.FILTER_CONTACT_PAIRS);
    this.walls.set(c.handle, key);
    return c;
  }

  /** Забути регіон (його колайдери прибирає власник). */
  removeRegion(region: string, colliders: readonly RAPIER.Collider[]): void {
    for (const c of colliders) this.walls.delete(c.handle);
    for (const k of [...this.rooms.keys()]) if (k.startsWith(`${region}/`)) this.rooms.delete(k);
  }

  /**
   * Крок світу з фільтром пар контакту. Кімнати тіл — до кроку: під час кроку хук не може звертатися до тіл
   * (WASM-світ зайнятий — виняток, і пару контакту Rapier відкидає).
   */
  step(): void {
    this.steps++;
    if (this.walls.size) this.world.forEachRigidBody((b) => void (b.isFixed() || this.roomOf(b)));
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

  private readonly hooks: RAPIER.PhysicsHooks = {
    filterContactPair: (c1, c2, b1, b2) => {
      const r1 = this.walls.get(c1);
      const [room, body] = r1 !== undefined ? [r1, b2] : [this.walls.get(c2), b1];
      if (room === undefined || body === null || body === undefined) return RAPIER.SolverFlags.COMPUTE_IMPULSE;
      const at = this.bodies.get(body)?.[1] ?? null;
      // Кімнату ще не знайдено (тіло над місцем без підлоги від самого початку) — стіни діють, як раніше.
      return at === null || at === room ? RAPIER.SolverFlags.COMPUTE_IMPULSE : null;
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
