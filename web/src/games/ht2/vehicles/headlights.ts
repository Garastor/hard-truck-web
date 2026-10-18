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
 * - асиметрія («галочка», як у європейських фар): ліворуч від осі межа рівна, праворуч від осі піднімається під
 *   RISE_SLOPE (15°) на RIGHT_RISE вище — праве узбіччя й знаки світяться далі, зустрічних ліворуч не сліпить;
 * - убік — повна сила до |tx| < SIDE_FULL, далі плавно до нуля на SIDE_ZERO.
 */
const W = 256;
const H = 1024;
const SIDE_FULL = 0.21;
const SIDE_ZERO = 0.42;
/**
 * Ширина плавного переходу над межею (тангенс кута, ≈ 0,7°): світло згасає smoothstep від лінії відсічки вгору —
 * дорога до межі освітлена повністю, далі тьмяніє поступово (на прохання користувача — без різкого обриву).
 */
const EDGE_SOFT = 0.012;
/** Підйом правої частини межі (тангенс кута; ≈ 1,1° — трохи вище горизонту) і нахил «галочки» (tan 15°) — на око. */
const RIGHT_RISE = 0.02;
const RISE_SLOPE = Math.tan((15 * Math.PI) / 180);

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
  for (let i = 0; i < W; i++) {
    const x = ((i + 0.5) / W - 0.5) * span;
    // Межа цього стовпця: праворуч (x > 0) — вище на min(RIGHT_RISE, x · tan 15°).
    const cut = tc - Math.min(RIGHT_RISE, Math.max(0, x) * RISE_SLOPE);
    const tx = Math.abs(x);
    const s = Math.min(1, Math.max(0, (SIDE_ZERO - tx) / (SIDE_ZERO - SIDE_FULL)));
    const side = s * s * (3 - 2 * s);
    for (let j = 0; j < H; j++) {
      // Верхній рядок полотна — угору (CanvasTexture перевертає: v = 1 — верх проєкції); t — тангенс кута вниз.
      const t = -((1 - (j + 0.5) / H) - 0.5) * span;
      const e = Math.min(1, Math.max(0, (t - cut) / EDGE_SOFT + 1));
      const edge = e * e * (3 - 2 * e);
      const v = Math.round(255 * edge * Math.min(1, tc / Math.max(t, tc)) * side);
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
