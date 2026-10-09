/**
 * Єдиний стан керування з різних джерел: клавіатура, сенсорні кнопки, геймпад.
 * Осі: steer −1..1 (вліво/вправо), throttle 0..1, brake 0..1.
 */
export interface ControlState {
  steer: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
}

type Action = 'left' | 'right' | 'gas' | 'brake' | 'handbrake';
type Command = 'camera' | 'reset' | 'horn' | 'autopilot';

export class Input {
  readonly state: ControlState = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  private readonly held = new Set<Action>();
  private steerSmooth = 0;
  private readonly onKey = (e: KeyboardEvent) => this.key(e);
  /** Одноразові події (перемкнути камеру, скинути вантажівку). */
  onCommand: ((cmd: Command) => void) | null = null;

  constructor() {
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKey);
  }

  private static readonly KEYS: Record<string, Action> = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'gas', KeyW: 'gas',
    ArrowDown: 'brake', KeyS: 'brake',
    Space: 'handbrake',
  };

  private key(e: KeyboardEvent): void {
    const a = Input.KEYS[e.code];
    if (a) {
      e.preventDefault();
      if (e.type === 'keydown') this.held.add(a);
      else this.held.delete(a);
    } else if (e.type === 'keydown' && !e.repeat) {
      if (e.code === 'KeyC') this.onCommand?.('camera');
      if (e.code === 'KeyR') this.onCommand?.('reset');
      if (e.code === 'KeyH') this.onCommand?.('horn');
      if (e.code === 'KeyP') this.onCommand?.('autopilot');
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
    const rate = target === 0 ? 4 : 2.5;
    this.steerSmooth += Math.sign(target - this.steerSmooth) * Math.min(Math.abs(target - this.steerSmooth), rate * dt);
    this.state.steer = padSteer || this.steerSmooth;
    this.state.throttle = Math.max(this.held.has('gas') ? 1 : 0, padGas);
    this.state.brake = Math.max(this.held.has('brake') ? 1 : 0, padBrake);
    this.state.handbrake = this.held.has('handbrake');
    return this.state;
  }

  /** Сенсорні кнопки поверх гри (мультитач через Pointer Events). */
  mountTouch(parent: HTMLElement): HTMLElement {
    const ui = document.createElement('div');
    ui.className = 'touch-ui';
    const btn = (cls: string, label: string, action?: Action, cmd?: Command) => {
      const b = document.createElement('button');
      b.className = `touch-btn ${cls}`;
      b.textContent = label;
      b.setAttribute('aria-label', cls);
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
    btn('left', '◀', 'left');
    btn('right', '▶', 'right');
    btn('brake', 'ГАЛЬМО', 'brake');
    btn('gas', 'ГАЗ', 'gas');
    btn('cam', '👁', undefined, 'camera');
    btn('reset', '↺', undefined, 'reset');
    btn('horn', '📯', undefined, 'horn');
    parent.append(ui);
    return ui;
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
  }
}
