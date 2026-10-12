import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { LightGeometry } from '../render/truckLights';
import { GROUP_BUMPER, GROUP_MOVABLE, g2t, groups } from '../physics/world';
import type { ControlState } from '../input/input';
import { visibleBox, type TruckDef, type TruckModel } from './trucks';
import { Engine, GEAR_R } from './engine';

/**
 * Вантажівка на DynamicRayCastVehicleController (Rapier).
 * Параметри — з [TECHn] у TRUCK.TCH. Двигун і коробка — відтворені з HTruck.exe (engine.ts);
 * шини, підвіска й інтегрування кузова — поки Rapier (доріжка R4 продовжується).
 */
/** Кермо (телеметрія s6): межа 1,04/(1 + 0,056·v), не більше 0,913; кут колеса = 0,684 × кермо. */
const STEER_A = 1.041;
const STEER_B = 0.056;
const STEER_MAX = 0.913;
const STEER_TO_WHEEL = 0.684;
/** cot(зовнішнього) − cot(внутрішнього) кута коліс (ЗіЛ, s6: 0,624 / 0,558 рад). */
const ACKERMANN = 0.208;

/**
 * Межа зчеплення шин (Rapier frictionSlip) — тертя колеса оригіналу [0x30b] = 0,84 на всіх колесах.
 * Відгук користувача: в оригіналі різкий поворот до упору — або крутий поворот із креном, або (на швидкості)
 * занос із втратою швидкості, після чого вантажівка різко доповорочує. (Запис s6 із ≈ 5 к/с фізики
 * показував ширше коло — великий крок часу спотворював, тож на нього не орієнтуємось.)
 */
const TIRE_GRIP = 0.84;
const TIRE_GRIP_BRAKING = 1.0;
/**
 * Параметри бічних сил шин (підібрані під телеметрію s9: кермо до упору на 8,5 м/с — ≈ 51°/с;
 * на 11,5 м/с — занос із втратою швидкості). Обʼєкт змінний — для підбору в консолі (dev).
 */
export const TIRE = {
  /**
   * Бічне тертя шини (межа = mu × навантаження). Вище за поздовжнє 0,84: в оригіналі з кермом до упору на
   * 8,5 м/с — ≈ 51°/с (бічне ≈ 0,79 g), чого з 0,84 не досягти через перевантажену передню вісь.
   */
  mu: 1.15,
  /** Кут проковзування, на якому бічна сила досягає межі, рад. */
  slip_peak: 0.2,
  /** Частка межі в повному заносі. */
  slide: 0.95,
  /** Поздовжнє гальмування в заносі: частка межі на одиницю «глибини» заносу і максимум. */
  slide_drag: 0.25,
  slide_drag_max: 0.45,
  /** Нижня межа поздовжньої швидкості для кута проковзування, м/с (стійкість на місці). */
  low_speed: 2,
  /**
   * Наскільки піднімати точку прикладання бічної сили до центру мас (0 — земля, 1 — центр мас). Відгук
   * користувача: в оригіналі кузов помітно кренить у поворотах, а іноді вантажівка перекидається на бік.
   * 0,1 разом із відбійником підвіски (SUSPENSION.bump_*) — крен див. там; різке кермо на швидкості чи нахилений
   * гребінь — перекидання; з вантажем центр мас вищий — перекидається раніше. Підбір, не формула оригіналу.
   */
  roll_lift: 0.1,
};

/**
 * Підвіска (Rapier: жорсткість і демпфування на одиницю маси кузова). М'яка, щоб кузов кренився й погойдувався,
 * як в оригіналі. Демпфування — та сама частка критичного
 * (≈ 0,4 стиснення, ≈ 0,2 відбій), що й до пом'якшення. ks/cs з TCH (у файлі закоментовані — діють типові 12500 / 1)
 * в одиницях оригіналу не розібрані — гіпотеза.
 */
