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
    const w = this.font.cellW;
    for (const ch of text) {
      const g = this.glyph(ch);
      if (g) drawBitmap(ctx, `${this.ids.get(g) ?? this.id(g)}`, g.width, this.font.height, (gx, gy) => g.bits[gy * w + gx] === 1, x, y, color);
      x += (g?.width ?? 3) + 1;
    }
    return x;
  }

  private readonly ids = new Map<Glyph, string>();
  private id(g: Glyph): string {
    const v = `g${PixelFont.next++}`;
    this.ids.set(g, v);
    return v;
  }
  private static next = 0;
}

/**
 * Масштаб піксельного табло — лише цілий (як в оригіналі 640×480 — охайні пікселі): табло займає ту ж
 * частку екрана, що й в оригіналі; на телефоні в ландшафті — 1×, на великому екрані — 2× і більше.
 */
export function hudScale(): number {
  return Math.max(1, Math.floor(window.innerHeight / 400));
}

/**
 * Експеримент «hud=smooth» (параметр адреси, запамʼятовується): табло в повній роздільності екрана, текст і
 * значки — як цифри одометра кабіни (плавне збільшення + відсікання прозорості 0,5, alphaTest); інакше — пікселі.
 */
export const HUD_SMOOTH = (() => {
  try {
    const p = new URLSearchParams(location.search).get('hud');
    if (p) localStorage.setItem('ht.hud', p);
    return (p ?? localStorage.getItem('ht.hud')) === 'smooth';
  } catch {
    return false;
  }
})();

/** Полотно в «пікселях оригіналу», показане з масштабом без згладжування (або в повній роздільності — HUD_SMOOTH). */
export function pixelCanvas(
  w: number,
  h: number,
  s = hudScale(),
): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  const cw = Math.ceil(w);
  const ch = Math.ceil(h);
  const k = HUD_SMOOTH ? s * (window.devicePixelRatio || 1) : 1;
  canvas.width = Math.round(cw * k);
  canvas.height = Math.round(ch * k);
  canvas.style.width = `${cw * s}px`;
  canvas.style.height = `${ch * s}px`;
  canvas.className = 'pixel';
  const ctx = canvas.getContext('2d')!;
  ctx.scale(canvas.width / cw, canvas.height / ch);
  return { canvas, ctx };
}

const smoothCache = new Map<string, HTMLCanvasElement>();

/**
 * Однобітний малюнок (w×h, ink(x, y)) кольором color у точці (x, y) одиниць табло. На полотні HUD_SMOOTH —
 * як текстура з alphaTest 0,5: плавно збільшений до роздільності полотна і відсічений, інакше — пікселями.
 */
export function drawBitmap(
  ctx: CanvasRenderingContext2D,
  key: string,
  w: number,
  h: number,
  ink: (x: number, y: number) => boolean,
  x: number,
  y: number,
  color: string,
): void {
  const k = ctx.getTransform().a;
  if (!HUD_SMOOTH || k <= 1.01) {
    ctx.fillStyle = color;
    for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) if (ink(gx, gy)) ctx.fillRect(x + gx, y + gy, 1, 1);
    return;
  }
  const id = `${key}|${color}|${k.toFixed(3)}`;
  let img = smoothCache.get(id);
  if (!img) {
    // Поле 1 піксель: інакше плавне збільшення обрізало б краї.
    const src = document.createElement('canvas');
    src.width = w + 2;
    src.height = h + 2;
    const sctx = src.getContext('2d')!;
    sctx.fillStyle = color;
    for (let gy = 0; gy < h; gy++) for (let gx = 0; gx < w; gx++) if (ink(gx, gy)) sctx.fillRect(gx + 1, gy + 1, 1, 1);
    img = document.createElement('canvas');
    img.width = Math.round((w + 2) * k);
    img.height = Math.round((h + 2) * k);
    const ictx = img.getContext('2d')!;
    ictx.imageSmoothingEnabled = true;
    ictx.imageSmoothingQuality = 'high';
    ictx.drawImage(src, 0, 0, img.width, img.height);
    const d = ictx.getImageData(0, 0, img.width, img.height);
    for (let i = 3; i < d.data.length; i += 4) d.data[i] = d.data[i] >= 128 ? 255 : 0;
    ictx.putImageData(d, 0, 0);
    smoothCache.set(id, img);
  }
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, x - 1, y - 1, w + 2, h + 2);
  ctx.restore();
}

/** Колір тексту табло оригіналу (виміряно зі скріншота). */
export const HUD_CYAN = 'rgb(123,255,255)';

/** Світла лінія рамок табло (виміряно зі скріншотів оригіналу). */
const LIGHT = 'rgb(118, 120, 118)';

/**
 * Зовнішня рамка табло оригіналу: світла лінія 1 px лише зверху й зліва, усе поле — напівпрозоре
 * затемнення (фон ≈ 57 %); справа й знизу лінії немає.
 */
export function frame(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.clearRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.43)';
  ctx.fillRect(x + 1, y + 1, w - 1, h - 1);
  ctx.fillStyle = LIGHT;
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
}

/**
 * «Втиснута» панель усередині рамки: фон ще темніший (≈ 60 % від рамки), темна лінія зверху й зліва,
 * світла — справа й знизу.
 */
export function inset(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.fillStyle = 'rgba(0, 0, 0, 0.4)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
  ctx.fillRect(x, y, w - 1, 1);
  ctx.fillRect(x, y, 1, h - 1);
  ctx.fillStyle = LIGHT;
  ctx.fillRect(x + w - 1, y, 1, h);
  ctx.fillRect(x, y + h - 1, w, 1);
}

/**
 * Тонка табличка як кнопки табло (.hud-btn): сіра лінія 1 px з усіх боків, темна 1 px усередині, темний
 * напівпрозорий фон.
 */
export function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  ctx.clearRect(x, y, w, h);
  ctx.fillStyle = 'rgba(16, 18, 20, 0.62)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgb(140, 140, 140)';
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillRect(x + w - 1, y, 1, h);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.8)';
  ctx.fillRect(x + 1, y + 1, w - 2, 1);
  ctx.fillRect(x + 1, y + h - 2, w - 2, 1);
  ctx.fillRect(x + 1, y + 1, 1, h - 2);
  ctx.fillRect(x + w - 2, y + 1, 1, h - 2);
}

/** Табличка оригіналу: рамка + втиснута панель із полем 4 px з усіх боків. */
export function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  frame(ctx, x, y, w, h);
  inset(ctx, x + 5, y + 5, w - 9, h - 9);
}
