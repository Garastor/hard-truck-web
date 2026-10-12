/** Послідовне читання little-endian бінарних даних. */
export class BinReader {
  readonly view: DataView;
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    pos = 0,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = pos;
  }

  get length(): number {
    return this.bytes.byteLength;
  }

  get eof(): boolean {
    return this.pos >= this.bytes.byteLength;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  /** n чисел f32 у новий масив. */
  f32s(n: number): Float32Array {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = this.view.getFloat32(this.pos + i * 4, true);
    this.pos += n * 4;
    return out;
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()];
  }

  bytesN(n: number): Uint8Array {
    if (this.pos + n > this.bytes.byteLength) throw new RangeError(`read past end @${this.pos} (+${n})`);
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  skip(n: number): void {
    this.pos += n;
  }

  /** Рядок фіксованої довжини, обрізаний по першому \0 (кодування cp1251). */
  fixedStr(n: number): string {
    const raw = this.bytesN(n);
    const end = raw.indexOf(0);
    return decodeCp1251(end < 0 ? raw : raw.subarray(0, end));
  }

  /** Рядок до \0. */
  cstr(): string {
    const end = this.bytes.indexOf(0, this.pos);
    if (end < 0) throw new RangeError(`unterminated string @${this.pos}`);
    const s = decodeCp1251(this.bytes.subarray(this.pos, end));
    this.pos = end + 1;
    return s;
  }

  fourcc(): string {
    return String.fromCharCode(...this.bytesN(4));
  }
}

const cp1251 = new TextDecoder('windows-1251');

export function decodeCp1251(b: Uint8Array): string {
  return cp1251.decode(b);
}

/** RGBA-зображення 8 біт/канал. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}
