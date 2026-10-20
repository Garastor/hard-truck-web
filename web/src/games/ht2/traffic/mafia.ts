import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { isList, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import type { Ht2Roads } from '../world/roads';
import { ambushProp, toThree } from '../world/world';
import { ChaseRoute, cruiseTo, holdStill, lineOfSight, newChaser, roadside, shoot, steerChase, type Chaser, type Quarry } from './pursuit';

/**
 * Мафія Дальнобойщиків 2 за king.exe (re/notes/ht2/mafia.md).
 *
 * - Гравець «на прицілі» мафії, якщо є борг мафії (+0xE0, ДТП з машиною мафії) чи він «цікавий мафії» (+0xC9:
 *   вантаж formafia при частці капіталу > 0,15) — рахує кар'єра; тоді лічильник переслідування 21.
 * - Засідки `ambush … MAFIA` (mod_*.sch, 43): раз на 300 с кожна активна з імовірністю 30 %, лише якщо гравець на
 *   прицілі й частка капіталу > 0,2 (markAmbushes 0x429820); займається, коли гравець за 250…600 м і підʼїжджає з
 *   боку засідки; звільняється далі 600 м. Гравець проїхав перед постом ближче 30 м — пост знімається й жене, міни
 *   засідки (AnmObj0001, перемикач MineKey) зводяться (releaseAmbushPlayer).
 * - mafiaOnHim (0x40aa00): поки гравець на прицілі — до 2 машин Cayman (HOOD1–8) маршрутом до нього. Порт: машина
 *   зʼявляється на дорозі поза полем зору за 300…500 м (у king.exe 8 машин мафії вже їздять світом) раз на
 *   DISPATCH_DELAY с [Г].
 * - Погоня (run_car 0x4d1360; контролер міліції 0x568090 мафію пропускає): ближче 100 м і без міліції в радіусі
 *   200 м — «ОСТАНОВИ МАШИНУ! НУЖНО ПОГОВОРИТЬ» (mess 73, без звуку), лічильник 22; через 20 с, якщо гравець їде
 *   швидше 1 м/с, — 23, стрілянина кожні 150 мс ±0,157 рад, поки гравець їде.
 * - Зупинка (обидві машини < 1 м/с, ближче 40 м) — напад (mafiaAttack 0x445740; гроші чи вантаж вирішує кар'єра),
 *   ціль знято з усіх машин (clearPlayerFromMafia).
 * - Міни: вибух від дотику колеса (mineExplose, mineSound, 0x56f240); порт — машина гравця ближче MINE_R до міни
 *   [Г: радіус і сила]; ховаються, коли погоні немає й їх не видно [Г: у king.exe не зʼясовано].
 */
const ACTIVATE_EVERY = 300;
const ACTIVATE_P = 0.3;
const SHARE_AMBUSH = 0.2;
const OCCUPY_MIN = 250;
const OCCUPY_MAX = 600;
const JOIN_R = 30;
const CAPTURE_R = 500;
const WARN_R = 100;
const POLICE_R = 200;
const SHOOT_AFTER = 20;
const SHOT_EVERY = 0.15;
const SHOT_SPREAD = 0.157;
const STOP_R = 40;
const TACTICAL_R = 50;
const MAX_CHASERS = 2;
const DISPATCH_DELAY = 20;
const SPAWN_MIN = 300;
const SPAWN_MAX = 500;
const LOST_AFTER = 3;
const MAX_TRIES = 4;
const FALLING = 25;
const MINE_R = 2.5;
const PEOPLE = 8;

export interface MafiaAmbush {
  name: string;
  pos: THREE.Vector3;
  dir: THREE.Vector3;
  heading: THREE.Vector3;
  /** Міни засідки (імена ambushProp). */
  mines: string[];
}

const DIRS: Record<string, [number, number]> = { NORTH: [0, 1], SOUTH: [0, -1], EAST: [1, 0], WEST: [-1, 0] };

/** Засідки мафії з `ENV/mod_*.sch` (той самий формат, що в міліції: вузол, напрям, список обʼєктів). */
export function parseMafiaAmbushes(mods: { sch: SExpr[] }[], ways: Iterable<{ way: Way }>): MafiaAmbush[] {
  const nodes = new Map<string, { pos: [number, number, number]; segs: Way['rooms'][number]['segments'] }>();
  for (const { way } of ways) for (const room of way.rooms) for (const n of room.nodes) nodes.set(n.name.toLowerCase(), { pos: n.pos, segs: room.segments });
  const out: MafiaAmbush[] = [];
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'ambush' || e[2] !== 'MAFIA') continue;
      const node = nodes.get(str(e[5]).toLowerCase());
      if (!node) continue;
      const [dx, dy] = DIRS[str(e[6]).toUpperCase()] ?? [0, 1];
      const dir = toThree(dx, dy, 0).normalize();
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
      const mines = isList(e[7]) ? e[7].filter((x): x is number => typeof x === 'number').map((id) => ambushProp('mafia', id)) : [];
      out.push({ name: str(e[1]), pos: toThree(...node.pos), dir, heading, mines });
    }
  return out;
}

