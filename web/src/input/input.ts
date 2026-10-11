/**
 * Єдиний стан керування з різних джерел: клавіатура, сенсорні кнопки, геймпад.
 * Осі: steer −1..1 (вліво/вправо), throttle 0..1, brake 0..1.
 */
import { soften } from '../ui/softUi';

export interface ControlState {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

type Action = 'left' | 'right' | 'gas' | 'brake' | 'handbrake';
/** Значок сигналу (ріжок, за зразком користувача) — однотонний контур, як решта кнопок. */
const HORN_SVG =
  '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M2.5 8.6v4.6M2.5 10.9H5"/><path d="M5 9h7.5c3.2 0 6-1.6 8-4.3.6-.8 1.5-.4 1.5.5v13.4c0 .9-.9 1.3-1.5.5-2-2.4-3.5-3.6-5.6-4.2"/><path d="M5 12.9h1.4"/><path d="M6.4 12.9c0 2.4 1.2 3.8 3.4 3.8h3.4"/><rect x="8.6" y="12.6" width="6.4" height="2.9" rx="1.45"/></svg>';

/** Значки групи «ще» (однотонні, як сигнал). */
const svg = (body: string, width = 2) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round">${body}</svg>`;
/** Значки — за зразками користувача, контуром кольору тексту. */
const ICONS = {
  more: svg('<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>'),
  // Фара з променями ліворуч.
  lights: svg('<path d="M13.5 5.5c4.5 0 7.5 2.9 7.5 6.5s-3 6.5-7.5 6.5z"/><path d="M3 8l7.5-1M3 11l7.5-1M3 14l7.5-1M3 17l7.5-1"/>'),
  // Салонне дзеркало заднього огляду на кріпленні, з відблиском.
  mirror: svg('<path d="M9.3 3.5h5.4l-1.3 2h-.6l-.4 3.6h-.8l-.4-3.6h-.6z" fill="currentColor"/><path d="M6.1 9.4h11.8c.8 0 1.4.5 1.6 1.2l1.5 5.5c.3.8-.3 1.6-1.2 1.6H4.2c-.9 0-1.5-.8-1.2-1.6l1.5-5.5c.2-.7.8-1.2 1.6-1.2z"/><path d="M10 15.6l2.6-2.8M12.2 16l2.6-2.8" stroke-width="1"/>'),
  map: svg('<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>'),
  // Лобове скло з двірником (вісь унизу посередині).
  wipers: svg('<path d="M10.2 18.5H6.5L3 7.5c5.8-2.6 12.2-2.6 18 0l-3.5 11h-3.7"/><path d="M12.4 17.2L10 7.8"/><circle cx="12.4" cy="18.4" r="1.4" fill="currentColor"/>'),
  // Блок двигуна.
  engine: svg('<path d="M6.5 9.5V8h3V6h5v2h2.5l1.5 2h1.5V8.5h1.5v7h-1.5V14H18.5l-1.5 3.5H9.5L7.5 15H6.5v-1.5H3.5v2H2v-6h1.5v2h3z"/>'),
  // Приладова панель — вид кабіни 2D / 3D.
  cab: svg('<path d="M6 18.5A7.5 7.5 0 1 1 18 18.5z"/><path d="M12 14.6l3.4-4.6"/><circle cx="12" cy="14.8" r="1.1"/><path d="M12 8.7v1.3M7.6 13.4h1.2M15.2 13.4h1.2M8.4 10l.8.8"/><path d="M3.6 11.6a2.6 2.6 0 0 0 0 5.2M20.4 11.6a2.6 2.6 0 0 1 0 5.2"/>'),
  // Дві клавіші по боках і дві заокруглені стрілки між ними — поміняти місцями кермо й педалі.
  swap: svg('<rect x="1.5" y="8.5" width="7" height="7" rx="1.4"/><rect x="15.5" y="8.5" width="7" height="7" rx="1.4"/><path d="M3.9 12l2.4-1.6v3.2zM20.1 12l-2.4-1.6v3.2z" fill="currentColor" stroke-width="1"/><path d="M8 6.6c2.3-2.6 5.7-2.6 8 0M16 17.4c-2.3 2.6-5.7 2.6-8 0"/><path d="M16.6 4.7l-.4 2.4-2.3-.5M7.4 19.3l.4-2.4 2.3.5"/>', 1.6),
  // Відеокамера — перемикання виду.
  cam: svg('<rect x="2" y="6" width="13.5" height="12" rx="2.5"/><path d="M15.5 10.5l6-3.5v10l-6-3.5z"/>'),
  // Кругова стрілка за годинниковою — відновитися.
  reset: svg('<path d="M17.2 16.8A6.8 6.8 0 1 1 18.3 9"/><path d="M15.6 9.6h5.2l-2.6 3.6z" fill="currentColor"/>'),
  left: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M17 4L6 12l11 8z"/></svg>',
  right: '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M7 4l11 8-11 8z"/></svg>',
};

type Command = 'camera' | 'reset' | 'horn' | 'autopilot' | 'tilt' | 'lights' | 'map' | 'engine' | 'wipers' | 'mirror' | 'cab' | 'swap';

/** Час повороту керма з клавіатури від центру до краю, с, і швидкість повернення, 1/с (оригінал, s6). */
const STEER_RAMP = 1.1;
const STEER_RETURN = 4.3;

/** Обернена до smoothstep x²(3 − 2x) на [0, 1]. */
function inverseSmoothstep(y: number): number {
  return 0.5 - Math.sin(Math.asin(1 - 2 * Math.min(1, y)) / 3);
}

export class Input {
  readonly state: ControlState = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  private readonly held = new Set<Action>();
  private steerSmooth = 0;
  private steerHold = 0;
  private steerDir = 0;
  /** Кермування нахилом телефона (DeviceOrientation), −1..1 або null, якщо вимкнено. */
  private tilt: number | null = null;
  private readonly onOrient = (e: DeviceOrientationEvent) => {
    // У ландшафті кермо — нахил уздовж довгої осі (beta), знак залежить від повороту екрана.
    const angle = (screen.orientation?.angle ?? 0) === 270 ? -(e.beta ?? 0) : (e.beta ?? 0);
    this.tilt = Math.max(-1, Math.min(1, angle / 25));
  };
  tiltEnabled = false;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** Одноразові події (перемкнути камеру, скинути вантажівку). */
  onCommand: ((cmd: Command) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  /**
   * Клавіші — як в оригіналі (таблиця клавіш HTruck.exe: стрілки — газ, гальмо, кермо; H — сигнал, W — двірники,
   * C — камера, 0 — відновитися; L — фари, M — дзеркало, Tab — навігація, пробіл — двигун). Ручне гальмо в таблиці оригіналу
   * без клавіші — Shift.
   */
  private static readonly KEYS: Record<string, Action> = {
    ArrowLeft: 'left',
    ArrowRight: 'right',
    ArrowUp: 'gas',
    ArrowDown: 'brake',
    ShiftLeft: 'handbrake',
    ShiftRight: 'handbrake',
  };
  private static readonly COMMANDS: Record<string, Command> = {
    KeyC: 'camera',
    KeyR: 'reset',
    Digit0: 'reset',
    Numpad0: 'reset',
    KeyH: 'horn',
    KeyP: 'autopilot',
    KeyL: 'lights',
    Tab: 'map',
    Space: 'engine',
    KeyW: 'wipers',
    KeyM: 'mirror',
  };

  private key(e: KeyboardEvent): void {
    const a = Input.KEYS[e.code];
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
    // Кермо з клавіатури як в оригіналі (телеметрія s6, поля [0x22f]/[0x230]): при утриманні — плавна
    // S-крива від 0 до повного за 1,1 с; відпустив — експоненційно до нуля (≈ 4,3 1/с).
    if (target !== 0) {
      if (Math.sign(target) !== this.steerDir) {
        // Нова сторона: продовжуємо з поточного положення керма по тій самій кривій.
        this.steerDir = Math.sign(target);
        this.steerHold = inverseSmoothstep(Math.max(0, this.steerSmooth * this.steerDir)) * STEER_RAMP;
      }
      this.steerHold = Math.min(STEER_RAMP, this.steerHold + dt);
      const x = this.steerHold / STEER_RAMP;
      this.steerSmooth = this.steerDir * x * x * (3 - 2 * x);
    } else {
      this.steerDir = 0;
      this.steerSmooth *= Math.exp(-STEER_RETURN * dt);
      if (Math.abs(this.steerSmooth) < 1e-3) this.steerSmooth = 0;
    }
    this.state.steer = padSteer || (this.tiltEnabled && this.tilt !== null && target === 0 ? this.tilt : this.steerSmooth);
    this.state.throttle = Math.max(this.held.has('gas') ? 1 : 0, padGas);
    this.state.brake = Math.max(this.held.has('brake') ? 1 : 0, padBrake);
    this.state.handbrake = this.held.has('handbrake');
    return this.state;
  }

  /** Вмикає/вимикає кермування нахилом (iOS вимагає дозволу на жест користувача). */
  async toggleTilt(): Promise<boolean> {
    if (this.tiltEnabled) {
      window.removeEventListener('deviceorientation', this.onOrient);
      this.tiltEnabled = false;
      this.tilt = null;
      return false;
    }
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    if (DOE.requestPermission && (await DOE.requestPermission().catch(() => 'denied')) !== 'granted') return false;
    window.addEventListener('deviceorientation', this.onOrient);
    this.tiltEnabled = true;
    return true;
  }

  /** Сенсорні кнопки поверх гри (мультитач через Pointer Events). */
  mountTouch(parent: HTMLElement): HTMLElement {
    const ui = document.createElement('div');
    ui.className = 'touch-ui';
    const btn = (cls: string, label: string, action?: Action, cmd?: Command, svg?: string) => {
      const b = document.createElement('button');
      b.className = `touch-btn ${cls}`;
      if (svg) b.innerHTML = svg;
      else b.textContent = label;
      b.setAttribute('aria-label', cls);
      soften(b);
      const down = (e: PointerEvent) => {
        e.preventDefault();
        b.setPointerCapture(e.pointerId);
        b.classList.add('pressed');
        if (action) this.press(action, true);
        if (cmd) this.onCommand?.(cmd);
      };
      const up = (e: PointerEvent) => {
        e.preventDefault();
        b.classList.remove('pressed');
        if (action) this.press(action, false);
      };
      b.addEventListener('pointerdown', down);
      b.addEventListener('pointerup', up);
      b.addEventListener('pointercancel', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      ui.append(b);
    };
    btn('left', '', 'left', undefined, ICONS.left);
    btn('right', '', 'right', undefined, ICONS.right);
    btn('brake', 'ГАЛЬМО', 'brake');
    btn('gas', 'ГАЗ', 'gas');
    btn('cam', '', undefined, 'camera', ICONS.cam);
    btn('reset', '', undefined, 'reset', ICONS.reset);
    btn('horn', '', undefined, 'horn', HORN_SVG);
    // Група «ще» (згорнута): фари, дзеркало, навігація, двірники, двигун (клавіші L, M, Tab, W, пробіл), а також
    // кабіна 2D / 3D і «поміняти місцями» кермо й педалі.
    const more = document.createElement('div');
    more.className = 'touch-more';
    more.hidden = true;
    btn('more', '', undefined, undefined, ICONS.more);
    const toggle = ui.lastElementChild as HTMLElement;
    toggle.addEventListener('pointerdown', () => {
      more.hidden = !more.hidden;
      toggle.classList.toggle('on', !more.hidden);
    });
    const items: [string, Command][] = [['lights', 'lights'], ['mirror', 'mirror'], ['map', 'map'], ['wipers', 'wipers'], ['engine', 'engine'], ['cab', 'cab'], ['horn', 'horn']];
    for (const [cls, cmd] of items) {
      btn(cls === 'horn' ? 'horn-in-group' : cls, '', undefined, cmd, cls === 'horn' ? HORN_SVG : ICONS[cls as keyof typeof ICONS]);
      const b = ui.lastElementChild as HTMLElement;
      b.dataset.cmd = cmd;
      more.append(b);
    }
    // Сигнал у групі — лише в розкладці бази (setBaseLayout).
    (more.querySelector('.horn-in-group') as HTMLElement).hidden = true;
    this.more = more;
    ui.append(more);
    parent.append(ui);
    this.touchUi = ui;
    return ui;
  }

  private touchUi: HTMLElement | null = null;
  private more: HTMLElement | null = null;
  private baseExtras: HTMLElement[] = [];

  /**
   * Розкладка бази (кар'єра): сигнал переходить у групу «•••» разом із group (Рейтинг), на місці сигналу — top
   * (Головне меню, Ремонт); null — звичайна (траса, тест).
   */
  setBaseLayout(layout: { group: HTMLElement[]; top: HTMLElement[] } | null): void {
    const ui = this.touchUi;
    if (!ui || !this.more) return;
    for (const e of this.baseExtras) e.remove();
    this.baseExtras = [];
    ui.classList.toggle('base-layout', !!layout);
    (this.more.querySelector('.horn-in-group') as HTMLElement).hidden = !layout;
    if (!layout) return;
    for (const e of layout.group) this.more.append(e);
    for (const e of layout.top) ui.append(e);
    this.baseExtras = [...layout.group, ...layout.top];
  }
  /** Підсвітка увімкнених функцій у групі «ще» (фари, дзеркало…); hidden — кнопку не показувати. */
  setToggle(cmd: Command, on: boolean, hidden = false): void {
    const b = this.touchUi?.querySelector<HTMLElement>(`[data-cmd="${cmd}"]`);
    if (!b) return;
    b.classList.toggle('on', on);
    b.hidden = hidden;
  }

  dispose(): void {
    window.removeEventListener('deviceorientation', this.onOrient);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
  }
}
