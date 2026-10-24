import * as THREE from 'three';

/**
 * Ближнє світло фар гравця — маска прожектора (`SpotLight.map`, працює без тіней): власна реалізація на прохання
 * користувача (оригінальний механізм фар king.exe не перенесено, Docs/ht2/lighting.md).
 *
 * Вісь фари — горизонтально вперед, згасання з відстанню немає (decay 0), а освітленість не залежить від кута
 * падіння (installHeadlightShading): дорога, стіни й машини нижче межі освітлені однаково — сила × маска. Інакше або
 * дорога вдалині темна (світло ковзає під кутом h / x), або, з підсиленням маски біля межі, вертикальні предмети
 * пересвічені в десятки разів. Маска в площині проєкції (тангенси кутів від осі):
 * - вище лінії відсічки (кут atan(h / cutoff) нижче горизонту) — темно: дорога світиться до відстані cutoff, а
 *   зустрічні машини й усе, що вище цієї площини, — ні (межа, як у справжньої ближньої фари); нижче — повна сила;
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
      const v = Math.round(255 * edge * side);
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

/**
 * Освітлення фарами без залежності від кута падіння: у гілці прожектора з маскою (у HT2 так світять лише фари
 * гравця) колір ділиться на cos кута між нормаллю й напрямком на фару — Lambert/Phong множать його назад.
 *
 * Фара світить майже горизонтально (≈1° вниз), тож трава, нахилена від машини хоч на градус (нормалі газону
 * відхилені до 45°), була б «повернута від фари» й темніла смугами з різкими краями, хоча дорога поруч світиться.
 * Тому земля (нормаль дивиться вгору: cos з вертикаллю ≥ GROUND_UP) освітлюється завжди — напрямок світла для неї
 * замінено нормаллю (Lambert дає рівно колір прожектора); темними лишаються лише крутіші поверхні, повернуті від фари
 * (дальній бік машин), з плавним переходом від GROUND_UP − 0,2. Шматки шейдерів спільні для всіх матеріалів
 * (як vertexFog), першу гру не зачіпає: вихід до вибору гри перезавантажує сторінку.
 *
 * Нульові нормалі (є в даних регіонів, напр. bb і ba — схили `mat_slope*`, king.exe кладе їх у вершини як є):
 * normalize(0) у шейдері дає NaN — для попіксельних світел (лише прожектори; сонце рахується у вершинах) нормаль
 * такого місця береться з площини трикутника.
 */
const GROUND_UP = 0.5;

export function installHeadlightShading(): void {
  const c = THREE.ShaderChunk as unknown as Record<string, string>;
  const from = 'directLight.color = inSpotLightMap ? directLight.color * spotColor.rgb : directLight.color;';
  if (!c.lights_fragment_begin.includes(from)) throw new Error('headlights: шматок шейдера прожектора змінився');
  c.lights_fragment_begin = c.lights_fragment_begin.replace(
    from,
    `${from}
			{
				float hlCos = dot( geometryNormal, directLight.direction );
				float hlUp = dot( geometryNormal, normalize( ( viewMatrix * vec4( 0.0, 1.0, 0.0, 0.0 ) ).xyz ) );
				float hlGround = smoothstep( ${(GROUND_UP - 0.2).toFixed(2)}, ${GROUND_UP.toFixed(2)}, hlUp );
				if ( hlCos > 0.01 && hlGround < 1.0 ) {
					directLight.color *= 1.0 / hlCos;
				} else {
					directLight.color *= max( hlGround, clamp( hlCos * 100.0, 0.0, 1.0 ) );
					directLight.direction = geometryNormal;
				}
			}`,
  );
  const nFrom = 'vec3 normal = normalize( vNormal );';
  if (!c.normal_fragment_begin.includes(nFrom)) throw new Error('headlights: шматок шейдера нормалі змінився');
  c.normal_fragment_begin = c.normal_fragment_begin.replace(
    nFrom,
    'vec3 normal = dot( vNormal, vNormal ) > 1e-12 ? normalize( vNormal ) : normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) );',
  );
}
