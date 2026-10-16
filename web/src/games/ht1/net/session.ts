/**
 * Сесія мережевої гри на 2–4 гравців «зіркою»: кожен гість з'єднаний лише з господарем (обмін кодами — з кожним
 * окремо), господар пересилає між гостями стан машин (пакети каналу `fast` — як є) і події гравців (`pick`,
 * `finish`, `lobby`). Гравців і вибір траси знає господар: розсилає `roster` і `setup`, гості їх лише показують.
 * Номер гравця — місце на старті (0 — господар, гості — 1…3 у порядку приєднання).
 */
import type { CloseReason, NetMessage, NetPeer, NetPlayer } from './peer';

export const MAX_PLAYERS = 4;
/** Скільки гість чекає свого номера від господаря після з'єднання, мс. */
const WELCOME_TIMEOUT = 8000;

export interface SessionEvents {
  /** Змінились гравці чи вибір господаря (траса, погода, суперники). */
  onChange?: () => void;
  /** Подія гри (start, go, ready, finish, lobby) — після обліку сесією. */
  onMessage?: (m: NetMessage) => void;
  /** Пакет стану машин (уже переслано іншим гостям). */
  onFast?: (data: ArrayBuffer) => void;
  /** Гравець відключився; у гостя id 0 — господар, сесію закрито. */
  onLeave?: (id: number, reason: CloseReason) => void;
}

export class NetSession {
  readonly players = new Map<number, NetPlayer>();
  level = 'CIRCUIT';
  rain = false;
  rivals = 0;
  events: SessionEvents = {};
  /** Гравці, що завантажили трасу поточного заїзду (лічить господар). */
  readonly ready = new Set<number>();
  closed = false;
  /** З'єднання: у господаря — з кожним гостем за номером, у гостя — одне, з господарем (номер 0). */
  private readonly links = new Map<number, NetPeer>();

  private constructor(
    readonly host: boolean,
    public myId: number,
    me: NetPlayer,
  ) {
    this.players.set(me.id, me);
  }

  /** Господар: сесія без гостей (гостей додає addGuest). */
  static hostFor(name: string, truck: number): NetSession {
    return new NetSession(true, 0, { id: 0, name, truck, driving: false });
  }

