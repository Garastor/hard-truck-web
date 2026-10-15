/**
 * Українські написи на графіці інтерфейсу `esc16.RES`. Кнопки `m_16\<імʼя>_<стан>.txr` — шматок фону панелі під
 * кнопкою з російським написом поверх (перевірено: поза написом кнопка збігається з фоном у тій самій точці);
 * стани відрізняються лише кольором напису. Тому старий напис з тінню замінюється фоном панелі під кнопкою (без
 * фону — заповненням по стовпчиках), а новий пишеться кольором напису цього стану, виміряним на картинці.
 * Підписи на фонах — заповнення по стовпчиках між рядками над і під написом, поверх — новий підпис.
 */

/** Напис кнопки українською (ключ — імʼя без стану й теки, нижній регістр). */
export const BUTTON_UK: Record<string, string> = {
  savg: 'ЗБЕРЕГТИ ГРУ',
  loadg: 'ЗАВАНТАЖИТИ ГРУ',
  restart: 'ПОЧАТИ СПОЧАТКУ',
  control: 'КЕРУВАННЯ',
  sound: 'ЗВУК',
  main: 'ГОЛОВНЕ МЕНЮ',
  exitsys: 'ВИХІД',
  exsave: 'ЗБЕРЕГТИ',
  exnsave: 'НЕ ЗБЕРІГАТИ',
  excanc: 'СКАСУВАТИ',
  // СТО й заправка («ОК» — так само українською, лишається).
  servcanc: 'СКАСУВАТИ',
  gascanc: 'СКАСУВАТИ',
};

/**
 * Групи кнопок (одне вікно): у групі літери однакової ширини — стиск за найдовшим написом групи, а не кожен напис
 * окремо (на прохання користувача).
 */
const GROUPS: { keys: string[]; width: number }[] = [
  // Меню Esc: кнопки 150 px, відступ зліва до 10 і справа 4.
  { keys: ['savg', 'loadg', 'restart', 'control', 'sound', 'main', 'exitsys', 'exsave', 'exnsave', 'excanc'], width: 136 },
  { keys: ['servcanc'], width: 118 },
  { keys: ['gascanc'], width: 72 },
];

const groupScale = new Map<string, number>();

/** Стиск по горизонталі для групи кнопки: щоб найдовший напис групи вмістився. */
function scaleFor(base: string): number {
  const group = GROUPS.find((g) => g.keys.includes(base)) ?? { keys: [base], width: 136 };
  const id = group.keys.join(',');
  if (!groupScale.has(id)) {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `bold ${Math.round(CAP / 0.72)}px ${FONT}`;
    const widest = Math.max(...group.keys.map((b) => ctx.measureText(BUTTON_UK[b] ?? '').width));
    groupScale.set(id, Math.min(1, group.width / Math.max(1, widest)));
  }
  return groupScale.get(id)!;
}

/**
 * Підпис на фоні вікна: що замалювати (старий напис з тінню), новий текст, прив'язка (x і базова лінія), висота
 * великих літер. Колір без явного — виміряний на старому написі (найсвітліші пікселі). group — підписи з однаковою
 * шириною літер (стиск за найдовшим у групі); spacing — розрідження літер заголовків («С Е Р В И С»).
 */
interface Label {
  erase: [number, number, number, number];
  text: string;
  x: number;
  base: number;
  align: 'left' | 'right' | 'center';
  cap: number;
  maxW: number;
  group?: string;
  color?: string;
  spacing?: number;
}

/**
 * Підпис у клітинці таблиці (СТО, склад, ринок, заправка): верх літер top, висота 11, тінь — до top + 12; нижня лінія
 * клітинки СТО — top + 14, тож опора заповнення — рядок top + 13 (з лінією були світлі смуги). Виміряно: текст (165, 205, 174) з темною тінню.
 */
function cell(x0: number, x1: number, top: number, text: string, align: 'left' | 'right' | 'center', group: string): Label {
  const x = align === 'right' ? x1 - 3 : align === 'left' ? x0 + 4 : (x0 + x1) / 2;
  return { erase: [x0, top - 2, x1, top + 12], text, x, base: top + 11, align, cap: 11, maxW: x1 - x0 - 6, group };
}

