import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildTruckModel, visibleBox } from '../engine/vehicle/trucks';
import { g2t } from '../engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import { recolor } from '../traffic/traffic';
import { toThree } from '../world/world';
import { truckDef, type Ht2Trucks } from './trucks';

/**
 * Напівпричепи-«подарунки» (presents) на базах — за king.exe (re/notes/ht2/trailers-bodies.md):
 * - типи — записи `semitrailer` з evehicles.sch: `SEMITRAILER1–6` (STrailerM, фарбування — кластер 0…5 TRUCKS.OVL),
 *   `SEMITANK1–4` (STrailerT, прапорець 1 — цистерна), `URAGAN_SEMITRAILER` (STrailerStorm, лише для «Шторма»);
 * - місця — вузли WAY `pos_base_*`; поки причепів менше за `semitrailers` з GAME.CNF (28), на вільному місці —
 *   зважений вибір (0x41eb80): 1 (Storm — 12) × вага типу (після кожного вибору ×0,75) × 2, якщо тягач гравця може
 *   його тягти × (цистерна ↔ «паливне» місце, інакше 0);
 * - причіп стоїть носом до найближчої точки дороги (вузли без ORTN, 0x41be60), на опорах (SupportKey 1);
 * - причепити (VVK_ATTACH_SEMITRAILER): лише тягачем без причепа, present ближче 30 м; сідло тягача від шворня
 *   причепа ≤ 10 м, висоти — ≤ 0,3 м, курси — скалярний добуток ≥ 0,2 (0x55f000); відчепити — та сама клавіша,
 *   причіп лишається на місці present'ом («кинутий»; прибирається, коли старший 1200 с і далі 5000 м від гравця).
 *
 * Гіпотези порту: «паливне» місце — ближче 150 м від вузла газгольдера (`(node … fuel)` без `unload` у mod_*.sch:
 * так стоять pos_base_0020/0021/bb12/cc00/cc01); вага типу — 1 (поле +0x70 не знайдено у файлах); presents — на
 * сесію, не в збереженні; причепи з вантажем на дорогах (`pos_road`, `missions 10`) ще не перенесено.
 */
export interface SemiKind {
  id: string;
  carNode: string;
  /** Фарбування — кластер TRUCKS.OVL з нуля (матеріали `…1` → `…N+1`). */
  cluster: number;
  tank: boolean;
}

/** Причіп гравця в кар'єрі (null — без причепа). */
export type TrailerChoice = Pick<SemiKind, 'id' | 'carNode' | 'cluster'>;

/** Типи напівпричепів з evehicles.sch: `(vehicle ID "Модель" кластер semitrailer none 0 101 () [1])`. */
export function semiKinds(sch: SExpr[]): SemiKind[] {
  return sch
    .filter((e): e is SExpr[] => isList(e) && e[0] === 'vehicle' && e[4] === 'semitrailer')
    .map((e) => ({ id: str(e[1]), carNode: str(e[2]), cluster: num(e[3]), tank: num(e[9]) === 1 }));
}

/** Вузли газгольдерів: `(node "імʼя" fuel)` без `unload` (АЗС — з `unload`). */
export function fuelNodes(mods: Iterable<{ sch: SExpr[] }>): Set<string> {
  const out = new Set<string>();
  const walk = (e: SExpr): void => {
    if (!isList(e)) return;
    if (e[0] === 'node' && e.includes('fuel') && !e.includes('unload')) out.add(str(e[1]).toLowerCase());
    else for (const c of e) walk(c);
  };
  for (const m of mods) m.sch.forEach(walk);
  return out;
}

export interface Place {
  name: string;
  /** Позиція (Three.js). */
  pos: THREE.Vector3;
  /** «Паливне» місце — лише для цистерн. */
  fuel: boolean;
}

/** Місця presents: вузли `pos_base_*`; «паливні» — ближче FUEL_REACH від газгольдера. */
export function basePlaces(ways: Iterable<{ way: { rooms: { nodes: { name: string; pos: [number, number, number] }[] }[] } }>, fuel: Set<string>): Place[] {
  const places: Place[] = [];
  const gas: THREE.Vector3[] = [];
  for (const r of ways)
    for (const room of r.way.rooms)
      for (const n of room.nodes) {
        if (/^pos_base_/i.test(n.name)) places.push({ name: n.name, pos: toThree(...n.pos), fuel: false });
        if (fuel.has(n.name.toLowerCase())) gas.push(toThree(...n.pos));
      }
  for (const p of places) p.fuel = gas.some((g) => Math.hypot(g.x - p.pos.x, g.z - p.pos.z) < FUEL_REACH);
  return places;
}

