/**
 * Лінії доріг HT2, якими їздять трафік і боти: однобічні дороги (біти 4/8) і вільне місце для появи машини
 * (traffic/clearance.ts). Docs/ht2/traffic.md §5а «Лінії доріг і місце появи».
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads, type RoadLine } from '@ht2/world/roads';
import { placeFree } from '@ht2/traffic/clearance';
import { initRapier } from '@ht2/engine/physics/world';
import { HT2_DIR } from '../gameDirs';

describe('HT2: вільне місце для появи (traffic/clearance.placeFree)', () => {
  let world: RAPIER.World;
  const onRoad = { offRoad: () => false } as unknown as Ht2Roads;
  const fwd = new THREE.Vector3(0, 0, -1);
  const at = new THREE.Vector3(0, 0, 0);

  beforeAll(async () => {
    await initRapier();
    world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    // Ґрунт 200 × 200 м, верх на y = 0.
    world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0));
    world.step();
  });

  const pole = (x: number, z: number) => {
    const c = world.createCollider(RAPIER.ColliderDesc.cuboid(0.25, 4, 0.25).setTranslation(x, 4, z));
    world.step();
    return c;
  };

  it('порожня дорога — вільно', () => {
    expect(placeFree(world, onRoad, at, fwd, 4, 16, 1.3)).toBe(true);
  });

  it('стовп (дерево) за 1 м праворуч від того місця, де стане причіп, — зайнято; за 3 м — вільно', () => {
    const near = pole(1, 10);
    expect(placeFree(world, onRoad, at, fwd, 4, 16, 1.3)).toBe(false);
    // Вантажівка без причепа (5 м позаду) до нього не дістає.
    expect(placeFree(world, onRoad, at, fwd, 4, 5, 1.3)).toBe(true);
    world.removeCollider(near, false);
    const far = pole(3, 10);
    world.step();
    expect(placeFree(world, onRoad, at, fwd, 4, 16, 1.3)).toBe(true);
    world.removeCollider(far, false);
    world.step();
  });

  it('машина поруч, за краєм полотна чи без ґрунту — зайнято', () => {
    expect(placeFree(world, onRoad, at, fwd, 4, 16, 1.3, [new THREE.Vector3(0, 0, 8)])).toBe(false);
    expect(placeFree(world, { offRoad: () => true } as unknown as Ht2Roads, at, fwd, 4, 16, 1.3)).toBe(false);
    expect(placeFree(world, onRoad, new THREE.Vector3(500, 0, 0), fwd, 4, 16, 1.3)).toBe(false);
  });
});

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe.skipIf(!has)('HT2: однобічні дороги (біти 4/8)', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);

  it('біт 4 — рух лише за точками осі, біт 8 — лише проти; решта — обидва напрямки', () => {
    let one = 0;
    for (const a of roads.axes) {
      const ls = roads.linesOf(a.road);
      const fwd = ls.some((l) => !l.name.endsWith('r'));
      const back = ls.some((l) => l.name.endsWith('r'));
      if (a.flags & 4) expect([fwd, back]).toEqual([true, false]);
      else if (a.flags & 8) expect([fwd, back]).toEqual([false, true]);
      else expect([fwd, back]).toEqual([true, true]);
      if (a.flags & 12) one++;
    }
    expect(one).toBe(1014);
  });

  it('мережа зв\'язна: поза найбільшою сильно зв\'язною частиною мало ліній, тупиків мало', () => {
    // Двобічні осі з бітом 4/8 давали «зустрічну» газоном, що вела в тупик: поза основною частиною було 577 ліній з 5767,
    // тупиків 143.
    const lines = roads.lines.filter((l) => !l.shortcut);
    const nexts = (l: RoadLine) => (l.next as RoadLine[]).filter((n) => !n.shortcut);
    const dead = lines.filter((l) => !nexts(l).length).length;
    // Kosaraju: порядок виходу на графі, потім обернений граф.
    const order: RoadLine[] = [];
    const seen = new Set<RoadLine>();
    for (const s of lines) {
      if (seen.has(s)) continue;
      seen.add(s);
      const stack: [RoadLine, number][] = [[s, 0]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const nx = nexts(top[0]);
        if (top[1] < nx.length) {
          const w = nx[top[1]++];
          if (!seen.has(w)) {
            seen.add(w);
            stack.push([w, 0]);
          }
        } else {
          order.push(top[0]);
          stack.pop();
        }
      }
    }
    const prev = new Map<RoadLine, RoadLine[]>();
    for (const l of lines) for (const n of nexts(l)) (prev.get(n) ?? prev.set(n, []).get(n)!).push(l);
    const done = new Set<RoadLine>();
    let biggest = 0;
    for (let i = order.length - 1; i >= 0; i--) {
      if (done.has(order[i])) continue;
      let size = 0;
      const todo = [order[i]];
      done.add(order[i]);
      while (todo.length) {
        const v = todo.pop()!;
        size++;
        for (const p of prev.get(v) ?? [])
          if (!done.has(p)) {
            done.add(p);
            todo.push(p);
          }
      }
      biggest = Math.max(biggest, size);
    }
    expect(lines.length - biggest).toBeLessThan(50);
    expect(dead).toBeLessThan(25);
  });
});
