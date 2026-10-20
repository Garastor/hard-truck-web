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
 *   узбіччям. Зустрічною й узбіччям порт обʼїжджає гравця, його причіп, суперників і машини трафіку, що стоять без
 *   причини (ДТП, застрягла: не в черзі за іншою, не на червоне й не пропускає) понад BYPASS_WAIT с, — після BYPASS_WAIT с
 *   своєї стоянки (інакше в обʼїзд кидається вся черга на стику — гіпотеза порту).
 * - Тупик (порт): машина розвертається на зустрічну смугу (у king.exe маршрут веде до цілі, тупиків на ньому немає;
 *   у порту машина в тупику стояла, доки її видно, — на базах це блокувало рух).
 * - Перешкода, що рухається не по смугах (гравець, суперник), — і там, де вона буде (траєкторія на PREDICT с, крок
 *   PREDICT_STEP): лідер, якщо ми доїдемо до цієї точки шляху майже тоді ж (±CROSS_MARGIN с). Виїзд гравця з бази
 *   поперек смуги трафік інакше помічав, лише коли той уже в смузі.
 * - Маршрут: на кожній лінії заздалегідь вибирається дорога після стику (у king.exe — маршрут до випадкової цілі,
 *   тож повороти так само випадкові); ближче 100 м до стику — перестроювання (changeLanes 0x420360): праворуч —
 *   у крайню праву смугу, ліворуч — у смугу біля осі, прямо — лишитись (іноді — випадкова смуга).
 * - Перестроювання — бічний зсув (у king.exe кінематична машина: lat ← s·lat + (1 − s)·ціль). Порт (відступ на
 *   прохання користувача — «природніше»): зсув іде S-кривою з бічним прискоренням до LAT_ACC (смуга ≈ 3,7 с);
 *   кінематична машина стоїть точно на лінії смуги з цим зсувом, а курс — на близьку точку шляху попереду (без зламів
 *   на вершинах ламаної). Вільний курс дугою до далекої точки пробували — машини зрізали повороти на зустрічну.
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
/** Перестроювання ліворуч перед лівим поворотом — ближче за стільки до стику; не встиг ближче LATE_LEFT — прямо. */
const LEFT_PLAN = 200;
const LATE_LEFT = 30;
const LANE_TAU = 0.9;
/** S-крива бічного зсуву: бічне прискорення, м/с², і найкоротший маневр, с. */
const LAT_ACC = 1.2;
const LAT_MIN_TIME = 1.5;
/** Курс кінематичної машини — на точку шляху за HEADING_LOOK·v м (у межах MIN…MAX): без зламів на вершинах. */
const HEADING_LOOK = 0.35;
const HEADING_MIN = 2;
const HEADING_MAX = 6;
/**
 * Огляд перед перестроюванням (порт): у цільовій смузі машині попереду — не ближче GAP_AHEAD м і не менше
 * T_AHEAD с наздоганяння; тій, що ззаду (зокрема гравцеві), — не ближче GAP_BEHIND м і не менше T_BEHIND с, доки
 * вона нас наздожене; огляд — на LOOK_LANE м уперед і назад.
 */
const GAP_AHEAD = 8;
const T_AHEAD = 3;
const GAP_BEHIND = 6;
const T_BEHIND = 4;
const LOOK_LANE = 90;
/**
 * Гальмування кінематичної машини (порт): сповільнення наростає не швидше JERK м/с³, різко (JERK_HARD) — коли потрібне
 * понад HARD м/с² (підібрано симуляцією: зіткнень — як без обмеження, різких гальмувань — на ≈ 14 % менше).
 */
const JERK = 10;
const JERK_HARD = 40;
const HARD = 3;
/** Покажчик: за скільки секунд до маневру, від якого кута повороту (рад), скільки метрів після стику. */
const SIGNAL_AHEAD = 3;
const SIGNAL_TURN = 0.35;
const SIGNAL_AFTER = 15;
const ACCEL = 2.5;
const BRAKE = 7;
/** Перешкода на шляху, якщо ближче за це до осі смуги (півширина машини + запас), м. */
const PATH_HALF = 2.2;
/** Скільки чекати за перешкодою, що стоїть, перш ніж обʼїжджати зустрічною чи узбіччям, с. */
const BYPASS_WAIT = 3;
/** Передбачення руху перешкоди не на смугах (гравець): на скільки, з яким кроком і допуском часу зустрічі, с. */
const PREDICT = 3;
const PREDICT_STEP = 0.25;
const CROSS_MARGIN = 1.5;
/** Точка обʼїзду (перед тіла, яке обʼїжджаємо) далі за стільки — обʼїзд скасовано, м. */
const BYPASS_LOST = 80;
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
/**
 * Перехрестя з кількох вузлів WAY (порт): пропуск зважає на машини біля всіх вузлів ближче за стільки метрів —
 * симуляція: зіткнення під прямим кутом переважно між машинами різних близьких вузлів.
 */
