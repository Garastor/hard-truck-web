import * as THREE from 'three';
import { walk, type B3d } from '../engine/formats/b3d';
import type { RmpArchive } from '../engine/formats/rmp';
import { parseTxr } from '../engine/formats/txr';

/**
 * Дерева Дальнобойщиків 2 — генератор `$$TreeGenerator1` (блок 40): центр і радіус обмежувальної сфери, `i1`.
 * Поведінка — за king.exe (re/notes/ht2/trees.md): біти `i1` 4–7 — вид N (атлас `tree<2⌊N/2⌋><2⌊N/2⌋+1>`), 8–11 —
 * форма (0…6), біт 0 — шар гілок зблизька (`tree<N>`, ще не в порту), біт 1 — тінь.
 *
 * Основа — площина з атласу, що повертається до камери навколо осі стовбура (циліндричний білборд, як в оригіналі;
 * у порту — у вершинному шейдері). Форми 3 і 4 беруть увесь атлас (листяне дерево `tree23`, кущ `tree45`), площина
 * завширшки з висоту; решта — половину (`tree01`: дві ялини, вибір — за парністю виду), ширина — частина висоти
 * (форма 0 — ½, 2 — ⅔; 1, 5, 6 — гіпотеза ½). u — від краю половини, 0,45 її ширини (без смужки кори).
 * Основа — центр сфери (він на рівні землі), висота — радіус (за знімками оригіналу). Колір-ключ — запис 256 палітри common.plm.
 */
interface TreeSpot {
  x: number;
  y: number;
  z: number;
  r: number;
  /** Вид (біти 4–7 i1). */
  kind: number;
  /** Форма (біти 8–11 i1). */
  shape: number;
}

export function collectTrees(b3d: B3d): TreeSpot[] {
  const out: TreeSpot[] = [];
  for (const [blk] of walk(b3d.blocks)) {
    const d = blk.data;
    if (d.t !== 40 || d.name2 !== '$$TreeGenerator1') continue;
    const [x, y, z, r] = d.bound;
    if (r <= 0) continue;
    out.push({ x, y, z, r, kind: (d.i1 >> 4) & 15, shape: (d.i1 >> 8) & 15 });
  }
  return out;
}

