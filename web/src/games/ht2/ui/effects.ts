import { setStaticSwitch } from '../engine/render/sceneBuilder';

/**
 * Повзунки «Спецэффекты» (g = grf/100) і «Детальность» (d = dtl/100) меню «Графіка» — пороги king.exe
 * (re/notes/ht2/menu-screens.md §1а; прапорці 0x4b91a0: ефект є, коли g і d більші за свої пороги). Читають місця
 * створення ефектів; задає меню (app.ts, Ht2Settings effects/detail).
 */
export interface Fx {
  g: number;
  d: number;
}

let cur: Fx = { g: 1, d: 1 };

export function fx(): Fx {
  return cur;
}

export function setFx(g: number, d: number): void {
  cur = { g, d };
  // Деталізація моделей і неба (0x512920): GeometryKey = 2 − ⌊dtl/35⌋ — діє на моделі, зібрані після зміни.
  setStaticSwitch('refer_GeometryKey', geometryKey(d));
}

/** Гілка refer_GeometryKey: dtl 0…34 → 2 (найпростіше, небо sky_min), 35…69 → 1, 70…100 → 0 (найдетальніше). */
export function geometryKey(d: number): number {
  return Math.max(0, Math.min(2, 2 - Math.floor(Math.round(d * 100) / 35)));
}

/** Краплі на склі CDrops (0x696044): g > 0,5 і d > 0,2. */
export const glassDrops = (): boolean => cur.g > 0.5 && cur.d > 0.2;
/** Фари чужих машин (0x696040, setLampValue): g > 0,5 і d > 0,5. */
export const trafficHeadlights = (): boolean => cur.g > 0.5 && cur.d > 0.5;
/** Дощ і сніг частинками CRain/CSnow (0x696060, 0x696080): g > 0,5 і d > 0,5. */
export const precipitation = (): boolean => cur.g > 0.5 && cur.d > 0.5;
/** Світло від вогню ThrowLamp (0x4d9cd0): g > 0,5. */
export const fireLight = (): boolean => cur.g > 0.5;
/**
 * Імовірність клубу диму чи вогню за кадр: g + base, не більше 1 — дим і вогонь пошкодженої машини base 0,2
 * (0x4ba660), обʼєктів, що горять чи вибухають, — 0,1 (0x4ba310, 0x4ba520, 0x4ba8a0, 0x4baae0).
 */
export const smokeChance = (base: number): number => Math.min(1, cur.g + base);
