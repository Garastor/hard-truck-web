import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Ht2Roads, RoadLine } from '../world/roads';

/**
 * ДТП машини гравця (king.exe 0x4cfe70 + класифікатор ПДР 0x54f040; re/notes/ht2/police.md §2).
 *
 * Зіткнення: тіло-партнер (динамічне) змінило швидкість на Δv ∈ [3; 100] м/с (у king.exe — стрибок швидкості
 * partner, 2…3 — без запису). Код порушення стосується лише гравця (класифікатор не зʼясовує, хто винен):
 * 1 зустрічна, 2 перестроювання, 3 задній хід, 4 стоянка, 5 суцільна, 6 «наїхав» (RoadHog); 0 — штрафу немає.
 * Сума d = 5000·f + 1000 (f — накопичене пошкодження партнера; у порту — сила цього удару
 * √((Δv − 3)·маса·2,5e−5), обмежена 1 — гіпотеза: пошкоджень машин трафіку в порту немає); міліція → 2d завжди,
 * інша машина → d, лише якщо міліція ближче 200 м. Порушення (біти) — разом із сумою.
 * Після класифікації — пауза 10 с (без коду — 10 + |v|/3 с); через 180 с після останньої ДТП штраф і біти
 * забуваються.
 */
const DV_MIN = 3;
const DV_MAX = 100;
const HOLD = 10;
const FORGET = 180;
const D_BASE = 1000;
const D_PER_F = 5000;

/** Код порушення → біт картки 14 (VIOLATIONS у law.ts). */
export const CODE_BIT: Record<number, number> = { 1: 1, 2: 0x10, 3: 2, 4: 4, 5: 8, 6: 0x20 };

export interface ClassifyInput {
  /** Центр машини, вісь уперед (горизонтальна), швидкість, м/с. */
  pos: THREE.Vector3;
  forward: THREE.Vector3;
  vel: THREE.Vector3;
  /** Точки кузова (кути), у світі. */
  corners: THREE.Vector3[];
  /** Найближча вісь дороги гравця й точка на ній (null — поза дорогами). */
  axis: RoadLine | null;
  axisPoint: THREE.Vector3 | null;
  /** Партнер на тій самій дорозі (той самий сегмент чи сусідній через вузол). */
  sameRoad: boolean;
  /** Швидкість партнера до удару. */
  partnerVelBefore: THREE.Vector3;
  /** Чи є машина, що стоїть попереду в смузі гравця (тоді стоянка — черга, не порушення; гіпотеза). */
  queueAhead: boolean;
}

/** Класифікатор ПДР (0x54f040) для машини гравця в момент удару; 0 — порушення немає. */
export function classify(c: ClassifyInput): number {
  const speed = Math.hypot(c.vel.x, c.vel.z);
  const fwd = c.forward.clone().setY(0).normalize();
  let code = 0;
  if (c.axis && c.axisPoint && c.sameRoad && !(c.axis.flags & 0x30)) {
    const hw = c.axis.width / 2;
    // Дотична осі в найближчій точці.
    let t = new THREE.Vector3(0, 0, -1);
    let best = Infinity;
    for (let i = 0; i + 1 < c.axis.pts.length; i++) {
      const a = c.axis.pts[i];
      const b = c.axis.pts[i + 1];
      const mid = a.clone().lerp(b, 0.5);
      const d = Math.hypot(mid.x - c.axisPoint.x, mid.z - c.axisPoint.z) - a.distanceTo(b) / 2;
      if (d < best) {
        best = d;
        t = b.clone().sub(a).setY(0).normalize();
      }
    }
    // n — нормаль до осі в бік руху; lane — напрям руху тієї половини, де центр машини (правосторонній рух).
    const right = new THREE.Vector3(-t.z, 0, t.x);
    const rel = c.pos.clone().sub(c.axisPoint).setY(0);
    const lane = rel.dot(right) >= 0 ? t.clone() : t.clone().negate();
    const n = right.clone();
    if (n.dot(fwd) < 0) n.negate();
    const dist = Math.hypot(rel.x, rel.z);
    const lim = hw + 2;
    // Точки кузова: бічна координата відносно осі; цикл до першої точки на дорозі (як у king.exe).
    let onRoad = false;
    let fMin = Infinity;
    let fMax = -Infinity;
    for (const p of c.corners) {
      const f = n.dot(c.axisPoint.clone().sub(p).setY(0));
      fMin = Math.min(fMin, f);
      fMax = Math.max(fMax, f);
      if (c.axis.flags & 12 ? f > -lim && f < 2 : Math.abs(f) < lim) {
        onRoad = true;
        break;
      }
    }
    if (onRoad) {
      const main = c.axis.cls <= 1;
      const vdir = speed > 1e-3 ? c.vel.clone().setY(0).normalize() : fwd;
      if (speed > 1) {
        if (fwd.dot(lane) <= 0 && dist > 1.5 && main) code = 1;
        else if (vdir.dot(fwd) < -0.8) code = 3;
        else if (fwd.dot(lane) <= 0.8 || vdir.dot(lane) <= 0.8) code = 2;
        else if (main && fMax > 0.3 && fMin < 0) code = 5;
      } else if (fwd.dot(lane) <= 0.8) code = 4;
      else if (Math.trunc((hw - dist) / 3) > 0 && !c.queueAhead) code = 4;
    }
  }
  if (!code) {
    // «Наїхав»: гравець швидший за партнера, а той стояв чи їхав у той самий бік.
    const pv = c.partnerVelBefore;
    const pSpeed2 = pv.x * pv.x + pv.z * pv.z;
    if (speed * speed > pSpeed2 && (Math.sqrt(pSpeed2) <= 5 || pv.x * fwd.x + pv.z * fwd.z >= 0)) code = 6;
  }
  return code;
}

