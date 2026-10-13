import * as THREE from 'three';
import { walk, type B3d } from '../../formats/b3d';
import type { RmpArchive } from '../../formats/rmp';
import { parseTxr } from '../../formats/txr';

/**
 * Дерева Дальнобойщиків 2 — генератор `$$TreeGenerator1` (блок 40): центр і радіус обмежувальної сфери, `i1`.
 * Поведінка — за king.exe (re/notes/ht2-trees.md): біти `i1` 4–7 — вид N (атлас `tree<2⌊N/2⌋><2⌊N/2⌋+1>`), 8–11 —
 * форма (0…6), біт 0 — шар гілок зблизька (`tree<N>`, ще не в порту), біт 1 — тінь.
 *
 * Основа — площина з атласу, що повертається до камери навколо осі стовбура (циліндричний білборд, як в оригіналі;
 * у порту — у вершинному шейдері). Форми 3 і 4 беруть увесь атлас (листяне дерево `tree23`, кущ `tree45`), площина
 * завширшки з висоту; решта — половину (`tree01`: дві ялини, вибір — за позицією), ширина — частина висоти
 * (форма 0 — ½, 2 — ⅔; 1, 5, 6 — гіпотеза ½). u — від краю половини, 0,45 її ширини (без смужки кори).
 * Висота — діаметр сфери, основа — центр мінус радіус (гіпотеза). Колір-ключ — запис 256 палітри common.plm.
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
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.name = file!;
  t.needsUpdate = true;
  return t;
}

/** Ширина площини (частка висоти) за формою; null — увесь атлас (форми 3, 4). */
function shapeWidth(shape: number): { width: number; full: boolean } {
  if (shape === 3 || shape === 4) return { width: 1, full: true };
  if (shape === 2) return { width: 1 / 1.5, full: false };
  return { width: 0.5, full: false };
}

/** Площина висотою 1 (z угору), основа в нулі, x — від −w/2 до w/2; u — [u0, u0 + uw]. */
function planeGeometry(width: number, u0: number, uw: number): THREE.BufferGeometry {
  const w = width / 2;
  const g = new THREE.BufferGeometry();
  // Рядок 0 текстури — верх зображення: v = 1 − z.
  g.setAttribute('position', new THREE.Float32BufferAttribute([-w, 0, 0, w, 0, 0, w, 0, 1, -w, 0, 0, w, 0, 1, -w, 0, 1], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([u0, 1, u0 + uw, 1, u0 + uw, 0, u0, 1, u0 + uw, 0, u0, 0], 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
  return g;
}

/**
 * Матеріал циліндричного білборда: вершина x — уздовж напрямку ⟂ осі стовбура (локальна z) і напрямку на камеру,
 * z — уздовж осі. Нормаль — вісь стовбура (освітлення як у перехрещених квадів раніше).
 */
function billboardMaterial(map: THREE.Texture): THREE.MeshLambertMaterial {
  const mat = new THREE.MeshLambertMaterial({ map, alphaTest: 0.5, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <project_vertex>',
      `mat4 bbM = modelViewMatrix * instanceMatrix;
      vec4 bbC = bbM * vec4(0.0, 0.0, 0.0, 1.0);
      vec3 bbUp = (bbM * vec4(0.0, 0.0, 1.0, 0.0)).xyz;
      float bbS = length((bbM * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      vec3 bbR = cross(normalize(bbUp), normalize(-bbC.xyz));
      bbR = length(bbR) > 1e-4 ? normalize(bbR) : normalize((bbM * vec4(1.0, 0.0, 0.0, 0.0)).xyz);
      vec4 mvPosition = vec4(bbC.xyz + bbR * transformed.x * bbS + bbUp * transformed.z, 1.0);
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  mat.customProgramCacheKey = () => 'ht2-tree-billboard';
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
  const groups = new Map<string, { tex: THREE.Texture; u0: number; uw: number; width: number; list: TreeSpot[] }>();
  for (const s of spots) {
    const tex = atlas(s.kind >> 1);
    if (!tex) continue;
    const { width, full } = shapeWidth(s.shape);
    // Половина атласу — за позицією (у грі — парність цілої частини координати; гіпотеза щодо якої).
    const half = full ? 2 : Math.floor(Math.abs(s.x)) & 1;
    const key = `${s.kind >> 1}:${half}:${width}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { tex, u0: half === 2 ? 0 : half * 0.5, uw: half === 2 ? 0.95 : 0.45, width, list: [] }));
    g.list.push(s);
  }
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const mats = new Map<THREE.Texture, THREE.MeshLambertMaterial>();
  for (const [key, g] of groups) {
    let mat = mats.get(g.tex);
    if (!mat) mats.set(g.tex, (mat = billboardMaterial(g.tex)));
    mat.name = `tree ${g.tex.name}`;
    const mesh = new THREE.InstancedMesh(planeGeometry(g.width, g.u0, g.uw), mat, g.list.length);
    mesh.name = `trees ${key}`;
    g.list.forEach((s, i) => {
      const h = 2 * s.r;
      m.compose(new THREE.Vector3(s.x, s.y, s.z - s.r), q, new THREE.Vector3(h, h, h));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    // Білборд виходить за межі геометрії в локальній площині — сфера з запасом.
    if (mesh.boundingSphere) mesh.boundingSphere.radius += 50;
    group.add(mesh);
  }
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