const JUNCTION_CLUSTER = 40;

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
  /** Скільки стоїть (швидкість < 0,5 м/с), с, і чи з причини руху (черга за машиною, червоне, пропуск). */
  still: number;
  queued: boolean;
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
  /** Поточне прискорення кінематичної машини, м/с² (для плавного гальмування). */
  acc: number;
  /** Кут повороту на останньому стику ліній (праворуч — додатний), рад — покажчик тримається й після стику. */
  turned: number;
  /**
   * Запланований бічний зсув від лінії (S-крива від offFrom до offTo за offDur с, пройдено offT с): за ним їдуть і
   * кінематична, і фізична машина (carrot); lat — фактичний.
   */
  off: number;
  offFrom: number;
  offTo: number;
  offT: number;
  offDur: number;
  /** Розворот перед закритою завалом дорогою (null — немає). */
  uturn?: UTurn | null;
  /**
   * Маршрут (бот-далекобійник з рейсом, traffic/botDriver.ts): точна лінія після стику (Freight.next — найкоротший шлях
   * до місця складу); null чи немає — як трафік (цілі-міста й випадкова дорога).
   */
  route?: ((l: RoadLine) => RoadLine | null) | null;
  /** Лінія після стику за маршрутом (route); null — без маршруту чи шляху немає. */
  via?: RoadLine | null;
  /** Довжина позаду понад halfLen (напівпричіп тягача), м: обʼїзд закінчується й перестроювання дивиться ззаду з нею. */
  tail?: number;
  /** Множник швидкості на кривих (тягач з причепом — повільніше), 1 — як трафік. */
  bend?: number;
  /** Тіло, яке обганяємо по зустрічній (усі його точки — не лідер). */
  passBody?: Obstacle | null;
  /** Почати обʼїзд чи обгін сусідньою смугою раніше на стільки секунд ходу (довга машина — довше перестроюється), с. */
  early?: number;
  /**
   * Ширша за легковик (вантажівка), м: на стільки більше PATH_HALF для перешкод, що не їдуть назустріч, — тіло, що
   * виступає в смугу, для неї зайняте (зустрічні в сусідній смузі — ні, інакше гальмувала б перед кожною).
   */
  wide?: number;
}

/** Продовження після кінця поточної лінії: за маршрутом, інакше — запланована дорога в смугу, найближчу за номером. */
function nextOf(m: Mover): RoadLine | null {
  return m.via ?? (m.plan === null ? null : nextLine(m.line, m.plan, m.line.lane));
}

/**
 * Розворот (порт; у king.exe маршрут ІІ просто оминає дорогу з прапорцем 0x40, як розвертається машина, що вже на
 * ній, не розібрано): півеліпс від точки p з курсом h на зустрічну смугу — f м уперед, w м ліворуч, 3 м/с.
 */
interface UTurn {
  p: THREE.Vector3;
  h: THREE.Vector3;
  left: THREE.Vector3;
  /** Зсув кінцевої точки вздовж h і ліворуч, м; виліт уперед, м. */
  d0: number;
  w: number;
  f: number;
  y1: number;
  u: number;
  len: number;
  to: RoadLine;
  seg: number;
  t: number;
}

const UTURN_SPEED = 3;

/** Машина на закритій дорозі їде до завалу (від нього — хай виїжджає). */
function towardBlock(m: Mover): boolean {
  const b = m.line.blockAt;
  if (!m.line.closed) return false;
  if (!b) return true;
  return (b.x - m.pos.x) * m.heading.x + (b.z - m.pos.z) * m.heading.z > 0;
}

/** Найближча точка лінії до p. */
function nearestOnLine(line: RoadLine, p: THREE.Vector3): { seg: number; t: number; point: THREE.Vector3 } {
  let best = { seg: 0, t: 0, point: line.pts[0].clone() };
  let bd = Infinity;
  for (let i = 0; i + 1 < line.pts.length; i++) {
    const q = new THREE.Line3(line.pts[i], line.pts[i + 1]);
    const t = q.closestPointToPointParameter(p, true);
    const pt = q.at(t, new THREE.Vector3());
    const d = Math.hypot(pt.x - p.x, pt.z - p.z);
    if (d < bd) {
      bd = d;
      best = { seg: i, t, point: pt };
    }
  }
  return best;
}

