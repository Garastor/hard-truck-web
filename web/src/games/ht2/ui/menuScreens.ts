import { screen, texButton, type Ht2MenuArt, type RoundKey } from './menu';
import type { Ht2Settings } from './settings';
import { DEFAULT_KEYS, type Action, type Command } from '../engine/input/input';

/**
 * Екрани меню LOAD.RES «Графіка», «Керування», «Водії», «Відеоплеєр» — розклад king.exe (re/notes/ht2/menu-screens.md;
 * координати — сцена 800×600, як у одиночної гри). Написи, які гра малює кодом, — українською (у фонах лишаються
 * оригінальні). Що в порту діє:
 * - графіка — роздільність 640×480…1600×1200 (висота кадру рендерера), «Автопошук» — за екраном пристрою; повзунки
 *   «спецефекти» й «детальність» — пороги ефектів king.exe (ui/effects.ts); на місці вибору відеокарти — частота
 *   кадрів 30 / 40 / 60 (порт; `Ht2Settings.fps`, FPS_MODES);
 * - керування — таблиця 22 дій з клавішами порту; рядок дії порту — перепризначити клавішу (наступне натискання;
 *   зайнята іншою дією — обмін), «За замовчуванням» — типові;
 * - водії — логотип (`d/logo1…8`) і фото (`d/photo01…51`) поточного водія, поле імені (нове імʼя — новий водій),
 *   список водіїв (вибір — поточний), «Видалити» — водія з його збереженими іграми;
 * - відеоплеєр — записів (файли .tr/.mvp оригіналу) у порту немає: список порожній, кнопки неактивні.
 */

/** Висота кадру для кнопок роздільності (`[DRVn] vpas/vpam/vpal/vpasl` king.exe). */
export const RESOLUTION_H = [480, 600, 768, 1200];

/** Щільність пікселів режиму «Баланс» — коли роздільність не вибрано (drive.ts resize). */
export const BALANCE_DPR = 1.5;

/** Кнопка роздільності, найближча до висоти кадру h (пікселі буфера). */
export function nearestResolution(h: number): number {
  let best = 0;
  RESOLUTION_H.forEach((r, i) => (Math.abs(r - h) < Math.abs(RESOLUTION_H[best] - h) ? (best = i) : 0));
  return best;
}

/** Частоти кадрів перемикача меню «Графіка» (Ht2Settings.fps): 40 — рівно кожен третій кадр екрана 120 Гц. */
export const FPS_MODES = [30, 40, 60];

const TEXT = 'color:#f0e896;font:600 12px/1 Arial,sans-serif;text-shadow:0 0 3px #000;white-space:nowrap;pointer-events:none;';

/** Текст у сцені: базова лінія (x, y), як у king.exe; align — від x чи по центру смуги width. */
function text(stage: HTMLElement, s: string, x: number, y: number, o: { width?: number; size?: number; color?: string } = {}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'menu-abs';
  const size = o.size ?? 12;
  el.style.cssText += TEXT + `font-size:${size}px;` + (o.color ? `color:${o.color};` : '');
  el.style.left = `${x}px`;
  el.style.top = `${y - size}px`;
  if (o.width) {
    el.style.width = `${o.width}px`;
    el.style.textAlign = 'center';
  }
  el.textContent = s.toUpperCase();
  stage.append(el);
  return el;
}

/** Повзунок 0…1: стрілки aleft/aright і бігунок runner від x (ширина смуги 182); неактивний — лише показ. */
function slider(art: Ht2MenuArt, stage: HTMLElement, x: number, y: number, value: () => number, label: string, set?: (v: number) => void): () => void {
  const off = !set;
  const left = texButton(art, stage, 'aleft', x, y, `${label}: менше`, { ext: '.msk', disabled: () => off || value() <= 0, action: () => set?.(value() - 0.1) });
  const right = texButton(art, stage, 'aright', x + 182 - 29, y, `${label}: більше`, { ext: '.msk', disabled: () => off || value() >= 1, action: () => set?.(value() + 0.1) });
  const knob = document.createElement('img');
  knob.alt = '';
  knob.className = 'menu-abs';
  knob.style.pointerEvents = 'none';
  stage.append(knob);
  const paint = () => {
    knob.src = art.image('runner_p.msk') ?? '';
    knob.style.left = `${x + 36 + (182 - 72 - 12) * value()}px`;
    knob.style.top = `${y + 3}px`;
    left();
    right();
  };
  paint();
  return paint;
}

