import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import type { Ht2Roads } from '../world/roads';
import { ambushProp, toThree } from '../world/world';
import { ChaseRoute, lineOfSight, newChaser, roadside, shoot, steerChase, type Chaser } from './pursuit';

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
 *
 * Лічильник переслідування (+0x51D0, `phase`) спільний для машин міліції й гелікоптерів; кожен просуває його своїм
 * таймером, спрацьовує той, що перший. Машина міліції (run_car 0x4d1360) — лише ближче 100 м і при лічильнику 1…19
 * (34 забороненої зони — ні): на 1 — «НЕМЕДЛЕННО ОСТАНОВИТЕ МАШИНУ» (mess 54, police_01); через 30 с, якщо гравець
 * їде (> 1 м/с), — «ОСТАНОВИТЕСЬ ИЛИ БУДЕМ СТРЕЛЯТЬ» (mess 55, police_02); ще через 20 с, якщо їде, — фаза 4:
 * постріл кожні 0,15 с, поки гравець їде, промінь 300 м з розкидом ±0,05 рад; мітка часу одна на гравця. Затримання
 * машиною — ближче 40 м і обидві повільніші 1 м/с. Гелікоптер (0x568090, helicopters.ts) — ближче 50 м mess 54, через
 * 10 с mess 55, ще через 20 с +1; затримання після попередження: гравець стоїть (< 0,3 м/с) і гелікоптер ближче 15 м,
 * або попереду далі 20 м і сам повільніший 3 м/с, або гравець стоїть довше 1 с. Біля цілі машина цілиться в точку
 * попереду неї: L = 30 м (обгін і вихід перед гравцем), під час стрілянини — 15·(v + 0,5)/(v + 3) м, плюс швидкість
 * цілі × 0,5 с (за контролером гелікоптера 0x566970 — гіпотеза для машини). Не бачить ціль довше 25 + 0,2·(v₁ + v₂) с
 * (чи 60 с) — кидає погоню.
 *
 * Гіпотези порту: де «вільні» машини міліції (у грі їх 15, GAME.CNF) — порт викликає їх за DISPATCH_DELAY с поза
 * полем зору на SPAWN_MIN…SPAWN_MAX м; крейсерська швидкість і швидкість у поворотах (v² ≤ BEND_ACCEL/κ); поштовх
 * від влучання (Δv = HIT_DV); обгін гравця лівою смугою, обʼїзд машин трафіку, розворот на повному кермі, здавання
 * назад при застряганні; безнадійно застрягла (провалилася, кілька спроб марні) — прибирається, виклик пришле іншу;
 * тактична точка поза дорогою — на найближчу смугу. Сирена й мигалки (`CopSirenKey`) — хто вмикає, в exe не знайдено.
 * Керування погоні (маршрут, тактична точка, обгін, обʼїзд, розворот, застрягання, постріл) — спільне з мафією,
 * traffic/pursuit.ts.
 */
const ACTIVATE_EVERY = 300;
const ACTIVATE_P = 0.3;
const OCCUPY_MIN = 250;
const OCCUPY_MAX = 600;
const RADAR_R = 50;
const JOIN_R = 30;
const CAPTURE_R = 500;
const ACT_R = 100;
const CAR_WARN2_AFTER = 30;
const CAR_SHOOT_AFTER = 20;
const CAR_ARREST_R = 40;
const MOVING = 1;
const SHOT_EVERY = 0.15;
const HELI_WARN_R = 50;
const HELI_WARN2_AFTER = 10;
const HELI_SHOOT_AFTER = 20;
const SHOT_RANGE = 300;
const SHOT_SPREAD = 0.05;
const TACTICAL_R = 50;
const MAX_CHASERS = 2;
const DISPATCH_DELAY = 30;
const SPAWN_MIN = 300;
const SPAWN_MAX = 500;
const MAX_TRIES = 4;
const LOST_AFTER = 3;
const FALLING = 25;

export interface Ambush {
  name: string;
  pos: THREE.Vector3;
  /** Напрям засідки (NORTH/EAST/… — горизонтальний одиничний, three.js). */
  dir: THREE.Vector3;
  /** Напрям машини — уздовж найближчої дороги. */
  heading: THREE.Vector3;
  /** Ліміт швидкості, км/год (null — пост перевищення не фіксує). */
  limit: number | null;
  /** Реквізит засідки — шипи (імена анімованих обʼєктів, world.ambushProp); виставляються лише на перехоплення. */
  props: string[];
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
      const props = isList(e[7]) ? e[7].filter((x): x is number => typeof x === 'number').map((id) => ambushProp('police', id)) : [];
      out.push({ name: str(e[1]), pos: toThree(...node.pos), dir, heading, limit, props });
    }
  return out;
}

interface Post extends Ambush {
  active: boolean;
  cop: Cop | null;
}

