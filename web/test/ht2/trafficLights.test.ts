/** Світлофори HT2 (king.exe 0x4ce160 / 0x56ffd0): фази й зони тригерів 0x1D на реальних даних регіону ap. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { TrafficLights, allowedAt } from '@ht2/world/trafficLights';
import { toThree, type LoadedRegion } from '@ht2/world/world';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.b3d'));

describe('HT2: світлофори', () => {
  it('дозвіл за тактом: p = 0/20 — такти 6–10, p = 10/30 — решта; +1 — інверсія', () => {
    const ticks = (p: number) => Array.from({ length: 12 }, (_, t) => (allowedAt(p, t) ? 1 : 0)).join('');
    expect(ticks(0)).toBe('000000111110');
    expect(ticks(20)).toBe('000000111110');
    expect(ticks(10)).toBe('111111000001');
    expect(ticks(30)).toBe('111111000001');
    expect(ticks(1)).toBe('111111000001');
    expect(ticks(11)).toBe('000000111110');
  });

  it.skipIf(!has)('перехрестя біля бази в ap: зони підʼїзду, стоп-лінія, червоне — раз за перетин', () => {
    const b3d = parseB3d(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', 'ap.b3d'))));
    const switches: [string, number][] = [];
    const region = { id: 'ap', built: { assembler: { b3d, setSwitch: (n: string, s: number) => switches.push([n, s]) } } } as unknown as LoadedRegion;
    const L = new TrafficLights();
    L.update(0.1, [region]);
    const at = (x: number, y: number) => L.zoneAt(toThree(x, y, 20));
    expect(at(-2880, -4650)).toBe(0); // схід
    expect(at(-2980, -4650)).toBe(20); // захід
    expect(at(-2930, -4600)).toBe(10); // північ
    expect(at(-2930, -4700)).toBe(30); // південь
    expect(at(-2920, -4650)).toBe(40); // за стоп-лінією
    expect(at(-2700, -4650)).toBeUndefined(); // далеко
    expect(switches).toContainEqual(['refer_TrafficLightKey0', 0]);

    // Зі сходу на червоне (такт 0): одне порушення на перетині; на зелений (такт 6) — жодного.
    const drive = (t0: number) => {
      L.time = t0;
      let n = 0;
      for (let x = -2880; x >= -2940; x -= 2) if (L.player(toThree(x, -4647, 20))) n++;
      L.player(new THREE.Vector3(1e6, 0, 1e6));
      return n;
    };
    expect(drive(0.5)).toBe(1);
    expect(drive(15.5)).toBe(0);
    // Стоп-лінія для машини зі сходу на червоне — відстань уздовж курсу.
    L.time = 0.5;
    const west = toThree(-1, 0, 0).sub(toThree(0, 0, 0)).normalize();
    expect(L.stopAhead(toThree(-2880, -4647, 20), west)).toBeCloseTo(20, 0);
    L.time = 15.5;
    expect(L.stopAhead(toThree(-2880, -4647, 20), west)).toBe(Infinity);
  });
});
