import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { ControlState } from '../engine/input/input';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import { Navigator } from '../world/navigator';
import type { Ht2Roads, RoadLine } from '../world/roads';
import { toThree } from '../world/world';
import { steerFor } from './physical';

/**
 * Міліція Дальнобойщиків 2 (Б9; поведінка king.exe — re/notes/ht2/police.md).
 *
 * Засідки — рядки `ambush … POLICE "<вузол WAY>" <напрям> (…) (…) [ліміт]` у `ENV/mod_*.sch`. Кожні 300 с засідка
 * стає активною з імовірністю 30 %; активну займає машина `BmwM5police` (vehicle.tech), коли гравець на 250…600 м і
 * підʼїжджає з боку напрямку засідки; далі 600 м — звільняє. Перевищення фіксують лише пости з лімітом (8 постів:
 * 65 і 85 км/год), ближче 50 м і без фарби Stealth: штраф 250 × ступінь — і гравець розшукуваний.
 *
 * Розшукуваного (хоч один штраф) переслідують: машина поста, повз яку він проїхав ближче 30 м, і до двох «вільних»
 * машин, що їдуть до нього дорогами (маршрут — щоразу за 3 с) і захоплюють ціль ближче 500 м у прямій видимості.
 * Ближче 50 м — «НЕМЕДЛЕННО ОСТАНОВИТЕ МАШИНУ» (mess 54, police_01), через 10 с — «ОСТАНОВИТЕСЬ ИЛИ БУДЕМ СТРЕЛЯТЬ»
 * (mess 55, police_02), ще через 20 с — стрілянина: постріл кожні 0,15 с, поки гравець їде, промінь 300 м з розкидом
 * ±0,05 рад. Біля цілі машина цілиться в точку попереду неї: L = 30 м (обгін і вихід перед гравцем), під час
 * стрілянини — 15·(v + 0,5)/(v + 3) м, плюс швидкість цілі × 0,5 с. Затримання: гравець стоїть (< 0,3 м/с) і
 * міліція ближче 15 м, або попереду далі 20 м і сама повільніша 3 м/с, або гравець стоїть довше 1 с; чи обидві
 * машини стоять ближче 40 м. Не бачить ціль довше 25 + 0,2·(v₁ + v₂) с (чи 60 с) — кидає погоню.
 *
 * Гіпотези порту: де «вільні» машини міліції (у грі їх 15, GAME.CNF) — порт викликає їх за DISPATCH_DELAY с поза
 * полем зору на SPAWN_MIN…SPAWN_MAX м; крейсерська швидкість дорогою; поштовх від влучання (Δv = HIT_DV); обгін
 * зліва. Сирена й мигалки (`CopSirenKey`) — хто вмикає, в exe не знайдено.
 */
const ACTIVATE_EVERY = 300;
const ACTIVATE_P = 0.3;
const OCCUPY_MIN = 250;
const OCCUPY_MAX = 600;
const RADAR_R = 50;
const JOIN_R = 30;
const CAPTURE_R = 500;
const WARN_R = 50;
const WARN2_AFTER = 10;
const SHOOT_AFTER = 20;
const ACT_R = 100;
const SHOT_EVERY = 0.15;
const SHOT_RANGE = 300;
const SHOT_SPREAD = 0.05;
const ROUTE_EVERY = 3;
const TACTICAL_R = 50;
const MAX_CHASERS = 2;
const DISPATCH_DELAY = 30;
const SPAWN_MIN = 300;
const SPAWN_MAX = 500;
const HIT_DV = 0.1;
const CRUISE = 30;
const ROAD_LOOK = 6;
const U_TURN = 1.6;
const U_TURN_SPEED = 5;
const STUCK_AFTER = 2;
const REVERSE_FOR = 2;

export interface Ambush {
  name: string;
  pos: THREE.Vector3;
  /** Напрям засідки (NORTH/EAST/… — горизонтальний одиничний, three.js). */
  dir: THREE.Vector3;
  /** Напрям машини — уздовж найближчої дороги. */
  heading: THREE.Vector3;
  /** Ліміт швидкості, км/год (null — пост перевищення не фіксує). */
  limit: number | null;
}

