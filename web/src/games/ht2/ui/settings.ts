import { iniNum, type Ini } from '@engine/formats/ini';
import { gameTimeScale } from '../world/climate';

/**
 * Налаштування одиночної гри HT2 — повзунки й перемикачі екрана `s/backsing` (LOAD.RES). Початкові значення —
 * з TRUCK.INI `[EFFECTS]`, де гра зберігає їх: `trafs=100` (насиченість трас), `days=50` (тривалість доби),
 * `weats=60` (погода), `arcad=0` (аркада/симулятор; підтверджено: гра пише `arcad=1`, коли вибрати «Аркадный»).
 * Значення повзунків — 0…1.
 *
 * Доба й погода — як у king.exe (climate.ts, re/notes/ht2-weather.md): доба триває days · 0,5 + 0,02 реальних
 * годин (типово 16,2 хв), погода — що вищий повзунок, то частіше негода. Гіпотези порту: трафік — частка найбільшої
 * кількості машин довкола (12 легкових, 4 далекобійники); аркада — удвічі менші пошкодження й витрата пального.
 */
export interface Ht2Settings {
  arcade: boolean;
  traffic: number;
  dayLength: number;
  weather: number;
}

const KEY = 'ht2.settings.v1';

export function defaultSettings(ini: Ini | null): Ht2Settings {
  const pct = (key: string, def: number) => Math.min(1, Math.max(0, (ini ? iniNum(ini, 'EFFECTS', key, def) : def) / 100));
  return { arcade: (ini ? iniNum(ini, 'EFFECTS', 'arcad', 0) : 0) !== 0, traffic: pct('trafs', 100), dayLength: pct('days', 50), weather: pct('weats', 60) };
}

export function loadSettings(ini: Ini | null): Ht2Settings {
  const def = defaultSettings(ini);
  try {
    const s = localStorage.getItem(KEY);
    return s ? { ...def, ...(JSON.parse(s) as Partial<Ht2Settings>) } : def;
  } catch {
    return def;
  }
}

export function saveSettings(s: Ht2Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* приватний режим */
  }
}

/** Скільки ігрових секунд за секунду реального часу (повзунок «тривалість доби»). */
export function timeScale(s: Ht2Settings | null | undefined): number {
  return gameTimeScale(s?.dayLength ?? 0.5);
}
