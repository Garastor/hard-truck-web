import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { parseSexpr } from '../../src/games/ht2/formats/sexpr';
import { DEALERS_PERIOD, Markets, SEEKER_WAIT, SEEKER_WAIT_RAND, carValue, parseMarkets, type Market } from '../../src/games/ht2/career/market';

/** Вузли WAY з іменами (координати — будь-які). */
function ways(names: string[]) {
  return [{ way: { rooms: [{ nodes: names.map((name, i) => ({ name, pos: [i * 10, 0, 0] })), segments: [] }] } }] as never;
}

const SCH = parseSexpr(`(
  ( parking MARKET_AJ "Барахолка" 1 () (( node "c0" ) ( node "c1" ) ( node "c2" ) ( node "c3" 4 "Приозерск" )) 10 )
  ( parking MARKET_D "Базар" 3 () (( node "d0" ) ( node "d1" )) 4 )
  ( parking PARKING_AE_2 "" -1 () (( node "hidden_car_ae_23" 8 ) ( node "old_car_ae_16" 32 )))
  ( parking PARKING_AJ_1 "" -1 () (( node "old_car_aj_38" 32 )))
  ( parking PARKING_BA "" -1 () (( node "node_stolen_ba0" 8 ))))`)[0] as never;
const NODES = ['c0', 'c1', 'c2', 'c3', 'd0', 'd1', 'hidden_car_ae_23', 'old_car_ae_16', 'old_car_aj_38', 'node_stolen_ba0'];

