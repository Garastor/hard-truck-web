/**
 * Запрошення й відповідь мережевої гри — короткі рядки для QR-коду. Повний опис з'єднання WebRTC (SDP) — 500…900
 * байтів, QR-код з нього дрібний і погано читається камерою з екрана телефона. Для каналу даних з нього потрібні
 * лише ключі ICE (ufrag, pwd), відбиток сертифіката DTLS, роль DTLS і адреси (кандидати); решту SDP відновлюємо
 * шаблоном. Без кандидатів зовнішніх серверів (relay) — лише пряме з'єднання.
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
  if (!ufrag || !pwd || !fp || !setup || !SETUPS.includes(setup)) throw new SignalError('Неповний опис з’єднання');
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

/**
 * Код: `HT1:` і байти сигналу в алфавіті Base44 (цифри, великі літери, `$%*+-./:` — режим QR «алфавітно-цифровий»,
 * 5,5 біта на символ; 2 байти → 3 символи). Байти: заголовок (вид, роль DTLS), ufrag і pwd (символи ICE — по 6 бітів),
 * відбиток (32 байти), кандидати (до MAX_CANDIDATES: тип, адреса IPv4 — 4 байти, IPv6 чи ім'я mDNS — 16, порт — 2).
 * Запрошення ≈ 115 символів — QR версії 4 (33×33 клітинки) замість версії 8 (49×49) у текстового коду.
 */
const PREFIX = 'HT1:';
const BASE44 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ$%*+-./:';
const ICE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SETUPS: Setup[] = ['actpass', 'active', 'passive'];
/** Скільки адрес класти в код (більше — довший код; у мережі вистачає однієї-двох). */
const MAX_CANDIDATES = 3;
const ADDR_IP4 = 1;
const ADDR_IP6 = 2;
const ADDR_MDNS = 3;
const ADDR_TEXT = 4;
const MDNS = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\.local$/i;

export function encodeSignal(s: Signal): string {
  const out: number[] = [(s.kind === 'answer' ? 4 : 0) | SETUPS.indexOf(s.setup)];
  writeIce(out, s.ufrag);
  writeIce(out, s.pwd);
  out.push(...s.fingerprint);
  // Адреси в мережі й IPv4 — першими (IPv6 на телефоні буває кілька).
  const rank = (c: Candidate) => (c.type === 'srflx' ? 2 : c.address.includes(':') ? 1 : 0);
  const cands = [...s.candidates].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_CANDIDATES);
  out.push(cands.length);
  for (const c of cands) {
    const addr = addressBytes(c.address);
    out.push((c.type === 'srflx' ? 0x80 : 0) | addr.kind, ...addr.bytes, c.port >> 8, c.port & 255);
  }
  return PREFIX + toBase44(out);
}

