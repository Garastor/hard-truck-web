/**
 * Технічні вікна порту (тонка рамка табло): модальне вікно з кнопками й текст. Шрифт — звичайний, зелений, без
 * піксельного ефекту (на прохання користувача; раніше — бірюзовий піксельний MENU.FON). Стилі — `.career-modal`,
 * `.career-box` у style.css, колір HT2 — `body.game-ht2 .career-box` у ui/ht2.css.
 */
import type { PixelFont } from './pixelFont';

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

/** Текст технічного вікна: звичайний шрифт (колір — зі стилю вікна), перенос рядків браузером. */
export function techText(t: string): HTMLElement {
  return el('p', 'career-text', t);
}

/** Модальне технічне вікно (тонка рамка табло, зелений текст); повертає вибрану кнопку. */
export function modal(overlay: HTMLElement, title: string, body: string | HTMLElement, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    const back = el('div', 'career-modal');
    const box = el('div', 'career-box');
    const head = el('h2');
    head.textContent = title;
    box.append(head);
    box.append(typeof body === 'string' ? techText(body) : body);
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
      btn.textContent = b;
      btn.addEventListener('click', () => close(i));
      row.append(btn);
    });
    box.append(row);
    back.append(box);
    overlay.append(back);
  });
}
