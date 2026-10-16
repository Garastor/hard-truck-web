/**
 * Українські написи в меню оригіналу. Кнопки LOAD.RES — картинки з російським текстом у станах
 * _b/_a/_p/_bp; між станами змінюється лише текст, тож пікселі тексту = пікселі, що відрізняються між
 * станами. Їх зафарбовуємо фоном (дифузія з сусідніх пікселів) і пишемо український напис кольорами
 * оригіналу. Підписи на фонах закриваємо шматком тієї ж смуги, зсунутим ліворуч, і пишемо поверх.
 */

/** Напис кнопки українською (\n — перенесення); відсутній — лишається оригінальний. */
export const BUTTON_UK: Record<string, string> = {
  'm/game': 'ГРА',
  'm/connec': 'МЕРЕЖЕВА ГРА',
  'm/quick': 'ПРОБНИЙ ЗАЇЗД',
  'm/driver': 'ЗМІНИТИ ВОДІЯ',
  'm/option': 'ОПЦІЇ',
  'm/demo': 'ДЕМО',
  'm/help': 'ДОПОМОГА',
  'm/reels': 'ВІДЕОКЛІПИ',
  'm/exit': 'ВИХІД З ГРИ',
  'n/arcad': 'АРКАДНИЙ',
  'n/simul': 'СИМУЛЯТОР',
  'n/new': 'НОВА\nГРА',
  'n/load': 'ЗАВАНТАЖИТИ\nГРУ',
  'n/cancel': 'СКАСУВАТИ',
  'd/cancel': 'СКАСУВАТИ',
  'o/ok': 'ОК',
  'o/defaul': 'ЗА ЗАМОВЧУВАННЯМ',
  'o/joyst': 'ГЕЙМПАД',
  'o/mouse': 'НАХИЛ',
  'o/keyb': 'КНОПКИ',
  'o/big': 'ВИСОКА',
  'o/med': 'СЕРЕДНЯ',
  'o/small': 'НИЗЬКА',
  'o/rs320': 'ВІКНО',
  'o/rs640': 'ЕКРАН',
  'o/rs800': 'ПРИСКОРЮВАЧ',
  'l/cancel': 'НАЗАД',
  'c/server': 'СТВОРИТИ ГРУ',
  'c/client': 'ПРИЄДНАТИСЯ',
  'c/change': 'КОД ТЕКСТОМ',
  'c/2main': 'ГОЛОВНЕ МЕНЮ',
  's/cancel': 'ВИЙТИ',
  's/start': 'СТАРТ',
};

/** Кольори тексту оригіналу за станами: заливка й тінь/контур (виміряно з масок). */
const STYLE: Record<string, { fill: string; edge: string }> = {
  // На прохання користувача — жовтий текст (в оригіналі звичайний стан фіолетовий); натиснута / вибрана — світліша.
  b: { fill: 'rgb(252,228,136)', edge: 'rgb(116,88,48)' },
  a: { fill: 'rgb(252,228,136)', edge: 'rgb(28,20,12)' },
  p: { fill: 'rgb(255,250,226)', edge: 'rgb(28,20,12)' },
  bp: { fill: 'rgb(255,250,226)', edge: 'rgb(28,20,12)' },
  /** Недоступна кнопка (режим не підтримується) — сірий текст. */
  off: { fill: 'rgb(120,120,120)', edge: 'rgb(30,30,30)' },
};

const FONT = '"Arial Narrow", "Roboto Condensed", Arial, sans-serif';

/** Висота великих літер напису, пікселів екрана 640×480 (однакова для всіх кнопок групи). */
const CAP: Record<string, number> = { m: 11, n: 12, d: 12, o: 9, l: 12, c: 12, s: 12 };
/** Підписи на фонах — тонкий геометричний шрифт, як в оригіналі. */
const LABEL_FONT = '"Century Gothic", "Futura", "Trebuchet MS", Arial, sans-serif';

/** Розширення маски тексту, пікселів (для замальовування, коли під кнопкою немає чистого фону). */
const GROW = 1;
/** Запас навколо старого напису, що замінюється фоном (тінь напису зміщена вниз-праворуч), пікселів. */
const PAD = 5;
/** Зсув тіні старого напису вниз-праворуч, пікселів. */
const SHADOW = 5;
/** Рамка кнопки (не замальовувати), пікселів від краю. */
const FRAME = 3;

/** Маска тексту: пікселі, що відрізняються між станами, розширені на GROW пікселів (контур і тінь). */
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
  // Розширення на GROW пікселів — контур напису.
  const out = m.slice();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (m[y * w + x])
        for (let dy = -GROW; dy <= GROW; dy++)
          for (let dx = -GROW; dx <= GROW; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
          }
  return out;
}

