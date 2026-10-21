import * as THREE from 'three';
import type { WayLine } from '../engine/vehicle/autopilot';
import type { Way } from '../formats/way';
import { toThree } from './world';

/**
 * Дорожня мережа Дальнобойщиків 2 з файлів WAY (усі регіони); реверс king.exe — re/notes/ht2/traffic.md.
 *
 * Вісь дороги — сегмент RSEG: з бітом 1 в ATTR — кубічна крива Безьє з 4 точок (кінці й дві контрольні; king.exe
 * 0x406600), інакше — ламана. WDTH — повна ширина W (обидва числа в даних рівні). Рух правосторонній; смуг у кожному
 * напрямку n = ⌊(W/2 + 1,75) / 3,5⌋ (щонайменше одна), ширина смуги W/2 / n, центр смуги k — (k + 0,5)·ширина
 * праворуч від осі (king.exe 0x4d4620). Кожна смуга кожного напрямку — окрема лінія руху.
 *
 * Розділені шосе (гіпотеза порту): дві осі з бітами 4/8 впритул паралельно (≤ 6 м) — дві проїжджі частини; по кожній
 * їдуть лише в тому напрямку, де сусідня вісь ліворуч (на даних: у 136 парах біт 4 + біт 8 сусід з бітом 8 ліворуч від
 * осі з бітом 4). Інакше дороги двобічні.
 *
 * Зʼєднання — між кінцями осей (ближче за JOIN): з кінця напрямку на початок напрямку іншої осі, без розворотів (кут
 * понад TURN_MAX); смуга k → смуга k (обмежено кількістю смуг), крайня права — ще й на всі зайві праворуч. Між кінцем
 * лінії й початком наступної лишається проміжок (зсув смуг на повороті) — його проїжджають навпростець.
 *
 * Інтерфейс — як у WayNet першої гри (lines, nearest, advance): той самий AutoPilot їздить і тут.
 */
const JOIN = 6;
/** Найбільший поворот на стику, рад (більший — розворот, не продовження). */
const TURN_MAX = THREE.MathUtils.degToRad(100);
/** Розділене шосе: друга вісь не далі за це, м, і паралельна (|cos| > PAIR_COS). */
const PAIR_DIST = 6;
const PAIR_COS = 0.9;
/** Крок розгортання кривої Безьє, м. */
const BEZIER_STEP = 3;
/** Лінія бази — ближче за стільки (у плані) від вузла місця причепа чи воріт складу, м (markBases). */
const BASE_R = 30;
/** Під'їзд заправки чи СТО — вісь з бітом 0x20 ближче за стільки (у плані) від вузла колонки чи СТО, м (markStations). */
const STATION_R = 10;
/**
 * Вузли заправок і СТО в WAY: колонки `node_car_fuel*`, `benzo_*`/`node_benzo_*`, СТО `sto_*`/`node_sto_*` і місця
 * ремонту `node_car_repair_*` (СТО ca має лише `node_sto_ca` і `node_car_repair_ca`).
 */
const STATION_NODE = /^(sto_|node_sto_|node_car_fuel|node_car_repair|benzo_|node_benzo_)/i;
/** Під'їзд вужчий за вулицю (3–8 м); ширша вісь біля колонки — вулиця повз заправку (ar_048, aj_032: 12 м), м. */
const STATION_W = 10;
/** Вузька вісь 0x20, що прилягає до під'їзду, не довша за це, — в'їзд у двір станції, м (СТО bb, bd: 19–36 м). */
const STATION_ENTRY = 40;
/** Від центру смуги бази чи вузької петлі до стіни праворуч — щонайменше, м (clearWalls; вантажівка — 2,5 м). */
const WALL_CLEAR = 3;
/** Найбільший зсув лінії від стіни, м. */
const WALL_SHIFT = 1.5;
/** Смуга, вужча за це, — петля майданчика (петлі баз — по 2,5 м), м. */
const NARROW_LANE = 2.8;

/** Відстань від точки p лінії до стіни в бік side (брусок 2·half уздовж along), м; Infinity — далі за max. */
export type WallProbe = (p: THREE.Vector3, along: THREE.Vector3, side: THREE.Vector3, half: number, max: number) => number;

