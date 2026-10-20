import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from '../world/world';
import { toThree } from '../world/world';
import { fireRay, type Quarry } from './pursuit';
import { markMover } from '../world/roomVisibility';

/**
 * Гелікоптери Ка-50 Дальнобойщиків 2 (Б11; поведінка king.exe — re/notes/ht2/helicopters.md).
 *
 * Шість гелікоптерів (initHelicopters 0x568b10) висять біля своїх баз — точок появи; «повідець» 600 м по
 * горизонталі. Політ кінематичний: 12 м над землею, тангаж π/16 × газ (≤ π/8), поздовжнє прискорення 30·sin(тангаж),
 * рискання до 120°/с з кутовим прискоренням π/2 рад/с², вертикальна швидкість ≤ 10 м/с, затухання × 0,99 за 0,1 с.
 *
 * Ціль — гравець у розшуку (лічильник міліції ≠ 0) ближче 500 м у прямій видимості. Попередження й затримання —
 * спільна шкала міліції (police.ts: гелікоптер стає ведучим переслідувачем, `chasers()`): ближче 50 м — mess 54,
 * через 10 с — mess 55, ще через 20 с — вогонь. Наведення на точку попереду цілі (L = 30 м; у бою
 * 15·(v + 0,5)/(v + 3) м) + швидкість цілі × 0,5 с; газ — формули 0x566970. Вогонь — два кулемети по черзі раз на
 * 0,14 с, коли ціль у конусі ≈ 26° (вимикається після ≈ 35°), промінь 300 м; спалахи `GunLeftKey`/`GunRightKey`
 * (фази 1→2→3 по 0,1 с). Не бачить ціль довше 25 + 0,2·(v₁ + v₂) с — зависає, довше 60 с — летить додому. Удома
 * висить, колихається й повертає ніс до найближчої машини. Вогні: `BlinkLightKey` — 0,2 с з кожних 1,5 с,
 * `StaticLightKey`/`SearchLightKey` — уночі (година < 6 або > 21).
 *
 * Заборонена зона (лише регіон db, 0x532f00): кімнати з тригером 13 `(27, рівень)` — 3 зовнішня, 2 попередження, 1
 * вогонь. Шлях 3 → 2 — пейджер mess 87 «ЗАПРЕТНАЯ ЗОНА. ОГОНЬ НА ПОРАЖЕНИЕ»; 3 → 2 → 1 — одразу вогонь (лічильник
 * 34); рівень 2 знімає це. Виняток — замовлення в Алмазний (регіон aa).
 *
 * Гіпотези порту: гелікоптер існує, поки завантажено регіон його бази; повернення додому — прямою (у exe — стеком
 * порталів кімнат); обхід перешкод (0x563600, промені ±45°) замінено висотою над найвищою точкою землі під собою й
 * попереду; бічна швидкість гаситься (крен у віражі — для вигляду); поштовх від влучання; гвинти статичні, як в
 * оригіналі (коду обертання не знайдено); займання від влучань і пил `bulletDust` не перенесено.
 */
const HOMES: { region: string; pos: [number, number, number] }[] = [
  { region: 'db', pos: [2650, -2400, 550] },
  { region: 'al', pos: [-2205, -1983, 65] },
  { region: 'aq', pos: [-3400, -3800, 20] },
  { region: 'at', pos: [-4107, -393, 40] },
  { region: 'am', pos: [-600, -2850, 100] },
  { region: 'bb', pos: [-3800, 4000, 20] },
];
const LEASH = 600;
const CAPTURE_R = 500;
const ALTITUDE = 12;
const PITCH_PER_THROTTLE = Math.PI / 16;
const PITCH_MAX = Math.PI / 8;
const PITCH_RATE = Math.PI / 4;
const ACCEL = 30;
const YAW_ACCEL = Math.PI / 2;
const YAW_MAX = (2 * Math.PI) / 3;
const VERT_MAX = 10;
const DRAG = 0.99;
/** Гасіння бічної швидкості, 1/с [Г]. */
const SIDE_DAMP = 1.5;
const BANK_MAX = Math.PI / 6;
const SEE_EVERY = 1;
const LOST_HOLD = 25;
const LOST_HOME = 60;
const ESCORT_LEAD = 30;
const HOVER_R = 10;
const FIRE_ON = 0.5;
const FIRE_OFF = 0.707;
const SHOT_EVERY = 0.14;
const SHOT_RANGE = 300;
/** Поштовх від влучання, частка маси (міліція — 0,1; у exe сила кулі гелікоптера 2,0 проти 0,1, абсолют — Г). */
const SHOT_FORCE = 0.3;
/** Сила кулі для займання (P = 2, як у гравця, drive.ts). */
const SHOT_POWER = 2;
const FLASH_PHASE = 0.1;
const BLINK_PERIOD = 1.5;
const BLINK_ON = 0.2;
/** Швидкість повернення додому, м/с [Г]. */
const RETURN_SPEED = 40;
const ARRIVE_DECEL = 5;
/** Гучність гвинтів падає до нуля на цій відстані, м [Г]. */
const SOUND_R = 600;

