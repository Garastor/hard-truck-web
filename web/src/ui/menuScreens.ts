/**
 * Меню оригіналу з LOAD.RES: фони екранів 640×480 (m/back_mai, n/back_new, d/back_dri) і кнопки-маски
 * у станах _b (звичайна), _a (під пальцем), _p (натиснута), _bp (вибрана). Екран масштабується під
 * телефон (цілком, з полями), кнопки — великі цілі для пальця.
 *
 * Координати кнопок у ресурсах не записані — знайдено зіставленням масок із рамками на фонах
 * (див. re/notes/menu.md).
 */
import { parseRmp, type RmpArchive } from '../formats/rmp';
import { parseTxr } from '../formats/txr';
import { parseMsk } from '../formats/msk';
import { parsePlm } from '../formats/plm';
import type { RgbaImage } from '../formats/binary';
import { formatMoney, type Career, type Difficulty } from '../game/career';
import { localizeBackground, localizeButton } from './menuLocale';

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

/** Екран 640×480, вписаний у вікно. */
class Screen {
  readonly root = document.createElement('div');
  readonly stage = document.createElement('div');
  private readonly onResize = () => this.fit();

  constructor(art: MenuArt, background: string) {
    this.root.className = 'menu-screen';
    this.stage.className = 'menu-stage';
    const bg = art.background(background);
    if (bg) {
      localizeBackground(background, bg);
      this.stage.append(bg);
    }
    this.root.append(this.stage);
    document.body.append(this.root);
    document.body.classList.add('in-menu');
    window.addEventListener('resize', this.onResize);
    this.fit();
  }

  private fit(): void {
    const s = Math.min(window.innerWidth / 640, window.innerHeight / 480);
    this.stage.style.transform = `translate(-50%, -50%) scale(${s})`;
  }

  private onKey: ((e: KeyboardEvent) => void) | null = null;

  /** Клавіатура: Enter і Esc — дії екрана (ОК / назад). Лише для верхнього екрана. */
  keys(enter: (() => void) | null, esc: (() => void) | null): void {
    this.onKey = (e) => {
      const fn = e.key === 'Enter' ? enter : e.key === 'Escape' ? esc : null;
      if (!fn || [...document.querySelectorAll('.menu-screen')].pop() !== this.root) return;
      if (document.querySelector('.career-modal')) return;
      e.preventDefault();
      fn();
    };
    window.addEventListener('keydown', this.onKey);
  }

  close(): void {
    if (this.onKey) window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.root.remove();
    document.body.classList.remove('in-menu');
  }

  /** Довільний елемент у координатах екрана 640×480. */
  place<T extends HTMLElement>(el: T, x: number, y: number, w?: number, h?: number): T {
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    if (w !== undefined) el.style.width = `${w}px`;
    if (h !== undefined) el.style.height = `${h}px`;
    el.classList.add('menu-abs');
    this.stage.append(el);
    return el;
  }
}

/** Підписи кнопок-картинок (для доступності й тестів). */
const LABELS: Record<string, string> = {
  game: 'Гра', connec: 'Мережева гра', quick: 'Пробний заїзд', driver: 'Змінити водія', option: 'Опції',
  demo: 'Демо', help: 'Допомога', reels: 'Відеокліпи', exit: 'Вихід', arcad: 'Аркадний', simul: 'Симулятор',
  new: 'Нова гра', load: 'Завантажити гру', cancel: 'Скасувати', ok: 'Гаразд', defaul: 'За замовчуванням',
  joyst: 'Геймпад', mouse: 'Нахил телефона', keyb: 'Кнопки', big: 'Висока якість', med: 'Середня якість', small: 'Низька якість',
  rs320: 'Вікно', rs640: 'Повний екран', rs800: 'Прискорювач',
  but0: '0', but1: '1', but2: '2', but3: '3', but4: '4', but5: '5', but6: '6', but7: '7',
};

interface ButtonOpts {
  selected?: () => boolean;
  disabled?: boolean;
}

