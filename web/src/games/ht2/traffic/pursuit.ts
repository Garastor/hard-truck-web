import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { ControlState } from '../engine/input/input';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { HT2_KING } from '../vehicles/controls';
import { Navigator } from '../world/navigator';
import type { Ht2Roads, RoadLine } from '../world/roads';

/**
 * Погоня фізичною машиною за гравцем — спільне для міліції й мафії (king.exe: маршрут дорогами updateChasedCars,
 * тактична точка 0x566970, стрілянина 0x567440; re/notes/ht2/police.md §4–5, mafia.md). Логіка — з police.ts
 * (сесія міліції), винесена й параметризована; police.ts поки на власній копії (переведення — окремо).
 *
 * Гіпотези порту (як у police.ts): швидкість за кривизною маршруту v² ≤ a/κ із запасом на гальмування; позаду
 * цілі — обгін лівою смугою; машина попереду в коридорі — обʼїзд убік; ціль позаду — розворот на повному кермі;
 * застрягла — назад з протилежним кермом.
 */
const CRUISE = 30;
const ROAD_LOOK = 6;
const OVERTAKE_R = 40;
const NEAR_GOAL = 150;
const OVERTAKE_SIDE = 4.5;
const BLOCK_AHEAD = 12;
const BEND_SAMPLES = 8;
const BEND_STEP = 10;
const BEND_ACCEL = 6;
const BEND_BRAKE = 4;
const U_TURN = 1.6;
const U_TURN_SPEED = 5;
const STUCK_AFTER = 2;
const REVERSE_FOR = 2;
const ROUTE_EVERY = 3;

/** Ціль погоні (гравець). */
export interface Quarry {
  body: RAPIER.RigidBody;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  /** Швидкість, м/с (вектор). */
  vel: THREE.Vector3;
  /** Скло g (0x567440, гравець+0x5308): шкода й займання від куль ×g; броньоване — 0,2. */
  glass?: number;
}

/** Машина-переслідувач: фізика й стан керування. */
export interface Chaser {
  v: TruckVehicle;
  ctrl: ControlState;
  /** Застрягання: скільки стоїть з газом, скільки ще здавати назад, кермо назад, спроб поспіль. */
  stuck: number;
  reverse: number;
  revSteer: number;
  tries: number;
  /** Бічний зсув обʼїзду, м (ліворуч — додатний). */
  offset: number;
}

export function newChaser(v: TruckVehicle): Chaser {
  return { v, ctrl: { steer: 0, throttle: 0, brake: 0, handbrake: true }, stuck: 0, reverse: 0, revSteer: 0, tries: 0, offset: 0 };
}

/** Кут коліс δ → кермо (обернене до δ = 45°·a·|s|^p, HT2_KING). */
function steerFor(delta: number): number {
  const k = HT2_KING;
  return Math.sign(delta) * (Math.abs(delta) / (Math.PI / 4) / k.steerScale) ** (1 / k.steerPower);
}

/** Маршрут дорогами до цілі (updateChasedCars: перерахунок раз на ROUTE_EVERY с). */
export class ChaseRoute {
  private nav: Navigator | null = null;
  private route: Map<RoadLine, number> | null = null;
  readonly goal = new THREE.Vector3();
  private timer = 0;

  constructor(private readonly roads: Ht2Roads) {}

  update(dt: number, goal: THREE.Vector3): void {
    if ((this.timer -= dt) > 0 && this.route) return;
    this.timer = ROUTE_EVERY;
    this.goal.copy(goal);
    this.nav ??= new Navigator(this.roads);
    this.route = this.nav.distances(this.goal);
  }

  /** Лінія біля цілі (маршрут «прибув»). */
  arrived(line: RoadLine): boolean {
    return this.route?.get(line) === 0;
  }

  /** Точка дорогами в бік цілі: уздовж смуги, на кінці — продовження з найкоротшим шляхом. */
  point(pos: THREE.Vector3, fwd: THREE.Vector3, ahead: number): THREE.Vector3 {
    if (!this.route) return this.goal.clone();
    const dist = this.route;
    const cost = (m: { line: RoadLine; seg: number; t: number } | null) => {
      if (!m) return Infinity;
      let rest = m.line.pts[m.seg].clone().lerp(m.line.pts[m.seg + 1], m.t).distanceTo(m.line.pts[m.seg + 1]);
      for (let i = m.seg + 1; i + 1 < m.line.pts.length; i++) rest += m.line.pts[i].distanceTo(m.line.pts[i + 1]);
      return rest + (dist.get(m.line) ?? Infinity);
    };
    const own = this.roads.nearest(pos, fwd);
    const back = this.roads.nearest(pos, fwd.clone().negate());
    const n = cost(back) + 30 < cost(own) ? back : own;
    if (!n || n.dist > 30) return this.goal.clone();
    let l: RoadLine = n.line;
    let cur = l.pts[n.seg].clone().lerp(l.pts[n.seg + 1], n.t);
    let left = ahead;
    let i = n.seg + 1;
    for (let guard = 0; guard < 200; guard++) {
      if (i >= l.pts.length) {
        if (!l.next.length) return cur;
        let best = l.next[0] as RoadLine;
        for (const x of l.next) if ((dist.get(x as RoadLine) ?? Infinity) < (dist.get(best) ?? Infinity)) best = x as RoadLine;
        l = best;
        i = 1;
        continue;
      }
      const d = cur.distanceTo(l.pts[i]);
      if (d >= left) return cur.lerp(l.pts[i], left / d);
      left -= d;
      cur = l.pts[i].clone();
      i++;
    }
    return cur;
  }
}

