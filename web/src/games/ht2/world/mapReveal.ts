import * as THREE from 'three';
import type { Ht2Roads, RoadLine } from './roads';

/**
 * Приховані дороги карти й відкриття проїздом (king.exe `updatePlayerBoxes` 0x42cf50, нарізка карти 0x5291a0;
 * re/notes/ht2/traffic.md «Приховані дороги»). Осі з бітом 0x20 на карті не показуються; ділянка (`roads.sections`,
 * лише 0x20 без 0x10) відкривається вся разом, коли гравець проїде нею: поки він на ділянці, памʼятається габарит
 * точок, де він був; діагональ габариту × REVEAL_K > розмаху ділянки — ділянку відкрито. Перейшов на іншу дорогу —
 * габарит з нуля. Відкрите — ключі ділянок (`MapSection.key`) у кар'єрі (`Ht2Career.mapOpened`).
 *
 * Гіпотеза порту: «гравець на ділянці» — найближча вісь ближче за ON_ROAD (+ пів ширини дороги); у king.exe — дорога
 * PositionId гравця (проєкція на мережу ІІ), поріг невідомий. Габарит — у плані (у king.exe — 3D).
 */
/** Коефіцієнт діагоналі габариту гравця (king.exe 0x64b7b8 = 1,2): відкрити, проїхавши ≈ 83 % розмаху ділянки. */
export const REVEAL_K = 1.2;
/** Поза дорогою (край дороги + стільки, м) — уже не на ній. */
const ON_ROAD = 15;

export class MapReveal {
  /** Відкриті ділянки (індекси `roads.sections`). */
  readonly opened = new Set<number>();
  /** Лічильник змін (карти перебудовують дороги). */
  version = 0;
  /** Нова ділянка відкрита (кар'єра зберігає). */
  onOpen: ((key: string) => void) | null = null;
  private section = -1;
  private readonly box = new THREE.Box2();
  private readonly byKey = new Map<string, number>();

  constructor(private readonly roads: Ht2Roads, saved: readonly string[] = []) {
    roads.sections.forEach((s, i) => this.byKey.set(s.key, i));
    this.load(saved);
  }

  /** Відкрите зі збереження (замінює поточне). */
  load(saved: readonly string[]): void {
    this.opened.clear();
    for (const k of saved) {
      const i = this.byKey.get(k);
      if (i !== undefined) this.opened.add(i);
    }
    this.section = -1;
    this.version++;
  }

  /** Ключі відкритих ділянок — для збереження. */
  keys(): string[] {
    return [...this.opened].sort((a, b) => a - b).map((i) => this.roads.sections[i].key);
  }

  /** Чи видно вісь на карті. */
  visible(axis: RoadLine): boolean {
    if (!(axis.flags & 0x20)) return true;
    return axis.section !== undefined && this.opened.has(axis.section);
  }

  /** Кадр гравця: позиція машини. Повертає індекс щойно відкритої ділянки чи −1. */
  update(pos: THREE.Vector3): number {
    const n = this.roads.nearestAxis(pos);
    const s = n && n.dist <= n.axis.width / 2 + ON_ROAD ? (n.axis.section ?? -1) : -1;
    if (s !== this.section) {
      // Інша дорога — габарит з нуля (king.exe: +0x3a8 ≠ дорога PositionId).
      this.section = s;
      this.box.makeEmpty();
    }
    if (s < 0 || this.opened.has(s)) return -1;
    this.box.expandByPoint(new THREE.Vector2(pos.x, pos.z));
    if (this.box.min.distanceTo(this.box.max) * REVEAL_K <= this.roads.sections[s].span) return -1;
    this.opened.add(s);
    this.version++;
    this.onOpen?.(this.roads.sections[s].key);
    return s;
  }
}

/** Шлях доріг карти: усі осі, крім прихованих (біт 0x20), доки ділянку не відкрито (без reveal — усі). */
export function roadPath(lines: readonly RoadLine[], reveal: MapReveal | null): Path2D {
  const path = new Path2D();
  for (const l of lines) {
    if (reveal && !reveal.visible(l)) continue;
    l.pts.forEach((p, i) => {
      if (i) path.lineTo(p.x, p.z);
      else path.moveTo(p.x, p.z);
    });
  }
  return path;
}
