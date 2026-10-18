import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { TireTracks } from '@ht2/world/tireTracks';
import type { SceneAssembler } from '@ht2/engine/render/sceneBuilder';

/** Збирач лише з матеріалами trace0/trace1 (текстура-заглушка). */
const asm = {
  b3d: { materials: ['trace0', 'trace1'] },
  lib: { material: () => new THREE.MeshBasicMaterial({ map: new THREE.Texture() }) },
} as unknown as SceneAssembler;

const up = new THREE.Vector3(0, 1, 0);
const count = (t: TireTracks) => (t.group.children[1] as THREE.Mesh).geometry.drawRange.count;

describe('HT2: сліди шин (king.exe 0x4bcd00)', () => {
  it('стрічка росте відрізками ≥ 0,2 м і рветься, коли колесо пропустило кадр', () => {
    const t = new TireTracks(asm);
    for (let k = 0; k <= 8; k++) {
      t.beginFrame();
      t.add(0, new THREE.Vector3(0, 0, -0.125 * k), up, 0.6, 1);
    }
    // 1 м кроками 0,125 м — 4 відрізки по 0,25 м (крок 0,125 < 0,2 пропускається), по 6 вершин.
    expect(count(t)).toBe(24);
    t.beginFrame();
    t.beginFrame();
    t.add(0, new THREE.Vector3(0, 0, -1.3), up, 0.6, 1);
    t.beginFrame();
    t.add(0, new THREE.Vector3(0, 0, -1.6), up, 0.6, 1);
    expect(count(t)).toBe(30);
  });

  it('поворот більше ніж на 5 рад (cos 5) рве стрічку, вершини на 0,1 м над контактом', () => {
    const t = new TireTracks(asm);
    const pts = [[0, 0], [0, -0.5], [0, -1], [0.5, -1]];
    for (const [x, z] of pts) {
      t.beginFrame();
      t.add(1, new THREE.Vector3(x, 2, z), up, 0.4, 1);
    }
    // Третій відрізок повернутий на 90° (cos 0 < cos 5 = 0,284) — стрічка почалась знову.
    expect(count(t)).toBe(12);
    const pos = (t.group.children[1] as THREE.Mesh).geometry.attributes.position;
    expect(pos.getY(0)).toBeCloseTo(2.1, 5);
    // Ширина — 0,4 м поперек руху.
    expect(Math.abs(pos.getX(0) - pos.getX(2))).toBeCloseTo(0.4, 5);
  });
});
