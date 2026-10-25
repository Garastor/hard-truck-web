import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { GROUP_BUMPER, GROUP_MOVABLE, g2t, groups } from '../physics/world';
import type { ControlState } from '../input/input';
import { rearAbove, visibleBox, type TruckDef, type TruckModel } from './trucks';
import { Engine, GEAR_N, GEAR_R, type EngineProfile } from './engine';
import { HitMeter } from './hitMeter';
import { RoomBounds } from '../physics/roomBounds';
import { KING, ROUGH_ASPHALT, roadBump, type Roughness, rollingForce, steerLimit, tireCurve, wheelForces, yawRate, type KingWheel, type WheelSlip } from './kingModel';

/**
 * Вантажівка на DynamicRayCastVehicleController (Rapier).
 * Параметри — з [TECHn] у TRUCK.TCH. Двигун і коробка — відтворені з HTruck.exe (engine.ts);
 * шини, підвіска й інтегрування кузова — поки Rapier (доріжка R4 продовжується).
 */
/** Кермо (телеметрія s6): межа 1,04/(1 + 0,056·v), не більше 0,913; кут колеса = 0,684 × кермо. */
/** Центр повороту: частка шляху від середини задніх осей до останньої (порт, рішення користувача). */
const PIVOT_TO_LAST = 0.6;
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
/**
 * М'яке покриття: понад його найбільшу швидкість машина пригальмовує з цим уповільненням, м/с² (повністю — на
 * SOFT_DRAG_SPAN м/с понад межу; двигун на високій передачі його не переборює). Налаштування порту.
 */
const SOFT_DRAG = 2;
const SOFT_DRAG_SPAN = 3;
/**
 * Момент інерції навколо вертикалі на кг маси, м² (запис king.exe, ZilR: [0x1f48].z / [0x2640] = 22 849 / 6671; для
 * інших машин — гіпотеза: tech `I` з ним прямо не повʼязаний).
 */
const YAW_GYRATION2 = 3.425;
/**
 * Пружини king.exe (0x4f8260, дамп ZilR): L₀ = хід × 4/3 (0,4 при 0,3 — гіпотеза для інших машин), підкрок ≤ 0,0085 с;
 * інерція крену й тангажу на кг маси, м² ([0x1f48] = 19 647 / 4314 / 22 849 при 6671 кг; X — бік, Y — уперед).
 */
const SPRING_L0 = 4 / 3;
const SPRING_STEP = 0.0085;
const KING_PITCH_GYRATION2 = 2.945;
const KING_ROLL_GYRATION2 = 0.6467;
const KING_COM_HEIGHT = 1.43;
/**
 * Колія для перенесення навантаження, м (king.exe, дамп ZilR: колеса ±1,13 спереду, ±1,21 ззаду; точки контакту
 * Rapier у порту — з моделі, вужчі). Гіпотеза для інших машин — та сама.
 */
const KING_TRACK = { front: 2.26, rear: 2.42 };
/** Нахил кузова від прискорення king.exe (0x4fca10): рад на м/с², межа, частка поздовжнього. */
const LEAN_K = 0.0109;
const LEAN_MAX = 0.0435;
const LEAN_PITCH = 0.2;
/** Бампери: висота низу над дорогою й товщина, м (гіпотеза). */
const BUMPER_CLEARANCE = 0.35;
const BUMPER_DEPTH = 0.5;
/** Товщина рами тягача під сідлом для колізії, м (гіпотеза порту). */
const FRAME_DEPTH = 0.3;
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
  /**
   * Антипробуксовочна система (АПС): тяга ведучого колеса не перевищує межу зчеплення. У русі king.exe (покращення
   * ABS, 0x4ffc1c) — газ ≤ 0,9 × 0,9 частки, за якої тяга дорівнює зчепленню ведучих коліс.
   */
  tractionControl?: boolean;
  /**
   * Гальмо двигуном (покращення PR_ENGINE_BRAKE, 0x507360): до гальмування двигуном тертям −n·c_f додається
   * −n·E·√b (b — педаль гальма), E = engineBrake·c_f. 0 — немає.
   */
  engineBrake?: number;
  /** Регульоване сидіння (РС): очі водія вище на стільки метрів. */
  seatRaise?: number;
  /** Покриття дороги впливає на зчеплення й опір (симулятор; в аркаді — ні). */
  surfaceEffects?: boolean;
  /** Відмінності двигуна й коробки гри (Дальнобойщики 2). */
  engine?: EngineProfile;
  /** Висота прикладання бічної сили шин (частка висоти центру мас, див. TIRE.roll_lift) — замість налаштувань першої гри. */
  rollLift?: number;
  /** Межа керма (частка STEER_TO_WHEEL) за швидкістю, м/с — замість межі першої гри 1,04/(1 + 0,056·v) ≤ 0,913. */
  steerLimit?: (speed: number) => number;
  /** Кут коліс ∝ |кермо|^steerPower (перша гра — 1, лінійно). */
  steerPower?: number;
  /** Педаль гальма за часом утримання, с (0…1), і множник сили гальм — замість t/(t + 1) першої гри. */
  brake?: { pedal: (t: number, sharp?: boolean) => number; scale: number };
  /** Рух за формулами king.exe (kingModel.ts) замість шин Rapier — Дальнобойщики 2. */
  king?: KingSetup;
}

/** Параметри руху king.exe, яких немає у vehicle.tech (див. vehicles/controls.ts: HT2_KING). */
export interface KingSetup {
  /** Зчеплення коліс з асфальтом μ. */
  mu: number;
  /** Множник μ у дощ. */
  rain: number;
  /** Множник межі керма k (1,5·atan(μ·k·L/v²)). */
  steerK: number;
  /** Кермо → частка повного кута 45°: a·|s|^p (запис king.exe, див. HT2_KING). */
  steerScale: number;
  steerPower: number;
  /** Крен кузова, рад на м/с² бічного прискорення, і межа (запис king.exe). */
  rollK: number;
  rollMax: number;
  /** Хід підвіски коліс, м (vehicle.tech `suspension`) — масштаб нерівності дороги (roadBump). */
  travel?: readonly number[];
  /**
   * Динамічний режим king.exe (3): бічні сили шин замість «швидкість уздовж курсу» (TruckVehicle.tireStep). У
   * оригіналі — машина гравця (телеметрія); трафік і ІІ — кінематичні (режим 0/1).
   */
  tires?: boolean;
  /** Множник μ для бічних сил шин (μ king.exe — 0,83 у записі, поздовжнє в порту підігнано з 0,71). */
  sideGrip?: number;
  /** Режим «Аркадний» (налаштування гри): допомога керуванню в режимі шин (ARCADE, arcadeAssist). */
  arcade?: boolean;
}

/** Тінь над дорогою, м — щоб не мерехтіла з дорогою (гіпотеза порту). */
const SHADOW_LIFT = 0.04;
/** Як далеко вниз шукати землю для тіні, коли колеса не торкаються дороги, м. */
const SHADOW_RAY = 30;
/** Колесо, що ковзає вбік, лишає слід понад цей кут ковзання, рад (10° — king.exe 0x502780, 0x64daa0). */
const TRACE_ALPHA = 0.174533;
/** Вихлоп king.exe: газ понад це протягом перших EXHAUST_TIME с утримання газу (з памʼяті гри). */
const EXHAUST_GAS = 0.5;
const EXHAUST_TIME = 2;
/** Ковзання вбік (king.exe [0x19c4]): |sin α| понад це. */
const SKID_SIN = 0.26;
/**
 * Аварійний поворот з Ctrl (порт, власна логіка на прохання користувача — не з king.exe): швидкістю жертвуємо, щоб
 * вписатися в поворот, коли сповільнитись уже нема часу. Кермо понад звичайною межею зчеплення (pastLim):
 * - шини труться й гасять швидкість — SHARP_SCRUB·μ·g, газ при цьому тягне лише частку (SHARP_GAS);
 * - машина повертає крутіше, ніж без Ctrl: курс тягнеться до кінематичного v·sin δ / L, а швидкість — за курсом, з
 *   бічним прискоренням до SHARP_LAT·μ·g (більше, ніж дають шини моделі);
 * - на великій швидкості колеса тримають лише частину (SHARP_SLIDE_GRIP понад SHARP_SLIDE_KMH): машину несе вперед, але
 *   вже в бік повороту; що повільніше (до SHARP_GRIP_KMH), то сильніше колеса «ловлять» дорогу й поворот різкішає.
 * Ctrl вмикається й гасне плавно (SHARP_BLEND_ON / _OFF, 1/с).
 */
/**
 * Допомога керуванню в режимі «Аркадний» (власна логіка порту, на прохання користувача: з причепом на 100 км/год
 * машина йшла дугою ≈ 90 м, хоч як крути, а тягач без причепа зривався в обертання). Лише режим шин, не з Ctrl:
 * - межа керма за зчепленням — з k × ARCADE.steerK (колеса повертаються більше на швидкості);
 * - курс тягнеться (ARCADE.yaw, 1/с) до кінематичного v·sin δ / L, але не крутіше бічного прискорення
 *   ARCADE.lat·μ·g — і докручує, і гасить зрив в обертання;
 * - бічне ковзання кузова понад кінематичне гаситься до ARCADE.slip·ARCADE.lat·μ·g. Обʼєкт змінний — для підбору в консолі (dev).
 * Напівпричіп в «Аркадному» — кінематично за шворнем (Trailer.follow, як у ботів): вільний 23-тонний причіп виносив
 * задок тягача, якого веде допомога (бічна до 15 м/с, складання 60° на повному кермі). «Симулятор» — без змін.
 */
export const ARCADE = { steerK: 3, lat: 1.9, yaw: 3, slip: 0.6 };
const SHARP_SLIDE_KMH = 90;
const SHARP_GRIP_KMH = 50;
const SHARP_SLIDE_GRIP = 0.45;
const SHARP_LAT = 1.6;
/** Як швидко курс тягнеться до кінематичного, 1/с. */
const SHARP_YAW = 5;
const SHARP_SCRUB = 0.4;
const SHARP_GAS = 0.3;
const SHARP_BLEND_ON = 4;
const SHARP_BLEND_OFF = 1.5;
/** Робочі обʼєкти візуалу (без нових обʼєктів щокадру — сміття для збирача памʼяті на телефоні). */
const WHEEL_TMP = new THREE.Matrix4();
const SLERP_TMP = new THREE.Quaternion();
/**
 * Машина з мережі (followRemote, як у першій грі): далі цього від пози — переносимо одразу, м; повернення до пози, с;
 * наближення швидкості тіла до бажаної, с.
 */
