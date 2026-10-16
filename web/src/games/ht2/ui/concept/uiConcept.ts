import type { EscArt } from '../escArt';

/**
 * Дизайн-концепт кнопок порту (лише для обговорення, у грі не вмикається): поверх справжньої їзди малює кнопки
 * трьох варіантів із графіки оригіналу `esc16.RES` і ховає теперішні кнопки порту. Відкрити: `&uiconcept`
 * (необовʼязково `=A|B|C`) в адресі їзди другої гри.
 *
 * - A «Табло»: верхній ряд — продовження табло `m16\tablo.txr` (синій шліфований метал, зелене LCD-скло, темні
 *   літери matrix.fon, як «КМ/ГОД»); педалі й кермо — металеві плити з LCD-віконцем і темною стрілкою.
 * - B «Відеоплеєр»: усе — зелене скло кнопок відеоплеєра `m16\vtr*` (стани _p/_a/_ap): кермо — vtrbck/vtrfrw,
 *   газ і гальмо — та сама стрілка, повернута; пауза (меню) — vtrstp, двигун — vtroff, відновитися — vtrres.
 * - C «Гібрид»: верхній ряд — як A (частина табло), керування в дорозі — як B (велике скло під пальці).
 */
type Variant = 'A' | 'B' | 'C';

const LCD_INK = 'rgb(24, 40, 22)';
const GLASS_INK = 'rgb(160, 255, 170)';

export function showUiConcept(art: EscArt, initial: Variant = 'C'): () => void {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  document.body.classList.add('ht2-concept');
  const root = document.createElement('div');
  root.className = 'ht2c-root';
  document.body.append(root);
  const ui = document.createElement('div');
  root.append(ui);

  const switcher = document.createElement('div');
  switcher.className = 'ht2c-switch';
  const labels: Record<Variant, string> = { A: 'A · Табло', B: 'B · Відеоплеєр', C: 'C · Гібрид' };
  const tabs = new Map<Variant, HTMLButtonElement>();
  for (const v of ['A', 'B', 'C'] as Variant[]) {
    const b = document.createElement('button');
    b.textContent = labels[v];
    b.addEventListener('click', () => render(v));
    switcher.append(b);
    tabs.set(v, b);
  }
  root.append(switcher);

  const parts = new Parts(art);
  const render = (v: Variant) => {
    ui.replaceChildren();
    for (const [k, b] of tabs) b.classList.toggle('on', k === v);
    const top = v === 'B' ? glassRow : tabloRow;
    top(parts, ui, 'left', ['Меню', '♪', 'Карта', 'Інфо', 'Рейтинг', 'Компанія', 'Рація'], 'Інфо');
    if (v === 'A') {
      tabloRow(parts, ui, 'right', ['•••', 'СИГНАЛ', 'ВІДНОВ.', 'КАМЕРА'], null);
      tabloPedals(parts, ui);
    } else {
      glassTools(parts, ui);
      glassPedals(parts, ui);
    }
    tabloMapFrame(parts, ui, v !== 'B');
  };
  render(initial);

  return () => {
    root.remove();
    style.remove();
    document.body.classList.remove('ht2-concept');
  };
}

/** Вирізки з графіки оригіналу (data URL, кешуються). */
class Parts {
  private readonly cache = new Map<string, string>();
  constructor(readonly art: EscArt) {}

  /** Шматок картинки як data URL. */
  crop(name: string, x: number, y: number, w: number, h: number): string {
    const key = `${name}@${x},${y},${w},${h}`;
    let url = this.cache.get(key);
    if (!url) {
      const src = this.art.canvas(name);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      if (src) c.getContext('2d')!.drawImage(src, x, y, w, h, 0, 0, w, h);
      url = c.toDataURL();
      this.cache.set(key, url);
    }
    return url;
  }

