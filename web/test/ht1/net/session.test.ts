import { describe, expect, it, vi } from 'vitest';
import type { CloseReason, NetMessage, NetPeer, NetPeerEvents } from '../../../src/games/ht1/net/peer';
import { NetSession } from '../../../src/games/ht1/net/session';

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

async function threeWay() {
  vi.stubGlobal('window', globalThis);
  const host = NetSession.hostFor('Олег', 1);
  const [h1, g1] = pair('Олег', 'Іра');
  host.addGuest(h1);
  const ira = await NetSession.join(g1, 'Іра', 2);
  const [h2, g2] = pair('Олег', 'Тарас');
  host.addGuest(h2);
  const taras = await NetSession.join(g2, 'Тарас', 4);
  return { host, ira, taras, h1, g1, h2, g2 };
}

describe('сесія мережевої гри на кількох гравців', () => {
  it('гостям — номери за порядком; список гравців з вантажівками в усіх однаковий', async () => {
    const { host, ira, taras } = await threeWay();
    expect(ira.myId).toBe(1);
    expect(taras.myId).toBe(2);
    const view = (s: NetSession) => [...s.players.values()].sort((a, b) => a.id - b.id).map((p) => `${p.id}:${p.name}:${p.truck}`);
    expect(view(host)).toEqual(['0:Олег:1', '1:Іра:2', '2:Тарас:4']);
    expect(view(ira)).toEqual(view(host));
    expect(view(taras)).toEqual(view(host));
    // Гість змінив вантажівку — бачать усі (через господаря).
    ira.pickTruck(7);
    expect(taras.players.get(1)!.truck).toBe(7);
  });

  it('вибір господаря й старт — усім; готовність гостей лічить господар', async () => {
    const { host, ira, taras } = await threeWay();
    host.setSetup('NIGHT', true, 3);
    expect([ira.level, ira.rain, ira.rivals]).toEqual(['NIGHT', true, 3]);
    const got: NetMessage[] = [];
    taras.events = { onMessage: (m) => got.push(m) };
    host.start([5, 6, 7]);
    expect(got[0]).toMatchObject({ t: 'start', level: 'NIGHT', rivals: [5, 6, 7] });
    expect((got[0] as { players: unknown[] }).players).toHaveLength(3);
    ira.send({ t: 'ready', id: ira.myId });
    taras.send({ t: 'ready', id: taras.myId });
    expect([...host.ready].sort()).toEqual([0, 1, 2]);
  });

  it('стан машини гостя господар пересилає іншим гостям; фініш — теж, з номером', async () => {
    const { host, ira, taras } = await threeWay();
    const fast: ArrayBuffer[] = [];
    const msgs: NetMessage[] = [];
    taras.events = { onFast: (d) => fast.push(d), onMessage: (m) => msgs.push(m) };
    const hostFast: ArrayBuffer[] = [];
    host.events = { onFast: (d) => hostFast.push(d) };
    const buf = new ArrayBuffer(8);
    ira.sendFast(buf);
    expect(fast).toEqual([buf]);
    expect(hostFast).toEqual([buf]);
    ira.send({ t: 'finish', time: 90, place: 2, id: 99 });
    // Номер — того, від кого прийшло (не з повідомлення).
    expect(msgs[0]).toMatchObject({ t: 'finish', time: 90, id: 1 });
  });

  it('гість відключився — зникає зі списку в усіх; господар вийшов — сесію закрито', async () => {
    const { host, ira, taras, g1, h2 } = await threeWay();
    const left: number[] = [];
    host.events = { onLeave: (id) => left.push(id) };
    (g1 as unknown as FakePeer).close('lost');
    expect(left).toEqual([1]);
    expect([...host.players.keys()]).toEqual([0, 2]);
    expect([...taras.players.keys()].sort()).toEqual([0, 2]);
    expect(ira).toBeTruthy();
    // Номер звільнився — новий гість отримує 1.
    const [h3, g3] = pair('Олег', 'Ліна');
    host.addGuest(h3);
    const lina = await NetSession.join(g3, 'Ліна', 3);
    expect(lina.myId).toBe(1);
    let closed = -1;
    taras.events = { onLeave: (id) => (closed = id) };
    (h2 as unknown as FakePeer).close('bye');
    expect(closed).toBe(0);
    expect(taras.closed).toBe(true);
  });

  it('не більше 4 гравців', async () => {
    const { host } = await threeWay();
    const [h3, g3] = pair('Олег', 'Ліна');
    expect(host.addGuest(h3)).toBe(true);
    await NetSession.join(g3, 'Ліна', 3);
    expect(host.full).toBe(true);
    const [h4] = pair('Олег', 'Зайвий');
    expect(host.addGuest(h4)).toBe(false);
  });
});