export interface RoadLine extends WayLine {
  /** Повна ширина дороги W, м. */
  width: number;
  region: string;
  /** Індекс осі в `Ht2Roads.axes`. */
  road: number;
  /** Смуга від осі (0 — біля осі); −1 — сама вісь. */
  lane: number;
  /** Смуг у цьому напрямку і ширина смуги, м. */
  lanes: number;
  laneWidth: number;
  /** Прапорці ATTR сегмента. */
  flags: number;
  /** Клас ATTR (1/2/3; частота появи привидів ×1 / ×0,5 / ×0,25). */
  cls: number;
  /** Довжина, м. */
  length: number;
  /** Усі смуги того самого напрямку дороги за номером (для перестроювання); в осі — порожньо. */
  siblings: RoadLine[];
  /** Вузли мережі на початку й кінці лінії (індекси `Ht2Roads.nodes`; в осі — за напрямком точок). */
  startNode: number;
  endNode: number;
  /** Проїзд територією бази чи складу (порт, `markBases`): трафік туди не звертає, якщо є інший шлях. */
  base?: boolean;
  /** Під'їзд заправки чи СТО (порт, `markStations`): трафік і боти туди не звертають, якщо є інший шлях. */
  station?: boolean;
  /**
   * «Зрізалка» — ґрунтовка чи стежка з бітами 0x20 і 0x40 (king.exe: маршрути ІІ оминають 0x40, випадкові точки появи —
   * 0x20/0x40; `markShortcuts`): їздить лише гравець — трафік, боти, міліція й мафія туди не звертають і не зʼявляються.
   */
  shortcut?: boolean;
  /**
   * Ділянка карти, що відкривається проїздом (індекс `Ht2Roads.sections`; лише осі з бітом 0x20 без 0x10). Осі з 0x20 без
   * ділянки (0x30: бази, під'їзди станцій, двори) на карті не показуються ніколи (king.exe 0x42cf50).
   */
  section?: number;
  /** Від центру смуги до стіни праворуч після `clearWalls`, м (розминання автопілота не заїжджає далі). */
  wallRight?: number;
  /** Дорогу закрито завалом (world/obstacles.ts; king.exe прапорець 0x40 смуг): маршрути її оминають. */
  closed?: boolean;
  /** Де завал на закритій дорозі (Three.js): розвертаються лише ті, хто їде до нього. */
  blockAt?: THREE.Vector3;
  /** Смуги зустрічного напрямку тієї ж осі (розворот перед закритою дорогою); на розділеному шосе — порожньо. */
  opposite?: RoadLine[];
}

/** Вузол мережі: точка, де сходяться кінці осей (ближче JOIN); перехрестя — якщо доріг три й більше. */
export interface RoadNode {
  pos: THREE.Vector3;
  /** Скільки доріг (осей) сходиться. */
  degree: number;
}

/** Прихована ділянка карти (`Ht2Roads.sections`): відкривається вся разом, коли гравець проїде нею (world/mapReveal.ts). */
export interface MapSection {
  /** Стала назва для збереження кар'єри: регіон і назва першої осі. */
  key: string;
  /** Осі ділянки (індекси `Ht2Roads.axes`). */
  axes: number[];
  /** Діагональ габариту ділянки в плані, м (king.exe: діагональ коробки дороги ІІ). */
  span: number;
}

interface Directed {
  axis: number;
  /** 1 — уздовж точок осі, −1 — проти. */
  dir: 1 | -1;
  pts: THREE.Vector3[];
  lines: RoadLine[];
}

export class Ht2Roads {
  /** Лінії руху (смуги обох напрямків). */
  readonly lines: RoadLine[] = [];
  /** Осі доріг (по одній на сегмент; для карт і визначення узбіччя). */
  readonly axes: RoadLine[] = [];
  /** Вузли (стики осей); перехрестя — degree ≥ 3. */
  readonly nodes: RoadNode[] = [];
  /** Приховані ділянки карти, що відкриваються проїздом (`markShortcuts`). */
  readonly sections: MapSection[] = [];
  private readonly grid = new Map<string, RoadLine[]>();
  private readonly axisGrid = new Map<string, RoadLine[]>();
  private readonly byRoad = new Map<string, RoadLine[]>();

