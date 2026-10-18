import * as THREE from 'three';

/**
 * Пошкодження кузова й шин HT2 за king.exe (re/notes/ht2/trucks-switches.md) — оригінальні перемикачі моделі
 * вантажівки чи причепа (TRUCKS.B3D, блоки 21):
 * - вмʼятини `refer_Damage<зона>Key`: зони FC, FR, FL (перед), R, L (боки), BR, BL, BC (зад); частка зони 0…1, стан —
 *   trunc(макс. стан × частка), макс. — з даних (кількість станів − 1);
 * - капот `refer_Damage1Key` не бʼється сам — стан виводиться з передніх зон (0x5553e0);
 * - побиті колеса `refer_DamageWheel<N>Key` (N — wheel_space N): 4 стани, стан = trunc(3 × частка);
 * - стоп-сигнали `StopFaraKeyL/R` (0 — темні, 1 — стоп, 2 — габарит) і задній хід `BackFaraKeyL/R` (0/1), 0x546d10.
 *
 * Удар (0x554c20): v — зміна швидкості, м/с; до 2 м/с шкоди немає; v' = v − 2,
 * E = v'·(1 + 15v'/(v' + 5))·(1 − 0,96·exp(−(0,04(v' − 10))²)). Зона — за напрямком n від центру машини до точки
 * удару (0x5465c0), частка += вага·E·швидкість зони (0,1; FC — 0,05). Шина (0x501010): точка удару ближче
 * √5 м до колеса — частка += (E − 1)·0,5/(d² + 0,5)·0,05.
 *
 * Гіпотези порту: напрямок до точки удару — протилежний зміні швидкості (точки контакту не рахуємо), сама точка —
 * на краю габаритної коробки в цьому напрямку; вплив побитих шин на фізику (радіус, опір кочення) — ще не перенесено.
 */
export type DentZone = 'FL' | 'FC' | 'FR' | 'L' | 'R' | 'BL' | 'BC' | 'BR';
const ZONES: DentZone[] = ['FL', 'FC', 'FR', 'L', 'R', 'BL', 'BC', 'BR'];
/** Швидкість накопичення частки зони за одиницю енергії удару. */
const RATE: Record<DentZone, number> = { FC: 0.05, FR: 0.1, FL: 0.1, R: 0.1, L: 0.1, BR: 0.1, BL: 0.1, BC: 0.1 };
const WHEEL_RATE = 0.05;
/** Квадрат відстані від точки удару до колеса, у межах якого шина пошкоджується, м². */
const WHEEL_REACH2 = 5;
const WHEEL_STATES = 3;

/** Енергія удару за зміною швидкості v, м/с (0 — нижче порогу 2 м/с). */
export function hitEnergy(v: number): number {
  if (v < 2) return 0;
  const u = v - 2;
  return u * (1 + (15 * u) / (u + 5)) * (1 - 0.96 * Math.exp(-((0.04 * (u - 10)) ** 2)));
}

/**
 * Вага зон за напрямком (nx — праворуч, ny — уперед, одиничний): перед — квадрати проєкцій (FC — ny, FR/FL — під
 * 45°), зад — BC за ny, BR/BL під 30° від осі; боки — лінійно.
 */
export function zoneWeights(nx: number, ny: number): Partial<Record<DentZone, number>> {
  const w: Partial<Record<DentZone, number>> = {};
  const sq = (k: DentZone, a: number) => {
    if (a > 0) w[k] = a * a;
  };
  if (ny > 0) w.FC = ny * ny;
  sq('FR', 0.707 * (nx + ny));
  sq('FL', 0.707 * (ny - nx));
  if (ny < 0) w.BC = ny * ny;
  sq('BR', 0.5 * nx - 0.866 * ny);
  sq('BL', -0.866 * ny - 0.5 * nx);
  if (nx > 0) w.R = nx;
  if (nx < 0) w.L = -nx;
  return w;
}

/** Геометрія моделі для шин: колеса (x праворуч, y уперед, м) і половини габаритів. */
export interface DentGeometry {
  wheels: [number, number][];
  half: [number, number];
}

/** Геометрія з моделі: колеса — з просторів коліс, габарити — коробка видимої геометрії (система моделі гри). */
export function dentGeometry(model: { root: THREE.Object3D; wheelBase: THREE.Matrix4[] }, box: THREE.Box3): DentGeometry {
  model.root.updateWorldMatrix(true, false);
  const local = box.clone().applyMatrix4(model.root.matrixWorld.clone().invert());
  const size = local.getSize(new THREE.Vector3());
  return {
    wheels: model.wheelBase.map((m) => [m.elements[12], m.elements[13]] as [number, number]),
    half: [size.x / 2, size.y / 2],
  };
}

export class Dents {
  constructor(
    /** Частки зон і шин (`W0`…`W7`) — зберігаються в кар'єрі. */
    readonly zones: Partial<Record<string, number>>,
    private readonly setSwitch: ((name: string, state: number) => void) | undefined,
    private readonly states: ((name: string) => number) | undefined,
    private readonly geom: DentGeometry | null = null,
  ) {
    this.apply();
  }

