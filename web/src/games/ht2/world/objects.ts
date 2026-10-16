import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { walk, type Block } from '../engine/formats/b3d';
import { GROUP_MOVABLE, GROUP_WORLD, g2t, groups } from '../engine/physics/world';
import type { SceneAssembler } from '../engine/render/sceneBuilder';

/**
 * Предмети світу, з якими машина взаємодіє (king.exe, re/notes/ht2/objects.md):
 *
 * **Збивні стовпи** — блоки 20 `sharp_*` з даними події (`values[1] = (вид << 16) | 2`): 1 — дорожній знак,
 * 4 — світлофор, 5 — стаціонарний радар, 6 — ліхтарний стовп. Обʼєкт `e_<X>` з колізією й видима модель `<X>`
 * стоять в одному просторі `<X>Space_`. Удар з імпульсом P = маса · |v|: P < 5000 — як стіна; інакше нахил
 * φ = (P − 5000)·1,5394/(Pmax − 5000) (Pmax 20000 для знака й світлофора, 40000 для радара й стовпа); понад 60° —
 * повалено: колізія зникає, машина їде далі зі швидкістю × (1 − A/P), A = (Pmax − 5000)·φmax·0,6496, обʼєкт лягає
 * майже на землю (0,98·φmax) у бік удару. Звук hit_sign (1, 4) чи hit_ironpillar (5, 6), гучність min(P/Pmax, 1).
 *
 * **Рухомі предмети** AnmObj0201…0209 (фургони, бочки, каністри) — тверді тіла з масами з vehicle.tech; від удару
 * відлітають і котяться, на місце не повертаються (поза зберігається, поки триває гра).
 *
 * Гіпотези порту: φmax = 0,9·π/2 (у exe 0,9·acos(…) — вектор не зʼясовано); падіння — за 0,5 с; колізія стовпа —
 * брус уздовж ламаної, товщина — подвоєний радіус блоку (не менше 0,1 м), висота — values[0]; форма предмета —
 * габарит моделі (exe — точки Corner_Mark і площини CollisionPlane); лампа й ореол поваленого ліхтаря та
 * світлофор не гаснуть (ще не зроблено).
 */
const MIN_P = 5000;
const PHI_MAX = 0.9 * (Math.PI / 2);
const FALL_TIME = 0.5;

export interface Pole {
  kind: number;
  /** Простір `<X>Space_`: видимі обʼєкти й поворот при падінні. */
  space: string;
  /** Матриця простору (координати гри). */
  matrix: THREE.Matrix4;
  /** Точки ламаної в координатах гри. */
  points: THREE.Vector3[];
  height: number;
  radius: number;
}

/** Рухомий предмет: екземпляр AnmObj02xx. */
export interface Movable {
  name: string;
  type: string;
  object: THREE.Object3D;
}

const MASS: Record<string, number> = {
  anmobj0201: 2000,
  anmobj0202: 3000,
  anmobj0203: 1400,
  anmobj0204: 1400,
  anmobj0205: 140,
  anmobj0206: 140,
  anmobj0207: 100,
  anmobj0208: 100,
  anmobj0209: 200,
  anmobj0231: 10000,
  anmobj0241: 10000,
};
/** Бочки й каністри — циліндри (восьмигранна призма в exe), решта — бруси. */
const ROUND = /^anmobj020[3-9]$/;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const asFloat = (v: number) => ((u32[0] = v), f32[0]);

