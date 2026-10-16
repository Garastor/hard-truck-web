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