export interface ChaseOptions {
  roads: Ht2Roads;
  route: ChaseRoute;
  /** Машини на дорозі (трафік, суперники) — обʼїжджати. */
  obstacles: readonly THREE.Vector3[];
  /** Ціль захоплено (тактичний рівень). */
  engaged: boolean;
  /** Ближче за це до цілі — тактична точка, м. */
  tacticalR: number;
  /** Випередження точки прицілу по курсу цілі, м (king.exe: 30 — обгін і вихід перед ціллю, 2,5…15 — щільно). */
  lead: number;
}

/** Керування переслідувача на кадр: дорогами до цілі, близько — тактична точка попереду цілі. */
export function steerChase(c: Chaser, q: Quarry, o: ChaseOptions, dt: number): void {
  const pos = c.v.visual.position;
  const fwd = c.v.forward();
  const d = pos.distanceTo(q.pos);
  const v = c.v.speedKmh / 3.6;
  const pv = q.vel.length();
  let target: THREE.Vector3;
  let want: number;
  let blocking = false;
  // Швидкість за кривизною маршруту попереду.
  let bendWant = CRUISE;
  let prev = pos.clone().setY(0);
  let dir = fwd.clone().setY(0).normalize();
  for (let k = 1; k <= BEND_SAMPLES; k++) {
    const p = o.route.point(pos, fwd, k * BEND_STEP).setY(0);
    const nd = p.clone().sub(prev);
    const len = nd.length();
    if (len < 1) break;
    nd.divideScalar(len);
    const kappa = Math.acos(THREE.MathUtils.clamp(nd.dot(dir), -1, 1)) / len;
    const vTurn = kappa > 1e-4 ? Math.sqrt(BEND_ACCEL / kappa) : CRUISE;
    bendWant = Math.min(bendWant, Math.sqrt(vTurn * vTurn + 2 * BEND_BRAKE * Math.max(0, (k - 1) * BEND_STEP)));
    prev = p;
    dir = nd;
  }
  bendWant = Math.max(bendWant, U_TURN_SPEED);
  const here = d < NEAR_GOAL ? o.roads.nearest(pos, fwd) : null;
  const arrived = !!here && o.route.arrived(here.line);
  if ((o.engaged || arrived) && (d < o.tacticalR || arrived)) {
    target = q.pos.clone().addScaledVector(q.forward, o.lead).addScaledVector(q.vel, 0.5);
    const rel = pos.clone().sub(q.pos);
    if (rel.dot(q.forward) < 5 && d < OVERTAKE_R) target.addScaledVector(new THREE.Vector3(q.forward.z, 0, -q.forward.x), OVERTAKE_SIDE);
    if (o.roads.offRoad(target)) {
      const m = o.roads.nearest(target);
      if (m) target = m.line.pts[m.seg].clone().lerp(m.line.pts[m.seg + 1], m.t);
    }
    const along = target.clone().sub(pos).dot(fwd);
    want = Math.min(bendWant + pv * 0.2, THREE.MathUtils.clamp(pv + 0.5 * along, 0, 40));
    const ahead = rel.dot(q.forward);
    const side = Math.abs(rel.x * q.forward.z - rel.z * q.forward.x);
    if (ahead > 0 && ahead < BLOCK_AHEAD && side < 3 && pv > 2) {
      blocking = true;
      if (fwd.dot(q.forward) > 0) {
        target = pos.clone().addScaledVector(q.forward, 20);
        want = pv + 4;
      } else {
        const left = new THREE.Vector3(q.forward.z, 0, -q.forward.x);
        const away = left.multiplyScalar(Math.sign(rel.dot(left)) || 1);
        target = pos.clone().addScaledVector(fwd, 6).addScaledVector(away, 12);
        want = U_TURN_SPEED;
      }
    }
  } else {
    target = o.route.point(pos, fwd, ROAD_LOOK + 0.8 * v);
    want = bendWant;
  }
  // Машина попереду в коридорі — обʼїзд убік, дуже близько — пригальмувати.
  const left = new THREE.Vector3(fwd.z, 0, -fwd.x);
  let block = Infinity;
  let sideSign = 1;
  for (const ob of o.obstacles) {
    const r = ob.clone().sub(pos);
    const ahead = r.dot(fwd);
    const lat = r.dot(left) - c.offset;
    if (ahead > 2 && ahead < 10 + 2 * v && Math.abs(lat) < 2.6 && ahead < block) {
      block = ahead;
      sideSign = lat >= 0 ? -1 : 1;
    }
  }
  const wantOffset = block < Infinity ? sideSign * OVERTAKE_SIDE : 0;
  c.offset += THREE.MathUtils.clamp(wantOffset - c.offset, -3 * dt, 3 * dt);
  target.addScaledVector(left, c.offset);
  if (block < 8) want = Math.min(want, 4);
  drive(c, target, want, blocking, dt);
}

