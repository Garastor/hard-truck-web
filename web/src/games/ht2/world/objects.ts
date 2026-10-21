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
 * **Заправка** AnmObj0004: колонки `sharp_benzo_0…2` (вид 3, параметр — номер колонки), решта `sharp_benzo_*` —
 * нерухомі стовпи навісу. Удар колонки на швидкості ≥ 5 м/с підриває її, далі сусідні (із середньої — навмання вліво
 * чи вправо) через 4·i ± 1,5 с; перемикачі Benzo<k>Key → 1, BenzoKey → 1 (колізії колонок зникають), звук
 * blowgazstation2/3. Штраф 6200 і «злочинна недбалість» — якщо вдарив гравець, а станція була ціла (0x4dd2a0, 0x56f120).
 *
 * **Рухомі предмети** AnmObj0201…0209 (фургони, бочки, каністри) — тверді тіла з масами з vehicle.tech; від удару
 * відлітають і котяться, на місце не повертаються (поза зберігається, поки триває гра).
 *
 * Гіпотези порту: φmax = 0,9·π/2 (у exe 0,9·acos(…) — вектор не зʼясовано); падіння — за 0,5 с; колізія стовпа —
 * брус уздовж ламаної, товщина — подвоєний радіус блоку (не менше 0,1 м), висота — values[0]; форма предмета —
 * габарит моделі (exe — точки Corner_Mark і площини CollisionPlane). Поваленого ліхтаря гасне ореол (світла лампи в
 * порту немає), світлофора — перемикач TL_operative → 0.
 */
const MIN_P = 5000;
const PHI_MAX = 0.9 * (Math.PI / 2);
const FALL_TIME = 0.5;

export interface Pole {
  /** 1 знак, 4 світлофор, 5 радар, 6 ліхтар, 3 колонка заправки, 0 — нерухомий стовп навісу заправки. */
  kind: number;
  /** Імʼя видимого обʼєкта (без `e_`; для ліхтаря `<РЕГ>Fonar<nn>` — ореол `<РЕГ>Glow<nn>`). */
  name: string;
  /** Колонка заправки: номер 0…2 і ключ станції (простір екземпляра AnmObj0004). */
  column?: number;
  /** Радар (вид 5): номер камери AnmObj0003 (3010…), той самий, що в тригері камери (traffic/radars.ts). */
  radar?: number;
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
  // М'яч Автобола (арена MTB, Ball_0): запис 11 таблиці trash boxes vehicle.tech — 50 кг, сфера R 2,5 (objects.md).
  anmobj0251: 50,
};
/** М'яч: радіус сфери (vehicle.tech, trash box 11) і пружність відскоку (гіпотеза порту: у даних rubber 0,1 — для ящиків). */
export const BALL_RADIUS = 2.5;
const BALL_BOUNCE = 0.5;
/** Бочки й каністри — циліндри (восьмигранна призма в exe), решта — бруси. */
const ROUND = /^anmobj020[3-9]$/;

/**
 * Зламані радари (номери камер): удар P ≥ 5000 ставить радару прапорець `+0x128 |= 1` — він більше не фотографує й
 * не штрафує (king.exe 0x588090 → перевірка в 0x56ffd0; re/notes/ht2/objects.md). Читає traffic/radars.ts.
 */
