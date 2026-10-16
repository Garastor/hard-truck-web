/** Класифікатор ПДР при ДТП (king.exe 0x54f040): коди порушень гравця на прямій дорозі 12 м. */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { RoadLine } from '@ht2/world/roads';
import { classify, CODE_BIT, type ClassifyInput } from '@ht2/traffic/accidents';

// Вісь x = 0 уздовж −z; праворуч від руху «уперед» — +x (смуги 1,5 і 4,5 м).
const axis: RoadLine = {
  name: 'a', pts: [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -200)], next: [], width: 12, region: 'x', road: 0, lane: -1,
  lanes: 2, laneWidth: 3, flags: 0, cls: 1, length: 200, siblings: [], startNode: -1, endNode: -1,
};

function at(x: number, z: number, heading: THREE.Vector3, vel: THREE.Vector3, extra: Partial<ClassifyInput> = {}): number {
  const pos = new THREE.Vector3(x, 0, z);
  const fwd = heading.clone().normalize();
  const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const corners = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => pos.clone().addScaledVector(fwd, 3.5 * a).addScaledVector(side, 1.25 * b));
  return classify({
    pos, forward: fwd, vel, corners, axis, axisPoint: new THREE.Vector3(0, 0, z), sameRoad: true,
    partnerVelBefore: new THREE.Vector3(), queueAhead: false, ...extra,
  });
}

const N = new THREE.Vector3(0, 0, -1);

describe('HT2: ДТП — класифікатор ПДР', () => {
  it('у своїй смузі наїхав на того, хто стоїть, — 6 (RoadHog)', () => {
    expect(at(1.5, -50, N, N.clone().multiplyScalar(10))).toBe(6);
  });
  it('у своїй смузі, вдарили збоку швидшою машиною — без порушення', () => {
    expect(at(1.5, -50, N, N.clone().multiplyScalar(5), { partnerVelBefore: new THREE.Vector3(-15, 0, 0) })).toBe(0);
  });
  it('зустрічна — 1', () => {
    expect(at(-4.5, -50, N, N.clone().multiplyScalar(10))).toBe(1);
  });
  it('задній хід — 3', () => {
    expect(at(1.5, -50, N, N.clone().multiplyScalar(-3))).toBe(3);
  });
  it('навскіс (перестроювання) — 2', () => {
    const d = new THREE.Vector3(1, 0, -1).normalize();
    expect(at(1.5, -50, d, d.clone().multiplyScalar(8))).toBe(2);
  });
  it('стоїть посеред смуги — 4; у черзі — ні', () => {
    expect(at(1.5, -50, N, new THREE.Vector3())).toBe(4);
    expect(at(1.5, -50, N, new THREE.Vector3(), { queueAhead: true })).toBe(0);
  });
  it('поза дорогою — лише «наїхав»', () => {
    expect(at(30, -50, N, N.clone().multiplyScalar(10), { axis: null, axisPoint: null })).toBe(6);
  });
  it('коди → біти картки 14', () => {
    expect([1, 2, 3, 4, 5, 6].map((c) => CODE_BIT[c])).toEqual([1, 0x10, 2, 4, 8, 0x20]);
  });
});
