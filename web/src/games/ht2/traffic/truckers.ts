import * as THREE from 'three';
import { HT2_ENGINE, HT2_ROLL_LIFT, HT2_STEER_LIMIT, HT2_STEER_POWER, HT2_BRAKE } from '../vehicles/controls';
import { AutoPilot } from '@engine/vehicle/autopilot';
import { TruckVehicle } from '@engine/vehicle/truckVehicle';
import { buildTruckModel } from '@engine/vehicle/trucks';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import { drivable, truckDef, type Ht2Trucks } from '../vehicles/trucks';
import { recolor } from './traffic';
import type { Ht2Roads, RoadLine } from '../world/roads';
import type { Ht2Drive } from '../drive';

/**
 * Далекобійники-суперники HT2 (перша версія): у світі їх 50 (`ENV/GAME.CNF`: `(aitruck 50)`), імена — `names.sch`
 * (`("ВИТАЛИЙ" male trucker 1)`). Порт не моделює всіх 50 — довкола гравця їздять до MAX вантажівок з кузовом
 * (клас trucker типу lorry з evehicles.sch: `(vehicle MERCEDES_LORRY2 "MercedesR" 1 lorry trucker …)`, число —
 * варіант фарбування) на тому ж автопілоті, що й гравець (клавіша P): зʼявляються на дорогах завантажених
 * регіонів за SPAWN_MIN…SPAWN_MAX від гравця, зникають далі за DESPAWN або перекинувшись. Це повноцінні тіла фізики:
 * зіткнення з ними — як з гравцем. Замовлень і торгівлі вони поки не ведуть (гіпотеза: у грі — конкуренти за вантажі).
 */
const MAX = 4;
const SPAWN_MIN = 140;
const SPAWN_MAX = 450;
const DESPAWN = 650;

export interface Rival {
  name: string;
  truck: TruckVehicle;
  pilot: AutoPilot;
  bad: number;
}

/** Машини далекобійників з evehicles.sch: тип lorry, клас trucker, модель є серед вантажівок (vehicle.tech). */
export function truckerKinds(sch: SExpr[], trucks: Ht2Trucks): { model: string; variant: number }[] {
  const ok = new Set(drivable(trucks).map((r) => r.carNode));
  return sch
    .filter((e): e is SExpr[] => isList(e) && e[0] === 'vehicle' && e[4] === 'lorry' && (e[5] === 'trucker' || (isList(e[5]) && e[5].includes('trucker'))))
    .map((e) => ({ model: str(e[2]), variant: num(e[3]) }))
    .filter((k) => ok.has(k.model));
}

/** Імена далекобійників з names.sch. */
export function truckerNames(sch: SExpr[]): string[] {
  return sch.filter((e): e is SExpr[] => isList(e) && e[2] === 'trucker').map((e) => str(e[0]));
}

export class Truckers {
  readonly list: Rival[] = [];
  private timer = 0;
  private nameIndex = Math.floor(Math.random() * 51);

  constructor(
    private readonly drive: Ht2Drive,
    private readonly roads: Ht2Roads,
    private readonly names: string[],
    private readonly loaded: (region: string) => boolean,
    private readonly kinds: { model: string; variant: number }[] = [],
    private readonly max = MAX,
  ) {}

  get positions(): THREE.Vector3[] {
    return this.list.map((r) => r.truck.visual.position);
  }

  /** Перед кроком фізики: автопілот кожного (оминає гравця, трафік і одне одного). */
  control(dt: number, obstacles: readonly THREE.Vector3[]): void {
    for (const r of this.list) {
      const p = r.truck.body.translation();
      const others = [...obstacles, ...this.positions.filter((o) => o !== r.truck.visual.position)];
      r.truck.update(dt, r.pilot.update(new THREE.Vector3(p.x, p.y, p.z), r.truck.forward(), r.truck.speedKmh, dt, others));
    }
  }

  /** Після кроку: візуал, поява й зникнення. */
  after(dt: number, player: THREE.Vector3): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      r.truck.syncVisual();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
      r.bad = up < 0.5 ? r.bad + dt : 0;
      const far = r.truck.visual.position.distanceTo(player) > DESPAWN;
      const line = this.roads.nearest(r.truck.visual.position);
      if (far || r.bad > 3 || (line && !this.loaded(line.line.region)) || r.truck.body.translation().y < -500) this.remove(i);
    }
    if ((this.timer -= dt) > 0 || this.list.length >= this.max) return;
    this.timer = 2;
    this.spawn(player);
  }

  private spawn(player: THREE.Vector3): void {
    const lines = this.roads.lines.filter((l) => this.loaded(l.region));
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
      const def = truckDef(this.drive.trucksData, rec);
      const model = def && buildTruckModel(this.drive.trucksData.asm, def, false);
      if (!def || !model) return;
      if (variant > 0) recolor(model.root, this.drive.trucksData, variant + 1);
      const forward = b.clone().sub(a).setY(0).normalize();
      const truck = new TruckVehicle(this.drive.rapierWorld, def, model, { position: this.drive.groundAtPublic(a), forward }, { engine: HT2_ENGINE, rollLift: HT2_ROLL_LIFT, steerLimit: HT2_STEER_LIMIT, steerPower: HT2_STEER_POWER, brake: HT2_BRAKE });
      this.drive.world.scene.add(truck.visual);
      const pilot = new AutoPilot(this.roads);
      pilot.cruise = 50 + Math.random() * 25;
      const name = this.names.length ? this.names[this.nameIndex++ % this.names.length] : rec.carNode;
      this.list.push({ name, truck, pilot, bad: 0 });
      return;
    }
  }

  private remove(i: number): void {
    const r = this.list[i];
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
  }
}