  constructor(regions: Iterable<{ id: string; way: Way }>) {
    // Вузли місць причепів і воріт складів — для markBases (regions може бути одноразовим ітератором).
    const spots: THREE.Vector3[] = [];
    // Вузли колонок заправок і СТО — для markStations.
    const stations: THREE.Vector3[] = [];
    for (const { id, way } of regions)
      for (const room of way.rooms) {
        for (const n of room.nodes) if (/^(pos_base_|node_store_)/i.test(n.name)) spots.push(toThree(...n.pos));
        for (const n of room.nodes) if (STATION_NODE.test(n.name)) stations.push(toThree(...n.pos));
        for (const s of room.segments) {
          const n = s.points.length / 3;
          if (n < 2) continue;
          const raw: THREE.Vector3[] = [];
          for (let i = 0; i < n; i++) raw.push(toThree(s.points[i * 3], s.points[i * 3 + 1], s.points[i * 3 + 2]));
          const pts = dedupe(s.type & 1 && n === 4 ? bezier(raw) : raw);
          if (pts.length < 2) continue;
          const width = Math.max(s.widthLeft, s.widthRight);
          const hw = width / 2;
          const lanes = Math.max(1, Math.floor((hw + 1.75) / 3.5));
          const road = this.axes.length;
          this.axes.push({ name: `${room.name}#${road}`, pts, next: [], width, region: id, road, lane: -1, lanes, laneWidth: hw / lanes, flags: s.type, cls: s.cls, length: polyLength(pts), siblings: [], startNode: -1, endNode: -1 });
        }
      }
    for (const a of this.axes) for (const k of cellsOf(a.pts)) push(this.axisGrid, k, a);
    this.buildNodes();

    // Напрямки руху осей.
    const dirs: Directed[] = [];
    for (const a of this.axes) {
      const ways = this.directions(a);
      for (const dir of ways) {
        const pts = dir === 1 ? a.pts : [...a.pts].reverse();
        const d: Directed = { axis: a.road, dir, pts, lines: [] };
        for (let k = 0; k < a.lanes; k++) {
          const line: RoadLine = {
            name: `${a.name}:${k}${dir === 1 ? '' : 'r'}`,
            pts: offsetRight(pts, (k + 0.5) * a.laneWidth),
            next: [],
            width: a.width,
            region: a.region,
            road: a.road,
            lane: k,
            lanes: a.lanes,
            laneWidth: a.laneWidth,
            flags: a.flags,
            cls: a.cls,
            length: a.length,
            siblings: d.lines,
            startNode: dir === 1 ? a.startNode : a.endNode,
            endNode: dir === 1 ? a.endNode : a.startNode,
          };
          d.lines.push(line);
          this.lines.push(line);
        }
        dirs.push(d);
      }
      if (ways.length === 2) {
        const [f, b] = dirs.slice(-2);
        for (const l of f.lines) l.opposite = b.lines;
        for (const l of b.lines) l.opposite = f.lines;
      }
    }

    // Зʼєднання кінців напрямків з початками інших (за осями).
    const starts = new Map<string, Directed[]>();
    for (const d of dirs) push(starts, cellKey(d.pts[0]), d);
    const cosMax = Math.cos(TURN_MAX);
    for (const a of dirs) {
      const end = a.pts[a.pts.length - 1];
      const din = tangentEnd(a.pts);
      for (const b of nearCells(starts, end)) {
        if (b.axis === a.axis || b.pts[0].distanceTo(end) >= JOIN) continue;
        if (din.dot(tangentStart(b.pts)) < cosMax) continue;
        const na = a.lines.length;
        const nb = b.lines.length;
        for (let k = 0; k < na; k++) {
          a.lines[k].next.push(b.lines[Math.min(k, nb - 1)]);
          if (k === na - 1) for (let j = k + 1; j < nb; j++) a.lines[k].next.push(b.lines[j]);
        }
      }
    }
    for (const l of this.lines) {
      for (const k of cellsOf(l.pts)) push(this.grid, k, l);
      push(this.byRoad, String(l.road), l);
    }
    this.markBases(spots);
    this.markStations(stations);
    this.markShortcuts();
  }

  /**
   * Зрізалки й приховані ділянки карти (king.exe, re/notes/ht2/traffic.md «Приховані дороги»): осі з 0x20 і 0x40 —
   * `shortcut` (ґрунтовки, стежки: 408 осей, 24 км; лише 23 кінці стикуються зі звичайними дорогами). Ділянки —
   * ланцюжки осей з 0x20 без 0x10 через вузли без розвилок (гіпотеза: так king.exe групує сегменти в дороги ІІ, які
   * відкриває на карті цілком).
   */
  private markShortcuts(): void {
    for (const a of this.axes) {
      if ((a.flags & 0x60) !== 0x60) continue;
      a.shortcut = true;
      for (const l of this.linesOf(a.road)) l.shortcut = true;
    }
    const hidden = (a: RoadLine) => (a.flags & 0x30) === 0x20;
    const atNode = new Map<number, RoadLine[]>();
    for (const a of this.axes) if (hidden(a)) for (const n of [a.startNode, a.endNode]) (atNode.get(n) ?? atNode.set(n, []).get(n)!).push(a);
    for (const first of this.axes) {
      if (!hidden(first) || first.section !== undefined) continue;
      const id = this.sections.length;
      const axes: number[] = [];
      const box = new THREE.Box2();
      const todo = [first];
      first.section = id;
      while (todo.length) {
        const a = todo.pop()!;
        axes.push(a.road);
        for (const p of a.pts) box.expandByPoint(new THREE.Vector2(p.x, p.z));
        for (const n of [a.startNode, a.endNode]) {
          if (this.nodes[n].degree !== 2) continue;
          for (const b of atNode.get(n) ?? [])
            if (b.section === undefined) {
              b.section = id;
              todo.push(b);
            }
        }
      }
      axes.sort((x, y) => x - y);
      for (const r of axes) for (const l of this.linesOf(r)) l.section = id;
      this.sections.push({ key: `${first.region}:${this.axes[axes[0]].name}`, axes, span: box.min.distanceTo(box.max) });
    }
  }

