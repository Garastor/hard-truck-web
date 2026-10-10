/**
 * Режими якості рендера. Найбільше на нагрів телефона впливають кількість пікселів (щільність екрана,
 * згладжування) і частота кадрів, а не геометрія: сцени гри 1998 року — кілька тисяч трикутників.
 */
export type QualityId = 'eco' | 'balance' | 'high';

export interface Quality {
  label: string;
  /** Максимальна щільність пікселів (оригінал — 640×480, тобто ≈ 1). */
  dpr: number;
  /** MSAA. Змінюється лише з перезавантаженням сторінки (атрибут контексту WebGL). */
  antialias: boolean;
  /** Обмеження частоти кадрів (екрани 120 Гц інакше малюють удвічі частіше). */
  fps: number;
}

export const QUALITY: Record<QualityId, Quality> = {
  eco: { label: 'Економія', dpr: 1, antialias: false, fps: 30 },
  balance: { label: 'Баланс', dpr: 1.5, antialias: false, fps: 60 },
  high: { label: 'Якість', dpr: 2, antialias: true, fps: 60 },
};

const KEY = 'ht.quality';
const FPS_KEY = 'ht.showFps';

export function loadQuality(): QualityId {
  try {
    const v = localStorage.getItem(KEY);
    if (v && v in QUALITY) return v as QualityId;
  } catch {
    /* сховище недоступне — типове значення */
  }
  return matchMedia('(pointer: coarse)').matches ? 'balance' : 'high';
}

export function saveQuality(id: QualityId): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* не критично */
  }
}

export function loadShowFps(): boolean {
  try {
    return localStorage.getItem(FPS_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveShowFps(on: boolean): void {
  try {
    localStorage.setItem(FPS_KEY, on ? '1' : '0');
  } catch {
    /* не критично */
  }
}

/** Обмежувач кадрів: пропускає виклик, якщо з попереднього кадру минуло замало часу. */
export class FrameLimiter {
  private last = -Infinity;
  constructor(public fps: number) {}

  /** true — цей кадр малюємо. Допуск 2 мс, щоб 60 к/с на екрані 60 Гц не губили кадри через тремтіння таймера. */
  ready(now: number): boolean {
    if (now - this.last < 1000 / this.fps - 2) return false;
    this.last = now;
    return true;
  }
}

/** Лічильник кадрів: середнє за останню секунду. */
export class FpsMeter {
  private frames = 0;
  private since = performance.now();
  value = 0;

  /** Повертає true, коли значення оновилось (раз на секунду). */
  tick(now: number): boolean {
    this.frames++;
    if (now - this.since < 1000) return false;
    this.value = Math.round((this.frames * 1000) / (now - this.since));
    this.frames = 0;
    this.since = now;
    return true;
  }
}
