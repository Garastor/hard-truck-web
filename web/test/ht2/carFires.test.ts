import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CarFires, shotIgnition } from '@ht2/traffic/carFires';
import type { TruckVehicle } from '@ht2/engine/vehicle/truckVehicle';

/** Машина-заглушка: позиція, курс +X, швидкість. */
function car(x: number, z = 0): TruckVehicle & { vel: THREE.Vector3 } {
  const visual = new THREE.Group();
  visual.position.set(x, 0, z);
  const vel = new THREE.Vector3();
  return { visual, vel, engineOn: true, forward: () => new THREE.Vector3(1, 0, 0), body: { linvel: () => vel } } as unknown as TruckVehicle & { vel: THREE.Vector3 };
}

function fires() {
  const log = { blows: 0, lit: new Set<TruckVehicle>() };
  const f = new CarFires({
    fire: (v, p) => (p ? log.lit.add(v) : log.lit.delete(v)),
    blow: () => log.blows++,
  });
  return { f, log };
}

describe('HT2: вогонь машин ІІ (king.exe 0x549900, 0x54e180)', () => {
  it('куля: p = g·P·0,03/(P + 0,3)', () => {
    expect(shotIgnition(0.1)).toBeCloseTo(0.0075, 6);
    expect(shotIgnition(2)).toBeCloseTo(0.0261, 4);
    expect(shotIgnition(2, 0.2)).toBeCloseTo(0.00522, 5);
  });

  it('займання — вибух один раз, через 60 с згоріло, двигун мертвий, вдруге не займається', () => {
    const { f, log } = fires();
    const a = car(0);
    const player = { v: car(500), burning: false };
    f.ignite(a);
    f.ignite(a);
    expect(log.blows).toBe(1);
    f.update(1, [a], player);
    expect(log.lit.has(a)).toBe(true);
    for (let i = 0; i < 60; i++) f.update(1, [a], player);
    expect(f.burning(a)).toBe(false);
    expect(log.lit.has(a)).toBe(false);
    expect(a.engineOn).toBe(false);
    f.ignite(a);
    expect(f.burning(a)).toBe(false);
  });

  it('поширення: ближче 3,2 м понад 5 с безперервно — і на гравця', () => {
    const { f } = fires();
    const a = car(0);
    const b = car(3);
    const far = car(20);
    const player = { v: car(0, 2.5), burning: false };
    f.ignite(a);
    let toPlayer = false;
    for (let i = 0; i < 45; i++) toPlayer = f.update(0.1, [a, b, far], player) || toPlayer;
    expect(f.burning(b)).toBe(false);
    for (let i = 0; i < 16; i++) toPlayer = f.update(0.1, [a, b, far], player) || toPlayer;
    expect(f.burning(b)).toBe(true);
    expect(toPlayer).toBe(true);
    expect(f.burning(far)).toBe(false);
  });

  it('від палаючого гравця займається сусід; машина, що зникла, гасне', () => {
    const { f, log } = fires();
    const a = car(2);
    const player = { v: car(0), burning: true };
    for (let i = 0; i < 52; i++) f.update(0.1, [a], player);
    expect(f.burning(a)).toBe(true);
    f.update(0.1, [], player);
    expect(log.lit.size).toBe(0);
  });

  it('удар об нерухоме понад 35 м/с — займання; поруч машина — ні', () => {
    const { f } = fires();
    const a = car(0);
    const b = car(100);
    const c = car(105);
    const player = { v: car(500), burning: false };
    a.vel.set(30, 0, 0);
    b.vel.set(30, 0, 0);
    c.vel.set(0, 0, 0);
    f.update(1 / 60, [a, b, c], player);
    a.vel.set(-6, 0, 0);
    b.vel.set(-6, 0, 0);
    f.update(1 / 60, [a, b, c], player);
    expect(f.burning(a)).toBe(true);
    expect(f.burning(b)).toBe(false);
  });
});
