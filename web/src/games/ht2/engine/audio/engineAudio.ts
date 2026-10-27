import type { RmpArchive } from '../formats/rmp';
import { engineMix, type EngineMix } from './engineMix';

export { LIGHT_ENGINE_MASS } from './engineMix';

/**
 * Звук вантажівки на Web Audio з оригінальних WAV (секції SOUNDFILES/SOUNDS архіву RMP).
 * Як у king.exe (0x538370): idleSound — холостий хід, fullSound — під навантаженням (легкі машини — jidle/jfull),
 * gearSound — перемикання, startSound — запуск двигуна. Тон і гучність — від обертів, поділених на n₀ машини (engineMix).
 * iOS/Chrome дозволяють звук лише після жесту користувача. Аудіоконтекст — один на всю гру, а не новий на кожну
 * трасу: новий контекст, створений після довгого завантаження траси без свіжого жесту, iOS запускав призупиненим, і
 * звук зникав на весь заїзд. Розблоковують його події, що на iOS вважаються жестом (pointerup/touchend/click/keydown;
 * pointerdown від дотику — ні), а після згортання чи дзвінка (стан «interrupted») — ще й повернення на вкладку.
 */
export interface LoopSound {
  set(volume: number, rate?: number, balance?: number): void;
  stop(): void;
}

let shared: AudioContext | null = null;

/**
 * Налагодження: `?mute` в адресі — без звуку до кінця сесії вкладки (тестові вкладки поруч із грою користувача;
 * гра може переписати адресу раніше, ніж завантажиться звук — оболонка запамʼятовує, rememberMute).
 */
export const MUTED = import.meta.env.DEV && (new URLSearchParams(location.search).has('mute') || session('ht.mute') === '1');

function session(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Запамʼятати `?mute` з адреси на сесію вкладки (викликає оболонка до запуску гри). */
export function rememberMute(): void {
  try {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('mute')) sessionStorage.setItem('ht.mute', '1');
  } catch {
    /* приватний режим */
  }
}

/** Спільний AudioContext гри (розблоковується першим жестом) — і для роликів (engine/video/player.ts). */
export function sharedContext(): AudioContext {
  if (shared) return shared;
  const ctx = new AudioContext();
  shared = ctx;
  const unlock = () => {
    if (ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  };
  for (const ev of ['pointerup', 'touchend', 'click', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });
  // Згорнули застосунок чи сховали вкладку — кадри браузер зупиняє сам, а цикли звуку (двигун, дощ, музика) грали б
  // далі; призупинити контекст, після повернення — відновити.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void ctx.suspend().catch(() => undefined);
    else unlock();
  });
  return ctx;
}

export class EngineAudio {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  /** Гучності меню «Звук»: двигун гравця й решта ефектів (0…1). */
  private readonly engineBus: GainNode;
  private readonly sfxBus: GainNode;
  private readonly buffers = new Map<string, AudioBuffer>();
  private idle: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private full: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Останній розрахунок звуку двигуна (налагодження: `window.ht2.drive.audio.lastMix`). */
  lastMix: (EngineMix & { light: boolean; running: boolean }) | null = null;
  /** Петлі легких машин (≤ 3000 кг: Газель, легковики) — king.exe 0x538fa3. */
  private jidle: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  private jfull: { src: AudioBufferSourceNode; gain: GainNode } | null = null;
  /** Звуки, що повторюються, — зупинити разом із трасою (контекст спільний і не закривається). */
  private readonly loops = new Set<AudioBufferSourceNode>();

  private constructor() {
    this.ctx = sharedContext();
    void this.ctx.resume().catch(() => undefined);
    this.master = this.ctx.createGain();
    this.master.gain.value = MUTED ? 0 : 0.6;
    this.master.connect(this.ctx.destination);
    this.engineBus = this.ctx.createGain();
    this.engineBus.connect(this.master);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.connect(this.master);
  }

