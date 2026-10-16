import { START_MONEY, type Ht2Career } from './career';

/**
 * Частка капіталу гравця серед усіх гравців (king.exe 0x41fcf0: `+0x308` — капітал гравця разом із найманими
 * водіями, `+0x300` — частка = капітал / сума капіталів усіх гравців; re/notes/ht2/mafia.md §1). Від частки
 * залежать: інтерес мафії (> 0,15, 0x4297f0), засідки мафії (> 0,2, 0x429820), прихований нелегальний товар у
 * замовленнях (> 0,25, fillTownOrder).
 *
 * Гіпотеза порту: капітал = гроші + вартість машин (своєї й найманих водіїв, vehicle.tech `price`); порт не веде
 * капіталу суперників — кожен із RIVALS (GAME.CNF `aitruck 50`) має стартовий капітал гравця: START_MONEY + ціна
 * стартової машини.
 */
export const RIVALS = 50;

/** Капітал гравця: гроші, своя машина (куплена — за ціною купівлі), машини найманих водіїв. */
export function capitalOf(c: Ht2Career, price: (carNode: string) => number): number {
  const own = c.truckPrice ?? price(c.truck);
  const hired = (c.company ?? []).reduce((s, d) => s + price(d.truck), 0);
  return Math.max(0, c.money) + own + hired;
}

/** Частка капіталу гравця 0…1; startTruck — машина, з якої починають суперники. */
export function capitalShare(c: Ht2Career, price: (carNode: string) => number, startTruck: string, rivals = RIVALS): number {
  const mine = capitalOf(c, price);
  const others = rivals * (START_MONEY + price(startTruck));
  return mine + others > 0 ? mine / (mine + others) : 0;
}