/** Стовпчик клітинок з кроком step. */
function column(x0: number, x1: number, top: number, step: number, texts: string[], align: 'left' | 'right', group: string): Label[] {
  return texts.map((t, i) => cell(x0, x1, top + step * i, t, align, group));
}

/** Заголовок вікна по центру. */
function title(erase: [number, number, number, number], text: string, x: number, base: number, cap: number, spacing = 0): Label {
  return { erase, text, x, base, align: 'center', cap, maxW: erase[2] - erase[0] + 30, spacing };
}

/** Виміряно на фонах (re/notes/ht2/ui.md §3): клітинки, заголовки, кольори. */
const BACKGROUND_UK: Record<string, Label[]> = {
  'm_16/backescmain.txr': [
    { erase: [26, 394, 148, 410], text: 'ПРОБЛЕМИ', x: 87, base: 409, align: 'center', cap: 14, maxW: 150, group: 'esc', color: 'rgb(205,207,206)' },
    { erase: [48, 417, 126, 433], text: 'В ДОРОЗІ', x: 87, base: 432, align: 'center', cap: 14, maxW: 150, group: 'esc', color: 'rgb(205,207,206)' },
  ],
  'm_16/backservice.txr': [
    title([283, 416, 404, 437], 'СЕРВІС', 343, 434, 15, 6),
    title([296, 459, 402, 478], 'ПОШКОДЖЕННЯ', 349, 475, 14),
    title([292, 570, 398, 590], 'МОДЕРНІЗАЦІЇ', 345, 587, 14),
    ...column(257, 362, 485, 19, ['ДВИГУН', 'КОРОБКА ПЕРЕДАЧ', 'ТРАНСМІСІЯ', 'ГАЛЬМА'], 'right', 'svc'),
    ...column(438, 543, 485, 19, ['ФАРИ', 'КУЗОВ', 'ШИНИ', 'ПОВНИЙ РЕМОНТ'], 'right', 'svc'),
    ...column(257, 362, 598, 19, ['ФОРСОВАНИЙ ДВИГУН', 'ПРИСАДКА В ДВИГУН', 'ПОВІТРОЗАБІРНИК', 'ШИНИ HIGH-WAY', 'ШИНИ ВСЮДИХІД', 'ДОДАТКОВИЙ БАК', 'АБС'], 'right', 'svc'),
    ...column(438, 543, 598, 19, ['РАДАР-ДЕТЕКТОР', 'РАДАР-ГЛУШНИК', 'СКАНЕР ВАНТАЖУ', 'ПОЖЕЖНА СИСТЕМА', 'НАВІГАТОР', 'СИГНАЛ', 'ВСТАНОВИТИ ВСЕ'], 'right', 'svc'),
    ...column(49, 181, 617, 19, ['ПНЕВМОПІДВІСКА', 'ВЕНТИЛЬОВАНІ ГАЛЬМА', 'ГАЛЬМУВАННЯ ДВИГУНОМ', 'ПОСИЛЕНА РАМА', 'БРОНЬОВАНЕ СКЛО', 'ЗАХИСТ ФАР'], 'right', 'svc'),
    { ...cell(164, 269, 748, 'МІЙ БАЛАНС', 'right', 'svcsum'), erase: [164, 747, 269, 764], cap: 12, base: 760 },
    { ...cell(345, 450, 748, 'РАЗОМ', 'right', 'svcsum'), erase: [345, 747, 450, 764], cap: 12, base: 760 },
  ],
  'm_16/backorder.txr': [
    title([69, 415, 182, 437], 'ЗАМОВЛЕННЯ', 125, 433, 15, 2),
    ...column(38, 118, 558, 20, ['ВАНТАЖ', 'КУДИ', 'МАКС. ПРЕМІЯ', 'МАКС. ЧАС', 'ВАГА', 'ОБʼЄМ', 'КРИХКІСТЬ'], 'left', 'ord'),
  ],
  'm_16/backsale.txr': [
    title([58, 415, 192, 437], 'ПРОДАЄТЬСЯ', 125, 434, 15, 1),
    ...column(52, 95, 588, 20, ['КОД', 'ЦІНА'], 'left', 'sale'),
    ...column(52, 135, 628, 20, ['ПОТУЖНІСТЬ', 'ВАНТАЖНІСТЬ'], 'left', 'sale'),
  ],
  'm_16/backgas.txr': [
    // Підписи над табличками цифр — помаранчеві, без клітинок.
    { erase: [64, 446, 135, 463], text: 'СУМА, $', x: 69, base: 460, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    { erase: [64, 495, 135, 512], text: 'ЛІТРИ', x: 67, base: 509, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    { erase: [64, 545, 135, 562], text: 'ЗА ЛІТР', x: 67, base: 559, align: 'left', cap: 10, maxW: 70, group: 'gasplate' },
    cell(41, 159, 629, 'РІВЕНЬ', 'center', 'gas'),
    cell(162, 207, 628, 'ПОВНИЙ', 'center', 'gas'),
    cell(43, 126, 689, 'ЛІТРИ', 'center', 'gas'),
  ],
};

const FONT = '"Arial Narrow", "Roboto Condensed", "Helvetica Neue", Arial, sans-serif';
/** Запас навколо старого напису: тінь зміщена вниз-праворуч. */
const SHADOW = 4;
/** Висота великих літер напису кнопки, px. */
const CAP = 15;

/** Пікселі напису: ті, що відрізняються між станами. */
function textMask(states: ImageData[]): Uint8Array {
  const { width: w, height: h } = states[0];
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const j = i * 4;
    for (let s = 1; s < states.length; s++) {
      const a = states[0].data;
      const b = states[s].data;
      if (Math.abs(a[j] - b[j]) + Math.abs(a[j + 1] - b[j + 1]) + Math.abs(a[j + 2] - b[j + 2]) > 24) {
        m[i] = 1;
        break;
      }
    }
  }
  return m;
}

function bbox(mask: Uint8Array, w: number, h: number): [number, number, number, number] | null {
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (mask[y * w + x]) {
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
  return x1 < 0 ? null : [x0, y0, x1, y1];
}

/** Колір напису стану: середнє найсвітлішої третини пікселів маски. */
function inkColor(img: ImageData, mask: Uint8Array): string {
  const px: [number, number, number][] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) px.push([img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]]);
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const top = px.slice(Math.floor((px.length * 2) / 3));
  if (!top.length) return 'rgb(240,240,240)';
  const avg = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k], 0) / top.length));
  return `rgb(${avg.join(',')})`;
}