  /**
   * Під'їзди заправок і СТО (порт, на прохання користувача): осі з бітом 0x20, вужчі за STATION_W, що проходять ближче
   * STATION_R від вузлів `node_car_fuel*` (колонки) чи `sto_*`, і їхні продовження з бітом 0x20 через вузли без розвилок — уся петля від
   * перехрестя до перехрестя, і вузькі гілки 0x20, що ведуть лише до неї. Сам біт 0x20 станції не позначає (930 осей, зокрема міські вулиці); заправка просто на
   * магістралі (STO_AA, біт 0x20 відсутній) не позначається — там трафік їде дорогою.
   */
  private markStations(spots: readonly THREE.Vector3[]): void {
    if (!spots.length) return;
    const atNode = new Map<string, RoadLine[]>();
    for (const a of this.axes) for (const n of [a.startNode, a.endNode]) if (n >= 0) push(atNode, String(n), a);
    const todo = this.axes.filter((a) => a.flags & 0x20 && a.width < STATION_W && spots.some((p) => polyDist(a.pts, p) < STATION_R));
    const seen = new Set(todo);
    const narrow = (a: RoadLine) => !!(a.flags & 0x20) && a.width < STATION_W;
    for (let changed = true; changed; ) {
      while (todo.length) {
        const a = todo.pop()!;
        for (const n of [a.startNode, a.endNode]) {
          if (n < 0 || this.nodes[n].degree !== 2) continue;
          for (const b of atNode.get(String(n)) ?? [])
            if (b.flags & 0x20 && !seen.has(b)) {
              seen.add(b);
              todo.push(b);
            }
        }
      }
      // Гілка, що веде лише до станції (СТО db: 100 м від перехрестя до петлі СТО), — теж під'їзд.
      changed = false;
      for (const a of this.axes) {
        if (seen.has(a) || !narrow(a)) continue;
        const spur = [a.startNode, a.endNode].some((n) => {
          const other = (atNode.get(String(n)) ?? []).filter((b) => b !== a);
          return other.length > 0 && other.every((b) => seen.has(b));
        });
        // Короткий в'їзд у двір станції з розвилкою (СТО bb, bd: дві паралельні петлі, вузли ступеня 3–4) — теж під'їзд.
        // Вузол спільний з під'їздом і всередині двору (лише вузькі осі 0x20): перехрестя з вулицею не рахується.
        const entry = a.length <= STATION_ENTRY && [a.startNode, a.endNode].some((n) => {
          const at = atNode.get(String(n)) ?? [];
          return at.some((b) => b !== a && seen.has(b)) && at.every(narrow);
        });
        if (!spur && !entry) continue;
        seen.add(a);
        todo.push(a);
        changed = true;
      }
    }
    for (const a of seen) {
      a.station = true;
      for (const l of this.linesOf(a.road)) l.station = true;
    }
  }

  /**
   * Територія баз і складів (порт): лінії з бітом 0x10, що проходять ближче BASE_R від вузлів `pos_base_*` (місця
   * причепів) чи `node_store_*` (ворота складу) — петлі майданчиків біля складів. Сам біт 0x10 бази не позначає (він
   * є й на міських дорогах, і на паркуванні легковиків біля аеропорту), а магістралі повз бази його не мають.
   */
  private markBases(spots: readonly THREE.Vector3[]): void {
    if (!spots.length) return;
    for (const a of this.axes) {
      if (!(a.flags & 0x10)) continue;
      if (!spots.some((p) => polyDist(a.pts, p) < BASE_R)) continue;
      a.base = true;
      for (const l of this.linesOf(a.road)) l.base = true;
    }
  }

