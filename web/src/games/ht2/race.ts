import * as THREE from 'three';
import { kingCar, kingPilot } from './vehicles/controls';
import { AutoPilot, type WayLine } from './engine/vehicle/autopilot';
import { TruckVehicle } from './engine/vehicle/truckVehicle';
import { buildTruckModel } from './engine/vehicle/trucks';
import { modal } from './engine/ui/modal';
import type { Ht2Roads } from './world/roads';
import { drivable, truckDef } from './vehicles/trucks';
import { toThree } from './world/world';
import type { Ht2Drive } from './drive';
import { recolor } from './traffic/traffic';
import { FIRST_RIVAL, FLAG_REVERSE, RemoteTrack, emptyState, packFleet, readFleet, type TruckState } from './net/state';
import type { NetCar } from './net/peer';
import type { Block } from './engine/formats/b3d';
import { BALL_WIN, BallGame, ballSlot, readGates } from './ball';

/**
 * Вид траси: `ring` — Кільце (3 кола маршрутом через check_point1…3), `trial` — Тріал (арена MTR, tracks.md §3):
 * зони-коробки `check_point_0 → 1 → 2` по черзі, одне проходження, фініш у зоні 2.
 */
export type CourseKind = 'ring' | 'trial' | 'ball';

/** Номер м'яча Автобола в пакеті машин (гравці — 0…7, суперники — від FIRST_RIVAL). */
export const BALL_ID = 15;
/** М'яч у гостей іде за станом із мережі: пружина до пози, с; далі цього — одразу туди, м. */
const BALL_FOLLOW = 0.15;
const BALL_SNAP = 8;

/** Зона-тригер B3D (блок 13 з i1 = 7, i2 — номер точки): площини (блоки 9) шляху до нього, координати гри. */
type ZonePlanes = { v: [number, number, number, number]; front: boolean }[];

/** Контрольні зони Тріалу в блоках арени: номер → площини. */
export function checkZones(blocks: readonly Block[]): Map<number, ZonePlanes> {
  const out = new Map<number, ZonePlanes>();
  const visit = (b: Block, planes: ZonePlanes) => {
    if (b.data.t === 13 && b.data.trigger.i1 === 7) {
      out.set(b.data.trigger.i2, planes);
      return;
    }
    const plane = b.data.t === 9 && b.data.shape.kind === 5 ? (b.data.shape.v as [number, number, number, number]) : null;
    (b.groups ?? []).forEach((g, gi) => {
      const next = plane && gi < 2 ? [...planes, { v: plane, front: gi === 0 }] : planes;
      for (const c of g) visit(c, next);
    });
  };
  for (const b of blocks) if (b.data.t === 19) visit(b, []);
  return out;
}

/** Точка Three.js усередині зони (площини в координатах гри: x, y — план, z — угору). */
export function inZone(planes: ZonePlanes, p: THREE.Vector3): boolean {
  const x = p.x;
  const y = -p.z;
  const z = p.y;
  return planes.length > 0 && planes.every(({ v, front }) => v[0] * x + v[1] * y + v[2] * z + v[3] >= 0 === front);
}

/**
 * Компас Тріалу на табло (king.exe 0x569ab0): 8 секторів за проєкціями напрямку на ціль на осі машини (пороги ±0,35 і
 * ±0,85), символи icon.fon. Порядок символів — за картинками стрілок шрифту (ui/tablo.ts COMPASS).
 */
export function compassSector(forward: THREE.Vector3, toTarget: THREE.Vector3): number {
  const f = forward.clone().setY(0).normalize();
  const d = toTarget.clone().setY(0).normalize();
  const right = new THREE.Vector3(-f.z, 0, f.x);
  const a = d.dot(f);
  const s = d.dot(right);
  // 0 — уперед, далі за годинниковою стрілкою: 1 праворуч-уперед, 2 праворуч, 3 праворуч-назад, 4 назад, 5…7 — ліворуч
  // (вісь «праворуч» Three.js: (−f.z, 0, f.x)).
  if (a > 0.85) return 0;
  if (a < -0.85) return 4;
  if (Math.abs(a) < 0.35) return s > 0 ? 2 : 6;
  if (a > 0) return s > 0 ? 1 : 7;
  return s > 0 ? 3 : 5;
}

/**
 * Мережева гонка (net/): номер свого гравця (місце на решітці: start1_<номер + 1>), чи ми господар, гравці з
 * машинами, суперники господаря — на вільних місцях решітки за порядком (у господаря — автопілот, у гостей — машини
 * з мережі з номерами від FIRST_RIVAL).
 */
export interface NetRace {
  myId: number;
  host: boolean;
  players: { id: number; name: string; truck: string; color: number }[];
  rivals: NetCar[];
}

/** Місць на решітці Кільця (`start1_1…8`). */
export const GRID_SLOTS = 8;

/**
 * Гонка на Кільці (регіон dr; re/notes/ht2/race.md): стартова решітка `start1_1…8`, контрольні точки
 * `check_point1…3` (вузли WAY); 3 кола (king.exe 0x56ffd0), суперників — 7 (режим «Гонки»: MENV/GAME.CNF aitruck 8
 * разом з гравцем). Маршрут кола — найкоротший шлях мережею доріг через точки по черзі; суперники їдуть ним
 * автопілотом. Місце — за пройденою відстанню маршруту.
 *
 * За king.exe: світлофор — червоний, через 2 с три блимання зеленого зі звуком `alarm`, через 5,5 с — старт
 * (0x53e510); суперники — у два ряди ±1,75 м від осі за номером на решітці (0x4d43a0); «гумова нитка» (0x4d4700):
 * x = 0,002·Δ (Δ — на скільки метрів гравець попереду), швидкість × (1 + x·|x|) у межах 0,75…1,5; зміна місця
 * гравця — пейджер YOU_ARE_N (0x4285c0), фініш суперника — COMPETITOR_ARRIVED; довше 1800 с — DISQUALIFIED.
 * Фініш — повідомлення YOU_CAME_N з Ms.sch.
 */
