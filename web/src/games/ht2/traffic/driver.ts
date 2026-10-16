import * as THREE from 'three';
import type { RoadLine } from '../world/roads';

/**
 * Водій машини трафіку за king.exe (re/notes/ht2/traffic.md) — без фізики: машина котиться лінією смуги, а
 * поведінка (швидкість, дистанція, перестроювання, повороти) — як у водія `_Car_V` (0x4d6510).
 *
 * - Цільова швидкість (0x4d4700): крейсерська (обережні dumb/ghost — до 20 м/с); крива — огляд уперед на
 *   L = 5·v, кривизна k = 4·кут/L, при k > 0,0157 — не більше √(5/k), але не менше 8 м/с; гребінь — той самий поріг
 *   для вертикальної кривизни, швидкість ділиться на |k|·200/π (у декомпіляції — «біт 2» огляду; що це гребінь, а не
 *   ухил, — гіпотеза); кінець дороги ближче 50 м — v·d·0,02 + 1.
 * - Лідер (0x4d4a90): перешкода на шляху попереду (до 150 м); безпечна дистанція D = 0,1·Δv² + 10 м між бамперами;
 *   між D і D + 20 — підлаштуватися під швидкість лідера, ближче — гальмувати (порт: плавно до зупинки за 3 м).
 * - Обʼїзд (0x4d57c0): обережні обʼїжджають лише того, хто стоїть чи повзе (≤ 5 м/с): у сусідню смугу свого
 *   напрямку, якщо вона вільна; інакше — по зустрічній (лише без бітів 4/8 в ATTR і коли вона вільна), інакше —
 *   узбіччям. Зустрічною й узбіччям порт обʼїжджає лише гравця, його причіп і суперників після BYPASS_WAIT с стоянки
 *   (інакше в обʼїзд кидається вся черга на стику — гіпотеза порту).
 * - Маршрут: на кожній лінії заздалегідь вибирається дорога після стику (у king.exe — маршрут до випадкової цілі,
 *   тож повороти так само випадкові); ближче 100 м до стику — перестроювання (changeLanes 0x420360): праворуч —
 *   у крайню праву смугу, ліворуч — у смугу біля осі, прямо — лишитись (іноді — випадкова смуга).
 * - Перестроювання — бічний зсув, що згасає (у king.exe кінематична машина: lat ← s·lat + (1 − s)·ціль; тут стала
 *   часу LANE_TAU — гіпотеза порту, щоб маневр було видно).
 * - Розгін/гальмування: газ 0,2·Δv, гальмо min(1; 0,2·Δv) (0x4d60c0) → прискорення порту (гіпотеза: до 2,5 м/с²,
 *   гальмування до 7 м/с²).
 */
const LOOK_MIN = 20;
const K_LIMIT = 0.0157;
const V_CURVE_MIN = 8;
const LEADER_RANGE = 150;
const LEADER_GAP = 10;
const FOLLOW_ZONE = 20;
const STOP_GAP = 3;
const SLOW_OBSTACLE = 5;
const LANE_PLAN = 100;
const LANE_TAU = 0.9;
const ACCEL = 2.5;
const BRAKE = 7;
/** Перешкода на шляху, якщо ближче за це до осі смуги (півширина машини + запас), м. */
const PATH_HALF = 2.2;
/** Скільки чекати за перешкодою, що стоїть, перш ніж обʼїжджати зустрічною чи узбіччям, с. */
const BYPASS_WAIT = 3;
/** Зустрічна має бути вільна на стільки вперед, м. */
const BYPASS_CLEAR = 120;

export interface Mover {
  line: RoadLine;
  seg: number;
  t: number;
  /** Початок першого відрізка нової лінії — кінець попередньої (проміжок між смугами на стику — навпростець). */
  from: THREE.Vector3 | null;
  speed: number;
  cruise: number;
  halfLen: number;
  /** Фактична позиція (лінія + бічний зсув). */
  pos: THREE.Vector3;
  /** Напрям руху (горизонтальний, одиничний). */
  heading: THREE.Vector3;
  /** Бічний зсув від лінії смуги, м (праворуч — додатний), і його ціль (≠ 0 — обʼїзд зустрічною чи узбіччям). */
  lat: number;
  latGoal: number;
  /** Перешкода, яку обʼїжджаємо зустрічною чи узбіччям. */
  bypass: THREE.Vector3 | null;
  /** Скільки стоїть за перешкодою, с. */
  waited: number;
  /** Дорога після кінця лінії (null — тупик). */
  plan: number | null;
  /** Бажана смуга. */
  wantLane: number;
  /** Доїхала до тупика — прибрати. */
  gone: boolean;
}

