/**
 * Діалоги в стилі табличок табло (тонка рамка, піксельний шрифт MENU.FON; без шрифту — системний): модальне вікно з
 * кнопками й піксельний текст із переносом. Спільні для ігор (стилі — `.career-modal`, `.career-box` у style.css).
 */
import { HUD_CYAN, hudScale, pixelCanvas, type PixelFont } from './pixelFont';

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Шрифт табло (MENU.FON) для вікон і підказок; до завантаження — системний (setHudFont з main). */
export let uiFont: PixelFont | null = null;
export function setHudFont(f: PixelFont | null): void {
  uiFont = f;
}

/** Рядки тексту не ширші за w пікселів шрифту. */
export function wrapText(f: PixelFont, t: string, w: number): string[] {
  const out: string[] = [];
  for (const para of t.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && f.measure(next) > w) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** Збільшення піксельного шрифту на кнопках (табло й вікон) відносно решти тексту. */
export const BUTTON_ZOOM = 1.35;

/**
 * Текст піксельним шрифтом табло (бірюзовий) з переносом за шириною в CSS-пікселях; без шрифту — звичайний
 * текст. line — крок рядків у пікселях шрифту.
 */
export function pixelText(t: string, cssWidth: number, color = HUD_CYAN, line = 12, zoom = 1): HTMLElement {
  const f = uiFont;
  if (!f) return el('p', 'career-text', t);
  const s = hudScale() * zoom;
  // У MENU.FON немає «ялинок» і кривих лапок — прямі.
  const text = t.replace(/[«»„“”]/g, '"');
  const lines = wrapText(f, text, Math.max(40, Math.floor(cssWidth / s)));
  const w = Math.max(1, ...lines.map((l) => f.measure(l)));
  const { canvas, ctx } = pixelCanvas(w, lines.length * line - (line - f.height), s);
  lines.forEach((l, i) => f.draw(ctx, l, 0, i * line, color));
  canvas.setAttribute('aria-label', t);
  canvas.classList.add('career-pixel-text');
  return canvas;
}

/** Ширина вмісту вікна, CSS-пікселі (як у .career-box: до 520, з полями). */
export function boxContentWidth(): number {
  return Math.min(520, window.innerWidth - 32) - 34;
}

/** Модальне вікно в стилі табличок табло (тонка рамка, піксельний шрифт); повертає вибрану кнопку. */
export function modal(overlay: HTMLElement, title: string, body: string | HTMLElement, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    const back = el('div', 'career-modal');
    const box = el('div', 'career-box');
    const head = el('h2');
    head.append(pixelText(title, boxContentWidth(), 'rgb(255,255,255)'));
    box.append(head);
    box.append(typeof body === 'string' ? pixelText(body, boxContentWidth()) : body);
    const row = el('div', 'career-actions');
    const close = (i: number) => {
      window.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(i);
    };
    // Клавіатура: Enter — перша (основна) кнопка, Esc — остання (скасувати / закрити).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      if (!back.isConnected) return window.removeEventListener('keydown', onKey, true);
      // Лише верхнє вікно (вкладені — останні в overlay).
      if ([...overlay.querySelectorAll('.career-modal')].pop() !== back) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close(e.key === 'Enter' ? 0 : buttons.length - 1);
    };
    window.addEventListener('keydown', onKey, true);
    buttons.forEach((b, i) => {
      const btn = el('button', i === 0 ? 'hud-btn primary' : 'hud-btn');
      btn.setAttribute('aria-label', b);
      // Напис кнопки — крупніший за текст вікна (на прохання користувача).
      if (uiFont) btn.append(pixelText(b, 400, HUD_CYAN, 12, BUTTON_ZOOM));
      else btn.textContent = b;
      btn.addEventListener('click', () => close(i));
      row.append(btn);
    });
    box.append(row);
    back.append(box);
    overlay.append(back);
  });
}
