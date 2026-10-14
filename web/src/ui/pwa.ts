/**
 * PWA: service worker (офлайн-кеш коду, public/sw.js) і оновлення. Нова збірка встановлюється у фоні й чекає:
 * гравцю — табличка «Є нова версія» з кнопкою «Оновити» (перезавантаження посеред заїзду скинуло б його).
 * Лише у збірці й у захищеному контексті (HTTPS/localhost).
 */
import { soften } from '@engine/ui/softUi';

export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator) || !isSecureContext) return;
  const sw = navigator.serviceWorker;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  void sw.register('./sw.js').then((reg) => {
    // Оновлення має сенс лише поверх уже встановленої версії (перше встановлення активується саме).
    const offer = (w: ServiceWorker | null) => {
      if (w && sw.controller) showUpdate(w);
    };
    offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed') offer(w);
      });
    });
    // Застосунок на головному екрані може не перезапускатись днями — перевіряємо оновлення при поверненні.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void reg.update().catch(() => {});
    });
  });
}

function showUpdate(waiting: ServiceWorker): void {
  if (document.querySelector('.update-banner')) return;
  const box = document.createElement('div');
  box.className = 'update-banner';
  const text = document.createElement('span');
  text.textContent = 'Є нова версія гри';
  const go = document.createElement('button');
  go.textContent = 'Оновити';
  go.addEventListener('click', () => waiting.postMessage('skipWaiting'));
  const later = document.createElement('button');
  later.textContent = 'Пізніше';
  later.addEventListener('click', () => box.remove());
  box.append(text, go, later);
  document.body.append(box);
  soften(go);
  soften(later);
}

/** iPhone / iPad (зокрема iPad, що прикидається Mac). */
export function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Запущено як застосунок з головного екрана. */
export function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}