  /**
   * Кнопка відеоплеєра без бежевої підкладки панелі: від кутів заливкою прибираються «не зелені» пікселі (фон
   * панелі), скло з темним обідком лишається.
   */
  glass(base: string, state: 'p' | 'a' | 'ap'): string {
    const key = `glass:${base}_${state}`;
    let url = this.cache.get(key);
    if (!url) {
      const src = this.art.canvas(`m16\\${base}_${state}.txr`);
      const c = document.createElement('canvas');
      if (src) {
        c.width = src.width;
        c.height = src.height;
        const g = c.getContext('2d')!;
        g.drawImage(src, 0, 0);
        const img = g.getImageData(0, 0, c.width, c.height);
        const d = img.data;
        const w = c.width;
        const h = c.height;
        const bg = (i: number) => {
          const r = d[i];
          const gg = d[i + 1];
          const b = d[i + 2];
          return !(gg > r + 18 && gg > b + 10) && r + gg + b > 200;
        };
        const seen = new Uint8Array(w * h);
        const stack: number[] = [0, w - 1, (h - 1) * w, h * w - 1];
        while (stack.length) {
          const p = stack.pop()!;
          if (seen[p]) continue;
          seen[p] = 1;
          if (!bg(p * 4)) continue;
          d[p * 4 + 3] = 0;
          const x = p % w;
          const y = (p / w) | 0;
          if (x > 0) stack.push(p - 1);
          if (x < w - 1) stack.push(p + 1);
          if (y > 0) stack.push(p - w);
          if (y < h - 1) stack.push(p + w);
        }
        g.putImageData(img, 0, 0);
      }
      url = c.toDataURL();
      this.cache.set(key, url);
    }
    return url;
  }

  /** Напис шрифтом табло matrix.fon (піксельний, ціле збільшення). */
  lcdText(text: string, color: string, k = 1): HTMLCanvasElement {
    const f = this.art.matrix;
    const t = text.toUpperCase();
    const c = document.createElement('canvas');
    if (!f) return c;
    c.width = Math.max(1, f.measure(t));
    c.height = f.height;
    f.draw(c.getContext('2d')!, t, 0, 0, color);
    c.style.width = `${c.width * k}px`;
    c.style.height = `${c.height * k}px`;
    c.className = 'ht2c-px';
    return c;
  }
}

// Табло: метал без гнізд x 2…95, зелене LCD-скло з хромовим обідком x 503…707, рядки 9…45.
const METAL = ['m16\\tablo.txr', 2, 0, 93, 50] as const;
const LCD = ['m16\\tablo.txr', 503, 9, 204, 36] as const;

function nine(el: HTMLElement, url: string, slice: number, width: number, fill = true): void {
  el.style.borderStyle = 'solid';
  el.style.borderWidth = `${width}px`;
  el.style.borderImage = `url(${url}) ${slice}${fill ? " fill" : ""} / ${width}px stretch`;
}

