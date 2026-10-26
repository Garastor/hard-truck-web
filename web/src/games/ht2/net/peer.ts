/**
 * З'єднання двох гравців напряму (WebRTC, канали даних): господар створює запрошення, гість відповідає, обмін
 * кодами — QR чи текстом (signal.ts), без сервера. Лише локальна мережа: без STUN — адреси в мережі (на iPhone —
 * імена *.local). Два канали, домовлені наперед (negotiated, без зайвого обміну): `ctrl` — надійний і впорядкований
 * (привітання, події гри), `fast` — без повторів і порядку (стан машини 20–30 разів на секунду — запізнілий не
 * потрібен).
 */
import { decodeSignal, encodeSignal, sdpFromSignal, sdpMid, signalFromSdp, SignalError } from './signal';

/**
 * Версія протоколу: різні версії порту не з'єднуються (повідомлення гравцям). Своя в другої гри — коди `HT2:` і так
 * не підходять першій (signal.ts).
 */
export const NET_VERSION = 5;
/** Скільки чекати збору адрес (у локальній мережі — частки секунди), мс. */
const GATHER_TIMEOUT = 4000;
/**
 * Пінг і обрив (М5, повторне з'єднання без нових кодів): без жодного повідомлення довше за STALL_AFTER — зв'язок
 * «завис» (onStall: гравцям показують «чекаємо», нічого не закривається), довше за LOST_AFTER — втрачено. WebRTC сам
 * відновлює зв'язок після короткого провалу Wi-Fi чи згорнутого застосунку, якщо зʼєднання не закрити: ICE стає
 * `disconnected` і повертається в `connected`; остаточно — лише `failed` (Chrome — ≈ 30 с без відповіді на перевірки
 * згоди ICE), і тоді без нового обміну кодами не обійтися (сервера сигналізації немає). Перша гра рвала зв'язок уже
 * за 6 с тиші.
 */
const PING_EVERY = 1000;
export const STALL_AFTER = 3000;
export const LOST_AFTER = 40000;

export type NetMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  | { t: 'bye' }
  /** Вибір господаря в сесії (екран «Сервер» h/backHost): траса, складність, повзунки. */
  | { t: 'setup'; setup: NetSetup }
  /** Господар — новому гостю: його номер у сесії (місце на старті). */
  | { t: 'welcome'; id: number }
  /** Господар — усім: гравці сесії. */
  | { t: 'roster'; players: NetPlayer[] }
  /** Машина гравця id: car_node і колір (екран «Мережева гра» n/backMult). */
  | { t: 'pick'; truck: string; color: number; id: number }
  /** Господар почав заїзд: вибір, гравці з машинами, машини суперників (усі вантажать трасу). */
  | { t: 'start'; setup: NetSetup; players: NetPlayer[]; rivals: NetCar[] }
  /** Гравець id повернувся із заїзду до сесії. */
  | { t: 'lobby'; id: number }
  /** Гравець id завантажив трасу — готовий до старту. */
  | { t: 'ready'; id: number }
  /** Господар: обидва готові — відлік (світлофор) почався. */
  | { t: 'go' }
  /** Автобол, сервер — усім: гравець id забив у ворота gate (індекс у readGates), у нього тепер total очок. */
  | { t: 'goal'; id: number; gate: number; total: number }
  /**
   * Мережева кар'єра (М6), кожен — усім раз на 8 с: флот (вантажопідйомність, кг; найнято), перевезено тонн — для
   * спільної частки ринку й рейтингу F2.
   */
  | { t: 'stand'; id: number; load: number; hired: number; tons: number }
  /** Мережева кар'єра: гравець id узяв замовлення на місці dock складу store — в інших це місце порожнє. */
  | { t: 'taken'; id: number; store: number; dock: number }
  /** Мережева кар'єра: гравець id захопив ринок (частка ≥ 0,51) — для інших кінець гри (BackLoose1). */
  | { t: 'won'; id: number }
  /** Гравець id фінішував: час заїзду від зеленого, с; місце серед усіх (з суперниками). */
  | { t: 'finish'; time: number; place: number; id: number };

/**
 * Траси мережевої гри king.exe (кнопки екрана «Сервер»): КОЛЬЦО (MENV), ТРИАЛ (MTR), АВТОБОЛ (MTB); `career` —
 * мережева кар'єра порту (М6, «змагання за ринок»; у king.exe її немає).
 */
export type NetTrack = 'ring' | 'trial' | 'ball' | 'career';

