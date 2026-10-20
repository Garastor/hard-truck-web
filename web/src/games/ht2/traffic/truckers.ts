import * as THREE from 'three';
import { kingCar } from '../vehicles/controls';
import type { Oncoming } from '../engine/vehicle/autopilot';
import { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { buildTruckModel } from '../engine/vehicle/trucks';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import { drivable, truckDef, type Ht2Trucks } from '../vehicles/trucks';
import { Trailer } from '../vehicles/trailer';
import type { SemiKind } from '../vehicles/presents';
import { recolor, SPOT_FACING, SPOT_RANGE, spotShare } from './traffic';
import { disposePool, makePool, setPoolFade } from './headPools';
import { markMover } from '../world/roomVisibility';
import { g2t } from '../engine/physics/world';
import { Freight, type FreightCapacity, type FreightJob } from './freight';
import { Fleet, type FleetMember, type SavedTrucker } from './fleet';
import { HIRED_MIN_SPEED } from '../career/hired';
import type { Ht2Roads } from '../world/roads';
import type { Ht2Drive } from '../drive';
import { alongPoints, newBot, POINT_HALF, setRoute, steer, think, type BotDriver } from './botDriver';
import { turnSignal, type Obstacle } from './driver';
import { Blinkers } from './blinkers';

/**
 * Далекобійники-суперники HT2: у світі їх 50 (`ENV/GAME.CNF`: `(playertypes … (aitruck 50))`), імена — `names.sch`
 * (`("ВИТАЛИЙ" male trucker 1)`). Кожен існує весь час (traffic/fleet.ts: рейс і позиція на мережі доріг; далеко —
 * абстрактний рух уздовж ліній). Ближче PHYS_ON у завантаженому регіоні водій стає машиною (вантажівки з кузовом і
 * тягачі класу trucker типів lorry і tractor з evehicles.sch: `(vehicle MERCEDES_LORRY2 "MercedesR" 1 lorry trucker …)`,
 * `(vehicle VOLVO_TRACTOR1 "Volvo" 0 tractor trucker …)`, число — варіант фарбування) на тому ж автопілоті, що й гравець
 * (клавіша P), з тим самим рейсом і вантажем; далі PHYS_OFF — знову абстрактний з позицією, де була машина. Машин
 * одночасно — не більше max (4 × повзунок трафіку), ближчі — першими. Це повноцінні тіла фізики: зіткнення з ними — як з
 * гравцем. Тягач — з напівпричепом (тип — як presents: SEMITRAILER1–6, SEMITANK1–4, у «Шторма» — URAGAN_SEMITRAILER;
 * гіпотеза порту: у king.exe ШІ бере причіп сам, як гравець). Возять вантажі, як далекобійники ІІ king.exe
 * (traffic/freight.ts): порожній — до найближчого складу на місце з замовленням, там вантажиться, везе за маршрутом
 * мережі до складу призначення, розвантажується й бере наступне.
 */
const MAX = 4;
/** Скільки далекобійників у світі (GAME.CNF aitruck). */
export const AITRUCK = 50;
/**
 * Водій (і найманий гравця, career/hired.ts) стає машиною ближче PHYS_ON і знову абстрактним далі PHYS_OFF, м (king.exe:
 * фізична — ближче 80 м, кінематична — до туману; порт кінематичних вантажівок не має).
 */
const PHYS_ON = 300;
const PHYS_OFF = 450;
/** На старті водії стоять не ближче за стільки від гравця, м. */
const START_AWAY = 150;
/** Машиною — не ближче за стільки від гравця й інших машин, м. */
const FREE_R = 30;
/** Перевірка, кому стати машиною, — раз на стільки, с. */
const PROMOTE_EVERY = 0.5;
/** Абстрактний рух водіїв світу — раз на стільки, с (на прохання користувача). */
const FLEET_EVERY = 1;
/** Стоїть довше — застряг, с. */
const STUCK_FOR = 30;
/** Після перекидання чи застрягання — абстрактний щонайменше стільки, с, і машиною лише поза видимістю. */
const HOLD = 20;

export interface Rival {
  name: string;
  truck: TruckVehicle;
  /** Водій — як у трафіку (traffic/botDriver.ts). */
  bot: BotDriver;
  bad: number;
  /** Напівпричіп тягача (null — вантажівка з кузовом чи причіп відірвало). */
  trailer: Trailer | null;
  /** Скільки стоїть (швидкість < 2 км/год), с. */
  idle: number;
  /** Перемикачі моделі тягача (фари, габарити, задні вогні). */
  setSwitch: ((name: string, state: number) => void) | undefined;
  /** Фари (Fara_FL/FR vehicle.tech, система моделі Three.js); увімкнені й світлові плями (headPools.ts). */
  faras: [THREE.Vector3, THREE.Vector3];
  /** Стан фар, поставлений перемикачам; null — ще не ставили (у даних моделі початково горить усе, і задній хід). */
  lit: boolean | null;
  pool: THREE.Group | null;
  /** Рейс (null — найманий чи без даних складів: стала випадкова гілка на розвилках). */
  job: FreightJob | null;
  /** Запис vehicle.tech машини (місткість кузова для замовлень). */
  rec: ReturnType<typeof drivable>[number];
  /** Далекобійник світу (traffic/fleet.ts), чия це машина; null — найманий гравця чи тестова машина. */
  member: FleetMember | null;
  /** Покажчики повороту на тягачі й (задні) на напівпричепі (traffic/blinkers.ts). */
  blink: THREE.Group | null;
  blinkTrailer: THREE.Group | null;
}

/** Точки вздовж тягача й причепа — одне тіло для обʼїзду. */
function rigPoints(r: Rival): THREE.Vector3[] {
  return [r.truck.visual.position, ...(r.trailer?.points() ?? [])];
}

/** Машини далекобійників з evehicles.sch: тип lorry чи tractor, клас trucker, модель є серед вантажівок (vehicle.tech). */
export function truckerKinds(sch: SExpr[], trucks: Ht2Trucks): { model: string; variant: number }[] {
  const ok = new Set(drivable(trucks).map((r) => r.carNode));
  return sch
    .filter((e): e is SExpr[] => isList(e) && e[0] === 'vehicle' && (e[4] === 'lorry' || e[4] === 'tractor') && (e[5] === 'trucker' || (isList(e[5]) && e[5].includes('trucker'))))
    .map((e) => ({ model: str(e[2]), variant: num(e[3]) }))
    .filter((k) => ok.has(k.model));
}

/** Імена далекобійників з names.sch. */
export function truckerNames(sch: SExpr[]): string[] {
  return sch.filter((e): e is SExpr[] => isList(e) && e[2] === 'trucker').map((e) => str(e[0]));
}

export class Truckers {
  readonly list: Rival[] = [];
  /** Наймані водії гравця, що зараз машиною на дорозі (за іменем; career/hired.ts). */
  readonly hired = new Map<string, Rival>();
  /** До наступної перевірки, кому стати машиною, с (1e9 — нікому: тести в браузері). */
  timer = 0;
  /** Час, накопичений для кроку абстрактних водіїв, с. */
  private fleetAcc = 0;
  /** Усі далекобійники світу (створюються в першому after — біля гравця не ставимо). */
  fleet: Fleet | null = null;
  private saved: readonly SavedTrucker[] | null = null;
  private recs: ReturnType<typeof drivable> | null = null;
  /** Покажчики повороту (створюються з першим ботом). */
  private blinkers: Blinkers | null = null;
  /** Фари вночі (drive: як у трафіку, за годиною й повзунками графіки). */
  lights = false;
  /** Шукати машину для прожекторів фар (drive.updateCarLamp) і чи віддано їх найближчій зустрічній (this.spot). */
  spotWanted = false;
  spotTaken = false;
  /** Найближча зустрічна з фарами ближче SPOT_RANGE: точки фар, напрям, відстань — кандидат на прожектори. */
  spot: { left: THREE.Vector3; right: THREE.Vector3; dir: THREE.Vector3; dist: number; rig: Rival } | null = null;

  constructor(
    private readonly drive: Ht2Drive,
    private readonly roads: Ht2Roads,
    private readonly names: string[],
    private readonly loaded: (region: string) => boolean,
    private readonly kinds: { model: string; variant: number }[] = [],
    private readonly max = MAX,
    /** Типи напівпричепів (evehicles.sch, presents.semiKinds) — для тягачів. */
    private readonly semis: SemiKind[] = [],
    /** Склади й товари для рейсів (null — без рейсів, вантаж — випадкова частка місткості). */
    readonly freight: Freight | null = null,
    /** Скільки далекобійників у світі (GAME.CNF aitruck). */
    private readonly size = AITRUCK,
  ) {}

  /** Моделі машин далекобійників (evehicles.sch, клас trucker; за кожен варіант фарбування) — частка X. */
  get models(): string[] {
    return this.kinds.map((k) => k.model);
  }

  /** Імена всіх далекобійників (names.sch) — рейтинг F2. */
  get allNames(): readonly string[] {
    return this.names;
  }

  /** Усі машини на дорозі (суперники й наймані). */
  get rigs(): Rival[] {
    return [...this.list, ...this.hired.values()];
  }

  /** Точки машин (з напівпричепами) — перешкоди для автопілотів, міліції й мафії. */
  get positions(): THREE.Vector3[] {
    return this.rigs.flatMap(rigPoints);
  }

  /** Кожна машина з причепом — набір точок одного тіла (трафік обʼїжджає його цілком). */
  get bodies(): THREE.Vector3[][] {
    return this.rigs.map(rigPoints);
  }

  /**
   * Наймані водії гравця (king.exe: найнятий — звичайний далекобійник ІІ, ближче — фізична машина): want — усі наймані з
   * абстрактною позицією на дорозі; ближче HIRED_ON у завантаженому регіоні — машина з автопілотом, далі HIRED_OFF —
   * знову абстрактний (позицію веде career/hired.ts). Звільнені — прибираються.
   */
  syncHired(want: readonly { name: string; carNode: string; pos: THREE.Vector3; forward: THREE.Vector3 }[], player: THREE.Vector3): void {
    const names = new Set(want.map((w) => w.name));
    // Найнятий — уже не вільний далекобійник світу: його веде career/hired.ts (king.exe — той самий запис, порт — окремо).
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].member && names.has(this.list[i].name)) this.demote(i, false);
    for (const m of this.fleet?.members ?? []) m.off = names.has(m.name);
    for (const [name, r] of this.hired) {
      const far = r.truck.visual.position.distanceTo(player) > PHYS_OFF;
      const line = this.roads.nearest(r.truck.visual.position);
      if (!names.has(name) || far || (line && !this.loaded(line.line.region)) || r.truck.body.translation().y < -500) this.dropHired(name);
    }
    for (const w of want) {
      if (this.hired.has(w.name) || w.pos.distanceTo(player) > PHYS_ON) continue;
      const line = this.roads.nearest(w.pos);
      if (!line || !this.loaded(line.line.region)) continue;
      const rec = this.records().find((r) => r.carNode === w.carNode);
      const r = rec && this.make(rec, 0, w.pos, w.forward, w.name);
      if (r) this.hired.set(w.name, r);
    }
  }

  /** Прибрати машину найманого (стане абстрактним; поміняв машину — зʼявиться з новою моделлю). */
  dropHired(name: string): void {
    const r = this.hired.get(name);
    if (!r) return;
    if (r.pool) disposePool(r.pool);
    this.unhitch(r);
    this.drive.world.scene.remove(r.truck.visual);
    r.truck.dispose();
    this.hired.delete(name);
  }

  /** Записи vehicle.tech, якими можна їздити. */
  private records(): ReturnType<typeof drivable> {
    return (this.recs ??= drivable(this.drive.trucksData));
  }

  /** Машина далекобійника з автопілотом у точці дороги; semi — напівпричіп тягача (не задано — випадковий). */
  make(rec: ReturnType<typeof drivable>[number], variant: number, at: THREE.Vector3, forward: THREE.Vector3, name: string, semi?: SemiKind | null): Rival | null {
    const def = truckDef(this.drive.trucksData, rec);
    const model = def && buildTruckModel(this.drive.trucksData.asm, def, true);
    if (!def || !model) return null;
    if (variant > 0) recolor(model.root, this.drive.trucksData, variant + 1);
    // Рух king.exe, як у гравця (kingModel), автопілот — переслідування по дузі з базою машини.
    if (!this.roads.nearest(at, forward)) return null;
    const truck = new TruckVehicle(this.drive.rapierWorld, def, model, { position: this.drive.groundAtPublic(at), forward }, kingCar(rec.suspension));
    markMover(truck.visual);
    this.drive.world.scene.add(truck.visual);
    const kind = semi === undefined ? this.pickSemi(rec) : semi;
    const trailer = rec.group === 'tractors' && kind ? this.hitch(truck, rec, kind) : null;
    // Довжина: до переду — від центру тягача; позаду — до заду кузова чи напівпричепа.
    truck.syncVisual(1);
    trailer?.syncVisual(1);
    const g = truck.lightGeometry;
    const halfLen = Math.max(2, -g.frontZ);
    const rear = trailer ? truck.visual.position.distanceTo(trailer.points()[2]) + 2 : g.backZ;
    // Крейсерська (як була в автопілоті): 50–75 км/год, з напівпричепом — 45–55 (і повільніше на кривих, botDriver).
    const cruise = (trailer ? 45 + Math.random() * 10 : 50 + Math.random() * 25) / 3.6;
    const bot = newBot(this.roads, truck.visual.position, truck.forward().setY(0).normalize(), cruise, halfLen, Math.max(0, rear - halfLen), trailer?.reach ?? 0, g.width / 2)!;
    const faras: [THREE.Vector3, THREE.Vector3] = [g2t(rec.faraFL), g2t(rec.faraFR)];
    return { name, truck, bot, bad: 0, trailer, idle: 0, setSwitch: model.setSwitch, faras, lit: null, pool: null, job: null, rec, member: null, blink: null, blinkTrailer: null };
  }

  /** Тип напівпричепа для тягача: випадковий з presents, у «Шторма» — свій (вантажівці — null). */
  private pickSemi(rec: ReturnType<typeof drivable>[number]): SemiKind | null {
    if (rec.group !== 'tractors') return null;
    const storm = /^Storm/i.test(rec.carNode);
    const pool = this.semis.filter((k) => /^STrailerStorm$/i.test(k.carNode) === storm);
    return pool[Math.floor(Math.random() * pool.length)] ?? null;
  }

  /** Напівпричіп тягача (як drive.hitch); вантаж — частка місткості (з рейсами — ставить loadCargo). */
  private hitch(truck: TruckVehicle, rec: ReturnType<typeof drivable>[number], kind: SemiKind): Trailer | null {
    const trucks = this.drive.trucksData;
    const tr = trucks.records.find((r) => r.carNode.toLowerCase() === kind.carNode.toLowerCase());
    const def = tr && truckDef(trucks, tr);
    if (!tr || !def) return null;
    // З рейсами вантаж ставить loadCargo; без них — випадкова частка місткості.
    const cargo = this.freight ? 0 : Math.min(tr.cargoLoad, rec.cargoLoad || tr.cargoLoad) * (0.3 + 0.7 * Math.random());
    const paint = kind.cluster > 0 ? (root: THREE.Object3D) => recolor(root, trucks, kind.cluster + 1) : undefined;
    const trailer = new Trailer(this.drive.rapierWorld, trucks.asm, def, tr, { body: truck.body, saddle: rec.lowSaddle }, cargo, paint);
    markMover(trailer.visual);
    this.drive.world.scene.add(trailer.visual);
    truck.towing = true;
    const handle = trailer.body.handle;
    truck.rayFilter = (c) => c.parent()?.handle !== handle;
    truck.setTowLoad(trailer.kingpinLoad);
    truck.tow = { mass: trailer.mass, wheels: trailer.wheelCount };
    return trailer;
  }

  /** Місткість машини бота для замовлень: причіп (якщо є) чи кузов. */
  capacity(r: Rival): FreightCapacity {
    return capacityOf(r.rec, r.trailer?.rec ?? null);
  }

  /** Місткість машини далекобійника світу (з його напівпричепом, навіть коли він абстрактний). */
  private memberCapacity(m: FleetMember): FreightCapacity {
    const rec = this.records().find((r) => r.carNode === m.model);
    const semi = m.semi;
    const tr = semi ? this.drive.trucksData.records.find((r) => r.carNode.toLowerCase() === semi.carNode.toLowerCase()) : undefined;
    return rec ? capacityOf(rec, tr ?? null) : { mass: 0, volume: 1, tanker: false, trailer: false };
  }

  /** Рейс боту: маршрут автопілота й точка зупинки (місце складу); у далекобійника світу — і в його запис. */
  setJob(r: Rival, job: FreightJob): void {
    r.job = job;
    if (r.member) r.member.job = job;
    setRoute(r.bot, this.freight?.route(job) ?? null, job.goal);
  }

  /** Вантаж у машині бота, кг: у причепі — маса й вага на сідлі тягача (кузов вантажівки — без зміни маси, порт). */
  loadCargo(r: Rival, mass: number): void {
    if (r.member) r.member.cargo = mass;
    const t = r.trailer;
    if (!t) return;
    t.setCargo(mass);
    r.truck.setTowLoad(t.kingpinLoad);
    r.truck.tow = { mass: t.mass, wheels: t.wheelCount };
  }

  /** Відчепити й прибрати напівпричіп (розрив зчіпки чи машина зникає). */
  private unhitch(r: Rival): void {
    if (!r.trailer) return;
    this.drive.world.scene.remove(r.trailer.visual);
    r.trailer.dispose();
    r.trailer = null;
    r.blinkTrailer = null;
    r.bot.m.tail = Math.max(0, r.truck.lightGeometry.backZ - r.bot.m.halfLen);
    r.bot.reach = 0;
    r.bot.m.bend = 1;
    r.truck.towing = false;
    r.truck.rayFilter = undefined;
    r.truck.setTowLoad(0);
    r.truck.tow = null;
  }

  /**
   * Раз на кадр (після traffic.update): рішення водіїв ботів — як у трафіку. me — точки гравця (з причепом), meVel —
   * його швидкість; oncoming — гравець і трафік з курсом (розминання; боти додаються тут). Перешкоди: машини трафіку
   * (з їхніми водіями: черга, пропуск, обгін), гравець і інші боти — тілом з точок.
   */
  think(dt: number, me: readonly THREE.Vector3[], meVel: THREE.Vector3, oncoming: readonly Oncoming[] = []): void {
    const rigs = this.rigs;
    if (!rigs.length) return;
    const traffic = this.drive.traffic;
    const all: Obstacle[] = (traffic?.cars ?? []).map((c) => ({ pos: c.pos, vel: c.heading.clone().multiplyScalar(c.speed), half: c.halfLen, mover: c }));
    for (const p of me) all.push({ pos: p, vel: meVel, half: POINT_HALF, group: me });
    for (const r of rigs) {
      const tv = r.truck.body.linvel();
      const vel = new THREE.Vector3(tv.x, tv.y, tv.z);
      for (const p of alongPoints(r.truck)) all.push({ pos: p, vel, half: POINT_HALF, mover: r.bot.m, group: r });
      if (r.trailer) {
        const lv = r.trailer.body.linvel();
        const tvel = new THREE.Vector3(lv.x, lv.y, lv.z);
        for (const p of r.trailer.points()) all.push({ pos: p, vel: tvel, half: POINT_HALF, mover: r.bot.m, group: r });
      }
    }
    const heads = rigs.map((r): Oncoming => ({ pos: r.truck.visual.position, forward: r.truck.forward().setY(0).normalize() }));
    rigs.forEach((r, i) => {
      const others = all.filter((o) => o.group !== r);
      const meet = [...oncoming, ...heads.filter((_, j) => j !== i)];
      const stopAt = traffic?.signals?.stopAhead(r.truck.visual.position, r.bot.m.heading) ?? Infinity;
      think(r.bot, this.roads, r.truck, dt, others, meet, stopAt);
    });
  }

  /** Перед кожним кроком фізики: педалі й кермо ботів (рішення — think). */
  control(dt: number): void {
    for (const r of this.rigs) {
      const state = steer(r.bot, r.truck, dt);
      r.truck.update(dt, state);
      r.trailer?.update(dt, r.truck.brakePedal(state), r.truck.def.tech.brakePower, r.truck.kinematic);
    }
  }

  /** Покажчики повороту ботів: блимають, коли водій сигналить (driver.turnSignal). */
  private updateSignals(dt: number): void {
    const bl = (this.blinkers ??= new Blinkers(this.drive.trucksData));
    bl.tick(dt);
    for (const r of this.rigs) {
      const side = turnSignal(r.bot.m);
      if (!side && !r.blink && !r.blinkTrailer) continue;
      r.blink ??= bl.make(r.truck.visual, r.rec.carNode);
      if (r.trailer) r.blinkTrailer ??= bl.make(r.trailer.visual, r.trailer.rec.carNode, null, true);
      if (r.blink) bl.show(r.blink, side);
      if (r.blinkTrailer) bl.show(r.blinkTrailer, side);
    }
  }

  /**
   * Після кроку: візуал, рейси машин, перехід машина ↔ абстрактний; playerSpeed — швидкість гравця, м/с (абстрактні
   * їдуть не повільніше за неї, king.exe prescribeAdvance).
   */
  after(dt: number, player: THREE.Vector3, alpha = 1, playerSpeed = 0): void {
    for (const r of this.rigs) {
      // Розрив зчіпки (складання, перекидання) — причіп прибираємо (гіпотеза порту: у king.exe лишається на дорозі).
      if (r.trailer?.broken) this.unhitch(r);
      r.truck.syncVisual(alpha);
      r.trailer?.syncVisual(alpha);
    }
    this.updateLights(player);
    this.updateSignals(dt);
    // Рейси: прибуття на місце складу, вантаження й розвантаження, наступний рейс.
    if (this.freight)
      for (const r of this.list) {
        if (!r.job) continue;
        const { job, event } = this.freight.step(r.job, r.truck.visual.position, r.truck.speedKmh, dt, this.capacity(r));
        if (event) this.loadCargo(r, event.cargo);
        if (job !== r.job) this.setJob(r, job);
      }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
      r.bad = up < 0.5 ? r.bad + dt : 0;
      r.idle = r.truck.speedKmh < 2 ? r.idle + dt : 0;
      // Застряг (уперся після удару, причіп зачепився) — абстрактним, щойно не видно (як трафік; порт).
      const stuck = r.idle > STUCK_FOR && !(this.drive.traffic?.view?.sees(r.truck.visual.position) ?? false);
      const far = r.truck.visual.position.distanceTo(player) > PHYS_OFF;
      const line = this.roads.nearest(r.truck.visual.position);
      const fell = r.truck.body.translation().y < -500;
      if (stuck || far || r.bad > 3 || fell || (line && !this.loaded(line.line.region))) this.demote(i, stuck || r.bad > 3, fell);
    }
    this.fleetStep(dt, player, playerSpeed);
  }

  /** Відновити далекобійників світу зі збереження кар'єри (до першого after). */
  restore(saved: readonly SavedTrucker[]): void {
    if (!this.fleet) this.saved = saved;
  }

  /** Стан далекобійників світу для збереження (машини — з поточною позицією). */
  snapshot(): SavedTrucker[] | undefined {
    if (!this.fleet) return this.saved ? [...this.saved] : undefined;
    for (const r of this.list) if (r.member) this.fleet.place(r.member, r.truck.visual.position, r.truck.forward().setY(0).normalize());
    return this.fleet.snapshot();
  }

  /** Усі далекобійники світу: збережені чи нові на випадкових дорогах (машина — з evehicles.sch класу trucker). */
  private makeFleet(player: THREE.Vector3): Fleet | null {
    const all = this.records();
    const pool = this.kinds.length
      ? this.kinds.filter((k) => all.some((r) => r.carNode === k.model))
      : all.filter((r) => r.group === 'lorries').map((r) => ({ model: r.carNode, variant: 0 }));
    if (!pool.length) return null;
    const f = new Fleet(this.roads, this.freight, (m) => this.memberCapacity(m));
    if (this.saved?.length) f.restore(this.saved.filter((v) => all.some((r) => r.carNode === v.model)), this.semis);
    else {
      const lines = f.startLines();
      for (let i = 0; i < this.size; i++) {
        const k = pool[Math.floor(Math.random() * pool.length)];
        const rec = all.find((r) => r.carNode === k.model)!;
        const name = this.names.length ? this.names[i % this.names.length] : rec.carNode;
        f.add(name, k.model, k.variant, this.pickSemi(rec), player, START_AWAY, lines);
      }
    }
    this.saved = null;
    return f;
  }

  /**
   * Далекобійники світу: абстрактний рух і рейси; ближчі PHYS_ON у завантаженому регіоні стають машинами (ближчі —
   * першими, не більше max).
   */
  private fleetStep(dt: number, player: THREE.Vector3, playerSpeed: number): void {
    const f = (this.fleet ??= this.makeFleet(player));
    if (!f) return;
    // Абстрактні водії (далі PHYS_ON, їх не видно) — раз на FLEET_EVERY с за весь час (оптимізація для телефона:
    // 50 водіїв щокадру — 0,3 мс на ПК); рейси без рейсу — щокадру, по два.
    f.assignJobs();
    this.fleetAcc += dt;
    if (this.fleetAcc >= FLEET_EVERY) {
      f.tick(this.fleetAcc, Math.max(HIRED_MIN_SPEED, playerSpeed));
      this.fleetAcc = 0;
    }
    if ((this.timer -= dt) > 0) return;
    this.timer = PROMOTE_EVERY;
    if (this.list.length >= this.max) return;
    const near = f.members
      .filter((m) => !m.physical && !m.off && m.hold <= 0 && this.loaded(m.line.region))
      .map((m) => ({ m, ...f.at(m) }))
      .map((c) => ({ ...c, d: c.pos.distanceTo(player) }))
      .filter((c) => c.d < PHYS_ON)
      .sort((a, b) => a.d - b.d);
    for (const c of near) {
      if (this.list.length >= this.max) break;
      if (c.d < FREE_R || this.rigs.some((r) => r.truck.visual.position.distanceTo(c.pos) < FREE_R)) continue;
      if (c.m.hidden && (this.drive.traffic?.view?.sees(c.pos) ?? false)) continue;
      this.materialize(c.m, c.pos, c.forward);
    }
  }

  /** Далекобійник світу стає машиною: та сама модель, напівпричіп, вантаж і рейс. */
  private materialize(m: FleetMember, pos: THREE.Vector3, forward: THREE.Vector3): void {
    const rec = this.records().find((r) => r.carNode === m.model);
    const r = rec && this.make(rec, m.variant, pos, forward, m.name, m.semi);
    if (!r) return;
    r.member = m;
    m.physical = true;
    m.hidden = false;
    this.list.push(r);
    if (!m.job) this.fleet?.startJob(m);
    this.loadCargo(r, m.cargo);
    if (m.job) this.setJob(r, m.job);
  }

  /**
   * Машина знову абстрактна: позиція — проєкція на свою смугу, рейс і вантаж лишаються (напівпричіп, відірваний у
   * машини, повертається — порт). trouble — перекинулась чи застрягла: машиною знову не раніше HOLD і поза видимістю.
   */
  private demote(i: number, trouble: boolean, lost = false): void {
    const r = this.list[i];
    const m = r.member;
    if (m && this.fleet) {
      if (!lost) this.fleet.place(m, r.truck.visual.position, r.truck.forward().setY(0).normalize());
      m.physical = false;
      if (trouble || lost) {
        m.hold = HOLD;
        m.hidden = true;
      }
    }
    this.remove(i);
  }

  /**
   * Фари ботів (порт, як у трафіку — на прохання користувача): уночі фари, габарити й задні вогні-габарити тягача й
   * причепа (StopFaraKey стан 2), світлові плями на дорозі; найближча зустрічна — кандидат на справжні прожектори.
   */
  private updateLights(player: THREE.Vector3): void {
    const R = this.drive.traffic?.view?.range() ?? 400;
    let best: Truckers['spot'] = null;
    for (const r of this.rigs) {
      if (r.lit !== this.lights) {
        r.lit = this.lights;
        const on = r.lit ? 1 : 0;
        for (const sw of [r.setSwitch, r.trailer?.setSwitch]) {
          sw?.('refer_HeadLightKey', on);
          sw?.('refer_SizeLightKey', on);
          sw?.('StopFaraKeyL', on ? 2 : 0);
          sw?.('StopFaraKeyR', on ? 2 : 0);
          sw?.('BackFaraKeyL', 0);
          sw?.('BackFaraKeyR', 0);
        }
      }
      const host = r.truck.visual;
      if (!r.lit) {
        if (r.pool) disposePool(r.pool);
        r.pool = null;
        continue;
      }
      const [fl, fr] = r.faras;
      if (!r.pool) {
        r.pool = makePool(r.truck.lightGeometry.groundY, fl.z, fl.x, fr.x);
        host.add(r.pool);
      }
      const d = host.position.distanceTo(player);
      const to = player.clone().sub(host.position).setY(0).normalize();
      if (this.spotWanted && d < SPOT_RANGE && d < (best?.dist ?? Infinity) && r.truck.forward().setY(0).normalize().dot(to) >= SPOT_FACING) {
        const left = host.localToWorld(fl.clone());
        const right = host.localToWorld(fr.clone());
        const dir = host.localToWorld(fl.clone().add(new THREE.Vector3(0, 0, -20))).sub(left).normalize();
        best = { left, right, dir, dist: d, rig: r };
      }
      setPoolFade(r.pool, THREE.MathUtils.clamp((R - d) / (0.3 * R), 0, 1));
    }
    this.spot = best;
    // Прожектори світять за пляму: її сховати (drive вирішує, чи віддати їх боту, — spotTaken з минулого кадру).
    if (best && this.spotTaken && best.rig.pool) setPoolFade(best.rig.pool, 1 - spotShare(best.dist));
  }

  private remove(i: number): void {
    const r = this.list[i];
    if (r.pool) disposePool(r.pool);
    this.unhitch(r);
    this.drive.world.scene.remove(r.truck.visual);
    r.truck.dispose();
    this.list.splice(i, 1);
  }

  /** Найближчий суперник-машина в межах dist, м. */
  nearest(p: THREE.Vector3, dist = 40): Rival | null {
    let best: Rival | null = null;
    let bd = dist;
    for (const r of this.list) {
      const d = r.truck.visual.position.distanceTo(p);
      if (d < bd) {
        bd = d;
        best = r;
      }
    }
    return best;
  }

  dispose(): void {
    for (let i = this.list.length - 1; i >= 0; i--) this.remove(i);
    for (const name of [...this.hired.keys()]) this.dropHired(name);
  }
}

/** Місткість для замовлень: причіп (якщо є) чи кузов; цистерна — причіп типу 3. */
function capacityOf(rec: ReturnType<typeof drivable>[number], trailer: ReturnType<typeof drivable>[number] | null): FreightCapacity {
  const t = trailer ?? rec;
  return { mass: t.cargoLoad, volume: Math.max(1, t.bodySquare * t.bodyHeight), tanker: trailer?.trailerType === 3, trailer: !!trailer };
}