const DIRS: Record<string, [number, number]> = { NORTH: [0, 1], SOUTH: [0, -1], EAST: [1, 0], WEST: [-1, 0] };

/** Засідки міліції з `ENV/mod_*.sch`; вузли — за назвою в WAY усіх регіонів. */
export function parseAmbushes(mods: { sch: SExpr[] }[], ways: Iterable<{ way: Way }>): Ambush[] {
  const nodes = new Map<string, { pos: [number, number, number]; segs: Way['rooms'][number]['segments'] }>();
  for (const { way } of ways) for (const room of way.rooms) for (const n of room.nodes) nodes.set(n.name.toLowerCase(), { pos: n.pos, segs: room.segments });
  const out: Ambush[] = [];
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'ambush' || e[2] !== 'POLICE') continue;
      const node = nodes.get(str(e[5]).toLowerCase());
      if (!node) continue;
      const [dx, dy] = DIRS[str(e[6]).toUpperCase()] ?? [0, 1];
      const dir = toThree(dx, dy, 0).normalize();
      // Машина — уздовж найближчого відрізка дороги кімнати, у бік, ближчий до напрямку засідки.
      let heading = dir.clone();
      let best = Infinity;
      for (const s of node.segs)
        for (let i = 0; i + 5 < s.points.length; i += 3) {
          const d = Math.hypot(s.points[i] - node.pos[0], s.points[i + 1] - node.pos[1]);
          if (d < best) {
            best = d;
            heading = toThree(s.points[i + 3] - s.points[i], s.points[i + 4] - s.points[i + 1], 0).normalize();
          }
        }
      if (heading.dot(dir) < 0) heading.negate();
      const limit = e.length > 9 && typeof e[9] === 'number' ? num(e[9]) : null;
      out.push({ name: str(e[1]), pos: toThree(...node.pos), dir, heading, limit });
    }
  return out;
}

interface Post extends Ambush {
  active: boolean;
  cop: Cop | null;
}

interface Cop {
  v: TruckVehicle;
  /** Інспектор COP1…COP15 (індекс з 0) — для хабара по рації. */
  person: number;
  post: Post | null;
  /** Ціль захоплено (тактичний рівень). */
  engaged: boolean;
  /** Скільки не бачить ціль, с; перевірка видимості — раз на секунду. */
  unseen: number;
  seeTimer: number;
  /** Застрягання: скільки стоїть з газом, і скільки ще здавати назад, с. */
  stuck: number;
  reverse: number;
  revSteer: number;
  ctrl: ControlState;
}

export type PoliceEvent =
  | { kind: 'speeding'; limit: number; speed: number; degree: 1 | 2 | 3 }
  | { kind: 'warn'; n: 1 | 2 }
  | { kind: 'shot'; hit: boolean; dist: number }
  | { kind: 'arrest' };

export interface PlayerState {
  body: RAPIER.RigidBody;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  /** Швидкість, м/с (вектор). */
  vel: THREE.Vector3;
  wanted: boolean;
  /** Фарба Stealth — пост не бачить машину. */
  stealth: boolean;
}

export interface PoliceDeps {
  rapier: RAPIER.World;
  roads: Ht2Roads;
  /** Машина міліції BmwM5police на землі в точці (null — немає моделі). */
  make(pos: THREE.Vector3, forward: THREE.Vector3): TruckVehicle | null;
  remove(v: TruckVehicle): void;
  /** Гравець бачить точку (для появи «вільних» машин поза полем зору). */
  sees(p: THREE.Vector3): boolean;
  /** Кількість інспекторів (names.sch COP*). */
  people: number;
}

export class Police {
  private readonly posts: Post[];
  readonly cops: Cop[] = [];
  private activateTimer = 0;
  private strategyTimer = 0;
  private dispatchTimer = DISPATCH_DELAY;
  /** Лічильник переслідування (king.exe +0x51D0): 0 — ні, 1 — розшук, 2 — перше попередження, 3 — друге, 4 — стрілянина. */
  phase = 0;
  private phaseTime = 0;
  private stoppedTime = 0;
  private shotTimer = 0;
  private nav: Navigator | null = null;
  /** Маршрут до цілі (updateChasedCars): відстані ліній до позиції гравця, перераховуються раз на ROUTE_EVERY с. */
  private route: Map<RoadLine, number> | null = null;
  private readonly routeGoal = new THREE.Vector3();
  private routeTimer = 0;
  private readonly tmp = new THREE.Vector3();