export const brokenRadars = new Set<number>();

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
      if (sd.t !== 20 || !/^sharp/i.test(s.name)) continue;
      // Вказівники міст (`e_BAZ0080`…) у даних без події — в king.exe стоять як стіна; порт (на прохання
      // користувача) збиває їх, як дорожній знак (вид 1).
      const event = sd.trigger.values.length >= 2;
      if (event && (sd.trigger.values[1] & 0xffff) !== 2) continue;
      const kind = event ? sd.trigger.values[1] >>> 16 : 1;
      if (![1, 4, 5, 6].includes(kind)) continue;
      const h = asFloat(sd.trigger.values[0]);
      out.push({
        kind,
        name: d.object.replace(/^e_/i, ''),
        space: d.space.toLowerCase(),
        matrix: m,
        points: sd.points.map((p) => new THREE.Vector3(...p).applyMatrix4(m)),
        height: h > 0.5 && h < 30 ? h : 3,
        radius: Math.max(0.05, sd.trigger.i2 * 0.01),
        radar: kind === 5 && sd.trigger.values.length > 2 ? sd.trigger.values[2] | 0 : undefined,
      });
    }
  }
  // Заправки: колонки й стовпи навісу в шаблоні AnmObj0004 (COMMON), розставленому екземплярами.
  for (const [b] of walk(asm.b3d.blocks)) {
    const d = b.data;
    if (d.t !== 18 || !/^anmobj0004$/i.test(d.object)) continue;
    const tpl = find(d.object);
    const m = asm.space(d.space);
    if (!tpl || !m) continue;
    for (const [s] of walk([tpl])) {
      const sd = s.data;
      if (sd.t !== 20 || !/^sharp_benzo_/i.test(s.name)) continue;
      const v = sd.trigger.values;
      const column = v.length > 2 && (v[1] & 0xffff) === 2 && v[1] >>> 16 === 3 ? v[2] & 0xff : undefined;
      out.push({
        kind: column === undefined ? 0 : 3,
        name: b.name,
        column,
        space: d.space.toLowerCase(),
        matrix: m,
        points: sd.points.map((p) => new THREE.Vector3(...p).applyMatrix4(m)),
        height: 3,
        radius: Math.max(0.05, sd.trigger.i2 * 0.01),
      });
    }
  }
  return out;
}

/** Простори стовпів і рухомі предмети — поза злиттям нерухомої геометрії (позначка noMerge). */
export function markObjects(root: THREE.Object3D, poles: Pole[]): Movable[] {
  const spaces = new Set(poles.filter((p) => p.kind !== 0 && p.kind !== 3).map((p) => p.space));
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
  sound: string;
  volume: number;
  /** Підрив заправки: хто вдарив (тіло) і чи станція була ціла (штраф 6200). */
  benzo?: { body: number; intact: boolean };
  /** Вибух колонки: матриця станції й номер колонки (ефект mnBlow3 — world/blasts.ts). */
  blast?: { matrix: THREE.Matrix4; column: number };
}

interface Station {
  /** Підірвані колонки — біти 1 << k (як +0x1a0 у exe). */
  bits: number;
  queue: { column: number; at: number }[];
  time: number;
  /** Перемикачі в моделі екземпляра: імʼя → групи станів. */
  switches: Map<string, THREE.Object3D[]>;
  columns: PoleState[];
}

export class WorldObjects {
  private readonly poles = new Map<string, PoleState[]>();
  private readonly movables = new Map<string, MovableState[]>();
  /**
   * Пози рухомих предметів — переживають вивантаження регіону (як реєстр king.exe). Повалені й зламані стовпи й
   * підірвані заправки — ні: з поверненням у регіон стоять знову цілі (на прохання користувача; у king.exe — [Г] так
   * само, objects.md).
   */
  private readonly poses = new Map<string, { p: RAPIER.Vector; q: RAPIER.Rotation }>();
  private readonly prevVel = new Map<number, { v: RAPIER.Vector; w: RAPIER.Vector }>();
  private readonly stations = new Map<string, Station>();
  private glows = new Map<string, THREE.Object3D>();

  constructor(private readonly rapier: RAPIER.World) {
    brokenRadars.clear();
  }

  addRegion(id: string, root: THREE.Object3D, poles: Pole[], movables: Movable[]): void {
    root.updateMatrixWorld(true);
    const byspace = new Map<string, THREE.Object3D[]>();
    root.traverse((o) => {
      const s = String(o.userData.space ?? '').toLowerCase();
      if (s) (byspace.get(s) ?? byspace.set(s, []).get(s)!).push(o);
    });
    const ps: PoleState[] = poles.map((def, i) => ({
      def,
      colliders: this.poleColliders(def),
      visuals: (byspace.get(def.space) ?? []).map((o) => ({ o, base: o.matrix.clone() })),
      down: false,
      fall: null,
      key: `${id}:${def.space}:${i}`,
    }));
    this.poles.set(id, ps);
    root.getObjectByName('glows')?.children.forEach((g) => g.name && this.glows.set(g.name.toLowerCase(), g));
    for (const s of ps) {
      if (s.def.kind !== 3) continue;
      const key = `${id}:${s.def.space}`;
      let st = this.stations.get(key);
      if (!st) {
        const switches = new Map<string, THREE.Object3D[]>();
        for (const o of byspace.get(s.def.space) ?? [])
          o.traverse((x) => {
            const m = /^(benzo\d?key)#(\d+)$/i.exec(x.name);
            if (!m) return;
            const list = switches.get(m[1].toLowerCase()) ?? switches.set(m[1].toLowerCase(), []).get(m[1].toLowerCase())!;
            list[Number(m[2])] = x;
          });
        st = { bits: 0, queue: [], time: 0, switches, columns: [] };
        this.stations.set(key, st);
      }
      st.columns.push(s);
    }
    this.movables.set(
      id,
      movables.map((def) => {
        const key = `${id}:${def.name}`;
        return { def, key, ...this.movableBody(def, key) };
      }),
    );
  }

