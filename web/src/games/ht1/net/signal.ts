/**
 * Запрошення й відповідь мережевої гри — короткі рядки для QR-коду. Повний опис з'єднання WebRTC (SDP) — 500…900
 * байтів, QR-код з нього дрібний і погано читається камерою з екрана телефона. Для каналу даних з нього потрібні
 * лише ключі ICE (ufrag, pwd), відбиток сертифіката DTLS, роль DTLS і адреси (кандидати); решту SDP відновлюємо
 * шаблоном. Рядок: `HT1<вид><роль> <ufrag> <pwd> <відбиток base64> <кандидат>…`, кандидат — `h|s<адреса>/<порт>`
 * (h — адреса в мережі, s — зовнішня адреса з STUN). Без кандидатів зовнішніх серверів (relay) — лише пряме з'єднання.
 */

export type SignalKind = 'offer' | 'answer';
type Setup = 'actpass' | 'active' | 'passive';

export interface Candidate {
  type: 'host' | 'srflx';
  address: string;
  port: number;
}

export interface Signal {
  kind: SignalKind;
  setup: Setup;
  ufrag: string;
  pwd: string;
  /** Відбиток сертифіката DTLS, SHA-256 (32 байти). */
  fingerprint: Uint8Array;
  candidates: Candidate[];
}

const PREFIX = 'HT1';
const KIND_CHAR: Record<SignalKind, string> = { offer: 'O', answer: 'A' };
const SETUP_CHAR: Record<Setup, string> = { actpass: 'x', active: 'a', passive: 'p' };
const TYPE_CHAR = { host: 'h', srflx: 's' } as const;

/** Помилка розбору коду — повідомлення для гравця. */
export class SignalError extends Error {}

/** Ключі, відбиток і кандидати з SDP (опис каналу даних, усі кандидати вже зібрані). */
export function signalFromSdp(kind: SignalKind, sdp: string): Signal {
  const lines = sdp.split(/\r?\n/);
  const attr = (name: string) => lines.find((l) => l.startsWith(`a=${name}:`))?.slice(name.length + 3).trim();
  const ufrag = attr('ice-ufrag');
  const pwd = attr('ice-pwd');
  const fp = attr('fingerprint');
  const setup = attr('setup') as Setup | undefined;
  if (!ufrag || !pwd || !fp || !setup || !(setup in SETUP_CHAR)) throw new SignalError('Неповний опис з’єднання');
  const [hash, hex] = fp.split(/\s+/);
  if (hash.toLowerCase() !== 'sha-256') throw new SignalError(`Непідтримуваний відбиток ${hash}`);
  const fingerprint = new Uint8Array(hex.split(':').map((h) => parseInt(h, 16)));
  if (fingerprint.length !== 32) throw new SignalError('Хибний відбиток');
  const candidates: Candidate[] = [];
  for (const l of lines) {
    if (!l.startsWith('a=candidate:')) continue;
    // a=candidate:<foundation> <компонент> <протокол> <пріоритет> <адреса> <порт> typ <тип> …
    const f = l.slice(12).trim().split(/\s+/);
    const type = f[7];
    if (f[1] !== '1' || f[2].toLowerCase() !== 'udp' || (type !== 'host' && type !== 'srflx')) continue;
    const c: Candidate = { type, address: f[4], port: Number(f[5]) };
    if (!candidates.some((o) => o.address === c.address && o.port === c.port)) candidates.push(c);
  }
  return { kind, setup, ufrag, pwd, fingerprint, candidates };
}

export function encodeSignal(s: Signal): string {
  if (/\s/.test(s.ufrag + s.pwd)) throw new SignalError('Пробіл у ключах ICE');
  const cands = s.candidates.map((c) => `${TYPE_CHAR[c.type]}${c.address}/${c.port}`);
  return [`${PREFIX}${KIND_CHAR[s.kind]}${SETUP_CHAR[s.setup]}`, s.ufrag, s.pwd, toBase64(s.fingerprint), ...cands].join(' ');
}

export function decodeSignal(code: string): Signal {
  const f = code.trim().split(/\s+/);
  const head = f[0] ?? '';
  const kind = (Object.keys(KIND_CHAR) as SignalKind[]).find((k) => KIND_CHAR[k] === head[3]);
  const setup = (Object.keys(SETUP_CHAR) as Setup[]).find((k) => SETUP_CHAR[k] === head[4]);
  if (!head.startsWith(PREFIX) || head.length !== 5 || !kind || !setup || f.length < 4) throw new SignalError('Це не код мережевої гри');
  const fingerprint = fromBase64(f[3]);
  if (fingerprint.length !== 32) throw new SignalError('Код пошкоджено');
  const candidates: Candidate[] = [];
  for (const c of f.slice(4)) {
    const type = c[0] === 'h' ? 'host' : c[0] === 's' ? 'srflx' : null;
    const at = c.lastIndexOf('/');
    const port = Number(c.slice(at + 1));
    if (!type || at < 2 || !Number.isInteger(port) || port <= 0 || port > 65535) throw new SignalError('Код пошкоджено');
    candidates.push({ type, address: c.slice(1, at), port });
  }
  return { kind, setup, ufrag: f[1], pwd: f[2], fingerprint, candidates };
}

/**
 * SDP каналу даних із сигналу (шаблон, як у браузерів). mid — ідентифікатор медіарядка: у відповіді — той, що в
 * нашому запрошенні; у відновленому запрошенні — будь-який (відповідь повторить його).
 */
export function sdpFromSignal(s: Signal, mid = '0'): string {
  const hex = [...s.fingerprint].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(':');
  const session = Array.from({ length: 18 }, (_, i) => (i === 0 ? 1 + Math.floor(Math.random() * 9) : Math.floor(Math.random() * 10))).join('');
  const lines = [
    'v=0',
    `o=- ${session} 2 IN IP4 127.0.0.1`,
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mid}`,
    'a=msid-semantic: WMS',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    ...s.candidates.map((c, i) => {
      // Пріоритет за RFC 8445: тип (host 126, srflx 100), порядок, компонент 1.
      const priority = (c.type === 'host' ? 126 : 100) * 2 ** 24 + (65535 - i) * 2 ** 8 + 255;
      return `a=candidate:${i + 1} 1 udp ${priority} ${c.address} ${c.port} typ ${c.type}${c.type === 'srflx' ? ' raddr 0.0.0.0 rport 0' : ''}`;
    }),
    'a=end-of-candidates',
    `a=ice-ufrag:${s.ufrag}`,
    `a=ice-pwd:${s.pwd}`,
    `a=fingerprint:sha-256 ${hex}`,
    `a=setup:${s.setup}`,
    `a=mid:${mid}`,
    'a=sctp-port:5000',
    'a=max-message-size:262144',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** Ідентифікатор медіарядка з SDP (для відповіді на наше запрошення). */
export function sdpMid(sdp: string): string {
  return /^a=mid:(\S+)/m.exec(sdp)?.[1] ?? '0';
}

function toBase64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/=+$/, '');
}

function fromBase64(s: string): Uint8Array {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    throw new SignalError('Код пошкоджено');
  }
}