  /** Гучність двигуна гравця й ефектів (меню Esc «Звук»), 0…1. */
  setVolumes(engine: number, sfx: number): void {
    const t = this.ctx.currentTime;
    this.engineBus.gain.setTargetAtTime(engine, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(sfx, t, 0.05);
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
    a.jidle = a.loop('jidle');
    a.jfull = a.loop('jfull');
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
    src.connect(gain).connect(this.engineBus);
    src.start();
    this.loops.add(src);
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
    src.connect(gain).connect(pan).connect(this.sfxBus);
    src.start(0, Math.random() * buf.duration);
    this.loops.add(src);
    const k = 0.1;
    return {
      set: (volume, rate = 1, balance = 0) => {
        const t = this.ctx.currentTime;
        gain.gain.setTargetAtTime(volume, t, k);
        src.playbackRate.setTargetAtTime(rate, t, k);
        pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, balance)), t, k);
      },
      stop: () => {
        this.loops.delete(src);
        try {
          src.stop();
        } catch {
          /* уже зупинено */
        }
      },
    };
  }

  /** Аудіоконтекст розблоковано (є жест користувача). */
  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Кінець звуків, що не накладаються (playOnce), за часом аудіоконтексту. */
  private readonly busyUntil = new Map<string, number>();

  /** Одноразовий звук, лише якщо такий самий уже не звучить (сигнал: швидкі повторні натискання не накладаються). */
  playOnce(name: string, volume = 1): boolean {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running' || this.ctx.currentTime < (this.busyUntil.get(name) ?? 0)) return false;
    this.busyUntil.set(name, this.ctx.currentTime + buf.duration);
    return !!this.play(name, volume);
  }

  /** Одноразовий звук (loop — по колу до stop, з початку запису); повертає зупинку (обірвати раніше кінця). */
  play(name: string, volume = 1, rate = 1, loop = false): { stop(): void } | null {
    const buf = this.buffers.get(name);
    if (!buf || this.ctx.state !== 'running') return null;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    // Запуск двигуна — гучністю двигуна, решта — ефектів.
    src.connect(g).connect(name === 'start' ? this.engineBus : this.sfxBus);
    src.start();
    // Петлю зупиняє й завершення гри (dispose).
    if (loop) this.loops.add(src);
    return {
      stop: () => {
        this.loops.delete(src);
        try {
          src.stop();
        } catch {
          /* уже зупинено */
        }
      },
    };
  }

  /**
   * Оновлення двигуна (king.exe 0x538ec1…0x5390f8, див. engineMix): rpm — оберти, gas — педаль газу 0…1,
   * maxPowerRpm — оберти найбільшої потужності цієї машини (`tach_with_max_power`), light — машина до 3000 кг
   * (петлі jidle/jfull); running = false — двигун заглушено.
   */
  update(rpm: number, gas: number, running = true, maxPowerRpm = 1600, light = false): void {
    const t = this.ctx.currentTime;
    const k = 0.05;
    const m = engineMix(rpm / Math.max(1, maxPowerRpm), gas);
    this.lastMix = { ...m, light, running };
    const on = light && this.jidle && this.jfull ? [this.jidle, this.jfull] : [this.idle, this.full];
    for (const loop of [this.idle, this.full, this.jidle, this.jfull]) {
      if (!loop) continue;
      const i = on.indexOf(loop);
      const vol = i === 0 ? m.idleVolume : i === 1 ? m.fullVolume : 0;
      loop.gain.gain.setTargetAtTime(running ? vol : 0, t, k);
      if (i >= 0) loop.src.playbackRate.setTargetAtTime(i === 0 ? m.idleRate : m.fullRate, t, k);
    }
  }

  setMuted(m: boolean): void {
    this.master.gain.setTargetAtTime(m ? 0 : 0.6, this.ctx.currentTime, 0.05);
  }

  /** Звуки траси замовкають; спільний контекст лишається для наступної траси. */
  dispose(): void {
    for (const src of this.loops) {
      try {
        src.stop();
      } catch {
        /* уже зупинено */
      }
    }
    this.loops.clear();
    this.master.disconnect();
  }
}
