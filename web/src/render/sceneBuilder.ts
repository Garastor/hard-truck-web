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
  assembler: SceneAssembler;
  /** Купол неба (Background_object): ставити в позицію камери кожен кадр. */
  sky: THREE.Group | null;
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

/**
 * Збирач обʼєктів сцени: кімнати світу, шаблони верхнього рівня (вантажівки, колеса, анімовані обʼєкти),
 * простори (24). Геометрія шаблонів кешується; інстанси — клони з матрицею простору.
 */
export class SceneAssembler {
  readonly lib: MaterialLibrary;
  readonly stats = { rooms: 0, meshes: 0, triangles: 0, instances: 0, missingTextures: 0 };
  private readonly topByName = new Map<string, Block>();
  /** Усі простори (24), включно з вкладеними, з композицією матриць батьків. */
  private readonly spaces = new Map<string, THREE.Matrix4>();
  private readonly templateCache = new Map<string, THREE.Group>();
  private readonly switchGroup: number;
  /** Перемикачі стану (тип 21) у кімнатах світу: імʼя → групи (видима лише одна). */
  readonly switches = new Map<string, THREE.Group[][]>();
  /** Куди реєструвати динамічні перемикачі при побудові (світ або окремий обʼєкт, напр. кабіна). */
  private switchTarget: Map<string, THREE.Group[][]> | null = null;

  constructor(
    readonly b3d: B3d,
    rmp: RmpArchive,
    opts: BuildOptions = {},
  ) {
    this.switchGroup = opts.switchGroup ?? 0;
    this.lib = new MaterialLibrary(b3d, rmp);
    for (const b of b3d.blocks) if (b.name) this.topByName.set(b.name.toLowerCase(), b);
    const collect = (b: Block, parent: THREE.Matrix4) => {
      let m = parent;
      if (b.data.t === 24) {
        m = parent.clone().multiply(spaceMatrix(b));
        if (b.name) this.spaces.set(b.name.toLowerCase(), m);
      }
      if (b.groups) for (const g of b.groups) for (const c of g) collect(c, m);
    };
    for (const b of b3d.blocks) if (b.data.t === 24) collect(b, new THREE.Matrix4());
  }

  block(name: string): Block | undefined {
    return this.topByName.get(name.toLowerCase());
  }

  /** Матриця простору (блок 24, зокрема вкладеного) за імʼям, або null. */
  space(name: string): THREE.Matrix4 | null {
    return this.spaces.get(name.toLowerCase())?.clone() ?? null;
  }

  /** Встановлює стан перемикача (усі екземпляри з цим імʼям). */
  setSwitch(name: string, state: number): void {
    for (const objs of this.switches.get(name) ?? []) objs.forEach((o, i) => (o.visible = i === state));
  }

  /** Шаблон обʼєкта верхнього рівня (кешований; повертається спільний екземпляр — клонуйте для розміщення). */
  template(name: string): THREE.Group | null {
    const key = name.toLowerCase();
    if (this.templateCache.has(key)) return this.templateCache.get(key)!;
    const blk = this.topByName.get(key);
    if (!blk) return null;
    const grp = new THREE.Group();
    grp.name = blk.name;
    const batches: Batches = new Map();
    this.visit(blk, null, batches, grp, 0);
    this.flush(batches, grp);
    this.templateCache.set(key, grp);
    return grp;
  }

  /**
   * Окремий (не кешований) екземпляр обʼєкта з динамічними перемикачами (21) — напр. кабіна з табло.
   * Повертає групу і функцію встановлення стану перемикача за імʼям.
   */
  dynamicObject(name: string): { root: THREE.Group; setSwitch: (n: string, state: number) => void; names: string[] } | null {
    const blk = this.topByName.get(name.toLowerCase());
    if (!blk) return null;
    const switches = new Map<string, THREE.Group[][]>();
    const prev = this.switchTarget;
    this.switchTarget = switches;
    const root = new THREE.Group();
    root.name = blk.name;
    const batches: Batches = new Map();
    this.visit(blk, null, batches, root, 0);
    this.flush(batches, root);
    this.switchTarget = prev;
    return {
      root,
      names: [...switches.keys()],
      setSwitch: (n, state) => {
        for (const objs of switches.get(n) ?? []) objs.forEach((o, i) => (o.visible = i === state));
      },
    };
  }

  /** Усі кімнати (тип 19) — геометрія світу. */
  buildRooms(): THREE.Group[] {
    const rooms: THREE.Group[] = [];
    this.switchTarget = this.switches;
    for (const b of this.b3d.blocks) {
      if (b.data.t !== 19) continue;
      const grp = new THREE.Group();
      grp.name = b.name;
      const batches: Batches = new Map();
      this.visit(b, null, batches, grp, 0);
      this.flush(batches, grp);
      rooms.push(grp);
      this.stats.rooms++;
    }
    this.switchTarget = null;
    return rooms;
  }

  private flush(batches: Batches, into: THREE.Object3D): void {
    for (const [matIndex, b] of batches) {
      if (!b.pos.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, this.lib.material(matIndex));
      mesh.matrixAutoUpdate = false;
      into.add(mesh);
      this.stats.meshes++;
      this.stats.triangles += b.pos.length / 9;
    }
  }

