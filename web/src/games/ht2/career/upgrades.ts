import { isList, num, type SExpr } from '../formats/sexpr';

/**
 * Покращення вантажівки HT2 (`restable.sch`): `(PR_ID (Назва-без 0) (Назва варіанта ціна) …)` — перший варіант —
 * «немає» за 0, далі варіанти з ціною (у шин — два: шосейні й позашляхові). Назви англійські й без лапок (слова —
 * окремі символи), останнє число — ціна, $.
 *
 * Дія — за king.exe (re/notes/ht2/upgrades.md): кожне покращення — «система техстану» зі своїми min…max на рівень
 * (0x520000). Знос систем (гальма, шини, двигун) порт не моделює — береться нова деталь (стан 1).
 */
export interface Upgrade {
  /** `PR_ID:варіант` — ключ у збереженні. */
  key: string;
  id: string;
  option: number;
  /** Назва з restable.sch (англ.). */
  original: string;
  name: string;
  effect: string;
  price: number;
}

/** Покращення: назва українською й опис дії (king.exe, upgrades.md). */
const KNOWN: Record<string, { name: string; effect: string }> = {
  'PR_FORCED_ENGINE:1': { name: 'Форсований двигун', effect: 'момент двигуна ×1,4' },
  'PR_OIL_ADDITIVE:1': { name: 'Присадка в масло', effect: 'момент ×1,25, витрата пального −20 %' },
  'PR_ABS:1': { name: 'АБС', effect: 'колеса не буксують: газ не більше 0,81 межі зчеплення' },
  'PR_ADJUSTABLE_SUSPENSION:1': { name: 'Пневмопідвіска', effect: 'шкода вантажу від ударів ×0,3' },
  'PR_BRAKES:1': { name: 'Вентильовані гальма', effect: 'повільніше зношуються (сила нових та сама)' },
  'PR_ENGINE_BRAKE:1': { name: 'Гальмо двигуном', effect: 'з педаллю гальма двигун гальмує до ×3' },
  'PR_REINFORCED_CHASSIS:1': { name: 'Посилена рама', effect: 'сила ударів ×0,3' },
  'PR_BULETPROOF_GLASS:1': { name: 'Броньоване скло', effect: 'шкода й займання від куль ×0,2' },
  'PR_TIRES:1': { name: 'Шосейні шини', effect: 'зчеплення на асфальті 0,6 → 0,8' },
  'PR_TIRES:2': { name: 'Шини «вездеход»', effect: 'зчеплення поза дорогою 0,55 → 0,8' },
  'PR_HORN:1': { name: 'Сигнал', effect: 'гучніший сигнал' },
  'PR_EXTRA_TANK:1': { name: 'Додатковий бак', effect: 'бак ×2' },
  'PR_ANTI_RADAR:1': { name: 'Антирадар', effect: 'попереджає про пост з радаром' },
  'PR_HEADLIGHT_PROTECTION:1': { name: 'Захист фар', effect: 'вмʼятини переду ×0,2' },
  'PR_FIRE_PROTECTION:1': { name: 'Протипожежна система', effect: 'гасить пожежу через 5 с, 4 рази' },
  'PR_AIR_FILTER_SNORKEL:1': { name: 'Повітрозабірник', effect: 'у воду можна заїхати на 1 м глибше' },
  'PR_CARGO_SCANNER:1': { name: 'Сканер вантажу', effect: 'видно прихований товар і крадену чи вживану машину' },
};

/**
 * all — усі покращення (вікно СТО оригіналу показує повний перелік; дія в порту — лише в KNOWN, решта поки лише
 * записується в збереження), інакше — лише з дією в порту.
 */
export function parseUpgrades(sch: SExpr[], all = false): Upgrade[] {
  const out: Upgrade[] = [];
  for (const e of sch) {
    if (!isList(e) || typeof e[0] !== 'string') continue;
    const id = e[0];
    e.slice(1).forEach((opt, i) => {
      if (!isList(opt) || !opt.length) return;
      const key = `${id}:${i}`;
      const known = KNOWN[key];
      const price = num(opt[opt.length - 1]);
      if ((!known && !all) || price <= 0 || id === 'PR_FUEL') return;
      const original = opt.slice(0, -1).map(String).join(' ');
      out.push({ key, id, option: i, original, name: known?.name ?? original, effect: known?.effect ?? '', price });
    });
  }
  return out;
}