export interface Obstacle {
  pos: THREE.Vector3;
  /** Швидкість, м/с (вектор). */
  vel: THREE.Vector3;
  /** Півдовжина, м. */
  half: number;
  /** Машина трафіку (для перевірки смуг при перестроюванні). */
  mover?: Mover;
}

export function newMover(line: RoadLine, seg: number, t: number, cruise: number, halfLen: number): Mover {
  const m: Mover = {
    line,
    seg,
    t,
    from: null,
    speed: cruise,
    cruise,
    halfLen,
    pos: new THREE.Vector3(),
    heading: new THREE.Vector3(0, 0, -1),
    lat: 0,
    latGoal: 0,
    bypass: null,
    waited: 0,
    plan: null,
    wantLane: line.lane,
    gone: false,
  };
  planNext(m);
  place(m, 0);
  return m;
}

/** Точка на лінії смуги (без бічного зсуву). */
function linePoint(m: Mover, out = new THREE.Vector3()): THREE.Vector3 {
  return out.copy(segStart(m)).lerp(m.line.pts[m.seg + 1], m.t);
}

function segStart(m: Mover): THREE.Vector3 {
  return m.seg === 0 && m.from ? m.from : m.line.pts[m.seg];
}

/** Кут повороту з кінця лінії a на початок b (праворуч — додатний), рад. */
export function turnAngle(a: RoadLine, b: RoadLine): number {
  const n = a.pts.length;
  const din = a.pts[n - 1].clone().sub(a.pts[n - 2]).setY(0).normalize();
  const dout = b.pts[Math.min(2, b.pts.length - 1)].clone().sub(b.pts[0]).setY(0).normalize();
  return Math.atan2(din.x * dout.z - din.z * dout.x, din.dot(dout));
}

/** Вибір дороги після стику й бажаної смуги (у king.exe — маршрут і changeLanes). */
function planNext(m: Mover): void {
  const roads = [...new Set((m.line.next as RoadLine[]).map((l) => l.road))];
  m.plan = roads.length ? roads[Math.floor(Math.random() * roads.length)] : null;
  const to = m.plan === null ? null : nextLine(m.line, m.plan, m.line.lane);
  const turn = to ? turnAngle(m.line, to) : 0;
  if (turn > 0.35) m.wantLane = m.line.lanes - 1;
  else if (turn < -0.35) m.wantLane = 0;
  else m.wantLane = Math.random() < 0.25 ? Math.floor(Math.random() * m.line.lanes) : m.line.lane;
}

/** Продовження лінії на дорогу road — у смугу, найближчу за номером. */
function nextLine(line: RoadLine, road: number | null, lane: number): RoadLine | null {
  const all = line.next as RoadLine[];
  const cand = road === null ? all : all.filter((l) => l.road === road);
  const list = cand.length ? cand : all;
  let best: RoadLine | null = null;
  for (const l of list) if (!best || Math.abs(l.lane - lane) < Math.abs(best.lane - lane)) best = l;
  return best;
}

/** Найпряміше продовження (для огляду за межею запланованого). */
function straightest(line: RoadLine): RoadLine | null {
  let best: RoadLine | null = null;
  let bestTurn = Infinity;
  for (const l of line.next as RoadLine[]) {
    const a = Math.abs(turnAngle(line, l)) + (l.lane === line.lane ? 0 : 0.01);
    if (a < bestTurn) {
      bestTurn = a;
      best = l;
    }
  }
  return best;
}