const LAPS = 3;
const COUNTDOWN = 5.5;
/** Моменти звуку `alarm` (три блимання зеленого) від початку відліку, с — гіпотеза: раз на секунду від 2 с. */
const BLINKS = [2, 3, 4];
/** Суперників у гонці кар'єри (0x66c6d0). */
const CAREER_RIVALS = 4;
/** Ліміт часу гонки, с (0x66c698). */
const TIME_LIMIT = 1800;
/** Відстань від маршруту (м), далі якої суперник за 4 с відновлюється на маршруті, і скільки секунд він може стояти. */
const OFF_ROUTE = 12;
const IDLE_RESPAWN = 8;
/** Ряди решітки — зсув від осі маршруту, м. */
const LANE = 1.75;
/** «Гумова нитка»: коефіцієнт при різниці поступу (1/м) і межі множника швидкості. */
const RUBBER_K = 0.002;
const RUBBER_MIN = 0.75;
const RUBBER_MAX = 1.5;

/** Лінії мережі, що проходять ближче reach від точки: найближчий сегмент і його напрям (горизонтальний). */
function nearLines(roads: Ht2Roads, p: THREE.Vector3, reach: number): { line: WayLine; seg: number; dir: THREE.Vector3 }[] {
  const out: { line: WayLine; seg: number; dir: THREE.Vector3 }[] = [];
  const ab = new THREE.Vector3();
  for (const line of roads.lines) {
    let best = Infinity;
    let seg = -1;
    for (let i = 0; i + 1 < line.pts.length; i++) {
      const a = line.pts[i];
      ab.subVectors(line.pts[i + 1], a);
      const l2 = ab.lengthSq();
      if (!l2) continue;
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / l2, 0, 1);
      const d = a.clone().addScaledVector(ab, t).distanceTo(p);
      if (d < best) {
        best = d;
        seg = i;
      }
    }
    if (seg >= 0 && best < reach) out.push({ line, seg, dir: line.pts[seg + 1].clone().sub(line.pts[seg]).setY(0).normalize() });
  }
  return out;
}
/** Радіус пошуку стартових ліній маршруту, м, і штраф (м) за лінію проти курсу старту. */
const START_REACH = 12;
const AGAINST_PENALTY = 300;

/** Найкоротший шлях лініями мережі від лінії біля a до лінії біля b (Дейкстра; вага — довжина лінії). */
function path(roads: Ht2Roads, a: THREE.Vector3, b: THREE.Vector3, heading?: THREE.Vector3): THREE.Vector3[] {
  // Мета — будь-яка лінія поруч з b (решітка старту стоїть на тупиковій лінії, у яку шляху немає).
  const ends = new Map<WayLine, number>();
  for (const e of nearLines(roads, b, START_REACH)) ends.set(e.line, e.seg);
  const nb = roads.nearest(b);
  if (nb && !ends.has(nb.line)) ends.set(nb.line, nb.seg);
  if (!ends.size) return [a, b];
  // Старт — з усіх ліній поруч з a (найближча за курсом буває тупиком — тоді шляху немає і маршрут ішов навпростець
  // через трибуни); лінія проти курсу — зі штрафом. Обирається та, з якої найкоротше до мети.
  const starts = nearLines(roads, a, START_REACH);
  const near = roads.nearest(a, heading);
  if (near && !starts.some((s) => s.line === near.line)) starts.push({ line: near.line, seg: near.seg, dir: new THREE.Vector3() });
  if (!starts.length) return [a, b];
  const len = (l: WayLine) => l.pts.reduce((s, p, i) => (i ? s + p.distanceTo(l.pts[i - 1]) : 0), 0);
  const startOf = new Map<WayLine, number>();
  const dist = new Map<WayLine, number>();
  for (const s of starts) {
    const cost = heading && s.dir.dot(heading) < -0.2 ? AGAINST_PENALTY : 0;
    if (cost < (dist.get(s.line) ?? Infinity)) {
      dist.set(s.line, cost);
      startOf.set(s.line, s.seg);
    }
  }
  const prev = new Map<WayLine, WayLine>();
  const open = new Set<WayLine>(dist.keys());
  let reached: WayLine | null = null;
  while (open.size) {
    let cur: WayLine | null = null;
    for (const l of open) if (!cur || dist.get(l)! < dist.get(cur)!) cur = l;
    open.delete(cur!);
    if (ends.has(cur!)) {
      reached = cur;
      break;
    }
    const d = dist.get(cur!)! + len(cur!);
    for (const n of cur!.next)
      if (d < (dist.get(n) ?? Infinity)) {
        dist.set(n, d);
        prev.set(n, cur!);
        open.add(n);
      }
  }
  if (!reached) return [a, b];
  const chain: WayLine[] = [];
  for (let l: WayLine | undefined = reached; l; l = prev.get(l)) chain.unshift(l);
  const pts: THREE.Vector3[] = [];
  chain.forEach((l, i) => {
    const s = i === 0 ? (startOf.get(l) ?? 0) : 0;
    const e = i === chain.length - 1 ? ends.get(l)! + 1 : l.pts.length - 1;
    for (let k = s; k <= e; k++) if (!pts.length || pts[pts.length - 1].distanceTo(l.pts[k]) > 0.5) pts.push(l.pts[k].clone());
  });
  return pts;
}

/**
 * Без різких зламів: на стиках сегментів шлях перестрибує між смугами й робить петлю назад — точки, де ламана
 * повертає більше ніж на 100°, і зовсім близькі точки прибираємо (повторно, доки є що прибрати).
 */
function despike(pts: THREE.Vector3[]): THREE.Vector3[] {
  let out = pts;
  for (let pass = 0; pass < 20; pass++) {
    const next: THREE.Vector3[] = [out[0]];
    let removed = false;
    for (let i = 1; i + 1 < out.length; i++) {
      const a = next[next.length - 1];
      const b = out[i];
      const c = out[i + 1];
      const u = b.clone().sub(a).setY(0);
      const v = c.clone().sub(b).setY(0);
      if (u.length() < 1.5 || (u.length() > 0 && v.length() > 0 && u.normalize().dot(v.normalize()) < Math.cos((100 * Math.PI) / 180))) {
        removed = true;
        continue;
      }
      next.push(b);
    }
    next.push(out[out.length - 1]);
    out = next;
    if (!removed) break;
  }
  return out;
}