/** Кнопка-маска: стани _b/_a/_p/_bp; спрацьовує при відпусканні пальця над нею. */
function maskButton(screen: Screen, art: MenuArt, base: string, x: number, y: number, onClick: () => void, opts: ButtonOpts = {}) {
  const wrap = document.createElement('button');
  wrap.className = 'menu-btn';
  wrap.setAttribute('aria-label', LABELS[base.replace(/^\w+\//, '')] ?? base);
  const orig: Record<string, HTMLCanvasElement | null> = {};
  for (const s of ['b', 'a', 'p', 'bp']) orig[s] = art.mask(`${base}_${s}.msk`);
  // Українські написи замість російських (якщо є переклад); off — недоступна (темніший текст).
  const states: Record<string, HTMLCanvasElement | null> = localizeButton(base, orig) ?? orig;
  for (const c of Object.values(states)) if (c) wrap.append(c);
  let pressed = false;
  let over = false;
  const show = () => {
    const sel = opts.selected?.() ?? false;
    const want = opts.disabled ? (states.off ? 'off' : 'b') : pressed ? 'p' : sel ? (states.bp ? 'bp' : 'p') : over ? 'a' : 'b';
    for (const [k, c] of Object.entries(states)) if (c) c.hidden = k !== (states[want] ? want : 'b');
  };
  if (opts.disabled) wrap.classList.add('disabled');
  wrap.addEventListener('pointerenter', () => ((over = true), show()));
  wrap.addEventListener('pointerleave', () => ((over = false), (pressed = false), show()));
  wrap.addEventListener('pointerdown', () => ((pressed = true), show()));
  wrap.addEventListener('pointerup', () => ((pressed = false), show()));
  wrap.addEventListener('click', () => {
    if (!opts.disabled) onClick();
  });
  show();
  screen.place(wrap, x, y);
  return { el: wrap, refresh: show };
}

/** Головне меню. Рамки кнопок на фоні: x = 0, y = 109 + 40·k (376×26). */
export function mainMenu(
  art: MenuArt,
  opts: { viewer: boolean; driver: string; onDriver: () => Promise<void>; onOptions: () => Promise<void>; onHelp: () => Promise<void> },
): Promise<'game' | 'quick' | 'viewer'> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'm/back_mai.txr');
    const done = (v: 'game' | 'quick' | 'viewer') => {
      scr.close();
      resolve(v);
    };
    const later = (fn: () => Promise<void>) => async () => {
      scr.root.hidden = true;
      await fn();
      scr.root.hidden = false;
      who.textContent = `За кермом: ${opts.driver}`;
    };
    const y = (k: number) => 109 + 40 * k;
    maskButton(scr, art, 'm/game', 0, y(0), () => done('game'));
    maskButton(scr, art, 'm/connec', 0, y(1), () => {}, { disabled: true });
    maskButton(scr, art, 'm/quick', 0, y(2), () => done('quick'));
    maskButton(scr, art, 'm/driver', 0, y(3), later(opts.onDriver));
    maskButton(scr, art, 'm/option', 0, y(4), later(opts.onOptions));
    maskButton(scr, art, 'm/demo', 0, y(5), () => {}, { disabled: true });
    maskButton(scr, art, 'm/help', 0, y(6), later(opts.onHelp));
    maskButton(scr, art, 'm/reels', 0, y(7), () => {}, { disabled: true });
    maskButton(scr, art, 'm/exit', 0, y(8), () => done('viewer'), { disabled: !opts.viewer });
    const who = scr.place(document.createElement('div'), 390, 450, 240);
    who.className += ' menu-note';
    who.textContent = `За кермом: ${opts.driver}`;
  });
}

export type NewGameChoice = { action: 'new'; difficulty: Difficulty; rivals: number } | { action: 'load'; name: string } | null;

/**
 * «Новая игра»: рівень складності (Аркадный/Симулятор), кількість суперників 0…7, список існуючих ігор,
 * кнопки НОВАЯ ИГРА / ЗАГРУЗИТЬ ИГРУ / ОТМЕНА.
 */
