// Стіни кімнат лише для машин у своїй кімнаті (engine/physics/roomBounds.ts) — на даних регіону dr.
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { levelCollision } from '@ht2/engine/physics/collision';
import { RoomBounds } from '@ht2/engine/physics/roomBounds';
import { addCollisionPolys, initRapier } from '@ht2/engine/physics/world';
import { HT2_DIR } from '../../gameDirs';

const file = join(HT2_DIR, 'ENV', 'dr.b3d');
const has = existsSync(file);

describe.skipIf(!has)('HT2: стіни кімнат (dr_000 / dr_099)', () => {
  let world: RAPIER.World;
  let bounds: RoomBounds;

  beforeAll(async () => {
    await initRapier();
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    bounds = new RoomBounds(world);
    const col = levelCollision(parseB3d(new Uint8Array(readFileSync(file))));
    const by = (polys: number[][][], rooms: string[]) => {
      const m = new Map<string, number[][][]>();
      polys.forEach((p, i) => (m.get(rooms[i]) ?? m.set(rooms[i], []).get(rooms[i])!).push(p));
      return m;
    };
    for (const [r, polys] of by(col.floors, col.floorRoom)) bounds.addFloors('dr', r, polys);
    addCollisionPolys(world, col.floors, 1);
    for (const [r, polys] of by(col.walls.filter((_, i) => !col.wallSwitch[i]), col.wallRoom.filter((_, i) => !col.wallSwitch[i])))
      bounds.addWalls('dr', r, polys);
  });

  /** Кубик 2×1×4 м, що їде зі сталою швидкістю (м/с, система гри) секунду; повертає кінцеву позицію (гра). */
  const push = (x: number, y: number, vx: number, vy: number): number[] => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(x, 2.5, -y).lockRotations());
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 2), body);
    for (let i = 0; i < 180; i++) {
      const v = body.linvel();
      body.setLinvel({ x: vx, y: v.y, z: -vy }, true);
      bounds.step();
    }
    const t = body.translation();
    world.removeRigidBody(body);
    return [t.x, -t.z];
  };

  it('кімната точки — за підлогою hit_road', () => {
    expect(bounds.roomAt(-2879, -2785, 3)).toBe('dr/room_dr_099');
    expect(bounds.roomAt(-2875, -2870, 3)).toBe('dr/room_dr_000');
  });

  it('межа кільця dr_000 (y = −2770) не перегороджує дорогу dr_099', () => {
    // Дорога dr_099 до порталу в dr_000 на y = −2800 перетинає лінію огорожі dr_000.
    const [, y] = push(-2879, -2755, 0, -10);
    expect(y).toBeLessThan(-2775);
  });

  it('машину всередині dr_000 його межа тримає (y = −2895)', () => {
    const [, y] = push(-2875, -2875, 0, -10);
    expect(y).toBeGreaterThan(-2895);
  });
});
