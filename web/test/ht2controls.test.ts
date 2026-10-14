/**
 * Профіль керування Дальнобойщиків 2 (games/ht2/controls.ts) проти телеметрії king.exe (ZilR, 2026-10-13,
 * re/notes/ht2-telemetry.md): газ від часу утримання, перемикання автомата за обертами, холості.
 */
import { describe, expect, it } from 'vitest';
import { Engine, GEAR_N } from '@engine/vehicle/engine';
import { HT2_ENGINE } from '../src/games/ht2/controls';
import { Climate, gameTimeScale, illumOn, sunDirection, sunHeight } from '../src/games/ht2/climate';

// ZilR з vehicle.tech: tach_with_max_power 26,67 об/с, головна 5,29, колесо 0,533.
const zilr = () =>
  new Engine({ maxTorque: 950, tachMaxPower: 1600, rearAxle: 5.29, reverse: -4, gears: [7.44, 4.1, 2.29, 1.47, 1.0], wheelRadius: 0.533 }, HT2_ENGINE);

describe('HT2: двигун і коробка ZilR', () => {
  it('холості 4,0 об/с, газ за часом утримання — як у записі', () => {
    const e = zilr();
    expect(e.idle).toBeCloseTo(4.0, 2);
    const gasAt = (t: number) => HT2_ENGINE.throttle!(t, false);
    expect(gasAt(1)).toBeCloseTo(0.528, 3);
    expect(gasAt(4)).toBeCloseTo(0.739, 3);
    expect(HT2_ENGINE.throttle!(1, true)).toBeCloseTo(0.832, 3);
    expect(gasAt(100)).toBeLessThan(0.83);
  });

  it('вгору на 16 / 29 / 50 / 77 км/год (± 2), вниз на 15,5 / 27,5 / 46,5 / 69,5 (± 3)', () => {
    const e = zilr();
    const dt = 1 / 60;
    const ups: number[] = [];
    let gear = GEAR_N;
    // Швидкість росте 1,5 м/с² — як на розгоні ZilR; газ утримано.
    for (let v = 0; v < 28; v += 1.5 * dt) {
      e.update(dt, 1, 0, v);
      if (!e.shifting && e.gear !== gear) {
        if (e.gear > gear && gear >= 2) ups.push(v * 3.6);
        gear = e.gear;
      }
    }
    expect(ups.map((k) => Math.round(k))).toHaveLength(4);
    [16, 29, 50, 77].forEach((k, i) => expect(Math.abs(ups[i] - k)).toBeLessThan(2.5));
    const downs: number[] = [];
    for (let v = 28; v > 1; v -= 1.5 * dt) {
      e.update(dt, 0, 0, v);
      if (!e.shifting && e.gear !== gear) {
        if (e.gear < gear && e.gear >= 2) downs.push(v * 3.6);
        gear = e.gear;
      }
    }
    [69.5, 46.5, 27.5, 15.5].forEach((k, i) => expect(Math.abs(downs[i] - k)).toBeLessThan(3));
  });
});

describe('HT2: доба й погода (king.exe weatherandtime)', () => {
  it('сонце: найнижче о 2:00, обрій о 6:00 і 22:00, найвище о 14:00', () => {
    expect(sunHeight(2)).toBeCloseTo(-0.5);
    expect(sunHeight(6)).toBeCloseTo(0);
    expect(sunHeight(22)).toBeCloseTo(0);
    expect(sunHeight(14)).toBeCloseTo(1.5);
    expect(sunDirection(14)[2]).toBeCloseTo(Math.sin(1.5 * Math.PI / 5));
  });
  it('доба: повзунок 0,5 → 16,2 хв', () => {
    expect(86400 / gameTimeScale(0.5) / 60).toBeCloseTo(16.2);
  });
  it('погода як на живій грі: θ₁ 4,84, θ₂ 1,32, повзунок 0,6 → w 0,334, вітер 1,79', () => {
    const c = new Climate(0.6);
    c.th1 = 4.84055;
    c.th2 = 1.3177;
    expect(c.w()).toBeCloseTo(0.334, 2);
    c.t = 3; // не порив
    expect(c.wind).toBeCloseTo(1.785, 1);
    expect(c.rain).toBe(false);
    expect(c.bad).toBe(0);
  });
  it('злива: дощ, грім, калюжі; без вітру дерева', () => {
    const c = new Climate(0.6, 0.13, 'bad');
    expect(c.rain && c.thunder).toBe(true);
    expect(c.bad).toBeCloseTo(0.8);
    expect(new Climate(0.6, 0.13, 'good').wind).toBe(0);
  });
  it('нічні вікна: 00 — ввечері й уранці, 08 — усю ніч', () => {
    expect(illumOn(0, 22)).toBe(true);
    expect(illumOn(0, 1)).toBe(false);
    expect(illumOn(0, 5)).toBe(true);
    expect(illumOn(8, 1)).toBe(true);
    expect(illumOn(8, 12)).toBe(false);
  });
});
