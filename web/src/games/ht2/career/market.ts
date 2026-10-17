import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildTruckModel, visibleBox } from '../engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '../engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import type { TechRecord } from '../formats/tech';
import { drivable, truckDef, type Ht2Trucks } from '../vehicles/trucks';
import { toThree } from '../world/world';
import { ukName } from '../ui/uk';
import { recolor } from '../traffic/traffic';

/**
 * Ринки вантажівок HT2 — `parking` з `ENV/mod_<регіон>.sch`:
 * `(parking MARKET_AJ "Барахолка" 1 () ((node "node_car_0100") … (node "node_car_0104" 4 "Приозерск")) 10)` — назва,
 * номер, місця (вузли WAY), у вузла з прапорцем 4 — назва міста. Записи з номером −1 (`hidden_car_*`, `old_car_*` —
 * схованки й старі машини) поки не використовуємо.
 *
 * Асортимент — гіпотеза порту за GAME.CNF (`forsale 25`, `forsale_used 5`): на кожному місці ринку — вантажівка
 * (з кузовом чи тягач), набір змінюється щодня гри (псевдовипадково за номером ринку й днем), кожна п'ята —
 * вживана: дешевше на 40 %, з пошкодженням 30 %.
 */
const SHOW_R = 450;
/** Замовлену машину приганяють на ринок далі цієї відстані від абонента, м (0x64b860). */
const DELIVERY_MIN = 500;
/** Вікно продажу (king.exe 0x56fc10): ближче 20 м до машини, що продається (без умови швидкості). */
const NEAR_R = 20;
const USED_DISCOUNT = 0.65;
const STOLEN_DISCOUNT = 0.45;
export const USED_DAMAGE = 0.3;

export interface Market {
  id: number;
  name: string;
  town: string;
  spots: { pos: THREE.Vector3; heading: THREE.Vector3 }[];
  /** Місце з прапорцем 4 (вузол з назвою міста) — туди приганяють замовлену машину (king.exe 0x433660); −1 — немає. */
  townSpot: number;
  /** Останнє число запису `parking` (поле ринку +0x30, типово 4): плата за доставку замовленої машини — N · 300 $. */
  fee: number;
}

/** Замовлена рацією машина (career/carOrder.ts): стоїть на місці ринку, доки її не куплять. */
export interface OrderedCar {
  market: number;
  spot: number;
  carNode: string;
  /** Фарбування — кластер TRUCKS.OVL з нуля. */
  cluster: number;
  stolen: boolean;
}

export interface ForSale {
  rec: TechRecord;
  used: boolean;
  /** Крадена (king.exe біт 2 машини, ціна × 0,45): без сканера не видно, міліція може вважати викраденою. */
  stolen?: boolean;
  price: number;
  spot: number;
  /** Фарбування замовленої машини (кластер з нуля). */
  cluster?: number;
  /** Замовлена рацією. */
  ordered?: boolean;
}

export function parseMarkets(mods: Iterable<{ sch: SExpr[] }>, ways: Iterable<{ way: Way }>): Market[] {
  const nodes = new Map<string, { pos: [number, number, number]; dir: THREE.Vector3 }>();
  for (const { way } of ways)
    for (const room of way.rooms)
      for (const n of room.nodes) {
        // Напрям — уздовж найближчого сегмента дороги кімнати.
        let dir = new THREE.Vector3(0, 0, -1);
        let best = Infinity;
        for (const s of room.segments)
          for (let i = 0; i + 5 < s.points.length; i += 3) {
            const d = Math.hypot(s.points[i] - n.pos[0], s.points[i + 1] - n.pos[1]);
            if (d < best) {
              best = d;
              dir = toThree(s.points[i + 3] - s.points[i], s.points[i + 4] - s.points[i + 1], 0).normalize();
            }
          }
        nodes.set(n.name.toLowerCase(), { pos: n.pos, dir });
      }
  const out: Market[] = [];
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'parking' || num(e[3], -1) < 0 || !isList(e[5])) continue;
      // Частина назв у даних — «??» (не заповнені): показуємо «Ринок».
      const name = str(e[2]);
      const m: Market = { id: num(e[3]), name: /^\?*$/.test(name) ? 'Ринок' : ukName(name), town: '', spots: [], townSpot: -1, fee: num(e[6], 4) };
      for (const n of e[5]) {
        if (!isList(n)) continue;
        const node = nodes.get(str(n[1]).toLowerCase());
        if (n.length > 3) m.town = ukName(str(n[3]));
        if (!node) continue;
        if (m.townSpot < 0 && num(n[2]) & 4) m.townSpot = m.spots.length;
        m.spots.push({ pos: toThree(...node.pos), heading: node.dir });
      }
      if (m.spots.length) out.push(m);
    }
  return out;
}

