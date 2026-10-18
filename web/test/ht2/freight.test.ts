/**
 * Рейси ботів-далекобійників HT2 (traffic/freight.ts, king.exe sendForClosestOrder 0x4185d0, actOnArrival 0x419cb0):
 * цикл «вантажитись → везти → розвантажитись» на синтетиці й проїзд автопілота реальною мережею до місця складу.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads } from '@ht2/world/roads';
import { findStores, type Goods, type Store } from '@ht2/career/economy';
import { toThree } from '@ht2/world/world';
import { Freight, LOAD_PAUSE, type FreightCapacity, type FreightJob } from '@ht2/traffic/freight';
import { AutoPilot } from '@ht2/engine/vehicle/autopilot';
import { HT2_DIR } from '../gameDirs';

const bread: Goods = { id: 'BREAD', name: 'Хліб', mass: 10, volume: 0.02, price: 10, ratio: 0.8, durability: 0.5, illegal: false, forMafia: false, trucks: true, fuel: false, cars: false, guilt: 0 };
const cap: FreightCapacity = { mass: 20000, volume: 80, tanker: false, trailer: true };

describe('HT2: рейс бота (синтетика)', () => {
  // Без мережі доріг: склади з місцями, маршрут не потрібен (reachable — порожня мережа дає false, тож підмінюємо).
  const a: Store = { id: 1, region: 'x', town: 'А', goods: [], docks: [[0, 0, 0], [10, 0, 0], [20, 0, 0]], places: [0, 1, 2], center: [10, 0, 0] };
  const b: Store = { id: 2, region: 'x', town: 'Б', goods: [], docks: [[5000, 0, 0], [5010, 0, 0], [5020, 0, 0]], places: [0, 1, 2], center: [5010, 0, 0] };
  const f = new Freight({ lines: [], deadEnd: () => false } as unknown as Ht2Roads, [a, b], [bread], () => 0.2);
  (f as unknown as { reachable: () => boolean }).reachable = () => true;

  it('порожній — на місце з замовленням найближчого складу; прибув — вантаж, пауза, до місця 00 призначення', () => {
    const job = f.sendEmpty(toThree(100, 0, 0), cap);
    expect(job.phase).toBe('load');
    expect(job.store).toBe(a);
    expect(job.place).toBeGreaterThan(0);
    expect(job.order!.to).toBe(2);
    // Їде — нічого; стоїть біля місця — вантаж 0,85 від місткості.
    expect(f.step(job, job.goal!.clone().add(new THREE.Vector3(20, 0, 0)), 40, 0.1, cap).event).toBeNull();
    const at = job.goal!.clone().add(new THREE.Vector3(1, 0, 0));
    const loaded = f.step(job, at, 0, 0.1, cap);
    expect(loaded.event!.cargo).toBeGreaterThan(0.8 * cap.mass);
    expect(loaded.event!.cargo).toBeLessThanOrEqual(cap.mass);
    // Пауза 1 с — стоїть, потім до місця 00 складу Б.
    let j: FreightJob = loaded.job;
    for (let t = 0; t < LOAD_PAUSE - 0.2; t += 0.1) j = f.step(j, at, 0, 0.1, cap).job;
    expect(j).toBe(job);
    j = f.step(j, at, 0, 0.3, cap).job;
    expect(j.phase).toBe('deliver');
    expect(j.store).toBe(b);
    expect(j.place).toBe(0);
    // Розвантажився — вантаж 0, після паузи — знову порожній до найближчого (того самого) складу.
    const done = f.step(j, j.goal!, 0, 0.1, cap);
    expect(done.event!.cargo).toBe(0);
    const next = f.step(done.job, j.goal!, 0, LOAD_PAUSE + 0.1, cap).job;
    expect(next.phase).toBe('load');
    expect(next.store).toBe(b);
  });

  it('у черзі біля місця (стоїть ближче 30 м понад 10 с) — вважається, що прибув', () => {
    const job = f.sendEmpty(toThree(0, 0, 0), cap);
    const near = job.goal!.clone().add(new THREE.Vector3(0, 0, 15));
    let ev = null;
    for (let t = 0; t < 11 && !ev; t += 0.5) ev = f.step(job, near, 0, 0.5, cap).event;
    expect(ev).not.toBeNull();
  });
});

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe.skipIf(!has)('HT2: рейс бота мережею доріг', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);
  const stores = findStores(regions);
  // Сталий випадковий ряд (LCG): той самий склад призначення щоразу.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const f = new Freight(roads, stores, [bread], rnd);

  it('до кожного місця кожного складу є маршрут (кінцеві лінії — не тупикові)', () => {
    for (const s of stores)
      for (const p of s.places!) {
        const goal = f.dock(s, p)!;
        expect((f as unknown as { reachable: (g: THREE.Vector3) => boolean }).reachable(goal), `склад ${s.id} місце ${p}`).toBe(true);
      }
  });

  /**
   * Автопілот на простій кінематичній моделі (велосипедна, база 5 м): від місця 00 складу ap (розвантажився) — до місця
   * з замовленням того самого складу, стоїть, далі до складу призначення (am).
   */
  it('автопілот доїжджає до місця складу, стоїть і їде далі', () => {
    const home = stores.find((s) => s.region === 'ap')!;
    // Лише два склади (ap → am, ≈ 3 км мережею), щоб тест не їхав півгодини до далекого.
    const f = new Freight(roads, [home, stores.find((s) => s.region === 'am')!], [bread], rnd);
    const pos = f.dock(home, 0)!.clone();
    const at = roads.nearest(pos)!;
    const heading = at.line.pts[at.seg + 1].clone().sub(at.line.pts[at.seg]).setY(0).normalize();
    const pilot = new AutoPilot(roads);
    pilot.kinematicBase = 5;
    pilot.cruise = 50;
    let v = 0;
    let job = f.sendEmpty(pos, cap);
    expect(job.store).toBe(home);
    const apply = (j: FreightJob) => {
      pilot.choose = f.route(j) as AutoPilot['choose'];
      pilot.halt = j.goal;
    };
    apply(job);
    const events: { t: number; cargo: number; phase: string; d: number }[] = [];
    let stoodAt: number | null = null;
    const stoodPos = new THREE.Vector3();
    const dt = 1 / 30;
    for (let i = 0; i < 30 * 1800 && events.length < 2; i++) {
      const s = pilot.update(pos, heading, v * 3.6, dt);
      const delta = (s.steer * Math.PI) / 4;
      if (s.handbrake) v = 0;
      v = Math.max(0, v + (s.throttle * 2 - s.brake * 6) * dt);
      heading.applyAxisAngle(new THREE.Vector3(0, 1, 0), -(v * Math.tan(delta) * dt) / 5).normalize();
      pos.addScaledVector(heading, v * dt);
      // Висота — з лінії мережі під машиною (nearest рахує 3D-відстань).
      const under = roads.nearest(pos, heading);
      if (under) pos.y = under.line.pts[under.seg].clone().lerp(under.line.pts[under.seg + 1], under.t).y;
      const r = f.step(job, pos, v * 3.6, dt, cap);
      if (r.event) {
        events.push({ t: i * dt, cargo: r.event.cargo, phase: job.phase, d: Math.hypot(job.goal!.x - pos.x, job.goal!.z - pos.z) });
        stoodAt = i;
        stoodPos.copy(pos);
      }
      if (r.job !== job) {
        job = r.job;
        apply(job);
      }
      // Стоїть паузу на місці.
      if (stoodAt !== null && i - stoodAt < 30) expect(pos.distanceTo(stoodPos)).toBeLessThan(1);
    }
    // Навантажився біля місця (не в черзі), поїхав і розвантажився на складі призначення.
    expect(events.length).toBe(2);
    expect(events[0].phase).toBe('load');
    expect(events[0].cargo).toBeGreaterThan(0);
    expect(events[0].d).toBeLessThan(5);
    expect(events[1].phase).toBe('deliver');
    expect(events[1].cargo).toBe(0);
    expect(events[1].d).toBeLessThan(5);
  });
});