/** Замкнений маршрут однією лінією (інтерфейс WayNet для AutoPilot) і довжина вздовж нього. */
class RouteNet {
  readonly lines: WayLine[];
  readonly cum: number[] = [0];
  constructor(readonly pts: THREE.Vector3[]) {
    const line: WayLine = { name: 'route', pts, next: [] };
    line.next.push(line);
    this.lines = [line];
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
  }
  get length(): number {
    return this.cum[this.cum.length - 1];
  }
  nearest(p: THREE.Vector3): { line: WayLine; seg: number; t: number; dist: number } | null {
    let best: { line: WayLine; seg: number; t: number; dist: number } | null = null;
    const ab = new THREE.Vector3();
    for (let i = 0; i + 1 < this.pts.length; i++) {
      const a = this.pts[i];
      ab.subVectors(this.pts[i + 1], a);
      const l2 = ab.lengthSq();
      if (!l2) continue;
      const t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / l2, 0, 1);
      const d = a.clone().addScaledVector(ab, t).distanceTo(p);
      if (!best || d < best.dist) best = { line: this.lines[0], seg: i, t, dist: d };
    }
    return best;
  }
  advance(_line: WayLine, seg: number, t: number, ahead: number): THREE.Vector3 {
    let i = seg;
    let cur = this.pts[i].clone().lerp(this.pts[i + 1], t);
    let left = ahead;
    for (let guard = 0; guard < 2000; guard++) {
      const j = (i + 1) % this.pts.length;
      const d = cur.distanceTo(this.pts[j]);
      if (d >= left) return cur.lerp(this.pts[j], left / Math.max(d, 1e-6));
      left -= d;
      cur = this.pts[j].clone();
      i = j;
    }
    return cur;
  }
  /** Пройдена відстань уздовж маршруту для точки. */
  along(p: THREE.Vector3): number {
    const n = this.nearest(p);
    return n ? this.cum[n.seg] + (this.cum[n.seg + 1] - this.cum[n.seg]) * n.t : 0;
  }
}

/**
 * Машини суперників: тягачі й вантажівки без надвеликих Storm (12 м і більше: на решітці з кроком 15 м — перетин); у
 * кар'єрі — клас машини гравця (0x425d40; без причепів — гіпотеза порту).
 */
export function rivalPool(drive: Ht2Drive, career = false): ReturnType<typeof drivable> {
  const group = drive.truckGroup;
  return drivable(drive.trucksData).filter((r) => (career ? r.group === group : r.group === 'tractors' || r.group === 'lorries') && !/^Storm/.test(r.carNode));
}

interface Racer {
  truck: TruckVehicle;
  pilot: AutoPilot | null;
  /** Пройдено кіл і остання відстань уздовж кола (для переходу через старт). */
  laps: number;
  last: number;
  /** Пройшли середину кола (без цього перехід «кінець → початок» біля старту рахувався б як коло). */
  halfway: boolean;
  /** Власна крейсерська швидкість без «гумової нитки», км/год. */
  cruise?: number;
  /** Скільки секунд машина перекинута чи далеко від маршруту (суперники — відновлення). */
  bad?: number;
  /** Скільки секунд суперник майже стоїть після старту. */
  idle?: number;
  finished: number | null;
  name: string;
  /** Номер машини в мережевій гонці (гравець — 0…7, суперник господаря — від FIRST_RIVAL). */
  id?: number;
  /** Тріал: наступна зона (0…2; 3 — фініш) і власний маршрут суперника (start → check1 → fline). */
  stage?: number;
  route?: RouteNet;
  /** Тріал: зона, у якій машина зараз (повідомлення лише при вʼїзді). */
  inside?: number;
  /** Автобол: очки. */
  points?: number;
  /** Машина з мережі: пакети стану, показ із запізненням; gone — гравець вийшов, waiting — стану ще не було. */
  remote?: { track: RemoteTrack; state: TruckState; gone: boolean; waiting: boolean };
}

export class RaceMode {
  private readonly route: RouteNet;
  readonly racers: Racer[] = [];
  private countdown = COUNTDOWN;
  private clock = 0;
  private done = false;
  /** Останнє місце гравця, оголошене пейджером. */
  private announced = 0;
  onFinish: ((place: number) => void) | null = null;

