/**
 * Двигун і коробка передач оригіналу (HTruck.exe: 0x4aa76c, 0x4aa388, 0x4aa320, 0x4aa46c, 0x4aa4f4).
 * Формули й константи — див. re/notes/ht1/physics.md, розділ «Двигун і коробка».
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
/** Найменший проміжок між перемиканнями автомата за обертами (профіль другої гри), с. */
const SHIFT_GAP = 0.5;
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

/**
 * Відмінності двигуна й коробки гри від першої (Дальнобойщики 2 — телеметрія king.exe,
 * re/notes/ht2/telemetry.md). Без профілю — як у першій грі.
 */
export interface EngineProfile {
  /** Газ із клавіатури за часом утримання t, с; sharp — режим «різко» (Ctrl). */
  throttle?: (t: number, sharp: boolean) => number;
  /** Тривалість перемикання автоматом і на нейтраль/задню, с. */
  shiftAuto?: number;
  shiftNeutral?: number;
  /** Холості оберти, частка n₀. */
  idle?: number;
  /** Пробуксовка зчеплення дає повний газ (перша гра); у другій газ на рушанні наростає звичайно. */
  slipFullGas?: boolean;
  /**
   * Автомат за обертами (замість порівняння сил першої гри), незалежно від газу: вгору, коли оберти, звʼязані з
   * колесами, ≥ up·n₀; вниз, коли < (downA + downB / k)·n₀, де k — відношення передатних чисел нижчої й
   * поточної передачі.
   */
  shiftByRpm?: { up: number; downA: number; downB: number };
  /** На нейтраль при гальмуванні нижче цієї швидкості, м/с (перша гра — 6). */
  neutralBelow?: number;
  /** Оберти під час і після перемикання не стрибають до n₀, а йдуть до звʼязаних з колесами з цією швидкістю, об/с². */
  rpmFollow?: number;
  /** Гальмування двигуном: частка maxTorque/n₀ на оберт (перша гра — 0,1). */
  engineBrake?: number;
  /** Ширина кривої моменту exp(−(|n − n₀| / (w·n₀))⁴): перша гра — 1,5, king.exe — 1. */
  torqueWidth?: number;
}

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

  /** Скільки утримується газ, с (king.exe: зараз − [0x17d8]). */
  gasTime = 0;
  private shift: { target: number; t: number; dur: number; nStart: number; from: number } | null = null;
  /** Час після завершення перемикання (для «зчеплення»). */
  private sinceShift = Infinity;

  private readonly shiftAuto: number;
  private readonly shiftNeutral: number;

  constructor(
    readonly spec: EngineSpec,
    private readonly profile: EngineProfile = {},
  ) {
    this.n0 = spec.tachMaxPower / 60;
    this.idle = this.n0 * (profile.idle ?? 0.25);
    this.shiftAuto = profile.shiftAuto ?? SHIFT_AUTO;
    this.shiftNeutral = profile.shiftNeutral ?? SHIFT_NEUTRAL;
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
    let t = m * Math.exp(-((Math.abs(n - n0) / ((this.profile.torqueWidth ?? 1.5) * n0)) ** 4));
    if (n < n0) t *= Math.sin((Math.PI / 2) * (n / n0)) * (n / n0) ** 0.2;
    return t * this.powerFactor;
  }

  /** Гальмування двигуном (0x4aa320): лінійне за обертами. */
  engineBrake(n: number): number {
    return -(this.profile.engineBrake ?? 0.1) * (this.spec.maxTorque / this.n0) * n;
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
   * (+ уперед); wantReverse — гравець просить задній хід (стоїть і тримає гальмо); sharp — «різко» (профіль).
   */
  update(dt: number, gas: number, brake: number, wheelSpeed: number, wantReverse = false, sharp = false): void {
    // Газ наростає поступово, як у грі з клавіатури.
    this.gasTime = gas > 0 ? this.gasTime + dt : 0;
    const curve = this.profile.throttle ? this.profile.throttle(this.gasTime, sharp) : this.gasTime / (this.gasTime + THROTTLE_RAMP);
    this.throttle = gas > 0 ? gas * curve : 0;
    const stopped = Math.abs(wheelSpeed) < 0.3;

    // Вибір передачі (автомат).
    if (!this.shift) {
      if (wantReverse && stopped && this.gear !== GEAR_R) this.startShift(GEAR_R, this.shiftNeutral);
      else if (this.gear === GEAR_R && !wantReverse && gas > 0 && wheelSpeed > -2) this.startShift(2, this.shiftNeutral);
      else if (this.gear === GEAR_N && gas > 0) this.startShift(2, this.shiftNeutral);
      else if (this.gear >= 2 && brake > 0 && gas === 0 && Math.abs(wheelSpeed) < (this.profile.neutralBelow ?? 6)) this.startShift(GEAR_N, this.shiftNeutral);
      else if (this.gear >= 2 && this.profile.shiftByRpm) this.shiftByRpm(wheelSpeed, this.profile.shiftByRpm);
      else if (this.gear >= 2 && gas > 0 && this.sinceShift > CLUTCH_TIME) this.autoShift(wheelSpeed);
    }

    if (this.shift) {
      // Під час перемикання — нейтраль: тяги немає, оберти лінійно йдуть до n₀.
      const s = this.shift;
      s.t += dt;
      const k = Math.min(1, s.t / s.dur);
      // Друга гра: оберти на мить перемикання не змінюються.
      if (!this.profile.rpmFollow) this.n = k * this.n0 + (1 - k) * s.nStart;
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
      if (gas > 0 && this.profile.slipFullGas !== false) this.throttle = gas;
    } else {
      // «Зчеплення»: протягом 1 с після перемикання оберти плавно переходять від n₀ до жорсткого
      // звʼязку з колесами (сила рахується від поточних обертів — у грі вона не наростає з нуля).
      const follow = this.profile.rpmFollow;
      if (follow) this.n = Math.max(this.n + Math.max(-follow * dt, Math.min(follow * dt, locked - this.n)), this.idle);
      else {
        const b = Math.min(1, this.sinceShift / CLUTCH_TIME);
        this.n = Math.max(b * locked + (1 - b) * this.n0, this.idle);
      }
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

  /** Автомат за обертами (профіль другої гри). */
  private shiftByRpm(wheelSpeed: number, r: { up: number; downA: number; downB: number }): void {
    // Між перемиканнями — щонайменше SHIFT_GAP (у записі два поспіль вниз — через 0,65 с), інакше на межі
    // 2 → 3 вона перемикалася б туди й назад.
    if (this.sinceShift < SHIFT_GAP) return;
    const top = Math.max(2, Math.min(this.topGear, this.gearLimit));
    if (this.gear > top) return this.startShift(top, this.shiftAuto);
    const n = this.lockedN(this.gear, wheelSpeed);
    if (this.gear < top && n >= r.up * this.n0) return this.startShift(this.gear + 1, this.shiftAuto);
    if (this.gear > 2) {
      const k = this.ratios[this.gear - 1] / this.ratios[this.gear];
      if (n < (r.downA + r.downB / k) * this.n0) this.startShift(this.gear - 1, this.shiftAuto);
    }
  }

  /**
   * Передача для руху з ходу (машина трафіку стає фізичною на швидкості): з першої вгору, доки вища дає силу,
   * більшу за поточну × UPSHIFT_GAIN, — як autoShift кілька разів поспіль, але без пауз на зчеплення.
   */
  engageFor(wheelSpeed: number): void {
    const top = Math.max(2, Math.min(this.topGear, this.gearLimit));
    let g = 2;
    while (g < top && this.wheelForce(g + 1, this.lockedN(g + 1, wheelSpeed), 1) > this.wheelForce(g, this.lockedN(g, wheelSpeed), 1) * UPSHIFT_GAIN) g++;
    this.gear = g;
    this.shift = null;
    this.sinceShift = 0;
    this.n = this.lockedN(g, wheelSpeed);
  }

  /** Автомат: вгору, якщо на вищій передачі сила більша за поточну × 1,1 (0x4aa76c). */
  private autoShift(wheelSpeed: number): void {
    const current = this.wheelForce(this.gear, this.lockedN(this.gear, wheelSpeed), 1);
    let best = 0;
    let bestForce = 0;
    const top = Math.max(2, Math.min(this.topGear, this.gearLimit));
    if (this.gear > top) return this.startShift(top, this.shiftAuto);
    for (let g = this.gear + 1; g <= top; g++) {
      const f = this.wheelForce(g, this.lockedN(g, wheelSpeed), 1);
      if (f > current * UPSHIFT_GAIN && f > bestForce) {
        best = g;
        bestForce = f;
      }
    }
    if (best) return this.startShift(best, this.shiftAuto);
    // Вниз (0x4aa76c): якщо виграш у силі на нижчій передачі більший за половину максимально
    // можливого (різниця сил обох передач при n₀) — інакше на підйомі машина «застрягає» на високій.
    if (this.gear > 2) {
      const g = this.gear - 1;
      const nLow = this.lockedN(g, wheelSpeed);
      const gain = this.wheelForce(g, nLow, 1) - current;
      const maxGain = this.wheelForce(g, this.n0, 1) - this.wheelForce(this.gear, this.n0, 1);
      if (nLow < this.n0 * 2 && gain > DOWNSHIFT_SHARE * maxGain) this.startShift(g, this.shiftAuto);
    }
  }
}