/**
 * Заповнює пікселі маски по стовпчиках: лінійно між найближчими незамаскованими пікселями над і під ними (напис —
 * горизонтальна смуга посередині кнопки; так зберігається малюнок плитки вище й нижче, а не розмивається в пляму).
 * Стовпчики без опори з обох боків — середнім сусідів (inpaint).
 */
function inpaintColumns(img: ImageData, mask: Uint8Array): void {
  const { width: w, height: h, data } = img;
  const rest = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!mask[y * w + x]) {
        y++;
        continue;
      }
      const y0 = y - 1;
      while (y < h && mask[y * w + x]) y++;
      const y1 = y;
      if (y0 < 0 || y1 >= h) {
        for (let k = Math.max(0, y0 + 1); k < y1; k++) rest[k * w + x] = 1;
        continue;
      }
      const a = (y0 * w + x) * 4;
      const b = (y1 * w + x) * 4;
      for (let k = y0 + 1; k < y1; k++) {
        const t = (k - y0) / (y1 - y0);
        const i = (k * w + x) * 4;
        for (let ch = 0; ch < 3; ch++) data[i + ch] = data[a + ch] + (data[b + ch] - data[a + ch]) * t;
        // Дірки (прозорі пікселі) усередині старого напису — теж заповнюємо, інакше просвічує тло.
        data[i + 3] = 255;
      }
    }
  }
  inpaint(img, rest);
}

/** Заповнює пікселі маски середнім уже відомих сусідів (шарами від краю всередину). */
function inpaint(img: ImageData, mask: Uint8Array): void {
  const { width: w, height: h, data } = img;
  const todo = mask.slice();
  for (let pass = 0; pass < 64; pass++) {
    const fill: [number, number, number, number][] = [];
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!todo[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const k = yy * w + xx;
            if (todo[k]) continue;
            r += data[k * 4];
            g += data[k * 4 + 1];
            b += data[k * 4 + 2];
            n++;
          }
        if (n) fill.push([i, r / n, g / n, b / n]);
      }
    if (!fill.length) break;
    for (const [i, r, g, b] of fill) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = 255;
      todo[i] = 0;
    }
  }
}

function bbox(mask: Uint8Array, w: number, h: number) {
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
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Напис у прямокутнику: розмір за висотою, стиснення за шириною; вирівнювання праворуч або по центру. */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  box: { x0: number; y0: number; x1: number; y1: number },
  maxW: number,
  align: 'right' | 'center',
  style: { fill: string; edge: string },
  outline: boolean,
  underline = false,
  cap?: number,
  weight = 'bold',
): void {
  const lines = text.split('\n');
  const lineH = (box.y1 - box.y0 + 1) / lines.length;
  const size = Math.max(8, Math.round((cap ?? lineH * 0.92) / 0.74));
  ctx.font = `${weight} ${size}px ${weight === 'bold' ? FONT : LABEL_FONT}`;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const tw = ctx.measureText(line).width;
    const k = Math.min(1, maxW / Math.max(1, tw));
    const w = tw * k;
    const x = align === 'right' ? box.x1 - w : (box.x0 + box.x1) / 2 - w / 2;
    const base = box.y0 + lineH * (i + 1) - Math.max(1, lineH * 0.12);
    ctx.save();
    ctx.translate(x, base);
    ctx.scale(k, 1);
    ctx.fillStyle = style.edge;
    if (outline) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1], [1, 1]]) ctx.fillText(line, dx, dy);
    else ctx.fillText(line, 1, 1);
    ctx.fillStyle = style.fill;
    ctx.fillText(line, 0, 0);
    if (underline) ctx.fillRect(0, 2, tw, 1);
    ctx.restore();
  });
}

/**
 * Українські стани кнопки: { b, a, p, bp?, off }. states — оригінальні полотна станів (той самий розмір).
 * Повертає null, якщо для кнопки немає перекладу.
 */
/**
 * under — фон екрана під кнопкою (той самий розмір), без перекладених підписів: кнопки меню оригіналу намальовані
 * поверх тієї ж смужки, що й на фоні, тож старий напис разом із його тінню замінюємо шматком фону (замальовування
 * лишало темні плями від тіні й розмивало смужку). Якщо поза текстом кнопка з фоном не збігається — замальовуємо.
 */