export interface CopterModel {
  root: THREE.Object3D;
  setSwitch(name: string, state: number): void;
}

export interface CopterDeps {
  rapier: RAPIER.World;
  scene: THREE.Object3D;
  /** Модель k50 з TRUCKS.B3D (окремий екземпляр з перемикачами). */
  model(): CopterModel | null;
  /** Машини поруч (трафік, далекобійники) — удома гелікоптер повертає до них ніс. */
  obstacles(): readonly THREE.Vector3[];
  /** Звук гвинтів (helicopterSound) — гучність 0…1, панорама −1…1; null — без звуку. */
  loop?(): { set(volume: number, rate?: number, balance?: number): void; stop(): void } | null;
}

export interface CopterTarget extends Quarry {
  /** Лічильник переслідування міліції (police.phase): 0 — не в розшуку, 4 — вогонь. */
  phase: number;
  /** Година доби (вогні). */
  hour: number;
}

export type CopterEvent = { kind: 'shot'; hit: boolean; dist: number } | { kind: 'miss'; dist: number };

type Mode = 'home' | 'return' | 'escort' | 'attack' | 'hold';

interface Copter {
  home: THREE.Vector3;
  region: string;
  model: CopterModel | null;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  yaw: number;
  yawRate: number;
  pitch: number;
  mode: Mode;
  engaged: boolean;
  seen: boolean;
  seeTimer: number;
  unseen: number;
  firing: boolean;
  shotTimer: number;
  /** Час від пострілу лівого/правого кулемета, с; який стріляв останнім. */
  gunAge: [number, number];
  lastGun: 0 | 1;
  sway: number;
  swayV: number;
  sound: ReturnType<NonNullable<CopterDeps['loop']>>;
  /** Стани перемикачів (щоб не ставити щокадру). */
  sw: Map<string, number>;
}

export class Helicopters {
  readonly copters: Copter[];
  private time = 0;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();

  constructor(private readonly deps: CopterDeps) {
    this.copters = HOMES.map((h) => {
      const home = toThree(...h.pos);
      return {
        home,
        region: h.region,
        model: null,
        pos: home.clone(),
        vel: new THREE.Vector3(),
        yaw: 0,
        yawRate: 0,
        pitch: 0,
        mode: 'home' as Mode,
        engaged: false,
        seen: false,
        seeTimer: 0,
        unseen: 0,
        firing: false,
        shotTimer: 0,
        gunAge: [9, 9] as [number, number],
        lastGun: 0 as 0 | 1,
        sway: Math.random() * 10,
        swayV: 0,
        sound: null,
        sw: new Map(),
      };
    });
  }

  /** Чи є гелікоптер ближче r (king.exe 0x4cfd10: Ка-50 — теж «міліція поруч» для штрафів за ДТП). */
  near(p: THREE.Vector3, r: number): boolean {
    return this.copters.some((c) => c.model && c.pos.distanceTo(p) < r);
  }

  /** Гелікоптери, що ведуть ціль (для шкали попереджень і затримання міліції). */
  chasers(): { pos: THREE.Vector3; speed: number }[] {
    return this.copters.filter((c) => c.model && c.engaged && c.seen).map((c) => ({ pos: c.pos, speed: c.vel.length() }));
  }

