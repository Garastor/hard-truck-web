import RAPIER from '@dimforge/rapier3d-compat';
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
varying vec3 vWorld;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

/**
 * Половина множника за прохід: (1 + a)² = 1 + k · маска. Світло має додаватися: пляма множить колір під собою, а там
 * може вже світити фара гравця (×2…3,5 уночі) — множник на освітлений піксель давав аномально білу пляму (зайвий
 * доданок «світло гравця × світло плями / нічне»). Тому k ділиться на 1 + q, де q — світло фар гравця в цьому пікселі
 * відносно нічного (та сама маска прожектора, playerLamps): колір = тло · (нічне + гравець + пляма).
 */
const FRAGMENT = `
uniform sampler2D map;
uniform vec3 ratio;
uniform sampler2D playerMask;
uniform mat4 playerMat[2];
uniform float playerOn;
uniform vec3 playerRatio;
varying vec2 vUv;
varying vec3 vWorld;
float lampAt(mat4 M) {
  vec4 c = M * vec4(vWorld, 1.0);
  if (c.w <= 0.0) return 0.0;
  vec3 p = c.xyz / c.w;
  if (any(greaterThan(abs(p * 2.0 - 1.0), vec3(1.0)))) return 0.0;
  return texture2D(playerMask, p.xy).r;
}
void main() {
  float m = texture2D(map, vUv).r;
  vec3 q = playerOn > 0.5 ? playerRatio * (lampAt(playerMat[0]) + lampAt(playerMat[1])) : vec3(0.0);
  vec3 k = ratio * m / (1.0 + q);
  gl_FragColor = vec4(min(sqrt(1.0 + k) - 1.0, vec3(1.0)), 1.0);
}`;

/**
 * Фари гравця для плям (спільні uniform-и всіх плям): маска прожектора, матриці «світ → полотно маски» обох фар (як
 * spotLightMatrix three.js), світло однієї фари відносно нічного — те саме, що в плям фар (ratios.head: той самий колір
 * і сила LAMP_ROAD).
 */
const playerLamps = {
  playerMask: { value: null as THREE.Texture | null },
  playerMat: { value: [new THREE.Matrix4(), new THREE.Matrix4()] },
  playerOn: { value: 0 },
  playerRatio: { value: ratios.head },
};

/** Щокадру: чи горять фари гравця й де вони (прожектори з маскою — drive.mountLamps). */
export function setPlayerLamps(lamps: THREE.SpotLight[]): void {
  const on = lamps.length >= 2 && lamps[0].visible && lamps[0].intensity > 0 && !!lamps[0].map;
  playerLamps.playerOn.value = on ? 1 : 0;
  if (!on) return;
  playerLamps.playerMask.value = lamps[0].map;
  for (let i = 0; i < 2; i++) {
    const l = lamps[i];
    l.updateWorldMatrix(true, false);
    l.target.updateWorldMatrix(true, false);
    l.shadow.updateMatrices(l);
    playerLamps.playerMat.value[i].copy(l.shadow.matrix);
  }
}

/**
 * Сітка плями, що лягає на дорогу (drapePool): рядки вздовж (частки довжини — густіше біля ламп) × стовпці поперек
 * (частки півширини рядка). Раніше пляма була пласкою трапецією в площині машини: нахил моделі (нормаль ґрунту
 * перечитується кожні 0,12 с, у ботів ще й підвіска) на 50 м зсував лінію, де пляма пірнає під асфальт, — дальній край
 * сіпався й був різкою прямою.
 */
const ROWS = [0, 0.06, 0.15, 0.3, 0.5, 0.75, 1];
const COLS = [-1, -0.5, 0, 0.5, 1];
/** За кадр промені до ґрунту — у третини рядків (решта — збережена висота дороги). */
const DRAPE_STEP = 3;
/** Ближче за стільки до гравця пляма лягає на дорогу (drapePool), далі — лишається, як була (сіпання не видно), м. */
export const DRAPE_NEAR = 160;
/**
 * Межі висоти ґрунту відносно площини машини, м: далі (урвище, крутий пагорб) — притиснути до межі. Повертати в
 * площину не можна: вершина біля межі стрибала б то на дорогу, то в площину.
 */
const DRAPE_RANGE = 4;
/** Промінь до ґрунту — з такої висоти над площиною машини, м (нижче за настил мосту над дорогою). */
const DRAPE_FROM = 4;

interface Drape {
  /** Локальні x, z вершин (система машини). */
  xz: Float32Array;
  /** Висота площини машини (дорога під машиною), локальна. */
  ground: number;
  /**
   * Висота дороги під вершинами — у світових координатах (NaN — ще невідома): машина хитається й різко міняє нахил
   * (нормаль ґрунту — кожні 0,12 с), а дорога нерухома; у систему машини переводиться щокадру за поточною матрицею.
   */
  h: Float32Array;
  phase: number;
  fresh: boolean;
}

