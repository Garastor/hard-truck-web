import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GROUP_BUMPER, GROUP_MOVABLE, g2t, groups } from '../physics/world';
import type { ControlState } from '../input/input';
import { visibleBox, type TruckDef, type TruckModel } from './trucks';
import { Engine, GEAR_R, type EngineProfile } from './engine';

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
/** Спад керма зі швидкістю (с/м) для тягача з напівпричепом. */
const TOW_STEER_B = 0.12;
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
 * Найменше бічне прискорення (частка g), за якого вантажівка без вантажу може перекинутися. Поріг ≈ половина колії /
 * (висота центру мас × (1 − roll_lift)); у високих машин (за CenterMassInB3D центр мас ЗіЛа — 1,6 м над дорогою,
 * Iveco — 2,1, КамАЗа — 2,3 при колії 1,7–2,2 м) з типовим roll_lift це 0,47…0,67 g — менше за бічне тертя шин
 * (1,15): вони перекидались у звичайних поворотах на 25–50 км/год, а суперники — по кілька разів за коло. Для таких
 * машин roll_lift піднімаємо до цього порогу (0,85 g лишав перекидання Iveco в шиканах: крен розгойдується
 * на перекладанні керма; 1,0 g — без перекидань на CIRCUIT з 15 суперниками за 60 с); у решти (1,07…1,58 g) — без
 * змін, Mack і Reno (0,96…0,99 g) — ледь помітно. Вантаж, як і раніше, піднімає центр
 * мас і знижує поріг. Налаштування порту на прохання користувача (раніше — лише ЗіЛ 0,12), не дані оригіналу.
 */
const ROLL_MIN_TIP = 1.0;
/**
 * Поріг для окремих вантажівок (за prefix з TRUCK.TCH), частка g. Iveco — найвужча колія (0,87 м від осі) при
 * центрі мас 2,1 м: і з 1,0 g у слаломі й різкому повороті на 40–50 км/год кренилась до 28–43° («як матрац» —
 * відгук користувача); з 1,25 g (roll_lift 0,66) — 9–10°, як Volvo. Налаштування порту.
 */
const ROLL_MIN_TIP_BY_TRUCK: Record<string, number> = { iveco: 1.25 };

/**
 * Пружини й амортизатори коліс — пропорційно статичному навантаженню колеса (як у справжніх вантажівок: ресори
 * під вагу осі). Rapier задає жорсткість «на одиницю маси кузова», однакову для всіх коліс, тож у машин із центром
 * мас далеко від середини бази (Iveco, КамАЗ: CenterMassInB3D на 1,2 м позаду — задня вісь ≈ 70 % ваги) зад осідав
 * до відбійника, а передні колеса на місці відривались від дороги — машина стояла на одній осі й лягала на бік від
 * повороту керма. Множник колеса: частка ваги його осі (за плечима до центру мас) × кількість коліс / коліс на осі
 * (1 — середнє). Передня вісь — перші два колеса, решта — задні. Частка обмежена 0,2…0,8.
 */
function axleLoads(wheelZ: number[], comZ: number): number[] {
  const n = wheelZ.length;
  if (n < 3) return wheelZ.map(() => 1);
  const front = (wheelZ[0] + wheelZ[1]) / 2;
  const rear = wheelZ.slice(2).reduce((a, z) => a + z, 0) / (n - 2);
  if (Math.abs(rear - front) < 0.5) return wheelZ.map(() => 1);
  const share = THREE.MathUtils.clamp((rear - comZ) / (rear - front), 0.2, 0.8);
  return wheelZ.map((_, i) => (i < 2 ? (share * n) / 2 : ((1 - share) * n) / (n - 2)));
}

/** Частки breakpower на колесо: передні / задні (телеметрія ЗіЛ, s6) — гіпотеза для інших вантажівок. */
const BRAKE_FRONT = 0.49;
const BRAKE_REAR = 0.35;
/** Коефіцієнт опору кочення (накат на 4-й передачі без газу, s7). */
const ROLLING_RESISTANCE = 0.015;
/**
 * М'яке покриття: понад його найбільшу швидкість машина пригальмовує з цим уповільненням, м/с² (типове; покриття
 * може задати своє), повністю — на SOFT_DRAG_SPAN м/с понад межу; двигун на високій передачі його не переборює.
 * Налаштування порту.
 */
