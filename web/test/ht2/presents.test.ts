import { describe, expect, it } from 'vitest';
import { parseSexpr } from '../../src/games/ht2/formats/sexpr';
import { fuelNodes, semiKinds } from '../../src/games/ht2/vehicles/presents';

describe('напівпричепи-presents HT2 (evehicles.sch, mod_*.sch)', () => {
  it('типи напівпричепів: модель, кластер, прапорець цистерни', () => {
    const sch = parseSexpr(`(
      ( vehicle  SEMITANK2  "STrailerT"  1  semitrailer  none  0  101 () 1 )
      ( vehicle  SEMITRAILER3  "STrailerM"  2  semitrailer  none  0  101 ())
      ( vehicle  RENAULT_TRACTOR1  "Renault"  0  tractor  trucker  95000  470 ( SEMITRAILER1 )))`)[0] as never;
    expect(semiKinds(sch)).toEqual([
      { id: 'SEMITANK2', carNode: 'STrailerT', cluster: 1, tank: true },
      { id: 'SEMITRAILER3', carNode: 'STrailerM', cluster: 2, tank: false },
    ]);
  });

  it('газгольдери — вузли fuel без unload (АЗС пропускаємо)', () => {
    const sch = parseSexpr(`(
      ( town TOWN_BB_FUEL "" 12 () (( node "" dummy ) ( node "gasholder_BB" fuel ))() (( FUEL 0 )) ( 5000 ))
      ( town X "" 0 () (( node "node_car_fuel_ac" unload fuel ))()()))`)[0] as never;
    expect([...fuelNodes([{ sch }])]).toEqual(['gasholder_bb']);
  });
});
