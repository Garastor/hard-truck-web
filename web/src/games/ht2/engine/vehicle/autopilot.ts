import * as THREE from 'three';
import { walk, type B3d } from '../formats/b3d';
import { g2t } from '../physics/world';
import type { ControlState } from '../input/input';

/**
 * Мережа доріг з ліній `way_*` (блоки 20) і простий водій, що їде по ній.
 * Основа для суперників (`aicar` у truck.ini) і для автотестів фізики.
 */
export interface WayLine {
  name: string;
  pts: THREE.Vector3[];
  /** Лінії, що починаються біля кінця цієї. */
  next: WayLine[];
}

export class WayNet {
  readonly lines: WayLine[] = [];

  constructor(b3d: B3d) {
    for (const [blk] of walk(b3d.blocks)) {
      if (blk.data.t !== 20 || !blk.name.toLowerCase().startsWith('way') || blk.data.points.length < 2) continue;
      this.lines.push({ name: blk.name, pts: blk.data.points.map((p) => g2t(p)), next: [] });
    }
    for (const a of this.lines) {
      const end = a.pts[a.pts.length - 1];
      for (const b of this.lines) if (b !== a && b.pts[0].distanceTo(end) < 8) a.next.push(b);
    }
  }

  /** Найближча точка мережі: лінія, індекс сегмента, параметр. */
  /** bias — надбавка до відстані лінії, м (автопілот за маршрутом: лінії поза маршрутом — далі). */
  nearest(p: THREE.Vector3, heading?: THREE.Vector3, bias?: (l: WayLine) => number): { line: WayLine; seg: number; t: number; dist: number } | null {
    let best: { line: WayLine; seg: number; t: number; dist: number } | null = null;
    const ab = new THREE.Vector3();
    const ap = new THREE.Vector3();
    for (const line of this.lines) {
      for (let i = 0; i + 1 < line.pts.length; i++) {
        const a = line.pts[i];
        ab.subVectors(line.pts[i + 1], a);
        const len2 = ab.lengthSq();
        if (!len2) continue;
        const t = THREE.MathUtils.clamp(ap.subVectors(p, a).dot(ab) / len2, 0, 1);
        let dist = a.clone().addScaledVector(ab, t).distanceTo(p);
        // Лінії проти руху штрафуємо, щоб не розвертатися.
        if (heading && ab.clone().setY(0).normalize().dot(heading) < -0.2) dist += 30;
        if (bias) dist += bias(line);
        if (!best || dist < best.dist) best = { line, seg: i, t, dist };
      }
    }
    return best;
  }

  /** Точка на відстані `ahead` уздовж мережі від позиції (line, seg, t); choose — продовження на розвилці. */
  advance(line: WayLine, seg: number, t: number, ahead: number, choose?: (l: WayLine) => WayLine | null): THREE.Vector3 {
    let cur = line.pts[seg].clone().lerp(line.pts[seg + 1], t);
    let left = ahead;
    let l = line;
    let i = seg + 1;
    for (let guard = 0; guard < 200; guard++) {
      if (i >= l.pts.length) {
        const n = choose?.(l) ?? l.next[0];
        if (!n) return cur;
        l = n;
        i = 1;
        cur = l.pts[0].clone();
        continue;
      }
      const d = cur.distanceTo(l.pts[i]);
      if (d >= left) return cur.lerp(l.pts[i], left / d);
      left -= d;
      cur = l.pts[i].clone();
      i++;
    }
    return cur;
  }
}

