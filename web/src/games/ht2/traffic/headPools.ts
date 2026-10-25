import * as THREE from 'three';
import { HEAD_HALF_ANGLE, beamProfile } from '../vehicles/headlights';

/**
 * Світлові плями фар на дорозі — власна реалізація на прохання користувача (оригінального механізму не знайдено,
 * Docs/ht2/lighting.md): фари машин трафіку й ботів (уперед) і вогні заднього ходу машини гравця (назад; у king.exe
 * такої плями немає). Справжній прожектор на кожну машину телефон не витягне: three.js рахує кожне світло в кожному
 * пікселі світу, а зміна кількості світел перекомпільовує шейдери. Тому пляма — плаский полігон у площині машини, що
 * множить колір під собою: результат = під · (1 + світло лампи / нічне світло), тобто дорога світлішає пропорційно
 * своєму кольору, як від світла (а не сіріє, як від додавання). Ціна — лише пікселі самої плями.
 *
 * Пляма фар — як світло фар гравця на землі (vehicles/headlights.ts): віяло в конусі 120° з тим самим профілем убік
 * (beamProfile: яскраве ядро й широке розсіяне світло) від кожної з двох фар; колір — точно як від фари гравця при
 * тому самому нічному освітленні, окремо по каналах (setPoolLight; замір у грі: фара гравця множить колір дороги на
 * ≈2,7 / 2,2 / 1,9 по R/G/B — ця формула дає те саме). Множник більший за 2, а змішування DstColor + One дає не
 * більше 2 (вихід шейдера ≤ 1), тож полігон малюється двічі з √(1 + k) − 1: разом рівно 1 + k (до 4).
 *
 * Обмеження: світить лише в площині машини (стіни й інші машини не освітлює); на перегині дороги дальній край
 * ховається під асфальт чи трохи висить — тому пляма коротша за світло фар гравця (80 м) і плавно гасне.
 */
export type PoolKind = 'head' | 'back';

interface PoolShape {
  /** Довжина плями від лампи, м. */
  length: number;
  /** Півкут віяла (полігон), рад. */
  angle: number;
  /** Сила вбік залежно від тангенса кута від осі лампи (0…1). */
  side: (tx: number) => number;
  /** З якої частки довжини пляма гасне до дальнього краю. */
  fadeFrom: number;
  /** На якій відстані від лампи світло доходить до землі повністю, м (ближче — плавно). */
  near: number;
}

/**
 * Профіль вогнів заднього ходу (на око): розсіяне світло — гаус BACK_SPREAD від осі, до нуля на краю віяла
 * BACK_ANGLE; пляма коротка (BACK_LENGTH) і широка — світло тьмяне, з низько посаджених ламп.
 */
const BACK_ANGLE = (75 * Math.PI) / 180;
const BACK_SPREAD = (40 * Math.PI) / 180;
const BACK_EDGE = (20 * Math.PI) / 180;

const SHAPES: Record<PoolKind, PoolShape> = {
  head: { length: 50, angle: HEAD_HALF_ANGLE, side: beamProfile(HEAD_HALF_ANGLE), fadeFrom: 0.55, near: 1 },
  back: {
    length: 11,
    angle: BACK_ANGLE,
    side: (tx) => {
      const a = Math.atan(tx);
      const e = Math.min(1, Math.max(0, (BACK_ANGLE - a) / BACK_EDGE));
      return Math.exp(-((a / BACK_SPREAD) ** 2)) * e * e * (3 - 2 * e);
    },
    fadeFrom: 0.25,
    near: 0.5,
  },
};

/** Світло однієї лампи відносно нічного світла дороги, по каналах (множник 1 + k · маска), — за видом плями. */
const ratios: Record<PoolKind, THREE.Color> = { head: new THREE.Color(0.5, 0.5, 0.5), back: new THREE.Color(0.2, 0.2, 0.2) };
/** Найбільше світло однієї лампи відносно нічного (дві разом — до 3: множник до 4, межа двох проходів). */
const RATIO_MAX = 1.5;

/**
 * Світло плям виду kind: lamp — колір лампи, power — освітленість від неї (у тих самих одиницях, що й розсіяне світу:
 * Lambert ділить силу прямого світла на π, а сила розсіяного в HT2 — π), base — нічне світло дороги під плямою
 * (розсіяне + місяць). Окремо по каналах — як світло фари гравця на дорозі.
 */
export function setPoolLight(kind: PoolKind, lamp: THREE.Color, power: number, base: THREE.Color): void {
  const ch = (l: number, b: number) => Math.min(RATIO_MAX, (power * l) / Math.max(b, 0.02));
  ratios[kind].setRGB(ch(lamp.r, base.r), ch(lamp.g, base.g), ch(lamp.b, base.b));
}

/** Підйом над дорогою, м — щоб не мерехтіла з асфальтом (плюс зсув глибини). */
const POOL_LIFT = 0.08;

