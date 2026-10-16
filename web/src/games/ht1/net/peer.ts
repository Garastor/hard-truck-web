/**
 * З'єднання двох гравців напряму (WebRTC, канали даних): господар створює запрошення, гість відповідає, обмін
 * кодами — QR чи текстом (signal.ts), без сервера. Лише локальна мережа: без STUN — адреси в мережі (на iPhone —
 * імена *.local). Два канали, домовлені наперед (negotiated, без зайвого обміну): `ctrl` — надійний і впорядкований
 * (привітання, події гри), `fast` — без повторів і порядку (стан машини 20–30 разів на секунду — запізнілий не
 * потрібен).
 */
import { decodeSignal, encodeSignal, sdpFromSignal, sdpMid, signalFromSdp, SignalError } from './signal';

/** Версія протоколу: різні версії порту не з'єднуються (повідомлення гравцям). */
export const NET_VERSION = 1;
/** Скільки чекати збору адрес (у локальній мережі — частки секунди), мс. */
const GATHER_TIMEOUT = 4000;
/** Пінг і обрив: без жодного повідомлення довше за LOST_AFTER — зв'язок втрачено, мс. */
const PING_EVERY = 1000;
const LOST_AFTER = 6000;

export type NetMessage =
  | { t: 'hello'; v: number; name: string }
  | { t: 'ping'; at: number }
  | { t: 'pong'; at: number }
  | { t: 'bye' }
  /** Вибір господаря в сесії: траса й погода. */
  | { t: 'setup'; level: string; rain: boolean }
  /** Вантажівка гравця (номер у TRUCK.TCH). */
  | { t: 'pick'; truck: number }
  /** Господар почав заїзд: траса, погода (обидва вантажать трасу). */
  | { t: 'start'; level: string; rain: boolean }
  /** Гравець повернувся із заїзду до сесії. */
  | { t: 'lobby' };

export type CloseReason = 'bye' | 'lost' | 'failed' | 'version' | 'local';

export interface NetPeerEvents {
  /** Канал відкрито й друг привітався (його ім'я). */
  onReady?: (name: string) => void;
  onMessage?: (m: NetMessage) => void;
  /** Пакет каналу `fast` (стан машини). */
  onFast?: (data: ArrayBuffer) => void;
  onClose?: (reason: CloseReason) => void;
}

export class NetPeer {
  readonly pc = new RTCPeerConnection({ iceServers: [] });
  readonly ctrl = this.pc.createDataChannel('ctrl', { negotiated: true, id: 0, ordered: true });
  readonly fast = this.pc.createDataChannel('fast', { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 });
  /** Ім'я друга (після привітання). */
  peerName: string | null = null;
  /** Час туди й назад, мс (згладжений). */
  rtt: number | null = null;
  events: NetPeerEvents = {};
  private closed = false;
  /** З'єднання ще живе. */
  get open(): boolean {
    return !this.closed;
  }
  private lastHeard = performance.now();
  private timer = 0;

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
      if (!(e.data instanceof ArrayBuffer)) return;
      this.lastHeard = performance.now();
      this.events.onFast?.(e.data);
    };
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
    if (this.ctrl.readyState === 'open') this.ctrl.send(JSON.stringify(m));
  }

  /** Стан машини (канал без повторів); якщо канал ще не відкрито чи переповнений — пакет пропускаємо. */
  sendFast(data: ArrayBuffer): void {
    if (this.fast.readyState === 'open' && this.fast.bufferedAmount < 16384) this.fast.send(data);
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
    if (typeof data !== 'string') return;
    let m: NetMessage;
    try {
      m = JSON.parse(data) as NetMessage;
    } catch {
      return;
    }
    this.lastHeard = performance.now();
    switch (m.t) {
      case 'hello':
        if (m.v !== NET_VERSION) {
          this.finish('version');
          return;
        }
        this.peerName = String(m.name).slice(0, 24) || 'Водій';
        this.events.onReady?.(this.peerName);
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
    this.events.onMessage?.(m);
  }

  private tick(): void {
    if (performance.now() - this.lastHeard > LOST_AFTER) {
      this.finish('lost');
      return;
    }
    this.send({ t: 'ping', at: performance.now() });
  }

  private finish(reason: CloseReason): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    // Дати «bye» піти перед закриттям каналу.
    setTimeout(() => this.pc.close(), reason === 'local' ? 200 : 0);
    this.events.onClose?.(reason);
  }
}
