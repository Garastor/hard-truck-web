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
/** Запас порталу по висоті й з боків при перетині, м. */
const GATE_PAD = 2;
/** Зсув тіла за крок, з якого це вже не рух, а перенесення (портали не перевіряються), м. */
const TELEPORT = 20;
/**
 * Підлога сусідньої кімнати діє на тіло, лише коли його центр ближче за NEAR_GATE до спільного порталу (у плані), м.
 * King.exe бере кімнату за порталом, лише коли рух кроку перетинає портал; у порту — колеса й корпус уже над сусідньою
 * підлогою за кілька метрів до переходу центру. Без обмеження площина блоку 12 сусідньої кімнати (обрізана лише рамкою
 * кімнати) ставала невидимою сходинкою далеко від порталу: room_cb01 (z = 10) на дорозі room_cb00 (9,1–9,5 м), 32 м
 * від порталу.
 */
const NEAR_GATE = 8;

/** Портал кімнати на плані (система гри): відрізок a→b, висоти z0…z1; ціль — ліворуч від a→b. */
export interface RoomGate {
  to: string;
  a: [number, number];
  b: [number, number];
  z0: number;
  z1: number;
}

/** Відомості про тіло: крок пошуку кімнати, кімната, позиція на попередньому кроці (гра). */
interface BodyRoom {
  at: number;
  room: string | null;
  x: number;
  y: number;
}

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
 * фільтрує `groundFilter` за тим самим правилом. Кімната тіла змінюється, як у king.exe, коли центр за крок перетинає
 * портал її кімнати (0x57def0): підлога кімнат заходить за портали (підлога dr_000 тягнеться до межі y = −2770, а
 * портал у dr_099 — на y = −2800), і машина, що виїжджала з кільця на dr_099, лишалась у dr_000 й упиралась у його
 * межу. Крім того кімната — поточна, поки її підлога (`hit_road`) під центром, інакше — найвища підлога під центром
 * (наближення там, де портал проминуто: перенесення, перший крок); без підлоги під собою (стрибок, вихід за межі)
 * тіло лишається в останній знайденій кімнаті.
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
  /** Портали кімнат (ключ `<регіон>/<кімната>`). */
  private readonly gates = new Map<string, RoomGate[]>();
  /** Тіло → кімната й позиція. */
  private readonly bodies = new Map<number, BodyRoom>();
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

  /**
   * Портали кімнати: сусідство (в обидва боки) і переходи тіл. Кімната за порталом — у тому самому регіоні, а як її
   * там немає — у будь-якому завантаженому.
   */
  addPortals(region: string, room: string, gates: readonly RoomGate[]): void {
    const a = room.toLowerCase();
    for (const g of gates) {
      const b = g.to.toLowerCase();
      for (const [x, y] of [[a, b], [b, a]]) (this.near.get(x) ?? this.near.set(x, new Set([x])).get(x)!).add(y);
    }
    this.gates.set(`${region}/${a}`, gates.map((g) => ({ ...g, to: g.to.toLowerCase() })));
  }

  /** Забути регіон (його колайдери прибирає власник). */
  removeRegion(region: string, colliders: readonly RAPIER.Collider[]): void {
    for (const c of colliders) this.owned.delete(c.handle);
    for (const k of [...this.rooms.keys()]) if (k.startsWith(`${region}/`)) this.rooms.delete(k);
    for (const k of [...this.gates.keys()]) if (k.startsWith(`${region}/`)) this.gates.delete(k);
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
    const t = body.translation();
    const x = t.x;
    const y = -t.z;
    const known = this.bodies.get(body.handle);
    if (known) {
      const moved = Math.hypot(x - known.x, y - known.y);
      const gate = known.room && moved > 1e-6 && moved < TELEPORT ? this.crossed(known.room, known.x, known.y, x, y, t.y) : null;
      known.x = x;
      known.y = y;
      if (gate) {
        known.room = gate;
        known.at = this.steps;
        return gate;
      }
      if (this.steps - known.at < RECHECK_STEPS && moved < TELEPORT) return known.room;
    }
    // Портал проминуто (перенесення, перший крок) чи підлога поточної кімнати скінчилась: де підлоги кімнат
    // перекриваються (дорога dr_099 заходить на кільце dr_000), машина лишається в тій, з якої приїхала.
    const cur = known?.room ? this.rooms.get(known.room) : undefined;
    const fz = cur ? floorUnder(cur.floors, x, y, t.y + RISE) : null;
    const stay = fz !== null && t.y - fz < KEEP;
    const room = stay ? known!.room : (this.roomAt(x, y, t.y) ?? known?.room ?? null);
    if (this.bodies.size > 2048) this.bodies.clear();
    this.bodies.set(body.handle, { at: this.steps, room, x, y });
    return room;
  }

  /** Кімната за порталом кімнати `key`, який перетнув відрізок (x0, y0) → (x1, y1) на висоті z; null — жодного. */
  private crossed(key: string, x0: number, y0: number, x1: number, y1: number, z: number): string | null {
    const gates = this.gates.get(key);
    if (!gates) return null;
    for (const g of gates) {
      if (z < g.z0 - GATE_PAD || z > g.z1 + GATE_PAD) continue;
      const dx = g.b[0] - g.a[0];
      const dy = g.b[1] - g.a[1];
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) continue;
      // Відстань ліворуч від a→b (бік кімнати-цілі): перехід — з відʼємної на невідʼємну.
      const s0 = (dx * (y0 - g.a[1]) - dy * (x0 - g.a[0])) / len;
      const s1 = (dx * (y1 - g.a[1]) - dy * (x1 - g.a[0])) / len;
      if (!(s0 < 0 && s1 >= 0)) continue;
      const k = s0 / (s0 - s1);
      const px = x0 + (x1 - x0) * k;
      const py = y0 + (y1 - y0) * k;
      const along = ((px - g.a[0]) * dx + (py - g.a[1]) * dy) / len;
      if (along < -GATE_PAD || along > len + GATE_PAD) continue;
      const region = key.slice(0, key.indexOf('/'));
      const same = `${region}/${g.to}`;
      if (this.rooms.has(same)) return same;
      for (const k2 of this.rooms.keys()) if (k2.endsWith(`/${g.to}`)) return k2;
    }
    return null;
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
    const at = this.bodies.get(body)?.room ?? null;
    // Кімнату ще не знайдено (тіло над місцем без підлоги від самого початку) — колізії діють, як раніше.
    if (at === null || at === o.key) return true;
    if (!o.floor) return false;
    if (!(this.near.get(at.slice(at.indexOf('/') + 1))?.has(o.name) ?? false)) return false;
    const b = this.bodies.get(body)!;
    return this.nearGate(at, o.name, b.x, b.y) || this.nearGate(o.key, at.slice(at.indexOf('/') + 1), b.x, b.y);
  }

  /** Чи точка (x, y) плану ближче за NEAR_GATE до порталу кімнати key в кімнату to. */
  private nearGate(key: string, to: string, x: number, y: number): boolean {
    for (const g of this.gates.get(key) ?? []) {
      if (g.to !== to) continue;
      const dx = g.b[0] - g.a[0];
      const dy = g.b[1] - g.a[1];
      const l2 = dx * dx + dy * dy;
      const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - g.a[0]) * dx + (y - g.a[1]) * dy) / l2)) : 0;
      if (Math.hypot(x - g.a[0] - dx * t, y - g.a[1] - dy * t) < NEAR_GATE) return true;
    }
    return false;
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
