import { parseRmp, normName } from '../engine/formats/rmp';
import { parseTxr } from '../engine/formats/txr';
import type { RgbaImage } from '../engine/formats/binary';
import type { FileSource } from '@shared/source';

/**
 * Екран завантаження світу king.exe (0x5105b0 — підготовка, 0x510690 — кадр): картинка `m16\loadpix.txr` з
 * `COMMON/ind16.RES` (у 15-бітному режимі — `m15\…` з ind15.RES) по центру чорного екрана; під нею смуга прогресу
 * `m16\loadrunner.txr` — на 0x228 = 552 px нижче верху картинки, у тих самих координатах, що й картинка; заповнюється
 * зліва направо на частку виконаного (king.exe рахує виклики кадру завантаження до очікуваних 900…4000).
 *
 * Картинка 1600×1200 (з розмитим гірським фоном), смуга 1600×97 — кольорова панорама, що відкривається поверх
 * сірої в картинці. king.exe не масштабує: на 640×480 (знімок користувача) видно лише середину — логотип на весь
 * екран. Порт: по висоті видно VIEW_H px картинки, по ширині — скільки влазить (loadScale; без розтягування
 * пропорцій), середина — по центру екрана; смуга, як у king.exe, заповнює частку ширини екрана, а не картинки.
 * Частку задає Ht2Drive.start за етапами (progress), між етапами смуга повільно повзе до наступного.
 * Файл необовʼязковий (імпорт, зроблений раніше, його не має): без нього — лише рядок стану оболонки.
 */
export class LoadScreen {
  private readonly el: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly pix: HTMLCanvasElement;
  private readonly runner: HTMLCanvasElement | null;
  /** Ширина видимої частини картинки й лівий край екрана в px картинки (fit). */
  private viewW = 0;
  private viewX = 0;
  private shown = 0;
  private target = 0;
  private ceiling = 0;
  private raf = 0;

  private constructor(pix: HTMLCanvasElement, runner: HTMLCanvasElement | null) {
    this.el = document.createElement('div');
    this.el.className = 'ht2-load';
    const stage = (this.stage = document.createElement('div'));
    stage.className = 'ht2-load-stage';
    this.pix = pix;
    pix.className = 'ht2-load-pix';
    stage.append(pix);
    this.runner = runner;
    if (runner) {
      // Смуга — у координатах картинки (king.exe), видно лише заповнену частку зліва (clip-path).
      runner.className = 'ht2-load-runner';
      runner.style.top = `${(RUNNER_Y / pix.height) * 100}%`;
      runner.style.width = `${(runner.width / pix.width) * 100}%`;
      runner.style.height = `${(runner.height / pix.height) * 100}%`;
      stage.append(runner);
    }
    this.el.append(stage);
    document.body.append(this.el);
    this.fit();
    window.addEventListener('resize', this.fit);
    this.tick();
  }

  /** Завантажене для джерела файлів (4 МБ ind16.RES читаються раз на сеанс). */
  private static readonly cache = new WeakMap<FileSource, Promise<Art | null>>();

  /** Показати екран; null — графіки немає (файл не імпортовано). */
  static async show(source: FileSource): Promise<LoadScreen | null> {
    let p = LoadScreen.cache.get(source);
    if (!p) {
      p = readArt(source);
      LoadScreen.cache.set(source, p);
      void p.then((a) => a || LoadScreen.cache.delete(source));
    }
    const art = await p;
    if (!art) return null;
    return new LoadScreen(toCanvas(art.pix), art.runner ? toCanvas(art.runner) : null);
  }

  /**
   * Етап готовий на `done` (0…1); до наступного смуга повзе не далі за `next` (уповільнюючись), щоб не стояти на
   * довгих етапах.
   */
  progress(done: number, next = done): void {
    this.target = Math.max(this.target, done);
    this.ceiling = Math.max(this.target, next);
  }

  hide(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.fit);
    this.el.remove();
  }

  private readonly fit = (): void => {
    const w = innerWidth;
    const h = innerHeight;
    const s = loadScale(w, h, this.pix.width);
    this.stage.style.width = `${this.pix.width * s}px`;
    this.stage.style.height = `${this.pix.height * s}px`;
    this.viewW = w / s;
    this.viewX = (this.pix.width - this.viewW) / 2;
  };

  private readonly tick = (): void => {
    // Повзе до межі етапу: щокадру 2 % відстані, але не повільніше, ніж уже досягнуто.
    this.target += (this.ceiling - this.target) * 0.02;
    this.shown += (this.target - this.shown) * 0.25;
    if (this.runner) {
      // Видно від лівого краю екрана до частки його ширини (king.exe 0x510690: від x = 0 до ширини екрана × частку).
      const right = Math.max(0, this.runner.width - (this.viewX + this.viewW * this.shown));
      this.runner.style.clipPath = `inset(0 ${((right / this.runner.width) * 100).toFixed(3)}% 0 0)`;
    }
    this.raf = requestAnimationFrame(this.tick);
  };
}

/** Скільки рядків картинки видно по висоті екрана: як у king.exe в режимі 640×480 (знімок користувача). */
export const VIEW_H = 480;

/**
 * Масштаб картинки (px екрана на px картинки): по висоті видно VIEW_H рядків, але не вужче за екран (широкий екран
 * показує більше боків картинки, поки вони є).
 */
export function loadScale(screenW: number, screenH: number, picW: number): number {
  return Math.max(screenH / VIEW_H, screenW / picW);
}

/** Верх смуги прогресу від верху картинки, px картинки (king.exe 0x510690: `iVar4 + 0x228`). */
export const RUNNER_Y = 0x228;

const FILE = 'COMMON/ind16.RES';
const PIX = 'm16\\loadpix.txr';
const RUNNER = 'm16\\loadrunner.txr';

interface Art {
  pix: RgbaImage;
  runner: RgbaImage | null;
}

async function readArt(source: FileSource): Promise<Art | null> {
  try {
    const res = parseRmp(await source.read(FILE));
    const pix = res.textures.get(normName(PIX));
    if (!pix) return null;
    const runner = res.textures.get(normName(RUNNER));
    return { pix: parseTxr(pix), runner: runner ? parseTxr(runner) : null };
  } catch (e) {
    console.warn(`${FILE} недоступний — без екрана завантаження`, e);
    return null;
  }
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}
