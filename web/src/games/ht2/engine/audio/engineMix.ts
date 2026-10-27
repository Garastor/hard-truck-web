/** Гучності (лінійні, 0…1) і висоти тону (множник швидкості запису) петель двигуна. */
export interface EngineMix {
  idleVolume: number;
  idleRate: number;
  fullVolume: number;
  fullRate: number;
}

/**
 * Звук двигуна гравця, як king.exe 0x538ec1…0x5390f8 (двигун працює, [veh+0x5214] = 2). r — оберти, поділені на
 * оберти найбільшої потужності цієї машини n₀ (`tach_with_max_power`; [veh+0x51e8] / [veh+0x51f0]), gas — педаль
 * газу ([veh+0x51f8]). s = min(1, gas + r) — «навантаження», що перетікає з петлі idle в full:
 * - idle: гучність s·min(1; 0,1·√r) + (1 − s)·(0,4·gas + 0,2), тон s·(0,8·r + 0,2) + (1 − s)·(0,2·r + 0,8);
 * - full: гучність 0,5·√s·(0,3·gas + 0,7), тон 0,8·√s·r + 0,2.
 * Тон — частка рідної частоти запису (0x5fd5c0: × 1000 — проміле, [Г]). Саме відносні оберти: звук мотора з n₀ =
 * 2200…4400 об/хв (Peterbilt, Газель, легковики) звучить так само, як у вантажівок з n₀ = 1100…1600.
 */
export function engineMix(r: number, gas: number): EngineMix {
  r = Math.max(0, r);
  gas = Math.min(1, Math.max(0, gas));
  const s = Math.min(1, gas + r);
  return {
    idleVolume: s * Math.min(1, 0.1 * Math.sqrt(r)) + (1 - s) * (0.4 * gas + 0.2),
    idleRate: s * (0.8 * r + 0.2) + (1 - s) * (0.2 * r + 0.8),
    fullVolume: 0.5 * Math.sqrt(s) * (0.3 * gas + 0.7),
    fullRate: 0.8 * Math.sqrt(s) * r + 0.2,
  };
}

/** Межа «легкої» машини, кг: до неї включно — петлі jidle/jfull (king.exe 0x538fa3, 0x64f3f8). */
export const LIGHT_ENGINE_MASS = 3000;

/** Тривалість stop_eng.wav, с — king.exe ділить на неї час глушіння (0x67440c = 2,98). */
export const STOP_SOUND_SECONDS = 2.98;

/**
 * Глушіння двигуна ([veh+0x5214] = 3, king.exe 0x538de0): t — частка запису stop_eng, що минула (час / 2,98 с).
 * Петлі двигуна грають далі за engineMix, помножені на engine = 2·(0,5 − t), і замовкають з t = 0,5 (1,49 с);
 * stop_eng — гучність 0,8·t до t = 0,5, далі 0,4.
 */
export function engineStopFade(t: number): { engine: number; stopSound: number } {
  t = Math.max(0, t);
  return t < 0.5 ? { engine: 2 * (0.5 - t), stopSound: 0.8 * t } : { engine: 0, stopSound: 0.4 };
}
