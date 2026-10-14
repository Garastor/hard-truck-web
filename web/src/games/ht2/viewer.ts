import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { FileSource } from '@engine/assets/source';
import { HT2_REGIONS } from './files';
import { Ht2World, toThree } from './world';
import type { DayTime, Sky } from './weather';

/**
 * Поле зору: TRUCK.INI [RENDER] ypyramid=0.9 — висота «піраміди огляду» на відстані 1 (як у HT1, де 1.5):
 * вертикаль 2·atan(0,45) ≈ 48,5°.
 */
export const Y_PYRAMID = 0.9;
export const FOV = THREE.MathUtils.radToDeg(2 * Math.atan(Y_PYRAMID / 2));

export interface WorldViewerOptions {
  renderer: THREE.WebGLRenderer;
  source: FileSource;
  region?: string;
  setStatus(text: string | null): void;
  onExit(): void;
}

/** Огляд світу HT2: обліт камерою, регіони підвантажуються навколо неї (Ht2World). */
export class WorldViewer {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 20000);
  readonly controls: OrbitControls;
  world: Ht2World | null = null;
  private readonly hud = document.createElement('div');
  private readonly info = document.createElement('div');
  private readonly select = document.createElement('select');
  private readonly time = document.createElement('select');
  private readonly sky = document.createElement('select');
  private readonly onResize = () => this.resize();
  private readonly onVisible = () => this.opts.renderer.setAnimationLoop(document.hidden ? null : () => this.frame());

  constructor(private readonly opts: WorldViewerOptions) {
    const { renderer } = opts;
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
    this.select.addEventListener('change', () => void this.goTo(this.select.value));
    for (const [v, t] of [['day', 'День'], ['srise', 'Світанок'], ['sset', 'Захід'], ['night', 'Ніч']]) this.time.add(new Option(t, v));
    for (const [v, t] of [['good', 'Ясно'], ['bad', 'Хмарно']]) this.sky.add(new Option(t, v));
    const light = () => {
      this.world?.setLight(this.sky.value as Sky, this.time.value as DayTime);
      this.world?.setNight(this.time.value !== 'day');
    };
    this.time.addEventListener('change', light);
    this.sky.addEventListener('change', light);
    this.hud.append(back, this.select, this.time, this.sky);
    this.info.className = 'ht2-info';
    document.body.append(this.hud, this.info);
    window.addEventListener('resize', this.onResize);
    document.addEventListener('visibilitychange', this.onVisible);
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

  async start(): Promise<void> {
    this.opts.setStatus('Завантаження світу…');
    try {
      this.world = await Ht2World.create(this.opts.source);
      this.world.onChange = () => this.showInfo();
      await this.goTo(this.select.value);
    } catch (e) {
      console.error(e);
      this.opts.setStatus(`Помилка: ${(e as Error).message}`);
    }
  }

  /** Камера на початок доріг регіону (3 м над дорогою, погляд уздовж); чекаємо регіони довкола. */
  async goTo(id: string): Promise<void> {
    const w = this.world;
    const start = w?.startOf(id);
    if (!w || !start) return;
    this.opts.setStatus(`Завантаження регіону ${id.toUpperCase()}…`);
    const [x, y, z] = start.pos;
    const [dx, dy] = start.dir;
    toThree(x + dx * 4, y + dy * 4, z + 3, this.camera.position);
    toThree(x + dx * 24, y + dy * 24, z + 2, this.controls.target);
    this.controls.update();
    await w.ready(x, y);
    this.opts.setStatus(null);
  }

  private showInfo(): void {
    const s = this.world?.stats();
    if (!s) return;
    const p = this.camera.position;
    this.info.textContent =
      `регіони: ${s.regions.map((r) => r.toUpperCase()).join(' ')}\n` +
      `мешів ${s.meshes}, трикутників ${s.triangles}\n` +
      `камера ${p.x.toFixed(0)} ${(-p.z).toFixed(0)} ${p.y.toFixed(0)} — ${this.world!.regionAt(p.x, -p.z)?.toUpperCase() ?? ''}`;
  }

  private frame(): void {
    this.controls.update();
    this.world?.update(this.camera);
    if (this.world) this.opts.renderer.render(this.world.scene, this.camera);
  }

  dispose(): void {
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('visibilitychange', this.onVisible);
    this.controls.dispose();
    this.hud.remove();
    this.info.remove();
    this.world?.dispose();
  }
}
