import * as THREE from 'three';
import { iniGet, iniNum, iniNums, parseIni, type Ini } from '../engine/formats/ini';
import { dayFactor, dayPhase, sunHeight } from './climate';

/**
 * Погода й світло Дальнобойщиків 2 (`WEATHER.INI`): набори [WEATHER1…8] (5 — техн. тунель, 6 — гори, 7 — рельєф,
 * 8 — тунель-копанка), у кожному — для «доброї» (good) і «поганої» (bad) погоди та пори доби (night, srise, day,
 * sset): колір туману `fog_*`, світло `sunenv_*` (сонце на довкілля), розсіяне `envamb_*`, небо `skyamb_*`,
 * `sunsky_*`/`suncld_*` (сонце на небі й хмарах), `moon_*`; межі туману `fogn_*`/`fogf_*` і `frpl_*` (лише для
 * day/night). Ключа немає — 0 0 0 (як у грі: уночі немає сонця, вдень — місяця).
 *
 * Змішування — як у king.exe (re/notes/ht2/weather.md): пора — за висотою сонця s (ніч до −0,2, сутінки — 0, день від
 * 0,2; сонце `sunenv` — 0…0,05), сутінки до 14:00 — srise, після — sset; good ↔ bad — за «негодою» b 0…1.
 * Звичайна погода — WEATHER1; спецнабори 5…8 підмішує кімната (подія `weather_change`, world/weatherRooms.ts):
 * X = (1 − k)·звичайна + k·спецнабір для всіх кольорів і меж туману (king.exe 0x5a8e90, 0x5a9240; k < 0,01 — 0,
 * > 0,99 — 1). Добової зміни WEATHER1→2→3→4 (0x5a9540) порт ще не робить.
 */
export type Sky = 'good' | 'bad';
export type DayTime = 'night' | 'srise' | 'day' | 'sset';

export interface Light {
  fog: THREE.Color;
  fogNear: number;
  fogFar: number;
  /** Сонце на довкілля (пряме світло), місяць і розсіяне світло. */
  sun: THREE.Color;
  moon: THREE.Color;
  ambient: THREE.Color;
  /** Небо (king.exe 0x005a7b50): skyamb — розсіяне (sky_env), sunsky — купол від сонця (sky_lamp), suncld — хмари (sky_lamp1). */
  sky: THREE.Color;
  sunsky: THREE.Color;
  suncld: THREE.Color;
}

/** Година, що відповідає пові доби (для огляду світу з вибором пори). */
export const DAY_TIME_HOUR: Record<DayTime, number> = { night: 2, srise: 6, day: 14, sset: 22 };

type Rgb = [number, number, number];

export class Weather {
  private readonly cache = new Map<string, Rgb>();

  constructor(private readonly ini: Ini) {}

  static parse(text: string): Weather {
    return new Weather(parseIni(text));
  }

  private rgb(set: number, key: string): Rgb {
    const k = `${set}:${key}`;
    let c = this.cache.get(k);
    if (!c) {
      const v = iniNums(this.ini, `WEATHER${set}`, key) ?? [0, 0, 0];
      c = [(v[0] ?? 0) / 255, (v[1] ?? 0) / 255, (v[2] ?? 0) / 255];
      this.cache.set(k, c);
    }
    return c;
  }

  /** Колір ключа за висотою сонця s, фазою (сутінки — srise чи sset) і негодою b. */
  private mix(set: number, key: string, s: number, phase: number, b: number, lo = -0.2, hi = 0.2): Rgb {
    const tw: DayTime = phase <= 0.5 ? 'srise' : 'sset';
    const one = (sky: Sky): Rgb => {
      const night = this.rgb(set, `${key}_${sky}night`);
      const twi = this.rgb(set, `${key}_${sky}${tw}`);
      const day = this.rgb(set, `${key}_${sky}day`);
      if (s > hi) return day;
      if (s < lo) return night;
      const mid = (lo + hi) / 2;
      const [a, c, k] = s > mid ? [twi, day, (s - mid) / (hi - mid)] : [twi, night, (mid - s) / (mid - lo)];
      return [a[0] + (c[0] - a[0]) * k, a[1] + (c[1] - a[1]) * k, a[2] + (c[2] - a[2]) * k];
    };
    const g = one('good');
    const bd = one('bad');
    return [g[0] + (bd[0] - g[0]) * b, g[1] + (bd[1] - g[1]) * b, g[2] + (bd[2] - g[2]) * b];
  }