/** Стовпи регіону: блоки 18 `e_*` з блоком 20 події виду 1, 4, 5, 6. */
export function findPoles(asm: SceneAssembler, find: (name: string) => Block | undefined): Pole[] {
  const out: Pole[] = [];
  for (const [b] of walk(asm.b3d.blocks)) {
    const d = b.data;
    if (d.t !== 18 || !/^e_/i.test(d.object)) continue;
    const tpl = find(d.object);
    const m = asm.space(d.space);
    if (!tpl || !m) continue;
    for (const [s] of walk([tpl])) {
      const sd = s.data;
      if (sd.t !== 20 || sd.trigger.values.length < 2 || (sd.trigger.values[1] & 0xffff) !== 2) continue;
      const kind = sd.trigger.values[1] >>> 16;
      if (![1, 4, 5, 6].includes(kind)) continue;
      const h = asFloat(sd.trigger.values[0]);
      out.push({
        kind,
        space: d.space.toLowerCase(),
        matrix: m,
        points: sd.points.map((p) => new THREE.Vector3(...p).applyMatrix4(m)),
        height: h > 0.5 && h < 30 ? h : 3,
        radius: Math.max(0.05, sd.trigger.i2 * 0.01),
      });
    }
  }
  return out;
}

/** Простори стовпів і рухомі предмети — поза злиттям нерухомої геометрії (позначка noMerge). */
export function markObjects(root: THREE.Object3D, poles: Pole[]): Movable[] {
  const spaces = new Set(poles.map((p) => p.space));
  const movables: Movable[] = [];
  root.traverse((o) => {
    const space = String(o.userData.space ?? '').toLowerCase();
    const name = String(o.userData.instance ?? '').toLowerCase();
    if (space && spaces.has(space)) o.userData.noMerge = true;
    const type = name.slice(0, 10);
    if (/^anmobj02\d\d\d{3}$/.test(name) && MASS[type]) {
      o.userData.noMerge = true;
      movables.push({ name, type, object: o });
    }
  });
  return movables;
}

interface PoleState {
  def: Pole;
  colliders: RAPIER.Collider[];
  visuals: { o: THREE.Object3D; base: THREE.Matrix4 }[];
  down: boolean;
  /** Падіння: вісь (гра), кут, час. */
  fall: { axis: THREE.Vector3; to: number; t: number } | null;
  key: string;
}

interface MovableState {
  def: Movable;
  body: RAPIER.RigidBody;
  parentInv: THREE.Matrix4;
  key: string;
}

export interface ObjectEvent {
  sound: 'hit_sign' | 'hit_ironpillar';
  volume: number;
}

export class WorldObjects {
  private readonly poles = new Map<string, PoleState[]>();
  private readonly movables = new Map<string, MovableState[]>();
  /** Повалені стовпи й пози предметів — переживають вивантаження регіону (як реєстр king.exe). */
  private readonly fallen = new Map<string, { axis: THREE.Vector3; to: number }>();
  private readonly poses = new Map<string, { p: RAPIER.Vector; q: RAPIER.Rotation }>();
  private readonly prevVel = new Map<number, { v: RAPIER.Vector; w: RAPIER.Vector }>();

  constructor(private readonly rapier: RAPIER.World) {}

  addRegion(id: string, root: THREE.Object3D, poles: Pole[], movables: Movable[]): void {
    root.updateMatrixWorld(true);
    const byspace = new Map<string, THREE.Object3D[]>();
    root.traverse((o) => {
      const s = String(o.userData.space ?? '').toLowerCase();
      if (s) (byspace.get(s) ?? byspace.set(s, []).get(s)!).push(o);
    });
    const ps: PoleState[] = poles.map((def, i) => {
      const key = `${id}:${def.space}:${i}`;
      const st: PoleState = {
        def,
        colliders: [],
        visuals: (byspace.get(def.space) ?? []).map((o) => ({ o, base: o.matrix.clone() })),
        down: false,
        fall: null,
        key,
      };
      const was = this.fallen.get(key);
      if (was) {
        st.down = true;
        this.tilt(st, was.axis, was.to);
      } else st.colliders = this.poleColliders(def);
      return st;
    });
    this.poles.set(id, ps);
    this.movables.set(
      id,
      movables.map((def) => {
        const key = `${id}:${def.name}`;
        return { def, key, ...this.movableBody(def, key) };
      }),
    );
  }