/** Стояти на місці (пост, ціль утрачено). */
export function holdStill(c: Chaser): void {
  Object.assign(c.ctrl, { steer: 0, throttle: 0, brake: c.v.speedKmh < 2 ? 0 : 1, handbrake: c.v.speedKmh < 2 });
}

/** Їхати дорогами до точки (без цілі): відʼїзд, повернення. */
export function cruiseTo(c: Chaser, route: ChaseRoute, dt: number): void {
  const pos = c.v.visual.position;
  const fwd = c.v.forward();
  const v = c.v.speedKmh / 3.6;
  drive(c, route.point(pos, fwd, ROAD_LOOK + 0.8 * v), 15, false, dt);
}

/** Кермо на точку, газ/гальмо до швидкості want, розворот, застрягання. */
function drive(c: Chaser, target: THREE.Vector3, want: number, blocking: boolean, dt: number): void {
  const ctl = c.ctrl;
  const pos = c.v.visual.position;
  const fwd = c.v.forward();
  const v = c.v.speedKmh / 3.6;
  const to = target.clone().sub(pos).setY(0);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const angle = Math.atan2(to.dot(right), to.dot(fwd));
  const delta = Math.atan((2 * c.v.base * Math.sin(angle)) / Math.max(4, to.length()));
  ctl.steer = THREE.MathUtils.clamp(steerFor(delta), -1, 1);
  if (Math.abs(angle) > U_TURN && !blocking) {
    ctl.steer = Math.sign(angle) || 1;
    want = Math.min(want, U_TURN_SPEED);
  }
  if (c.reverse > 0) {
    c.reverse -= dt;
    Object.assign(ctl, { steer: c.revSteer, throttle: 0, brake: 1, handbrake: false });
    return;
  }
  c.stuck = want > 1.5 && v < 1 ? c.stuck + dt : 0;
  if (c.stuck > STUCK_AFTER) {
    c.stuck = 0;
    c.reverse = REVERSE_FOR;
    c.revSteer = -ctl.steer;
    c.tries++;
  }
  if (v > 8) c.tries = 0;
  const dv = want - v;
  ctl.handbrake = false;
  if (want < 0.1) {
    ctl.throttle = 0;
    ctl.brake = v < 0.5 ? 0 : 1;
    ctl.handbrake = v < 0.5;
  } else if (dv < 0) {
    ctl.throttle = 0;
    ctl.brake = Math.min(1, 0.5 * -dv);
  } else {
    ctl.throttle = Math.min(1, 0.3 + 0.2 * dv);
    ctl.brake = 0;
  }
}

/** Пряма видимість від машини до цілі (лише нерухомі колізії). */
export function lineOfSight(world: RAPIER.World, c: Chaser, q: Quarry): boolean {
  const from = c.v.visual.position.clone().setY(c.v.visual.position.y + 1.3);
  const to = q.pos.clone().setY(q.pos.y + 1.5);
  const dist = from.distanceTo(to);
  const hit = world.castRay(new RAPIER.Ray(from, to.sub(from).divideScalar(dist)), dist - 3, true, undefined, undefined, undefined, undefined, (col) => col.parent()?.isFixed() ?? true);
  return !hit;
}

/**
 * Постріл (0x567440): промінь на range м на ціль із відхиленням рискання ±spread рад; влучання — поштовх у тіло
 * (сила 0,1 × маса, у точці влучання).
 */
export function shoot(world: RAPIER.World, c: Chaser, q: Quarry, spread: number, range = 300): boolean {
  const from = c.v.visual.position.clone().setY(c.v.visual.position.y + 1.3);
  const dir = q.pos.clone().setY(q.pos.y + 1.5).sub(from).normalize();
  dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() * 2 - 1) * spread);
  return fireRay(world, from, dir, range, q, 0.1, c.v.body).hit;
}

/**
 * Промінь кулі (0x567440) з точки from у напрямку dir: влучання в ціль — поштовх force × маса в точці влучання;
 * point — куди влучила куля (null — нікуди). own — тіло стрільця (промінь крізь нього).
 */
export function fireRay(world: RAPIER.World, from: THREE.Vector3, dir: THREE.Vector3, range: number, q: Quarry, force: number, own?: RAPIER.RigidBody): { hit: boolean; point: THREE.Vector3 | null } {
  const hit = world.castRay(new RAPIER.Ray(from, dir), range, true, undefined, undefined, undefined, undefined, (col) => col.parent() !== own);
  if (!hit) return { hit: false, point: null };
  const point = from.clone().addScaledVector(dir, hit.timeOfImpact);
  const onTarget = hit.collider.parent() === q.body;
  if (onTarget) {
    const m = q.body.mass() * force * (q.glass ?? 1);
    q.body.applyImpulseAtPoint({ x: dir.x * m, y: dir.y * m, z: dir.z * m }, point, true);
  }
  return { hit: onTarget, point };
}
