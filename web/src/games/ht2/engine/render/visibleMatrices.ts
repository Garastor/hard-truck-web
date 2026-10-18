import * as THREE from 'three';

/**
 * Матриці світу лише для видимих гілок сцени (оптимізація порту для телефона). Стандартний
 * `scene.updateMatrixWorld()` обходить усі вузли, зокрема сховані: кімнати поза порталами, варіанти перемикачів,
 * пошкодження й LOD моделей машин — у світі HT2 це ~85 % з ~11 тис. вузлів, а рухома машина змушує щокадру
 * перемножувати матриці всього свого дерева (~3,9 тис. вузлів, видимих ~220).
 *
 * Сховану гілку, чий батько змінився, лише позначаємо (`matrixWorldNeedsUpdate`) — її перерахують, коли її покажуть
 * (до кадру — цим обходом, під час кадру — перемикачі типів 9/10, `revealChild`). Явні `updateMatrixWorld(true)`
 * (збирання, колізії) і далі оновлюють усе дерево. Сцену з цим обходом позначати
 * `matrixWorldAutoUpdate = false`, щоб рендерер не обходив її вдруге.
 */
export function updateVisibleMatrices(o: THREE.Object3D, force = false): void {
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.matrixWorldNeedsUpdate || force) {
    if (o.parent) o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix);
    else o.matrixWorld.copy(o.matrix);
    o.matrixWorldNeedsUpdate = false;
    force = true;
  }
  const children = o.children;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c.visible) {
      if (c.matrixWorldAutoUpdate) updateVisibleMatrices(c, force);
    } else if (force) c.matrixWorldNeedsUpdate = true;
  }
}

/**
 * Показати чи сховати дочірній вузол під час кадру (перемикачі в `update(camera)` — після обходу матриць): щойно
 * показаній гілці, пропущеній обходом, — свіжі матриці.
 */
export function revealChild(c: THREE.Object3D | undefined, on: boolean): void {
  if (!c || c.visible === on) return;
  c.visible = on;
  if (on) c.updateMatrixWorld(true);
}