/** Почати розворот на крайню праву зустрічну смугу; false — зустрічних смуг немає. */
function startUTurn(m: Mover): boolean {
  const opp = m.line.opposite;
  if (!opp?.length) return false;
  const to = opp.reduce((a, b) => (b.lane > a.lane ? b : a));
  const p = m.pos.clone();
  const q = nearestOnLine(to, p);
  const h = m.heading.clone().setY(0).normalize();
  const left = new THREE.Vector3(h.z, 0, -h.x);
  const rel = q.point.clone().sub(p);
  const w = Math.max(3, rel.dot(left));
  const d0 = rel.dot(h);
  const f = Math.max(6, 1.5 * m.halfLen);
  // Довжина півеліпса (наближення Рамануджана, половина).
  const a = f;
  const b = w / 2;
  const len = (Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)))) / 2;
  m.uturn = { p, h, left, d0, w, f, y1: q.point.y, u: 0, len, to, seg: q.seg, t: q.t };
  m.bypass = null;
  m.overtaking = false;
  m.backLane = -1;
  return true;
}

/** Крок розвороту; instant — одразу в кінець (далека машина). */
function stepUTurn(m: Mover, dt: number, instant = false): void {
  const r = m.uturn!;
  r.u = instant ? 1 : Math.min(1, r.u + (UTURN_SPEED * dt) / r.len);
  const th = Math.PI * r.u;
  const along = r.f * Math.sin(th) + (r.d0 * (1 - Math.cos(th))) / 2;
  const side = (r.w * (1 - Math.cos(th))) / 2;
  m.pos.copy(r.p).addScaledVector(r.h, along).addScaledVector(r.left, side);
  m.pos.y = THREE.MathUtils.lerp(r.p.y, r.y1, r.u);
  const dir = r.h.clone().multiplyScalar(r.f * Math.cos(th) + (r.d0 * Math.sin(th)) / 2).addScaledVector(r.left, (r.w * Math.sin(th)) / 2);
  if (dir.lengthSq() > 1e-6) m.heading.copy(dir.setY(0).normalize());
  m.speed = instant ? 0 : UTURN_SPEED;
  if (r.u < 1) return;
  m.uturn = null;
  m.line = r.to;
  m.seg = Math.min(r.seg, r.to.pts.length - 2);
  m.t = r.t;
  m.from = null;
  m.lat = m.off = m.latGoal = m.offFrom = m.offTo = 0;
  m.speed = 0;
  planNext(m);
}

/** Фізична машина перед завалом: маршрут — на зустрічну смугу (розвертається сама, за морквиною позаду). */
function turnBack(m: Mover): boolean {
  const opp = m.line.opposite;
  if (!opp?.length) return false;
  const to = opp.reduce((a, b) => (b.lane > a.lane ? b : a));
  const q = nearestOnLine(to, m.pos);
  retrace(m, to, q.seg, q.t);
  return true;
}

export interface Obstacle {
  pos: THREE.Vector3;
  /** Швидкість, м/с (вектор). */
  vel: THREE.Vector3;
  /** Півдовжина, м. */
  half: number;
  /** Машина трафіку (для перевірки смуг при перестроюванні). */
  mover?: Mover;
  /** Тіло, якому належить точка (вантажівка — кілька точок уздовж): обʼїжджають тіло цілком. */
  group?: object;
}

/** Та сама перешкода чи інша точка того самого тіла. */
function sameBody(a: Obstacle, b: Obstacle): boolean {
  return a === b || (a.group !== undefined && a.group === b.group);
}

/** Машина трафіку стоїть без причини (ДТП, застрягла) — її обʼїжджають, як гравця. */
function stalled(o: Mover): boolean {
  return o.still > BYPASS_WAIT && !o.queued;
}

/** Точка тіла перешкоди, найдальша вперед за курсом heading (кінець обʼїзду — коли минули її). */
function frontOf(o: Obstacle, obstacles: readonly Obstacle[], heading: THREE.Vector3): THREE.Vector3 {
  let best = o.pos;
  for (const x of obstacles) if (sameBody(x, o) && x.pos.dot(heading) > best.dot(heading)) best = x.pos;
  return best;
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
    still: 0,
    queued: false,
    overtaking: false,
    backLane: -1,
    waitJ: 0,
    stopAt: Infinity,
    redStop: false,
    plan: null,
    wantLane: line.lane,
    gone: false,
    acc: 0,
    turned: 0,
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
  // Без нових векторів (щокадру для кожної машини): atan2(×, ·) не залежить від довжин напрямків.
  const n = a.pts.length;
  const p1 = a.pts[n - 1];
  const p0 = a.pts[n - 2];
  const q1 = b.pts[Math.min(2, b.pts.length - 1)];
  const q0 = b.pts[0];
  const ix = p1.x - p0.x;
  const iz = p1.z - p0.z;
  const ox = q1.x - q0.x;
  const oz = q1.z - q0.z;
  return Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz);
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