  /**
   * Лінії баз і вузьких петель майданчиків — від стін (порт, на прохання користувача): на базі ap смуга вздовж складу
   * йшла за 2,2 м від рампи (петля ap_049 — за 1,35 м), тягачі з причепами чіпляли рампу й колони навісу. Шматками
   * ≤ 2 м міряємо стіну праворуч (probe, по колайдерах регіону); ближче WALL_CLEAR — точки лінії зсуваються ліворуч
   * (до осі петлі), не більше WALL_SHIFT і не далі половини вільного місця ліворуч. Звичайні дороги не чіпаємо: до
   * бордюру чи огорожі від крайньої смуги W12 — ті самі 2,4 м, і там їздять без зачіпань.
   */
  clearWalls(region: string, probe: WallProbe): void {
    const right = new THREE.Vector3();
    const left = new THREE.Vector3();
    for (const l of this.lines) {
      if (l.region !== region || !(l.base || l.laneWidth < NARROW_LANE)) continue;
      const n = l.pts.length;
      const need = new Array<number>(n).fill(0);
      let wall = Infinity;
      for (let i = 0; i + 1 < n; i++) {
        const a = l.pts[i];
        const b = l.pts[i + 1];
        const along = b.clone().sub(a).setY(0);
        const len = along.length();
        if (len < 0.01) continue;
        along.divideScalar(len);
        right.set(-along.z, 0, along.x);
        left.copy(right).negate();
        const pieces = Math.ceil(len / 2);
        for (let k = 0; k < pieces; k++) {
          const p = a.clone().lerp(b, (k + 0.5) / pieces);
          const r = probe(p, along, right, len / pieces / 2, WALL_CLEAR + 1);
          if (r >= WALL_CLEAR) continue;
          const room = probe(p, along, left, len / pieces / 2, WALL_CLEAR + WALL_SHIFT);
          const s = Math.min(WALL_CLEAR - r, WALL_SHIFT, Math.max(0, (room - r) / 2));
          need[i] = Math.max(need[i], s);
          need[i + 1] = Math.max(need[i + 1], s);
          wall = Math.min(wall, r + s);
        }
      }
      if (!need.some((s) => s > 0) && !Number.isFinite(wall)) continue;
      l.wallRight = Math.min(l.wallRight ?? Infinity, wall);
      // Зсув — по нормалі в точці (середня з сусідніх відрізків).
      const moved = l.pts.map((p, i) => {
        if (!need[i]) return p;
        const d = l.pts[Math.min(n - 1, i + 1)].clone().sub(l.pts[Math.max(0, i - 1)]).setY(0).normalize();
        return p.clone().add(new THREE.Vector3(d.z, 0, -d.x).multiplyScalar(need[i]));
      });
      for (let i = 0; i < n; i++) l.pts[i] = moved[i];
    }
  }

  /** Лінії руху дороги (усі смуги обох напрямків). */
  linesOf(road: number): RoadLine[] {
    return this.byRoad.get(String(road)) ?? [];
  }

  /** Лічильник змін закритих доріг (кеші маршрутів перераховуються). */
  closedVersion = 0;

  /** Закрити чи відкрити дорогу (вісь і всі її смуги). */
  setClosed(road: number, closed: boolean, at?: THREE.Vector3): void {
    const axis = this.axes[road];
    if (!axis || !!axis.closed === closed) return;
    axis.closed = closed;
    axis.blockAt = closed ? at : undefined;
    for (const l of this.linesOf(road)) {
      l.closed = closed;
      l.blockAt = closed ? at : undefined;
    }
    this.closedVersion++;
  }

  /** Вузли: кінці осей ближче JOIN — один вузол (позиція — середня), degree — скільки осей. */
  private buildNodes(): void {
    const grid = new Map<string, number[]>();
    const sums: THREE.Vector3[] = [];
    const counts: number[] = [];
    const node = (p: THREE.Vector3): number => {
      for (const i of nearCells(grid, p)) if (this.nodes[i].pos.distanceTo(p) < JOIN) return i;
      const i = this.nodes.length;
      this.nodes.push({ pos: p.clone(), degree: 0 });
      sums.push(new THREE.Vector3());
      counts.push(0);
      push(grid, cellKey(p), i);
      return i;
    };
    for (const a of this.axes) {
      a.startNode = node(a.pts[0]);
      a.endNode = node(a.pts[a.pts.length - 1]);
      for (const i of [a.startNode, a.endNode]) {
        this.nodes[i].degree++;
        sums[i].add(i === a.startNode ? a.pts[0] : a.pts[a.pts.length - 1]);
        counts[i]++;
      }
    }
    this.nodes.forEach((n, i) => n.pos.copy(sums[i]).divideScalar(counts[i] || 1));
  }

  /** Перехрестя (три дороги й більше). */
  isJunction(node: number): boolean {
    return node >= 0 && (this.nodes[node]?.degree ?? 0) >= 3;
  }

  /** Напрямки руху осі: розділене шосе — один (сусідня вісь ліворуч), інакше обидва. */
  private directions(a: RoadLine): (1 | -1)[] {
    if (!(a.flags & 12)) return [1, -1];
    const i = Math.floor((a.pts.length - 1) / 2);
    const p = a.pts[i].clone().lerp(a.pts[i + 1], 0.5);
    const t = a.pts[i + 1].clone().sub(a.pts[i]).setY(0).normalize();
    let side = 0;
    let best = PAIR_DIST;
    for (const b of nearCells(this.axisGrid, p)) {
      if (b === a || !(b.flags & 12)) continue;
      const q = closestOn(b.pts, p);
      if (!q) continue;
      const d = Math.hypot(q.point.x - p.x, q.point.z - p.z);
      if (d < 0.5 || d >= best || Math.abs(q.tangent.dot(t)) < PAIR_COS) continue;
      best = d;
      // Ліворуч від напрямку t (вісь Y угору): cross(t, rel).y > 0.
      side = t.z * (q.point.x - p.x) - t.x * (q.point.z - p.z) > 0 ? 1 : -1;
    }
    return side === 0 ? [1, -1] : side > 0 ? [1] : [-1];
  }