export function decodeSignal(code: string): Signal {
  const text = code.replace(/\s+/g, '').toUpperCase();
  if (!text.startsWith(PREFIX)) throw new SignalError('Це не код мережевої гри');
  const b = fromBase44(text.slice(PREFIX.length));
  let at = 0;
  const need = (n: number) => {
    if (at + n > b.length) throw new SignalError('Код пошкоджено');
    const v = b.subarray(at, at + n);
    at += n;
    return v;
  };
  const head = need(1)[0];
  const setup = SETUPS[head & 3];
  if (!setup || head >> 3) throw new SignalError('Код пошкоджено');
  const kind: SignalKind = head & 4 ? 'answer' : 'offer';
  const readIce = () => {
    const len = need(1)[0];
    if (!(len & 0x80)) return String.fromCharCode(...need(len));
    const n = len & 0x7f;
    const bytes = need(Math.ceil((n * 6) / 8));
    let s = '';
    for (let i = 0; i < n; i++) {
      const bit = i * 6;
      const v = (((bytes[bit >> 3] << 8) | (bytes[(bit >> 3) + 1] ?? 0)) >> (10 - (bit & 7))) & 63;
      s += ICE_CHARS[v];
    }
    return s;
  };
  const ufrag = readIce();
  const pwd = readIce();
  const fingerprint = Uint8Array.from(need(32));
  const candidates: Candidate[] = [];
  for (let n = need(1)[0]; n > 0; n--) {
    const tag = need(1)[0];
    const kindA = tag & 0x7f;
    let address: string;
    if (kindA === ADDR_IP4) address = [...need(4)].join('.');
    else if (kindA === ADDR_IP6) {
      const v = need(16);
      address = Array.from({ length: 8 }, (_, i) => ((v[2 * i] << 8) | v[2 * i + 1]).toString(16)).join(':');
    } else if (kindA === ADDR_MDNS) {
      const h = [...need(16)].map((x) => x.toString(16).padStart(2, '0')).join('');
      address = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}.local`;
    } else if (kindA === ADDR_TEXT) address = String.fromCharCode(...need(need(1)[0]));
    else throw new SignalError('Код пошкоджено');
    const p = need(2);
    const port = (p[0] << 8) | p[1];
    if (!port) throw new SignalError('Код пошкоджено');
    candidates.push({ type: tag & 0x80 ? 'srflx' : 'host', address, port });
  }
  if (at !== b.length) throw new SignalError('Код пошкоджено');
  return { kind, setup, ufrag, pwd, fingerprint, candidates };
}

/** Рядок ICE (ufrag, pwd): з символів ICE — довжина з прапорцем 0x80 і по 6 бітів на символ, інакше — як є. */
function writeIce(out: number[], s: string): void {
  if (s.length > 127) throw new SignalError('Задовгий ключ ICE');
  if (![...s].every((c) => ICE_CHARS.includes(c))) {
    out.push(s.length, ...[...s].map((c) => c.charCodeAt(0) & 0x7f));
    return;
  }
  out.push(0x80 | s.length);
  const bytes = new Array<number>(Math.ceil((s.length * 6) / 8)).fill(0);
  [...s].forEach((c, i) => {
    const v = ICE_CHARS.indexOf(c);
    const bit = i * 6;
    const w = v << (10 - (bit & 7));
    bytes[bit >> 3] |= w >> 8;
    if ((bit >> 3) + 1 < bytes.length) bytes[(bit >> 3) + 1] |= w & 255;
  });
  out.push(...bytes);
}

function addressBytes(a: string): { kind: number; bytes: number[] } {
  const m = MDNS.exec(a);
  if (m) return { kind: ADDR_MDNS, bytes: m.slice(1).join('').match(/../g)!.map((h) => parseInt(h, 16)) };
  const v4 = a.split('.');
  if (v4.length === 4 && v4.every((x) => /^\d{1,3}$/.test(x) && Number(x) < 256)) return { kind: ADDR_IP4, bytes: v4.map(Number) };
  const v6 = ip6Groups(a);
  if (v6) return { kind: ADDR_IP6, bytes: v6.flatMap((g) => [g >> 8, g & 255]) };
  if (a.length > 255) throw new SignalError('Задовга адреса');
  return { kind: ADDR_TEXT, bytes: [a.length, ...[...a].map((c) => c.charCodeAt(0) & 0x7f)] };
}

/** Вісім груп IPv6 (з розгортанням `::`); не IPv6 — null. */
function ip6Groups(a: string): number[] | null {
  if (!/^[0-9a-f:]+$/i.test(a) || a.split('::').length > 2) return null;
  const [l, r] = a.split('::');
  const left = l ? l.split(':') : [];
  const right = r !== undefined && r ? r.split(':') : [];
  const fill = r !== undefined ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array<string>(Math.max(0, fill)).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function toBase44(b: number[]): string {
  let s = '';
  for (let i = 0; i < b.length; i += 2) {
    if (i + 1 < b.length) {
      const n = b[i] * 256 + b[i + 1];
      s += BASE44[n % 44] + BASE44[Math.floor(n / 44) % 44] + BASE44[Math.floor(n / 1936)];
    } else s += BASE44[b[i] % 44] + BASE44[Math.floor(b[i] / 44)];
  }
  return s;
}

function fromBase44(s: string): Uint8Array {
  if (s.length % 3 === 1) throw new SignalError('Код пошкоджено');
  const out: number[] = [];
  const v = (c: string) => {
    const i = BASE44.indexOf(c);
    if (i < 0) throw new SignalError('Це не код мережевої гри');
    return i;
  };
  for (let i = 0; i < s.length; i += 3) {
    if (i + 2 < s.length) {
      const n = v(s[i]) + v(s[i + 1]) * 44 + v(s[i + 2]) * 1936;
      if (n > 65535) throw new SignalError('Код пошкоджено');
      out.push(n >> 8, n & 255);
    } else {
      const n = v(s[i]) + v(s[i + 1]) * 44;
      if (n > 255) throw new SignalError('Код пошкоджено');
      out.push(n);
    }
  }
  return Uint8Array.from(out);
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
