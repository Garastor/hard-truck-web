import { uiScale, type PixelFont } from '../engine/ui/pixelFont';
import type { EscArt } from './escArt';

/**
 * Бічна панель king.exe (re/notes/ht2/ui.md §3): фон `m_16\Back*.txr` заввишки 1200, притиснутий до правого (вікна
 * біля обʼєктів) чи лівого (Esc, F1–F4) краю. По вертикалі — як в оригіналі: рядок 650 фону — посередині екрана
 * (king.exe для 640×480 малює фон з y = −410). Координати кнопок і текстів — у пікселях фону, як у king.exe; текст
 * пишеться від базової лінії. Масштаб — як у табло (на телефоні 1×).
 */
export const PANEL_CENTER = 650;

export type ButtonState = 'p' | 'a' | 'ap' | 'pp' | 'n' | 'ok' | 'f';

export interface PanelButton {
  el: HTMLButtonElement;
  paint(): void;
}

export class SidePanel {
  readonly el: HTMLDivElement;
  private readonly stage: HTMLDivElement;
  private readonly text: CanvasRenderingContext2D;
  private readonly onResize = () => this.fit();
  readonly width: number;
  private readonly background: string;

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
  ) {
    this.el = document.createElement('div');
    this.el.className = `ht2-panel ${side}`;
    this.stage = document.createElement('div');
    this.stage.className = 'ht2-panel-stage';
    this.background = background;
    const bg = art.canvas(background);
    this.width = bg?.width ?? 225;
    const img = document.createElement('img');
    img.src = art.url(background) ?? '';
    img.alt = '';
    img.draggable = false;
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = bg?.height ?? 1200;
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
    }
    this.el.style.width = `${this.width * s}px`;
    this.stage.style.width = `${this.width}px`;
    this.stage.style.transform = `translateY(${y}px) scale(${s})`;
  }

  /** Стерти тексти. */
  clear(): void {
    this.text.clearRect(0, 0, this.text.canvas.width, this.text.canvas.height);
  }

  /** Текст шрифтом (типово menu.fon) від базової лінії; align — від x вліво, по центру чи вправо. */
  write(x: number, y: number, s: string, color = 'rgb(240, 232, 150)', font: PixelFont | null = this.art.menu, align: 'left' | 'center' | 'right' = 'left'): void {
    if (!font) return;
    const t = s.toUpperCase();
    const w = font.measure(t);
    const x0 = align === 'center' ? x - Math.floor(w / 2) : align === 'right' ? x - w : x;
    font.draw(this.text, t, x0, y - font.height, color);
  }

  /** Смуга-показник (рівень вантажу, стан систем) у пікселях фону. */
  bar(x: number, y: number, w: number, h: number, color: string): void {
    this.text.fillStyle = color;
    this.text.fillRect(x, y, w, h);
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
      const under = { background: this.background, x, y };
      img.src = this.art.buttonUrl(base, st, under) ?? this.art.buttonUrl(base, 'p', under) ?? '';
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
  }
}