export interface GraphicsScreen {
  settings: Ht2Settings;
  onChange(s: Ht2Settings): void;
  onCancel(): void;
  onRound(key: RoundKey): void;
}

/** Графіка (`g/backGraf`, 0x515ca0). */
export function ht2GraphicsScreen(art: Ht2MenuArt, o: GraphicsScreen): () => void {
  const sc = screen(art, 'g/backgraf.txr', o.onRound);
  const { stage } = sc;
  const s = { ...o.settings };
  const was = { ...o.settings };
  const painters: (() => void)[] = [];
  const repaint = () => painters.forEach((p) => p());
  const pick = (i: number) => {
    s.resolution = i;
    o.onChange({ ...s });
    repaint();
  };
  // «Автопошук»: найбільша роздільність, що не вища за фізичну висоту екрана (гіпотеза порту замість частоти ЦП і
  // відеопамʼяті king.exe).
  painters.push(
    texButton(art, stage, 'g/detect', 348, 157, 'Автопошук', {
      action: () => {
        const h = window.innerHeight * window.devicePixelRatio;
        let i = 0;
        RESOLUTION_H.forEach((r, k) => (r <= h ? (i = k) : 0));
        pick(i);
      },
    }),
  );
  // На місці вибору відеокарти (у порту вона одна — WebGL) — частота кадрів (порт, на прохання користувача): менше —
  // менше нагріву телефона. Стрілки — сусіднє значення FPS_MODES.
  const fpsLabel = text(stage, '', 329, 257, { width: 255, size: 14 });
  const fpsAt = () => Math.max(0, FPS_MODES.indexOf(s.fps ?? 60));
  const stepFps = (d: number) => {
    s.fps = FPS_MODES[Math.min(FPS_MODES.length - 1, Math.max(0, fpsAt() + d))];
    o.onChange({ ...s });
    repaint();
  };
  painters.push(texButton(art, stage, 'aleft', 324, 263, 'Частота кадрів: менше', { ext: '.msk', disabled: () => fpsAt() === 0, action: () => stepFps(-1) }));
  painters.push(texButton(art, stage, 'aright', 536, 263, 'Частота кадрів: більше', { ext: '.msk', disabled: () => fpsAt() === FPS_MODES.length - 1, action: () => stepFps(1) }));
  const paintFps = () => (fpsLabel.textContent = `${FPS_MODES[fpsAt()]} FPS`);
  paintFps();
  painters.push(paintFps);
  const res: [string, number, number, string][] = [
    ['small', 329, 293, '640×480'],
    ['med', 441, 293, '800×600'],
    ['large', 329, 330, '1024×768'],
    ['huge', 441, 330, '1600×1200'],
  ];
  // Не вибрано — світиться та, що найближча до того, що діє насправді (drive.ts «Баланс», щільність ≤ BALANCE_DPR):
  // на телефоні це ≈ 800×600; раніше світилась 1024×768, і вибір нижчих майже не змінював картинку.
  const current = () => s.resolution ?? nearestResolution(Math.min(window.devicePixelRatio, BALANCE_DPR) * window.innerHeight);
  res.forEach(([tex, x, y, label], i) => painters.push(texButton(art, stage, `g/${tex}`, x, y, label, { selected: () => current() === i, action: () => pick(i), after: repaint })));
  const set = (k: 'effects' | 'detail') => (v: number) => {
    s[k] = Math.round(Math.max(0, Math.min(1, v)) * 10) / 10;
    o.onChange({ ...s });
    repaint();
  };
  painters.push(slider(art, stage, 349, 370, () => s.effects, 'Спецефекти', set('effects')));
  painters.push(slider(art, stage, 349, 405, () => s.detail, 'Детальність', set('detail')));
  painters.push(
    texButton(art, stage, 'g/canc', 348, 452, 'Скасувати', {
      action: () => {
        o.onChange(was);
        o.onCancel();
      },
    }),
  );
  return sc.close;
}

type Bind = Action | Command;

/**
 * Дії таблиці керування king.exe (0x514d10): стовпчик 1 — 11 рядків, стовпчик 2 — 11; назви — mess.txt (0x29…0x66),
 * дія порту (engine/input) — без неї «—» (передачі: у порту лише автомат).
 */
