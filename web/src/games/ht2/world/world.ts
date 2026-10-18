import { findPoles, markObjects, type Movable, type Pole } from './objects';
import * as THREE from 'three';
import type { FileSource } from '@shared/source';
import { parseB3d } from '../engine/formats/b3d';
import { parseRmp, type RmpArchive } from '../engine/formats/rmp';
import { decodeCp1251 } from '../engine/formats/binary';
import { parseWay, type Way } from '../formats/way';
import { SKY_LIGHT, SceneAssembler, buildSceneAsync, type BuiltScene } from '../engine/render/sceneBuilder';
import { HT2_REGIONS, readTextures, regionFiles, type TexLevel } from '../files';
import { DAY_TIME_HOUR, Weather, WeatherCycle, type DayTime, type Sky } from './weather';
import { TREE_LIGHT, buildGlows, buildTrees, type TreeUpdate } from './trees';
import { illumOn, sunDirection, sunHeight } from './climate';
import { LensFlare } from './lensFlare';
import { mergeStatic } from './mergeStatic';
import { RoomVisibility, readPortals, roomFootprints, type RoomPortal } from './roomVisibility';
import { walk } from '../engine/formats/b3d';
import { parseHeightmap } from '../formats/heightmap';
import { buildTerrainMesh, terrainHeights } from './terrain';

/**
 * Відкритий світ Дальнобойщиків 2 (G3): 39 регіонів `ENV/<код>` у спільній системі координат гри. Межі регіону —
 * за точками його доріг (WAY, файли малі — читаються всі одразу); регіони в радіусі LOAD_R від камери вантажаться
 * по одному (найближчий першим), далі UNLOAD_R — вивантажуються (памʼять телефона). Спільні об'єкти й небо —
 * COMMON.B3D. Світло й туман — WEATHER.INI.
 *
 * Координати гри: x, y — площина, z — угору; у Three.js — (x, z, −y) (корінь регіону повернуто на −90° навколо X).
 */
export const LOAD_R = 1100;
export const UNLOAD_R = 1700;

export interface RegionInfo {
  id: string;
  way: Way;
  /** Межі доріг регіону в координатах гри: [x0, y0, x1, y1]. */
  bounds: [number, number, number, number];
}

export interface LoadedRegion {
  id: string;
  built: BuiltScene;
  /**
   * Реквізит засідок — анімовані обʼєкти `anmobj000<тип><id % 1000>` (тип 2 — шипи міліції AnmObj0002, 1 — міни мафії
   * AnmObj0001; номери — списки обʼєктів рядків `ambush` у mod_*.sch). King.exe вмикає їх лише на зайнятій засідці
   * (0x569310); за замовчуванням сховані.
   */
  props: Map<string, THREE.Object3D[]>;
  /** Збивні стовпи (знаки, світлофори, радари, ліхтарі) і рухомі предмети — world/objects.ts. */
  poles: Pole[];
  movables: Movable[];
  /** Процедурний рельєф ($$GeneratorOfTerrain, регіон aa): висоти сітки для колізій (terrain.ts). */
  terrain?: Float32Array;
  /** Портали кімнат (блок 30) і сліди кімнат на плані — видимість кімнат (roomVisibility.ts). */
  portals: Map<string, RoomPortal[]>;
  footprint: Map<number, string[]>;
}

/** Точка гри → Three.js. */
export function toThree(x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(x, z, -y);
}

/**
 * Спільні об'єкти (небо, анімовані предмети, ліхтарі): COMMON.B3D + текстури COMMON.RES (з палітрою common.plm
 * і звуками — двигун, сигнал, удари).
 */
export async function loadCommon(source: FileSource, tex: TexLevel = ''): Promise<{ asm: SceneAssembler; rmp: RmpArchive }> {
  const [b3d, res] = await Promise.all([source.read('COMMON/COMMON.B3D'), (tex ? source.read(`COMMON/common${tex}.res`) : readTextures(source, 'COMMON/COMMON.RES'))]);
  const rmp = parseRmp(res);
  return { asm: new SceneAssembler(parseB3d(b3d), rmp, { lit: true, colorKey: true, nearGroup: 0 }), rmp };
}

