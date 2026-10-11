/**
 * Налагодження в браузері (лише dev-збірка): `window.ht.dev`. Скорочує типові перевірки до одного-двох викликів —
 * і працює в схованій вкладці (кроки симуляції без requestAnimationFrame). Порядок перевірки — у скілі
 * `.claude/skills/verify-in-game`.
 *
 *   await ht.dev.ready()                         — дочекатися заїзду після завантаження сторінки
 *   ht.dev.setup({ cam: 'far', weather: 'rain', start: true })
 *   ht.dev.teleport('room_011')                  — точка рестарту кімнати; або { x, z, heading }
 *   ht.dev.run(10)                               — 10 с гри автопілотом (синхронно), звіт: кімнати, відстань
 *   ht.dev.smoke(300)                            — автопрохід із пошуком застрягань
 *   ht.dev.still()                               — зупинити машину перед знімком екрана
 *   ht.dev.info()                                — траса, кімната, позиція, швидкість, камера, погода
 */
import type { CamMode, DriveSession } from '../modes/drive';

interface DevHost {
  drive: () => DriveSession | null;
  level: () => string;
}

interface RunReport {
  seconds: number;
  rooms: string[];
  distance: number;
  /** Найдовший відрізок часу (с), коли машина майже не рухалась. */
  stuckFor: number;
  room: string | null;
  speedKmh: number;
  /** Скільки разів машина перекидалась (після 3 с на боці — відновлення, як кнопка «↺»). */
  flips: number;
}

const STEP = 1 / 30;

export function installDevTools(host: DevHost): object {
  const need = (): DriveSession => {
    const d = host.drive();
    if (!d) throw new Error('немає заїзду: відкрий ?tab=drive і дочекайся ht.dev.ready()');
    return d;
  };

  const info = () => {
    const d = host.drive();
    if (!d) return { level: host.level(), drive: false };
    const t = d.playerTruck.body.translation();
    return {
      level: host.level(),
      room: d.roomName,
      pos: [t.x, t.y, t.z].map((v) => Math.round(v * 10) / 10),
      speedKmh: Math.round(d.playerTruck.speedKmh),
      cam: d.cameraMode,
      raining: d.raining,
      night: d.night,
      reflections: d.reflectionMode,
      autopilot: d.autopilotOn,
    };
  };

  const run = (seconds: number, opts: { autopilot?: boolean } = {}): RunReport => {
    const d = need();
    d.skipCountdown();
    if ((opts.autopilot ?? true) !== d.autopilotOn) d.toggleAutopilot(opts.autopilot ?? true);
    const rooms = new Set<string>();
    let distance = 0;
    let still = 0;
    let stuckFor = 0;
    let prev = d.playerTruck.body.translation();
    let flips = 0;
    let onSide = 0;
    const steps = Math.round(seconds / STEP);
    for (let i = 0; i < steps; i++) {
      d.update(STEP);
      onSide = d.flipped ? onSide + STEP : 0;
      if (onSide > 3) {
        flips++;
        onSide = 0;
        d.recover();
      }
      if (d.roomName) rooms.add(d.roomName);
      const p = d.playerTruck.body.translation();
      const moved = Math.hypot(p.x - prev.x, p.z - prev.z);
      distance += moved;
      still = moved < 0.5 * STEP && !onSide ? still + STEP : 0; // лежання на боці — не застрягання
      stuckFor = Math.max(stuckFor, still);
      prev = p;
    }
    return {
      seconds,
      rooms: [...rooms],
      distance: Math.round(distance),
      stuckFor: Math.round(stuckFor * 10) / 10,
      room: d.roomName,
      speedKmh: Math.round(d.playerTruck.speedKmh),
      flips,
    };
  };

  return {
    info,
    run,

    /** Дочекатися заїзду (після навігації на ?tab=drive…). */
    async ready(timeoutMs = 30000) {
      const t0 = performance.now();
      while (!host.drive()) {
        if (performance.now() - t0 > timeoutMs) throw new Error('заїзд не стартував');
        await new Promise((r) => setTimeout(r, 200));
      }
      return info();
    },

    /** Камера, погода, відблиски, старт без відліку, автопілот. */
    setup(o: { cam?: CamMode; weather?: 'dry' | 'rain'; reflections?: 'own' | 'original'; start?: boolean; autopilot?: boolean }) {
      const d = need();
      if (o.cam) d.cameraMode = o.cam;
      if (o.weather) d.setWeather(o.weather === 'rain');
      if (o.reflections) d.reflectionMode = o.reflections;
      if (o.start) d.skipCountdown();
      if (o.autopilot !== undefined && o.autopilot !== d.autopilotOn) d.toggleAutopilot(o.autopilot);
      return info();
    },

    teleport(target: string | { x: number; z: number; heading?: number }) {
      const d = need();
      if (!d.teleport(target)) throw new Error(`немає кімнати ${String(target)}`);
      for (let i = 0; i < 10; i++) d.update(STEP);
      return info();
    },

    /** Автопрохід: чи машина ніде не застрягла (stuckFor < 3 с — гаразд). */
    smoke(seconds = 300) {
      const r = run(seconds);
      return { ...r, ok: r.stuckFor < 3, rooms: r.rooms.length };
    },

    /** Зупинити машину (перед знімком): без автопілота, нульова швидкість, кілька кроків. */
    still() {
      const d = need();
      if (d.autopilotOn) d.toggleAutopilot(false);
      for (let i = 0; i < 15; i++) {
        d.playerTruck.body.setLinvel({ x: 0, y: d.playerTruck.body.linvel().y, z: 0 }, true);
        d.playerTruck.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        d.update(STEP);
      }
      return info();
    },
  };
}
