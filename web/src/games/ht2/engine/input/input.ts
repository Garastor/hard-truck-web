import { icon } from '../ui/icons';
/**
 * Єдиний стан керування з різних джерел: клавіатура, сенсорні кнопки, геймпад.
 * Осі: steer −1..1 (вліво/вправо), throttle 0..1, brake 0..1.
 */

export interface ControlState {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  /** «Різко» (Ctrl у Дальнобойщиках 2): кермо до упору швидше й газ вище (див. InputProfile, engine.ts). */
  sharp?: boolean;
}

/**
 * Керування з клавіатури, що відрізняється від першої гри (Дальнобойщики 2 — телеметрія king.exe,
 * re/notes/ht2/telemetry.md). Без профілю — як у першій грі.
 */
export interface InputProfile {
  /** Час повороту керма від центру до упору, с, за швидкістю машини й режимом «різко». */
  steerRamp: (kmh: number, sharp: boolean) => number;
  /** Форма наростання: частка часу x → кермо x^steerPower. */
  steerPower: number;
  /** Повернення до нуля, 1/с (експоненційно). */
  steerReturn: number;
  /** Клавіша Ctrl і сенсорна кнопка «різко». */
  sharp: boolean;
  /**
   * Швидкість керма з клавіатури, 1/с, за часом утримання t (с), швидкістю v (м/с) і «різко» — формула king.exe
   * (0x500850). Є — замість steerRamp/steerPower; межа зчеплення — Input.steerLimit.
   */
  steerRate?: (t: number, v: number, sharp: boolean) => number;
}

/** camLeft/camRight — обертання зовнішньої камери навколо машини (king.exe 0x59a030, поки клавіша натиснута). */
export type Action = 'left' | 'right' | 'gas' | 'brake' | 'handbrake' | 'sharp' | 'camLeft' | 'camRight';
/** Значки верхніх кнопок — PNG-маски кольору тексту (engine/ui/icons.ts); стрілки керма й педалей — свої, нижче. */
const ICONS = {
  more: icon('more'),
  lights: icon('lights'),
  mirror: icon('mirror'),
  map: icon('map'),
  wipers: icon('wipers'),
  engine: icon('engine'),
  horn: icon('horn'),
  swap: icon('swap'),
  cam: icon('camera'),
  // Обертання камери: стрілка за годинниковою — ліворуч (камера йде навколо машини), праворуч — дзеркально.
  orbitLeft: icon('orbit'),
  orbitRight: icon('orbit', 22, true),
  attach: icon('attach'),
  reset: icon('reset'),
  left: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M17 4L6 12l11 8z"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M7 4l11 8-11 8z"/></svg>',
  // Газ і гальмо (на прохання користувача — стрілки вперед і назад замість написів), як стрілки керма.
  gas: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M4 17l8-11 8 11z"/></svg>',
  brake: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M4 7l8 11 8-11z"/></svg>',
};

/**
 * «Різко» (Ctrl) на сенсорному екрані (на прохання користувача; окремої кнопки немає): на кнопці керма — зсунути палець
 * у бік повороту на SHARP_SLIDE ширини кнопки (назад до SHARP_SLIDE_OFF — вимкнути), на кнопці газу — угору на
 * SHARP_SLIDE висоти (газ без антибукса — колеса можна зірвати, як Ctrl+газ king.exe), або сильно натиснути, де екран
 * міряє силу (3D Touch на iPhone: PointerEvent.pressure, без датчика — 0,5): від SHARP_FORCE, вимкнути нижче
 * SHARP_FORCE_OFF. Діє, доки кнопку тримають; кнопка в цей час мерехтить (клас sharp-on).
 */
