import * as THREE from 'three';
import type { B3d, Block, Polygon } from '../formats/b3d';
import { parseMaterial, type Material, type RmpArchive } from '../formats/rmp';
import { parseTxr } from '../formats/txr';
import { parsePlm } from '../formats/plm';

/**
 * Перетворює B3D + RMP у граф Three.js.
 * Світ = блоки «кімнат» (тип 19) у світових координатах; анімовані/повторювані обʼєкти
 * вставляються посиланнями (тип 18: простір-24 + обʼєкт-шаблон верхнього рівня).
 * Система координат гри: Z угору → корінь повертаємо на −90° навколо X.
 */
export interface BuildOptions {
  /** Яку групу брати в перемикачах (LOD тощо). */
  switchGroup?: number;
}

export interface BuiltScene {
  root: THREE.Group;
  rooms: THREE.Group[];
  stats: { rooms: number; meshes: number; triangles: number; instances: number; missingTextures: number };
  dispose(): void;
}

interface VertexSource {
  positions: Float32Array;
  uvs: Float32Array;
}

type Batches = Map<number, { pos: number[]; uv: number[] }>;

export class MaterialLibrary {
  private readonly cache = new Map<number, THREE.Material>();
  private readonly texCache = new Map<number, THREE.Texture | null>();
  private readonly rmpByName = new Map<string, Material>();
  private readonly palette: Uint8Array | null;
  missingTextures = 0;

  constructor(
    private readonly b3d: B3d,
    private readonly rmp: RmpArchive,
  ) {
    for (const line of rmp.materials) {
      const m = parseMaterial(line);
      this.rmpByName.set(m.name.toLowerCase(), m);
    }
    const plm = [...rmp.palettes.values()][0];
    this.palette = plm ? parsePlm(plm).palette : null;
  }

  material(index: number): THREE.Material {
    let mat = this.cache.get(index);
    if (mat) return mat;
    const name = this.b3d.materials[index]?.toLowerCase() ?? '';
    const def = this.rmpByName.get(name) ?? (this.rmp.materials[index] ? parseMaterial(this.rmp.materials[index]) : null);
    const params: THREE.MeshBasicMaterialParameters = { side: THREE.DoubleSide };
    if (def && def.tex > 0) {
      const tex = this.texture(def.tex, def.flags.has('notile'));
      if (tex) {
        params.map = tex;
        if (def.transparentTex || (tex.userData.hasAlpha as boolean)) {
          params.alphaTest = 0.5;
          params.transparent = false;
        }
      } else params.color = 0xff00ff;
    } else if (def && def.col !== null && this.palette) {
      const c = def.col;
      params.color = new THREE.Color(this.palette[c * 3] / 255, this.palette[c * 3 + 1] / 255, this.palette[c * 3 + 2] / 255);
    } else params.color = 0x808080;
    if (def?.params.transp) {
      params.transparent = true;
      params.opacity = 1 - def.params.transp[0];
      params.depthWrite = false;
    }
    mat = new THREE.MeshBasicMaterial(params);
    mat.name = name;
    this.cache.set(index, mat);
    return mat;
  }

  private texture(oneBased: number, clamp: boolean): THREE.Texture | null {
    const key = oneBased * (clamp ? -1 : 1);
    if (this.texCache.has(key)) return this.texCache.get(key)!;
    const file = this.rmp.order.TEXTUREFILES[oneBased - 1];
    const bytes = file ? this.rmp.textures.get(file) : undefined;
    let tex: THREE.Texture | null = null;
    if (bytes) {
      try {
        const img = parseTxr(bytes);
        const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
        t.colorSpace = THREE.SRGBColorSpace;
        t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = 4;
        t.name = file;
        t.userData.hasAlpha = img.hasAlpha;
        t.needsUpdate = true;
        tex = t;
      } catch {
        tex = null;
      }
    }
    if (!tex) this.missingTextures++;
    this.texCache.set(key, tex);
    return tex;
  }

  dispose(): void {
    for (const m of this.cache.values()) m.dispose();
    for (const t of this.texCache.values()) t?.dispose();
  }
}