  /**
   * career — гонка в кар'єрі (0x4279d0): 4 суперники класу машини гравця на start1_1…4, гравець приїхав сам (не
   * переставляємо), фініш — пейджер без вікна; інакше — режим «Гонки»: гравець на start1_1, 7 суперників на 2…8.
   */
  constructor(
    private readonly drive: Ht2Drive,
    roads: Ht2Roads,
    private readonly messages: (key: string, fb: string) => string,
    private readonly career = false,
    net: NetRace | null = null,
    readonly kind: CourseKind = 'ring',
  ) {
    const nodes = new Map<string, THREE.Vector3>();
    for (const r of drive.world.regions.values())
      for (const room of r.way.rooms) for (const n of room.nodes) if (/^(start1_\d|check_point\d|check1_\d|fline1_\d)$/.test(n.name)) nodes.set(n.name, toThree(...n.pos));
    if (kind === 'ball') {
      // Автобол: поле без доріг; «маршрут» — лише точка в центрі (для значка на карті й відновлення не потрібен).
      const center = drive.groundAtPublic(toThree(0, 0, 10));
      this.route = new RouteNet([center, center.clone().add(new THREE.Vector3(1, 0, 0))]);
      this.dir = toThree(1, 0, 0);
      this.slot = (k) => {
        const s = ballSlot(k - 1);
        return toThree(s.x, s.y, 10);
      };
      this.slotDir = (k) => {
        const s = ballSlot(k - 1);
        return toThree(s.dir[0], s.dir[1], 0).normalize();
      };
      this.setupBall(!net || net.host);
      this.place0(net, career);
      return;
    }
    const start = nodes.get('start1_1')!;
    if (kind === 'trial') {
      // Тріал: зони з тригерів арени; центри точок 1 і 2 — вузли check1_* і fline1_* (там їде ІІ); маршрут гравця для
      // відновлення й карти — дорогами start1_1 → check1_1 → fline1_1. Решітка — вузли start1_k як є (два ряди).
      for (const reg of drive.world.loaded.values()) for (const [i, z] of checkZones(reg.built.assembler.b3d.blocks)) this.zones.set(i, z);
      const mean = (re: RegExp) => {
        const ps = [...nodes].filter(([k]) => re.test(k)).map(([, p]) => p);
        return ps.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(Math.max(1, ps.length));
      };
      this.targets = [start.clone(), mean(/^check1_/), mean(/^fline1_/)];
      const head = this.targets[1].clone().sub(start).setY(0).normalize();
      this.trialRoute = (k: number) => {
        const from = nodes.get(`start1_${k}`) ?? start;
        const a = path(roads, from, nodes.get(`check1_${k}`) ?? this.targets[1], head);
        const b = path(roads, a[a.length - 1], nodes.get(`fline1_${k}`) ?? this.targets[2]);
        return new RouteNet(despike([...a, ...b.slice(1)]));
      };
      this.route = this.trialRoute(1);
      // Напрям — уздовж рядів решітки, до першої зони (start1_* — x 2205…2270, check_point_0 — x 2272…2288).
      this.dir = toThree(1, 0, 0);
      this.slot = (k) => nodes.get(`start1_${k}`)?.clone();
      this.place0(net, career);
      return;
    }
    const cps = ['check_point1', 'check_point2', 'check_point3'].map((k) => nodes.get(k)!);
    // Напрям старту — до першої контрольної точки (решітка стоїть поперек траси).
    const head = cps[0].clone().sub(start).setY(0).normalize();
    const pts: THREE.Vector3[] = [];
    const legs = [start, ...cps, start];
    for (let i = 0; i + 1 < legs.length; i++) {
      const leg = path(roads, legs[i], legs[i + 1], i === 0 ? head : undefined);
      pts.push(...(pts.length ? leg.slice(1) : leg));
    }
    this.route = new RouteNet(despike(pts));
    // Гравець — на start1_1, суперники — на решітці 2…8, усі вздовж маршруту.
    const rp = this.route.pts;
    const dir = rp[Math.min(5, rp.length - 1)].clone().sub(rp[0]).setY(0).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    // Решітка — одна колона вздовж траси; машини — у два ряди за номером (±1,75 м, як смуги 0x4d43a0).
    const slot = (k: number) => nodes.get(`start1_${k}`)?.clone().addScaledVector(side, k % 2 ? LANE : -LANE);
    this.dir = dir;
    this.slot = slot;
    this.place0(net, career, start);
  }

  /** Розстановка: гравець, машини з мережі, суперники (ring без мережі — start ставить гравця на start1_1). */
  private place0(net: NetRace | null, career: boolean, start?: THREE.Vector3): void {
    const drive = this.drive;
    const player = drive.truck;
    const slot = this.slot;
    const dir = this.dir;
    if (net) {
      // Мережа: кожен — на своєму місці за номером (king.exe ставить живих гравців на start<в>_<k+1> за мережевим
      // номером, tracks.md §3 «Старт»).
      this.net = net;
      const mine = slot(net.myId + 1);
      if (mine) player.reset({ position: drive.groundAtPublic(mine), forward: this.slotDir?.(net.myId + 1) ?? dir });
      this.racers.push({ truck: player, pilot: null, laps: 0, last: 0, halfway: false, finished: null, name: 'Ви', id: net.myId });
      for (const p of net.players) if (p.id !== net.myId) this.addRemote(p.id, p, p.name, slot(p.id + 1), false, this.slotDir?.(p.id + 1));
      // Суперники — на вільних місцях решітки за порядком.
      const free = Array.from({ length: GRID_SLOTS }, (_, i) => i).filter((i) => !net.players.some((p) => p.id === i));
      net.rivals.forEach((c, k) => {
        const s = free[k];
        if (s === undefined) return;
        if (net.host) this.addAi(drive.trucksData.records.find((r) => r.carNode === c.truck), s + 1, FIRST_RIVAL + k, c.color);
        else this.addRemote(FIRST_RIVAL + k, c, c.truck, slot(s + 1), true);
      });
      return;
    }
    const at = start ?? slot(1);
    if (!career && at) player.reset({ position: drive.groundAtPublic(at), forward: this.slotDir?.(1) ?? dir });
    this.racers.push({ truck: player, pilot: null, laps: 0, last: career ? this.route.along(player.visual.position) : 0, halfway: false, finished: null, name: 'Ви' });
    // Автобол без суперників на автопілоті (MTB: GAME.CNF немає, ІІ не створюється, 0x512920).
    if (this.kind === 'ball') return;
    const pool = rivalPool(drive, career);
    for (let k = career ? 1 : 2; k <= (career ? CAREER_RIVALS : GRID_SLOTS); k++) this.addAi(pool[(k * 5) % pool.length], k);
  }

  /** Напрям старту й місце на решітці start1_<k> (з рядом). */
  private readonly dir: THREE.Vector3;
  private readonly slot: (k: number) => THREE.Vector3 | undefined;
  /** Тріал: зони за номером, центри точок 0…2, маршрут суперника з місця k. */
  private readonly zones = new Map<number, ZonePlanes>();
  private targets: THREE.Vector3[] = [];
  private trialRoute: ((k: number) => RouteNet) | null = null;
  /** Автобол: напрям машини на місці k (обличчям до центру), м'яч, чи рахуємо його тут (сервер чи гра без мережі). */
  private slotDir: ((k: number) => THREE.Vector3) | null = null;
  ball: BallGame | null = null;
  private ballAuthority = true;
  private readonly ballTrack = new RemoteTrack();
  private readonly ballState = emptyState();
  private ballSeen = false;
  /** Автобол: гол (сервер — розіслати) і кінець гри (очки гравців). */
  onBallGoal: ((id: number, gate: number, total: number) => void) | null = null;
  onBallOver: ((scores: { id: number; name: string; points: number }[]) => void) | null = null;

