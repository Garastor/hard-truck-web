// Стовпчики sharp_* без подій (engine/physics/collision.ts roomPosts) — ніжки щитів, вказівників, щогл.
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseB3d, type B3d, type Block } from '@ht2/engine/formats/b3d';
import { levelCollision, roomGround, roomPosts } from '@ht2/engine/physics/collision';
import { spaceMatrix } from '@ht2/engine/render/sceneBuilder';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.b3d'));

function posts(reg: string) {
  const common = parseB3d(new Uint8Array(readFileSync(join(HT2_DIR, 'COMMON', 'COMMON.B3D'))));
  const b3d: B3d = parseB3d(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${reg}.b3d`))));
  const top = new Map<string, Block>();
  for (const b of [...common.blocks, ...b3d.blocks]) if (b.name) top.set(b.name.toLowerCase(), b);
  const spaces = new Map<string, THREE.Matrix4>();
  const collect = (b: Block, parent: THREE.Matrix4) => {
    let m = parent;
    if (b.data.t === 24) {
      m = parent.clone().multiply(spaceMatrix(b));
      if (b.name) spaces.set(b.name.toLowerCase(), m);
    }
    for (const g of b.groups ?? []) for (const c of g) collect(c, m);
  };
  for (const b of b3d.blocks) if (b.data.t === 24) collect(b, new THREE.Matrix4());
  const col = levelCollision(b3d);
  const t0 = performance.now();
  const p = roomPosts(b3d, (n) => top.get(n.toLowerCase()), (n) => spaces.get(n.toLowerCase()) ?? null, new Set(), roomGround(col));
  const ms = performance.now() - t0;
  // Центр і радіус кожного стовпчика (8 граней поспіль).
  const list: { room: string; x: number; y: number; r: number; z0: number; z1: number }[] = [];
  for (let i = 0; i < p.walls.length; i += 8) {
    const w = p.walls.slice(i, i + 8);
    const x = w.reduce((s, q) => s + q[0][0], 0) / 8;
    const y = w.reduce((s, q) => s + q[0][1], 0) / 8;
    list.push({ room: p.wallRoom[i], x, y, r: Math.hypot(w[0][0][0] - x, w[0][0][1] - y), z0: w[0][0][2], z1: w[0][2][2] });
  }
  return { p, list, ms };
}

describe.skipIf(!has)('HT2: стовпчики sharp_* без подій', () => {
  it('ap: щогла освітлення біля бази «Южный» — ніжка r 0,9 м у room_ap_048', () => {
    const { list } = posts('ap');
    const mast = list.find((c) => Math.hypot(c.x + 3000, c.y + 4663) < 0.1)!;
    expect(mast.room).toBe('room_ap_048');
    expect(mast.r).toBeCloseTo(0.9, 2);
  });

  it('ba: вказівник «Ключи» (e_BAZ0080) — не стовпчик, а збивний знак (world/objects.ts)', () => {
    const { list } = posts('ba');
    expect(list.some((c) => Math.hypot(c.x + 2418, c.y - 3420) < 0.5)).toBe(false);
  });

  it('aj: рекламний щит (−1900; −61) — дві низькі ніжки — до 2 м над ґрунтом', () => {
    const { list } = posts('aj');
    const legs = list.filter((c) => Math.abs(c.y + 60) < 1 && c.x > -1910 && c.x < -1890);
    expect(legs.map((c) => Math.round(c.x)).sort((a, b) => a - b)).toEqual([-1907, -1893]);
    // Ґрунт тут ≈ 5,1 м, точки — 4,7…5,7 (майже на землі): стовпчик піднято на 2 м над ґрунтом.
    for (const c of legs) expect(c.z1).toBeCloseTo(5.1 + 2, 0);
  });

  it('дерева з бітом 1 i1 — стовбур (king.exe sharpTerrainTree: точки 0,75 і 1,5 м; порт — від ґрунту до 2 м), без біта — без колізії', () => {
    const { list } = posts('ap');
    // Tree048_22 (i1 = 19: біт 1) у (−3006; −4635), основа z = 21; Tree048_21 (i1 = 3) теж; обидва — у room_ap_048.
    const t = list.find((c) => Math.hypot(c.x + 3006, c.y + 4635) < 0.05)!;
    expect(t.room).toBe('room_ap_048');
    expect(t.z0).toBeCloseTo(21 - 0.5, 1);
    expect(t.z1).toBeCloseTo(21 + 2, 1);
  });

  it('cf — найбільше стовпчиків: швидко (≤ 150 мс з пошуком ґрунту — синхронно під час підвантаження регіону)', () => {
    const { p, ms } = posts('cf');
    expect(p.count).toBeGreaterThan(1400);
    expect(ms).toBeLessThan(150);
  });
});
