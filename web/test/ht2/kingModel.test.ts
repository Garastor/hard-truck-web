import { describe, expect, it } from 'vitest';
import { KING, ROUGH_GROUND, roadBump, rollingForce, steerLimit, wheelForces, yawRate, type KingWheel, type WheelSlip } from '../../src/games/ht2/engine/vehicle/kingModel';

/** Чотири колеса по 10 кН, ведучі задні (μ = 0,7: межа колеса 7 кН). */
const wheels = (mu = 0.7): KingWheel[] =>
  [false, false, true, true].map((driven) => ({ ground: true, driven, load: 10_000, mu, brake: KING.brakeLoad * 10_000 }));

describe('рух king.exe (G10 В3)', () => {
  it('межа керма — 1,5·atan(μ·k·L/v²), на місці без межі', () => {
    expect(steerLimit(0, 0.7, 7.2, 9.8)).toBe(1);
    expect(steerLimit(5, 0.7, 7.2, 9.8)).toBe(1);
    expect(steerLimit(20, 0.7, 7.2, 9.8)).toBeCloseTo(1.5 * Math.atan((0.7 * 9.8 * 7.2) / 400), 6);
  });

  it('кутова швидкість — v·sin δ / L (ZilR, L = 7,22: кривизна на кермі 0,2 ≈ 0,021, як у записі оригіналу)', () => {
    const delta = KING.steerMax * 0.2;
    expect(yawRate(12.5, delta, 7.22) / 12.5).toBeCloseTo(0.0216, 3);
    expect(yawRate(-5, delta, 7.22)).toBeLessThan(0);
  });

  it('тяга ділиться між ведучими й обмежена μ·N — понад межу пробуксовка', () => {
    const slip: WheelSlip[] = [];
    expect(wheelForces(wheels(), 10_000, 0, 5, slip)).toBeCloseTo(10_000 * (14_000 / 14_000.01), 0);
    expect(slip).toEqual([0, 0, 0, 0]);
    expect(wheelForces(wheels(), 30_000, 0, 5, slip)).toBeCloseTo(14_000, 0);
    expect(slip).toEqual([0, 0, 1, 1]);
  });

  it('гальмо — 1,5·N·педаль проти руху, понад μ·N — блокування (лише понад 1 м/с)', () => {
    const slip: WheelSlip[] = [];
    // Педаль 0,4: 6 кН на колесо — у межах 7 кН.
    expect(wheelForces(wheels(), 0, 0.4, 10, slip)).toBeCloseTo(-24_000, 0);
    expect(slip).toEqual([0, 0, 0, 0]);
    // Повне гальмо: межа 7 кН на кожному колесі, назад — сила вперед.
    expect(wheelForces(wheels(), 0, 1, 10, slip)).toBeCloseTo(-28_000, 0);
    expect(slip).toEqual([-1, -1, -1, -1]);
    expect(wheelForces(wheels(), 0, 1, -10)).toBeCloseTo(28_000, 0);
    wheelForces(wheels(), 0, 1, 0.5, slip);
    expect(slip).toEqual([0, 0, 0, 0]);
    // Педаль до 0,1 не діє.
    expect(wheelForces(wheels(), 0, 0.1, 10)).toBe(0);
  });

  it('колесо в повітрі не дає сили; кочення наростає від нуля до f_r·N', () => {
    const w = wheels();
    w[2].ground = false;
    w[3].ground = false;
    expect(wheelForces(w, 10_000, 0, 5)).toBe(0);
    expect(rollingForce(10_000, 0)).toBe(0);
    expect(rollingForce(10_000, 20)).toBeCloseTo(100, 6);
  });
});

describe('нерівність дороги king.exe (0x502780)', () => {
  it('на місці не рухається, на ходу блукає в межах ±2 см', () => {
    const s = { h: 0, u: 0 };
    for (let i = 0; i < 600; i++) roadBump(s, 1 / 60, 0, 0.3, Math.random());
    expect(s.h).toBe(0);
    let max = 0;
    let moved = 0;
    for (let i = 0; i < 6000; i++) {
      const before = s.h;
      roadBump(s, 1 / 60, 12, 0.3, Math.random());
      max = Math.max(max, Math.abs(s.h));
      if (s.h !== before) moved++;
    }
    expect(max).toBeLessThanOrEqual(0.02);
    expect(moved).toBeGreaterThan(3000);
  });

  it('ґрунт трусить сильніше — до ±10 см', () => {
    const s = { h: 0, u: 0 };
    let max = 0;
    for (let i = 0; i < 6000; i++) {
      roadBump(s, 1 / 60, 12, 0.3, Math.random(), ROUGH_GROUND);
      max = Math.max(max, Math.abs(s.h));
    }
    expect(max).toBeGreaterThan(0.03);
    expect(max).toBeLessThanOrEqual(0.1);
  });
});