  /**
   * Удар: зміна швидкості dv (м/с) у системі машини (Three.js: уперед — −z); front — множник переду (захист фар).
   * Повертає середній приріст часток 8 зон кузова (0…1) — для стану машини в кар'єрі.
   */
  hit(dvLocal: THREE.Vector3, front = 1): number {
    const v = Math.hypot(dvLocal.x, dvLocal.z);
    const e = hitEnergy(v);
    if (e <= 0) return 0;
    let added = 0;
    // До точки удару — проти зміни швидкості: nx = −dv.x, уперед (−z) — dv.z.
    const nx = -dvLocal.x / v;
    const ny = dvLocal.z / v;
    const w = zoneWeights(nx, ny);
    for (const z of ZONES) {
      const k = w[z];
      if (!k) continue;
      const f = z[0] === 'F' && z.length === 2 ? front : 1;
      const was = this.zones[z] ?? 0;
      this.zones[z] = Math.min(1, was + k * e * f * RATE[z]);
      added += this.zones[z]! - was;
    }
    if (this.geom && e > 1) {
      const [hx, hy] = this.geom.half;
      const t = Math.min(Math.abs(nx) > 1e-6 ? hx / Math.abs(nx) : Infinity, Math.abs(ny) > 1e-6 ? hy / Math.abs(ny) : Infinity);
      const px = nx * t;
      const py = ny * t;
      this.geom.wheels.forEach(([x, y], i) => {
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        if (d2 >= WHEEL_REACH2) return;
        const key = `W${i}`;
        this.zones[key] = Math.min(1, (this.zones[key] ?? 0) + ((e - 1) * 0.5 * WHEEL_RATE) / (d2 + 0.5));
      });
    }
    this.apply();
    return added / ZONES.length;
  }

  repair(): void {
    for (const k of Object.keys(this.zones)) delete this.zones[k];
    this.apply();
  }

  /** Стан зони (0 — ціла). */
  state(zone: DentZone): number {
    return this.stateOf(`refer_Damage${zone}Key`, this.zones[zone] ?? 0);
  }

  /** Стан шини N (0 — ціла, 3 — лише диск). */
  wheel(i: number): number {
    return Math.min(WHEEL_STATES, Math.trunc(WHEEL_STATES * (this.zones[`W${i}`] ?? 0)));
  }

  /**
   * Задні вогні (0x546d10): стоп горить при гальмі, якщо ціла зона BR (оригінал перевіряє BR для обох ліхтарів);
   * інакше — габарит, коли ввімкнені габарити. Задній хід: лівий — при цілій BL, правий — при цілій BR.
   */
  rearLights(brake: boolean, reverse: boolean, size: boolean): void {
    if (!this.setSwitch) return;
    const br = this.state('BR') !== 0;
    const bl = this.state('BL') !== 0;
    const stop = brake && !br ? 1 : size ? 2 : 0;
    if (stop !== this.lastStop) {
      this.lastStop = stop;
      this.setSwitch('StopFaraKeyL', stop);
      this.setSwitch('StopFaraKeyR', stop);
    }
    const back = (reverse && !bl ? 1 : 0) | (reverse && !br ? 2 : 0);
    if (back !== this.lastBack) {
      this.lastBack = back;
      this.setSwitch('BackFaraKeyL', back & 1);
      this.setSwitch('BackFaraKeyR', back >> 1);
    }
  }
  private lastStop = -1;
  private lastBack = -1;

  private stateOf(name: string, d: number): number {
    const n = this.states?.(name) ?? 0;
    return n > 1 ? Math.min(n - 1, Math.trunc((n - 1) * d)) : 0;
  }

  private apply(): void {
    if (!this.setSwitch) return;
    for (const z of ZONES) {
      const d = this.zones[z] ?? 0;
      for (const name of [`refer_Damage${z}Key`, `Damage${z}Key`]) this.setSwitch(name, this.stateOf(name, d));
    }
    for (let i = 0; this.states?.(`refer_DamageWheel${i}Key`); i++) this.setSwitch(`refer_DamageWheel${i}Key`, this.wheel(i));
    // Капот (0x5553e0) — з передніх зон.
    const fr = this.state('FR');
    const fl = this.state('FL');
    const fc = this.state('FC');
    const prev = this.hood;
    this.hood = fr >= 2 && fl >= 2 ? 4 : fr >= 1 && fl >= 1 ? 3 : fr >= 1 && prev <= 2 ? 2 : fl >= 1 && prev <= 2 ? 1 : fc >= 1 ? 3 : 0;
    const n = this.states?.('refer_Damage1Key') ?? 0;
    if (n) this.setSwitch('refer_Damage1Key', Math.min(n - 1, this.hood));
    // Побитий зад гасить ліхтарі — перерахувати.
    this.lastStop = this.lastBack = -1;
  }
  private hood = 0;
}
