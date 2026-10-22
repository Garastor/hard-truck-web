import { uiScale, type PixelFont } from '../engine/ui/pixelFont';
import type { EscArt } from './escArt';

/**
 * Бічна панель king.exe (re/notes/ht2/ui.md §3): фон `m_16\Back*.txr` заввишки 1200, притиснутий до правого (вікна
 * біля обʼєктів) чи лівого (Esc, F1–F4) краю. По вертикалі — як в оригіналі: рядок 650 фону — посередині екрана
 * (king.exe для 640×480 малює фон з y = −410). Координати кнопок і текстів — у пікселях фону, як у king.exe; текст
 * пишеться від базової лінії. Масштаб — як у табло (на телефоні 1×).
 */
export const PANEL_CENTER = 650;

/** Компактна панель (compactBottom): висота екрана, нижче якої вмикається, масштаб і відступ від низу (CSS px). */
const COMPACT_H = 500;
const COMPACT_SCALE = 0.9;
const COMPACT_MARGIN = 4;

/**
 * Жовті тексти панелей (значення, назви) — не піксельним MENU.FON (8 рядків, на телефоні дрібний і нечіткий), а
 * векторним шрифтом кнопок порту (.ht2-panel-act), трохи стиснутим по ширині, як написи фону. Розмір — однаковий на
 * екрані в усіх панелях: TEXT_PX пікселів екрана, навіть коли панель зменшено (F1–F4 на телефоні — ×0,7); на
 * великому екрані росте разом із панеллю. Табло (LCD-цифри icon.fon, matrix.fon рації) лишаються піксельними.
 */
const TEXT_PX = 12;
const TEXT_SQUEEZE = 0.88;

/**
 * Відкриті панелі праворуч (вікна станцій: закупівля, сервіс, заправка…). Поки є хоч одна, на body — клас
 * `ht2-right-open` і `--ht2-right-panel-w` (ширина панелі на екрані): праві кнопки керування відсуваються з-під неї
 * (ht2.css) і повертаються після закриття. Якщо широка панель (СТО) не лишає місця для пари кнопок поряд — вони
 * налазили б на ліві, — на body ще `ht2-right-stack`: праві кнопки стають другим рядом над лівими.
 */
const rightPanels = new Map<SidePanel, number>();

/** Проміжок між лівою й правою групами кнопок, менше якого праву групу ставимо у два ряди (px). */
const STACK_GAP = 8;

/** Тривалість зсуву правих кнопок, мс (ht2.css `--ht2-slide-s`): на час переїзду вони мигають синім. */
const SLIDE_MS = 800;
let slideTimer = 0;
let lastShift = 0;

function syncRightPanels(): void {
  const w = Math.max(0, ...rightPanels.values());
  const body = document.body;
  const shift = rightPanels.size > 0 ? w : 0;
  if (shift !== lastShift) {
    lastShift = shift;
    body.classList.add('ht2-right-moving');
    clearTimeout(slideTimer);
    slideTimer = window.setTimeout(() => body.classList.remove('ht2-right-moving'), SLIDE_MS);
  }
  body.classList.toggle('ht2-right-open', rightPanels.size > 0);
  body.style.setProperty('--ht2-right-panel-w', `${w}px`);
  // Міряємо базове положення кнопок — без розкладки у два ряди.
  body.classList.remove('ht2-right-stack');
  body.classList.toggle('ht2-right-stack', rightPanels.size > 0 && rightPairCramped(w));
}

/**
 * Чи налазить пара правих кнопок, відсунута на ширину панелі `w`, на ліву пару. Положення — offsetLeft (без зсуву
 * translate, тож не залежить від анімації); кнопки сховані (ПК, кермо нахилом) — місця вистачає. Тоді праву пару
 * ставимо над лівою (ht2.css `ht2-right-stack`).
 */
function rightPairCramped(w: number): boolean {
  const swap = document.body.classList.contains('swap-controls');
  const pick = (cls: string) => document.querySelector<HTMLElement>(`.touch-ui > .touch-btn.${cls}`);
  const leftSide = (swap ? ['brake', 'gas'] : ['left', 'right']).map(pick);
  const rightSide = (swap ? ['left', 'right'] : ['brake', 'gas']).map(pick);
  const shown = (b: HTMLElement | null): b is HTMLElement => !!b && b.offsetWidth > 0;
  const right = rightSide.filter(shown);
  if (right.length < 2) return false;
  const leftEdge = Math.min(...right.map((b) => b.offsetLeft)) - w;
  const left = leftSide.filter(shown);
  const leftEnd = left.length ? Math.max(...left.map((b) => b.offsetLeft + b.offsetWidth)) : 0;
  return leftEdge < leftEnd + STACK_GAP;
}

