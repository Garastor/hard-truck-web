import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { Dents, hitEnergy, zoneWeights } from '../../src/games/ht2/vehicles/dents';

describe('пошкодження HT2 (king.exe 0x554c20, 0x5465c0)', () => {
  it('енергія удару: до 2 м/с — нуль, далі росте', () => {
    expect(hitEnergy(1.9)).toBe(0);
    expect(hitEnergy(3)).toBeGreaterThan(0);
    expect(hitEnergy(20)).toBeGreaterThan(hitEnergy(10));
  });

  it('зони за напрямком: прямо вперед — FC і обидва передні кути', () => {
    const w = zoneWeights(0, 1);
    expect(w.FC).toBeCloseTo(1);
    expect(w.FR).toBeCloseTo(0.5, 2);
    expect(w.FL).toBeCloseTo(0.5, 2);
    expect(w.BC).toBeUndefined();
    expect(zoneWeights(1, 0).R).toBe(1);
    expect(zoneWeights(-1, 0).L).toBe(1);
  });

  it('удар спереду мне перед, капот — з передніх зон; задні вогні гаснуть від побитого BR', () => {
    const set = new Map<string, number>();
    const states = (n: string) => (/Damage(FC|FR|FL|BR|BL|BC)Key$/.test(n) ? 4 : n === 'refer_Damage1Key' ? 5 : /DamageWheel[0-3]Key/.test(n) ? 4 : /StopFara/.test(n) ? 3 : /BackFara/.test(n) ? 2 : 0);
    const d = new Dents({}, (n, s) => set.set(n, s), states, { wheels: [[-1, 2], [1, 2], [-1, -2], [1, -2]], half: [1.2, 3] });
    // Швидкість змінилась назад (+z) на 20 м/с — удар спереду.
    d.hit(new THREE.Vector3(0, 0, 20));
    expect(d.state('FC')).toBeGreaterThan(0);
    expect(d.state('BC')).toBe(0);
    expect(set.get('refer_Damage1Key')).toBeGreaterThan(0);
    expect(d.zones.W0).toBeGreaterThan(0);
    expect(d.zones.W2).toBeUndefined();
    d.rearLights(true, false, true);
    expect(set.get('StopFaraKeyL')).toBe(1);
    d.hit(new THREE.Vector3(-8, 0, -18));
    d.rearLights(true, true, true);
    expect(d.state('BR')).toBeGreaterThan(0);
    expect(set.get('StopFaraKeyR')).toBe(2);
    expect(set.get('BackFaraKeyR')).toBe(0);
    d.repair();
    expect(d.state('FC')).toBe(0);
    expect(d.wheel(0)).toBe(0);
  });
});
