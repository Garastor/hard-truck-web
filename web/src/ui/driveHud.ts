/**
 * Верхнє табло заїзду в стилі табличок оригіналу (рамка + втиснуті панелі, растрові шрифти large.fon / MENU.FON,
 * бірюзовий текст): швидкість, передача (кольори індикатора на приладовій панелі кабіни — pribor.txr:
 * R червона, N біла, передачі зелені), міцність машини й цілість вантажу у відсотках; нижче — баланс і рядок гонки.
 */
import { HUD_CYAN, PixelFont, inset, frame, pixelCanvas } from './pixelFont';

export interface HudData {
  speedKmh: number;
  /** −1 — R, 0 — N, 1… — передача. */
  gear: number;
  /** Міцність машини 0…1; null — не показувати. */
  truck: number | null;
  /** Цілість вантажу 0…1; null — вантажу немає. */
  cargo: number | null;
  /** Рядок гонки: баланс, коло, час, місце, відлік, фініш. */
  line: string;
}

/** Кольори передачі — як світиться індикатор GearKey на приладовій панелі (текстура pribor.txr). */
const GEAR_R = 'rgb(255,0,0)';
const GEAR_N = 'rgb(255,255,255)';
const GEAR_D = 'rgb(0,255,0)';

/** Вантажівка спереду: класичний американський тягач із високими вихлопними трубами обабіч кабіни. */
const TRUCK_ICON = [
  'X...............X',
  'X...............X',
  'X...............X',
  'X..XXXXXXXXXXX..X',
  'X..X....X....X..X',
  'X..X....X....X..X',
  'X..XXXXXXXXXXX..X',
  'X.....XXXXX.....X',
  'X.....X.X.X.....X',
  'XXXX..X.X.X..XXXX',
  'XXXX..XXXXX..XXXX',
  'XXXXXXXXXXXXXXXXX',
  '.XX...........XX.',
  '.XX...........XX.',
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

function icon(ctx: CanvasRenderingContext2D, rows: string[], x: number, y: number, color: string): number {
  ctx.fillStyle = color;
  rows.forEach((r, j) => {
    for (let i = 0; i < r.length; i++) if (r[i] === 'X') ctx.fillRect(x + i, y + j, 1, 1);
  });
  return x + rows[0].length;
}

export class DriveHud {
  private key = '';

  constructor(
    private readonly host: HTMLElement,
    private readonly small: PixelFont,
    private readonly large: PixelFont | null,
  ) {
    host.classList.add('pixel-hud');
  }

  update(d: HudData): void {
    const speed = String(Math.round(d.speedKmh));
    const gear = d.gear < 0 ? 'R' : d.gear === 0 ? 'N' : String(d.gear);
    const pct = (f: number) => `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
    const truck = d.truck !== null ? pct(d.truck) : null;
    const cargo = d.cargo !== null ? pct(d.cargo) : null;
    const key = [speed, gear, truck, cargo, d.line, window.innerHeight].join('|');
    if (key === this.key) return;
    this.key = key;

    const S = this.small;
    const L = this.large ?? S;
    const lh = L.height;
    const sh = S.height;
    // Ширини — за найширшими значеннями, щоб табло не «дихало» з кожною цифрою.
    const speedW = L.measure('000');
    const gearW = Math.max(L.measure('R'), L.measure('N'), L.measure('8'));
    const pctW = S.measure('100%');
    const item = (rows: string[]) => rows[0].length + 4 + pctW;
    let rowW = speedW + 8 + gearW;
    if (truck) rowW += 12 + item(TRUCK_ICON);
    if (cargo) rowW += 10 + item(BOXES_ICON);
    const lineW = S.measure(d.line);
    const innerW = Math.max(rowW, lineW) + 12;
    const W = innerW + 9;
    const top1 = 5;
    const h1 = lh + 8;
    const top2 = top1 + h1 + 3;
    const h2 = sh + 7;
    const H = top2 + h2 + 4;

    const { canvas, ctx } = pixelCanvas(W, H);
    frame(ctx, 0, 0, W, H);
    inset(ctx, 5, top1, innerW, h1);
    inset(ctx, 5, top2, innerW, h2);

    // Рядок 1 — посередині першої панелі.
    let x = 5 + Math.floor((innerW - rowW) / 2);
    const y = top1 + 4;
    const ys = y + Math.round((lh - sh) / 2);
    L.draw(ctx, speed, x + speedW - L.measure(speed), y, HUD_CYAN);
    x += speedW + 8;
    L.draw(ctx, gear, x + Math.floor((gearW - L.measure(gear)) / 2), y, gear === 'R' ? GEAR_R : gear === 'N' ? GEAR_N : GEAR_D);
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

    S.draw(ctx, d.line, 5 + Math.floor((innerW - lineW) / 2), top2 + 4, HUD_CYAN);
    this.host.replaceChildren(canvas);
  }

  dispose(): void {
    this.host.classList.remove('pixel-hud');
    this.host.replaceChildren();
  }
}