  /** М'яч Автобола: рухомий предмет anmobj0251000 арени, ворота з огорож, лампи — перемикачі світу. */
  private setupBall(authority: boolean): void {
    const drive = this.drive;
    const mv = drive.worldObjects.movable('anmobj0251000');
    const blocks = [...drive.world.loaded.values()].flatMap((r) => r.built.assembler.b3d.blocks);
    if (!mv) return;
    this.ballAuthority = authority;
    this.ball = new BallGame(drive.rapierWorld, mv.body, readGates(blocks), {
      onGoal: (id, gate) => this.goal(id, gate),
      setLamp: (k, on) => drive.setWorldSwitch(k, on ? 1 : 0),
    });
    mv.body.wakeUp();
    // У гостя м'яч веде сервер: тіло з масою без тяжіння, швидкість — до пози з мережі (удар машини відчутний).
    if (!authority) mv.body.setGravityScale(0, true);
  }

  /**
   * М'яч у гостя (щокроку фізики): поза з мережі із запізненням (RemoteTrack), швидкість тіла — рух пози плюс пружина до
   * неї; далі BALL_SNAP — одразу туди (гол: м'яч на старті).
   */
  private followBall(): void {
    const s = this.ballTrack.sample(this.simNow, this.ballState);
    const body = this.ball!.body;
    if (!s) return;
    const t = body.translation();
    const d = new THREE.Vector3(s.pos.x - t.x, s.pos.y - t.y, s.pos.z - t.z);
    if (!this.ballSeen || d.length() > BALL_SNAP) {
      this.ballSeen = true;
      body.setTranslation(s.pos, true);
      body.setLinvel(s.vel, true);
      return;
    }
    const v = s.vel.clone().addScaledVector(d, 1 / BALL_FOLLOW);
    body.setLinvel({ x: v.x, y: v.y, z: v.z }, true);
    body.wakeUp();
  }

  /** Гол (сервер чи гра без мережі): очки, лампа, оплески; сервер розсилає. */
  private goal(id: number, gate: number): void {
    const r = this.racers.find((x) => (x.id ?? 0) === id);
    const g = this.ball?.gates[gate];
    if (!r || !g) return;
    r.points = (r.points ?? 0) + g.points;
    this.scored(r, gate);
    this.onBallGoal?.(id, gate, r.points);
  }

  /** Гол з мережі: очки гравця id (разом), лампа й оплески. */
  netGoal(id: number, gate: number, total: number): void {
    const r = this.racers.find((x) => x.id === id);
    if (!r) return;
    r.points = total;
    this.scored(r, gate);
  }

  private scored(r: Racer, gate: number): void {
    this.ball?.lightGate(gate);
    this.drive.playSound('ovation1');
    // mess.txt 0x56 «ВАША СУММА $%d» — лише своєму гравцю (0x576670).
    if (r === this.racers[0]) this.drive.say(`ВАША СУМА $${r.points}`);
    if ((r.points ?? 0) >= BALL_WIN && !this.done) {
      this.done = true;
      this.onBallOver?.(this.ballScores());
    }
  }

  /** Очки гравців (без суперників), за спаданням. */
  ballScores(): { id: number; name: string; points: number }[] {
    return this.racers
      .filter((r) => !r.pilot)
      .map((r) => ({ id: r.id ?? 0, name: r.name, points: r.points ?? 0 }))
      .sort((a, b) => b.points - a.points);
  }
  /** Мережева гонка (null — одиночна). */
  net: NetRace | null = null;

  /** Суперник на автопілоті на місці решітки k (рух king.exe, як у гравця; автопілот — переслідування по дузі). */
  private addAi(rec: ReturnType<typeof drivable>[number] | undefined, k: number, id?: number, color = 0): void {
    const drive = this.drive;
    const p = this.slot(k);
    const def = rec && truckDef(drive.trucksData, rec);
    const model = def && buildTruckModel(drive.trucksData.asm, def, false);
    if (!rec || !p || !def || !model) return;
    if (color > 0) recolor(model.root, drive.trucksData, color + 1);
    const truck = new TruckVehicle(drive.rapierWorld, def, model, { position: drive.groundAtPublic(p), forward: this.dir }, kingCar(rec.suspension));
    drive.world.scene.add(truck.visual);
    // Тріал: у кожного свій маршрут дорогами арени до check1_k і fline1_k (0x422400), смуги — по осі.
    const route = this.trialRoute?.(k);
    const pilot = kingPilot(new AutoPilot(route ?? this.route), truck.base);
    pilot.cruise = 75 + (k % 4) * 6;
    pilot.lane = route ? 0 : k % 2 ? LANE : -LANE;
    this.racers.push({ truck, pilot, laps: 0, last: 0, halfway: false, finished: null, name: rec.carNode, cruise: pilot.cruise, id, route, stage: route ? 1 : undefined });
  }

