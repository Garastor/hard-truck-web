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
};

/**
 * Групи кнопок (одне вікно): у групі літери однакової ширини — стиск за найдовшим написом групи, а не кожен напис
 * окремо (на прохання користувача).
 */
const GROUPS: string[][] = [['savg', 'loadg', 'restart', 'control', 'sound', 'main', 'exitsys', 'exsave', 'exnsave', 'excanc']];
/** Найбільша ширина напису на кнопці 150 px (відступ зліва до 10 і справа 4). */
const BUTTON_TEXT_W = 136;

const groupScale = new Map<string, number>();

/** Стиск по горизонталі для групи кнопки: щоб найдовший напис групи вмістився. */
function scaleFor(base: string): number {
  const group = GROUPS.find((g) => g.includes(base)) ?? [base];
  const id = group.join(',');
  if (!groupScale.has(id)) {
    const ctx = document.createElement('canvas').getContext('2d')!;
    ctx.font = `bold ${Math.round(CAP / 0.72)}px ${FONT}`;
    const widest = Math.max(...group.map((b) => ctx.measureText(BUTTON_UK[b] ?? '').width));
    groupScale.set(id, Math.min(1, BUTTON_TEXT_W / Math.max(1, widest)));
  }
  return groupScale.get(id)!;
}

/** Підпис на фоні: рамка старого напису [x0, y0, x1, y1] (без тіні), новий текст, центр рядка по x. */
interface Label {
  box: [number, number, number, number];
  text: string;
  center: number;
  color: string;
}

/** Виміряно на `BackEscMain`: заголовок двома рядками, світло-сірий, центр — x ≈ 87. */
const BACKGROUND_UK: Record<string, Label[]> = {
  'm_16/backescmain.txr': [
    { box: [28, 395, 145, 408], text: 'ПРОБЛЕМИ', center: 87, color: 'rgb(205,207,206)' },
    { box: [50, 418, 123, 431], text: 'В ДОРОЗІ', center: 87, color: 'rgb(205,207,206)' },
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
function drawText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, cap: number, maxW: number, color: string, align: 'left' | 'center', underline = false, fixed?: number): void {
  ctx.font = `bold ${Math.round(cap / 0.72)}px ${FONT}`;
  ctx.textBaseline = 'alphabetic';
  const tw = ctx.measureText(text).width;
  const k = fixed ?? Math.min(1, maxW / Math.max(1, tw));
  ctx.save();
  ctx.translate(align === 'center' ? x - (tw * k) / 2 : x, y);
  ctx.scale(k, 1);
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowOffsetX = 2;
  ctx.shadowOffsetY = 2;
  ctx.shadowBlur = 2;
  ctx.fillStyle = color;
  ctx.fillText(text, 0, 0);
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

/** Замінює російські підписи фону панелі українськими (на місці). */
export function localizeBackground(name: string, canvas: HTMLCanvasElement): void {
  const items = BACKGROUND_UK[name];
  if (!items) return;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  for (const { box } of items) fillColumns(img, box[0] - 2, box[1] - 1, box[2] + 3, box[3] + 2);
  ctx.putImageData(img, 0, 0);
  // Рядки одного підпису — одним стиском (за найширшим).
  ctx.font = `bold ${Math.round((items[0].box[3] - items[0].box[1] + 1) / 0.72)}px ${FONT}`;
  const k = Math.min(1, ...items.map((it) => (canvas.width - 50) / Math.max(1, ctx.measureText(it.text).width)));
  for (const { box, text, center, color } of items) drawText(ctx, text, center, box[3] + 1, box[3] - box[1] + 1, canvas.width - 50, color, 'center', false, k);
}