interface Post extends MafiaAmbush {
  active: boolean;
  hood: Hood | null;
}

interface Hood extends Chaser {
  /** Бандит HOOD1…HOOD8 (з 0) — рація. */
  person: number;
  post: Post | null;
  engaged: boolean;
  unseen: number;
  seeTimer: number;
  bad: number;
}

export type MafiaEvent = { kind: 'warn' } | { kind: 'shot'; hit: boolean; dist: number } | { kind: 'attack' } | { kind: 'mine'; pos: THREE.Vector3 };

export interface MafiaPlayer extends Quarry {
  /** На прицілі мафії: борг мафії > 0 чи «цікавий мафії». */
  hunted: boolean;
  /** Частка X гравця — «доля перевезень» (career/share.ts). */
  share: number;
}

export interface MafiaDeps {
  rapier: RAPIER.World;
  roads: Ht2Roads;
  /** Машина мафії Cayman на землі в точці (null — немає моделі). */
  make(pos: THREE.Vector3, forward: THREE.Vector3): TruckVehicle | null;
  remove(v: TruckVehicle): void;
  sees(p: THREE.Vector3): boolean;
  obstacles(): readonly THREE.Vector3[];
  /** Показати чи сховати реквізит (міни). */
  props(names: readonly string[], on: boolean): void;
  /** Положення реквізиту за імʼям у завантажених регіонах (міни). */
  propPositions(name: string): THREE.Vector3[];
  /** Міліція ближче r (мафія тоді не підходить попереджати). */
  policeNear(p: THREE.Vector3, r: number): boolean;
}

export class Mafia {
  private readonly posts: Post[];
  readonly hoods: Hood[] = [];
  /** Зведені міни: імʼя реквізиту → точки. */
  private readonly mines = new Map<string, THREE.Vector3[]>();
  private activateTimer = 0;
  private strategyTimer = 0;
  private dispatchTimer = DISPATCH_DELAY;
  /** Лічильник переслідування (+0x51D0): 0 — ні, 21 — жене, 22 — попередила, 23 — стріляє. */
  phase = 0;
  private phaseTime = 0;
  private shotTimer = 0;
  private readonly route: ChaseRoute;

  constructor(
    ambushes: MafiaAmbush[],
    private readonly deps: MafiaDeps,
  ) {
    this.posts = ambushes.map((a) => ({ ...a, active: false, hood: null }));
    this.route = new ChaseRoute(deps.roads);
  }

  get count(): number {
    return this.posts.length;
  }

  /** Найближча машина, що жене (для рядка стану). */
  get chase(): { pos: THREE.Vector3 } | null {
    const h = this.hoods.find((x) => x.engaged);
    return h ? { pos: h.v.visual.position } : null;
  }

  /** Машини мафії поруч (рація): person — бандит HOOD1…HOOD8 (з 0). */
  nearby(player: THREE.Vector3, r: number): { id: number; pos: THREE.Vector3; person: number }[] {
    return this.hoods.flatMap((h, id) => (h.v.visual.position.distanceTo(player) < r ? [{ id, pos: h.v.visual.position, person: h.person }] : []));
  }

  /** Тіло машини мафії (ДТП з нею — борг мафії 2d). */
  isMafia(body: RAPIER.RigidBody): boolean {
    return this.hoods.some((h) => h.v.body === body);
  }

  control(dt: number): void {
    for (const h of this.hoods) h.v.update(dt, h.ctrl);
  }