/** Огляд перешкод попереду, м; зупинка за стільки до перешкоди (точки), м; розрахункове сповільнення, м/с². */
const BLOCK_LOOK = 60;
/** Робочий вектор перевірки перешкод (щокадру десятки точок — без нових обʼєктів). */
const REL = new THREE.Vector3();
/** Перешкода «на курсі» — ближче за стільки вбік від осі машини (півширини обох + запас), м. */
const STOP_SIDE = 2.6;
const STOP_GAP = 10;
const BLOCK_DECEL = 3;
/**
 * Розминання із зустрічною (порт, на прохання користувача: на базах боти стояли ніс у ніс): зустрічна машина
 * (курси протилежні, cos < PASS_COS) попереду ближче PASS_LOOK і ближче PASS_SIDE вбік від осі → прийняти праворуч
 * на PASS_SHIFT і їхати не швидше PASS_KMH; триматися ще PASS_HOLD с, як розминулися. Зустрічна-бот робить те саме,
 * тож розходяться вдвох. Стати — за PASS_GAP (ближче STOP_GAP: розʼїжджаються впритул, повзучи). Лише там, де
 * смуги вузькі (ширина ≤ PASS_LANE: на W12 внутрішні смуги по 3 м — тягачі зачіпали одне одного дзеркалами) чи на
 * території бази (`base`, world/roads); пригальмовувати — лише на базі й на смугах, вужчих за SLOW_LANE (петлі баз —
 * 2,5 м), на дорозі — лише прийняти праворуч.
 */
const PASS_LOOK = 70;
const PASS_SIDE = 6;
const PASS_COS = -0.5;
const PASS_SHIFT = 2.5;
const PASS_KMH = 20;
const PASS_HOLD = 1.5;
const PASS_GAP = 6;
const PASS_LANE = 3.2;
const SLOW_LANE = 2.8;
/**
 * Зупинка в точці (бот біля місця складу, traffic/truckers.ts): точка попереду ближче HALT_LOOK і ближче HALT_SIDE
 * вбік від осі → швидкість не більше √(2·HALT_DECEL·залишок), стати центром машини за HALT_AT від неї.
 */
const HALT_LOOK = 60;
const HALT_SIDE = 4;
const HALT_DECEL = 1.2;
const HALT_AT = 0.5;
/**
 * Їдучи за маршрутом (choose), «де я» — лінія маршруту (поточна чи її продовження), якщо інша ближча не більше ніж на
 * стільки, м: на стику лінії петлі й виїзду починаються в одній точці, і найближчою бувала петля — бот кружляв базою.
 */
const OFF_ROUTE = 3;
/** Від борту до стіни при розминанні — щонайменше: зсув праворуч ≤ wallRight − PASS_EDGE (півширини 1,25 + запас), м. */
const PASS_EDGE = 1.7;

/** Зустрічна машина для розминання: позиція й курс (одиничний, у площині). */
export interface Oncoming {
  pos: THREE.Vector3;
  forward: THREE.Vector3;
}

export class AutoPilot {
  readonly state: ControlState = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  /** Бажана крейсерська швидкість, км/год. */
  cruise = 60;
  /** Сповільнення перед поворотом: підсилення за кривизною й найменша частка крейсерської (тягач з причепом — сильніше). */
  bendGain = 2.2;
  bendFloor = 0.3;
  /**
   * Колісна база для кінематичного руху king.exe, м (0 — кермо = кут до цілі × 2,2, як для шин Rapier). Задана —
   * переслідування цілі по дузі: кут коліс δ = atan(2·L·sin α / d), кермо = δ / 45°.
   */
  kinematicBase = 0;
  /** Кермо для потрібного кута коліс δ (кінематичний рух; без нього — δ / 45°). */
  steerFor: ((delta: number) => number) | null = null;
  private stuck = 0;
  private reversing = 0;
  /** Кермо на час здавання назад (протилежне до того, з яким застряг). */
  private reverseSteer = 0;
  /** Бічний зсув для обгону (м), плавно змінюється. */
  private offset = 0;
  /** Своя смуга — сталий зсув від осі маршруту, м (+ праворуч; гонка: ряди решітки ±1,75 м). */
  lane = 0;
  /** Скільки ще розминатися із зустрічною (прийняти праворуч), с. */
  passing = 0;
  /**
   * Продовження лінії на розвилці (маршрут бота до складу, world/navigator next); null чи немає — стала випадкова
   * гілка мережі (`pick`).
   */
  choose: ((l: WayLine) => WayLine | null) | null = null;
  /** Де стати (місце складу); null — їхати далі. */
  halt: THREE.Vector3 | null = null;
  /** Лінія, на якій машина була минулого кроку (маршрут: її продовження — своє). */
  private cur: WayLine | null = null;