const SOFT_DRAG = 2;
const SOFT_DRAG_SPAN = 3;
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
  /** Режим «аркада»: дощ і пошкодження не впливають на машину (покриття — так само, як у «симуляторі»). */
  arcade?: boolean;
  /** Відмінності двигуна й коробки гри (Дальнобойщики 2). */
  engine?: EngineProfile;
  /** Висота прикладання бічної сили шин (частка висоти центру мас, див. TIRE.roll_lift) — замість налаштувань першої гри. */
  rollLift?: number;
  /** Межа керма (частка STEER_TO_WHEEL) за швидкістю, м/с — замість межі першої гри 1,04/(1 + 0,056·v) ≤ 0,913. */
  steerLimit?: (speed: number) => number;
  /** Кут коліс ∝ |кермо|^steerPower (перша гра — 1, лінійно). */
  steerPower?: number;
  /** Педаль гальма за часом утримання, с (0…1), і множник сили гальм — замість t/(t + 1) першої гри. */
  brake?: { pedal: (t: number) => number; scale: number };
}

/** Тінь над дорогою, м — щоб не мерехтіла з дорогою (гіпотеза порту). */
const SHADOW_LIFT = 0.04;
/** Машина друга далі за стільки метрів від своєї пози з мережі (рестарт, телепорт) — переноситься одразу, м. */
const REMOTE_SNAP = 10;
/** За скільки секунд машина друга пружно повертається до своєї пози з мережі після удару, с. */
const REMOTE_FOLLOW = 0.2;
/** За скільки секунд швидкість машини друга наближається до бажаної (поштовх від удару загасає), с. */
const REMOTE_BLEND = 0.1;
/**
 * Заготовки для обчислень щокадру й щокроку (без нових об'єктів — менше роботи збирачу сміття на телефоні). У кожної
 * функції свої: одна не викликає іншу посеред обчислень.
 */
const V = Array.from({ length: 8 }, () => new THREE.Vector3());
const M = Array.from({ length: 6 }, () => new THREE.Matrix4());
const Q = new THREE.Quaternion();
const E = new THREE.Euler();
/** Як далеко вниз шукати землю для тіні, коли колеса не торкаються дороги, м. */
const SHADOW_RAY = 30;

