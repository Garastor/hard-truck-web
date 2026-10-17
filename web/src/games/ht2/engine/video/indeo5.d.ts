/** Модуль Emscripten декодера Indeo 5 (tools/video/build.py; функції — tools/video/indeo5.c). */
export interface Indeo5Module {
  HEAPU8: Uint8Array;
  _iv_open(w: number, h: number): number;
  _iv_input(size: number): number;
  _iv_decode(size: number): number;
  _iv_rgba(): number;
  _iv_close(): void;
}

export default function createIndeo5(o?: { locateFile?: (path: string) => string; wasmBinary?: ArrayBuffer | Uint8Array }): Promise<Indeo5Module>;