const FUEL_REACH = 150;
/** Причіп має модель і колізію ближче цієї відстані від гравця, м. */
const MODEL_RANGE = 350;
/** Пошук present'а для зчіпки, м (0x56ffd0). */
const PICK_RANGE = 30;
/** Умови зчіпки (0x55f000): відстань сідло — шворінь, різниця висот, косинус між курсами. */
const HITCH_DIST = 10;
const HITCH_DY = 0.3;
const HITCH_COS = 0.2;
/** Кинутий причіп прибирається, коли старший і далі від гравця (0x42a1c0), с і м. */
const STRAY_AGE = 1200;
const STRAY_FAR = 5000;
/** Множник ваги типу після кожного вибору (0x64b700). */
const WEIGHT_DECAY = 0.75;

export interface Present {
  kind: SemiKind;
  place: Place | null;
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  /** Час кидання (ігрові секунди) — для прибирання; null — на базі. */
  dropped: number | null;
  model: { visual: THREE.Group; body: RAPIER.RigidBody; kingpin: THREE.Vector3; topSaddle: THREE.Vector3; lift: number; grounded: boolean } | null;
}

export interface PresentsCtx {
  scene: THREE.Scene;
  rapier: RAPIER.World;
  trucks: Ht2Trucks;
  /** Найближча точка мережі доріг (Three.js) — курс причепа. */
  roadPoint: (p: THREE.Vector3) => THREE.Vector3 | null;
}

export class Presents {
  readonly list: Present[] = [];
  private readonly weight = new Map<string, number>();

  constructor(
    private readonly ctx: PresentsCtx,
    private readonly kinds: SemiKind[],
    private readonly places: Place[],
    private readonly limit = 28,
    private readonly rnd: () => number = Math.random,
  ) {
    for (const k of kinds) this.weight.set(k.id, 1);
  }

