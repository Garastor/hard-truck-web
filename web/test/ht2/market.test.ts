import { describe, expect, it } from 'vitest';
import { parseSexpr } from '../../src/games/ht2/formats/sexpr';
import { Markets, parseMarkets } from '../../src/games/ht2/career/market';

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

  it('нові — на місцях без прапорців, вживані — на 32, крадені — на 8; стоянка з найменшою кількістю зайнятих', () => {
    const list = parseMarkets([{ sch: SCH }], ways(NODES));
    const trucks = { records: [{ group: 'lorries', carNode: 'ZilR', price: 1000 }], asm: { block: () => ({}) } } as never;
    const m = new Markets(null as never, null as never, trucks, list, () => 0, { forsale: 4, used: 2, stolen: 1 });
    for (const day of [0, 1, 7]) {
      const all = list.flatMap((mk) => m.stock(mk, day).map((s) => ({ s, f: mk.flags[s.spot], mk })));
      const fresh = all.filter((x) => !x.s.used && !x.s.stolen && !x.s.hire);
      expect(fresh).toHaveLength(4);
      // Шукач роботи — окрема машина на вільному звичайному місці ринку (не схованки, не місце-місто), щонайбільше одна.
      for (const mk of list) {
        const hire = m.stock(mk, day).filter((x) => x.hire);
        expect(hire.length).toBeLessThanOrEqual(mk.hidden ? 0 : 1);
        for (const h of hire) expect(mk.flags[h.spot] & 4).toBe(0);
      }
      expect(fresh.every((x) => (x.f & 0x2c) === 0)).toBe(true);
      // Рівномірно: по дві на кожному ринку (місце-місто 4 не займають).
      expect(fresh.filter((x) => x.mk.id === 1)).toHaveLength(2);
      const used = all.filter((x) => x.s.used);
      expect(used.map((x) => x.f)).toEqual([32, 32]);
      expect(used[0].s.price).toBe(650);
      const stolen = all.filter((x) => x.s.stolen);
      expect(stolen.map((x) => x.f)).toEqual([8]);
      expect(stolen[0].s.price).toBe(450);
    }
  });

  it('найнятий водій і куплена машина не повертаються на ринок після збереження й завантаження (soldKeys/restoreSold)', () => {
    const list = parseMarkets([{ sch: SCH }], ways(NODES));
    const trucks = { records: [{ group: 'lorries', carNode: 'ZilR', price: 1000 }], asm: { block: () => ({}) } } as never;
    const make = () => new Markets(null as never, null as never, trucks, list, () => 0, { forsale: 4, used: 2, stolen: 1 });
    const mk = list[0];
    // День, коли на ринку є шукач роботи.
    const day = [0, 1, 2, 3, 4, 5, 6, 7].find((d) => make().stock(mk, d).some((s) => s.hire))!;
    const a = make();
    const hire = a.stock(mk, day).find((s) => s.hire)!;
    const car = a.stock(mk, day).find((s) => !s.hire)!;
    a.sell(mk, day, hire);
    a.sell(mk, day, car);
    a.sell(mk, day - 1, car);
    // Збереження — лише поточний день і далі (вчорашні ринки вже інші).
    const saved = a.soldKeys(day);
    expect(saved).toHaveLength(2);
    const b = make();
    b.restoreSold(JSON.parse(JSON.stringify(saved)));
    expect(b.stock(mk, day).some((s) => s.hire)).toBe(false);
    expect(b.stock(mk, day).some((s) => s.spot === car.spot)).toBe(false);
    // Без відновлення (як було) — водій знову стоїть на ринку.
    expect(make().stock(mk, day).some((s) => s.hire)).toBe(true);
  });
});
