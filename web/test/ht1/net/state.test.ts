import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FIRST_RIVAL, FLAG_BRAKE, FLAG_LIGHTS, FleetMixer, RemoteTrack, emptyState, packFleet, packState, unpackFleet, unpackState, type TruckState } from '../../../src/games/ht1/net/state';

function state(time: number, x: number, vx: number): TruckState {
  const s = emptyState();
  s.time = time;
  s.pos.set(x, 2, -5);
  s.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), time);
  s.vel.set(vx, 0, 0);
  s.steer = 0.1;
  s.rpm = 1500;
  s.flags = FLAG_LIGHTS;
  return s;
}

describe('стан машини в мережі', () => {
  it('пакет 62 байти, розбирається без втрат (float32)', () => {
    const s = state(12.345, 100.5, 20);
    s.flags = FLAG_LIGHTS | FLAG_BRAKE;
    const buf = packState(s);
    expect(buf.byteLength).toBe(62);
    const back = unpackState(buf)!;
    expect(back.time).toBe(12.345);
    expect(back.pos.x).toBeCloseTo(100.5, 4);
    expect(back.quat.angleTo(s.quat)).toBeLessThan(1e-4);
    expect(back.vel.x).toBeCloseTo(20, 4);
    expect(back.flags).toBe(FLAG_LIGHTS | FLAG_BRAKE);
  });

  it('чужий пакет відкидається', () => {
    expect(unpackState(new ArrayBuffer(10))).toBeNull();
    const buf = packState(state(1, 0, 0));
    new DataView(buf).setUint8(0, 9);
    expect(unpackState(buf)).toBeNull();
  });

  it('показ — із запізненням 0,1 с, між пакетами плавно, далі — коротко вперед за швидкістю', () => {
    const tr = new RemoteTrack();
    // Відправник рівномірно їде 20 м/с; годинник відправника на 50 с позаду, доставка 20 мс.
    for (let i = 0; i <= 10; i++) tr.push(state(i / 30, (20 * i) / 30, 20), 50 + i / 30 + 0.02);
    const out = emptyState();
    // Місцевий час останнього пакета: показуємо стан на 0,1 с раніше за останній.
    const now = 50 + 10 / 30 + 0.02;
    tr.sample(now, out);
    expect(out.pos.x).toBeCloseTo(20 * (10 / 30 - 0.1), 3);
    // Пакети не приходять — уперед за швидкістю не більше ніж на 0,3 с.
    tr.sample(now + 2, out);
    expect(out.pos.x).toBeCloseTo(20 * (10 / 30 + 0.3), 3);
  });

  it('пакет кількох машин: номери, час кожної й стани без втрат, 58 байтів на машину', () => {
    const a = state(3.5, 10, 1);
    const b = state(1234.25, -20, 2);
    b.flags = FLAG_BRAKE;
    const buf = packFleet([{ id: 1, s: a }, { id: FIRST_RIVAL + 2, s: b }]);
    expect(buf.byteLength).toBe(2 + 2 * 58);
    const cars = unpackFleet(buf)!;
    expect(cars.map((c) => c.id)).toEqual([1, FIRST_RIVAL + 2]);
    expect(cars[1].s.pos.x).toBeCloseTo(-20, 4);
    expect(cars[1].s.flags).toBe(FLAG_BRAKE);
    expect(cars.map((c) => c.s.time)).toEqual([3.5, 1234.25]);
    expect(unpackFleet(buf.slice(0, 30))).toBeNull();
  });

  it('змішувач господаря: кожному гостю — один пакет з оновленими машинами, без його власної', () => {
    const mix = new FleetMixer();
    mix.add(packFleet([{ id: 0, s: state(1, 0, 0) }, { id: FIRST_RIVAL, s: state(1, 5, 0) }]));
    mix.add(packFleet([{ id: 1, s: state(70, 10, 0) }]));
    mix.add(packFleet([{ id: 2, s: state(500, 20, 0) }]));
    // Запізнілий пакет гостя 1 не перезаписує новіший.
    mix.add(packFleet([{ id: 1, s: state(69, 99, 0) }]));
    const got = new Map<number, number[]>();
    mix.flush([1, 2], (to, d) => got.set(to, unpackFleet(d)!.map((c) => c.id)));
    expect(got.get(1)).toEqual([0, FIRST_RIVAL, 2]);
    expect(got.get(2)).toEqual([0, FIRST_RIVAL, 1]);
    // Нічого нового — нічого не шлемо; оновилася одна машина — лише вона.
    got.clear();
    mix.flush([1, 2], (to, d) => got.set(to, unpackFleet(d)!.map((c) => c.id)));
    expect(got.size).toBe(0);
    mix.add(packFleet([{ id: 1, s: state(71, 11, 0) }]));
    mix.flush([1, 2], (to, d) => got.set(to, unpackFleet(d)!.map((c) => c.s.pos.x)));
    expect([...got]).toEqual([[2, [11]]]);
  });

  it('показ зберігає копії станів: розбір пакетів повторно використовує один буфер', () => {
    const tr = new RemoteTrack();
    const s = state(0, 0, 10);
    tr.push(s, 50);
    s.time = 0.1;
    s.pos.x = 1;
    tr.push(s, 50.1);
    const out = emptyState();
    // Між пакетами (час відправника 0,05) — посередині, а не обидва стани = останній.
    tr.sample(50.1 + 0.1 - 0.05, out);
    expect(out.pos.x).toBeGreaterThan(0.3);
    expect(out.pos.x).toBeLessThan(0.7);
  });

  it('запізнілий пакет не ламає порядок', () => {
    const tr = new RemoteTrack();
    tr.push(state(1, 10, 0), 101);
    tr.push(state(0.5, 5, 0), 101.1);
    const out = emptyState();
    expect(tr.sample(102, out)!.pos.x).toBe(10);
  });
});