  /** Лінії в клітинці точки й сусідніх. */
  private near(p: THREE.Vector3): RoadLine[] {
    return [...new Set(nearCells(this.grid, p))];
  }

  /** bias — надбавка до відстані лінії, м (автопілот за маршрутом: лінії поза маршрутом — далі). */
  nearest(p: THREE.Vector3, heading?: THREE.Vector3, bias?: (l: RoadLine) => number): { line: RoadLine; seg: number; t: number; dist: number } | null {
    let best: { line: RoadLine; seg: number; t: number; dist: number } | null = null;
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    const q = new THREE.Vector3();
    for (const line of this.near(p)) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const a = line.pts[i];
        ab.subVectors(line.pts[i + 1], a);
        const len2 = ab.lengthSq();
        if (!len2) continue;
        const t = THREE.MathUtils.clamp(ap.subVectors(p, a).dot(ab) / len2, 0, 1);
        let dist = q.copy(a).addScaledVector(ab, t).distanceTo(p);
        // Лінії проти руху штрафуємо — їдемо своєю смугою, не розвертаємось.
        if (heading && ab.setY(0).normalize().dot(heading) < 0.2) dist += 30;
        if (bias) dist += bias(line);
        if (!best || dist < best.dist) best = { line, seg: i, t, dist };
      }
    }
    return best;
  }

  /** Відстань по горизонталі до найближчої осі дороги й сама вісь (null — доріг поблизу немає); open — без закритих. */
  nearestAxis(p: THREE.Vector3, open = false): { axis: RoadLine; dist: number; point: THREE.Vector3 } | null {
    // Точка — лише для найближчої осі (щокадру десятки осей: без нових векторів на кожну).
    let axis: RoadLine | null = null;
    let dist = Infinity;
    let seg = 0;
    let t = 0;
    for (const a of new Set(nearCells(this.axisGrid, p))) {
      if (open && a.closed) continue;
      if (!closestSeg(a.pts, p)) continue;
      if (!axis || SEG.d < dist) {
        axis = a;
        dist = SEG.d;
        seg = SEG.i;
        t = SEG.t;
      }
    }
    return axis ? { axis, dist, point: axis.pts[seg].clone().lerp(axis.pts[seg + 1], t) } : null;
  }

  /**
   * Приховані ділянки карти поблизу: індекс ділянки → відстань від краю її найближчої осі, м (лише ≤ within), і
   * найближча точка на осі.
   */
  sectionsNear(p: THREE.Vector3, within: number): Map<number, { dist: number; point: THREE.Vector3 }> {
    const out = new Map<number, { dist: number; point: THREE.Vector3 }>();
    for (const a of new Set(nearCells(this.axisGrid, p))) {
      if (a.section === undefined) continue;
      const q = closestOn(a.pts, p);
      if (!q) continue;
      const dist = Math.max(0, Math.hypot(q.point.x - p.x, q.point.z - p.z) - a.width / 2);
      if (dist > within) continue;
      const prev = out.get(a.section);
      if (!prev || dist < prev.dist) out.set(a.section, { dist, point: q.point });
    }
    return out;
  }

  /** Точка поза проїжджою частиною (далі від осі, ніж половина ширини W, з запасом). */
  offRoad(p: THREE.Vector3, margin = 0.5): boolean {
    const n = this.nearestAxis(p);
    return !!n && n.dist > n.axis.width / 2 + margin;
  }

  /**
   * Тупикова гілка (порт): з початку лінії за DEAD_LOOK м мережа доходить лише до кінців без продовження — в'їзди на
   * бази, глухі майданчики. Автопілот (гравця з причепом, далекобійники) туди не звертає: розвернутися не може.
   */
  deadEnd(line: RoadLine): boolean {
    let v = this.dead.get(line);
    if (v === undefined) {
      v = !reaches(line, DEAD_LOOK, new Map());
      this.dead.set(line, v);
    }
    return v;
  }

  private readonly dead = new Map<RoadLine, boolean>();

  /**
   * Продовження лінії для автопілота: стала для лінії гілка (без смикання), крім тупикових і закритих завалом
   * (world/obstacles.ts; із закритої лінії — можна, машина з неї виїжджає), якщо є інші; на зрізалки — ніколи.
   */
  pick(line: RoadLine): RoadLine | null {
    // Зрізалки (markShortcuts) — лише для гравця: дорога, що далі веде лише на них, для автопілота — кінець.
    const all = (line.next as RoadLine[]).filter((n) => line.shortcut || !n.shortcut);
    if (!all.length) return null;
    const passable = all.filter((n) => line.closed || !n.closed);
    const open = passable.filter((n) => !this.deadEnd(n));
    const pool0 = open.length ? open : passable.length ? passable : all;
    // Паркувальні кишені бази й під'їзди заправок і СТО — лише якщо іншого шляху немає (боти-автопілоти виписували
    // кишенями зигзаги).
    const roads = pool0.filter((n) => !isPocket(n) && !toStation(n));
    const pool = roads.length ? roads : pool0;
    return pool[hashPick(line.name, pool.length)];
  }

  /**
   * Точка на відстані `ahead` уздовж мережі; на розвилках — випадкова гілка, але стала для лінії (без смикання), крім
   * тупикових (deadEnd), якщо є інші; choose — своє продовження (маршрут бота, world/navigator next), null — як завжди.
   */
  advance(line: RoadLine, seg: number, t: number, ahead: number, choose?: (l: RoadLine) => RoadLine | null): THREE.Vector3 {
    const cur = line.pts[seg].clone().lerp(line.pts[seg + 1], t);
    let left = ahead;
    let l: RoadLine = line;
    let i = seg + 1;
    for (let guard = 0; guard < 400; guard++) {
      if (i >= l.pts.length) {
        const n = choose?.(l) ?? this.pick(l);
        if (!n) return cur;
        l = n;
        // Проміжок між смугами на стику — навпростець до другої точки наступної лінії.
        i = 1;
        continue;
      }
      const d = cur.distanceTo(l.pts[i]);
      if (d >= left) return cur.lerp(l.pts[i], left / d);
      left -= d;
      cur.copy(l.pts[i]);
      i++;
    }
    return cur;
  }
}

