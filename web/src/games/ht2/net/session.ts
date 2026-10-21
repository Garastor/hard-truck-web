/**
 * Сесія мережевої гри на 2–8 гравців «зіркою»: кожен гість з'єднаний лише з господарем (обмін кодами — з кожним
 * окремо), господар збирає стан машин усіх гравців і шле кожному гостю один пакет з рештою машин (FleetMixer), а
 * події гравців (`pick`, `finish`, `lobby`) пересилає. Гравців і вибір траси знає господар: розсилає `roster` і
 * `setup`, гості їх лише показують. Номер гравця — місце на старті (0 — господар, гості — 1…7 у порядку приєднання).
 * Перенесено з першої гри (games/ht1/net/session.ts) — та сама будова, інші поля вибору й машини.
 */
import { DEFAULT_SETUP, type CloseReason, type NetCar, type NetMessage, type NetPeer, type NetPlayer, type NetSetup } from './peer';
import { FleetMixer, STATE_RATE } from './state';

/**
 * Господар і до 7 гостей: у king.exe 8 місць на решітці (`start1_1…8`), таблиця F2 мережевої гри — 8 рядків
 * (`BackF2Tball`, re/notes/ht2/tracks.md §3).
 */
export const MAX_PLAYERS = 8;
/** Скільки гість чекає свого номера від господаря після з'єднання, мс. */
const WELCOME_TIMEOUT = 8000;
/** Без власних пакетів господаря довше за це (мс) — він не на трасі, машини гостей розсилає таймер. */
const OWN_SILENT = 200;

export interface SessionEvents {
  /** Змінились гравці чи вибір господаря. */
  onChange?: () => void;
  /** Подія гри (start, go, ready, finish, lobby) — після обліку сесією. */
  onMessage?: (m: NetMessage) => void;
  /** Пакет стану машин (уже переслано іншим гостям). */
  onFast?: (data: ArrayBuffer) => void;
  /** Гравець відключився; у гостя id 0 — господар, сесію закрито. */
  onLeave?: (id: number, reason: CloseReason) => void;
  /**
   * Зв'язок із гравцем id завис (true) чи відновився (false), без нових кодів (М5). У гостя — лише з сервером (id 0);
   * про інших гостей — поле `stalled` у списку гравців від сервера (onChange).
   */
  onStall?: (id: number, stalled: boolean) => void;
}

export class NetSession {
  readonly players = new Map<number, NetPlayer>();
  setup: NetSetup = { ...DEFAULT_SETUP };
  events: SessionEvents = {};
  /** Гравці, що завантажили трасу поточного заїзду (лічить господар). */
  readonly ready = new Set<number>();
  closed = false;
  /** З'єднання: у господаря — з кожним гостем за номером, у гостя — одне, з господарем (номер 0). */
  private readonly links = new Map<number, NetPeer>();
  /** Господар: найновіші стани машин для гостей; розсилка — зі своїм пакетом чи, якщо свого немає, за таймером. */
  private readonly mixer = new FleetMixer();
  private relayTimer = 0;
  /** Коли господар востаннє слав свій пакет (він на трасі — розсилка з ним, таймер мовчить), мс. */
  private lastOwn = -Infinity;

  private constructor(
    readonly host: boolean,
    public myId: number,
    me: NetPlayer,
  ) {
    this.players.set(me.id, me);
  }

  /** Господар: сесія без гостей (гостей додає addGuest); вибір — з екрана «Сервер». */
  static hostFor(name: string, car: NetCar, setup: NetSetup = DEFAULT_SETUP): NetSession {
    const s = new NetSession(true, 0, { id: 0, name, ...car, driving: false });
    s.setup = { ...setup };
    return s;
  }

