import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Heightmap } from '@engine/formats/heightmap';
import { GROUP_WORLD, groups } from '@engine/physics/world';

/**
 * Процедурний рельєф HT2 (`$$GeneratorOfTerrain` у кімнаті `room_aa_000`): сітка 771 × 771 вузлів — плитки 3 × 3 по
 * 257 відліків з трьох карт висот `MTR/terrain0–2.raw`.
 *
 * З розбору поведінки king.exe (ht2-rev, лише для розуміння, власна реалізація):
 * - відлік (X, Y) береться з плитки tx = X / 257, ty = Y / 257 за діагональною схемою: на побічній діагоналі
 *   (tx + ty = 2) — таблиця 0 (у кутових плитках (0, 2) і (2, 0) — частково 1 по діагоналі), поза нею — таблиця 2,
 *   край (tx або ty = 3) — 1; у таблиці — `[(X % 257) · 257 + Y % 257]`;
 * - висота = (raw / 65535 − 0,5) · 100 + 474,9 м;
 * - координати текстур вузла — X / 8 і X / 3 (дві текстури різного масштабу: ter000 і ter100 регіону).
 *
 * Початок і крок сітки в даних не записані (задає код) — підібрано за дорогами WAY регіону aa, що лежать на рельєфі:
 * крок 3,91 м, початок (2049; −5999) — середня розбіжність висоти доріг і рельєфу 0,2 м (гіпотеза).
 */
export const TERRAIN = { n: 771, step: 3.91, x0: 2049, y0: -5999 };

export interface Terrain {
  /** Висоти вузлів (м), індекс X · n + Y. */
  heights: Float32Array;
  mesh: THREE.Mesh;
}

/** Висоти сітки з трьох карт (діагональна схема плиток). */
export function terrainHeights(tiles: Heightmap[]): Float32Array {
  const n = TERRAIN.n;
  const out = new Float32Array(n * n);
  const table = (x: number, y: number) => {
    const tx = Math.floor(x / 257);
    const ty = Math.floor(y / 257);
    if (tx === 3 || ty === 3) return tiles[1];
    if (2 - tx !== ty) return tiles[2];
    if (tx === 0) return ty === 2 && 771 - y <= 257 - x ? tiles[1] : tiles[0];
    if (tx === 2 && ty === 0) return 771 - x <= 257 - y ? tiles[1] : tiles[0];
    return tiles[0];
  };
  for (let x = 0; x < n; x++)
    for (let y = 0; y < n; y++) out[x * n + y] = (table(x, y).heights[(x % 257) * 257 + (y % 257)] - 0.5) * 100 + 474.9;
  return out;
}

/** Висота рельєфу в точці гри (білінійно); поза сіткою — NaN. */
export function terrainHeightAt(heights: Float32Array, gx: number, gy: number): number {
  const { n, step, x0, y0 } = TERRAIN;
  const fx = (gx - x0) / step;
  const fy = (gy - y0) / step;
  const X = Math.floor(fx);
  const Y = Math.floor(fy);
  if (X < 0 || Y < 0 || X >= n - 1 || Y >= n - 1) return NaN;
  const u = fx - X;
  const v = fy - Y;
  const h = (a: number, b: number) => heights[a * n + b];
  return h(X, Y) * (1 - u) * (1 - v) + h(X + 1, Y) * u * (1 - v) + h(X, Y + 1) * (1 - u) * v + h(X + 1, Y + 1) * u * v;
}

/**
 * Сітка рельєфу для малювання: кожен DECIMATE-й вузол (на телефоні 771² вершин забагато), у системі гри (x, y,
 * висота) — як решта геометрії регіону (корінь регіону повертає її в систему Three.js). Текстура — ter000 з UV = X / 8, деталь — ter100 з UV = X / 3 (множення ×2, гіпотеза змішування).
 */
const DECIMATE = 2;

export function buildTerrainMesh(heights: Float32Array, base: THREE.Texture | null, detail: THREE.Texture | null): THREE.Mesh {
  const { n, step, x0, y0 } = TERRAIN;
  const m = Math.floor((n - 1) / DECIMATE) + 1;
  const pos = new Float32Array(m * m * 3);
  const uv = new Float32Array(m * m * 2);
  for (let i = 0; i < m; i++)
    for (let j = 0; j < m; j++) {
      const X = i * DECIMATE;
      const Y = j * DECIMATE;
      const k = i * m + j;
      pos[k * 3] = x0 + X * step;
      pos[k * 3 + 1] = y0 + Y * step;
      pos[k * 3 + 2] = heights[X * n + Y];
      uv[k * 2] = X / 8;
      uv[k * 2 + 1] = Y / 8;
    }
  const index: number[] = [];
  for (let i = 0; i + 1 < m; i++)
    for (let j = 0; j + 1 < m; j++) {
      const a = i * m + j;
      const b = (i + 1) * m + j;
      // Обхід — лицем угору (+z гри).
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  for (const t of [base, detail]) if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  const mat = new THREE.MeshLambertMaterial({ map: base ?? undefined, color: base ? 0xffffff : 0x8a7a55 });
  if (detail) {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.detailMap = { value: detail };
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <map_pars_fragment>', '#include <map_pars_fragment>\nuniform sampler2D detailMap;')
        .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb *= texture2D(detailMap, vMapUv * (8.0 / 3.0)).rgb * 2.0;');
    };
  }
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = 'terrain';
  return mesh;
}

/**
 * Колайдер — heightfield Rapier на повній сітці (771²): стовпці — X гри (вісь x), рядки — уздовж z Three.js
 * (z = −y гри, тож рядок i = n − 1 − Y); висоти зберігаються стовпцями.
 */
export function terrainCollider(world: RAPIER.World, heights: Float32Array): RAPIER.Collider {
  const { n, step, x0, y0 } = TERRAIN;
  const cells = n - 1;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) h[i + j * n] = heights[j * n + (n - 1 - i)];
  const size = cells * step;
  return world.createCollider(
    RAPIER.ColliderDesc.heightfield(cells, cells, h, { x: size, y: 1, z: size })
      .setTranslation(x0 + size / 2, 0, -(y0 + size / 2))
      .setFriction(1.0)
      .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
  );
}
