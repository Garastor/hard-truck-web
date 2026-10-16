/** Водій трафіку HT2 (king.exe 0x4d6510): крива, лідер, обʼїзд, смуга перед поворотом — на синтетичних дорогах. */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RoadLine } from '@ht2/world/roads';
import { newMover, step, type Mover, type Net, type Obstacle } from '@ht2/traffic/driver';

/** Дорога з n смуг одного напрямку за точками осі (смуги — праворуч, по 3 м). */
function road(axis: THREE.Vector3[], lanes: number, id: number, nodes: [number, number] = [-1, -1]): RoadLine[] {
  const out: RoadLine[] = [];
  for (let k = 0; k < lanes; k++) {
    const pts = axis.map((p, i) => {
      const a = axis[Math.max(0, i - 1)];
      const b = axis[Math.min(axis.length - 1, i + 1)];
      const d = b.clone().sub(a).setY(0).normalize();
      return p.clone().addScaledVector(new THREE.Vector3(-d.z, 0, d.x), (k + 0.5) * 3);
    });
    out.push({ name: `r${id}:${k}`, pts, next: [], width: lanes * 6, region: 'x', road: id, lane: k, lanes, laneWidth: 3, flags: 0, cls: 1, length: 0, siblings: out, startNode: nodes[0], endNode: nodes[1] });
  }
  return out;
}

const straight = (len: number, step = 10) => Array.from({ length: len / step + 1 }, (_, i) => new THREE.Vector3(0, 0, -i * step));

function run(m: ReturnType<typeof newMover>, sec: number, obstacles: Obstacle[] = [], each?: () => void): void {
  for (let i = 0; i < sec * 30; i++) {
    step(m, 1 / 30, obstacles);
    each?.();
  }
}

/** Кілька машин разом: перешкоди — одна для одної (з поточними швидкостями). */
function runAll(ms: Mover[], sec: number, net: Net | null = null, extra: Obstacle[] = [], each?: () => void): void {
  for (let i = 0; i < sec * 30; i++) {
    const obs: Obstacle[] = [...ms.map((x) => ({ pos: x.pos, vel: x.heading.clone().multiplyScalar(x.speed), half: x.halfLen, mover: x })), ...extra];
    for (const x of ms) step(x, 1 / 30, obs, net);
    each?.();
  }
}

/** Відстань уздовж −Z (напрямок доріг straight). */
const along = (m: Mover) => -m.pos.z;

