/**
 * Українські написи на круглих кнопках головного меню (`m/<ключ>_p|a|ap.msk` у LOAD.RES, 125×125). Напис намальовано
 * в кожному стані окремо, поверх текстури (дерево, метал) — різниці між станами, як у кнопок esc16.RES, немає. Тому:
 * літери (чорне тіло й світлий відблиск над і під ним; на «Відеоплеєрі» — фіолетові з білим обведенням) вирізаються
 * з самих кнопок і складаються в нові слова тим самим шрифтом; старий напис замальовується текстурою кнопки з
 * сусідньої смуги; натиснута кнопка (`_ap`) — та сама картинка, зменшена в 0,9 раза до центру, тож новий напис
 * малюється в масштабі `_p` і зменшується так само. Літер, яких немає в російських написах, складено з наявних:
 * І — ліва ніжка И, Є — С із середньою рискою Е, Ж — дзеркальне К + К.
 */

type RoundKey = 'graph' | 'contr' | 'demo' | 'recor' | 'singl' | 'multi' | 'chang' | 'exit';

/** Написи оригіналу (по рядках) і українські; «Демо» не змінюється. */
const TEXTS: Partial<Record<RoundKey, [string[], string[]]>> = {
  graph: [['ГРАФИКА'], ['ГРАФІКА']],
  contr: [['УПРАВЛЕНИЕ'], ['КЕРУВАННЯ']],
  recor: [['ВИДЕОПЛЕЕР'], ['ВІДЕОПЛЕЄР']],
  singl: [['ИГРА'], ['ГРА']],
  multi: [['СЕТЕВАЯ', 'ИГРА'], ['МЕРЕЖЕВА', 'ГРА']],
  chang: [['СМЕНИТЬ', 'ВОДИТЕЛЯ'], ['ЗМІНИТИ', 'ВОДІЯ']],
  exit: [['ВЫХОД', 'ИЗ ИГРЫ'], ['ВИХІД', 'З ГРИ']],
};

const SIZE = 125;
/** Натиснута кнопка — зменшена копія звичайної (підібрано на картинках: 0,9 до точки 63,5). */
const PRESS = 0.9;
const PRESS_C = 63.5;
/** Напис — усередині кола цього радіуса (далі обідок кнопки); на «Відеоплеєрі» напис ширший — до обідка. */
const INNER = 49;
const inner = (key: RoundKey) => (key === 'recor' ? 55 : INNER);

interface Glyph {
  w: number;
  /** Зсув верху літери від верху рядка (Д, Щ — з нижніми виносними, у них зсув 0 і більша висота). */
  top: number;
  h: number;
  /** 1 — тіло літери, 2 — відблиск. */
  px: Uint8Array;
}

interface Line {
  y0: number;
  y1: number;
  x0: number;
  x1: number;
  /** Стовпчики літер [x0, x1] зліва направо. */
  cols: [number, number][];
}

type Img = ImageData;

const lum = (d: Uint8ClampedArray, i: number) => (d[i] + d[i + 1] + d[i + 2]) / 3;

/** Тіло літери: чорне на дереві й металі, прозоре на «Відеоплеєрі». */
function isCore(key: RoundKey, d: Uint8ClampedArray, i: number): boolean {
  // «Відеоплеєр»: літери — прозорі отвори в масці (крізь них видно те, що під кнопкою).
  if (key === 'recor') return d[i + 3] < 128;
  return Math.max(d[i], d[i + 1], d[i + 2]) < 60;
}

const isLight = (d: Uint8ClampedArray, i: number) => lum(d, i) > 185;