  constructor(
    ambushes: Ambush[],
    private readonly deps: PoliceDeps,
  ) {
    this.posts = ambushes.map((a) => ({ ...a, active: false, cop: null }));
  }

  get count(): number {
    return this.posts.length;
  }

  /** Машини міліції поруч (рація): person — інспектор COP1…COP15 (з 0). */
  nearby(player: THREE.Vector3, r: number): { id: number; pos: THREE.Vector3; person: number }[] {
    return this.cops.flatMap((c, id) => (c.v.visual.position.distanceTo(player) < r ? [{ id, pos: c.v.visual.position, person: c.person }] : []));
  }

  /** Чи є машина міліції ближче r (штрафи за ДТП і червоне світло — лише при міліції в радіусі 200 м, 0x4cfd10). */
  near(p: THREE.Vector3, r = 200): boolean {
    return this.cops.some((c) => c.v.visual.position.distanceTo(p) < r);
  }

  /** Тіла машин міліції (зіткнення з міліцією — подвійне відшкодування, 0x4cfe70). */
  isCop(body: RAPIER.RigidBody): boolean {
    return this.cops.some((c) => c.v.body === body);
  }

  /** Сигнал радар-детектора (0x538370): пост ближче 100 м → відстань × 0,01; 0 — немає. */
  radarSignal(player: THREE.Vector3): number {
    let s = 0;
    for (const p of this.posts) {
      if (!p.cop || p.cop.post !== p) continue;
      const d = p.cop.v.visual.position.distanceTo(player);
      if (d < 100) s = Math.max(s, d * 0.01);
    }
    return s;
  }

  /** Перед кроком фізики: керування машин. */
  control(dt: number): void {
    for (const c of this.cops) c.v.update(dt, c.ctrl);
  }

  /** Після кроку: візуал. */
  after(alpha: number): void {
    for (const c of this.cops) c.v.syncVisual(alpha);
  }

  /** Кадр: засідки, погоня, попередження, стрілянина, затримання. */
  update(dt: number, pl: PlayerState): PoliceEvent[] {
    const ev: PoliceEvent[] = [];
    this.updatePosts(dt, pl, ev);
    if (!pl.wanted) {
      this.phase = 0;
      this.phaseTime = 0;
      for (const c of this.cops) c.engaged = false;
    } else if (this.phase === 0) this.phase = 1;
    this.updateFree(dt, pl);
    if (pl.wanted && this.cops.some((c) => !c.post) && (this.routeTimer -= dt) <= 0) {
      this.routeTimer = ROUTE_EVERY;
      this.routeGoal.copy(pl.pos);
      this.nav ??= new Navigator(this.deps.roads);
      this.route = this.nav.distances(this.routeGoal);
    }

    // Тактичний рівень: найближча машина, що веде ціль.
    let lead: Cop | null = null;
    let leadD = Infinity;
    for (const c of this.cops) {
      const d = c.v.visual.position.distanceTo(pl.pos);
      if (c.engaged && d < leadD) {
        lead = c;
        leadD = d;
      }
    }
    const speed = pl.vel.length();
    this.stoppedTime = speed < 0.3 ? this.stoppedTime + dt : 0;
    if (lead && this.phase > 0) {
      this.phaseTime += dt;
      if (this.phase === 1 && leadD < WARN_R) this.setPhase(2, ev);
      else if (this.phase === 2 && this.phaseTime > WARN2_AFTER) this.setPhase(3, ev);
      else if (this.phase === 3 && this.phaseTime > SHOOT_AFTER) this.setPhase(4, ev);
      if (this.phase >= 2 && this.arrested(lead, leadD, pl)) {
        ev.push({ kind: 'arrest' });
        this.phase = 0;
        for (const c of this.cops) c.engaged = false;
      }
      if (this.phase === 4 && leadD < ACT_R && speed > 1 && (this.shotTimer -= dt) <= 0) {
        this.shotTimer = SHOT_EVERY;
        ev.push(this.shoot(lead, pl, leadD));
      }
    }
    for (const c of this.cops) this.steer(c, pl, dt);
    return ev;
  }