const ACTIONS: [string, Bind?][] = [
  ['Кермо ліворуч', 'left'],
  ['Кермо праворуч', 'right'],
  ['Газ', 'gas'],
  ['Гальмо', 'brake'],
  ['Ручне гальмо', 'handbrake'],
  ['Передача вгору'],
  ['Передача вниз'],
  ['Запалювання', 'engine'],
  ['Фари', 'lights'],
  ['Напівпричіп', 'attach'],
  ['Сигнал', 'horn'],
  ['Двірники', 'wipers'],
  ['Пейджер'],
  ['Зовнішня камера', 'camera'],
  ['Камера ліворуч'],
  ['Камера праворуч'],
  ['Камера ближче'],
  ['Камера далі'],
  ['Карта', 'map'],
  ['Купівля'],
  ['Повернення'],
  ['Монітор'],
];

/** Назва клавіші за KeyboardEvent.code. */
export function keyName(code: string): string {
  const names: Record<string, string> = {
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    Space: 'ПРОБІЛ',
    Enter: 'ENTER',
    Backspace: 'BACKSPACE',
    Tab: 'TAB',
    Escape: 'ESC',
  };
  if (names[code]) return names[code];
  const m = /^(?:Key|Digit)(.)$/.exec(code) ?? /^Numpad(.+)$/.exec(code);
  if (m) return code.startsWith('Numpad') ? `NUM ${m[1]}` : m[1];
  const side = /^(Shift|Control|Alt|Meta)(Left|Right)$/.exec(code);
  if (side) return { Shift: 'SHIFT', Control: 'CTRL', Alt: 'ALT', Meta: 'WIN' }[side[1]]! + (side[2] === 'Right' ? ' ПР' : '');
  return code.toUpperCase();
}

/** Клавіші, яких не можна призначити: меню, підказки F1…F5 (зайняті вікнами гри). */
const RESERVED = new Set(['Escape', 'F1', 'F2', 'F3', 'F4', 'F5']);

export interface ControlsScreen {
  keys: Partial<Record<Bind, string>>;
  onChange(keys: Partial<Record<Bind, string>>): void;
  onCancel(): void;
  onRound(key: RoundKey): void;
}

/**
 * Керування (`c/backCtrl`, 0x513b30): пристрій, таблиця дій, «за замовчуванням». Рядок дії — чекати на клавішу
 * (Esc — скасувати); клавіша іншої дії — обмін (та дія дістає попередню клавішу цієї).
 */
export function ht2ControlsScreen(art: Ht2MenuArt, o: ControlsScreen): () => void {
  const sc = screen(art, 'c/backctrl.txr', o.onRound);
  const { stage } = sc;
  let keys = { ...o.keys };
  const was = { ...o.keys };
  const code = (b: Bind) => keys[b] ?? DEFAULT_KEYS[b]![0];
  const cells: [Bind, HTMLElement][] = [];
  let waiting: Bind | null = null;
  const paint = () => cells.forEach(([b, el]) => (el.textContent = b === waiting ? '…' : keyName(code(b))));
  const set = (b: Bind, c: string) => {
    const other = ACTIONS.find(([, a]) => a && a !== b && code(a) === c)?.[1];
    if (other) keys[other] = code(b);
    keys[b] = c;
    // Типові — не зберігати (лишаються й додаткові клавіші: правий Shift, 0 на цифровій панелі).
    for (const [, a] of ACTIONS) if (a && keys[a] === DEFAULT_KEYS[a]![0]) delete keys[a];
    o.onChange({ ...keys });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!waiting) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== 'Escape' && !RESERVED.has(e.code)) set(waiting, e.code);
    waiting = null;
    paint();
  };
  window.addEventListener('keydown', onKey, true);
  texButton(art, stage, 'aleft', 259, 157, 'Попередній пристрій', { ext: '.msk', disabled: true, action: () => {} });
  texButton(art, stage, 'aright', 514, 157, 'Наступний пристрій', { ext: '.msk', disabled: true, action: () => {} });
  text(stage, 'Клавіатура', 299, 178, { width: 204, size: 14 });
  ACTIONS.forEach(([name, bind], n) => {
    const col = Math.floor(n / 11);
    const y = 194 + 20 * (n % 11) + 15;
    text(stage, name, 222 + 180 * col, y, { size: 10 });
    const cell = text(stage, '—', 221 + 107 + 180 * col, y, { size: 10, color: '#fff' });
    if (!bind) return;
    cells.push([bind, cell]);
    // Рядок — зона дотику: чекати на клавішу.
    const row = document.createElement('button');
    row.className = 'menu-abs';
    row.style.cssText += 'background:transparent;border:0;padding:0;cursor:pointer;';
    row.style.left = `${220 + 180 * col}px`;
    row.style.top = `${194 + 20 * (n % 11)}px`;
    row.style.width = '178px';
    row.style.height = '20px';
    row.setAttribute('aria-label', name);
    row.addEventListener('click', () => {
      waiting = waiting === bind ? null : bind;
      paint();
    });
    stage.append(row);
  });
  paint();
  texButton(art, stage, 'c/def', 350, 443, 'За замовчуванням', {
    action: () => {
      keys = {};
      waiting = null;
      o.onChange({});
      paint();
    },
  });
  texButton(art, stage, 'c/canc', 323, 490, 'Скасувати', {
    action: () => {
      o.onChange(was);
      o.onCancel();
    },
  });
  return () => {
    window.removeEventListener('keydown', onKey, true);
    sc.close();
  };
}

