import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { walk, type Block } from './engine/formats/b3d';
import { BALL_RADIUS } from './world/objects';

/**
 * Автобол (арена MTB, re/notes/ht2/tracks.md §3): поле 60 × 100 м, м'яч `anmobj0251000` (рухомий предмет — тверде
 * тіло-сфера, world/objects.ts), на периметрі 9 воріт — огорожі (блоки 20) з подією 2: дані — очки (f32) і ключ лампи
 * (`tbLamp<N>Key`). King.exe (0x52e540, 0x52e970, 0x576670): удар машини запам'ятовує «останнього, хто торкався»;
 * м'яч торкнувся воріт — йому очки, звук `ovation1Sound`, лампа воріт горить 2 с, м'яч — на 10 м вище старту з
 * нульовою швидкістю, «останній» скидається. 1000 очок — кінець гри для всіх.
 */
export const BALL_WIN = 1000;
/** Лампа воріт після гола, с (0x64b660). */
const LAMP_TIME = 2;
/** М'яч після гола — вище стартової точки, м (0x52e550). */
const RESET_LIFT = 10;
/** Запас торкання воріт до сфери, м (гіпотеза порту: огорожа — відрізок, м'яч упирається в неї поверхнею). */
const TOUCH = 0.3;

/** Ворота: відрізок на плані (координати гри), очки, ключ лампи. */
export interface Gate {
  name: string;
  a: [number, number];
  b: [number, number];
  points: number;
  lamp: string;
}

/** Ворота Автобола в блоках арени: огорожі (20) з подією 2; дані — f32 очок і рядок ключа лампи. */
export function readGates(blocks: Block[]): Gate[] {
  const out: Gate[] = [];
  for (const [b] of walk(blocks)) {
    const d = b.data;
    if (d.t !== 20 || d.trigger.i1 !== 2 || d.trigger.values.length < 2 || d.points.length < 2) continue;
    const v = new Uint32Array(Array.from(d.trigger.values));
    const points = new Float32Array(v.buffer, 0, 1)[0];
    const bytes = new Uint8Array(v.buffer, 4);
    let lamp = '';
    for (const c of bytes) {
      if (!c) break;
      lamp += String.fromCharCode(c);
    }
    const [p, q] = [d.points[0], d.points[d.points.length - 1]];
    out.push({ name: b.name ?? '', a: [p[0], p[1]], b: [q[0], q[1]], points, lamp });
  }
  return out;
}

/** Відстань від точки (x, y) до відрізка a→b на плані. */
export function segmentDistance(x: number, y: number, a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l2)) : 0;
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

/**
 * Розстановка Автобола (0x572208): гравець з номером i — x = −20 (парний) / +20 (непарний), y = 10·i − 40 (гра),
 * обличчям до середини поля (курс ∓90°).
 */
export function ballSlot(i: number): { x: number; y: number; dir: [number, number] } {
  return { x: i % 2 ? 20 : -20, y: 10 * i - 40, dir: i % 2 ? [-1, 0] : [1, 0] };
}

export interface BallEvents {
  /** Гол (у господаря / без мережі): хто забив (номер машини), ворота (індекс у gates). */
  onGoal(id: number, gate: number): void;
  /** Увімкнути чи вимкнути лампу воріт (перемикач світу). */
  setLamp(key: string, on: boolean): void;
}

export class BallGame {
  /** Номер машини, що торкалася м'яча останньою (−1 — ніхто). */
  last = -1;
  /** Лампи, що горять: ключ → скільки ще секунд. */
  private readonly lamps = new Map<string, number>();
  private readonly start: THREE.Vector3;

  constructor(
    private readonly rapier: RAPIER.World,
    readonly body: RAPIER.RigidBody,
    readonly gates: Gate[],
    private readonly ev: BallEvents,
  ) {
    const t = body.translation();
    this.start = new THREE.Vector3(t.x, t.y, t.z);
    for (const g of gates) ev.setLamp(g.lamp, false);
  }

  /** Центр м'яча (Three.js). */
  get pos(): THREE.Vector3 {
    const t = this.body.translation();
    return new THREE.Vector3(t.x, t.y, t.z);
  }

  /**
   * Після кроку фізики (господар чи гра без мережі): хто торкається м'яча (cars — тіло → номер машини), чи м'яч
   * у воротах.
   */
  step(cars: Map<number, number>): void {
    const ball = this.body.collider(0);
    if (!ball) return;
    this.rapier.contactPairsWith(ball, (other) => {
      const id = cars.get(other.parent()?.handle ?? -1);
      if (id === undefined) return;
      this.rapier.contactPair(ball, other, (m) => {
        if (m.numContacts() > 0) this.last = id;
      });
    });
    const p = this.body.translation();
    const x = p.x;
    const y = -p.z;
    const i = this.gates.findIndex((g) => segmentDistance(x, y, g.a, g.b) < BALL_RADIUS + TOUCH);
    if (i < 0) return;
    const who = this.last;
    this.reset();
    // Без «останнього» (м'яч сам докотився) — без очок, але м'яч повертається (0x52e970).
    if (who >= 0) this.ev.onGoal(who, i);
  }

  /** Лампа воріт (і в гостей — за повідомленням про гол). */
  lightGate(i: number): void {
    const g = this.gates[i];
    if (!g) return;
    this.lamps.set(g.lamp, LAMP_TIME);
    this.ev.setLamp(g.lamp, true);
  }

  /** М'яч — на 10 м вище стартової точки, без швидкості; «останній» скидається. */
  reset(): void {
    this.body.setTranslation({ x: this.start.x, y: this.start.y + RESET_LIFT, z: this.start.z }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.last = -1;
  }

  /** Лампи гаснуть через 2 с. */
  update(dt: number): void {
    for (const [k, left] of this.lamps) {
      if (left - dt > 0) this.lamps.set(k, left - dt);
      else {
        this.lamps.delete(k);
        this.ev.setLamp(k, false);
      }
    }
  }
}