  private setPhase(n: number, ev: PoliceEvent[]): void {
    this.phase = n;
    this.phaseTime = 0;
    if (n === 2) ev.push({ kind: 'warn', n: 1 });
    if (n === 3) ev.push({ kind: 'warn', n: 2 });
  }

  private arrested(c: Cop, d: number, pl: PlayerState): boolean {
    const copSpeed = c.v.speedKmh / 3.6;
    if (d < 40 && pl.vel.length() < 1 && copSpeed < 1) return true;
    if (pl.vel.length() >= 0.3) return false;
    if (d < 15 || this.stoppedTime > 1) return true;
    const rel = this.tmp.copy(c.v.visual.position).sub(pl.pos).setY(0);
    const ahead = rel.dot(pl.forward);
    const side = Math.abs(rel.x * pl.forward.z - rel.z * pl.forward.x);
    return ahead > side && ahead > 20 && copSpeed < 3;
  }

  private shoot(c: Cop, pl: PlayerState, dist: number): PoliceEvent {
    const from = c.v.visual.position.clone().setY(c.v.visual.position.y + 1.3);
    const dir = pl.pos.clone().setY(pl.pos.y + 1.5).sub(from).normalize();
    dir.applyAxisAngle(new THREE.Vector3(0, 1, 0), (Math.random() * 2 - 1) * SHOT_SPREAD);
    const own = c.v.body;
    const hit = this.deps.rapier.castRay(new RAPIER.Ray(from, dir), SHOT_RANGE, true, undefined, undefined, undefined, undefined, (col) => col.parent() !== own);
    const onPlayer = !!hit && hit.collider.parent() === pl.body;
    if (onPlayer) {
      const m = pl.body.mass();
      const p = from.clone().addScaledVector(dir, hit!.timeOfImpact);
      pl.body.applyImpulseAtPoint({ x: dir.x * m * HIT_DV, y: dir.y * m * HIT_DV, z: dir.z * m * HIT_DV }, p, true);
    }
    return { kind: 'shot', hit: onPlayer, dist };
  }

  /** Засідки: активація, зайняття й звільнення, радар, долучення поста до погоні. */
  private updatePosts(dt: number, pl: PlayerState, ev: PoliceEvent[]): void {
    if ((this.activateTimer -= dt) <= 0) {
      this.activateTimer = ACTIVATE_EVERY;
      for (const p of this.posts) if (!p.cop) p.active = Math.random() < ACTIVATE_P;
    }
    const step = (this.strategyTimer -= dt) <= 0;
    if (step) this.strategyTimer = 1;
    for (const p of this.posts) {
      const d = p.pos.distanceTo(pl.pos);
      if (step && p.active && !p.cop && d > OCCUPY_MIN && d < OCCUPY_MAX && this.tmp.copy(pl.pos).sub(p.pos).dot(p.dir) > 0) this.occupy(p);
      const c = p.cop;
      if (!c || c.post !== p) continue;
      if (step && d > OCCUPY_MAX) {
        this.release(c);
        continue;
      }
      const cd = c.v.visual.position.distanceTo(pl.pos);
      // Радар поста з лімітом.
      if (p.limit !== null && !pl.wanted && !pl.stealth && cd < RADAR_R) {
        const kmh = pl.vel.length() * 3.6;
        const degree = kmh > p.limit + 35 ? 3 : kmh > p.limit + 15 ? 2 : kmh > p.limit ? 1 : 0;
        if (degree) ev.push({ kind: 'speeding', limit: p.limit, speed: Math.round(kmh), degree });
      }
      // Розшукуваний проїхав перед постом ближче 30 м — пост знімається й жене.
      if (pl.wanted && cd < JOIN_R && this.tmp.copy(pl.pos).sub(c.v.visual.position).dot(c.v.forward()) > 0) {
        c.post = null;
        p.cop = null;
        p.active = false;
        c.engaged = true;
      }
    }
  }