export function newGameScreen(art: MenuArt, saves: Career[], driver: string): Promise<NewGameChoice> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'n/back_new.txr');
    let difficulty: Difficulty = 'sim';
    let rivals = 3;
    let picked: string | null = saves.find((c) => c.name === driver)?.name ?? saves[0]?.name ?? null;
    const buttons: { refresh: () => void }[] = [];
    const refreshAll = () => buttons.forEach((b) => b.refresh());
    const done = (v: NewGameChoice) => {
      scr.close();
      resolve(v);
    };
    buttons.push(maskButton(scr, art, 'n/arcad', 0, 111, () => ((difficulty = 'arcade'), refreshAll()), { selected: () => difficulty === 'arcade' }));
    buttons.push(maskButton(scr, art, 'n/simul', 0, 143, () => ((difficulty = 'sim'), refreshAll()), { selected: () => difficulty === 'sim' }));
    for (let k = 0; k <= 7; k++) {
      const x = k === 0 ? 0 : 95 + 30 * (k - 1);
      buttons.push(maskButton(scr, art, `n/but${k}`, x, 189, () => ((rivals = k), refreshAll()), { selected: () => rivals === k }));
    }
    maskButton(scr, art, 'n/new', 327, 111, () => done({ action: 'new', difficulty, rivals }));
    maskButton(scr, art, 'n/load', 327, 239, () => picked && done({ action: 'load', name: picked }), { disabled: !saves.length });
    maskButton(scr, art, 'n/cancel', 327, 389, () => done(null));
    scr.keys(null, () => done(null));
    // Список «Существующие игры» (рамка ≈ 152…300 × 256…448): 10 рядків, порожні — «none», як в оригіналі.
    const list = scr.place(document.createElement('div'), 156, 270, 142, 176);
    list.className += ' menu-list';
    const rows: HTMLElement[] = [];
    for (let i = 0; i < 10; i++) {
      const c = saves[i];
      const row = document.createElement('div');
      row.textContent = c ? `${c.name} ${formatMoney(c.money)}` : 'none';
      if (c) {
        row.classList.add('menu-row');
        row.addEventListener('click', () => {
          picked = c.name;
          rows.forEach((r, j) => r.classList.toggle('picked', saves[j]?.name === picked));
        });
        row.addEventListener('dblclick', () => done({ action: 'load', name: c.name }));
        if (c.name === picked) row.classList.add('picked');
      }
      rows.push(row);
      list.append(row);
    }
  });
}

/** «Сменить водителя»: поле «За рулем» і список зареєстрованих водіїв. */
export function driverScreen(art: MenuArt, current: string, known: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'd/back_dri.txr');
    const input = scr.place(document.createElement('input'), 6, 161, 140, 20);
    input.className += ' menu-input';
    input.value = current;
    input.maxLength = 12;
    const done = (v: string | null) => {
      scr.close();
      resolve(v);
    };
    const list = scr.place(document.createElement('div'), 162, 250, 130, 130);
    list.className += ' menu-list';
    for (const n of known) {
      const row = document.createElement('div');
      row.className = 'menu-row';
      row.textContent = n;
      row.addEventListener('click', () => (input.value = n));
      list.append(row);
    }
    maskButton(scr, art, 'd/ok', 327, 148, () => done(input.value.trim() || current));
    maskButton(scr, art, 'd/cancel', 327, 362, () => done(null));
    scr.keys(() => done(input.value.trim() || current), () => done(null));
  });
}

export type ControlMode = 'buttons' | 'tilt';
export type QualityLevel = 'high' | 'balance' | 'eco';

export interface OptionsState {
  control: ControlMode;
  quality: QualityLevel;
  fullscreen: boolean;
  swap: boolean;
  fps: boolean;
  /** Кабіна: 3D-модель чи 2D-растр (як у програмному режимі оригіналу). */
  cab: '3d' | '2d';
}

export interface OptionsActions {
  /** Повертає новий стан керування (нахил на iOS вимагає дозволу — може не вдатися). */
  setControl(c: ControlMode): Promise<ControlMode>;
  setQuality(q: QualityLevel): void;
  setFullscreen(on: boolean): Promise<boolean>;
  setSwap(on: boolean): void;
  setFps(on: boolean): void;
  setCab(style: '3d' | '2d'): void;
}

/** Клавіші порту (для таблиці «перевизначення клавіатури» — поки лише показуємо). */
const KEY_ROWS: [string, string][] = [
  ['Газ', '↑'],
  ['Гальмо, задній хід', '↓'],
  ['Кермо', '← →'],
  ['Ручне гальмо', 'Shift'],
  ['Двигун: заглушити / завести', 'Пробіл'],
  ['Фари', 'L'],
  ['Дзеркало заднього огляду', 'M'],
  ['Двірники', 'W'],
  ['Навігація (якщо є)', 'Tab'],
  ['Камера', 'C'],
  ['Сигнал', 'H'],
  ['Відновитися', '0 / R'],
  ['Вікна: так / скасувати', 'Enter / Esc'],
  ['Автопілот (налагодження)', 'P'],
];

/**
 * «Опции» (o/back_opt): таблиця налаштувань і клавіш; «Управление» — кнопки / нахил / геймпад (немає),
 * «Разрешение» — якість графіки, «Видеорежим» — вікно / екран (прискорювач — завжди, набір *2.B3D).
 * Рамки кнопок: стовпчики x = 27, 150, 273; рядки y = 368, 399, 430; «По умолчанию» (27, 328), ОК (397, 343).
 */
