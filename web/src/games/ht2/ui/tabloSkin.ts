import type { EscArt } from './escArt';

/**
 * Кнопки порту в стилі табло (затверджений концепт A, ui/concept): шматки `m16\tablo.txr` як CSS-змінні
 * для border-image — синій шліфований метал (смуги кнопок), зелене LCD-скло з хромовим обідком (клітинки) і саме
 * скло без обідка (тло керма й педалей, згасає до країв). Написи — шрифтом табло matrix.fon темним «LCD»-кольором.
 * Стилі — ht2.css (body.ht2-orig-ui); без графіки оригіналу кнопки лишаються в стилі порту.
 */

/** Колір літер і значків на LCD-склі (як цифри табло). */
export const LCD_INK = 'rgb(24, 40, 22)';

// Табло: метал без гнізд x 2…95; LCD-клітинка цілком — x 486…695 (хромовий обідок 486…488 і 694…695; далі — чорна
// щілина й обідок сусідньої клітинки, які не мають потрапляти в кнопку), рядки 9…45; скло без обідка — всередині.
const METAL: Crop = [2, 0, 93, 50];
const LCD: Crop = [486, 9, 210, 36];
const LCD_FLAT: Crop = [500, 15, 178, 24];
type Crop = [number, number, number, number];

export function applyTabloSkin(art: EscArt): void {
  const tablo = art.canvas('m16\\tablo.txr');
  if (!tablo) return;
  const url = ([x, y, w, h]: Crop) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(tablo, x, y, w, h, 0, 0, w, h);
    return `url(${c.toDataURL()})`;
  };
  const st = document.documentElement.style;
  st.setProperty('--ht2-metal', url(METAL));
  st.setProperty('--ht2-lcd', url(LCD));
  st.setProperty('--ht2-lcd-flat', url(LCD_FLAT));
}

/** Напис шрифтом табло (піксельний, 1:1 у CSS-пікселях); без шрифту — null. */
export function lcdLabel(art: EscArt, text: string): HTMLCanvasElement | null {
  const f = art.matrix;
  if (!f) return null;
  const t = text.toUpperCase();
  const c = document.createElement('canvas');
  c.width = Math.max(1, f.measure(t));
  c.height = f.height;
  f.draw(c.getContext('2d')!, t, 0, 0, LCD_INK);
  c.className = 'ht2-lcd-label';
  return c;
}