const SHARP_SLIDE = 0.3;
const SHARP_SLIDE_OFF = 0.12;
const SHARP_FORCE = 0.8;
const SHARP_FORCE_OFF = 0.6;
/** «Різко»: швидкість керма понад межею зчеплення до упору, 1/с (порт; з 0,4 до 1 — за ≈ 0,4 с). */
const SHARP_STEER_RATE = 1.5;
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export type Command = 'f1' |'f2' | 'f3' | 'f4' | 'f5' | 'menu' | 'camera' | 'reset' | 'horn' | 'autopilot' | 'tilt' | 'lights' | 'map' | 'engine' | 'wipers' | 'mirror' | 'cab' | 'swap' | 'attach';

/**
 * Дозвіл на датчик руху (iOS 13+: DeviceOrientationEvent.requestPermission). Питати можна лише в жесті користувача;
 * застосунок з початкового екрана після перезапуску дозвіл забуває, хоч налаштування «нахил» збережене. Тому, коли
 * запит без жесту не пройшов, чекаємо першого дотику (touchend/click — на iOS це жест) і питаємо в ньому.
 */
const MOTION = (typeof DeviceOrientationEvent === 'undefined' ? {} : DeviceOrientationEvent) as { requestPermission?: () => Promise<string> };
let motionGranted = typeof MOTION.requestPermission !== 'function';

/** 'granted' — є дозвіл; 'denied' — відмова; 'gesture' — потрібен жест користувача. */
export async function requestMotionPermission(): Promise<'granted' | 'denied' | 'gesture'> {
  if (motionGranted) return 'granted';
  try {
    // Виклик — синхронно (до першого await), щоб у обробнику дотику він ще рахувався жестом.
    motionGranted = (await MOTION.requestPermission!()) === 'granted';
    return motionGranted ? 'granted' : 'denied';
  } catch {
    return 'gesture';
  }
}

let motionWaiters: ((r: 'granted' | 'denied') => void)[] = [];
let motionArmed = false;

/** Попросити дозвіл на першому дотику (наприклад, ще в головному меню, якщо збережено керування нахилом). */
export function motionOnGesture(): Promise<'granted' | 'denied'> {
  if (motionGranted) return Promise.resolve('granted');
  const done = new Promise<'granted' | 'denied'>((r) => motionWaiters.push(r));
  if (!motionArmed) {
    motionArmed = true;
    const events = ['touchend', 'click'] as const;
    const onGesture = () => {
      void requestMotionPermission().then((r) => {
        if (r === 'gesture') return; // не зарахувалось жестом — чекаємо наступного дотику
        for (const e of events) window.removeEventListener(e, onGesture, true);
        motionArmed = false;
        const ws = motionWaiters;
        motionWaiters = [];
        for (const w of ws) w(r);
      });
    };
    for (const e of events) window.addEventListener(e, onGesture, true);
  }
  return done;
}

/** Час повороту керма з клавіатури від центру до краю, с, і швидкість повернення, 1/с (оригінал, s6). */
const STEER_RAMP = 1.1;
const STEER_RETURN = 4.3;
/** Найбільша швидкість керма на S-кривій (посередині, де кермо = 0,5), 1/с. */
const STEER_RATE = 1.5 / STEER_RAMP;

/** Обернена до smoothstep x²(3 − 2x) на [0, 1]. */
function inverseSmoothstep(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * Math.min(1, y)) / 3);
}

