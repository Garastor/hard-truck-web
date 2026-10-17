/**
 * Доба й погода Дальнобойщиків 2 — поведінка обʼєкта `weatherandtime` king.exe (re/notes/ht2/weather.md).
 *
 * Час: доба триває `timetemp` реальних годин, timetemp = повзунок «тривалість доби» (меню «Игра», 0…1) · 0,5 + 0,02
 * (типово 0,5 → 16,2 хв). Сонце: фаза (година − 2)/24, висота s = 0,5 − cos(2π·фаза) (−0,5…1,5; найвище о 14:00).
 *
 * Погода: показник w (0 — ясно, 1 — злива) від двох повільних кутів θ₁ (оберт за `wtemp` реальних годин, TRUCK.INI
 * 0,13 → 7,8 хв) і θ₂ (у 5,7 раза повільніше) та повзунка погоди S. Від w — «негода» кольорів, дощ, грім, вітер,
 * калюжі.
 */
const TAU = Math.PI * 2;

/** Ігрових секунд за реальну: доба = timetemp реальних годин. */
export function gameTimeScale(dayLength = 0.5): number {
  return 24 / (dayLength * 0.5 + 0.02);
}

/** Фаза доби 0…1 (0 — 2:00, найтемніше). */
export function dayPhase(hour: number): number {
  return ((((hour - 2) / 24) % 1) + 1) % 1;
}

/** Висота сонця −0,5…1,5 (0 — 6:00 і 22:00). */
export function sunHeight(hour: number): number {
  return 0.5 - Math.cos(TAU * dayPhase(hour));
}

/** «Денність» для меж туману: 0 о 2:00 → 1 о 14:00 → 0, лінійно. */
export function dayFactor(hour: number): number {
  const p = 2 * dayPhase(hour);
  return p > 1 ? 2 - p : p;
}

/**
 * Напрям на сонце в координатах гри (z угору), виміряно телеметрією king.exe (2026-10-18): простір `sun_s0`, у
 * якому лежить `sun_lamp` (світить уздовж −y простору), будує 0x005a6ad0 — вектор (0, 1, 0), повернутий на підйом
 * e = s·π/5 навколо x і на азимут a = −2π·фаза навколо z: (−sin a·cos e, cos a·cos e, sin e), переведений у простір
 * камери. Вектор погоди +0x22c (cos a·cos e, sin a·cos e, sin e) на світло не йде — він повернутий на 90°.
 * О 8:00 сонце на сході (+x), о 14:00 — на півдні (−y), о 20:00 — на заході.
 */
export function sunDirection(hour: number): [number, number, number] {
  const a = -TAU * dayPhase(hour);
  const e = sunHeight(hour) * (Math.PI / 5);
  return [-Math.sin(a) * Math.cos(e), Math.cos(a) * Math.cos(e), Math.sin(e)];
}

/**
 * Нічні вікна `ILLUM_LEVEL_00…15` (гілки моделей міст): поріг рівня v; 00…07 горять ввечері (21,5+v … 23,5+v) і
 * вранці (4,5+v … 6,5+v), 08…15 — усю ніч (з 21,5+v до 4,5+v).
 */
const ILLUM = [0.1, 0.6, 0.8, 0.3, 0.5, 0.4, 0.9, 0.7, 0.7, 0.8, 0.9, 0.4, 0.5, 0.3, 0.6, 0.5];
export function illumOn(level: number, hour: number): boolean {
  const v = ILLUM[level];
  if (v === undefined) return false;
  const a = 21.5 + v;
  if (level < 8) return (hour > a && hour < a + 2) || (hour > a - 17 && hour < a - 15);
  return hour > a || hour < a - 17;
}

/** Трафік вмикає фари при появі з 22:00 до 6:00. */
export function trafficLights(hour: number): boolean {
  return hour > 22 || hour < 6;
}

/** Фари гравця й відблиски на дорозі в оригіналі — уночі (22:00…5:00) або на мокрій дорозі. */
export function nightGlows(hour: number): boolean {
  return hour > 22 || hour < 5;
}

export class Climate {
  /** Кути погоди (рад). */
  th1: number;
  th2 = 0;
  /** Реальний час, с (пориви вітру, грім). */
  t = 0;
  /** Примусова погода (тест: `?weather=bad|good`): сталий показник w. */
  private readonly fixed: number | null;

  constructor(
    /** Повзунок погоди 0…1 (типово 0,6): що більший, то частіше негода. */
    private readonly slider = 0.6,
    /** TRUCK.INI wtemp — період зміни погоди, реальних годин. */
    private readonly wtemp = 0.13,
    forced: 'good' | 'bad' | null = null,
  ) {
    // Початковий кут — wstart·2π, wstart = S·0,25 (TRUCK.INI wstart гра перезаписує повзунком).
    this.th1 = slider * 0.25 * TAU;
    this.fixed = forced === 'bad' ? 0.9 : forced === 'good' ? 0 : null;
  }

  update(realDt: number): void {
    this.t += realDt;
    if (this.fixed !== null) return;
    const d = (realDt * TAU) / (this.wtemp * 3600);
    this.th1 = (this.th1 + d) % TAU;
    this.th2 = (this.th2 + d * 0.17544) % TAU;
  }

  /** Показник погоди; lag — запізнення фази θ₁ (калюжі). */
  w(lag = 0): number {
    if (this.fixed !== null) return this.fixed;
    const c = 1 - 2 * this.slider;
    const v = 0.5 * (Math.sin(this.th1 - Math.PI / 2 - lag) * (1 - Math.abs(c)) * (1 + 0.3 * Math.sin(this.th2)) + c + 1);
    return Math.min(1, Math.max(0, v));
  }

  /** Частка набору «bad» у кольорах і тумані: з w > 0,5. */
  get bad(): number {
    return Math.max(0, 2 * (this.w() - 0.5));
  }

  get rain(): boolean {
    return this.w() > 0.7;
  }

  get thunder(): boolean {
    return this.w() >= 0.8;
  }

  /** Гучність шуму дощу (w − 0,7, множник набору — 1). */
  get rainVolume(): number {
    return Math.max(0, this.w() - 0.7);
  }

  /** Гучність шуму вітру: 2(w/4 − 0,1) з w > 0,4. */
  get windVolume(): number {
    return Math.max(0, 2 * (this.w() * 0.25 - 0.1));
  }

  /** Вітер 0…6 (дерева): кожні 6 с одні 2 с — порив (×3, у дощ 2 → 4). */
  get wind(): number {
    const w = this.w();
    const gust = Math.floor(this.t * 0.5) % 3 === 0;
    if (w > 0.7) return gust ? 4 : 2;
    if (w <= 0.2) return 0;
    const v = w <= 0.65 ? (w - 0.2) * 13.333 : 6 - (w - 0.65) * 80;
    return gust ? v * 3 : v;
  }

  /** Мокрість дороги 0…1: як дощ, але з запізненням фази до π/4 (мокне й висихає пізніше). */
  get puddles(): number {
    const lag = this.th1 > Math.PI / 2 ? Math.min(this.th1 - Math.PI / 2, Math.PI / 4) : 0;
    const v = (this.w(lag) - 0.7) * 3.3333;
    return Math.sqrt(Math.min(1, Math.max(0, v)));
  }
}
