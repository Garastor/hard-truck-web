import * as THREE from 'three';
import type { B3d, Block, Polygon } from '../formats/b3d';
import { parseMaterial, type Material, type RmpArchive } from '../formats/rmp';
import { parseTxr } from '../formats/txr';
import { parsePlm } from '../formats/plm';
import { noFarClip } from './farClip';
import { revealChild } from './visibleMatrices';

/**
 * Перетворює B3D + RMP у граф Three.js.
 * Світ = блоки «кімнат» (тип 19) у світових координатах; анімовані/повторювані обʼєкти
 * вставляються посиланнями (тип 18: простір-24 + обʼєкт-шаблон верхнього рівня).
 * Система координат гри: Z угору → корінь повертаємо на −90° навколо X.
 */
export interface BuildOptions {
  /** Яку групу брати в перемикачах (LOD тощо). */
  switchGroup?: number;
  /**
   * Освітлення (HT2): вершини типу 37 мають нормалі, рушій освітлює сцену сонцем і розсіяним світлом
   * (WEATHER.INI) — матеріали MeshLambert з нормалями. HT1 — без освітлення (текстури вже «засвічені»).
   */
  lit?: boolean;
  /** Звідки брати шаблони, яких немає в цьому файлі (HT2: регіон → COMMON.B3D зі своїми матеріалами). */
  fallback?: SceneAssembler;
  /**
   * Палітра для `col N`, якщо в архіві своєї немає (HT2: регіональні RES без палітри — common.plm з COMMON.RES).
   * У HT2 вона ж задає колір-ключ прозорості: матеріал `ttx T col N` — прозорі пікселі кольору палітри N
   * (ліси — col 256 = (50, 59, 18) → 565 0x31C2); `ttx` без col — чорні, як у HT1.
   */
  palette?: Uint8Array;
  /** HT2: колір-ключ прозорості ttx — з `col N` (див. palette). */
  colorKey?: boolean;
  /**
   * Перемикач за відстанню (10): яка група — «зблизька». HT1 — 1 (група 0 далі за r), HT2 — 0: і плитки рельєфу
   * (група 0 — детальна, 1 — 4 вершини), і деталі вантажівок (група 0 — модель, 1 — порожньо, рама й двигун
   * інакше зникали поруч з камерою).
   */
  nearGroup?: 0 | 1;
  /**
   * Множник радіуса перемикачів за відстанню (10). Оригінал — 1 (king.exe 0x5f88d0: відстань камери проти r без
   * множників); більше — детальні групи видно далі (машини HT2 — на прохання користувача, див. vehicles/trucks.ts).
   */
  lodScale?: number;
  /** HT2: блок 4 — деталі в просторі name1 (кабіни: кермо в ZilRuleSpace, стрілки в ZilSpeedSpace…). */
  type4Space?: boolean;
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
  normals?: Float32Array | null;
  /**
   * Вершини формату 3 (блок 36/37): замість нормалі — інтенсивність (у всіх файлах 1,0). king.exe малює такі
   * меші без освітлення: FVF без нормалі → 0x005b1020 ставить emissive і diffuse з кольору вершини (колір
   * матеріалу × інтенсивність, 0x005f0b10), ambient 0 — ліхтарі, фари, вікна, тіні машин світять рівно.
   */
  prelit?: boolean;
}

/**
 * Полігони за матеріалом; ord — порядковий номер полігона в даних для кожного трикутника; nrm — нормалі
 * (режим lit; null — у джерелі нормалей немає, рахуємо з геометрії).
 */
type Batch = { pos: number[]; uv: number[]; ord: number[]; layer?: number[]; nrm?: number[] | null };
/** Ключ — індекс матеріалу; ~індекс (від'ємний) — той самий матеріал без освітлення (VertexSource.prelit). */
type Batches = Map<number, Batch>;

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
/** Клітинка просторової сітки пошуку перекриттів шарів, м (лише прискорення — результат той самий). */
const LAYER_CELL = 4;
/** Сітку будуємо лише для площин з більшою кількістю трикутників (малі — простий перебір дешевший). */
const LAYER_GRID_FROM = 64;
const LAYER_OFFSET_UNITS = -4;

export class MaterialLibrary {
  private readonly cache = new Map<number, THREE.Material>();
  private readonly texCache = new Map<string, THREE.Texture | null>();
  private readonly rmpByName = new Map<string, Material>();
  readonly palette: Uint8Array | null;
  /** Колір-ключ прозорості з `col N` матеріалу ttx (HT2). */
  private readonly colorKey: boolean;
  missingTextures = 0;