/** Псевдовипадкові числа з зерна (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Shown {
  market: Market;
  day: number;
  parts: { root: THREE.Object3D; body: RAPIER.RigidBody }[];
}

export class Markets {
  private readonly shown = new Map<number, Shown>();
  /** Продані сьогодні: `ринок:день:місце`. */
  private readonly sold = new Set<string>();
  /** Замовлені рацією машини (зберігаються в кар'єрі). */
  ordered: OrderedCar[] = [];

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly trucks: Ht2Trucks,
    readonly list: Market[],
    private readonly ground: (p: THREE.Vector3) => number,
  ) {}

  /** Що продається на ринку в цей день гри. */
  stock(m: Market, day: number): ForSale[] {
    const pool = drivable(this.trucks).filter((r) => !/^Storm/i.test(r.carNode));
    const rnd = seeded(m.id * 7919 + day * 104729);
    const out: ForSale[] = [];
    m.spots.forEach((_, spot) => {
      const rec = pool[Math.floor(rnd() * pool.length)];
      // Замовлена машина стоїть на своєму місці, доки її не куплять (king.exe 0x433b60: звичайна машина на продаж).
      const own = this.ordered.find((o) => o.market === m.id && o.spot === spot);
      const oRec = own && this.trucks.records.find((r) => r.carNode === own.carNode);
      if (own && oRec) {
        rnd(); // той самий порядок випадкових чисел — інші місця ринку не міняються
        out.push({ rec: oRec, used: false, stolen: own.stolen, price: Math.round(oRec.price * (own.stolen ? STOLEN_DISCOUNT : 1)), spot, cluster: own.cluster, ordered: true });
        return;
      }
      // Частки — як forsale 25 / forsale_used 5 / forsale_stolen 5 у GAME.CNF (гіпотеза: місце ринку — випадкове).
      const r = rnd();
      const used = r < 5 / 35;
      const stolen = !used && r < 10 / 35;
      if (!rec || this.sold.has(`${m.id}:${day}:${spot}`)) return;
      out.push({ rec, used, stolen, price: Math.round(rec.price * (used ? USED_DISCOUNT : stolen ? STOLEN_DISCOUNT : 1)), spot });
    });
    return out;
  }

  sell(m: Market, day: number, item: ForSale): void {
    this.sold.add(`${m.id}:${day}:${item.spot}`);
    if (item.ordered) this.ordered.splice(0, this.ordered.length, ...this.ordered.filter((o) => !(o.market === m.id && o.spot === item.spot)));
    this.hide(m.id);
  }

  /**
   * Куди пригнати замовлену машину (king.exe 0x433660): ринок з місцем-містом (прапорець 4) далі 500 м від абонента,
   * найближчий.
   */
  deliveryFor(from: THREE.Vector3): Market | null {
    let best: Market | null = null;
    let bd = Infinity;
    for (const m of this.list) {
      if (m.townSpot < 0) continue;
      const d = m.spots[m.townSpot].pos.distanceTo(from);
      if (d > DELIVERY_MIN && d < bd) {
        bd = d;
        best = m;
      }
    }
    return best;
  }

  /** Ринок, найближчий до точки (плата за доставку в продавця — N · 300 $ того ринку). */
  nearest(p: THREE.Vector3): Market | null {
    let best: Market | null = null;
    let bd = Infinity;
    for (const m of this.list)
      for (const s of m.spots) {
        const d = s.pos.distanceTo(p);
        if (d < bd) {
          bd = d;
          best = m;
        }
      }
    return best;
  }

  /** Поставити замовлену машину на місце-місто ринку (машину, що там стояла, прибирають — killPlayer 0x4466a0). */
  deliver(m: Market, car: Omit<OrderedCar, 'market' | 'spot'>): void {
    const spot = m.townSpot;
    this.ordered.splice(0, this.ordered.length, ...this.ordered.filter((o) => !(o.market === m.id && o.spot === spot)), { market: m.id, spot, ...car });
    this.hide(m.id);
  }

  /** Ринок, біля місць якого стоїть вантажівка. */
  at(p: THREE.Vector3): Market | null {
    return this.list.find((m) => m.spots.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < NEAR_R)) ?? null;
  }

  /**
   * Машина на продаж, ближча за 20 м до точки (king.exe 0x56fc10: щокадру обхід машин із прапорцем «продається» чи
   * «шукає роботу», відстань між машинами < 20 м — подія 0x12/0x18, вікно «ПРОДАЁТСЯ» / «ИЩУ РАБОТУ»; швидкість не
   * перевіряється). skip — модель, якої не показуємо (своя). Найближча з тих, що поруч.
   */
  nearSale(p: THREE.Vector3, day: number, skip?: string): { market: Market; item: ForSale } | null {
    let best: { market: Market; item: ForSale } | null = null;
    let bd = NEAR_R;
    for (const m of this.list) {
      if (!m.spots.some((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z) < NEAR_R + 5)) continue;
      for (const item of this.stock(m, day)) {
        if (item.rec.carNode === skip) continue;
        const d = m.spots[item.spot].pos.distanceTo(p);
        if (d < bd) {
          bd = d;
          best = { market: m, item };
        }
      }
    }
    return best;
  }

  /** Показати машини на ринках поблизу (і сховати далекі), день гри — для асортименту. */
  update(p: THREE.Vector3, day: number): void {
    for (const m of this.list) {
      const d = Math.min(...m.spots.map((s) => Math.hypot(s.pos.x - p.x, s.pos.z - p.z)));
      const cur = this.shown.get(m.id);
      if (cur && (d > SHOW_R * 1.2 || cur.day !== day)) this.hide(m.id);
      if (d < SHOW_R && !this.shown.has(m.id)) this.show(m, day);
    }
  }

  private show(m: Market, day: number): void {
    const parts: Shown['parts'] = [];
    for (const item of this.stock(m, day)) {
      const def = truckDef(this.trucks, item.rec);
      const model = def && buildTruckModel(this.trucks.asm, def, false);
      if (!model) continue;
      if (item.cluster) recolor(model.root, this.trucks, item.cluster + 1);
      const spot = m.spots[item.spot];
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      frame.add(model.root);
      const root = new THREE.Group();
      root.add(frame);
      root.updateMatrixWorld(true);
      const box = visibleBox(model.root);
      frame.position.y = -box.min.y;
      const at = spot.pos.clone();
      at.y = this.ground(spot.pos);
      root.position.copy(at);
      root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), spot.heading, new THREE.Vector3(0, 1, 0)));
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z).setRotation(root.quaternion));
      this.rapier.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setTranslation(center.x, center.y - box.min.y, center.z)
          .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        body,
      );
      this.scene.add(root);
      parts.push({ root, body });
    }
    this.shown.set(m.id, { market: m, day, parts });
  }

  private hide(id: number): void {
    const s = this.shown.get(id);
    if (!s) return;
    for (const p of s.parts) {
      this.scene.remove(p.root);
      this.rapier.removeRigidBody(p.body);
    }
    this.shown.delete(id);
  }

  dispose(): void {
    for (const id of [...this.shown.keys()]) this.hide(id);
  }
}
