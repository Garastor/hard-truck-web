import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '../engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '../engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Ht2Roads, RoadLine } from '../world/roads';
import { coast, decide, newMover, pathAhead, retrace, roadLimit, setGoals, step, sync, turnSignal, type Mover, type Obstacle } from './driver';
import { Navigator } from '../world/navigator';
import { control, newPhysState, type PhysState } from './physical';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
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
/**
 * Модель — у радіусі R = кінець туману + 50 м (від VISIBLE_ON до VISIBLE_MAX; гіпотеза порту: у king.exe — модулі
 * світу). Відхилення від оригіналу (на прохання користувача): машини не виникають і не зникають на очах — модель
 * вмикається ближче R − 100 м лише невидимою (поза кадром, за рельєфом чи туманом), привиди зʼявляються й
 * зникають лише в невидимих точках, машина в тупику стоїть, доки її видно.
 */
const VISIBLE_ON = 700;
const VISIBLE_MAX = 1100;
/** Далі за R + це модель зникає навіть на виду, м. */
const VISIBLE_DROP = 300;
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
/**
 * Фізичний режим (king.exe 0x4cf620): ближче PHYS_ON до гравця машина фізична (`_Car_V`) зі швидкістю ≤ PHYS_SPEED
 * уздовж курсу; назад — далі PHYS_OFF, або далі PHYS_BACK, якщо вона в межах 0,5 м від центру смуги й не обʼїжджає.
 */
const PHYS_ON = 80;
const PHYS_BACK = 100;
const PHYS_OFF = 300;
const PHYS_SPEED = 18;
/**
 * Кінематична модель — на поверхні дороги, з нахилом за нею (порт: у king.exe — висота лінії WAY, без нахилу; лінії
 * лежать до ±1,3 м від настилу, тож модель «пливла» й підскакувала при переході у фізику). Замір раз на GROUND_EVERY с,
 * висота згладжена з GROUND_LAG с; модель піднята на REST_LIFT — як фізична машина на підвісці в спокої.
 */
/**
 * Покажчики повороту — відступ порту на прохання користувача (у king.exe їх немає): відблиск оригінальної текстури
 * `Ka50_GlowO` (помаранчева мигалка Ка-50, TRUCKS.B3D) біля передніх фар і задніх вогнів (StopFaraKeyL/R) свого
 * боку, 1,5 Гц; коли — driver.turnSignal. Далеким абстрактним машинам — нічого.
 */
const BLINK_HZ = 1.5;
const BLINK_SIZE = 0.55;
const GROUND_EVERY = 0.12;
const GROUND_LAG = 0.12;
const REST_LIFT = 0.1;
/** Промінь до землі: звідки над лінією й як глибоко під нею, м. */
const GROUND_UP = 6;
const GROUND_DOWN = 10;
/** Відкинуло далі за це від лінії — маршрут перебудовується (king.exe: ≥ 50 м; порт — менше, лінії смуг), м. */
const RETRACE = 8;
/** Перекинута (вгору < 0,5) довше за це — прибрати, щойно не видно, с. */
const FLIP_TIME = 3;
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
  /** Фізична машина (ближче PHYS_ON до гравця) і її керування. */
  vehicle: TruckVehicle | null;
  phys: PhysState;
  /** Цільова швидкість водія фізичної машини, м/с. */
  want: number;
  /** Скільки лежить перекинута, с. */
  flipped: number;
  /** Поверхня під кінематичною моделлю (промінь до нерухомих колізій): висота, нормаль, час до наступного заміру. */
  ground: Ground | null;
  /** Покажчики повороту (4 відблиски: перед і зад лівого боку, перед і зад правого) — на моделі. */
  blink: THREE.Group | null;
}

/** Поверхня під кінематичною моделлю: згладжена висота y, заміряна goal, нормаль n, час до заміру t. */
interface Ground {
  y: number;
  goal: number;
  n: THREE.Vector3;
  t: number;
}