/**
 * Пляма двох ламп (свій матеріал на машину — для згасання з відстанню) у системі машини: вісь машини −Z, дорога —
 * y = ground, лампи — на z = z0, x = left і right; head світить уперед (−Z), back — назад (+Z). Щокадру —
 * drapePool (кладе сітку на дорогу).
 */
export function makePool(kind: PoolKind, ground: number, z0: number, left: number, right: number): THREE.Group {
  const s = SHAPES[kind];
  const half = Math.max(0, Math.abs(right - left) / 2);
  const mid = (left + right) / 2;
  const X = reach(s, half);
  const dir = kind === 'head' ? -1 : 1;
  const C = COLS.length;
  const n = ROWS.length * C;
  const pos = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const xz = new Float32Array(n * 2);
  // Віяло: біля ламп — між ними, на дальньому краї — ±X; u поперек полотна (лінійно по x), v уздовж.
  ROWS.forEach((v, r) => {
    const w = half + (X - half) * v;
    const z = z0 + dir * s.length * v;
    COLS.forEach((f, c) => {
      const i = r * C + c;
      const x = mid + f * w;
      pos.set([x, ground + POOL_LIFT, z], i * 3);
      uv.set([0.5 + (x - mid) / (2 * X), v], i * 2);
      xz.set([x, z], i * 2);
    });
  });
  const index: number[] = [];
  for (let r = 0; r + 1 < ROWS.length; r++)
    for (let c = 0; c + 1 < C; c++) {
      const a = r * C + c;
      const b = a + 1;
      const d = a + C;
      const e = d + 1;
      // Лицем угору: обхід проти годинникової згори для head (−Z уперед), для back — дзеркальний.
      index.push(...(dir < 0 ? [a, b, e, a, e, d] : [a, e, b, a, d, e]));
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  // Сітка ходить угору-вниз за дорогою (drapePool) — сфера відсікання з запасом.
  geo.boundingSphere!.radius += DRAPE_RANGE;
  const mat = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture(kind, half) }, ratio: { value: new THREE.Color() }, ...playerLamps },
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
  const drape: Drape = { xz, ground, h: new Float32Array(n).fill(NaN), phase: 0, fresh: true };
  g.userData.drape = drape;
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

const DRAPE_DOWN = { x: 0, y: -1, z: 0 };
const DRAPE_P = new THREE.Vector3();
const DRAPE_INV = new THREE.Matrix4();
const fixedOnly = (c: RAPIER.Collider) => c.parent()?.isFixed() ?? true;

/**
 * Покласти пляму на дорогу: промінь донизу (лише нерухомі колізії — не машини) під вершинами третини рядків по черзі
 * (першого разу — усіх) оновлює світову висоту дороги; щокадру всі вершини — на цю висоту в поточній системі машини,
 * тож хитання машини пляму не зсуває. Лише видима пляма. Нема ґрунту — попередня висота; далі за DRAPE_RANGE від
 * площини машини — межа.
 */
export function drapePool(pool: THREE.Group, world: RAPIER.World): void {
  const host = pool.parent;
  const dr = pool.userData.drape as Drape | undefined;
  if (!host || !dr || !pool.visible) return;
  host.updateWorldMatrix(true, false);
  const M = host.matrixWorld;
  DRAPE_INV.copy(M).invert();
  const C = COLS.length;
  const n = dr.h.length;
  for (let r = dr.fresh ? 0 : dr.phase; r < ROWS.length; r += dr.fresh ? 1 : DRAPE_STEP) {
    for (let c = 0; c < C; c++) {
      const i = r * C + c;
      DRAPE_P.set(dr.xz[i * 2], dr.ground, dr.xz[i * 2 + 1]).applyMatrix4(M);
      const top = DRAPE_P.y + DRAPE_FROM;
      const hit = world.castRay(new RAPIER.Ray({ x: DRAPE_P.x, y: top, z: DRAPE_P.z }, DRAPE_DOWN), DRAPE_FROM + DRAPE_RANGE, false, undefined, undefined, undefined, undefined, fixedOnly);
      if (hit) dr.h[i] = top - hit.timeOfImpact;
    }
  }
  dr.phase = (dr.phase + 1) % DRAPE_STEP;
  dr.fresh = false;
  const mesh = pool.children[0] as THREE.Mesh;
  const pos = mesh.geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < n; i++) {
    let y = dr.ground;
    if (!Number.isNaN(dr.h[i])) {
      DRAPE_P.set(dr.xz[i * 2], dr.ground, dr.xz[i * 2 + 1]).applyMatrix4(M);
      DRAPE_P.y = dr.h[i];
      y = Math.min(dr.ground + DRAPE_RANGE, Math.max(dr.ground - DRAPE_RANGE, DRAPE_P.applyMatrix4(DRAPE_INV).y));
    }
    pos.setY(i, y + POOL_LIFT);
  }
  pos.needsUpdate = true;
}

export function disposePool(pool: THREE.Group): void {
  pool.removeFromParent();
  const m = pool.children[0] as THREE.Mesh | undefined;
  m?.geometry.dispose();
  (m?.material as THREE.Material | undefined)?.dispose();
}