/**
 * На станцію (порт): під'їзд заправки чи СТО (`station`) або смуга, з якої далі шлях лише на під'їзд чи зрізалку —
 * трикутник розвилки перед СТО db (db_028), з'їзди розв'язки ba05 до заправки ba14. Трафік і боти туди не звертають,
 * якщо є інше продовження.
 */
export function toStation(l: RoadLine): boolean {
  return !!l.station || (l.next.length > 0 && (l.next as RoadLine[]).every((n) => n.station || n.shortcut));
}

/**
 * Паркувальна кишеня (порт): коротка (до 40 м) лінія бази (біт 0x10) з поворотом усередині понад 70° — заїзд на
 * місце стоянки й виїзд (на базі біля аеропорту — ланцюжок кишень по 27 м з поворотом 94° поруч із прямою).
 */
export function isPocket(l: RoadLine): boolean {
  // Лінії незмінні — відповідь запамʼятовується (питають щокадру на кожній розвилці).
  let v = POCKETS.get(l);
  if (v === undefined) POCKETS.set(l, (v = pocketShape(l)));
  return v;
}

const POCKETS = new WeakMap<RoadLine, boolean>();

function pocketShape(l: RoadLine): boolean {
  if (!(l.flags & 0x10) || l.length > 40) return false;
  let w = 0;
  let prev: THREE.Vector3 | null = null;
  for (let i = 1; i < l.pts.length; i++) {
    const d = l.pts[i].clone().sub(l.pts[i - 1]).setY(0);
    if (d.lengthSq() < 0.25) continue;
    d.normalize();
    if (prev) w += Math.acos(THREE.MathUtils.clamp(prev.dot(d), -1, 1));
    prev = d;
  }
  return w > (70 * Math.PI) / 180;
}

/** Розвилка: продовження ведуть на різні дороги (а не лише в різні смуги однієї). */
export function isFork(line: RoadLine): boolean {
  const roads = new Set((line.next as RoadLine[]).map((n) => n.road));
  return roads.size > 1;
}

/** Як далеко дивитися, чи гілка не тупикова, м. */
const DEAD_LOOK = 400;

/** Чи веде лінія (від її початку) хоч куди-небудь на left метрів. */
function reaches(line: RoadLine, left: number, tried: Map<RoadLine, number>): boolean {
  if (line.length >= left) return true;
  // Уже пробували звідси з не меншим запасом — і не дійшли.
  if ((tried.get(line) ?? -1) >= left) return false;
  tried.set(line, left);
  // Зрізалки ботам недоступні: дорога, що веде лише на них, — тупикова.
  return (line.next as RoadLine[]).some((n) => (line.shortcut || !n.shortcut) && reaches(n, left - line.length, tried));
}

function hashPick(s: string, n: number): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h) % n;
}

/** Кубічна крива Безьє (P0, P1, P2, P3) — ламана з кроком ≈ BEZIER_STEP; пряма (контрольні на хорді) — два кінці. */
function bezier(p: THREE.Vector3[]): THREE.Vector3[] {
  const [p0, p1, p2, p3] = p;
  const chord = new THREE.Line3(p0, p3);
  const tmp = new THREE.Vector3();
  const off = Math.max(chord.closestPointToPoint(p1, true, tmp).distanceTo(p1), chord.closestPointToPoint(p2, true, tmp).distanceTo(p2));
  if (off < 0.05) return [p0.clone(), p3.clone()];
  const len = p0.distanceTo(p1) + p1.distanceTo(p2) + p2.distanceTo(p3);
  const n = THREE.MathUtils.clamp(Math.ceil(len / BEZIER_STEP), 4, 64);
  const out: THREE.Vector3[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    out.push(
      new THREE.Vector3()
        .addScaledVector(p0, u * u * u)
        .addScaledVector(p1, 3 * u * u * t)
        .addScaledVector(p2, 3 * u * t * t)
        .addScaledVector(p3, t * t * t),
    );
  }
  return out;
}

