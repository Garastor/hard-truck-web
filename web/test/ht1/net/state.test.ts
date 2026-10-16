import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FLAG_BRAKE, FLAG_LIGHTS, RemoteTrack, emptyState, packState, unpackState, type TruckState } from '../../../src/games/ht1/net/state';

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

  it('запізнілий пакет не ламає порядок', () => {
    const tr = new RemoteTrack();
    tr.push(state(1, 10, 0), 101);
    tr.push(state(0.5, 5, 0), 101.1);
    const out = emptyState();
    expect(tr.sample(102, out)!.pos.x).toBe(10);
  });
});