/**
 * Вибір господаря — поля екрана «Сервер» king.exe (re/notes/ht2/tracks.md §2): траса, аркада чи симулятор,
 * повзунки «Насыщенность трасс», «Длительность суток», «Погода» (0…1). Однакові в усіх телефонів — однакові доба й
 * погода (у гонці погода стала, Climate за повзунком). `rivals` — суперників на автопілоті в Кільці й Тріалі (точне
 * число 0…15 стрілками; власний інтерфейс порту, у king.exe — завжди вільні місця решітки); `traffic` — лише в
 * мережевій кар'єрі (насиченість трас, як повзунок одиночної гри).
 */
export interface NetSetup {
  track: NetTrack;
  arcade: boolean;
  rivals: number;
  traffic: number;
  dayLength: number;
  weather: number;
}

export const DEFAULT_SETUP: NetSetup = { track: 'ring', arcade: false, rivals: 6, traffic: 0.5, dayLength: 0.5, weather: 0.6 };

/** Машина: car_node (vehicle.tech) і колір (0…3; фото — net/cars.ts carPhoto). */
export interface NetCar {
  truck: string;
  color: number;
}

/** Гравець сесії: номер (0 — господар; місце на старті), ім'я, машина, чи зараз на трасі. */
export interface NetPlayer extends NetCar {
  id: number;
  name: string;
  driving: boolean;
  /** Зв'язок сервера з цим гравцем завис (чекаємо відновлення, STALL_AFTER…LOST_AFTER). */
  stalled?: boolean;
}

export type CloseReason = 'bye' | 'lost' | 'failed' | 'version' | 'local';

export interface NetPeerEvents {
  /** Канал відкрито й друг привітався (його ім'я). */
  onReady?: (name: string) => void;
  onMessage?: (m: NetMessage) => void;
  /** Пакет каналу `fast` (стан машини). */
  onFast?: (data: ArrayBuffer) => void;
  onClose?: (reason: CloseReason) => void;
  /** Зв'язок завис (true: друг мовчить понад STALL_AFTER) чи відновився (false). */
  onStall?: (stalled: boolean) => void;
}

export class NetPeer {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  readonly ctrl = this.pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  readonly fast = this.pc.createDataChannel('fast', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  /** Ім'я друга (після привітання). */
  peerName: string | null = null;
  /** Час туди й назад, мс (згладжений). */
  rtt: number | null = null;
  private ev: NetPeerEvents = {};
  /** Повідомлення, що прийшли, поки ніхто не слухав (екран з'єднання вже закрито, сесія ще не підписалась). */
  private readonly pending: NetMessage[] = [];
  get events(): NetPeerEvents {
    return this.ev;
  }
  set events(e: NetPeerEvents) {
    this.ev = e;
    if (e.onMessage) for (const m of this.pending.splice(0)) e.onMessage(m);
  }
  private closed = false;
  /** З'єднання ще живе. */
  get open(): boolean {
    return !this.closed;
  }
  private lastHeard = performance.now();
  private timer = 0;
  /** Друг мовчить понад STALL_AFTER (зв'язок завис, але ще не втрачений). */
  stalled = false;
  /** Перевірка: до цього часу (performance.now) нічого не надсилати й не приймати — імітація обриву. */
  private muteUntil = 0;
  /**
   * Свій застосунок повертається з фону (iPhone призупиняє сторінку): тиша — через нас, а не друга; годинник тиші — з
   * нуля, щоб не закрити живе з'єднання першим же пінгом.
   */
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') this.lastHeard = performance.now();
  };