const REMOTE_SNAP = 10;
const REMOTE_FOLLOW = 0.2;
const REMOTE_BLEND = 0.1;
const REMOTE_V = Array.from({ length: 6 }, () => new THREE.Vector3());
const REMOTE_Q = new THREE.Quaternion();

/** Кутова швидкість повороту dq за 1/rate с (вісь × кут · rate). */
function angularVelocity(dq: THREE.Quaternion, rate: number, out: THREE.Vector3): THREE.Vector3 {
  if (dq.w < 0) dq.set(-dq.x, -dq.y, -dq.z, -dq.w);
  const angle = 2 * Math.acos(Math.min(1, dq.w));
  const sin = Math.sqrt(Math.max(0, 1 - dq.w * dq.w));
  const k = sin > 1e-6 ? (angle / sin) * rate : 0;
  return out.set(dq.x * k, dq.y * k, dq.z * k);
}
/**
 * Перекидання (порт): промені підвіски Rapier нахиляються разом із кузовом, і на крені ≈ 45° точки опору зсуваються під
 * центр мас — машина «стояла» й їхала на двох колесах. Кузов відхилився від нормалі ґрунту понад TIP_ON — колеса не
 * тримають (сила пружин 0, без тяги й бічних сил): машина падає на бік або повертається на колеса; знову на колесах —
 * ближче TIP_OFF. Поріг — трохи за статичною стійкістю вантажівки (півколія / висота центру мас ≈ 1 / 1,5 → 34°).
 */
