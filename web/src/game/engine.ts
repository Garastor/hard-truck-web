/**
 * Двигун і коробка передач оригіналу (HTruck.exe: 0x4aa76c, 0x4aa388, 0x4aa320, 0x4aa46c, 0x4aa4f4).
 * Формули й константи — див. re/notes/physics.md, розділ «Двигун і коробка».
 *
 * Одиниці як в оригіналі: оберти — об/с (n₀ = tach_with_max_power / 60), момент — Н·м, сила — Н.
 * Нумерація передач оригіналу: 0 — R, 1 — N, 2 — перша, 3 — друга…
 */

export interface EngineSpec {
  /** maxrotmomentum, Н·м. */
  maxTorque: number;
  /** tach_with_max_power, об/хв. */
  tachMaxPower: number;
  rearAxle: number;
  /** reverse_trans_coeff (відʼємне). */
  reverse: number;
  /** gear_trans_coeff1..N. */
  gears: number[];
  wheelRadius: number;
}

/** Тривалість перемикання: автомат (0x243), на нейтраль (0x244), с. */
const SHIFT_AUTO = 0.3;
const SHIFT_NEUTRAL = 0.1;
/** Після перемикання оберти й сила плавно «зчіплюються» з колесами (0x246), с. */
const CLUTCH_TIME = 1.0;
/** Вгору, якщо сила на вищій передачі > поточна × 1,1. */
const UPSHIFT_GAIN = 1.1;
/** Вниз, якщо виграш у силі > 0,5 від максимального (константа 0x548832). */
const DOWNSHIFT_SHARE = 0.5;
/**
 * Пробуксовка зчеплення (0x4aa1c0): поки оберти, звʼязані з колесами, нижчі за 0,5·n₀ (або колеса
 * крутяться проти передачі), газ — повний (телеметрія s6: [0x339] = 1,0 до ≈ 0,8 м/с), а двигун тримає
 * оберти CLUTCH_SLIP_N·n₀ (гіпотеза: точне значення в оригіналі не розібране).
 */
const CLUTCH_SLIP_BELOW = 0.5;
const CLUTCH_SLIP_N = 0.75;
/** Газ із клавіатури: g = t / (t + 1,2). */
const THROTTLE_RAMP = 1.2;

export const GEAR_R = 0;
export const GEAR_N = 1;

export class Engine {
  /** Поточна передача (нумерація оригіналу). */
  gear = GEAR_N;
  /** Оберти, об/с. */
  n: number;
  /** Сила тяги на всіх ведучих колесах, Н (відʼємна — гальмування двигуном). */
  force = 0;
  /** Ефективний газ 0…1 (після наростання). */
  throttle = 0;
  /** Пошкодження: множник моменту й найвища доступна передача (див. damageEffects у career.ts). */
  powerFactor = 1;
  gearLimit = Infinity;

  readonly n0: number;
  readonly idle: number;
  /** Передатні числа «двигун → колесо» за передачами (з головною передачею). */
  readonly ratios: number[];

  private gasTime = 0;
  private shift: { target: number; t: number; dur: number; nStart: number; from: number } | null = null;
  /** Час після завершення перемикання (для «зчеплення»). */
  private sinceShift = Infinity;

  constructor(readonly spec: EngineSpec) {
    this.n0 = spec.tachMaxPower / 60;
    this.idle = this.n0 * 0.25;
    this.n = this.idle;
    this.ratios = [spec.rearAxle * spec.reverse, 0, ...spec.gears.map((g) => spec.rearAxle * g)];
  }

  get topGear(): number {
    return this.ratios.length - 1;
  }

  get rpm(): number {
    return this.n * 60;
  }

  /** Йде перемикання (у грі в цей час передача — нейтраль). */
  get shifting(): boolean {
    return this.shift !== null;
  }

  /** Передача, яку показує гра: під час перемикання — нейтраль. */
  get displayGear(): number {
    return this.shift ? GEAR_N : this.gear;
  }

  /** Момент двигуна на повному газі (0x4aa388). */
  torque(n: number): number {
    const { maxTorque: m } = this.spec;
    const n0 = this.n0;
    n = Math.max(n, 0.1 * n0);
    let t = m * Math.exp(-((Math.abs(n - n0) / (1.5 * n0)) ** 4));
    if (n < n0) t *= Math.sin((Math.PI / 2) * (n / n0)) * (n / n0) ** 0.2;
    return t * this.powerFactor;
  }

  /** Гальмування двигуном (0x4aa320): лінійне за обертами. */
  engineBrake(n: number): number {
    return -0.1 * (this.spec.maxTorque / this.n0) * n;
  }

  /** Сила на колесах для передачі g при обертах n і газі g (0x4aa46c + 0x4aa4f4). */
  wheelForce(gear: number, n: number, gas: number): number {
    const te = gas * this.torque(n) + (1 - gas) * this.engineBrake(n);
    return (te * this.ratios[gear]) / this.spec.wheelRadius;
  }

  /** Оберти двигуна, жорстко повʼязаного з колесами (0x4aa120). */
  lockedN(gear: number, wheelSpeed: number): number {
    return (Math.abs(wheelSpeed) / (2 * Math.PI * this.spec.wheelRadius)) * Math.abs(this.ratios[gear]);
  }