/** Фізичні машини трафіку (будує гра: модель, параметри king.exe з vehicle.tech, сцена). */
export interface TrafficPhysics {
  make(kind: TrafficKind, pos: THREE.Vector3, forward: THREE.Vector3, speed: number): TruckVehicle | null;
  remove(v: TruckVehicle): void;
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
  private blinkTime = 0;
  private blinkMat: THREE.SpriteMaterial | null | undefined;
  /** Точки покажчиків моделі (Three.js, від початку координат моделі): перед лів., зад лів., перед прав., зад прав. */
  private readonly blinkPts = new Map<string, THREE.Vector3[] | null>();

  /** Що бачить гравець: дальність (кінець туману, м) і чи видно точку з камери. Без нього — без перевірок. */
  view: { range(): number; sees(p: THREE.Vector3): boolean } | null = null;

  /** Світлофори: відстань до стоп-лінії на червоне (world/trafficLights.ts); без них — не зважати. */
  signals: { stopAhead(p: THREE.Vector3, heading: THREE.Vector3): number } | null = null;

  /** Фізичні машини поруч з гравцем; без цього — усі кінематичні. */
  physics: TrafficPhysics | null = null;

  private sees(p: THREE.Vector3): boolean {
    return this.view?.sees(p) ?? false;
  }

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

    // Абстрактні — уздовж мережі; поблизу в завантаженому регіоні — з моделлю й водієм (вмикається й вимикається
    // невидимою).
    const R = this.view ? THREE.MathUtils.clamp(this.view.range() + 50, VISIBLE_ON, VISIBLE_MAX) : VISIBLE_ON;
    for (const c of this.all) {
      const d = c.pos.distanceTo(player);
      const loaded = this.loaded(c.line.region);
      c.age += dt;
      if (c.vehicle) {
        // Фізична → кінематична (0x4cee70).
        if (!loaded || d > PHYS_OFF || (d > PHYS_BACK && Math.abs(c.lat) <= 0.5 && !c.bypass && c.flipped === 0)) this.unphysical(c);
        continue;
      }
      if (c.root && this.physics && d < PHYS_ON && loaded) {
        this.makePhysical(c);
        if (c.vehicle) continue;
      }
      if (!c.root) {
        if (loaded && (d < R - 100 || (d < R && !this.sees(c.pos)))) this.activate(c);
      } else if (!loaded || d > R + VISIBLE_DROP || (d > R + 50 && !this.sees(c.pos))) this.deactivate(c);
    }
    this.cars = this.all.filter((c) => c.root || c.vehicle);