  private constructor(
    readonly host: boolean,
    private readonly name: string,
  ) {
    this.ctrl.onopen = () => {
      this.send({ t: 'hello', v: NET_VERSION, name: this.name });
      this.lastHeard = performance.now();
      this.timer = window.setInterval(() => this.tick(), PING_EVERY);
    };
    this.ctrl.onmessage = (e) => this.receive(e.data);
    this.fast.binaryType = 'arraybuffer';
    this.fast.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer) || this.muted) return;
      this.heard();
      this.ev.onFast?.(e.data);
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisible);
    this.ctrl.onclose = () => this.finish('lost');
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === 'failed') this.finish('failed');
    };
  }

  /** Господар: запрошення для друга. */
  static async host(name: string): Promise<{ peer: NetPeer; code: string }> {
    const peer = new NetPeer(true, name);
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    await peer.gathered();
    return { peer, code: encodeSignal(signalFromSdp('offer', peer.pc.localDescription!.sdp)) };
  }

  /** Гість: відповідь на запрошення господаря. */
  static async join(name: string, offerCode: string): Promise<{ peer: NetPeer; code: string }> {
    const offer = decodeSignal(offerCode);
    if (offer.kind !== 'offer') throw new SignalError('Відскануйте код того, хто створив гру');
    const peer = new NetPeer(false, name);
    try {
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: sdpFromSignal(offer) });
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      await peer.gathered();
      return { peer, code: encodeSignal(signalFromSdp('answer', peer.pc.localDescription!.sdp)) };
    } catch (e) {
      peer.close();
      throw e;
    }
  }

  /** Господар: відповідь друга — далі з'єднання встановлюється саме. */
  async accept(answerCode: string): Promise<void> {
    const answer = decodeSignal(answerCode);
    if (answer.kind !== 'answer') throw new SignalError('Відскануйте код друга, що приєднується');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: sdpFromSignal(answer, sdpMid(this.pc.localDescription!.sdp)) });
  }

  send(m: NetMessage): void {
    if (this.ctrl.readyState === 'open' && !this.muted) this.ctrl.send(JSON.stringify(m));
  }

  /** Перевірка повторного зʼєднання: ms мілісекунд тиші в обидва боки (як провал Wi-Fi). */
  simulateOutage(ms: number): void {
    this.muteUntil = performance.now() + ms;
  }

  private get muted(): boolean {
    return performance.now() < this.muteUntil;
  }

  /** Від друга щось прийшло: годинник тиші — з нуля, зависання минуло. */
  private heard(): void {
    this.lastHeard = performance.now();
    if (!this.stalled) return;
    this.stalled = false;
    this.ev.onStall?.(false);
  }

  /** Стан машини (канал без повторів); якщо канал ще не відкрито чи переповнений — пакет пропускаємо. */
  sendFast(data: ArrayBuffer): void {
    if (this.fast.readyState === 'open' && this.fast.bufferedAmount < 16384 && !this.muted) this.fast.send(data);
  }

  /** Тип з'єднання: адреса в мережі (host) чи через зовнішню адресу (srflx). */
  async route(): Promise<string | null> {
    const stats = await this.pc.getStats();
    let pairId: string | undefined;
    stats.forEach((r) => {
      if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
    });
    let local: string | null = null;
    stats.forEach((r) => {
      if (r.type === 'candidate-pair' && (pairId ? r.id === pairId : r.state === 'succeeded' && r.nominated)) {
        local = stats.get(r.localCandidateId)?.candidateType ?? null;
      }
    });
    return local;
  }

  /** Закрити з'єднання (друг отримає «bye»). */
  close(): void {
    if (this.closed) return;
    this.send({ t: 'bye' });
    this.finish('local');
  }

  private gathered(): Promise<void> {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.pc.removeEventListener('icegatheringstatechange', check);
        resolve();
      };
      const check = () => this.pc.iceGatheringState === 'complete' && done();
      const t = setTimeout(done, GATHER_TIMEOUT);
      this.pc.addEventListener('icegatheringstatechange', check);
    });
  }

  private receive(data: unknown): void {
    if (typeof data !== 'string' || this.muted) return;
    let m: NetMessage;
    try {
      m = JSON.parse(data) as NetMessage;
    } catch {
      return;
    }
    this.heard();
    switch (m.t) {
      case 'hello':
        if (m.v !== NET_VERSION) {
          this.finish('version');
          return;
        }
        this.peerName = String(m.name).slice(0, 24) || 'Водій';
        this.ev.onReady?.(this.peerName);
        return;
      case 'ping':
        this.send({ t: 'pong', at: m.at });
        return;
      case 'pong': {
        const rtt = performance.now() - m.at;
        this.rtt = this.rtt === null ? rtt : this.rtt * 0.7 + rtt * 0.3;
        break;
      }
      case 'bye':
        this.finish('bye');
        return;
    }
    if (this.ev.onMessage) this.ev.onMessage(m);
    else if (this.pending.length < 64) this.pending.push(m);
  }

  private tick(): void {
    const silent = performance.now() - this.lastHeard;
    if (silent > LOST_AFTER) {
      this.finish('lost');
      return;
    }
    if (silent > STALL_AFTER && !this.stalled) {
      this.stalled = true;
      this.ev.onStall?.(true);
    }
    this.send({ t: 'ping', at: performance.now() });
  }

  private finish(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisible);
    // Дати «bye» піти перед закриттям каналу.
    setTimeout(() => this.pc.close(), reason === 'local' ? 200 : 0);
    this.ev.onClose?.(reason);
  }
}
