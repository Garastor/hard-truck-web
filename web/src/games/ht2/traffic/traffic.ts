import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '../engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '../engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Ht2Roads, RoadLine } from '../world/roads';
import { coast, newMover, step, type Mover, type Obstacle } from './driver';
import type { Ht2Trucks } from '../vehicles/trucks';

/**
 * Трафік Дальнобойщиків 2: машини з `evehicles.sch` класу `dumb` («тупі» легковики, автобус, пікапи) — запис
 * `(vehicle ID "Модель" варіант клас поведінка …)`; модель — вузол TRUCKS.B3D, варіант 0…3 — набір матеріалів
 * (`Fiat_all1` → `Fiat_all3`; кластери TRUCKS.OVL `Fiat1_car_cl`…).
 *
 * Населення — як у king.exe (re/notes/ht2/traffic.md): постійні машини `dumb N` з ENV/GAME.CNF (N·T, T — повзунок
 * «насиченість трас») рухаються всією мережею абстрактно (без моделі, крейсерською швидкістю вздовж ліній), а
 * привиди `ghost` зʼявляються довкола гравця (updateGhosts). Поблизу гравця в завантаженому регіоні машина
 * дістає модель і водія.
 *
 * Рух — водій за king.exe (`driver.ts`: швидкість на кривих, дистанція до лідера, перестроювання перед поворотом,
 * обʼїзд тих, хто стоїть), але без фізики: машина котиться лінією смуги (у king.exe ближче 80 м до гравця вона
 * фізична). Тіло в Rapier — кінематичне: гравець упирається в нього, але штовхнути не може.
 */
/** Модель зʼявляється ближче за це до гравця й зникає далі за VISIBLE_OFF (гіпотеза порту: у king.exe — модулі світу), м. */
const VISIBLE_ON = 700;
const VISIBLE_OFF = 750;
/**
 * Привиди (king.exe 0x420ed0): поява за 2·GHOST_NEAR від гравця, дорога — не ближче GHOST_NEAR; зникають далі
 * GHOST_KEEP, якщо старші за GHOST_AGE с чи далі GHOST_FAR.
 */
const GHOST_NEAR = 160;
const GHOST_KEEP = 330;
const GHOST_AGE = 72;
const GHOST_FAR = 700;
/** Період detectJams (king.exe 0x434780), с. */
const JAM_PERIOD = 9.2;
/** Крейсерська швидкість обережних водіїв dumb (king.exe 0x4d4700: межа 20 м/с; розкид — порту), м/с. */
const CRUISE_MIN = 17;
const CRUISE_MAX = 20;
/** Півдовжина гравця й інших точок-перешкод, м. */
const AVOID_HALF = 2.5;

export interface TrafficKind {
  model: string;
  variant: number;
}

/** Типи трафіку з evehicles.sch (клас car, поведінка dumb), моделі яких є в TRUCKS.B3D. */
export function trafficKinds(sch: SExpr[], trucks: Ht2Trucks): TrafficKind[] {
  const out: TrafficKind[] = [];
  for (const e of sch) {
    if (!isList(e) || e[0] !== 'vehicle') continue;
    const model = str(e[2]);
    const behaviour = e[5];
    const dumb = behaviour === 'dumb' || (isList(behaviour) && behaviour.includes('dumb'));
    if (e[4] !== 'car' || !dumb || !trucks.asm.block(model)) continue;
    out.push({ model, variant: num(e[3]) });
  }
  return out;
}

interface Car extends Mover {
  kind: TrafficKind;
  /** Привид (ghost): зʼявляється довкола гравця й зникає; інакше — постійна машина dumb. */
  ghost: boolean;
  /** Вік, с. */
  age: number;
  /** Модель і тіло — лише поблизу гравця в завантаженому регіоні (інакше машина абстрактна). */
  root: THREE.Group | null;
  body: RAPIER.RigidBody | null;
}

/** Кількості з ENV/GAME.CNF (`playertypes`) і повзунок «насиченість трас». */
export interface TrafficConfig {
  /** `dumb N` — постійні машини на всю карту (king.exe створює N·T, 0x422400). */
  dumb: number;
  /** `ghost N` — найбільше привидів (гіпотеза: з цим числом порівнює updateGhosts). */
  ghost: number;
  /** Насиченість трас T, 0…1. */
  density: number;
}

