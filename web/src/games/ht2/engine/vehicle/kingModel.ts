/**
 * Рух вантажівки Дальнобойщиків 2 — формули king.exe (реверс В1, re/notes/ht2/physics.md, «Сили й інтегрування»).
 * Власна реалізація за описом, код оригіналу не копіювався.
 *
 * Звичайна їзда в оригіналі — не динаміка твердого тіла з шинами, а кінематична модель: поворот — кутова швидкість
 * v·sin δ / L, сили коліс — лише поздовжні в межах «тертя × навантаження», швидкість щокроку спрямовується вздовж
 * курсу (бічного ковзання немає), схил тягне з половиною дотичної складової ваги, коли всі колеса на землі.
 */

export const KING = {
  /** Кут керованих коліс на повному кермі, рад (45°). */
  steerMax: 0.7854,
  g: 9.8,
  /** Усі колеса на землі — дотична складова ваги × 0,5. */
  slope: 0.5,
  /** Швидкість — уздовж курсу, лише якщо нормаль ґрунту n_z ≥ 0,8 (схил < ≈ 37°). */
  flat: 0.8,
  /** Опір кочення за замовчуванням. */
  rolling: 0.01,
  /** Сила гальма колеса — 1,5 × статичного навантаження × педаль. */
  brakeLoad: 1.5,
  /** Педаль гальма діє понад 0,1. */
  brakeFrom: 0.1,
  /** Колесо блокується (гальмо переважає зчеплення) лише понад 1 м/с. */
  lockSpeed: 1,
  /** До суми сил зчеплення ведучих коліс — щоб не ділити на нуль. */
  driveEps: 0.01,
};

/**
 * Межа керма гравця: |s| ≤ min(1, 1,5·atan(μ·k·L/v²)) — не повернути більше, ніж дозволяє зчеплення (на |v| < 0,1 —
 * без межі). μ — середнє зчеплення коліс на землі, L — колісна база, k — множник (поле [0x263c]; гіпотеза — g).
 */
export function steerLimit(v: number, mu: number, base: number, k: number): number {
  const s = Math.abs(v);
  if (s < 0.1) return 1;
  return Math.min(1, 1.5 * Math.atan((mu * k * base) / (s * s)));
}

/** Кутова швидкість повороту навколо нормалі ґрунту, рад/с: v_fwd·sin δ / L (знак — за напрямом руху й керма). */
export function yawRate(vFwd: number, delta: number, base: number): number {
  return (vFwd * Math.sin(delta)) / base;
}

/**
 * Опір кочення колеса, Н: f_r·N з плавним наростанням від нуля на малій швидкості (в оригіналі — φ(v), φ(0) = 0,
 * сталі якого не прочитано; лінійно до 1 м/с — гіпотеза).
 */
export function rollingForce(load: number, v: number, fr = KING.rolling): number {
  return fr * load * Math.min(1, Math.abs(v));
}

export interface KingWheel {
  /** Колесо торкається ґрунту. */
  ground: boolean;
  driven: boolean;
  /** Навантаження N, Н. */
  load: number;
  /** Зчеплення μ. */
  mu: number;
  /** Найбільша сила гальма (1,5 × статичного навантаження), Н. */
  brake: number;
}

/** Стан колеса після кроку: 0 — котиться, 1 — пробуксовує, −1 — заблоковане гальмом. */
export type WheelSlip = -1 | 0 | 1;

/**
 * Поздовжні сили коліс («коло тертя» по одному напряму). drive — сила двигуна на всіх ведучих, Н (+ уперед за
 * передачею); pedal — гальмо 0…1; vFwd — швидкість уздовж курсу, м/с. Сила тяги ділиться між ведучими пропорційно
 * їхньому зчепленню (F_max = μ·N); гальмо — проти руху; сума колеса не більша за F_max: тяга більша — пробуксовка
 * (сила = F_max), гальмо більше — блокування (сила F_max проти руху). Повертає суму сил уздовж курсу (без кочення).
 */
export function wheelForces(wheels: readonly KingWheel[], drive: number, pedal: number, vFwd: number, slip?: WheelSlip[]): number {
  let grip = KING.driveEps;
  for (const w of wheels) if (w.ground && w.driven) grip += w.mu * w.load;
  const dir = Math.abs(vFwd) > 0.05 ? Math.sign(vFwd) : Math.sign(drive) || 1;
  let total = 0;
  wheels.forEach((w, i) => {
    if (slip) slip[i] = 0;
    if (!w.ground) return;
    const max = w.mu * w.load;
    const d = w.driven ? (max * drive) / grip : 0;
    const b = pedal > KING.brakeFrom ? w.brake * pedal : 0;
    const net = d - b * dir;
    if (Math.abs(net) <= max) {
      total += net;
      return;
    }
    if (Math.abs(d) >= b) {
      total += Math.sign(net) * max;
      if (slip) slip[i] = 1;
    } else {
      total -= dir * max;
      if (slip && Math.abs(vFwd) > KING.lockSpeed) slip[i] = -1;
    }
  });
  return total;
}
