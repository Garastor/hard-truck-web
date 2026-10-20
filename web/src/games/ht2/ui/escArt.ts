import { parseRmp, normName, type RmpArchive } from '../engine/formats/rmp';
import { parseTxr } from '../engine/formats/txr';
import { parseMsk } from '../engine/formats/msk';
import { parseFon } from '../engine/formats/fon';
import { PixelFont } from '../engine/ui/pixelFont';
import type { RgbaImage } from '../engine/formats/binary';
import type { FileSource } from '@shared/source';

/**
 * Графіка інтерфейсу в дорозі з `COMMON/esc16.RES` (16-бітний набір king.exe; `esc15.RES` — те саме для 15-бітного
 * режиму): табло `m16\tablo.txr`, пейджер, картки подій `m16\mess<N>.msk`, бічні панелі `m_16\Back*.txr`, рація
 * `m_16\BackF5*`, кнопки `m_16\<імʼя>_<стан>.txr`. Яка картинка в якій ситуації — re/notes/ht2/ui.md.
 * Шрифти табло: `matrix.fon` (підписи) і `icon.fon` (цифри й значки).
 * Файл необовʼязковий: без нього лишається власний інтерфейс порту.
 */
export class EscArt {
  private readonly canvases = new Map<string, HTMLCanvasElement | null>();
  private readonly urls = new Map<string, string | null>();

  private constructor(
    private readonly res: RmpArchive,
    /** Великі рідкісні картинки, яких у res немає: довантажує ensure (normName). */
    private readonly lazy: Set<string>,
    private readonly source: FileSource,
    /** Підписи табло й тексти поверх панелей (7×12, лише великі літери). */
    readonly matrix: PixelFont | null,
    /** Цифри й значки табло (25×30): великі цифри 0x30, дрібні 0x40, значки 0x3B–0x6F. */
    readonly icon: PixelFont | null,
    /** Тексти на панелях (MENU.FON — шрифт king.exe для вікон складу, ринку, СТО). */
    readonly menu: PixelFont | null,
  ) {}

  /**
   * Довантажити великі картинки (екрани кінця гри й перемоги) перед показом: їх не тримаємо в памʼяті —
   * файл читається ще раз (лише в ці рідкісні моменти).
   */
  async ensure(...names: string[]): Promise<void> {
    const want = names.map(normName).filter((n) => this.lazy.has(n));
    if (!want.length) return;
    try {
      const full = parseRmp(await this.source.read(ESC_FILE));
      for (const n of want) {
        const tex = full.textures.get(n);
        const msk = full.masks.get(n);
        if (tex) this.res.textures.set(n, tex.slice());
        if (msk) this.res.masks.set(n, msk.slice());
        this.lazy.delete(n);
        // Запит до довантаження лишив би в кешах null.
        this.canvases.delete(n);
        this.urls.delete(n);
      }
    } catch (e) {
      console.warn(`${ESC_FILE}: не вдалося довантажити ${want.join(', ')}`, e);
    }
  }

  /** Завантажене для джерела файлів: нова гра й завантаження збереження не читають 57 МБ заново. */
  private static readonly cache = new WeakMap<FileSource, Promise<EscArt | null>>();

  static load(source: FileSource): Promise<EscArt | null> {
    let p = EscArt.cache.get(source);
    if (!p) {
      p = EscArt.read(source);
      EscArt.cache.set(source, p);
      // Без файлу — не запамʼятовувати: після імпорту файлів гри спробувати знову.
      void p.then((art) => art || EscArt.cache.delete(source));
    }
    return p;
  }

  private static async read(source: FileSource): Promise<EscArt | null> {
    try {
      const res = parseRmp(await source.read(ESC_FILE));
      const lazy = compact(res);
      const font = (n: string) => source.read(n).then((b) => new PixelFont(parseFon(b))).catch(() => null);
      const [matrix, icon, menu] = await Promise.all([font('matrix.fon'), font('icon.fon'), font('MENU.FON')]);
      return new EscArt(res, lazy, source, matrix, icon, menu);
    } catch (e) {
      console.warn('COMMON/esc16.RES недоступний — інтерфейс порту замість оригінального', e);
      return null;
    }
  }

  /** Чи є картинка (`m16\tablo.txr`, `m_16\BackGas.txr`, `m16\mess9.msk`…). */
  has(name: string): boolean {
    const n = normName(name);
    return this.res.textures.has(n) || this.res.masks.has(n) || this.lazy.has(n);
  }

  /** Картинка як canvas (кешується; не вставляти той самий у DOM двічі — для DOM є url). */
  canvas(name: string): HTMLCanvasElement | null {
    const n = normName(name);
    if (!this.canvases.has(n)) {
      const tex = this.res.textures.get(n);
      const msk = this.res.masks.get(n);
      this.canvases.set(n, tex ? toCanvas(parseTxr(tex)) : msk ? toCanvas(parseMsk(msk)) : null);
    }
    return this.canvases.get(n)!;
  }

  /** Кнопка `<base>_<state>.txr` — графіка оригіналу (написи на картинках не перекладаються). */
  buttonUrl(base: string, state: string): string | null {
    return this.url(`${base}_${state}.txr`);
  }

  /** Картинка як data URL для `<img>` (кешується). */
  url(name: string): string | null {
    const n = normName(name);
    if (!this.urls.has(n)) this.urls.set(n, this.canvas(n)?.toDataURL() ?? null);
    return this.urls.get(n)!;
  }
}

const ESC_FILE = 'COMMON/esc16.RES';

/** Великі рідкісні картинки (кінець гри BackLoose*, перемога BackWin* — ≈ 31 МБ з 57) — не тримати, а довантажувати. */
const LAZY = /^m_16[\\/]back(loose|win)/i;

/**
 * Копії потрібних шматків замість переглядів у буфер файлу (оптимізація памʼяті для телефона): інакше весь
 * 57-МБ файл лишався в памʼяті, доки жива графіка. Великі рідкісні картинки — прибрати; повертає їхні імена.
 */
function compact(res: RmpArchive): Set<string> {
  const lazy = new Set<string>();
  for (const map of [res.palettes, res.sounds, res.backgrounds, res.masks, res.textures]) {
    for (const [n, v] of map) {
      if ((map === res.textures || map === res.masks) && LAZY.test(n)) {
        map.delete(n);
        lazy.add(n);
      } else map.set(n, v.slice());
    }
  }
  return lazy;
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}