export interface DriverInfo {
  name: string;
  /** Логотип 0…7 і фото 0…50. */
  logo: number;
  photo: number;
}

export interface DriversScreen {
  /** Усі водії (king.exe — усі `*.pl1`) і поточний (`lastp`) чи null — немає. */
  drivers(): DriverInfo[];
  current(): string | null;
  /** Створити водія чи оновити логотип і фото наявного; зробити поточним. */
  onPut(d: DriverInfo): void;
  onSelect(name: string): void;
  /** Видалити водія (з підтвердженням); true — видалено. */
  onDelete(name: string): Promise<boolean>;
  onCancel(): void;
  onRound(key: RoundKey): void;
}

/**
 * Рядок списку водіїв, px; стрілки списку atop/abot — у круглих гніздах ліворуч від поля: найкращий збіг картинки
 * стрілки з гніздом `d/backDriv` (x 308 — як у списку king.exe).
 */
const DRIVER_ROW = 15;
const DRIVER_LIST = { x: 347, y: 326, w: 78, h: 120 };
const DRIVER_ARROWS = [
  [308, 324],
  [308, 424],
] as const;

/**
 * Водії (`d/backDriv`, 0x51b640): логотип і фото стрілками, поле імені, список водіїв, «Видалити». Як в оригіналі
 * (застосувати 0x51bfa0): нове імʼя в полі — новий водій (наявне — вибрати його); вибір у списку — поточний водій.
 */