/** Рядки напису й стовпчики літер. */
function findLines(key: RoundKey, img: Img, scale = 1): Line[] {
  const d = img.data;
  const lines: Line[] = [];
  let cur: Line | null = null;
  const c = scale === 1 ? 62 : PRESS_C;
  for (let y = 0; y < SIZE; y++) {
    let n = 0;
    let mn = SIZE;
    let mx = -1;
    for (let x = 0; x < SIZE; x++) {
      if (Math.hypot(x - c, y - c) > inner(key) * scale) continue;
      // Поодинокі темні цятки текстури — не літери (у тіла літери щонайменше 2 пікселі поспіль).
      const i = (y * SIZE + x) * 4;
      if (!isCore(key, d, i) || !(isCore(key, d, i - 4) || isCore(key, d, i + 4))) continue;
      n++;
      mn = Math.min(mn, x);
      mx = Math.max(mx, x);
    }
    if (n >= 4) {
      if (!cur) lines.push((cur = { y0: y, y1: y, x0: mn, x1: mx, cols: [] }));
      else {
        cur.y1 = y;
        cur.x0 = Math.min(cur.x0, mn);
        cur.x1 = Math.max(cur.x1, mx);
      }
    } else cur = null;
  }
  const out = lines.filter((l) => l.y1 - l.y0 >= 10 * scale);
  for (const l of out) {
    let start = -1;
    for (let x = l.x0; x <= l.x1 + 1; x++) {
      let has = false;
      for (let y = l.y0; y <= l.y1 && x <= l.x1; y++) {
        const i = (y * SIZE + x) * 4;
        if (isCore(key, d, i) && (isCore(key, d, i - 4) || isCore(key, d, i + 4) || isCore(key, d, i - SIZE * 4) || isCore(key, d, i + SIZE * 4))) has = true;
      }
      if (has && start < 0) start = x;
      if (!has && start >= 0) {
        l.cols.push([start, x - 1]);
        start = -1;
      }
    }
    // Межі рядка — за літерами (окремі темні пікселі обідка в рядку не рахуються).
    if (l.cols.length) {
      l.x0 = l.cols[0][0];
      l.x1 = l.cols[l.cols.length - 1][1];
    }
  }
  return out;
}

/** Літери рядка за відомим текстом (Ы — дві частини, зливаються). null — не збіглося. */
function cutLetters(key: RoundKey, img: Img, line: Line, text: string): Map<string, Glyph> | null {
  const letters = [...text.replace(/ /g, '')];
  const cols = [...line.cols];
  const groups: [number, number][] = [];
  for (const ch of letters) {
    const c = cols.shift();
    if (!c) return null;
    if (ch === 'Ы') {
      const c2 = cols.shift();
      if (!c2) return null;
      groups.push([c[0], c2[1]]);
    } else groups.push(c);
  }
  if (cols.length) return null;
  // Верх рядка — верх більшості літер (без виносних).
  const d = img.data;
  const out = new Map<string, Glyph>();
  letters.forEach((ch, k) => {
    const [x0, x1] = groups[k];
    let top = SIZE;
    let bottom = -1;
    for (let y = line.y0; y <= line.y1; y++)
      for (let x = x0; x <= x1; x++)
        if (isCore(key, d, (y * SIZE + x) * 4)) {
          top = Math.min(top, y);
          bottom = Math.max(bottom, y);
        }
    // Відблиск — світлі пікселі над і під тілом (до 3 рядків) у стовпчиках літери.
    const t = top - 3;
    const h = bottom + 3 - t + 1;
    const w = x1 - x0 + 1;
    const px = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((t + y) * SIZE + x0 + x) * 4;
        if (isCore(key, d, i)) px[y * w + x] = 1;
        else if (isLight(d, i) && (y < 4 || y >= h - 4)) px[y * w + x] = 2;
      }
    if (!out.has(ch)) out.set(ch, { w, top: t - line.y0, h, px });
  });
  return out;
}

/** Товщина вертикальної ніжки (стовпчики зліва, де тіло займає майже всю висоту). */
function stem(g: Glyph): number {
  let n = 0;
  for (let x = 0; x < g.w; x++) {
    let k = 0;
    for (let y = 0; y < g.h; y++) if (g.px[y * g.w + x] === 1) k++;
    if (k < g.h - 9) break;
    n++;
  }
  return Math.max(2, n);
}

function slice(g: Glyph, x0: number, x1: number): Glyph {
  const w = x1 - x0;
  const px = new Uint8Array(w * g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < w; x++) px[y * w + x] = g.px[y * g.w + x0 + x];
  return { w, top: g.top, h: g.h, px };
}

function mirror(g: Glyph): Glyph {
  const px = new Uint8Array(g.w * g.h);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) px[y * g.w + x] = g.px[y * g.w + g.w - 1 - x];
  return { ...g, px };
}