function atlasTexture(rmp: RmpArchive, pattern: RegExp, palette: Uint8Array | null): THREE.Texture | null {
  const file = rmp.order.TEXTUREFILES.find((n) => pattern.test(n));
  const bytes = file ? rmp.textures.get(file) : undefined;
  if (!bytes) return null;
  const img = parseTxr(bytes);
  const d = img.data;
  if (palette) {
    const c = 255 * 3;
    const kr = palette[c] >> 3, kg = palette[c + 1] >> 2, kb = palette[c + 2] >> 3;
    for (let i = 0; i < d.length; i += 4) if (d[i] >> 3 === kr && d[i + 1] >> 2 === kg && d[i + 2] >> 3 === kb) d[i + 3] = 0;
  }
  const t = new THREE.DataTexture(d, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  // Без міпмапів: з ними дерева здалеку розмиті й «худнуть» (відсікання прозорих пікселів на зменшених рівнях);
  // в оригіналі здалеку чіткі (порівняння знімків користувача).
  t.minFilter = THREE.LinearFilter;
  t.generateMipmaps = false;
  t.name = file!;
  t.needsUpdate = true;
  return t;
}

/**
 * Форма: ширина площини (частка висоти), увесь атлас чи половина, і межа градієнта тіні split (param_13 у
 * 0x005c6ac0): форми 0, 1 — 0,2, 2…4 — 0,3; 5, 6 — гіпотеза 0,2.
 */
function shapeOf(shape: number): { width: number; full: boolean; split: number } {
  if (shape === 3 || shape === 4) return { width: 1, full: true, split: 0.3 };
  if (shape === 2) return { width: 1 / 1.5, full: false, split: 0.3 };
  return { width: 0.5, full: false, split: 0.2 };
}

/**
 * Світло дерев (king.exe 0x005ca660): дерева не освітлюються за нормалями — колір = розсіяне + 0,7 · (сонце +
 * місяць), до 1 (ставить Ht2World.setClimate). Спільна uniform-змінна всіх матеріалів дерев.
 */
export const TREE_LIGHT = { value: new THREE.Color(1, 1, 1) };

/** Множник кольору за висотою (0x005c6ac0): 0,35 біля землі → 0,7 на межі split → 1 на вершині. */
export function treeShade(z: number, split: number): number {
  return z < split ? 0.35 + (0.35 * z) / split : 0.7 + (0.3 * (z - split)) / (1 - split);
}

/** Смужка кори в половині атласу (u від початку половини) — праворуч від дерева (≈ px 118…125 з 128). */
const BARK_U0 = 0.46;
const BARK_UW = 0.025;
/** Ширина стовбура — частка висоти дерева (за знімком оригіналу — тонкий; гіпотеза). */
const TRUNK_W = 0.025;
/** Верх стовбура — частка висоти: на знімку оригіналу стовбур видно крізь крону до ≈ середини дерева. */
const TRUNK_TOP = 0.5;
/** Наскільки стовбур відсунуто від камери за площину крони, м. */
const TRUNK_PUSH = 0.4;

/**
 * Площина (z угору) від z0 до z1, x — від −w/2 до w/2; u — [u0, u0 + uw], v — від низу зображення до верху.
 * Колір вершин — градієнт тіні treeShade (з рядком вершин на межі split).
 */
function planeGeometry(width: number, u0: number, uw: number, z0: number, z1: number, split: number): THREE.BufferGeometry {
  const w = width / 2;
  const rows = [z0, ...(split > z0 && split < z1 ? [split] : []), z1];
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  // Рядок 0 текстури — верх зображення: v = 1 — низ площини.
  const add = (x: number, z: number) => {
    pos.push(x, 0, z);
    uv.push(x < 0 ? u0 : u0 + uw, 1 - (z - z0) / (z1 - z0));
    const f = treeShade(z, split);
    c.setRGB(f, f, f, THREE.SRGBColorSpace);
    col.push(c.r, c.g, c.b);
  };
  for (let i = 0; i + 1 < rows.length; i++) {
    const a = rows[i];
    const b = rows[i + 1];
    add(-w, a), add(w, a), add(w, b), add(-w, a), add(w, b), add(-w, b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

/**
 * Погойдування (king.exe 0x005c8010): на дерево — дві пружини (осі x, y гри), L = висота / 3; кроки 0,01 с:
 * кут a += v·h, v += f·h, f = −3,5·L·a − 0,5·v (на межі |a| = 0,125·L кут обмежено, загасання 1,5), і щокроку
 * поштовх L²·вітер·0,04·rnd(0…1). Вершина зсувається на 2a (гіпотеза: вісь — ламана 1:3:6 по третинах висоти зі
 * зсувом третини a/3), у шейдері — уздовж висоти за bend(z).
 */
export class TreeSway {
  private acc = 0;
  constructor(
    /** На дерево: L, ax, vx, fx, ay, vy, fy. */
    private readonly state: Float32Array,
    /** Зсув вершини (x, y гри, м) — атрибут інстансів `sway`. */
    private readonly attr: THREE.InstancedBufferAttribute,
  ) {}

  update(dt: number, wind: number): void {
    this.acc = Math.min(this.acc + dt, 0.1);
    const st = this.state;
    const h = 0.01;
    let moved = false;
    while (this.acc >= h) {
      this.acc -= h;
      for (let i = 0; i < st.length; i += 7) {
        if (!wind && st[i + 1] === 0 && st[i + 4] === 0) continue;
        moved = true;
        const L = st[i];
        const lim = 0.125 * L;
        for (let k = i + 1; k <= i + 4; k += 3) {
          let a = st[k] + h * st[k + 1];
          let damp = 0.5;
          if (Math.abs(a) > lim) (a = a > 0 ? lim : -lim), (damp = 1.5);
          const v = st[k + 1] + h * st[k + 2];
          st[k] = a;
          st[k + 1] = v;
          st[k + 2] = -3.5 * L * a - damp * v + L * L * wind * 0.04 * Math.random();
          // Без вітру пружина згасає — зупинити зовсім, щоб не рахувати далі.
          if (!wind && Math.abs(a) < 1e-4 && Math.abs(v) < 1e-4) st[k] = st[k + 1] = st[k + 2] = 0;
        }
      }
    }
    if (!moved) return;
    const out = this.attr.array as Float32Array;
    for (let i = 0, j = 0; i < st.length; i += 7, j += 2) {
      out[j] = 2 * st[i + 1];
      out[j + 1] = 2 * st[i + 4];
    }
    this.attr.needsUpdate = true;
  }
}

/**
 * Матеріал циліндричного білборда: вершина x — уздовж напрямку ⟂ осі стовбура (локальна z) і напрямку на камеру,
 * z — уздовж осі. Без освітлення за нормалями (як в оригіналі): колір = текстура × градієнт тіні (колір вершин) ×
 * TREE_LIGHT. Погойдування — атрибут інстансів `sway` (зсув вершини, м гри), уздовж висоти — ламана bend(z).
 */
function billboardMaterial(map: THREE.Texture, push = 0): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.treeLight = TREE_LIGHT;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 sway;').replace(
      '#include <project_vertex>',
      `mat4 bbM = modelViewMatrix * instanceMatrix;
      vec4 bbC = bbM * vec4(0.0, 0.0, 0.0, 1.0);
      vec3 bbUp = (bbM * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
      float bbS = length((bbM * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      vec3 bbR = cross(normalize(bbUp), normalize(-bbC.xyz));
      bbR = length(bbR) > 1e-4 ? normalize(bbR) : normalize((bbM * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      float bz = clamp(transformed.z, 0.0, 1.0);
      float bend = bz < 0.3333 ? bz * 0.5 : (bz < 0.6667 ? bz * 1.5 - 0.3333 : bz * 1.5 - 0.5);
      vec3 swayV = (modelViewMatrix * vec4(sway * bend, 0.0, 0.0)).xyz;
      vec4 mvPosition = vec4(bbC.xyz + bbR * transformed.x * bbS + bbUp * transformed.z + swayV + normalize(bbC.xyz) * ${push.toFixed(2)}, 1.0);
      gl_Position = projectionMatrix * mvPosition;`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 treeLight;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * treeLight, opacity );');
  };
  mat.customProgramCacheKey = () => `ht2-tree-billboard-${push}`;
  return mat;
}

/** Група дерев регіону (система координат гри — додавати в корінь регіону). */
export function buildTrees(b3d: B3d, rmp: RmpArchive, palette: Uint8Array | null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';
  const spots = collectTrees(b3d);
  if (!spots.length) return group;
  const atlases = new Map<number, THREE.Texture | null>();
  const atlas = (pair: number) => {
    if (!atlases.has(pair)) atlases.set(pair, atlasTexture(rmp, new RegExp(`tree${2 * pair}${2 * pair + 1}[^/]*\\.txr$`, 'i'), palette));
    return atlases.get(pair)!;
  };
  // Групи інстансів: атлас × половина (0, 1; 2 — увесь) × форма ширини.
  const groups = new Map<string, { tex: THREE.Texture; u0: number; uw: number; width: number; crown: number; split: number; trunk: boolean; list: TreeSpot[] }>();
  for (const s of spots) {
    const tex = atlas(s.kind >> 1);
    if (!tex) continue;
    const { width, full, split } = shapeOf(s.shape);
    // Крона: форма 2 (хвоя tree23 біля повороту за «Южним») — з 0,3 висоти, під нею видно стовбур (знімок
    // оригіналу); форма 0 (ялини біля бази) — від землі. Решта форм — від землі (гіпотеза). Стовбур зі смужки кори —
    // лише в половинних атласах (до половини висоти, за кроною).
    const crown = s.shape === 2 ? 0.3 : 0;
    const trunk = !full;
    // Половина атласу — за парністю виду (атлас tree<2k><2k+1>: парний вид — ліва, непарний — права; у регіоні ap
    // tree01 — темна | блакитна ялина, tree23 — темна | світла хвоя).
    const half = full ? 2 : s.kind & 1;
    const key = `${s.kind >> 1}:${half}:${width}:${crown}:${split}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tex, u0: half === 2 ? 0 : half * 0.5, uw: half === 2 ? 0.95 : 0.45, width, crown, split, trunk, list: [] }));
    g.list.push(s);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sways: TreeSway[] = [];
  const mats = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
  /**
   * Стовбур — у площині крони: без зсуву пікселі мерехтіли (крона й стовбур на однаковій глибині; знімки
   * користувача). Стовбур відсунуто від камери на TRUNK_PUSH м — крона завжди перекриває його, він видно лише в
   * прозорих проміжках і під кроною.
   */
  const trunkMats = new Map<THREE.Texture, THREE.MeshBasicMaterial>();
  const trunkMat = (tex: THREE.Texture) => {
    let m = trunkMats.get(tex);
    if (!m) {
      m = billboardMaterial(tex, TRUNK_PUSH);
      m.name = `tree trunk ${tex.name}`;
      trunkMats.set(tex, m);
    }
    return m;
  };
  for (const [key, g] of groups) {
    let mat = mats.get(g.tex);
    if (!mat) mats.set(g.tex, (mat = billboardMaterial(g.tex)));
    mat.name = `tree ${g.tex.name}`;
    // Крона — від частки висоти до верху; стовбур — смужка кори від землі до середини (видно крізь крону).
    const parts = [planeGeometry(g.width, g.u0, g.uw, g.crown, 1, g.split)];
    if (g.trunk) parts.push(planeGeometry(TRUNK_W, g.u0 + BARK_U0, BARK_UW, 0, TRUNK_TOP, g.split));
    // Погойдування — спільне для крони й стовбура дерева.
    const swayAttr = new THREE.InstancedBufferAttribute(new Float32Array(g.list.length * 2), 2);
    swayAttr.setUsage(THREE.DynamicDrawUsage);
    const st = new Float32Array(g.list.length * 7);
    g.list.forEach((t, i) => (st[i * 7] = t.r / 3));
    sways.push(new TreeSway(st, swayAttr));
    for (const [pi, geo] of parts.entries()) {
      geo.setAttribute('sway', swayAttr);
      const mesh = new THREE.InstancedMesh(geo, pi ? trunkMat(g.tex) : mat, g.list.length);
      mesh.name = `trees ${key}${pi ? ' trunk' : ''}`;
      g.list.forEach((s, i) => {
        // Центр сфери генератора — на рівні землі (z ≈ дорога поруч): основа — центр, висота — радіус (користувач:
        // до висоти претензій немає).
        const h = s.r;
        m.compose(new THREE.Vector3(s.x, s.y, s.z), q, new THREE.Vector3(h, h, h));
        mesh.setMatrixAt(i, m);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      // Білборд виходить за межі геометрії в локальній площині — сфера з запасом.
      if (mesh.boundingSphere) mesh.boundingSphere.radius += 50;
      group.add(mesh);
    }
  }
  group.userData.sway = { update: (dt: number, wind: number) => sways.forEach((s) => s.update(dt, wind)) } satisfies Pick<TreeSway, 'update'>;
  return group;
}

/**
 * Ореоли ліхтарів — генератор `$$DynamicGlow` (блок 40): центр і радіус сфери; світіння — білборд з текстурою
 * `glow*.txr` регіону, додається до кадру (адитивно). Показуються в сутінках і вночі (Ht2World.setNight).
 * Розмір — 0,6 радіуса сфери (на око; поля `values` генератора — 75, 275, 0,75, 5,5… — не розібрано).
 */
export function buildGlows(b3d: B3d, rmp: RmpArchive): THREE.Group {
  const group = new THREE.Group();
  group.name = 'glows';
  group.visible = false;
  const file = rmp.order.TEXTUREFILES.find((n) => /glow[^/]*\.txr$/i.test(n));
  const bytes = file ? rmp.textures.get(file) : undefined;
  if (!bytes) return group;
  const img = parseTxr(bytes);
  const tex = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  for (const [blk] of walk(b3d.blocks)) {
    const d = blk.data;
    if (d.t !== 40 || d.name2 !== '$$DynamicGlow') continue;
    const [x, y, z, r] = d.bound;
    const s = new THREE.Sprite(mat);
    s.position.set(x, y, z);
    s.scale.setScalar(Math.max(1.5, r * 0.6));
    group.add(s);
  }
  return group;
}