export class Traffic {
  /** Машини з моделлю (поблизу гравця): для мінікарти, автопілота й зіткнень. */
  cars: Car[] = [];
  /** Усі машини, зокрема абстрактні. */
  readonly all: Car[] = [];
  private readonly templates = new Map<string, THREE.Object3D>();
  /** Позиції перешкод (гравець, причіп, суперники) минулого кроку — для їхньої швидкості. */
  private avoidPrev: THREE.Vector3[] = [];
  private ghostTimer = 0;
  private jamTimer = JAM_PERIOD;
  /** Затор (detectJams): нові привиди не зʼявляються. */
  jam = false;
  private readonly ghostPeriod: number;
  private readonly totalLength: number;
  private started = false;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly roads: Ht2Roads,
    private readonly trucks: Ht2Trucks,
    private readonly kinds: TrafficKind[],
    /** Чи завантажено регіон (модель — лише там, де є дорога й колізії). */
    private readonly loaded: (region: string) => boolean,
    private readonly config: TrafficConfig = { dumb: 70, ghost: 25, density: 1 },
  ) {
    // king.exe 0x434780: період updateGhosts = 15^(1 − 0,7·T) · 2,667 с.
    this.ghostPeriod = Math.pow(15, 1 - 0.7 * config.density) * 2.667;
    this.totalLength = roads.lines.reduce((s, l) => s + l.length, 0);
  }

  /** Фари машин, що зʼявляються (king.exe: при створенні — з 22:00 до 6:00; ставить режим їзди). */
  lights = false;

  /** Скільки привидів зараз. */
  get ghosts(): number {
    return this.all.reduce((n, c) => n + (c.ghost ? 1 : 0), 0);
  }

  /**
   * Модель машини потрібного кольору (кешується; повертається копія). З фарами — перемикачі моделі
   * `refer_HeadLightKey` і `refer_SizeLightKey` у стані 1.
   */
  private model(kind: TrafficKind, lights: boolean): THREE.Object3D | null {
    const key = `${kind.model}#${kind.variant}${lights ? '+L' : ''}`;
    let tpl = this.templates.get(key);
    if (!tpl) {
      let base: THREE.Object3D | null;
      if (lights) {
        const dyn = this.trucks.asm.dynamicObject(kind.model);
        dyn?.setSwitch('refer_HeadLightKey', 1);
        dyn?.setSwitch('refer_SizeLightKey', 1);
        base = dyn?.root ?? null;
      } else base = this.trucks.asm.template(kind.model);
      if (!base) return null;
      tpl = lights ? base : base.clone();
      if (kind.variant > 0) recolor(tpl, this.trucks, kind.variant + 1);
      this.templates.set(key, tpl);
    }
    return tpl.clone();
  }

  /** player — гравець; extra — інші точки, яких машини не мають наїхати (напівпричіп гравця, суперники). */
  update(dt: number, player: THREE.Vector3, extra: readonly THREE.Vector3[] = []): void {
    if (!this.started) {
      this.started = true;
      // Постійні машини dumb — на старті по всій мережі (king.exe createPlayersRegular: N·T).
      const n = Math.round(this.config.dumb * this.config.density);
      for (let i = 0; i < n && this.kinds.length; i++) this.addDumb(player, 0);
    }
    this.updateGhosts(dt, player);
    this.detectJams(dt);

    // Абстрактні — уздовж мережі; поблизу в завантаженому регіоні — з моделлю й водієм.
    for (const c of this.all) {
      const d = c.pos.distanceTo(player);
      const near = d < (c.root ? VISIBLE_OFF : VISIBLE_ON) && this.loaded(c.line.region);
      if (near && !c.root) this.activate(c);
      else if (!near && c.root) this.deactivate(c);
      c.age += dt;
    }
    this.cars = this.all.filter((c) => c.root);

    const avoid = [player, ...extra];
    const obstacles: Obstacle[] = this.cars.map((c) => ({ pos: c.pos, vel: c.heading.clone().multiplyScalar(c.speed), half: c.halfLen, mover: c }));
    avoid.forEach((p, i) => {
      const prev = this.avoidPrev[i];
      const vel = prev && dt > 0 && this.avoidPrev.length === avoid.length ? p.clone().sub(prev).divideScalar(dt) : new THREE.Vector3();
      obstacles.push({ pos: p, vel: vel.lengthSq() < 900 ? vel : new THREE.Vector3(), half: AVOID_HALF });
    });
    this.avoidPrev = avoid.map((p) => p.clone());
    for (const c of this.all) {
      if (c.root) this.drive(c, dt, avoid, obstacles);
      else coast(c, dt);
    }
    // Тупик: привид зникає, постійна машина — заново далеко від гравця.
    for (let i = this.all.length - 1; i >= 0; i--) {
      const c = this.all[i];
      if (!c.gone) continue;
      this.remove(i);
      if (!c.ghost) this.addDumb(player, VISIBLE_OFF);
    }
    this.cars = this.all.filter((c) => c.root);
  }

  /** Постійна машина на випадковій лінії (пропорційно довжині), не ближче за minDist до гравця. */
  private addDumb(player: THREE.Vector3, minDist: number): void {
    for (let attempt = 0; attempt < 20; attempt++) {
      let r = Math.random() * this.totalLength;
      let line = this.roads.lines[0];
      for (const l of this.roads.lines) {
        line = l;
        if ((r -= l.length) <= 0) break;
      }
      const seg = Math.floor(Math.random() * (line.pts.length - 1));
      if (line.pts[seg].distanceTo(player) < minDist) continue;
      this.all.push(this.newCar(line, seg, false));
      return;
    }
  }

  private newCar(line: RoadLine, seg: number, ghost: boolean): Car {
    const kind = this.kinds[Math.floor(Math.random() * this.kinds.length)];
    const cruise = CRUISE_MIN + Math.random() * (CRUISE_MAX - CRUISE_MIN);
    return Object.assign(newMover(line, seg, Math.random(), cruise, 2.2), { kind, ghost, age: 0, root: null, body: null });
  }

  /**
   * Привиди (king.exe updateGhosts 0x420ed0, кожні ghostPeriod с): зникають далі 330 м, якщо старші за 72 с чи
   * далі 700 м; нові — без затору й понад ліміт, з імовірністю ½ (гіпотеза: в king.exe — за невідомою умовою),
   * до 8 спроб: точка за 320 м від гравця під випадковим кутом → найближча дорога без бітів 0x10/0x40, щонайменше
   * за 160 м від гравця; зʼявляється з імовірністю √(W/14) × (клас 2 — ½, клас 3 — ¼), інакше — до наступного разу.
   */
  private updateGhosts(dt: number, player: THREE.Vector3): void {
    if ((this.ghostTimer -= dt) > 0) return;
    this.ghostTimer = this.ghostPeriod;
    for (let i = this.all.length - 1; i >= 0; i--) {
      const c = this.all[i];
      if (!c.ghost) continue;
      const d = c.pos.distanceTo(player);
      if ((d > GHOST_KEEP && (c.age > GHOST_AGE || d > GHOST_FAR)) || !this.loaded(c.line.region)) this.remove(i);
    }
    if (this.jam || this.ghosts >= this.config.ghost || !this.kinds.length || Math.random() < 0.5) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const at = player.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(2 * GHOST_NEAR));
      const n = this.roads.nearestAxis(at);
      if (!n || n.axis.flags & 0x50 || n.point.distanceTo(player) < GHOST_NEAR || !this.loaded(n.axis.region)) continue;
      const p = Math.sqrt(n.axis.width / 14) * (n.axis.cls === 2 ? 0.5 : n.axis.cls === 3 ? 0.25 : 1);
      if (Math.random() >= p) return;
      const lines = this.roads.linesOf(n.axis.road);
      if (!lines.length) return;
      const line = lines[Math.floor(Math.random() * lines.length)];
      let seg = 0;
      for (let i = 0; i + 1 < line.pts.length; i++) if (line.pts[i].distanceTo(n.point) < line.pts[seg].distanceTo(n.point)) seg = i;
      this.all.push(this.newCar(line, Math.min(seg, line.pts.length - 2), true));
      return;
    }
  }

  /** Затор (king.exe detectJams 0x420040, кожні 9,2 с): понад 2 пари повільних (< 5 м/с) машин ближче 20 м. */
  private detectJams(dt: number): void {
    if ((this.jamTimer -= dt) > 0) return;
    this.jamTimer = JAM_PERIOD;
    const slow = this.cars.filter((c) => c.speed < 5);
    let pairs = 0;
    for (let i = 0; i < slow.length; i++) for (let j = i + 1; j < slow.length; j++) if (slow[i].pos.distanceTo(slow[j].pos) < 20) pairs++;
    this.jam = pairs > 2;
  }

  /** Модель і кінематичне тіло машини, що наблизилась. */
  private activate(c: Car): void {
    const model = this.model(c.kind, this.lights);
    if (!model) return;
    // Модель у системі гри → обгортка в системі Three.js (вперед −Z).
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model);
    const root = new THREE.Group();
    root.add(frame);
    root.updateMatrixWorld(true);
    const box = visibleBox(model);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Модель стоїть на колесах: низ коробки — дорога.
    frame.position.y = -box.min.y;
    root.position.copy(c.pos);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), c.heading, new THREE.Vector3(0, 1, 0)));
    const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(c.pos.x, c.pos.y, c.pos.z));
    this.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y - box.min.y, center.z)
        .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
      body,
    );
    body.setRotation(root.quaternion, true);
    this.scene.add(root);
    c.root = root;
    c.body = body;
    c.halfLen = size.z / 2;
  }

  private deactivate(c: Car): void {
    if (c.root) this.scene.remove(c.root);
    if (c.body) this.rapier.removeRigidBody(c.body);
    c.root = null;
    c.body = null;
  }

  private remove(i: number): void {
    this.deactivate(this.all[i]);
    this.all.splice(i, 1);
  }

  /** Рух водія; гравець (тягач чи причіп) упритул спереду — стоп одразу. */
  private drive(c: Car, dt: number, avoid: readonly THREE.Vector3[], obstacles: readonly Obstacle[]): void {
    step(c, dt, obstacles);
    // Кінематична машина інакше штовхає гравця з «нескінченною» масою (на перехресті вантажівка з причепом
    // виїжджає збоку, гальмувати пізно).
    for (const o of avoid) {
      const rel = o.clone().sub(c.pos);
      const along = rel.x * c.heading.x + rel.z * c.heading.z;
      const side = Math.abs(rel.x * c.heading.z - rel.z * c.heading.x);
      if (along > 0 && along < c.halfLen + 5 && side < 2.5) c.speed = 0;
    }
    if (!c.root || !c.body) return;
    // lookAt ставить +Z від цілі до ока: ціль — уперед, тож −Z (перед моделі) дивиться за рухом.
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), c.heading, new THREE.Vector3(0, 1, 0)));
    // Плавний поворот на зламах ламаної.
    c.root.quaternion.slerp(q, Math.min(1, dt * 6));
    c.root.position.copy(c.pos);
    c.body.setNextKinematicTranslation(c.pos);
    c.body.setNextKinematicRotation(c.root.quaternion);
  }

  dispose(): void {
    for (let i = this.all.length - 1; i >= 0; i--) this.remove(i);
    this.cars = [];
  }
}

/** Варіант кольору: матеріали `<…>1` моделі → `<…>N` (Fiat_all1 → Fiat_all3), якщо такий є в TRUCKS.B3D. */
export function recolor(root: THREE.Object3D, trucks: Ht2Trucks, n: number): void {
  const names = trucks.asm.b3d.materials.map((m) => m.toLowerCase());
  const swap = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const one = (m: THREE.Material): THREE.Material => {
      const hit = swap.get(m);
      if (hit) return hit;
      const nm = /^(.*?)1$/.exec(m.name);
      const idx = nm ? names.indexOf(`${nm[1]}${n}`) : -1;
      const out = idx >= 0 ? trucks.asm.lib.material(idx) : m;
      swap.set(m, out);
      return out;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
}
