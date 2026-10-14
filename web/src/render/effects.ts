import * as THREE from 'three';
import type { SceneAssembler } from '@engine/render/sceneBuilder';

/**
 * Вибух і полумʼя з ресурсів траси: обʼєкт `explosion` — перемикач `ExplodeKey` на 6 станів (5 кадрів білборду
 * й порожній), `Flame` — `SwitchFlame` на 9 кадрів вогню. Темп кадрів в оригіналі невідомий (гіпотеза: 12 і 15 к/с).
 */
const EXPLODE_FPS = 12;
const FLAME_FPS = 15;
/** Скільки горять уламки після вибуху, с. */
const FLAME_TIME = 6;
/**
 * Білборди в ресурсах малі (вибух 4 м, вогонь 1,5 м) і з центру машини їх закриває кузов — піднімаємо над
 * дахом і збільшуємо (гіпотеза: як оригінал масштабує ефект, невідомо).
 */
const EXPLODE_SCALE = 2.5;
const FLAME_SCALE = 2;
/** Над точкою тіла машини (≈ 1,1 м над дорогою): вибух — на рівні кабіни, вогонь — на даху. */
const EXPLODE_ABOVE = 1.5;
const FLAME_ABOVE = 1.2;

interface Anim {
  root: THREE.Group;
  setSwitch: (n: string, s: number) => void;
  key: string;
  frames: number;
  fps: number;
  t: number;
  loop: boolean;
  until: number;
}

export class Effects {
  private readonly anims: Anim[] = [];

  constructor(
    private readonly asm: SceneAssembler,
    private readonly scene: THREE.Scene,
  ) {}

  /** Вибух у точці (Three.js) і вогонь, що йде за target (уламки). */
  explode(at: THREE.Vector3, target?: THREE.Object3D): void {
    const boom = this.spawn('explosion', 'ExplodeKey', EXPLODE_FPS, false, 0);
    if (boom) {
      boom.root.position.copy(at).y += EXPLODE_ABOVE;
      boom.root.scale.setScalar(EXPLODE_SCALE);
    }
    const fire = this.spawn('Flame', 'SwitchFlame', FLAME_FPS, true, FLAME_TIME);
    if (fire) {
      fire.root.position.copy(at).y += FLAME_ABOVE;
      fire.root.scale.setScalar(FLAME_SCALE);
      if (target) fire.root.userData.follow = target;
    }
  }

  private spawn(object: string, key: string, fps: number, loop: boolean, until: number): Anim | null {
    const dyn = this.asm.dynamicObject(object);
    if (!dyn) return null;
    const states = dyn.states(key);
    if (!states) return null;
    const root = new THREE.Group();
    dyn.root.rotation.x = -Math.PI / 2;
    root.add(dyn.root);
    this.scene.add(root);
    // Порожній останній стан вибуху — не кадр.
    const frames = loop ? states : Math.max(1, states - 1);
    const a: Anim = { root, setSwitch: dyn.setSwitch, key, frames, fps, t: 0, loop, until };
    a.setSwitch(key, 0);
    this.anims.push(a);
    return a;
  }

  update(dt: number): void {
    for (let i = this.anims.length - 1; i >= 0; i--) {
      const a = this.anims[i];
      a.t += dt;
      const follow = a.root.userData.follow as THREE.Object3D | undefined;
      if (follow) follow.getWorldPosition(a.root.position).y += FLAME_ABOVE;
      const f = Math.floor(a.t * a.fps);
      const done = a.loop ? a.t > a.until : f >= a.frames;
      if (done) {
        this.scene.remove(a.root);
        this.anims.splice(i, 1);
        continue;
      }
      a.setSwitch(a.key, a.loop ? f % a.frames : f);
    }
  }

  dispose(): void {
    for (const a of this.anims) this.scene.remove(a.root);
    this.anims.length = 0;
  }
}
