import { iniNum, type Ini } from '../engine/formats/ini';
import { gameTimeScale } from '../world/climate';
import type { Action, Command } from '../engine/input/input';

/**
 * Налаштування одиночної гри HT2 — повзунки й перемикачі екрана `s/backsing` (LOAD.RES). Початкові значення —
 * з TRUCK.INI `[EFFECTS]`, де гра зберігає їх: `trafs=100` (насиченість трас), `days=50` (тривалість доби),
 * `weats=60` (погода), `arcad=0` (аркада/симулятор; підтверджено: гра пише `arcad=1`, коли вибрати «Аркадный»).
 * Значення повзунків — 0…1.
 *
 * Усі три повзунки — як у king.exe (підказки mess 0x8b–0x8d; Docs/ht2/traffic.md «Повзунки екрана Игра»):
 * - «движение: слабое/интенсивное» (trafs = T): постійних машин dumb — N·T (GAME.CNF dumb 70), привиди — кожні
 *   2,667·15^(1 − 0,7·T) с (40 с при T = 0, 6 с при T = 1), суперників на замовленні 3…4 → 3…7; далекобійників
 *   світу (aitruck) не змінює (traffic/traffic.ts, career/competition.ts);
 * - «сутки: короткие/длинные»: доба триває days · 0,5 + 0,02 реальних годин (1,2…31,2 хв, типово 16,2);
 * - «погода: дождливо/солнечно»: ліворуч — завжди злива, з 0,8 — завжди ясно, 0,6 — дощ ≈ 20 % часу (climate.ts).
 * Діють з наступного заїзду (екран — лише в головному меню, як в оригіналі). Гіпотеза порту: аркада — удвічі менші
 * пошкодження й витрата пального.
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
  /**
   * Повзунки «Спецэффекты» і «Детальность» меню «Графіка» (TRUCK.INI [EFFECTS] grf, dtl, 0…100, типово 100) —
   * 0…1; що вмикають — ui/effects.ts.
   */
  effects: number;
  detail: number;
  /**
   * Найбільша частота кадрів (порт, на прохання користувача): 60, 40 чи 30 — менше нагріву телефона ціною плавності
   * (40 — рівно кожен третій кадр екрана 120 Гц). Перемикач — на місці вибору відеокарти меню «Графіка»
   * (ui/menuScreens.ts FPS_MODES); не задано — defaultFps(): 40 на телефоні, 60 на ПК.
   */
  fps?: number;
  /**
   * Згладжування (MSAA) з меню «Графіка» (порт, на прохання користувача): діє з перезавантаженням (рендерер створює
   * оболонка — GameModule.antialias). Не задано — як вирішить оболонка: ПК — так, телефон — ні (`ht.quality`).
   */
  antialias?: boolean;
  /**
   * Розкладка сенсорних кнопок (порт, на прохання користувача): кермо праворуч, газ і гальмо ліворуч
   * (body.swap-controls). Не задано — так і є (pedalsLeft()); перемикач — кнопка в лівій верхній групі (drive.ts).
   * Своє в HT2: спільний ключ оболонки `ht.swapControls` лишається за першою грою.
   */
  pedalsLeft?: boolean;
  /** Перепризначені клавіші з меню «Керування»: дія → KeyboardEvent.code (engine/input Input.bind). */
  keys?: Partial<Record<Action | Command, string>>;
  /** Версія збережених налаштувань (REV). */
  rev?: number;
}

const KEY = 'ht2.settings.v1';
/** Типова гучність музики — на 40 % тихіша за колишню (на прохання користувача). */
const MUSIC_QUIET = 0.6;
/** Типова загальна гучність (TRUCK.INI sfxvol=54): за неї музика звучить на своєму повзунку без поправки. */
export const SFX_REF = 0.54;
/**
 * Версія збережених налаштувань: 1 — музику зменшено на 40 %. Збережене раніше (без `rev`) — гучність музики ×0,6,
 * щоб зміна дійшла й до тих, хто вже натискав «ОК» у меню «Звук».
 */
const REV = 1;

export function defaultSettings(ini: Ini | null): Ht2Settings {
  const pct = (key: string, def: number) => Math.min(1, Math.max(0, (ini ? iniNum(ini, 'EFFECTS', key, def) : def) / 100));
  return {
    arcade: (ini ? iniNum(ini, 'EFFECTS', 'arcad', 0) : 0) !== 0,
    traffic: pct('trafs', 100),
    dayLength: pct('days', 50),
    weather: pct('weats', 60),
    sfx: pct('sfxvol', SFX_REF * 100),
    // Музика: TRUCK.INI midivol=20 на телефоні майже не чути — було не тихіше 0,35; на прохання користувача — на 40 %
    // тихіше (0,21).
    music: MUSIC_QUIET * Math.max(0.35, pct('midivol', 20)),
    engine: pct('engvol', 90),
    skid: pct('skivol', 90),
    steerSpeed: pct('sens', 50),
    steerCenter: pct('power', 50),
    force: pct('force', 50),
    automatic: true,
    xpyramid: Math.min(2, Math.max(1.2, ini ? iniNum(ini, 'EFFECTS', 'xpyramid', 1.6) : 1.6)),
    effects: pct('grf', 100),
    detail: pct('dtl', 100),
    rev: REV,
  };
}

export function loadSettings(ini: Ini | null): Ht2Settings {
  const def = defaultSettings(ini);
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return def;
    const saved = JSON.parse(s) as Partial<Ht2Settings>;
    if ((saved.rev ?? 0) < 1 && saved.music != null) saved.music = Math.round(saved.music * MUSIC_QUIET * 100) / 100;
    return { ...def, ...saved, rev: REV };
  } catch {
    return def;
  }
}

/** Згладжування зі збережених налаштувань (без TRUCK.INI — до запуску гри); null — не вибрано. */
export function savedAntialias(): boolean | null {
  try {
    const v = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Ht2Settings>).antialias;
    return typeof v === 'boolean' ? v : null;
  } catch {
    return null;
  }
}

export function saveSettings(s: Ht2Settings): void {
  try {
    // Розкладку змінює лише savePedalsLeft: копії налаштувань (меню, мережеві заїзди) могли її не бачити.
    const stored = (JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Ht2Settings>).pedalsLeft;
    localStorage.setItem(KEY, JSON.stringify(typeof stored === 'boolean' ? { ...s, pedalsLeft: stored } : s));
  } catch {
    /* приватний режим */
  }
}

/** Зберегти розкладку сенсорних кнопок (лише це поле; решта налаштувань — як збережено). */
export function savePedalsLeft(on: boolean): void {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Ht2Settings>;
    localStorage.setItem(KEY, JSON.stringify({ ...saved, pedalsLeft: on }));
  } catch {
    /* приватний режим — лише на цей сеанс */
  }
}

/** Розкладка сенсорних кнопок: чи газ і гальмо ліворуч (типово так). */
export function pedalsLeft(s: Ht2Settings | null | undefined): boolean {
  return s?.pedalsLeft ?? true;
}

/** Множник швидкості керма з повзунка 0…1: середина — 1 (як у телеметрії), краї — 0,5 і 1,5 (гіпотеза). */
export function steerGain(v: number): number {
  return 0.5 + v;
}

/** Скільки ігрових секунд за секунду реального часу (повзунок «тривалість доби»). */
export function timeScale(s: Ht2Settings | null | undefined): number {
  return gameTimeScale(s?.dayLength ?? 0.5);
}