interface Cop extends Chaser {
  /** Інспектор COP1…COP15 (індекс з 0) — для хабара по рації. */
  person: number;
  post: Post | null;
  /** Ціль захоплено (тактичний рівень). */
  engaged: boolean;
  /** Скільки не бачить ціль, с; перевірка видимості — раз на секунду. */
  unseen: number;
  seeTimer: number;
  /** Скільки с без коліс на землі чи перекинута. */
  bad: number;
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
  /** Скло (броньоване — 0,2): поштовх від куль ×g. */
  glass?: number;
  /** Куля влучила в інше тіло (Quarry.stray). */
  stray?: (body: RAPIER.RigidBody, power: number) => void;
}

export interface PoliceDeps {
  rapier: RAPIER.World;
  roads: Ht2Roads;
  /** Машина міліції BmwM5police на землі в точці (null — немає моделі). */
  make(pos: THREE.Vector3, forward: THREE.Vector3): TruckVehicle | null;
  remove(v: TruckVehicle): void;
  /** Гравець бачить точку (для появи «вільних» машин поза полем зору). */
  sees(p: THREE.Vector3): boolean;
  /** Машини на дорозі (трафік, далекобійники) — щоб обʼїжджати, а не вʼїжджати ззаду. */
  obstacles(): readonly THREE.Vector3[];
  /** Кількість інспекторів (names.sch COP*). */
  people: number;
  /**
   * Показати чи сховати реквізит засідки (шипи, king.exe 0x569310): зайняття й звільнення засідки ставлять 0
   * (activateAmbush 0x42bb90, 0x42baa0), пост, що зривається за розшукуваним (releaseAmbushPlayer 0x42c570 →
   * 0x42ba20), — 1; знімаються всі разом зі штрафами (0x42bb50).
   */
  props(names: readonly string[], on: boolean): void;
  /**
   * Інші переслідувачі, що ведуть ціль (гелікоптери, helicopters.ts): той самий лічильник +0x51D0 — попередження й
   * затримання від найближчого з усіх; стріляють вони самі.
   */
  chasers?(): readonly { pos: THREE.Vector3; speed: number }[];
}

export class Police {
  private readonly posts: Post[];
  readonly cops: Cop[] = [];
  private activateTimer = 0;
  private strategyTimer = 0;
  private dispatchTimer = DISPATCH_DELAY;
  /** Лічильник переслідування (king.exe +0x51D0): 0 — ні, 1 — розшук, 2 — перше попередження, 3 — друге, 4 — стрілянина. */
  phase = 0;
  /** Заборонена зона (лічильник 34 у exe): машини міліції такого не женуть, лише гелікоптери. */
  private zone = false;
  /** Мітка часу машин міліції (одна на гравця, +0x4098), с від початку. */
  private carMark = 0;
  /** Стан гелікоптерного контролера: 0 — ще не попереджав, 1 — mess 54, 2 — mess 55, 3 — +1; час від кроку. */
  private heliStage = 0;
  private heliTime = 0;
  private clock = 0;
  private stoppedTime = 0;
  /** Маршрут до цілі (updateChasedCars): дорогами до позиції гравця, перерахунок раз на 3 с (pursuit.ts). */
  private readonly route: ChaseRoute;
  private readonly tmp = new THREE.Vector3();
  /** Виставлені шипи: пост → його реквізит (знімаються, коли гравця більше не шукають і їх не видно). */
  private readonly spikes = new Set<Post>();

  constructor(
    ambushes: Ambush[],
    private readonly deps: PoliceDeps,
  ) {
    this.posts = ambushes.map((a) => ({ ...a, active: false, cop: null }));
    this.route = new ChaseRoute(deps.roads);
  }

  get count(): number {
    return this.posts.length;
  }

  /** Машини міліції поруч (рація): person — інспектор COP1…COP15 (з 0). */
  nearby(player: THREE.Vector3, r: number): { id: number; pos: THREE.Vector3; person: number }[] {
    return this.cops.flatMap((c, id) => (c.v.visual.position.distanceTo(player) < r ? [{ id, pos: c.v.visual.position, person: c.person }] : []));
  }

