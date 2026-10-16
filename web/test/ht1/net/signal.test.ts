import { describe, expect, it } from 'vitest';
import { decodeSignal, encodeSignal, sdpFromSignal, sdpMid, signalFromSdp, SignalError } from '../../../src/games/ht1/net/signal';

// Запрошення каналу даних, як його дає Chrome (адреса в мережі — ім'я mDNS) — після збору кандидатів.
const CHROME_OFFER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 54321 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=candidate:1467250027 1 udp 2122260223 6d3c1b2e-8f6a-4c11-9d1e-0a2b3c4d5e6f.local 54321 typ host generation 0 network-cost 999',
  'a=candidate:1853887674 1 udp 2122194687 192.168.1.23 54322 typ host generation 0 network-cost 999',
  'a=candidate:842163049 1 udp 1677729535 93.184.216.34 61000 typ srflx raddr 0.0.0.0 rport 0 generation 0 network-cost 999',
  'a=candidate:1467250027 1 tcp 1518280447 6d3c1b2e-8f6a-4c11-9d1e-0a2b3c4d5e6f.local 9 typ host tcptype active generation 0',
  'a=ice-ufrag:Ab3D',
  'a=ice-pwd:x9y8z7w6v5u4t3s2r1q0p0o9',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

describe('код з’єднання мережевої гри', () => {
  it('бере з SDP ключі, відбиток і лише UDP-кандидати компонента 1', () => {
    const s = signalFromSdp('offer', CHROME_OFFER);
    expect(s.ufrag).toBe('Ab3D');
    expect(s.pwd).toBe('x9y8z7w6v5u4t3s2r1q0p0o9');
    expect(s.setup).toBe('actpass');
    expect(s.fingerprint[0]).toBe(0x0a);
    expect(s.fingerprint[31]).toBe(0xf9);
    expect(s.candidates).toEqual([
      { type: 'host', address: '6d3c1b2e-8f6a-4c11-9d1e-0a2b3c4d5e6f.local', port: 54321 },
      { type: 'host', address: '192.168.1.23', port: 54322 },
      { type: 'srflx', address: '93.184.216.34', port: 61000 },
    ]);
  });

  it('рядок коду короткий і розбирається назад без втрат', () => {
    const s = signalFromSdp('offer', CHROME_OFFER);
    const code = encodeSignal(s);
    expect(code.startsWith('HT1Ox ')).toBe(true);
    expect(code.length).toBeLessThan(200);
    expect(decodeSignal(code)).toEqual(s);
    // Пробіли й перенесення рядків від месенджера не заважають.
    expect(decodeSignal(`  ${code.replace(/ /g, '\n')}\n`)).toEqual(s);
  });

  it('IPv6-адреса з двокрапками', () => {
    const s = signalFromSdp('answer', CHROME_OFFER.replace('192.168.1.23', 'fe80::1c2b:3a4d').replace('setup:actpass', 'setup:active'));
    const back = decodeSignal(encodeSignal(s));
    expect(back.kind).toBe('answer');
    expect(back.setup).toBe('active');
    expect(back.candidates[1]).toEqual({ type: 'host', address: 'fe80::1c2b:3a4d', port: 54322 });
  });

  it('відновлений SDP містить те саме, що потрібно браузеру', () => {
    const s = signalFromSdp('offer', CHROME_OFFER);
    const sdp = sdpFromSignal(s, 'data');
    expect(sdpMid(sdp)).toBe('data');
    expect(sdp).toContain('a=group:BUNDLE data');
    expect(sdp).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    expect(sdp.endsWith('\r\n')).toBe(true);
    expect(signalFromSdp('offer', sdp)).toEqual(s);
  });

  it('чужий чи пошкоджений код — зрозуміла помилка', () => {
    expect(() => decodeSignal('https://example.com')).toThrow(SignalError);
    expect(() => decodeSignal('HT1Ox a b c')).toThrow(SignalError);
    const code = encodeSignal(signalFromSdp('offer', CHROME_OFFER));
    expect(() => decodeSignal(code + ' hbad')).toThrow(SignalError);
  });
});
