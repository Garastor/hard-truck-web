import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FileSource } from '../../assets/loader';
import { parseB3d } from '../../formats/b3d';
import { parseRmp } from '../../formats/rmp';
import { SceneAssembler, buildScene, type BuiltScene } from '../../render/sceneBuilder';
import { decodeCp1251 } from '../../formats/binary';
import { parseWay } from '../../formats/way';
import { HT2_REGIONS, regionFiles, type TexLevel } from './files';
import { Weather, type DayTime, type Sky } from './weather';

/**
 * Поле зору: TRUCK.INI [RENDER] ypyramid=0.9 — висота «піраміди огляду» на відстані 1 (як у HT1, де 1.5):
 * вертикаль 2·atan(0,45) ≈ 48,5°.
 */
const Y_PYRAMID = 0.9;

/**
 * Переглядач світу Дальнобойщиків 2 (G2): регіон `ENV/<код>.b3d` + текстури `<код>1.res`, обліт камерою.
 * Наступні кроки — склеювання регіонів і потокове завантаження (G3).
 */
export interface WorldViewerOptions {
  renderer: THREE.WebGLRenderer;
  source: FileSource;
  region?: string;
  setStatus(text: string | null): void;
  onExit(): void;
}

export interface LoadedRegion {
  id: string;
  built: BuiltScene;
}

/** Спільні об'єкти (небо, анімовані предмети, ліхтарі): COMMON.B3D + текстури common1.res (з палітрою common.plm). */
export async function loadCommon(source: FileSource, tex: TexLevel = '1'): Promise<SceneAssembler> {
  const [b3d, res] = await Promise.all([source.read('COMMON/COMMON.B3D'), source.read(`COMMON/common${tex}.res`)]);
  return new SceneAssembler(parseB3d(b3d), parseRmp(res), { lit: true, colorKey: true });
}

export async function loadRegion(source: FileSource, id: string, common: SceneAssembler | null, tex: TexLevel = '1', dir = 'ENV'): Promise<LoadedRegion> {
  const f = regionFiles(id, tex, dir);
  const [b3d, res] = await Promise.all([source.read(f.b3d), source.read(f.res)]);
  const built = buildScene(parseB3d(b3d), parseRmp(res), { lit: true, colorKey: true, fallback: common ?? undefined, palette: common?.lib.palette ?? undefined });
  return { id, built };
}

export class WorldViewer {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  region: LoadedRegion | null = null;
  private common: SceneAssembler | null = null;
  private readonly hud = document.createElement('div');
  private readonly info = document.createElement('div');
  private readonly select = document.createElement('select');
  private readonly onResize = () => this.resize();
  private readonly clock = new THREE.Clock();
  private readonly sun = new THREE.DirectionalLight(0xffffff, 1);
  private readonly ambient = new THREE.AmbientLight(0xffffff, 0.5);
  private weather: Weather | null = null;
  private readonly time = document.createElement('select');
  private readonly sky = document.createElement('select');

