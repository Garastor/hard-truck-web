import { iniNum, type Ini } from '../engine/formats/ini';
import { gameTimeScale } from '../world/climate';

/**
 * Налаштування одиночної гри HT2 — повзунки й перемикачі екрана `s/backsing` (LOAD.RES). Початкові значення —
 * з TRUCK.INI `[EFFECTS]`, де гра зберігає їх: `trafs=100` (насиченість трас), `days=50` (тривалість доби),
 * `weats=60` (погода), `arcad=0` (аркада/симулятор; підтверджено: гра пише `arcad=1`, коли вибрати «Аркадный»).
 * Значення повзунків — 0…1.
 *
 * Доба й погода — як у king.exe (climate.ts, re/notes/ht2/weather.md): доба триває days · 0,5 + 0,02 реальних
 * годин (типово 16,2 хв), погода — що вищий повзунок, то частіше негода. Гіпотези порту: трафік — частка найбільшої
 * кількості машин довкола (12 легкових, 4 далекобійники); аркада — удвічі менші пошкодження й витрата пального.
 */
export interface Ht2Settings {
  arcade: boolean;
  traffic: number;
  dayLength: number;
  weather: number;
  /**
   * Меню Esc «Звук» (king.exe 0x516ea0; TRUCK.INI [EFFECTS] sfxvol, midivol, engvol, skivol, 0…100): ефекти, музика,
   * двигун, заноси — 0…1.
   */
  sfx: number;
  music: number;
  engine: number;
  skid: number;
  /**
   * Меню Esc «Керування» (0x517530; [EFFECTS] sens, power, force, autgb): чутливість і центрування керма, віддача
   * (кермо з віддачею; у порті не діє), автоматична коробка (порт — лише автомат). 0…1, середина — як телеметрія.
   */
  steerSpeed: number;
  steerCenter: number;
  force: number;
  automatic: boolean;
  /**
   * Ширина піраміди огляду (TRUCK.INI [EFFECTS] xpyramid, king.exe 0x5972d0 → рендерер +0x58; клавішами 1,2…2,0):
   * тангенс половини горизонтального кута — xpyramid/2, для всіх камер.
   */
  xpyramid: number;
  /**
   * Роздільність з меню «Графіка» (king.exe 0x515ca0: 640×480 / 800×600 / 1024×768 / 1600×1200) — висота кадру
   * рендерера (ui/menuScreens.ts RESOLUTION_H); не задано — як вирішить оболонка (якість).
   */
  resolution?: number;
}

const KEY = 'ht2.settings.v1';

export function defaultSettings(ini: Ini | null): Ht2Settings {
  const pct = (key: string, def: number) => Math.min(1, Math.max(0, (ini ? iniNum(ini, 'EFFECTS', key, def) : def) / 100));
  return {
    arcade: (ini ? iniNum(ini, 'EFFECTS', 'arcad', 0) : 0) !== 0,
    traffic: pct('trafs', 100),
    dayLength: pct('days', 50),
    weather: pct('weats', 60),
    sfx: pct('sfxvol', 54),
    // Музика: TRUCK.INI midivol=20 на телефоні майже не чути — не тихіше 35 (як раніше в music.ts).
    music: Math.max(0.35, pct('midivol', 20)),
    engine: pct('engvol', 90),
    skid: pct('skivol', 90),
    steerSpeed: pct('sens', 50),
    steerCenter: pct('power', 50),
    force: pct('force', 50),
    automatic: true,
    xpyramid: Math.min(2, Math.max(1.2, ini ? iniNum(ini, 'EFFECTS', 'xpyramid', 1.6) : 1.6)),
  };
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

/** Множник швидкості керма з повзунка 0…1: середина — 1 (як у телеметрії), краї — 0,5 і 1,5 (гіпотеза). */
export function steerGain(v: number): number {
  return 0.5 + v;
}

/** Скільки ігрових секунд за секунду реального часу (повзунок «тривалість доби»). */
export function timeScale(s: Ht2Settings | null | undefined): number {
  return gameTimeScale(s?.dayLength ?? 0.5);
}
