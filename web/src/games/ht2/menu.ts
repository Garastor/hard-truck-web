import { parseRmp, type RmpArchive } from '../../formats/rmp';
import { parseTxr } from '../../formats/txr';
import type { RgbaImage } from '../../formats/binary';
import type { PixelFont } from '../../ui/pixelFont';
import type { Ht2Settings } from './settings';
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

  /** Зображення кнопки (стан — суфікс `_p`, `_a`…); кешується. */
  private readonly cache = new Map<string, string | null>();
  image(name: string): string | null {
    if (!this.cache.has(name)) {
      const c = this.background(name);
      this.cache.set(name, c ? c.toDataURL() : null);
    }
    return this.cache.get(name)!;
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

/**
 * Екран одиночної гри оригіналу (`s/backsing.txr`, 800×600) з кнопками LOAD.RES. Розташування кнопок у даних немає
 * (воно в king.exe) — знайдено зіставленням текстур кнопок з порожніми «гніздами» фону.
 * Стани кнопки: `_p` — звичайна, `_a` — під пальцем/мишею, `_ap` — натиснута, `_pp` / `_ph` — вибрана (перемикач)
 * і вибрана під пальцем, `_f` — недоступна.
 * Повзунки (насиченість трас, тривалість доби, погода): круглі кнопки фону ліворуч/праворуч — менше/більше, смуга
 * між ними — власне зображення значення (як малює оригінал, невідомо).
 */
const SINGLE = {
  new: [323, 120],
  arcade: [350, 174],
  simul: [444, 174],
  car: [350, 301],
  truck: [444, 301],
  load: [323, 355],
  cancel: [323, 485],
} as const;
/** Рядки повзунків: y центру; круглі кнопки — x 369 і 529, смуга між ними. */
const SLIDERS: [keyof Pick<Ht2Settings, 'traffic' | 'dayLength' | 'weather'>, number][] = [
  ['traffic', 227],
  ['dayLength', 259],
  ['weather', 290],
];

export interface SingleScreen {
  hasSave: boolean;
  saveText: string;
  settings: Ht2Settings;
  onNew(): void;
  onLoad(): void;
  onCancel(): void;
  onChange(s: Ht2Settings): void;
  /** Повідомлення поверх екрана (parent — контейнер екрана: шар overlay гри під меню). */
  note(text: string, parent: HTMLElement): void;
}

export function ht2SingleScreen(art: Ht2MenuArt, o: SingleScreen): () => void {
  const root = document.createElement('div');
  root.className = 'menu-screen ht2-menu';
  const stage = document.createElement('div');
  stage.className = 'menu-stage ht2-stage';
  root.append(stage);
  const bg = art.background('s/backsing.txr');
  if (bg) stage.append(bg);
  const s = { ...o.settings };
  const painters: (() => void)[] = [];
  const repaint = () => painters.forEach((p) => p());
  const changed = () => {
    o.onChange({ ...s });
    repaint();
  };

  const button = (key: keyof typeof SINGLE, tex: string, label: string, opts: { selected?: () => boolean; disabled?: boolean; action: () => void }) => {
    const [x, y] = SINGLE[key];
    const b = document.createElement('button');
    b.className = 'menu-abs ht2-tex-button';
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.setAttribute('aria-label', label);
    const img = document.createElement('img');
    img.alt = '';
    img.draggable = false;
    b.append(img);
    let hover = false;
    let down = false;
    const paint = () => {
      const st = opts.disabled ? 'f' : opts.selected?.() ? (hover ? 'ph' : 'pp') : down ? 'ap' : hover ? 'a' : 'p';
      img.src = art.image(`s/${tex}_${st}.txr`) ?? art.image(`s/${tex}_p.txr`) ?? '';
    };
    b.addEventListener('pointerenter', () => {
      hover = true;
      paint();
    });
    b.addEventListener('pointerleave', () => {
      hover = false;
      down = false;
      paint();
    });
    b.addEventListener('pointerdown', () => {
      down = true;
      paint();
    });
    b.addEventListener('pointerup', () => {
      down = false;
      paint();
    });
    b.addEventListener('click', () => {
      if (opts.disabled) return;
      opts.action();
      repaint();
    });
    paint();
    stage.append(b);
    painters.push(paint);
  };
  button('new', 'new', 'Нова гра', { action: o.onNew });
  button('arcade', 'arcad', 'Аркадний', {
    selected: () => s.arcade,
    action: () => {
      s.arcade = true;
      changed();
    },
  });
  button('simul', 'simul', 'Симулятор', {
    selected: () => !s.arcade,
    action: () => {
      s.arcade = false;
      changed();
    },
  });
  button('car', 'mecar', 'Легковик', { selected: () => false, action: () => o.note('Легковий автомобіль у порті ще недоступний', root) });
  button('truck', 'metruck', 'Вантажівка', { selected: () => true, action: () => {} });
  button('load', 'load', 'Завантажити гру', { disabled: !o.hasSave, action: o.onLoad });
  button('cancel', 'canc', 'Скасувати', { action: o.onCancel });

  for (const [key, y] of SLIDERS) {
    const bar = document.createElement('div');
    bar.className = 'menu-abs ht2-slider';
    bar.style.left = '386px';
    bar.style.top = `${y - 4}px`;
    const fill = document.createElement('div');
    bar.append(fill);
    const paint = () => {
      fill.style.width = `${Math.round(s[key] * 100)}%`;
    };
    const set = (v: number) => {
      s[key] = Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;
      paint();
      changed();
    };
    for (const [x, d, label] of [
      [369, -0.1, 'менше'],
      [529, 0.1, 'більше'],
    ] as const) {
      const b = document.createElement('button');
      b.className = 'menu-abs ht2-round';
      b.style.left = `${x - 15}px`;
      b.style.top = `${y - 15}px`;
      b.setAttribute('aria-label', `${key}: ${label}`);
      b.addEventListener('click', () => set(s[key] + d));
      stage.append(b);
    }
    bar.addEventListener('click', (e) => {
      const r = bar.getBoundingClientRect();
      set((e.clientX - r.left) / r.width);
    });
    paint();
    stage.append(bar);
  }

  // Збережена гра — у полі списку (власний текст).
  const save = document.createElement('div');
  save.className = 'menu-abs ht2-save';
  save.style.left = '362px';
  save.style.top = '418px';
  save.textContent = o.hasSave ? o.saveText : 'Немає збереженої гри';
  stage.append(save);

  const fit = () => {
    const k = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${k})`;
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
