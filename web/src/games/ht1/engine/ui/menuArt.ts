import { parseRmp, type RmpArchive } from '../formats/rmp';
import { parseTxr } from '../formats/txr';
import { parseMsk } from '../formats/msk';
import { parsePlm } from '../formats/plm';
import type { RgbaImage } from '../formats/binary';

/** Графіка меню оригіналу з LOAD.RES (обидві гри): фони (txr) і маски кнопок (msk, палітра архіву). */
export class MenuArt {
  private readonly palette: Uint8Array | undefined;
  private constructor(private readonly res: RmpArchive) {
    const plm = [...res.palettes.values()][0];
    this.palette = plm ? parsePlm(plm).palette : undefined;
  }

  static async load(read: (name: string) => Promise<Uint8Array>): Promise<MenuArt | null> {
    try {
      return new MenuArt(parseRmp(await read('LOAD.RES')));
    } catch (e) {
      console.warn('LOAD.RES недоступний — меню без графіки оригіналу', e);
      return null;
    }
  }

  private canvasOf(img: RgbaImage): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return c;
  }

  background(name: string): HTMLCanvasElement | null {
    const b = this.res.textures.get(name);
    return b ? this.canvasOf(parseTxr(b)) : null;
  }

  mask(name: string): HTMLCanvasElement | null {
    const b = this.res.masks.get(name);
    return b ? this.canvasOf(parseMsk(b, this.palette)) : null;
  }
}
