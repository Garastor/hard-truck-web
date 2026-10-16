/** Водій трафіку HT2 (king.exe 0x4d6510): крива, лідер, обʼїзд, смуга перед поворотом — на синтетичних дорогах. */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RoadLine } from '@ht2/world/roads';
import { newMover, step, type Obstacle } from '@ht2/traffic/driver';

/** Дорога з n смуг одного напрямку за точками осі (смуги — праворуч, по 3 м). */
function road(axis: THREE.Vector3[], lanes: number, id: number): RoadLine[] {
  const out: RoadLine[] = [];
  for (let k = 0; k < lanes; k++) {
    const pts = axis.map((p, i) => {
      const a = axis[Math.max(0, i - 1)];
      const b = axis[Math.min(axis.length - 1, i + 1)];
      const d = b.clone().sub(a).setY(0).normalize();
      return p.clone().addScaledVector(new THREE.Vector3(-d.z, 0, d.x), (k + 0.5) * 3);
    });
    out.push({ name: `r${id}:${k}`, pts, next: [], width: lanes * 6, region: 'x', road: id, lane: k, lanes, laneWidth: 3, flags: 0, siblings: out });
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
