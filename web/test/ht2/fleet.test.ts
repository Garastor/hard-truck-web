/**
 * Далекобійники світу HT2 (traffic/fleet.ts, king.exe aitruck 50): абстрактний рух мережею доріг за рейсом —
 * доїжджає до місця складу, вантажиться, везе, розвантажується й бере наступний рейс без фізики; перехід у машину
 * й назад (place) і збереження кар'єри (snapshot/restore) не губить рейсу й вантажу.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads } from '@ht2/world/roads';
import { findStores, type Goods } from '@ht2/career/economy';
import { Freight, type FreightCapacity } from '@ht2/traffic/freight';
import { Fleet, type FleetMember } from '@ht2/traffic/fleet';
import { HT2_DIR } from '../gameDirs';

const bread: Goods = { id: 'BREAD', name: 'Хліб', mass: 10, volume: 0.02, price: 10, ratio: 0.8, durability: 0.5, illegal: false, forMafia: false, trucks: true, fuel: false, cars: false, guilt: 0 };
const cap: FreightCapacity = { mass: 20000, volume: 80, tanker: false, trailer: true };

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe.skipIf(!has)('HT2: далекобійники світу (абстрактний рух)', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);
  const stores = findStores(regions);
  let seed = 11;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  // Два склади (ap ↔ am, ≈ 3 км мережею): рейси туди й назад.
  const two = [stores.find((s) => s.region === 'ap')!, stores.find((s) => s.region === 'am')!];
  const freight = new Freight(roads, two, [bread], rnd);
  const fleet = () => new Fleet(roads, freight, () => cap, rnd);

  /** Поставити водія на найближчу до точки лінію. */
  const at = (f: Fleet, p: THREE.Vector3): FleetMember => {
    const m = f.add('ВИТАЛИЙ', 'Volvo', 0, null)!;
    f.place(m, p);
    // Порожній — до місця з замовленням того самого складу (startJob дав би половині вже вантаж).
    f.setJob(m, f.freight!.sendEmpty(p, cap));
    return m;
  };

  it('абстрактний водій доїжджає до місця, вантажиться, везе й розвантажується, бере наступні рейси', () => {
    const f = fleet();
    const m = at(f, f.freight!.dock(two[0], 0)!);
    const log: { phase: string; cargo: number; d: number; t: number }[] = [];
    const dt = 0.5;
    let t = 0;
    for (; t < 3 * 3600 && log.length < 5; t += dt) {
      const job = m.job;
      const changed = f.tick(dt, 13.89);
      if (changed.includes(m)) {
        const g = job!.goal!;
        const p = f.at(m).pos;
        log.push({ phase: job!.phase, cargo: m.cargo, d: Math.hypot(g.x - p.x, g.z - p.z), t });
      }
    }
    // Вантаж — на місці з замовленням, розвантаження — на місці 00 іншого складу; і так по колу.
    expect(log.length).toBe(5);
    expect(log.map((e) => e.phase)).toEqual(['load', 'deliver', 'load', 'deliver', 'load']);
    for (const e of log) expect(e.d).toBeLessThan(5);
    expect(log[0].cargo).toBeGreaterThan(0.8 * cap.mass);
    expect(log[1].cargo).toBe(0);
    expect(log[2].cargo).toBeGreaterThan(0);
    // Рейс ap → am ≈ 3 км на 13,89 м/с — кілька хвилин, а не годину.
    expect(log[1].t - log[0].t).toBeLessThan(900);
  });

  it('стоїть паузу 1 с на місці, далі їде', () => {
    const f = fleet();
    const m = at(f, f.freight!.dock(two[0], 0)!);
    for (let i = 0; i < 20000 && !f.tick(0.1, 13.89).includes(m); i++);
    const p0 = f.at(m).pos;
    f.tick(0.5, 13.89);
    expect(f.at(m).pos.distanceTo(p0)).toBeLessThan(0.01);
    for (let i = 0; i < 20; i++) f.tick(0.1, 13.89);
    expect(f.at(m).pos.distanceTo(p0)).toBeGreaterThan(5);
  });

  it('машина й назад: поки машина — абстрактно не рухається; place повертає позицію, рейс і вантаж ті самі', () => {
    const f = fleet();
    const m = at(f, f.freight!.dock(two[0], 0)!);
    for (let i = 0; i < 20000 && !f.tick(0.1, 13.89).includes(m); i++);
    for (let i = 0; i < 40; i++) f.tick(0.1, 13.89);
    expect(m.job!.phase).toBe('deliver');
    const job = m.job;
    const cargo = m.cargo;
    // «Машина»: Truckers.materialize ставить physical — абстрактний рух і рейс стоять (рейс веде машина).
    m.physical = true;
    const { pos, forward } = f.at(m);
    f.tick(5, 13.89);
    expect(f.at(m).pos.distanceTo(pos)).toBeLessThan(0.01);
    // Машина проїхала 200 м своєю смугою (точка на 1 м убік) — знову абстрактна там само.
    const s0 = m.s;
    const line0 = m.line;
    f.move(m, 200);
    const there = f.at(m);
    m.line = line0;
    m.s = s0;
    m.physical = false;
    f.place(m, there.pos.clone().add(new THREE.Vector3(-there.forward.z, 0, there.forward.x)), there.forward);
    expect(f.at(m).pos.distanceTo(there.pos)).toBeLessThan(1.5);
    expect(m.job).toBe(job);
    expect(m.cargo).toBe(cargo);
    expect(forward.length()).toBeCloseTo(1);
  });

  it('збереження кар\'єри: snapshot → restore — та сама лінія, рейс (склад, місце, товар) і вантаж', () => {
    const f = fleet();
    const m = at(f, f.freight!.dock(two[0], 0)!);
    for (let i = 0; i < 20000 && !f.tick(0.1, 13.89).includes(m); i++);
    for (let i = 0; i < 40; i++) f.tick(0.1, 13.89);
    const saved = JSON.parse(JSON.stringify(f.snapshot()));
    const g = fleet();
    g.restore(saved, []);
    const r = g.members[0];
    expect(r.name).toBe('ВИТАЛИЙ');
    expect(r.line).toBe(m.line);
    expect(r.s).toBeCloseTo(m.s, 0);
    expect(r.cargo).toBe(m.cargo);
    expect(r.job!.phase).toBe(m.job!.phase);
    expect(r.job!.store).toBe(m.job!.store);
    expect(r.job!.place).toBe(m.job!.place);
    expect(r.job!.order!.goods).toBe(bread);
    expect(r.job!.goal!.distanceTo(m.job!.goal!)).toBeLessThan(0.01);
  });

  it('50 водіїв на випадкових дорогах: за 10 хв кожен має рейс і ніхто не застряг у тупику', () => {
    const f = new Fleet(roads, new Freight(roads, stores, [bread], rnd), () => cap, rnd);
    const lines = f.startLines();
    for (let i = 0; i < 50; i++) f.add(`В${i}`, 'Volvo', 0, null, undefined, 0, lines);
    const start = f.members.map((m) => f.at(m).pos);
    const moved = new Array(50).fill(0);
    let events = 0;
    for (let t = 0; t < 600; t += 1) {
      events += f.tick(1, 13.89).length;
      f.members.forEach((m, i) => (moved[i] = Math.max(moved[i], f.at(m).pos.distanceTo(start[i]))));
    }
    expect(f.members.every((m) => m.job)).toBe(true);
    // Хтось за 10 хв устиг завантажитись чи розвантажитись; майже всі відʼїхали далеко від старту.
    expect(events).toBeGreaterThan(0);
    expect(moved.filter((d) => d > 300).length).toBeGreaterThan(40);
  });

  it('суперник: зсув уздовж дороги вперед і назад міняє «лишилось» на зсув; затриманий стоїть; швидкість — своя', () => {
    const f = fleet();
    const order = { goods: bread, units: 10, from: two[0].id, to: two[1].id, distance: 3000, pay: 100, value: 100, deadline: 1e5, urgent: false };
    const m = at(f, f.freight!.dock(two[0], 0)!);
    const job = f.freight!.sendLoaded(order)!;
    f.setJob(m, job);
    // Вийти з бази на дорогу, щоб зсув назад не впирався в початок мережі.
    f.move(m, 400);
    const base = f.left(m)!;
    expect(base).toBeGreaterThan(1000);
    const line = m.line;
    const s0 = m.s;
    f.shift(m, 300);
    expect(base - f.left(m)!).toBeCloseTo(300, -1);
    m.line = line;
    m.s = s0;
    f.shift(m, -300);
    expect(f.left(m)! - base).toBeGreaterThan(250);
    expect(f.left(m)! - base).toBeLessThan(350);
    m.line = line;
    m.s = s0;
    m.rival = { job, slow: 1, delay: 4 };
    f.tick(4, 20);
    expect(f.left(m)).toBeCloseTo(base, 3);
    f.tick(2, (x) => (x === m ? 10 : 20));
    expect(base - f.left(m)!).toBeCloseTo(20, 0);
  });
});
