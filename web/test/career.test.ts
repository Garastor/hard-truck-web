/** Економіка кар'єри на реальних вантажівках з TRUCK.TCH. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { decodeCp1251 } from '../src/formats/binary';
import { parseTrucks } from '../src/game/trucks';
import {
  START_MONEY, autoLoad, buyPart, buyTruck, canLoad, cargoValue, cargoWeight, loadGood, newCareer, repair,
  rollMarket, settleTrip, truckSetup, truckSpec, unloadGood,
} from '../src/game/career';

const defs = parseTrucks(decodeCp1251(new Uint8Array(readFileSync('../Game/Hard Truck/TRUCK.TCH'))));
const specs = defs.map(truckSpec);
const fresh = () => newCareer({ name: 'Тест', difficulty: 'sim', rivals: 3, trucks: specs, seed: 42 });
const spec = (i: number) => specs.find((s) => s.index === i)!;

describe('карʼєра', () => {
  it('старт: найдешевша вантажівка (ЗіЛ), стартовий капітал, суперники', () => {
    const c = fresh();
    expect(spec(c.truck).name).toBe('ЗіЛ');
    expect(c.money).toBe(START_MONEY);
    expect(c.drivers.filter((d) => d.ai)).toHaveLength(3);
    expect(c.market).toHaveLength(7);
  });

  it('ринок детермінований і має 4 профілі товарів', () => {
    expect(rollMarket(7)).toEqual(rollMarket(7));
    const many = Array.from({ length: 20 }, (_, i) => rollMarket(i)).flat();
    expect(new Set(many.map((g) => g.variant)).size).toBe(4);
  });

  it('завантаження обмежене грошима, вагою й обʼємом; повернення віддає гроші', () => {
    const c = fresh();
    const s = spec(c.truck);
    const g = c.market[0];
    const n = canLoad(c, s, g);
    expect(n).toBeGreaterThan(0);
    expect(loadGood(c, s, 0, 1000)).toBe(n);
    expect(canLoad(c, s, g)).toBe(0);
    expect(cargoWeight(c)).toBeLessThanOrEqual(s.payload);
    const before = c.money;
    expect(unloadGood(c, 0, 1)).toBe(1);
    expect(c.money).toBe(before + g.price);
  });

  it('автозавантаження порожнього кузова — на половину готівки', () => {
    const c = fresh();
    const money = c.money;
    expect(autoLoad(c, spec(c.truck))).toBeGreaterThan(0);
    expect(cargoValue(c)).toBeLessThanOrEqual(money / 2);
    expect(cargoValue(c)).toBeGreaterThan(money / 4);
  });

  it('комерційний рейс з вантажем дає прибуток; удари бʼють вантаж', () => {
    const run = (hits: number) => {
      const c = fresh();
      autoLoad(c, spec(c.truck));
      const total = c.money + cargoValue(c);
      settleTrip(c, specs, { track: 'COUNT', finished: true, place: 1, racers: 4, time: 300, hits, distance: 5000 });
      return c.money - total;
    };
    expect(run(0)).toBeGreaterThan(0);
    expect(run(80)).toBeLessThan(run(0));
  });

  it('покупка вантажівки: різниця цін має бути меншою за готівку', () => {
    const c = fresh();
    const dear = [...specs].sort((a, b) => b.price - a.price)[0];
    expect(buyTruck(c, specs, dear.index)).toBe('money');
    c.money = 1e6;
    expect(buyTruck(c, specs, dear.index)).toBe('ok');
    expect(c.truck).toBe(dear.index);
  });

  it('запчастини: один раз (шини — щоразу), ФД додає момент, аркада ігнорує вантаж', () => {
    const c = fresh();
    c.money = 1e5;
    expect(buyPart(c, 0)).toBe('ok');
    expect(buyPart(c, 0)).toBe('have');
    c.condition.tires = 0.3;
    expect(buyPart(c, 2)).toBe('ok');
    expect(c.condition.tires).toBe(1);
    loadGood(c, spec(c.truck), 1, 5);
    expect(truckSetup(c, spec(c.truck), 'COUNT').torque).toBeCloseTo(1.2);
    expect(truckSetup(c, spec(c.truck), 'COUNT').cargoMass).toBeGreaterThan(0);
    c.difficulty = 'arcade';
    expect(truckSetup(c, spec(c.truck), 'COUNT').cargoMass).toBeUndefined();
  });

  it('після удару — ремонт за гроші відновлює техстан', () => {
    const c = fresh();
    settleTrip(c, specs, { track: 'CIRCUIT', finished: true, place: 2, racers: 4, time: 200, hits: 50, distance: 6000 });
    expect(c.condition.tech).toBeLessThan(1);
    expect(repair(c, spec(c.truck))).toBe(true);
    expect(c.condition.tech).toBe(1);
  });
});