  /** Кадр: поява з регіоном бази, ціль, політ, вогонь, вогні. */
  update(dt: number, loaded: ReadonlySet<string>, q: CopterTarget, view: THREE.Vector3): CopterEvent[] {
    this.time += dt;
    const ev: CopterEvent[] = [];
    for (const c of this.copters) {
      if (!loaded.has(c.region)) {
        if (c.model) this.unload(c);
        continue;
      }
      if (!c.model && !this.load(c)) continue;
      this.think(c, dt, q);
      this.fly(c, dt, q);
      if (c.mode === 'attack') this.weapons(c, dt, q, ev);
      else c.firing = false;
      for (let i = 0; i < 2; i++) c.gunAge[i] += dt;
      this.draw(c, q.hour, view);
    }
    return ev;
  }

  dispose(): void {
    for (const c of this.copters) if (c.model) this.unload(c);
  }

  private load(c: Copter): boolean {
    const m = this.deps.model();
    if (!m) return false;
    // Модель у системі гри → обгортка в системі Three.js (вперед −Z).
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(m.root);
    const root = new THREE.Group();
    root.add(frame);
    markMover(root);
    this.deps.scene.add(root);
    c.model = { root, setSwitch: m.setSwitch };
    c.sw.clear();
    c.pos.copy(c.home);
    c.vel.set(0, 0, 0);
    c.mode = 'home';
    c.engaged = false;
    c.sound = this.deps.loop?.() ?? null;
    return true;
  }

  private unload(c: Copter): void {
    this.deps.scene.remove(c.model!.root);
    c.model = null;
    c.sound?.stop();
    c.sound = null;
  }

  /** Вибір режиму: захоплення цілі, повідець, втрата видимості (0x566550, 0x5663c0, 0x566970). */
  private think(c: Copter, dt: number, q: CopterTarget): void {
    const d = c.pos.distanceTo(q.pos);
    if ((c.seeTimer -= dt) <= 0) {
      c.seeTimer = SEE_EVERY;
      c.seen = d < CAPTURE_R && this.visible(c.pos, q);
    }
    if (q.phase === 0) {
      if (c.engaged) c.mode = 'return';
      c.engaged = false;
    } else if (!c.engaged && c.seen && d < CAPTURE_R) c.engaged = true;
    if (c.engaged) {
      c.unseen = c.seen ? 0 : c.unseen + dt;
      const leash = this.tmp.copy(c.pos).sub(c.home).setY(0).length();
      if (leash > LEASH || c.unseen > LOST_HOME) {
        c.engaged = false;
        c.mode = 'return';
      } else if (c.unseen > LOST_HOLD + 0.2 * (c.vel.length() + q.vel.length())) c.mode = 'hold';
      else c.mode = q.phase >= 4 ? 'attack' : 'escort';
    } else if (c.mode !== 'home' && c.mode !== 'return') c.mode = 'return';
    if (c.mode === 'return' && this.tmp.copy(c.pos).sub(c.home).setY(0).length() < this.brakeDist(c) + 5) c.mode = 'home';
  }

  private brakeDist(c: Copter): number {
    const v = c.vel.length();
    return (v * v) / (2 * ARRIVE_DECEL);
  }

