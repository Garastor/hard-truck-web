import * as THREE from 'three';
import { HT2_ENGINE, HT2_ROLL_LIFT, HT2_STEER_LIMIT, HT2_STEER_POWER, HT2_BRAKE } from './controls';
import { AutoPilot, type WayLine } from '../../game/autopilot';
import { TruckVehicle } from '../../game/truckVehicle';
import { buildTruckModel } from '../../game/trucks';
import { modal } from '../../ui/careerUi';
import type { Ht2Roads } from './roads';
import { drivable, truckDef } from './trucks';
import { toThree } from './world';
import type { Ht2Drive } from './drive';

/**
 * Гонка на Кільці (регіон dr): стартова решітка `start1_1…8`, контрольні точки `check_point1…3` (вузли WAY);
 * 3 кола (гіпотеза; mess.txt: «Пройдено кругов : %d из %d»), суперників — 7 (MENV/GAME.CNF: aitruck 8 разом з
 * гравцем). Маршрут кола — найкоротший шлях мережею доріг через точки по черзі; суперники їдуть ним автопілотом.
 * Місце — за пройденою відстанню маршруту. Фініш — повідомлення YOU_CAME_N з Ms.sch.
 */
const LAPS = 3;
const COUNTDOWN = 3;

/** Найкоротший шлях лініями мережі від лінії біля a до лінії біля b (Дейкстра; вага — довжина лінії). */
function path(roads: Ht2Roads, a: THREE.Vector3, b: THREE.Vector3, heading?: THREE.Vector3): THREE.Vector3[] {
  const from = roads.nearest(a, heading);
  const to = roads.nearest(b);
  if (!from || !to) return [a, b];
  const len = (l: WayLine) => l.pts.reduce((s, p, i) => (i ? s + p.distanceTo(l.pts[i - 1]) : 0), 0);
  const dist = new Map<WayLine, number>([[from.line, 0]]);
  const prev = new Map<WayLine, WayLine>();
  const open = new Set<WayLine>([from.line]);
  while (open.size) {
    let cur: WayLine | null = null;
    for (const l of open) if (!cur || dist.get(l)! < dist.get(cur)!) cur = l;
    open.delete(cur!);
    if (cur === to.line) break;
    const d = dist.get(cur!)! + len(cur!);
    for (const n of cur!.next)
      if (d < (dist.get(n) ?? Infinity)) {
        dist.set(n, d);
        prev.set(n, cur!);
        open.add(n);
      }
  }
  if (!dist.has(to.line)) return [a, b];
  const chain: WayLine[] = [];
  for (let l: WayLine | undefined = to.line; l; l = prev.get(l)) chain.unshift(l);
  const pts: THREE.Vector3[] = [];
  chain.forEach((l, i) => {
    const s = i === 0 ? from.seg : 0;
    const e = i === chain.length - 1 ? to.seg + 1 : l.pts.length - 1;
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
  /** Скільки секунд машина перекинута чи далеко від маршруту (суперники — відновлення). */
  bad?: number;
  finished: number | null;
  name: string;
}

export class RaceMode {
  private readonly route: RouteNet;
  readonly racers: Racer[] = [];
  private countdown = COUNTDOWN;
  private clock = 0;
  private done = false;
  onFinish: ((place: number) => void) | null = null;

  constructor(private readonly drive: Ht2Drive, roads: Ht2Roads, private readonly messages: (key: string, fb: string) => string) {
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
    player.reset({ position: drive.groundAtPublic(start), forward: dir });
    this.racers.push({ truck: player, pilot: null, laps: 0, last: 0, halfway: false, finished: null, name: 'Ви' });
    // Суперники: тягачі й вантажівки без надвеликих Storm (12 м і більше: на решітці з кроком 15 м — перетин).
    const pool = drivable(drive.trucksData).filter((r) => (r.group === 'tractors' || r.group === 'lorries') && !/^Storm/.test(r.carNode));
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0)).normalize();
    for (let k = 2; k <= 8; k++) {
      const base = nodes.get(`start1_${k}`);
      // Решітка — одна колона вздовж траси; розводимо машини на дві колони (±3,5 м), щоб не торкались.
      const p = base?.clone().addScaledVector(side, k % 2 ? 3.5 : -3.5);
      const rec = pool[(k * 5) % pool.length];
      const def = rec && truckDef(drive.trucksData, rec);
      const model = def && buildTruckModel(drive.trucksData.asm, def, false);
      if (!p || !def || !model) continue;
      const truck = new TruckVehicle(drive.rapierWorld, def, model, { position: drive.groundAtPublic(p), forward: dir }, { engine: HT2_ENGINE, rollLift: HT2_ROLL_LIFT, steerLimit: HT2_STEER_LIMIT, steerPower: HT2_STEER_POWER, brake: HT2_BRAKE });
      drive.world.scene.add(truck.visual);
      const pilot = new AutoPilot(this.route);
      pilot.cruise = 75 + (k % 4) * 6;
      this.racers.push({ truck, pilot, laps: 0, last: 0, halfway: false, finished: null, name: rec.carNode });
    }
  }

  get routeLength(): number {
    return this.route.length;
  }

  /** Перед кроком фізики: керування суперників (до відліку — стоять). */
  control(dt: number): void {
    const others = this.racers.map((r) => r.truck.visual.position);
    for (const r of this.racers) {
      if (!r.pilot) continue;
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
  after(dt: number): void {
    this.countdown -= dt;
    if (this.countdown <= 0) this.clock += dt;
    for (const r of this.racers) {
      if (r.pilot) {
        r.truck.syncVisual();
        // Упав крізь світ, перекинувся (2 с) чи далеко від маршруту (4 с) — назад на маршрут, де був.
        const y = r.truck.body.translation().y;
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.truck.visual.quaternion).y;
        const off = this.route.nearest(r.truck.visual.position)?.dist ?? 0;
        r.bad = up < 0.5 ? (r.bad ?? 0) + dt * 2 : off > 25 ? (r.bad ?? 0) + dt : 0;
        if (y < this.floor - 40 || r.bad > 4) {
          r.bad = 0;
          this.respawn(r);
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
        if (r.laps >= LAPS) r.finished = this.clock;
      }
      r.last = s;
    }
    const me = this.racers[0];
    if (me.finished !== null && !this.done) {
      this.done = true;
      const place = this.place(me);
      void modal(this.drive.overlay, 'Фініш', this.messages(`YOU_CAME_${place - 1}`, `Ви фінішували ${place}-м`), ['Гаразд']).then(() => this.onFinish?.(place));
    }
  }

  /** Найнижча точка маршруту (нижче — суперник падає крізь світ). */
  private get floor(): number {
    return Math.min(...this.route.pts.map((p) => p.y));
  }

  private respawn(r: Racer): void {
    const n = this.route.nearest(r.truck.visual.position.clone().setY(this.route.pts[0].y));
    const seg = n?.seg ?? 0;
    const p = this.route.pts[seg];
    const q = this.route.pts[(seg + 1) % this.route.pts.length];
    r.truck.reset({ position: this.drive.groundAtPublic(p), forward: q.clone().sub(p).setY(0).normalize() });
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