export const SUSPENSION = {
  stiffness: 15,
  compression: 3.2,
  relaxation: 1.7,
  /**
   * Довжина пружини у спокої й хід, м: м'яка пружина просідає під вагою на ≈ 0,17 м (жорсткість 28 — на 0,09), тож
   * довжину й хід збільшено на різницю — машина стоїть на тій самій висоті й має той самий запас до упору (≈ 0,21 м),
   * що й до пом'якшення. З ходом 0,3 при довжині 0,35 підвіска «пробивалась» на крутих перепадах COUNT (187 разів за
   * 2 хв автопроходу проти 4) — колеса й низ машини провалювались в асфальт.
   */
  rest: 0.43,
  travel: 0.38,
  /**
   * Відбійник: після bump_from м стиснення (≈ 14 см понад просідання в спокої) — жорстка додаткова пружина (на
   * одиницю маси, як stiffness) і демпфер: гасить «пробої» на перепадах (COUNT, 2 хв автопроходу: 6 замість 187),
   * а крен лишає (кермо до упору, ЗіЛ: 25 км/год — 6°, 35 — 9°, 40 — 21°). Нижчий поріг (0,25) з'їдав крен до 6°.
   */
  bump_from: 0.31,
  bump_stiffness: 500,
  bump_damping: 12,
};

/**
 * Поправка roll_lift для окремих вантажівок (за prefix з TRUCK.TCH): у ЗіЛа центр мас (CenterMassInB3D) майже на
 * метр вищий, ніж у Volvo, і він перекидався помітно частіше — на прохання користувача крен трохи менший
 * (кермо до упору: 40 км/год — 10° замість 17°, 45 — 28° замість 54°).
 * Налаштування, не дані оригіналу.
 */
const ROLL_LIFT_BY_TRUCK: Record<string, number> = { zil: 0.12 };

/** Частки breakpower на колесо: передні / задні (телеметрія ЗіЛ, s6) — гіпотеза для інших вантажівок. */
const BRAKE_FRONT = 0.49;
const BRAKE_REAR = 0.35;
/** Коефіцієнт опору кочення (накат на 4-й передачі без газу, s7). */
const ROLLING_RESISTANCE = 0.015;
/** Бампери: висота низу над дорогою й товщина, м (гіпотеза). */
const BUMPER_CLEARANCE = 0.35;
const BUMPER_DEPTH = 0.5;
/** Утримання гальма на місці до вмикання задньої передачі, с. */
const REVERSE_HOLD = 0.3;

/** Стан машини з кар'єри, що впливає на фізику (режим «симулятор»). */
export interface TruckSetup {
  /** Маса вантажу, кг, і висота його шару в кузові, м (центр ваги піднімається з обʼємом вантажу). */
  cargoMass?: number;
  cargoHeight?: number;
  /** Множник зчеплення шин (знос, дощ). */
  grip?: number;
  /** Множник моменту двигуна (форсований двигун). */
  torque?: number;
  /** Антипробуксовочна система (АПС): тяга ведучого колеса не перевищує межу зчеплення. */
  tractionControl?: boolean;
  /** Регульоване сидіння (РС): очі водія вище на стільки метрів. */
  seatRaise?: number;
  /** Покриття дороги впливає на зчеплення й опір (симулятор; в аркаді — ні). */
  surfaceEffects?: boolean;
}

/** Тінь над дорогою, м — щоб не мерехтіла з дорогою (гіпотеза порту). */
const SHADOW_LIFT = 0.04;
/** Як далеко вниз шукати землю для тіні, коли колеса не торкаються дороги, м. */
const SHADOW_RAY = 30;

export class TruckVehicle {
  readonly body: RAPIER.RigidBody;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  /** Візуальна модель у світі Three.js. */
  readonly visual = new THREE.Group();
  /** Передача для інтерфейсу: −1 — R, 0 — N, 1 — перша… */
  gear = 0;
  rpm = 300;
  speedKmh = 0;
  readonly engine: Engine;
  /** Двигун працює (пробіл глушить і заводить). */
  engineOn = true;
  /** Параметри шин (спільні для всіх вантажівок) — для підбору в консолі. */
  readonly tire = TIRE;
  /** Параметри підвіски (спільні) — для підбору в консолі. */
  readonly suspension = SUSPENSION;
  /** Поправки roll_lift за вантажівкою — для підбору в консолі. */
  readonly rollLiftByTruck = ROLL_LIFT_BY_TRUCK;