  /**
   * Крок. gas/brake — входи 0…1 (клавіатура — 0/1); wheelSpeed — лінійна швидкість ведучих коліс, м/с
   * (+ уперед); wantReverse — гравець просить задній хід (стоїть і тримає гальмо).
   */
  update(dt: number, gas: number, brake: number, wheelSpeed: number, wantReverse = false): void {
    // Газ наростає поступово, як у грі з клавіатури.
    this.gasTime = gas > 0 ? this.gasTime + dt : 0;
    this.throttle = gas > 0 ? gas * (this.gasTime / (this.gasTime + THROTTLE_RAMP)) : 0;
    const stopped = Math.abs(wheelSpeed) < 0.3;

    // Вибір передачі (автомат).
    if (!this.shift) {
      if (wantReverse && stopped && this.gear !== GEAR_R) this.startShift(GEAR_R, SHIFT_NEUTRAL);
      else if (this.gear === GEAR_R && !wantReverse && gas > 0 && wheelSpeed > -2) this.startShift(2, SHIFT_NEUTRAL);
      else if (this.gear === GEAR_N && gas > 0) this.startShift(2, SHIFT_NEUTRAL);
      else if (this.gear >= 2 && brake > 0 && gas === 0 && Math.abs(wheelSpeed) < 6) this.startShift(GEAR_N, SHIFT_NEUTRAL);
      else if (this.gear >= 2 && gas > 0 && this.sinceShift > CLUTCH_TIME) this.autoShift(wheelSpeed);
    }

    if (this.shift) {
      // Під час перемикання — нейтраль: тяги немає, оберти лінійно йдуть до n₀.
      const s = this.shift;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      this.n = k * this.n0 + (1 - k) * s.nStart;
      this.force = 0;
      if (s.t >= s.dur) {
        this.gear = s.target;
        this.shift = null;
        this.sinceShift = 0;
      }
      return;
    }

    if (this.gear === GEAR_N) {
      // Нейтраль: оберти тягнуться до холостих (з газом — вгору).
      const target = this.idle + this.throttle * (this.n0 * 2.5 - this.idle);
      this.n += (target - this.n) * Math.min(1, dt * 3);
      this.force = 0;
      return;
    }

    this.sinceShift += dt;
    // Оберти, жорстко звʼязані з колесами; відʼємні — колеса крутяться проти передачі (котимось назад).
    const ratio = this.ratios[this.gear];
    const locked = ((wheelSpeed * Math.sign(ratio)) / (2 * Math.PI * this.spec.wheelRadius)) * Math.abs(ratio);
    const slipLimit = CLUTCH_SLIP_BELOW * this.n0;
    if (locked < slipLimit) {
      // Пробуксовка зчеплення: повний газ, оберти між «зчепленими» і робочими.
      const f = Math.max(0, locked) / slipLimit;
      this.n = Math.max(this.idle, f * Math.max(0, locked) + (1 - f) * CLUTCH_SLIP_N * this.n0);
      if (gas > 0) this.throttle = gas;
    } else {
      // «Зчеплення»: протягом 1 с після перемикання оберти плавно переходять від n₀ до жорсткого
      // звʼязку з колесами (сила рахується від поточних обертів — у грі вона не наростає з нуля).
      const b = Math.min(1, this.sinceShift / CLUTCH_TIME);
      this.n = Math.max(b * locked + (1 - b) * this.n0, this.idle);
    }
    this.force = this.wheelForce(this.gear, this.n, this.throttle);
  }

  /** Стан як після запуску двигуна: нейтраль, холості оберти. */
  reset(): void {
    this.gear = GEAR_N;
    this.n = this.idle;
    this.force = 0;
    this.throttle = 0;
    this.gasTime = 0;
    this.shift = null;
    this.sinceShift = Infinity;
  }

  private startShift(target: number, dur: number): void {
    this.shift = { target, t: 0, dur, nStart: this.n, from: this.gear };
  }

  /** Автомат: вгору, якщо на вищій передачі сила більша за поточну × 1,1 (0x4aa76c). */
  private autoShift(wheelSpeed: number): void {
    const current = this.wheelForce(this.gear, this.lockedN(this.gear, wheelSpeed), 1);
    let best = 0;
    let bestForce = 0;
    const top = Math.max(2, Math.min(this.topGear, this.gearLimit));
    if (this.gear > top) return this.startShift(top, SHIFT_AUTO);
    for (let g = this.gear + 1; g <= top; g++) {
      const f = this.wheelForce(g, this.lockedN(g, wheelSpeed), 1);
      if (f > current * UPSHIFT_GAIN && f > bestForce) {
        best = g;
        bestForce = f;
      }
    }
    if (best) return this.startShift(best, SHIFT_AUTO);
    // Вниз (0x4aa76c): якщо виграш у силі на нижчій передачі більший за половину максимально
    // можливого (різниця сил обох передач при n₀) — інакше на підйомі машина «застрягає» на високій.
    if (this.gear > 2) {
      const g = this.gear - 1;
      const nLow = this.lockedN(g, wheelSpeed);
      const gain = this.wheelForce(g, nLow, 1) - current;
      const maxGain = this.wheelForce(g, this.n0, 1) - this.wheelForce(this.gear, this.n0, 1);
      if (nLow < this.n0 * 2 && gain > DOWNSHIFT_SHARE * maxGain) this.startShift(g, SHIFT_AUTO);
    }
  }
}
