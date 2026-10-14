import { matchRequired, type FileSet } from '@engine/assets/gameStore';
import { httpSource, type FileSource } from '@engine/assets/source';

/**
 * Файли Дальнобойщиків 2 на пристрої. Текстури — повні набори (`<код>.res`, `COMMON.RES`, `TRUCKS.RES`…; на
 * прохання користувача: половинні `*1.res` зблизька розмиті, особливо дерева). Половинні лишаються запасними
 * (readTextures): імпортовані раніше файли працюють, доки не імпортовано повні.
 */

/** Регіони світу (`ENV/<код>.b3d`, `.way`, `<код>.res`). */
export const HT2_REGIONS = [
  'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'aj', 'ak', 'al', 'am', 'ap', 'aq', 'ar', 'as', 'at', 'au', 'av', 'aw',
  'ax', 'ba', 'bb', 'bc', 'bd', 'be', 'bf', 'bg', 'ca', 'cb', 'cc', 'ce', 'cf', 'ch', 'da', 'db', 'dc', 'dq', 'dr',
] as const;
export type Ht2Region = (typeof HT2_REGIONS)[number];

/** Траси: кільце (MENV), полігон з картою висот (MTR), тестовий майданчик (MTB). */
export const HT2_TRACKS = {
  MENV: 'dr',
  MTR: 'tr',
  MTB: 'tb',
} as const;

/** Набір текстур: '' — повний (за замовчуванням), '1' — половинний, '2' — чверть. */
export type TexLevel = '' | '1' | '2';

export function regionFiles(region: string, tex: TexLevel = '', dir = 'ENV'): { b3d: string; res: string; way: string } {
  return { b3d: `${dir}/${region}.b3d`, res: `${dir}/${region}${tex}.res`, way: `${dir}/${region}.way` };
}

export const HT2_REQUIRED: string[] = [
  ...HT2_REGIONS.flatMap((r) => Object.values(regionFiles(r))),
  'ENV/GAME.CNF',
  'MENV/dr.b3d', 'MENV/dr.res', 'MENV/dr.way', 'MENV/GAME.CNF',
  'MTR/tr.b3d', 'MTR/tr.res', 'MTR/tr.way', 'MTR/GAME.CNF', 'MTR/terrain0.raw', 'MTR/terrain1.raw', 'MTR/terrain2.raw',
  'MTB/tb.b3d', 'MTB/tb.res',
  'COMMON/COMMON.B3D', 'COMMON/COMMON.RES', 'COMMON/COMMON.OVL',
  'COMMON/TRUCKS.B3D', 'COMMON/TRUCKS.RES', 'COMMON/TRUCKS1.OVL',
  'COMMON/CABINES.B3D', 'COMMON/CABINES.RES', 'COMMON/CABINES1.OVL',
  'vehicle.tech', 'LOAD.RES', 'load.ovl', 'TRUCK.INI', 'WEATHER.INI', 'mess.txt',
  'MENU.FON', 'LARGE.FON', 'icon.fon', 'menublk.fon', 'matrix.fon',
  'merchandise.sch', 'evehicles.sch', 'etrashboxes.sch', 'names.sch', 'restable.sch', 'vd.sch', 'Ms.sch',
];

/** Музика (≈ 29 МБ) — імпортується, якщо є, але гра без неї повна. */
export const HT2_MUSIC = Array.from({ length: 12 }, (_, i) => `MUSIC/track${String(i + 1).padStart(2, '0')}l.mp3`);

/**
 * Описи регіонів `ENV/mod_<код>.sch` (міста й товари складів, СТО з переліком покращень, вказівники, засідки) —
 * є не в усіх регіонах. Необовʼязкові: без них економіка бере назви міст зі знаків і всі товари.
 */
export const HT2_MOD_REGIONS = [
  'aa', 'ab', 'ac', 'ad', 'ae', 'af', 'ag', 'ah', 'aj', 'ak', 'al', 'am', 'ap', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax',
  'ba', 'bb', 'bc', 'bd', 'bf', 'bg', 'ca', 'cb', 'cc', 'ce', 'cf', 'ch', 'da', 'db', 'dc', 'dq',
];
export const HT2_MODS = HT2_MOD_REGIONS.map((r) => `ENV/mod_${r}.sch`);

/** Повний набір текстур → половинний (запасний, імпортований раніше). */
export function halfTextures(path: string): string {
  if (/^COMMON\/COMMON\.RES$/i.test(path)) return 'COMMON/common1.res';
  return path.replace(/(\.res)$/i, (m) => `1${m}`);
}

/** Половинні набори текстур — необовʼязкові, запасні для повних. */
export const HT2_HALF_TEX = HT2_REQUIRED.filter((f) => /\.res$/i.test(f) && f !== 'LOAD.RES').map(halfTextures);

/** Повний набір текстур; якщо його ще не імпортовано — половинний. */
export async function readTextures(source: FileSource, path: string): Promise<Uint8Array> {
  try {
    return await source.read(path);
  } catch (e) {
    const half = halfTextures(path);
    if (half === path) throw e;
    return source.read(half);
  }
}

export const HT2_FILES: FileSet<'ht2'> = {
  game: 'ht2',
  required: HT2_REQUIRED,
  prefix: 'ht2/',
  canonical: (path) => matchRequired(HT2_REQUIRED, path) ?? matchRequired(HT2_MUSIC, path) ?? matchRequired(HT2_MODS, path) ?? matchRequired(HT2_HALF_TEX, path),
};

/** Dev-сервер ПК: файли HT2 за `/game2/` (vite.config.ts). */
export const ht2DevSource: FileSource = httpSource('/game2/');
