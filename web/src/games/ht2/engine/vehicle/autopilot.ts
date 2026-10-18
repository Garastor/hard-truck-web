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
  nearest(p: THREE.Vector3, heading?: THREE.Vector3): { line: WayLine; seg: number; t: number; dist: number } | null {
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
        if (!best || dist < best.dist) best = { line, seg: i, t, dist };
      }
    }
    return best;
  }

  /** Точка на відстані `ahead` уздовж мережі від позиції (line, seg, t). */
  advance(line: WayLine, seg: number, t: number, ahead: number): THREE.Vector3 {
    let cur = line.pts[seg].clone().lerp(line.pts[seg + 1], t);
    let left = ahead;
    let l = line;
    let i = seg + 1;
    for (let guard = 0; guard < 200; guard++) {
      if (i >= l.pts.length) {
        if (!l.next.length) return cur;
        l = l.next[0];
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
/** Перешкода «на курсі» — ближче за стільки вбік від осі машини (півширини обох + запас), м. */
const STOP_SIDE = 2.6;
const STOP_GAP = 10;
const BLOCK_DECEL = 3;

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
    const n = this.net.nearest(pos, forward);
    if (!n) {
      s.throttle = 0;
      s.brake = 1;
      return s;
    }
    const look = 5 + speedKmh * 0.18;
    const target = this.net.advance(n.line, n.seg, n.t, look);
    // Машини попереду в «коридорі» → обгін зсувом убік, а якщо дуже близько — гальмуємо.
    const rightV = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    // blockDist — у коридорі обгону (зі зсувом); stopDist — там, куди машина їде (з обгоном — той самий коридор).
    let blockDist = Infinity;
    let blockSide = 0;
    let stopDist = Infinity;
    for (const o of others) {
      const rel = o.clone().sub(pos);
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
    const wantOffset = this.dodge && blockDist < 25 ? this.lane + blockSide * 3.2 : this.lane;
    this.offset += THREE.MathUtils.clamp(wantOffset - this.offset, -2 * dt, 2 * dt);
    target.addScaledVector(rightV, this.offset);
    const far = this.net.advance(n.line, n.seg, n.t, 12 + speedKmh * 0.6);
    const to = target.clone().sub(pos).setY(0);
    const angle = Math.atan2(to.dot(rightV), to.dot(forward));
    if (this.kinematicBase > 0) {
      const delta = Math.atan((2 * this.kinematicBase * Math.sin(angle)) / Math.max(4, to.length()));
      s.steer = THREE.MathUtils.clamp(this.steerFor ? this.steerFor(delta) : delta / (Math.PI / 4), -1, 1);
    } else s.steer = THREE.MathUtils.clamp(angle * 2.2, -1, 1);
    // Кривизна попереду → зниження швидкості.
    const toFar = far.clone().sub(pos).setY(0).normalize();
    const bend = 1 - Math.max(0, toFar.dot(forward));
    const want = this.cruise * (1 - Math.min(1 - this.bendFloor, bend * this.bendGain));
    s.throttle = speedKmh < want ? Math.min(1, (want - speedKmh) / 10 + 0.3) : 0;
    s.brake = speedKmh > want + 8 ? Math.min(1, (speedKmh - want) / 20) : 0;
    s.handbrake = false;
    // Перешкода попереду (порт): гальмувати за швидкістю зближення, щоб стати за STOP_GAP м (сповільнення до
    // BLOCK_DECEL); ближче STOP_GAP — стоїть на ручному (утримання педалі на місці вмикає задній хід). Раніше гальмо
    // 0,6 лише ближче 9 м і відпускалося нижче 8 км/год: бот на ходу чи «доповзаючи» вʼїжджав у гравця, що стоїть.
    const v = speedKmh / 3.6;
    const room = stopDist - STOP_GAP;
    if (room < 0) {
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