  /**
   * Машина з мережі: гравець (стоїть на своєму місці, доки не прийде стан) чи суперник господаря (схований, доки не
   * прийде перший стан). Тіло з масою, без тяжіння — його веде стан із мережі (TruckVehicle.followRemote).
   */
  private addRemote(id: number, car: NetCar, name: string, at: THREE.Vector3 | undefined, hidden: boolean, forward = this.dir): void {
    const drive = this.drive;
    const rec = drive.trucksData.records.find((r) => r.carNode === car.truck) ?? drivable(drive.trucksData)[0];
    const def = rec && truckDef(drive.trucksData, rec);
    const model = def && buildTruckModel(drive.trucksData.asm, def, false);
    if (!rec || !def || !model) return;
    if (car.color > 0) recolor(model.root, drive.trucksData, car.color + 1);
    const truck = new TruckVehicle(drive.rapierWorld, def, model, { position: drive.groundAtPublic(at ?? this.route.pts[0]), forward }, kingCar(rec.suspension));
    truck.makeRemote();
    truck.syncVisual();
    drive.world.scene.add(truck.visual);
    const state = emptyState();
    const p = truck.body.translation();
    const r = truck.body.rotation();
    state.pos.set(p.x, p.y, p.z);
    state.quat.set(r.x, r.y, r.z, r.w);
    const racer: Racer = { truck, pilot: null, laps: 0, last: 0, halfway: false, finished: null, name, id, remote: { track: new RemoteTrack(), state, gone: false, waiting: hidden } };
    this.racers.push(racer);
    if (hidden) this.hide(racer, true);
  }

  private hide(r: Racer, hidden: boolean): void {
    r.truck.visual.visible = !hidden;
    r.truck.body.setEnabled(!hidden);
  }

  /** Мережа: тримати світлофор на червоному, доки всі не завантажать трасу (старт дає господар). */
  hold = false;
  /** Свій фініш у мережевій гонці: час від зеленого (с) і місце — замість вікна (таблицю показує гра). */
  onNetFinish: ((time: number, place: number) => void) | null = null;
  /** Секунди для показу машин з мережі (performance.now / 1000), що йдуть кроками фізики. */
  private simNow = -1;

  /** Пакет стану своєї машини (і суперників — у господаря) для мережі; flags — фари, гальмо, задній хід. */
  netPacket(flags: number): ArrayBuffer {
    const now = performance.now() / 1000;
    const cars: { id: number; s: TruckState }[] = [];
    for (const r of this.racers) {
      if (r.remote || r.id === undefined) continue;
      const s = (this.sendStates[cars.length] ??= emptyState());
      const t = r.truck.body.translation();
      const q = r.truck.body.rotation();
      const v = r.truck.body.linvel();
      s.time = now;
      s.pos.set(t.x, t.y, t.z);
      s.quat.set(q.x, q.y, q.z, q.w);
      s.vel.set(v.x, v.y, v.z);
      s.steer = r.truck.wheelSteer;
      s.rpm = r.truck.rpm;
      s.flags = r.pilot ? (r.truck.gear < 0 ? FLAG_REVERSE : 0) : flags;
      cars.push({ id: r.id, s });
    }
    // М'яч Автобола — у пакеті сервера (номер BALL_ID).
    if (this.ball && this.ballAuthority && this.net) {
      const s = (this.sendStates[cars.length] ??= emptyState());
      const b = this.ball.body;
      const t = b.translation();
      const q = b.rotation();
      const v = b.linvel();
      s.time = now;
      s.pos.set(t.x, t.y, t.z);
      s.quat.set(q.x, q.y, q.z, q.w);
      s.vel.set(v.x, v.y, v.z);
      s.steer = 0;
      s.rpm = 0;
      s.flags = 0;
      cars.push({ id: BALL_ID, s });
    }
    return packFleet(cars);
  }

  private readonly sendStates: TruckState[] = [];

  /** Пакет машин з мережі. */
  pushFleet(data: ArrayBuffer): void {
    const now = performance.now() / 1000;
    readFleet(data, (id, s) => {
      if (id === BALL_ID) {
        if (!this.ballAuthority) this.ballTrack.push(s, now);
        return;
      }
      const r = this.racers.find((x) => x.remote && x.id === id);
      if (!r?.remote || r.remote.gone) return;
      r.remote.track.push(s, now);
      if (r.remote.waiting) {
        r.remote.waiting = false;
        this.hide(r, false);
      }
    });
  }

  /** Гравці вийшли (which — за номером; без нього — усі машини з мережі): машини прибрати з траси. */
  remoteGone(which: (id: number) => boolean = () => true): void {
    for (const r of this.racers) {
      if (!r.remote || r.remote.gone || r.id === undefined || !which(r.id)) continue;
      r.remote.gone = true;
      this.hide(r, true);
    }
  }

  /** Фініш гравця з мережі (його час від зеленого) — для місць і таблиці. */
  netFinished(id: number, time: number): void {
    const r = this.racers.find((x) => x.id === id && x !== this.racers[0]);
    if (r) r.finished = time;
  }

  get routeLength(): number {
    return this.route.length;
  }

  /** Старт і фініш кола (start1_1) — для значка на карті. */
  get finishPos(): THREE.Vector3 {
    if (this.kind === 'ball') return this.ball?.pos ?? this.route.pts[0];
    return this.kind === 'trial' ? this.targets[2] : this.route.pts[0];
  }

  /** Підпис фінішу на карті: mess.txt 88 «Кольцо»; Тріал — фініш. */
  get finishLabel(): string {
    return this.kind === 'ball' ? 'МʼЯЧ' : this.kind === 'trial' ? 'ФІНІШ' : 'КІЛЬЦЕ';
  }

  /** Тріал: куди показує компас (наступна точка після нульової; далі 10 м — нічого) — null, якщо не показувати. */
  compassTarget(): THREE.Vector3 | null {
    if (this.kind !== 'trial') return null;
    const me = this.racers[0];
    const st = me.stage ?? 0;
    if (st < 1 || st > 2 || me.finished !== null) return null;
    const t = this.targets[st];
    return t && t.distanceTo(me.truck.visual.position) > 10 ? t : null;
  }