  private readonly wheelRadius: number;
  /** Кількість коліс (HT1 — 4, HT2 — 4 або 6); керовані — перші два, «передні» гальма — теж. */
  private readonly wheels: number;
  private readonly driven: boolean[];
  private readonly wheelVisual: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly suspRest = SUSPENSION.rest;
  /** Висота кріплення підвіски над центром колеса моделі, м (незмінна: від неї — посадка кузова й колеса). */
  private readonly suspAnchor = 0.175;
  private steerAngle = 0;
  /** Задній хід: гравець утримує гальмо на місці (тоді «гальмо» — це газ назад). */
  private reverseMode = false;
  /** Скільки утримується гальмо на місці (для вмикання задньої). */
  private reverseHold = 0;
  private brakeTime = 0;
  private readonly mass: number;
  private readonly grip: number;
  /** Пошкодження гальм: множник сили (1 — справні). */
  private brakeFactor = 1;
  private readonly tractionControl: boolean;
  /** Для світлових плям фар і габаритів (локальна система машини). */
  lightGeometry: LightGeometry = { groundY: -1, frontZ: -4, backZ: 4, width: 2.5 };
  /** Покриття під колесами: множники зчеплення й опору кочення (1 — асфальт). Аркада — без впливу. */
  private surfaceGrip = 1;
  private surfaceRoll = 1;
  private readonly surfaceEffects: boolean;
  /** Тестовий режим: дощ (у кар'єрі він уже в setup.grip). */
  weatherGrip = 1;
  setSurface(grip: number, roll: number): void {
    if (!this.surfaceEffects) return;
    this.surfaceGrip = grip;
    this.surfaceRoll = roll;
  }

  /** Вплив пошкоджень (режим «симулятор»): момент, недоступні верхні передачі, сила гальм. */
  setDamage(d: { power: number; lostGears: number; brakes: number }): void {
    this.engine.powerFactor = d.power;
    this.engine.gearLimit = d.lostGears > 0 ? this.engine.topGear - d.lostGears : Infinity;
    this.brakeFactor = d.brakes;
  }

