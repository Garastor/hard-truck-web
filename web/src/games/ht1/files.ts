import { parseB3d, type B3d } from '@engine/formats/b3d';
import { parseRmp, type RmpArchive } from '@engine/formats/rmp';
import { httpSource, type FileSource } from '@shared/source';
import { idbSourceFor, matchRequired, type FileSet } from '@shared/gameStore';
import { CAB2D_DIR, CAB2D_RAIN_FILES, CAB2D_SOURCE, extractCab2d } from './cab2d/cab2dFiles';

/** Локації гри: тека, сцена/ресурси для апаратного рендеру (*2.B3D + *3.RMP) і програмного (*.B3D + *.RMP). */
export const LEVELS = {
  CIRCUIT: { dir: 'CIRCUIT', hw: ['CIRC2.B3D', 'CIRC3.RMP'], sw: ['CIRC.B3D', 'CIRC.RMP'] },
  COUNT: { dir: 'COUNT', hw: ['COUNT2.B3D', 'COUNT3.RMP'], sw: ['COUNT.B3D', 'COUNT.RMP'] },
  MOUNT: { dir: 'MOUNT', hw: ['MOUNT2.B3D', 'MOUNT3.RMP'], sw: ['MOUNT.B3D', 'MOUNT.RMP'] },
  NIGHT: { dir: 'NIGHT', hw: ['NIGHT2.B3D', 'NIGHT3.RMP'], sw: ['NIGHT.B3D', 'NIGHT.RMP'] },
  TRIAL: { dir: 'TRIAL', hw: ['TRIAL2.B3D', 'TRIAL3.RMP'], sw: ['TRIAL.B3D', 'TRIAL.RMP'] },
  MENU3D: { dir: 'MENU3D', hw: ['MENU3D2.B3D', 'MENU3D3.RMP'], sw: ['MENU3D.B3D', 'MENU3D.RMP'] },
} as const;
export type LevelId = keyof typeof LEVELS;

/** Dev-сервер ПК: файли першої гри за `/game/` (vite.config.ts). */
export const devServerSource: FileSource = httpSource('/game/');

export interface LoadedLevel {
  id: LevelId;
  b3d: B3d;
  rmp: RmpArchive;
}

export async function loadLevel(src: FileSource, id: LevelId, mode: 'hw' | 'sw' = 'hw'): Promise<LoadedLevel> {
  const lvl = LEVELS[id];
  const [b3dName, rmpName] = lvl[mode];
  const [b3dBytes, rmpBytes] = await Promise.all([src.read(`${lvl.dir}/${b3dName}`), src.read(`${lvl.dir}/${rmpName}`)]);
  return { id, b3d: parseB3d(b3dBytes), rmp: parseRmp(rmpBytes) };
}

/** Канонічні шляхи потрібних файлів (лише апаратний набір + техніка, ≈ 66 МБ). */
export const REQUIRED: string[] = [
  ...Object.values(LEVELS).flatMap((l) => l.hw.map((f) => `${l.dir}/${f}`)),
  'TRUCK.TCH',
  'LOAD.RES',
  'MENU.FON',
  'large.fon',
];

/** Зіставляє довільний шлях з архіву/теки з канонічним (без урахування регістру, за останніми сегментами). */
export function canonical(path: string): string | null {
  // Витягнуті маски 2D-кабіни (див. cab2d/cab2dFiles.ts) — під власними іменами.
  if (path.startsWith(CAB2D_DIR)) return path;
  return matchRequired(REQUIRED, path);
}

/**
 * Набір файлів першої гри на пристрої: без префікса (як до появи другої гри); з архіву програмного набору
 * COUNT/COUNT.RMP при імпорті беремо лише маски 2D-кабіни, файли її дощу — у підрахунку «Опцій».
 */
export const HT1_FILES: FileSet<'ht1'> = {
  game: 'ht1',
  required: REQUIRED,
  prefix: '',
  canonical,
  extract: {
    match: (path) => path.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/').toUpperCase() === CAB2D_SOURCE,
    run: extractCab2d,
  },
  extras: CAB2D_RAIN_FILES,
};

/** Файли першої гри з IndexedDB. */
export const idbSource: FileSource = idbSourceFor(HT1_FILES);