export function ht2DriversScreen(art: Ht2MenuArt, o: DriversScreen): () => void {
  const sc = screen(art, 'd/backdriv.txr', o.onRound);
  const { stage } = sc;
  const find = (name: string | null) => o.drivers().find((x) => x.name === name) ?? null;
  // Немає водіїв — у полі імʼя за замовчуванням; водій зʼявиться після першої зміни (чи нової гри).
  let d: DriverInfo = { ...(find(o.current()) ?? { name: 'Водій', logo: 4, photo: 0 }) };
  const pic = (x: number, y: number) => {
    const img = document.createElement('img');
    img.alt = '';
    img.className = 'menu-abs';
    img.style.left = `${x}px`;
    img.style.top = `${y}px`;
    img.style.pointerEvents = 'none';
    stage.append(img);
    return img;
  };
  const logo = pic(342, 129);
  const photo = pic(450, 219);
  // Поле імені «ЗА КЕРМОМ» (до 34 символів).
  const name = document.createElement('input');
  name.className = 'menu-abs';
  name.maxLength = 34;
  name.setAttribute('aria-label', 'Імʼя водія');
  name.style.cssText += TEXT + 'pointer-events:auto;background:transparent;border:0;outline:0;padding:0;width:96px;height:14px;text-transform:uppercase;';
  name.style.left = '313px';
  name.style.top = '268px';
  // Список водіїв: рядки (дотик — вибрати), гортання стрілками й пальцем.
  const list = document.createElement('div');
  list.className = 'menu-abs ht2-drivers';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Водії');
  Object.assign(list.style, { left: `${DRIVER_LIST.x}px`, top: `${DRIVER_LIST.y}px`, width: `${DRIVER_LIST.w}px`, height: `${DRIVER_LIST.h}px` });
  const paintList = () => {
    list.replaceChildren(
      ...o.drivers().map((x) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ht2-driver-row';
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(x.name === o.current()));
        row.style.height = `${DRIVER_ROW}px`;
        row.textContent = x.name;
        row.addEventListener('click', () => {
          o.onSelect(x.name);
          d = { ...x };
          paint();
        });
        return row;
      }),
    );
    if (!list.childElementCount) list.textContent = 'Немає водіїв';
  };
  const painters: (() => void)[] = [];
  const paint = () => {
    logo.src = art.image(`d/logo${d.logo + 1}.msk`) ?? '';
    photo.src = art.image(`d/photo${String(d.photo + 1).padStart(2, '0')}.msk`) ?? '';
    if (document.activeElement !== name) name.value = d.name;
    paintList();
    painters.forEach((p) => p());
  };
  const change = (f: () => void) => () => {
    f();
    o.onPut({ ...d });
    paint();
  };
  name.addEventListener('change', () => {
    const v = name.value.trim();
    if (v) {
      const known = find(v);
      if (known) {
        o.onSelect(v);
        d = { ...known };
      } else {
        d = { ...d, name: v };
        o.onPut({ ...d });
      }
    }
    name.value = d.name;
    paint();
  });
  name.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') name.blur();
  });
  stage.append(name, list);
  texButton(art, stage, 'aleft', 308, 175, 'Попередній логотип', { ext: '.msk', action: change(() => (d.logo = (d.logo + 7) % 8)) });
  texButton(art, stage, 'aright', 463, 175, 'Наступний логотип', { ext: '.msk', action: change(() => (d.logo = (d.logo + 1) % 8)) });
  texButton(art, stage, 'aleft', 416, 265, 'Попереднє фото', { ext: '.msk', action: change(() => (d.photo = (d.photo + 50) % 51)) });
  texButton(art, stage, 'aright', 571, 265, 'Наступне фото', { ext: '.msk', action: change(() => (d.photo = (d.photo + 1) % 51)) });
  const scroll = (dir: number) => () => list.scrollBy({ top: dir * DRIVER_ROW * 3 });
  texButton(art, stage, 'atop', DRIVER_ARROWS[0][0], DRIVER_ARROWS[0][1], 'Гортати водіїв угору', { ext: '.msk', action: scroll(-1) });
  texButton(art, stage, 'abot', DRIVER_ARROWS[1][0], DRIVER_ARROWS[1][1], 'Гортати водіїв униз', { ext: '.msk', action: scroll(1) });
  painters.push(
    texButton(art, stage, 'd/deldriv', 434, 418, 'Видалити водія', {
      disabled: () => !find(o.current()),
      action: () => {
        const cur = o.current();
        if (!cur) return;
        void o.onDelete(cur).then((gone) => {
          if (!gone) return;
          d = { ...(find(o.current()) ?? { name: 'Водій', logo: 4, photo: 0 }) };
          paint();
        });
      },
    }),
  );
  texButton(art, stage, 'd/canc', 323, 481, 'Скасувати', { action: o.onCancel });
  paint();
  return sc.close;
}

export interface RecordsScreen {
  onCancel(): void;
  onRound(key: RoundKey): void;
}

/** Відеоплеєр (`r/backRcrd`, 0x518d20): відтворення й запис фільмів — у порту записів немає. */
export function ht2RecordsScreen(art: Ht2MenuArt, o: RecordsScreen): () => void {
  const sc = screen(art, 'r/backrcrd.txr', o.onRound);
  const { stage } = sc;
  texButton(art, stage, 'r/repl', 332, 145, 'Відеоповтор', { disabled: true, action: () => {} });
  text(stage, 'Записів немає', 336, 214, { size: 11 });
  texButton(art, stage, 'r/delrec', 475, 285, 'Видалити запис', { disabled: true, action: () => {} });
  texButton(art, stage, 'r/rec', 332, 343, 'Запис', { disabled: true, action: () => {} });
  text(stage, 'Фільм', 341, 417, { size: 11 });
  texButton(art, stage, 'r/canc', 332, 465, 'Скасувати', { action: o.onCancel });
  return sc.close;
}
