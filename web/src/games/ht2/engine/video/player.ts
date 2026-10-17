import { parseAvi, pcmChannels, type Avi } from '../../formats/avi';
import wasmUrl from './indeo5.wasm?url';
import type { Indeo5Module } from './indeo5.js';

/**
 * Програвач роликів HT2 (`*.bne` — AVI Indeo 5 + PCM, re/notes/ht2/video.md): декодер Indeo 5 — FFmpeg libavcodec
 * (LGPL-2.1, LICENSE.LGPL-2.1.txt), зібраний у WebAssembly (tools/video). Кадр — на canvas 640×480 на весь екран
 * (пропорції зберігаються), звук — WebAudio; годинник — звук (без нього — performance.now). Дотик, клік, Esc,
 * Enter чи пробіл — пропустити ролик.
 */

type Indeo5 = Indeo5Module;

let module: Promise<Indeo5> | null = null;

/** Модуль декодера (раз на сторінку; wasm — окремим файлом, вантажиться лише з першим роликом). */
function decoder(): Promise<Indeo5> {
  module ??= import('./indeo5.js').then((m) => m.default({ locateFile: () => wasmUrl }));
  return module;
}

/** Декодер одного ролика: кадри по порядку → RGBA (порожній кадр — попередній). */
export class VideoDecoder5 {
  private next = 0;
  private constructor(
    private readonly m: Indeo5,
    readonly avi: Avi,
  ) {}

  /** m — модуль декодера (для тестів у Node; інакше — свій модуль сторінки). */
  static async open(avi: Avi, mod?: Indeo5): Promise<VideoDecoder5> {
    if (avi.video.codec.toUpperCase() !== 'IV50') throw new Error(`Відео: кодек ${avi.video.codec} не підтримано`);
    const m = mod ?? (await decoder());
    const r = m._iv_open(avi.video.width, avi.video.height);
    if (r < 0) throw new Error(`Відео: декодер не відкрився (${r})`);
    return new VideoDecoder5(m, avi);
  }

  get index(): number {
    return this.next;
  }

  /** Декодувати наступний кадр; повертає RGBA (вигляд у памʼять wasm — скопіювати до наступного виклику). */
  decode(): Uint8ClampedArray | null {
    const f = this.avi.frames[this.next++];
    if (!f || f.length === 0) return null;
    const p = this.m._iv_input(f.length);
    this.m.HEAPU8.set(f, p);
    if (this.m._iv_decode(f.length) !== 1) return null;
    const { width, height } = this.avi.video;
    return new Uint8ClampedArray(this.m.HEAPU8.buffer, this.m._iv_rgba(), width * height * 4);
  }

  close(): void {
    this.m._iv_close();
  }
}

export interface PlayOptions {
  /** Контекст звуку гри (інакше — свій); гучність 0…1. */
  audio?: AudioContext;
  volume?: number;
  /** Куди покласти екран ролика (типово — document.body). */
  parent?: HTMLElement;
}

/** Показати ролик на весь екран; завершується після кінця чи пропуску. Помилка декодера — одразу кінець. */
export async function playVideo(data: Uint8Array, o: PlayOptions = {}): Promise<void> {
  const avi = parseAvi(data);
  let dec: VideoDecoder5;
  try {
    dec = await VideoDecoder5.open(avi);
  } catch (e) {
    console.warn(e);
    return;
  }
  const { width, height, fps } = avi.video;
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;inset:0;z-index:1000;background:#000;display:flex;align-items:center;justify-content:center;touch-action:none;';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Відеоролик (дотик — пропустити)');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.style.cssText = 'max-width:100%;max-height:100%;width:100%;height:100%;object-fit:contain;';
  root.append(canvas);
  (o.parent ?? document.body).append(root);
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(width, height);

  const ctx = o.audio ?? new AudioContext();
  let src: AudioBufferSourceNode | null = null;
  const pcm = pcmChannels(avi);
  if (pcm.length && avi.audio) {
    const buf = ctx.createBuffer(pcm.length, pcm[0].length, avi.audio.rate);
    pcm.forEach((c, i) => buf.getChannelData(i).set(c));
    src = ctx.createBufferSource();
    src.buffer = buf;
    const gain = ctx.createGain();
    gain.gain.value = o.volume ?? 1;
    src.connect(gain).connect(ctx.destination);
    void ctx.resume().catch(() => {});
  }
  const duration = avi.frames.length / fps;
  // Звук іде, лише коли контекст запущено (iOS — після жесту); інакше годинник — performance.now.
  const t0Audio = ctx.currentTime;
  const t0 = performance.now();
  src?.start();
  const clock = () => (ctx.state === 'running' && src ? ctx.currentTime - t0Audio : (performance.now() - t0) / 1000);

  await new Promise<void>((resolve) => {
    let raf = 0;
    const finish = () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      try {
        src?.stop();
      } catch {
        /* уже зупинено */
      }
      if (!o.audio) void ctx.close();
      dec.close();
      root.remove();
      resolve();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopImmediatePropagation();
        finish();
      }
    };
    window.addEventListener('keydown', onKey, true);
    root.addEventListener('pointerup', finish);
    const tick = () => {
      const t = clock();
      if (t >= duration) return finish();
      // Декодувати всі кадри до поточного (пропущені — без показу; Indeo 5 залежить від попередніх).
      const target = Math.min(avi.frames.length - 1, Math.floor(t * fps));
      let shown: Uint8ClampedArray | null = null;
      while (dec.index <= target) {
        const rgba = dec.decode();
        if (rgba) shown = rgba;
      }
      if (shown) {
        image.data.set(shown);
        g.putImageData(image, 0, 0);
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  });
}