  after(alpha: number): void {
    for (const h of this.hoods) h.v.syncVisual(alpha);
  }

  /** Рівень з меню вільної їзди (порт): 0 — ні, 1 — жене, 2 — попередила, 3 — стріляє. */
  get level(): number {
    return this.phase ? this.phase - 20 : 0;
  }

  setLevel(n: number): void {
    this.phase = n > 0 ? 20 + Math.min(3, n) : 0;
    this.phaseTime = 0;
    if (!n) for (const h of this.hoods) h.engaged = false;
  }

  update(dt: number, pl: MafiaPlayer): MafiaEvent[] {
    const ev: MafiaEvent[] = [];
    this.updatePosts(dt, pl);
    if (!pl.hunted) {
      this.phase = 0;
      this.phaseTime = 0;
      for (const h of this.hoods) h.engaged = false;
    } else if (this.phase === 0) this.phase = 21;
    this.updateFree(dt, pl);
    if (pl.hunted && this.hoods.some((h) => !h.post)) this.route.update(dt, pl.pos);

    let lead: Hood | null = null;
    let leadD = Infinity;
    for (const h of this.hoods) {
      const d = h.v.visual.position.distanceTo(pl.pos);
      if (h.engaged && d < leadD) {
        lead = h;
        leadD = d;
      }
    }
    const speed = pl.vel.length();
    if (lead && this.phase > 0) {
      this.phaseTime += dt;
      if (this.phase === 21 && leadD < WARN_R && !this.deps.policeNear(pl.pos, POLICE_R)) {
        this.phase = 22;
        this.phaseTime = 0;
        ev.push({ kind: 'warn' });
      } else if (this.phase === 22 && this.phaseTime > SHOOT_AFTER && speed > 1) {
        this.phase = 23;
        this.phaseTime = 0;
      }
      if (this.phase >= 22 && speed < 1 && lead.v.speedKmh / 3.6 < 1 && leadD < STOP_R) {
        ev.push({ kind: 'attack' });
        this.phase = 0;
        for (const h of this.hoods) h.engaged = false;
      }
      if (this.phase === 23 && leadD < WARN_R && speed > 1 && (this.shotTimer -= dt) <= 0) {
        this.shotTimer = SHOT_EVERY;
        ev.push({ kind: 'shot', hit: shoot(this.deps.rapier, lead, pl, SHOT_SPREAD), dist: leadD });
      }
    }
    this.updateMines(pl, ev);
    const tmp = new THREE.Vector3();
    for (const h of [...this.hoods]) {
      const up = tmp.set(0, 1, 0).applyQuaternion(h.v.visual.quaternion).y;
      const air = ![0, 1, 2, 3].some((i) => h.v.ctrl.wheelIsInContact(i));
      h.bad = (up < 0.5 || air) && h.v.speedKmh < 3 ? h.bad + dt : 0;
      if (h.v.body.linvel().y < -FALLING) h.bad = LOST_AFTER + 1;
      if (!h.post && (h.bad > LOST_AFTER || (h.tries > MAX_TRIES && !this.deps.sees(h.v.visual.position)))) {
        this.remove(h);
        continue;
      }
      if (h.post) holdStill(h);
      else if (pl.hunted) {
        const v = pl.vel.length();
        const lead2 = this.phase === 23 ? (15 * (v + 0.5)) / (v + 3) : 30;
        steerChase(h, pl, { roads: this.deps.roads, route: this.route, obstacles: this.deps.obstacles(), engaged: h.engaged, tacticalR: TACTICAL_R, lead: lead2 }, dt);
      } else cruiseTo(h, this.route, dt);
    }
    return ev;
  }

