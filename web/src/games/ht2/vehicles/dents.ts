import * as THREE from 'three';

/**
 * Вмʼятини HT2 — оригінальні перемикачі моделі вантажівки (TRUCKS.B3D, блоки 21): `refer_Damage<зона>Key` для зон
 * FL, FC, FR (перед), L, R (боки), BL, BC, BR (зад) і `refer_Damage1Key` (капот). Стан 0 — ціла деталь, далі —
 * дедалі сильніше пом'ята, останній (порожній) — деталь відпала.
 *
 * Гіпотези порту: зона — за напрямком удару в системі машини (зміна швидкості за крок: назад — удар спереду, убік —
 * збоку, частка поперечної складової — лівий/центр/правий край); пошкодження зони росте з силою удару, стан —
 * за порогами DENT_STEPS; капот — разом із центром переду.
 */
export type DentZone = 'FL' | 'FC' | 'FR' | 'L' | 'R' | 'BL' | 'BC' | 'BR';
const ZONES: DentZone[] = ['FL', 'FC', 'FR', 'L', 'R', 'BL', 'BC', 'BR'];
/** Пороги пошкодження зони для станів 1, 2, 3. */
const DENT_STEPS = [0.2, 0.5, 0.9];
/** Пошкодження зони за 1 м/с зміни швидкості. */
const PER_MS = 0.04;

/** Зона удару за зміною швидкості dv у системі машини (Three.js: уперед — −z, праворуч — +x). */
export function hitZone(dvLocal: THREE.Vector3): DentZone {
  const { x, z } = dvLocal;
  if (Math.abs(z) >= Math.abs(x)) {
    // Швидкість змінилась назад (+z) — удар спереду.
    const front = z > 0;
    const side = x / (Math.abs(z) + 1e-6);
    // Поштовх праворуч (+x) — удар зліва.
    const edge = side > 0.35 ? 'L' : side < -0.35 ? 'R' : 'C';
    return `${front ? 'F' : 'B'}${edge}` as DentZone;
  }
  return x > 0 ? 'L' : 'R';
}

export class Dents {
  constructor(
    readonly zones: Partial<Record<DentZone, number>>,
    private readonly setSwitch: ((name: string, state: number) => void) | undefined,
    private readonly states: ((name: string) => number) | undefined,
  ) {
    this.apply();
  }

  /** Удар: зміна швидкості dv (м/с) у системі машини. */
  hit(dvLocal: THREE.Vector3): void {
    const z = hitZone(dvLocal);
    this.zones[z] = Math.min(1, (this.zones[z] ?? 0) + dvLocal.length() * PER_MS);
    this.apply();
  }

  repair(): void {
    for (const z of ZONES) delete this.zones[z];
    this.apply();
  }

  private apply(): void {
    if (!this.setSwitch) return;
    const state = (name: string, d: number) => {
      const n = this.states?.(name) ?? 3;
      const s = DENT_STEPS.filter((t) => d >= t).length;
      return Math.min(n - 1, s);
    };
    for (const z of ZONES) {
      const d = this.zones[z] ?? 0;
      for (const name of [`refer_Damage${z}Key`, `Damage${z}Key`]) this.setSwitch(name, state(name, d));
    }
    // Капот — разом з центром переду (5 станів: останній — відлетів).
    this.setSwitch('refer_Damage1Key', state('refer_Damage1Key', this.zones.FC ?? 0));
  }
}
