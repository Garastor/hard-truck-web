import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '../engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '../engine/physics/world';
import type { SceneAssembler } from '../engine/render/sceneBuilder';
import type { Place } from './presents';
import { toThree } from '../world/world';

/**
 * Схованки на вузлах `pos_hidden_*` (king.exe updatePresents 0x41d340, re/notes/ht2/trailers-bodies.md §10):
 * - **контейнер** (present 0x40, модель AnmObj0231 з COMMON.B3D) — «складське» замовлення: товар рівномірно серед
 *   легальних не-паливних, склад призначення — будь-який, що приймає товар; гравець бере його, під'їхавши ближче 20 м
 *   (вікно «ЗАКАЗ», підтвердження VVK_BUY): вантаж іде в кузов чи причіп, контейнер зникає;
 * - **паливо** (0x10, AnmObj0241 — цистерна-обʼєкт) — лише модель, взяти неможливо (декорація).
 * Ліміти — `containers` і `fuel` з GAME.CNF (кар'єра — по 10; без CNF — 5 і 2). Спільний пул місць; на старті — до
 * ліміту будь-де, далі задача раз на 7 с ставить нові на вільних місцях не ближче 700 м від гравця. Взятий контейнер
 * звільняє місце, тож схованки **відновлюються** (як в оригіналі; на те саме місце — лише коли гравець відʼїде).
 *
 * Гіпотези порту: обʼєкт нерухомий (в оригіналі — рухомий ящик 10 т, `_MovingBox`); курс — носом до найближчої дороги,
 * у вузлах з ORTN (bb02) — за вузлом; вибір виду при підборі місця — спершу паливо, потім контейнери (порядок exe).
 */
export type CacheKind = 'container' | 'fuel';

/** Вантаж контейнера: товар (ID merchandise) і склад призначення. */
export interface CacheLot {
  goods: string;
  to: number;
}

export interface SavedCache {
  kind: CacheKind;
  place: string;
  lot?: CacheLot;
}

export interface Cache {
  kind: CacheKind;
  place: Place;
  lot?: CacheLot;
  model: { root: THREE.Object3D; body: RAPIER.RigidBody; grounded: boolean } | null;
}

export interface CachesCtx {
  scene: THREE.Scene;
  rapier: RAPIER.World;
  common: SceneAssembler;
  /** Найближча точка дороги (Three.js) — курс «носом до дороги». */
  roadPoint: (p: THREE.Vector3) => THREE.Vector3 | null;
}

const MODEL: Record<CacheKind, string> = { container: 'AnmObj0231', fuel: 'AnmObj0241' };
/** Період дозаповнення (0x41ed50) і найменша відстань нового місця від гравця, с і м. */
const PERIOD = 7;
const MIN_DIST = 700;
/** Модель і колізія — ближче цієї відстані від гравця, м. */
const MODEL_RANGE = 350;
/** Підбір контейнера — ближче, м (0x64c32c, між центрами). */
export const CACHE_PICK_RANGE = 20;

/** Місця схованок: вузли `pos_hidden_*` (62 у світі). */
export function hiddenPlaces(ways: Iterable<{ way: { rooms: { nodes: { name: string; pos: [number, number, number]; orient?: number[] }[] }[] } }>): Place[] {
  const out: Place[] = [];
  for (const r of ways)
    for (const room of r.way.rooms)
      for (const n of room.nodes)
        if (/^pos_hidden_/i.test(n.name)) {
          const o = n.orient;
          const forward = o && o.length >= 6 ? toThree(o[3], o[4], o[5]).setY(0) : undefined;
          out.push({ name: n.name, pos: toThree(...n.pos), fuel: false, ...(forward && forward.lengthSq() > 1e-6 ? { forward: forward.normalize() } : {}) });
        }
  return out;
}

export class Caches {
  readonly list: Cache[] = [];
  private timer = 0;
  private start = true;

  constructor(
    private readonly ctx: CachesCtx,
    private readonly places: Place[],
    private readonly limits: Record<CacheKind, number>,
    /** Вантаж для нового контейнера (null — товару чи складу немає: місце лишається порожнім). */
    private readonly lot: (p: Place) => CacheLot | null,
    private readonly rnd: () => number = Math.random,
  ) {}

  snapshot(): SavedCache[] {
    return this.list.map((c) => ({ kind: c.kind, place: c.place.name, ...(c.lot ? { lot: c.lot } : {}) }));
  }

