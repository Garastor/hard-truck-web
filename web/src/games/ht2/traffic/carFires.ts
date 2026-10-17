import * as THREE from 'three';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';

/**
 * Вогонь машин ІІ (king.exe 0x549900 / 0x549960, 0x54e180, 0x554c20, 0x551970; re/notes/ht2/police.md «Займання
 * від куль і ударів — звірка»): трафік, міліція, мафія, далекобійники, суперники. Гравцевий вогонь — у drive.ts
 * (протипожежна система, кінець гри); тут — спільне поширення між машинами.
 * - кулі: будь-яка машина, у яку влучила куля, займається з імовірністю g·P·0,03/(P + 0,3), g = 1 (звичайне скло);
 * - удар об нерухоме з силою (зміна швидкості) понад IMPACT м/с, поруч немає машини;
 * - поширення: машина, що не горить, з точкою двигуна ближче SPREAD_R до точки двигуна палаючої безперервно понад
 *   SPREAD_T с;
 * - через BURN_T с горіння — «згоріло» (стан 3): полумʼя зникає, двигун мертвий, повторно не займається;
 * - вибух `_Blow` — раз за пожежу; момент у exe залежить від невідомого коефіцієнта моделі (0x697db8) — порт
 *   вибухає одразу після займання [Г].
 */
const IMPACT = 35;
const SPREAD_R = Math.sqrt(10);
const SPREAD_T = 5;
const BURN_T = 60;
/** «Поруч машина» для удару, м (як у гравця). */
const CAR_NEAR = 10;

/** Точка двигуна (полумʼя): у передній третині машини, 1,5 м над центром [Г, як у гравця]. */
export function enginePoint(v: TruckVehicle): THREE.Vector3 {
  const p = v.visual.position;
  return p.clone().addScaledVector(v.forward(), 2).setY(p.y + 1.5);
}

/** Імовірність займання від кулі сили P зі склом g (0x567440). */
export function shotIgnition(power: number, glass = 1): number {
  return (glass * power * 0.03) / (power + 0.3);
}

export interface FireFx {
  /** Полумʼя машини в точці (Three.js) чи null — погасити. */
  fire(key: TruckVehicle, p: THREE.Vector3 | null): void;
  /** Вибух машини в точці (Three.js). */
  blow(p: THREE.Vector3): void;
}

/** Гравець для поширення вогню. */
export interface FirePlayer {
  v: TruckVehicle;
  burning: boolean;
}

export class CarFires {
  /** Палаючі машини: секунд від займання. */
  private readonly lit = new Map<TruckVehicle, number>();
  /** Згорілі (стан 3). */
  private readonly burnt = new WeakSet<TruckVehicle>();
  /** Скільки секунд машина (чи гравець) безперервно біля палаючої. */
  private readonly near = new Map<TruckVehicle, number>();
  private readonly prevVel = new WeakMap<TruckVehicle, THREE.Vector3>();

  constructor(private readonly fx: FireFx) {}

  burning(v: TruckVehicle): boolean {
    return this.lit.has(v);
  }

  get count(): number {
    return this.lit.size;
  }

  /** Займання машини ІІ (з 0 — лише машина, що не горить і не згоріла). */
  ignite(v: TruckVehicle): void {
    if (this.lit.has(v) || this.burnt.has(v)) return;
    this.lit.set(v, 0);
    this.fx.blow(enginePoint(v));
  }

  /** Куля сили power влучила в машину ІІ. */
  shot(v: TruckVehicle, power: number): void {
    if (Math.random() < shotIgnition(power)) this.ignite(v);
  }

  /**
   * Крок: cars — усі фізичні машини ІІ зараз (решту забуто), player — гравець. Повертає true, якщо гравець має
   * зайнятися від сусіда (займає drive.ts — з урахуванням щойно погашеного).
   */
  update(dt: number, cars: readonly TruckVehicle[], player: FirePlayer): boolean {
    const alive = new Set(cars);
    for (const v of [...this.lit.keys()])
      if (!alive.has(v)) {
        this.lit.delete(v);
        this.fx.fire(v, null);
      }
    for (const v of [...this.near.keys()]) if (v !== player.v && !alive.has(v)) this.near.delete(v);
    // Удари об нерухоме.
    for (const v of cars) {
      const lv = v.body.linvel();
      const vel = new THREE.Vector3(lv.x, 0, lv.z);
      const prev = this.prevVel.get(v);
      this.prevVel.set(v, vel);
      if (!prev || vel.distanceTo(prev) <= IMPACT) continue;
      const p = v.visual.position;
      const crowd = cars.some((o) => o !== v && o.visual.position.distanceTo(p) < CAR_NEAR) || player.v.visual.position.distanceTo(p) < CAR_NEAR;
      if (!crowd) this.ignite(v);
    }
    // Горіння й «згоріло».
    for (const [v, t] of this.lit) {
      const now = t + dt;
      if (now >= BURN_T) {
        this.lit.delete(v);
        this.burnt.add(v);
        v.engineOn = false;
        this.fx.fire(v, null);
        continue;
      }
      this.lit.set(v, now);
      this.fx.fire(v, enginePoint(v));
    }
    // Поширення: джерела — палаючі машини ІІ і гравець.
    const sources = [...this.lit.keys()].map(enginePoint);
    if (player.burning) sources.push(enginePoint(player.v));
    let catchPlayer = false;
    for (const v of [...cars, player.v]) {
      const isPlayer = v === player.v;
      if (isPlayer ? player.burning : this.lit.has(v) || this.burnt.has(v)) {
        this.near.delete(v);
        continue;
      }
      const e = enginePoint(v);
      // Своє джерело (сам гравець) не рахується: він не горить, тож його точки серед джерел немає.
      const close = sources.some((s) => s.distanceTo(e) < SPREAD_R);
      const t = close ? (this.near.get(v) ?? 0) + dt : 0;
      if (t > SPREAD_T) {
        this.near.delete(v);
        if (isPlayer) catchPlayer = true;
        else this.ignite(v);
      } else if (t > 0) this.near.set(v, t);
      else this.near.delete(v);
    }
    return catchPlayer;
  }

  dispose(): void {
    for (const v of this.lit.keys()) this.fx.fire(v, null);
    this.lit.clear();
  }
}
