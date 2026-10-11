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

/** Полігони за матеріалом; ord — порядковий номер полігона в даних для кожного трикутника. */
type Batches = Map<number, { pos: number[]; uv: number[]; ord: number[]; layer?: number[] }>;

/**
 * Шари в одній площині (фасад тунелю на суцільній стіні лісу): оригінал малює полігони по черзі й пізніший
 * перекриває ранішній; з буфером глибини вони мерехтять. Пізніший трикутник, що справді перекривається з
 * ранішнім у тій самій площині й з того самого боку, малюємо зі зсувом глибини (polygonOffset) на шар за кожен
 * шар під ним. Раніше його зсували геометрично на 4 см до глядача — біля краю висунутої панелі відкривалась щілина
 * (світла смуга під плакатами в залі запчастин бази). Лише текстуровані: однотонні (розмітка) у даних ідуть
 * раніше за асфальт, а малюються поверх — для них зсув глибини матеріалу.
 */
const LAYER_OFFSET_FACTOR = -1;
/** Розніс площин у даних (м), від якого порядок шарів визначає положення, а не черговість полігонів. */
const DATA_LAYER_GAP = 0.004;
const LAYER_OFFSET_UNITS = -4;

export class MaterialLibrary {
  private readonly cache = new Map<number, THREE.Material>();
  private readonly texCache = new Map<string, THREE.Texture | null>();
  private readonly rmpByName = new Map<string, Material>();
  readonly palette: Uint8Array | null;
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
    // Однобічні полігони, як в оригіналі: дані мають явні зворотні копії там, де видно обидва боки (дерева —
    // 308 з 362 трикутників, знаки), а стіни лісу на межах кімнат — пари в одній площині, повернуті в різні боки
    // (кожна видна лише зі своєї кімнати; двобічні — мерехтіли одна крізь одну).
    const params: THREE.MeshBasicMaterialParameters = { side: THREE.FrontSide };
    if (def && def.tex > 0) {
      const tex = this.texture(def.tex, def.flags.has('notile'), def.transparentTex);
      if (tex) {
        params.map = tex;
        if (def.transparentTex || (tex.userData.hasAlpha as boolean)) {
          params.alphaTest = 0.5;
          params.transparent = false;
        }
      } else params.color = 0xff00ff;
    } else if (def && def.col !== null && (this.palette || Number.isFinite(Number(this.rmp.colors[def.col - 1])))) {
      // col N — колір N-го запису палітри траси, рахуючи з 1 (palette[N − 1]): black col 1 = 0,0,0; white col 5 =
      // білий; red col 6 = 255,0,0; шини «*_black col 10» = 4,4,4 на всіх трасах. (Раніше брали palette[N] — шини
      // виходили кремові/сині; тоді перейшли на яскравість із COLORS — і червоні ліхтарі стали білими.)
      const c = def.col - 1;
      if (this.palette) {
        params.color = new THREE.Color().setRGB(
          this.palette[c * 3] / 255,
          this.palette[c * 3 + 1] / 255,
          this.palette[c * 3 + 2] / 255,
          THREE.SRGBColorSpace,
        );
      } else {
        const v = Number(this.rmp.colors[c]);
        params.color = new THREE.Color().setRGB(v, v, v, THREE.SRGBColorSpace);
      }
      // У світі однотонні полігони — переважно розмітка, що лежить на текстурованій дорозі в тій самій площині:
      // висуваємо трохи до камери, інакше далі розмітка «тоне» в асфальті. (У моделях вантажівок навпаки —
      // див. buildTruckModel.)
      params.polygonOffset = true;
      params.polygonOffsetFactor = -1;
      params.polygonOffsetUnits = -2;
    } else params.color = 0x808080;
    if (def?.params.transp) {
      params.transparent = true;
      params.opacity = 1 - def.params.transp[0];
      params.depthWrite = false;
    }
    mat = new THREE.MeshBasicMaterial(params);
    mat.name = name;
    // Опис матеріалу з архіву — для ефектів, що читають параметри (move, noz).
    mat.userData.def = def;
    this.cache.set(index, mat);
    return mat;
  }

  /**
   * Текстура з архіву. keyBlack — матеріал ttx: у 16-бітних текстурах оригіналу альфа-каналу немає,
   * прозорість задає чорний колір (знаки, дерева, диски коліс) — робимо його прозорим.
   */
  private texture(oneBased: number, clamp: boolean, keyBlack = false): THREE.Texture | null {
    const key = `${oneBased}/${clamp ? 'c' : 'r'}/${keyBlack ? 'k' : ''}`;
    if (this.texCache.has(key)) return this.texCache.get(key)!;
    const file = this.rmp.order.TEXTUREFILES[oneBased - 1];
    const bytes = file ? this.rmp.textures.get(file) : undefined;
    let tex: THREE.Texture | null = null;
    if (bytes) {
      try {
        const img = parseTxr(bytes);
        if (keyBlack && !img.hasAlpha) {
          const d = img.data;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] <= 12) d[i + 3] = 0;
          img.hasAlpha = true;
        }
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
/**
 * Вузол «поділ площиною» (тип 9): показує групу 0, якщо камера з додатного боку площини (n·p + d ≥ 0, система
 * вузла), інакше групу 1. Оновлюється рендерером щокадру (як THREE.LOD — через isLOD/update).
 */
// Перемикачі — від Object3D, не Group: рендерер Three.js викликає update(camera) для isLOD лише в об'єктів,
// що не є групами (для груп ця гілка пропускається) — інакше обидві гілки лишалися видимими.
export class SideSwitch extends THREE.Object3D {
  readonly isLOD = true;
  autoUpdate = true;
  readonly plane: THREE.Vector4;
  private static readonly tmp = new THREE.Vector3();

  constructor(plane: [number, number, number, number] = [0, 0, 1, 0]) {
    super();
    this.plane = new THREE.Vector4(...plane);
  }

  update(camera: THREE.Camera): void {
    const p = this.worldToLocal(camera.getWorldPosition(SideSwitch.tmp));
    // Група 0 — камера з боку нормалі (n·p + d ≥ 0), як у деревах колізій. Перевірено на відблисках задніх
    // ліхтарів: їх видно ззаду машини (нормаль площини ліхтаря дивиться назад).
    const front = this.plane.x * p.x + this.plane.y * p.y + this.plane.z * p.z + this.plane.w >= 0;
    if (this.children[0]) this.children[0].visible = front;
    if (this.children[1]) this.children[1].visible = !front;
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    this.plane.copy(source.plane);
    return this;
  }
}

/** Тип 10 (форма 1 — сфера [x, y, z, r]): група 0 — камера далі за r від центру, група 1 — ближче. */
export class DistanceSwitch extends THREE.Object3D {
  readonly isLOD = true;
  autoUpdate = true;
  readonly sphere: THREE.Vector4;
  private static readonly tmp = new THREE.Vector3();

  constructor(sphere: [number, number, number, number] = [0, 0, 0, 0]) {
    super();
    this.sphere = new THREE.Vector4(...sphere);
  }

  update(camera: THREE.Camera): void {
    const p = this.worldToLocal(camera.getWorldPosition(DistanceSwitch.tmp));
    // Група 0 — камера ДАЛІ за r, група 1 — ближче (перевірено: з протилежним вибором зникали дорога й машини).
    const near = Math.hypot(p.x - this.sphere.x, p.y - this.sphere.y, p.z - this.sphere.z) < this.sphere.w;
    if (this.children[0]) this.children[0].visible = !near;
    if (this.children[1]) this.children[1].visible = near;
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    this.sphere.copy(source.sphere);
    return this;
  }
}

export class SceneAssembler {
  readonly lib: MaterialLibrary;
  readonly stats = { rooms: 0, meshes: 0, triangles: 0, instances: 0, sprites: 0, layered: 0, missingTextures: 0 };
  private readonly topByName = new Map<string, Block>();
  /** Усі простори (24), включно з вкладеними, з композицією матриць батьків. */
  private readonly spaces = new Map<string, THREE.Matrix4>();
  private readonly templateCache = new Map<string, THREE.Group>();
  private readonly switchGroup: number;
  /** Перемикачі стану (тип 21) у кімнатах світу: імʼя → групи (видима лише одна). */
  readonly switches = new Map<string, THREE.Group[][]>();
  /** Куди реєструвати динамічні перемикачі при побудові (світ або окремий обʼєкт, напр. кабіна). */
  private switchTarget: Map<string, THREE.Group[][]> | null = null;
  /** Будуємо кімнати світу (а не модель): екземпляри з порожнім простором — привʼязка до спостерігача. */
  private buildingRooms = false;

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
  dynamicObject(
    name: string,
  ): { root: THREE.Group; setSwitch: (n: string, state: number) => void; names: string[]; states: (n: string) => number } | null {
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
      states: (n) => switches.get(n)?.[0]?.length ?? 0,
      setSwitch: (n, state) => {
        for (const objs of switches.get(n) ?? []) objs.forEach((o, i) => (o.visible = i === state));
      },
    };
  }

  /** Усі кімнати (тип 19) — геометрія світу. */
  buildRooms(): THREE.Group[] {
    const rooms: THREE.Group[] = [];
    this.switchTarget = this.switches;
    this.buildingRooms = true;
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
    this.buildingRooms = false;
    return rooms;
  }

  private polyOrder = 0;

  private flush(batches: Batches, into: THREE.Object3D): void {
    if (this.buildingRooms) this.stats.layered += separateLayers(
        [...batches].filter(([m]) => !!(this.lib.material(m) as THREE.MeshBasicMaterial).map).map(([, b]) => b),
      );
    for (const [matIndex, b] of batches) {
      if (!b.pos.length) continue;
      // Трикутники за шаром: шар 0 — звичайний матеріал, вищі — копія зі зсувом глибини.
      const byLayer = new Map<number, { pos: number[]; uv: number[] }>();
      if (!b.layer) byLayer.set(0, b);
      else
        for (let t = 0; t < b.pos.length / 9; t++) {
          const l = b.layer[t] ?? 0;
          let part = byLayer.get(l);
          if (!part) byLayer.set(l, (part = { pos: [], uv: [] }));
          part.pos.push(...b.pos.slice(t * 9, t * 9 + 9));
          part.uv.push(...b.uv.slice(t * 6, t * 6 + 6));
        }
      for (const [layer, part] of byLayer) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, layer ? this.layerMaterial(matIndex, layer) : this.lib.material(matIndex));
        mesh.matrixAutoUpdate = false;
        into.add(mesh);
        this.stats.meshes++;
        this.stats.triangles += part.pos.length / 9;
      }
    }
  }

  private readonly layerMaterials = new Map<string, THREE.Material>();

  /** Матеріал шару над стіною: та сама текстура, зсув глибини до глядача на layer кроків. */
  private layerMaterial(matIndex: number, layer: number): THREE.Material {
    const key = `${matIndex}/${layer}`;
    let m = this.layerMaterials.get(key);
    if (!m) {
      const src = this.lib.material(matIndex) as THREE.Material;
      m = src.clone();
      m.userData = src.userData; // clone() копіює userData через JSON — Set прапорців матеріалу пропадав би
      m.polygonOffset = true;
      m.polygonOffsetFactor = LAYER_OFFSET_FACTOR * layer;
      m.polygonOffsetUnits = LAYER_OFFSET_UNITS * layer;
      this.layerMaterials.set(key, m);
    }
    return m;
  }

  private addPolys(polys: Polygon[], vs: VertexSource, batches: Batches): void {
    for (const p of polys) {
      let b = batches.get(p.material);
      if (!b) batches.set(p.material, (b = { pos: [], uv: [], ord: [] }));
      const ord = this.polyOrder++;
      const idx = p.indices;
      for (let k = 1; k + 1 < idx.length; k++) {
        for (const corner of [0, k, k + 1]) {
          const vi = idx[corner];
          b.pos.push(vs.positions[vi * 3], vs.positions[vi * 3 + 1], vs.positions[vi * 3 + 2]);
          if (p.uvs) b.uv.push(p.uvs[corner * 2], p.uvs[corner * 2 + 1]);
          else b.uv.push(vs.uvs[vi * 2], vs.uvs[vi * 2 + 1]);
        }
        b.ord.push(ord);
      }
    }
  }

  /** Обходить піддерево, збираючи полігони в batches; посилання (18) додає як дочірні обʼєкти в `into`. */
  private visit(block: Block, vs: VertexSource | null, batches: Batches, into: THREE.Object3D, depth: number): void {
    if (depth > 64) return;
    // Фари й ліхтарі вантажівок (`<Prefix>FFaraL/R`, `<Prefix>BFaraL/R` — імена з TRUCK.TCH): білборди-відблиски
    // всередині мають центр (0, 0, 0) — ставимо їх у центр скла ліхтаря (вершини геометрії блоку). Гіпотеза: як
    // саме гра розміщує відблиски, у даних не записано.
    if (/[FB]Fara[LR]$/i.test(block.name)) {
      const prev = this.spriteOrigin;
      this.spriteOrigin = lampCenter(block, vs);
      try {
        this.visitInner(block, vs, batches, into, depth);
      } finally {
        this.spriteOrigin = prev;
      }
      return;
    }
    this.visitInner(block, vs, batches, into, depth);
  }

  /** Центр відблисків поточного ліхтаря (див. visit). */
  private spriteOrigin: [number, number, number] | null = null;

  private visitInner(block: Block, vs: VertexSource | null, batches: Batches, into: THREE.Object3D, depth: number): void {
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
      case 28:
        this.addSprites(d.center, d.raw, into);
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
    if (d.t === 29 && block.groups.length >= 2) {
      // Рівні деталізації (вантажівки; HTruck.exe 0x44bf38, режим 1): гра обирає групу за розміром моделі на
      // екрані — сфера sphere2 (r ≈ 2,5 м) у пікселях екрана 640: < values[0] — не малювати, далі група i, де
      // values[i] ≤ розмір (група 2 — найдетальніша, 0 — найпростіша). Переводимо пікселі у відстань:
      // d = 2r · f / розмір (гіпотеза: розмір — діаметр; підібрано так, щоб зблизька в салоні була повна модель).
      const lod = new THREE.LOD();
      const v = Array.from(d.values);
      const r = d.sphere2?.[3] ?? 2.5;
      // Розмір — діаметр сфери; f — фокусна відстань у пікселях екрана висотою 480 при полі зору камери 60°.
      const f = 240 / Math.tan(Math.PI / 6);
      const dist = (px: number) => (2 * r * f) / Math.max(1, px);
      const n = block.groups.length;
      // Моделі прості (сотні полігонів) — показуємо найдетальнішу на будь-якій відстані (рішення користувача);
      // пороги оригіналу (dist) лишаємо для довідки.
      void dist;
      void v;
      const levels: [number, number][] = [[n - 1, 0]];
      for (const [gi, at] of levels) {
        const go = new THREE.Group();
        const b: Batches = new Map();
        for (const child of block.groups[gi] ?? []) this.visit(child, cur, b, go, depth + 1);
        this.flush(b, go);
        lod.addLevel(go, at);
      }
      into.add(lod);
      return;
    }
    if (d.t === 21) {
      // Перемикач стану: i1 — початковий стан. Виняток — купол неба, який рушій вмикає сам (група 1).
      const start = block.groups[d.i1] ?? [];
      const sky = block.name === 'SkyDomeKey';
      groups = [sky && !start.length ? (block.groups.find((g) => g.length) ?? []) : start];
    } else if (d.t === 9 && d.shape.kind === 5 && block.groups.length >= 2 && this.buildingRooms) {
      // У геометрії трас тип 9 — дерево поділу простору: обидві половини видимі (як було до перемикачів у
      // моделях); вибір за боком камери ховав частини траси — мерехтіння й «невидимі» стіни з колізією.
      groups = block.groups.slice(0, 2);
    } else if (d.t === 9 && d.shape.kind === 5 && block.groups.length >= 2) {
      // Вибір за боком площини: група 0 — камера там, де n·p + d ≥ 0, група 1 — з іншого боку (варіанти
      // геометрії, що збігаються в просторі; обидві разом — подвійні трикутники й мерехтіння).
      const sw = new SideSwitch(d.shape.v as [number, number, number, number]);
      for (const [gi, g] of block.groups.slice(0, 2).entries()) {
        const go = new THREE.Group();
        const b: Batches = new Map();
        for (const child of g) this.visit(child, cur, b, go, depth + 1);
        this.flush(b, go);
        go.visible = gi === 0;
        sw.add(go);
      }
      into.add(sw);
      return;
    } else if (d.t === 9) {
      groups = [block.groups[0] ?? []];
    } else if (d.t === 10 && d.shape.kind === 1 && block.groups.length >= 2 && !this.buildingRooms) {
      // Перемикач за відстанню: група 0 — камера далі за r від центру сфери, група 1 — ближче (LOD машин і
      // обʼєктів трас; з протилежним вибором зникали дорога й машини).
      const sw = new DistanceSwitch(d.shape.v as [number, number, number, number]);
      for (const [gi, g] of block.groups.slice(0, 2).entries()) {
        const go = new THREE.Group();
        const b: Batches = new Map();
        for (const child of g) this.visit(child, cur, b, go, depth + 1);
        this.flush(b, go);
        go.visible = gi === 0;
        sw.add(go);
      }
      into.add(sw);
      return;
    } else if (d.t === 10 || d.t === 11 || d.t === 22 || d.t === 29) {
      groups = [block.groups[Math.min(this.switchGroup, block.groups.length - 1)] ?? []];
    }
    for (const g of groups) for (const child of g) this.visit(child, cur, batches, into, depth + 1);
  }

  /**
   * Тип 28 — білборди, повернуті до камери (ореоли ліхтарів і фар, відблиски): u32 n, далі n полігонів —
   * u32 формат (2), f32, u32, u32 матеріал, u32 k, k × (x, y — зміщення кута в метрах у площині екрана; u, v).
   * Світяться — додаємо колір (адитивно), глибину не пишемо.
   */
  private addSprites(center: [number, number, number], raw: Uint8Array, into: THREE.Object3D): void {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    let o = 0;
    const n = dv.getUint32(o, true);
    o += 4;
    for (let p = 0; p < n && o + 20 <= raw.byteLength; p++) {
      const material = dv.getUint32(o + 12, true);
      const k = dv.getUint32(o + 16, true);
      o += 20;
      if (o + k * 16 > raw.byteLength) return;
      const pts: [number, number, number, number][] = [];
      for (let i = 0; i < k; i++, o += 16) pts.push([0, 4, 8, 12].map((j) => dv.getFloat32(o + j, true)) as [number, number, number, number]);
      if (k < 3) continue;
      const sprite = this.sprite(material, pts);
      if (!sprite) continue;
      // Біля ліхтаря центр у даних — нуль або малий зсув (Renault: ±0,1 м) відносно скла.
      const lamp = this.spriteOrigin;
      const near = Math.hypot(...center) < 0.5;
      if (lamp && near) sprite.position.set(lamp[0] + center[0], lamp[1] + center[1], lamp[2] + center[2]);
      else sprite.position.set(...center);
      into.add(sprite);
    }
  }

  private sprite(material: number, pts: [number, number, number, number][]): THREE.Sprite | null {
    const base = this.lib.material(material) as THREE.MeshBasicMaterial;
    if (!base.map) return null;
    const xs = pts.map((q) => q[0]);
    const ys = pts.map((q) => q[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4) return null;
    // UV у кутах прямокутника — з найближчих вершин (у даних кути завжди осьові).
    const uvAt = (x: number, y: number) => {
      let best = pts[0];
      for (const q of pts) if (Math.hypot(q[0] - x, q[1] - y) < Math.hypot(best[0] - x, best[1] - y)) best = q;
      return [best[2], best[3]];
    };
    // UV кутів прямокутника: у даних текстура буває повернута на 90° (відблиски фар: u іде вздовж висоти),
    // тож задаємо повне афінне перетворення UV спрайта (s, t ∈ 0…1) → UV текстури.
    const [ubl, vbl] = uvAt(x0, y0);
    const [ubr, vbr] = uvAt(x1, y0);
    const [utl, vtl] = uvAt(x0, y1);
    const key = `${material}|${ubl},${vbl},${ubr},${vbr},${utl},${vtl}`;
    let mat = this.spriteMats.get(key);
    if (!mat) {
      const map = base.map.clone();
      map.matrixAutoUpdate = false;
      map.matrix.set(ubr - ubl, utl - ubl, ubl, vbr - vbl, vtl - vbl, vbl, 0, 0, 1);
      map.needsUpdate = true;
      mat = new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
      this.spriteMats.set(key, mat);
    }
    const s = new THREE.Sprite(mat);
    s.center.set(-x0 / (x1 - x0), -y0 / (y1 - y0));
    s.scale.set(x1 - x0, y1 - y0, 1);
    this.stats.sprites++;
    return s;
  }

  private readonly spriteMats = new Map<string, THREE.SpriteMaterial>();

  private addInstance(spaceName: string, objectName: string, into: THREE.Object3D): void {
    // Порожній простір: у моделях (вантажівки) — система координат батька (деталі кабіни, колеса);
    // у кімнатах — привʼязка до спостерігача (сонце, лінзи) — поки не відтворюємо.
    if (!spaceName && this.buildingRooms) return;
    const m = spaceName ? this.space(spaceName) : new THREE.Matrix4();
    if (this.switchTarget && !this.buildingRooms) {
      // Окремий екземпляр (кабіна, машина гравця): вкладені обʼєкти будуємо наново, щоб їхні перемикачі
      // (скло з краплями GlassKey, фари) теж керувалися грою.
      const blk = this.topByName.get(objectName.toLowerCase());
      if (!m || !blk) return;
      const g = new THREE.Group();
      g.name = blk.name;
      const b: Batches = new Map();
      this.visit(blk, null, b, g, 0);
      this.flush(b, g);
      g.matrixAutoUpdate = false;
      g.matrix.copy(m);
      into.add(g);
      this.stats.instances++;
      return;
    }
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
    // Купол видно зсередини.
    m.side = THREE.DoubleSide;
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

/**
 * Центр скла ліхтаря: вершини, на які посилаються полігони (8/35) усередині блоку. Вершини беремо з власних
 * блоків 7/37 або — як у Renault — з батьківського джерела вершин vs.
 */
function lampCenter(top: Block, vs: VertexSource | null): [number, number, number] | null {
  let n = 0;
  const sum = [0, 0, 0];
  const add = (p: ArrayLike<number>, i: number) => {
    sum[0] += p[i * 3];
    sum[1] += p[i * 3 + 1];
    sum[2] += p[i * 3 + 2];
    n++;
  };
  const visit = (b: Block, src: VertexSource | null): void => {
    const d = b.data;
    let cur = src;
    if ((d.t === 7 || d.t === 37) && d.positions) cur = { positions: d.positions, uvs: d.uvs };
    if ((d.t === 8 || d.t === 35) && cur) {
      const used = new Set<number>();
      for (const poly of d.polys) for (const i of poly.indices) used.add(i);
      for (const i of used) if (i * 3 + 2 < cur.positions.length) add(cur.positions, i);
    }
    for (const g of b.groups ?? []) for (const c of g) visit(c, cur);
  };
  visit(top, vs);
  return n ? [sum[0] / n, sum[1] / n, sum[2] / n] : null;
}

/** Шари в одній площині (див. LAYER_OFFSET_*): номер шару трикутника — у b.layer. Повертає кількість трикутників над шаром 0. */
function separateLayers(batches: { pos: number[]; ord: number[]; layer?: number[] }[]): number {
  interface Tri { b: { pos: number[]; layer?: number[] }; at: number; ord: number; n: THREE.Vector3; d: number; pts: THREE.Vector3[]; layer: number }
  const groups = new Map<string, Tri[]>();
  for (const b of batches) {
    for (let t = 0; t < b.ord.length; t++) {
      const at = t * 9;
      const pts = [0, 1, 2].map((k) => new THREE.Vector3(b.pos[at + k * 3], b.pos[at + k * 3 + 1], b.pos[at + k * 3 + 2]));
      const n = new THREE.Vector3().subVectors(pts[1], pts[0]).cross(new THREE.Vector3().subVectors(pts[2], pts[0]));
      if (n.lengthSq() < 1e-6) continue;
      n.normalize();
      const d = n.dot(pts[0]);
      // Кошик площини (грубо; сусідні кошики теж перевіряються через допуски нижче — тут достатньо одного).
      const key = `${Math.round(n.x * 20)},${Math.round(n.y * 20)},${Math.round(n.z * 20)},${Math.round(d * 2)}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = []));
      g.push({ b, at, ord: b.ord[t], n, d, pts, layer: 0 });
    }
  }
  let moved = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    // Порядок шарів: спершу — розташування в даних уздовж нормалі (автори часто вже кладуть напис на 1 см перед
    // дошкою: він має бути зверху, хоч у файлі йде раніше — інакше дошка перекривала його здалеку); у точно спільній
    // площині (до DATA_LAYER_GAP) — порядок полігонів у даних (пізніший — зверху).
    g.sort((a, c) => Math.round(a.d / DATA_LAYER_GAP) - Math.round(c.d / DATA_LAYER_GAP) || a.ord - c.ord);
    for (let i = 1; i < g.length; i++) {
      const top = g[i];
      for (let j = 0; j < i; j++) {
        const low = g[j];
        if (low.ord === top.ord || top.n.dot(low.n) < 0.999 || Math.abs(top.d - low.d) > 0.05) continue;
        if (overlapInPlane(top.pts, low.pts, top.n)) top.layer = Math.max(top.layer, low.layer + 1);
      }
      if (!top.layer) continue;
      (top.b.layer ??= [])[top.at / 9] = top.layer;
      moved++;
    }
  }
  return moved;
}

/** Чи перекриваються два трикутники в спільній площині (а не лише торкаються краєм) — тест розділювальних осей. */
function overlapInPlane(a: THREE.Vector3[], b: THREE.Vector3[], n: THREE.Vector3): boolean {
  const EPS = 0.02;
  for (const tri of [a, b]) {
    for (let k = 0; k < 3; k++) {
      const axis = new THREE.Vector3().subVectors(tri[(k + 1) % 3], tri[k]).cross(n);
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const p of a) { const v = axis.dot(p); a0 = Math.min(a0, v); a1 = Math.max(a1, v); }
      for (const p of b) { const v = axis.dot(p); b0 = Math.min(b0, v); b1 = Math.max(b1, v); }
      const len = axis.length();
      if (Math.min(a1, b1) - Math.max(a0, b0) <= EPS * len) return false;
    }
  }
  return true;
}
