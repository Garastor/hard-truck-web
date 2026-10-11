/**
 * Верхнє табло заїзду в стилі кнопок табло (тонка рамка, растрові шрифти large.fon / MENU.FON,
 * бірюзовий текст): швидкість, передача (кольори індикатора на приладовій панелі кабіни — pribor.txr:
 * R червона, N біла, передачі зелені), міцність машини й цілість вантажу у відсотках; нижче — баланс і рядок гонки.
 */
import type * as THREE from 'three';
import { HUD_CYAN, PixelFont, box, hudScale, pixelCanvas } from './pixelFont';

export interface HudData {
  speedKmh: number;
  /** −1 — R, 0 — N, 1… — передача. */
  gear: number;
  /** Міцність машини 0…1; null — не показувати. */
  truck: number | null;
  /** Цілість вантажу 0…1; null — вантажу немає. */
  cargo: number | null;
  /** Рядок гонки: баланс, коло, час, місце, відлік, фініш; порожній — без нижньої панелі. */
  line: string;
  /**
   * Найширший типовий рядок цього заїзду (база — лише баланс, гонка — коло, час, кращий, місце): ширина табло
   * фіксована за ним і за всіма значками, щоб табло не «дихало» з кожною зміною значень.
   */
  template?: string;
}

/** Висота цифр швидкості відносно цифри передачі (на прохання користувача — трохи більші). */
const SPEED_SIZE = 1.35;

/** Висота цифри передачі відносно великого шрифту (на прохання користувача — трохи менша, у рамці). */
const GEAR_SIZE = 0.75;

/** Кольори передачі — як світиться індикатор GearKey на приладовій панелі (текстура pribor.txr). */
const GEAR_R = 'rgb(255,0,0)';
const GEAR_N = 'rgb(255,255,255)';
const GEAR_D = 'rgb(0,255,0)';

/**
 * Американський капотний тягач спереду, контуром (обрано користувачем з кількох варіантів): труби обабіч
 * кабіни, поперечина з вузькими дзеркалами, вузький капот із ґратами, прямі крила з фарами, прямий бампер,
 * широкі колеса по краях.
 */
const TRUCK_ICON = [
  '...X...........X...',
  '...X.XXXXXXXXX.X...',
  '...X.X.......X.X...',
  '...X.X.......X.X...',
  '..XXXXXXXXXXXXXXX..',
  '..X..X.......X..X..',
  '..X..XXXXXXXXX..X..',
  '......X.XXX.X......',
  '...XXXX.....XXXX...',
  '...X..X.XXX.X..X...',
  '...XX.X.....X.XX...',
  '...XXXXXXXXXXXXX...',
  '...XXX.......XXX...',
  '...XXX.......XXX...',
];

/** Ящики: один на двох. */
const BOXES_ICON = [
  '...XXXXX...',
  '...X.X.X...',
  '...X...X...',
  '...X...X...',
  '...XXXXX...',
  'XXXXX.XXXXX',
  'X.X.X.X.X.X',
  'X...X.X...X',
  'X...X.X...X',
  'X...X.X...X',
  'XXXXX.XXXXX',
];

/**
 * Цифри одометра кабіни (перемикач `KMeter<n>Key` старшого розряду, стани 0–9): ділянки текстури приладів
 * (pribor.txr) за UV, колір — з текстури, форма — в альфа-каналі. Без одометра в кабіні — null.
 */
export function odometerDigits(cab: THREE.Object3D): HTMLCanvasElement[] | null {
  let top = -1;
  cab.traverse((o) => {
    const m = /^KMeter(\d)Key#\d$/.exec(o.name);
    if (m) top = Math.max(top, Number(m[1]));
  });
  if (top < 0) return null;
  const digits: HTMLCanvasElement[] = [];
  for (let d = 0; d < 10; d++) {
    let mesh: THREE.Mesh | undefined;
    cab.traverse((o) => {
      if (!mesh && o.name === `KMeter${top}Key#${d}`) o.traverse((g) => (mesh ??= (g as THREE.Mesh).geometry ? (g as THREE.Mesh) : undefined));
    });
    const mat = mesh && ([] as THREE.Material[]).concat(mesh.material)[0];
    const img = (mat as THREE.MeshBasicMaterial | undefined)?.map?.image as { data?: ArrayLike<number>; width: number; height: number } | undefined;
    const uv = mesh?.geometry.attributes.uv;
    if (!img?.data || !uv) return null;
    let [u0, v0, u1, v1] = [1, 1, 0, 0];
    for (let i = 0; i < uv.count; i++) {
      u0 = Math.min(u0, uv.getX(i));
      u1 = Math.max(u1, uv.getX(i));
      v0 = Math.min(v0, uv.getY(i));
      v1 = Math.max(v1, uv.getY(i));
    }
    const x0 = Math.round(u0 * img.width);
    const y0 = Math.round(v0 * img.height);
    const w = Math.round(u1 * img.width) - x0;
    const h = Math.round(v1 * img.height) - y0;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const out = new ImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const si = ((y0 + y) * img.width + x0 + x) * 4;
        out.data.set([img.data[si], img.data[si + 1], img.data[si + 2], img.data[si + 3]], (y * w + x) * 4);
      }
    c.getContext('2d')!.putImageData(out, 0, 0);
    digits.push(c);
  }
  return digits;
}