/** Дія встановлених покращень на машину й кар'єру (king.exe, upgrades.md; нові деталі — стан 1). */
export interface Tuning {
  /** Множник моменту двигуна: форсований A = 1,4·M, присадка — дільник B = 0,8 (T ∝ A/B). */
  torque: number;
  /** Сила гальм (вентильовані нові — ті самі, 1). */
  brakes: number;
  /** Множник витрати пального (присадка B = 0,8). */
  fuel: number;
  /** Варіант шин: 0 — звичайні, 1 — шосейні, 2 — позашляхові (ряд таблиці μ, tireMu). */
  tires: 0 | 1 | 2;
  tank: number;
  /** Посилена рама: імпульс удару ×0,3 (усі наслідки удару). */
  damage: number;
  /** Пневмопідвіска: шкода вантажу від удару ×0,3. */
  cargo: number;
  /** Захист фар: деформація зон переду ×0,2. */
  front: number;
  /** Скло g: шкода й займання від куль ×g (броньоване 0,2). */
  glass: number;
  /** ABS — антипробуксовка (0x4ffc1c). */
  antiSpin: boolean;
  /** Гальмо двигуном: E/c_f = 2 (0x507360). */
  engineBrake: number;
  /** Сигнал із покращенням — hornupgrSound. */
  horn: boolean;
  antiRadar: boolean;
  /** Фарба Stealth — пости й камери міліції не бачать машину (king.exe 0x4d1360). */
  stealth: boolean;
}

export function tuning(owned: readonly string[] = []): Tuning {
  const has = (k: string) => owned.includes(k);
  return {
    torque: (has('PR_FORCED_ENGINE:1') ? 1.4 : 1) * (has('PR_OIL_ADDITIVE:1') ? 1 / 0.8 : 1),
    brakes: 1,
    fuel: has('PR_OIL_ADDITIVE:1') ? 0.8 : 1,
    tires: has('PR_TIRES:2') ? 2 : has('PR_TIRES:1') ? 1 : 0,
    tank: has('PR_EXTRA_TANK:1') ? 2 : 1,
    damage: has('PR_REINFORCED_CHASSIS:1') ? 0.3 : 1,
    cargo: has('PR_ADJUSTABLE_SUSPENSION:1') ? 0.3 : 1,
    front: has('PR_HEADLIGHT_PROTECTION:1') ? 0.2 : 1,
    glass: has('PR_BULETPROOF_GLASS:1') ? 0.2 : 1,
    antiSpin: has('PR_ABS:1'),
    engineBrake: has('PR_ENGINE_BRAKE:1') ? 2 : 0,
    horn: has('PR_HORN:1'),
    antiRadar: has('PR_ANTI_RADAR:1'),
    stealth: has('PR_STEALTH_BODY_PAINT:1'),
  };
}

/**
 * Зчеплення μ за поверхнею (king.exe 0x501fb0, ряд = погода + 2·варіант шин): поверхні 1…13; у порту асфальт —
 * поверхня 1, узбіччя — 2 (гіпотеза: тип поверхні за матеріалом не знайдено).
 */
const TIRE_MU: Record<0 | 1 | 2, [number[], number[]]> = {
  0: [
    [0.6, 0.55, 0.3, 0.3, 0.45, 0.45, 0.3, 0.45, 0.2, 0.6, 0.45, 0, 0],
    [0.5, 0.35, 0.3, 0.3, 0.4, 0.35, 0.3, 0.35, 0.2, 0.5, 0.35, 0, 0],
  ],
  1: [
    [0.8, 0.6, 0.2, 0.3, 0.8, 0.45, 0.3, 0.45, 0.2, 0.7, 0.7, 0, 0],
    [0.7, 0.35, 0.2, 0.3, 0.7, 0.35, 0.3, 0.35, 0.2, 0.5, 0.25, 0, 0],
  ],
  2: [
    [0.6, 0.8, 0.4, 0.3, 0.5, 0.5, 0.3, 0.45, 0.2, 0.5, 0.8, 0, 0],
    [0.5, 0.8, 0.4, 0.4, 0.45, 0.5, 0.3, 0.5, 0.2, 0.5, 0.8, 0, 0],
  ],
};

/**
 * Множник зчеплення шин відносно звичайних на тій самій поверхні в ту саму погоду: модель руху вже має μ і
 * дощовий множник для звичайних шин (узбіччя в порту — як асфальт, не виміряно), тож тут — лише відношення
 * μ[варіант][погода][поверхня] / μ[0][погода][поверхня]; без покращення — 1.
 */
export function tireGrip(tires: 0 | 1 | 2, rain: boolean, surface: number): number {
  const w = rain ? 1 : 0;
  const base = TIRE_MU[0][w][surface - 1];
  return base > 0 ? TIRE_MU[tires][w][surface - 1] / base : 1;
}

/** Купівля: варіанти одного покращення взаємовиключні (шини), повторно той самий — ні. */
export function install(owned: readonly string[], u: Upgrade): string[] {
  return [...owned.filter((k) => !k.startsWith(`${u.id}:`)), u.key];
}