/** Шлях уперед від машини: вершини, відстані вздовж, відстань до тупика (Infinity — немає). */
export function pathAhead(m: Mover, maxDist: number): { pts: THREE.Vector3[]; s: number[]; deadEnd: number } {
  const pts = [linePoint(m)];
  const s = [0];
  let line = m.line;
  let i = m.seg + 1;
  let first = true;
  let total = 0;
  for (let guard = 0; guard < 500 && total < maxDist; guard++) {
    if (i >= line.pts.length) {
      const nx = first ? nextLine(line, m.plan, line.lane) : straightest(line);
      first = false;
      if (!nx) return { pts, s, deadEnd: total };
      line = nx;
      i = 1;
      continue;
    }
    const p = line.pts[i++];
    const d = pts[pts.length - 1].distanceTo(p);
    if (d < 1e-3) continue;
    total += d;
    pts.push(p);
    s.push(total);
  }
  return { pts, s, deadEnd: Infinity };
}

/** Дотична шляху на відстані d (по горизонталі) і нахил там (рад, угору — додатний). */
function tangentAt(path: { pts: THREE.Vector3[]; s: number[] }, d: number): { dir: THREE.Vector3; pitch: number } {
  const { pts, s } = path;
  let i = 1;
  while (i < pts.length - 1 && s[i] < d) i++;
  const a = pts[i - 1];
  const b = pts[Math.min(i, pts.length - 1)];
  const v = b.clone().sub(a);
  const h = Math.hypot(v.x, v.z);
  return { dir: v.setY(0).normalize(), pitch: Math.atan2(b.y - a.y, h || 1) };
}

/** Обмеження швидкості за дорогою попереду (king.exe 0x4d4700). */
export function roadLimit(m: Mover, path: { pts: THREE.Vector3[]; s: number[]; deadEnd: number }): number {
  let v = m.cruise;
  if (path.pts.length < 2) return v;
  const L = Math.max(LOOK_MIN, 5 * m.cruise);
  const here = tangentAt(path, 0);
  const there = tangentAt(path, L);
  const yaw = Math.atan2(here.dir.x * there.dir.z - here.dir.z * there.dir.x, here.dir.dot(there.dir));
  const k = (4 * Math.abs(yaw)) / L;
  if (k > K_LIMIT) v = Math.min(v, Math.max(V_CURVE_MIN, Math.sqrt(5 / k)));
  const kv = (4 * (there.pitch - here.pitch)) / L;
  if (kv < -K_LIMIT) v /= Math.abs(kv) * (200 / Math.PI);
  if (path.deadEnd < 50) v = Math.min(v, v * path.deadEnd * 0.02 + 1);
  return v;
}

/** Найближча перешкода на шляху: відстань між бамперами і її швидкість уздовж шляху. */
export function leaderOn(
  m: Mover,
  path: { pts: THREE.Vector3[]; s: number[] },
  obstacles: readonly Obstacle[],
  lat = m.lat,
): { gap: number; speed: number; obstacle: Obstacle } | null {
  let best: { gap: number; speed: number; obstacle: Obstacle } | null = null;
  const ab = new THREE.Vector3();
  for (const o of obstacles) {
    if (o.mover === m) continue;
    if (o.pos.distanceTo(m.pos) > LEADER_RANGE + 10) continue;
    for (let i = 0; i + 1 < path.pts.length; i++) {
      const a = path.pts[i];
      ab.subVectors(path.pts[i + 1], a).setY(0);
      const len = ab.length();
      if (!len) continue;
      ab.divideScalar(len);
      const along = (o.pos.x - a.x) * ab.x + (o.pos.z - a.z) * ab.z;
      if (along < -o.half || along > len + o.half) continue;
      // Бічна відстань праворуч від шляху (вектор праворуч — (−z, x)) мінус наш зсув.
      const side = Math.abs((o.pos.z - a.z) * ab.x - (o.pos.x - a.x) * ab.z - lat);
      if (side > PATH_HALF) continue;
      const s = path.s[i] + THREE.MathUtils.clamp(along, 0, len);
      if (s <= 0.5) continue; // поруч чи позаду — не лідер
      const gap = s - m.halfLen - o.half;
      if (!best || gap < best.gap) best = { gap, speed: Math.max(0, o.vel.x * ab.x + o.vel.z * ab.z), obstacle: o };
      break;
    }
  }
  return best;
}