  constructor(
    private readonly world: RAPIER.World,
    readonly def: TruckDef,
    model: TruckModel,
    spawn: { position: THREE.Vector3; forward: THREE.Vector3 },
    setup: TruckSetup = {},
  ) {
    const tech = def.tech;
    this.grip = setup.grip ?? 1;
    this.tractionControl = setup.tractionControl ?? false;
    this.surfaceEffects = setup.surfaceEffects ?? true;
    this.wheelRadius = tech.wheelRadius;
    this.wheels = model.wheels.length;
    this.driven = Array.from({ length: this.wheels }, (_, i) => (tech.drivingWheels[i] ?? 1) !== 0);
    this.engine = new Engine({
      maxTorque: tech.maxRotMomentum * (setup.torque ?? 1),
      tachMaxPower: tech.tachMaxPower,
      rearAxle: tech.rearAxleCoeff,
      reverse: tech.reverseCoeff,
      gears: tech.gears,
      wheelRadius: tech.wheelRadius,
    });

    // Модель у системі гри → обгортка, що повертає її у систему Three.js.
    const gameFrame = new THREE.Group();
    gameFrame.rotation.x = -Math.PI / 2;
    gameFrame.add(model.root);
    this.visual.add(gameFrame);
    this.wheelVisual = model.wheels.map((obj, i) => ({ obj, base: model.wheelBase[i] }));

    // Габарити кузова в локальних координатах Three.js.
    gameFrame.updateMatrixWorld(true);
    // Тінь (*Shadow, матеріал s_shadow) у моделі — на рівні коліс у верхньому положенні підвіски, ≈ 1 м над дорогою:
    // більша за кузов, вона виглядала сірою «спідницею» навколо нього. Кладемо її на дорогу (syncVisual). Тут visual
    // ще в нулі — світові матриці збігаються з локальними для visual.
    model.root.traverse((o) => {
      if (this.shadow || !/shadow$/i.test(o.name) || !o.parent) return;
      const box = new THREE.Box3().setFromObject(o);
      if (box.isEmpty()) return;
      const center = box.getCenter(new THREE.Vector3());
      o.matrixAutoUpdate = false;
      this.shadow = {
        obj: o,
        // Площина тіні з центром у нулі (орієнтація — як у кузова).
        local: new THREE.Matrix4().makeTranslation(-center.x, -center.y, -center.z).multiply(o.matrixWorld),
        center,
        mid: center.clone(),
        parentInv: o.parent.matrixWorld.clone().invert(),
      };
    });
    const box = visibleBox(model.body);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // Точка, під якою лежить тінь: центр тіні на середній висоті кузова — і на боці, і догори колесами тінь під машиною.
    if (this.shadow) this.shadow.mid.y = center.y;

    const forward = spawn.forward.clone().setY(0).normalize();
    const rot = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)),
        new THREE.Vector3(0, 1, 0),
        forward.clone().negate(),
      ),
    );
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
        .setRotation(rot)
        .setLinearDamping(0) // опір руху — кочення й двигун (як в оригіналі), без штучного демпфування
        .setAngularDamping(0.5)
        .setCanSleep(false), // контролер транспорту не будить тіло — сон «заморожує» вантажівку
    );
    const cargo = Math.max(0, setup.cargoMass ?? 0);
    const mass = tech.mass + tech.bodyMass + cargo;
    this.mass = mass;
    // Центр мас — CenterMassInB3D з TCH у системі моделі (x, висота, вперед): для ЗіЛа (0; 0,524; −0,3) —
    // 0,3 м позаду початку моделі, ≈ 1,5 м над дорогою; так передня вісь несе ≈ 56 % ваги, як в оригіналі
    // (навантаження коліс у s6: 12 452 / 9 662 Н). Rapier задає центр мас відносно колайдера.
    const [cx, cy, cz] = tech.centerMass;
    const colliderAt = new THREE.Vector3(center.x, center.y + size.y * 0.05, center.z);
    // Вантаж: центр — над дном вантажу (center_of_cargo_bottom) на половині висоти шару.
    const [bx, by, bz] = tech.cargoBottom;
    const cargoAt = new THREE.Vector3(bx, bz + (setup.cargoHeight ?? 0) / 2, -by);
    const com = new THREE.Vector3(cx, cy, -cz)
      .multiplyScalar(mass - cargo)
      .addScaledVector(cargoAt, cargo)
      .divideScalar(mass)
      .sub(colliderAt);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2 * 0.8, size.z / 2)
        .setTranslation(colliderAt.x, colliderAt.y, colliderAt.z)
        .setMassProperties(mass, { x: com.x, y: com.y, z: com.z }, {
          x: mass * (size.y ** 2 + size.z ** 2) / 12,
          y: mass * (size.x ** 2 + size.z ** 2) / 12,
          z: mass * (size.x ** 2 + size.y ** 2) / 12,
        }, { w: 1, x: 0, y: 0, z: 0 })
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );

    this.ctrl = world.createVehicleController(this.body);
    for (let i = 0; i < this.wheels; i++) {
      const p = new THREE.Vector3().setFromMatrixPosition(model.wheelBase[i]);
      const c = g2t(p);
      this.ctrl.addWheel({ x: c.x, y: c.y + this.suspAnchor, z: c.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.suspRest, this.wheelRadius);
      this.ctrl.setWheelSuspensionStiffness(i, SUSPENSION.stiffness);
      this.ctrl.setWheelSuspensionCompression(i, SUSPENSION.compression);
      this.ctrl.setWheelSuspensionRelaxation(i, SUSPENSION.relaxation);
      this.ctrl.setWheelMaxSuspensionTravel(i, SUSPENSION.travel);
      this.ctrl.setWheelMaxSuspensionForce(i, mass * 40);
      this.ctrl.setWheelFrictionSlip(i, TIRE_GRIP * this.grip);
      // Бічні сили шин рахуємо самі (applyTireLateral) — у Rapier вимикаємо.
      this.ctrl.setWheelSideFrictionStiffness(i, 0);
    }

    // Бампери: корпус-колайдер високо (низ ≈ 1 м над дорогою), а колеса — промені, тож низькі предмети (ящики,
    // блоки) проходили під кузовом і колеса на них заїжджали. Низькі коробки спереду й ззаду без маси —
    // до BUMPER_CLEARANCE над дорогою (дорога — низ коліс у спокої).
    const wy = g2t(new THREE.Vector3().setFromMatrixPosition(model.wheelBase[0])).y;
    const ground = wy - this.suspAnchor - this.wheelRadius;
    this.lightGeometry = { groundY: ground, frontZ: box.min.z, backZ: box.max.z, width: size.x };
    const bottom = ground + BUMPER_CLEARANCE;
    const top = colliderAt.y - size.y * 0.4 + 0.2;
    if (top > bottom + 0.1)
      for (const z of [box.min.z + BUMPER_DEPTH / 2, box.max.z - BUMPER_DEPTH / 2])
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(size.x / 2 - 0.05, (top - bottom) / 2, BUMPER_DEPTH / 2)
            .setTranslation(center.x, (top + bottom) / 2, z)
            .setDensity(0)
            .setFriction(0.3)
            .setRestitution(0.1)
            // Лише проти рухомих предметів: з дорогою бампер на крутому трампліні впирався в асфальт.
            .setCollisionGroups(groups(GROUP_BUMPER, GROUP_MOVABLE)),
          this.body,
        );
  }

  /** Крок фізики керування (до world.step). */
  update(dt: number, input: ControlState): void {
    const tech = this.def.tech;
    // Швидкість уздовж напрямку «уперед» (−Z локально), м/с; + уперед.
    const lv = this.body.linvel();
    const q = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speedKmh = Math.abs(v) * 3.6;

    // Кермо як в оригіналі (s6): межа залежить від швидкості 1,04/(1 + 0,056·v) ≤ 0,913,
    // кут колеса = 0,684 × кермо; внутрішнє колесо повертається більше (Аккерман, cot o − cot i = 0,208).
    const limit = Math.min(STEER_MAX, STEER_A / (1 + STEER_B * Math.abs(v)));
    this.steerAngle = -input.steer * limit * STEER_TO_WHEEL;
    const inner = Math.abs(this.steerAngle);
    const outer = inner > 1e-4 ? Math.atan(1 / (1 / Math.tan(inner) + ACKERMANN)) : 0;
    const left = this.steerAngle > 0; // + — вліво
    this.ctrl.setWheelSteering(0, Math.sign(this.steerAngle) * (left ? inner : outer));
    this.ctrl.setWheelSteering(1, Math.sign(this.steerAngle) * (left ? outer : inner));

    // Задній хід — автоматично: на місці утримуємо гальмо ≈ 0,3 с → R, тоді «гальмо» везе назад, а «газ»
    // гальмує; зупинилися й тиснемо газ — знову вперед.
    const stopped = Math.abs(v) < 0.5;
    if (!this.reverseMode && input.brake > 0 && input.throttle === 0 && stopped) {
      this.reverseHold += dt;
      if (this.reverseHold >= REVERSE_HOLD) this.reverseMode = true;
    } else this.reverseHold = 0;
    if (this.reverseMode && input.throttle > 0 && input.brake === 0 && stopped) this.reverseMode = false;
    // Заглушений двигун не тягне (оберти — до нуля, гальмування двигуном лишається).
    const gas = !this.engineOn ? 0 : this.reverseMode ? input.brake : input.throttle;
    const brake = this.reverseMode ? input.throttle : input.brake;

    const eng = this.engine;
    eng.update(dt, gas, brake, v, this.reverseMode);
    this.rpm = this.engineOn ? eng.rpm : Math.max(0, this.rpm - 3000 * dt);
    this.gear = eng.displayGear === GEAR_R ? -1 : eng.displayGear - 1;

    // Гальмо з клавіатури наростає як t/(t + 1) (поле [0x33a] оригіналу; телеметрія s6).
    this.brakeTime = brake > 0 ? this.brakeTime + dt : 0;
    const brakePedal = brake > 0 ? brake * (this.brakeTime / (this.brakeTime + 1)) : 0;

    // Сила двигуна — порівну на ведучі колеса (у Rapier відʼємна сила — уперед).
    // Гальма: сила колеса = педаль × B (передні 0,49·breakpower, задні 0,35·breakpower — ЗіЛ, s6);
    // опір кочення ≈ 0,015·N (накат s7). Rapier бере гальмо як імпульс за крок — множимо на dt.
    const nDriven = this.driven.filter(Boolean).length || 2;
    const wheelLoad = (this.mass * 9.81) / this.wheels;
    // Rapier ігнорує гальмо колеса, на яке діє сила двигуна, тож гальмування двигуном (сила проти руху)
    // переносимо в гальмо того ж колеса.
    // Двигун гальмує лише з відпущеним газом (сила проти руху); з газом — завжди тягне, зокрема з місця й назад.
    // Без газу двигун лише гальмує (як гальмо, що не штовхає): інакше на місці гальмування обертами діяло як
    // тяга — вантажівка сама котилася назад (а на задній — уперед).
    const engineBrakes = gas === 0;
    // Межа зчеплення Rapier спільна для повороту, тяги й гальмування; під час гальмування — вища
    // (оригінал гальмує до ≈ 0,55 g незалежно від бічного зчеплення).
    const grip = (TIRE_GRIP + (TIRE_GRIP_BRAKING - TIRE_GRIP) * brakePedal) * this.grip * this.surfaceGrip * this.weatherGrip;
    for (let i = 0; i < this.wheels; i++) {
      this.ctrl.setWheelFrictionSlip(i, grip);
      let engine = this.driven[i] ? eng.force / nDriven : 0;
      // АПС: не більше 90 % межі зчеплення колеса (гіпотеза) — колесо не зривається в буксування.
      if (this.tractionControl && engine > 0) engine = Math.min(engine, 0.9 * grip * wheelLoad);
      const share = i < 2 ? BRAKE_FRONT : BRAKE_REAR;
      const rolling = ROLLING_RESISTANCE * this.surfaceRoll * wheelLoad;
      let force = brakePedal * share * tech.brakePower * this.brakeFactor + rolling;
      if (input.handbrake && i >= 2) force += tech.brakePower;
      if (engineBrakes) {
        this.ctrl.setWheelEngineForce(i, 0);
        force += Math.abs(engine);
      } else if (engine !== 0 && Math.abs(v) > 0.1) {
        // З тягою Rapier ігнорує й опір кочення — віднімаємо його від сили двигуна.
        this.ctrl.setWheelEngineForce(i, -(engine - Math.sign(v) * rolling));
      } else this.ctrl.setWheelEngineForce(i, -engine);
      this.ctrl.setWheelBrake(i, force * dt);
    }
    this.ctrl.updateVehicle(dt);
    this.applyBumpStops(dt);
    this.applyTireLateral(dt);
  }

  /** Відбійники підвіски (див. SUSPENSION.bump_*): сила вгору в точці кріплення колеса, коли стиснення велике. */
  private applyBumpStops(dt: number): void {
    const S = SUSPENSION;
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const t = this.body.translation();
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const excess = this.suspRest - (this.ctrl.wheelSuspensionLength(i) ?? this.suspRest) - S.bump_from;
      if (excess <= 0) continue;
      const c = this.ctrl.wheelChassisConnectionPointCs(i);
      if (!c) continue;
      const at = new THREE.Vector3(c.x, c.y, c.z).applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
      const v = this.body.velocityAtPoint(at);
      const closing = -(v.x * up.x + v.y * up.y + v.z * up.z); // > 0 — кузов іде вниз, підвіска стискається
      const force = (this.mass / this.wheels) * (S.bump_stiffness * excess + S.bump_damping * Math.max(0, closing));
      this.body.applyImpulseAtPoint({ x: up.x * force * dt, y: up.y * force * dt, z: up.z * force * dt }, at, true);
    }
  }



  /**
   * Бічні сили шин: кут проковзування α кожного колеса → сила до межі «тертя × навантаження» на α ≈ 7°,
   * далі занос (сила слабшає до 80 % і гальмує рух боком — вантажівка втрачає швидкість, а потім
   * знову зачіпається й різко доповорочує). Сила прикладена нижче центру мас — крен кузова, а в різкому
   * повороті на швидкості — перекидання.
   * Форма кривої — гіпотеза під опис поведінки оригіналу (відгук користувача), межа тертя — 0,84 з оригіналу.
   */
  private applyTireLateral(dt: number): void {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const chassisFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const wheelMass = this.mass / this.wheels;
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const load = this.ctrl.wheelSuspensionForce(i) ?? 0;
      const p = this.ctrl.wheelContactPoint(i);
      if (load <= 0 || !p) continue;
      const fwd = chassisFwd.clone().applyAxisAngle(up, this.ctrl.wheelSteering(i) ?? 0);
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      const vp = this.body.velocityAtPoint(p);
      const vLong = vp.x * fwd.x + vp.y * fwd.y + vp.z * fwd.z;
      const vLat = vp.x * right.x + vp.y * right.y + vp.z * right.z;
      const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), TIRE.low_speed));
      const x = alpha / TIRE.slip_peak;
      const mu = x <= 1 ? x : Math.max(TIRE.slide, 1 - (1 - TIRE.slide) * (x - 1) * 0.5);
      // Бічна сила (перпендикулярно колесу): росте з кутом проковзування до межі, у заносі — TIRE.slide.
      let force = mu * TIRE.mu * this.grip * this.surfaceGrip * this.weatherGrip * load;
      // Не «перестрибувати» нуль бокової швидкості за один крок (стійкість на малій швидкості).
      force = Math.min(force, (wheelMass * Math.abs(vLat)) / dt);
      const impulse = right.multiplyScalar(-Math.sign(vLat) * force * dt);
      if (x > 1) {
        // Занос: колесо ще й гальмує вздовж руху — тим сильніше, чим глибший занос; вантажівка
        // втрачає швидкість, доки шина знову не зачепиться (тоді — різкий доворот).
        const drag = Math.min(TIRE.slide_drag_max, TIRE.slide_drag * (x - 1)) * TIRE.mu * this.grip * this.surfaceGrip * this.weatherGrip * load;
        const limited = Math.min(drag, (wheelMass * Math.abs(vLong)) / dt);
        impulse.addScaledVector(fwd, -Math.sign(vLong) * limited * dt);
      }
      // Точку прикладання піднімаємо до висоти центру мас на частку TIRE.roll_lift: перекидальний момент трохи
      // менший за фізичний (як rollInfluence у Bullet) — бічне тертя 1,15 інакше перекидало б у кожному повороті.
      const com = this.body.worldCom();
      const h = (com.x - p.x) * up.x + (com.y - p.y) * up.y + (com.z - p.z) * up.z;
      const lift = ROLL_LIFT_BY_TRUCK[this.def.prefix.toLowerCase()] ?? TIRE.roll_lift;
      const at = { x: p.x + up.x * h * lift, y: p.y + up.y * h * lift, z: p.z + up.z * h * lift };
      this.body.applyImpulseAtPoint(impulse, at, true);
    }
  }

  /** Синхронізує візуальну модель з фізикою (після world.step). */
  /**
   * Висота дороги під машиною в системі моделі (z гри = y кузова): середнє за колесами з фактичним ходом
   * підвіски (під вагою вона стиснута, і в кожної машини по-різному).
   */
  groundHeight(): number {
    let sum = 0;
    for (let i = 0; i < this.wheels; i++) {
      const anchor = g2t(new THREE.Vector3().setFromMatrixPosition(this.wheelVisual[i].base)).y + this.suspAnchor;
      sum += anchor - (this.ctrl.wheelSuspensionLength(i) ?? this.suspRest) - this.wheelRadius;
    }
    return sum / this.wheels;
  }

  /**
   * Тінь моделі: вузол; площина тіні з центром у нулі в системі visual; її центр; обернена матриця батька вузла
   * в системі visual (сталa — вище тіні в моделі нічого не рухається); mid — точка в кузові, під якою тінь лягає.
   */
  private shadow: { obj: THREE.Object3D; local: THREE.Matrix4; center: THREE.Vector3; mid: THREE.Vector3; parentInv: THREE.Matrix4 } | null = null;

  /**
   * Тінь лягає на площину дороги під колесами (точки й нормалі контакту — досить одного колеса: на сильному крені
   * колеса одного боку відриваються): при крені й тангажі кузова вона не провалюється під дорогу одним боком. Від
   * кузова — лише напрям і точка під центром. Без жодного контакту коліс (машина на боці, догори колесами, у
   * стрибку) — на землю під центром кузова за променем униз; землі під ним немає — тінь не показуємо.
   */
  private placeShadow(): void {
    const s = this.shadow!;
    const v = this.visual;
    v.updateMatrix();
    const centerW = s.mid.clone().applyMatrix4(v.matrix);
    const up = new THREE.Vector3();
    const ground = new THREE.Vector3();
    let n = 0;
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const p = this.ctrl.wheelContactPoint(i);
      const nr = this.ctrl.wheelContactNormal(i);
      if (!p || !nr) continue;
      ground.add(p as THREE.Vector3Like);
      up.add(nr as THREE.Vector3Like);
      n++;
    }
    if (n > 0 && up.lengthSq() > 1e-6) {
      up.normalize();
      ground.divideScalar(n);
    } else {
      // Нерухома геометрія під центром кузова (без власного корпусу й рухомих тіл).
      const hit = this.world.castRayAndGetNormal(
        new RAPIER.Ray(centerW, { x: 0, y: -1, z: 0 }),
        SHADOW_RAY,
        true,
        RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
        undefined,
        undefined,
        this.body,
      );
      if (!hit) {
        s.obj.visible = false;
        return;
      }
      ground.set(centerW.x, centerW.y - hit.timeOfImpact, centerW.z);
      up.copy(hit.normal as THREE.Vector3Like).normalize();
    }
    s.obj.visible = true;
    // Точка під центром кузова на площині дороги.
    const pos = centerW.clone().addScaledVector(up, -centerW.clone().sub(ground).dot(up) + SHADOW_LIFT);
    // Напрям — уздовж кузова, спроєктований на дорогу (машина сторч — уздовж її «угору»).
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(v.quaternion);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-4) {
      fwd.set(0, 1, 0).applyQuaternion(v.quaternion);
      fwd.addScaledVector(up, -fwd.dot(up));
    }
    fwd.normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    const world = new THREE.Matrix4().makeBasis(right, up, fwd.negate()).setPosition(pos);
    // У систему батька вузла: visual⁻¹ · світ · площина, потім батько⁻¹.
    s.obj.matrix.copy(s.parentInv).multiply(v.matrix.clone().invert()).multiply(world).multiply(s.local);
    s.obj.matrixWorldNeedsUpdate = true;
  }

  syncVisual(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.position.set(t.x, t.y, t.z);
    this.visual.quaternion.set(r.x, r.y, r.z, r.w);
    if (this.shadow) this.placeShadow();
    // Колеса: підвіска (зсув по Z гри), поворот керма (навколо Z), обертання (навколо X).
    for (let i = 0; i < this.wheels; i++) {
      const w = this.wheelVisual[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
      const steer = this.ctrl.wheelSteering(i) ?? 0;
      const spin = this.ctrl.wheelRotation(i) ?? 0;
      const m = w.base.clone();
      m.multiply(new THREE.Matrix4().makeTranslation(0, 0, this.suspAnchor - len));
      m.multiply(new THREE.Matrix4().makeRotationZ(steer));
      m.multiply(new THREE.Matrix4().makeRotationX(-spin));
      w.obj.matrix.copy(m);
    }
  }

  reset(spawn: { position: THREE.Vector3; forward: THREE.Vector3 }): void {
    const f = spawn.forward.clone().setY(0).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 1, 0), f.clone().negate()),
    );
    this.body.setTranslation(spawn.position, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.reverseMode = false;
    this.brakeTime = 0;
    this.engine.reset();
  }

  /** Поточний напрям «уперед» у світі. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.visual.quaternion);
  }

  dispose(): void {
    this.world.removeVehicleController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}