/** Заповнює прямокутник по стовпчиках лінійно між пікселем над ним і під ним (край зображення — найближчим рядком). */
function fillColumns(img: ImageData, x0: number, y0: number, x1: number, y1: number): void {
  const { width: w, height: h, data } = img;
  x0 = Math.max(0, x0);
  x1 = Math.min(w - 1, x1);
  const top = y0 - 1;
  const bottom = y1 + 1;
  for (let x = x0; x <= x1; x++) {
    const a = (Math.max(0, top) * w + x) * 4;
    const b = (Math.min(h - 1, bottom) * w + x) * 4;
    // Напис біля краю кнопки — опора лише з одного боку.
    const ia = top < 0 ? b : a;
    const ib = bottom >= h ? a : b;
    for (let y = Math.max(0, y0); y <= Math.min(h - 1, y1); y++) {
      const t = (y - top) / (bottom - top);
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) data[i + ch] = data[ia + ch] + (data[ib + ch] - data[ia + ch]) * t;
      data[i + 3] = 255;
    }
  }
}

/** Рядок тексту з тінню: висота великих літер cap, базова лінія y; стискається до maxW. */
/** Ширина тексту поточним шрифтом з розрідженням spacing між літерами. */
function textWidth(ctx: CanvasRenderingContext2D, text: string, spacing = 0): number {
  return ctx.measureText(text).width + spacing * Math.max(0, [...text].length - 1);
}

