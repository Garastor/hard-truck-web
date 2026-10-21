/**
 * Бік «бровки» (вирізу, Dynamic Island, отвору камери) у ландшафті.
 *
 * Браузер не повідомляє бік прямо, тому:
 *  1) безпечні відступи (`env(safe-area-inset-left/right)`) різні — бровка там, де більший;
 *  2) однакові й ненульові (iOS у ландшафті робить їх симетричними) — за поворотом екрана: верх телефона
 *     (а з ним бровка) ліворуч при куті 90° і праворуч при 270° (−90°).
 * Нульові відступи — бровки не видно (або браузер її не повідомляє): бік невідомий, лишаються симетричні запаси.
 *
 * Результат — атрибут `data-notch="left|right"` на <html>; CSS (style.css) тоді обнуляє безпечну зону з
 * протилежного боку (`--sal`/`--sar`) і зменшує там бічний відступ інтерфейсу (`--sl`/`--sr`). Кнопки руху
 * (кермо, педалі, «Різко») мають власні симетричні відступи `--cl`/`--cr` і на бровку не реагують.
 */
export type NotchSide = 'left' | 'right' | null;

let probe: HTMLDivElement | null = null;

function insets(): { l: number; r: number } {
  if (!probe) {
    probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;' +
      'padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0 };
}

/** Кут повороту екрана: 0, 90, 180, 270 (iOS — зі старого `window.orientation`, там −90 = 270). */
function angle(): number {
  const legacy = (window as { orientation?: number }).orientation;
  if (typeof legacy === 'number') return (legacy + 360) % 360;
  return screen.orientation?.angle ?? 0;
}

export function notchSide(): NotchSide {
  if (window.innerWidth <= window.innerHeight) return null;
  const { l, r } = insets();
  if (Math.abs(l - r) > 1) return l > r ? 'left' : 'right';
  if (l < 1) return null;
  const a = angle();
  return a === 90 ? 'left' : a === 270 ? 'right' : null;
}

function apply(): void {
  const side = notchSide();
  const root = document.documentElement;
  if (side) root.dataset.notch = side;
  else delete root.dataset.notch;
}

/** Стежити за бровкою: при повороті екрана й зміні розміру. */
export function watchNotch(): void {
  apply();
  // Після повороту iOS оновлює відступи не одразу — перевірити ще раз трохи згодом.
  const later = (): void => {
    apply();
    setTimeout(apply, 300);
  };
  window.addEventListener('resize', later);
  window.addEventListener('orientationchange', later);
  screen.orientation?.addEventListener?.('change', later);
}