/** Швидкість за лідером (дистанція D = 0,1·Δv² + 10 м). */
export function followLimit(m: Mover, leader: { gap: number; speed: number } | null, v: number): number {
  if (!leader) return v;
  const dv = Math.max(0, m.speed - leader.speed);
  const D = 0.1 * dv * dv + LEADER_GAP;
  if (leader.gap < STOP_GAP) return 0;
  if (leader.gap < D) return Math.min(v, (leader.speed + 1) * ((leader.gap - STOP_GAP) / (D - STOP_GAP)));
  if (leader.gap < D + FOLLOW_ZONE) return Math.min(v, leader.speed + ((v - leader.speed) * (leader.gap - D)) / FOLLOW_ZONE);
  return v;
}

/** Смуга sib вільна поруч з машиною (інші машини на ній і перешкоди біля точки). */
function laneFree(m: Mover, sib: RoadLine | undefined, obstacles: readonly Obstacle[]): boolean {
  if (!sib || sib.pts.length !== m.line.pts.length) return false;
  const p = new THREE.Vector3().copy(sib.pts[m.seg]).lerp(sib.pts[m.seg + 1], m.t);
  const fwd = m.heading;
  for (const o of obstacles) {
    if (o.mover === m) continue;
    const rel = o.pos.clone().sub(p);
    const along = rel.x * fwd.x + rel.z * fwd.z;
    const side = Math.abs(rel.x * fwd.z - rel.z * fwd.x);
    if (side < PATH_HALF && along > -15 - o.half && along < 25 + o.half) return false;
  }
  return true;
}

/** Перестроїтися на сусідню смугу (на одну), зберігши місце: бічний зсув компенсує різницю. */
function changeLane(m: Mover, to: number): void {
  const sib = m.line.siblings[to];
  if (!sib || sib === m.line || sib.pts.length !== m.line.pts.length) return;
  m.lat += (m.line.lane - to) * m.line.laneWidth;
  m.line = sib;
}

/** Крок водія: швидкість, перестроювання, рух уздовж ліній. */
export function step(m: Mover, dt: number, obstacles: readonly Obstacle[]): void {
  if (m.gone) return;
  const path = pathAhead(m, LEADER_RANGE);
  const leader = leaderOn(m, path, obstacles);

  // Перестроювання: перед поворотом (ближче LANE_PLAN до стику) чи обʼїзд повільної перешкоди.
  const lane = m.line.lane;
  const toEnd = remaining(m);
  if (m.bypass) {
    // Перешкоду минули — назад у смугу.
    const rel = m.bypass.clone().sub(m.pos);
    if (rel.x * m.heading.x + rel.z * m.heading.z < -(m.halfLen + 8) || rel.lengthSq() > 900) {
      m.bypass = null;
      m.latGoal = 0;
    }
  }
  m.waited = leader && leader.speed <= SLOW_OBSTACLE && m.speed < 1 ? m.waited + dt : 0;
  // Зсув (обʼїзд) — будь-де; перехід на сусідню лінію — не на «містку» між лініями (там інша геометрія).
  const settled = m.latGoal === 0 && Math.abs(m.lat) < 0.3 * m.line.laneWidth;
  const canShift = settled && !(m.seg === 0 && m.from);
  if (settled && leader && !leader.obstacle.mover && m.waited > BYPASS_WAIT) {
    // Своя смуга заблокована гравцем чи суперником: сусідня смуга, інакше зустрічна, інакше узбіччя.
    const w = m.line.laneWidth;
    const goals = [m.line.lane > 0 ? -w : null, m.line.lane < m.line.lanes - 1 ? w : null, m.line.flags & 12 ? null : -(m.line.lane + 1) * w, (m.line.lanes - m.line.lane) * w];
    for (const g of goals) {
      if (g === null || leaderOn(m, path, obstacles, g)?.obstacle === leader.obstacle) continue;
      const block = leaderOn(m, path, obstacles.filter((o) => o !== leader.obstacle), g);
      if (block && block.gap < BYPASS_CLEAR) continue;
      m.latGoal = g;
      m.bypass = leader.obstacle.pos.clone();
      m.waited = 0;
      break;
    }
  } else if (canShift) {
    if (leader && leader.speed <= SLOW_OBSTACLE && leader.gap < LEADER_GAP + FOLLOW_ZONE) {
      for (const to of [lane - 1, lane + 1])
        if (to >= 0 && to < m.line.lanes && laneFree(m, m.line.siblings[to], obstacles)) {
          changeLane(m, to);
          m.wantLane = to;
          break;
        }
    } else if (m.wantLane !== lane && (toEnd < LANE_PLAN || m.line.next.length === 0 || Math.random() < dt * 0.2)) {
      const to = lane + Math.sign(m.wantLane - lane);
      if (laneFree(m, m.line.siblings[to], obstacles)) changeLane(m, to);
    }
  }

  let want = followLimit(m, leader, roadLimit(m, path));
  if (want < 0.1) want = 0;
  const dv = want - m.speed;
  const acc = dv > 0 ? Math.min(ACCEL, 0.3 + 0.6 * dv) : want === 0 ? -BRAKE : -Math.min(BRAKE, Math.max(1.5, 0.8 * -dv));
  m.speed = Math.max(0, dv > 0 ? Math.min(want, m.speed + acc * dt) : Math.max(want, m.speed + acc * dt));
  advance(m, m.speed * dt);
  m.lat = m.latGoal + (m.lat - m.latGoal) * Math.exp(-dt / LANE_TAU);
  if (Math.abs(m.lat - m.latGoal) < 1e-3) m.lat = m.latGoal;
  place(m, dt);
}