export function optionsScreen(art: MenuArt, st: OptionsState, act: OptionsActions, defaults: OptionsState): Promise<void> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'o/back_opt.txr');
    const buttons: { refresh: () => void }[] = [];
    const refresh = () => {
      buttons.forEach((b) => b.refresh());
      renderRows();
    };
    const col = (k: number) => 27 + 123 * k;
    const row = (k: number) => 368 + 31 * k;
    buttons.push(maskButton(scr, art, 'o/joyst', col(0), row(0), () => {}, { disabled: true }));
    buttons.push(
      maskButton(scr, art, 'o/mouse', col(0), row(1), () => void act.setControl('tilt').then((c) => ((st.control = c), refresh())), {
        selected: () => st.control === 'tilt',
      }),
    );
    buttons.push(
      maskButton(scr, art, 'o/keyb', col(0), row(2), () => void act.setControl('buttons').then((c) => ((st.control = c), refresh())), {
        selected: () => st.control === 'buttons',
      }),
    );
    const levels: [string, QualityLevel][] = [['o/big', 'high'], ['o/med', 'balance'], ['o/small', 'eco']];
    levels.forEach(([base, q], i) =>
      buttons.push(maskButton(scr, art, base, col(1), row(i), () => ((st.quality = q), act.setQuality(q), refresh()), { selected: () => st.quality === q })),
    );
    buttons.push(
      maskButton(scr, art, 'o/rs320', col(2), row(0), () => void act.setFullscreen(false).then((on) => ((st.fullscreen = on), refresh())), {
        selected: () => !st.fullscreen,
      }),
    );
    buttons.push(
      maskButton(scr, art, 'o/rs640', col(2), row(1), () => void act.setFullscreen(true).then((on) => ((st.fullscreen = on), refresh())), {
        selected: () => st.fullscreen,
      }),
    );
    buttons.push(maskButton(scr, art, 'o/rs800', col(2), row(2), () => {}, { selected: () => true }));
    maskButton(scr, art, 'o/defaul', 27, 328, () => {
      if (st.control !== defaults.control) void act.setControl(defaults.control).then((c) => ((st.control = c), refresh()));
      st.quality = defaults.quality;
      act.setQuality(st.quality);
      st.swap = defaults.swap;
      act.setSwap(st.swap);
      st.fps = defaults.fps;
      act.setFps(st.fps);
      st.cab = defaults.cab;
      act.setCab(st.cab);
      refresh();
    });
    const ok = () => {
      scr.close();
      resolve();
    };
    maskButton(scr, art, 'o/ok', 397, 343, ok);
    scr.keys(ok, ok);

    // Таблиця (рамка ≈ 27…445 × 107…325): угорі — перемикачі (тап змінює), нижче — клавіші.
    const table = scr.place(document.createElement('div'), 32, 110, 408, 212);
    table.className += ' menu-list menu-table';
    function renderRows(): void {
      table.replaceChildren();
      const add = (k: string, v: string, onClick?: () => void) => {
        const r = document.createElement('div');
        r.className = onClick ? 'menu-row menu-trow' : 'menu-trow';
        const a = document.createElement('span');
        a.textContent = k;
        const b = document.createElement('span');
        b.textContent = v;
        r.append(a, b);
        if (onClick) r.addEventListener('click', onClick);
        table.append(r);
      };
      add('Кермо й педалі', st.swap ? 'навпаки' : 'звичайно', () => ((st.swap = !st.swap), act.setSwap(st.swap), renderRows()));
      add('Лічильник кадрів', st.fps ? 'так' : 'ні', () => ((st.fps = !st.fps), act.setFps(st.fps), renderRows()));
      add('Кабіна', st.cab === '2d' ? '2D' : '3D', () => ((st.cab = st.cab === '2d' ? '3d' : '2d'), act.setCab(st.cab), renderRows()));
      add('Кермування нахилом', st.control === 'tilt' ? 'так' : 'ні');
      add('', '');
      for (const [k, v] of KEY_ROWS) add(k, v);
    }
    renderRows();
  });
}

/** «Помощь»: текст у великій панелі екрана l/backlast (≈ 30…608 × 33…353), кнопка «НАЗАД» праворуч унизу. */
export function helpScreen(art: MenuArt, text: string): Promise<void> {
  return new Promise((resolve) => {
    const scr = new Screen(art, 'l/backlast.txr');
    const box = scr.place(document.createElement('div'), 44, 44, 552, 252);
    box.className += ' menu-list menu-help';
    for (const para of text.split('\n\n')) {
      const p = document.createElement('p');
      p.textContent = para;
      box.append(p);
    }
    const back = () => {
      scr.close();
      resolve();
    };
    maskButton(scr, art, 'l/cancel', 495, 384, back);
    scr.keys(back, back);
  });
}
