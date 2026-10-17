import type * as THREE from 'three';

/**
 * Дальність малювання HT2 — по краю туману (drive.ts: `camera.far` = fog.far із запасом): далі туману однаково лише
 * його колір. Небо з хмарами (власний туман неба, без глибини), відблиски сонця й блискавку обрізати не можна: їм
 * глибину вершини затискаємо до дальньої площини (z ≤ w у просторі відсікання) — далі неї вони лягають на саму
 * площину, а не відкидаються. Вивісок і ореолів без туману (`fog: false`) це не стосується: далеко за туманом їх
 * закривали пагорби, яких за дальньою площиною вже немає, — затиснуті, вони просвічували б крізь гори; такі спрайти
 * обрізаються на краю туману разом зі світом.
 */
export function noFarClip(m: THREE.Material): void {
  if (m.userData.noFarClip) return;
  m.userData.noFarClip = true;
  const key = m.customProgramCacheKey();
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev.call(m, sh, r);
    sh.vertexShader = sh.vertexShader.replace(
      '#include <fog_vertex>',
      '#include <fog_vertex>\ngl_Position.z = min(gl_Position.z, gl_Position.w * 0.99999);',
    );
  };
  m.customProgramCacheKey = () => `${key}|nofar`;
}