  /** Політ: точка, газ, рискання, висота (0x566970, 0x561f30). */
  private fly(c: Copter, dt: number, q: CopterTarget): void {
    const h = this.tmp2.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const vf = c.vel.x * h.x + c.vel.z * h.z;
    const vh = Math.hypot(c.vel.x, c.vel.z);
    const v = Math.hypot(q.vel.x, q.vel.z);
    let aim: THREE.Vector3;
    let throttle: number;
    let sway = 0;
    if (c.mode === 'escort' || c.mode === 'attack') {
      const lead = c.mode === 'attack' ? (15 * (v + 0.5)) / (v + 3) : ESCORT_LEAD;
      aim = q.pos.clone().addScaledVector(q.forward, lead).addScaledVector(q.vel, 0.5);
      const d = Math.hypot(aim.x - c.pos.x, aim.z - c.pos.z);
      if (c.mode === 'escort')
        throttle = d >= 15 ? 0.6 / (25 / Math.max(d, 1) + (0.6 * vh) / Math.max(v, 0.1) + 0.3) : (-0.1 * vf) / (Math.abs(vf) + 10);
      else if (Math.hypot(q.pos.x - c.pos.x, q.pos.z - c.pos.z) < HOVER_R) {
        // Зависання над ціллю: точка — ціль + її швидкість за 1 с.
        aim = q.pos.clone().addScaledVector(q.vel, 1);
        throttle = 0.15 * ((v + 0.1) / (v + 5)) ** 3;
      } else throttle = (1 / (25 / Math.max(d, 1) + (0.6 * vh) / Math.max(v, 1) + 0.3)) * ((v + 0.1) / (v + 5)) ** 2;
    } else if (c.mode === 'return') {
      aim = c.home;
      const d = Math.hypot(aim.x - c.pos.x, aim.z - c.pos.z);
      const want = Math.min(RETURN_SPEED, Math.sqrt(2 * ARRIVE_DECEL * d));
      throttle = THREE.MathUtils.clamp((want - vf) / 5, -2, 2);
    } else {
      // Висіти (удома чи втративши ціль): гальмувати й повертати ніс до найближчої машини; колихання.
      throttle = THREE.MathUtils.clamp(-vf / 5, -2, 2);
      aim = this.nearestCar(c, q) ?? c.pos.clone().add(h);
      c.swayV += (Math.random() - 0.5) * dt * 4;
      c.swayV *= 0.98;
      c.sway += c.swayV * dt;
      sway = 0.2 * Math.sin(c.sway);
    }
    // Рискання: до точки, з межею кутової швидкості й гальмуванням вчасно.
    const dx = aim.x - c.pos.x;
    const dz = aim.z - c.pos.z;
    let err = Math.atan2(-dx, -dz) - c.yaw;
    err = Math.atan2(Math.sin(err), Math.cos(err));
    const wantRate = Math.hypot(dx, dz) < 1 ? 0 : Math.sign(err) * Math.min(YAW_MAX, Math.sqrt(2 * YAW_ACCEL * Math.abs(err)));
    const dr = THREE.MathUtils.clamp(wantRate - c.yawRate, -YAW_ACCEL * dt, YAW_ACCEL * dt);
    c.yawRate += dr;
    c.yaw += (c.yawRate + sway) * dt;
    // Тангаж і поздовжнє прискорення.
    const pitch = THREE.MathUtils.clamp(PITCH_PER_THROTTLE * throttle, -PITCH_MAX, PITCH_MAX);
    c.pitch += THREE.MathUtils.clamp(pitch - c.pitch, -PITCH_RATE * dt, PITCH_RATE * dt);
    h.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    c.vel.addScaledVector(h, ACCEL * Math.sin(c.pitch) * dt);
    const side = c.vel.x * -h.z + c.vel.z * h.x;
    const damp = 1 - Math.exp(-SIDE_DAMP * dt);
    c.vel.x -= -h.z * side * damp;
    c.vel.z -= h.x * side * damp;
    const drag = DRAG ** (dt * 10);
    c.vel.x *= drag;
    c.vel.z *= drag;
    // Висота: 12 м над найвищою землею під собою й попереду (замість обходу перешкод — гіпотеза).
    let ground = -Infinity;
    for (const ahead of [0, 20, 2 * vh]) {
      const g = this.groundAt(this.tmp.copy(c.pos).addScaledVector(h, ahead));
      if (g !== null) ground = Math.max(ground, g);
    }
    const goal = Number.isFinite(ground) ? ground + ALTITUDE : c.pos.y;
    c.vel.y = THREE.MathUtils.clamp(goal - c.pos.y, -VERT_MAX, VERT_MAX) + sway;
    c.pos.addScaledVector(c.vel, dt);
  }

  /** Найближча видима машина (гравець чи трафік) — куди дивитися на місці (0x5668c0). */
  private nearestCar(c: Copter, q: CopterTarget): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bd = CAPTURE_R;
    for (const p of [q.pos, ...this.deps.obstacles()]) {
      const d = p.distanceTo(c.pos);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    return best;
  }

