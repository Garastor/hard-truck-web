import { hudScale, uiScale, type PixelFont } from './pixelFont';

/**
 * «М'які» кнопки, як панелі (на прохання користувача): значки й написи малюються на полотні в «пікселях оригіналу»
 * (масштаб панелей hudScale) і плавно збільшуються — з тими самими розмитими контурами, що в табло. Написи —
 * піксельним шрифтом оригіналу MENU.FON (як «НА БАЗУ», «Рейтинг»). Полотно — маска (mask-image), колір —
 * currentColor кнопки: натискання й увімкнений стан (інверсія кольорів) працюють як і раніше.
 */

/**
 * Збільшення написів кнопок до масштабу кнопок (--ui): 9 px шрифту × 1,35 ≈ 12 px — як попередній напис Tahoma
 * 12 px. Масштаб панелей (hudScale) для написів не годиться — у портреті він більший за кнопки.
 */
const TEXT_ZOOM = 1.35;

let font: PixelFont | null = null;
/** Початковий вміст кнопок (SVG, текст) — перемальовується при зміні масштабу чи появі шрифту. */
const originals = new Map<HTMLElement, Node[]>();
const cache = new Map<string, string>();
let scaleNow = 0;
let uiNow = 0;

/** Шрифт написів (MENU.FON); до його появи написи лишаються звичайним текстом. */
export function setSoftFont(f: PixelFont | null): void {
  font = f;
  redrawAll();
}

/** Зробити вміст кнопки «м'яким» (повторний виклик — після зміни вмісту кнопки). */
export function soften(el: HTMLElement): void {
  // Напис стає картинкою — для екранних читачів лишаємо його в aria-label.
  const text = el.textContent?.trim();
  if (text && !el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
  originals.set(el, [...el.childNodes].map((n) => n.cloneNode(true)));
  draw(el);
}

function redrawAll(): void {
  for (const el of [...originals.keys()]) {
    if (el.isConnected) draw(el);
    else if (!document.contains(el)) originals.delete(el);
  }
}

window.addEventListener('resize', () => {
  if (hudScale() !== scaleNow || uiScale() !== uiNow) redrawAll();
});

function draw(el: HTMLElement): void {
  scaleNow = hudScale();
  uiNow = uiScale();
  const nodes = originals.get(el)!;
  el.replaceChildren(...nodes.map((n) => soft(n)));
}

function soft(n: Node): Node {
  if (n instanceof SVGSVGElement) {
    const w = Number(n.getAttribute('width')) || 24;
    const h = Number(n.getAttribute('height')) || 24;
    const span = maskSpan(w, h, n.getAttribute('class'));
    const svg = n.cloneNode(true) as SVGSVGElement;
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    // Маска — лише альфа: малюємо білим замість currentColor.
    const src = svg.outerHTML.replace(/currentColor/g, '#fff');
    const key = `${src}|${w}x${h}|${scaleNow}`;
    const hit = cache.get(key);
    if (hit) setMask(span, hit);
    else {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        // Роздільність — «пікселі оригіналу»: CSS-розмір / масштаб панелей.
        c.width = Math.max(1, Math.round(w / scaleNow));
        c.height = Math.max(1, Math.round(h / scaleNow));
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        const url = c.toDataURL();
        cache.set(key, url);
        setMask(span, url);
      };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src)}`;
    }
    return span;
  }
  if (n.nodeType === Node.TEXT_NODE && font && n.textContent?.trim()) {
    const text = n.textContent.trim();
    const s = uiNow * TEXT_ZOOM;
    const c = document.createElement('canvas');
    c.width = Math.max(1, font.measure(text));
    c.height = font.height;
    font.draw(c.getContext('2d')!, text, 0, 0, '#fff');
    const span = maskSpan(c.width * s, c.height * s, null);
    span.setAttribute('aria-hidden', 'true');
    setMask(span, c.toDataURL());
    return span;
  }
  // Обгортки (span із SVG усередині) — обходимо вкладене; полотна й картинки (уже піксельні) — як є.
  if (n instanceof HTMLElement && !(n instanceof HTMLCanvasElement) && !(n instanceof HTMLImageElement)) {
    const copy = n.cloneNode(false) as HTMLElement;
    copy.append(...[...n.childNodes].map((c) => soft(c)));
    return copy;
  }
  return n.cloneNode(true);
}

function maskSpan(w: number, h: number, cls: string | null): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = `soft${cls ? ' ' + cls : ''}`;
  span.style.width = `${w}px`;
  span.style.height = `${h}px`;
  return span;
}

function setMask(span: HTMLElement, url: string): void {
  span.style.maskImage = `url("${url}")`;
  span.style.setProperty('-webkit-mask-image', `url("${url}")`);
}