/**
 * Віддати потік між частинами важкої роботи (підвантаження регіону під час їзди): кадр встигає намалюватися, а не
 * чекає 70…140 мс усього регіону разом (заміри на ПК, Docs/ht2/progress.md). setTimeout, не rAF — у прихованій
 * вкладці rAF зупиняється, і завантаження на старті не завершилося б.
 */
export const yieldTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

export async function loadRegion(source: FileSource, id: string, common: SceneAssembler | null, tex: TexLevel = '', dir = 'ENV'): Promise<LoadedRegion> {
  const f = regionFiles(id, tex, dir);
  const [b3d, res] = await Promise.all([source.read(f.b3d), readTextures(source, f.res)]);
  const scene = parseB3d(b3d);
  const rmp = parseRmp(res);
  await yieldTask();
  const palette = common?.lib.palette ?? null;
  const built = await buildSceneAsync(scene, rmp, { lit: true, colorKey: true, nearGroup: 0, fallback: common ?? undefined, palette: palette ?? undefined }, yieldTask);
  await yieldTask();
  // Реквізит засідок — схований і поза злиттям нерухомої геометрії (mergeStatic пропускає невидиме).
  const props = new Map<string, THREE.Object3D[]>();
  built.root.traverse((o) => {
    const name = String(o.userData.instance ?? '').toLowerCase();
    if (!AMBUSH_PROP.test(name)) return;
    o.visible = false;
    (props.get(name) ?? props.set(name, []).get(name)!).push(o);
  });
  const poles = findPoles(built.assembler, (n) => built.assembler.block(n) ?? common?.block(n));
  const movables = markObjects(built.root, poles);
  // Нерухома геометрія регіону — одна сітка на матеріал у клітинці (було ≈ 500 мешів на регіон), у межах кімнати:
  // кімнату, якої не видно крізь портали, ховають цілком (roomVisibility.ts).
  let meshes = 0;
  for (const room of built.rooms) meshes += mergeStatic(room).after;
  built.stats.meshes = meshes;
  await yieldTask();
  const portals = readPortals(scene);
  const footprint = await roomFootprints(built.rooms, built.root, yieldTask);
  const trees = buildTrees(scene, rmp, palette);
  built.root.add(trees);
  const glows = buildGlows(scene, rmp);
  built.root.add(glows);
  await yieldTask();
  // Процедурний рельєф: генератор $$GeneratorOfTerrain (лише aa) — сітка з ENV/terrain0–2.raw.
  let terrain: Float32Array | undefined;
  let terrainMesh: THREE.Mesh | null = null;
  if ([...walk(scene.blocks)].some(([b]) => b.data.t === 40 && b.data.name2 === '$$GeneratorOfTerrain')) {
    try {
      // Кар'єра читає ENV/terrain*.raw (king.exe 0x5726e3; MTR/ — для мережевого «Тріалу», terrain1 там інший, до
      // 70 м); старий імпорт без ENV-файлів — MTR (re/notes/ht2/tracks.md).
      const tile = (i: number) => source.read(`ENV/terrain${i}.raw`).catch(() => source.read(`MTR/terrain${i}.raw`)).then(parseHeightmap);
      const tiles = await Promise.all([0, 1, 2].map(tile));
      terrain = terrainHeights(tiles);
      await yieldTask();
      const tex = (name: string) => {
        const i = scene.materials.findIndex((m) => m.toLowerCase() === name);
        return i >= 0 ? ((built.assembler.lib.material(i) as THREE.MeshLambertMaterial).map ?? null) : null;
      };
      terrainMesh = await buildTerrainMesh(terrain, tex('ter000'), tex('ter100'), yieldTask);
      // Рельєф — частина єдиної кімнати aa: ховається з нею.
      if (built.rooms.length === 1) terrainMesh.userData.room = built.rooms[0].name;
      built.root.add(terrainMesh);
    } catch (e) {
      console.warn('HT2: рельєф не побудовано', e);
    }
  }
  const dispose = built.dispose;
  built.dispose = () => {
    dispose();
    if (terrainMesh) {
      terrainMesh.geometry.dispose();
      for (const m of ([] as THREE.Material[]).concat(terrainMesh.material)) {
        (m as THREE.MeshLambertMaterial).map?.dispose();
        m.dispose();
      }
    }
    for (const g of [trees, glows])
      g.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          (o.material as THREE.MeshLambertMaterial).map?.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
  };
  return { id, built, terrain, props, poles, movables, portals, footprint };
}

