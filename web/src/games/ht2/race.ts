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
  ) {
    const nodes = new Map<string, THREE.Vector3>();
    for (const r of drive.world.regions.values())
      for (const room of r.way.rooms) for (const n of room.nodes) if (/^(start1_\d|check_point\d)$/.test(n.name)) nodes.set(n.name, toThree(...n.pos));
    const start = nodes.get('start1_1')!;
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
    const player = drive.truck;
    if (!career) player.reset({ position: drive.groundAtPublic(start), forward: dir });
    this.racers.push({ truck: player, pilot: null, laps: 0, last: career ? this.route.along(player.visual.position) : 0, halfway: false, finished: null, name: 'Ви' });
    // Суперники: тягачі й вантажівки без надвеликих Storm (12 м і більше: на решітці з кроком 15 м — перетин); у
    // кар'єрі — клас машини гравця (0x425d40; без причепів — гіпотеза порту).
    const group = drive.truckGroup;
    const pool = drivable(drive.trucksData).filter((r) => (career ? r.group === group : r.group === 'tractors' || r.group === 'lorries') && !/^Storm/.test(r.carNode));
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    for (let k = career ? 1 : 2; k <= (career ? CAREER_RIVALS : 8); k++) {
      const base = nodes.get(`start1_${k}`);
      // Решітка — одна колона вздовж траси; машини — у два ряди за номером (±1,75 м, як смуги 0x4d43a0).
      const p = base?.clone().addScaledVector(side, k % 2 ? LANE : -LANE);
      const rec = pool[(k * 5) % pool.length];
      const def = rec && truckDef(drive.trucksData, rec);
      const model = def && buildTruckModel(drive.trucksData.asm, def, false);
      if (!p || !def || !model) continue;
      // Рух king.exe, як у гравця (kingModel), автопілот — переслідування по дузі з базою машини.
      const truck = new TruckVehicle(drive.rapierWorld, def, model, { position: drive.groundAtPublic(p), forward: dir }, kingCar(rec.suspension));
      drive.world.scene.add(truck.visual);
      const pilot = kingPilot(new AutoPilot(this.route), truck.base);
      pilot.cruise = 75 + (k % 4) * 6;
      pilot.lane = k % 2 ? LANE : -LANE;
      this.racers.push({ truck, pilot, laps: 0, last: 0, halfway: false, finished: null, name: rec.carNode, cruise: pilot.cruise });
    }
  }

  get routeLength(): number {
    return this.route.length;
  }

  /** Старт і фініш кола (start1_1) — для значка на карті. */
  get finishPos(): THREE.Vector3 {
    return this.route.pts[0];
  }

  /** Перед кроком фізики: керування суперників (до відліку — стоять). */
  control(dt: number): void {
    const others = this.racers.map((r) => r.truck.visual.position);
    const me = this.progress(this.racers[0]);
    for (const r of this.racers) {
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
    this.countdown -= dt;
    const now = COUNTDOWN - this.countdown;
    for (const b of BLINKS) if (before < b && now >= b) this.drive.playSound('alarm');
    if (this.countdown <= 0) this.clock += dt;
    for (const r of this.racers) {
      if (r.pilot) {
        r.truck.syncVisual(alpha);
        // Упав крізь світ, перекинувся (2 с) чи далеко від маршруту (4 с) — назад на маршрут, де був.
        const y = r.truck.body.translation().y;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
        const off = this.route.nearest(r.truck.visual.position)?.dist ?? 0;
        r.bad = up < 0.5 ? (r.bad ?? 0) + dt * 2 : off > OFF_ROUTE ? (r.bad ?? 0) + dt : 0;
        // Стоїть після старту (застряг за перешкодою чи в купі машин) — теж відновлення, як «застряглий» водій.
        r.idle = this.countdown <= 0 && r.finished === null && r.truck.speedKmh < 3 ? (r.idle ?? 0) + dt : 0;
        if (y < this.floor - 40 || r.bad > 4 || r.idle > IDLE_RESPAWN) {
          const stuck = r.idle > IDLE_RESPAWN;
          r.idle = 0;
          r.bad = 0;
          this.respawn(r, stuck ? 20 : 0);
        }
      }
      if (r.finished !== null || this.countdown > 0) continue;
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
    const me = this.racers[0];
    if (this.done || this.countdown > 0) return;
    if (me.finished !== null) {
      this.done = true;
      const place = this.place(me);
      if (this.career) {
        this.drive.say(this.messages(`YOU_CAME_${place - 1}`, `ВИ ПРИЇХАЛИ ${place}-М`));
        this.onFinish?.(place);
        return;
      }
      void modal(this.drive.overlay, 'Фініш', this.messages(`YOU_CAME_${place - 1}`, `Ви фінішували ${place}-м`), ['Гаразд']).then(() => this.onFinish?.(place));
      return;
    }
    if (this.clock > TIME_LIMIT) {
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
    const route = this.route;
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
    // До середини кола «кінець маршруту» — це ще позаду старту (від’ємний поступ), а не майже ціле коло.
    const L = this.route.length;
    const s = !r.halfway && r.last > L * 0.8 ? r.last - L : r.last;
    return r.finished !== null ? 1e9 - r.finished : r.laps * L + s;
  }

  place(r: Racer): number {
    const mine = this.progress(r);
    return 1 + this.racers.filter((o) => o !== r && this.progress(o) > mine).length;
  }

  hud(): string {
    const me = this.racers[0];
    if (this.countdown > 0) return `Старт через ${Math.ceil(this.countdown)}…`;
    return `Коло ${Math.min(LAPS, me.laps + 1)} з ${LAPS}   місце ${this.place(me)} з ${this.racers.length}   ${this.clock.toFixed(1)} с`;
  }

  dispose(): void {
    for (const r of this.racers.slice(1)) {
      this.drive.world.scene.remove(r.truck.visual);
      r.truck.dispose();
    }
  }
}