export function localizeButton(
  base: string,
  states: Record<string, HTMLCanvasElement | null>,
  under?: ImageData | null,
): Record<string, HTMLCanvasElement> | null {
  const text = BUTTON_UK[base];
  const keys = Object.keys(states).filter((k) => states[k]);
  if (!text || keys.length < 2) return null;
  const src = keys.map((k) => states[k]!.getContext('2d')!.getImageData(0, 0, states[k]!.width, states[k]!.height));
  const { width: w, height: h } = src[0];
  const mask = textMask(src);
  const box = bbox(mask, w, h);
  if (!box) return null;
  // Текст оригіналу притиснутий праворуч (головне меню, рівні) або по центру (великі кнопки).
  const align = box.x1 > w * 0.75 && box.x0 > w * 0.3 ? 'right' : 'center';
  const tight = { x0: box.x0 + GROW, y0: box.y0 + GROW, x1: box.x1 - GROW, y1: box.y1 - GROW };
  const maxW = align === 'right' ? tight.x1 - 8 : w - 10;
  // По центру — за шириною кнопки (старий напис бував зсунутий); однорядковий — і по висоті кнопки: у рамку
  // старого напису потрапляло його підкреслення, і новий сідав нижче середини.
  const cap = CAP[base.split('/')[0]];
  let place = align === 'center' ? { ...tight, x0: 0, x1: w - 1 } : tight;
  if (align === 'center' && cap && !text.includes('\n')) {
    // drawLabel: базова лінія — y0 + 0,88·висоти рядка; великі літери — cap над нею.
    const lineH = Math.round(cap * 1.6);
    const y0 = Math.round(h / 2 + cap / 2 - lineH * 0.88);
    place = { x0: 0, x1: w - 1, y0, y1: y0 + lineH - 1 };
  }
  // Для замальовування — маска з тінню: тінь напису оригіналу розмита й зміщена вниз-праворуч на 3–4 px і однакова в
  // усіх станах (у різницю не потрапляє); без неї замальовування розтягувало темні плями.
  // Увесь прямокутник старого напису з тінню (без рамки кнопки): поодинокі пікселі букв і тіні поза маскою
  // різниці лишались крапками.
  const shadowMask = mask.slice();
  for (let y = Math.max(FRAME, box.y0 - 1); y <= Math.min(h - 1 - FRAME, box.y1 + SHADOW); y++)
    for (let x = Math.max(FRAME, box.x0 - 1); x <= Math.min(w - 1 - FRAME, box.x1 + SHADOW + 1); x++) shadowMask[y * w + x] = 1;
  // Кнопки «Опцій»: фон екрана має під ними чисті плитки (без візерунка кнопки) — беремо плитку цілком, стан
  // кнопки показує колір напису.
  const whole = !!under && under.width === w && under.height === h && base.startsWith('o/');
  // Чи збігається стан кнопки поза текстом із фоном під нею (вибраний / натиснутий стан буває підсвічений).
  const matches = (from: ImageData) => {
    if (!under || under.width !== w || under.height !== h) return false;
    const d = from.data;
    let diff = 0;
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (mask[i] || d[i * 4 + 3] === 0) continue;
      diff += Math.abs(d[i * 4] - under.data[i * 4]) + Math.abs(d[i * 4 + 1] - under.data[i * 4 + 1]) + Math.abs(d[i * 4 + 2] - under.data[i * 4 + 2]);
      n++;
    }
    return n > 0 && diff / n / 3 < 10;
  };
  const out: Record<string, HTMLCanvasElement> = {};
  const make = (key: string, from: ImageData, style: { fill: string; edge: string }, underline = false) => {
    const img = new ImageData(new Uint8ClampedArray(from.data), w, h);
    if (under && whole) {
      // Уся плитка — з фону екрана (на фоні «Опцій» під кнопками лежать чисті плитки без написів).
      for (let i = 0; i < w * h; i++) {
        if (img.data[i * 4 + 3] === 0) continue;
        img.data[i * 4] = under.data[i * 4];
        img.data[i * 4 + 1] = under.data[i * 4 + 1];
        img.data[i * 4 + 2] = under.data[i * 4 + 2];
      }
    } else if (under && matches(from)) {
      const x0 = Math.max(0, box.x0 - PAD);
      const y0 = Math.max(0, box.y0 - PAD);
      const x1 = Math.min(w - 1, box.x1 + PAD);
      const y1 = Math.min(h - 1, box.y1 + PAD);
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const i = (y * w + x) * 4;
          if (img.data[i + 3] === 0) continue;
          img.data[i] = under.data[i];
          img.data[i + 1] = under.data[i + 1];
          img.data[i + 2] = under.data[i + 2];
        }
    } else inpaintColumns(img, shadowMask);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    ctx.putImageData(img, 0, 0);
    drawLabel(ctx, text, place, maxW, align, style, key !== 'b' && key !== 'off', underline, CAP[base.split('/')[0]]);
    out[key] = c;
  };
  keys.forEach((k, i) => make(k, src[i], STYLE[k] ?? STYLE.b, k === 'bp'));
  make('off', src[keys.indexOf('b')] ?? src[0], STYLE.off);
  return out;
}