/** З ким зіткнулися (будує гра): міліція, машина (трафік, суперник) — з масою; інше — null (не ДТП). */
export interface PartnerInfo {
  kind: 'police' | 'car';
  mass: number;
}

export interface AccidentHooks {
  world: RAPIER.World;
  roads: Ht2Roads;
  /** Тіла гравця (тягач, причіп) і стан тягача. */
  player(): { bodies: RAPIER.RigidBody[]; pos: THREE.Vector3; forward: THREE.Vector3; vel: THREE.Vector3; corners: THREE.Vector3[] };
  /** Динамічні тіла, які можуть бути партнерами (їхню швидкість до удару треба памʼятати). */
  candidates(): RAPIER.RigidBody[];
  partner(body: RAPIER.RigidBody): PartnerInfo | null;
  /** Машина, що стоїть попереду гравця в його смузі ближче 15 м (черга). */
  queueAhead(): boolean;
  policeNear(p: THREE.Vector3): boolean;
  /** Нарахувати: відшкодування й біти порушень (без коду не викликається). */
  fine(amount: number, bits: number): void;
  /** 180 с без ДТП — забути відшкодування й біти. */
  forget(): void;
}

export class Accidents {
  private prevVel = new Map<number, THREE.Vector3>();
  private hold = 0;
  private since = Infinity;
  /** Останній зареєстрований випадок (для перевірок). */
  last: { code: number; amount: number; partner: 'police' | 'car'; dv: number } | null = null;

  constructor(private readonly h: AccidentHooks) {}

  update(dt: number): void {
    this.hold -= dt;
    if (this.since < FORGET && (this.since += dt) >= FORGET) this.h.forget();
    const pl = this.h.player();
    const own = new Set(pl.bodies.map((b) => b.handle));
    // Партнери в контакті з тілами гравця.
    const touching = new Set<RAPIER.RigidBody>();
    for (const b of pl.bodies)
      for (let i = 0; i < b.numColliders(); i++)
        this.h.world.contactPairsWith(b.collider(i), (other) => {
          const ob = other.parent();
          if (!ob || own.has(ob.handle)) return;
          let hit = false;
          this.h.world.contactPair(b.collider(i), other, (m) => (hit ||= m.numContacts() > 0));
          if (hit) touching.add(ob);
        });
    for (const ob of touching) {
      if (this.hold > 0) break;
      const before = this.prevVel.get(ob.handle);
      if (!before) continue;
      const lv = ob.linvel();
      const dv = Math.hypot(lv.x - before.x, lv.y - before.y, lv.z - before.z);
      if (dv < DV_MIN || dv > DV_MAX) continue;
      const info = this.h.partner(ob);
      if (!info) continue;
      const near = this.h.roads.nearestAxis(pl.pos);
      const p = ob.translation();
      const pPos = new THREE.Vector3(p.x, p.y, p.z);
      const pAxis = this.h.roads.nearestAxis(pPos);
      const sameRoad = !!near && !!pAxis && (near.axis === pAxis.axis || [near.axis.startNode, near.axis.endNode].some((n) => n >= 0 && (n === pAxis.axis.startNode || n === pAxis.axis.endNode)));
      const code = classify({
        pos: pl.pos,
        forward: pl.forward,
        vel: pl.vel,
        corners: pl.corners,
        axis: near?.axis ?? null,
        axisPoint: near?.point ?? null,
        sameRoad,
        partnerVelBefore: before,
        queueAhead: this.h.queueAhead(),
      });
      if (!code) {
        this.hold = HOLD + Math.hypot(pl.vel.x, pl.vel.z) / 3;
        continue;
      }
      this.hold = HOLD;
      this.since = 0;
      const f = Math.min(1, Math.sqrt(Math.max(0, (dv - 3) * info.mass * 2.5e-5)));
      const d = D_PER_F * f + D_BASE;
      const amount = info.kind === 'police' ? 2 * d : this.h.policeNear(pl.pos) ? d : 0;
      this.last = { code, amount, partner: info.kind, dv };
      if (amount > 1) this.h.fine(amount, CODE_BIT[code]);
    }
    // Швидкості кандидатів — на наступний кадр (для стрибка при ударі).
    const next = new Map<number, THREE.Vector3>();
    for (const b of this.h.candidates()) {
      const lv = b.linvel();
      next.set(b.handle, new THREE.Vector3(lv.x, lv.y, lv.z));
    }
    this.prevVel = next;
  }
}
