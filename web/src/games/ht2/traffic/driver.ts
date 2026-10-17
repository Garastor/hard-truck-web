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
 * - Перестроювання — бічний зсув (у king.exe кінематична машина: lat ← s·lat + (1 − s)·ціль). Порт (відступ на
 *   прохання користувача — «природніше»): зсув іде S-кривою з бічним прискоренням до LAT_ACC (смуга ≈ 3,7 с), а
 *   кінематична машина не котиться ламаною, а їде своїм курсом до точки на шляху попереду (як фізична), з кривизною
 *   до KAPPA_MAX і бічним прискоренням до TURN_ACC: вершини ламаних і стики ліній — дугами; позиція на лінії —
 *   проєкцією (sync).
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
/** S-крива бічного зсуву: бічне прискорення, м/с², і найкоротший маневр, с. */
const LAT_ACC = 1.2;
const LAT_MIN_TIME = 1.5;
/** Курс кінематичної машини: найбільша кривизна, 1/м, бічне прискорення на дузі, м/с², огляд уперед L = a·v + b. */
const KAPPA_MAX = 1 / 7;
const TURN_ACC = 4;
const LOOK_A = 0.6;
const LOOK_B = 4;
/** Далі від запланованого зсуву — довертати з найбільшою кривизною; ще далі — повернути на лінію (застрягла). */
const OFF_TRACK = 1.5;
const SNAP_OFF = 8;
const ACCEL = 2.5;
const BRAKE = 7;
/** Перешкода на шляху, якщо ближче за це до осі смуги (півширина машини + запас), м. */
const PATH_HALF = 2.2;
/** Скільки чекати за перешкодою, що стоїть, перш ніж обʼїжджати зустрічною чи узбіччям, с. */
const BYPASS_WAIT = 3;
/** Зустрічна має бути вільна на стільки вперед, м. */
const BYPASS_CLEAR = 120;
/**
 * Обгін рухомих (порт, на прохання користувача): лідер повільніший за крейсерську на OVERTAKE_DV — обгін лівою
 * смугою свого напрямку, на дорозі з однією смугою — по зустрічній; під час обгону — швидше на OVERTAKE_BOOST;
 * зустрічний ближче OVERTAKE_ABORT, поки не порівнялися, — повернутися.
 */
const OVERTAKE_DV = 3;
const OVERTAKE_BOOST = 4;
const OVERTAKE_ABORT = 70;
/**
 * Пропуск на перехрестях (порт, на прохання користувача): перехрестя — вузол трьох і більше доріг ближче
 * JUNCTION_LOOK; «на перехресті» — перші INSIDE м лінії за вузлом; шляхи перетинаються, якщо точки ближче
 * CONFLICT_DIST; зупинка за JUNCTION_STOP до вузла; хто чекає довше YIELD_MAX — їде першим.
 */
const JUNCTION_LOOK = 60;
const INSIDE = 15;
const CONFLICT_DIST = 3.5;
const JUNCTION_STOP = 7;
const YIELD_MAX = 6;

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
  /** Обганяє по зустрічній (bypass — машина, яку обганяє). */
  overtaking: boolean;
  /** Смуга, у яку повернутися після обгону сусідньою смугою (−1 — немає). */
  backLane: number;
  /** Скільки чекає, пропускаючи на перехресті, с. */
  waitJ: number;
  /** Відстань до стоп-лінії світлофора, перед якою треба стати (червоне), м; Infinity — ні (ставить трафік). */
  stopAt: number;
  /** Гальмує на червоне (вже вирішив стати). */
  redStop: boolean;
  /** Дорога після кінця лінії (null — тупик). */
  plan: number | null;
  /** Ціль маршруту — індекс у goals (−1 — немає, вибір навмання). */
  goal: number;
  /** Бажана смуга. */
  wantLane: number;
  /** Доїхала до тупика — прибрати. */
  gone: boolean;
  /**
   * Запланований бічний зсув від лінії (S-крива від offFrom до offTo за offDur с, пройдено offT с): за ним їдуть і
   * кінематична, і фізична машина (carrot); lat — фактичний.
   */
  off: number;
  offFrom: number;
  offTo: number;
  offT: number;
  offDur: number;
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
    overtaking: false,
    backLane: -1,
    waitJ: 0,
    stopAt: Infinity,
    redStop: false,
    plan: null,
    wantLane: line.lane,
    gone: false,
    off: 0,
    offFrom: 0,
    offTo: 0,
    offT: 0,
    offDur: 0,
    goal: goals.length ? Math.floor(Math.random() * goals.length) : -1,
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

