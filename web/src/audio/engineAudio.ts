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

  /** Одноразовий звук. */
  play(name: string, volume = 1, rate = 1): void {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    src.connect(g).connect(this.master);
    src.start();
  }

  /** Оновлення двигуна: rpm — оберти, load — навантаження 0..1 (газ). */
  update(rpm: number, load: number): void {
    const t = this.ctx.currentTime;
    const k = 0.08;
    const idleRate = Math.min(2.2, Math.max(0.8, rpm / 800));
    const fullRate = Math.min(2.0, Math.max(0.6, rpm / 1500));
    if (this.idle) {
      this.idle.src.playbackRate.setTargetAtTime(idleRate, t, k);
      this.idle.gain.gain.setTargetAtTime(0.55 * (1 - load) + 0.1, t, k);
    }
    if (this.full) {
      this.full.src.playbackRate.setTargetAtTime(fullRate, t, k);
      this.full.gain.gain.setTargetAtTime(0.7 * load, t, k);
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