  /** Гість: з'єднання з господарем → чекаємо свого номера й гравців. */
  static join(peer: NetPeer, name: string, truck: number): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const s = new NetSession(false, -1, { id: -1, name, truck, driving: false });
      const timer = window.setTimeout(() => {
        peer.close();
        reject(new Error('Господар не відповів'));
      }, WELCOME_TIMEOUT);
      s.links.set(0, peer);
      s.listen(0, peer, (m) => {
        if (m.t !== 'welcome') return false;
        clearTimeout(timer);
        s.players.delete(-1);
        s.myId = m.id;
        s.players.set(m.id, { id: m.id, name, truck, driving: false });
        peer.send({ t: 'pick', truck, id: m.id });
        resolve(s);
        return true;
      });
    });
  }

  get me(): NetPlayer {
    return this.players.get(this.myId)!;
  }

  get full(): boolean {
    return this.players.size >= MAX_PLAYERS;
  }

  /** Затримка до гравця id, мс (у гостя — до господаря для всіх). */
  rtt(id: number): number | null {
    return (this.links.get(this.host ? id : 0) ?? null)?.rtt ?? null;
  }

  /** З'єднання з гравцем id (для типу зв'язку). */
  link(id: number): NetPeer | null {
    return this.links.get(this.host ? id : 0) ?? null;
  }

  /** Господар: новий гість — найменший вільний номер, вітання, усім — гравці й вибір. */
  addGuest(peer: NetPeer): boolean {
    if (!this.host || this.full) return false;
    let id = 1;
    while (this.players.has(id)) id++;
    this.players.set(id, { id, name: peer.peerName ?? `Водій ${id + 1}`, truck: this.me.truck, driving: false });
    this.links.set(id, peer);
    this.listen(id, peer);
    peer.send({ t: 'welcome', id });
    this.sendSetup();
    this.sendRoster();
    this.events.onChange?.();
    return true;
  }

  /** Подія всім (господар) чи господарю (гість). */
  send(m: NetMessage): void {
    for (const p of this.links.values()) p.send(m);
  }

  sendFast(data: ArrayBuffer): void {
    for (const p of this.links.values()) p.sendFast(data);
  }

  pickTruck(truck: number): void {
    this.me.truck = truck;
    if (this.host) this.sendRoster();
    else this.send({ t: 'pick', truck, id: this.myId });
    this.events.onChange?.();
  }

  /** Господар: траса, погода, суперники. */
  setSetup(level: string, rain: boolean, rivals: number): void {
    this.level = level;
    this.rain = rain;
    this.rivals = rivals;
    this.sendSetup();
    this.events.onChange?.();
  }

  /** Господар: старт заїзду — усім траса, гравці з вантажівками й суперники; усі вважаються на трасі. */
  start(rivals: number[]): NetMessage & { t: 'start' } {
    for (const p of this.players.values()) p.driving = true;
    this.ready.clear();
    this.ready.add(0);
    const m = { t: 'start' as const, level: this.level, rain: this.rain, players: [...this.players.values()].map((p) => ({ ...p })), rivals };
    this.send(m);
    this.sendRoster();
    return m;
  }

  /** Повернувся із заїзду до сесії. */
  backToLobby(): void {
    this.me.driving = false;
    this.send({ t: 'lobby', id: this.myId });
    if (this.host) this.sendRoster();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.links.values()) p.close();
    this.links.clear();
  }

  private sendSetup(): void {
    if (this.host) this.send({ t: 'setup', level: this.level, rain: this.rain, rivals: this.rivals });
  }

  private sendRoster(): void {
    if (this.host) this.send({ t: 'roster', players: [...this.players.values()] });
  }

  /** Події з'єднання з гравцем id; first — обробник до сесійного (вітання гостя). */
  private listen(id: number, peer: NetPeer, first?: (m: NetMessage) => boolean): void {
    peer.events = {
      onFast: (data) => {
        // Господар пересилає стан машини гостя іншим гостям.
        if (this.host) for (const [k, p] of this.links) if (k !== id) p.sendFast(data);
        this.events.onFast?.(data);
      },
      onMessage: (m) => {
        if (first?.(m)) return;
        this.receive(id, m);
      },
      onClose: (reason) => {
        this.links.delete(id);
        if (!this.host) {
          this.closed = true;
          this.events.onLeave?.(0, reason);
          return;
        }
        this.players.delete(id);
        this.ready.delete(id);
        this.sendRoster();
        this.events.onLeave?.(id, reason);
        this.events.onChange?.();
      },
    };
  }

  private receive(from: number, m: NetMessage): void {
    if (this.host) {
      // Від гостя: облік і пересилання іншим гостям (номер — того, від кого прийшло).
      const relay = (x: NetMessage) => {
        for (const [k, p] of this.links) if (k !== from) p.send(x);
      };
      const pl = this.players.get(from);
      if (!pl) return;
      switch (m.t) {
        case 'pick':
          pl.truck = m.truck;
          this.sendRoster();
          this.events.onChange?.();
          return;
        case 'ready':
          this.ready.add(from);
          break;
        case 'finish':
          relay({ ...m, id: from });
          break;
        case 'lobby':
          pl.driving = false;
          relay({ ...m, id: from });
          this.sendRoster();
          this.events.onChange?.();
          break;
        default:
          return;
      }
      this.events.onMessage?.({ ...m, id: from } as NetMessage);
      return;
    }
    // Від господаря.
    switch (m.t) {
      case 'roster': {
        // Свою вантажівку — зі свого вибору: список господаря міг розминутися з нашим pick.
        const mine = this.players.get(this.myId);
        this.players.clear();
        for (const p of m.players) this.players.set(p.id, p);
        if (mine) this.players.set(this.myId, { ...(this.players.get(this.myId) ?? mine), truck: mine.truck });
        this.events.onChange?.();
        return;
      }
      case 'setup':
        this.level = m.level;
        this.rain = m.rain;
        this.rivals = m.rivals;
        this.events.onChange?.();
        return;
      case 'start':
        for (const p of this.players.values()) p.driving = true;
        break;
      case 'lobby': {
        const p = this.players.get(m.id);
        if (p) p.driving = false;
        break;
      }
      case 'go':
      case 'finish':
        break;
      default:
        return;
    }
    this.events.onMessage?.(m);
  }
}
