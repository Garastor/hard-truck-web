import * as THREE from 'three';
import { visibleBox } from '../engine/vehicle/trucks';
import type { Ht2Trucks } from '../vehicles/trucks';

/**
 * Покажчики повороту — відступ порту на прохання користувача (у king.exe їх немає): відблиск оригінальної текстури
 * `Ka50_GlowO` (помаранчева мигалка Ка-50, TRUCKS.B3D) біля передніх фар і задніх вогнів (StopFaraKeyL/R) свого
 * боку, 1,5 Гц; коли — driver.turnSignal. Спільні для трафіку (traffic.ts) і ботів-далекобійників (truckers.ts:
 * тягач — усі чотири, напівпричіп — задні).
 */
const BLINK_HZ = 1.5;
const BLINK_SIZE = 0.55;

export class Blinkers {
  private time = 0;
  private mat: THREE.SpriteMaterial | null | undefined;
  /** Точки покажчиків моделі (Three.js, від початку координат моделі): перед лів., зад лів., перед прав., зад прав. */
  private readonly pts = new Map<string, THREE.Vector3[] | null>();

  constructor(private readonly trucks: Ht2Trucks) {}

  /** Фаза миготіння (раз на кадр). */
  tick(dt: number): void {
    this.time += dt;
  }

  /** Зараз світить (перша половина періоду). */
  get on(): boolean {
    return (this.time * BLINK_HZ) % 1 < 0.5;
  }

  /**
   * Точки покажчиків моделі: перед — краї фар (refer_HeadLightKey, стан 1), зад — задні вогні (StopFaraKeyL/R, стан 1);
   * без них — кути габаритів моделі. Ліво — −x (уперед — −Z).
   */
  points(model: string): THREE.Vector3[] | null {
    if (this.pts.has(model)) return this.pts.get(model)!;
    let out: THREE.Vector3[] | null = null;
    const dyn = this.trucks.asm.dynamicObject(model);
    if (dyn) {
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      frame.add(dyn.root);
      frame.updateMatrixWorld(true);
      const body = visibleBox(dyn.root);
      const part = (name: string): THREE.Box3 | null => {
        let o: THREE.Object3D | null = null;
        dyn.root.traverse((x) => {
          if (!o && x.name === name) o = x;
        });
        if (!o) return null;
        const b = new THREE.Box3().setFromObject(o);
        return b.isEmpty() ? null : b;
      };
      const head = part('refer_HeadLightKey#1');
      const rl = part('StopFaraKeyL#1');
      const rr = part('StopFaraKeyR#1');
      const y = head ? head.getCenter(new THREE.Vector3()).y : body.min.y + 0.4 * (body.max.y - body.min.y);
      const fz = (head ? head.min.z : body.min.z) - 0.05;
      const rear = (b: THREE.Box3 | null, x: number) => (b ? b.getCenter(new THREE.Vector3()).setZ(b.max.z + 0.05) : new THREE.Vector3(x, y, body.max.z + 0.05));
      out = [
        new THREE.Vector3((head ? head.min.x : body.min.x) + 0.15, y, fz),
        rear(rl, body.min.x + 0.2),
        new THREE.Vector3((head ? head.max.x : body.max.x) - 0.15, y, fz),
        rear(rr, body.max.x - 0.2),
      ];
    }
    this.pts.set(model, out);
    return out;
  }

  /**
   * Відблиски покажчиків на моделі (host — вузол у системі моделі; lift — зсув обгортки моделі над host); rearOnly —
   * лише задні (напівпричіп). null — моделі чи текстури немає.
   */
  make(host: THREE.Object3D, model: string, lift: THREE.Vector3 | null = null, rearOnly = false): THREE.Group | null {
    const pts = this.points(model);
    if (this.mat === undefined) {
      const mats = this.trucks.asm.b3d.materials.map((m) => m.toLowerCase());
      const i = mats.indexOf('ka50_glowo');
      const map = i >= 0 ? (this.trucks.asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
      this.mat = map ? new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }) : null;
    }
    if (!pts || !this.mat) return null;
    const g = new THREE.Group();
    g.name = 'TurnSignals';
    if (lift) g.position.copy(lift);
    pts.forEach((p, i) => {
      if (rearOnly && i % 2 === 0) return;
      const s = new THREE.Sprite(this.mat!);
      s.position.copy(p);
      s.scale.setScalar(BLINK_SIZE);
      s.visible = false;
      s.userData.left = i < 2;
      g.add(s);
    });
    host.add(g);
    return g;
  }

  /** Показати покажчик боку side (−1 ліво, 1 право, 0 — нічого). */
  show(g: THREE.Group, side: -1 | 0 | 1): void {
    const on = this.on && side !== 0;
    for (const s of g.children) s.visible = on && (s.userData.left ? side < 0 : side > 0);
  }
}