export type ButtonState = 'p' | 'a' | 'ap' | 'pp' | 'n' | 'ok' | 'f';

export interface PanelButton {
  el: HTMLButtonElement;
  paint(): void;
}

export class SidePanel {
  readonly el: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly text: CanvasRenderingContext2D;
  /** Що намальовано на текстовому шарі — перемальовується в роздільності екрана після зміни масштабу. */
  private ops: ((ctx: CanvasRenderingContext2D) => void)[] = [];
  private textRes = 0;
  /** Поточний масштаб панелі (пікселі екрана на піксель фону). */
  private s = 1;
  private readonly onResize = () => this.fit();
  readonly width: number;
  private readonly height: number;

  constructor(
    readonly art: EscArt,
    parent: HTMLElement,
    background: string,
    readonly side: 'left' | 'right' | 'center' = 'right',
    /**
     * Які рядки фону показати [згори, знизу]: вписуються між табло й низом екрана (зменшуються, якщо не влазять).
     * Без — як в оригіналі: рядок 650 посередині екрана.
     */
    private readonly view?: [number, number],
    /** Додатковий відступ згори під табло, CSS px (рядок кнопок порту). */
    private readonly below = 0,
    /**
     * Нижній рядок фону з вмістом (кнопки OK/скасування). Якщо задано, на низькому екрані (телефон у ландшафті,
     * < COMPACT_H) панель зменшується на 10% і зсувається донизу, щоб цей рядок був біля низу екрана: верх
     * вмісту (СТО) інакше ховається під табло (на прохання користувача).
     */
    private readonly compactBottom?: number,
  ) {
    this.el = document.createElement('div');
    this.el.className = `ht2-panel ${side}`;
    this.stage = document.createElement('div');
    this.stage.className = 'ht2-panel-stage';
    const bg = art.canvas(background);
    this.width = bg?.width ?? 225;
    const img = document.createElement('img');
    img.src = art.url(background) ?? '';
    img.alt = '';
    img.draggable = false;
    const canvas = document.createElement('canvas');
    this.height = bg?.height ?? 1200;
    canvas.width = this.width;
    canvas.height = this.height;
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${this.height}px`;
    canvas.className = 'ht2-panel-text';
    this.text = canvas.getContext('2d')!;
    this.stage.append(img, canvas);
    this.el.append(this.stage);
    parent.append(this.el);
    window.addEventListener('resize', this.onResize);
    this.fit();
  }

  get scale(): number {
    return Math.max(uiScale(), window.innerHeight / 800);
  }

  private fit(): void {
    const H = window.innerHeight;
    let s = this.scale;
    let y = H / 2 - PANEL_CENTER * s;
    if (this.view) {
      const top = (parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0) + this.below;
      const [a, b] = this.view;
      s = Math.min(s, (H - top) / (b - a));
      y = top + (H - top - (b - a) * s) / 2 - a * s;
    } else if (this.compactBottom !== undefined && H < COMPACT_H) {
      s *= COMPACT_SCALE;
      y = Math.max(H / 2 - PANEL_CENTER * s, H - COMPACT_MARGIN - this.compactBottom * s);
    }
    this.el.style.width = `${this.width * s}px`;
    if (this.side === 'right' && this.el.isConnected) {
      rightPanels.set(this, this.width * s);
      syncRightPanels();
    }
    this.stage.style.width = `${this.width}px`;
    this.stage.style.transform = `translateY(${y}px) scale(${s})`;
    const textChanged = s !== this.s && (s < 1 || this.s < 1);
    this.s = s;
    // Зменшена панель (F1–F4 на телефоні) — згладжування: «pixelated» при зменшенні рве лінії й літери фону.
    this.stage.classList.toggle('smooth', s < 1);
    // Текстовий шар — рівно в пікселях екрана (без обрізання до 1…4): інакше браузер перемасштабовує готові літери,
    // і вони рвуться. Межі — лише від надто малого чи великого полотна.
    const res = Math.min(6, Math.max(0.25, s * (window.devicePixelRatio || 1)));
    if (res !== this.textRes || textChanged) {
      this.textRes = res;
      const c = this.text.canvas;
      c.width = Math.round(this.width * res);
      c.height = Math.round(this.height * res);
      this.redraw();
    }
  }

  private redraw(): void {
    const ctx = this.text;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(this.textRes, 0, 0, this.textRes, 0, 0);
    for (const op of this.ops) op(ctx);
  }

  private paintOp(op: (ctx: CanvasRenderingContext2D) => void): void {
    this.ops.push(op);
    op(this.text);
  }

  /** Стерти тексти. */
  clear(): void {
    this.ops = [];
    this.redraw();
  }

  /**
   * Текст від базової лінії (місця — як для MENU.FON у king.exe); align — від x вліво, по центру чи вправо.
   * Типово (menu) — векторний шрифт панелей (TEXT_PX), піксельний — лише табло (icon, matrix). maxW — ширина
   * клітинки в пікселях фону: довший текст стискається по ширині.
   */
  write(x: number, y: number, s: string, color = 'rgb(240, 232, 150)', font: PixelFont | null = this.art.menu, align: 'left' | 'center' | 'right' = 'left', maxW?: number): void {
    const t = s.toUpperCase();
    if (font && font !== this.art.menu) {
      const w = font.measure(t);
      const x0 = align === 'center' ? x - Math.floor(w / 2) : align === 'right' ? x - w : x;
      this.paintOp((ctx) => font.draw(ctx, t, x0, y - font.height, color));
      return;
    }
    this.paintOp((ctx) => {
      // Розмір у пікселях фону: TEXT_PX на екрані (у зменшеній панелі — більше пікселів фону).
      const px = TEXT_PX / Math.min(1, this.s);
      ctx.save();
      ctx.font = `700 ${px.toFixed(2)}px Arial, sans-serif`;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = color;
      const k = Math.min(TEXT_SQUEEZE, maxW ? maxW / ctx.measureText(t).width : TEXT_SQUEEZE);
      const w = ctx.measureText(t).width * k;
      const x0 = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
      // Базова лінія MENU.FON — під текстом; великі літери вищі, тож центр рядка — на 4 рядки вище, як у піксельного.
      ctx.translate(x0, y - 4 + px * 0.36);
      ctx.scale(k, 1);
      ctx.fillText(t, 0, 0);
      ctx.restore();
    });
  }

  /** Смуга-показник (рівень вантажу, стан систем) у пікселях фону. */
  bar(x: number, y: number, w: number, h: number, color: string): void {
    this.paintOp((ctx) => {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, w, h);
    });
  }

  /** Кнопка `<base>_<стан>.txr` у точці фону; state — стан для малювання (типово — за дотиком). */
  button(base: string, x: number, y: number, label: string, action: () => void, state?: () => ButtonState | null): PanelButton {
    const b = document.createElement('button');
    b.className = 'ht2-panel-btn';
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
      const fixed = state?.();
      const st = fixed === 'n' || fixed === 'ok' || fixed === 'f' ? fixed : fixed === 'pp' ? (hover ? 'ap' : 'pp') : down ? 'ap' : hover ? 'a' : 'p';
      img.src = this.art.buttonUrl(base, st) ?? this.art.buttonUrl(base, 'p') ?? '';
      b.disabled = fixed === 'n' || fixed === 'f';
    };
    b.addEventListener('pointerenter', () => ((hover = true), paint()));
    b.addEventListener('pointerleave', () => ((hover = false), (down = false), paint()));
    b.addEventListener('pointerdown', () => ((down = true), paint()));
    b.addEventListener('pointerup', () => ((down = false), paint()));
    b.addEventListener('click', () => {
      action();
      paint();
    });
    paint();
    this.stage.append(b);
    return { el: b, paint };
  }

  /** Кнопка порту (дії, що в оригіналі — клавішами Num+ / Num−), у точці фону. */
  action(x: number, y: number, w: number, label: string, action: () => void): HTMLButtonElement {
    const b = document.createElement('button');
    b.className = 'ht2-panel-act';
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;
    b.style.width = `${w}px`;
    b.textContent = label;
    b.addEventListener('click', action);
    this.stage.append(b);
    return b;
  }

  /** Картинка (фото, значок) у точці фону. */
  image(name: string, x: number, y: number): HTMLImageElement | null {
    const url = this.art.url(name);
    if (!url) return null;
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.className = 'ht2-panel-img';
    img.style.left = `${x}px`;
    img.style.top = `${y}px`;
    this.stage.append(img);
    return img;
  }

  close(): void {
    window.removeEventListener('resize', this.onResize);
    this.el.remove();
    if (rightPanels.delete(this)) syncRightPanels();
  }
}