  /**
   * Крок: поповнення до ліміту (вільні місця), прибирання кинутих, моделі поблизу гравця. compatible — чи може
   * тягач гравця тягти тип (×2 до ваги); time — ігровий час, с.
   */
  update(player: THREE.Vector3, time: number, compatible: (k: SemiKind) => boolean): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      if (p.dropped !== null && time - p.dropped > STRAY_AGE && p.pos.distanceTo(player) > STRAY_FAR) this.remove(i);
    }
    const based = this.list.filter((p) => p.place).length;
    if (based < this.limit) {
      const used = new Set(this.list.map((p) => p.place));
      // Нове — лише поза полем зору гравця (поза зоною моделей), щоб причіп не зʼявлявся на очах.
      const free = this.places.filter((pl) => !used.has(pl) && pl.pos.distanceTo(player) > MODEL_RANGE);
      if (free.length) this.spawn(free[Math.floor(this.rnd() * free.length)], compatible);
    }
    for (const p of this.list) {
      const near = p.pos.distanceTo(player) < MODEL_RANGE;
      if (near && !p.model) this.build(p);
      else if (!near && p.model) this.unbuild(p);
      // Колізії регіону зʼявляються лише біля машин — поки ґрунту під причепом немає, висота з вузла WAY.
      if (p.model && !p.model.grounded) this.settle(p);
    }
  }

  /** Зважений вибір типу для місця (0x41eb80). */
  private spawn(place: Place, compatible: (k: SemiKind) => boolean): void {
    let sum = 0;
    const w = this.kinds.map((k) => {
      const base = /^STrailerStorm$/i.test(k.carNode) ? 12 : 1;
      const v = k.tank === place.fuel ? base * (this.weight.get(k.id) ?? 1) * (compatible(k) ? 2 : 1) * 32 : 0;
      sum += v;
      return v;
    });
    if (sum <= 0) return;
    let x = this.rnd() * sum;
    const i = Math.max(0, w.findIndex((v) => (x -= v) < 0));
    const kind = this.kinds[i];
    this.weight.set(kind.id, (this.weight.get(kind.id) ?? 1) * WEIGHT_DECAY);
    const road = this.ctx.roadPoint(place.pos);
    const forward = road ? road.clone().sub(place.pos).setY(0) : new THREE.Vector3(0, 0, -1);
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    this.list.push({ kind, place, pos: place.pos.clone(), forward: forward.normalize(), dropped: null, model: null });
  }

  /** Кинутий гравцем причіп — present на місці (позиція й курс причепа). */
  drop(kind: SemiKind, pos: THREE.Vector3, forward: THREE.Vector3, time: number): void {
    this.list.push({ kind, place: null, pos: pos.clone(), forward: forward.clone().setY(0).normalize(), dropped: time, model: null });
  }

  /**
   * Present для зчіпки: ближче 30 м, сідло тягача (світ) ≤ 10 м від шворня, висоти ≤ 0,3 м, курси — косинус ≥ 0,2.
   * Повертає present і причину відмови (для підказки).
   */
  hitchable(saddle: THREE.Vector3, forward: THREE.Vector3, compatible: (k: SemiKind) => boolean): { present: Present | null; why: 'far' | 'align' | 'type' | null } {
    let best: Present | null = null;
    let bestD = Infinity;
    for (const p of this.list) {
      if (!p.model) continue;
      const d = p.pos.distanceTo(saddle);
      if (d < PICK_RANGE && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best?.model) return { present: null, why: 'far' };
    if (!compatible(best.kind)) return { present: null, why: 'type' };
    const kp = best.model.kingpin;
    const flat = Math.hypot(kp.x - saddle.x, kp.z - saddle.z);
    const ok = flat <= HITCH_DIST && Math.abs(kp.y - saddle.y) <= HITCH_DY && best.forward.dot(forward.clone().setY(0).normalize()) >= HITCH_COS;
    return ok ? { present: best, why: null } : { present: null, why: flat > HITCH_DIST ? 'far' : 'align' };
  }

  take(p: Present): void {
    const i = this.list.indexOf(p);
    if (i >= 0) this.remove(i);
  }

  private remove(i: number): void {
    const p = this.list[i];
    if (p.model) this.unbuild(p);
    this.list.splice(i, 1);
  }

  /** Модель на опорах (SupportKey 1, логотипа немає) і нерухома коробка колізії. */
  private build(p: Present): void {
    const { trucks, scene, rapier } = this.ctx;
    const rec = trucks.records.find((r) => r.carNode.toLowerCase() === p.kind.carNode.toLowerCase());
    const def = rec && truckDef(trucks, rec);
    const model = def && buildTruckModel(trucks.asm, def, true);
    if (!rec || !model) return;
    if (p.kind.cluster > 0) recolor(model.root, trucks, p.kind.cluster + 1);
    model.setSwitch?.('SupportKey', 1);
    model.setSwitch?.('refer_IconKey', 0);
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model.root);
    const visual = new THREE.Group();
    visual.add(frame);
    visual.updateMatrixWorld(true);
    const box = visibleBox(model.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const yaw = Math.atan2(-p.forward.x, -p.forward.z);
    visual.rotation.y = yaw;
    // Стоїть на колесах (низ коліс — на ґрунті): шворінь — на висоті, як у зчепленого (опори — до землі).
    const wheelZ = model.wheelBase.reduce((s, m) => s + m.elements[14], 0) / Math.max(1, model.wheelBase.length);
    const lift = model.wheelBase.length ? rec.wheelRadius - wheelZ : -box.min.y;
    visual.position.set(p.pos.x, p.pos.y + lift, p.pos.z);
    visual.updateMatrixWorld(true);
    scene.add(visual);
    const q = visual.quaternion;
    const body = rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(visual.position.x, visual.position.y, visual.position.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
    rapier.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2).setTranslation(center.x, center.y, center.z), body);
    const topSaddle = g2t(rec.topSaddle);
    p.model = { visual, body, kingpin: topSaddle.clone().applyMatrix4(visual.matrixWorld), topSaddle, lift, grounded: false };
    this.settle(p);
  }

  /** Поставити на ґрунт: промінь донизу повз власну коробку; немає влучання — ще раз наступного кроку. */
  private settle(p: Present): void {
    const m = p.model!;
    const from = { x: p.pos.x, y: p.pos.y + 6, z: p.pos.z };
    const hit = this.ctx.rapier.castRay(new RAPIER.Ray(from, { x: 0, y: -1, z: 0 }), 60, true, undefined, undefined, undefined, m.body);
    if (!hit) return;
    const y = from.y - hit.timeOfImpact + m.lift;
    m.visual.position.y = y;
    m.visual.updateMatrixWorld(true);
    m.body.setTranslation({ x: m.visual.position.x, y, z: m.visual.position.z }, true);
    m.kingpin.copy(m.topSaddle).applyMatrix4(m.visual.matrixWorld);
    m.grounded = true;
  }

  private unbuild(p: Present): void {
    if (!p.model) return;
    this.ctx.scene.remove(p.model.visual);
    this.ctx.rapier.removeRigidBody(p.model.body);
    p.model = null;
  }

  dispose(): void {
    for (const p of this.list) this.unbuild(p);
    this.list.length = 0;
  }
}
