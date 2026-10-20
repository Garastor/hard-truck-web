/** Водій трафіку HT2 (king.exe 0x4d6510): крива, лідер, обʼїзд, смуга перед поворотом — на синтетичних дорогах. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import type { RoadLine } from '@ht2/world/roads';
import { newMover, replan, step, turnSignal, type Mover, type Net, type Obstacle } from '@ht2/traffic/driver';

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

/** Детермінований Math.random (mulberry32): водій випадково вибирає дорогу й смугу — без підміни тести нестабільні. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('HT2: водій трафіку', () => {
  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(seeded(1));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('машину після ДТП (стоїть без причини) обʼїжджає зустрічною; ту, що в черзі, — ні', () => {
    for (const queued of [false, true]) {
      const lanes = road(straight(1000), 1, 0);
      const m = newMover(lanes[0], 0, 0, 20, 2);
      const wreck = newMover(lanes[0], 20, 0, 0, 2);
      Object.assign(wreck, { still: 10, queued });
      const o: Obstacle = { pos: wreck.pos.clone(), vel: new THREE.Vector3(), half: 2, mover: wreck };
      let passed = false;
      run(m, 40, [o], () => (passed ||= m.pos.z < o.pos.z - 5));
      expect(passed).toBe(!queued);
    }
  });

  it('у тупику розвертається на зустрічну смугу (порт), а не стоїть', () => {
    const [l] = road(straight(200), 1, 0);
    // Зустрічна смуга — ліворуч від осі, у зворотний бік.
    const back = straight(200).reverse().map((p) => p.clone().setX(-1.5));
    const o: RoadLine = { ...l, name: 'back', pts: back, next: [], siblings: [] };
    o.siblings.push(o);
    l.opposite = [o];
    o.opposite = [l];
    const m = newMover(l, 10, 0, 15, 2);
    run(m, 20);
    expect(m.gone).toBe(false);
    expect(m.line).toBe(o);
    expect(m.heading.z).toBeGreaterThan(0.9);
  });

  it('гравця, що виїжджає поперек смуги, помічає наперед і пропускає', () => {
    const lanes = road(straight(1000), 1, 0);
    const m = newMover(lanes[0], 0, 0, 20, 2);
    // Гравець за 18 м праворуч від смуги, 70 м уперед, їде вліво 6 м/с — у смузі за ≈ 2,6 с, коли машина за ≈ 18 м:
    // помітивши його лише тоді, вона б не встигла загальмувати.
    const player: Obstacle = { pos: new THREE.Vector3(19.5, 0, -70), vel: new THREE.Vector3(-6, 0, 0), half: 2.5 };
    let closest = Infinity;
    run(m, 15, [player], () => {
      if (player.pos.x > -10) player.pos.x -= 6 / 30;
      else player.vel.set(0, 0, 0);
      closest = Math.min(closest, Math.hypot(player.pos.x - m.pos.x, player.pos.z - m.pos.z));
    });
    expect(closest).toBeGreaterThan(5);
  });

  it('гравця, що наздоганяє ззаду, лідером не вважає — не зупиняється перед ним (повідомлення користувача)', () => {
    const [l] = road(straight(2000), 1, 0);
    const m = newMover(l, 10, 0, 7, 2);
    m.speed = 7;
    // Гравець на тій самій смузі за 30 м, 17 м/с — за 2–3 с «опиняється» перед капотом за прогнозом.
    const player: Obstacle = { pos: m.pos.clone().add(new THREE.Vector3(0, 0, 30)), vel: new THREE.Vector3(0, 0, -17), half: 2.5 };
    let minSpeed = Infinity;
    run(m, 1.6, [player], () => {
      player.pos.addScaledVector(player.vel, 1 / 30);
      minSpeed = Math.min(minSpeed, m.speed);
    });
    expect(minSpeed).toBeGreaterThan(6);
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
    // Обидві тримаються правої смуги (інакше повільна випадково зʼїжджає ліворуч і обгону немає).
    slow.wantLane = 1;
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

  it('прямо — тримається крайньої правої смуги, щойно вона вільна (порт)', () => {
    const lanes = road(straight(3000), 2, 0);
    const m = newMover(lanes[0], 0, 0, 20, 2);
    expect(m.wantLane).toBe(1);
    run(m, 15);
    expect(m.line.lane).toBe(1);
    // Права зайнята повільною машиною поруч — лишається ліворуч.
    const n = newMover(lanes[0], 0, 0, 20, 2);
    const beside: Obstacle = { pos: lanes[1].pts[0].clone(), vel: new THREE.Vector3(0, 0, -20), half: 2 };
    run(n, 3, [beside], () => beside.pos.z = n.pos.z);
    expect(n.line.lane).toBe(0);
  });

  it('на територію бази не звертає, якщо є інший шлях (порт)', () => {
    const a = road(straight(200), 1, 0);
    const base = road([0, 1, 2, 3].map((i) => new THREE.Vector3(i * 20, 0, -200)), 1, 1);
    const on = road(straight(200).map((p) => p.clone().setZ(p.z - 200)), 1, 2);
    for (const l of base) l.base = true;
    a[0].next.push(base[0], on[0]);
    for (let s = 1; s <= 20; s++) {
      vi.spyOn(Math, 'random').mockImplementation(seeded(s));
      expect(newMover(a[0], 0, 0, 20, 2).plan).toBe(2);
    }
    // Іншого шляху немає — на базу (тупик інакше).
    a[0].next.splice(1);
    expect(newMover(a[0], 0, 0, 20, 2).plan).toBe(1);
  });

  it('бот за маршрутом (route) звертає туди, куди веде маршрут, і сигналить поворот', () => {
    const a = road(straight(200), 1, 0);
    const right = road([0, 1, 2, 3, 4].map((i) => new THREE.Vector3(i * 20, 0, -200)), 1, 1);
    const ahead = road(straight(200).map((p) => p.clone().setZ(p.z - 200)), 1, 2);
    a[0].next.push(ahead[0], right[0]);
    for (let s = 1; s <= 10; s++) {
      vi.spyOn(Math, 'random').mockImplementation(seeded(s));
      const m = newMover(a[0], 0, 0, 15, 2);
      m.route = (l) => (l === a[0] ? right[0] : null);
      replan(m);
      expect(m.via).toBe(right[0]);
      let signalled = false;
      run(m, 25, [], () => (signalled ||= turnSignal(m) === 1));
      expect(m.line).toBe(right[0]);
      expect(signalled).toBe(true);
    }
  });

  it('бот за маршрутом не перестроюється в смугу, з якої шляху до цілі немає', () => {
    const a = road(straight(1000), 2, 0);
    const m = newMover(a[1], 0, 0, 20, 2);
    // Маршрут — лише з правої смуги; стоїть машина попереду: сусідня (ліва) смуга без маршруту — стоїть за нею.
    m.route = (l) => (l === a[1] ? a[1] : null);
    replan(m);
    const stopped: Obstacle = { pos: a[1].pts[20].clone(), vel: new THREE.Vector3(), half: 2, mover: Object.assign(newMover(a[1], 20, 0, 0, 2), { still: 0, queued: true }) };
    run(m, 20, [stopped]);
    expect(m.line).toBe(a[1]);
  });

  it('тягач з причепом (tail) повертається в смугу, лише коли причіп минув перешкоду', () => {
    const at = (tail: number) => {
      const lanes = road(straight(1000), 1, 0);
      const m = newMover(lanes[0], 0, 0, 20, 3);
      m.tail = tail;
      const player: Obstacle = { pos: lanes[0].pts[20].clone(), vel: new THREE.Vector3(), half: 2.5 };
      let back = Infinity;
      run(m, 40, [player], () => {
        if (back === Infinity && m.pos.z < player.pos.z && m.latGoal === 0 && m.bypass === null && m.waited === 0 && Math.abs(m.lat) > 1) back = player.pos.z - m.pos.z;
      });
      return back;
    };
    // Без причепа повертається одразу за перешкодою, з причепом 12 м — на 12 м пізніше.
    expect(at(12) - at(0)).toBeGreaterThan(10);
  });

  it('широка машина (wide): перешкода, що виступає в сусідню смугу, — не гойдається між смугами, а обʼїжджає далі', () => {
    const lanes = road(straight(1000), 2, 0);
    // Опозитна смуга (зустрічна) для обʼїзду: без бітів 4/8.
    const m = newMover(lanes[1], 0, 0, 12, 3);
    m.wide = 0.75;
    m.early = 2.5;
    // Гравець на правій смузі, зсунутий на 0,5 м ліворуч: від осі лівої смуги — 2,5 м (для легковика вільно, для широкої — ні).
    const player: Obstacle = { pos: lanes[1].pts[15].clone().add(new THREE.Vector3(-0.5, 0, 0)), vel: new THREE.Vector3(), half: 2.5 };
    let changes = 0;
    let lane = m.line.lane;
    let passedSide = 0;
    run(m, 40, [player], () => {
      if (m.line.lane !== lane) (changes++, (lane = m.line.lane));
      if (!passedSide && m.pos.z < player.pos.z - 1) passedSide = m.pos.x - player.pos.x;
    });
    expect(changes).toBeLessThanOrEqual(1);
    // Обʼїхав щонайменше на 3,4 м убік (півширини обох з запасом).
    expect(passedSide).toBeLessThan(-3.4);
  });

  it("на під'їзд заправки чи СТО не звертає, якщо є інший шлях (порт)", () => {
    const a = road(straight(200), 1, 0);
    const gas = road([0, 1, 2, 3].map((i) => new THREE.Vector3(i * 20, 0, -200)), 1, 1);
    const on = road(straight(200).map((p) => p.clone().setZ(p.z - 200)), 1, 2);
    for (const l of gas) l.station = true;
    a[0].next.push(gas[0], on[0]);
    for (let s = 1; s <= 20; s++) {
      vi.spyOn(Math, 'random').mockImplementation(seeded(s));
      expect(newMover(a[0], 0, 0, 20, 2).plan).toBe(2);
    }
  });
});
