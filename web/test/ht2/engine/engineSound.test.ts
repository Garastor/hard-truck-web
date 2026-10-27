import { describe, expect, it } from 'vitest';
import { STOP_SOUND_SECONDS, engineMix, engineStopFade } from '@ht2/engine/audio/engineMix';

/** Звук двигуна гравця — як king.exe 0x538ec1…0x5390f8: усе від частки обертів r = n / n₀ цієї машини. */
describe('HT2: звук двигуна (engineMix)', () => {
  it('холості: idle звучить близько рідного тону, full — низько й тихо', () => {
    // ZilR: холості 4 об/с при n₀ = 26,67 (телеметрія), педаль 0,05.
    const m = engineMix(4 / 26.67, 0.05);
    expect(m.idleRate).toBeCloseTo(0.73, 2);
    expect(m.idleVolume).toBeCloseTo(0.18, 2);
    expect(m.fullRate).toBeCloseTo(0.25, 2);
    expect(m.fullVolume).toBeCloseTo(0.16, 2);
  });

  it('повний газ на межі перемикання (r = 1,85): обидві петлі на тоні 1,68, переважає full', () => {
    const m = engineMix(1.85, 1);
    expect(m.idleRate).toBeCloseTo(1.68, 5);
    expect(m.fullRate).toBeCloseTo(1.68, 5);
    expect(m.fullVolume).toBeCloseTo(0.5, 5);
    expect(m.idleVolume).toBeCloseTo(0.1 * Math.sqrt(1.85), 5);
  });

  it('тон залежить від відносних обертів: Газель (n₀ 3000) і Peterbilt (n₀ 2200) на холостих — як ЗіЛ (n₀ 1600)', () => {
    // Порт раніше брав абсолютні об/хв (rpm / 1500, до 2,0): машини з високими n₀ звучали на «максимумі».
    const idle = 0.25; // Engine: холості — ¼ n₀ для будь-якої машини
    const zil = engineMix((1600 * idle) / 1600, 0);
    for (const n0 of [2200, 3000, 4400]) {
      const m = engineMix((n0 * idle) / n0, 0);
      expect(m.idleRate).toBeCloseTo(zil.idleRate, 9);
      expect(m.fullRate).toBeCloseTo(zil.fullRate, 9);
    }
  });

  it('тон росте з обертами монотонно', () => {
    let prev = engineMix(0, 0.5);
    for (let r = 0.1; r <= 2.5; r += 0.1) {
      const m = engineMix(r, 0.5);
      expect(m.fullRate).toBeGreaterThan(prev.fullRate);
      prev = m;
    }
  });
});

describe('HT2: глушіння двигуна (engineStopFade)', () => {
  it('петлі стихають за 1,49 с (половина stop_eng), stop_eng наростає до 0,4', () => {
    expect(engineStopFade(0)).toEqual({ engine: 1, stopSound: 0 });
    expect(engineStopFade(0.25).engine).toBeCloseTo(0.5, 9);
    expect(engineStopFade(0.25).stopSound).toBeCloseTo(0.2, 9);
    expect(engineStopFade(0.5)).toEqual({ engine: 0, stopSound: 0.4 });
    expect(engineStopFade(0.75 / STOP_SOUND_SECONDS).engine).toBeCloseTo(1 - 0.75 / 1.49, 9);
  });
});
