/** Обвали й повені HT2 (obstacle у mod_*.sch, king.exe 0x42b3a0, 0x42b060). */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseWay } from '@ht2/formats/way';
import { readSch } from '@ht2/formats/sexpr';
import { HT2_MOD_REGIONS, HT2_REGIONS } from '@ht2/files';
import { Ht2Roads } from '@ht2/world/roads';
import { Navigator } from '@ht2/world/navigator';
import { Obstacles, closedAxes, parseObstacles, type Obstacle } from '@ht2/world/obstacles';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'mod_ac.sch'));

describe.skipIf(!has)('HT2: обвали й повені', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const mods = (has ? HT2_MOD_REGIONS : [])
    .map((r) => join(HT2_DIR, 'ENV', `mod_${r}.sch`))
    .filter(existsSync)
    .map((f) => ({ sch: readSch(new Uint8Array(readFileSync(f))) }));
  const list = parseObstacles(mods, regions);

  it('17 записів: ключі, вузли по краях, тексти, місця катка', () => {
    expect(list).toHaveLength(17);
    const ac1 = list.find((o) => o.id === 'OBST_AC_1')!;
    expect(ac1.key).toBe('FallAC1Key');
    expect(ac1.ends).not.toBeNull();
    expect(ac1.closeText).toBe('ТРАССА ШАХТЫ - БОРОВОЕ ЗАКРЫТА');
    expect(ac1.work).toHaveLength(2);
    // Ремонт мосту — без вузлів завалу, позиція — місце катка.
    const bd = list.find((o) => o.id === 'OBST_BD_1')!;
    expect(bd.ends).toBeNull();
    expect(bd.work).toHaveLength(1);
    expect(bd.pos.distanceTo(bd.work[0])).toBeLessThan(0.01);
    // Позиція — середина між вузлами (без катка), з катком — останнє місце катка (0x411b10).
    const ab1 = list.find((o) => o.id === 'OBST_AB_1')!;
    expect(ab1.pos.distanceTo(ab1.ends![0].clone().lerp(ab1.ends![1], 0.5))).toBeLessThan(0.01);
    expect(ac1.pos.distanceTo(ac1.work[1])).toBeLessThan(0.01);
  });

  it('завал закриває дорогу між вузлами — навігатор її оминає', () => {
    const roads = new Ht2Roads(regions);
    const nav = new Navigator(roads);
    for (const o of list) {
      if (!o.ends) continue;
      const axes = closedAxes(roads, o.ends);
      expect(axes.length, o.id).toBeGreaterThan(0);
      // Ланцюжок короткий — не півкарти.
      expect(axes.reduce((s, r) => s + roads.axes[r].length, 0), o.id).toBeLessThan(3500);
    }
    const ac1 = list.find((o) => o.id === 'OBST_AC_1')!;
    const axes = closedAxes(roads, ac1.ends!);
    const target = ac1.ends![1];
    const before = nav.distances(target).size;
    for (const r of axes) roads.setClosed(r, true);
    const dist = nav.distances(target);
    for (const r of axes) for (const l of roads.linesOf(r)) expect(dist.has(l)).toBe(false);
    expect(dist.size).toBeLessThan(before);
    for (const r of axes) roads.setClosed(r, false);
    expect(nav.distances(target).size).toBe(before);
  });
});

describe('HT2: вибір діючого завалу (0x42b3a0)', () => {
  const at = (x: number, id: string): Obstacle => ({ id, region: 'ac', key: `${id}Key`, ends: null, closeText: 'ЗАКРЫТА', openText: 'ОТКРЫТО', work: [], pos: new THREE.Vector3(x, 0, 0) });
  const list = [at(0, 'A'), at(400, 'B'), at(2000, 'C')];

  it('не ближче 500 м до гравця й до діючого; лише один діючий', () => {
    const log: string[] = [];
    let player = new THREE.Vector3(0, 0, 0);
    let r = 0;
    const seq = [0.99, 0.5, 0.0, 0.4, 0.7];
    const obs = new Obstacles(list, { player: () => player, apply: (o, on) => log.push(`${o.id}:${on ? 1 : 0}`), random: () => seq[r++ % seq.length] }, null);
    // Гравець біля A і B — єдиний кандидат C.
    obs.tick();
    expect(obs.active).toBe('C');
    // Гравець біля діючого C — нічого не міняється.
    player = new THREE.Vector3(1900, 0, 0);
    obs.tick();
    expect(obs.active).toBe('C');
    // Гравець далеко від усіх: новий завал далі 500 м від C — A чи B; C вимкнено.
    player = new THREE.Vector3(10000, 0, 0);
    obs.tick();
    expect(['A', 'B']).toContain(obs.active);
    expect(log[0]).toBe('C:1');
    expect(log[1]).toBe('C:0');
  });

  it('період 600…899 с; діючий зі збереження вмикається без тексту', () => {
    const calls: [string, boolean, boolean][] = [];
    const obs = new Obstacles(list, { player: () => new THREE.Vector3(9999, 0, 0), apply: (o, on, ann) => calls.push([o.id, on, ann]), random: () => 0.999 }, 'B');
    expect(calls).toEqual([['B', true, false]]);
    obs.update(898);
    expect(calls).toHaveLength(1);
    obs.update(2);
    expect(calls.length).toBeGreaterThan(1);
  });
});