    const avoid = [player, ...extra];
    const obstacles: Obstacle[] = this.cars.map((c) => ({ pos: c.pos, vel: c.heading.clone().multiplyScalar(c.speed), half: c.halfLen, mover: c }));
    avoid.forEach((p, i) => {
      const prev = this.avoidPrev[i];
      const vel = prev && dt > 0 && this.avoidPrev.length === avoid.length ? p.clone().sub(prev).divideScalar(dt) : new THREE.Vector3();
      obstacles.push({ pos: p, vel: vel.lengthSq() < 900 ? vel : new THREE.Vector3(), half: AVOID_HALF });
    });
    this.avoidPrev = avoid.map((p) => p.clone());
    for (const c of this.all) {
      c.stopAt = c.root || c.vehicle ? (this.signals?.stopAhead(c.pos, c.heading) ?? Infinity) : Infinity;
      if (c.vehicle) this.think(c, dt, obstacles);
      else if (c.root) this.drive(c, dt, avoid, obstacles);
      else coast(c, dt);
    }
    // Тупик: привид зникає, постійна машина — заново далеко від гравця (на виду — стоїть, доки не сховається).
    for (let i = this.all.length - 1; i >= 0; i--) {
      const c = this.all[i];
      const wreck = c.flipped > FLIP_TIME;
      if (!(c.gone || wreck) || ((c.root || c.vehicle) && this.sees(c.pos))) continue;
      this.remove(i);
      if (!c.ghost) this.addDumb(player, R + 50);
    }
    this.cars = this.all.filter((c) => c.root || c.vehicle);
    this.updateSignals(dt);
  }

  /** Покажчики повороту: на моделі (кінематичній чи фізичній) — блимають, коли водій сигналить. */
  private updateSignals(dt: number): void {
    this.blinkTime += dt;
    const on = (this.blinkTime * BLINK_HZ) % 1 < 0.5;
    for (const c of this.cars) {
      const side = turnSignal(c);
      if (!side && !c.blink) continue;
      const host = c.vehicle ? c.vehicle.visual : c.root;
      if (!host) continue;
      if (!c.blink || c.blink.parent !== host) {
        c.blink?.removeFromParent();
        c.blink = this.makeBlink(c, host);
        if (!c.blink) continue;
      }
      c.blink.children.forEach((s, i) => (s.visible = on && side !== 0 && (i < 2 ? side < 0 : side > 0)));
    }
  }

  /** Відблиски покажчиків на моделі машини (кінематична — над обгорткою моделі, фізична — у системі моделі). */
  private makeBlink(c: Car, host: THREE.Object3D): THREE.Group | null {
    const pts = this.signalPoints(c.kind.model);
    if (this.blinkMat === undefined) {
      const mats = this.trucks.asm.b3d.materials.map((m) => m.toLowerCase());
      const i = mats.indexOf('ka50_glowo');
      const map = i >= 0 ? (this.trucks.asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
      this.blinkMat = map ? new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }) : null;
    }
    if (!pts || !this.blinkMat) return null;
    const g = new THREE.Group();
    g.name = 'TurnSignals';
    // Кінематична модель піднята обгорткою (frame) над початком координат root.
    if (!c.vehicle && c.root) g.position.copy(c.root.children[0]?.position ?? new THREE.Vector3());
    for (const p of pts) {
      const s = new THREE.Sprite(this.blinkMat);
      s.position.copy(p);
      s.scale.setScalar(BLINK_SIZE);
      s.visible = false;
      g.add(s);
    }
    host.add(g);
    return g;
  }

  /**
   * Точки покажчиків моделі: перед — краї фар (refer_HeadLightKey, стан 1), зад — задні вогні (StopFaraKeyL/R, стан 1);
   * без них — кути габаритів моделі. Ліво — −x (уперед — −Z).
   */
  private signalPoints(model: string): THREE.Vector3[] | null {
    if (this.blinkPts.has(model)) return this.blinkPts.get(model)!;
    let out: THREE.Vector3[] | null = null;
    const dyn = this.trucks.asm.dynamicObject(model);
    if (dyn) {
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      frame.add(dyn.root);
      frame.updateMatrixWorld(true);
      const body = visibleBox(dyn.root);
      const part = (name: string): THREE.Box3 | null => {
        let o: THREE.Object3D | null = null;
        dyn.root.traverse((x) => {
          if (!o && x.name === name) o = x;
        });
        if (!o) return null;
        const b = new THREE.Box3().setFromObject(o);
        return b.isEmpty() ? null : b;
      };
      const head = part('refer_HeadLightKey#1');
      const rl = part('StopFaraKeyL#1');
      const rr = part('StopFaraKeyR#1');
      const y = head ? head.getCenter(new THREE.Vector3()).y : body.min.y + 0.4 * (body.max.y - body.min.y);
      const fz = (head ? head.min.z : body.min.z) - 0.05;
      const rear = (b: THREE.Box3 | null, x: number) => (b ? b.getCenter(new THREE.Vector3()).setZ(b.max.z + 0.05) : new THREE.Vector3(x, y, body.max.z + 0.05));
      out = [
        new THREE.Vector3((head ? head.min.x : body.min.x) + 0.15, y, fz),
        rear(rl, body.min.x + 0.2),
        new THREE.Vector3((head ? head.max.x : body.max.x) - 0.15, y, fz),
        rear(rr, body.max.x - 0.2),
      ];
    }
    this.blinkPts.set(model, out);
    return out;
  }

  /** Перед кожним кроком фізики: педалі й кермо фізичних машин. */
  control(dt: number): void {
    for (const c of this.all) if (c.vehicle) c.vehicle.update(dt, control(c, c.vehicle, c.phys, c.want, false, dt));
  }

  /** Після кроків фізики: модель фізичних машин між станами кроків. */
  after(alpha: number): void {
    for (const c of this.all) c.vehicle?.syncVisual(alpha);
  }

  /** Фізична машина: логічна позиція з тіла, перебудова маршруту, рішення водія. */
  private think(c: Car, dt: number, obstacles: readonly Obstacle[]): void {
    const v = c.vehicle!;
    // Позиція — з тіла (модель оновлюється лише після кроку фізики).
    const t = v.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    const fwd = v.forward();
    const off = sync(c, p, fwd, v.speedKmh / 3.6);
    if (off > RETRACE) {
      const n = this.roads.nearest(p, fwd);
      if (n) retrace(c, n.line, n.seg, n.t);
    }
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(v.visual.quaternion).y;
    c.flipped = up < 0.5 ? c.flipped + dt : 0;
    c.want = c.gone ? 0 : decide(c, dt, obstacles, this.roads);
  }

  /** Кінематична → фізична (0x4cf080): та сама модель на колесах з параметрами vehicle.tech, швидкість ≤ 18 м/с. */
  private makePhysical(c: Car): void {
    if (!this.physics) return;
    // Порт: не на в'їзді в поворот — машина, швидша за дозволене дорогою попереду, у фізиці не встигає загальмувати.
    if (c.speed > roadLimit(c, pathAhead(c, 150)) + 1) return;
    // Спершу прибрати кінематичне тіло: інакше промінь до землі при створенні влучає в дах самої машини.
    this.deactivate(c);
    const v = this.physics.make(c.kind, c.pos, c.heading, Math.min(PHYS_SPEED, c.speed));
    if (!v) {
      this.activate(c);
      return;
    }
    v.syncVisual(1);
    c.vehicle = v;
    c.phys = newPhysState();
    c.want = c.speed;
    c.flipped = 0;
  }

  /** Фізична → кінематична: модель знову котиться лінією (зсув від лінії згасає). */
  private unphysical(c: Car): void {
    if (!c.vehicle) return;
    c.blink?.removeFromParent();
    c.blink = null;
    c.heading.copy(c.vehicle.forward()).setY(0).normalize();
    this.physics?.remove(c.vehicle);
    c.vehicle = null;
    c.latGoal = 0;
    this.activate(c);
  }

  /** Цілі маршрутів (вузли WAY з FLAG & 2, Three.js): найкоротші шляхи мережею до кожної — driver.setGoals. */
  setGoals(points: readonly THREE.Vector3[]): void {
    const nav = new Navigator(this.roads);
    setGoals(points.map((p) => nav.distances(p)));
    for (const c of this.all) c.goal = Math.floor(Math.random() * points.length);
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
    return Object.assign(newMover(line, seg, Math.random(), cruise, 2.2), { kind, ghost, age: 0, root: null, body: null, vehicle: null, phys: newPhysState(), want: 0, flipped: 0, ground: null, blink: null });
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
      const old = d > GHOST_KEEP && (c.age > GHOST_AGE || d > GHOST_FAR);
      if (!this.loaded(c.line.region) || d > VISIBLE_MAX + VISIBLE_DROP || (old && !this.sees(c.pos))) this.remove(i);
    }
    if (this.jam || this.ghosts >= this.config.ghost || !this.kinds.length || Math.random() < 0.5) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = Math.random() * Math.PI * 2;
      const at = player.clone().add(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)).multiplyScalar(2 * GHOST_NEAR));
      const n = this.roads.nearestAxis(at);
      if (!n || n.axis.flags & 0x50 || n.point.distanceTo(player) < GHOST_NEAR || !this.loaded(n.axis.region)) continue;
      // Порт: не на очах гравця — інша спроба.
      if (this.sees(n.point)) continue;
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
    // Модель стоїть на колесах: низ коробки — дорога (плюс хід підвіски в спокої).
    frame.position.y = -box.min.y + REST_LIFT;
    c.ground = this.groundUnder(c.pos);
    root.position.set(c.pos.x, c.ground?.y ?? c.pos.y, c.pos.z);
    orient(root.quaternion, c.heading, c.ground?.n);
    const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(root.position.x, root.position.y, root.position.z));
    this.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y - box.min.y + REST_LIFT, center.z)
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
    c.blink?.removeFromParent();
    c.blink = null;
    if (c.vehicle) {
      this.physics?.remove(c.vehicle);
      c.vehicle = null;
    }
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
    step(c, dt, obstacles, this.roads);
    // Кінематична машина інакше штовхає гравця з «нескінченною» масою (на перехресті вантажівка з причепом
    // виїжджає збоку, гальмувати пізно).
    for (const o of avoid) {
      const rel = o.clone().sub(c.pos);
      const along = rel.x * c.heading.x + rel.z * c.heading.z;
      const side = Math.abs(rel.x * c.heading.z - rel.z * c.heading.x);
      if (along > 0 && along < c.halfLen + 5 && side < 2.5) c.speed = 0;
    }
    if (!c.root || !c.body) return;
    // Поверхня під машиною — раз на GROUND_EVERY с; між замірами — висота й нахил з попереднього.
    if (!c.ground || (c.ground.t -= dt) <= 0) {
      const g = this.groundUnder(c.pos);
      if (g) c.ground = c.ground ? { ...c.ground, n: g.n, goal: g.y, t: GROUND_EVERY } : g;
      else if (c.ground) c.ground.t = GROUND_EVERY;
    }
    if (c.ground) c.ground.y += (c.ground.goal - c.ground.y) * (1 - Math.exp(-dt / GROUND_LAG));
    const q = orient(new THREE.Quaternion(), c.heading, c.ground?.n);
    // Плавний поворот на зламах ламаної.
    c.root.quaternion.slerp(q, Math.min(1, dt * 6));
    c.root.position.set(c.pos.x, c.ground?.y ?? c.pos.y, c.pos.z);
    c.body.setNextKinematicTranslation(c.root.position);
    c.body.setNextKinematicRotation(c.root.quaternion);
  }

  /** Поверхня під точкою: промінь униз до нерухомих колізій (дорога, рельєф); null — колізій там немає. */
  private groundUnder(p: THREE.Vector3): Ground | null {
    const from = { x: p.x, y: p.y + GROUND_UP, z: p.z };
    const hit = this.rapier.castRayAndGetNormal(new RAPIER.Ray(from, { x: 0, y: -1, z: 0 }), GROUND_UP + GROUND_DOWN, true, undefined, undefined, undefined, undefined, (col) => col.parent()?.isFixed() ?? true);
    if (!hit) return null;
    const n = new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z);
    if (n.y < 0.7) return null;
    const y = from.y - hit.timeOfImpact;
    return { y, goal: y, n, t: GROUND_EVERY };
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

/** Орієнтація моделі: перед — курс, спроєктований на площину ґрунту з нормаллю n (без n — горизонтально). */
function orient(q: THREE.Quaternion, heading: THREE.Vector3, n?: THREE.Vector3): THREE.Quaternion {
  const up = n ?? new THREE.Vector3(0, 1, 0);
  const f = heading.clone().addScaledVector(up, -heading.dot(up));
  if (f.lengthSq() < 1e-6) f.copy(heading);
  // lookAt ставить +Z від цілі до ока: ціль — уперед, тож −Z (перед моделі) дивиться за рухом.
  return q.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), f.normalize(), up));
}