/**
 * Підписи на фонах: [x0, y0, x1, y1, текст, заповнення?, центр?]. Рамка напису — вирівнювання праворуч (або по
 * центру колонки «центр» [x0, x1]); \n — два рядки. Старий підпис з тінню прибирається заповненням по стовпчиках
 * між рядком над ним і рядком під ним (прямокутник «заповнення» [x0, y0, x1, y1]; без нього — рамка напису з запасом
 * на тінь): малюнок тла зберігається, без вставок шматків сусіднього тла (вони давали шви на діагональному малюнку).
 */
type Label = [number, number, number, number, string, [number, number, number, number]?, [number, number]?];
const BACKGROUND_UK: Record<string, Label[]> = {
  'n/back_new.txr': [
    [166, 97, 320, 110, 'РІВЕНЬ СКЛАДНОСТІ'],
    [130, 178, 322, 190, 'КІЛЬКІСТЬ СУПЕРНИКІВ'],
    [156, 241, 298, 254, 'ЗБЕРЕЖЕНІ ІГРИ'],
  ],
  // Виміряно на тлі: літери — рядки 97…105 і 357…365, нижче тінь, далі світла лінія рамки (107, 368) — її не чіпаємо.
  'o/back_opt.txr': [
    [254, 96, 446, 106, 'НАЛАШТУВАННЯ ТА КЛАВІШІ', [253, 96, 448, 106]],
    // Заголовки колонок кнопок — по центру колонки (стовпчики x = 27, 150, 273, кнопка 99 px).
    [48, 355, 128, 366, 'КЕРУВАННЯ', [48, 356, 128, 367], [27, 125]],
    [162, 355, 250, 366, 'ЯКІСТЬ', [172, 356, 250, 367], [150, 248]],
    [286, 355, 375, 366, 'ВІДЕОРЕЖИМ', [287, 356, 374, 367], [273, 371]],
  ],
  // Літери — рядки 120…128, x 289…433.
  'c/back_con.txr': [[288, 120, 434, 128, 'СПОСОБИ З’ЄДНАННЯ']],
  'd/back_dri.txr': [
    [232, 152, 294, 166, 'ЗА КЕРМОМ'],
    [150, 215, 296, 242, 'ЗАРЕЄСТРОВАНІ\nВОДІЇ'],
  ],
};

/** Заповнює прямокутник по стовпчиках: лінійно між пікселем над ним і пікселем під ним. */
function fillColumns(ctx: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  x0 = Math.max(0, x0);
  x1 = Math.min(W - 1, x1);
  const top = Math.max(0, y0 - 1);
  const bottom = Math.min(H - 1, y1 + 1);
  const w = x1 - x0 + 1;
  const h = bottom - top + 1;
  if (w <= 0 || h < 3) return;
  const img = ctx.getImageData(x0, top, w, h);
  const d = img.data;
  for (let x = 0; x < w; x++) {
    const a = x * 4;
    const b = ((h - 1) * w + x) * 4;
    for (let y = 1; y < h - 1; y++) {
      const t = y / (h - 1);
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) d[i + ch] = d[a + ch] + (d[b + ch] - d[a + ch]) * t;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, x0, top);
}

/** Замінює російські підписи фону українськими. */
export function localizeBackground(name: string, canvas: HTMLCanvasElement): void {
  const items = BACKGROUND_UK[name];
  if (!items) return;
  const ctx = canvas.getContext('2d')!;
  // Спершу прибрати всі старі підписи, потім писати нові.
  for (const [x0, y0, x1, y1, , fill] of items) {
    const [fx0, fy0, fx1, fy1] = fill ?? [x0 - 2, y0, x1 + 3, y1 + 2];
    fillColumns(ctx, fx0, fy0, fx1, fy1);
  }
  for (const [x0, y0, x1, y1, text, , center] of items) {
    const box = center ? { x0: center[0], y0, x1: center[1], y1 } : { x0, y0, x1, y1 };
    const w = box.x1 - box.x0 + 1;
    drawLabel(ctx, text, box, w, center ? 'center' : 'right', { fill: 'rgb(240,232,204)', edge: 'rgba(0,0,0,0.85)' }, false, false, 8.5, 'normal');
  }
}