/** Габарити машини для світла фар (земля під машиною, передня й задня межі, ширина) — у системі моделі. */
export interface LightGeometry {
  groundY: number;
  frontZ: number;
  backZ: number;
  width: number;
}

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
  /** roll_lift цієї машини (не нижче TIRE.roll_lift; див. ROLL_MIN_TIP). */
  private autoRollLift: number = TIRE.roll_lift;
  /** Тягне напівпричіп (Дальнобойщики 2): бічні сили коліс обмежуються навантаженням, а не масою тягача. */
  towing = false;
  /**
   * Фільтр променів коліс: напівпричіп нависає над задньою віссю, і в цистерни дно нижче за кріплення коліс — без
   * фільтра тягач «ставав» колесами на власний причіп і перекидався.
   */
  rayFilter: ((c: RAPIER.Collider) => boolean) | undefined = undefined;

  /**
   * Навантаження на сідло, Н (напівпричіп): задня підвіска тягача (колеса з 2-го) жорсткішає пропорційно — у Rapier
   * сила пружини масштабується масою шасі, і вага причепа інакше стискала її до упору. Частка задніх коліс у вазі
   * тягача — половина (гіпотеза).
   */
  setTowLoad(newtons: number): void {
    const f = 1 + newtons / (this.mass * 9.81 * 0.5);
    for (let i = 2; i < this.wheels; i++) {
      this.ctrl.setWheelSuspensionStiffness(i, SUSPENSION.stiffness * f);
      this.ctrl.setWheelMaxSuspensionForce(i, this.mass * 40 * f);
    }
  }

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
  /** Педаль гальма з урахуванням заднього ходу (на R «гальмо» везе назад, а гальмує «газ»). */
  brakePedal(input: ControlState): number {
    return this.reverseMode ? input.throttle : input.brake;
  }
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
  /**
   * Покриття під колесами: множники зчеплення, опору кочення й межі керма (1 — асфальт), найбільша швидкість,
   * м/с, і уповільнення понад неї, м/с². Однаково в аркаді й «симуляторі».
   */
  private surfaceGrip = 1;
  private surfaceRoll = 1;
  private surfaceSteer = 1;
  private surfaceMaxSpeed = Infinity;
  private surfaceDrag = SOFT_DRAG;
  private readonly rollLift: number | undefined;
  private readonly steerLimit: ((speed: number) => number) | undefined;
  private readonly steerPower: number;
  private readonly brakeProfile: { pedal: (t: number) => number; scale: number } | undefined;
  /** Тестовий режим: дощ (у кар'єрі він уже в setup.grip). */
  weatherGrip = 1;
  setSurface(grip: number, roll: number, steer = 1, maxSpeed = Infinity, drag = SOFT_DRAG): void {
    this.surfaceGrip = grip;
    this.surfaceRoll = roll;
    this.surfaceSteer = steer;
    this.surfaceMaxSpeed = maxSpeed;
    this.surfaceDrag = drag;
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
    this.rollLift = setup.rollLift;
    this.steerLimit = setup.steerLimit;
    this.steerPower = setup.steerPower ?? 1;
    this.brakeProfile = setup.brake;
    this.tractionControl = setup.tractionControl ?? false;
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
    }, setup.engine);

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
    const comModel = new THREE.Vector3(cx, cy, -cz)
      .multiplyScalar(mass - cargo)
      .addScaledVector(cargoAt, cargo)
      .divideScalar(mass);
    const com = comModel.clone().sub(colliderAt);
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
    const wheelAt = model.wheelBase.map((m) => g2t(new THREE.Vector3().setFromMatrixPosition(m)));
    const load = axleLoads(wheelAt.map((c) => c.z), comModel.z);
    for (let i = 0; i < this.wheels; i++) {
      const c = wheelAt[i];
      this.ctrl.addWheel({ x: c.x, y: c.y + this.suspAnchor, z: c.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.suspRest, this.wheelRadius);
      this.ctrl.setWheelSuspensionStiffness(i, SUSPENSION.stiffness * load[i]);
      this.ctrl.setWheelSuspensionCompression(i, SUSPENSION.compression * load[i]);
      this.ctrl.setWheelSuspensionRelaxation(i, SUSPENSION.relaxation * load[i]);
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
    // Поріг перекидання без вантажу: половина колії (вужча вісь) / висота центру мас над дорогою.
    const halfTrack = Math.min(...wheelAt.map((c) => Math.abs(c.x)));
    const comHeight = cy - ground;
    const minTip = ROLL_MIN_TIP_BY_TRUCK[def.prefix.toLowerCase()] ?? ROLL_MIN_TIP;
    if (comHeight > 0.1) this.autoRollLift = Math.min(0.8, Math.max(TIRE.roll_lift, 1 - halfTrack / (comHeight * minTip)));
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
    this.savePrev();
    const tech = this.def.tech;
    // Швидкість уздовж напрямку «уперед» (−Z локально), м/с; + уперед.
    const lv = this.body.linvel();
    const q = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speedKmh = Math.abs(v) * 3.6;

    // Кермо як в оригіналі (s6): межа залежить від швидкості 1,04/(1 + 0,056·v) ≤ 0,913,
    // кут колеса = 0,684 × кермо; внутрішнє колесо повертається більше (Аккерман, cot o − cot i = 0,208).
    // З напівпричепом кермо на швидкості ще менше (гіпотеза порту): інакше повне кермо на 25 км/год дає радіус,
    // менший за базу причепа, і зчіпка складається.
    const tow = this.towing ? 1 / (1 + TOW_STEER_B * Math.abs(v)) : 1;
    const limit = (this.steerLimit ? this.steerLimit(Math.abs(v)) : Math.min(STEER_MAX, STEER_A / (1 + STEER_B * Math.abs(v)))) * tow * this.surfaceSteer;
    const steer = this.steerPower === 1 ? input.steer : Math.sign(input.steer) * Math.abs(input.steer) ** this.steerPower;
    this.steerAngle = -steer * limit * STEER_TO_WHEEL;
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
    eng.update(dt, gas, brake, v, this.reverseMode, !!input.sharp);
    this.rpm = this.engineOn ? eng.rpm : Math.max(0, this.rpm - 3000 * dt);
    this.gear = eng.displayGear === GEAR_R ? -1 : eng.displayGear - 1;

    // Гальмо з клавіатури наростає як t/(t + 1) (поле [0x33a] оригіналу; телеметрія s6).
    this.brakeTime = brake > 0 ? this.brakeTime + dt : 0;
    const bp = this.brakeProfile;
    const brakePedal = brake > 0 ? brake * (bp ? bp.pedal(this.brakeTime) : this.brakeTime / (this.brakeTime + 1)) : 0;

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
      let force = brakePedal * share * tech.brakePower * this.brakeFactor * (bp?.scale ?? 1) + rolling;
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
    this.ctrl.updateVehicle(dt, undefined, undefined, this.rayFilter);
    this.applySoftDrag(dt, v, fwd);
    this.applyBumpStops(dt);
    this.applyTireLateral(dt);
  }

  /**
   * М'яке покриття: понад його межу швидкості — опір проти руху, плавно наростає з перевищенням. Прикладається
   * імпульсом у точках контакту коліс, а не гальмами: гальма Rapier обмежені зчепленням (на болоті ≈ 0,5 g), і
   * різке уповільнення не досягалося; у центрі мас разом із тягою коліс він перекидав машину. Не гальмує нижче межі.
   */
  private applySoftDrag(dt: number, v: number, fwd: THREE.Vector3): void {
    const over = Math.abs(v) - this.surfaceMaxSpeed;
    if (over <= 0) return;
    const points: { x: number; y: number; z: number }[] = [];
    for (let i = 0; i < this.wheels; i++) {
      const p = this.ctrl.wheelIsInContact(i) ? this.ctrl.wheelContactPoint(i) : null;
      if (p) points.push(p);
    }
    if (!points.length) return;
    const dv = Math.min(over, this.surfaceDrag * Math.min(1, over / SOFT_DRAG_SPAN) * dt);
    const j = (-Math.sign(v) * this.mass * dv) / points.length;
    for (const p of points) this.body.applyImpulseAtPoint({ x: fwd.x * j, y: fwd.y * j, z: fwd.z * j }, p, true);
  }

  /** Відбійники підвіски (див. SUSPENSION.bump_*): сила вгору в точці кріплення колеса, коли стиснення велике. */
  private applyBumpStops(dt: number): void {
    const S = SUSPENSION;
    const r = this.body.rotation();
    const q = Q.set(r.x, r.y, r.z, r.w);
    const up = V[0].set(0, 1, 0).applyQuaternion(q);
    const t = this.body.translation();
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const excess = this.suspRest - (this.ctrl.wheelSuspensionLength(i) ?? this.suspRest) - S.bump_from;
      if (excess <= 0) continue;
      const c = this.ctrl.wheelChassisConnectionPointCs(i);
      if (!c) continue;
      const at = V[1].set(c.x, c.y, c.z).applyQuaternion(q).add(V[2].set(t.x, t.y, t.z));
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
    const q = Q.set(r.x, r.y, r.z, r.w);
    const up = V[0].set(0, 1, 0).applyQuaternion(q);
    const chassisFwd = V[1].set(0, 0, -1).applyQuaternion(q);
    const wheelMass = this.mass / this.wheels;
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const load = this.ctrl.wheelSuspensionForce(i) ?? 0;
      // Тягач з напівпричепом: колеса під сідлом тримають і частину причепа — межа кроку за навантаженням.
      const stepMass = this.towing ? Math.max(wheelMass, load / 9.81) : wheelMass;
      const p = this.ctrl.wheelContactPoint(i);
      if (load <= 0 || !p) continue;
      const fwd = V[2].copy(chassisFwd).applyAxisAngle(up, this.ctrl.wheelSteering(i) ?? 0);
      const right = V[3].crossVectors(fwd, up).normalize();
      const vp = this.body.velocityAtPoint(p);
      const vLong = vp.x * fwd.x + vp.y * fwd.y + vp.z * fwd.z;
      const vLat = vp.x * right.x + vp.y * right.y + vp.z * right.z;
      const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), TIRE.low_speed));
      const x = alpha / TIRE.slip_peak;
      const mu = x <= 1 ? x : Math.max(TIRE.slide, 1 - (1 - TIRE.slide) * (x - 1) * 0.5);
      // Бічна сила (перпендикулярно колесу): росте з кутом проковзування до межі, у заносі — TIRE.slide.
      let force = mu * TIRE.mu * this.grip * this.surfaceGrip * this.weatherGrip * load;
      // Не «перестрибувати» нуль бокової швидкості за один крок (стійкість на малій швидкості).
      force = Math.min(force, (stepMass * Math.abs(vLat)) / dt);
      const impulse = right.multiplyScalar(-Math.sign(vLat) * force * dt);
      if (x > 1) {
        // Занос: колесо ще й гальмує вздовж руху — тим сильніше, чим глибший занос; вантажівка
        // втрачає швидкість, доки шина знову не зачепиться (тоді — різкий доворот).
        const drag = Math.min(TIRE.slide_drag_max, TIRE.slide_drag * (x - 1)) * TIRE.mu * this.grip * this.surfaceGrip * this.weatherGrip * load;
        const limited = Math.min(drag, (stepMass * Math.abs(vLong)) / dt);
        impulse.addScaledVector(fwd, -Math.sign(vLong) * limited * dt);
      }
      // Точку прикладання піднімаємо до висоти центру мас на частку TIRE.roll_lift: перекидальний момент трохи
      // менший за фізичний (як rollInfluence у Bullet) — бічне тертя 1,15 інакше перекидало б у кожному повороті.
      const com = this.body.worldCom();
      const h = (com.x - p.x) * up.x + (com.y - p.y) * up.y + (com.z - p.z) * up.z;
      const lift = this.rollLift ?? this.autoRollLift;
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
    const centerW = V[0].copy(s.mid).applyMatrix4(v.matrix);
    const up = V[1].set(0, 0, 0);
    const ground = V[2].set(0, 0, 0);
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
    const pos = V[3].copy(centerW).addScaledVector(up, -V[4].copy(centerW).sub(ground).dot(up) + SHADOW_LIFT);
    // Напрям — уздовж кузова, спроєктований на дорогу (машина сторч — уздовж її «угору»).
    const fwd = V[5].set(0, 0, -1).applyQuaternion(v.quaternion);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-4) {
      fwd.set(0, 1, 0).applyQuaternion(v.quaternion);
      fwd.addScaledVector(up, -fwd.dot(up));
    }
    fwd.normalize();
    const right = V[6].crossVectors(fwd, up).normalize();
    const world = M[0].makeBasis(right, up, fwd.negate()).setPosition(pos);
    // У систему батька вузла: visual⁻¹ · світ · площина, потім батько⁻¹.
    s.obj.matrix.copy(s.parentInv).multiply(M[1].copy(v.matrix).invert()).multiply(world).multiply(s.local);
    s.obj.matrixWorldNeedsUpdate = true;
  }

  /** Стан кузова до останнього кроку фізики — для згладжування між кроками (syncVisual). */
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private savePrev(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
  }

  /**
   * Модель — за тілом фізики. alpha — частка кроку фізики, що лишилась у кадрі (0…1): модель між станами до й після
   * останнього кроку. Без цього за частоти кадрів, не кратної кроку (50 к/с, 120 Гц), машина на екрані зсувалась то
   * на 0, то на 2 кроки — від третьої особи (камера плавна) вона смикалась.
   */
  syncVisual(alpha = 1): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.position.set(t.x, t.y, t.z);
    this.visual.quaternion.set(r.x, r.y, r.z, r.w);
    // Стрибок (рестарт, телепорт) — без згладжування.
    if (alpha < 1 && this.prevPos.distanceToSquared(this.visual.position) < 25) {
      this.visual.position.lerpVectors(this.prevPos, this.visual.position, alpha);
      this.visual.quaternion.slerpQuaternions(this.prevQuat, this.visual.quaternion.clone(), alpha);
    }
    if (this.shadow) this.placeShadow();
    // Колеса: підвіска (зсув по Z гри), поворот керма (навколо Z), обертання (навколо X).
    for (let i = 0; i < this.wheels; i++) {
      const w = this.wheelVisual[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
      const steer = this.ctrl.wheelSteering(i) ?? 0;
      const spin = this.ctrl.wheelRotation(i) ?? 0;
      const m = w.obj.matrix.copy(w.base);
      m.multiply(M[2].makeTranslation(0, 0, this.suspAnchor - len));
      m.multiply(M[2].makeRotationZ(steer));
      m.multiply(M[2].makeRotationX(-spin));
    }
  }

  /** Від системи батька колеса до системи моделі (visual) — ланцюжок вузлів моделі незмінний, рахуємо раз. */
  private wheelFrames: { m: THREE.Matrix4; inv: THREE.Matrix4 }[] | null = null;
  private wheelFrame(i: number): { m: THREE.Matrix4; inv: THREE.Matrix4 } {
    this.wheelFrames ??= this.wheelVisual.map(({ obj }) => {
      const m = new THREE.Matrix4();
      for (let o = obj.parent; o && o !== this.visual; o = o.parent) {
        if (o.matrixAutoUpdate) o.updateMatrix();
        m.premultiply(o.matrix);
      }
      return { m, inv: m.clone().invert() };
    });
    return this.wheelFrames[i];
  }

  /**
   * Візуальне трясіння (лише модель, після syncVisual; фізика не змінюється): кузов повертається на pitch/roll, рад, і
   * піднімається на lift, м, у власних осях, а колеса лишаються на землі — ніби працює підвіска — і кожне ще
   * підскакує на bump(i), м.
   */
  shakeVisual(pitch: number, roll: number, lift: number, bump: (i: number) => number): void {
    // Як нижче з моделлю: поворот, потім підйом уздовж повернутої осі Y.
    const rot = Q.setFromEuler(E.set(pitch, 0, roll));
    const shake = M[3].makeRotationFromQuaternion(rot).multiply(M[4].makeTranslation(0, lift, 0));
    this.visual.quaternion.multiply(rot);
    this.visual.position.add(V[7].set(0, lift, 0).applyQuaternion(this.visual.quaternion));
    const undo = shake.invert();
    for (let i = 0; i < this.wheels; i++) {
      const P = this.wheelFrame(i);
      // Колесо в системі моделі: зворотне трясіння (лишається, де було) і підскок угору.
      const w = M[4].copy(P.inv).multiply(undo).multiply(M[5].makeTranslation(0, bump(i), 0)).multiply(P.m);
      this.wheelVisual[i].obj.matrix.premultiply(w);
    }
  }

  /**
   * Машина друга в мережевій грі: тіло з масою вантажівки, але без тяжіння — його веде стан із мережі
   * (followRemote). Не кінематичне: кінематичне тіло для фізики — нерухома стіна, наїзд зупиняв машину гравця на місці
   * з сильним ударом; з масою удар ділиться між машинами, як між двома вантажівками.
   */
  makeRemote(): void {
    this.body.setGravityScale(0, true);
  }

  /** Поза машини друга з мережі на попередньому кроці — для швидкості, з якою рухається сама поза. */
  private readonly remotePrev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), set: false };

  /**
   * Крок машини друга (до world.step): кут керованих коліс, оберти й швидкість — з мережі; підвіска й обертання коліс
   * — променями контролера, як у своєї машини (його поштовхи тілу відкидаємо: без тяжіння підвіска підкидала б машину).
   * Бажана швидкість тіла — рух самої пози з мережі плюс пружне повернення до неї за REMOTE_FOLLOW с; швидкість тіла
   * наближається до неї за REMOTE_BLEND с, тож поштовх від удару живе кілька кроків: машина друга відходить і
   * повертається, а удар ділиться між машинами (швидкість, жорстко задана щокроку, робила її стіною). Далеко від пози
   * (рестарт друга) — одразу туди.
   */
  followRemote(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion, steer: number, rpm: number, speedKmh: number, reverse: boolean): void {
    this.savePrev();
    this.steerAngle = steer;
    this.ctrl.setWheelSteering(0, steer);
    this.ctrl.setWheelSteering(1, steer);
    for (let i = 0; i < this.wheels; i++) {
      this.ctrl.setWheelEngineForce(i, 0);
      this.ctrl.setWheelBrake(i, 0);
    }
    // Швидкості після минулого кроку (з поштовхами від ударів) — до поштовхів підвіски.
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const vNow = V[4].set(lv.x, lv.y, lv.z);
    const wNow = V[5].set(av.x, av.y, av.z);
    this.ctrl.updateVehicle(dt, undefined, undefined, this.rayFilter);
    const prev = this.remotePrev;
    const t = this.body.translation();
    const d = V[0].set(pos.x - t.x, pos.y - t.y, pos.z - t.z);
    if (!prev.set || d.lengthSq() > REMOTE_SNAP ** 2) {
      this.body.setTranslation(pos, true);
      this.body.setRotation(quat, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.savePrev();
    } else {
      // Лінійна: рух пози за крок + повернення до неї.
      const k = Math.min(1, dt / REMOTE_BLEND);
      const want = V[1].copy(pos).sub(prev.pos).divideScalar(dt).addScaledVector(d, 1 / REMOTE_FOLLOW);
      vNow.lerp(want, k);
      this.body.setLinvel({ x: vNow.x, y: vNow.y, z: vNow.z }, true);
      // Кутова: поворот пози за крок + повернення до неї (поворот, що лишився: ціль · поточний⁻¹).
      const r = this.body.rotation();
      const w = angularVelocity(Q.copy(prev.quat).invert().premultiply(quat), 1 / dt, V[2]);
      const back = angularVelocity(Q.set(r.x, r.y, r.z, r.w).invert().premultiply(quat), 1 / REMOTE_FOLLOW, V[3]);
      wNow.lerp(w.add(back), k);
      this.body.setAngvel({ x: wNow.x, y: wNow.y, z: wNow.z }, true);
    }
    prev.pos.copy(pos);
    prev.quat.copy(quat);
    prev.set = true;
    this.rpm = rpm;
    this.speedKmh = speedKmh;
    this.gear = reverse ? -1 : 1;
  }

  /** Кут керованих коліс, рад (+ — уліво) — для стану в мережі. */
  get wheelSteer(): number {
    return this.steerAngle;
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
    this.savePrev();
    this.reverseMode = false;
    this.brakeTime = 0;
    this.engine.reset();
  }

  /** Поточний напрям «уперед» у світі (за тілом фізики: модель згладжена й може відставати на частку кроку). */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  }

  dispose(): void {
    this.world.removeVehicleController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}

/** Кутова швидкість повороту dq (кватерніон) за 1/rate с: вісь × кут × rate (коротший шлях). */
function angularVelocity(dq: THREE.Quaternion, rate: number, out: THREE.Vector3): THREE.Vector3 {
  if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
  const angle = 2 * Math.acos(Math.min(1, dq.w));
  const sin = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
  const k = sin > 1e-6 ? (angle / sin) * rate : 0;
  return out.set(dq.x * k, dq.y * k, dq.z * k);
}