/** Полотно маски: поперек (u) і вздовж (v: 0 — біля ламп, 1 — дальній край). */
const TEX_W = 256;
const TEX_H = 128;
const textures = new Map<string, THREE.DataTexture>();

const smooth = (e: number) => {
  const x = Math.min(1, Math.max(0, e));
  return x * x * (3 - 2 * x);
};

/** Півширина дальнього краю віяла для ламп на ±half, м. */
const reach = (s: PoolShape, half: number) => half + s.length * Math.tan(s.angle);

/**
 * Маска плями двох ламп на ±half від середини (згори, у площині дороги): середнє двох ламп — 0…1 (множник шейдера
 * подвоєний). Кожна лампа — сила вбік side(|x − xл| / z) (z — відстань уперед від лампи), біля ламп світло плавно
 * доходить до землі, на дальній частині плями — гасне.
 */
function texture(kind: PoolKind, half: number): THREE.DataTexture {
  const key = `${kind}:${half.toFixed(2)}`;
  const had = textures.get(key);
  if (had) return had;
  const s = SHAPES[kind];
  const X = reach(s, half);
  const data = new Uint8Array(TEX_W * TEX_H * 4);
  for (let j = 0; j < TEX_H; j++) {
    const v = (j + 0.5) / TEX_H;
    const z = v * s.length;
    const along = smooth(z / s.near) * smooth((1 - v) / (1 - s.fadeFrom));
    for (let i = 0; i < TEX_W; i++) {
      const x = ((i + 0.5) / TEX_W - 0.5) * 2 * X;
      const m = z > 0 ? 0.5 * (s.side(Math.abs(x + half) / z) + s.side(Math.abs(x - half) / z)) : 0;
      const k = (j * TEX_W + i) * 4;
      data[k] = data[k + 1] = data[k + 2] = Math.round(255 * along * m);
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, TEX_W, TEX_H);
  // Без mip-рівнів: пляму видно під пологим кутом, і вони розмивали вузьке ядро (центр тьмянів удвічі); маска
  // плавна, тож мерехтіння без них немає.
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  textures.set(key, tex);
  return tex;
}

const VERTEX = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

/** Половина множника за прохід: (1 + a)² = 1 + k · маска. */
const FRAGMENT = `
uniform sampler2D map;
uniform vec3 ratio;
varying vec2 vUv;
void main() {
  float m = texture2D(map, vUv).r;
  gl_FragColor = vec4(min(sqrt(1.0 + ratio * m) - 1.0, vec3(1.0)), 1.0);
}`;

/**
 * Пляма двох ламп (свій матеріал на машину — для згасання з відстанню) у системі машини: вісь машини −Z, дорога —
 * y = ground, лампи — на z = z0, x = left і right; head світить уперед (−Z), back — назад (+Z).
 */
export function makePool(kind: PoolKind, ground: number, z0: number, left: number, right: number): THREE.Group {
  const s = SHAPES[kind];
  const half = Math.max(0, Math.abs(right - left) / 2);
  const mid = (left + right) / 2;
  const X = reach(s, half);
  const dir = kind === 'head' ? -1 : 1;
  const y = ground + POOL_LIFT;
  const zf = z0 + dir * s.length;
  // Трапеція віяла: біля ламп — між ними, на дальньому краї — ±X; u поперек полотна, v уздовж.
  const pos = [mid - half, y, z0, mid + half, y, z0, mid + X, y, zf, mid - X, y, zf];
  const uv = [0.5 - half / (2 * X), 0, 0.5 + half / (2 * X), 0, 1, 1, 0, 1];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  // Лицем угору: обхід проти годинникової згори для head (−Z уперед), для back — дзеркальний.
  geo.setIndex(dir < 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]);
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture(kind, half) }, ratio: { value: new THREE.Color() } },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.DstColorFactor,
    blendDst: THREE.OneFactor,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -4,
  });
  const g = new THREE.Group();
  g.name = kind === 'head' ? 'HeadPools' : 'BackPools';
  g.userData.kind = kind;
  // Два проходи того самого полігона — множник до 4 (FRAGMENT).
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    g.add(mesh);
  }
  setPoolFade(g, 1);
  return g;
}

/**
 * Сила плям (fade 0…1: 1 — повна, 0 — сховані): згасання з відстанню, а для заднього ходу — ще й половина, коли
 * горить лише один вогонь. Колір — останній setPoolLight свого виду.
 */
export function setPoolFade(pool: THREE.Group, fade: number): void {
  pool.visible = fade > 0.01;
  const mat = (pool.children[0] as THREE.Mesh).material as THREE.ShaderMaterial;
  // Полотно — середнє двох ламп, тож множник — на дві.
  (mat.uniforms.ratio.value as THREE.Color).copy(ratios[pool.userData.kind as PoolKind]).multiplyScalar(2 * fade);
}

export function disposePool(pool: THREE.Group): void {
  pool.removeFromParent();
  const m = pool.children[0] as THREE.Mesh | undefined;
  m?.geometry.dispose();
  (m?.material as THREE.Material | undefined)?.dispose();
}