  /** «Вільні» машини: виклик на розшукуваного, захоплення цілі, втрата видимості, прибирання. */
  private updateFree(dt: number, pl: PlayerState): void {
    const free = this.cops.filter((c) => !c.post);
    if (pl.wanted && free.length < MAX_CHASERS && (this.dispatchTimer -= dt) <= 0) {
      this.dispatchTimer = DISPATCH_DELAY;
      this.dispatch(pl);
    }
    if (!pl.wanted) this.dispatchTimer = DISPATCH_DELAY;
    for (const c of free) {
      const d = c.v.visual.position.distanceTo(pl.pos);
      if ((c.seeTimer -= dt) <= 0) {
        c.seeTimer = 1;
        const seen = d < CAPTURE_R && this.lineOfSight(c, pl);
        c.unseen = seen ? 0 : c.unseen + 1;
        if (pl.wanted && seen) c.engaged = true;
        const vs = c.v.speedKmh / 3.6 + pl.vel.length();
        if (c.engaged && (c.unseen > 25 + 0.2 * vs || c.unseen > 60)) c.engaged = false;
      }
      // Не розшукується й далеко чи поза полем зору — машина зникає.
      if (!pl.wanted && (d > 650 || (d > 150 && !this.deps.sees(c.v.visual.position)))) this.remove(c);
    }
  }

  private lineOfSight(c: Cop, pl: PlayerState): boolean {
    const from = c.v.visual.position.clone().setY(c.v.visual.position.y + 1.3);
    const to = pl.pos.clone().setY(pl.pos.y + 1.5);
    const dist = from.distanceTo(to);
    const hit = this.deps.rapier.castRay(new RAPIER.Ray(from, to.sub(from).divideScalar(dist)), dist - 3, true, undefined, undefined, undefined, undefined, (col) => col.parent()?.isFixed() ?? true);
    return !hit;
  }

  private occupy(p: Post): void {
    const v = this.deps.make(p.pos, p.heading);
    if (!v) return;
    p.cop = this.add(v, p);
  }

  private release(c: Cop): void {
    if (c.post) c.post.cop = null;
    this.remove(c);
  }

  private add(v: TruckVehicle, post: Post | null): Cop {
    const used = new Set(this.cops.map((c) => c.person));
    const pool = [...Array(Math.max(1, this.deps.people)).keys()].filter((i) => !used.has(i));
    const person = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
    const cop: Cop = { v, person, post, engaged: false, unseen: 0, seeTimer: 0, stuck: 0, reverse: 0, revSteer: 0, ctrl: { steer: 0, throttle: 0, brake: 0, handbrake: true } };
    this.cops.push(cop);
    return cop;
  }

  private remove(c: Cop): void {
    const i = this.cops.indexOf(c);
    if (i < 0) return;
    this.cops.splice(i, 1);
    if (c.post?.cop === c) c.post.cop = null;
    this.deps.remove(c.v);
  }

  /** Виклик: машина на дорозі поза полем зору на SPAWN_MIN…SPAWN_MAX м від гравця (гіпотеза порту). */
  private dispatch(pl: PlayerState): void {
    const lines = this.deps.roads.lines;
    for (let attempt = 0; attempt < 40; attempt++) {
      const line = lines[Math.floor(Math.random() * lines.length)];
      if (line.lane < 0 || line.pts.length < 2) continue;
      const i = Math.floor(Math.random() * (line.pts.length - 1));
      const a = line.pts[i];
      const d = a.distanceTo(pl.pos);
      if (d < SPAWN_MIN || d > SPAWN_MAX || this.deps.sees(a)) continue;
      const v = this.deps.make(a, line.pts[i + 1].clone().sub(a).setY(0).normalize());
      if (v) this.add(v, null);
      return;
    }
  }