export class Input {
  readonly state: ControlState = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  private readonly held = new Set<Action>();
  /** Швидкість машини, км/год (для профілю: кермо на швидкості повертається повільніше). */
  speedKmh = 0;
  /** Кнопки керма, на яких зараз «різко» (зсув пальця чи сильне натискання). */
  private readonly touchSharp = new Set<HTMLElement>();
  private steerSmooth = 0;
  private steerHold = 0;
  private steerDir = 0;
  /** Кермо перекладається з протилежного боку (див. update). */
  private steerCross = false;
  /** Кермування нахилом телефона (DeviceOrientation), −1..1 або null, якщо вимкнено. */
  private tilt: number | null = null;
  private readonly onOrient = (e: DeviceOrientationEvent) => {
    // У ландшафті кермо — нахил уздовж довгої осі (beta), знак залежить від повороту екрана.
    const angle = (screen.orientation?.angle ?? 0) === 270 ? -(e.beta ?? 0) : (e.beta ?? 0);
    this.tilt = Math.max(-1, Math.min(1, angle / 25));
  };
  tiltEnabled = false;
  /** Меню «Керування»: швидкість керма й повернення до центру (множники; 1 — як у телеметрії). */
  steerSpeed = 1;
  steerCenter = 1;
  /** Межа керма за зчепленням (king.exe 0x500850: |s| ≤ c, понад — назад до c зі швидкістю 1/с); null — без межі. */
  steerLimit: (() => number) | null = null;
  /** Час утримання клавіші керма в один бік, с. */
  private steerT = 0;
  /** Сенсорні кнопки (кнопки керма ховаються, поки кермують нахилом). */
  private touchEl: HTMLElement | null = null;
  /** Нахил вимкнено сам (відмова в дозволі на датчик руху). */
  onTiltDenied: (() => void) | null = null;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** Одноразові події (перемкнути камеру, скинути вантажівку). */
  onCommand: ((cmd: Command) => void) | null = null;