  private addPolys(polys: Polygon[], vs: VertexSource, batches: Batches): void {
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
  private visit(block: Block, vs: VertexSource | null, batches: Batches, into: THREE.Object3D, depth: number): void {
    if (depth > 64) return;
    const d = block.data;
    let cur = vs;
    switch (d.t) {
      case 6:
      case 36: {
        // Вершини в локальному просторі name1 (напр. кермо в ZilRuleSpace): окрема група з матрицею простору.
        const m = d.name1 ? this.space(d.name1) : null;
        if (m) {
          const grp = new THREE.Group();
          grp.name = block.name;
          grp.matrixAutoUpdate = false;
          grp.matrix.copy(m);
          grp.userData.baseMatrix = m.clone();
          grp.userData.space = d.name1.toLowerCase();
          const b: Batches = new Map();
          const vsrc = { positions: d.positions, uvs: d.uvs };
          if (block.groups) for (const g of block.groups) for (const child of g) this.visit(child, vsrc, b, grp, depth + 1);
          this.flush(b, grp);
          into.add(grp);
          return;
        }
        cur = { positions: d.positions, uvs: d.uvs };
        break;
      }
      case 7:
      case 37:
        cur = { positions: d.positions, uvs: d.uvs };
        break;
      case 8:
      case 35:
        if (vs) this.addPolys(d.polys, vs, batches);
        return;
      case 18:
        this.addInstance(d.space, d.object, into);
        return;
      case 20:
      case 23:
      case 30:
      case 13:
        return; // логіка/колізії — не рендеримо
    }
    if (!block.groups) return;
    let groups = block.groups;
    if (d.t === 21 && this.switchTarget && block.name) {
      // Динамічний перемикач: кожна група — окремий обʼєкт, видимість змінює гра (світлофори тощо).
      const objs: THREE.Group[] = block.groups.map((g, gi) => {
        const go = new THREE.Group();
        go.name = `${block.name}#${gi}`;
        const b: Batches = new Map();
        for (const child of g) this.visit(child, cur, b, go, depth + 1);
        this.flush(b, go);
        go.visible = gi === d.i1;
        into.add(go);
        return go;
      });
      const list = this.switchTarget.get(block.name) ?? [];
      list.push(objs);
      this.switchTarget.set(block.name, list);
      return;
    }
    if (d.t === 21) {
      // Перемикач стану: i1 — початковий стан. Виняток — купол неба, який рушій вмикає сам (група 1).
      const start = block.groups[d.i1] ?? [];
      const sky = block.name === 'SkyDomeKey';
      groups = [sky && !start.length ? (block.groups.find((g) => g.length) ?? []) : start];
    } else if (d.t === 9 || d.t === 10 || d.t === 11 || d.t === 22 || d.t === 29) {
      groups = [block.groups[Math.min(this.switchGroup, block.groups.length - 1)] ?? []];
    }
    for (const g of groups) for (const child of g) this.visit(child, cur, batches, into, depth + 1);
  }

  private addInstance(spaceName: string, objectName: string, into: THREE.Object3D): void {
    if (!spaceName) return; // привʼязка до спостерігача (сонце, лінзи) — пізніше
    const m = this.space(spaceName);
    const tpl = this.template(objectName);
    if (!m || !tpl) return;
    const inst = tpl.clone();
    inst.matrixAutoUpdate = false;
    inst.matrix.copy(m);
    into.add(inst);
    this.stats.instances++;
  }

  dispose(): void {
    const geos = new Set<THREE.BufferGeometry>();
    for (const t of this.templateCache.values()) t.traverse((o) => o instanceof THREE.Mesh && geos.add(o.geometry));
    for (const g of geos) g.dispose();
    this.lib.dispose();
  }
}

export function buildScene(b3d: B3d, rmp: RmpArchive, opts: BuildOptions = {}): BuiltScene {
  const asm = new SceneAssembler(b3d, rmp, opts);
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  const rooms = asm.buildRooms();
  for (const r of rooms) root.add(r);
  root.updateMatrixWorld(true);
  const sky = buildSky(asm);
  asm.stats.missingTextures = asm.lib.missingTextures;
  return {
    root,
    rooms,
    stats: asm.stats,
    assembler: asm,
    sky,
    dispose() {
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      asm.dispose();
    },
  };
}

/** Небо: шаблон Background_object (купол noz_sky) без глибини й туману, малюється першим. */
function buildSky(asm: SceneAssembler): THREE.Group | null {
  const tpl = asm.template('Background_object');
  if (!tpl) return null;
  const inner = tpl.clone();
  inner.rotation.x = -Math.PI / 2;
  inner.matrixAutoUpdate = true;
  const sky = new THREE.Group();
  sky.name = 'sky';
  sky.add(inner);
  inner.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const m = (o.material as THREE.MeshBasicMaterial).clone();
    m.depthWrite = false;
    m.depthTest = false;
    m.fog = false;
    o.material = m;
    o.renderOrder = -1000;
    o.frustumCulled = false;
  });
  return sky;
}

/** Матриця з блоку 24: три осі + позиція (у системі гри). */
export function spaceMatrix(block: Block): THREE.Matrix4 {
  if (block.data.t !== 24) throw new Error('not a space');
  const [x, y, z] = block.data.matrix;
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...x), new THREE.Vector3(...y), new THREE.Vector3(...z));
  m.setPosition(...block.data.position);
  return m;
}