const AMBUSH_PROP = /^anmobj000[12]\d{3}$/;

/** Імʼя реквізиту засідки: тип 2 — міліція, 1 — мафія; id — номер з рядка ambush. */
export function ambushProp(kind: 'police' | 'mafia', id: number): string {
  return `anmobj000${kind === 'police' ? 2 : 1}${String(id % 1000).padStart(3, '0')}`;
}

function boundsOf(way: Way): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of way.rooms)
    for (const s of r.segments)
      for (let i = 0; i < s.points.length; i += 3) {
        x0 = Math.min(x0, s.points[i]);
        x1 = Math.max(x1, s.points[i]);
        y0 = Math.min(y0, s.points[i + 1]);
        y1 = Math.max(y1, s.points[i + 1]);
      }
  return [x0, y0, x1, y1];
}

/** Відстань від точки (x, y) гри до прямокутника меж регіону (0 — усередині). */
export function distToBounds(b: [number, number, number, number], x: number, y: number): number {
  const dx = Math.max(b[0] - x, 0, x - b[2]);
  const dy = Math.max(b[1] - y, 0, y - b[3]);
  return Math.hypot(dx, dy);
}

/** Відстань ламп неба від камери в бік сонця, м (гіпотеза). */
const SKY_LAMP_DIST = 90;
/** Розсіяне світло в спалаху блискавки (king.exe 0x005a9540). */
const FLASH_COLOR = new THREE.Color().setRGB(0.9, 1, 1, THREE.SRGBColorSpace);

