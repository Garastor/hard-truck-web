import * as THREE from 'three';
import type { ControlState } from '../engine/input/input';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import type { Oncoming } from '../engine/vehicle/autopilot';
import type { Ht2Roads, RoadLine } from '../world/roads';
import { decide, newMover, offAt, pathAhead, replan, retrace, sync, type Mover, type Obstacle } from './driver';
import { control, newPhysState, type PhysState } from './physical';

/**
 * Водій бота-далекобійника (traffic/truckers.ts) — той самий, що в машини трафіку (порт, на прохання користувача):
 * рішення — `driver.decide` (лідер і дистанція, обʼїзд того, хто стоїть, обгін, перестроювання перед поворотом,
 * пропуск на перехрестях, червоне світло, покажчики `turnSignal`), педалі й кермо — `physical.control`. Боту понад
 * трафік:
 * - маршрут рейсу (Mover.route = Freight.next): точна лінія після кожного стику до місця складу;
 * - зупинка на місці складу (halt): попереду ближче HALT_LOOK і ближче HALT_SIDE від осі → не швидше
 *   √(2·HALT_DECEL·залишок), стати центром за HALT_AT;
 * - розминання із зустрічною на базі й вузьких смугах (як було в AutoPilot): зустрічна попереду ближче PASS_LOOK і
 *   ближче PASS_SIDE убік → зсув праворуч PASS_SHIFT (не ближче PASS_EDGE до стіни, RoadLine.wallRight) ще PASS_HOLD с;
 *   на базі й смугах вужчих за SLOW_LANE — не швидше PASS_KMH. Зсув — бічним маневром водія (latGoal: S-крива, огляд
 *   смуги враховує його, покажчик праворуч);
 * - тягач з напівпричепом (Mover.tail — довжина позаду, bend — повільніше на кривих): у крутому повороті заходить
 *   ширше — точка керма зсувається назовні на OFFTRACK_K × зрізання кута причепом R − √(R² − L²) (R — радіус шляху
 *   біля точки керма, L — від шворня до осі причепа), не далі OUT_LANE смуги, а праворуч — не ближче PASS_EDGE до стіни
 *   (гіпотеза порту; у king.exe причепів у ботів немає);
 * - боковий запас: тіло збоку (від заду причепа до SIDE_LOOK с уперед) ближче за півширину бота + SIDE_OTHER від шляху,
 *   яким бот там буде (запланований маневр offAt), але не на ньому (ближче ON_PATH — це лідер, decide) → точка керма
 *   відходить від нього на нестачу (не більше SIDE_MAX, праворуч — не ближче PASS_EDGE до стіни): у смугах по 3 м
 *   тягач (3,3 м з дзеркалами), обʼїжджаючи сусідньою смугою, чіпляв того, хто стоїть не по центру своєї.
 * Лінії баз і вузьких смуг уже відсунуто від стін (roads.clearWalls) — водій їде по них, як і автопілот.
 */
const RETRACE = 8;
const PASS_LOOK = 70;
const PASS_SIDE = 6;
const PASS_COS = -0.5;
const PASS_SHIFT = 2.5;
const PASS_KMH = 20;
const PASS_HOLD = 1.5;
const PASS_LANE = 3.2;
const SLOW_LANE = 2.8;
const PASS_EDGE = 1.7;
const HALT_LOOK = 60;
const HALT_SIDE = 4;
const HALT_DECEL = 1.2;
const HALT_AT = 0.5;
/** Півширина іншої машини для ширини шляху бота (Mover.wide), м. */
const OTHER_HALF = 1.3;
/** Перестроюватися на обʼїзд раніше на стільки секунд ходу, ніж трафік (смуга в тягача — ≈ 4 с), с. */
const LANE_EARLY = 2.5;
/** Множник швидкості на кривих для тягача з причепом (driver.roadLimit). */
const TRAILER_BEND = 0.75;
/** Захід у поворот: частка зрізання, вікно кривизни (± м від точки керма), найбільше назовні (частка смуги), м/с зміни. */
const OFFTRACK_K = 1.0;
const OFFTRACK_WIN = 6;
const OUT_LANE = 0.8;
const OFFTRACK_RATE = 1.5;
/** Поворот, менший за стільки радіан на вікні, — не поворот. */
const OFFTRACK_MIN = 0.15;
/**
 * Боковий запас: від борту бота до центру тіла збоку (півширина іншого 1,4 + зазор), м; ближче — на шляху, м;
 * найбільший відступ, м; огляд уперед (не менше SIDE_AHEAD м), с; швидкість відступу, м/с.
 */
const SIDE_OTHER = 2;
const ON_PATH = 0.8;
const SIDE_MAX = 1.5;
const SIDE_LOOK = 3;
const SIDE_AHEAD = 10;
const SIDE_RATE = 2.5;
/** Точка керма — за стільки + 0,8·v м (physical.ts CARROT_MIN). */
const CARROT_MIN = 5;
/** Півдовжина точки-перешкоди (гравець, боти), м. */
export const POINT_HALF = 2.5;

