import { screen, texButton, type Ht2MenuArt, type RoundKey } from './menu';
import type { Ht2Settings } from './settings';

/**
 * Екрани меню LOAD.RES «Графіка», «Керування», «Водії», «Відеоплеєр» — розклад king.exe (re/notes/ht2/menu-screens.md;
 * координати — сцена 800×600, як у одиночної гри). Написи, які гра малює кодом, — українською (у фонах лишаються
 * оригінальні). Що в порту діє:
 * - графіка — роздільність 640×480…1600×1200 (висота кадру рендерера), «Автопошук» — за екраном пристрою; повзунки
 *   «спецефекти» й «детальність» у порту не діють (неактивні);
 * - керування — таблиця 22 дій з клавішами порту; перепризначення клавіш у порту немає;
 * - водії — імʼя, логотип (`d/logo1…8`) і фото (`d/photo01…51`) водія кар'єри, список («недавні» — збереження порту),
 *   «Видалити» — стерти кар'єру;
 * - відеоплеєр — записів (файли .tr/.mvp оригіналу) у порту немає: список порожній, кнопки неактивні.
 */

/** Висота кадру для кнопок роздільності (`[DRVn] vpas/vpam/vpal/vpasl` king.exe). */
export const RESOLUTION_H = [480, 600, 768, 1200];

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
  // Адаптер: у порту — один (WebGL).
  painters.push(texButton(art, stage, 'aleft', 324, 263, 'Попередня відеокарта', { ext: '.msk', disabled: true, action: () => {} }));
  painters.push(texButton(art, stage, 'aright', 536, 263, 'Наступна відеокарта', { ext: '.msk', disabled: true, action: () => {} }));
  text(stage, 'WEBGL', 329, 257, { width: 255, size: 14 });
  const res: [string, number, number, string][] = [
    ['small', 329, 293, '640×480'],
    ['med', 441, 293, '800×600'],
    ['large', 329, 330, '1024×768'],
    ['huge', 441, 330, '1600×1200'],
  ];
  res.forEach(([tex, x, y, label], i) => painters.push(texButton(art, stage, `g/${tex}`, x, y, label, { selected: () => (s.resolution ?? 2) === i, action: () => pick(i), after: repaint })));
  painters.push(slider(art, stage, 349, 370, () => 1, 'Спецефекти'));
  painters.push(slider(art, stage, 349, 405, () => 1, 'Детальність'));
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

/**
 * Дії таблиці керування king.exe (0x514d10): стовпчик 1 — 11 рядків, стовпчик 2 — 11; назви — mess.txt (0x29…0x66),
 * клавіші — порту (input.ts); «—» — дії порту немає.
 */
const ACTIONS: [string, string, string?][] = [
  ['Кермо ліворуч', '←'],
  ['Кермо праворуч', '→'],
  ['Газ', '↑'],
  ['Гальмо', '↓'],
  ['Ручне гальмо', 'SHIFT'],
  ['Передача вгору', '—'],
  ['Передача вниз', '—'],
  ['Запалювання', 'ПРОБІЛ'],
  ['Фари', 'L'],
  ['Напівпричіп', 'T'],
  ['Сигнал', 'H'],
  ['Двірники', 'W'],
  ['Пейджер', '—'],
  ['Зовнішня камера', 'C'],
  ['Камера ліворуч', '—'],
  ['Камера праворуч', '—'],
  ['Камера ближче', '—'],
  ['Камера далі', '—'],
  ['Карта', 'TAB'],
  ['Купівля', '—'],
  ['Повернення', '—'],
  ['Монітор', '—'],
];

export interface ControlsScreen {
  onCancel(): void;
  onRound(key: RoundKey): void;
  note(text: string, parent: HTMLElement): void;
}

