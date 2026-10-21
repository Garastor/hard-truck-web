// Стіни кімнат лише для машин у своїй кімнаті (engine/physics/roomBounds.ts) — на даних регіону dr.
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseB3d } from '@ht2/engine/formats/b3d';
import { hitOwners, levelCollision } from '@ht2/engine/physics/collision';
import { RoomBounds } from '@ht2/engine/physics/roomBounds';
import { addCollisionPolys, initRapier } from '@ht2/engine/physics/world';
import { readPortals } from '@ht2/world/roomVisibility';
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
    const b3d = parseB3d(new Uint8Array(readFileSync(file)));
    const col = levelCollision(b3d);
    for (const [room, list] of readPortals(b3d))
      bounds.addPortals('dr', room, list.map((p) => ({
        to: p.to,
        a: [p.corners[0].x, -p.corners[0].z] as [number, number],
        b: [p.corners[2].x, -p.corners[2].z] as [number, number],
        z0: Math.min(p.corners[0].y, p.corners[2].y),
        z1: Math.max(p.corners[0].y, p.corners[2].y),
      })));
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

  it('з кільця dr_000 на дорогу dr_099 — через портал (y = −2800), межа dr_000 (y = −2770) не тримає', () => {
    // Підлога dr_000 тягнеться до y = −2760: без переходу через портал машина лишалась у dr_000 і впиралась у межу.
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(-2875, 1, 2825));
    const rooms: (string | null)[] = [];
    for (let y = -2825; y <= -2772; y += 0.5) {
      body.setNextKinematicTranslation({ x: -2875, y: 1, z: -y });
      bounds.step();
      rooms.push(bounds.roomOf(body));
    }
    world.removeRigidBody(body);
    expect(rooms[0]).toBe('dr/room_dr_000');
    expect(rooms.at(-1)).toBe('dr/room_dr_099');
    // Перехід — саме на порталі: у dr_099 тіло вже за 3 м після нього.
    expect(rooms[Math.round((-2797 + 2825) / 0.5)]).toBe('dr/room_dr_099');
  });

  it('машину всередині dr_000 його межа тримає (y = −2895)', () => {
    const [, y] = push(-2875, -2875, 0, -10);
    expect(y).toBeGreaterThan(-2895);
  });
});

// Підлога кімнат теж лише для своєї кімнати й сусідніх через портал: схил ґрунту av_050 піднімається на 2 м над
// дорогою aw_001 (гра ≈ −2470, 1590), і машина впиралася в нього, як у невидиму стіну.
const aw = join(HT2_DIR, 'ENV', 'aw.b3d');
const av = join(HT2_DIR, 'ENV', 'av.b3d');

describe.skipIf(!existsSync(aw) || !existsSync(av))('HT2: підлога кімнат (aw_001 / av_050)', () => {
  let world: RAPIER.World;
  let bounds: RoomBounds;

  beforeAll(async () => {
    await initRapier();
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    bounds = new RoomBounds(world);
    for (const [id, file] of [['aw', aw], ['av', av]] as const) {
      const col = levelCollision(parseB3d(new Uint8Array(readFileSync(file))));
      const rooms = new Map<string, { polys: number[][][]; surfaces: number[] }>();
      col.floors.forEach((p, i) => {
        if (col.floorSwitch[i] || !col.floorRoom[i]) return;
        const g = rooms.get(col.floorRoom[i]) ?? rooms.set(col.floorRoom[i], { polys: [], surfaces: [] }).get(col.floorRoom[i])!;
        g.polys.push(p);
        g.surfaces.push(col.floorSurface[i]);
      });
      for (const [r, g] of rooms) bounds.addFloors(id, r, g.polys);
      for (const [r, g] of rooms) bounds.addFloorCollider(id, r, g.polys, g.surfaces);
    }
  });

  it('схил av_050 стоїть над дорогою aw_001', () => {
    expect(bounds.roomAt(-2475, 1590, 20)).toBe('aw/room_aw_001');
    expect(bounds.roomAt(-2470.3, 1593.5, 23)).toBe('av/room_av_050');
  });

  it('корпус на дорозі aw_001 проїжджає крізь схил av_050', () => {
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(-2478, 20.6, -1586).lockRotations());
    world.createCollider(RAPIER.ColliderDesc.cuboid(1, 0.5, 2), body);
    for (let i = 0; i < 90; i++) {
      const v = body.linvel();
      body.setLinvel({ x: 8.6, y: v.y, z: -5.1 }, true);
      bounds.step();
    }
    const t = body.translation();
    world.removeRigidBody(body);
    expect(t.x).toBeGreaterThan(-2468);
    expect(t.y).toBeLessThan(21.5);
  });
});

// Колізія кімнати — за посиланням з кімнати (вузол 5 `road_XXX` → `hit_road_YYY`), не за іменем: у cb `room_cb15` →
// `hit_road_cb15a`; за іменем підлога діставалась неіснуючій кімнаті без порталів, і машина провалювалась на межах.
const envDir = join(HT2_DIR, 'ENV');

describe.skipIf(!existsSync(join(envDir, 'cb.b3d')))('HT2: кімната колізій hit_* — за посиланням з кімнати', () => {
  it('cb: hit_road_cb15a належить room_cb15', () => {
    const b3d = parseB3d(new Uint8Array(readFileSync(join(envDir, 'cb.b3d'))));
    expect(hitOwners(b3d).get('hit_road_cb15a')).toBe('room_cb15');
    expect(new Set(levelCollision(b3d).floorRoom)).not.toContain('room_cb15a');
  });

  it('у всіх регіонах підлога належить наявній кімнаті', () => {
    const bad: string[] = [];
    for (const f of readdirSync(envDir).filter((n) => /^[a-z]{2}\.b3d$/i.test(n))) {
      const b3d = parseB3d(new Uint8Array(readFileSync(join(envDir, f))));
      const rooms = new Set(b3d.blocks.filter((b) => b.data.t === 19).map((b) => b.name.toLowerCase()));
      for (const r of new Set(levelCollision(b3d).floorRoom)) if (r && !rooms.has(r.toLowerCase())) bad.push(`${f}: ${r}`);
    }
    expect(bad).toEqual([]);
  });
});