export interface BotDriver {
  m: Mover;
  ps: PhysState;
  /** Цільова швидкість, м/с. */
  want: number;
  /** Де стати (місце складу); null — їхати далі. */
  halt: THREE.Vector3 | null;
  /** Скільки ще розминатися, с, і зсув розминання, заданий водію (0 — немає). */
  passing: number;
  squeeze: number;
  /** Від шворня до осі причепа, м (0 — без причепа). */
  reach: number;
  /** Зсув точки керма праворуч у повороті й від тіл збоку (згладжений), м. */
  shift: number;
  /** Півширина машини (з дзеркалами), м. */
  halfWidth: number;
}

/** Точки вздовж машини у світі: від заду до переду габариту, крайні — на 2 м всередину, крок не більше 4 м. */
export function alongPoints(v: TruckVehicle): THREE.Vector3[] {
  const g = v.lightGeometry;
  const a = g.frontZ + 2;
  const b = Math.max(a, g.backZ - 2);
  const n = Math.max(1, Math.ceil((b - a) / 4));
  v.visual.updateMatrix();
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) out.push(new THREE.Vector3(0, 0, a + ((b - a) * i) / n).applyMatrix4(v.visual.matrix));
  return out;
}

/** Водій на найближчій смузі; cruise — м/с; halfLen — від центру до переду, tail — ще позаду (причіп), reach — L причепа. */
export function newBot(roads: Ht2Roads, pos: THREE.Vector3, fwd: THREE.Vector3, cruise: number, halfLen: number, tail: number, reach: number, halfWidth = 1.3): BotDriver | null {
  const n = roads.nearest(pos, fwd);
  if (!n) return null;
  const m = newMover(n.line, n.seg, n.t, cruise, halfLen);
  m.tail = tail;
  m.bend = reach > 0 ? TRAILER_BEND : 1;
  m.early = LANE_EARLY;
  // Шлях — на ширину машини: півширина + 1,3 м іншого замість PATH_HALF 2,2 м легковика.
  m.wide = Math.max(0, halfWidth + OTHER_HALF - 2.2);
  m.route = null;
  sync(m, pos, fwd, 0);
  return { m, ps: newPhysState(), want: 0, halt: null, passing: 0, squeeze: 0, reach, shift: 0, halfWidth };
}