/** Керування (`c/backCtrl`, 0x513b30): пристрій, таблиця дій, «за замовчуванням». */
export function ht2ControlsScreen(art: Ht2MenuArt, o: ControlsScreen): () => void {
  const sc = screen(art, 'c/backctrl.txr', o.onRound);
  const { stage, root } = sc;
  texButton(art, stage, 'aleft', 259, 157, 'Попередній пристрій', { ext: '.msk', disabled: true, action: () => {} });
  texButton(art, stage, 'aright', 514, 157, 'Наступний пристрій', { ext: '.msk', disabled: true, action: () => {} });
  text(stage, 'Клавіатура', 299, 178, { width: 204, size: 14 });
  ACTIONS.forEach(([name, key], n) => {
    const col = Math.floor(n / 11);
    const y = 194 + 20 * (n % 11) + 15;
    text(stage, name, 222 + 180 * col, y, { size: 10 });
    text(stage, key, 221 + 107 + 180 * col, y, { size: 10, color: '#fff' });
    // Рядок — зона дотику (перепризначення клавіш у порті немає).
    const row = document.createElement('button');
    row.className = 'menu-abs';
    row.style.cssText += 'background:transparent;border:0;padding:0;cursor:pointer;';
    row.style.left = `${220 + 180 * col}px`;
    row.style.top = `${194 + 20 * (n % 11)}px`;
    row.style.width = '178px';
    row.style.height = '20px';
    row.setAttribute('aria-label', name);
    row.addEventListener('click', () => o.note('Перепризначення клавіш у порті ще недоступне.', root));
    stage.append(row);
  });
  texButton(art, stage, 'c/def', 350, 443, 'За замовчуванням', { action: () => o.note('Клавіші порту — типові.', root) });
  texButton(art, stage, 'c/canc', 323, 490, 'Скасувати', { action: o.onCancel });
  return sc.close;
}

export interface DriverInfo {
  name: string;
  /** Логотип 0…7 і фото 0…50. */
  logo: number;
  photo: number;
}

export interface DriversScreen {
  /** Поточний водій (кар'єра) чи null — немає. */
  driver: DriverInfo | null;
  onChange(d: DriverInfo): void;
  onDelete(): void;
  onCancel(): void;
  onRound(key: RoundKey): void;
}

/** Водії (`d/backDriv`, 0x51b640): логотип і фото стрілками, імʼя, «недавні», «Видалити». */
export function ht2DriversScreen(art: Ht2MenuArt, o: DriversScreen): () => void {
  const sc = screen(art, 'd/backdriv.txr', o.onRound);
  const { stage } = sc;
  const d: DriverInfo = o.driver ? { ...o.driver } : { name: 'Водій', logo: 4, photo: 0 };
  const has = !!o.driver;
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
  const paint = () => {
    logo.src = art.image(`d/logo${d.logo + 1}.msk`) ?? '';
    photo.src = art.image(`d/photo${String(d.photo + 1).padStart(2, '0')}.msk`) ?? '';
  };
  const change = (f: () => void) => () => {
    f();
    paint();
    o.onChange({ ...d });
  };
  texButton(art, stage, 'aleft', 308, 175, 'Попередній логотип', { ext: '.msk', disabled: !has, action: change(() => (d.logo = (d.logo + 7) % 8)) });
  texButton(art, stage, 'aright', 463, 175, 'Наступний логотип', { ext: '.msk', disabled: !has, action: change(() => (d.logo = (d.logo + 1) % 8)) });
  texButton(art, stage, 'aleft', 416, 265, 'Попереднє фото', { ext: '.msk', disabled: !has, action: change(() => (d.photo = (d.photo + 50) % 51)) });
  texButton(art, stage, 'aright', 571, 265, 'Наступне фото', { ext: '.msk', disabled: !has, action: change(() => (d.photo = (d.photo + 1) % 51)) });
  // Поле імені «ЗА КЕРМОМ» (до 34 символів).
  const name = document.createElement('input');
  name.className = 'menu-abs';
  name.maxLength = 34;
  name.value = d.name;
  name.disabled = !has;
  name.setAttribute('aria-label', 'Імʼя водія');
  name.style.cssText += TEXT + 'pointer-events:auto;background:transparent;border:0;outline:0;padding:0;width:96px;height:14px;text-transform:uppercase;';
  name.style.left = '313px';
  name.style.top = '268px';
  name.addEventListener('change', () => {
    d.name = name.value.trim() || d.name;
    name.value = d.name;
    o.onChange({ ...d });
  });
  stage.append(name);
  // «Недавні» — збереження порту (одне).
  text(stage, has ? d.name : 'Немає водіїв', 312, 336, { size: 11 });
  texButton(art, stage, 'd/deldriv', 434, 418, 'Видалити водія', { disabled: !has, action: o.onDelete });
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
