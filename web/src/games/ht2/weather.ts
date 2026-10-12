import * as THREE from 'three';
import { iniNum, iniNums, parseIni, type Ini } from '../../formats/ini';

/**
 * Погода й світло Дальнобойщиків 2 (`WEATHER.INI`): набори [WEATHER1…8] (5 — техн. тунель, 6 — гори, 7 — рельєф,
 * 8 — тунель-копанка), у кожному — для «доброї» (good) і «поганої» (bad) погоди та пори доби (night, srise, day,
 * sset): колір туману `fog_*`, близь/далечінь туману `fogn_*`/`fogf_*` (лише для day/night), світло `sunenv_*`
 * (сонце на довкілля), розсіяне `envamb_*`, небо `skyamb_*`, `sunsky_*`/`suncld_*` (сонце на небі й хмарах),
 * `moon_*`. Яка погода в якому регіоні — подія кімнати `weather_change` (ще не розібрано; гіпотеза: WEATHER1).
 */
export type Sky = 'good' | 'bad';
export type DayTime = 'night' | 'srise' | 'day' | 'sset';

export interface Light {
  fog: THREE.Color;
  fogNear: number;
  fogFar: number;
  /** Сонце на довкілля (пряме світло) і розсіяне світло. */
  sun: THREE.Color;
  ambient: THREE.Color;
  sky: THREE.Color;
}

export class Weather {
  constructor(private readonly ini: Ini) {}

  static parse(text: string): Weather {
    return new Weather(parseIni(text));
  }

  light(set = 1, sky: Sky = 'good', time: DayTime = 'day'): Light {
    const s = `WEATHER${set}`;
    const rgb = (key: string, def: number[]) => {
      const v = iniNums(this.ini, s, `${key}_${sky}${time}`) ?? def;
      return new THREE.Color().setRGB((v[0] ?? 0) / 255, (v[1] ?? 0) / 255, (v[2] ?? 0) / 255, THREE.SRGBColorSpace);
    };
    // Межі туману є лише для дня й ночі; світанок і захід — як день.
    const ft = time === 'night' ? 'night' : 'day';
    return {
      fog: rgb('fog', [200, 200, 200]),
      fogNear: iniNum(this.ini, s, `fogn_${sky}${ft}`, 250),
      fogFar: iniNum(this.ini, s, `fogf_${sky}${ft}`, 900),
      sun: time === 'night' ? rgb('moon', [0, 0, 0]) : rgb('sunenv', [255, 255, 255]),
      ambient: rgb('envamb', [128, 128, 128]),
      sky: rgb('skyamb', [200, 200, 200]),
    };
  }
}
