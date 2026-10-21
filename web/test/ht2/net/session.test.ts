import { describe, expect, it, vi } from 'vitest';
import type { CloseReason, NetMessage, NetPeer, NetPeerEvents } from '../../../src/games/ht2/net/peer';
import { MAX_PLAYERS, NetSession } from '../../../src/games/ht2/net/session';
import { emptyState, packFleet, unpackFleet } from '../../../src/games/ht2/net/state';

/** Підставне з'єднання в пам'яті: два кінці, повідомлення — одразу іншому кінцю (як канали WebRTC, по порядку). */
class FakePeer {
  other!: FakePeer;
  peerName: string | null;
  rtt = 5;
  open = true;
  private ev: NetPeerEvents = {};
  private readonly pending: NetMessage[] = [];
  constructor(name: string) {
    this.peerName = name;
  }
  get events(): NetPeerEvents {
    return this.ev;
  }
  set events(e: NetPeerEvents) {
    this.ev = e;
    if (e.onMessage) for (const m of this.pending.splice(0)) e.onMessage(m);
  }
  send(m: NetMessage): void {
    const o = this.other;
    const copy = JSON.parse(JSON.stringify(m)) as NetMessage;
    if (o.ev.onMessage) o.ev.onMessage(copy);
    else o.pending.push(copy);
  }
  sendFast(d: ArrayBuffer): void {
    this.other.ev.onFast?.(d);
  }
  close(reason: CloseReason = 'bye'): void {
    if (!this.open) return;
    this.open = false;
    this.other.open = false;
    this.other.ev.onClose?.(reason);
    this.ev.onClose?.('local');
  }
}

/** Пара: кінець господаря (ім'я — гостя) і кінець гостя (ім'я — господаря). */
function pair(hostName: string, guestName: string): [NetPeer, NetPeer] {
  const h = new FakePeer(guestName);
  const g = new FakePeer(hostName);
  h.other = g;
  g.other = h;
  return [h as unknown as NetPeer, g as unknown as NetPeer];
}

const ZIL = { truck: 'ZilR', color: 0 };
const KAMAZ = { truck: 'KamazR', color: 2 };
const MACK = { truck: 'Mack', color: 1 };

async function threeWay() {
  vi.stubGlobal('window', globalThis);
  const host = NetSession.hostFor('Олег', ZIL);
  const [h1, g1] = pair('Олег', 'Іра');
  host.addGuest(h1);
  const ira = await NetSession.join(g1, 'Іра', KAMAZ);
  const [h2, g2] = pair('Олег', 'Тарас');
  host.addGuest(h2);
  const taras = await NetSession.join(g2, 'Тарас', MACK);
  return { host, ira, taras, h1, g1, h2, g2 };
}