  constructor(
    private readonly b3d: B3d,
    private readonly rmp: RmpArchive,
    private readonly lit = false,
    fallbackPalette: Uint8Array | null = null,
    colorKey = false,
  ) {
    for (const line of rmp.materials) {
      const m = parseMaterial(line);
      this.rmpByName.set(m.name.toLowerCase(), m);
    }
    const plm = [...rmp.palettes.values()][0];
    this.palette = plm ? parsePlm(plm).palette : fallbackPalette;
    this.colorKey = colorKey;
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
      const key = def.transparentTex ? (this.colorKey && def.col !== null && this.palette ? def.col : 0) : null;
      const tex = this.texture(def.tex, def.flags.has('notile'), key);
      if (tex) {
        params.map = tex;
        if (tex.userData.softAlpha) {
          // Direct3D змішує текстури з альфою (king.exe): тінь store_sh 16×16 — м'який перехід, а не поріг 0,5
          // (з порогом вздовж рампи бази лягала темна смуга). Кольоровий ключ (ttx) і майже двоколірні альфи (ліс,
          // наліпки) — з порогом, як було.
          params.transparent = true;
          params.depthWrite = false;
        } else if (def.transparentTex || (tex.userData.hasAlpha as boolean)) {
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
    const spec = def?.params.specular?.[0];
    if (this.lit && spec) {
      // Відблиск Direct3D (king.exe 0x005b1020: specular s, power p — кузови TRUCKS.RES «specular 1 power 42»):
      // + світло·s·(N·H)^p після множення на текстуру. Blinn-Phong three.js нормований (0,5p + 1)/4 — ділимо назад.
      const power = def.params.power?.[0] ?? 10;
      const k = (spec * 4) / (0.5 * power + 1);
      mat = new THREE.MeshPhongMaterial({ ...(params as THREE.MeshPhongMaterialParameters), specular: new THREE.Color(k, k, k), shininess: power });
    } else mat = this.lit ? new THREE.MeshLambertMaterial(params as THREE.MeshLambertMaterialParameters) : new THREE.MeshBasicMaterial(params);
    mat.name = name;
    // Опис матеріалу з архіву — для ефектів, що читають параметри (move, noz).
    mat.userData.def = def;
    // Рух текстури (move u v — річки, вода): своя копія текстури, зсув UV щосекунди робить світ (world.ts).
    const move = def?.params.move;
    const mm = mat as THREE.MeshBasicMaterial;
    if (move && mm.map) {
      mm.map = mm.map.clone();
      mm.userData.move = move;
    }
    this.cache.set(index, mat);
    return mat;
  }

  private readonly unlitCache = new Map<number, THREE.Material>();

  /**
   * Матеріал без освітлення (меші з вершинами формату 3, див. VertexSource.prelit): колір = текстура × колір
   * матеріалу, як emissive з кольору вершини в king.exe. Поза режимом lit — звичайний матеріал.
   */
  unlit(index: number): THREE.Material {
    const src = this.material(index) as THREE.MeshLambertMaterial;
    if (!this.lit) return src;
    let mat = this.unlitCache.get(index);
    if (mat) return mat;
    const m = new THREE.MeshBasicMaterial({
      map: src.map,
      color: src.color,
      side: src.side,
      transparent: src.transparent,
      opacity: src.opacity,
      depthWrite: src.depthWrite,
      alphaTest: src.alphaTest,
      polygonOffset: src.polygonOffset,
      polygonOffsetFactor: src.polygonOffsetFactor,
      polygonOffsetUnits: src.polygonOffsetUnits,
    });
    m.name = src.name;
    m.userData = { ...src.userData, unlit: true };
    // Рух текстури: своя копія, щоб світ не зсував спільну текстуру двічі за кадр.
    if (m.userData.move && m.map) m.map = m.map.clone();
    this.unlitCache.set(index, (mat = m));
    return mat;
  }

  /** Матеріал партії за ключем Batches (від'ємний — без освітлення). */
  forKey(key: number): THREE.Material {
    return key < 0 ? this.unlit(~key) : this.material(key);
  }

  /**
   * Текстура з архіву. keyBlack — матеріал ttx: у 16-бітних текстурах оригіналу альфа-каналу немає,
   * прозорість задає чорний колір (знаки, дерева, диски коліс) — робимо його прозорим.
   */
  private texture(oneBased: number, clamp: boolean, colorKey: number | null = null): THREE.Texture | null {
    const keyBlack = colorKey !== null;
    const key = `${oneBased}/${clamp ? 'c' : 'r'}/${keyBlack ? `k${colorKey}` : ''}`;
    if (this.texCache.has(key)) return this.texCache.get(key)!;
    const file = this.rmp.order.TEXTUREFILES[oneBased - 1];
    const bytes = file ? this.rmp.textures.get(file) : undefined;
    let tex: THREE.Texture | null = null;
    if (bytes) {
      try {
        const img = parseTxr(bytes);
        if (keyBlack && !img.hasAlpha) {
          const d = img.data;
          if (colorKey && this.palette) {
            // Колір палітри N, зведений до 565 (як пікселі текстури): порівнюємо в розрядності каналів 5-6-5.
            const c = (colorKey - 1) * 3;
            const kr = this.palette[c] >> 3, kg = this.palette[c + 1] >> 2, kb = this.palette[c + 2] >> 3;
            for (let i = 0; i < d.length; i += 4) if (d[i] >> 3 === kr && d[i + 1] >> 2 === kg && d[i + 2] >> 3 === kb) d[i + 3] = 0;
          } else {
            // Ключ Direct3D — точний збіг із чорним у 565, без допуску: цифри знаків обмеження швидкості
            // (zspl60 тощо) — темно-сині 0,4,8, з порогом «сума ≤ 12» вони ставали прозорими.
            for (let i = 0; i < d.length; i += 4) if (d[i] >> 3 === 0 && d[i + 1] >> 2 === 0 && d[i + 2] >> 3 === 0) d[i + 3] = 0;
          }
          img.hasAlpha = true;
        }
        const t = new THREE.DataTexture(img.data, img.width, img.height, THREE.RGBAFormat);
        // Без перетворення кольорового простору: світло — у кольорах екрана, як у Direct3D (app.ts runHt2).
        t.wrapS = t.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        // Без анізотропії, як king.exe (LINEAR без анізотропії, docs lighting.md §7): дешевше на телефоні, трава на
        // відстані мʼякша — як в оригіналі (було anisotropy = 4).
        t.name = file;
        t.userData.hasAlpha = img.hasAlpha;
        // Плавна альфа (тіні будівель store_sh, вода, річки, габарити): понад 15 % пікселів напівпрозорі.
        if (img.hasAlpha && !keyBlack) {
          let mid = 0;
          for (let i = 3; i < img.data.length; i += 4) if (img.data[i] > 8 && img.data[i] < 247) mid++;
          t.userData.softAlpha = mid / (img.data.length / 4) >= 0.15;
        }
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
    revealChild(this.children[0], front);
    revealChild(this.children[1], !front);
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    this.plane.copy(source.plane);
    return this;
  }
}

/**
 * Тип 10 (форма 1 — сфера [x, y, z, r]): HT1 — група 0, коли камера далі за r від центру, група 1 — ближче.
 * HT2 (king.exe 0x5f8f10 → 0x5f88d0): група 0, коли камера (переставлення оберненої model-view, 0x5ae580) не далі
 * за r у координатах моделі; r — без множника деталізації.
 */
export class DistanceSwitch extends THREE.Object3D {
  readonly isLOD = true;
  autoUpdate = true;
  readonly sphere: THREE.Vector4;
  /** Група «зблизька» (HT1 — 1, HT2 — 0; див. BuildOptions.nearGroup). */
  nearGroup: 0 | 1 = 1;
  private static readonly tmp = new THREE.Vector3();

  constructor(sphere: [number, number, number, number] = [0, 0, 0, 0], nearGroup: 0 | 1 = 1) {
    super();
    this.sphere = new THREE.Vector4(...sphere);
    this.nearGroup = nearGroup;
  }

  update(camera: THREE.Camera): void {
    const p = this.worldToLocal(camera.getWorldPosition(DistanceSwitch.tmp));
    // HT1: група 0 — камера ДАЛІ за r, група 1 — ближче (перевірено: з протилежним вибором зникали дорога й машини).
    const near = Math.hypot(p.x - this.sphere.x, p.y - this.sphere.y, p.z - this.sphere.z) < this.sphere.w;
    const n = this.nearGroup;
    revealChild(this.children[n], near);
    revealChild(this.children[1 - n], !near);
  }

  override copy(source: this, recursive?: boolean): this {
    super.copy(source, recursive);
    this.sphere.copy(source.sphere);
    this.nearGroup = source.nearGroup;
    return this;
  }
}

/**
 * Стани перемикачів (тип 21) за назвою блоку, що заміняють початковий i1 при збиранні: налаштування гри (HT2 —
 * `refer_GeometryKey` за повзунком «Детальность», ui/effects.ts). Діє на моделі, зібрані після зміни.
 */
const staticSwitches = new Map<string, number>();

export function setStaticSwitch(name: string, state: number): void {
  staticSwitches.set(name, state);
}

/** Початковий стан перемикача: з налаштування (не більше за кількість груп) чи i1. */
function switchInit(name: string | undefined, i1: number, groups: number): number {
  const s = name ? staticSwitches.get(name) : undefined;
  return s === undefined ? i1 : Math.min(s, groups - 1);
}

export class SceneAssembler {
  readonly lib: MaterialLibrary;
  readonly stats = { rooms: 0, meshes: 0, triangles: 0, instances: 0, sprites: 0, layered: 0, missingTextures: 0 };
  private readonly topByName = new Map<string, Block>();
  /** Усі простори (24), включно з вкладеними, з композицією матриць батьків. */
  private readonly spaces = new Map<string, THREE.Matrix4>();
  private readonly templateCache = new Map<string, THREE.Group>();
  /** Зразки dynamicObject (не віддаються назовні — лише їхні копії) з перемикачами. */
  private readonly dynamicProtos = new Map<string, { root: THREE.Group; switches: Map<string, THREE.Group[][]> }>();
  private readonly switchGroup: number;
  /** Перемикачі стану (тип 21) у кімнатах світу: імʼя → групи (видима лише одна). */
  readonly switches = new Map<string, THREE.Group[][]>();
  /** Куди реєструвати динамічні перемикачі при побудові (світ або окремий обʼєкт, напр. кабіна). */
  private switchTarget: Map<string, THREE.Group[][]> | null = null;
  /** Будуємо кімнати світу (а не модель): екземпляри з порожнім простором — привʼязка до спостерігача. */
  private buildingRooms = false;
  private readonly lit: boolean;
  private readonly nearGroup: 0 | 1;
  private readonly lodScale: number;
  private readonly type4Space: boolean;
  private readonly fallback: SceneAssembler | null;

  constructor(
    readonly b3d: B3d,
    rmp: RmpArchive,
    opts: BuildOptions = {},
  ) {
    this.switchGroup = opts.switchGroup ?? 0;
    this.lib = new MaterialLibrary(b3d, rmp, opts.lit, opts.palette ?? null, opts.colorKey);
    this.lit = opts.lit ?? false;
    this.nearGroup = opts.nearGroup ?? 1;
    this.lodScale = opts.lodScale ?? 1;
    this.type4Space = opts.type4Space ?? false;
    this.fallback = opts.fallback ?? null;
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
    return this.spaces.get(name.toLowerCase())?.clone() ?? this.fallback?.space(name) ?? null;
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
    if (!blk) return this.fallback?.template(name) ?? null;
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
    const key = name.toLowerCase();
    let proto = this.dynamicProtos.get(key);
    if (!proto) {
      const blk = this.topByName.get(key);
      if (!blk) return null;
      const sw = new Map<string, THREE.Group[][]>();
      const prev = this.switchTarget;
      this.switchTarget = sw;
      const grp = new THREE.Group();
      grp.name = blk.name;
      const batches: Batches = new Map();
      this.visit(blk, null, batches, grp, 0);
      this.flush(batches, grp);
      this.switchTarget = prev;
      proto = { root: grp, switches: sw };
      this.dynamicProtos.set(key, proto);
    }
    // Екземпляр — копія збереженого зразка (геометрія й матеріали спільні, вузли свої): збирання з B3D щоразу
    // коштувало 25…45 мс на ПК (фізична машина трафіку, що зʼявляється біля гравця, — ривок). Перемикачі — на вузли
    // копії; userData — свій для кожного вузла (стандартна копія Three.js пропускає його через JSON — матриці
    // baseMatrix ставали звичайними обʼєктами).
    const src: THREE.Object3D[] = [];
    proto.root.traverse((o) => src.push(o));
    const root = proto.root.clone(true);
    const map = new Map<THREE.Object3D, THREE.Object3D>();
    let i = 0;
    root.traverse((o) => {
      const s = src[i++];
      map.set(s, o);
      o.userData = { ...s.userData };
    });
    const switches = new Map<string, THREE.Group[][]>();
    for (const [n, sets] of proto.switches) switches.set(n, sets.map((objs) => objs.map((o) => map.get(o) as THREE.Group)));
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
    for (const b of this.b3d.blocks) if (b.data.t === 19) rooms.push(this.buildRoom(b));
    return rooms;
  }

  /** Кімнати по черзі; щойно минуло budgetMs — pause() (віддати кадр). */
  async buildRoomsAsync(pause: () => Promise<void>, budgetMs: number): Promise<THREE.Group[]> {
    const rooms: THREE.Group[] = [];
    let start = performance.now();
    const check = async () => {
      if (performance.now() - start <= budgetMs) return;
      this.switchTarget = null;
      this.buildingRooms = false;
      await pause();
      this.switchTarget = this.switches;
      this.buildingRooms = true;
      start = performance.now();
    };
    for (const b of this.b3d.blocks) {
      if (b.data.t !== 19) continue;
      // Діти кімнати незалежні (кімната не дає їм вершин) — пауза й між ними: в aa кімната одна на весь регіон.
      this.switchTarget = this.switches;
      this.buildingRooms = true;
      const grp = new THREE.Group();
      grp.name = b.name;
      const batches: Batches = new Map();
      for (const g of b.groups ?? [])
        for (const child of g) {
          this.visit(child, null, batches, grp, 1);
          await check();
        }
      await this.flushAsync(batches, grp, check);
      this.stats.rooms++;
      this.switchTarget = null;
      this.buildingRooms = false;
      rooms.push(grp);
      await check();
    }
    return rooms;
  }

  private buildRoom(b: Block): THREE.Group {
    this.switchTarget = this.switches;
    this.buildingRooms = true;
    const grp = new THREE.Group();
    grp.name = b.name;
    const batches: Batches = new Map();
    this.visit(b, null, batches, grp, 0);
    this.flush(batches, grp);
    this.stats.rooms++;
    this.switchTarget = null;
    this.buildingRooms = false;
    return grp;
  }

  private polyOrder = 0;

  private flush(batches: Batches, into: THREE.Object3D): void {
    this.layerPass(batches);
    for (const [matIndex, b] of batches) this.flushBatch(matIndex, b, into);
  }

  /** Те саме з паузами між партіями (buildRoomsAsync). */
  private async flushAsync(batches: Batches, into: THREE.Object3D, check: () => Promise<void>): Promise<void> {
    this.layerPass(batches);
    await check();
    for (const [matIndex, b] of batches) {
      this.flushBatch(matIndex, b, into);
      await check();
    }
  }

  private layerPass(batches: Batches): void {
    if (this.buildingRooms) this.stats.layered += separateLayers(
        [...batches].filter(([m]) => !!(this.lib.forKey(m) as THREE.MeshBasicMaterial).map).map(([, b]) => b),
      );
  }

  private flushBatch(matIndex: number, b: Batch, into: THREE.Object3D): void {
    if (!b.pos.length) return;
    // Трикутники за шаром: шар 0 — звичайний матеріал, вищі — копія зі зсувом глибини.
    const byLayer = new Map<number, { pos: number[]; uv: number[]; nrm?: number[] | null }>();
    if (!b.layer) byLayer.set(0, b);
    else
      for (let t = 0; t < b.pos.length / 9; t++) {
        const l = b.layer[t] ?? 0;
        let part = byLayer.get(l);
        if (!part) byLayer.set(l, (part = { pos: [], uv: [], nrm: b.nrm ? [] : null }));
        part.pos.push(...b.pos.slice(t * 9, t * 9 + 9));
        part.uv.push(...b.uv.slice(t * 6, t * 6 + 6));
        if (b.nrm) part.nrm!.push(...b.nrm.slice(t * 9, t * 9 + 9));
      }
    for (const [layer, part] of byLayer) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
      if (this.lit && matIndex >= 0) {
        if (part.nrm && part.nrm.length === part.pos.length) g.setAttribute('normal', new THREE.Float32BufferAttribute(part.nrm, 3));
        else g.computeVertexNormals();
      }
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, layer ? this.layerMaterial(matIndex, layer) : this.lib.forKey(matIndex));
      mesh.matrixAutoUpdate = false;
      into.add(mesh);
      this.stats.meshes++;
      this.stats.triangles += part.pos.length / 9;
    }
  }

  private readonly layerMaterials = new Map<string, THREE.Material>();

  /** Матеріал шару над стіною: та сама текстура, зсув глибини до глядача на layer кроків. */
  private layerMaterial(matIndex: number, layer: number): THREE.Material {
    const key = `${matIndex}/${layer}`;
    let m = this.layerMaterials.get(key);
    if (!m) {
      const src = this.lib.forKey(matIndex) as THREE.Material;
      m = src.clone();
      m.userData = src.userData; // clone() копіює userData через JSON — Set прапорців матеріалу пропадав би
      m.polygonOffset = true;
      m.polygonOffsetFactor = LAYER_OFFSET_FACTOR * layer;
      m.polygonOffsetUnits = LAYER_OFFSET_UNITS * layer;
      this.layerMaterials.set(key, m);
    }
    return m;
  }

  private addPolys(polys: Polygon[], vs: VertexSource, batches: Batches, mtype?: number): void {
    // Блок 35 з mtype 3 — трикутники лише з індексів вершин блоку 37 (king.exe 0x005f08d0); освітлення тоді
    // вирішує формат вершин (0x005f1620: прапорець — нормаль у FVF). mtype 1/2 мають свої вершини — завжди освітлені.
    const unlit = this.lit && !!vs.prelit && mtype === 3;
    for (const p of polys) {
      const key = unlit ? ~p.material : p.material;
      let b = batches.get(key);
      if (!b) batches.set(key, (b = { pos: [], uv: [], ord: [], nrm: this.lit && !unlit ? [] : null }));
      const ord = this.polyOrder++;
      const idx = p.indices;
      // Нормалі (lit): з полігона, інакше з вершин; якщо їх немає хоч в одного полігона партії — рахуємо з геометрії.
      const nsrc = this.lit && !unlit ? (p.normals ? 'poly' : vs.normals ? 'verts' : null) : null;
      if (!nsrc) b.nrm = null;
      // Біт 0x80 формату (лише в HT2: 145, 177, 179…) — смуга трикутників: вершини йдуть «зигзагом» (перевірено
      // на всіх 4-кутниках TRUCKS.B3D і регіонів: з бітом — 1 і 3 по один бік діагоналі 0–2, без — по різні).
      // Віяло на такій смузі лишало діагональні дірки (дах і задня стінка причепа). Без біта — віяло (HT1).
      const strip = (p.format & 0x80) !== 0;
      for (let k = 1; k + 1 < idx.length; k++) {
        const corners = !strip ? [0, k, k + 1] : k % 2 ? [k - 1, k, k + 1] : [k, k - 1, k + 1];
        for (const corner of corners) {
          const vi = idx[corner];
          b.pos.push(vs.positions[vi * 3], vs.positions[vi * 3 + 1], vs.positions[vi * 3 + 2]);
          if (p.uvs) b.uv.push(p.uvs[corner * 2], p.uvs[corner * 2 + 1]);
          else b.uv.push(vs.uvs[vi * 2], vs.uvs[vi * 2 + 1]);
          if (b.nrm) {
            if (nsrc === 'poly') b.nrm.push(p.normals![corner * 3], p.normals![corner * 3 + 1], p.normals![corner * 3 + 2]);
            else b.nrm.push(vs.normals![vi * 3], vs.normals![vi * 3 + 1], vs.normals![vi * 3 + 2]);
          }
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
          const vsrc = { positions: d.positions, uvs: d.uvs, normals: d.t === 36 ? d.normals : null, prelit: d.t === 36 && (d.format & 0xff) === 3 };
          if (block.groups) for (const g of block.groups) for (const child of g) this.visit(child, vsrc, b, grp, depth + 1);
          this.flush(b, grp);
          into.add(grp);
          return;
        }
        cur = { positions: d.positions, uvs: d.uvs, normals: d.t === 36 ? d.normals : null, prelit: d.t === 36 && (d.format & 0xff) === 3 };
        break;
      }
      case 7:
      case 37:
        cur = { positions: d.positions, uvs: d.uvs, normals: d.t === 37 ? d.normals : null, prelit: d.t === 37 && (d.format & 0xff) === 3 };
        break;
      case 4: {
        // HT2: деталь у просторі name1 — окрема група з матрицею простору (кермо, стрілки обертає гра).
        const m = this.type4Space && d.name1 ? this.space(d.name1) : null;
        if (m) {
          const grp = new THREE.Group();
          grp.name = block.name;
          grp.matrixAutoUpdate = false;
          grp.matrix.copy(m);
          grp.userData.baseMatrix = m.clone();
          grp.userData.space = d.name1.toLowerCase();
          const b: Batches = new Map();
          if (block.groups) for (const g of block.groups) for (const child of g) this.visit(child, cur, b, grp, depth + 1);
          this.flush(b, grp);
          into.add(grp);
          return;
        }
        break;
      }
      case 8:
      case 35:
        if (vs) this.addPolys(d.polys, vs, batches, d.t === 35 ? d.mtype : undefined);
        return;
      case 18:
        this.addInstance(d.space, d.object, into, block.name);
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
        go.visible = gi === switchInit(block.name, d.i1, groups.length);
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
      // Перемикач стану: i1 — початковий стан. Виняток — купол неба SkyDomeKey: рушій щокадру ставить стан
      // «номер неба кімнати + 1» (HTruck.exe 0x42a8a8), група 0 — порожня (блок nil, без неба). Номер неба кімнати
      // ще не розібрано — беремо перше небо (група 1, гіпотеза).
      const sky = block.name === 'SkyDomeKey';
      groups = [sky && block.groups.length > 1 ? block.groups[1] : (block.groups[switchInit(block.name, d.i1, block.groups.length)] ?? [])];
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
      const [sx, sy, sz, sr] = d.shape.v as [number, number, number, number];
      const sw = new DistanceSwitch([sx, sy, sz, sr * this.lodScale], this.nearGroup);
      for (const [gi, g] of block.groups.slice(0, 2).entries()) {
        const go = new THREE.Group();
        const b: Batches = new Map();
        for (const child of g) this.visit(child, cur, b, go, depth + 1);
        this.flush(b, go);
        // До першого кадру видима група 0 (HT1 — «здалеку», HT2 — детальна: з неї габарити колізії вантажівки).
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

  /** name — імʼя блоку-екземпляра (напр. `anmobj0002090` — шипи засідки 1090), у `userData.instance`. */
  private addInstance(spaceName: string, objectName: string, into: THREE.Object3D, name = ''): void {
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
      if (name) g.userData.instance = name;
      if (spaceName) g.userData.space = spaceName;
      into.add(g);
      this.stats.instances++;
      return;
    }
    // Заправка AnmObj0004 — окремий екземпляр з живими перемикачами (Benzo<k>Key, BenzoKey: вибух колонок,
    // world/objects.ts); решта — клон спільного шаблону.
    const live = /^anmobj0004$/i.test(objectName) ? (this.topByName.has(objectName.toLowerCase()) ? this : this.fallback)?.dynamicObject(objectName)?.root : null;
    const tpl = live ?? this.template(objectName);
    if (!m || !tpl) return;
    const inst = live ?? tpl.clone();
    inst.matrixAutoUpdate = false;
    inst.matrix.copy(m);
    if (name) inst.userData.instance = name;
    // Простір розміщення — для обʼєктів, що рухаються (стовпи падають у своєму Space_, world/objects.ts).
    inst.userData.space = spaceName;
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
  return finishScene(asm, asm.buildRooms());
}

/**
 * Те саме частинами: між кімнатами — pause(), щойно минуло budgetMs (підвантаження регіону під час їзди — без
 * ривка на 50…120 мс усього регіону).
 */
export async function buildSceneAsync(b3d: B3d, rmp: RmpArchive, opts: BuildOptions, pause: () => Promise<void>, budgetMs = 8): Promise<BuiltScene> {
  const asm = new SceneAssembler(b3d, rmp, opts);
  return finishScene(asm, await asm.buildRoomsAsync(pause, budgetMs));
}

function finishScene(asm: SceneAssembler, rooms: THREE.Group[]): BuiltScene {
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  for (const r of rooms) root.add(r);
  root.updateMatrixWorld(true);
  clampUntiled(root);
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

/**
 * Текстури з прозорістю, які в геометрії трас не повторюються вздовж осі (усі UV у 0…1), — без повтору по цій осі:
 * інакше лінійна фільтрація на краю підхоплює протилежний край текстури, і над верхівками лісу (forest: дерева
 * вгорі прозорі, стовбури внизу) видно тонку горизонтальну лінію. Повтори (forest по u до 15, stolb_dn по v до 13)
 * лишаються.
 */
function clampUntiled(root: THREE.Object3D): void {
  const range = new Map<THREE.Texture, { u: boolean; v: boolean }>();
  const EPS = 0.01;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const uv = mesh.isMesh ? mesh.geometry.getAttribute('uv') : undefined;
    if (!uv) return;
    const mats = ([] as THREE.Material[]).concat(mesh.material);
    const index = mesh.geometry.index;
    const groups = mesh.geometry.groups.length ? mesh.geometry.groups : [{ start: 0, count: index ? index.count : uv.count, materialIndex: 0 }];
    for (const g of groups) {
      const map = (mats[g.materialIndex ?? 0] as THREE.MeshBasicMaterial | undefined)?.map;
      if (!map || !map.userData.hasAlpha || map.wrapT !== THREE.RepeatWrapping) continue;
      const r = range.get(map) ?? { u: true, v: true };
      for (let i = g.start; i < g.start + g.count && (r.u || r.v); i++) {
        const k = index ? index.getX(i) : i;
        const u = uv.getX(k);
        const v = uv.getY(k);
        if (u < -EPS || u > 1 + EPS) r.u = false;
        if (v < -EPS || v > 1 + EPS) r.v = false;
      }
      range.set(map, r);
    }
  });
  for (const [map, r] of range) {
    if (r.u) map.wrapS = THREE.ClampToEdgeWrapping;
    if (r.v) map.wrapT = THREE.ClampToEdgeWrapping;
    if (r.u || r.v) map.needsUpdate = true;
  }
}

/**
 * Світло неба king.exe (0x005a9540, 0x005a7b50): sky_env — розсіяне skyamb і туман зі згустком у 15 разів (0x005f3da0);
 * точкові sky_lamp (sunsky — купол col_sky_b) і sky_lamp1 (suncld — хмари sky_mat*) з боку сонця, загасання
 * 1/(1 + 0,0025·d²). Позиція лампи — `lamp` відносно камери (виставляє Ht2World.setClimate).
 */
export const SKY_LIGHT = {
  amb: { value: new THREE.Color(0.8, 0.8, 0.8) },
  sky: { value: new THREE.Color(0, 0, 0) },
  cld: { value: new THREE.Color(0, 0, 0) },
  lamp: { value: new THREE.Vector3(0, 90, 0) },
  fogNear: { value: 1e5 },
  fogFar: { value: 2e5 },
};

/** Хто освітлює меш неба: 0 — лише skyamb (земля, панорами обрію), 1 — sky_lamp, 2 — sky_lamp1, 3 — не освітлюється. */
function skyKind(name: string): number {
  if (/^sky_mat/.test(name)) return 2;
  if (name === 'col_sky_b') return 1;
  if (/^(col_sun|sun_mat|moon_mat)$/.test(name)) return 3;
  return 0;
}

/** Небо: шаблон Background_object (купол noz_sky) без глибини, малюється першим. */
function buildSky(asm: SceneAssembler): THREE.Group | null {
  const tpl = asm.template('Background_object');
  if (!tpl) return null;
  const inner = tpl.clone();
  inner.rotation.x = -Math.PI / 2;
  inner.matrixAutoUpdate = true;
  const sky = new THREE.Group();
  sky.name = 'sky';
  sky.add(inner);
  // Черга малювання (без глибини — хто пізніше, той зверху). У sky_max шари записано від ближнього до дальнього (сонце,
  // хмари sky5…sky1, купол col_sky_b) — малюємо навпаки, інакше купол закривав хмари (гіпотеза: порядку обходу в
  // king.exe не розібрано). Решта (земля col_grass, панорами обрію fon_*) — у порядку файлу, після sky_max.
  const skySp = asm.space('sky_sp');
  const meshes: THREE.Mesh[] = [];
  inner.traverse((o) => {
    if (o instanceof THREE.Mesh) meshes.push(o);
  });
  const inMax = (o: THREE.Object3D): boolean => (o.name === 'sky_max' ? true : o.parent ? inMax(o.parent) : false);
  const maxIdx = meshes.map((_, i) => i).filter((i) => inMax(meshes[i]));
  const order = meshes.map((_, i) => i);
  maxIdx.forEach((i, k) => (order[i] = maxIdx[maxIdx.length - 1 - k]));
  meshes.forEach((o, i) => {
    const src = o.material as THREE.MeshBasicMaterial;
    // Небо не освітлюється (у режимі lit матеріали — Lambert).
    const m = src.isMeshBasicMaterial ? src.clone() : new THREE.MeshBasicMaterial({ map: src.map, color: src.color, alphaTest: src.alphaTest, transparent: src.transparent, opacity: src.opacity });
    m.depthWrite = false;
    m.depthTest = false;
    const kind = skyKind(src.name);
    // Плитки хмар (sky_tex) задано відносно центру сфери неба — простору sky_sp (SkyDomeSpace, z −136,26), купол
    // col_sky_b — відносно камери (шапка тієї ж сфери, ≈ 9 м над камерою, до обрію на 50 м). Без зсуву хмари висіли
    // на 88…145 м і було видно їх лише вище 37°; зі зсувом вони, як в оригіналі, сягають обрію (гіпотеза: у B3D
    // sky_tex посилається на SkyDomeSpace, звʼязку з sky_sp у коді king.exe не знайдено — висновок із геометрії).
    if (kind === 2 && skySp) {
      o.applyMatrix4(skySp);
      o.matrixAutoUpdate = true;
    }
    // Рух текстури (move u v): UV зсуваються на move·dt щосекунди (king.exe 0x005b22f0) — хмари пливуть.
    const move = (src.userData.def as { params?: Record<string, number[]> } | undefined)?.params?.move;
    if (move && m.map) {
      m.map = m.map.clone();
      m.userData.move = move;
    }
    // Хмари (sky4, sky5) — з плавною альфою: змішування, а не поріг 0,5 (з порогом лишалися клапті, небо — біле).
    // Шари лишаються в списку непрозорих (прозорі three.js малює після світу — без глибини небо лягло б поверх
    // нього), змішування — власне (CustomBlending діє й без transparent), по черзі файлу.
    if (m.map?.userData.hasAlpha) {
      m.alphaTest = 0;
      m.transparent = false;
      m.blending = THREE.CustomBlending;
      m.blendSrc = THREE.SrcAlphaFactor;
      m.blendDst = THREE.OneMinusSrcAlphaFactor;
    }
    // Освітлення (SKY_LIGHT) і туман неба: лінійний за глибиною, відстані туману сцени / 15.
    m.fog = true;
    m.defines = { SKY_KIND: kind };
    m.onBeforeCompile = (sh) => {
      sh.uniforms.skyAmb = SKY_LIGHT.amb;
      sh.uniforms.skySun = SKY_LIGHT.sky;
      sh.uniforms.skyCld = SKY_LIGHT.cld;
      sh.uniforms.skyLamp = SKY_LIGHT.lamp;
      sh.uniforms.skyFogNear = SKY_LIGHT.fogNear;
      sh.uniforms.skyFogFar = SKY_LIGHT.fogFar;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSkyPos;\nvarying vec3 vSkyN;')
        .replace(
          '#include <fog_vertex>',
          '#include <fog_vertex>\nvSkyPos = (modelMatrix * vec4(transformed, 1.0)).xyz - cameraPosition;\nvSkyN = mat3(modelMatrix) * normal;',
        );
      sh.fragmentShader = sh.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vSkyPos;\nvarying vec3 vSkyN;\nuniform vec3 skyAmb;\nuniform vec3 skySun;\nuniform vec3 skyCld;\nuniform vec3 skyLamp;\nuniform float skyFogNear;\nuniform float skyFogFar;',
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
#if SKY_KIND < 3
  vec3 skyL = skyAmb;
#if SKY_KIND > 0
  vec3 toL = skyLamp - vSkyPos;
  float d = length(toL);
  float ndl = max(dot(normalize(vSkyN), toL / d), 0.0) / (1.0 + 0.0025 * d * d);
  skyL += (SKY_KIND == 1 ? skySun : skyCld) * ndl;
#endif
  diffuseColor.rgb *= min(skyL, vec3(1.0));
#endif`,
        )
        .replace(
          '#include <fog_fragment>',
          `#ifdef USE_FOG
  float skyFog = clamp((vFogDepth - skyFogNear) / max(skyFogFar - skyFogNear, 1.0), 0.0, 1.0);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, skyFog);
#endif`,
        );
    };
    m.customProgramCacheKey = () => `sky-${kind}`;
    noFarClip(m);
    // Купол видно зсередини.
    m.side = THREE.DoubleSide;
    o.material = m;
    o.renderOrder = -1000 + order[i];
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
    // Кандидати — лише попередні трикутники з сусідніх клітинок (рамки перетинаються): у великій кімнаті (aa) перебір
    // усіх пар у площині займав ≈ 2,6 с одним шматком — ривок при підвантаженні регіону.
    const grid = new Map<string, number[]>();
    const big: number[] = [];
    const cellsOf = (t: Tri): string[] | null => {
      const lo = t.pts[0].clone().min(t.pts[1]).min(t.pts[2]);
      const hi = t.pts[0].clone().max(t.pts[1]).max(t.pts[2]);
      const [x0, y0, z0] = [lo.x, lo.y, lo.z].map((v) => Math.floor((v - 0.05) / LAYER_CELL));
      const [x1, y1, z1] = [hi.x, hi.y, hi.z].map((v) => Math.floor((v + 0.05) / LAYER_CELL));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) * (z1 - z0 + 1) > 64) return null;
      const out: string[] = [];
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) out.push(`${x},${y},${z}`);
      return out;
    };
    const useGrid = g.length > LAYER_GRID_FROM;
    for (let i = 0; i < g.length; i++) {
      const top = g[i];
      const cells = useGrid ? cellsOf(top) : null;
      const cand = new Set<number>(big);
      if (cells) for (const c of cells) for (const j of grid.get(c) ?? []) cand.add(j);
      else for (let j = 0; j < i; j++) cand.add(j);
      for (const j of cand) {
        const low = g[j];
        if (low.ord === top.ord || top.n.dot(low.n) < 0.999 || Math.abs(top.d - low.d) > 0.05) continue;
        if (overlapInPlane(top.pts, low.pts, top.n)) top.layer = Math.max(top.layer, low.layer + 1);
      }
      if (cells) for (const c of cells) (grid.get(c) ?? grid.set(c, []).get(c)!).push(i);
      else big.push(i);
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
