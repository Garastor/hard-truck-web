/**
 * Текст растровим шрифтом оригіналу (MENU.FON / large.fon) на canvas — табло бази й траси.
 * Шрифти російські (cp1251): українські Є, Ї, Ґ складаємо з наявних символів
 * (Є — дзеркальна Э, Ї — I з двома крапками, Ґ — Г), І/і — латинські.
 */
import type { BitmapFont, Glyph } from '../formats/fon';

const CP1251 = (() => {
  const map = new Map<string, number>();
  const dec = new TextDecoder('windows-1251');
  for (let c = 0; c < 256; c++) map.set(dec.decode(new Uint8Array([c])), c);
  return map;
})();

export class PixelFont {
  private readonly extra = new Map<string, Glyph>();

  constructor(readonly font: BitmapFont) {
    const g = (ch: string) => font.glyphs[CP1251.get(ch) ?? -1] ?? null;
    const mirror = (src: Glyph | null) => src && { width: src.width, bits: this.flip(src) };
    const dots = (src: Glyph | null, lower: boolean) => {
      if (!src) return null;
      const bits = src.bits.slice();
      const w = font.cellW;
      // Мала: прибрати крапку над i (верхні рядки до першого порожнього); велика — рядок над літерою.
      let top = 0;
      if (lower) {
        while (top < font.height && bits.slice(top * w, top * w + w).every((b) => b === 0)) top++;
        while (top < font.height && bits.slice(top * w, top * w + w).some((b) => b === 1)) bits.fill(0, top * w, top * w + w), top++;
        top = Math.max(0, top - 1);
      }
      const cx = Math.floor((src.width - 1) / 2);
      for (const x of [cx - 1, cx + 1]) if (x >= 0 && x < w) bits[top * w + x] = 1;
      return { width: Math.max(src.width, 3), bits };
    };
    const set = (ch: string, glyph: Glyph | null) => glyph && this.extra.set(ch, glyph);
    set('Є', mirror(g('Э')));
    set('є', mirror(g('э')));
    set('І', g('I'));
    set('і', g('i'));
    set('Ї', dots(g('I'), false));
    set('ї', dots(g('i'), true));
    set('Ґ', g('Г'));
    set('ґ', g('г'));
    set('ʼ', g("'"));
    set('’', g("'"));
  }

  private flip(src: Glyph): Uint8Array {
    const w = this.font.cellW;
    const out = new Uint8Array(src.bits.length);
    for (let y = 0; y < this.font.height; y++)
      for (let x = 0; x < src.width; x++) out[y * w + (src.width - 1 - x)] = src.bits[y * w + x];
    return out;
  }

  glyph(ch: string): Glyph | null {
    return this.extra.get(ch) ?? this.font.glyphs[CP1251.get(ch) ?? CP1251.get(ch.toUpperCase()) ?? 63] ?? null;
  }

  get height(): number {
    return this.font.height;
  }

  /** Ширина тексту (символ + 1 піксель проміжку). */
  measure(text: string): number {
    let w = 0;
    for (const ch of text) w += (this.glyph(ch)?.width ?? 3) + 1;
    return Math.max(0, w - 1);
  }

  /** Малює текст; (x, y) — лівий верхній кут. */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): number {
    ctx.fillStyle = color;
    const w = this.font.cellW;
    for (const ch of text) {
      const g = this.glyph(ch);
      if (g) {
        for (let gy = 0; gy < this.font.height; gy++)
          for (let gx = 0; gx < g.width; gx++) if (g.bits[gy * w + gx]) ctx.fillRect(x + gx, y + gy, 1, 1);
      }
      x += (g?.width ?? 3) + 1;
    }
    return x;
  }
}

/**
 * Масштаб піксельного табло — лише цілий (як в оригіналі 640×480 — охайні пікселі): табло займає ту ж
 * частку екрана, що й в оригіналі; на телефоні в ландшафті — 1×, на великому екрані — 2× і більше.
 */
export function hudScale(): number {
  return Math.max(1, Math.floor(window.innerHeight / 400));
}

/** Полотно в «пікселях оригіналу», показане з масштабом без згладжування. */
export function pixelCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(w);
  canvas.height = Math.ceil(h);
  const s = hudScale();
  canvas.style.width = `${canvas.width * s}px`;
  canvas.style.height = `${canvas.height * s}px`;
  canvas.className = 'pixel';
  return { canvas, ctx: canvas.getContext('2d')! };
}

/** Колір тексту табло оригіналу (виміряно зі скріншота). */
export const HUD_CYAN = 'rgb(123,255,255)';

/**
 * Рамка табличок оригіналу (виміряно зі скріншота): світла лінія 1 px по краю; усередині — «втиснута»
 * панель: зверху й зліва смуга 4 px, що затемнює фон наполовину, темна лінія 1 px, далі фон темніший
 * (≈ 80 %); справа й знизу смуги немає.
 */
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.clearRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.56)';
  ctx.fillRect(x + 1, y + 1, w - 2, h - 2);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(x + 5, y + 5, w - 6, h - 6);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillRect(x + 5, y + 5, w - 6, 1);
  ctx.fillRect(x + 5, y + 5, 1, h - 6);
  ctx.fillStyle = 'rgb(122, 124, 122)';
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
}
