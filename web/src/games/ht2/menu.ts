import { parseRmp, type RmpArchive } from '@engine/formats/rmp';
import { parseTxr } from '@engine/formats/txr';
import { parseMsk } from '@engine/formats/msk';
import { parsePlm } from '@engine/formats/plm';
import type { RgbaImage } from '@engine/formats/binary';
import type { PixelFont } from '@engine/ui/pixelFont';
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
  /** Палітра масок меню (`menu_.plm` у LOAD.RES). */
  private readonly palette: Uint8Array | undefined;
  private constructor(readonly res: RmpArchive) {
    const plm = res.palettes.get('menu_.plm');
    this.palette = plm ? parsePlm(plm).palette : undefined;
  }

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

  /** Маска LOAD.RES (`common.msk` — рамка, `m/*.msk` — круглі кнопки, стрілки й бігунок повзунків). */
  mask(name: string): HTMLCanvasElement | null {
    const b = this.res.masks.get(name);
    if (!b) return null;
    const m = parseMsk(b, this.palette);
    return toCanvas({ width: m.width, height: m.height, data: m.data });
  }

  /** Зображення кнопки: текстура (`….txr`) чи маска (`….msk`); кешується. */
  private readonly cache = new Map<string, string | null>();
  image(name: string): string | null {
    if (!this.cache.has(name)) {
      const c = name.endsWith('.msk') ? this.mask(name) : this.background(name);
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
      // Шрифт ×3, довгі пункти — дрібніше, щоб уміститись у колонку до краю сцени.
      const k = Math.min(3, (W - x - 16) / c.width);
      c.style.width = `${c.width * k}px`;
      c.style.height = `${c.height * k}px`;
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
 * Рамка меню оригіналу — маска `common.msk` (800×600, прозоре коло в центрі): у коло лягають екрани LOAD.RES
 * (`m/back_main`, `s/backsing`, `e/backexit`…), по боках — вісім круглих кнопок `m/<ключ>_p|a|ap.msk` (125×125).
 * Місця кнопок у даних немає — це центри чорних гнізд рамки (рамка симетрична відносно x = 400).
 */
export type RoundKey = 'graph' | 'contr' | 'demo' | 'recor' | 'singl' | 'multi' | 'chang' | 'exit';
const ROUND: [RoundKey, number, number, string][] = [
  ['graph', 79, 82, 'Графіка'],
  ['contr', 28, 200, 'Керування'],
  ['demo', 28, 330, 'Демо'],
  ['recor', 79, 451, 'Відеоплеєр'],
  ['singl', 597, 82, 'Гра'],
  ['multi', 648, 200, 'Мережева гра'],
  ['chang', 648, 330, 'Змінити водія'],
  ['exit', 597, 451, 'Вихід з гри'],
];

/** Головний екран: центр — `m/back_main`, дії — круглі кнопки рамки. */
export function ht2MainScreen(art: Ht2MenuArt, o: { note?: string; onRound(key: RoundKey): void }): () => void {
  const sc = screen(art, 'm/back_main.txr', o.onRound);
  if (o.note) {
    const n = document.createElement('div');
    n.className = 'menu-abs menu-note ht2-main-note';
    n.style.left = '0';
    n.style.top = `${H - 30}px`;
    n.style.width = `${W}px`;
    n.textContent = o.note;
    sc.stage.append(n);
  }
  return sc.close;
}

/**
 * Екран одиночної гри оригіналу (`s/backsing.txr`) з кнопками LOAD.RES. Місця кнопок знайдено зіставленням
 * текстур кнопок з порожніми «гніздами» фону; повзунків (стрілки `aleft`/`aright`, бігунок `runner`) — за знімком
 * екрана оригіналу.
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
/** Рядки повзунків: y центру; стрілки — центри x 365 і 524 (29×29), бігунок (12×22) — від x 385 (0) до 502 (1). */
const SLIDERS: [keyof Pick<Ht2Settings, 'traffic' | 'dayLength' | 'weather'>, number][] = [
  ['traffic', 225],
  ['dayLength', 255],
  ['weather', 285],
];
const RUN_X0 = 385;
const RUN_X1 = 502;

export interface SingleScreen {
  hasSave: boolean;
  saveText: string;
  settings: Ht2Settings;
  onNew(): void;
  onLoad(): void;
  onCancel(): void;
  onChange(s: Ht2Settings): void;
  /** Кругла кнопка рамки (інший розділ меню). */
  onRound(key: RoundKey): void;
  /** Повідомлення поверх екрана (parent — контейнер екрана: шар overlay гри під меню). */
  note(text: string, parent: HTMLElement): void;
}

export function ht2SingleScreen(art: Ht2MenuArt, o: SingleScreen): () => void {
  const sc = screen(art, 's/backsing.txr', o.onRound);
  const { stage, root } = sc;
  const s = { ...o.settings };
  const painters: (() => void)[] = [];
  const repaint = () => painters.forEach((p) => p());
  const changed = () => {
    o.onChange({ ...s });
    repaint();
  };

  const button = (key: keyof typeof SINGLE, tex: string, label: string, opts: TexButtonOptions) => {
    const [x, y] = SINGLE[key];
    painters.push(texButton(art, stage, `s/${tex}`, x, y, label, { ...opts, after: repaint }));
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
    const set = (v: number) => {
      s[key] = Math.round(Math.min(1, Math.max(0, v)) * 10) / 10;
      changed();
    };
    // Стрілки: на межі — недоступні (_f).
    painters.push(
      texButton(art, stage, 'aleft', 365 - 14, y - 14, `${key}: менше`, { ext: '.msk', disabled: () => s[key] <= 0, action: () => set(s[key] - 0.1) }),
      texButton(art, stage, 'aright', 524 - 14, y - 14, `${key}: більше`, { ext: '.msk', disabled: () => s[key] >= 1, action: () => set(s[key] + 0.1) }),
    );
    // Смуга — зона дотику (перетягування бігунка), бігунок — маска runner.
    const track = document.createElement('div');
    track.className = 'menu-abs ht2-track';
    track.style.left = `${RUN_X0 - 8}px`;
    track.style.top = `${y - 13}px`;
    track.style.width = `${RUN_X1 - RUN_X0 + 16}px`;
    const knob = document.createElement('img');
    knob.alt = '';
    knob.draggable = false;
    knob.className = 'ht2-runner';
    track.append(knob);
    let drag = false;
    const paint = () => {
      knob.src = art.image(`runner_${drag ? 'ap' : 'p'}.msk`) ?? '';
      knob.style.left = `${8 + (RUN_X1 - RUN_X0) * s[key] - 6}px`;
    };
    const fromEvent = (e: PointerEvent) => {
      const r = track.getBoundingClientRect();
      const k = r.width / (RUN_X1 - RUN_X0 + 16);
      set((e.clientX - r.left - 8 * k) / ((RUN_X1 - RUN_X0) * k));
    };
    track.addEventListener('pointerdown', (e) => {
      drag = true;
      track.setPointerCapture(e.pointerId);
      fromEvent(e);
    });
    track.addEventListener('pointermove', (e) => {
      if (drag) fromEvent(e);
    });
    const up = () => {
      drag = false;
      paint();
    };
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    painters.push(paint);
    paint();
    stage.append(track);
  }

  // Збережена гра — у полі списку (власний текст).
  const save = document.createElement('div');
  save.className = 'menu-abs ht2-save';
  save.style.left = '362px';
  save.style.top = '418px';
  save.textContent = o.hasSave ? o.saveText : 'Немає збереженої гри';
  stage.append(save);
  return sc.close;
}

interface TexButtonOptions {
  selected?: () => boolean;
  disabled?: boolean | (() => boolean);
  action: () => void;
  /** Після дії (перемалювати сусідні перемикачі). */
  after?: () => void;
  /** Розширення зображень стану: `.txr` (текстура) чи `.msk` (маска). */
  ext?: string;
}

/**
 * Кнопка LOAD.RES у точці (x, y) сцени: `<base>_<стан><ext>`. Повертає функцію перемальовування.
 * Стани: `_p` — звичайна, `_a` — під пальцем/мишею, `_ap` — натиснута, `_pp` / `_ph` — вибрана (перемикач) і вибрана
 * під пальцем, `_f` — недоступна.
 */
function texButton(art: Ht2MenuArt, stage: HTMLElement, base: string, x: number, y: number, label: string, opts: TexButtonOptions): () => void {
  const ext = opts.ext ?? '.txr';
  const off = () => (typeof opts.disabled === 'function' ? opts.disabled() : !!opts.disabled);
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
    const st = off() ? 'f' : opts.selected?.() ? (hover ? 'ph' : 'pp') : down ? 'ap' : hover ? 'a' : 'p';
    img.src = art.image(`${base}_${st}${ext}`) ?? art.image(`${base}_p${ext}`) ?? '';
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
    if (off()) return;
    opts.action();
    opts.after?.();
  });
  paint();
  stage.append(b);
  return paint;
}