  constructor(private readonly profile: InputProfile | null = null) {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  /**
   * Клавіші — як в оригіналі (таблиця клавіш HTruck.exe: стрілки — газ, гальмо, кермо; H — сигнал, W — двірники,
   * C — камера, 0 — відновитися; L — фари, M — дзеркало, Tab — навігація, пробіл — двигун). Ручне гальмо в таблиці оригіналу
   * без клавіші — Shift. Перепризначені в меню «Керування» — Input.bind (типові — DEFAULT_KEYS).
   */
  private static KEYS: Record<string, Action> = {};
  private static COMMANDS: Record<string, Command> = {};

  /**
   * Перепризначення клавіш (меню «Керування», ht2.settings.v1 `keys`): дія → код клавіші (KeyboardEvent.code) замість
   * усіх типових клавіш цієї дії. Діє на всі екземпляри Input.
   */
  static bind(over: Partial<Record<Action | Command, string>> = {}): void {
    Input.KEYS = {};
    Input.COMMANDS = {};
    const put = (b: Action | Command, c: string) => {
      delete Input.KEYS[c];
      delete Input.COMMANDS[c];
      if ((ACTIONS as readonly string[]).includes(b)) Input.KEYS[c] = b as Action;
      else Input.COMMANDS[c] = b as Command;
    };
    // Спершу типові, потім перепризначені (клавіша, забрана в іншої дії, — лише новій).
    for (const [b, def] of Object.entries(DEFAULT_KEYS) as [Action | Command, string[]][]) if (!over[b]) def.forEach((c) => put(b, c));
    for (const [b, c] of Object.entries(over) as [Action | Command, string][]) if (c && DEFAULT_KEYS[b]) put(b, c);
  }

  private key(e: KeyboardEvent): void {
    const a = Input.KEYS[e.code] ?? (this.profile?.sharp && (e.code === 'ControlLeft' || e.code === 'ControlRight') ? 'sharp' : undefined);
    if (a) {
      e.preventDefault();
      if (e.type === 'keydown') this.held.add(a);
      else this.held.delete(a);
    } else if (Input.COMMANDS[e.code] && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
      // Tab і пробіл — без типової дії браузера (фокус, прокрутка, натискання кнопки у фокусі).
      e.preventDefault();
      if (e.type === 'keydown' && !e.repeat) this.onCommand?.(Input.COMMANDS[e.code]);
    }
  }

  press(a: Action, down: boolean): void {
    if (down) this.held.add(a);
    else this.held.delete(a);
  }

  /** Оновлює осі; кермо плавно повертається, як у грі з клавіатури. */
  update(dt: number): ControlState {
    const target = (this.held.has('right') ? 1 : 0) - (this.held.has('left') ? 1 : 0);
    const pads = navigator.getGamepads?.() ?? [];
    let padSteer = 0;
    let padGas = 0;
    let padBrake = 0;
    for (const p of pads) {
      if (!p) continue;
      padSteer = Math.abs(p.axes[0] ?? 0) > 0.12 ? p.axes[0] : 0;
      padGas = p.buttons[7]?.value ?? 0;
      padBrake = p.buttons[6]?.value ?? 0;
      break;
    }
    const sharp = this.held.has('sharp') || this.touchSharp.size > 0;
    if (this.profile) this.steerProfile(dt, target, sharp, this.profile);
    // Кермо з клавіатури як в оригіналі (телеметрія s6, поля [0x22f]/[0x230]): при утриманні — плавна
    // S-крива від 0 до повного за 1,1 с; відпустив — експоненційно до нуля (≈ 4,3 1/с).
    else if (target !== 0) {
      if (Math.sign(target) !== this.steerDir) {
        this.steerDir = Math.sign(target);
        // Кермо вже в інший бік (різко переклали): переходить без стрибка — див. нижче.
        this.steerCross = this.steerSmooth * this.steerDir < 0;
        // Нова сторона: продовжуємо з поточного положення керма по тій самій кривій.
        if (!this.steerCross) this.steerHold = inverseSmoothstep(Math.max(0, this.steerSmooth * this.steerDir)) * STEER_RAMP;
      }
      const s = this.steerSmooth * this.steerDir;
      if (this.steerCross && s < 0.5) {
        // Перекладання з одного боку на інший (порт; як в оригіналі — не розібрано): до центру — не повільніше,
        // ніж кермо повертається саме, далі до половини — з найбільшою швидкістю S-кривої, звідки крива
        // продовжується без зламу. Інакше S-крива з нуля стартує з нульовою швидкістю — кермо «зависало» в центрі.
        const rate = s < 0 ? Math.max(STEER_RATE, STEER_RETURN * -s) : STEER_RATE;
        const next = s + rate * dt;
        if (next < 0.5) this.steerSmooth = this.steerDir * next;
        else {
          // Дійшли до половини: решту кроку — уже по S-кривій.
          this.steerCross = false;
          this.steerHold = Math.min(STEER_RAMP, 0.5 * STEER_RAMP + (next - 0.5) / STEER_RATE);
          const x = this.steerHold / STEER_RAMP;
          this.steerSmooth = this.steerDir * x * x * (3 - 2 * x);
        }
      } else {
        this.steerCross = false;
        this.steerHold = Math.min(STEER_RAMP, this.steerHold + dt);
        const x = this.steerHold / STEER_RAMP;
        this.steerSmooth = this.steerDir * x * x * (3 - 2 * x);
      }
    } else {
      this.steerDir = 0;
      this.steerSmooth *= Math.exp(-STEER_RETURN * dt);
      if (Math.abs(this.steerSmooth) < 1e-3) this.steerSmooth = 0;
    }
    this.state.steer = padSteer || (this.tiltEnabled && this.tilt !== null && target === 0 ? this.tilt : this.steerSmooth);
    this.state.throttle = Math.max(this.held.has('gas') ? 1 : 0, padGas);
    this.state.brake = Math.max(this.held.has('brake') ? 1 : 0, padBrake);
    this.state.handbrake = this.held.has('handbrake');
    this.state.sharp = sharp;
    return this.state;
  }

  /**
   * Кермо Дальнобойщиків 2 (телеметрія king.exe): утримання — кермо x^p за час ramp(швидкість, «різко»);
   * клавіша в інший бік — спершу повернення до нуля, далі наростання; відпустив — експоненційно до нуля.
   */
  private steerProfile(dt: number, target: number, sharp: boolean, p: InputProfile): void {
    if (p.steerRate) return this.steerExe(dt, target, sharp, p, p.steerRate);
    const s = this.steerSmooth;
    if (target !== 0 && s * target >= -0.02) {
      const ramp = p.steerRamp(this.speedKmh, sharp) / this.steerSpeed;
      const x = Math.min(1, Math.max(0, s * target) ** (1 / p.steerPower) + dt / ramp);
      this.steerSmooth = target * x ** p.steerPower;
      this.steerDir = target;
    } else {
      this.steerDir = 0;
      this.steerSmooth *= Math.exp(-p.steerReturn * this.steerCenter * dt);
      if (Math.abs(this.steerSmooth) < 1e-3) this.steerSmooth = 0;
    }
  }

  /**
   * Кермо з клавіатури king.exe (0x500850, re/notes/ht2/career-misc.md §5, steering.md): s += rate(t, v)·dt, t — час
   * утримання; протилежна клавіша — спершу гасіння (s ← p·s − |p·s|·dt), далі та сама формула; без клавіш — s ← p·s
   * (повернення steerReturn). Межа зчеплення c (крім «різко»): клавіша доводить кермо лише до c; якщо c зменшилась
   * (розігнався) і |s| > c — назад до c зі швидкістю 1/с.
   */
  private steerExe(dt: number, target: number, sharp: boolean, p: InputProfile, rate: NonNullable<InputProfile['steerRate']>): void {
    let s = this.steerSmooth;
    const c = sharp ? 1 : (this.steerLimit?.() ?? 1);
    // Уже понад межею (розігнався) і клавіша тисне в той самий бік — назад до c зі швидкістю 1/с, кермо не додає.
    // Відпущене чи протилежне кермо — як завжди (інакше з межею, що коливається зі швидкістю, кермо «залипало» на c).
    if (Math.abs(s) > c && target !== 0 && Math.sign(s) === target) {
      this.steerDir = target;
      this.steerT += dt;
      this.steerSmooth = target * Math.max(c, Math.abs(s) - dt);
      return;
    }
    const back = Math.exp(-p.steerReturn * this.steerCenter * dt);
    if (target !== 0) {
      if (target !== this.steerDir) this.steerT = 0;
      this.steerDir = target;
      if (s * target < 0) {
        s *= back;
        s -= s * dt;
      }
      s += target * rate(this.steerT, this.speedKmh / 3.6, sharp) * this.steerSpeed * dt;
      this.steerT += dt;
    } else {
      this.steerDir = 0;
      this.steerT = 0;
      s *= back;
      if (Math.abs(s) < 1e-3) s = 0;
    }
    // Межа — лише для керма, що зростає в бік клавіші (повернення до центру не обрізаємо вгору).
    s = target !== 0 && s * target > 0 ? Math.max(-c, Math.min(c, s)) : s;
    // «Різко» понад межею зчеплення — кермо докручується до упору не швидше SHARP_STEER_RATE (порт, на прохання
    // користувача): за формулою exe після довгого утримання клавіші швидкість ≈ 10 1/с, і кермо стрибало на упор.
    const norm = this.steerLimit?.() ?? 1;
    if (sharp && target !== 0 && s * target > norm) {
      const from = Math.max(norm, this.steerSmooth * target);
      s = target * Math.min(s * target, from + SHARP_STEER_RATE * this.steerSpeed * dt);
    }
    this.steerSmooth = s;
  }

  /**
   * Вмикає/вимикає кермування нахилом. iOS вимагає дозволу в жесті користувача: якщо його ще немає (старт траси
   * після перезапуску застосунку), нахил лишається ввімкненим, а дозвіл питаємо на першому дотику.
   */
  async toggleTilt(): Promise<boolean> {
    if (this.tiltEnabled) {
      this.setTiltOn(false);
      return false;
    }
    this.setTiltOn(true);
    // Поза жестом iOS може відповісти відмовою, хоч користувач не відмовляв, — питаємо лише в дотику.
    void motionOnGesture().then((g) => {
      if (g === 'denied' && this.tiltEnabled) {
        this.setTiltOn(false);
        this.onTiltDenied?.();
      }
    });
    return true;
  }

  private setTiltOn(on: boolean): void {
    this.tiltEnabled = on;
    if (on) window.addEventListener('deviceorientation', this.onOrient);
    else {
      window.removeEventListener('deviceorientation', this.onOrient);
      this.tilt = null;
    }
    this.touchEl?.classList.toggle('tilt-on', on);
  }

  /** Сенсорні кнопки поверх гри (мультитач через Pointer Events). */
  mountTouch(parent: HTMLElement): HTMLElement {
    const ui = document.createElement('div');
    ui.className = 'touch-ui';
    ui.classList.toggle('tilt-on', this.tiltEnabled);
    this.touchEl = ui;
    // Угорі праворуч — один ряд (група «ще», карта, відновитися, вид), під ним — розгорнута група «ще».
    const top = document.createElement('div');
    top.className = 'touch-top';
    const row = document.createElement('div');
    row.className = 'touch-top-row';
    top.append(row);
    const btn = (cls: string, label: string, action?: Action, cmd?: Command, svg?: string, parent: HTMLElement = ui) => {
      const b = document.createElement('button');
      b.className = `touch-btn ${cls}`;
      if (svg) b.innerHTML = svg;
      else b.textContent = label;
      b.setAttribute('aria-label', cls);
      // Значки — векторні SVG (не «м'які» маски softUi): у стилі табло мають бути чіткими на будь-якому екрані.
      const down = (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('pressed');
        if (action) {
          this.press(action, true);
          this.touchHeld.set(e.pointerId, { b, action });
        }
        if (cmd) this.onCommand?.(cmd);
      };
      const up = (e: PointerEvent) => {
        e.preventDefault();
        this.releasePointer(e.pointerId, b);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      // Захоплення дотику загублено (кнопку сховано, вікно перекрило) — pointerup сюди вже не прийде.
      b.addEventListener('lostpointercapture', (e) => this.releasePointer(e.pointerId, b));
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      parent.append(b);
      return b;
    };
    this.sharpGesture(btn('left', '', 'left', undefined, ICONS.left), -1);
    this.sharpGesture(btn('right', '', 'right', undefined, ICONS.right), 1);
    btn('brake', '', 'brake', undefined, ICONS.brake);
    this.sharpGesture(btn('gas', '', 'gas', undefined, ICONS.gas), -1, 'y');
    // Група «ще» (згорнута): фари, дзеркало (лише з кабіни), двірники, двигун (клавіші L, M, W, пробіл) і сигнал;
    // кабіни 2D у другій грі немає — кнопку прибрано.
    const more = document.createElement('div');
    more.className = 'touch-more';
    more.hidden = true;
    const toggle = btn('more', '', undefined, undefined, ICONS.more, row);
    // «•••» показує / згортає групу «ще»; з зовнішньою камерою в ній — і 4-й ряд обертання камери (з кабіни схований).
    toggle.addEventListener('pointerdown', () => {
      this.moreOpen = !this.moreOpen;
      more.hidden = !this.moreOpen;
      toggle.classList.toggle('on', this.moreOpen);
      this.syncOrbit();
    });
    btn('reset', '', undefined, 'reset', ICONS.reset, row);
    btn('cam', '', undefined, 'camera', ICONS.cam, row);
    // Причепити / відчепити напівпричіп — лише в тягача (drive: setToggle('attach', …, hidden)).
    const attach = btn('attach', '', undefined, 'attach', ICONS.attach, row);
    attach.dataset.cmd = 'attach';
    attach.hidden = true;
    // Карта (Tab) — першою в групі «ще» (на прохання користувача).
    const items: [string, Command, string][] = [
      ['map', 'map', ICONS.map],
      ['lights', 'lights', ICONS.lights],
      ['mirror', 'mirror', ICONS.mirror],
      ['wipers', 'wipers', ICONS.wipers],
      ['engine', 'engine', ICONS.engine],
      ['horn', 'horn', ICONS.horn],
    ];
    for (const [cls, cmd, icon] of items) btn(cls, '', undefined, cmd, icon, more).dataset.cmd = cmd;
    // Кнопки обертання камери по колу (тримати) — 4-м рядом групи «ще»; ракурс скидає «Камера».
    for (const [cls, a, icon] of [['orbit-left', 'camLeft', ICONS.orbitLeft], ['orbit-right', 'camRight', ICONS.orbitRight]] as const) {
      const b = btn(cls, '', a, undefined, icon, more);
      b.hidden = true;
      this.orbitBtns.push(b);
    }
    top.append(more);
    ui.append(top);
    parent.append(ui);
    this.touchUi = ui;
    window.addEventListener('pointerup', this.onPointerEnd, true);
    window.addEventListener('pointercancel', this.onPointerEnd, true);
    return ui;
  }

  private touchUi: HTMLElement | null = null;

  /** Утримані сенсорні кнопки дій: pointerId → кнопка й дія (щоб відпустити, куди б не прийшов pointerup). */
  private readonly touchHeld = new Map<number, { b: HTMLElement; action: Action }>();

  /** Відпускання дотику будь-де (вікно поверх кнопки могло перехопити pointerup) — відпустити його кнопку. */
  private readonly onPointerEnd = (e: PointerEvent) => this.releasePointer(e.pointerId);

  private releasePointer(id: number, b?: HTMLElement): void {
    const h = this.touchHeld.get(id);
    if (h) {
      this.touchHeld.delete(id);
      const rest = [...this.touchHeld.values()];
      // Ця сама дія чи кнопка ще утримана іншим пальцем — лишається натиснутою.
      if (!rest.some((o) => o.action === h.action)) this.press(h.action, false);
      if (!rest.some((o) => o.b === h.b)) {
        h.b.classList.remove('pressed');
        this.touchSharp.delete(h.b);
        h.b.classList.remove('sharp-on');
      }
    } else b?.classList.remove('pressed');
  }

  /**
   * Відпустити всі сенсорні кнопки керування (зʼявилось вікно: пауза, покупка, штраф, бічна панель). Під вікном
   * iOS часто не доносить pointerup до кнопки — газ чи кермо «залипали». Щоб натиснути знову — новий дотик.
   */
  releaseTouch(): void {
    for (const id of [...this.touchHeld.keys()]) this.releasePointer(id);
    for (const b of this.touchUi?.querySelectorAll<HTMLElement>('.touch-btn.pressed') ?? []) b.classList.remove('pressed');
    for (const b of this.touchSharp) b.classList.remove('sharp-on');
    this.touchSharp.clear();
  }

  /**
   * «Різко» на кнопці: зсув пальця вздовж axis у бік dir (кермо — x: −1 ліворуч, 1 праворуч; газ — y: −1 угору) чи
   * сильне натискання.
   */
  private sharpGesture(b: HTMLElement, dir: number, axis: 'x' | 'y' = 'x'): void {
    if (!this.profile?.sharp) return;
    let x0 = 0;
    let slide = false;
    let force = false;
    const set = () => {
      const on = slide || force;
      b.classList.toggle('sharp-on', on);
      if (on) this.touchSharp.add(b);
      else this.touchSharp.delete(b);
    };
    const pressure = (e: PointerEvent) => {
      // Без датчика сили натиснутий дотик має 0,5 (мишка — 0,5 чи 0), тож поріг 0,8 спрацьовує лише з датчиком.
      // Лише iPhone/iPad (3D Touch): на Android pressure часто — площа дотику, і тверде натискання вмикало б «різко».
      if (!IOS || e.pointerType !== 'touch') return;
      if (e.pressure >= SHARP_FORCE) force = true;
      else if (e.pressure < SHARP_FORCE_OFF) force = false;
    };
    b.addEventListener('pointerdown', (e) => {
      x0 = axis === 'x' ? e.clientX : e.clientY;
      slide = false;
      force = false;
      pressure(e);
      set();
    });
    b.addEventListener('pointermove', (e) => {
      if (!b.classList.contains('pressed')) return;
      const r = b.getBoundingClientRect();
      const w = Math.max(40, axis === 'x' ? r.width : r.height);
      const d = (((axis === 'x' ? e.clientX : e.clientY) - x0) * dir) / w;
      if (d >= SHARP_SLIDE) slide = true;
      else if (d < SHARP_SLIDE_OFF) slide = false;
      pressure(e);
      set();
    });
    const off = () => {
      slide = false;
      force = false;
      set();
    };
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
  }
  /** Підсвітка увімкнених функцій у групі «ще» (фари, дзеркало…); hidden — кнопку не показувати. */
  /** unavailable — функції немає (навігація без «НС»): кнопка видна, але сіра. */
  /** Обертання камери: −1 ліворуч, 1 праворуч, 0 — не крутити (клавіші чи кнопки, поки натиснуті). */
  get camTurn(): number {
    return (this.held.has('camRight') ? 1 : 0) - (this.held.has('camLeft') ? 1 : 0);
  }

  private moreOpen = false;
  private orbitAllowed = true;
  private readonly orbitBtns: HTMLElement[] = [];

  /** Кнопки обертання камери є лише з зовнішньою камерою: з кабіни — сховані (на прохання користувача). */
  setOrbitAvailable(on: boolean): void {
    this.orbitAllowed = on;
    this.syncOrbit();
  }

  private syncOrbit(): void {
    const show = this.moreOpen && this.orbitAllowed;
    for (const b of this.orbitBtns) b.hidden = !show;
    // Сховану кнопку, яку ще тримали, — відпустити.
    if (!show) {
      this.held.delete('camLeft');
      this.held.delete('camRight');
      for (const b of this.orbitBtns) b.classList.remove('pressed');
    }
  }

  setToggle(cmd: Command, on: boolean, hidden = false, unavailable = false): void {
    const b = this.touchUi?.querySelector<HTMLElement>(`[data-cmd="${cmd}"]`);
    if (!b) return;
    b.classList.toggle('on', on && !unavailable);
    b.classList.toggle('unavailable', unavailable);
    b.hidden = hidden;
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrient);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('pointerup', this.onPointerEnd, true);
    window.removeEventListener('pointercancel', this.onPointerEnd, true);
  }
}

const ACTIONS = ['left', 'right', 'gas', 'brake', 'handbrake', 'sharp', 'camLeft', 'camRight'] as const;

/** Типові клавіші дій і команд (перша — показується в меню «Керування»). */
export const DEFAULT_KEYS: Partial<Record<Action | Command, string[]>> = {
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
  gas: ['ArrowUp'],
  brake: ['ArrowDown'],
  handbrake: ['ShiftLeft', 'ShiftRight'],
  menu: ['Escape'],
  f1: ['F1'],
  f2: ['F2'],
  f3: ['F3'],
  f4: ['F4'],
  f5: ['F5'],
  camera: ['KeyC'],
  // Порту: Del і PgDn — крайні клавіші ряду Del–End–PgDn (типові клавіші king.exe не з'ясовано; їхні назви
  // задає конструктор таблиці клавіш, re/notes/ht2/menu-screens.md — гіпотеза).
  camLeft: ['Delete'],
  camRight: ['PageDown'],
  reset: ['KeyR', 'Digit0', 'Numpad0'],
  horn: ['KeyH'],
  autopilot: ['KeyP'],
  lights: ['KeyL'],
  map: ['Tab'],
  engine: ['Space'],
  wipers: ['KeyW'],
  mirror: ['KeyM'],
  attach: ['KeyT'],
};
Input.bind();

/**
 * Розкладка сенсорних кнопок: кермо праворуч, газ і гальмо ліворуч (body.swap-controls; стилі — style.css і ht2.css).
 * Зберігає ui/settings.ts (pedalsLeft) — не спільний ключ оболонки `ht.swapControls`, що лишається за першою грою.
 */
export function applyPedalsLeft(on: boolean): void {
  document.body.classList.toggle('swap-controls', on);
}

/** Значок «поміняти місцями кермо й педалі» — для лівої групи кнопок (drive.ts). */
