/** Гелікоптери Ка-50 HT2 (Б11, re/notes/ht2/helicopters.md): заборонена зона db, бази. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { COPTER_HOMES, ForbiddenZone, zoneRooms } from '@ht2/traffic/helicopters';
import type { LoadedRegion } from '@ht2/world/world';
import { HT2_DIR } from '../gameDirs';

const db = join(HT2_DIR, 'ENV', 'db.b3d');

/** Регіон з кімнатами-коробками (габарити кімнат зони db, координати Three.js). */
function fakeRegion(rooms: [string, number, number][]): LoadedRegion {
  const b3d = {
    blocks: rooms.map(([name, , level]) => ({ name, data: { t: 19 }, groups: [[{ name: 'no_entry', data: { t: 13, trigger: { i1: 27, i2: level, values: new Uint32Array(0) } } }]] })),
  };
  const groups = rooms.map(([name, x]) => {
    const g = new THREE.Group();
    g.name = name;
    const m = new THREE.Mesh(new THREE.BoxGeometry(100, 20, 100));
    m.position.set(x, 0, 0);
    g.add(m);
    g.updateMatrixWorld(true);
    return g;
  });
  return { id: 'db', built: { rooms: groups, assembler: { b3d } } } as unknown as LoadedRegion;
}

describe('HT2: гелікоптери', () => {
  it.skipIf(!existsSync(db))('тригери забороненої зони (13, дані 27) — лише кімнати db 018/019/020/004', () => {
    const z = zoneRooms(parseB3d(new Uint8Array(readFileSync(db))).blocks);
    expect([...z.entries()].sort()).toEqual([
      ['room_db_004', 2],
      ['room_db_018', 3],
      ['room_db_019', 2],
      ['room_db_020', 1],
    ]);
  });

  it('шість баз, перша — db', () => {
    expect(COPTER_HOMES.map((h) => h.region)).toEqual(['db', 'al', 'aq', 'at', 'am', 'bb']);
  });

  it('зона: 3 → 2 — попередження, 3 → 2 → 1 — вогонь, назад у 2 — знято; виняток без подій', () => {
    const reg = fakeRegion([
      ['room_db_018', 0, 3],
      ['room_db_019', 100, 2],
      ['room_db_020', 200, 1],
    ]);
    const run = (exempt: boolean) => {
      const z = new ForbiddenZone();
      const at = (x: number) => z.update(1, [reg], new THREE.Vector3(x, 0, 0), exempt);
      return [at(0), at(100), at(200), at(100), at(-500)];
    };
    expect(run(false)).toEqual([[], ['warn'], ['fire'], ['clear'], []]);
    expect(run(true)).toEqual([[], [], [], [], []]);
    // Обʼїзд рівня 2 (3 → 1) — не вогонь.
    const z = new ForbiddenZone();
    z.update(1, [reg], new THREE.Vector3(0, 0, 0), false);
    expect(z.update(1, [reg], new THREE.Vector3(200, 0, 0), false)).toEqual([]);
    expect(z.hot).toBe(false);
  });
});
