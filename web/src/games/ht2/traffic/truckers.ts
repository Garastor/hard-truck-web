import * as THREE from 'three';
import { kingCar, kingPilot } from '../vehicles/controls';
import { AutoPilot, type Oncoming } from '../engine/vehicle/autopilot';
import { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { buildTruckModel } from '../engine/vehicle/trucks';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import { drivable, truckDef, type Ht2Trucks } from '../vehicles/trucks';
import { Trailer } from '../vehicles/trailer';
import type { SemiKind } from '../vehicles/presents';
import { recolor } from './traffic';
import type { Ht2Roads, RoadLine } from '../world/roads';
import type { Ht2Drive } from '../drive';

/**
 * Далекобійники-суперники HT2 (перша версія): у світі їх 50 (`ENV/GAME.CNF`: `(aitruck 50)`), імена — `names.sch`
 * (`("ВИТАЛИЙ" male trucker 1)`). Порт не моделює всіх 50 — довкола гравця їздять до MAX вантажівок з кузовом
 * і тягачів (клас trucker типів lorry і tractor з evehicles.sch: `(vehicle MERCEDES_LORRY2 "MercedesR" 1 lorry
 * trucker …)`, `(vehicle VOLVO_TRACTOR1 "Volvo" 0 tractor trucker …)`, число — варіант фарбування) на тому ж автопілоті,
 * що й гравець (клавіша P): зʼявляються на дорогах завантажених регіонів за SPAWN_MIN…SPAWN_MAX від гравця, зникають
 * далі за DESPAWN або перекинувшись. Це повноцінні тіла фізики: зіткнення з ними — як з гравцем. Тягач — одразу з
 * напівпричепом (тип — як presents: SEMITRAILER1–6, SEMITANK1–4, у «Шторма» — URAGAN_SEMITRAILER; гіпотеза порту: у
 * king.exe ШІ бере причіп сам, як гравець) і вантажем 30–100 % вантажопідйомності. Замовлень і торгівлі вони поки не
 * ведуть (гіпотеза: у грі — конкуренти за вантажі).
 */
const MAX = 4;
/** Найманий водій гравця стає машиною ближче HIRED_ON і знову абстрактним далі HIRED_OFF, м (career/hired.ts). */
const HIRED_ON = 300;
const HIRED_OFF = 450;
const SPAWN_MIN = 140;
const SPAWN_MAX = 450;
const DESPAWN = 650;
/** Стоїть довше — застряг, с. */
const STUCK_FOR = 30;

export interface Rival {
  name: string;
  truck: TruckVehicle;
  pilot: AutoPilot;
  bad: number;
  /** Напівпричіп тягача (null — вантажівка з кузовом чи причіп відірвало). */
  trailer: Trailer | null;
  /** Скільки стоїть (швидкість < 2 км/год), с. */
  idle: number;
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
  private timer = 0;
  private nameIndex = Math.floor(Math.random() * 51);

  constructor(
    private readonly drive: Ht2Drive,
    private readonly roads: Ht2Roads,
    private readonly names: string[],
    private readonly loaded: (region: string) => boolean,
    private readonly kinds: { model: string; variant: number }[] = [],
    private readonly max = MAX,
    /** Типи напівпричепів (evehicles.sch, presents.semiKinds) — для тягачів. */
    private readonly semis: SemiKind[] = [],
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
    for (const [name, r] of this.hired) {
      const far = r.truck.visual.position.distanceTo(player) > HIRED_OFF;
      const line = this.roads.nearest(r.truck.visual.position);
      if (!names.has(name) || far || (line && !this.loaded(line.line.region)) || r.truck.body.translation().y < -500) this.dropHired(name);
    }
    for (const w of want) {
      if (this.hired.has(w.name) || w.pos.distanceTo(player) > HIRED_ON) continue;
      const line = this.roads.nearest(w.pos);
      if (!line || !this.loaded(line.line.region)) continue;
      const rec = drivable(this.drive.trucksData).find((r) => r.carNode === w.carNode);
      const r = rec && this.make(rec, 0, w.pos, w.forward, w.name);
      if (r) this.hired.set(w.name, r);
    }
  }

  /** Прибрати машину найманого (стане абстрактним; поміняв машину — зʼявиться з новою моделлю). */
  dropHired(name: string): void {
    const r = this.hired.get(name);
    if (!r) return;
    this.unhitch(r);
    this.drive.world.scene.remove(r.truck.visual);
    r.truck.dispose();
    this.hired.delete(name);
  }

  /** Машина далекобійника з автопілотом у точці дороги. */
  private make(rec: ReturnType<typeof drivable>[number], variant: number, at: THREE.Vector3, forward: THREE.Vector3, name: string): Rival | null {
    const def = truckDef(this.drive.trucksData, rec);
    const model = def && buildTruckModel(this.drive.trucksData.asm, def, false);
    if (!def || !model) return null;
    if (variant > 0) recolor(model.root, this.drive.trucksData, variant + 1);
    // Рух king.exe, як у гравця (kingModel), автопілот — переслідування по дузі з базою машини.
    const truck = new TruckVehicle(this.drive.rapierWorld, def, model, { position: this.drive.groundAtPublic(at), forward }, kingCar(rec.suspension));
    this.drive.world.scene.add(truck.visual);
    const pilot = kingPilot(new AutoPilot(this.roads), truck.base);
    pilot.cruise = 50 + Math.random() * 25;
    pilot.dodge = false;
    const trailer = rec.group === 'tractors' ? this.hitch(truck, rec) : null;
    // З напівпричепом — повільніше в поворотах, як автопілот гравця (drive: команда autopilot).
    if (trailer) Object.assign(pilot, { cruise: 45 + Math.random() * 10, bendGain: 5, bendFloor: 0.25 });
    return { name, truck, pilot, bad: 0, trailer, idle: 0 };
  }

  /** Напівпричіп тягача (як drive.hitch): тип — випадковий з presents, у «Шторма» — свій; вантаж — частка місткості. */
  private hitch(truck: TruckVehicle, rec: ReturnType<typeof drivable>[number]): Trailer | null {
    const storm = /^Storm/i.test(rec.carNode);
    const pool = this.semis.filter((k) => /^STrailerStorm$/i.test(k.carNode) === storm);
    const kind = pool[Math.floor(Math.random() * pool.length)];
    const trucks = this.drive.trucksData;
    const tr = kind && trucks.records.find((r) => r.carNode.toLowerCase() === kind.carNode.toLowerCase());
    const def = tr && truckDef(trucks, tr);
    if (!kind || !tr || !def) return null;
    const cargo = Math.min(tr.cargoLoad, rec.cargoLoad || tr.cargoLoad) * (0.3 + 0.7 * Math.random());
    const paint = kind.cluster > 0 ? (root: THREE.Object3D) => recolor(root, trucks, kind.cluster + 1) : undefined;
    const trailer = new Trailer(this.drive.rapierWorld, trucks.asm, def, tr, { body: truck.body, saddle: rec.lowSaddle }, cargo, paint);
    this.drive.world.scene.add(trailer.visual);
    truck.towing = true;
    const handle = trailer.body.handle;
    truck.rayFilter = (c) => c.parent()?.handle !== handle;
    truck.setTowLoad(trailer.kingpinLoad);
    truck.tow = { mass: trailer.mass, wheels: trailer.wheelCount };
    return trailer;
  }

  /** Відчепити й прибрати напівпричіп (розрив зчіпки чи машина зникає). */
  private unhitch(r: Rival): void {
    if (!r.trailer) return;
    this.drive.world.scene.remove(r.trailer.visual);
    r.trailer.dispose();
    r.trailer = null;
    r.truck.towing = false;
    r.truck.rayFilter = undefined;
    r.truck.setTowLoad(0);
    r.truck.tow = null;
  }

  /**
   * Перед кроком фізики: автопілот кожного (оминає гравця, трафік і одне одного); oncoming — інші машини з курсом
   * (гравець, трафік), з якими розминатися, коли їдуть назустріч (боти — додаються тут).
   */
  control(dt: number, obstacles: readonly THREE.Vector3[], oncoming: readonly Oncoming[] = []): void {
    const rigs = this.rigs;
    const points = rigs.map(rigPoints);
    const heads = rigs.map((r): Oncoming => ({ pos: r.truck.visual.position, forward: r.truck.forward().setY(0).normalize() }));
    rigs.forEach((r, i) => {
      const p = r.truck.body.translation();
      const others = [...obstacles, ...points.filter((_, j) => j !== i).flat()];
      const meet = [...oncoming, ...heads.filter((_, j) => j !== i)];
      const state = r.pilot.update(new THREE.Vector3(p.x, p.y, p.z), r.truck.forward(), r.truck.speedKmh, dt, others, meet);
      r.truck.update(dt, state);
      r.trailer?.update(dt, r.truck.brakePedal(state), r.truck.def.tech.brakePower, r.truck.kinematic);
    });
  }

  /** Після кроку: візуал, поява й зникнення. */
  after(dt: number, player: THREE.Vector3, alpha = 1): void {
    for (const r of this.rigs) {
      // Розрив зчіпки (складання, перекидання) — причіп прибираємо (гіпотеза порту: у king.exe лишається на дорозі).
      if (r.trailer?.broken) this.unhitch(r);
      r.truck.syncVisual(alpha);
      r.trailer?.syncVisual(alpha);
    }
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
      r.bad = up < 0.5 ? r.bad + dt : 0;
      r.idle = r.truck.speedKmh < 2 ? r.idle + dt : 0;
      // Застряг (уперся після удару, причіп зачепився) — прибрати, щойно не видно (як трафік; порт).
      const stuck = r.idle > STUCK_FOR && !(this.drive.traffic?.view?.sees(r.truck.visual.position) ?? false);
      const far = stuck || r.truck.visual.position.distanceTo(player) > DESPAWN;
      const line = this.roads.nearest(r.truck.visual.position);
      if (far || r.bad > 3 || (line && !this.loaded(line.line.region)) || r.truck.body.translation().y < -500) this.remove(i);
    }
    if ((this.timer -= dt) > 0 || this.list.length >= this.max) return;
    this.timer = 2;
    this.spawn(player);
  }

  private spawn(player: THREE.Vector3): void {
    // Не на під'їздах заправок і СТО (порт, world/roads markStations).
    const lines = this.roads.lines.filter((l) => !l.station && this.loaded(l.region));
    const all = drivable(this.drive.trucksData);
    const pool = this.kinds.length
      ? this.kinds.map((k) => ({ rec: all.find((r) => r.carNode === k.model)!, variant: k.variant }))
      : all.filter((r) => r.group === 'lorries').map((rec) => ({ rec, variant: 0 }));
    if (!lines.length || !pool.length) return;
    for (let attempt = 0; attempt < 10; attempt++) {
      const line: RoadLine = lines[Math.floor(Math.random() * lines.length)];
      const seg = Math.floor(Math.random() * (line.pts.length - 1));
      const a = line.pts[seg];
      const b = line.pts[seg + 1];
      const d = a.distanceTo(player);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (this.list.some((r) => r.truck.visual.position.distanceTo(a) < 40)) continue;
      const { rec, variant } = pool[Math.floor(Math.random() * pool.length)];
      const forward = b.clone().sub(a).setY(0).normalize();
      const name = this.names.length ? this.names[this.nameIndex++ % this.names.length] : rec.carNode;
      const r = this.make(rec, variant, a, forward, name);
      if (r) this.list.push(r);
      return;
    }
  }

  private remove(i: number): void {
    const r = this.list[i];
    this.unhitch(r);
    this.drive.world.scene.remove(r.truck.visual);
    r.truck.dispose();
    this.list.splice(i, 1);
  }

  /** Найближчий суперник у межах dist, м. */
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