describe('ринки й стоянки-схованки HT2 (parking у mod_*.sch, king.exe 0x456460)', () => {
  it('стоянки з номером −1 — схованки з прапорцями місць', () => {
    const list = parseMarkets([{ sch: SCH }], ways(NODES));
    expect(list.map((m) => [m.id, m.hidden, m.flags])).toEqual([
      [1, false, [0, 0, 0, 4]],
      [3, false, [0, 0]],
      [1000, true, [8, 32]],
      [1001, true, [32]],
      [1002, true, [8]],
    ]);
    expect(list[0].townSpot).toBe(3);
  });

  /** Ринки зі зерном випадковості (mulberry32) і далекобійниками names. */
  function make(limits = { forsale: 4, used: 2, stolen: 1 }, names = ['А', 'Б', 'В'], seed = 7) {
    const list = parseMarkets([{ sch: SCH }], ways(NODES));
    const trucks = { records: [{ group: 'lorries', carNode: 'ZilR', price: 1000 }, { group: 'tractors', carNode: 'DafT', price: 2000 }], asm: { block: () => ({}) } } as never;
    let a = seed;
    const rnd = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const m = new Markets(null as never, null as never, trucks, list, () => 0, limits, rnd);
    const hired: string[] = [];
    m.hirable = () => names.filter((n) => !hired.includes(n));
    return { m, list, hired };
  }
  const all = (m: Markets, list: Market[]) => list.flatMap((mk) => m.stock(mk).map((s) => ({ s, f: mk.flags[s.spot], mk })));
  const FAR = new THREE.Vector3(10000, 0, 10000);
  const NEAR = new THREE.Vector3(0, 0, 0);

  it('старт (і старе збереження без стоянок): нові — на місцях без прапорців, вживані — на 32, крадені — на 8; стоянка з найменшою кількістю зайнятих', () => {
    const { m, list } = make();
    m.forhire = 1;
    m.restore(undefined);
    const xs = all(m, list);
    const fresh = xs.filter((x) => !x.s.used && !x.s.stolen && !x.s.hire);
    expect(fresh).toHaveLength(4);
    expect(fresh.every((x) => (x.f & 0x2c) === 0)).toBe(true);
    // Рівномірно: по дві на кожному ринку (місце-місто 4 не займають).
    expect(fresh.filter((x) => x.mk.id === 1)).toHaveLength(2);
    const used = xs.filter((x) => x.s.used);
    expect(used.map((x) => x.f)).toEqual([32, 32]);
    expect(used[0].s.price).toBe(carValue(used[0].s.rec.price, { used: true }));
    const stolen = xs.filter((x) => x.s.stolen);
    expect(stolen.map((x) => x.f)).toEqual([8]);
    expect(stolen[0].s.price).toBe(Math.round(stolen[0].s.rec.price * 0.45));
    // Шукач роботи — окрема машина на вільному звичайному місці ринку (не схованки, не місце-місто), з іменем.
    const hire = xs.filter((x) => x.s.hire);
    expect(hire).toHaveLength(1);
    expect(hire[0].f & 0x2c).toBe(0);
    expect(['А', 'Б', 'В']).toContain(hire[0].s.name);
  });

  it('updateDealers раз на 27,5 с: старі (> 900…1019 с) далі 2 км зникають, на їхнє місце — нові; поруч гравця — не чіпає', () => {
    const { m } = make();
    m.forhire = 0;
    m.restore(undefined);
    expect(m.tick(DEALERS_PERIOD - 1, FAR)).toBe(false);
    // Гравець поруч ринків: нікого не прибирають, нових далі 700 м поставити нікуди.
    for (let t = 0; t < 1100; t += 10) m.tick(10, NEAR);
    expect(m.state.cars.every((c) => c.born === 0)).toBe(true);
    // Гравець далеко: усі простояли довше 1019 с — нові машини (новий вік), кількість та сама.
    m.state.timer = 0;
    expect(m.tick(1, FAR)).toBe(true);
    expect(m.state.cars).toHaveLength(7);
    expect(m.state.cars.every((c) => c.born === m.state.clock)).toBe(true);
  });

  it('найнятий водій зникає з місця, згодом зʼявляється інший (ще не найнятий); відчеклий іде, коли пул повний', () => {
    const { m, list, hired } = make({ forsale: 0, used: 0, stolen: 0 }, ['А', 'Б']);
    m.forhire = 1;
    m.restore(undefined);
    const mk = list.find((x) => m.stock(x).some((s) => s.hire))!;
    const seeker = m.stock(mk).find((s) => s.hire)!;
    hired.push(seeker.name!);
    m.sell(mk, seeker);
    expect(all(m, list).some((x) => x.s.hire)).toBe(false);
    m.state.timer = 0;
    m.tick(1, FAR);
    const next = all(m, list).filter((x) => x.s.hire);
    expect(next).toHaveLength(1);
    expect(next[0].s.name).not.toBe(seeker.name);
    // Чекає 1200…2699 с; потім іде (пул повний: 1 > forhire − 2), гравець поруч — нового не ставлять.
    const until = m.state.cars[0].until!;
    expect(until - m.state.clock).toBeGreaterThanOrEqual(SEEKER_WAIT);
    expect(until - m.state.clock).toBeLessThan(SEEKER_WAIT + SEEKER_WAIT_RAND);
    while (m.state.clock < until) m.tick(10, NEAR);
    m.state.timer = 0;
    m.tick(1, NEAR);
    expect(m.state.cars).toHaveLength(0);
  });

  it('купівля: стара машина гравця лишається на місці купленої (ціна з пошкодженням), переживає збереження й пізніше замінюється', () => {
    const { m, list } = make({ forsale: 4, used: 0, stolen: 0 });
    m.forhire = 0;
    m.restore(undefined);
    const mk = list[0];
    const bought = m.stock(mk)[0];
    m.sell(mk, bought, { carNode: 'DafT', cluster: 2, damage: 0.1, stolen: false });
    const left = m.stock(mk).find((s) => s.spot === bought.spot)!;
    expect(left.rec.carNode).toBe('DafT');
    expect(left.cluster).toBe(2);
    expect(left.damage).toBe(0.1);
    expect(left.price).toBe(2000 - 500);
    expect(carValue(1000, { stolen: true, damage: 0.5 })).toBe(0);
    // Збереження й завантаження — машина там само.
    const b = make({ forsale: 4, used: 0, stolen: 0 });
    b.m.restore(JSON.parse(JSON.stringify(m.state)));
    expect(b.m.stock(mk).find((s) => s.spot === bought.spot)?.rec.carNode).toBe('DafT');
    // Простояла свій строк (вік продавця — від його появи), гравець далеко — замінюється новою.
    b.m.state.clock = 1100;
    b.m.state.timer = 0;
    b.m.tick(1, FAR);
    expect(b.m.state.cars.some((c) => c.traded)).toBe(false);
    expect(b.m.state.cars.filter((c) => c.group === 0)).toHaveLength(4);
  });
});