  /**
   * Мигалки й сирена (king.exe run_car 0x4d1360 → +0x55A4, 0x546b60): машина веде погоню — лічильник 1…19 (не
   * заборонена зона, 34) і гравець ближче 100 м. «Електрику» машини (0x557090 > 0,3) порт не моделює.
   */
  siren(c: Cop, player: THREE.Vector3): boolean {
    return c.engaged && this.phase > 0 && !this.zone && c.v.visual.position.distanceTo(player) < ACT_R;
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

  /** Підняти лічильник переслідування (заборонена зона: одразу 4 — вогонь, без попереджень). */
  escalate(n: number): void {
    if (this.phase >= n) return;
    this.phase = n;
    this.zone = true;
  }

  /** Кадр: засідки, погоня, попередження, стрілянина, затримання. */
  update(dt: number, pl: PlayerState): PoliceEvent[] {
    const ev: PoliceEvent[] = [];
    this.updatePosts(dt, pl, ev);
    this.clock += dt;
    if (!pl.wanted) this.reset();
    else if (this.phase === 0) this.phase = 1;
    this.updateFree(dt, pl);
    if (pl.wanted && this.cops.some((c) => !c.post)) this.route.update(dt, pl.pos);

    const speed = pl.vel.length();
    this.stoppedTime = speed < 0.3 ? this.stoppedTime + dt : 0;
    // Машина міліції (0x4d1360): найближча, що веде ціль, ближче 100 м; лічильник 1…19.
    let car: Cop | null = null;
    let carD = ACT_R;
    for (const c of this.cops) {
      const d = c.v.visual.position.distanceTo(pl.pos);
      if (c.engaged && d < carD) {
        car = c;
        carD = d;
      }
    }
    if (car && this.phase > 0 && !this.zone) {
      const late = (t: number) => this.clock > this.carMark + t;
      if (this.phase === 1) {
        this.carMark = this.clock;
        this.step(2, ev, 1);
      } else if (this.phase === 2 && late(CAR_WARN2_AFTER) && speed > MOVING) {
        this.carMark = this.clock;
        this.step(3, ev, 2);
      } else if (this.phase === 3 && late(CAR_SHOOT_AFTER) && speed > MOVING) {
        this.carMark = this.clock;
        this.step(4, ev);
      } else if (this.phase === 4 && speed > MOVING && late(SHOT_EVERY)) {
        this.carMark = this.clock;
        ev.push(this.shoot(car, pl, carD));
      }
      if (carD < CAR_ARREST_R && speed < MOVING && car.v.speedKmh / 3.6 < MOVING) this.arrest(ev);
    }
    // Гелікоптер (0x568090): найближчий, що веде ціль; свій таймер, кожен крок — лічильник +1.
    let heli: { pos: THREE.Vector3; speed: number } | null = null;
    let heliD = Infinity;
    for (const x of (this.phase > 0 && this.deps.chasers?.()) || []) {
      const d = x.pos.distanceTo(pl.pos);
      if (d < heliD) {
        heli = x;
        heliD = d;
      }
    }
    if (heli && this.phase > 0) {
      this.heliTime += dt;
      const next = () => Math.min(4, this.phase + 1);
      if (this.heliStage === 0 && heliD < HELI_WARN_R && this.phase < 2) {
        this.heliStage = 1;
        this.heliTime = 0;
        this.stoppedTime = 0;
        this.step(next(), ev, 1);
      } else if (this.heliStage === 1 && this.heliTime > HELI_WARN2_AFTER) {
        this.heliStage = 2;
        this.heliTime = 0;
        this.step(next(), ev, 2);
      } else if (this.heliStage === 2 && this.heliTime > HELI_SHOOT_AFTER) {
        this.heliStage = 3;
        this.step(next(), ev);
      }
      if (this.heliStage > 0 && this.heliArrest(heli.pos, heli.speed, heliD, pl)) this.arrest(ev);
    }
    for (const c of [...this.cops]) {
      // Безнадійно застрягла (колеса не на землі, перекинута, кілька спроб здати назад марні) — прибрати; виклик
      // пришле іншу (гіпотеза порту, як трафік).
      const up = this.tmp.set(0, 1, 0).applyQuaternion(c.v.visual.quaternion).y;
      const air = ![0, 1, 2, 3].some((i) => c.v.ctrl.wheelIsInContact(i));
      c.bad = (up < 0.5 || air) && c.v.speedKmh < 3 ? c.bad + dt : 0;
      // Провалилася крізь світ (падає) — теж прибрати.
      if (c.v.body.linvel().y < -FALLING) c.bad = LOST_AFTER + 1;
      if (!c.post && (c.bad > LOST_AFTER || (c.tries > MAX_TRIES && !this.deps.sees(c.v.visual.position)))) {
        this.remove(c);
        continue;
      }
      this.steer(c, pl, dt);
    }
    return ev;
  }

  /** Новий рівень лічильника; warn — попередження (mess 54/55 і звуки police_01/02). */
  private step(n: number, ev: PoliceEvent[], warn?: 1 | 2): void {
    if (this.phase === 0) return;
    this.phase = n;
    if (warn) ev.push({ kind: 'warn', n: warn });
  }

  /** Затримання (подія 2): лічильник 0, цілі знято. */
  private arrest(ev: PoliceEvent[]): void {
    if (this.phase === 0) return;
    ev.push({ kind: 'arrest' });
    this.reset();
  }

  private reset(): void {
    this.phase = 0;
    this.zone = false;
    this.heliStage = 0;
    this.heliTime = 0;
    for (const c of this.cops) c.engaged = false;
  }

  /** Затримання гелікоптером (0x568090): гравець стоїть і гелікоптер близько, попереду й повільний, чи стоїть > 1 с. */
  private heliArrest(pos: THREE.Vector3, heliSpeed: number, d: number, pl: PlayerState): boolean {
    if (pl.vel.length() >= 0.3) return false;
    if (d < 15 || this.stoppedTime > 1) return true;
    const rel = this.tmp.copy(pos).sub(pl.pos).setY(0);
    const ahead = rel.dot(pl.forward);
    const side = Math.abs(rel.x * pl.forward.z - rel.z * pl.forward.x);
    return ahead > side && ahead > 20 && heliSpeed < 3;
  }

  private shoot(c: Cop, pl: PlayerState, dist: number): PoliceEvent {
    return { kind: 'shot', hit: shoot(this.deps.rapier, c, pl, SHOT_SPREAD, SHOT_RANGE), dist };
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
        if (p.props.length) {
          this.deps.props(p.props, true);
          this.spikes.add(p);
        }
      }
    }
    // Погоні немає — шипи прибрано (0x42bb50 при знятті штрафів; порт — коли не видно, щоб не зникали на очах).
    if (!pl.wanted)
      for (const p of this.spikes) {
        if (p.cop || this.deps.sees(p.pos)) continue;
        this.deps.props(p.props, false);
        this.spikes.delete(p);
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
        const seen = d < CAPTURE_R && lineOfSight(this.deps.rapier, c, pl);
        c.unseen = seen ? 0 : c.unseen + 1;
        if (pl.wanted && seen) c.engaged = true;
        const vs = c.v.speedKmh / 3.6 + pl.vel.length();
        if (c.engaged && (c.unseen > 25 + 0.2 * vs || c.unseen > 60)) c.engaged = false;
      }
      // Не розшукується й далеко чи поза полем зору — машина зникає.
      if (!pl.wanted && (d > 650 || (d > 150 && !this.deps.sees(c.v.visual.position)))) this.remove(c);
    }
  }

  private occupy(p: Post): void {
    // Пост — на узбіччі (вузол засідки лежить на смузі); шипи прибрано (0x42bb90 ставить реквізиту 0).
    const v = this.deps.make(roadside(this.deps.roads, p.pos, p.dir), p.heading);
    if (!v) return;
    p.cop = this.add(v, p);
    this.deps.props(p.props, false);
    this.spikes.delete(p);
  }

  private release(c: Cop): void {
    this.remove(c);
  }

  private add(v: TruckVehicle, post: Post | null): Cop {
    const used = new Set(this.cops.map((c) => c.person));
    const pool = [...Array(Math.max(1, this.deps.people)).keys()].filter((i) => !used.has(i));
    const person = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
    const cop: Cop = { ...newChaser(v), person, post, engaged: false, unseen: 0, seeTimer: 0, bad: 0 };
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
    const ring: { a: THREE.Vector3; b: THREE.Vector3 }[] = [];
    for (const line of this.deps.roads.lines) {
      // Не на зрізалках (world/roads markShortcuts): ними їздить лише гравець.
      if (line.lane < 0 || line.shortcut) continue;
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const d = line.pts[i].distanceTo(pl.pos);
        if (d > SPAWN_MIN && d < SPAWN_MAX) ring.push({ a: line.pts[i], b: line.pts[i + 1] });
      }
    }
    for (let attempt = 0; attempt < 20 && ring.length; attempt++) {
      const { a, b } = ring[Math.floor(Math.random() * ring.length)];
      if (this.deps.sees(a)) continue;
      const v = this.deps.make(a, b.clone().sub(a).setY(0).normalize());
      if (v) this.add(v, null);
      return;
    }
  }

  /** Керування машини: на посту — стоїть; ціль захоплено й близько — тактична точка; інакше — дорогами до цілі. */
  private steer(c: Cop, pl: PlayerState, dt: number): void {
    if (c.post || !pl.wanted) {
      Object.assign(c.ctrl, { steer: 0, throttle: 0, brake: c.post ? 0 : 1, handbrake: !!c.post || c.v.speedKmh < 2 });
      return;
    }
    // Точка прицілу: попереду цілі на L по її курсу (30 м — обгін і вихід перед ціллю; під час стрілянини щільно).
    const pv = pl.vel.length();
    const lead = this.phase === 4 ? (15 * (pv + 0.5)) / (pv + 3) : 30;
    steerChase(c, pl, { roads: this.deps.roads, route: this.route, obstacles: this.deps.obstacles(), engaged: c.engaged, tacticalR: TACTICAL_R, lead }, dt);
  }

  dispose(): void {
    for (const c of [...this.cops]) this.remove(c);
  }
}
