/**
 * Мобільні дрібниці: заборона масштабування сторінки жестами й повноекранний режим
 * (з префіксом webkit для старих Safari/iPad; на iPhone Fullscreen API для сторінок немає).
 */

/** Блокує зум подвійним дотиком і щипком (iOS Safari ігнорує `user-scalable=no`). */
export function blockPageZoom(): void {
  let lastTouchEnd = 0;
  document.addEventListener(
    'touchend',
    (e) => {
      const now = performance.now();
      const t = e.target as HTMLElement | null;
      // Другий швидкий дотик — це жест «подвійний дотик»; поля вводу не чіпаємо.
      if (now - lastTouchEnd < 350 && !t?.closest('select, input, textarea')) e.preventDefault();
      lastTouchEnd = now;
    },
    { passive: false },
  );
  document.addEventListener('dblclick', (e) => e.preventDefault(), { passive: false });
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
  document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });
}

type FsDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };

/** Гра вже на весь екран: Fullscreen API або запуск як встановлений застосунок. */
export function isFullscreen(): boolean {
  const d = document as FsDocument;
  return (
    !!(d.fullscreenElement ?? d.webkitFullscreenElement) ||
    matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function fullscreenSupported(): boolean {
  const el = document.documentElement as FsElement;
  return !!(el.requestFullscreen || el.webkitRequestFullscreen);
}

/** Вмикає повноекранний режим і блокує ландшафт. Викликати лише з обробника дотику/кліку. */
export async function enterFullscreen(): Promise<boolean> {
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    else return false;
  } catch {
    return false;
  }
  const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
  await orientation.lock?.('landscape').catch(() => {});
  return true;
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDocument;
  if (d.fullscreenElement) await d.exitFullscreen();
  else await d.webkitExitFullscreen?.();
}

/** Коротке повідомлення внизу екрана, яке зникає саме. */
export function toast(text: string, ms = 6000): void {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.addEventListener('click', () => (el!.hidden = true));
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(setTimeout(() => (el!.hidden = true), ms));
}

/** Пояснення, як отримати повний екран там, де Fullscreen API немає (iPhone). */
export const IOS_FULLSCREEN_HINT =
  'iPhone не дає сайтам весь екран. Встанови гру як застосунок: у Safari натисни кнопку «Поділитися» ' +
  '(квадрат зі стрілкою вгору; у новому Safari вона в меню «…») → «На початковий екран» → «Додати». ' +
  'Потім запускай гру з іконки Hard Truck на екрані «Додому».';