function polyLength(pts: THREE.Vector3[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += pts[i].distanceTo(pts[i - 1]);
  return len;
}

/** Відстань у плані (без висоти) від точки до ламаної, м. */
function polyDist(pts: THREE.Vector3[], p: THREE.Vector3): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const abx = pts[i + 1].x - a.x;
    const abz = pts[i + 1].z - a.z;
    const len2 = abx * abx + abz * abz;
    const t = len2 ? THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1) : 0;
    best = Math.min(best, Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z));
  }
  return best;
}

/** Без повторних точок (нульові відрізки ламають дотичні). */
function dedupe(pts: THREE.Vector3[]): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const p of pts) if (!out.length || out[out.length - 1].distanceTo(p) > 0.01) out.push(p);
  return out;
}

function tangentEnd(pts: THREE.Vector3[]): THREE.Vector3 {
  return pts[pts.length - 1].clone().sub(pts[pts.length - 2]).setY(0).normalize();
}

function tangentStart(pts: THREE.Vector3[]): THREE.Vector3 {
  return pts[1].clone().sub(pts[0]).setY(0).normalize();
}

/** Найближча до p точка ламаної (по горизонталі) і дотична там. */
function closestOn(pts: THREE.Vector3[], p: THREE.Vector3): { point: THREE.Vector3; tangent: THREE.Vector3 } | null {
  if (!closestSeg(pts, p)) return null;
  const a = pts[SEG.i];
  const b = pts[SEG.i + 1];
  return { point: a.clone().lerp(b, SEG.t), tangent: new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize() };
}

/** Результат closestSeg: відрізок i, частка t на ньому, відстань d по горизонталі. */
const SEG = { i: 0, t: 0, d: 0 };

/**
 * Найближчий до p відрізок ламаної (по горизонталі) — у SEG, без нових обʼєктів (щокадру — сотні відрізків: сміття
 * для збирача памʼяті на телефоні). false — ламана без відрізків.
 */
function closestSeg(pts: THREE.Vector3[], p: THREE.Vector3): boolean {
  let bi = -1;
  let bt = 0;
  let bd = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const abx = b.x - a.x;
    const abz = b.z - a.z;
    const len2 = abx * abx + abz * abz;
    if (!len2) continue;
    const t = THREE.MathUtils.clamp(((p.x - a.x) * abx + (p.z - a.z) * abz) / len2, 0, 1);
    const d = Math.hypot(a.x + abx * t - p.x, a.z + abz * t - p.z);
    if (d < bd) {
      bd = d;
      bi = i;
      bt = t;
    }
  }
  if (bi < 0) return false;
  SEG.i = bi;
  SEG.t = bt;
  SEG.d = bd;
  return true;
}

function cellKey(p: THREE.Vector3): string {
  return `${Math.floor(p.x / 200)},${Math.floor(p.z / 200)}`;
}

/** Клітинки, які зачіпає ламана (з точками на відрізках, щоб довгі прямі не пропускали клітинок). */
function cellsOf(pts: THREE.Vector3[]): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < pts.length; i++) {
    out.add(cellKey(pts[i]));
    if (i + 1 < pts.length) {
      const steps = Math.ceil(pts[i].distanceTo(pts[i + 1]) / 100);
      for (let s = 1; s < steps; s++) out.add(cellKey(pts[i].clone().lerp(pts[i + 1], s / steps)));
    }
  }
  return out;
}

function nearCells<T>(grid: Map<string, T[]>, p: THREE.Vector3): T[] {
  const cx = Math.floor(p.x / 200);
  const cz = Math.floor(p.z / 200);
  const out: T[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push(...(grid.get(`${cx + dx},${cz + dz}`) ?? []));
  return out;
}

function push<T>(grid: Map<string, T[]>, k: string, v: T): void {
  const list = grid.get(k);
  if (list) list.push(v);
  else grid.set(k, [v]);
}

/** Ламана, зсунута праворуч (у площині XZ Three.js) на d. */
function offsetRight(pts: THREE.Vector3[], d: number): THREE.Vector3[] {
  const up = new THREE.Vector3(0, 1, 0);
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dir = b.clone().sub(a).setY(0);
    if (dir.lengthSq() < 1e-6) return p.clone();
    const right = new THREE.Vector3().crossVectors(dir.normalize(), up);
    return p.clone().addScaledVector(right, d);
  });
}
