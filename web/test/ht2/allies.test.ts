/** Мережева кар'єра «Союзники» (career/allies.ts): спільна компанія, журнал змін, частка, годинник доби. */
import { describe, expect, it } from 'vitest';
import { AllyLedger, alliedShare, allyCareer, applyOp, dayOffset, memberOf, stateOf, type AllyOp } from '@ht2/career/allies';
import { newCareer, type Ht2Career } from '@ht2/career/career';
import { netMarketShare } from '@ht2/career/share';
import type { HiredDriver } from '@ht2/career/company';

const driver = (name: string): HiredDriver => ({ name, truck: 'Mack', tariff: 1, photo: 0, km: 0, advance: 0, profit: 0, v: 2 });

/** Сервер і гість з однією компанією; ops — «мережа» гість → сервер. */
function setup() {
  const host: Ht2Career = { ...newCareer('Олег', 'RenaultR'), net: true, allied: true, allies: {}, money: 10000, licences: [5000, 9000] };
  const guest = allyCareer({ state: stateOf(host), members: {} }, 'Іра', 'VolvoR', 2);
  const ledger = new AllyLedger(stateOf(host));
  const acks: Record<number, number> = {};
  const send = () => {
    const op = ledger.collect(guest);
    if (op) applyOp(host, acks, 1, op);
    return op;
  };
  const sync = () => ledger.receive(guest, stateOf(host, acks), 1);
  return { host, guest, ledger, acks, send, sync };
}

describe('союзники: спільна компанія', () => {
  it('кар’єра гостя — компанія сервера, своя машина; без id (гість не зберігає)', () => {
    const { guest, host } = setup();
    expect(guest).toMatchObject({ driver: 'Іра', truck: 'VolvoR', paint: 2, money: 10000, ally: true, net: true });
    expect(guest.id).toBeUndefined();
    expect(guest.licences).toEqual(host.licences);
    // Особисте зі збереження сервера — поверх нової машини.
    host.allies!['Іра'] = { truck: 'Daf', damage: 0.3, pos: [1, 2, 3] };
    const back = allyCareer({ state: stateOf(host), members: host.allies! }, 'Іра', 'VolvoR', 0);
    expect(back).toMatchObject({ truck: 'Daf', damage: 0.3, pos: [1, 2, 3], money: 10000 });
  });

  it('гроші: прирости гостя й сервера складаються; повтор тієї самої зміни сервер не рахує', () => {
    const { host, guest, acks, send, sync } = setup();
    guest.money += 2500; // доставка гостя
    const op = send()!;
    host.money -= 700; // сервер заправився
    sync();
    expect(guest.money).toBe(11800);
    expect(host.money).toBe(11800);
    expect(applyOp(host, acks, 1, op)).toBe(false);
    expect(host.money).toBe(11800);
  });

  it('стан сервера раніше за свою зміну: невраховані прирости гостя — поверх', () => {
    const { host, guest, ledger } = setup();
    guest.money += 1000;
    const op = ledger.collect(guest)!;
    // Сервер ще не застосував (ack 0) — гість бачить 10000 + 1000.
    ledger.receive(guest, stateOf(host, {}), 1);
    expect(guest.money).toBe(11000);
    applyOp(host, {}, 1, op);
    ledger.receive(guest, stateOf(host, { 1: op.seq }), 1);
    expect(guest.money).toBe(11000);
    expect(ledger.collect(guest)).toBeNull();
  });

  it('найм і ліцензії гостя: водій у спільній компанії, витрачена ліцензія — та сама; прострочена двічі не знімає чинну', () => {
    const { host, guest, send, sync } = setup();
    // Гість найняв (бере найранішу ліцензію) і купив ще одну.
    guest.company = [...(guest.company ?? []), driver('Петро')];
    guest.licences = [9000, 12000];
    const op = send() as AllyOp;
    expect(op).toMatchObject({ hire: [{ name: 'Петро' }], fire: [], licAdd: [12000], licDel: [5000] });
    expect(host.company?.map((d) => d.name)).toEqual(['Петро']);
    expect(host.licences).toEqual([9000, 12000]);
    sync();
    // Ліцензія 9000 прострочилась: сервер прибрав сам, гість — теж; чинна 12000 лишається.
    host.licences = [12000];
    guest.licences = [12000];
    send();
    expect(host.licences).toEqual([12000]);
    // Звільнення сервером видно гостю.
    host.company = [];
    sync();
    expect(guest.company).toEqual([]);
  });

  it('тонни й доставки компанії — сума всіх союзників', () => {
    const { host, guest, send, sync } = setup();
    guest.tons = (guest.tons ?? 0) + 12;
    guest.delivered += 1;
    send();
    host.tons = (host.tons ?? 0) + 5;
    sync();
    expect(guest.tons).toBe(17);
    expect(guest.delivered).toBe(1);
  });

  it('особисте союзника — лише його машина й справи, без грошей компанії', () => {
    const m = memberOf({ ...newCareer('Іра', 'ZilR'), damage: 0.2, money: 999 });
    expect(m).toMatchObject({ truck: 'ZilR', damage: 0.2 });
    expect('money' in m).toBe(false);
  });
});

describe('союзники: частка ринку', () => {
  it('одна на компанію: наймані — раз, у всіх однакова; дорівнює сумі часток суперництва', () => {
    const host = { load: 20000 + 15000, hired: 1 };
    const guest = { load: 12000, hired: 0 };
    const x = alliedShare([host, guest], 14000);
    expect(alliedShare([guest, host], 14000)).toBeCloseTo(x);
    expect(x).toBeCloseTo(netMarketShare(host, [guest], 14000) + netMarketShare(guest, [host], 14000));
  });
});

describe('суперництво: година доби сервера', () => {
  it('зсув — у межах ±12 год, після нього година та сама', () => {
    for (const [h, m] of [
      [10 * 3600, 20 * 3600],
      [5 * 86400 + 23 * 3600, 2 * 86400 + 3600],
      [3600, 3600],
    ]) {
      const off = dayOffset(h, m);
      expect(Math.abs(off)).toBeLessThanOrEqual(43200);
      expect((((m + off) % 86400) + 86400) % 86400).toBeCloseTo(h % 86400);
    }
  });
});