  /** Засідки: активація, зайняття й звільнення, пост долучається до погоні (і зводить міни). */
  private updatePosts(dt: number, pl: MafiaPlayer): void {
    if ((this.activateTimer -= dt) <= 0) {
      this.activateTimer = ACTIVATE_EVERY;
      for (const p of this.posts) if (!p.hood) p.active = pl.hunted && pl.share > SHARE_AMBUSH && Math.random() < ACTIVATE_P;
    }
    const step = (this.strategyTimer -= dt) <= 0;
    if (step) this.strategyTimer = 1;
    const tmp = new THREE.Vector3();
    for (const p of this.posts) {
      const d = p.pos.distanceTo(pl.pos);
      if (step && p.active && !p.hood && d > OCCUPY_MIN && d < OCCUPY_MAX && tmp.copy(pl.pos).sub(p.pos).dot(p.dir) > 0) {
        const v = this.deps.make(roadside(this.deps.roads, p.pos, p.dir), p.heading);
        if (v) p.hood = this.add(v, p);
      }
      const h = p.hood;
      if (!h || h.post !== p) continue;
      if (step && d > OCCUPY_MAX) {
        this.remove(h);
        continue;
      }
      // Проїхав перед постом ближче 30 м (releaseAmbushPlayer): пост жене, міни зводяться.
      const hd = h.v.visual.position.distanceTo(pl.pos);
      if (pl.hunted && hd < JOIN_R && tmp.copy(pl.pos).sub(h.v.visual.position).dot(h.v.forward()) > 0) {
        h.post = null;
        p.hood = null;
        p.active = false;
        h.engaged = true;
        this.arm(p);
      }
    }
  }

  /** Звести міни засідки: показати й запамʼятати точки. */
  private arm(p: Post): void {
    if (!p.mines.length) return;
    this.deps.props(p.mines, true);
    for (const n of p.mines) this.mines.set(n, this.deps.propPositions(n));
  }

  /** Міни: дотик — вибух (подія), міна зникає; погоні немає й не видно — сховати. */
  private updateMines(pl: MafiaPlayer, ev: MafiaEvent[]): void {
    for (const [name, pts] of [...this.mines]) {
      if (!pts.length) pts.push(...this.deps.propPositions(name));
      const hit = pts.find((m) => Math.hypot(m.x - pl.pos.x, m.z - pl.pos.z) < MINE_R && Math.abs(m.y - pl.pos.y) < 4);
      if (hit) {
        ev.push({ kind: 'mine', pos: hit.clone() });
        this.mines.delete(name);
        this.deps.props([name], false);
        continue;
      }
      if (!pl.hunted && !pts.some((m) => this.deps.sees(m))) {
        this.mines.delete(name);
        this.deps.props([name], false);
      }
    }
  }

  /** Вільні машини: виклик, захоплення цілі, втрата видимості, відʼїзд. */
  private updateFree(dt: number, pl: MafiaPlayer): void {
    const free = this.hoods.filter((h) => !h.post);
    if (pl.hunted && free.length < MAX_CHASERS && (this.dispatchTimer -= dt) <= 0) {
      this.dispatchTimer = DISPATCH_DELAY;
      this.dispatch(pl);
    }
    if (!pl.hunted) this.dispatchTimer = DISPATCH_DELAY;
    for (const h of free) {
      const d = h.v.visual.position.distanceTo(pl.pos);
      if ((h.seeTimer -= dt) <= 0) {
        h.seeTimer = 1;
        const seen = d < CAPTURE_R && lineOfSight(this.deps.rapier, h, pl);
        h.unseen = seen ? 0 : h.unseen + 1;
        if (pl.hunted && seen) h.engaged = true;
        const vs = h.v.speedKmh / 3.6 + pl.vel.length();
        if (h.engaged && (h.unseen > 25 + 0.2 * vs || h.unseen > 60)) h.engaged = false;
      }
      if (!pl.hunted && (d > 650 || (d > 150 && !this.deps.sees(h.v.visual.position)))) this.remove(h);
    }
  }

  private dispatch(pl: MafiaPlayer): void {
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

  private add(v: TruckVehicle, post: Post | null): Hood {
    const used = new Set(this.hoods.map((h) => h.person));
    const pool = [...Array(PEOPLE).keys()].filter((i) => !used.has(i));
    const person = pool.length ? pool[Math.floor(Math.random() * pool.length)] : 0;
    const h: Hood = { ...newChaser(v), person, post, engaged: false, unseen: 0, seeTimer: 0, bad: 0 };
    this.hoods.push(h);
    return h;
  }

  private remove(h: Hood): void {
    const i = this.hoods.indexOf(h);
    if (i < 0) return;
    this.hoods.splice(i, 1);
    if (h.post?.hood === h) h.post.hood = null;
    this.deps.remove(h.v);
  }

  dispose(): void {
    for (const h of [...this.hoods]) this.remove(h);
    for (const name of this.mines.keys()) this.deps.props([name], false);
    this.mines.clear();
  }
}