function drawText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  cap: number,
  maxW: number,
  color: string,
  align: 'left' | 'right' | 'center',
  underline = false,
  fixed?: number,
  spacing = 0,
): void {
  ctx.font = `bold ${Math.round(cap / 0.72)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  const tw = textWidth(ctx, text, spacing);
  const k = fixed ?? Math.min(1, maxW / Math.max(1, tw));
  ctx.save();
  ctx.translate(align === 'center' ? x - (tw * k) / 2 : align === 'right' ? x - tw * k : x, y);
  ctx.scale(k, 1);
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 2;
  ctx.fillStyle = color;
  if (spacing) {
    let cx = 0;
    for (const ch of text) {
      ctx.fillText(ch, cx, 0);
      cx += ctx.measureText(ch).width + spacing;
    }
  } else ctx.fillText(text, 0, 0);
  if (underline) ctx.fillRect(0, 3, tw, 2);
  ctx.restore();
}

function toCanvas(img: ImageData): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(img, 0, 0);
  return c;
}

/**
 * Українські стани кнопки. states — картинки станів (`p`, `a`, `ap`, `f`…; той самий розмір), under — фон панелі під
 * кнопкою того ж розміру (без нього — заповнення по стовпчиках). null — перекладу немає.
 */
export function localizeButton(base: string, states: Record<string, ImageData>, under: ImageData | null): Record<string, HTMLCanvasElement> | null {
  const text = BUTTON_UK[base];
  const keys = Object.keys(states);
  if (!text || keys.length < 2) return null;
  const src = keys.map((k) => states[k]);
  const { width: w, height: h } = src[0];
  const mask = textMask(src);
  const box = bbox(mask, w, h);
  if (!box) return null;
  // Усі кнопки m_16 — одним кеглем, як в оригіналі (великі літери в рядках 1…16 кнопки 150×30, виміряно); базова
  // лінія — під ними.
  const cap = CAP;
  const top = Math.max(1, box[1]);
  const k = scaleFor(base);
  const out: Record<string, HTMLCanvasElement> = {};
  keys.forEach((key, i) => {
    const img = new ImageData(new Uint8ClampedArray(src[i].data), w, h);
    const color = inkColor(src[i], mask);
    const [x0, y0, x1, y1] = [box[0] - 1, box[1] - 1, Math.min(w - 1, box[2] + SHADOW), Math.min(h - 1, box[3] + SHADOW)];
    if (under && under.width === w && under.height === h) {
      for (let y = Math.max(0, y0); y <= y1; y++)
        for (let x = Math.max(0, x0); x <= x1; x++) {
          const j = (y * w + x) * 4;
          img.data[j] = under.data[j];
          img.data[j + 1] = under.data[j + 1];
          img.data[j + 2] = under.data[j + 2];
          img.data[j + 3] = 255;
        }
    } else fillColumns(img, x0, y0, x1, y1);
    const c = toCanvas(img);
    // Натиснута / вибрана — зсув на піксель і підкреслення, як в оригіналі.
    const pressed = key === 'ap' || key === 'pp';
    drawText(c.getContext('2d')!, text, box[0] + (pressed ? 1 : 0), top + cap + (pressed ? 1 : 0), cap, w - box[0] - 4, color, 'left', pressed, k);
    out[key] = c;
  });
  return out;
}

/** Колір старого напису: середнє найсвітлішої шостини пікселів прямокутника. */
function brightest(img: ImageData, [x0, y0, x1, y1]: [number, number, number, number]): string {
  const px: [number, number, number][] = [];
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++)
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const i = (y * img.width + x) * 4;
      px.push([img.data[i], img.data[i + 1], img.data[i + 2]]);
    }
  px.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const top = px.slice(Math.floor((px.length * 5) / 6));
  const avg = [0, 1, 2].map((k) => Math.round(top.reduce((s, p) => s + p[k], 0) / Math.max(1, top.length)));
  return `rgb(${avg.join(',')})`;
}

/** Замінює російські підписи фону вікна українськими (на місці). */
export function localizeBackground(name: string, canvas: HTMLCanvasElement): void {
  const items = BACKGROUND_UK[name];
  if (!items) return;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const colors = items.map((it) => it.color ?? brightest(img, it.erase));
  for (const { erase } of items) fillColumns(img, ...erase);
  ctx.putImageData(img, 0, 0);
  // Одна група — один стиск (за найдовшим підписом відносно його місця).
  const scale = new Map<string, number>();
  items.forEach((it, i) => {
    ctx.font = `bold ${Math.round(it.cap / 0.72)}px ${FONT}`;
    const k = Math.min(1, it.maxW / Math.max(1, textWidth(ctx, it.text, it.spacing)));
    const g = it.group ?? `#${i}`;
    scale.set(g, Math.min(scale.get(g) ?? 1, k));
  });
  items.forEach((it, i) => drawText(ctx, it.text, it.x, it.base, it.cap, it.maxW, colors[i], it.align, false, scale.get(it.group ?? `#${i}`), it.spacing));
}
