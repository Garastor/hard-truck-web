import * as THREE from 'three';
import { makeOrders, type Order } from '../career/economy';
import { isPocket, toStation, type Ht2Roads, type RoadLine } from '../world/roads';
import type { SemiKind } from '../vehicles/presents';
import type { Freight, FreightCapacity, FreightJob, FreightPhase } from './freight';

/**
 * Далекобійники ІІ світу (king.exe: `(playertypes … (aitruck 50))` з ENV/GAME.CNF, імена — names.sch): кожен існує
 * весь час, має свій рейс (traffic/freight.ts) і позицію на мережі доріг. Тут — лише «абстрактний» бік: далеко від
 * гравця водій їде вздовж ліній мережі за маршрутом рейсу (як наймані, career/hired.ts; швидкість prescribeAdvance
 * 0x41a9d0 — max(13,89 м/с, згладжена швидкість гравця), від машини не залежить), на місці складу вантажиться чи
 * розвантажується без фізики (Freight.step з нульовою швидкістю) і бере наступний рейс. Ближче — фізична машина
 * (traffic/truckers.ts): рейс і вантаж ті самі, позиція повертається сюди, коли машина знову стає абстрактною.
 *
 * Гіпотези порту: на старті водії стоять на випадкових дорогах (не на під'їздах заправок і СТО), половина вже з
 * вантажем (START_LOADED); машина (модель, фарбування, напівпричіп) — випадкова з evehicles.sch класу trucker і не
 * міняється; пошкоджень, пального, оплати й ліцензій абстрактний рух не рахує.
 */
export interface FleetMember {
  name: string;
  /** Модель (carNode vehicle.tech) і варіант фарбування з evehicles.sch. */
  model: string;
  variant: number;
  /** Напівпричіп тягача (null — вантажівка з кузовом). */
  semi: SemiKind | null;
  /** Рейс (null — ще не призначено чи немає складів). */
  job: FreightJob | null;
  /** Вантаж, кг (у причепі; вантажівці — лише облік). */
  cargo: number;
  /** Позиція на мережі: лінія й відстань від її початку, м. */
  line: RoadLine;
  s: number;
  /** Стоїть на місці складу (абстрактно доїхав до цілі рейсу). */
  stopped: boolean;
  /** Зараз фізична машина (traffic/truckers.ts) — абстрактно не рухається. */
  physical: boolean;
  /** Найнятий гравцем (career/hired.ts веде його окремо) — тут не їздить. */
  off: boolean;
  /** Не ставати машиною ще стільки, с (після перекидання чи застрягання), і лише поза видимістю. */
  hold: number;
  hidden: boolean;
  /** Суперник на замовленні гравця (career/competition.ts): рейс змагання, множник швидкості, скільки ще стоїть, с. */
  rival?: RivalLink;
}

/** Суперник на замовленні гравця: рейс змагання (інший рейс — доїхав чи зійшов), «не поспішатиме», затримка міліцією. */
export interface RivalLink {
  job: FreightJob;
  slow: number;
  delay: number;
}

/** Збережений водій (кар'єра `fleet`): лінія — за іменем, замовлення — з ID товару. */
export interface SavedTrucker {
  name: string;
  model: string;
  variant: number;
  semi: string | null;
  paint: number;
  line: string;
  s: number;
  cargo: number;
  job: { phase: FreightPhase; store: number | null; place: number; order: SavedOrder | null; pause: number; roam: number } | null;
}
type SavedOrder = Omit<Order, 'goods' | 'hidden'> & { goods: string; hidden?: string };

/** Частка водіїв, що на старті вже везуть вантаж (порт). */
export const START_LOADED = 0.5;
/** Скільки нових рейсів призначати за кадр (Дейкстра до нового місця ≈ 6 мс). */
const JOBS_PER_TICK = 2;
/** Місце складу «на лінії»: точка місця ближче за стільки від осі смуги, м (вузли — за 1,2–2 м). */
const GOAL_SIDE = 4;
/** Тупик без продовження — розворот на лінію, що починається ближче, м. */
const UTURN_R = 25;

export class Fleet {
  readonly members: FleetMember[] = [];
  private readonly byName = new Map<string, RoadLine>();
  private readonly lengths = new Map<RoadLine, number>();
  /** Де на лінії місце складу поточного рейсу (кеш: лінія + рейс → s чи null). */
  private readonly goalCache = new WeakMap<FleetMember, { line: RoadLine; job: FreightJob | null; s: number | null }>();