describe('HT2: водій трафіку', () => {
  it('на прямій тримає крейсерську', () => {
    const [l] = road(straight(2000), 1, 0);
    const m = newMover(l, 0, 0, 20, 2);
    run(m, 10);
    expect(m.speed).toBeCloseTo(20, 1);
  });

  it('перед крутим поворотом пригальмовує (не нижче 8 м/с)', () => {
    // Пряма 300 м, далі дуга радіусом 15 м на 90° праворуч.
    const axis = straight(300);
    const c = new THREE.Vector3(15, 0, -300);
    for (let a = 1; a <= 9; a++) {
      const t = (a / 9) * (Math.PI / 2);
      axis.push(new THREE.Vector3(c.x - 15 * Math.cos(t), 0, c.z - 15 * Math.sin(t)));
    }
    for (let i = 1; i <= 20; i++) axis.push(new THREE.Vector3(15 + i * 10, 0, -315));
    const [l] = road(axis, 1, 0);
    const m = newMover(l, 0, 0, 20, 2);
    let min = Infinity;
    run(m, 25, [], () => (min = Math.min(min, m.speed)));
    expect(min).toBeLessThan(12);
    expect(min).toBeGreaterThanOrEqual(7.5);
  });

  it('за машиною, що стоїть, зупиняється на дистанції', () => {
    const lanes = road(straight(1000), 1, 0);
    const m = newMover(lanes[0], 0, 0, 20, 2);
    // Машина трафіку, що стоїть у черзі (її не обʼїжджають).
    const queued = newMover(lanes[0], 30, 0, 0, 2);
    const stopped: Obstacle = { pos: lanes[0].pts[30].clone(), vel: new THREE.Vector3(), half: 2, mover: queued };
    run(m, 30, [stopped]);
    const gap = stopped.pos.distanceTo(m.pos) - 4;
    expect(m.speed).toBeLessThan(0.1);
    expect(gap).toBeGreaterThan(2);
    expect(gap).toBeLessThan(15);
  });

  it('за повільнішим лідером їде з його швидкістю', () => {
    const lanes = road(straight(3000), 1, 0);
    const m = newMover(lanes[0], 0, 0, 20, 2);
    const lead: Obstacle = { pos: lanes[0].pts[10].clone(), vel: new THREE.Vector3(0, 0, -10), half: 2 };
    run(m, 40, [lead], () => lead.pos.z -= 10 / 30);
    expect(m.speed).toBeGreaterThan(8.5);
    expect(m.speed).toBeLessThan(11.5);
    expect(lead.pos.distanceTo(m.pos)).toBeGreaterThan(10);
  });

  it('машину, що стоїть, обʼїжджає сусідньою смугою', () => {
    const lanes = road(straight(1000), 2, 0);
    const m = newMover(lanes[1], 0, 0, 20, 2);
    m.wantLane = 1;
    const stopped: Obstacle = { pos: lanes[1].pts[20].clone(), vel: new THREE.Vector3(), half: 2 };
    let passed = false;
    run(m, 20, [stopped], () => (passed ||= m.pos.z < stopped.pos.z - 10));
    expect(passed).toBe(true);
  });

  it('гравця, що стоїть, обʼїжджає зустрічною; з бітами 4/8 — узбіччям', () => {
    for (const flags of [0, 4]) {
      const lanes = road(straight(1000), 1, 0);
      lanes[0].flags = flags;
      const m = newMover(lanes[0], 0, 0, 20, 2);
      const player: Obstacle = { pos: lanes[0].pts[20].clone(), vel: new THREE.Vector3(), half: 2.5 };
      let passed = false;
      let side = 0;
      run(m, 40, [player], () => {
        if (!passed && m.pos.z < player.pos.z - 1) {
          passed = true;
          side = m.pos.x - player.pos.x;
        }
      });
      expect(passed).toBe(true);
      // Без бітів — ліворуч (зустрічна), з бітами — праворуч (узбіччя).
      if (flags) expect(side).toBeGreaterThan(2);
      else expect(side).toBeLessThan(-2);
      // Після обʼїзду — назад у свою смугу.
      expect(Math.abs(m.lat)).toBeLessThan(0.5);
    }
  });

  it('зустрічна зайнята — чекає', () => {
    const lanes = road(straight(1000), 1, 0);
    const m = newMover(lanes[0], 0, 0, 20, 2);
    const player: Obstacle = { pos: lanes[0].pts[20].clone(), vel: new THREE.Vector3(), half: 2.5 };
    // Зустрічна машина стоїть на зустрічній смузі за 40 м попереду гравця.
    const oncoming: Obstacle = { pos: new THREE.Vector3(-1.5, 0, -240), vel: new THREE.Vector3(), half: 2 };
    lanes[0].flags = 0;
    run(m, 20, [player, oncoming]);
    // Узбіччя (праворуч) вільне — обʼїзд туди, на зустрічну не виїжджає.
    expect(m.pos.x).toBeGreaterThan(-0.5);
  });

  it('повільнішого обганяє лівою смугою й повертається праворуч', () => {
    const lanes = road(straight(3000), 2, 0);
    const slow = newMover(lanes[1], 6, 0, 10, 2);
    // Повільна лишається у своїй смузі (інакше з імовірністю 25 % сама займає ліву — обганяти нема де).
    slow.wantLane = 1;
    const m = newMover(lanes[1], 0, 0, 20, 2);
    m.wantLane = 1;
    let left = false;
    runAll([slow, m], 40, null, [], () => (left ||= m.line.lane === 0));
    expect(left).toBe(true);
    expect(along(m)).toBeGreaterThan(along(slow) + 10);
    expect(m.line.lane).toBe(1);
  });

  it('на дорозі з однією смугою обганяє по зустрічній; суцільна чи зустрічний — ні', () => {
    for (const [flags, oncoming, expectPass] of [[0, false, true], [4, false, false], [0, true, false]] as const) {
      const lanes = road(straight(4000), 1, 0);
      lanes[0].flags = flags;
      const slow = newMover(lanes[0], 6, 0, 10, 2);
      const m = newMover(lanes[0], 0, 0, 20, 2);
      // Зустрічний стоїть на зустрічній смузі попереду (видно на весь маневр).
      const extra: Obstacle[] = oncoming ? [{ pos: new THREE.Vector3(-1.5, 0, -180), vel: new THREE.Vector3(), half: 2 }] : [];
      let minGap = Infinity;
      runAll([slow, m], 12, null, extra, () => (minGap = Math.min(minGap, m.pos.distanceTo(slow.pos))));
      expect(along(m) > along(slow), `flags ${flags}, зустрічний ${oncoming}`).toBe(expectPass);
      expect(minGap).toBeGreaterThan(2.5);
      if (expectPass) expect(Math.abs(m.lat)).toBeLessThan(0.5);
    }
  });

  it('на перехресті пропускає того, хто праворуч', () => {
    // Схід (+x) і північ (−z) сходяться у вузлі 0 в (0, 0, 0); праворуч від того, хто їде на схід, — +z.
    const net: Net = { isJunction: (n) => n === 0 };
    const east = road(Array.from({ length: 11 }, (_, i) => new THREE.Vector3(-100 + i * 10, 0, 0)), 1, 0, [-1, 0]);
    const east2 = road(Array.from({ length: 11 }, (_, i) => new THREE.Vector3(i * 10, 0, 0)), 1, 1, [0, -1]);
    const north = road(Array.from({ length: 11 }, (_, i) => new THREE.Vector3(0, 0, 100 - i * 10)), 1, 2, [-1, 0]);
    const north2 = road(Array.from({ length: 11 }, (_, i) => new THREE.Vector3(0, 0, -i * 10)), 1, 3, [0, -1]);
    east[0].next.push(east2[0]);
    north[0].next.push(north2[0]);
    const a = newMover(east[0], 0, 0, 15, 2);
    const b = newMover(north[0], 0, 0, 15, 2);
    let minGap = Infinity;
    let firstThrough: string | null = null;
    runAll([a, b], 25, net, [], () => {
      minGap = Math.min(minGap, a.pos.distanceTo(b.pos));
      if (!firstThrough && a.line.road === 1) firstThrough = 'схід';
      if (!firstThrough && b.line.road === 3) firstThrough = 'північ';
    });
    // b підʼїжджає з +z — праворуч від a: першим проїжджає b.
    expect(firstThrough).toBe('північ');
    expect(minGap).toBeGreaterThan(4);
    expect(a.line.road).toBe(1);
  });

  it('перед правим поворотом перестроюється в крайню праву смугу', () => {
    const a = road(straight(400), 2, 0);
    const b = road([0, 1, 2, 3, 4, 5].map((i) => new THREE.Vector3(i * 20, 0, -400)), 2, 1);
    for (const l of a) l.next.push(b[l.lane]);
    const m = newMover(a[0], 0, 0, 20, 2);
    expect(m.plan).toBe(1);
    expect(m.wantLane).toBe(1);
    run(m, 18);
    expect(m.line.lane).toBe(1);
  });
});