  removeRegion(id: string): void {
    for (const s of this.poles.get(id) ?? []) for (const c of s.colliders) this.rapier.removeCollider(c, false);
    for (const m of this.movables.get(id) ?? []) {
      this.poses.set(m.key, { p: m.body.translation(), q: m.body.rotation() });
      this.rapier.removeRigidBody(m.body);
    }
    this.poles.delete(id);
    this.movables.delete(id);
  }

  /** Перед кроками фізики: швидкості тіл (імпульс удару — до зіткнення). */
  before(): void {
    this.prevVel.clear();
    this.rapier.bodies.forEach((b) => {
      if (b.isDynamic() && !b.isSleeping()) this.prevVel.set(b.handle, { v: b.linvel(), w: b.angvel() });
    });
  }

  /** Після кроків: удари по стовпах, падіння, візуал предметів. */
  after(dt: number): ObjectEvent[] {
    const ev: ObjectEvent[] = [];
    for (const list of this.poles.values())
      for (const s of list) {
        if (s.fall) {
          s.fall.t = Math.min(1, s.fall.t + dt / FALL_TIME);
          this.tilt(s, s.fall.axis, s.fall.to * s.fall.t * s.fall.t);
          if (s.fall.t >= 1) s.fall = null;
        }
        if (s.down || !s.colliders.length) continue;
        this.checkPole(s, ev);
      }
    for (const list of this.movables.values())
      for (const m of list) {
        if (m.body.isSleeping()) continue;
        const t = m.body.translation();
        const r = m.body.rotation();
        const w = new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
        m.def.object.matrix.multiplyMatrices(m.parentInv, w);
        m.def.object.matrixWorldNeedsUpdate = true;
      }
    return ev;
  }

  private checkPole(s: PoleState, ev: ObjectEvent[]): void {
    let hit: RAPIER.RigidBody | null = null;
    for (const c of s.colliders)
      this.rapier.contactPairsWith(c, (other) => {
        const b = other.parent();
        if (hit || !b || !b.isDynamic()) return;
        this.rapier.contactPair(c, other, (m) => {
          if (m.numContacts() > 0) hit = b;
        });
      });
    if (!hit) return;
    const body = hit as RAPIER.RigidBody;
    const pv = this.prevVel.get(body.handle);
    if (!pv) return;
    const v = new THREE.Vector3(pv.v.x, pv.v.y, pv.v.z);
    const P = body.mass() * v.length();
    const pmax = s.def.kind === 5 || s.def.kind === 6 ? 40000 : 20000;
    ev.push({ sound: s.def.kind === 5 || s.def.kind === 6 ? 'hit_ironpillar' : 'hit_sign', volume: Math.min(1, P / pmax) });
    if (P < MIN_P) return;
    const phi = Math.min(PHI_MAX, ((P - MIN_P) * 1.5394) / (pmax - MIN_P));
    // Напрям удару в координатах гри (горизонтальний); вісь повороту — угору × напрям.
    const dir = new THREE.Vector3(v.x, -v.z, 0);
    if (dir.lengthSq() < 1e-6) return;
    dir.normalize();
    const axis = new THREE.Vector3(-dir.y, dir.x, 0);
    if (phi <= Math.PI / 3) {
      this.tilt(s, axis, phi);
      return;
    }
    // Повалено: колізія зникає, машина їде далі, втративши частину швидкості.
    s.down = true;
    for (const c of s.colliders) this.rapier.removeCollider(c, true);
    s.colliders = [];
    const to = 0.98 * PHI_MAX;
    s.fall = { axis, to, t: 0 };
    this.fallen.set(s.key, { axis, to });
    const A = (pmax - MIN_P) * PHI_MAX * 0.6496;
    if (A < P) {
      const k = 1 - A / P;
      body.setLinvel({ x: pv.v.x * k, y: pv.v.y * k, z: pv.v.z * k }, true);
      body.setAngvel({ x: pv.w.x * k, y: pv.w.y * k, z: pv.w.z * k }, true);
    }
  }