  /** Кулемети: конус, темп, черговість, промінь (0x567bb0, 0x567440). */
  private weapons(c: Copter, dt: number, q: CopterTarget, ev: CopterEvent[]): void {
    const h = this.tmp2.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const rel = this.tmp.copy(q.pos).sub(c.pos);
    const f = rel.x * h.x + rel.z * h.z;
    const s = Math.abs(rel.x * -h.z + rel.z * h.x);
    if (f > 0 && s < FIRE_ON * f) c.firing = true;
    else if (f <= 0 || s > FIRE_OFF * f) c.firing = false;
    if (!c.firing || !c.seen || (c.shotTimer -= dt) > 0) return;
    c.shotTimer = SHOT_EVERY;
    const gun: 0 | 1 = c.lastGun === 0 ? 1 : 0;
    c.lastGun = gun;
    c.gunAge[gun] = 0;
    // Кулемет: зліва чи справа під корпусом; бічна складова напрямку обмежена 0,2…0,3 поздовжньої (кулемети не
    // повертаються — промах, якщо ціль не прямо попереду).
    const right = new THREE.Vector3(-h.z, 0, h.x);
    const from = c.pos.clone().addScaledVector(right, gun === 0 ? -0.7 : 0.7).setY(c.pos.y - 0.5);
    const to = q.pos.clone().setY(q.pos.y + 1.5).sub(from);
    const fw = to.x * h.x + to.z * h.z;
    const sd = to.x * right.x + to.z * right.z;
    const lim = (0.2 + 0.1 * Math.random()) * Math.abs(fw);
    const dir = h.clone().multiplyScalar(fw).addScaledVector(right, THREE.MathUtils.clamp(sd, -lim, lim)).setY(to.y).normalize();
    const shot = fireRay(this.deps.rapier, from, dir, SHOT_RANGE, q, SHOT_FORCE, undefined, SHOT_POWER);
    const dist = c.pos.distanceTo(q.pos);
    ev.push(shot.hit ? { kind: 'shot', hit: true, dist } : { kind: 'miss', dist: shot.point ? shot.point.distanceTo(q.pos) : dist });
  }

  /** Модель: поза, вогні, спалахи, звук. */
  private draw(c: Copter, hour: number, view: THREE.Vector3): void {
    const m = c.model!;
    m.root.position.copy(c.pos);
    const h = this.tmp2.set(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    const side = c.vel.x * -h.z + c.vel.z * h.x;
    const bank = THREE.MathUtils.clamp(-c.yawRate * Math.hypot(c.vel.x, c.vel.z) * 0.03 + side * 0.02, -BANK_MAX, BANK_MAX);
    m.root.rotation.set(-c.pitch, c.yaw, bank, 'YXZ');
    const night = hour < 6 || hour > 21 ? 1 : 0;
    this.set(c, 'StaticLightKey', night);
    this.set(c, 'SearchLightKey', night);
    this.set(c, 'BlinkLightKey', this.time % BLINK_PERIOD < BLINK_ON ? 1 : 0);
    const flash = (age: number) => (age < FLASH_PHASE ? 1 : age < 2 * FLASH_PHASE ? 2 : age < 3 * FLASH_PHASE ? 3 : 0);
    this.set(c, 'GunLeftKey', c.lastGun === 0 ? flash(c.gunAge[0]) : 0);
    this.set(c, 'GunRightKey', c.lastGun === 1 ? flash(c.gunAge[1]) : 0);
    if (c.sound) {
      const d = c.pos.distanceTo(view);
      const vol = Math.max(0, 1 - d / SOUND_R) ** 2;
      c.sound.set(vol, 1);
    }
  }

  private set(c: Copter, key: string, state: number): void {
    if (c.sw.get(key) === state) return;
    c.sw.set(key, state);
    c.model!.setSwitch(key, state);
  }

  /** Висота землі (нерухомі колізії) під точкою; null — колізій там немає. */
  private groundAt(p: THREE.Vector3): number | null {
    const hit = this.deps.rapier.castRay(new RAPIER.Ray({ x: p.x, y: p.y + 300, z: p.z }, { x: 0, y: -1, z: 0 }), 1000, true, undefined, undefined, undefined, undefined, (col) => col.parent()?.isFixed() ?? true);
    return hit ? p.y + 300 - hit.timeOfImpact : null;
  }

  /** Пряма видимість від гелікоптера до цілі (лише нерухомі колізії). */
  private visible(from: THREE.Vector3, q: Quarry): boolean {
    const to = q.pos.clone().setY(q.pos.y + 1.5);
    const dist = from.distanceTo(to);
    if (dist < 3) return true;
    const hit = this.deps.rapier.castRay(new RAPIER.Ray(from, to.sub(from).divideScalar(dist)), dist - 3, true, undefined, undefined, undefined, undefined, (col) => col.parent()?.isFixed() ?? true);
    return !hit;
  }
}

/**
 * Заборонена зона (0x532f00): кімнати з тригером 13 `(27, рівень)` у даних регіону. Рівень гравця — кімната, в якій він;
 * кімнати без тригера рівня не змінюють (обробник у exe викликається лише в тригерах).
 */
export type ZoneEvent = 'warn' | 'fire' | 'clear';

export function zoneRooms(blocks: readonly Block[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of blocks)
    if (b.data.t === 19 && b.name)
      for (const g of b.groups ?? [])
        for (const c of g) if (c.data.t === 13 && c.data.trigger.i1 === 27) out.set(b.name.toLowerCase(), c.data.trigger.i2);
  return out;
}

const ZONE_EVERY = 0.25;

export class ForbiddenZone {
  /** Поточний, попередній і передпопередній рівні (game +0x584/+0x588/+0x58c). */
  private levels: [number, number, number] = [0, 0, 0];
  private warned = false;
  /** Вогонь на ураження (лічильник 34) — поки не виїхав у рівень 2 чи не затримано. */
  hot = false;
  private timer = 0;
  private readonly seen = new WeakSet<LoadedRegion>();
  private readonly rooms: { region: LoadedRegion; group: THREE.Object3D; box: THREE.Box3; level: number }[] = [];

