import { parseRmp, type RmpArchive } from '../../formats/rmp';
import { parseTxr } from '../../formats/txr';
import type { RgbaImage } from '../../formats/binary';
import type { PixelFont } from '../../ui/pixelFont';
import '../select.css';
import './ht2.css';

/**
 * Меню Дальнобойщиків 2 з їхнього LOAD.RES: фони 800×600 (`m/back_main.txr` — головне), сцена вписується у вікно,
 * як і меню першої гри. Пункти — написи шрифтом гри (LARGE.FON) у чорному полі поруч із колом фону.
 * Розкладку кнопок оригіналу ще не відновлено (гіпотеза: пункти малюються кодом поверх фону) — див. G6 у
 * Docs/08-ht2-plan.md.
 */
export class Ht2MenuArt {
  private constructor(readonly res: RmpArchive) {}

  static async load(read: (name: string) => Promise<Uint8Array>): Promise<Ht2MenuArt | null> {
    try {
      return new Ht2MenuArt(parseRmp(await read('LOAD.RES')));
    } catch (e) {
      console.warn('HT2 LOAD.RES недоступний', e);
      return null;
    }
  }

  background(name: string): HTMLCanvasElement | null {
    const b = this.res.textures.get(name);
    return b ? toCanvas(parseTxr(b)) : null;
  }
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

const W = 800;
const H = 600;

export interface MenuItem {
  label: string;
  action: () => void | Promise<void>;
  disabled?: boolean;
}

/** Екран меню HT2: фон + стовпчик пунктів праворуч; повертає функцію закриття. */
export function ht2MenuScreen(art: Ht2MenuArt | null, font: PixelFont | null, items: MenuItem[], note?: string): () => void {
  const root = document.createElement('div');
  root.className = 'menu-screen ht2-menu';
  const stage = document.createElement('div');
  stage.className = 'menu-stage ht2-stage';
  root.append(stage);
  const bg = art?.background('m/back_main.txr');
  if (bg) stage.append(bg);

  // Пункти — великі цілі для пальця: шрифт ×3, крок 52 px сцени (на телефоні 812×375 — ≈ 22 px тексту).
  const x = 598;
  let y = 150;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'menu-abs ht2-item';
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.setAttribute('aria-label', it.label);
    if (it.disabled) b.classList.add('disabled');
    if (font) {
      const c = document.createElement('canvas');
      const text = it.label.toUpperCase();
      c.width = font.measure(text) + 2;
      c.height = font.height + 2;
      font.draw(c.getContext('2d')!, text, 1, 1, 'rgb(240,220,138)');
      c.className = 'ht2-item-text';
      c.style.width = `${c.width * 3}px`;
      c.style.height = `${c.height * 3}px`;
      b.append(c);
    } else b.textContent = it.label;
    b.addEventListener('click', () => {
      if (!it.disabled) void it.action();
    });
    stage.append(b);
    y += 52;
  }
  if (note) {
    const n = document.createElement('div');
    n.className = 'menu-abs menu-note';
    n.style.left = '16px';
    n.style.top = `${H - 40}px`;
    n.style.fontSize = '20px';
    n.textContent = note;
    stage.append(n);
  }
  const fit = () => {
    const s = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  };
  window.addEventListener('resize', fit);
  fit();
  document.body.append(root);
  document.body.classList.add('in-menu');
  return () => {
    window.removeEventListener('resize', fit);
    root.remove();
    document.body.classList.remove('in-menu');
  };
}