/** Новий рейс: маршрут до місця й точка зупинки (null — без маршруту, як трафік). */
export function setRoute(b: BotDriver, route: ((l: RoadLine) => RoadLine | null) | null, halt: THREE.Vector3 | null): void {
  b.m.route = route;
  b.halt = halt;
  replan(b.m);
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Рішення раз на кадр: позиція з тіла, розминання, decide, зупинка на місці, захід у поворот. obstacles — без свого
 * тіла; oncoming — інші машини з курсом; stopAt — до стоп-лінії на червоне, м.
 */
export function think(b: BotDriver, roads: Ht2Roads, v: TruckVehicle, dt: number, obstacles: readonly Obstacle[], oncoming: readonly Oncoming[], stopAt: number): void {
  const m = b.m;
  const t = v.body.translation();
  const p = new THREE.Vector3(t.x, t.y, t.z);
  const fwd = v.forward();
  const speed = Math.max(0, v.speedKmh / 3.6);
  const off = sync(m, p, fwd, speed);
  if (off > RETRACE) {
    const n = roads.nearest(p, fwd);
    if (n) retrace(m, n.line, n.seg, n.t);
  }
  // Тупик без зустрічної смуги: на найближчу лінію назад (розвернеться за точкою керма).
  if (m.gone) {
    m.gone = false;
    const n = roads.nearest(p, fwd.clone().negate());
    if (n) retrace(m, n.line, n.seg, n.t);
  }
  m.stopAt = stopAt;

  // Розминання із зустрічною на базі й вузьких смугах.
  const flat = fwd.clone().setY(0).normalize();
  const right = new THREE.Vector3().crossVectors(flat, UP).normalize();
  const line = m.line;
  const tight = !!line.base || line.laneWidth < PASS_LANE;
  const slow = !!line.base || line.laneWidth < SLOW_LANE;
  b.passing = Math.max(0, b.passing - dt);
  if (tight)
    for (const o of oncoming) {
      if (o.forward.dot(flat) > PASS_COS) continue;
      const rel = o.pos.clone().sub(p);
      const ahead = rel.dot(flat);
      if (ahead > 0 && ahead < PASS_LOOK && Math.abs(rel.dot(right)) < PASS_SIDE) b.passing = PASS_HOLD;
    }
  const shift = Math.min(PASS_SHIFT, Math.max(0, (line.wallRight ?? Infinity) - PASS_EDGE));
  if (b.passing > 0 && !m.bypass && !m.overtaking && shift > 0.3) {
    if (m.latGoal === 0 || m.latGoal === b.squeeze) m.latGoal = b.squeeze = shift;
  } else if (b.squeeze) {
    if (m.latGoal === b.squeeze) m.latGoal = 0;
    b.squeeze = 0;
  }

  let want = decide(m, dt, obstacles, roads);
  if (b.passing > 0 && slow) want = Math.min(want, PASS_KMH / 3.6);
  // Місце складу попереду на осі: доповзти й стати.
  if (b.halt) {
    const rel = b.halt.clone().sub(p).setY(0);
    const ahead = rel.dot(flat);
    if (ahead < HALT_LOOK && Math.abs(rel.dot(right)) < HALT_SIDE && ahead > -HALT_SIDE) {
      const left = ahead - HALT_AT;
      want = left <= 0 ? 0 : Math.min(want, Math.max(0.8, Math.sqrt(2 * HALT_DECEL * left)));
    }
  }
  b.want = want;
  const side = sideClear(b, p, flat, right, speed, obstacles);
  const turn = b.reach > 0 ? offtrack(b, speed) : 0;
  b.shift = moveTo(b.shift, side + turn, (side ? SIDE_RATE : OFFTRACK_RATE) * dt);
}

/** Відступ точки керма (праворуч +) від тіл збоку, ближчих SIDE_CLEAR до осі шляху. */
function sideClear(b: BotDriver, p: THREE.Vector3, flat: THREE.Vector3, right: THREE.Vector3, speed: number, obstacles: readonly Obstacle[]): number {
  const m = b.m;
  const clear = b.halfWidth + SIDE_OTHER;
  const ahead = m.halfLen + Math.max(SIDE_AHEAD, SIDE_LOOK * speed);
  let out = 0;
  const rel = new THREE.Vector3();
  for (const o of obstacles) {
    rel.subVectors(o.pos, p);
    const a = rel.dot(flat);
    if (a < -(m.halfLen + (m.tail ?? 0) + o.half) || a > ahead + o.half) continue;
    // Бічна відстань від шляху, яким бот буде біля перешкоди: тіло — на m.lat від лінії, шлях там — offAt.
    const s = rel.dot(right) + m.lat - offAt(m, Math.max(0, a) / Math.max(2, speed));
    const d = Math.abs(s);
    if (d >= clear || d < ON_PATH) continue;
    const need = -Math.sign(s) * (clear - d);
    if (Math.abs(need) > Math.abs(out)) out = need;
  }
  const lw = m.line.laneWidth;
  return THREE.MathUtils.clamp(out, -Math.min(SIDE_MAX, OUT_LANE * lw), Math.min(SIDE_MAX, Math.max(0, (m.line.wallRight ?? lw) - PASS_EDGE)));
}

/** Педалі й кермо на крок фізики. */
export function steer(b: BotDriver, v: TruckVehicle, dt: number): ControlState {
  return control(b.m, v, b.ps, b.want, false, dt, b.shift);
}

function moveTo(x: number, goal: number, step: number): number {
  return x + THREE.MathUtils.clamp(goal - x, -step, step);
}

/** Напрям шляху на відстані d (горизонтальний). */
function dirAt(path: { pts: THREE.Vector3[]; s: number[] }, d: number): THREE.Vector3 {
  const { pts, s } = path;
  let i = 1;
  while (i < pts.length - 1 && s[i] < d) i++;
  return pts[Math.min(i, pts.length - 1)].clone().sub(pts[i - 1]).setY(0).normalize();
}

/**
 * Зсув точки керма праворуч (+) для заходу в поворот ширше: назовні на OFFTRACK_K·(R − √(R² − L²)); праворуч — не
 * ближче PASS_EDGE до стіни, ліворуч — не далі OUT_LANE смуги.
 */
function offtrack(b: BotDriver, speed: number): number {
  const m = b.m;
  const c = CARROT_MIN + 0.8 * speed;
  const path = pathAhead(m, c + OFFTRACK_WIN + 5);
  if (path.pts.length < 3) return 0;
  const a = dirAt(path, Math.max(0, c - OFFTRACK_WIN));
  const z = dirAt(path, c + OFFTRACK_WIN);
  // Праворуч від a — (−z, x); поворот праворуч — додатний.
  const yaw = Math.atan2(a.x * z.z - a.z * z.x, a.dot(z));
  if (Math.abs(yaw) < OFFTRACK_MIN) return 0;
  const R = (2 * OFFTRACK_WIN) / Math.abs(yaw);
  const L = b.reach;
  const cut = R <= L ? L : R - Math.sqrt(R * R - L * L);
  const lw = m.line.laneWidth;
  if (yaw > 0) return -Math.min(OFFTRACK_K * cut, OUT_LANE * lw);
  return Math.min(OFFTRACK_K * cut, OUT_LANE * lw, Math.max(0, (m.line.wallRight ?? lw) - PASS_EDGE));
}
