import { parseB3d, type B3d } from '@engine/formats/b3d';
import { parseRmp, type RmpArchive } from '@engine/formats/rmp';

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

/** Звідки брати файли гри. Зараз — dev-сервер (/game/...); у Фазі 7 — OPFS з імпортованих файлів. */
export interface FileSource {
  read(path: string): Promise<Uint8Array>;
}

export const devServerSource: FileSource = {
  async read(path) {
    const res = await fetch(`/game/${path.split('/').map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error(`Не вдалося завантажити ${path}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
};

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
