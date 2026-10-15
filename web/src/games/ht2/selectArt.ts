import { cachedSource } from '@shared/gameStore';
import type { SelectArt } from '@shared/gameContext';
import { MenuArt } from './engine/ui/menuArt';
import { PixelFont } from './engine/ui/pixelFont';
import { parseFon } from './engine/formats/fon';
import { HT2_FILES, ht2DevSource } from './files';

/** Графіка «Дальнобойщики 2» для екрана вибору гри: фон головного меню з LOAD.RES і шрифти MENU.FON / large.fon. */
export async function selectArt(): Promise<SelectArt> {
  const source = cachedSource(ht2DevSource, HT2_FILES);
  const font = (name: string) =>
    source
      .read(name)
      .then((b) => new PixelFont(parseFon(b)))
      .catch(() => null);
  const [art, small, large] = await Promise.all([MenuArt.load((n) => source.read(n)).catch(() => null), font('MENU.FON'), font('large.fon')]);
  return { background: art?.background('m/back_main.txr') ?? null, small, large };
}