const ICONS: Record<string, string> = {
  left: '<path d="M16 4 L6 12 L16 20 Z"/>',
  right: '<path d="M8 4 L18 12 L8 20 Z"/>',
  up: '<path d="M4 16 L12 6 L20 16 Z"/>',
  down: '<path d="M4 8 L12 18 L20 8 Z"/>',
  horn: '<path d="M3 9h4l6-4v14l-6-4H3z M16 8c1.5 1.2 1.5 6.8 0 8 M19 6c2.5 2 2.5 10 0 12" stroke="currentColor" stroke-width="1.6" fill="currentColor"/>',
  cam: '<path d="M3 7h12v10H3z M15 10l6-3v10l-6-3z"/>',
  more: '<circle cx="5" cy="12" r="2.2"/><circle cx="12" cy="12" r="2.2"/><circle cx="19" cy="12" r="2.2"/>',
};
function icon(name: string, color: string, size: number): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="${color}" style="color:${color}">${ICONS[name]}</svg>`;
}

/** Ряд кнопок-клітинок LCD на металевій смузі, як продовження табло. */
function tabloRow(p: Parts, ui: HTMLElement, side: 'left' | 'right', items: string[], active: string | null): void {
  const strip = document.createElement('div');
  strip.className = `ht2c-strip ${side}`;
  nine(strip, p.crop(...METAL), 8, 6);
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ht2c-lcd';
    nine(b, p.crop(...LCD), 7, 5);
    if (it === active) b.classList.add('on');
    if (it === '♪') b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="' + LCD_INK + '"><path d="M9 4v11.5a3 3 0 1 0 2 2.8V8h7V4z"/></svg>';
    else if (it === '•••') b.innerHTML = icon('more', LCD_INK, 16);
    else {
      if (it === 'Меню') b.insertAdjacentHTML('beforeend', icon('left', LCD_INK, 12));
      b.append(p.lcdText(it, LCD_INK));
    }
    strip.append(b);
  }
  ui.append(strip);
}

/** Ряд «скляних» кнопок з текстом (CSS під кольори скла відеоплеєра). */
function glassRow(p: Parts, ui: HTMLElement, side: 'left' | 'right', items: string[], active: string | null): void {
  const row = document.createElement('div');
  row.className = `ht2c-glassrow ${side}`;
  for (const it of items) {
    const b = document.createElement('button');
    b.className = 'ht2c-glasspill';
    if (it === active) b.classList.add('on');
    if (it === '♪') b.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="' + GLASS_INK + '"><path d="M9 4v11.5a3 3 0 1 0 2 2.8V8h7V4z"/></svg>';
    else {
      if (it === 'Меню') b.insertAdjacentHTML('beforeend', icon('left', GLASS_INK, 12));
      b.append(p.lcdText(it, GLASS_INK));
    }
    row.append(b);
  }
  ui.append(row);
}

/** Педалі й кермо — металеві плити з LCD-віконцем і темною стрілкою (варіант A). */
function tabloPedals(p: Parts, ui: HTMLElement): void {
  const place: [string, string][] = [
    ['left', 'left: 52px'],
    ['right', 'left: 146px'],
    ['down', 'right: 146px'],
    ['up', 'right: 52px'],
  ];
  for (const [ic, pos] of place) {
    const plate = document.createElement('button');
    plate.className = 'ht2c-plate';
    plate.setAttribute('style', pos);
    nine(plate, p.crop(...METAL), 8, 7);
    const win = document.createElement('div');
    win.className = 'ht2c-plate-win';
    nine(win, p.crop(...LCD), 7, 6);
    win.innerHTML = icon(ic, LCD_INK, 30);
    plate.append(win);
    if (ic === 'up') plate.classList.add('on');
    ui.append(plate);
  }
}

/** Педалі й кермо — скло відеоплеєра, збільшене вдвічі (варіанти B, C). */
function glassPedals(p: Parts, ui: HTMLElement): void {
  const place: [string, string, number, string][] = [
    ['vtrbck', 'left: 40px', 0, 'p'],
    ['vtrfrw', 'left: 136px', 0, 'p'],
    ['vtrfrw', 'right: 136px', 90, 'p'],
    ['vtrfrw', 'right: 40px', -90, 'ap'],
  ];
  for (const [base, pos, rot, st] of place) {
    const b = document.createElement('img');
    b.className = 'ht2c-glass';
    b.src = p.glass(base, st as 'p');
    b.setAttribute('style', `${pos}; transform: rotate(${rot}deg)`);
    ui.append(b);
  }
}

/** Праві кнопки (ще, сигнал, відновитися, камера) і пауза — скло (варіанти B, C). */
function glassTools(p: Parts, ui: HTMLElement): void {
  const row = document.createElement('div');
  row.className = 'ht2c-tools';
  const img = (base: string) => {
    const i = document.createElement('img');
    i.src = p.glass(base, 'p');
    i.className = 'ht2c-tool-img';
    return i;
  };
  const round = (ic: string) => {
    const b = document.createElement('div');
    b.className = 'ht2c-glassround';
    b.innerHTML = icon(ic, GLASS_INK, 18);
    return b;
  };
  row.append(round('more'), round('horn'), img('vtrres'), img('vtroff'), round('cam'));
  ui.append(row);
}

/** Рамка мінікарти з металу табло (замість синьої лінії порту). */
function tabloMapFrame(p: Parts, ui: HTMLElement, on: boolean): void {
  if (!on) return;
  const f = document.createElement('div');
  f.className = 'ht2c-mapframe';
  nine(f, p.crop(...METAL), 8, 5, false);
  ui.append(f);
}

const CSS = `
body.ht2-concept .ht2-hud, body.ht2-concept .ht2-drive-bar, body.ht2-concept .touch-ui { visibility: hidden !important; }
.ht2c-root { position: fixed; inset: 0; z-index: 40; pointer-events: none; }
.ht2c-root button, .ht2c-root img { pointer-events: auto; }
.ht2c-px { image-rendering: pixelated; display: block; }
.ht2c-switch { position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); display: flex; gap: 4px; pointer-events: auto; }
.ht2c-switch button { font: 600 11px Arial, sans-serif; padding: 4px 8px; background: rgba(0,0,0,.65); color: #ddd; border: 1px solid #777; border-radius: 4px; min-height: 0; }
.ht2c-switch button.on { color: #000; background: rgb(240,232,150); }
.ht2c-strip { position: absolute; top: calc(var(--ht2-tablo-h, 46px) + 2px); display: flex; gap: 2px; box-sizing: border-box; }
.ht2c-strip.left { left: 4px; }
.ht2c-strip.right { right: 4px; }
.ht2c-lcd { box-sizing: border-box; height: 30px; min-height: 0; padding: 0 3px; margin: 0; display: flex; align-items: center; justify-content: center; background: none; cursor: pointer; }
.ht2c-lcd.on { filter: brightness(1.35) saturate(1.2); }
.ht2c-glassrow { position: absolute; top: calc(var(--ht2-tablo-h, 46px) + 6px); display: flex; gap: 4px; }
.ht2c-glassrow.left { left: 6px; }
.ht2c-glasspill { height: 26px; min-height: 0; padding: 0 9px; display: flex; align-items: center; border-radius: 13px;
  border: 2px solid rgb(20, 40, 22); box-shadow: inset 0 0 0 1px rgb(110, 210, 120), inset 0 6px 8px rgba(160,255,170,.25);
  background: linear-gradient(180deg, rgb(30, 90, 40), rgb(8, 34, 14) 60%, rgb(20, 70, 30)); cursor: pointer; }
.ht2c-glasspill.on { background: linear-gradient(180deg, rgb(70, 190, 80), rgb(20, 110, 35) 60%, rgb(60, 170, 70)); }
.ht2c-plate { position: absolute; bottom: 30px; width: 84px; height: 84px; box-sizing: border-box; padding: 0; min-height: 0; background: none; }
.ht2c-plate-win { box-sizing: border-box; width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; }
.ht2c-plate.on .ht2c-plate-win { filter: brightness(1.35) saturate(1.2); }
.ht2c-glass { position: absolute; bottom: 34px; width: 86px; height: 68px; image-rendering: pixelated; }
.ht2c-tools { position: absolute; top: calc(var(--ht2-tablo-h, 46px) + 6px); right: 8px; display: flex; gap: 6px; align-items: center; }
.ht2c-tool-img { height: 34px; image-rendering: pixelated; }
.ht2c-glassround { width: 34px; height: 34px; border-radius: 50%; box-sizing: border-box; display: flex; align-items: center; justify-content: center;
  border: 2px solid rgb(20, 40, 22); box-shadow: inset 0 0 0 1px rgb(110, 210, 120), inset 0 6px 8px rgba(160,255,170,.25);
  background: radial-gradient(circle at 50% 35%, rgb(40, 110, 50), rgb(8, 34, 14) 70%); pointer-events: auto; }
.ht2c-mapframe { position: absolute; left: 38px; top: calc(var(--ht2-tablo-h, 46px) + 44px); width: 210px; height: 194px; box-sizing: border-box; pointer-events: none; background-clip: padding-box; }
`;