  /** Межа туману: good/bad × ніч/день, змішані за b і «денністю» d. */
  private dist(set: number, key: string, b: number, d: number, def: [number, number, number, number]): number {
    const s = `WEATHER${set}`;
    const bn = iniNum(this.ini, s, `${key}_badnight`, def[0]);
    const bdy = iniNum(this.ini, s, `${key}_badday`, def[1]);
    const gn = iniNum(this.ini, s, `${key}_goodnight`, def[2]);
    const gd = iniNum(this.ini, s, `${key}_goodday`, def[3]);
    return d * (b * bdy + (1 - b) * gd) + (1 - d) * (b * bn + (1 - b) * gn);
  }

  /**
   * Прапорці набору (king.exe 0x5a7b50, маска 0x6fca38): rain, sun, thund; немає ключа — on. rain=off гасить краплі
   * на склі й двірники, thund=off — спалах блискавки.
   */
  flags(set: number): { rain: boolean; sun: boolean; thund: boolean } {
    const on = (k: string) => (iniGet(this.ini, `WEATHER${set}`, k) ?? 'on').trim().toLowerCase() !== 'off';
    return { rain: on('rain'), sun: on('sun'), thund: on('thund') };
  }

  /** Світло на годину доби (0…24) і негоду b (0…1); special — спецнабір кімнати з вагою k. */
  at(hour: number, b: number, set = 1, special?: { set: number; k: number }): Light {
    const k = special && special.set ? (special.k < 0.01 ? 0 : special.k > 0.99 ? 1 : special.k) : 0;
    if (k === 0) return this.one(hour, b, set);
    const sp = this.one(hour, b, special!.set);
    if (k === 1) return sp;
    const base = this.one(hour, b, set);
    const c = (a: THREE.Color, s: THREE.Color) => a.clone().lerp(s, k);
    const n = (a: number, s: number) => a + (s - a) * k;
    return {
      fog: c(base.fog, sp.fog),
      fogNear: n(base.fogNear, sp.fogNear),
      fogFar: n(base.fogFar, sp.fogFar),
      sun: c(base.sun, sp.sun),
      moon: c(base.moon, sp.moon),
      ambient: c(base.ambient, sp.ambient),
      sky: c(base.sky, sp.sky),
      sunsky: c(base.sunsky, sp.sunsky),
      suncld: c(base.suncld, sp.suncld),
    };
  }

  private one(hour: number, b: number, set: number): Light {
    const s = sunHeight(hour);
    const ph = dayPhase(hour);
    const c = (v: Rgb) => new THREE.Color().setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace);
    const d = dayFactor(hour);
    // Колір туману в грі змішується з подвоєною негодою (палітра, індекс 8).
    return {
      fog: c(this.mix(set, 'fog', s, ph, Math.min(1, 2 * b))),
      fogNear: this.dist(set, 'fogn', b, d, [20, 50, 500, 800]),
      fogFar: this.dist(set, 'fogf', b, d, [100, 250, 800, 1300]),
      sun: c(this.mix(set, 'sunenv', s, ph, b, 0, 0.05)),
      moon: c(this.mix(set, 'moon', s, ph, b)),
      ambient: c(this.mix(set, 'envamb', s, ph, b)),
      sky: c(this.mix(set, 'skyamb', s, ph, b)),
      sunsky: c(this.mix(set, 'sunsky', s, ph, b)),
      suncld: c(this.mix(set, 'suncld', s, ph, b)),
    };
  }

  /** Світло пори доби (огляд світу): good — b = 0, bad — 1. */
  light(set = 1, sky: Sky = 'good', time: DayTime = 'day'): Light {
    return this.at(DAY_TIME_HOUR[time], sky === 'bad' ? 1 : 0, set);
  }
}