export function buildScene(b3d: B3d, rmp: RmpArchive, opts: BuildOptions = {}): BuiltScene {
  const switchGroup = opts.switchGroup ?? 0;
  const lib = new MaterialLibrary(b3d, rmp);
  const topByName = new Map<string, Block>();
  for (const b of b3d.blocks) if (b.name) topByName.set(b.name.toLowerCase(), b);

  const stats = { rooms: 0, meshes: 0, triangles: 0, instances: 0, missingTextures: 0 };
  const templateCache = new Map<string, THREE.Group>();

  function flush(batches: Batches, into: THREE.Object3D): void {
    for (const [matIndex, b] of batches) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, lib.material(matIndex));
      mesh.matrixAutoUpdate = false;
      into.add(mesh);
      stats.meshes++;
      stats.triangles += b.pos.length / 9;
    }
  }

  function addPolys(polys: Polygon[], vs: VertexSource, batches: Batches): void {
    for (const p of polys) {
      let b = batches.get(p.material);
      if (!b) batches.set(p.material, (b = { pos: [], uv: [] }));
      const idx = p.indices;
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const corner of [0, k, k + 1]) {
          const vi = idx[corner];
          b.pos.push(vs.positions[vi * 3], vs.positions[vi * 3 + 1], vs.positions[vi * 3 + 2]);
          if (p.uvs) b.uv.push(p.uvs[corner * 2], p.uvs[corner * 2 + 1]);
          else b.uv.push(vs.uvs[vi * 2], vs.uvs[vi * 2 + 1]);
        }
      }
    }
  }

  /** Обходить піддерево, збираючи полігони в batches; посилання (18) додає як дочірні обʼєкти в `into`. */
  function visit(block: Block, vs: VertexSource | null, batches: Batches, into: THREE.Object3D, depth: number): void {
    if (depth > 64) return;
    const d = block.data;
    let cur = vs;
    switch (d.t) {
      case 6:
      case 7:
      case 36:
      case 37:
        cur = { positions: d.positions, uvs: d.uvs };
        break;
      case 8:
      case 35:
        if (vs) addPolys(d.polys, vs, batches);
        return;
      case 18:
        addInstance(d.space, d.object, into);
        return;
      case 20:
      case 23:
      case 30:
      case 13:
        return; // логіка/колізії — не рендеримо
    }
    if (!block.groups) return;
    const isSwitch = d.t === 9 || d.t === 10 || d.t === 11 || d.t === 21 || d.t === 22 || d.t === 29;
    const groups = isSwitch ? [block.groups[Math.min(switchGroup, block.groups.length - 1)] ?? []] : block.groups;
    for (const g of groups) for (const child of g) visit(child, cur, batches, into, depth + 1);
  }

  function buildTemplate(name: string): THREE.Group | null {
    const key = name.toLowerCase();
    if (templateCache.has(key)) return templateCache.get(key)!;
    const blk = topByName.get(key);
    if (!blk) return null;
    const grp = new THREE.Group();
    grp.name = blk.name;
    const batches: Batches = new Map();
    visit(blk, null, batches, grp, 0);
    flush(batches, grp);
    templateCache.set(key, grp);
    return grp;
  }

  function addInstance(spaceName: string, objectName: string, into: THREE.Object3D): void {
    if (!spaceName) return; // привʼязка до спостерігача (сонце, лінзи) — пізніше
    const space = topByName.get(spaceName.toLowerCase());
    const tpl = buildTemplate(objectName);
    if (!space || space.data.t !== 24 || !tpl) return;
    const inst = tpl.clone();
    inst.matrixAutoUpdate = false;
    inst.matrix.copy(spaceMatrix(space));
    into.add(inst);
    stats.instances++;
  }

  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  const rooms: THREE.Group[] = [];
  for (const b of b3d.blocks) {
    if (b.data.t !== 19) continue;
    const grp = new THREE.Group();
    grp.name = b.name;
    const batches: Batches = new Map();
    visit(b, null, batches, grp, 0);
    flush(batches, grp);
    root.add(grp);
    rooms.push(grp);
    stats.rooms++;
  }
  root.updateMatrixWorld(true);
  stats.missingTextures = lib.missingTextures;

  return {
    root,
    rooms,
    stats,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      lib.dispose();
    },
  };
}

/** Матриця з блоку 24: три осі + позиція (у системі гри). */
export function spaceMatrix(block: Block): THREE.Matrix4 {
  if (block.data.t !== 24) throw new Error('not a space');
  const [x, y, z] = block.data.matrix;
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z));
  m.setPosition(...block.data.position);
  return m;
}