  /** Нахил видимих обʼєктів простору навколо його початку (основа стовпа), кут φ навколо горизонтальної осі. */
  private tilt(s: PoleState, axis: THREE.Vector3, phi: number): void {
    const p = new THREE.Vector3().setFromMatrixPosition(s.def.matrix);
    const rot = new THREE.Matrix4().makeTranslation(p.x, p.y, p.z).multiply(new THREE.Matrix4().makeRotationAxis(axis, phi)).multiply(new THREE.Matrix4().makeTranslation(-p.x, -p.y, -p.z));
    for (const v of s.visuals) {
      v.o.matrix.multiplyMatrices(rot, v.base);
      v.o.matrixWorldNeedsUpdate = true;
    }
  }

  /** Колізія стовпа: брус уздовж кожного відрізка ламаної (координати three.js). */
  private poleColliders(def: Pole): RAPIER.Collider[] {
    const out: RAPIER.Collider[] = [];
    const pts = def.points.length === 1 ? [def.points[0], def.points[0].clone().add(new THREE.Vector3(0.01, 0, 0))] : def.points;
    for (let i = 0; i + 1 < pts.length; i++) {
      const a = g2t(pts[i]);
      const b = g2t(pts[i + 1]);
      const len = Math.max(0.1, a.distanceTo(b));
      const mid = a.clone().add(b).multiplyScalar(0.5).setY(Math.min(a.y, b.y) + def.height / 2);
      const yaw = Math.atan2(-(b.z - a.z), b.x - a.x);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
      out.push(
        this.rapier.createCollider(
          RAPIER.ColliderDesc.cuboid(len / 2 + def.radius, def.height / 2, def.radius)
            .setTranslation(mid.x, mid.y, mid.z)
            .setRotation(q)
            .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        ),
      );
    }
    return out;
  }

  /** Тверде тіло предмета: поза — з матриці екземпляра (чи збережена), форма — габарит моделі. */
  private movableBody(def: Movable, key: string): { body: RAPIER.RigidBody; parentInv: THREE.Matrix4 } {
    const o = def.object;
    const parent = o.parent!;
    parent.updateMatrixWorld(true);
    const parentInv = parent.matrixWorld.clone().invert();
    const world = parent.matrixWorld.clone().multiply(o.matrix);
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    world.decompose(pos, quat, new THREE.Vector3());
    const saved = this.poses.get(key);
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(saved?.p.x ?? pos.x, saved?.p.y ?? pos.y, saved?.p.z ?? pos.z)
      .setRotation(saved?.q ?? { x: quat.x, y: quat.y, z: quat.z, w: quat.w })
      .setCanSleep(true);
    const body = this.rapier.createRigidBody(desc);
    // Габарит моделі в її локальних координатах (координати гри: z — угору).
    const box = new THREE.Box3();
    const inv = o.matrixWorld.clone().invert();
    o.traverse((m) => {
      if (!(m instanceof THREE.Mesh)) return;
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(m.geometry.boundingBox!.clone().applyMatrix4(inv.clone().multiply(m.matrixWorld)));
    });
    const size = box.getSize(new THREE.Vector3());
    const c = box.getCenter(new THREE.Vector3());
    const mass = MASS[def.type];
    const shape = ROUND.test(def.type)
      ? RAPIER.ColliderDesc.cylinder(size.z / 2, Math.max(size.x, size.y) / 2).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))
      : RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
    this.rapier.createCollider(
      shape
        .setTranslation(c.x, c.y, c.z)
        .setMass(mass)
        .setFriction(0.6)
        .setRestitution(0.1)
        .setCollisionGroups(groups(GROUP_MOVABLE, 0xffff)),
      body,
    );
    if (!saved) body.sleep();
    return { body, parentInv };
  }

  dispose(): void {
    for (const id of [...this.poles.keys()]) this.removeRegion(id);
  }
}