  /** Перед кроком фізики: керування суперників (до відліку — стоять). */
  control(dt: number): void {
    // Час показу машин з мережі — кроками фізики (кілька кроків за кадр бачать різні пози); відстав чи забіг понад
    // 0,25 с (пауза, довгий кадр) — знову за годинником.
    const real = performance.now() / 1000;
    this.simNow = this.simNow < 0 || Math.abs(real - this.simNow) > 0.25 ? real : this.simNow + dt;
    if (this.ball && !this.ballAuthority) this.followBall();
    const others = this.racers.filter((r) => !r.remote?.gone && !r.remote?.waiting).map((r) => r.truck.visual.position);
    // «Гумова нитка» — від гравця; у мережі — від найдальшого з живих гравців.
    const me = this.net ? Math.max(...this.racers.filter((r) => !r.pilot && !r.remote?.gone).map((r) => this.progress(r))) : this.progress(this.racers[0]);
    for (const r of this.racers) {
      const rm = r.remote;
      if (rm) {
        if (rm.gone || rm.waiting) continue;
        const s = rm.track.sample(this.simNow, rm.state) ?? rm.state;
        r.truck.followRemote(dt, s.pos, s.quat, s.steer, s.rpm, s.vel.length() * 3.6, (s.flags & FLAG_REVERSE) !== 0);
        continue;
      }
      if (!r.pilot) continue;
      // «Гумова нитка»: гравець попереду — суперник швидшає (до ×1,5), позаду — повільнішає (до ×0,75).
      const x = RUBBER_K * (me - this.progress(r));
      r.pilot.cruise = (r.cruise ?? r.pilot.cruise) * THREE.MathUtils.clamp(1 + x * Math.abs(x), RUBBER_MIN, RUBBER_MAX);
      const p = r.truck.body.translation();
      const st = r.pilot.update(new THREE.Vector3(p.x, p.y, p.z), r.truck.forward(), r.truck.speedKmh, dt, others.filter((o) => o !== r.truck.visual.position));
      r.truck.update(dt, this.countdown > 0 || r.finished !== null ? { steer: 0, throttle: 0, brake: 1, handbrake: true } : st);
    }
  }

  /** Гравцю до старту — гальмо. */
  get holding(): boolean {
    return this.countdown > 0;
  }

  /** Після кроку: візуал суперників, кола, місця, фініш. */
  after(dt: number, alpha = 1): void {
    const before = COUNTDOWN - this.countdown;
    if (!this.hold) this.countdown -= dt;
    const now = COUNTDOWN - this.countdown;
    for (const b of BLINKS) if (before < b && now >= b) this.drive.playSound('alarm');
    if (this.countdown <= 0) this.clock += dt;
    for (const r of this.racers) {
      if (r.pilot) {
        r.truck.syncVisual(alpha);
        // Упав крізь світ, перекинувся (2 с) чи далеко від маршруту (4 с) — назад на маршрут, де був.
        const y = r.truck.body.translation().y;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
        const off = (r.route ?? this.route).nearest(r.truck.visual.position)?.dist ?? 0;
        r.bad = up < 0.5 ? (r.bad ?? 0) + dt * 2 : off > OFF_ROUTE ? (r.bad ?? 0) + dt : 0;
        // Стоїть після старту (застряг за перешкодою чи в купі машин) — теж відновлення, як «застряглий» водій.
        r.idle = this.countdown <= 0 && r.finished === null && r.truck.speedKmh < 3 ? (r.idle ?? 0) + dt : 0;
        if (y < this.floor - 40 || r.bad > 4 || r.idle > IDLE_RESPAWN) {
          const stuck = r.idle > IDLE_RESPAWN;
          r.idle = 0;
          r.bad = 0;
          this.respawn(r, stuck ? 20 : 0);
        }
      } else if (r.remote && !r.remote.gone && !r.remote.waiting) r.truck.syncVisual(alpha);
      if (r.finished !== null || this.countdown > 0 || r.remote?.gone) continue;
      if (this.kind === 'trial') {
        this.trialStep(r);
        continue;
      }
      if (this.kind === 'ball') continue;
      const s = this.route.along(r.truck.visual.position);
      const L = this.route.length;
      if (s > L * 0.4 && s < L * 0.6) r.halfway = true;
      // Перетнули старт: було біля кінця кола — стало біля початку (і середину кола пройдено).
      if (r.halfway && r.last > L * 0.8 && s < L * 0.2) {
        r.laps++;
        r.halfway = false;
        if (r.laps >= LAPS) {
          r.finished = this.clock;
          if (r.pilot && this.racers[0].finished === null) this.drive.say(this.messages('COMPETITOR_ARRIVED', 'ВАШ КОНКУРЕНТ ЩОЙНО ПРИБУВ. ПОКВАПТЕСЯ'));
        }
      }
      r.last = s;
    }
    if (this.kind === 'ball') {
      this.ball?.update(dt);
      // Хто торкався й голи — лише там, де м'яч рахується (сервер чи гра без мережі); до старту м'яч ще не в грі.
      if (this.ball && this.ballAuthority && !this.done && this.countdown <= 0) {
        const cars = new Map<number, number>();
        for (const r of this.racers) if (!r.pilot && !r.remote?.gone) cars.set(r.truck.body.handle, r.id ?? 0);
        this.ball.step(cars);
      }
      return;
    }
    const me = this.racers[0];
    if (this.done || this.countdown > 0) return;
    if (me.finished !== null) {
      this.done = true;
      const place = this.place(me);
      if (this.net) {
        this.drive.say(this.messages(`YOU_CAME_${place - 1}`, `ВИ ПРИЇХАЛИ ${place}-М`));
        this.onNetFinish?.(me.finished, place);
        return;
      }
      if (this.career) {
        this.drive.say(this.messages(`YOU_CAME_${place - 1}`, `ВИ ПРИЇХАЛИ ${place}-М`));
        this.onFinish?.(place);
        return;
      }
      void modal(this.drive.overlay, 'Фініш', this.messages(`YOU_CAME_${place - 1}`, `Ви фінішували ${place}-м`), ['Гаразд']).then(() => this.onFinish?.(place));
      return;
    }
    // Ліміту часу в мережевій грі немає (0x427920 викликається лише в кар'єрі, tracks.md §3).
    if (this.clock > TIME_LIMIT && !this.net) {
      this.done = true;
      if (this.career) {
        this.drive.say(this.messages('DISQUALIFIED', 'ВАС ЗНЯТО З ДИСТАНЦІЇ'));
        this.onFinish?.(0);
        return;
      }
      void modal(this.drive.overlay, 'Гонка', this.messages('DISQUALIFIED', 'ВАС ЗНЯТО З ДИСТАНЦІЇ'), ['Гаразд']).then(() => this.onFinish?.(0));
      return;
    }
    // Пейджер: місце змінилось (повідомлення є лише для перших трьох місць).
    const place = this.place(me);
    if (place !== this.announced) {
      if (this.announced && place <= 3) this.drive.say(this.messages(`YOU_ARE_${place - 1}`, `ВИ ${place}-Й У ГОНЦІ`));
      this.announced = place;
    }
  }