function icon(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, color: string): number {
  ctx.fillStyle = color;
  rows.forEach((r, j) => {
    for (let i = 0; i < r.length; i++) if (r[i] === 'X') ctx.fillRect(x + i, y + j, 1, 1);
  });
  return x + rows[0].length;
}

/** Рядки з пікселями цифри «8» великого шрифту: верх і висота (висота цифр передачі й швидкості). */
function gearInk(L: PixelFont): { top: number; h: number } {
  const g = L.glyph('8');
  const w = L.font.cellW;
  const rows = g ? Array.from({ length: L.height }, (_, y) => g.bits.slice(y * w, y * w + w).some((b) => b === 1)) : [];
  const top = Math.max(0, rows.indexOf(true));
  return { top, h: rows.length ? rows.lastIndexOf(true) - top + 1 : L.height };
}

/**
 * Шар повної роздільності екрана поверх піксельного табло: (x, y, w, h) — в одиницях табло; draw малює
 * з плавним масштабуванням у пікселях шару (w, h).
 */
function hiRes(x: number, y: number, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): HTMLCanvasElement {
  const s = hudScale();
  const k = s * (window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.ceil(w * k);
  c.height = Math.ceil(h * k);
  c.style.cssText = `position:absolute;left:${x * s}px;top:${y * s}px;width:${w * s}px;height:${h * s}px`;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  draw(ctx, c.width, c.height);
  return c;
}

export class DriveHud {
  private key = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly small: PixelFont,
    private readonly large: PixelFont | null,
    /** Цифри одометра кабіни для швидкості (0–9); null — великим шрифтом. */
    private readonly digits: HTMLCanvasElement[] | null = null,
  ) {
    host.classList.add('pixel-hud');
  }

  update(d: HudData): void {
    const speed = String(Math.round(d.speedKmh));
    const gear = d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear);
    const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    const truck = d.truck !== null ? pct(d.truck) : null;
    const cargo = d.cargo !== null ? pct(d.cargo) : null;
    const key = [speed, gear, truck, cargo, d.line, d.template, window.innerHeight, window.innerWidth].join('|');
    if (key === this.key) return;
    this.key = key;

    const S = this.small;
    const L = this.large ?? S;
    const dg = this.digits;
    // Швидкість — цифрами одометра, масштабованими до висоти індикатора передачі (за рядками з пікселями).
    const ink = dg ? this.digitInk(L) : null;
    const lh = ink ? Math.max(L.height, ink.h + 2) : L.height;
    const sh = S.height;
    // Ширини — за найширшими значеннями, щоб табло не «дихало» з кожною цифрою.
    const step = dg && ink ? Math.round(dg[0].width * ink.scale) : 0;
    const speedW = dg ? step * 3 : L.measure('000');
    // Передача — трохи менша (GEAR_SIZE) у прямокутній рамці кольору передачі.
    const gi = gearInk(L);
    const gw = Math.max(L.measure('R'), L.measure('N'), L.measure('8'));
    const gScaledW = Math.round(gw * GEAR_SIZE);
    const gScaledH = Math.round(gi.h * GEAR_SIZE);
    const gearW = gScaledW + 6;
    const pctW = S.measure('100%');
    const item = (rows: string[]) => rows[0].length + 4 + pctW;
    let rowW = speedW + 8 + gearW;
    if (truck) rowW += 12 + item(TRUCK_ICON);
    if (cargo) rowW += 10 + item(BOXES_ICON);
    const lineW = S.measure(d.line);
    // Ширина — з запасом під усі значки (міцність, вантаж) і типовий найширший рядок: не змінюється на ходу.
    const reservedW = speedW + 8 + gearW + 12 + item(TRUCK_ICON) + 10 + item(BOXES_ICON);
    const innerW = Math.max(reservedW, rowW, lineW, d.template ? S.measure(d.template) : 0) + 8;
    const W = innerW + 4;
    const top1 = 2;
    const h1 = lh + 6;
    const top2 = top1 + h1 + 1;
    const h2 = d.line ? sh + 6 : 0;
    const H = d.line ? top2 + h2 + 2 : top1 + h1 + 2;

    const { canvas, ctx } = pixelCanvas(W, H);
    box(ctx, 0, 0, W, H);
    // Між рядками — тонка лінія, як рамка.
    if (d.line) {
      ctx.fillStyle = 'rgba(140, 140, 140, 0.6)';
      ctx.fillRect(4, top2 - 1, W - 8, 1);
    }

    // Рядок 1 — посередині першої панелі.
    let x = 2 + Math.floor((innerW - rowW) / 2);
    const y = top1 + 3;
    const ys = y + Math.round((lh - sh) / 2);
    const layers: HTMLCanvasElement[] = [];
    if (dg && ink) {
      // Цифри одометра — на шарі повної роздільності з плавним масштабуванням (м'які контури); на піксельному
      // полотні дрібні цифри з напівпрозорими краями розмивались. Відсікання прозорості (alphaTest 0,5, як у
      // кабіні) спотворювало контури — без нього.
      const sx = x + speedW - step * speed.length;
      const sy = Math.round(y + lh / 2 - ink.h / 2);
      const sh0 = ink.bottom - ink.top + 1;
      layers.push(
        hiRes(sx, sy, step * speed.length, ink.h, (lc, _w, h) => {
          const k = h / ink.h;
          let dx = 0;
          for (const ch of speed) {
            const c = dg[Number(ch)];
            lc.drawImage(c, 0, ink.top, c.width, sh0, dx * k, 0, c.width * ink.scale * k, h);
            dx += step;
          }
        }),
      );
    } else L.draw(ctx, speed, x + speedW - L.measure(speed), y, HUD_CYAN);
    x += speedW + 8;
    const gearColor = gear === 'R' ? GEAR_R : gear === 'N' ? GEAR_N : GEAR_D;
    const boxH = gScaledH + 6;
    const by = y + Math.round((lh - boxH) / 2);
    ctx.fillStyle = gearColor;
    ctx.globalAlpha = 0.7;
    ctx.fillRect(x, by, gearW, 1);
    ctx.fillRect(x, by + boxH - 1, gearW, 1);
    ctx.fillRect(x, by, 1, boxH);
    ctx.fillRect(x + gearW - 1, by, 1, boxH);
    ctx.globalAlpha = 1;
    const g = L.glyph(gear);
    if (g) {
      // Гліф великого шрифту в окремому полотні, зменшений плавно на шарі повної роздільності; по горизонталі —
      // за стовпчиками з пікселями (у клітинці шрифту праворуч бувають порожні стовпчики — літера зсувалась уліво).
      const cw = L.font.cellW;
      let x0 = g.width;
      let x1 = -1;
      for (let yy = 0; yy < L.height; yy++)
        for (let xx = 0; xx < g.width; xx++)
          if (g.bits[yy * cw + xx]) {
            x0 = Math.min(x0, xx);
            x1 = Math.max(x1, xx);
          }
      if (x1 < x0) [x0, x1] = [0, g.width - 1];
      const inkW = x1 - x0 + 1;
      const src = document.createElement('canvas');
      src.width = inkW;
      src.height = gi.h;
      L.draw(src.getContext('2d')!, gear, -x0, -gi.top, gearColor);
      const wS = inkW * GEAR_SIZE;
      const bx = x + (gearW - wS) / 2;
      layers.push(hiRes(bx, by + 3, wS, gScaledH, (lc, w, h) => lc.drawImage(src, 0, 0, w, h)));
    }
    x += gearW;
    const stat = (rows: string[], text: string, gap: number) => {
      x += gap;
      const iy = y + Math.round((lh - rows.length) / 2);
      x = icon(ctx, rows, x, iy, HUD_CYAN) + 4;
      S.draw(ctx, text, x + pctW - S.measure(text), ys, HUD_CYAN);
      x += pctW;
    };
    if (truck) stat(TRUCK_ICON, truck, 12);
    if (cargo) stat(BOXES_ICON, cargo, 10);

    if (d.line) S.draw(ctx, d.line, 2 + Math.floor((innerW - lineW) / 2), top2 + 3, HUD_CYAN);
    this.host.replaceChildren(canvas, ...layers);
  }

  private ink: { top: number; bottom: number; scale: number; h: number; gearTop: number; gearH: number } | null = null;

  /** Рядки з пікселями цифр одометра і цифри «8» великого шрифту — масштаб цифр швидкості (SPEED_SIZE × передача). */
  private digitInk(L: PixelFont): { top: number; bottom: number; scale: number; h: number; gearTop: number; gearH: number } {
    if (this.ink) return this.ink;
    const dg = this.digits!;
    let top = Infinity;
    let bottom = -1;
    for (const c of dg) {
      const a = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let y = 0; y < c.height; y++)
        for (let x = 0; x < c.width; x++)
          if (a[(y * c.width + x) * 4 + 3] > 0) {
            top = Math.min(top, y);
            bottom = Math.max(bottom, y);
          }
    }
    const { top: gearTop, h: gearH } = gearInk(L);
    const h = Math.round(gearH * SPEED_SIZE);
    this.ink = { top, bottom, scale: h / (bottom - top + 1), h, gearTop, gearH };
    return this.ink;
  }

  dispose(): void {
    this.host.classList.remove('pixel-hud');
    this.host.replaceChildren();
  }
}