/** Штраф маршруту за поворот, м/рад (порт). */
const TURN_COST = 25;
/**
 * Штраф маршруту за проїзд територією бази, м (порт, на прохання користувача): база — для вантажівок, що
 * вантажаться; трафік (легковики, автобуси) їде повз неї магістраллю, навіть якщо через базу коротше.
 */
const BASE_COST = 3000;
/**
 * Штраф за під'їзд заправки чи СТО, м (порт, на прохання користувача): трафік туди не заїжджає ніколи, якщо є хоч
 * якийсь інший шлях. 3000 м мало: петля СТО db — розворот, що скорочує маршрут на кілометри.
 */
const STATION_COST = 100_000;
const windings = new WeakMap<RoadLine, number>();

/** Штраф лінії для маршрутів трафіку (Navigator): звивистість, м. */
export function routePenalty(l: RoadLine): number {
  return TURN_COST * winding(l) + (l.base ? BASE_COST : 0) + (l.station ? STATION_COST : 0);
}

/** Продовження без вʼїзду на базу, заправку, СТО чи зрізалку (world/roads markBases, markStations, markShortcuts), якщо таке є. */
function offBase(lines: RoadLine[]): RoadLine[] {
  const out = lines.filter((l) => !l.base && !l.station && !l.shortcut);
  return out.length ? out : lines.filter((l) => !l.shortcut);
}

/**
 * Штраф лінії для маршрутів ботів-далекобійників (traffic/freight.ts): звивистість і під'їзди заправок і СТО; територія
 * баз — без штрафу (бот туди й їде вантажитись).
 */
export function freightPenalty(l: RoadLine): number {
  return TURN_COST * winding(l) + (l.station ? STATION_COST : 0);
}

/** Сума кутів повороту всередині лінії, рад. */
function winding(l: RoadLine): number {
  let w = windings.get(l);
  if (w !== undefined) return w;
  w = 0;
  let prev: THREE.Vector3 | null = null;
  for (let i = 1; i < l.pts.length; i++) {
    const d = l.pts[i].clone().sub(l.pts[i - 1]).setY(0);
    if (d.lengthSq() < 0.25) continue;
    d.normalize();
    if (prev) w += Math.acos(THREE.MathUtils.clamp(prev.dot(d), -1, 1));
    prev = d;
  }
  windings.set(l, w);
  return w;
}

/** Перепланувати продовження (новий маршрут бота). */
export function replan(m: Mover): void {
  planNext(m);
}

/**
 * Маршрут бота: наступна лінія — з route; смуга — як у трафіку (права, перед лівим поворотом — ліва), але лише серед
 * сусідніх смуг, з яких маршрут теж веде до цілі. false — маршруту немає (план — як у трафіку).
 */
function planRoute(m: Mover): boolean {
  m.via = m.route ? m.route(m.line) : null;
  if (!m.via) return false;
  m.plan = m.via.road;
  const left = turnAngle(m.line, m.via) < -0.35;
  let want = m.line.lane;
  for (const sib of m.line.siblings) {
    if (sib === m.line || sib.pts.length !== m.line.pts.length || !m.route!(sib)) continue;
    if (left ? sib.lane < want : sib.lane > want) want = sib.lane;
  }
  m.wantLane = want;
  return true;
}

function planNext(m: Mover): void {
  if (m.route !== undefined && planRoute(m)) return;
  // Закриту завалом дорогу оминаємо, якщо є інша (world/obstacles.ts).
  const all = m.line.next as RoadLine[];
  const open = all.filter((l) => !l.closed);
  const next = offBase(open.length ? open : all);
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
      // Порт: звивистість — штраф TURN_COST м за радіан повороту на стику й усередині лінії. Без нього на базах
      // ланцюжок паркувальних кишень (по 27 м з поворотом 94°) і пряма поруч майже однакові за довжиною — трафік
      // навмання їхав кишенями й виписував зигзаги.
      const d = (g.get(l) ?? Infinity) + l.length + TURN_COST * (Math.abs(turnAngle(m.line, l)) + winding(l));
      if (d < bd) {
        bd = d;
        best = l;
      }
    }
    if (best) m.plan = best.road;
  }
  const to = m.plan === null ? null : nextLine(m.line, m.plan, m.line.lane);
  const turn = to ? turnAngle(m.line, to) : 0;
  // Порт (на прохання користувача): триматися крайньої правої; ліва — лише для лівого повороту (і обгону). У king.exe
  // прямо — лишитись у своїй смузі, іноді випадкова.
  m.wantLane = turn < -0.35 ? 0 : m.line.lanes - 1;
}