  /** Відновити зі збереження (як presents у king.exe, §9); далі — без стартового заповнення. */
  restore(saved: SavedCache[]): void {
    const byName = new Map(this.places.map((p) => [p.name, p]));
    for (const s of saved) {
      const place = byName.get(s.place);
      if (place && !this.list.some((c) => c.place === place)) this.list.push({ kind: s.kind, place, ...(s.lot ? { lot: s.lot } : {}), model: null });
    }
    if (saved.length) this.start = false;
  }

  /** Крок: дозаповнення (на старті — будь-де, далі раз на 7 с не ближче 700 м), моделі поблизу гравця. */
  update(player: THREE.Vector3, dt: number): void {
    if (this.start || (this.timer -= dt) <= 0) {
      this.timer = PERIOD;
      const min = this.start ? 0 : MIN_DIST;
      for (const kind of ['fuel', 'container'] as const) {
        for (let n = this.list.filter((c) => c.kind === kind).length; n < this.limits[kind]; n++) {
          const used = new Set(this.list.map((c) => c.place));
          const free = this.places.filter((p) => !used.has(p) && p.pos.distanceTo(player) >= min);
          if (!free.length) break;
          const place = free[Math.floor(this.rnd() * free.length)];
          const lot = kind === 'container' ? this.lot(place) : null;
          if (kind === 'container' && !lot) break;
          this.list.push({ kind, place, ...(lot ? { lot } : {}), model: null });
        }
      }
      this.start = false;
    }
    for (const c of this.list) {
      const near = c.place.pos.distanceTo(player) < MODEL_RANGE;
      if (near && !c.model) this.build(c);
      else if (!near && c.model) this.unbuild(c);
      if (c.model && !c.model.grounded) this.settle(c);
    }
  }

  /** Контейнер з вантажем ближче CACHE_PICK_RANGE (з моделлю), найближчий. */
  near(pos: THREE.Vector3): Cache | null {
    let best: Cache | null = null;
    let bd = CACHE_PICK_RANGE;
    for (const c of this.list) {
      if (c.kind !== 'container' || !c.lot || !c.model) continue;
      const d = c.model.root.position.distanceTo(pos);
      if (d < bd) (bd = d), (best = c);
    }
    return best;
  }

  /** Взяти (pickPresent 0x41f0d0): обʼєкт зникає, місце звільняється — пізніше там може стати новий. */
  take(c: Cache): void {
    const i = this.list.indexOf(c);
    if (i < 0) return;
    this.unbuild(c);
    this.list.splice(i, 1);
  }

  private build(c: Cache): void {
    const tpl = this.ctx.common.template(MODEL[c.kind]);
    if (!tpl) return;
    const model = tpl.clone();
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model);
    const root = new THREE.Group();
    root.add(frame);
    root.updateMatrixWorld(true);
    const box = visibleBox(model);
    frame.position.y = -box.min.y;
    // Курс: з ORTN вузла, інакше носом до найближчої дороги (§7/§8 нотаток).
    const road = this.ctx.roadPoint(c.place.pos);
    const dir = c.place.forward?.clone() ?? (road ? road.clone().sub(c.place.pos).setY(0) : new THREE.Vector3(0, 0, -1));
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.normalize(), new THREE.Vector3(0, 1, 0)));
    root.position.copy(c.place.pos);
    root.updateMatrixWorld(true);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const q = root.quaternion;
    const body = this.ctx.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(root.position.x, root.position.y, root.position.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }));
    this.ctx.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y - box.min.y, center.z)
        .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
      body,
    );
    this.ctx.scene.add(root);
    c.model = { root, body, grounded: false };
    this.settle(c);
  }

  /** На ґрунт: промінь донизу з-над вузла (колізії регіону зʼявляються лише біля машин — до того висота вузла). */
  private settle(c: Cache): void {
    const m = c.model!;
    const p = c.place.pos;
    const from = { x: p.x, y: p.y + 6, z: p.z };
    const hit = this.ctx.rapier.castRay(new RAPIER.Ray(from, { x: 0, y: -1, z: 0 }), 60, true, RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC, undefined, undefined, m.body);
    if (!hit) return;
    m.root.position.y = from.y - hit.timeOfImpact;
    m.root.updateMatrixWorld(true);
    const t = m.root.position;
    m.body.setTranslation({ x: t.x, y: t.y, z: t.z }, true);
    m.grounded = true;
  }

  private unbuild(c: Cache): void {
    if (!c.model) return;
    this.ctx.scene.remove(c.model.root);
    this.ctx.rapier.removeRigidBody(c.model.body);
    c.model = null;
  }

  dispose(): void {
    for (const c of this.list) this.unbuild(c);
    this.list.length = 0;
  }
}