  /** Найнижча точка маршруту (нижче — суперник падає крізь світ). */
  private get floor(): number {
    return Math.min(...this.route.pts.map((p) => p.y));
  }

  /**
   * Назад на маршрут, де був; застряглого — трохи вперед, на вільне місце у своєму ряду (гіпотеза порту: інакше
   * машина знову ставала в ту саму купу).
   */
  private respawn(r: Racer, ahead = 0): void {
    const route = r.route ?? this.route;
    const n = route.nearest(r.truck.visual.position.clone().setY(route.pts[0].y));
    let seg = n?.seg ?? 0;
    const N = route.pts.length;
    const free = (p: THREE.Vector3) => this.racers.every((o) => o === r || o.truck.visual.position.distanceTo(p) > 8);
    for (let tries = 0; tries < 20; tries++) {
      const from = route.cum[seg];
      while (ahead > 0 && route.cum[(seg + 1) % N] - from < ahead && seg + 1 < N - 1) seg++;
      const p = route.pts[seg];
      const q = route.pts[(seg + 1) % N];
      const fwd = q.clone().sub(p).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
      const at = p.clone().addScaledVector(side, r.pilot?.lane ?? 0);
      if (!ahead || free(at) || tries === 19) {
        r.truck.reset({ position: this.drive.groundAtPublic(at), forward: fwd });
        return;
      }
      ahead = 10;
    }
  }

  private progress(r: Racer): number {
    if (this.kind === 'ball') return r.points ?? 0;
    if (this.kind === 'trial') {
      // Пряма відстань, що лишилась (як прогрес ІІ king.exe 0x4171a0): до точки 1 і від неї до фінішу, після точки 1 —
      // до фінішу.
      if (r.finished !== null) return 1e9 - r.finished;
      const p = r.truck.visual.position;
      const [, c1, c2] = this.targets;
      const left = (r.stage ?? 0) >= 2 ? p.distanceTo(c2) : p.distanceTo(c1) + c1.distanceTo(c2);
      return 1e6 - left;
    }
    // До середини кола «кінець маршруту» — це ще позаду старту (від’ємний поступ), а не майже ціле коло.
    const L = this.route.length;
    const s = !r.halfway && r.last > L * 0.8 ? r.last - L : r.last;
    return r.finished !== null ? 1e9 - r.finished : r.laps * L + s;
  }

  place(r: Racer): number {
    const mine = this.progress(r);
    return 1 + this.racers.filter((o) => o !== r && !o.remote?.gone && this.progress(o) > mine).length;
  }

  /** Час від зеленого, с. */
  get time(): number {
    return this.clock;
  }

  hud(): string {
    const me = this.racers[0];
    if (this.hold) return 'Чекаємо, поки всі завантажать трасу…';
    if (this.countdown > 0) return `Старт через ${Math.ceil(this.countdown)}…`;
    const all = this.racers.filter((r) => !r.remote?.gone).length;
    const where =
      this.kind === 'ball' ? `Очки ${me.points ?? 0} з ${BALL_WIN}` : this.kind === 'trial' ? `Точка ${Math.min(3, (me.stage ?? 0) + 1)} з 3` : `Коло ${Math.min(LAPS, me.laps + 1)} з ${LAPS}`;
    return `${where}   місце ${this.place(me)} з ${all}   ${this.clock.toFixed(1)} с`;
  }

  /** Місце гравця серед машин на трасі — для табло («ПОЗИЦІЯ N З M»). */
  standing(): { place: number; of: number } {
    return { place: this.place(this.racers[0]), of: this.racers.filter((r) => !r.remote?.gone).length };
  }

  /**
   * Тріал (king.exe 0x56ffd0, подія 7): зони лише по черзі 0 → 1 → 2; вʼїзд у наступну — «Контрольна точка» (mess.txt 6),
   * у пізнішу — «Порядок проходження маршруту порушено» (mess.txt 4); зона 2 — фініш. Суперники починають з точки 1
   * (їхня ціль одразу check1/fline, 0x422400). Без тригерів у даних — зона за 15 м від центру точки.
   */
  private trialStep(r: Racer): void {
    const p = r.truck.visual.position;
    let inside = -1;
    if (this.zones.size) {
      for (const [i, z] of this.zones)
        if (inZone(z, p)) {
          inside = i;
          break;
        }
    } else inside = this.targets.findIndex((t) => t.distanceTo(p) < 15);
    const was = r.inside;
    r.inside = inside;
    if (inside < 0 || inside === was) return;
    const st = r.stage ?? 0;
    const me = r === this.racers[0];
    if (inside === st) {
      r.stage = st + 1;
      if (r.stage >= 3) {
        r.finished = this.clock;
        if (!me && r.pilot && this.racers[0].finished === null) this.drive.say(this.messages('COMPETITOR_ARRIVED', 'ВАШ КОНКУРЕНТ ЩОЙНО ПРИБУВ. ПОКВАПТЕСЯ'));
      } else if (me) this.drive.say('КОНТРОЛЬНА ТОЧКА');
    } else if (inside > st && me) this.drive.say('ПОРЯДОК ПРОХОДЖЕННЯ МАРШРУТУ ПОРУШЕНО');
  }

  dispose(): void {
    for (const r of this.racers.slice(1)) {
      this.drive.world.scene.remove(r.truck.visual);
      r.truck.dispose();
    }
  }
}