  /** Керування машини: на посту — стоїть; ціль захоплено й близько — тактична точка; інакше — дорогами до цілі. */
  private steer(c: Cop, pl: PlayerState, dt: number): void {
    const ctl = c.ctrl;
    if (c.post || !pl.wanted) {
      Object.assign(ctl, { steer: 0, throttle: 0, brake: c.post ? 0 : 1, handbrake: !!c.post || c.v.speedKmh < 2 });
      return;
    }
    const pos = c.v.visual.position;
    const fwd = c.v.forward();
    const d = pos.distanceTo(pl.pos);
    const v = c.v.speedKmh / 3.6;
    const pv = pl.vel.length();
    let target: THREE.Vector3;
    let want: number;
    if (c.engaged && d < TACTICAL_R) {
      // Точка прицілу: попереду цілі на L по її курсу + швидкість цілі × 0,5 с.
      const L = this.phase === 4 ? (15 * (pv + 0.5)) / (pv + 3) : 30;
      target = pl.pos.clone().addScaledVector(pl.forward, L).addScaledVector(pl.vel, 0.5);
      // Позаду цілі й близько — обгін зліва (гіпотеза порту), а не таран.
      const rel = this.tmp.copy(pos).sub(pl.pos);
      if (rel.dot(pl.forward) < 3 && d < 15) target.addScaledVector(new THREE.Vector3(pl.forward.z, 0, -pl.forward.x), 4);
      const along = target.clone().sub(pos).dot(fwd);
      want = THREE.MathUtils.clamp(pv + 0.5 * along, 0, 40);
    } else {
      target = this.routePoint(pos, fwd, ROAD_LOOK + 0.8 * v);
      const far = this.routePoint(pos, fwd, 12 + 0.6 * v * 3.6);
      const bend = 1 - Math.max(0, far.clone().sub(pos).setY(0).normalize().dot(fwd));
      want = CRUISE * (1 - Math.min(0.7, bend * 2.2));
    }
    const to = target.sub(pos).setY(0);
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    const angle = Math.atan2(to.dot(right), to.dot(fwd));
    const delta = Math.atan((2 * c.v.base * Math.sin(angle)) / Math.max(4, to.length()));
    ctl.steer = THREE.MathUtils.clamp(steerFor(delta), -1, 1);
    // Ціль позаду — розворот на повному кермі повільно (гіпотеза порту).
    if (Math.abs(angle) > U_TURN) {
      ctl.steer = Math.sign(angle) || 1;
      want = Math.min(want, U_TURN_SPEED);
    }
    // Застрягла (у стіні, на розвороті) — назад з протилежним кермом, як фізичний трафік (physical.ts).
    if (c.reverse > 0) {
      c.reverse -= dt;
      Object.assign(ctl, { steer: c.revSteer, throttle: 0, brake: 1, handbrake: false });
      return;
    }
    c.stuck = want > 3 && v < 1 ? c.stuck + dt : 0;
    if (c.stuck > STUCK_AFTER) {
      c.stuck = 0;
      c.reverse = REVERSE_FOR;
      c.revSteer = -ctl.steer;
    }
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

  /** Точка дорогами в бік цілі: уздовж смуги, на кінці — продовження з найкоротшим шляхом до цілі. */
  private routePoint(pos: THREE.Vector3, fwd: THREE.Vector3, ahead: number): THREE.Vector3 {
    if (!this.route) return this.routeGoal.clone();
    const dist = this.route;
    // Смуга свого напрямку чи зустрічна — та, звідки шлях до цілі коротший (на зустрічній — розворот).
    const cost = (m: { line: RoadLine; seg: number; t: number } | null) => {
      if (!m) return Infinity;
      let rest = m.line.pts[m.seg].clone().lerp(m.line.pts[m.seg + 1], m.t).distanceTo(m.line.pts[m.seg + 1]);
      for (let i = m.seg + 1; i + 1 < m.line.pts.length; i++) rest += m.line.pts[i].distanceTo(m.line.pts[i + 1]);
      return rest + (dist.get(m.line) ?? Infinity);
    };
    const own = this.deps.roads.nearest(pos, fwd);
    const back = this.deps.roads.nearest(pos, fwd.clone().negate());
    const n = cost(back) + 30 < cost(own) ? back : own;
    if (!n || n.dist > 30) return this.routeGoal.clone();
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

  dispose(): void {
    for (const c of [...this.cops]) this.remove(c);
  }
}