  /** Кадр: рівень кімнати під гравцем → події (exempt — замовлення в Алмазний, прапорець 0x8000). */
  update(dt: number, loaded: Iterable<LoadedRegion>, pos: THREE.Vector3, exempt: boolean): ZoneEvent[] {
    if ((this.timer -= dt) > 0) return [];
    this.timer = ZONE_EVERY;
    this.sync(loaded);
    const level = this.levelAt(pos);
    if (level === null) return [];
    if (level !== this.levels[0]) this.levels = [level, this.levels[0], this.levels[1]];
    const ev: ZoneEvent[] = [];
    if (level === 2) {
      if (this.hot) ev.push('clear');
      this.hot = false;
      if (this.levels[1] === 3 && !this.warned && !exempt) {
        this.warned = true;
        ev.push('warn');
      }
    } else if (level === 1) {
      this.warned = false;
      if (this.levels[1] === 2 && this.levels[2] === 3 && !exempt && !this.hot) {
        this.hot = true;
        ev.push('fire');
      }
    }
    return ev;
  }

  private sync(loaded: Iterable<LoadedRegion>): void {
    const live = new Set(loaded);
    for (let i = this.rooms.length - 1; i >= 0; i--) if (!live.has(this.rooms[i].region)) this.rooms.splice(i, 1);
    for (const r of live) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      const zones = zoneRooms(r.built.assembler.b3d.blocks);
      if (!zones.size) continue;
      for (const g of r.built.rooms) {
        const level = zones.get(g.name.toLowerCase());
        if (level !== undefined) this.rooms.push({ region: r, group: g, box: new THREE.Box3().setFromObject(g), level });
      }
    }
  }

  /**
   * Рівень кімнати, в якій точка: габарити кімнати (з запасом 3 м по висоті — гравець на дорозі кімнати, а не на
   * горі над тунелем); з кількох — найменша. null — не в кімнаті зони. Геометрія кімнат зони — здебільшого стіни й
   * склепіння, тож промінь униз дорогу не знаходить.
   */
  private levelAt(p: THREE.Vector3): number | null {
    let best: { v: number; level: number } | null = null;
    for (const r of this.rooms) {
      const b = r.box;
      if (p.x < b.min.x || p.x > b.max.x || p.z < b.min.z || p.z > b.max.z || p.y < b.min.y - 3 || p.y > b.max.y + 3) continue;
      const v = (b.max.x - b.min.x) * (b.max.z - b.min.z);
      if (!best || v < best.v) best = { v, level: r.level };
    }
    return best?.level ?? null;
  }
}

/** Бази гелікоптерів (для тестів і мапи). */
export const COPTER_HOMES = HOMES;
