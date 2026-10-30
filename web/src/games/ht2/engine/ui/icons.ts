/**
 * Іконки кнопок у дорозі (верхні групи: ☰, «•••», фари, камера…) — власні, на прохання користувача: білі силуети
 * з прозорим фоном (аркуш, згенерований за промптом, розрізаний на 96×96 у `icons/`). PNG — маска, колір — колір
 * тексту кнопки (`currentColor`): темний на склі табло, жовтий в інтерфейсі порту; стани on/off — як і були.
 */
const FILES = import.meta.glob('./icons/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;

export type IconName =
  | 'menu' | 'swap' | 'settings' | 'exit' | 'music'
  | 'info' | 'rating' | 'company' | 'radio' | 'more'
  | 'reset' | 'camera' | 'attach' | 'map' | 'lights'
  | 'mirror' | 'wipers' | 'engine' | 'horn' | 'orbit';

/** Розмітка значка (px — сторона квадрата; flip — дзеркально по горизонталі, напр. обертання камери ліворуч). */
export function icon(name: IconName, px = 22, flip = false): string {
  const url = FILES[`./icons/${name}.png`];
  const turn = flip ? ';transform:scaleX(-1)' : '';
  return `<span class="ht2-icon" aria-hidden="true" style="--ht2-icon:url('${url}');width:${px}px;height:${px}px${turn}"></span>`;
}