  /** Гість: з'єднання з господарем → чекаємо свого номера й гравців. */
  static join(peer: NetPeer, name: string, car: NetCar): Promise<NetSession> {
    return new Promise((resolve, reject) => {
      const s = new NetSession(false, -1, { id: -1, name, ...car, driving: false });
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
        s.players.set(m.id, { id: m.id, name, ...car, driving: false });
        peer.send({ t: 'pick', ...car, id: m.id });
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
    this.players.set(id, { id, name: peer.peerName ?? `Водій ${id + 1}`, truck: this.me.truck, color: id % 4, driving: false });
    this.links.set(id, peer);
    this.listen(id, peer);
    // Господар не на трасі (власних пакетів немає) — машини гостей однаково розсилаються.
    this.relayTimer ||= window.setInterval(() => {
      if (performance.now() - this.lastOwn > OWN_SILENT) this.relay();
    }, 1000 / STATE_RATE);
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

  /** Свій пакет машин: гість — господарю; господар — разом з машинами гостей, кожному гостю один пакет. */
  sendFast(data: ArrayBuffer): void {
    if (!this.host) {
      for (const p of this.links.values()) p.sendFast(data);
      return;
    }
    this.lastOwn = performance.now();
    this.mixer.add(data);
    this.relay();
  }

  /** Господар: оновлені машини — гостям (кожному без його власної). */
  relay(): void {
    this.mixer.flush(this.links.keys(), (to, d) => this.links.get(to)?.sendFast(d));
  }

  /** Своя машина (car_node і колір). */
  pickCar(car: NetCar): void {
    Object.assign(this.me, car);
    if (this.host) this.sendRoster();
    else this.send({ t: 'pick', ...car, id: this.myId });
    this.events.onChange?.();
  }

  /** Господар: вибір екрана «Сервер». */
  setSetup(setup: NetSetup): void {
    this.setup = { ...setup };
    this.sendSetup();
    this.events.onChange?.();
  }

  /** Господар: старт заїзду — усім вибір, гравці з машинами й суперники; усі вважаються на трасі. */
  start(rivals: NetCar[]): NetMessage & { t: 'start' } {
    for (const p of this.players.values()) p.driving = true;
    this.ready.clear();
    this.ready.add(0);
    const m = { t: 'start' as const, setup: { ...this.setup }, players: [...this.players.values()].map((p) => ({ ...p })), rivals };
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
    clearInterval(this.relayTimer);
    for (const p of this.links.values()) p.close();
    this.links.clear();
  }

  private sendSetup(): void {
    if (this.host) this.send({ t: 'setup', setup: this.setup });
  }

  private sendRoster(): void {
    if (this.host) this.send({ t: 'roster', players: [...this.players.values()] });
  }

  /** Події з'єднання з гравцем id; first — обробник до сесійного (вітання гостя). */
  private listen(id: number, peer: NetPeer, first?: (m: NetMessage) => boolean): void {
    peer.events = {
      onFast: (data) => {
        // Господар запам'ятовує стан машини гостя для інших гостей (relay).
        if (this.host) this.mixer.add(data);
        this.events.onFast?.(data);
      },
      onMessage: (m) => {
        if (first?.(m)) return;
        this.receive(id, m);
      },
      onStall: (stalled) => {
        if (this.host) {
          const p = this.players.get(id);
          if (p) p.stalled = stalled;
          // Відновився — і список, і вибір ще раз (раптом щось загубилось).
          if (!stalled) this.sendSetup();
          this.sendRoster();
          this.events.onChange?.();
        }
        this.events.onStall?.(this.host ? id : 0, stalled);
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
        this.mixer.drop(id);
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
          pl.truck = String(m.truck);
          pl.color = Number(m.color) & 3;
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
        // Свою машину — зі свого вибору: список господаря міг розминутися з нашим pick.
        const mine = this.players.get(this.myId);
        this.players.clear();
        for (const p of m.players) this.players.set(p.id, p);
        if (mine) this.players.set(this.myId, { ...(this.players.get(this.myId) ?? mine), truck: mine.truck, color: mine.color });
        this.events.onChange?.();
        return;
      }
      case 'setup':
        this.setup = { ...m.setup };
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
      case 'goal':
        break;
      default:
        return;
    }
    this.events.onMessage?.(m);
  }
}