/** До кінця поточної лінії, м. */
function remaining(m: Mover): number {
  let d = segStart(m).distanceTo(m.line.pts[m.seg + 1]) * (1 - m.t);
  for (let i = m.seg + 1; i + 1 < m.line.pts.length; i++) d += m.line.pts[i].distanceTo(m.line.pts[i + 1]);
  return d;
}

function advance(m: Mover, move: number): void {
  for (let guard = 0; move > 0 && guard < 100; guard++) {
    const p0 = segStart(m);
    const p1 = m.line.pts[m.seg + 1];
    const segLen = p0.distanceTo(p1) || 0.001;
    const left = (1 - m.t) * segLen;
    if (move < left) {
      m.t += move / segLen;
      return;
    }
    move -= left;
    m.t = 0;
    m.seg++;
    m.from = null;
    if (m.seg + 1 >= m.line.pts.length) {
      const nx = nextLine(m.line, m.plan, m.line.lane);
      if (!nx) {
        m.gone = true;
        m.seg = m.line.pts.length - 2;
        m.t = 1;
        return;
      }
      m.line = nx;
      m.seg = 0;
      m.from = p1.clone();
      planNext(m);
    }
  }
}

/** Позиція й напрям з лінії й бічного зсуву. */
function place(m: Mover, dt: number): void {
  const a = segStart(m);
  const b = m.line.pts[m.seg + 1];
  const dir = b.clone().sub(a).setY(0);
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();
  const right = new THREE.Vector3(-dir.z, 0, dir.x);
  linePoint(m, m.pos).addScaledVector(right, m.lat);
  // Курс з бічною складовою перестроювання (зсув згасає — машина «з'їжджає» на нову смугу).
  const dLat = ((m.lat - m.latGoal) * (1 - Math.exp(-dt / LANE_TAU))) / Math.max(0.5, m.speed * dt);
  m.heading.copy(dir).addScaledVector(right, -THREE.MathUtils.clamp(dLat, -0.3, 0.3)).normalize();
}

/**
 * Абстрактний рух далекої машини (king.exe prescribeAdvance 0x41a9d0: позиція ІІ на осі дороги, крейсерська
 * швидкість без огляду й лідерів): лише вздовж ліній за планом, бічний зсув скинуто.
 */
export function coast(m: Mover, dt: number): void {
  if (m.gone) return;
  m.speed = m.cruise;
  m.lat = m.latGoal = 0;
  m.bypass = null;
  m.waited = 0;
  advance(m, m.cruise * dt);
  place(m, dt);
}
