import * as THREE from 'three';
import { walk, type B3d, type Block } from '../engine/formats/b3d';
import type { RmpArchive } from '../engine/formats/rmp';
import { parseTxr } from '../engine/formats/txr';

/**
 * Дерева Дальнобойщиків 2 — генератор `$$TreeGenerator1` (блок 40): центр і радіус обмежувальної сфери, `i1`.
 * Поведінка — за king.exe (re/notes/ht2/trees.md): біти `i1` 4–7 — вид N (атлас `tree<2⌊N/2⌋><2⌊N/2⌋+1>`), 8–11 —
 * форма (0…6), біт 0 — шар гілок зблизька (`tree<N>`, buildBranches), біт 1 — тінь.
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
  /** Шар гілок зблизька (біт 0 i1). */
  branches: boolean;
  /** Форма (біти 8–11 i1). */
  shape: number;
  /** Кімната (блок 19), у якій генератор; '' — поза кімнатами. */
  room: string;
}

/** Блоки файлу з іменем кімнати (блок 19 верхнього рівня), у якій кожен лежить; '' — поза кімнатами. */
export function* walkRooms(b3d: B3d): Generator<[Block, string]> {
  for (const top of b3d.blocks) {
    const room = top.data.t === 19 ? top.name : '';
    for (const [blk] of walk([top])) yield [blk, room];
  }
}