/** Перебудувати маршрут (king.exe seeIfMustBeRetraced): машину відкинуло від лінії — на найближчу. */
export function retrace(m: Mover, line: RoadLine, seg: number, t: number): void {
  m.line = line;
  m.seg = Math.min(seg, line.pts.length - 2);
  m.t = t;
  m.from = null;
  m.latGoal = 0;
  m.bypass = null;
  m.overtaking = false;
  m.backLane = -1;
  planNext(m);
}

/** Вибір дороги після стику й бажаної смуги (у king.exe — маршрут і changeLanes). */
/**
 * Цілі руху трафіку (king.exe 0x45cdc0, 0x406600; re/notes/ht2/career-misc.md §2): машина їде найкоротшим шляхом
 * до одного з вузлів WAY з FLAG & 2 (міста біля стоянок), доїхала — нова ціль. Так з'їзди на заправки, СТО й склади
 * машини проминають, якщо ті не на шляху. Кожна карта — відстань від кінця лінії до цілі (Navigator.distances).
 */
let goals: Map<RoadLine, number>[] = [];

export function setGoals(maps: Map<RoadLine, number>[]): void {
  goals = maps;
}

function planNext(m: Mover): void {
  const next = m.line.next as RoadLine[];
  const roads = [...new Set(next.map((l) => l.road))];
  m.plan = roads.length ? roads[Math.floor(Math.random() * roads.length)] : null;
  if (goals.length) {
    let g = goals[m.goal];
    // Доїхали (лінія біля цілі) чи ціль недосяжна — нова ціль.
    if (!g || (g.get(m.line) ?? Infinity) === 0 || !next.some((l) => Number.isFinite(g!.get(l) ?? Infinity))) {
      m.goal = Math.floor(Math.random() * goals.length);
      g = goals[m.goal];
    }
    let best: RoadLine | null = null;
    let bd = Infinity;
    for (const l of next) {
      const d = (g.get(l) ?? Infinity) + l.length;
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    if (best) m.plan = best.road;
  }
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
  lat?: number,
): { gap: number; speed: number; obstacle: Obstacle } | null {
  let best: { gap: number; speed: number; obstacle: Obstacle } | null = null;
  // Далі кінця шляху (з запасом) перешкода не на шляху.
  const reach = (path.s[path.s.length - 1] ?? 0) + 10;
  const ab = new THREE.Vector3();
  for (const o of obstacles) {
    if (o.mover === m) continue;
    if (o.pos.distanceTo(m.pos) > reach) continue;
    for (let i = 0; i + 1 < path.pts.length; i++) {
      const a = path.pts[i];
      ab.subVectors(path.pts[i + 1], a).setY(0);
      const len = ab.length();
      if (!len) continue;
      ab.divideScalar(len);
      const along = (o.pos.x - a.x) * ab.x + (o.pos.z - a.z) * ab.z;
      if (along < -o.half || along > len + o.half) continue;
      const s = path.s[i] + THREE.MathUtils.clamp(along, 0, len);
      // Бічна відстань праворуч від шляху (вектор праворуч — (−z, x)) мінус наш зсув — запланований на мить, коли
      // доїдемо до перешкоди (S-крива маневру), якщо не задано інший.
      const side = Math.abs((o.pos.z - a.z) * ab.x - (o.pos.x - a.x) * ab.z - (lat ?? offAt(m, s / Math.max(2, m.speed))));
      if (side > PATH_HALF) continue;
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

/** Перестроїтися на сусідню смугу (на одну), зберігши місце: бічний зсув компенсує різницю й згасає S-кривою. */
function changeLane(m: Mover, to: number): void {
  const sib = m.line.siblings[to];
  if (!sib || sib === m.line || sib.pts.length !== m.line.pts.length) return;
  const d = (m.line.lane - to) * m.line.laneWidth;
  m.lat += d;
  m.off += d;
  m.line = sib;
  shiftTo(m, m.latGoal);
}

/** Новий маневр бічного зсуву: від поточного запланованого до goal, тривалість — за бічним прискоренням. */
function shiftTo(m: Mover, goal: number): void {
  m.offFrom = m.off;
  m.offTo = goal;
  m.offT = 0;
  m.offDur = Math.max(LAT_MIN_TIME, Math.sqrt((6 * Math.abs(goal - m.off)) / LAT_ACC));
}

/** Запланований зсув через ahead с (smoothstep: найбільше бічне прискорення 6·Δ/T²). */
export function offAt(m: Mover, ahead: number): number {
  if (m.offDur <= 0) return m.offTo;
  const x = THREE.MathUtils.clamp((m.offT + ahead) / m.offDur, 0, 1);
  return m.offFrom + (m.offTo - m.offFrom) * x * x * (3 - 2 * x);
}

/** Крок маневру: нова ціль latGoal — новий маневр. */
function updateOff(m: Mover, dt: number): void {
  if (m.offTo !== m.latGoal) shiftTo(m, m.latGoal);
  if (m.offDur > 0) {
    m.offT += dt;
    if (m.offT >= m.offDur) m.offDur = 0;
  }
  m.off = offAt(m, 0);
}

/** Крок водія кінематичної машини: рішення (decide) і рух уздовж ліній. */
export function step(m: Mover, dt: number, obstacles: readonly Obstacle[], net: Net | null = null): void {
  if (m.gone) return;
  const want = decide(m, dt, obstacles, net);
  const dv = want - m.speed;
  const acc = dv > 0 ? Math.min(ACCEL, 0.3 + 0.6 * dv) : want === 0 ? -BRAKE : -Math.min(BRAKE, Math.max(2.5, 0.8 * -dv));
  m.speed = Math.max(0, dv > 0 ? Math.min(want, m.speed + acc * dt) : Math.max(want, m.speed + acc * dt));
  const move = m.speed * dt;
  if (move > 0) pursue(m, move, Math.abs(m.lat - m.off) > OFF_TRACK);
  // Позиція на лінії — проєкцією; далеко від лінії (кут, якого дуга не бере) — повернути на лінію.
  const away = sync(m, m.pos, m.heading, m.speed);
  if (away > SNAP_OFF + Math.abs(m.off)) {
    m.lat = m.off;
    place(m, dt);
  } else m.pos.y = linePoint(m).y;
}

/**
 * Кінематична машина за точкою на шляху (порт): курс повертає до точки на L = 0,6·v + 4 м уперед (з запланованим
 * зсувом), кривизна κ = 2·sin α / d — не більше KAPPA_MAX і TURN_ACC/v²; позиція — уздовж курсу.
 */
function pursue(m: Mover, move: number, recover: boolean): void {
  const look = THREE.MathUtils.clamp(LOOK_A * m.speed + LOOK_B, 5, 20);
  const to = carrot(m, look).sub(m.pos).setY(0);
  const d = to.length();
  if (d > 0.05) {
    to.divideScalar(d);
    const h = m.heading;
    const alpha = Math.atan2(h.z * to.x - h.x * to.z, h.x * to.x + h.z * to.z);
    // Зійшла з траєкторії (кут, якого не взяла) — довертає різкіше, щоб не «телепортувати» на лінію.
    const kMax = recover ? KAPPA_MAX : Math.min(KAPPA_MAX, TURN_ACC / Math.max(1, m.speed * m.speed));
    const k = THREE.MathUtils.clamp((2 * Math.sin(alpha)) / Math.max(d, 1), -kMax, kMax);
    h.applyAxisAngle(new THREE.Vector3(0, 1, 0), k * move).setY(0).normalize();
  }
  m.pos.addScaledVector(m.heading, move);
}

/** Рішення водія (і кінематичного, і фізичного): перестроювання, обʼїзд, обгін, пропуск, цільова швидкість, м/с. */
export function decide(m: Mover, dt: number, obstacles: readonly Obstacle[], net: Net | null = null): number {
  updateOff(m, dt);
  const path = pathAhead(m, LEADER_RANGE);
  // Машину, яку обганяємо, лідером не вважаємо (вона збоку чи позаду).
  const others = m.overtaking && m.bypass ? obstacles.filter((o) => o.pos !== m.bypass) : obstacles;
  const leader = leaderOn(m, path, others);
  const junction = net ? junctionAhead(m, net) : null;

  // Перестроювання: перед поворотом (ближче LANE_PLAN до стику) чи обʼїзд повільної перешкоди.
  const lane = m.line.lane;
  const toEnd = remaining(m);
  if (m.bypass) {
    // Перешкоду минули — назад у смугу.
    const rel = m.bypass.clone().sub(m.pos);
    if (rel.x * m.heading.x + rel.z * m.heading.z < -(m.halfLen + 8) || rel.lengthSq() > 2500) endBypass(m);
    else if (m.overtaking) {
      // Порт: на зустрічній хтось зʼявився, а ми ще не порівнялися — повернутися за лідера.
      const ahead = rel.x * m.heading.x + rel.z * m.heading.z;
      const oncoming = leaderOn(m, path, others, m.latGoal);
      if (oncoming && oncoming.gap < OVERTAKE_ABORT && ahead > 0) endBypass(m);
    }
  }
  m.waited = leader && leader.speed <= SLOW_OBSTACLE && m.speed < 1 ? m.waited + dt : 0;
  // Зсув (обʼїзд) — будь-де; перехід на сусідню лінію — не на «містку» між лініями (там інша геометрія).
  const settled = m.latGoal === 0 && Math.abs(m.lat) < 0.3 * m.line.laneWidth;
  const canShift = settled && !(m.seg === 0 && m.from);
  // Лідер повільніший за нас (порт: обгін рухомих; king.exe обʼїжджає лише тих, хто стоїть).
  const slow = !!leader && leader.gap < LEADER_GAP + FOLLOW_ZONE && (leader.speed <= SLOW_OBSTACLE || (!!leader.obstacle.mover && leader.speed < m.cruise - OVERTAKE_DV));
  if (settled && leader && !leader.obstacle.mover && m.waited > BYPASS_WAIT) {
    // Своя смуга заблокована гравцем чи суперником: сусідня смуга, інакше зустрічна, інакше узбіччя.
    const w = m.line.laneWidth;
    const goals = [m.line.lane > 0 ? -w : null, m.line.lane < m.line.lanes - 1 ? w : null, m.line.flags & 12 ? null : -(m.line.lane + 1) * w, (m.line.lanes - m.line.lane) * w];
    for (const g of goals) {
      if (g === null || leaderOn(m, path, obstacles, g)?.obstacle === leader.obstacle) continue;
      const block = leaderOn(m, path, obstacles.filter((o) => o !== leader.obstacle), g);
      if (block && block.gap < BYPASS_CLEAR) continue;
      m.latGoal = g;
      m.bypass = leader.obstacle.pos;
      m.waited = 0;
      break;
    }
  } else if (canShift && slow && leader) {
    // Обгін сусідньою смугою свого напрямку: рухомого — лише ліворуч (ближче до осі), того, хто стоїть, — будь-якою.
    const sides = leader.speed <= SLOW_OBSTACLE ? [lane - 1, lane + 1] : [lane - 1];
    let done = false;
    for (const to of sides)
      if (to >= 0 && to < m.line.lanes && laneFree(m, m.line.siblings[to], obstacles)) {
        if (leader.speed > SLOW_OBSTACLE && m.backLane < 0) m.backLane = lane;
        changeLane(m, to);
        m.wantLane = to;
        done = true;
        break;
      }
    if (!done && leader.obstacle.mover && leader.speed > SLOW_OBSTACLE && lane === 0 && !junction) tryOncoming(m, leader, others);
  } else if (canShift) {
    if (m.backLane >= 0 && m.backLane !== lane && !(leader && leader.gap < LEADER_GAP + FOLLOW_ZONE + 20)) {
      // Після обгону — назад праворуч, щойно смуга вільна.
      const to = lane + Math.sign(m.backLane - lane);
      if (laneFree(m, m.line.siblings[to], obstacles)) {
        changeLane(m, to);
        m.wantLane = to;
        if (to === m.backLane) m.backLane = -1;
      }
    } else if (m.wantLane !== lane && (toEnd < LANE_PLAN || m.line.next.length === 0 || Math.random() < dt * 0.2)) {
      const to = lane + Math.sign(m.wantLane - lane);
      if (laneFree(m, m.line.siblings[to], obstacles)) changeLane(m, to);
    }
  }

  const base = roadLimit(m, path);
  let want = followLimit(m, leader, m.overtaking ? Math.min(base + OVERTAKE_BOOST, m.cruise + OVERTAKE_BOOST) : base);
  // Пропуск на перехресті: зупинитися перед вузлом, доки той, кому поступаємося, не проїде.
  if (junction && net && mustYield(m, junction, obstacles, net)) {
    want = Math.min(want, followLimit(m, { gap: junction.dist - JUNCTION_STOP - m.halfLen, speed: 0 }, want));
    m.waitJ = m.speed < 1 ? m.waitJ + dt : m.waitJ;
  } else m.waitJ = 0;
  // Червоне світло (king.exe: точка зупинки +0x40b0 від тригера 0x1D): стати перед стоп-лінією. Порт: рівне
  // гальмування 2 м/с² до точки за 2,5 м перед лінією; «не встигаю» (проїхати) — лише якщо на початку не вистачає
  // і екстреного 6 м/с²; почавши гальмувати, стоїть до кінця (інакше запізнення біля лінії вирішувало «проїхати»).
  if (Number.isFinite(m.stopAt)) {
    const gap = m.stopAt - m.halfLen - 1;
    if (m.redStop || gap > (m.speed * m.speed) / (2 * 6) + 1) {
      m.redStop = true;
      const left = gap - 1.5;
      want = Math.min(want, left <= 0.3 ? 0 : Math.sqrt(2 * 2 * left));
    }
  } else m.redStop = false;
  return want < 0.1 ? 0 : want;
}

function endBypass(m: Mover): void {
  m.bypass = null;
  m.latGoal = 0;
  m.overtaking = false;
}

/**
 * Обгін по зустрічній (порт): лише без бітів 4/8 (суцільна), коли зустрічна вільна на весь маневр із запасом,
 * дорога попереду пряма (обмеження за кривизною не нижче крейсерської) і до кінця лінії вистачає місця.
 */
function tryOncoming(m: Mover, leader: { gap: number; speed: number; obstacle: Obstacle }, obstacles: readonly Obstacle[]): void {
  if (m.line.flags & 12) return;
  const goal = -(m.line.lane + 1) * m.line.laneWidth;
  const rel = Math.max(2, m.cruise + OVERTAKE_BOOST - leader.speed);
  const need = leader.gap + 2 * m.halfLen + 2 * leader.obstacle.half + 16;
  const time = need / rel;
  if (remaining(m) < need + time * leader.speed + 30) return;
  const clear = Math.min(400, time * (m.cruise + OVERTAKE_BOOST + 20) + 40);
  const path = pathAhead(m, clear);
  if (roadLimit(m, path) < m.cruise * 0.95) return;
  if (leaderOn(m, path, obstacles.filter((o) => o !== leader.obstacle), goal)) return;
  m.latGoal = goal;
  m.bypass = leader.obstacle.pos;
  m.overtaking = true;
}

/** Мережа для пропуску на перехрестях (вузли). */
export interface Net {
  isJunction(node: number): boolean;
}

/** Відстань від початку поточної лінії до машини, м. */
function fromStart(m: Mover): number {
  let d = 0;
  for (let i = 0; i < m.seg; i++) d += m.line.pts[i].distanceTo(m.line.pts[i + 1]);
  return d + segStart(m).distanceTo(m.line.pts[m.seg + 1]) * m.t;
}

/** Перехрестя в кінці поточної лінії ближче JUNCTION_LOOK. */
function junctionAhead(m: Mover, net: Net): { node: number; dist: number } | null {
  if (!net.isJunction(m.line.endNode)) return null;
  const dist = remaining(m);
  return dist < JUNCTION_LOOK ? { node: m.line.endNode, dist } : null;
}

/** Точки шляху через перехрестя (від from до to м уздовж шляху, крок 2 м). */
function through(m: Mover, from: number, to: number): THREE.Vector3[] {
  const { pts, s } = pathAhead(m, to + 2);
  const out: THREE.Vector3[] = [];
  for (let d = Math.max(0, from); d <= to; d += 2) {
    let i = 1;
    while (i < pts.length - 1 && s[i] < d) i++;
    const a = pts[i - 1];
    const b = pts[Math.min(i, pts.length - 1)];
    const len = (s[i] ?? d) - s[i - 1];
    out.push(a.clone().lerp(b, len > 0 ? THREE.MathUtils.clamp((d - s[i - 1]) / len, 0, 1) : 0));
  }
  return out;
}

function crosses(a: THREE.Vector3[], b: THREE.Vector3[]): boolean {
  for (const p of a) for (const q of b) if (Math.hypot(p.x - q.x, p.z - q.z) < CONFLICT_DIST) return true;
  return false;
}

/** Запланований поворот на стику (праворуч — додатний), рад. */
function plannedTurn(m: Mover): number {
  const to = m.plan === null ? null : nextLine(m.line, m.plan, m.line.lane);
  return to ? turnAngle(m.line, to) : 0;
}

/**
 * Чи поступитися на перехресті (порт; у king.exe пропуску немає): тим, хто вже на перехресті й чий шлях перетинає
 * наш; серед тих, хто підʼїжджає (за ETA не пізніше нас + 4 с чи ближче 25 м) і перетинається: хто не встигає
 * загальмувати — їде; хто чекає довше YIELD_MAX — їде; головна дорога (ширша на 3 м) — їде; поворот ліворуч
 * пропускає зустрічного; на рівних — перешкода праворуч.
 */
function mustYield(m: Mover, j: { node: number; dist: number }, obstacles: readonly Obstacle[], net: Net): boolean {
  const canStop = (o: Mover, dist: number) => !(o.speed > 3 && dist < (o.speed * o.speed) / (2 * 4) + 3);
  if (!canStop(m, j.dist)) return false;
  let mine: THREE.Vector3[] | null = null;
  const myEta = j.dist / Math.max(m.speed, 0.5);
  for (const o of obstacles) {
    const om = o.mover;
    if (!om || om === m || om.gone || om.line.siblings === m.line.siblings) continue;
    let inside = false;
    let oDist: number;
    if (om.line.endNode === j.node && net.isJunction(om.line.endNode)) {
      oDist = remaining(om);
      if (oDist > JUNCTION_LOOK) continue;
      if (oDist > 25 && oDist / Math.max(om.speed, 0.5) > myEta + 4) continue;
    } else if (om.line.startNode === j.node && fromStart(om) < INSIDE) {
      inside = true;
      oDist = 0;
    } else continue;
    mine ??= through(m, j.dist - 4, j.dist + 25);
    const theirs = inside ? through(om, 0, 20) : through(om, oDist - 4, oDist + 25);
    if (!crosses(mine, theirs)) continue;
    if (inside) return true;
    if (!canStop(om, oDist)) return true;
    if (m.waitJ > YIELD_MAX && m.waitJ >= om.waitJ) continue;
    if (om.waitJ > YIELD_MAX && om.waitJ > m.waitJ) return true;
    if (om.line.width >= m.line.width + 3) return true;
    if (m.line.width >= om.line.width + 3) continue;
    const dot = m.heading.dot(om.heading);
    if (dot < -0.7) {
      if (plannedTurn(m) < -0.35 && plannedTurn(om) >= -0.35) return true;
      continue;
    }
    // Перешкода праворуч (вектор праворуч — (−z, x)).
    const rx = om.pos.x - m.pos.x;
    const rz = om.pos.z - m.pos.z;
    if (rx * -m.heading.z + rz * m.heading.x > 0) return true;
  }
  return false;
}

/**
 * Фізична машина → логічна позиція (king.exe setPlayerPosition / findPositionOnATrajectory: проєкція на маршрут):
 * найближча точка поточної лінії від m.seg уперед (за кінцем — запланована наступна), бічний зсув, курс, швидкість.
 * Повертає відстань до лінії по горизонталі (далеко — маршрут треба перебудувати).
 */
export function sync(m: Mover, p: THREE.Vector3, fwd: THREE.Vector3, speed: number): number {
  for (let guard = 0; guard < 4; guard++) {
    let best = -1;
    let bestT = 0;
    let bestD = Infinity;
    for (let i = m.seg; i + 1 < m.line.pts.length; i++) {
      const a = i === m.seg ? segStart(m) : m.line.pts[i];
      const b = m.line.pts[i + 1];
      const ab = b.clone().sub(a).setY(0);
      const len2 = ab.lengthSq();
      if (!len2) continue;
      const t = THREE.MathUtils.clamp(((p.x - a.x) * ab.x + (p.z - a.z) * ab.z) / len2, 0, 1);
      const d = Math.hypot(a.x + ab.x * t - p.x, a.z + ab.z * t - p.z);
      if (d < bestD) {
        bestD = d;
        best = i;
        bestT = t;
      }
    }
    if (best < 0) break;
    if (best !== m.seg) m.from = null;
    m.seg = best;
    m.t = bestT;
    // За кінцем лінії — на заплановану наступну.
    if (best === m.line.pts.length - 2 && bestT >= 1) {
      const nx = nextLine(m.line, m.plan, m.line.lane);
      if (!nx) {
        m.gone = true;
        break;
      }
      m.from = m.line.pts[m.line.pts.length - 1].clone();
      m.line = nx;
      m.seg = 0;
      m.t = 0;
      planNext(m);
      continue;
    }
    break;
  }
  const a = segStart(m);
  const dir = m.line.pts[m.seg + 1].clone().sub(a).setY(0).normalize();
  const on = linePoint(m);
  m.lat = (p.x - on.x) * -dir.z + (p.z - on.z) * dir.x;
  m.pos.copy(p);
  m.heading.copy(fwd).setY(0).normalize();
  m.speed = speed;
  return Math.hypot(p.x - on.x, p.z - on.z);
}

/** Точка, за якою кермує фізична машина: шлях уперед на dist м, зсунутий на бажаний бічний зсув (обʼїзд). */
export function carrot(m: Mover, dist: number): THREE.Vector3 {
  const path = pathAhead(m, dist + 5);
  const { pts, s } = path;
  let i = 1;
  while (i < pts.length - 1 && s[i] < dist) i++;
  const a = pts[i - 1];
  const b = pts[Math.min(i, pts.length - 1)];
  const seg = (s[i] ?? dist) - s[i - 1];
  const k = seg > 0 ? THREE.MathUtils.clamp((dist - s[i - 1]) / seg, 0, 1) : 0;
  const out = a.clone().lerp(b, k);
  const d = b.clone().sub(a).setY(0);
  // Зсув — запланований на час, коли машина буде в цій точці (S-крива маневру), а не кінцевий: інакше точка
  // стрибала на ширину смуги й фізична машина смикала кермом.
  const lat = offAt(m, dist / Math.max(2, m.speed));
  if (d.lengthSq() > 1e-6 && lat) {
    d.normalize();
    out.add(new THREE.Vector3(-d.z, 0, d.x).multiplyScalar(lat));
  }
  return out;
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
  m.overtaking = false;
  m.backLane = -1;
  m.waited = 0;
  m.waitJ = 0;
  advance(m, m.cruise * dt);
  place(m, dt);
}
