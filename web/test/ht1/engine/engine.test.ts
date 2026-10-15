/**
 * Двигун і коробка проти телеметрії оригіналу (re/telemetry/s6: ЗіЛ, база, 2026-10-10).
 * Значення з памʼяті гри: [0x252] — оберти (об/с), [0x257] — сила тяги (Н), [0x23d] — передача.
 */
import { describe, expect, it } from 'vitest';
import { Engine } from '@ht1/engine/vehicle/engine';

// ЗіЛ з TRUCK.TCH ([TECH1]).
const zil = () =>
  new Engine({ maxTorque: 400, tachMaxPower: 1200, rearAxle: 5.29, reverse: -4, gears: [7.44, 4.1, 2.29, 1.47, 1.0], wheelRadius: 0.508 });

const ramp = (t: number) => t / (t + 1.2);

describe('двигун оригіналу', () => {
  it('n₀ і момент: максимум на 1200 об/хв, спад до відсічки', () => {
    const e = zil();
    expect(e.n0).toBe(20);
    expect(e.torque(20)).toBeCloseTo(400, 6);
    expect(e.torque(48) / 400).toBeCloseTo(Math.exp(-((28 / 30) ** 4)), 6);
    expect(e.torque(10)).toBeLessThan(400);
  });

  // [час утримання газу, передача, оберти, сила в грі]
  const points: [number, number, number, number][] = [
    [5.41, 4, 20.751, 7713.8], // 3-тя, одразу після перемикання
    [7.85, 4, 29.634, 8041.1],
    [6.85, 4, 26.041, 7831.6],
  ];
  it.each(points)('сила тяги: газ %s с, передача %s, %s об/с → %s Н (±2 %)', (hold, gear, n, game) => {
    const f = zil().wheelForce(gear, n, ramp(hold));
    expect(Math.abs(f - game) / game).toBeLessThan(0.02);
  });

  it('автомат: з першої на другу — при ≈ 46–48 об/с, як у грі', () => {
    const e = zil();
    // Розгін на першій: швидкість коліс росте, оберти жорстко звʼязані з колесами.
    e.update(0.01, 1, 0, 0);
    for (let i = 0; i < 200; i++) e.update(0.02, 1, 0, 0.5); // включити першу, пройти «зчеплення»
    expect(e.gear).toBe(2);
    let shiftAt = 0;
    for (let v = 0.5; v < 8 && !shiftAt; v += 0.01) {
      const before = e.lockedN(e.gear, v);
      e.update(0.02, 1, 0, v);
      if (e.shifting) shiftAt = before;
    }
    expect(shiftAt).toBeGreaterThan(43);
    expect(shiftAt).toBeLessThan(50);
  });

  it('автомат: на підйомі (швидкість падає) з 5-ї на 4-ту — до того, як оберти впадуть нижче n₀', () => {
    const e = zil();
    e.gear = e.topGear;
    let shiftAt = 0;
    for (let v = 20; v > 4 && !shiftAt; v -= 0.01) {
      const before = e.lockedN(e.gear, v);
      e.update(0.02, 1, 0, v);
      if (e.shifting) shiftAt = before;
    }
    expect(shiftAt).toBeGreaterThan(20);
    expect(shiftAt).toBeLessThan(30);
  });

  it('гальмування двигуном: при n₀ — −0,1·M', () => {
    expect(zil().engineBrake(20)).toBeCloseTo(-40, 6);
  });
});
