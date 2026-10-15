/**
 * Шифр `SDTE` у Дальнобойщиках 2 (`*.sch`, `GAME.CNF`): після 4-байтового заголовка «SDTE» кожен байт
 * XOR-иться з молодшим байтом потоку адитивного генератора Фібоначчі із запізненням (55 слів, крок 24):
 * `t[c] -= t[c + 31 mod 55]`, ключ — молодший байт нового `t[c]`. Початковий стан генератора — 55 слів нижче.
 *
 * Алгоритм і стан — з напрацювань спільноти: AlexKimov/HardTruck-RignRoll-file-formats
 * (`scripts/010editor/KeyGenerator.1sc`, `decodeSCH.1sc`), ліцензія MIT, © 2018 Alexander Evdokimov.
 */
const SEED = [
  0x3f8b385e, 0x36b04cd2, 0xe119a25a, 0xa117aac8, 0x6fb37259, 0xaa5a06b7, 0xc6ca87f2, 0x285c96d7, 0xe30569af,
  0x60028eb5, 0x13176548, 0xe527d7a4, 0x03ca34b0, 0x56f50193, 0x05a372d4, 0xfceea0c5, 0x011b78e3, 0xfe96cdc1,
  0x49b0a62a, 0x78f46e85, 0x03a2c50b, 0x0b0c7c91, 0x18e313dc, 0x97b42ea2, 0x7a2ca407, 0x4800e92f, 0xc73197a9,
  0xf45e734c, 0xfee0c3b4, 0xd8f2032f, 0xb34f7cca, 0xb31e3d0e, 0x18957090, 0x2764aeda, 0xfc7d41e6, 0x65371a8d,
  0x198945d3, 0x00b53eb7, 0x5e65e29a, 0xb9b111fb, 0xa077872a, 0x188d17c5, 0xc5e7bbbb, 0xbeca9c9b, 0x2c38ba13,
  0x23c83c99, 0xbf90dc6f, 0x4985b6d3, 0x025baa6c, 0x0fcbd855, 0xd1c0afd4, 0xab67770a, 0x48609b84, 0x6c3b0b17,
  0x8cdb888d,
];

export function isSdte(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x53 && bytes[1] === 0x44 && bytes[2] === 0x54 && bytes[3] === 0x45;
}

/** Розшифровує файл SDTE (без заголовка); незашифрований файл повертає як є. */
export function decodeSdte(bytes: Uint8Array): Uint8Array {
  if (!isSdte(bytes)) return bytes;
  const t = Uint32Array.from(SEED);
  const out = new Uint8Array(bytes.length - 4);
  let c = 0;
  let z = 31;
  for (let i = 0; i < out.length; i++) {
    const k = (t[c] - t[z]) >>> 0;
    t[c] = k;
    out[i] = bytes[i + 4] ^ (k & 0xff);
    if (++c === 55) c = 0;
    if (++z === 55) z = 0;
  }
  return out;
}