  constructor(
    private readonly roads: Ht2Roads,
    readonly freight: Freight | null,
    /** Місткість машини водія для замовлень (причіп чи кузов). */
    private readonly capacity: (m: FleetMember) => FreightCapacity,
    private readonly rnd: () => number = Math.random,
  ) {
    for (const l of roads.lines) this.byName.set(l.name, l);
  }

  /** Лінії, де можна поставити водія на старті: не під'їзди станцій, не зрізалки, не закриті, не нульові. */
  startLines(): RoadLine[] {
    return this.roads.lines.filter((l) => !l.station && !l.shortcut && !l.closed && this.len(l) > 1 && !this.roads.deadEnd(l));
  }

  /**
   * Новий водій на випадковій дорозі (не ближче away м від точки avoid): рейс призначає tick (по JOBS_PER_TICK за кадр).
   */
  add(name: string, model: string, variant: number, semi: SemiKind | null, avoid?: THREE.Vector3, away = 0, lines = this.startLines()): FleetMember | null {
    if (!lines.length) return null;
    for (let attempt = 0; attempt < 30; attempt++) {
      const line = lines[Math.floor(this.rnd() * lines.length)];
      const s = this.rnd() * this.len(line);
      const m: FleetMember = { name, model, variant, semi, job: null, cargo: 0, line, s, stopped: false, physical: false, off: false, hold: 0, hidden: false };
      if (avoid && attempt < 29 && this.at(m).pos.distanceTo(avoid) < away) continue;
      this.members.push(m);
      return m;
    }
    return null;
  }

  /** Довжина лінії вздовж її точок (3D), м. */
  len(l: RoadLine): number {
    let v = this.lengths.get(l);
    if (v === undefined) {
      v = 0;
      for (let i = 1; i < l.pts.length; i++) v += l.pts[i].distanceTo(l.pts[i - 1]);
      this.lengths.set(l, v);
    }
    return v;
  }