/** Літери, яких немає в російських написах. */
function compose(lib: Map<string, Glyph>): void {
  const i = lib.get('И');
  if (i && !lib.has('І')) lib.set('І', slice(i, 0, stem(i)));
  const s = lib.get('С');
  const e = lib.get('Е');
  if (s && e && !lib.has('Є')) {
    const px = s.px.slice();
    const w0 = stem(e);
    // Рядки середньої риски Е: тіло правіше від ніжки, середина висоти.
    for (let y = Math.floor(e.h * 0.3); y < Math.ceil(e.h * 0.7); y++) {
      let k = 0;
      for (let x = w0 + 1; x < e.w; x++) if (e.px[y * e.w + x] === 1) k++;
      if (k < (e.w - w0) * 0.5) continue;
      const sy = y + e.top - s.top;
      if (sy < 0 || sy >= s.h) continue;
      for (let x = w0; x < Math.min(s.w, e.w) - 1; x++) if (e.px[y * e.w + x] === 1) px[sy * s.w + x] = 1;
    }
    lib.set('Є', { ...s, px });
  }
  const k = lib.get('К');
  if (k && !lib.has('Ж')) {
    const st = stem(k);
    const m = mirror(k);
    const w = 2 * k.w - st;
    const px = new Uint8Array(w * k.h);
    for (let y = 0; y < k.h; y++) {
      for (let x = 0; x < k.w; x++) px[y * w + x] = m.px[y * k.w + x];
      for (let x = 0; x < k.w; x++) px[y * w + k.w - st + x] = Math.max(px[y * w + k.w - st + x], k.px[y * k.w + x]);
    }
    lib.set('Ж', { w, top: k.top, h: k.h, px });
  }
}

/** Середній колір пікселів класу cls (1 — тіло, 2 — відблиск) у старому написі. */
function inkColor(key: RoundKey, img: Img, lines: Line[], cls: 1 | 2): [number, number, number] {
  const d = img.data;
  const sum = [0, 0, 0];
  let n = 0;
  for (const l of lines)
    for (let y = l.y0 - 3; y <= l.y1 + 3; y++)
      for (let x = l.x0; x <= l.x1; x++) {
        const i = (y * SIZE + x) * 4;
        const ok = cls === 1 ? isCore(key, d, i) : !isCore(key, d, i) && isLight(d, i);
        if (!ok) continue;
        sum[0] += d[i];
        sum[1] += d[i + 1];
        sum[2] += d[i + 2];
        n++;
      }
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n].map(Math.round) as [number, number, number] : cls === 1 ? [16, 12, 10] : [225, 225, 225];
}

/**
 * Замалювати старий напис. Латка (тіло літер із запасом 2 пікселі й відблиски) у кожному стовпчику — плавний перехід
 * кольору між пікселями над і під латкою плюс зерно текстури (відхилення від місцевого середнього) з чистих рядків
 * того самого стовпчика: освітлення кнопки нерівне, і просте копіювання сусідньої смуги давало видимі латки.
 */