  constructor(private readonly opts: WorldViewerOptions) {
    const { renderer } = opts;
    this.scene.background = new THREE.Color(0x8fb4d8);
    this.scene.fog = new THREE.Fog(0x8fb4d8, 250, 900);
    this.camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(Y_PYRAMID / 2)), 1, 0.5, 20000);
    // Сонце: напрям у даних не знайдено (гіпотеза: високо з півдня-заходу). Світло у світових координатах Three.js.
    this.sun.position.set(-0.5, 1, 0.35);
    this.scene.add(this.sun, this.sun.target, this.ambient);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.495;

    this.hud.className = 'ht2-hud';
    const back = document.createElement('button');
    back.textContent = '← Меню';
    back.addEventListener('click', () => opts.onExit());
    for (const r of HT2_REGIONS) this.select.add(new Option(r.toUpperCase(), r));
    this.select.value = opts.region && (HT2_REGIONS as readonly string[]).includes(opts.region) ? opts.region : 'aa';
    this.select.addEventListener('change', () => void this.open(this.select.value));
    for (const [v, t] of [['day', 'День'], ['srise', 'Світанок'], ['sset', 'Захід'], ['night', 'Ніч']]) this.time.add(new Option(t, v));
    for (const [v, t] of [['good', 'Ясно'], ['bad', 'Хмарно']]) this.sky.add(new Option(t, v));
    this.time.addEventListener('change', () => this.applyLight());
    this.sky.addEventListener('change', () => this.applyLight());
    this.hud.append(back, this.select, this.time, this.sky);
    this.info.className = 'ht2-info';
    document.body.append(this.hud, this.info);
    window.addEventListener('resize', this.onResize);
    this.resize();
    renderer.setAnimationLoop(() => this.frame());
  }

  get regionId(): string {
    return this.select.value;
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.opts.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Світло й туман з WEATHER.INI за вибраною порою доби й погодою. */
  private applyLight(): void {
    if (!this.weather) return;
    const l = this.weather.light(1, this.sky.value as Sky, this.time.value as DayTime);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.copy(l.fog);
    fog.near = l.fogNear;
    fog.far = l.fogFar;
    (this.scene.background as THREE.Color).copy(l.fog);
    this.sun.color.copy(l.sun);
    this.ambient.color.copy(l.ambient);
    this.sun.intensity = Math.PI * 0.8;
    this.ambient.intensity = Math.PI;
  }

  async open(id: string): Promise<void> {
    this.opts.setStatus(`Завантаження регіону ${id.toUpperCase()}…`);
    try {
      if (!this.weather) {
        this.weather = await this.opts.source.read('WEATHER.INI').then((b) => Weather.parse(decodeCp1251(b))).catch(() => null);
        this.applyLight();
      }
      const t0 = performance.now();
      this.common ??= await loadCommon(this.opts.source);
      const next = await loadRegion(this.opts.source, id, this.common);
      const t1 = performance.now();
      if (this.region) {
        this.scene.remove(this.region.built.root);
        if (this.region.built.sky) this.scene.remove(this.region.built.sky);
        this.region.built.dispose();
      }
      this.region = next;
      this.scene.add(next.built.root);
      if (next.built.sky) this.scene.add(next.built.sky);
      await this.placeOnRoad(id);
      const s = next.built.stats;
      this.info.textContent =
        `${id.toUpperCase()}: кімнат ${s.rooms}, мешів ${s.meshes}, трикутників ${s.triangles}\n` +
        `інстансів ${s.instances}, без текстур ${s.missingTextures}, завантаження ${(t1 - t0).toFixed(0)} мс`;
      this.opts.setStatus(null);
    } catch (e) {
      console.error(e);
      this.opts.setStatus(`Помилка: ${(e as Error).message}`);
    }
  }

  /**
   * Камера на дорозі: перший сегмент дорожньої мережі регіону (ENV/<код>.way) — на 3 м над першою точкою,
   * погляд уздовж сегмента. Координати WAY — як у B3D (z — висота): у Three.js (x, z, −y).
   */
  private async placeOnRoad(id: string): Promise<void> {
    const way = await this.opts.source.read(regionFiles(id).way).then(parseWay).catch(() => null);
    const seg = way?.rooms.flatMap((r) => r.segments).find((s) => s.points.length >= 6);
    if (seg) {
      const p = seg.points;
      const a = new THREE.Vector3(p[0], p[2], -p[1]);
      const b = new THREE.Vector3(p[3], p[5], -p[4]);
      const dir = b.clone().sub(a).setY(0).normalize();
      this.camera.position.copy(a).add(new THREE.Vector3(0, 3, 0)).addScaledVector(dir, 4);
      this.controls.target.copy(a).add(new THREE.Vector3(0, 2, 0)).addScaledVector(dir, 20);
    } else {
      const box = new THREE.Box3().setFromObject(this.region!.built.root);
      const c = box.getCenter(new THREE.Vector3());
      this.controls.target.copy(c);
      this.camera.position.copy(c).add(new THREE.Vector3(150, 120, 150));
    }
    this.camera.far = 20000;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  private frame(): void {
    this.clock.getDelta();
    this.controls.update();
    const sky = this.region?.built.sky;
    if (sky) sky.position.copy(this.camera.position);
    this.opts.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    this.controls.dispose();
    this.hud.remove();
    this.info.remove();
    if (this.region) this.region.built.dispose();
  }
}