  constructor(private readonly net: WayNet) {}

  /** Відстань до перешкоди попереду минулого кроку й швидкість зближення з нею, м і м/с. */
  private prevBlock = Infinity;
  private closing = 0;
  /**
   * Обгін зсувом убік на ходу (гонка, автопілот гравця). Далекобійники-боти не обганяють (як «обережні» водії
   * king.exe): тягач з довгим причепом, кидаючись убік, чіпляв боком того, кого обʼїжджав, а зсуви між ботами й
   * трафіком виглядали зигзагами; бот стоїть за перешкодою.
   */
  dodge = true;

  update(
    pos: THREE.Vector3,
    forward: THREE.Vector3,
    speedKmh: number,
    dt = 1 / 60,
    others: readonly THREE.Vector3[] = [],
    oncoming: readonly Oncoming[] = [],
  ): ControlState {
    const s = this.state;
    // Застряг (газ є, швидкості немає) → здати назад з протилежним кермом.
    if (this.reversing > 0) {
      this.reversing -= dt;
      s.throttle = 0;
      s.brake = 1;
      s.steer = this.reverseSteer;
      return s;
    }
    if (s.throttle > 0.5 && speedKmh < 2) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 1.5) {
      this.stuck = 0;
      this.reversing = 1.6;
      // Назад — з протилежним кермом: ніс повертає до цілі (кінематичний рух king.exe інакше їздив туди-сюди по
      // тій самій дузі, упираючись у ту саму стіну).
      this.reverseSteer = -s.steer;
      s.steer = this.reverseSteer;
      s.throttle = 0;
      s.brake = 1;
      return s;
    }
    const cur = this.choose ? this.cur : null;
    const onward = cur && this.choose!(cur);
    const n = this.net.nearest(pos, forward, cur ? (l) => (l === cur || l === onward ? 0 : OFF_ROUTE) : undefined);
    this.cur = n?.line ?? null;
    if (!n) {
      s.throttle = 0;
      s.brake = 1;
      return s;
    }
    const look = 5 + speedKmh * 0.18;
    const choose = this.choose ?? undefined;
    const target = this.net.advance(n.line, n.seg, n.t, look, choose);
    // Машини попереду в «коридорі» → обгін зсувом убік, а якщо дуже близько — гальмуємо.
    const rightV = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const flat = forward.clone().setY(0).normalize();
    this.passing = Math.max(0, this.passing - dt);
    // Лінії Ht2Roads (друга гра) несуть ширину смуги й позначку бази; у WayNet їх немає — там розминання немає.
    const here = n.line as WayLine & { base?: boolean; laneWidth?: number; wallRight?: number };
    const lw = here.laneWidth ?? Infinity;
    const tight = !!here.base || lw < PASS_LANE;
    const slow = !!here.base || lw < SLOW_LANE;
    if (tight) for (const o of oncoming) {
      if (o.forward.dot(flat) > PASS_COS) continue;
      const rel = REL.subVectors(o.pos, pos);
      const ahead = rel.dot(forward);
      if (ahead > 0 && ahead < PASS_LOOK && Math.abs(rel.dot(rightV)) < PASS_SIDE) this.passing = PASS_HOLD;
    }
    // blockDist — у коридорі обгону (зі зсувом); stopDist — там, куди машина їде (з обгоном — той самий коридор).
    let blockDist = Infinity;
    let blockSide = 0;
    let stopDist = Infinity;
    for (const o of others) {
      const rel = REL.subVectors(o, pos);
      const ahead = rel.dot(forward);
      if (ahead <= 0 || ahead > BLOCK_LOOK) continue;
      const side = rel.dot(rightV);
      const lateral = side - this.offset;
      if (Math.abs(this.dodge ? lateral : side) < STOP_SIDE) stopDist = Math.min(stopDist, ahead);
      if (ahead < 25 && Math.abs(lateral) < 3 && ahead < blockDist) {
        blockDist = ahead;
        blockSide = lateral >= 0 ? -1 : 1;
      }
    }
    // Швидкість зближення з перешкодою на курсі (за зміною відстані, згладжена).
    if (Number.isFinite(stopDist) && Number.isFinite(this.prevBlock) && dt > 0) {
      const c = (this.prevBlock - stopDist) / dt;
      if (Math.abs(c) < 60) this.closing += (c - this.closing) * Math.min(1, dt * 4);
    } else this.closing = speedKmh / 3.6;
    this.prevBlock = stopDist;
    const wantOffset = (this.dodge && blockDist < 25 ? this.lane + blockSide * 3.2 : this.lane) + (this.passing > 0 ? Math.min(PASS_SHIFT, Math.max(0, (here.wallRight ?? Infinity) - PASS_EDGE)) : 0);
    this.offset += THREE.MathUtils.clamp(wantOffset - this.offset, -2 * dt, 2 * dt);
    target.addScaledVector(rightV, this.offset);
    const far = this.net.advance(n.line, n.seg, n.t, 12 + speedKmh * 0.6, choose);
    const to = target.clone().sub(pos).setY(0);
    const angle = Math.atan2(to.dot(rightV), to.dot(forward));
    if (this.kinematicBase > 0) {
      const delta = Math.atan((2 * this.kinematicBase * Math.sin(angle)) / Math.max(4, to.length()));
      s.steer = THREE.MathUtils.clamp(this.steerFor ? this.steerFor(delta) : delta / (Math.PI / 4), -1, 1);
    } else s.steer = THREE.MathUtils.clamp(angle * 2.2, -1, 1);
    // Кривизна попереду → зниження швидкості.
    const toFar = far.clone().sub(pos).setY(0).normalize();
    const bend = 1 - Math.max(0, toFar.dot(forward));
    let want = this.cruise * (1 - Math.min(1 - this.bendFloor, bend * this.bendGain));
    if (this.passing > 0 && slow) want = Math.min(want, PASS_KMH);
    // Точка зупинки попереду на осі: доповзти й стати.
    let halted = false;
    if (this.halt) {
      const rel = this.halt.clone().sub(pos).setY(0);
      const ahead = rel.dot(flat);
      if (ahead < HALT_LOOK && Math.abs(rel.dot(rightV)) < HALT_SIDE && ahead > -HALT_SIDE) {
        const left = ahead - HALT_AT;
        if (left <= 0) halted = true;
        else want = Math.min(want, Math.max(3, 3.6 * Math.sqrt(2 * HALT_DECEL * left)));
      }
    }
    s.throttle = speedKmh < want ? Math.min(1, (want - speedKmh) / 10 + 0.3) : 0;
    s.brake = speedKmh > want + 8 ? Math.min(1, (speedKmh - want) / 20) : 0;
    s.handbrake = false;
    // Перешкода попереду (порт): гальмувати за швидкістю зближення, щоб стати за STOP_GAP м (сповільнення до
    // BLOCK_DECEL); ближче STOP_GAP — стоїть на ручному (утримання педалі на місці вмикає задній хід). Раніше гальмо
    // 0,6 лише ближче 9 м і відпускалося нижче 8 км/год: бот на ходу чи «доповзаючи» вʼїжджав у гравця, що стоїть.
    const v = speedKmh / 3.6;
    const room = stopDist - (this.passing > 0 && slow ? PASS_GAP : STOP_GAP);
    if (room < 0 || halted) {
      s.throttle = 0;
      s.brake = v > 0.5 ? 1 : 0;
      s.handbrake = v <= 0.5;
    } else if (this.closing > 0.5 && room < (this.closing * this.closing) / (2 * BLOCK_DECEL) + 4) {
      s.throttle = 0;
      s.brake = Math.min(1, Math.max(0.3, (this.closing * this.closing) / (2 * Math.max(1, room)) / BLOCK_DECEL));
    }
    return s;
  }
}