function erase(key: RoundKey, img: Img, lines: Line[], scale: number): void {
  const d = img.data;
  const c = scale === 1 ? 62 : PRESS_C;
  const mask = new Uint8Array(SIZE * SIZE);
  const mark = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const yy = y + dy;
        const xx = x + dx;
        if (yy >= 0 && xx >= 0 && yy < SIZE && xx < SIZE) mask[yy * SIZE + xx] = 1;
      }
  };
  for (const l of lines)
    for (let y = l.y0 - 4; y <= l.y1 + 4; y++)
      for (let x = l.x0 - 2; x <= l.x1 + 2; x++) {
        const i = (y * SIZE + x) * 4;
        if (isCore(key, d, i)) mark(x, y, 2);
        else if (isLight(d, i)) mark(x, y, 1);
      }
  // На «Відеоплеєрі» напис — у білій рамці на всю ширину кнопки: замалювати всю смугу рядка.
  if (key === 'recor')
    for (const l of lines) for (let y = l.y0 - 4; y <= l.y1 + 4; y++) for (let x = 0; x < SIZE; x++) if (Math.hypot(x - c, y - c) < 57 * scale) mask[y * SIZE + x] = 1;
  const src = new Uint8ClampedArray(d);
  // Чистий піксель (не латка, непрозорий); для зерна — ще й не біля обідка.
  const open = (x: number, y: number) => y >= 0 && y < SIZE && !mask[y * SIZE + x] && src[(y * SIZE + x) * 4 + 3] > 128;
  const clean = (x: number, y: number) => open(x, y) && Math.hypot(x - c, y - c) < 46 * scale;
  for (let x = 0; x < SIZE; x++) {
    // Чисті рядки стовпчика — джерело зерна.
    const rows: number[] = [];
    for (let y = 2; y < SIZE - 2; y++) if (clean(x, y) && clean(x, y - 2) && clean(x, y + 2)) rows.push(y);
    let y = 0;
    while (y < SIZE) {
      if (!mask[y * SIZE + x]) {
        y++;
        continue;
      }
      let e = y;
      while (e + 1 < SIZE && mask[(e + 1) * SIZE + x]) e++;
      const edge = (from: number, dir: number): number[] | null => {
        const sum = [0, 0, 0];
        let n = 0;
        for (let k = 1; k <= 3; k++) {
          const yy = from + dir * k;
          if (!open(x, yy)) continue;
          for (let ch = 0; ch < 3; ch++) sum[ch] += src[(yy * SIZE + x) * 4 + ch];
          n++;
        }
        return n ? sum.map((v) => v / n) : null;
      };
      const top = edge(y, -1);
      const bottom = edge(e, 1);
      const a = top ?? bottom;
      const b = bottom ?? top;
      if (a && b)
        for (let yy = y; yy <= e; yy++) {
          const t = e === y ? 0.5 : (yy - y) / (e - y);
          const i = (yy * SIZE + x) * 4;
          // Зерно: піксель чистого рядка мінус середнє його сусідів по вертикалі.
          let grain = 0;
          if (rows.length) {
            const sy = rows[(yy * 7 + x * 3) % rows.length];
            const j = (sy * SIZE + x) * 4;
            grain = lum(src, j) - (lum(src, j - SIZE * 8) + lum(src, j + SIZE * 8)) / 2;
          }
          for (let ch = 0; ch < 3; ch++) d[i + ch] = a[ch] * (1 - t) + b[ch] * t + grain * 0.8;
          d[i + 3] = 255;
        }
      y = e + 1;
    }
  }
}

/** Новий напис у масштабі звичайної кнопки — шари тіла й відблиску (прозорий фон). */
function drawLines(key: RoundKey, lib: Map<string, Glyph>, lines: Line[], texts: string[], core: number[], light: number[]): [ImageData, ImageData] {
  const layers: [ImageData, ImageData] = [new ImageData(SIZE, SIZE), new ImageData(SIZE, SIZE)];
  const set = (x: number, y: number, c: number[]) => {
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
    const d = layers[c === core ? 0 : 1].data;
    const i = (y * SIZE + x) * 4;
    d[i] = c[0];
    d[i + 1] = c[1];
    d[i + 2] = c[2];
    d[i + 3] = 255;
  };
  texts.forEach((text, n) => {
    const l = lines[Math.min(n, lines.length - 1)];
    // Проміжок — як у старому рядку (середній), щоб розрідженість написів лишилась; не ширше за коло.
    const gaps = l.cols.slice(1).map((c, k) => c[0] - l.cols[k][1] - 1);
    let gap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : 2;
    const glyphs = [...text].map((ch) => (ch === ' ' ? null : lib.get(ch) ?? null));
    const space = Math.max(4, gap * 2);
    const width = (g: number) => glyphs.reduce((s, q) => s + (q ? q.w : space - g), 0) + g * (glyphs.length - 1);
    const r = inner(key);
    const half = Math.sqrt(r * r - Math.pow(Math.max(Math.abs(l.y0 - 62), Math.abs(l.y1 - 62)), 2));
    while (gap > 1 && width(gap) > 2 * half) gap--;
    let x = Math.round(62.5 - width(gap) / 2);
    for (const g of glyphs) {
      if (!g) {
        x += space;
        continue;
      }
      for (let y = 0; y < g.h; y++)
        for (let k = 0; k < g.w; k++) {
          const v = g.px[y * g.w + k];
          if (v) set(x + k, l.y0 + g.top + y, v === 1 ? core : light);
        }
      // Обведення літер-отворів «Відеоплеєра» — світлий піксель навколо тіла.
      if (key === 'recor')
        for (let y = -1; y <= g.h; y++)
          for (let k = -1; k <= g.w; k++) {
            const at = (yy: number, kk: number) => yy >= 0 && kk >= 0 && yy < g.h && kk < g.w && g.px[yy * g.w + kk] === 1;
            if (at(y, k)) continue;
            if (at(y - 1, k) || at(y + 1, k) || at(y, k - 1) || at(y, k + 1)) set(x + k, l.y0 + g.top + y, light);
          }
      x += g.w + gap;
    }
  });
  return layers;
}