/** Лівий поворот не з лівої смуги: інша дорога після стику — прямо чи праворуч, якщо така є; смуга — права. */
function giveUpLeft(m: Mover): void {
  // За маршрутом дорога одна: продовження з цієї смуги теж веде до цілі.
  if (m.via) return;
  const roads = [...new Set(offBase(m.line.next as RoadLine[]).map((l) => l.road))];
  const ok = roads.filter((r) => {
    const to = nextLine(m.line, r, m.line.lane);
    return to && turnAngle(m.line, to) >= -0.35;
  });
  if (!ok.length) return;
  m.plan = ok[Math.floor(Math.random() * ok.length)];
  m.wantLane = m.line.lanes - 1;
}

/** Продовження лінії на дорогу road — у смугу, найближчу за номером. */
function nextLine(line: RoadLine, road: number | null, lane: number): RoadLine | null {
  // На закриту завалом дорогу й на зрізалку не заїжджаємо (з закритої — можна: машина вже там і має з неї виїхати);
  // дорога, що далі веде лише на зрізалки (ag_010, ah_010), — тупик: розворот.
  // Без проміжних масивів (щокадру для кожної машини): найближча смуга серед ліній тієї ж дороги, без них — серед усіх.
  let best: RoadLine | null = null;
  let any: RoadLine | null = null;
  for (const l of line.next as RoadLine[]) {
    if (!((line.closed || !l.closed) && (line.shortcut || !l.shortcut))) continue;
    if (!any || Math.abs(l.lane - lane) < Math.abs(any.lane - lane)) any = l;
    if (road !== null && l.road === road && (!best || Math.abs(l.lane - lane) < Math.abs(best.lane - lane))) best = l;
  }
  return road === null ? any : (best ?? any);
}

