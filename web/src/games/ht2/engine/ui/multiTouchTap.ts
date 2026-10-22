/**
 * Натискання кнопок другим пальцем. Поки один палець тримає кермо чи газ, iOS Safari не породжує `click` для дотику
 * іншим пальцем (жест «тап» скасовується мультитачем) — кнопки з обробником `click` (☰, меню, Інфо, вікна) не
 * відповідали. Тут: дотик, що почався й закінчився на тій самій кнопці, коли на екрані був ще інший палець, натискає
 * кнопку сам (`button.click()`); якщо браузер усе ж надішле свій `click` (Android), його гасимо, щоб не було двох.
 * Сенсорні кнопки керування (`.touch-btn`) працюють на pointerdown — їх не чіпаємо.
 */
export function installMultiTouchTap(root: Document = document): () => void {
  /** Активні дотики: pointerId → кнопка, на якій дотик почався (або null), і чи був тоді на екрані інший палець. */
  const active = new Map<number, { b: HTMLElement | null; multi: boolean }>();
  /** Кнопка, яку щойно натиснули самі, і до коли гасити рідний click на ній. */
  let fired: HTMLElement | null = null;
  let firedUntil = 0;
  const buttonAt = (t: EventTarget | null) => {
    const b = (t as Element | null)?.closest?.('button') as HTMLButtonElement | null;
    return b && !b.classList.contains('touch-btn') && !b.disabled ? b : null;
  };
  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    // Новий палець робить мультитач і для дотиків, що вже тривають.
    for (const a of active.values()) a.multi = true;
    active.set(e.pointerId, { b: buttonAt(e.target), multi: active.size > 0 });
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    const a = active.get(e.pointerId);
    active.delete(e.pointerId);
    const b = a?.b;
    if (!b || !a.multi || !b.isConnected) return;
    // Палець відпущено над тією самою кнопкою (target дотику — початковий елемент, тож за координатами).
    const r = b.getBoundingClientRect();
    if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
    b.click();
    fired = b;
    firedUntil = performance.now() + 600;
  };
  const onCancel = (e: PointerEvent) => active.delete(e.pointerId);
  const onClick = (e: MouseEvent) => {
    // Рідний click після нашого (isTrusted) — зайвий.
    if (!e.isTrusted || !fired || performance.now() > firedUntil) return;
    if (buttonAt(e.target) !== fired) return;
    fired = null;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('pointerup', onUp, true);
  root.addEventListener('pointercancel', onCancel, true);
  root.addEventListener('click', onClick, true);
  return () => {
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('pointerup', onUp, true);
    root.removeEventListener('pointercancel', onCancel, true);
    root.removeEventListener('click', onClick, true);
  };
}