/** Бібліотека літер — з усіх звичайних (`_p`) кнопок з чорним написом. */
let library: Map<string, Glyph> | null = null;
function buildLibrary(mask: (name: string) => HTMLCanvasElement | null): Map<string, Glyph> {
  if (library) return library;
  const lib = new Map<string, Glyph>();
  for (const [key, [ru]] of Object.entries({ ...TEXTS, demo: [['ДЕМО'], []] }) as [RoundKey, [string[], string[]]][]) {
    if (key === 'recor') continue;
    const c = mask(`m/${key}_p.msk`);
    if (!c) continue;
    const img = c.getContext('2d')!.getImageData(0, 0, SIZE, SIZE);
    const lines = findLines(key, img);
    if (lines.length !== ru.length) continue;
    lines.forEach((l, n) => {
      const got = cutLetters(key, img, l, ru[n]);
      if (got) for (const [ch, g] of got) if (!lib.has(ch)) lib.set(ch, g);
    });
  }
  compose(lib);
  return (library = lib);
}

/** Українізувати картинку круглої кнопки (`m/<ключ>_<стан>.msk`) на місці; false — не вийшло (лишається оригінал). */
export function localizeRound(name: string, canvas: HTMLCanvasElement, mask: (name: string) => HTMLCanvasElement | null): boolean {
  const m = /^m\/([a-z]+)_(p|a|ap)\.msk$/.exec(name);
  if (!m || canvas.width !== SIZE || canvas.height !== SIZE) return false;
  const key = m[1] as RoundKey;
  const state = m[2];
  const texts = TEXTS[key];
  if (!texts) return false;
  const [ru, uk] = texts;
  const lib = buildLibrary(mask);
  if ([...uk.join('')].some((ch) => ch !== ' ' && !lib.has(ch))) return false;
  // Рядки — з картинки звичайного стану (у наведеної вони там самі; у натиснутої — зменшені).
  const base = mask(`m/${key}_p.msk`);
  if (!base) return false;
  const lines = findLines(key, base.getContext('2d')!.getImageData(0, 0, SIZE, SIZE));
  if (lines.length !== ru.length) return false;
  const g = canvas.getContext('2d')!;
  const img = g.getImageData(0, 0, SIZE, SIZE);
  const pressed = state === 'ap';
  const own = pressed ? findLines(key, img, PRESS) : lines;
  if (own.length !== ru.length) return false;
  const core = inkColor(key, img, own, 1);
  const light = inkColor(key, img, own, 2);
  erase(key, img, own, pressed ? PRESS : 1);
  g.putImageData(img, 0, 0);
  // Тіло, потім відблиск; на «Відеоплеєрі» тіло — отвір (прозорість, як в оригіналі).
  drawLines(key, lib, lines, uk, core, light).forEach((layer, n) => {
    const tmp = document.createElement('canvas');
    tmp.width = tmp.height = SIZE;
    tmp.getContext('2d')!.putImageData(layer, 0, 0);
    g.save();
    if (n === 0 && key === 'recor') g.globalCompositeOperation = 'destination-out';
    if (pressed) {
      g.translate(PRESS_C, PRESS_C);
      g.scale(PRESS, PRESS);
      g.translate(-PRESS_C, -PRESS_C);
    }
    g.drawImage(tmp, 0, 0);
    g.restore();
  });
  return true;
}