/**
 * Сцена 800×600, вписана у вікно: центр — екран LOAD.RES, поверх — рамка `common.msk` і круглі кнопки (onRound;
 * без нього рамки немає). Повертає (stage, root, close).
 */
function screen(art: Ht2MenuArt, background: string, onRound?: (key: RoundKey) => void): { stage: HTMLElement; root: HTMLElement; close: () => void } {
  const root = document.createElement('div');
  root.className = 'menu-screen ht2-menu';
  const stage = document.createElement('div');
  stage.className = 'menu-stage ht2-stage';
  root.append(stage);
  const bg = art.background(background);
  if (bg) stage.append(bg);
  if (onRound) {
    const frame = art.mask('common.msk');
    if (frame) {
      frame.className = 'menu-abs ht2-frame';
      stage.append(frame);
    }
    for (const [key, x, y, label] of ROUND) texButton(art, stage, `m/${key}`, x, y, label, { ext: '.msk', action: () => onRound(key) });
  }
  const fit = () => {
    const k = Math.min(window.innerWidth / W, window.innerHeight / H);
    stage.style.transform = `translate(-50%, -50%) scale(${k})`;
  };
  window.addEventListener('resize', fit);
  fit();
  document.body.append(root);
  document.body.classList.add('in-menu');
  return {
    stage,
    root,
    close: () => {
      window.removeEventListener('resize', fit);
      root.remove();
      document.body.classList.remove('in-menu');
    },
  };
}

/**
 * Підтвердження виходу (`e/backexit.txr`: «ВЫЙТИ ИЗ ИГРЫ»), кнопки `e/ok`, `e/canc` — місця знайдено зіставленням з
 * гніздами фону. Повертає true — вийти.
 */
export function ht2ExitScreen(art: Ht2MenuArt): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => () => {
      sc.close();
      resolve(v);
    };
    const sc = screen(art, 'e/backexit.txr', () => done(false)());
    texButton(art, sc.stage, 'e/ok', 290, 304, 'Так, вийти', { action: done(true) });
    texButton(art, sc.stage, 'e/canc', 381, 304, 'Скасувати', { action: done(false) });
  });
}
