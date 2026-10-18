import * as THREE from 'three';

/**
 * Ближнє світло фар гравця — маска прожектора (`SpotLight.map`, працює без тіней): власна реалізація на прохання
 * користувача (оригінальний механізм фар king.exe не перенесено, Docs/ht2/lighting.md).
 *
 * Вісь фари — горизонтально вперед. Маска в площині проєкції (тангенси кутів від осі):
 * - вище лінії відсічки (кут atan(h / cutoff) нижче горизонту) — темно: дорога світиться до відстані cutoff, а
 *   зустрічні машини й усе, що вище цієї площини, — ні (чітка межа, як у справжньої ближньої фари);
 * - нижче — вага t_c / t (t — тангенс кута вниз, t_c — на межі). Точка дороги на відстані x видна під t = h / x і
 *   отримує (без згасання з відстанню, decay 0) освітленість ∝ вага · cos = (t_c / t) · t = t_c — тобто однакову від
 *   капота до межі, без яскравої плями біля машини;
 * - убік — повна сила до |tx| < SIDE_FULL, далі плавно до нуля на SIDE_ZERO.
 */
const W = 128;
const H = 1024;
const SIDE_FULL = 0.21;
const SIDE_ZERO = 0.42;
/** Розмиття межі, рядків маски (≈ 1 — чітка, без сходинок). */
const EDGE_ROWS = 1.5;

/**
 * Маска для фари на висоті h над землею (м), межа світла на відстані cutoff (м), півкут конуса angle (рад).
 */
export function headlightMask(h: number, cutoff: number, angle: number): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  const span = 2 * Math.tan(angle);
  const tc = Math.max(h, 0.1) / cutoff;
  const rowT = span / H;
  for (let j = 0; j < H; j++) {
    // Верхній рядок полотна — угору (CanvasTexture перевертає: v = 1 — верх проєкції).
    const t = -((1 - (j + 0.5) / H) - 0.5) * span;
    const edge = Math.min(1, Math.max(0, (t - tc) / (EDGE_ROWS * rowT) + 0.5));
    const wy = edge * Math.min(1, tc / Math.max(t, tc));
    for (let i = 0; i < W; i++) {
      const tx = Math.abs(((i + 0.5) / W - 0.5) * span);
      const s = Math.min(1, Math.max(0, (SIDE_ZERO - tx) / (SIDE_ZERO - SIDE_FULL)));
      const v = Math.round(255 * wy * s * s * (3 - 2 * s));
      const k = (j * W + i) * 4;
      img.data[k] = img.data[k + 1] = img.data[k + 2] = v;
      img.data[k + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
}