export function collectTrees(b3d: B3d): TreeSpot[] {
  const out: TreeSpot[] = [];
  for (const [blk, room] of walkRooms(b3d)) {
    const d = blk.data;
    if (d.t !== 40 || d.name2 !== '$$TreeGenerator1') continue;
    const [x, y, z, r] = d.bound;
    if (r <= 0) continue;
    out.push({ x, y, z, r, kind: (d.i1 >> 4) & 15, branches: (d.i1 & 1) !== 0, shape: (d.i1 >> 8) & 15, room });
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
/** Згасання основи ребром (синус кута між променем і площиною): нижче EDGE_HIDE — не видно, вище EDGE_SHOW — повністю. */
const EDGE_HIDE = 0.1;
const EDGE_SHOW = 0.3;

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
 * Згасання ребром (не з king.exe — власне, на прохання користувача): згори площину видно майже ребром, і перспектива
 * тягне її в довгу смугу через дороги (re/notes/ht2/trees.md); де промінь до вершини йде під площину під синусом кута
 * менше EDGE_SHOW, альфа спадає до 0 на EDGE_HIDE (з alphaTest 0,5 — зникає частина площини, видима надто косо).
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
      gl_Position = projectionMatrix * mvPosition;
      vec3 bbN = cross(bbR, normalize(bbUp));
      bbFade = smoothstep(${EDGE_HIDE.toFixed(2)}, ${EDGE_SHOW.toFixed(2)}, abs(dot(normalize(mvPosition.xyz), bbN)));`,
    );
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float bbFade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 treeLight;\nvarying float bbFade;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * treeLight, opacity );')
      .replace('#include <alphatest_fragment>', 'diffuseColor.a *= bbFade;\n#include <alphatest_fragment>');
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
  const groups = new Map<string, { tex: THREE.Texture; u0: number; uw: number; width: number; crown: number; split: number; trunk: boolean; room: string; list: TreeSpot[] }>();
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
    // Окремо по кімнатах: кімнату, якої не видно крізь портали, ховають разом з її деревами (world/roomVisibility.ts),
    // і менша сфера інстансів відсікається полем зору й туманом.
    const key = `${s.room}:${s.kind >> 1}:${half}:${width}:${crown}:${split}`;
    let g = groups.get(key);
    // Краї крони — на пів текселя всередину: лінійна фільтрація на u = 0,5 брала навпіл колонку 127 — суцільну
    // смужку кори лівої половини (без кольору прозорості), альфа ≈ 0,5 на порозі alphaTest давала пунктирні
    // вертикальні лінії по боках дерев (знімки користувача).
    const inset = 0.5 / ((tex.image as { width: number }).width || 256);
    if (!g) groups.set(key, (g = { tex, u0: (half === 2 ? 0 : half * 0.5) + inset, uw: (half === 2 ? 0.95 : 0.45) - 2 * inset, width, crown, split, trunk, room: s.room, list: [] }));
    g.list.push(s);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sways: TreeSway[] = [];
  const branchSpots: BranchSpot[] = [];
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
    g.list.forEach((t, i) => {
      st[i * 7] = t.r / 3;
      if (t.branches) branchSpots.push({ spot: t, sway: swayAttr.array as Float32Array, index: i });
    });
    sways.push(new TreeSway(st, swayAttr));
    for (const [pi, geo] of parts.entries()) {
      geo.setAttribute('sway', swayAttr);
      const mesh = new THREE.InstancedMesh(geo, pi ? trunkMat(g.tex) : mat, g.list.length);
      mesh.name = `trees ${key}${pi ? ' trunk' : ''}`;
      mesh.userData.room = g.room;
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
  const branches = buildBranches(branchSpots, rmp, palette);
  for (const b of branches.meshes) group.add(b);
  group.userData.sway = {
    update: (dt: number, wind: number, camera?: THREE.Vector3) => {
      sways.forEach((s) => s.update(dt, wind));
      if (camera) branches.update(group.worldToLocal(tmpCam.copy(camera)));
    },
  } satisfies TreeUpdate;
  return group;
}

/** Оновлення дерев регіону щокадру: погойдування; шар гілок — за положенням камери (світові координати). */
export interface TreeUpdate {
  update(dt: number, wind: number, camera?: THREE.Vector3): void;
}

const tmpCam = new THREE.Vector3();

/** Дерево з шаром гілок: його погойдування — у атрибуті `sway` групи основи (індекс index). */
interface BranchSpot {
  spot: TreeSpot;
  sway: Float32Array;
  index: number;
}

/**
 * Вісь шару гілок за формою (king.exe 0x005c8ae0, перший switch): початок і довжина — частки висоти дерева (радіуса
 * сфери). Вісь ділиться на три відрізки p0…p3 (погойдуються, як і основа).
 */
const BRANCH_AXIS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0.5, 2 / 3],
  [0.2083, 1.0417],
  [0.2167, 0.8333],
  [0, 0.9],
  [0.625, 0.625],
  [0.3125, 0.75],
];
/** Ділник розміру гілок (0x005c8ae0 → 0x005c6580): форми 0–2 — 2, решта — 1. */
const branchDiv = (shape: number) => (shape <= 2 ? 2 : 1);
/** Межа градієнта тіні гілок (0x005cbcb0, як основи 0x005c6ac0): форми 0, 1 — 0,2; 2–4 — 0,3; 5 — 0,5; 6 — 0,4. */
const BRANCH_SPLIT = [0.2, 0.2, 0.3, 0.3, 0.3, 0.5, 0.4];
/**
 * Кластери гілок (0x005ccb20): точка на осі (у відрізках p0…p3, 0…3) і множник розміру c. Розмір кластера
 * L = (довжина осі / 3) · c / ділник; кожен кластер на 0,5 м вище своєї точки (0x005cca60).
 */
const CLUSTERS_CONIFER: readonly (readonly [number, number])[] = [
  [2.2, 0.8],
  [1.85, 1.30625],
  [1.3, 1.5125],
  [0.65, 1.75625],
  [0.1, 1.9625],
];
const CLUSTERS_LEAFY: readonly (readonly [number, number])[] = [
  [2, 1.5125],
  [1.5, 1.85625],
  [1, 1.9625],
  [0.5, 2],
  [0, 2],
];
const clustersOf = (shape: number) => (shape === 3 || shape === 4 || shape === 6 ? CLUSTERS_LEAFY : CLUSTERS_CONIFER);
/**
 * Шкала відстаней шару гілок. В оригіналі (0x005c6580, лише сталі 0,01 і 0,25 — без dtl і xpyramid) гілок немає
 * далі 100 м, а ромби «виростають» між ≈ 92 і 28 м — зблизька це помітно. На прохання користувача порт розтягує
 * шкалу втричі: гілки з 300 м, ростуть між ≈ 275 і 85 м, де ромб завбільшки 1–3 м — кілька пікселів.
 */
const BRANCH_RANGE = 3;
const BRANCH_FAR = 100 * BRANCH_RANGE;

/** Рамка в рядковій нотації Direct3D (v' = v·R + t), як у king.exe. */
interface Frame {
  r: number[];
  t: [number, number, number];
}

function mulFrame(a: Frame, b: Frame): Frame {
  const r = new Array<number>(9);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) r[i * 3 + j] = a.r[i * 3] * b.r[j] + a.r[i * 3 + 1] * b.r[3 + j] + a.r[i * 3 + 2] * b.r[6 + j];
  const t: [number, number, number] = [0, 0, 0];
  for (let j = 0; j < 3; j++) t[j] = a.t[0] * b.r[j] + a.t[1] * b.r[3 + j] + a.t[2] * b.r[6 + j] + b.t[j];
  return { r, t };
}

const rotY = (a: number): Frame => ({ r: [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)], t: [0, 0, 0] });
const rotZ = (a: number): Frame => ({ r: [Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a), 0, 0, 0, 1], t: [0, 0, 0] });
const IDENTITY: Frame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };

/**
 * Скелет гілок (king.exe 0x005cc930, 0x005cba00, 0x005cc6b0) — спільний для всіх дерев (один генератор на гру, вузли
 * створюються випадково один раз). Вузол: «сила» (корінь 1…1,5; нащадок — сила батька − 0…0,75; від'ємна — нащадків
 * немає) і випадкова частка кута 0…1. Рекурсія глибиною 4, на вузол дві гілки: рамка нащадка = поворот навколо z на
 * 45°, навколо y на ±(45° + 10° · частка) (у оригіналі частка ще колишеться ±0,1 · cos(час) — ±1°, у порту без цього),
 * зсув уздовж z на 0,95 довжини вузла (довжина кореня — 0,01 L: гілки практично з однієї точки). На кінцях — ромб
 * розміром 0,75 L (0x005cbcb0). Повертає рамки кінців для L = 1 (rand — як у MSVC, затравка 1 — гіпотеза: стан rand
 * оригіналу залежить від усієї гри).
 */
function branchLeaves(): Frame[] {
  let seed = 1;
  const rand = () => ((seed = (seed * 214013 + 2531011) >>> 0) >>> 16) & 0x7fff;
  interface Seg {
    power: number;
    frac: number;
    len: number;
    kids: (Seg | null)[];
  }
  const seg = (parent: Seg | null, len: number): Seg => {
    const frac = rand() * 3.0518509e-5;
    rand(); // +0x24 (0…0,1) — у квад не йде
    const power = parent ? parent.power - rand() * 3.0518509e-5 * 0.75 : rand() * 1.5259255e-5 + 1;
    return { power, frac, len, kids: [] };
  };
  const child = (s: Seg, i: number, len: number) => {
    if (s.power < 0) return null;
    return (s.kids[i] ??= seg(s, len));
  };
  const out: Frame[] = [];
  const deg = Math.PI / 180;
  const walk = (depth: number, frame: Frame, s: Seg | null) => {
    if (depth >= 4 || !s) {
      if (out.length < 100) out.push(frame);
      return;
    }
    const len = s.len * 0.95;
    const t: Frame = { r: IDENTITY.r, t: [0, 0, len] };
    const left = mulFrame(mulFrame(mulFrame(rotZ(45 * deg), rotY((45 + 10 * s.frac) * deg)), t), frame);
    walk(depth + 1, left, child(s, 0, len));
    const right = mulFrame(mulFrame(mulFrame(rotZ(45 * deg), rotY(-(45 + 10 * (1 - s.frac)) * deg)), t), frame);
    walk(depth + 1, right, child(s, 1, len));
  };
  walk(0, IDENTITY, seg(null, 0.01));
  return out;
}

let leavesCache: Frame[] | null = null;

/**
 * Геометрія шару гілок форми (одиниця — висота дерева): кластери з ромбів-квадів `tree<N>` у світових осях — не
 * повертаються до камери, тому дерево зблизька обʼємне. Атрибут `leaf` — початок ромба (x, y, z) і поріг появи w
 * (0x005c6580: n-й ромб дерева — (10 + n mod 20) / 30), `leafBase` — початок осі (від нього відстань до камери).
 */
function branchGeometry(shape: number): THREE.BufferGeometry {
  const leaves = (leavesCache ??= branchLeaves());
  const [start, len] = BRANCH_AXIS[shape] ?? BRANCH_AXIS[0];
  const split = BRANCH_SPLIT[shape] ?? 0.2;
  const pos: number[] = [];
  const uv: number[] = [];
  const col: number[] = [];
  const leaf: number[] = [];
  const index: number[] = [];
  const c = new THREE.Color();
  let n = 0;
  for (const [at, k] of clustersOf(shape)) {
    const size = ((len / 3) * k) / branchDiv(shape);
    const z0 = start + (at / 3) * len;
    for (const f of leaves) {
      if (n >= 100) break;
      const s = 0.75;
      // Ромб у площині xz рамки: основа, ліво, верх, право; uv — кути текстури (0x005cbcb0).
      const quad: [number, number, number, number][] = [
        [0, 0, 1, 0],
        [-0.5 * s, 0.5 * s, 0, 0],
        [0, s, 0, 1],
        [0.5 * s, 0.5 * s, 1, 1],
      ];
      const ox = f.t[0] * size, oy = f.t[1] * size, oz = z0 + f.t[2] * size;
      const v0 = pos.length / 3;
      for (const [x, z, u, v] of quad) {
        const px = ox + size * (x * f.r[0] + z * f.r[6]);
        const py = oy + size * (x * f.r[1] + z * f.r[7]);
        const pz = oz + size * (x * f.r[2] + z * f.r[8]);
        pos.push(px, py, pz);
        uv.push(u, v);
        const sh = treeShade(Math.min(1, Math.max(0, (pz - start) / len)), split);
        c.setRGB(sh, sh, sh, THREE.SRGBColorSpace);
        col.push(c.r, c.g, c.b);
        leaf.push(ox, oy, oz, (10 + (n % 20)) / 30);
      }
      index.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
      n++;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('leaf', new THREE.Float32BufferAttribute(leaf, 4));
  g.setIndex(index);
  g.userData.base = start;
  return g;
}

/**
 * Матеріал шару гілок: ромб росте від своєї основи з наближенням камери (масштаб (a − поріг) · 30, a = 1 − max(0,
 * d/100 − 0,25; у порту d — поділене на BRANCH_RANGE), далі BRANCH_FAR — нічого), піднятий на 0,5 м, зсув погойдування — як у основи (bend за висотою ромба).
 * Колір — як у основи: текстура × градієнт × TREE_LIGHT.
 */
function branchMaterial(map: THREE.Texture, base: number): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide, vertexColors: true });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.treeLight = TREE_LIGHT;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 sway;\nattribute vec4 leaf;').replace(
      '#include <project_vertex>',
      `mat4 lfM = modelViewMatrix * instanceMatrix;
      float lfD = length((lfM * vec4(0.0, 0.0, ${base.toFixed(4)}, 1.0)).xyz);
      float lfA = lfD > ${BRANCH_FAR.toFixed(1)} ? -1.0 : 1.0 - max(0.0, lfD * ${(0.01 / BRANCH_RANGE).toFixed(6)} - 0.25);
      float lfK = clamp((lfA - leaf.w) * 30.0, 0.0, 1.0);
      vec3 lfP = leaf.xyz + (transformed - leaf.xyz) * lfK;
      float bz = clamp(leaf.z, 0.0, 1.0);
      float bend = bz < 0.3333 ? bz * 0.5 : (bz < 0.6667 ? bz * 1.5 - 0.3333 : bz * 1.5 - 0.5);
      vec4 lfW = instanceMatrix * vec4(lfP, 1.0);
      lfW.xy += sway * bend;
      lfW.z += 0.5;
      vec4 mvPosition = modelViewMatrix * lfW;
      gl_Position = projectionMatrix * mvPosition;`,
    );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 treeLight;')
      .replace('vec4 diffuseColor = vec4( diffuse, opacity );', 'vec4 diffuseColor = vec4( diffuse * treeLight, opacity );');
  };
  mat.customProgramCacheKey = () => `ht2-tree-branches-${base.toFixed(4)}`;
  return mat;
}

/**
 * Шар гілок (біт 0 i1): меш інстансів на кімнату × вид × форму; щокадру в нього потрапляють лише дерева ближче
 * BRANCH_FAR від камери (решта гілок однаково не видно), з поточним погойдуванням.
 */
function buildBranches(spots: BranchSpot[], rmp: RmpArchive, palette: Uint8Array | null): { meshes: THREE.InstancedMesh[]; update(cam: THREE.Vector3): void } {
  const meshes: THREE.InstancedMesh[] = [];
  const lists = new Map<string, BranchSpot[]>();
  for (const b of spots) {
    const key = `${b.spot.room}:${b.spot.kind}:${b.spot.shape}`;
    let l = lists.get(key);
    if (!l) lists.set(key, (l = []));
    l.push(b);
  }
  const textures = new Map<number, THREE.Texture | null>();
  const geometries = new Map<number, THREE.BufferGeometry>();
  const materials = new Map<string, THREE.MeshBasicMaterial>();
  const sets: { mesh: THREE.InstancedMesh; list: BranchSpot[]; sway: THREE.InstancedBufferAttribute; base: number }[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  for (const [key, list] of lists) {
    const { kind, shape, room } = list[0].spot;
    if (!textures.has(kind)) textures.set(kind, atlasTexture(rmp, new RegExp(`(^|/)tree${kind}\\.txr$`, 'i'), palette));
    const tex = textures.get(kind);
    if (!tex) continue;
    let geo = geometries.get(shape);
    if (!geo) geometries.set(shape, (geo = branchGeometry(shape)));
    const base = geo.userData.base as number;
    const mk = `${kind}:${base}`;
    let mat = materials.get(mk);
    if (!mat) {
      materials.set(mk, (mat = branchMaterial(tex, base)));
      mat.name = `tree branches ${tex.name}`;
    }
    // Своя копія геометрії: атрибут інстансів `sway` у кожного меша свій.
    const g = geo.clone();
    const sway = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 2), 2);
    sway.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('sway', sway);
    const mesh = new THREE.InstancedMesh(g, mat, list.length);
    mesh.name = `tree branches ${key}`;
    mesh.userData.room = room;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    list.forEach((b, i) => mesh.setMatrixAt(i, m.compose(p.set(b.spot.x, b.spot.y, b.spot.z), q, s.setScalar(b.spot.r))));
    // Сфера — з усіх дерев (кількість інстансів далі змінюється щокадру).
    mesh.computeBoundingSphere();
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 50;
    mesh.count = 0;
    meshes.push(mesh);
    sets.push({ mesh, list, sway, base });
  }
  const update = (cam: THREE.Vector3) => {
    for (const { mesh, list, sway, base } of sets) {
      const arr = sway.array as Float32Array;
      let n = 0;
      for (const b of list) {
        const t = b.spot;
        const dx = t.x - cam.x, dy = t.y - cam.y, dz = t.z + base * t.r - cam.z;
        if (dx * dx + dy * dy + dz * dz > BRANCH_FAR * BRANCH_FAR) continue;
        mesh.setMatrixAt(n, m.compose(p.set(t.x, t.y, t.z), q, s.setScalar(t.r)));
        arr[n * 2] = b.sway[b.index * 2];
        arr[n * 2 + 1] = b.sway[b.index * 2 + 1];
        n++;
      }
      if (n === 0 && mesh.count === 0) continue;
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      sway.needsUpdate = true;
    }
  };
  return { meshes, update };
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
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  const mat = new THREE.SpriteMaterial({ map: tex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false });
  for (const [blk, room] of walkRooms(b3d)) {
    const d = blk.data;
    if (d.t !== 40 || d.name2 !== '$$DynamicGlow') continue;
    const [x, y, z, r] = d.bound;
    const s = new THREE.Sprite(mat);
    s.userData.room = room;
    // Імʼя `<РЕГ>Glow<nn>` — ореол гасне, коли ліхтар збито (world/objects.ts).
    s.name = blk.name;
    s.position.set(x, y, z);
    s.scale.setScalar(Math.max(1.5, r * 0.6));
    group.add(s);
  }
  return group;
}
