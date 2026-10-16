/** Штрафи міліції (career/law.ts) — правила king.exe з re/notes/ht2/police.md. */
import { describe, expect, it } from 'vitest';
import { arrestCard, bribeSum, noFines, speedDegree, totalFine, wanted } from '@ht2/career/law';

describe('HT2: штрафи міліції', () => {
  it('ступінь перевищення: + 15 і + 35 км/год', () => {
    expect(speedDegree(65, 65)).toBe(0);
    expect(speedDegree(70, 65)).toBe(1);
    expect(speedDegree(81, 65)).toBe(2);
    expect(speedDegree(101, 65)).toBe(3);
  });

  it('картка затримання: один штраф — своя, кілька — 15', () => {
    const f = noFines();
    expect(wanted(f)).toBe(false);
    expect(arrestCard(f)).toBeNull();
    f.speeding = 500;
    expect(arrestCard(f)).toMatchObject({ card: 10, amount: 500 });
    f.redLight = 830;
    const c = arrestCard(f)!;
    expect(c.card).toBe(15);
    expect(c.amount).toBe(totalFine(f));
    expect(c.lines.map((l) => l.key)).toEqual(['FINE_SPEEDING', 'FINE_RED_LIGHT']);
  });

  it('хабар: сума − 200, округлена вгору', () => {
    expect(bribeSum(150, 200)).toBe(0);
    expect(bribeSum(500, 200)).toBe(300);
    expect(bribeSum(1330, 200)).toBe(1200);
    expect(bribeSum(1347, 200)).toBe(1200);
    expect(bribeSum(1360, 200)).toBe(1200);
    expect(bribeSum(1361, 200)).toBe(1200);
  });
});
