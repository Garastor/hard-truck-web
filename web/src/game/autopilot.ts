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

export class AutoPilot {
  readonly state: ControlState = { steer: 0, throttle: 0, brake: 0, handbrake: false };
  /** Бажана крейсерська швидкість, км/год. */
  cruise = 60;
  private stuck = 0;
  private reversing = 0;

  constructor(private readonly net: WayNet) {}

  update(pos: THREE.Vector3, forward: THREE.Vector3, speedKmh: number, dt = 1 / 60): ControlState {
    const s = this.state;
    // Застряг (газ є, швидкості немає) → здати назад з протилежним кермом.
    if (this.reversing > 0) {
      this.reversing -= dt;
      s.throttle = 0;
      s.brake = 1;
      return s;
    }
    if (s.throttle > 0.5 && speedKmh < 2) this.stuck += dt;
    else this.stuck = 0;
    if (this.stuck > 1.5) {
      this.stuck = 0;
      this.reversing = 1.6;
      s.steer = -s.steer;
    }
    const n = this.net.nearest(pos, forward);
    if (!n) {
      s.throttle = 0;
      s.brake = 1;
      return s;
    }
    const look = 5 + speedKmh * 0.18;
    const target = this.net.advance(n.line, n.seg, n.t, look);
    const far = this.net.advance(n.line, n.seg, n.t, 12 + speedKmh * 0.6);
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    const to = target.clone().sub(pos).setY(0);
    const angle = Math.atan2(to.dot(right), to.dot(forward));
    s.steer = THREE.MathUtils.clamp(angle * 2.2, -1, 1);
    // Кривизна попереду → зниження швидкості.
    const toFar = far.clone().sub(pos).setY(0).normalize();
    const bend = 1 - Math.max(0, toFar.dot(forward));
    const want = this.cruise * (1 - Math.min(0.7, bend * 2.2));
    s.throttle = speedKmh < want ? Math.min(1, (want - speedKmh) / 10 + 0.3) : 0;
    s.brake = speedKmh > want + 8 ? Math.min(1, (speedKmh - want) / 20) : 0;
    s.handbrake = false;
    return s;
  }
}