/** Найпряміше продовження (для огляду за межею запланованого). */
function straightest(line: RoadLine): RoadLine | null {
  let best: RoadLine | null = null;
  let bestTurn = Infinity;
  for (const l of line.next as RoadLine[]) {
    if (l.shortcut && !line.shortcut) continue;
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
      const nx = first ? nextOf(m) : straightest(line);
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
  if (k > K_LIMIT) v = Math.min(v, Math.max(V_CURVE_MIN, Math.sqrt(5 / k)) * (m.bend ?? 1));
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
  const ahead = new THREE.Vector3();
  for (const o of obstacles) {
    if (o.mover === m) continue;
    const dist = o.pos.distanceTo(m.pos);
    if (dist > reach + PREDICT * o.vel.length()) continue;
    // Перешкода не на смугах (гравець) — ще й на своїй траєкторії: точка через tau с — перешкода, якщо ми будемо там
    // майже тоді ж.
    const moving = !o.mover && o.vel.lengthSq() >= 1;
    for (let tau = 0; tau <= (moving ? PREDICT : 0) + 1e-6; tau += PREDICT_STEP) {
      const q = tau ? ahead.copy(o.pos).addScaledVector(o.vel, tau).setY(o.pos.y) : o.pos;
      let hit = false;
      for (let i = 0; i + 1 < path.pts.length; i++) {
        const a = path.pts[i];
        ab.subVectors(path.pts[i + 1], a).setY(0);
        const len = ab.length();
        if (!len) continue;
        ab.divideScalar(len);
        const along = (q.x - a.x) * ab.x + (q.z - a.z) * ab.z;
        if (along < -o.half || along > len + o.half) continue;
        const s = path.s[i] + THREE.MathUtils.clamp(along, 0, len);
        // Бічна відстань праворуч від шляху (вектор праворуч — (−z, x)) мінус наш зсув — запланований на мить, коли
        // доїдемо до перешкоди (S-крива маневру), якщо не задано інший.
        const side = Math.abs((q.z - a.z) * ab.x - (q.x - a.x) * ab.z - (lat ?? offAt(m, s / Math.max(2, m.speed))));
        if (side > PATH_HALF + (m.wide && o.vel.x * ab.x + o.vel.z * ab.z > -1 ? m.wide : 0)) continue;
        if (s <= 0.5) continue; // поруч чи позаду — не лідер
        if (tau && Math.abs(s / Math.max(2, m.speed) - tau) > CROSS_MARGIN) continue;
        const gap = s - m.halfLen - o.half;
        if (!best || gap < best.gap) best = { gap, speed: Math.max(0, o.vel.x * ab.x + o.vel.z * ab.z), obstacle: o };
        hit = true;
        break;
      }
      if (hit) break;
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
    if (side >= PATH_HALF + (m.wide ?? 0) || Math.abs(along) > LOOK_LANE) continue;
    const ov = o.vel.x * fwd.x + o.vel.z * fwd.z;
    const gap = Math.abs(along) - m.halfLen - o.half;
    if (gap < 2) return false;
    // Попереду: не ближче GAP_AHEAD і не менше T_AHEAD с наздоганяння; ззаду: не ближче GAP_BEHIND і не менше T_BEHIND с,
    // доки задній наздожене (гравець ззаду на швидкості — не підрізати).
    if (along > 0 && (gap < GAP_AHEAD || gap < (m.speed - ov) * T_AHEAD)) return false;
    if (along <= 0 && (gap - (m.tail ?? 0) < GAP_BEHIND || gap - (m.tail ?? 0) < (ov - m.speed) * T_BEHIND)) return false;
  }
  return true;
}

/** Перестроїтися на сусідню смугу (на одну), зберігши місце: бічний зсув компенсує різницю й згасає S-кривою. */
function changeLane(m: Mover, to: number): void {
  const sib = m.line.siblings[to];
  if (!sib || sib === m.line || sib.pts.length !== m.line.pts.length) return;
  // За маршрутом — лише в смугу, з якої шлях до цілі теж є.
  const via = m.route ? m.route(sib) : null;
  if (m.route && !via) return;
  const d = (m.line.lane - to) * m.line.laneWidth;
  m.lat += d;
  m.off += d;
  m.line = sib;
  if (via) m.via = via;
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
  if (m.uturn) return stepUTurn(m, dt);
  // Дорогу, якою їде, закрив завал — розвертається.
  if (towardBlock(m) && startUTurn(m)) return stepUTurn(m, dt);
  const want = decide(m, dt, obstacles, net);
  const dv = want - m.speed;
  // Потрібне прискорення — як було (розгін 0,3 + 0,6·Δv до 2,5; гальмування 0,8·Δv, не менше 2,5, зупинка — 7 м/с²):
  // м'якша формула (від 1,5 м/с², зупинка за швидкістю) втричі збільшувала зіткнення в симуляції.
  const goal = dv > 0 ? Math.min(ACCEL, 0.3 + 0.6 * dv) : want === 0 ? -BRAKE : -Math.min(BRAKE, Math.max(2.5, 0.8 * -dv));
  // Сповільнення наростає не миттєво (JERK), різко (JERK_HARD) — коли потрібне понад HARD; відпускається одразу.
  const jerk = goal < -HARD ? JERK_HARD : JERK;
  m.acc = goal < m.acc ? Math.max(goal, m.acc - jerk * dt) : goal;
  const acc = m.acc;
  m.speed = Math.max(0, dv > 0 ? Math.min(want, m.speed + acc * dt) : acc < 0 ? Math.max(want, m.speed + acc * dt) : m.speed);
  advance(m, m.speed * dt);
  // Позиція — точно на лінії смуги з запланованим зсувом (S-крива маневру); курс — на близьку точку шляху попереду
  // (без зламів на вершинах ламаної), але сама машина зі смуги не зрізає (дуги з далекою точкою виводили її на
  // зустрічну в поворотах — симуляція: зіткнень лоб у лоб удесятеро більше).
  m.lat = m.off;
  place(m, dt);
  const look = THREE.MathUtils.clamp(HEADING_LOOK * m.speed, HEADING_MIN, HEADING_MAX);
  const to = carrot(m, look).sub(m.pos).setY(0);
  if (to.lengthSq() > 0.01) m.heading.copy(to.normalize());
}

/** Фізична → кінематична: запланований зсув — від того, де машина є, назад до цілі S-кривою. */
export function settleFrom(m: Mover): void {
  m.off = m.lat;
  shiftTo(m, m.latGoal);
}

/** Рішення водія (і кінематичного, і фізичного): перестроювання, обʼїзд, обгін, пропуск, цільова швидкість, м/с. */
export function decide(m: Mover, dt: number, obstacles: readonly Obstacle[], net: Net | null = null): number {
  updateOff(m, dt);
  const path = pathAhead(m, LEADER_RANGE);
  // Машину, яку обганяємо, лідером не вважаємо (вона збоку чи позаду).
  const pass = m.passBody;
  const others = m.overtaking && m.bypass ? obstacles.filter((o) => o.pos !== m.bypass && !(pass && sameBody(o, pass))) : obstacles;
  const leader = leaderOn(m, path, others);
  const junction = net ? junctionAhead(m, net) : null;

  // Перестроювання: перед поворотом (ближче LANE_PLAN до стику) чи обʼїзд повільної перешкоди.
  const lane = m.line.lane;
  const toEnd = remaining(m);
  if (m.bypass) {
    // Перешкоду минули — назад у смугу.
    const rel = m.bypass.clone().sub(m.pos);
    if (rel.x * m.heading.x + rel.z * m.heading.z < -(m.halfLen + (m.tail ?? 0) + 8) || rel.lengthSq() > BYPASS_LOST * BYPASS_LOST) endBypass(m);
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
  const slow = !!leader && leader.gap < LEADER_GAP + FOLLOW_ZONE + (m.early ?? 0) * m.speed && (leader.speed <= SLOW_OBSTACLE || (!!leader.obstacle.mover && leader.speed < m.cruise - OVERTAKE_DV));
  if (settled && leader && (!leader.obstacle.mover || stalled(leader.obstacle.mover)) && m.waited > BYPASS_WAIT) {
    // Своя смуга заблокована гравцем, суперником чи машиною після ДТП: сусідня смуга, інакше зустрічна, інакше узбіччя.
    const w = m.line.laneWidth;
    const goals = [m.line.lane > 0 ? -w : null, m.line.lane < m.line.lanes - 1 ? w : null, m.line.flags & 12 ? null : -(m.line.lane + 1) * w, (m.line.lanes - m.line.lane) * w];
    for (const g of goals) {
      if (g === null) continue;
      const same = leaderOn(m, path, obstacles, g);
      if (same && sameBody(same.obstacle, leader.obstacle)) continue;
      const block = leaderOn(m, path, obstacles.filter((o) => !sameBody(o, leader.obstacle)), g);
      if (block && block.gap < BYPASS_CLEAR) continue;
      m.latGoal = g;
      m.bypass = frontOf(leader.obstacle, obstacles, m.heading);
      m.waited = 0;
      break;
    }
  } else if (canShift && slow && leader) {
    // Обгін сусідньою смугою свого напрямку: рухомого — лише ліворуч (ближче до осі), того, хто стоїть, — будь-якою.
    const sides = leader.speed <= SLOW_OBSTACLE ? [lane - 1, lane + 1] : [lane - 1];
    let done = false;
    for (const to of sides)
      if (to >= 0 && to < m.line.lanes && laneFree(m, m.line.siblings[to], obstacles) && !blocksToo(m, path, obstacles, leader.obstacle, (to - lane) * m.line.laneWidth)) {
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
    } else if (m.wantLane !== lane && (m.wantLane > lane || toEnd < LEFT_PLAN || m.line.next.length === 0)) {
      // Праворуч (триматися правої) — будь-коли, щойно вільно; ліворуч (лівий поворот) — ближче LEFT_PLAN до стику.
      const to = lane + Math.sign(m.wantLane - lane);
      if (laneFree(m, m.line.siblings[to], obstacles)) changeLane(m, to);
    }
  }

  // Не встиг у ліву смугу до лівого повороту — не повертати через смуги, а їхати прямо чи праворуч (порт).
  if (m.wantLane < lane && toEnd < LATE_LEFT && lane > 0) giveUpLeft(m);

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
  // Підповзати впритул (бажана швидкість, пропорційна залишку дистанції) — неприродно: менше 0,3 м/с — стоїть.
  if (want < 0.3) want = 0;
  // Чи стоїть з причини руху (черга за машиною, червоне, пропуск) — інакше її обʼїжджають (stalled).
  m.still = m.speed < 0.5 ? m.still + dt : 0;
  m.queued = want < 1 && ((!!leader?.obstacle.mover && leader.gap < LEADER_GAP + FOLLOW_ZONE) || m.redStop || m.waitJ > 0);
  return want;
}

/** Та сама перешкода перекриває й шлях зі зсувом lat (сусідню смугу): перестроюватися туди марно — гойдалися б між смугами. */
function blocksToo(m: Mover, path: { pts: THREE.Vector3[]; s: number[] }, obstacles: readonly Obstacle[], o: Obstacle, lat: number): boolean {
  const there = leaderOn(m, path, obstacles, lat);
  return !!there && sameBody(there.obstacle, o);
}

function endBypass(m: Mover): void {
  m.bypass = null;
  m.passBody = null;
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
  const need = leader.gap + 2 * m.halfLen + (m.tail ?? 0) + 2 * leader.obstacle.half + 16;
  const time = need / rel;
  if (remaining(m) < need + time * leader.speed + 30) return;
  const clear = Math.min(400, time * (m.cruise + OVERTAKE_BOOST + 20) + 40);
  const path = pathAhead(m, clear);
  if (roadLimit(m, path) < m.cruise * 0.95) return;
  if (leaderOn(m, path, obstacles.filter((o) => !sameBody(o, leader.obstacle)), goal)) return;
  m.latGoal = goal;
  m.bypass = frontOf(leader.obstacle, obstacles, m.heading);
  m.passBody = leader.obstacle;
  m.overtaking = true;
}

/** Мережа для пропуску на перехрестях (вузли). */
export interface Net {
  isJunction(node: number): boolean;
  /** Положення вузлів (перехрестя WAY часто з кількох близьких вузлів — пропуск дивиться на всі). */
  nodes?: readonly { pos: THREE.Vector3 }[];
}

/** Вузли одного перехрестя: той самий чи ближче JUNCTION_CLUSTER м. */
function sameJunction(net: Net, a: number, b: number): boolean {
  if (a === b) return true;
  const pa = net.nodes?.[a]?.pos;
  const pb = net.nodes?.[b]?.pos;
  return !!pa && !!pb && Math.hypot(pa.x - pb.x, pa.z - pb.z) < JUNCTION_CLUSTER;
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
/**
 * Покажчик повороту (порт, на прохання користувача — у king.exe покажчиків немає): −1 ліворуч, 1 праворуч, 0 — ні.
 * Під час бічного маневру (перестроювання, обʼїзд, обгін); за SIGNAL_AHEAD с до перестроювання в смугу повороту й до
 * стику з поворотом понад SIGNAL_TURN; після стику — ще SIGNAL_AFTER м нової лінії.
 */
export function turnSignal(m: Mover): -1 | 0 | 1 {
  if (m.gone) return 0;
  if (m.offDur > 0 && Math.abs(m.offTo - m.offFrom) > 1) return m.offTo > m.offFrom ? 1 : -1;
  const toEnd = remaining(m);
  const soon = Math.max(m.speed, 3) * SIGNAL_AHEAD + 10;
  if (m.wantLane !== m.line.lane && toEnd < Math.min(LANE_PLAN, soon)) return m.wantLane > m.line.lane ? 1 : -1;
  if (toEnd < soon) {
    const t = plannedTurn(m);
    if (Math.abs(t) > SIGNAL_TURN) return t > 0 ? 1 : -1;
  }
  if (Math.abs(m.turned) > SIGNAL_TURN && fromStart(m) < SIGNAL_AFTER) return m.turned > 0 ? 1 : -1;
  return 0;
}

function plannedTurn(m: Mover): number {
  const to = nextOf(m);
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
    if (net.isJunction(om.line.endNode) && sameJunction(net, om.line.endNode, j.node)) {
      oDist = remaining(om);
      if (oDist > JUNCTION_LOOK) continue;
      if (oDist > 25 && oDist / Math.max(om.speed, 0.5) > myEta + 4) continue;
    } else if (sameJunction(net, om.line.startNode, j.node) && fromStart(om) < INSIDE) {
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
  m.uturn = null;
  if (towardBlock(m)) turnBack(m);
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
      const nx = nextOf(m);
      if (!nx && turnBack(m)) continue;
      if (!nx) {
        m.gone = true;
        break;
      }
      m.from = m.line.pts[m.line.pts.length - 1].clone();
      m.turned = turnAngle(m.line, nx);
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
      const nx = nextOf(m);
      // Тупик чи дорогу перекрито завалом — розворот на зустрічну смугу (без неї — прибрати).
      if (!nx) {
        m.seg = m.line.pts.length - 2;
        m.t = 1;
        place(m, 0);
        if (startUTurn(m)) return;
      }
      if (!nx) {
        m.gone = true;
        m.seg = m.line.pts.length - 2;
        m.t = 1;
        return;
      }
      m.turned = turnAngle(m.line, nx);
      m.line = nx;
      m.seg = 0;
      m.from = p1.clone();
      planNext(m);
    }
  }
}

const PLACE_DIR = new THREE.Vector3();
const PLACE_RIGHT = new THREE.Vector3();

/** Позиція й напрям з лінії й бічного зсуву. */
function place(m: Mover, dt: number): void {
  const a = segStart(m);
  const b = m.line.pts[m.seg + 1];
  // Робочі вектори модуля: place — щокадру для кожної машини трафіку й привида.
  const dir = PLACE_DIR.subVectors(b, a).setY(0);
  if (dir.lengthSq() < 1e-8) return;
  dir.normalize();
  const right = PLACE_RIGHT.set(-dir.z, 0, dir.x);
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
  if (m.uturn || (towardBlock(m) && startUTurn(m))) return stepUTurn(m, dt, true);
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