export const TIP_ON = (38 * Math.PI) / 180;
export const TIP_OFF = (25 * Math.PI) / 180;

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
  /** Поправки roll_lift за вантажівкою — для підбору в консолі. */
  readonly rollLiftByTruck = ROLL_LIFT_BY_TRUCK;
  /** Тягне напівпричіп (Дальнобойщики 2): бічні сили коліс обмежуються навантаженням, а не масою тягача. */
  towing = false;
  /**
   * Фільтр променів коліс: напівпричіп нависає над задньою віссю, і в цистерни дно нижче за кріплення коліс — без
   * фільтра тягач «ставав» колесами на власний причіп і перекидався.
   */
  rayFilter: ((c: RAPIER.Collider) => boolean) | undefined = undefined;
  private roomRule: ((c: RAPIER.Collider) => boolean) | undefined;
  /** Промені коліс: `rayFilter` і лише підлога своєї кімнати та сусідніх через портал (engine/physics/roomBounds.ts). */
  private readonly groundRays = (c: RAPIER.Collider): boolean =>
    (!this.rayFilter || this.rayFilter(c)) && (this.roomRule ??= RoomBounds.groundFilter(this.world, this.body) ?? (() => true))(c);

  /** Навантаження на сідло, Н (напівпричіп): лягає на задні колеса тягача — див. `balanceSprings`. */
  setTowLoad(newtons: number): void {
    this.balanceSprings(newtons);
  }

  /**
   * Жорсткість пружини кожного колеса — пропорційно його статичному навантаженню (`staticLoads` плюс вага на сідлі
   * порівну на задні колеса), як у king.exe: k_i = N_ст/((x/L₀ + 1)·x) — кожна пружина в рівновазі на тому самому ході
   * (0x508300). У Rapier сила пружини масштабується масою шасі, і однакова жорсткість стискала навантажені колеса до
   * упору: у бортових машин (DafR, VolvoR — центр мас у tech ≈ 3 м позаду, ≈ 80 % ваги на задній осі) задок сідав,
   * машина стояла дибки; вага причепа так само давила задок тягача.
   */
  private balanceSprings(towNewtons = 0): void {
    const loads = this.staticLoads();
    const nr = Math.max(1, this.wheels - 2);
    const avg = (this.mass * KING.g) / this.wheels;
    for (let i = 0; i < this.wheels; i++) {
      const f = (loads[i] + (i >= 2 ? towNewtons / nr : 0)) / avg;
      this.ctrl.setWheelSuspensionStiffness(i, SUSPENSION.stiffness * f);
      this.suspMax[i] = this.mass * 40 * f;
      if (!this.tipped) this.ctrl.setWheelMaxSuspensionForce(i, this.suspMax[i]);
    }
  }

  /** Перекинута (див. TIP_ON): колеса не тримають. */
  tipped = false;
  /** Кулі-шини, увімкнені лише в перекинутої машини. */
  private readonly tires: RAPIER.Collider[] = [];
  /** Найбільша сила пружини коліс (відновлюється, коли машина знову на колесах). */
  private readonly suspMax: number[] = [];
  /** Нормаль ґрунту під колесами з останнього кроку, коли машина була на колесах. */
  private readonly groundUp = new THREE.Vector3(0, 1, 0);

  /** Перед кроком: чи перекинута (кут між віссю кузова вгору й нормаллю ґрунту, з гістерезисом). */
  private updateTip(): void {
    const r = this.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const cos = up.dot(this.groundUp);
    const tipped = cos < Math.cos(this.tipped ? TIP_OFF : TIP_ON);
    if (tipped === this.tipped) return;
    this.tipped = tipped;
    for (let i = 0; i < this.wheels; i++) this.ctrl.setWheelMaxSuspensionForce(i, tipped ? 0 : (this.suspMax[i] ?? this.mass * 40));
    for (const t of this.tires) t.setEnabled(tipped);
  }

  /**
   * Перекинута: нормаль ґрунту — променем униз з центру мас (повз власні тіла). Кузов, що ліг на схил кювету чи насипу
   * паралельно до нього, знову «на колесах» (раніше порівнювався з нормаллю дороги до падіння — причіп так і висів
   * нахиленим на узбіччі).
   */
  private probeGround(): void {
    const c = this.body.worldCom();
    const own = this.body.handle;
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray({ x: c.x, y: c.y + 0.5, z: c.z }, { x: 0, y: -1, z: 0 }), 6, true, undefined, undefined, undefined, undefined, (col) => {
      const p = col.parent();
      return !p ? this.groundRays(col) : p.handle !== own && (!this.rayFilter || this.rayFilter(col));
    });
    if (hit && hit.normal.y > 0.5) this.groundUp.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
  }

  /** Після кроку підвіски на колесах: нормаль ґрунту — середня нормаль контактів. */
  private updateGroundUp(): void {
    if (this.tipped) return this.probeGround();
    const n = new THREE.Vector3();
    for (let i = 0; i < this.wheels; i++) {
      const nr = this.ctrl.wheelIsInContact(i) ? this.ctrl.wheelContactNormal(i) : null;
      if (nr) n.add(nr as THREE.Vector3Like);
    }
    if (n.lengthSq() > 1e-6) this.groundUp.copy(n.normalize());
  }

  private readonly wheelRadius: number;
  /** Кількість коліс (HT1 — 4, HT2 — 4 або 6); керовані — перші два, «передні» гальма — теж. */
  private readonly wheels: number;
  private readonly driven: boolean[];
  private readonly wheelVisual: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly suspRest = SUSPENSION.rest;
  /** Висота кріплення підвіски над центром колеса моделі, м (незмінна: від неї — посадка кузова й колеса). */
  private readonly suspAnchor = 0.175;
  /** Кут керованих коліс, рад (+ — ліворуч). */
  steerAngle = 0;
  /** Задній хід: гравець утримує гальмо на місці (тоді «гальмо» — це газ назад). */
  private reverseMode = false;
  /** Педаль гальма з урахуванням заднього ходу (на R «гальмо» везе назад, а гальмує «газ»). */
  brakePedal(input: ControlState): number {
    return this.reverseMode ? input.throttle : input.brake;
  }
  /** Скільки утримується гальмо на місці (для вмикання задньої). */
  private reverseHold = 0;
  private brakeTime = 0;
  /** Педаль гальма останнього кроку, 0…1. */
  private pedalNow = 0;
  /** Швидкість уперед останнього кроку, м/с (+ — уперед). */
  private vNow = 0;
  /** Ручне гальмо останнього кроку. */
  private handbrakeNow = false;
  /**
   * Удар відбійників підвіски для звуку: найбільша за кроки з останнього забору Σ сил відбійників / масу, м/с²
   * (аналог «сили удару» пробою king.exe [ph+0x3be8+4i]; забирає drive.vehicleSounds і обнуляє).
   */
  suspHit = 0;

  /** Гальма тягнуть повітря (king.exe 0x538370, «пшш»): педаль гальма > 0,1 або ручник. */
  airBrakeOn(): boolean {
    return this.pedalNow > 0.1 || this.handbrakeNow;
  }

  /** Маса машини з вантажем, кг (king.exe «пшш» — лише машинам понад 5000 кг). */
  get totalMass(): number {
    return this.mass;
  }

  /**
   * Гучність вереску шин 0…1 (петля breakSound; king.exe 0x54a380 → [car+0x522c] → 0x538370). Колеса на землі:
   * A — ковзає вбік (`skid`, [Г] прапорець [ph+0x346c+4i]), B — буксує чи заблоковане (`slip`, [Г] [ph+0x348c+4i]).
   * Звук, лише коли (є A і горизонтальна швидкість > 0,5 м/с) або є B: S = 0,3·Σ A·min(1, |α|/0,349) (α — кут
   * ковзання колеса, [Г] [ph+0x338c+4i]), V = S·(1 + f(v)) + 3·(0,06·A₀A₁ + 0,3·A₂ + 0,2·A₃) + 0,15·(B₀ + … + B₃),
   * f(v) = 0,3 до 5 м/с уперед, 1 від 20, між ними лінійно; гучність = min(1; 0,3·V). Покриття — у drive.
   */
  skidLevel(): number {
    if (!this.king) return 0;
    const lv = this.body.linvel();
    let anyA = false;
    let s = 0;
    let b = 0;
    const a = [0, 0, 0, 0];
    for (let i = 0; i < this.wheels; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      if (this.skid[i]) {
        anyA = true;
        s += 0.3 * Math.min(1, Math.abs(this.skidAlpha[i] ?? 0) / 0.349);
        if (i < 4) a[i] = 1;
      }
      if (this.slip[i] && i < 4) b++;
    }
    if (!((anyA && Math.hypot(lv.x, lv.z) > 0.5) || b > 0)) return 0;
    const v = this.vNow;
    const f = v < 5 ? 0.3 : v > 20 ? 1 : (v - 5) * (0.7 / 15) + 0.3;
    const total = s * (1 + f) + 3 * (0.06 * a[0] * a[1] + 0.3 * a[2] + 0.2 * a[3]) + 0.15 * b;
    return Math.min(1, 0.3 * total);
  }

  /**
   * Пара з-під передніх коліс при різкому гальмуванні (king.exe 0x4ff800 → подія [ph+0x3c18] → 0x548250, біт 0x8000
   * [car+0x27b4] → 0x551970 → 0x4baf90): педаль > 0,5, швидкість уперед > 0,5 м/с, обидва передні колеса на землі —
   * дві точки rs0, rs1 з tech мінус радіус колеса в матриці машини (у ZilR — (±0,6; 1; −0,7): під кузовом, 1 м
   * позаду передньої осі, 0,34 м над дорогою; без них — низ передніх коліс), координати гри. Інакше — порожньо.
   */
  brakeVaporPoints(): THREE.Vector3[] {
    if (!this.king || this.pedalNow <= 0.5 || this.vNow <= 0.5) return [];
    const out: THREE.Vector3[] = [];
    for (const i of [0, 1]) if (!this.ctrl.wheelIsInContact(i)) return [];
    const local = this.def.tech.vaporPoints;
    if (local?.length === 2) {
      this.visual.updateWorldMatrix(true, false);
      for (const q of local) {
        const p = this.visual.localToWorld(g2t(q));
        out.push(new THREE.Vector3(p.x, -p.z, p.y));
      }
      return out;
    }
    for (const i of [0, 1]) {
      const p = this.ctrl.wheelContactPoint(i);
      if (!p) return [];
      out.push(new THREE.Vector3(p.x, -p.z, p.y));
    }
    return out;
  }
  private readonly mass: number;
  private readonly grip: number;
  /** Пошкодження гальм: множник сили (1 — справні). */
  private brakeFactor = 1;
  private readonly tractionControl: boolean;
  private readonly engineBrake: number;
  /** Для світлових плям фар і габаритів (локальна система машини). */
  lightGeometry: LightGeometry = { groundY: -1, frontZ: -4, backZ: 4, width: 2.5 };
  /**
   * Рама тягача позаду кабіни (система тіла, Three.js): верх — висота сідла, від задньої стінки кабіни до заду, сідло
   * (z). Під нею заїжджають під передок напівпричепа (presents.ts); null — не тягач.
   */
  frame: { top: number; front: number; rear: number; halfWidth: number; saddleZ: number } | null = null;
  /**
   * Покриття під колесами: множники зчеплення, опору кочення й межі керма (1 — асфальт) і найбільша швидкість,
   * м/с. Аркада — без впливу.
   */
  private surfaceGrip = 1;
  private surfaceRoll = 1;
  private surfaceSteer = 1;
  private surfaceMaxSpeed = Infinity;
  private readonly surfaceEffects: boolean;
  private readonly rollLift: number | undefined;
  private readonly steerLimit: ((speed: number) => number) | undefined;
  private readonly steerPower: number;
  private readonly brakeProfile: { pedal: (t: number, sharp?: boolean) => number; scale: number } | undefined;
  /** Рух king.exe (null — шини й тертя Rapier, як у першій грі). */
  private readonly king: KingSetup | null;
  /**
   * Напівпричіп у русі king.exe: його маса — у рівнянні тягача (v += F/(M + M_прич)·dt), його колеса — гальмують і
   * котяться разом з тягачем (навантаження — порівну, без частки на сідлі; гіпотеза). Сам причіп іде кінематично
   * за шворнем (Trailer.update). У режимі шин (гравець, towDynamic) — інакше: причіп — вільне тіло зі своїми шинами
   * (Trailer.dynamic), тягне його шарнір Rapier; тягач не рахує ні маси, ні коліс причепа, лише вагу на сідлі
   * (saddleLoad, Н, у точці saddleZ — z сідла в системі тіла тягача) на задніх колесах (tireLoads).
   */
  tow: { mass: number; wheels: number; saddleLoad?: number; saddleZ?: number } | null = null;
  /** Причіп рухається сам (режим шин тягача, не «Аркадний»): тоді Trailer.update отримує towTires. */
  get towDynamic(): boolean {
    return !!this.king?.tires && !this.king.arcade;
  }
  /** Зчеплення шин для причепа в динамічному русі (μ поздовжнє поточного кроку й множник бічного). */
  get towTires(): { mu: number; side: number } | undefined {
    return this.towDynamic ? { mu: this.muNow, side: this.king!.sideGrip ?? 1 } : undefined;
  }
  /** μ коліс останнього кроку руху king.exe (покриття, дощ, шини). */
  private muNow: number = 0.71;
  /** Кінематичний рух king.exe (кермо дає кутову швидкість v·sin δ / L). */
  get kinematic(): boolean {
    return this.king !== null;
  }
  /**
   * Колісна база, м: від передньої осі до найближчої задньої (ZilR — 6,54 м; з нею радіуси повороту збігаються із
   * записом king.exe на всіх швидкостях; до середини задніх, 7,22 м, — повертала ширше; гіпотеза за записом).
   */
  readonly base: number;
  /** Задня вісь бази — z у системі кузова (Three.js), м. */
  private readonly rearAxleZ: number;
  /** Момент інерції навколо вертикалі, кг·м² (YAW_GYRATION2; у колайдера — інший, Rapier ним рахує лише удари). */
  private readonly yawInertia: number;
  /** Бічна швидкість центру мас від повороту навколо задньої осі (ω·d), додана минулого кроку, м/с. */
  private readonly axleSide = new THREE.Vector3();
  /** Удари king — зміна швидкості від зіткнень, без власного кінематичного кроку (hitMeter.ts). */
  readonly hits: HitMeter;
  /**
   * Пробій підвіски: зміна швидкості, яку відбійники дали кузову з останнього забору (м/с, Σ імпульсів / маса) —
   * аналог точкового імпульсу пробою king.exe (d < 0, physics.md): приземлення після трампліна, глибока яма.
   */
  bumpDv = 0;
  /** Стан коліс king: 1 — пробуксовка, −1 — заблоковане. */
  readonly slip: WheelSlip[];
  /**
   * Колесо king ковзає вбік (king.exe [0x19c4+i]): бічна сила шини впирається в μ·N, а |sin α| > 0,26; і кут ковзання
   * α колеса, рад (динамічний режим, tireStep).
   */
  readonly skid: boolean[] = [];
  readonly skidAlpha: number[] = [];
  /** «Різко» (Ctrl) з плавним вмиканням і згасанням 0…1 — межа керма й знос (SHARP_*). */
  private sharpBlend = 0;
  /** Аварійний поворот (SHARP_*): кермо понад звичайною межею 0…1 і зчеплення в ньому 0…1 (1 — тримає повністю). */
  sharpTurn = 0;
  sharpGrip = 1;

  /**
   * Колеса, що лишають слід шин (king.exe 0x502780 → [0x34d0+4i], 0x548250; wheel-effects.md): колесо на землі
   * буксує чи заблоковане, або ковзає вбік з α > 10°. Ширина — товщина колеса з tech (передні 0, 1 — передня, решта
   * — задня); ширша за колесо (i + 2) mod 4 — середнє з ним. Тип — 1 (trace1): обидві гілки king.exe ставлять 2.
   */
  /**
   * Труби вихлопу (king.exe 0x551970 → 0x4bac90): SmokePosition і SmokePosition2 з tech у матриці машини, напрям —
   * повернутий SmokeDirection (довжина 1 → 1 м/с); точки з |z| ≥ 10 (немає труби — (0, 0, 20)) пропускаються. Лише
   * машини з масою tech > 4000 кг, car_node яких не починається з «daf» (0x5427a0, прапорець 2 [car+0x51a4]).
   * Координати гри (x, y, z — угору).
   */
  /**
   * Чи йде дим з вихлопу (біт 0x400 [car+0x27b4] = [car+0x51a0] king.exe; запису поля в коді не знайдено — умова з
   * памʼяті гри, re/notes/ht2/wheel-effects.md §2): газ > 0,5, поки від натискання газу минуло менше 2 с — на
   * звичайному газі це 0,86…2 с розгону, з Ctrl — майже одразу; оберти й передача не важать.
   */
  exhaustOn(): boolean {
    const e = this.engine;
    return this.engineOn && e.gear !== GEAR_N && e.throttle > EXHAUST_GAS && e.gasTime < EXHAUST_TIME;
  }

  exhaustPoints(): { p: THREE.Vector3; v: THREE.Vector3 }[] {
    const t = this.def.tech;
    if (t.mass <= 4000 || /^daf/i.test(this.def.carNode)) return [];
    this.visual.updateWorldMatrix(true, false);
    const q = this.visual.getWorldQuaternion(new THREE.Quaternion());
    const out: { p: THREE.Vector3; v: THREE.Vector3 }[] = [];
    for (const { pos, dir } of t.smoke ?? []) {
      if (Math.abs(pos[2]) >= 10) continue;
      const p = this.visual.localToWorld(g2t(pos));
      const v = g2t(dir).applyQuaternion(q);
      out.push({ p: new THREE.Vector3(p.x, -p.z, p.y), v: new THREE.Vector3(v.x, -v.z, v.y) });
    }
    return out;
  }

  traceWheels(): { i: number; p: THREE.Vector3; n: THREE.Vector3; w: number; type: number }[] {
    const out: { i: number; p: THREE.Vector3; n: THREE.Vector3; w: number; type: number }[] = [];
    if (!this.king) return out;
    const [front, rear] = this.def.tech.wheelThickness ?? [0.2, 0.4];
    const raw = (i: number) => (i < 2 ? front : rear);
    for (let i = 0; i < this.wheels; i++) {
      if (!this.slip[i] && !(this.skid[i] && (this.skidAlpha[i] ?? 0) > TRACE_ALPHA)) continue;
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const p = this.ctrl.wheelContactPoint(i);
      const n = this.ctrl.wheelContactNormal(i);
      if (!p || !n) continue;
      let w = raw(i);
      const other = raw((i + 2) % 4);
      if (other < w) w = (w + other) / 2;
      out.push({ i, p: new THREE.Vector3(p.x, p.y, p.z), n: new THREE.Vector3(n.x, n.y, n.z), w, type: 1 });
    }
    return out;
  }
  /**
   * Межа керма за зчепленням для поточної швидкості (рух king.exe; king.exe 0x500850 обмежує нею саме кермо s):
   * min(1; 1,5·atan(μ·k·L/v²)); без руху king — 1.
   */
  steerLimitNow(): number {
    const K = this.king;
    if (!K) return 1;
    const mu = K.mu * this.grip * this.surfaceGrip * (this.weatherGrip < 1 ? K.rain : 1);
    const r = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const lv = this.body.linvel();
    return steerLimit(lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z, mu, this.base, K.steerK * (K.arcade && K.tires ? ARCADE.steerK : 1));
  }

  /** Тестовий режим: дощ (у кар'єрі він уже в setup.grip). */
  weatherGrip = 1;
  /** Нерівність покриття під колесами (king: roadBump) — асфальт чи ґрунт. */
  roughness: Roughness = ROUGH_ASPHALT;

  setSurface(grip: number, roll: number, steer = 1, maxSpeed = Infinity): void {
    if (!this.surfaceEffects) return;
    this.surfaceGrip = grip;
    this.surfaceRoll = roll;
    this.surfaceSteer = steer;
    // Без межі покриття може прийти null (не лише Infinity) — інакше «перевищення» було б завжди.
    this.surfaceMaxSpeed = maxSpeed ?? Infinity;
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
    this.king = setup.king ?? null;
    this.tractionControl = setup.tractionControl ?? false;
    this.engineBrake = setup.engineBrake ?? 0;
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
    }, setup.engine);

    // Модель у системі гри → обгортка, що повертає її у систему Three.js.
    const gameFrame = new THREE.Group();
    gameFrame.rotation.x = -Math.PI / 2;
    gameFrame.add(model.root);
    this.visual.add(gameFrame);
    this.wheelVisual = model.wheels.map((obj, i) => ({ obj, base: model.wheelBase[i] }));
    this.slip = model.wheels.map(() => 0);
    for (let i = 0; i < model.wheels.length; i++) this.bumps.push({ h: 0, u: 0 });
    // Колісна база: z передніх (0, 1) і найближчої до них задньої осі.
    const wz = model.wheelBase.map((m) => g2t(new THREE.Vector3().setFromMatrixPosition(m)).z);
    const front = (wz[0] + wz[1]) / 2;
    // Задні — лише осі по інший бік від середини колісної колії: у Storm дві передні керовані осі (3,10 і 1,15 м),
    // друга — не задня (база 1,95 м замість 5,3 — розворот на місці з радіусом 2,9 м).
    const mid = (Math.max(...wz) + Math.min(...wz)) / 2;
    const rear = wz.slice(2).map((z) => (Math.sign(z - mid) === Math.sign(front - mid) ? Infinity : Math.abs(z - front)));
    this.base = Math.max(1, rear.length ? Math.min(...rear) : 1);
    // Центр повороту (на прохання користувача): від середини задніх осей на 60 % до останньої — остання вісь
    // тандема — крайня точка зчеплення з дорогою (ZilR: поворот навколо передньої задньої осі — задня на 1,36 м
    // позаду ковзала вбік до 1,2 м/с). Темп повороту — від бази, як у king.exe.
    const rearZ = wz.slice(2).filter((_, i) => Number.isFinite(rear[i]));
    const midRear = rearZ.length ? rearZ.reduce((a, b) => a + b, 0) / rearZ.length : front;
    const lastRear = rearZ.reduce((a, z) => (Math.abs(z - front) > Math.abs(a - front) ? z : a), midRear);
    this.rearAxleZ = midRear + PIVOT_TO_LAST * (lastRear - midRear);

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
    // Тінь Дальнобойщиків 2 — не вузол моделі (блоки `<машина>Shadow` у TRUCKS.B3D king.exe не вживає), а квад
    // матеріалу effect_Shadow по точках Corner_Mark_W з tech, спроєктований на дорогу під колесами (0x552940 →
    // 0x4bb270 → 0x57c490). Кладемо його тією самою placeShadow.
    const corners = def.tech.shadowCorners;
    if (!this.shadow && model.shadowMaterial && corners && corners.length >= 4) {
      const pts = corners.slice(0, 4).map(([x, y]) => g2t([x, y, 0]));
      const center = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(4);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pts.flatMap((p) => [p.x - center.x, 0, p.z - center.z]), 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 1, 1], 2));
      geo.setIndex([0, 2, 1, 1, 2, 3]);
      const mesh = new THREE.Mesh(geo, model.shadowMaterial);
      mesh.name = 'effect_Shadow';
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      this.visual.add(mesh);
      this.shadow = { obj: mesh, local: new THREE.Matrix4(), center, mid: center.clone(), parentInv: new THREE.Matrix4() };
    }
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
    this.hits = new HitMeter(this.body, world);
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
    // Тягач: позаду кабіни — лише рама до висоти сідла (lowSaddle), щоб сідлом можна було заїхати під передок
    // напівпричепа (presents.ts). Коробка на всю висоту стояла б стіною під рамою причепа. Кабіна — до її задньої
    // стінки (найзадніша видима точка на 0,6 м вище сідла).
    const hull = { half: new THREE.Vector3(size.x / 2, (size.y / 2) * 0.8, size.z / 2), at: colliderAt.clone() };
    if (tech.saddle) {
      const saddle = g2t(tech.saddle);
      const saddleY = saddle.y;
      const cabBack = rearAbove(model.body, saddleY + 0.6);
      if (cabBack > box.min.z + 1 && cabBack < box.max.z - 0.5) {
        hull.half.z = (cabBack - box.min.z) / 2;
        hull.at.z = (cabBack + box.min.z) / 2;
        const bottom = Math.min(colliderAt.y - hull.half.y, saddleY - FRAME_DEPTH);
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(size.x / 2, (saddleY - bottom) / 2, (box.max.z - cabBack) / 2)
            .setTranslation(colliderAt.x, (saddleY + bottom) / 2, (box.max.z + cabBack) / 2)
            .setDensity(0)
            .setFriction(0.3)
            .setRestitution(0.1),
          this.body,
        );
        this.frame = { top: saddleY, front: cabBack, rear: box.max.z, halfWidth: size.x / 2, saddleZ: saddle.z };
      }
    }
    const com = new THREE.Vector3(cx, cy, -cz)
      .multiplyScalar(mass - cargo)
      .addScaledVector(cargoAt, cargo)
      .divideScalar(mass)
      .sub(hull.at);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(hull.half.x, hull.half.y, hull.half.z)
        .setTranslation(hull.at.x, hull.at.y, hull.at.z)
        .setMassProperties(mass, { x: com.x, y: com.y, z: com.z }, {
          x: mass * (size.y ** 2 + size.z ** 2) / 12,
          y: mass * (size.x ** 2 + size.z ** 2) / 12,
          z: mass * (size.x ** 2 + size.y ** 2) / 12,
        }, { w: 1, x: 0, y: 0, z: 0 })
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );
    this.yawInertia = mass * YAW_GYRATION2;

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
      this.suspMax[i] = mass * 40;
      this.ctrl.setWheelFrictionSlip(i, TIRE_GRIP * this.grip);
      // Бічні сили шин рахуємо самі (applyTireLateral) — у Rapier вимикаємо.
      this.ctrl.setWheelSideFrictionStiffness(i, 0);
      // Шина перекинутої машини (TIP_ON): опора на зовнішнє колесо, а не на ребро кузова-колайдера (він високо над
      // дорогою — машина на ньому поверталась на колеса, як ванька-встанька). Без маси; на колесах — вимкнена.
      const tire = world.createCollider(RAPIER.ColliderDesc.ball(this.wheelRadius).setTranslation(c.x, c.y - this.suspAnchor, c.z).setDensity(0).setFriction(0.8).setRestitution(0.05), this.body);
      tire.setEnabled(false);
      this.tires.push(tire);
    }
    this.balanceSprings();

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


  /** Стан тіла до останнього кроку фізики — модель між кроками інтерполюється (syncVisual(alpha)). */
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrev = false;

  /** Запамʼятати стан перед кроком фізики. */
  private savePrev(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
    this.hasPrev = true;
  }

  /**
   * Модель — між станом до й після останнього кроку (alpha = залишок накопичувача / крок): фізика йде кроками 1/60 с,
   * і при 120 Гц чи нерівних кадрах без цього машина відносно плавної камери смикалась. Стрибок понад 5 м
   * (телепорт, відновлення) — без згладжування.
   */
  private placeVisual(alpha: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.position.set(t.x, t.y, t.z);
    this.visual.quaternion.set(r.x, r.y, r.z, r.w);
    if (alpha < 1 && this.hasPrev && this.prevPos.distanceTo(this.visual.position) < 5) {
      this.visual.position.lerpVectors(this.prevPos, this.visual.position, alpha);
      this.visual.quaternion.slerpQuaternions(this.prevQuat, SLERP_TMP.copy(this.visual.quaternion), alpha);
    }
    this.bodyQuat.copy(this.visual.quaternion);
    // Нахил кузова king (косметичний): верх кузова хилиться праворуч на leanSide і вперед на leanFwd.
    if (!this.king) return;
    const q = this.visual.quaternion;
    this.visual.position.addScaledVector(new THREE.Vector3(0, 1, 0).applyQuaternion(q), this.bumpLift);
    // У системі моделі: поворот навколо осі «угору × нахил».
    const tilt = new THREE.Vector3(this.leanSide * this.rollScale, 0, -this.leanFwd);
    const angle = tilt.length();
    const rot = angle > 1e-5 ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0).cross(tilt).normalize(), angle) : null;
    if (rot) q.multiply(rot);
    // Колеса лишаються на дорозі (з нерівністю під кожним), кузов ходить відносно них — видно роботу підвіски:
    // зсув колеса = нерівність − наскільки кузов піднявся в точці кріплення.
    for (let i = 0; i < this.wheels; i++) {
      const p = g2t(new THREE.Vector3().setFromMatrixPosition(this.wheelVisual[i].base));
      const lift = this.bumpLift + (rot ? p.clone().applyQuaternion(rot).y - p.y : 0);
      this.wheelLift[i] = (this.bumps[i]?.h ?? 0) - lift;
    }
  }

  /** Зсув колеса king угору відносно кузова, м (placeVisual). */
  private readonly wheelLift: number[] = [];

  /** Крок фізики керування (до world.step). */
  update(dt: number, input: ControlState): void {
    this.savePrev();
    this.updateTip();
    const tech = this.def.tech;
    // Швидкість уздовж напрямку «уперед» (−Z локально), м/с; + уперед.
    const lv = this.body.linvel();
    const q = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speedKmh = Math.abs(v) * 3.6;
    this.vNow = v;

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
    const brakePedal = brake > 0 ? brake * (bp ? bp.pedal(this.brakeTime, !!input.sharp) : this.brakeTime / (this.brakeTime + 1)) : 0;
    this.pedalNow = brakePedal;
    this.handbrakeNow = !!input.handbrake;
    if (this.king) {
      this.hits.begin(dt);
      this.updateKing(dt, input.steer, brakePedal, !!input.handbrake, !!input.sharp);
      this.hits.end();
      return;
    }

    // Сила двигуна — порівну на ведучі колеса (у Rapier відʼємна сила — уперед).
    // Гальма: сила колеса = педаль × B (передні 0,49·breakpower, задні 0,35·breakpower — ЗіЛ, s6);
    // опір кочення ≈ 0,015·N (накат s7). Rapier бере гальмо як імпульс за крок — множимо на dt.
    const nDriven = this.driven.filter(Boolean).length || 2;
    // М'яке покриття: понад його межу швидкості — додатковий опір (на колесо), плавно наростає з перевищенням.
    const over = Math.abs(v) - this.surfaceMaxSpeed;
    const soft = over > 0 ? ((this.mass * SOFT_DRAG) / this.wheels) * Math.min(1, over / SOFT_DRAG_SPAN) : 0;
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
      const rolling = ROLLING_RESISTANCE * this.surfaceRoll * wheelLoad + soft;
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
    this.ctrl.updateVehicle(dt, undefined, undefined, this.groundRays);
    this.updateGroundUp();
    if (this.tipped) return;
    this.applyBumpStops(dt);
    this.applyTireLateral(dt);
  }

  /**
   * Крок руху за king.exe (kingModel.ts). Rapier лишається для підвіски (тримає кузов над дорогою й нахиляє його за
   * нерівностями — в оригіналі кузов вирівнюється за площиною контактів), ударів і польоту; тертя шин Rapier вимкнене.
   * Уздовж ґрунту швидкість задаємо самі: v += (½·g_дот + ΣF/M)·dt, потім — уздовж курсу; поворот — кутова швидкість
   * v·sin δ / L навколо нормалі ґрунту. Усі колеса в повітрі — рух лише Rapier (балістика).
   */
  private updateKing(dt: number, steer: number, pedal: number, handbrake: boolean, sharp = false): void {
    const K = this.king!;
    const ctrl = this.ctrl;
    for (let i = 0; i < this.wheels; i++) {
      ctrl.setWheelEngineForce(i, 0);
      ctrl.setWheelBrake(i, 0);
      ctrl.setWheelFrictionSlip(i, 0);
    }
    const mu = K.mu * this.grip * this.surfaceGrip * (this.weatherGrip < 1 ? K.rain : 1);
    this.muNow = mu;
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const lv0 = this.body.linvel();
    // Кермо: δ = 45°·s, |s| — не більше межі зчеплення на цій швидкості; «різко» (Ctrl) — без межі, до упору
    // (king.exe 0x500850: межу c при «різко» не застосовує — Input.steerExe). Межа знімається й вертається плавно
    // (sharpBlend): кермо в кабіні не перескакує на упор і назад.
    const vAlong = lv0.x * fwd.x + lv0.y * fwd.y + lv0.z * fwd.z;
    this.sharpBlend = sharp ? Math.min(1, this.sharpBlend + SHARP_BLEND_ON * dt) : Math.max(0, this.sharpBlend - SHARP_BLEND_OFF * dt);
    const normLim = steerLimit(vAlong, mu, this.base, K.steerK * (K.arcade && K.tires ? ARCADE.steerK : 1));
    const lim = normLim + (1 - normLim) * this.sharpBlend;
    const shaped = Math.sign(steer) * K.steerScale * Math.abs(steer) ** K.steerPower;
    // Аварійний поворот (SHARP_*): наскільки кермо понад звичайною межею; зчеплення — за швидкістю.
    const pastLim = normLim < 1 ? Math.max(0, Math.min(1, (Math.min(Math.abs(shaped), lim) - normLim) / (1 - normLim))) : 0;
    const x = Math.max(0, Math.min(1, (Math.abs(vAlong) * 3.6 - SHARP_GRIP_KMH) / (SHARP_SLIDE_KMH - SHARP_GRIP_KMH)));
    this.sharpTurn = K.tires ? pastLim * this.sharpBlend : 0;
    this.sharpGrip = 1 - (1 - SHARP_SLIDE_GRIP) * x * x * (3 - 2 * x);
    const delta = KING.steerMax * Math.max(-lim, Math.min(lim, shaped));
    // Колеса на моделі: + — ліворуч; внутрішнє повертається більше (Аккерман — лише вигляд).
    this.steerAngle = -delta;
    const inner = Math.abs(delta);
    const outer = inner > 1e-4 ? Math.atan(1 / (1 / Math.tan(inner) + this.track / this.base)) : 0;
    const left = this.steerAngle > 0;
    ctrl.setWheelSteering(0, Math.sign(this.steerAngle) * (left ? inner : outer));
    ctrl.setWheelSteering(1, Math.sign(this.steerAngle) * (left ? outer : inner));
    ctrl.updateVehicle(dt, undefined, undefined, this.groundRays);
    this.updateGroundUp();
    if (this.tipped) {
      // Перекинута: колеса не тримають і не везуть — кузов падає (рух лише Rapier).
      this.axleSide.set(0, 0, 0);
      this.slip.fill(0);
      this.skid.fill(false);
      return;
    }
    this.applyBumpStops(dt);
    // Швидкість — уже з імпульсами підвіски (їх не затирати: інакше кузов провалюється крізь дорогу).
    const lv = this.body.linvel();
    // Далі — швидкість задньої осі: бічну ω·d, додану минулого кроку (нижче), віднімаємо вектором. Інакше за крок
    // кузов повертався, і ця бічна складова проєктувалась на новий курс як розгін — на повному кермі (Ctrl) машина
    // сама розганялась до 100+ км/год.
    const v = new THREE.Vector3(lv.x, lv.y, lv.z).sub(this.axleSide);
    this.axleSide.set(0, 0, 0);

    // Контакти: нормаль ґрунту — середня нормаль коліс на землі; навантаження N_i = M·g/n·|n_i,y| (рівний розподіл).
    const n = new THREE.Vector3();
    const wheels: KingWheel[] = [];
    const M = this.mass;
    const share = (M * KING.g) / this.wheels;
    const statics = this.staticLoads();
    let onGround = 0;
    for (let i = 0; i < this.wheels; i++) {
      const nr = ctrl.wheelIsInContact(i) ? ctrl.wheelContactNormal(i) : null;
      if (nr) {
        n.add(nr as THREE.Vector3Like);
        onGround++;
      }
      wheels.push({ ground: !!nr, driven: this.driven[i], load: nr ? share * Math.abs(nr.y) : 0, mu, brake: KING.brakeLoad * statics[i] * this.brakeFactor });
    }
    if (!onGround || n.lengthSq() < 1e-6) {
      this.slip.fill(0);
      this.skid.fill(false);
      return;
    }
    // Колеса причепа (вважаємо на землі, без приводу); у режимі шин причіп рахує себе сам (Trailer.dynamic).
    const tow = this.tow && !this.towDynamic ? this.tow : null;
    if (tow)
      for (let i = 0; i < tow.wheels; i++) {
        const load = (tow.mass * KING.g) / tow.wheels;
        wheels.push({ ground: true, driven: false, load, mu, brake: KING.brakeLoad * load * this.brakeFactor });
      }
    const mass = M + (tow?.mass ?? 0);
    n.normalize();
    const all = onGround === this.wheels;
    const ft = fwd.clone().addScaledVector(n, -fwd.dot(n));
    if (ft.lengthSq() < 1e-6) return;
    ft.normalize();
    const vn = v.dot(n);
    const vt = v.clone().addScaledVector(n, -vn);
    const vFwd = vt.dot(ft);
    if (K.tires) {
      this.tireLoads(dt, wheels, n, ft);
      // Регулятор гальмівних сил (порт, на прохання користувача; у king.exe B_i = 1,5·N_ст): гальмо колеса — від його
      // поточного навантаження, тож усі колеса блокуються разом (педаль > μ/1,5) і машину несе юзом прямо. Зі
      // статичним гальмом розвантажений гальмуванням задок блокувався першим уже на педалі ≈ 0,26 — розвертало.
      for (let i = 0; i < this.wheels; i++) if (wheels[i].ground) wheels[i].brake = KING.brakeLoad * wheels[i].load * this.brakeFactor;
    }

    // Поздовжні сили: двигун і гальма; ручне — задні колеса на повну; кочення; мʼяке покриття понад його швидкість.
    // Без газу двигун лише гальмує (0x4aa320) — проти руху й до зупинки, з наростанням від нуля, як кочення: інакше
    // гальмування холостими обертами на передачі штовхало вантажівку з місця назад.
    const engineBraking = this.engine.throttle === 0;
    let drive = engineBraking ? 0 : this.engine.force;
    // Антибукс (0x4ff660): газ ≤ 0,81 межі зчеплення ведучих. Газ із клавіші king.exe обмежує завжди (0x4ff800: гілка
    // [0x2714] = 1 іде на 0x4ffc5d), без покращення; покращення ABS ([0x2754]) потрібне лише аналоговому газу — тут
    // машинам без режиму шин (трафік). Ctrl («різко», [0x2714] = 2) обмеження оминає — колеса можна зірвати.
    // Задній хід — так само (0x4ff660 має окрему гілку для задньої передачі [0x1c1c] = 0): раніше обрізалась лише
    // тяга вперед, і Scania задом буксувала.
    if ((this.tractionControl || K.tires) && drive !== 0 && !sharp) {
      let grip = 0;
      for (const w of wheels) if (w.ground && w.driven) grip += w.mu * w.load;
      drive = Math.sign(drive) * Math.min(Math.abs(drive), 0.81 * grip);
    }
    // Сили коліс окремо — для моменту рискання від нерівної тяги й гальм (режим шин).
    const perWheel: number[] = [];
    let force = wheelForces(wheels, drive, pedal, vFwd, this.slip, perWheel);
    if (handbrake && pedal <= KING.brakeFrom) force += wheelForces(wheels.map((w, i) => (i >= 2 ? w : { ...w, ground: false })), 0, 1, vFwd, undefined, perWheel);
    let resist = engineBraking ? Math.abs(this.engine.force) * Math.min(1, Math.abs(vFwd)) * (1 + this.engineBrake * Math.sqrt(pedal)) : 0;
    // Аварійний поворот гасить швидкість (шини труться об дорогу), газ тягне лише частку.
    if (this.sharpTurn > 0) {
      resist += mass * mu * KING.g * SHARP_SCRUB * this.sharpTurn * Math.min(1, Math.abs(vFwd));
      if (drive > 0) {
        const cut = drive * (1 - SHARP_GAS) * this.sharpTurn;
        force -= cut;
        perWheel.forEach((f, i) => (perWheel[i] = f * (1 - (1 - SHARP_GAS) * this.sharpTurn)));
      }
    }
    for (const w of wheels) if (w.ground) resist += rollingForce(w.load, vFwd) * this.surfaceRoll;
    const over = Math.abs(vFwd) - this.surfaceMaxSpeed;
    if (over > 0) resist += mass * SOFT_DRAG * Math.min(1, over / SOFT_DRAG_SPAN);
    force -= Math.sign(vFwd) * resist;

    // Вага: дотична складова; усі колеса на землі — половина.
    const gravity = this.world.gravity;
    const g = new THREE.Vector3(gravity.x, gravity.y, gravity.z);
    const gt = g.clone().addScaledVector(n, -g.dot(n));
    const gEff = gt.clone().multiplyScalar(all ? KING.slope : 1);
    const next = vt.clone().addScaledVector(ft, (force / mass) * dt).addScaledVector(gEff, dt);
    // Майже стоїть, а гальмо (чи ручне) втримує проти двигуна й схилу — стоїть.
    const brakes = wheels.reduce((sum, w) => sum + (w.ground ? Math.min(w.brake, w.mu * w.load) : 0), 0);
    const hold = (handbrake ? 1 : pedal > KING.brakeFrom ? pedal : 0) * brakes;
    const push = Math.abs(drive + mass * gEff.dot(ft));
    const along = next.dot(ft);
    if (hold > 0 && Math.abs(vFwd) < 0.5 && push <= hold) next.set(0, 0, 0);
    // Опір і гальма зупиняють, але не розганяють назад.
    else if (vFwd !== 0 && Math.sign(along) !== Math.sign(vFwd) && Math.sign(force) === -Math.sign(vFwd) && Math.abs(drive) < resist + hold) next.addScaledVector(ft, -along);
    // Динамічний режим (машина гравця): бічні сили шин і курс з їхнього моменту.
    let tireOmega: number | null = null;
    if (K.tires) {
      const av0 = this.body.angvel();
      tireOmega = this.tireStep(dt, next, n, ft, delta, wheels, Math.abs(vFwd), av0.x * n.x + av0.y * n.y + av0.z * n.z, perWheel);
      if (this.sharpTurn > 0) tireOmega = this.sharpAssist(dt, next, n, ft, delta, tireOmega, mu);
      else if (K.arcade && !sharp && this.sharpBlend === 0) tireOmega = this.arcadeAssist(dt, next, n, ft, delta, tireOmega, mu * (K.sideGrip ?? 1));
      // Прискорення від сил коліс (без ваги) — для перенесення навантаження наступного кроку.
      this.tireAcc.addScaledVector(ft, force / mass);
    }
    // Рівний ґрунт і всі колеса на землі — швидкість уздовж курсу (бічного ковзання немає).
    else if (all && n.y >= KING.flat) {
      // Довжина вектора — як в оригіналі, але лише коли бічна складова мала (поворот за крок): після удару збоку
      // (в оригіналі тоді вмикається «динамічний» режим) поштовх не має ставати розгоном уперед.
      const along2 = next.dot(ft);
      const side = Math.sqrt(Math.max(0, next.lengthSq() - along2 * along2));
      const speed = side < 0.5 ? next.length() * (Math.sign(along2) || 0) : along2;
      next.copy(ft).multiplyScalar(speed);
      // Поворот навколо задньої осі (порт, на прохання користувача): уздовж курсу рухається задня вісь, а центр мас
      // попереду неї — ще й убік на ω·d. Інакше машина крутилася навколо центру мас і задні колеса виносило назовні.
      if (wheels[0].ground || wheels[1].ground) {
        const d = this.rearAxleZ - this.body.localCom().z;
        this.axleSide.crossVectors(n, ft).multiplyScalar(-yawRate(speed, delta, this.base) * d);
      }
    } else {
      // Не всі колеса на землі чи схил (порт; у king.exe тут «динамічний» режим, не розібрано): бічне ковзання задньої
      // осі гасить тертя коліс, що на землі, — не більше μ·g·(частка коліс на землі) за секунду; центр мас — на тій самій
      // дузі навколо задньої осі. Без цього після підскоку (бордюр, клумба) машину несло боком, доки всі колеса не стануть.
      const left = new THREE.Vector3().crossVectors(n, ft);
      const excess = next.dot(left);
      const maxDv = mu * KING.g * (onGround / this.wheels) * dt;
      next.addScaledVector(left, -Math.sign(excess) * Math.min(Math.abs(excess), maxDv));
      if (wheels[0].ground || wheels[1].ground) this.axleSide.copy(left).multiplyScalar(-yawRate(vFwd, delta, this.base) * (this.rearAxleZ - this.body.localCom().z));
    }
    next.add(this.axleSide);
    // Rapier за крок додасть усю вагу — її дотичну частину віднімаємо наперед; уздовж нормалі — як є (підвіска).
    next.addScaledVector(gt, -dt).addScaledVector(n, vn);
    this.body.setLinvel(next, true);
    // Поворот: кутова швидкість навколо нормалі — кінематична (обидва передні колеса в повітрі — 0); крен і
    // тангаж від підвіски лишаються.
    const omega = tireOmega ?? (wheels[0].ground || wheels[1].ground ? -yawRate(vFwd, delta, this.base) : 0);
    this.slip.length = this.wheels;
    const av = this.body.angvel();
    const w = new THREE.Vector3(av.x, av.y, av.z);
    w.addScaledVector(n, omega - w.dot(n));
    this.body.setAngvel(w, true);
    for (let i = 0; i < this.wheels; i++) if (wheels[i].ground) roadBump(this.bumps[i], dt, vFwd, this.king!.travel?.[i] ?? 0.3, Math.random(), this.roughness);
    this.lean(dt, n, ft, gt, vFwd * omega, force / mass);
  }

  /**
   * Бічні сили шин динамічного режиму king.exe (режим 3 — машина гравця, telemetry.md 2026-10-18; 0x4f4f60, 0x4f4110):
   * кожне колесо на землі тисне поперек себе (передні повернуті на δ) проти бічної швидкості точки контакту з силою μ·N·φ(α, v) (kingModel.tireCurve, v — швидкість машини; на швидкості колеса < 1 м/с — ще
   * ×швидкість, як в exe). Сили всіх коліс — одночасно, з одного стану; сума й момент навколо нормалі змінюють
   * швидкість ЦМ і кутову швидкість. Змінює next (швидкість ЦМ), повертає кутову швидкість навколо n. Повне кермо на
   * швидкості — передні колеса зриваються (α ≈ 0,6–0,7 рад у записі), недоповорот.
   */
  private tireStep(dt: number, next: THREE.Vector3, n: THREE.Vector3, ft: THREE.Vector3, delta: number, wheels: readonly KingWheel[], speed: number, omega0: number, along: readonly number[]): number {
    const c = this.body.worldCom();
    const com = new THREE.Vector3(c.x, c.y, c.z);
    const side = new THREE.Vector3().crossVectors(n, ft);
    // δ > 0 — праворуч (колеса моделі: + — ліворуч, steerAngle = −δ).
    const fFront = ft.clone().multiplyScalar(Math.cos(delta)).addScaledVector(side, -Math.sin(delta));
    const sideMu = this.king!.sideGrip ?? 1;
    const M = this.mass;
    const I = this.yawInertia;
    const on: number[] = [];
    for (let i = 0; i < this.wheels; i++) if (wheels[i].ground && this.ctrl.wheelContactPoint(i)) on.push(i);
    this.skid.fill(false);
    let w = omega0;
    const dv = new THREE.Vector3();
    let dw = 0;
    for (const i of on) {
      const p = this.ctrl.wheelContactPoint(i)!;
      const r = new THREE.Vector3(p.x, p.y, p.z).sub(com);
      r.addScaledVector(n, -r.dot(n));
      // Поперечне плече — колія king.exe (KING_TRACK; точки контакту Rapier — з моделі, вужчі).
      const q = Math.sign(r.dot(side) || (i % 2 ? -1 : 1)) * (i < 2 ? KING_TRACK.front : KING_TRACK.rear) / 2;
      const s = r.dot(ft);
      r.copy(ft).multiplyScalar(s).addScaledVector(side, q);
      // Тяга й гальмо колеса (wheelForces; їхня сума вже в швидкості) збоку від ЦМ крутять кузов: у повороті з газом
      // тяга — переважно на завантажених зовнішніх ведучих колесах (king.exe ділить її за μ·N), що докручує машину.
      dw -= (q * (along[i] ?? 0) * dt) / I;
      // Сила — поперек колеса (передні повернуті на δ): її складова вздовж кузова гальмує на повному кермі — у записі
      // з повним газом опір повороту ≈ 1,7 м/с² на 51 км/год і ≈ 2,5 на 70 (поперек кузова опору не було б).
      const f = i < 2 ? fFront : ft;
      const d = new THREE.Vector3().crossVectors(n, f);
      const u = next.clone().add(new THREE.Vector3().crossVectors(n, r).multiplyScalar(w));
      const lat = u.dot(d);
      const lon = u.dot(f);
      const alpha = Math.atan2(Math.abs(lat), Math.abs(lon));
      // Колесо, що буксує (+1) чи заблоковане (−1), вбік не тримає (king.exe: у дампі такі колеса мають нульову
      // силу ковзання) — газ з Ctrl зриває задні ведучі, і задок заносить; гальмо блокує розвантажені колеса.
      // Заблоковане ж колесо (порт, на прохання користувача) ковзає юзом: тертя μ·N — проти всієї швидкості контакту,
      // тож поперек — μ·N·sin α (уздовж гальмує wheelForces). Без цього розвантажений гальмуванням задок тягача
      // блокувався й не тримав зовсім — машину розвертало на 70–80° до зупинки.
      const m = wheels[i].mu * sideMu * wheels[i].load;
      const size = this.slip[i] === -1 ? m * Math.abs(Math.sin(alpha)) : this.slip[i] ? 0 : m * tireCurve(alpha, speed) * Math.min(1, Math.hypot(lat, lon));
      // Сухе тертя (як 0x4f4110): імпульс колеса не більший, ніж гасить бічну швидкість його контакту, — з поділом на
      // число коліс (діють одночасно), щоб разом не перекинути знак.
      const arm = new THREE.Vector3().crossVectors(r, d).dot(n);
      const gain = 1 / M + (arm * arm) / I;
      // Сила впирається в межу — колесо ковзає вбік (для сліду шин).
      this.skid[i] = size * dt < Math.abs(lat) / (gain * on.length) && Math.abs(Math.sin(alpha)) > SKID_SIN;
      this.skidAlpha[i] = alpha;
      const j = -Math.sign(lat) * Math.min(size * dt, Math.abs(lat) / (gain * on.length));
      dv.addScaledVector(d, j / M);
      dw += (arm * j) / I;
    }
    next.add(dv);
    this.tireAcc.copy(dv).divideScalar(dt);
    w += dw;
    return w;
  }

  /**
   * Аварійний поворот з Ctrl (SHARP_*): курс тягнеться до кінематичного v·sin δ / L, але не крутіше, ніж дозволяє бічне
   * прискорення A = SHARP_LAT·μ·g·зчеплення; бічна швидкість гаситься тим самим A — машина йде за курсом. На великій
   * швидкості зчеплення мале — несе вперед, лише трохи в бік повороту. Змінює next, повертає кутову швидкість.
   */
  private sharpAssist(dt: number, next: THREE.Vector3, n: THREE.Vector3, ft: THREE.Vector3, delta: number, omega: number, mu: number): number {
    const k = this.sharpTurn;
    const A = SHARP_LAT * mu * KING.g * this.sharpGrip;
    const vLon = next.dot(ft);
    const speed = Math.max(1, Math.abs(vLon));
    const want = THREE.MathUtils.clamp(-yawRate(vLon, delta, this.base), -A / speed, A / speed);
    // Лише докручувати в бік керма: шини, що вже повертають сильніше, не стримуємо.
    if (Math.abs(want) > Math.abs(omega) || Math.sign(want) !== Math.sign(omega)) omega += (want - omega) * Math.min(1, k * SHARP_YAW * dt);
    const side = new THREE.Vector3().crossVectors(n, ft);
    const lat = next.dot(side);
    next.addScaledVector(side, -Math.sign(lat) * Math.min(Math.abs(lat), A * k * dt));
    return omega;
  }

  /**
   * Допомога керуванню «Аркадний» (ARCADE): курс — до кінематичного v·sin δ / L у межах бічного прискорення
   * A = ARCADE.lat·μ·g (в обидва боки: і докручує, і не дає зірватися в обертання), бічна швидкість центру мас понад
   * кінематичну ω·d (d — від задньої осі) гаситься до ARCADE.slip·A. Змінює next, повертає кутову швидкість.
   */
  private arcadeAssist(dt: number, next: THREE.Vector3, n: THREE.Vector3, ft: THREE.Vector3, delta: number, omega: number, mu: number): number {
    const A = ARCADE.lat * mu * KING.g;
    const vLon = next.dot(ft);
    const speed = Math.max(1, Math.abs(vLon));
    const want = THREE.MathUtils.clamp(-yawRate(vLon, delta, this.base), -A / speed, A / speed);
    omega += (want - omega) * Math.min(1, ARCADE.yaw * dt);
    const side = new THREE.Vector3().crossVectors(n, ft);
    const extra = next.dot(side) - omega * (this.rearAxleZ - this.body.localCom().z);
    next.addScaledVector(side, -Math.sign(extra) * Math.min(Math.abs(extra), ARCADE.slip * A * dt));
    return omega;
  }

  /** Прискорення від сил коліс минулого кроку (світ, м/с²) і стан кузова на пружинах (tireLoads). */
  private readonly tireAcc = new THREE.Vector3();
  private readonly spring = { z: 0, vz: 0, roll: 0, vroll: 0, pitch: 0, vpitch: 0 };

  /**
   * Навантаження коліс динамічного режиму (машина гравця) — кузов на пружинах king.exe (0x4f8260): підскок, крен і
   * тангаж кузова відносно коліс. Пружина колеса F = k·e·(1 + e/L₀)·(1 − exp(−((d − T)/(0,1·T))²)), e = L₀ − d,
   * d — довжина ходу; k = N_ст/((x/L₀ + 1)·x), x = L₀ − 0,75·T (статичний стиск однаковий); демпфер — від швидкості
   * стиску v: стиск — c·v/0,8, не більше 0,95·F; розтяг — −0,5·c·|v| (|v| ≤ 0,5) або −c·v², не більше F; c = N_ст.
   * Сили шин на рівні дороги (KING_COM_HEIGHT нижче ЦМ) кренять і хитають кузов; нерівність дороги (roadBump) —
   * під колесом. Сума N — не обовʼязково вага: кузов підстрибує (у записі — 28…69 кН при 65 кН).
   */
  /**
   * Статичне навантаження кожного колеса, Н (king.exe 0x4ef480 → [0x2650]): вага ділиться між осями за плечима від
   * центру мас (передня — l_r/L, задні — l_f/L), усередині осі — порівну. Від нього — сила гальма колеса
   * B_i = 1,5·N_ст (0x4ee540): у тягача без причепа задок легкий, і рівний поділ гальм блокував задні колеса вже на
   * малій педалі — машину розвертало. Геометрія невдала — рівний поділ.
   */
  private staticLoads(): number[] {
    const Mg = this.mass * KING.g;
    const equal = new Array<number>(this.wheels).fill(Mg / this.wheels);
    const com = this.body.localCom().z;
    let f = 0;
    let r = 0;
    const nf = Math.min(2, this.wheels);
    const nr = this.wheels - nf;
    for (let i = 0; i < this.wheels; i++) {
      const z = this.ctrl.wheelChassisConnectionPointCs(i)?.z;
      if (z === undefined) return equal;
      // Уперед — −z: плече передньої осі com − z, задніх z − com.
      if (i < nf) f += com - z;
      else r += z - com;
    }
    const lf = f / nf;
    const lr = nr ? r / nr : 0;
    if (!(lf > 0.3 && lr > 0.3)) return equal;
    return equal.map((_, i) => (i < nf ? (Mg * lr) / (lf + lr) / nf : (Mg * lf) / (lf + lr) / nr));
  }

  private tireLoads(dt: number, wheels: KingWheel[], n: THREE.Vector3, ft: THREE.Vector3): void {
    const c = this.body.worldCom();
    const com = new THREE.Vector3(c.x, c.y, c.z);
    const side = new THREE.Vector3().crossVectors(n, ft);
    const pts: { i: number; s: number; q: number }[] = [];
    for (let i = 0; i < this.wheels; i++) {
      const p = wheels[i].ground ? this.ctrl.wheelContactPoint(i) : null;
      if (!p) continue;
      const r = new THREE.Vector3(p.x, p.y, p.z).sub(com);
      // Поперечне плече — з колії king.exe (KING_TRACK), знак — бік колеса.
      const q = Math.sign(r.dot(side) || (i % 2 ? -1 : 1)) * (i < 2 ? KING_TRACK.front : KING_TRACK.rear) / 2;
      pts.push({ i, s: r.dot(ft), q });
    }
    const front = pts.filter((t) => t.i < 2);
    const rear = pts.filter((t) => t.i >= 2);
    if (!front.length || !rear.length) return;
    const lf = front.reduce((a, t) => a + t.s, 0) / front.length;
    const lr = -rear.reduce((a, t) => a + t.s, 0) / rear.length;
    const L = lf + lr;
    if (!(lf > 0.3 && lr > 0.3)) return;
    const M = this.mass;
    const gn = Math.max(0, -(this.world.gravity.x * n.x + this.world.gravity.y * n.y + this.world.gravity.z * n.z));
    const Mg = M * gn;
    // Вага напівпричепа на сідлі (режим шин: причіп — окреме тіло): униз у точці сідла, на d позаду центру мас.
    // (Кінематичний причіп — «Аркадний» — свою вагу несе колесами в рівнянні тягача, тут її немає.)
    const Fk = this.towDynamic ? (this.tow?.saddleLoad ?? 0) * (gn / KING.g) : 0;
    const sk = this.tow?.saddleZ !== undefined ? -(this.tow.saddleZ - this.body.localCom().z) : 0;
    const h = KING_COM_HEIGHT;
    const sp = this.spring;
    // Зовнішні моменти від сил коліс минулого кроку (на рівні дороги): бічна сила ліворуч кренить праворуч, тяга
    // вперед піднімає ніс.
    const Fy = M * this.tireAcc.dot(side);
    const Fx = M * this.tireAcc.dot(ft);
    const Iroll = M * KING_ROLL_GYRATION2;
    const Ipitch = M * KING_PITCH_GYRATION2;
    const loads = new Map<number, number>();
    const sub = Math.max(1, Math.ceil(dt / SPRING_STEP));
    const hdt = dt / sub;
    for (let k = 0; k < sub; k++) {
      let Fz = 0;
      let Mr = -Fy * h;
      let Mp = -Fx * h + Fk * sk;
      for (const t of pts) {
        const isFront = t.i < 2;
        const Ns = ((isFront ? Mg * lr + Fk * (lr + sk) : Mg * lf + Fk * (lf - sk)) / L) / (isFront ? front.length : rear.length);
        const T = this.king!.travel?.[t.i] ?? 0.3;
        const L0 = T * SPRING_L0;
        const x0 = L0 - 0.75 * T;
        const kk = Ns / ((x0 / L0 + 1) * x0);
        // Стиск понад статичний: підскок (вниз +), крен (лівий борт вниз +), тангаж (ніс вниз +), нерівність дороги.
        const de = sp.z + sp.roll * t.q + sp.pitch * t.s + (this.bumps[t.i]?.h ?? 0);
        const e = x0 + de;
        const d = L0 - e;
        let N = 0;
        if (d < T) {
          const f = d < 0 ? 2 * kk * L0 : kk * e * (1 + Math.abs(e) / L0) * (1 - Math.exp(-(((d - T) / (0.1 * T)) ** 2)));
          const v = sp.vz + sp.vroll * t.q + sp.vpitch * t.s;
          let fd: number;
          if (v >= 0) fd = Math.min((Ns * v) / 0.8, 0.95 * f);
          else fd = Math.max(-v <= 0.5 ? -0.5 * Ns * -v : -Ns * v * v, -f);
          N = Math.max(0, f + fd);
        }
        loads.set(t.i, N);
        Fz += N;
        Mr -= N * t.q;
        Mp -= N * t.s;
      }
      sp.vz += ((Mg + Fk - Fz) / M) * hdt;
      sp.vroll += (Mr / Iroll) * hdt;
      sp.vpitch += (Mp / Ipitch) * hdt;
      sp.z += sp.vz * hdt;
      sp.roll += sp.vroll * hdt;
      sp.pitch += sp.vpitch * hdt;
    }
    for (const t of pts) wheels[t.i].load = loads.get(t.i) ?? 0;
  }

  /**
   * Нахил кузова від прискорення (king.exe 0x4fca10): вектор (g − a) у площині ґрунту (a — сили коліс і доцентрова,
   * поділені на масу), θ = 0,0109·|вектор|, не більше 0,0435 рад (2,5°); кузов хилиться в його бік — клювання
   * θ·(напрям·курс)·0,2 (збігається із записом), згладжування стан = f·стан + (1 − f)·ціль, f = 0,5^(10·dt). Крен —
   * за записом оригіналу (KingSetup.rollK/rollMax): у записі він лінійний і більший за межу 2,5° — ще одну складову
   * в exe не дорозібрано. Нахил косметичний (лише модель, не тіло), як в оригіналі. lateral — доцентрове прискорення v·ω (+ — ліворуч), along — уздовж курсу.
   */
  private lean(dt: number, n: THREE.Vector3, ft: THREE.Vector3, gt: THREE.Vector3, lateral: number, along: number): void {
    const left = new THREE.Vector3().crossVectors(n, ft);
    const d = gt.clone().addScaledVector(ft, -along).addScaledVector(left, -lateral);
    const len = d.length();
    this.feltFwd = d.dot(ft);
    this.feltSide = -d.dot(left);
    const theta = Math.min(LEAN_MAX, LEAN_K * len);
    if (len > 0.01) d.divideScalar(len);
    const f = 0.5 ** (10 * dt);
    // Крен — за записом оригіналу (лінійний, без межі 2,5°): напрям і згладжування ті самі.
    const K = this.king!;
    const roll = Math.min(K.rollMax, K.rollK * len);
    // Площина контактів з нерівностями доріг (roadBump): ліві колеса — парні, передні — 0 і 1.
    let l = 0, r = 0, fr = 0, bk = 0;
    this.bumps.forEach((b, i) => {
      if (i % 2) r += b.h;
      else l += b.h;
      if (i < 2) fr += b.h;
      else bk += b.h;
    });
    const half = this.wheels / 2;
    const bumpRoll = (l - r) / half / this.track;
    const bumpPitch = (fr / 2 - bk / Math.max(1, this.wheels - 2)) / this.base;
    // Висота — з центру контактів без згладжування (як 0x2214 в оригіналі), нахил — згладжений.
    this.bumpLift = (l + r) / this.wheels;
    // У системі кузова: x — праворуч, z — уперед. Ліві колеса вище — кузов хилиться праворуч; передні — назад.
    this.leanSide = f * this.leanSide + (1 - f) * (roll * -d.dot(left) + bumpRoll);
    this.leanFwd = f * this.leanFwd + (1 - f) * (theta * d.dot(ft) * LEAN_PITCH - bumpPitch);
  }

  /** Нерівності дороги під колесами (roadBump) і зсув кузова за ними вгору, м. */
  private readonly bumps: { h: number; u: number }[] = [];
  private bumpLift = 0;

  /**
   * Відчутне прискорення (g − a) у площині ґрунту, м/с² (lean): уперед (+ — гальмування) і праворуч (+ — поворот
   * ліворуч); вхід гойдання голови в кабіні (king.exe 0x535a70, поля 0x33b0 / 0x33ac).
   */
  feltFwd = 0;
  feltSide = 0;
  /** Множник косметичного крену кузова (вигляд з кабіни — 0,7, на прохання користувача; drive.ts). */
  rollScale = 1;
  /** Орієнтація кузова без косметичного нахилу (як матриця машини +0x204 king.exe — на ній стоїть камера кабіни). */
  readonly bodyQuat = new THREE.Quaternion();
  /** Нахил кузова (рад): верх праворуч і вперед — вхід гойдання салону (king.exe 0x4decc0, поля +0xd20, +0xd2c). */
  get leanAngles(): { side: number; fwd: number } {
    return { side: this.leanSide, fwd: this.leanFwd };
  }

  /** Згладжений нахил кузова king (рад): у бік праворуч і вперед (lean). */
  private leanSide = 0;
  private leanFwd = 0;

  /** Колія передньої осі, м (для кута зовнішнього колеса). */
  private get track(): number {
    const a = new THREE.Vector3().setFromMatrixPosition(this.wheelVisual[0].base);
    const b = new THREE.Vector3().setFromMatrixPosition(this.wheelVisual[1].base);
    return a.distanceTo(b);
  }

  /** Відбійники підвіски (див. SUSPENSION.bump_*): сила вгору в точці кріплення колеса, коли стиснення велике. */
  private applyBumpStops(dt: number): void {
    const S = SUSPENSION;
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const t = this.body.translation();
    let hit = 0;
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
      this.bumpDv += (force * dt) / this.mass;
      hit += force / this.mass;
    }
    this.suspHit = Math.max(this.suspHit, hit);
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
      // Тягач з напівпричепом: колеса під сідлом тримають і частину причепа — межа кроку за навантаженням.
      const stepMass = this.towing ? Math.max(wheelMass, load / 9.81) : wheelMass;
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
      const lift = this.rollLift ?? ROLL_LIFT_BY_TRUCK[this.def.prefix.toLowerCase()] ?? TIRE.roll_lift;
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

  syncVisual(alpha = 1): void {
    this.placeVisual(alpha);
    if (this.shadow) this.placeShadow();
    // Колеса: підвіска (зсув по Z гри), поворот керма (навколо Z), обертання (навколо X).
    for (let i = 0; i < this.wheels; i++) {
      const w = this.wheelVisual[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
      const steer = this.ctrl.wheelSteering(i) ?? 0;
      const spin = this.ctrl.wheelRotation(i) ?? 0;
      // Прямо в матрицю колеса, робоча матриця модуля (щокадру для кожного колеса кожної машини).
      const m = w.obj.matrix.copy(w.base);
      m.multiply(WHEEL_TMP.makeTranslation(0, 0, this.suspAnchor - len + (this.wheelLift[i] ?? 0)));
      m.multiply(WHEEL_TMP.makeRotationZ(steer));
      m.multiply(WHEEL_TMP.makeRotationX(-spin));
    }
  }

  /**
   * Машина іншого гравця в мережевій грі: тіло з масою машини, але без тяжіння — його веде стан із мережі
   * (followRemote). Не кінематичне: кінематичне тіло для фізики — нерухома стіна (наїзд зупиняв би свою машину на
   * місці); з масою удар ділиться між машинами. Перенесено з першої гри (там перевірено на телефонах).
   */
  makeRemote(): void {
    this.body.setGravityScale(0, true);
    this.remote = true;
  }

  /** Машина з мережі (makeRemote) — її не веде ні гравець, ні автопілот. */
  remote = false;

  /** Поза машини з мережі на попередньому кроці — для швидкості, з якою рухається сама поза. */
  private readonly remotePrev = { pos: new THREE.Vector3(), quat: new THREE.Quaternion(), set: false };

  /**
   * Крок машини з мережі (до world.step): кут коліс, оберти й швидкість — з мережі; підвіска й обертання коліс —
   * променями контролера, як у своєї машини (його поштовхи тілу відкидаємо: без тяжіння підвіска підкидала б машину).
   * Бажана швидкість тіла — рух самої пози плюс пружне повернення до неї за REMOTE_FOLLOW с; швидкість тіла
   * наближається до неї за REMOTE_BLEND с, тож поштовх від удару живе кілька кроків. Далеко від пози (відновлення,
   * новий старт) — одразу туди.
   */
  followRemote(dt: number, pos: THREE.Vector3, quat: THREE.Quaternion, steer: number, rpm: number, speedKmh: number, reverse: boolean): void {
    this.savePrev();
    this.steerAngle = steer;
    for (let i = 0; i < this.wheels; i++) {
      this.ctrl.setWheelEngineForce(i, 0);
      this.ctrl.setWheelBrake(i, 0);
      this.ctrl.setWheelFrictionSlip(i, 0);
      this.ctrl.setWheelSteering(i, i < 2 ? steer : 0);
    }
    // Швидкості після минулого кроку (з поштовхами від ударів) — до поштовхів підвіски.
    const lv = this.body.linvel();
    const av = this.body.angvel();
    const vNow = REMOTE_V[4].set(lv.x, lv.y, lv.z);
    const wNow = REMOTE_V[5].set(av.x, av.y, av.z);
    this.ctrl.updateVehicle(dt, undefined, undefined, this.groundRays);
    const prev = this.remotePrev;
    const t = this.body.translation();
    const d = REMOTE_V[0].set(pos.x - t.x, pos.y - t.y, pos.z - t.z);
    if (!prev.set || d.lengthSq() > REMOTE_SNAP ** 2) {
      this.body.setTranslation(pos, true);
      this.body.setRotation(quat, true);
      this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
      this.savePrev();
    } else {
      const k = Math.min(1, dt / REMOTE_BLEND);
      const want = REMOTE_V[1].copy(pos).sub(prev.pos).divideScalar(dt).addScaledVector(d, 1 / REMOTE_FOLLOW);
      vNow.lerp(want, k);
      this.body.setLinvel({ x: vNow.x, y: vNow.y, z: vNow.z }, true);
      // Кутова: поворот пози за крок + повернення до неї (поворот, що лишився: ціль · поточний⁻¹).
      const r = this.body.rotation();
      const w = angularVelocity(REMOTE_Q.copy(prev.quat).invert().premultiply(quat), 1 / dt, REMOTE_V[2]);
      const back = angularVelocity(REMOTE_Q.set(r.x, r.y, r.z, r.w).invert().premultiply(quat), 1 / REMOTE_FOLLOW, REMOTE_V[3]);
      wNow.lerp(w.add(back), k);
      this.body.setAngvel({ x: wNow.x, y: wNow.y, z: wNow.z }, true);
    }
    prev.pos.copy(pos);
    prev.quat.copy(quat);
    prev.set = true;
    this.rpm = rpm;
    this.speedKmh = speedKmh;
    this.vNow = (reverse ? -speedKmh : speedKmh) / 3.6;
    this.gear = reverse ? -1 : 1;
  }

  /** Кут керованих коліс, рад (+ — уліво) — для стану в мережі. */
  get wheelSteer(): number {
    return this.steerAngle;
  }

  reset(spawn: { position: THREE.Vector3; forward: THREE.Vector3 }): void {
    this.remotePrev.set = false;
    const f = spawn.forward.clone().setY(0).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 1, 0), f.clone().negate()),
    );
    this.body.setTranslation(spawn.position, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.axleSide.set(0, 0, 0);
    this.tireAcc.set(0, 0, 0);
    this.groundUp.set(0, 1, 0);
    this.updateTip();
    Object.assign(this.spring, { z: 0, vz: 0, roll: 0, vroll: 0, pitch: 0, vpitch: 0 });
    this.hits.reset();
    this.reverseMode = false;
    this.brakeTime = 0;
    this.engine.reset();
    this.savePrev();
  }

  /** Поточний напрям «уперед» у світі — за тілом (модель між кроками відстає на частку кроку). */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    const r = this.body.rotation();
    return out.set(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
  }

  dispose(): void {
    this.world.removeVehicleController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}