export class Ht2World {
  readonly scene = new THREE.Scene();
  readonly regions = new Map<string, RegionInfo>();
  readonly loaded = new Map<string, LoadedRegion>();
  /** Які кімнати малювати: щокадру з камери (drive.ts, і для дзеркала). */
  readonly visibility = new RoomVisibility();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  /** Місяць (WEATHER.INI moon_*; напрям у грі не розібрано — гіпотеза: навпроти сонця, під 45°). */
  private readonly moon = new THREE.DirectionalLight(0xffffff, 1);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.5);
  /** Година доби (нічні вікна ILLUM_LEVEL у нових регіонах). */
  private hour = 14;
  private sky: THREE.Group | null = null;
  /** Шари неба з рухом текстури (move): хмари. */
  private readonly skyMoving: THREE.MeshBasicMaterial[] = [];
  /** Матеріали регіонів з рухом текстури (move): річки й вода — за регіоном (вивантаження прибирає). */
  private readonly worldMoving = new Map<string, THREE.MeshBasicMaterial[]>();
  private lastFrame = 0;
  /** Відблиски сонця на екрані (lightonglass2) і показник погоди w для них. */
  private readonly flare: LensFlare;
  private weatherW = 0;
  /**
   * Дальня площина камери, м: king.exe — frpl · fogf (удень 0,6 · 900 = 540 м, у негоду 1 · 250), ближня — 0,2 м
   * (рендерер +0x2110/+0x2118, телеметрія 2026-10-18). Туман D3D іде з fogn/fogf без ділення на ближню площину
   * (0x005adc80: FOGSTART/FOGEND = fogn/fogf; поділені — лише для програмного рендерера), тож на краю площини
   * туман неповний (удень ≈ 45 %) і світ далі просто не малюється.
   */
  viewFar = 900;
  private loading: string | null = null;
  /** Увімкнений реквізит засідок (імена ambushProp). */
  private readonly propsOn = new Set<string>();

  /** Показати чи сховати реквізит засідки (шипи міліції, міни мафії) — і в регіонах, що завантажаться пізніше. */
  setAmbushProps(names: readonly string[], on: boolean): void {
    for (const n of names) {
      if (on) this.propsOn.add(n);
      else this.propsOn.delete(n);
      for (const r of this.loaded.values()) for (const o of r.props.get(n) ?? []) o.visible = on;
    }
  }
  private lastCheck = 0;
  private readonly waiters: (() => void)[] = [];
  onChange: (() => void) | null = null;
  /** Регіон завантажено (true) чи вивантажено (false) — для колізій режиму їзди (може будувати їх частинами). */
  onRegion: ((reg: LoadedRegion, loaded: boolean) => void | Promise<void>) | null = null;
  /** Підготувати регіон до показу (текстури на GPU, шейдери) — частинами, до додавання в сцену. */
  prepare: ((root: THREE.Object3D) => Promise<void>) | null = null;

  private constructor(
    private readonly source: FileSource,
    readonly common: SceneAssembler,
    readonly commonRmp: RmpArchive,
    private readonly weather: Weather | null,
  ) {
    this.scene.background = new THREE.Color(0x8fb4d8);
    this.scene.fog = new THREE.Fog(0x8fb4d8, 250, 900);
    this.scene.add(this.sun, this.sun.target, this.moon, this.moon.target, this.ambient);
    this.flare = new LensFlare(common);
    this.scene.add(this.flare.group);
    this.setClimate(14, 0);
  }

  static async create(source: FileSource): Promise<Ht2World> {
    const [common, weather, ways] = await Promise.all([
      loadCommon(source),
      source.read('WEATHER.INI').then((b) => Weather.parse(decodeCp1251(b))).catch(() => null),
      Promise.all(HT2_REGIONS.map((id) => source.read(regionFiles(id).way).then(parseWay).catch(() => null))),
    ]);
    const w = new Ht2World(source, common.asm, common.rmp, weather);
    HT2_REGIONS.forEach((id, i) => {
      const way = ways[i];
      if (way) w.regions.set(id, { id, way, bounds: boundsOf(way) });
    });
    return w;
  }

  /** Світло пори доби (огляд світу): good — без негоди, bad — повна. */
  setLight(sky: Sky, time: DayTime): void {
    this.setClimate(DAY_TIME_HOUR[time], sky === 'bad' ? 1 : 0);
  }

  /**
   * Світло й туман на годину доби й негоду b (0…1) — плавно, як у king.exe (weather.ts, re/notes/ht2/weather.md);
   * flash — спалах блискавки (розсіяне світло (0,9, 1, 1)). Набір WEATHER1 — гіпотеза (подія weather_change не
   * розібрана). Також напрям сонця, колір дерев (розсіяне + 0,7 · (сонце + місяць)) і нічні вікна; w — показник
   * погоди (відблиски сонця — лише при w < 0,2).
   */
  /** Спецнабір погоди кімнати (world/weatherRooms.ts): WEATHERn з вагою k. */
  special = { set: 0, k: 0 };
  /** Добова зміна звичайної погоди WEATHER1→4 (king.exe 0x5a9540). */
  readonly cycle = new WeatherCycle();

  /** Прапорці набору, що діє (king.exe: маска спецнабору при вазі ≥ 0,05, інакше звичайного). */
  weatherFlags(): { rain: boolean; sun: boolean; thund: boolean } {
    const set = this.special.set && this.special.k >= 0.05 ? this.special.set : this.cycle.set;
    return this.weather?.flags(set) ?? { rain: true, sun: true, thund: true };
  }

  setClimate(hour: number, b: number, flash: number | boolean = 0, w = b > 0 ? 0.5 + b / 2 : 0): void {
    this.hour = hour;
    this.weatherW = w;
    this.applyIllum();
    if (!this.weather) return;
    const l = this.weather.at(hour, b, this.cycle.update(hour), this.special);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(l.fog);
    fog.near = l.fogNear;
    fog.far = l.fogFar;
    this.viewFar = l.frpl * l.fogFar;
    (this.scene.background as THREE.Color).copy(l.fog);
    this.sun.color.copy(l.sun);
    this.moon.color.copy(l.moon);
    // Спалах f 0…1: розсіяне світло — від свого до (0,9, 1, 1).
    const f = Number(flash);
    this.ambient.color.copy(l.ambient);
    if (f > 0) this.ambient.color.lerp(FLASH_COLOR, Math.min(1, f));
    const [x, y, z] = sunDirection(hour);
    toThree(x, y, z, this.sun.position);
    this.moon.position.set(-this.sun.position.x, 0, -this.sun.position.z).normalize().setY(1).normalize();
    // Небо: skyamb, sunsky (купол), suncld (хмари); лампи неба — з боку сонця (гіпотеза: 90 м — sun_s0 на 50 м
    // і ще 40 м у його просторі), туман неба в 15 разів ближчий.
    SKY_LIGHT.amb.value.copy(l.sky);
    SKY_LIGHT.sky.value.copy(l.sunsky);
    SKY_LIGHT.cld.value.copy(l.suncld);
    SKY_LIGHT.lamp.value.copy(this.sun.position).normalize().multiplyScalar(SKY_LAMP_DIST);
    SKY_LIGHT.fogNear.value = l.fogNear / 15;
    SKY_LIGHT.fogFar.value = l.fogFar / 15;
    // Інтенсивність π — у three.js множник рівно 1 (Lambert ділить на π): колір = текстура × (envamb + sunenv·cos).
    this.sun.intensity = Math.PI;
    this.moon.intensity = Math.PI;
    this.ambient.intensity = Math.PI;
    // Дерева (0x005ca660): без освітлення за нормалями — колір = розсіяне + 0,7 · (сонце + місяць), до 1.
    const sr = { r: 0, g: 0, b: 0 };
    const amb = this.ambient.color.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    const sn = l.sun.getRGB({ r: 0, g: 0, b: 0 }, THREE.SRGBColorSpace);
    const mn = l.moon.getRGB(sr, THREE.SRGBColorSpace);
    const ch = (k: 'r' | 'g' | 'b') => Math.min(1, amb[k] + 0.7 * (sn[k] + mn[k]));
    TREE_LIGHT.value.setRGB(ch('r'), ch('g'), ch('b'), THREE.SRGBColorSpace);
  }

  /** Нічні вікна: перемикачі refer_ILLUM_LEVEL_00…15 регіонів (1 — світяться). */
  private readonly illum: boolean[] = [];
  private applyIllum(): void {
    for (let i = 0; i < 16; i++) {
      const on = illumOn(i, this.hour);
      if (this.illum[i] === on) continue;
      this.illum[i] = on;
      for (const r of this.loaded.values()) this.setIllum(r, i, on);
    }
  }
  private setIllum(r: LoadedRegion, level: number, on: boolean): void {
    const n = `ILLUM_LEVEL_${String(level).padStart(2, '0')}`;
    r.built.assembler.setSwitch(`refer_${n}`, on ? 1 : 0);
    r.built.assembler.setSwitch(n, on ? 1 : 0);
  }

  /** Погойдування дерев усіх завантажених регіонів: вітер 0…6 (Climate.wind); шар гілок — за положенням камери. */
  updateTrees(dt: number, wind: number, camera?: THREE.Vector3): void {
    for (const r of this.loaded.values()) (r.built.root.getObjectByName('trees')?.userData.sway as TreeUpdate | undefined)?.update(dt, wind, camera);
  }

  /** Ніч і сутінки: ореоли ліхтарів ($$DynamicGlow) у всіх завантажених регіонах. */
  private night = false;
  setNight(on: boolean): void {
    this.night = on;
    for (const r of this.loaded.values()) {
      const g = r.built.root.getObjectByName('glows');
      if (g) g.visible = on;
    }
  }

  /** Колір місячного світла пори доби (плями фар трафіку, traffic/headPools.ts). */
  get moonColor(): THREE.Color {
    return this.moon.color;
  }

  /** Колір розсіяного світла пори доби (для кабіни, що малюється окремою сценою). */
  get ambientColor(): THREE.Color {
    return this.ambient.color;
  }

  /** Регіон, у межах доріг якого точка гри (x, y), або найближчий. */
  regionAt(x: number, y: number): string | null {
    let best: string | null = null;
    let bd = Infinity;
    for (const r of this.regions.values()) {
      const d = distToBounds(r.bounds, x, y);
      if (d < bd) (bd = d), (best = r.id);
    }
    return best;
  }

  /** Початок першого сегмента доріг регіону: точка й напрям (координати гри). */
  startOf(id: string): { pos: [number, number, number]; dir: [number, number] } | null {
    const seg = this.regions.get(id)?.way.rooms.flatMap((r) => r.segments).find((s) => s.points.length >= 6);
    if (!seg) return null;
    const p = seg.points;
    const dx = p[3] - p[0];
    const dy = p[4] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return { pos: [p[0], p[1], p[2]], dir: [dx / l, dy / l] };
  }

  /**
   * Щокадру: небо за камерою; раз на 0,5 с — які регіони вантажити й вивантажувати довкола `focus` (у їзді —
   * вантажівка: камера після телепорту ще далеко, і регіони під машиною вивантажувались).
   */
  update(camera: THREE.Camera, focus: THREE.Vector3 = camera.position, now = performance.now()): void {
    if (this.sky) this.sky.position.copy(camera.position);
    if (camera instanceof THREE.PerspectiveCamera) this.flare.update(camera, this.sun.position, sunHeight(this.hour), this.weatherW);
    const dt = this.lastFrame ? Math.min(0.1, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const shift = (m: THREE.MeshBasicMaterial) => {
      const mv = m.userData.move as number[];
      m.map!.offset.set((m.map!.offset.x + mv[0] * dt) % 1, (m.map!.offset.y + mv[1] * dt) % 1);
    };
    this.skyMoving.forEach(shift);
    for (const list of this.worldMoving.values()) list.forEach(shift);
    if (now - this.lastCheck < 500) return;
    this.lastCheck = now;
    this.stream(focus.x, -focus.z);
  }

  /** Чекати, доки довкола точки гри (x, y) завантажаться всі регіони радіуса LOAD_R. */
  async ready(x: number, y: number): Promise<void> {
    this.stream(x, y);
    while (this.loading || this.wanted(x, y).some((id) => !this.loaded.has(id))) {
      await new Promise<void>((r) => this.waiters.push(r));
      this.stream(x, y);
    }
  }

  private wanted(x: number, y: number): string[] {
    return [...this.regions.values()]
      .map((r) => [r.id, distToBounds(r.bounds, x, y)] as const)
      .filter(([, d]) => d < LOAD_R)
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  }

  private stream(x: number, y: number): void {
    for (const [id, reg] of this.loaded) {
      if (distToBounds(this.regions.get(id)!.bounds, x, y) > UNLOAD_R) {
        this.scene.remove(reg.built.root);
        this.visibility.removeRegion(id);
        this.worldMoving.delete(id);
        this.onRegion?.(reg, false);
        reg.built.dispose();
        this.loaded.delete(id);
        this.onChange?.();
      }
    }
    if (this.loading) return;
    const next = this.wanted(x, y).find((id) => !this.loaded.has(id));
    if (!next) return;
    this.loading = next;
    void loadRegion(this.source, next, this.common)
      .then(async (reg) => {
        await this.prepare?.(reg.built.root);
        this.loaded.set(next, reg);
        const moving = new Set<THREE.MeshBasicMaterial>();
        reg.built.root.traverse((o) => {
          const ms = (o as THREE.Mesh).material;
          for (const m of Array.isArray(ms) ? ms : ms ? [ms] : []) if (m.userData.move) moving.add(m as THREE.MeshBasicMaterial);
        });
        if (moving.size) this.worldMoving.set(next, [...moving]);
        for (const [name, list] of reg.props) for (const o of list) o.visible = this.propsOn.has(name);
        const glows = reg.built.root.getObjectByName('glows');
        if (glows) glows.visible = this.night;
        for (let i = 0; i < 16; i++) this.setIllum(reg, i, illumOn(i, this.hour));
        this.visibility.addRegion(next, reg.built.rooms, reg.portals, reg.footprint, reg.built.root);
        this.scene.add(reg.built.root);
        await this.onRegion?.(reg, true);
        if (!this.sky && reg.built.sky) {
          this.sky = reg.built.sky;
          this.sky.traverse((o) => {
            const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
            if (m?.userData.move) this.skyMoving.push(m);
          });
          this.scene.add(this.sky);
        }
        this.onChange?.();
      })
      .catch((e) => console.error(`HT2: регіон ${next}`, e))
      .finally(() => {
        this.loading = null;
        for (const w of this.waiters.splice(0)) w();
        this.stream(x, y);
      });
  }

  stats(): { regions: string[]; triangles: number; meshes: number } {
    let triangles = 0;
    let meshes = 0;
    for (const r of this.loaded.values()) {
      triangles += r.built.stats.triangles;
      meshes += r.built.stats.meshes;
    }
    return { regions: [...this.loaded.keys()], triangles, meshes };
  }

  dispose(): void {
    for (const r of this.loaded.values()) r.built.dispose();
    this.loaded.clear();
    this.common.dispose();
  }
}
