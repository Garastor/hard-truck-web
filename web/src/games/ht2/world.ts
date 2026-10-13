import * as THREE from 'three';
import type { FileSource } from '../../assets/loader';
import { parseB3d } from '../../formats/b3d';
import { parseRmp, type RmpArchive } from '../../formats/rmp';
import { decodeCp1251 } from '../../formats/binary';
import { parseWay, type Way } from '../../formats/way';
import { SceneAssembler, buildScene, type BuiltScene } from '../../render/sceneBuilder';
import { HT2_REGIONS, readTextures, regionFiles, type TexLevel } from './files';
import { Weather, type DayTime, type Sky } from './weather';
import { buildGlows, buildTrees } from './trees';
import { mergeStatic } from '../../render/mergeStatic';
import { walk } from '../../formats/b3d';
import { parseHeightmap } from '../../formats/heightmap';
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
  /** Процедурний рельєф ($$GeneratorOfTerrain, регіон aa): висоти сітки для колізій (terrain.ts). */
  terrain?: Float32Array;
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

export async function loadRegion(source: FileSource, id: string, common: SceneAssembler | null, tex: TexLevel = '', dir = 'ENV'): Promise<LoadedRegion> {
  const f = regionFiles(id, tex, dir);
  const [b3d, res] = await Promise.all([source.read(f.b3d), readTextures(source, f.res)]);
  const scene = parseB3d(b3d);
  const rmp = parseRmp(res);
  const palette = common?.lib.palette ?? null;
  const built = buildScene(scene, rmp, { lit: true, colorKey: true, nearGroup: 0, fallback: common ?? undefined, palette: palette ?? undefined });
  // Нерухома геометрія регіону — одна сітка на матеріал у клітинці (було ≈ 500 мешів на регіон).
  const merged = mergeStatic(built.root);
  built.stats.meshes = merged.after;
  const trees = buildTrees(scene, rmp, palette);
  built.root.add(trees);
  const glows = buildGlows(scene, rmp);
  built.root.add(glows);
  // Процедурний рельєф: генератор $$GeneratorOfTerrain (лише aa) — сітка з MTR/terrain0–2.raw.
  let terrain: Float32Array | undefined;
  let terrainMesh: THREE.Mesh | null = null;
  if ([...walk(scene.blocks)].some(([b]) => b.data.t === 40 && b.data.name2 === '$$GeneratorOfTerrain')) {
    try {
      const tiles = await Promise.all([0, 1, 2].map((i) => source.read(`MTR/terrain${i}.raw`).then(parseHeightmap)));
      terrain = terrainHeights(tiles);
      const tex = (name: string) => {
        const i = scene.materials.findIndex((m) => m.toLowerCase() === name);
        return i >= 0 ? ((built.assembler.lib.material(i) as THREE.MeshLambertMaterial).map ?? null) : null;
      };
      terrainMesh = buildTerrainMesh(terrain, tex('ter000'), tex('ter100'));
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
      (terrainMesh.material as THREE.Material).dispose();
    }
    for (const g of [trees, glows])
      g.traverse((o) => {
        if (o instanceof THREE.Mesh || o instanceof THREE.Sprite) {
          (o.material as THREE.MeshLambertMaterial).map?.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
  };
  return { id, built, terrain };
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

export class Ht2World {
  readonly scene = new THREE.Scene();
  readonly regions = new Map<string, RegionInfo>();
  readonly loaded = new Map<string, LoadedRegion>();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.5);
  private sky: THREE.Group | null = null;
  private readonly skyTint = new THREE.Color(1, 1, 1);

  private tintSky(): void {
    this.sky?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (m?.color) m.color.copy(this.skyTint);
    });
  }
  private loading: string | null = null;
  private lastCheck = 0;
  private readonly waiters: (() => void)[] = [];
  onChange: (() => void) | null = null;
  /** Регіон завантажено (true) чи вивантажено (false) — для колізій режиму їзди. */
  onRegion: ((reg: LoadedRegion, loaded: boolean) => void) | null = null;

  private constructor(
    private readonly source: FileSource,
    readonly common: SceneAssembler,
    readonly commonRmp: RmpArchive,
    private readonly weather: Weather | null,
  ) {
    this.scene.background = new THREE.Color(0x8fb4d8);
    this.scene.fog = new THREE.Fog(0x8fb4d8, 250, 900);
    // Сонце: напрям у даних не знайдено (гіпотеза: високо з півдня-заходу). Світло у світових координатах Three.js.
    this.sun.position.set(-0.5, 1, 0.35);
    this.scene.add(this.sun, this.sun.target, this.ambient);
    this.setLight('good', 'day');
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

  /** Світло й туман з WEATHER.INI (набір 1 — гіпотеза: погоду регіону задає подія кімнати weather_change). */
  setLight(sky: Sky, time: DayTime): void {
    if (!this.weather) return;
    const l = this.weather.light(1, sky, time);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(l.fog);
    fog.near = l.fogNear;
    fog.far = l.fogFar;
    (this.scene.background as THREE.Color).copy(l.fog);
    this.sun.color.copy(l.sun);
    this.ambient.color.copy(l.ambient);
    // Купол неба (текстура денного неба) — у кольорі skyamb пори доби відносно ясного дня (204): уночі темний.
    this.skyTint.copy(l.sky).multiplyScalar(255 / 204);
    this.tintSky();
    this.sun.intensity = Math.PI * 0.8;
    this.ambient.intensity = Math.PI;
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
      .then((reg) => {
        this.loaded.set(next, reg);
        const glows = reg.built.root.getObjectByName('glows');
        if (glows) glows.visible = this.night;
        this.scene.add(reg.built.root);
        this.onRegion?.(reg, true);
        if (!this.sky && reg.built.sky) {
          this.sky = reg.built.sky;
          this.scene.add(this.sky);
          this.tintSky();
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
