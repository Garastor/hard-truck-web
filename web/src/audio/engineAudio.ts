import type { RmpArchive } from '../formats/rmp';

/**
 * Звук вантажівки на Web Audio з оригінальних WAV (секції SOUNDFILES/SOUNDS архіву RMP).
 * Як в оригіналі (HTruck.exe 0x4872b8): idleSound — холостий хід, fullSound — під навантаженням,
 * gearSound — перемикання, startSound — запуск двигуна. Висота тону ∝ обертам.
 * iOS/Chrome дозволяють звук лише після жесту користувача — контекст відновлюється на першому дотику.
 */
export interface LoopSound {
  set(volume: number, rate?: number, balance?: number): void;
  stop(): void;
}

/** Оберти холостого ходу, об/хв (Engine: idle 5 об/с). */
const IDLE_RPM = 300;

export class EngineAudio {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private idle: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private full: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private readonly unlock = () => void this.ctx.resume();

  private constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.6;
    this.master.connect(this.ctx.destination);
    window.addEventListener('pointerdown', this.unlock);
    window.addEventListener('keydown', this.unlock);
  }

  static async create(rmp: RmpArchive): Promise<EngineAudio> {
    const a = new EngineAudio();
    // SOUNDS: "<імʼя> <індекс у SOUNDFILES (з 1)>"
    const files = rmp.order.SOUNDFILES;
    await Promise.all(
      rmp.soundNames.map(async (line) => {
        const [name, idx] = line.trim().split(/\s+/);
        const file = files[Number(idx) - 1];
        const bytes = file && rmp.sounds.get(file);
        if (!bytes) return;
        try {
          const copy = bytes.slice().buffer;
          a.buffers.set(name.replace(/Sound$/, '').toLowerCase(), await a.ctx.decodeAudioData(copy));
        } catch {
          /* пошкоджений WAV — пропускаємо */
        }
      }),
    );
    a.idle = a.loop('idle');
    a.full = a.loop('full');
    a.play('start', 0.8);
    return a;
  }

  private loop(name: string) {
    const buf = this.buffers.get(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.master);
    src.start();
    return { src, gain };
  }

  /**
   * Звук, що повторюється (двигуни суперників, двірники): гучність, висота тону й панорама (−1 ліво … 1 право)
   * змінюються плавно. Без такого файлу — null.
   */
  loopSound(name: string): LoopSound | null {
    const buf = this.buffers.get(name);
    if (!buf) return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    // Різні суперники — з різного місця запису, щоб не звучали в унісон.
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    const pan = this.ctx.createStereoPanner();
    src.connect(gain).connect(pan).connect(this.master);
    src.start(0, Math.random() * buf.duration);
    const k = 0.1;
    return {
      set: (volume, rate = 1, balance = 0) => {
        const t = this.ctx.currentTime;
        gain.gain.setTargetAtTime(volume, t, k);
        src.playbackRate.setTargetAtTime(rate, t, k);
        pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, balance)), t, k);
      },
      stop: () => {
        try {
          src.stop();
        } catch {
          /* уже зупинено */
        }
      },
    };
  }

  /** Кінець звуків, що не накладаються (playOnce), за часом аудіоконтексту. */
  private readonly busyUntil = new Map<string, number>();

  /** Одноразовий звук, лише якщо такий самий уже не звучить (сигнал: швидкі повторні натискання не накладаються). */
  playOnce(name: string, volume = 1): void {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running' || this.ctx.currentTime < (this.busyUntil.get(name) ?? 0)) return;
    this.busyUntil.set(name, this.ctx.currentTime + buf.duration);
    this.play(name, volume);
  }

  /** Одноразовий звук; повертає зупинку (обірвати раніше кінця запису). */
  play(name: string, volume = 1, rate = 1): { stop(): void } | null {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
    return {
      stop: () => {
        try {
          src.stop();
        } catch {
          /* уже зупинено */
        }
      },
    };
  }

  /** Оновлення двигуна: rpm — оберти, load — навантаження 0..1 (газ); running = false — двигун заглушено. */
  update(rpm: number, load: number, running = true): void {
    const t = this.ctx.currentTime;
    const k = 0.08;
    // Без газу на високих обертах (накат на передачі) — запис full за обертами, тихіше, ніж під газом, а idle
    // притихає й прискорюється не більше ніж у 1,3 раза: раніше лише idle × rpm / 800 (до 2,2×) звучав як
    // максимальні оберти. Співвідношення гучностей — гіпотеза порту.
    const over = Math.min(1, Math.max(0, (rpm - IDLE_RPM) / 1200));
    const idleRate = 0.8 + 0.5 * over;
    const fullRate = Math.min(2.0, Math.max(0.6, rpm / 1500));
    if (this.idle) {
      this.idle.src.playbackRate.setTargetAtTime(idleRate, t, k);
      this.idle.gain.gain.setTargetAtTime(running ? (0.55 * (1 - load) + 0.1) * (1 - 0.6 * over) : 0, t, k);
    }
    if (this.full) {
      this.full.src.playbackRate.setTargetAtTime(fullRate, t, k);
      this.full.gain.gain.setTargetAtTime(running ? 0.7 * load + 0.3 * (1 - load) * over : 0, t, k);
    }
  }

  setMuted(m: boolean): void {
    this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.unlock);
    window.removeEventListener('keydown', this.unlock);
    void this.ctx.close();
  }
}