  /** Точка й напрям водія на дорозі (Three.js). */
  at(m: FleetMember): { pos: THREE.Vector3; forward: THREE.Vector3 } {
    const pts = m.line.pts;
    let left = m.s;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = a.distanceTo(b);
      if (left <= len || i + 2 === pts.length) {
        const t = len > 0 ? THREE.MathUtils.clamp(left / len, 0, 1) : 0;
        const forward = b.clone().sub(a).setY(0);
        return { pos: a.clone().lerp(b, t), forward: forward.lengthSq() > 0 ? forward.normalize() : new THREE.Vector3(0, 0, -1) };
      }
      left -= len;
    }
    return { pos: pts[0].clone(), forward: new THREE.Vector3(0, 0, -1) };
  }

  /** Поставити на найближчу лінію своєї смуги (машина стала абстрактною); біля місця рейсу — вважається, що стоїть там. */
  place(m: FleetMember, pos: THREE.Vector3, heading?: THREE.Vector3): void {
    const n = this.roads.nearest(pos, heading);
    if (!n) return;
    let s = 0;
    for (let i = 0; i < n.seg; i++) s += n.line.pts[i].distanceTo(n.line.pts[i + 1]);
    s += n.line.pts[n.seg].distanceTo(n.line.pts[n.seg + 1]) * n.t;
    m.line = n.line;
    m.s = Math.min(s, this.len(n.line));
    const g = m.job?.goal;
    m.stopped = !!g && Math.hypot(g.x - pos.x, g.z - pos.z) < 5;
  }

  /** Перший рейс: з імовірністю START_LOADED — уже з вантажем випадкового складу до іншого, інакше порожній. */
  startJob(m: FleetMember): void {
    const f = this.freight;
    if (!f) return;
    const cap = this.capacity(m);
    let job: FreightJob | null = null;
    if (this.rnd() < START_LOADED && f.stores.length > 1) {
      const from = f.stores[Math.floor(this.rnd() * f.stores.length)];
      const order = makeOrders(from, f.stores, f.goodsList, cap, this.rnd, 1, cap.tanker, 0, cap.trailer)[0];
      job = order ? f.sendLoaded(order) : null;
      if (job) m.cargo = order.goods.mass * order.units;
    }
    this.setJob(m, job ?? f.sendEmpty(this.at(m).pos, cap));
  }

  setJob(m: FleetMember, job: FreightJob): void {
    m.job = job;
    m.stopped = false;
  }

  /** Рейси водіям без рейсу — по JOBS_PER_TICK за кадр (кожен кадр, хоч рух і рідше: без ривка на старті). */
  assignJobs(): void {
    if (!this.freight) return;
    let budget = JOBS_PER_TICK;
    for (const m of this.members) {
      if (budget <= 0) return;
      if (m.off || m.physical || m.job) continue;
      budget--;
      this.startJob(m);
    }
  }

  /**
   * Крок абстрактного руху за dt с (truckers.ts кличе раз на FLEET_EVERY с — водіїв далеко не видно): speed — м/с
   * (prescribeAdvance). Водії-машини й наймані стоять; на паузі (вантаження) і біля місця — стоять, Freight.step
   * вантажить/розвантажує й видає наступний рейс. Повертає водіїв, у кого змінився вантаж.
   */
  tick(dt: number, speed: number | ((m: FleetMember) => number)): FleetMember[] {
    const changed: FleetMember[] = [];
    this.assignJobs();
    for (const m of this.members) {
      if (m.off || m.physical) continue;
      m.hold = Math.max(0, m.hold - dt);
      const job = m.job;
      const v = typeof speed === 'number' ? speed : speed(m);
      // Суперника затримала міліція — стоїть.
      if (m.rival && m.rival.delay > 0) {
        m.rival.delay = Math.max(0, m.rival.delay - dt);
        continue;
      }
      if (!job || job.pause <= 0) this.move(m, v * dt);
      if (!job || !this.freight) continue;
      const still = m.stopped || job.pause > 0;
      const { job: next, event } = this.freight.step(job, this.at(m).pos, still ? 0 : v * 3.6, dt, this.capacity(m));
      if (event) {
        m.cargo = event.cargo;
        changed.push(m);
      }
      if (next !== job) this.setJob(m, next);
    }
    return changed;
  }

  /** Абстрактно проїхати meters: за маршрутом рейсу (Navigator), без нього — випадковими гілками; біля місця — стати. */
  move(m: FleetMember, meters: number): void {
    if (m.stopped) return;
    let left = meters;
    for (let guard = 0; guard < 50; guard++) {
      const g = this.goalOn(m);
      if (g !== null && m.s <= g + 0.01 && m.s + left >= g) {
        m.s = g;
        m.stopped = true;
        return;
      }
      const len = this.len(m.line);
      if (m.s + left <= len) {
        m.s += left;
        return;
      }
      left -= Math.max(0, len - m.s);
      const n = this.next(m);
      if (!n) {
        m.s = len;
        return;
      }
      m.line = n;
      m.s = 0;
    }
  }

  /** Продовження лінії: найкоротшим шляхом до місця рейсу, без маршруту — випадкова гілка; тупик — розворот. */
  private next(m: FleetMember): RoadLine | null {
    const line = m.line;
    const routed = m.job && this.freight?.next(m.job, line);
    if (routed) return routed;
    // Зрізалки (world/roads markShortcuts) — лише для гравця.
    const all = (line.next as RoadLine[]).filter((n) => this.len(n) > 0 && (line.shortcut || !n.shortcut));
    const passable = all.filter((n) => line.closed || !n.closed);
    const open = passable.filter((n) => !this.roads.deadEnd(n));
    const pool0 = open.length ? open : passable;
    // Паркувальні кишені й під'їзди станцій — лише якщо іншого шляху немає (як roads.pick).
    const roads = pool0.filter((n) => !isPocket(n) && !toStation(n));
    const pool = roads.length ? roads : pool0;
    if (pool.length) return pool[Math.floor(this.rnd() * pool.length)];
    const end = line.pts[line.pts.length - 1];
    const back = this.roads.lines.filter((l) => l !== line && !l.station && !l.shortcut && this.len(l) > 0 && l.pts[0].distanceTo(end) < UTURN_R);
    return back.length ? back[Math.floor(this.rnd() * back.length)] : null;
  }

  /**
   * Зсунути водія вздовж дороги на offset м (суперники біля гравця, provideCompetitionSpecial 0x425dd0): уперед —
   * маршрутом рейсу (move, біля місця складу стає), назад — попередніми лініями (не станції й не зрізалки).
   */
  shift(m: FleetMember, offset: number): void {
    if (offset >= 0) {
      this.move(m, offset);
      return;
    }
    let left = -offset;
    for (let guard = 0; guard < 50 && left > 0; guard++) {
      if (m.s >= left) {
        m.s -= left;
        return;
      }
      left -= m.s;
      const prev = this.prevOf(m.line).filter((l) => !l.closed && !l.station && !l.shortcut && this.len(l) > 0);
      if (!prev.length) {
        m.s = 0;
        return;
      }
      // Стала гілка (не тупикова, якщо є): найдовша — найімовірніше дорога, а не з'їзд.
      const open = prev.filter((l) => !this.roads.deadEnd(l));
      m.line = (open.length ? open : prev).reduce((a, b) => (this.len(a) >= this.len(b) ? a : b));
      m.s = this.len(m.line);
    }
  }

  private prevMap: Map<RoadLine, RoadLine[]> | null = null;

  private prevOf(l: RoadLine): RoadLine[] {
    if (!this.prevMap) {
      this.prevMap = new Map();
      for (const a of this.roads.lines) for (const n of a.next as RoadLine[]) (this.prevMap.get(n) ?? this.prevMap.set(n, []).get(n)!).push(a);
    }
    return this.prevMap.get(l) ?? [];
  }

  /** Скільки водієві лишилось дорогами до місця рейсу, м (null — без цілі чи шляху). */
  left(m: FleetMember): number | null {
    return m.job && this.freight ? this.freight.left(m.job, m.line, m.s) : null;
  }

  /** s місця складу рейсу на поточній лінії (null — місце не на ній). */
  private goalOn(m: FleetMember): number | null {
    const c = this.goalCache.get(m);
    if (c && c.line === m.line && c.job === m.job) return c.s;
    const g = m.job?.goal ?? null;
    let s: number | null = null;
    if (g) {
      let best = GOAL_SIDE;
      let acc = 0;
      const pts = m.line.pts;
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const l2 = abx * abx + abz * abz;
        const seg = a.distanceTo(b);
        if (l2 > 0) {
          const t = THREE.MathUtils.clamp(((g.x - a.x) * abx + (g.z - a.z) * abz) / l2, 0, 1);
          const d = Math.hypot(a.x + abx * t - g.x, a.z + abz * t - g.z);
          if (d < best) (best = d), (s = acc + seg * t);
        }
        acc += seg;
      }
    }
    this.goalCache.set(m, { line: m.line, job: m.job, s });
    return s;
  }

  /** Стан усіх водіїв для збереження кар'єри. */
  snapshot(): SavedTrucker[] {
    return this.members.map((m) => ({
      name: m.name,
      model: m.model,
      variant: m.variant,
      semi: m.semi?.carNode ?? null,
      paint: m.semi?.cluster ?? 0,
      line: m.line.name,
      s: Math.round(m.s * 10) / 10,
      cargo: m.cargo,
      job: m.job && {
        phase: m.job.phase,
        store: m.job.store?.id ?? null,
        place: m.job.place,
        order: m.job.order && { ...m.job.order, goods: m.job.order.goods.id, hidden: m.job.order.hidden?.id },
        pause: m.job.pause,
        roam: m.job.roam,
      },
    }));
  }

  /**
   * Відновити водіїв зі збереження (semis — типи напівпричепів evehicles.sch). Лінії чи складу вже немає — водій на
   * випадковій дорозі чи без рейсу (отримає новий).
   */
  restore(saved: readonly SavedTrucker[], semis: readonly SemiKind[]): void {
    const lines = this.startLines();
    for (const v of saved) {
      const semi = v.semi ? (semis.find((k) => k.carNode === v.semi && k.cluster === v.paint) ?? semis.find((k) => k.carNode === v.semi) ?? null) : null;
      const line = this.byName.get(v.line);
      const m = line
        ? { name: v.name, model: v.model, variant: v.variant, semi, job: null, cargo: v.cargo, line, s: Math.min(v.s, this.len(line)), stopped: false, physical: false, off: false, hold: 0, hidden: false }
        : this.add(v.name, v.model, v.variant, semi, undefined, 0, lines);
      if (!m) continue;
      if (line) this.members.push(m);
      m.cargo = v.cargo;
      const job = v.job && this.restoreJob(v.job);
      if (job) {
        m.job = job;
        const g = job.goal;
        const p = this.at(m).pos;
        m.stopped = !!g && Math.hypot(g.x - p.x, g.z - p.z) < 5;
      } else m.cargo = 0;
    }
  }

  private restoreJob(j: NonNullable<SavedTrucker['job']>): FreightJob | null {
    const f = this.freight;
    if (!f) return null;
    const store = j.store === null ? null : (f.stores.find((s) => s.id === j.store) ?? null);
    const goods = j.order && f.goodsList.find((g) => g.id === j.order!.goods);
    const hidden = j.order?.hidden ? f.goodsList.find((g) => g.id === j.order!.hidden) : undefined;
    if (j.order && !goods) return null;
    const order: Order | null = j.order && goods ? { ...j.order, goods, hidden } : null;
    if (j.phase !== 'roam' && !store) return null;
    const goal = store ? f.dock(store, j.place) : null;
    if (j.phase !== 'roam' && !goal) return null;
    return { phase: j.phase, store, place: j.place, goal, order, pause: j.pause, queued: 0, roam: j.roam };
  }
}
