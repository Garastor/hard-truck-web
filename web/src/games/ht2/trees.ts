import * as THREE from 'three';
import { walk, type B3d } from '../../formats/b3d';
import type { RmpArchive } from '../../formats/rmp';
import { parseTxr } from '../../formats/txr';

/**
 * Дерева Дальнобойщиків 2 — генератор `$$TreeGenerator1` (блок 40): центр і радіус обмежувальної сфери, `i1`.
 * Оригінал будує дерево процедурно (гілки випадкової довжини й кута, до 100 листків-квадів з текстур
 * `tree0…3*`), зображення дерева цілком — в атласах `tree01*` (ялина | береза) і `tree23*` (ще два види), по
 * 128×256 на дерево: саме дерево ≈ 115 px завширшки, справа — смужка кори.
 *
 * Порт малює кожне дерево двома перехрещеними квадами з атласу (так оригінал виглядає здалеку). Гіпотези:
 * вид — `i1 & 3` (0, 1 — tree01, 2, 3 — tree23); висота — діаметр сфери, основа — центр мінус радіус;
 * поворот — від позиції (випадковий, але сталий). Колір-ключ — запис 256 палітри common.plm (як у лісах).
 */
const TREE_W = 115 / 256;

interface TreeSpot {
  x: number;
  y: number;
  z: number;
  r: number;
  kind: number;
}

export function collectTrees(b3d: B3d): TreeSpot[] {
  const out: TreeSpot[] = [];
  for (const [blk] of walk(b3d.blocks)) {
    const d = blk.data;
    if (d.t !== 40 || d.name2 !== '$$TreeGenerator1') continue;
    const [x, y, z, r] = d.bound;
    if (r <= 0) continue;
    out.push({ x, y, z, r, kind: d.i1 & 3 });
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

/** Два перехрещені вертикальні квади висотою 1 (z угору), основа в нулі; u — половина атласу [u0, u0 + TREE_W]. */
function crossGeometry(u0: number): THREE.BufferGeometry {
  const w = TREE_W / 2; // півширина квада відносно висоти (дерево в атласі — 115 × 256 px)
  const pos: number[] = [];
  const uv: number[] = [];
  const nrm: number[] = [];
  const quad = (ax: number, ay: number) => {
    const corners: [number, number, number, number][] = [
      [-ax * w, -ay * w, 0, 0],
      [ax * w, ay * w, 0, 1],
      [ax * w, ay * w, 1, 1],
      [-ax * w, -ay * w, 1, 0],
    ];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const [x, y, z, s] = corners[i];
      pos.push(x, y, z);
      // Текстура: v = 0 — низ (TGA знизу вгору вже перевернуто парсером: рядок 0 — верх зображення).
      uv.push(u0 + s * TREE_W, 1 - z);
      nrm.push(0, 0, 1);
    }
  };
  quad(1, 0);
  quad(0, 1);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/** Група дерев регіону (система координат гри — додавати в корінь регіону). */
export function buildTrees(b3d: B3d, rmp: RmpArchive, palette: Uint8Array | null): THREE.Group {
  const group = new THREE.Group();
  group.name = 'trees';
  const spots = collectTrees(b3d);
  if (!spots.length) return group;
  const atlases = [atlasTexture(rmp, /tree01[^/]*\.txr$/i, palette), atlasTexture(rmp, /tree23[^/]*\.txr$/i, palette)];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const zAxis = new THREE.Vector3(0, 0, 1);
  for (let kind = 0; kind < 4; kind++) {
    const tex = atlases[kind >> 1];
    const list = spots.filter((s) => s.kind === kind);
    if (!tex || !list.length) continue;
    const mat = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide });
    mat.name = `tree${kind}`;
    const mesh = new THREE.InstancedMesh(crossGeometry((kind & 1) * 0.5), mat, list.length);
    list.forEach((s, i) => {
      const h = 2 * s.r;
      const angle = ((Math.sin(s.x * 12.9898 + s.y * 78.233) * 43758.5453) % 1) * Math.PI;
      q.setFromAxisAngle(zAxis, angle);
      m.compose(new THREE.Vector3(s.x, s.y, s.z - s.r), q, new THREE.Vector3(h, h, h));
      mesh.setMatrixAt(i, m);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}