describe('сесія мережевої гри HT2', () => {
  it('гостям — номери за порядком; список гравців з машинами й кольорами в усіх однаковий', async () => {
    const { host, ira, taras } = await threeWay();
    expect(ira.myId).toBe(1);
    expect(taras.myId).toBe(2);
    const view = (s: NetSession) => [...s.players.values()].sort((a, b) => a.id - b.id).map((p) => `${p.id}:${p.name}:${p.truck}:${p.color}`);
    expect(view(host)).toEqual(['0:Олег:ZilR:0', '1:Іра:KamazR:2', '2:Тарас:Mack:1']);
    expect(view(ira)).toEqual(view(host));
    expect(view(taras)).toEqual(view(host));
    // Гість змінив машину й колір — бачать усі (через господаря).
    ira.pickCar({ truck: 'Freightliner', color: 3 });
    expect(taras.players.get(1)).toMatchObject({ truck: 'Freightliner', color: 3 });
  });

  it('вибір екрана «Сервер» і старт — усім; готовність гостей лічить господар', async () => {
    const { host, ira, taras } = await threeWay();
    host.setSetup({ track: 'trial', arcade: true, traffic: 0.2, dayLength: 0.7, weather: 0.9 });
    expect(ira.setup).toEqual({ track: 'trial', arcade: true, traffic: 0.2, dayLength: 0.7, weather: 0.9 });
    const got: NetMessage[] = [];
    taras.events = { onMessage: (m) => got.push(m) };
    host.start([{ truck: 'Volvo', color: 1 }]);
    expect(got[0]).toMatchObject({ t: 'start', setup: { track: 'trial' }, rivals: [{ truck: 'Volvo', color: 1 }] });
    expect((got[0] as { players: unknown[] }).players).toHaveLength(3);
    ira.send({ t: 'ready', id: ira.myId });
    taras.send({ t: 'ready', id: taras.myId });
    expect([...host.ready].sort()).toEqual([0, 1, 2]);
  });

  it('стан машин господар збирає й шле кожному гостю одним пакетом; фініш — пересилає, з номером', async () => {
    const { host, ira, taras } = await threeWay();
    const fast: number[][] = [];
    const msgs: NetMessage[] = [];
    taras.events = { onFast: (d) => fast.push(unpackFleet(d)!.map((c) => c.id)), onMessage: (m) => msgs.push(m) };
    const iraFast: number[][] = [];
    ira.events = { onFast: (d) => iraFast.push(unpackFleet(d)!.map((c) => c.id)) };
    const car = (time: number) => Object.assign(emptyState(), { time });
    ira.sendFast(packFleet([{ id: 1, s: car(1) }]));
    expect(fast).toEqual([]);
    host.sendFast(packFleet([{ id: 0, s: car(5) }, { id: 16, s: car(5) }]));
    expect(fast).toEqual([[1, 0, 16]]);
    expect(iraFast).toEqual([[0, 16]]);
    ira.send({ t: 'finish', time: 90, place: 2, id: 99 });
    expect(msgs[0]).toMatchObject({ t: 'finish', time: 90, id: 1 });
    host.close();
  });

  it('гість відключився — зникає зі списку в усіх; господар вийшов — сесію закрито', async () => {
    const { host, taras, g1, h2 } = await threeWay();
    const left: number[] = [];
    host.events = { onLeave: (id) => left.push(id) };
    (g1 as unknown as FakePeer).close('lost');
    expect(left).toEqual([1]);
    expect([...taras.players.keys()].sort()).toEqual([0, 2]);
    let closed = -1;
    taras.events = { onLeave: (id) => (closed = id) };
    (h2 as unknown as FakePeer).close('bye');
    expect(closed).toBe(0);
    expect(taras.closed).toBe(true);
  });

  it('звʼязок гостя завис і відновився (М5): сервер позначає його в списку для всіх, сесія живе', async () => {
    const { host, taras, h1 } = await threeWay();
    const seen: [number, boolean][] = [];
    host.events = { onStall: (id, s) => seen.push([id, s]) };
    const fake = h1 as unknown as FakePeer;
    fake.events.onStall?.(true);
    expect(seen).toEqual([[1, true]]);
    expect(host.players.get(1)?.stalled).toBe(true);
    expect(taras.players.get(1)?.stalled).toBe(true);
    expect(host.players.has(1)).toBe(true);
    fake.events.onStall?.(false);
    expect(seen.at(-1)).toEqual([1, false]);
    expect(taras.players.get(1)?.stalled).toBe(false);
    host.close();
  });

  it('господар і не більше 7 гостей (8 місць решітки king.exe)', async () => {
    const { host } = await threeWay();
    expect(MAX_PLAYERS).toBe(8);
    for (let i = 3; i < MAX_PLAYERS; i++) {
      const [h, g] = pair('Олег', `Гість ${i}`);
      expect(host.addGuest(h)).toBe(true);
      expect((await NetSession.join(g, `Гість ${i}`, ZIL)).myId).toBe(i);
    }
    expect(host.full).toBe(true);
    const [hx] = pair('Олег', 'Зайвий');
    expect(host.addGuest(hx)).toBe(false);
    host.close();
  });
});
