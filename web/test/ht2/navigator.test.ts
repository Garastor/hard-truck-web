/** Навігатор HT2: найкоротший шлях по мережі WAY до складу й поворот на розвилці. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads } from '@ht2/world/roads';
import { Navigator } from '@ht2/world/navigator';
import { findStores } from '@ht2/career/economy';
import { toThree } from '@ht2/world/world';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

describe.skipIf(!has)('HT2: навігатор', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);
  const nav = new Navigator(roads);
  const stores = findStores(regions);

  it('від кожного складу є шлях до іншого', () => {
    const target = toThree(...stores[0].center);
    const dist = nav.distances(target);
    for (const s of stores.slice(1)) {
      const at = roads.nearest(toThree(...s.center));
      expect(at, `склад ${s.id}`).not.toBeNull();
      expect(dist.has(at!.line) || dist.has(roads.lines.find((l) => l.name === `${at!.line.name}r`) ?? at!.line), `склад ${s.id}`).toBe(true);
    }
  });

  it('стрілка — лише ліворуч / прямо / праворуч чи нічого', () => {
    const target = toThree(...stores[1].center);
    let shown = 0;
    for (const l of roads.lines.slice(0, 400)) {
      const p = l.pts[0];
      const h = l.pts[1].clone().sub(p).normalize();
      const t = nav.turn(p, h, target);
      expect([null, 'left', 'straight', 'right']).toContain(t);
      if (t) shown++;
    }
    expect(shown).toBeGreaterThan(0);
  });
});