  removeRegion(id: string): void {
    for (const s of this.poles.get(id) ?? []) {
      for (const c of s.colliders) this.rapier.removeCollider(c, false);
      // Зламаний радар знову штрафує, коли регіон завантажиться наново.
      if (s.def.kind === 5 && s.def.radar !== undefined) brokenRadars.delete(s.def.radar);
    }
    for (const m of this.movables.get(id) ?? []) {
      this.poses.set(m.key, { p: m.body.translation(), q: m.body.rotation() });
      this.rapier.removeRigidBody(m.body);
    }
    this.poles.delete(id);
    this.movables.delete(id);
    for (const key of [...this.stations.keys()]) if (key.startsWith(`${id}:`)) this.stations.delete(key);
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
        if (s.down || !s.colliders.length || s.def.kind === 0) continue;
        if (s.def.kind === 3) this.checkColumn(s, ev);
        else this.checkPole(s, ev);
      }
    for (const st of this.stations.values()) {
      st.time += dt;
      for (const q of [...st.queue]) {
        if (q.at > st.time) continue;
        st.queue.splice(st.queue.indexOf(q), 1);
        if (st.bits & (1 << (2 * q.column))) continue;
        st.bits |= 1 << (2 * q.column);
        this.applyStation(st, st.bits);
        ev.push({ sound: q.column % 2 ? 'blowgazstation3' : 'blowgazstation2', volume: 1, blast: { matrix: st.columns[0].def.matrix, column: q.column } });
      }
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

  /** Тіло, що торкається колізій стовпа (динамічне). */
  private touching(s: PoleState): RAPIER.RigidBody | null {
    let hit: RAPIER.RigidBody | null = null;
    for (const c of s.colliders)
      this.rapier.contactPairsWith(c, (other) => {
        const b = other.parent();
        if (hit || !b || !b.isDynamic()) return;
        this.rapier.contactPair(c, other, (m) => {
          if (m.numContacts() > 0) hit = b;
        });
      });
    return hit;
  }

  /** Колонка заправки: удар ≥ 5 м/с — підрив і ланцюг до сусідніх. */
  private checkColumn(s: PoleState, ev: ObjectEvent[]): void {
    const st = [...this.stations.values()].find((x) => x.columns.includes(s));
    const k = s.def.column ?? 0;
    if (!st || st.bits & (1 << (2 * k)) || st.queue.length) return;
    const body = this.touching(s);
    const pv = body && this.prevVel.get(body.handle);
    if (!body || !pv || Math.hypot(pv.v.x, pv.v.y, pv.v.z) < 5) return;
    ev.push({ sound: 'blowgazstation2', volume: 1, benzo: { body: body.handle, intact: st.bits === 0 } });
    // Порядок: вдарена, далі сусідні; із середньої — навмання вліво чи вправо.
    const order = k === 1 ? (Math.random() < 0.5 ? [1, 0, 2] : [1, 2, 0]) : k === 0 ? [0, 1, 2] : [2, 1, 0];
    order.forEach((c, i) => st.queue.push({ column: c, at: st.time + (i === 0 ? 0 : 4 * i + (Math.random() * 2 - 1) * 1.5) }));
  }

  /** Стан заправки: перемикачі Benzo<k>Key, BenzoKey; колізії колонок зникають з першим вибухом. */
  private applyStation(st: Station, bits: number): void {
    st.bits = bits;
    const set = (name: string, on: boolean) => st.switches.get(name)?.forEach((o, i) => o && (o.visible = i === (on ? 1 : 0)));
    for (let k = 0; k < 3; k++) set(`benzo${k}key`, !!(bits & (1 << (2 * k))));
    set('benzokey', bits !== 0);
    if (bits)
      for (const c of st.columns) {
        for (const x of c.colliders) this.rapier.removeCollider(x, true);
        c.colliders = [];
        c.down = true;
      }
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
    this.breakPole(s);
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
    if (s.def.kind === 4) this.lightOff(s);
    const A = (pmax - MIN_P) * PHI_MAX * 0.6496;
    if (A < P) {
      const k = 1 - A / P;
      body.setLinvel({ x: pv.v.x * k, y: pv.v.y * k, z: pv.v.z * k }, true);
      body.setAngvel({ x: pv.w.x * k, y: pv.w.y * k, z: pv.w.z * k }, true);
    }
  }

  /**
   * Зламаний радар чи ліхтар (удар P ≥ 5000, king.exe 0x588090): радар більше не штрафує (brokenRadars), ліхтар
   * гасне — ореол `<РЕГ>Glow<nn>` ховається; перемикач `RadarHeadOn` / `FonarHeadOn` у моделі → 1 ([Г] розбита голова).
   */
  private breakPole(s: PoleState): void {
    if (s.def.kind !== 5 && s.def.kind !== 6) return;
    if (s.def.kind === 5 && s.def.radar !== undefined) brokenRadars.add(s.def.radar);
    if (s.def.kind === 6) this.glows.get(s.def.name.replace(/fonar/i, 'glow').toLowerCase())?.removeFromParent();
    for (const v of s.visuals)
      v.o.traverse((x) => {
        const m = /^(?:Radar|Fonar)HeadOn#(\d+)$/i.exec(x.name);
        if (m) x.visible = m[1] === '1';
      });
  }

  /** Повалений світлофор не працює: перемикач TL_operative → 0 (лампи без світла; king.exe 0x588090). */
  private lightOff(s: PoleState): void {
    for (const v of s.visuals)
      v.o.traverse((x) => {
        const m = /^TL_operative#(\d+)$/i.exec(x.name);
        if (m) x.visible = m[1] === '0';
      });
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
    const flat = pts.every((p) => Math.hypot(p.x - pts[0].x, p.y - pts[0].y) < 0.3);
    if (flat && pts.length > 1) {
      // Вертикальна ламана (колонки, стовпи навісу) — стовп від нижньої до верхньої точки.
      const z0 = Math.min(...pts.map((p) => p.z));
      const z1 = Math.max(...pts.map((p) => p.z));
      const c = g2t(new THREE.Vector3(pts[0].x, pts[0].y, (z0 + z1) / 2));
      return [
        this.rapier.createCollider(
          RAPIER.ColliderDesc.cuboid(def.radius, Math.max(0.2, (z1 - z0) / 2), def.radius)
            .setTranslation(c.x, c.y, c.z)
            .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        ),
      ];
    }
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
    const ball = def.type === 'anmobj0251';
    const shape = ball
      ? RAPIER.ColliderDesc.ball(BALL_RADIUS)
      : ROUND.test(def.type)
      ? RAPIER.ColliderDesc.cylinder(size.z / 2, Math.max(size.x, size.y) / 2).setRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2))
      : RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2);
    this.rapier.createCollider(
      shape
        .setTranslation(c.x, c.y, c.z)
        .setMass(mass)
        .setFriction(ball ? 0.3 : 0.6)
        .setRestitution(ball ? BALL_BOUNCE : 0.1)
        .setCollisionGroups(groups(GROUP_MOVABLE, 0xffff)),
      body,
    );
    if (!saved) body.sleep();
    return { body, parentInv };
  }

  /** Тіло рухомого предмета за іменем екземпляра (`anmobj0251000` — м'яч Автобола). */
  movable(name: string): { body: RAPIER.RigidBody; object: THREE.Object3D } | null {
    for (const list of this.movables.values()) for (const m of list) if (m.def.name === name) return { body: m.body, object: m.def.object };
    return null;
  }

  dispose(): void {
    for (const id of [...this.poles.keys()]) this.removeRegion(id);
  }
}
