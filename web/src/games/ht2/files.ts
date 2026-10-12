import { matchRequired, type FileSet } from '../../assets/gameFiles';
import type { FileSource } from '../../assets/loader';

/**
 * Файли Дальнобойщиків 2 на пристрої. На телефон беремо полегшені набори текстур (`*1.res`: ті самі імена й
 * матеріали, текстури вдвічі менші) — разом ≈ 150 МБ замість ≈ 530 МБ гри (без відео, музики, повних текстур).
 */

/** Регіони світу (`ENV/<код>.b3d`, `.way`, `<код>1.res`). */
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

/** Набір текстур: '' — повний, '1' — половинний (за замовчуванням), '2' — чверть. */
export type TexLevel = '' | '1' | '2';

export function regionFiles(region: string, tex: TexLevel = '1', dir = 'ENV'): { b3d: string; res: string; way: string } {
  return { b3d: `${dir}/${region}.b3d`, res: `${dir}/${region}${tex}.res`, way: `${dir}/${region}.way` };
}

export const HT2_REQUIRED: string[] = [
  ...HT2_REGIONS.flatMap((r) => Object.values(regionFiles(r))),
  'ENV/GAME.CNF',
  'MENV/dr.b3d', 'MENV/dr1.res', 'MENV/dr.way', 'MENV/GAME.CNF',
  'MTR/tr.b3d', 'MTR/tr1.res', 'MTR/tr.way', 'MTR/GAME.CNF', 'MTR/terrain0.raw', 'MTR/terrain1.raw', 'MTR/terrain2.raw',
  'MTB/tb.b3d', 'MTB/tb1.res',
  'COMMON/COMMON.B3D', 'COMMON/common1.res', 'COMMON/COMMON.OVL',
  'COMMON/TRUCKS.B3D', 'COMMON/TRUCKS1.RES', 'COMMON/TRUCKS1.OVL',
  'COMMON/CABINES.B3D', 'COMMON/CABINES1.RES', 'COMMON/CABINES1.OVL',
  'vehicle.tech', 'LOAD.RES', 'load.ovl', 'TRUCK.INI', 'WEATHER.INI', 'mess.txt',
  'MENU.FON', 'LARGE.FON', 'icon.fon', 'menublk.fon', 'matrix.fon',
  'merchandise.sch', 'evehicles.sch', 'etrashboxes.sch', 'names.sch', 'restable.sch', 'vd.sch', 'Ms.sch',
];

/** Музика (≈ 29 МБ) — імпортується, якщо є, але гра без неї повна. */
export const HT2_MUSIC = Array.from({ length: 12 }, (_, i) => `MUSIC/track${String(i + 1).padStart(2, '0')}l.mp3`);

export const HT2_FILES: FileSet = {
  game: 'ht2',
  required: HT2_REQUIRED,
  prefix: 'ht2/',
  canonical: (path) => matchRequired(HT2_REQUIRED, path) ?? matchRequired(HT2_MUSIC, path),
};

/** Dev-сервер ПК: файли HT2 за `/game2/` (vite.config.ts). */
export const ht2DevSource: FileSource = {
  async read(path) {
    const res = await fetch(`/game2/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error(`Не вдалося завантажити ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};
