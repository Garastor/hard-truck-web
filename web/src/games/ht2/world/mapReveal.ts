import * as THREE from 'three';
import type { Ht2Roads, RoadLine } from './roads';

/**
 * Приховані дороги карти й відкриття проїздом (king.exe `updatePlayerBoxes` 0x42cf50, нарізка карти 0x5291a0;
 * re/notes/ht2/traffic.md «Приховані дороги»). Осі з бітом 0x20 на карті не показуються; ділянка (`roads.sections`,
 * лише 0x20 без 0x10) відкривається вся разом, коли гравець проїде нею: поки він на ділянці, памʼятається габарит
 * точок, де він був; діагональ габариту × REVEAL_K > розмаху ділянки — ділянку відкрито. Перейшов на іншу дорогу —
 * габарит з нуля. Відкрите — ключі ділянок (`MapSection.key`) у кар'єрі (`Ht2Career.mapOpened`).
 *
 * Відступ порту (на прохання користувача): приховані дороги — часто просто трава без видимого полотна, тож суворе «на
 * дорозі» (як PositionId у king.exe) змушувало їхати точно по невидимій лінії. Тут гравець «на ділянці», коли край
 * будь-якої її осі ближче за ON_ROAD (не обовʼязково найближча вісь — поряд може бути інша дорога), і габарит кожної
 * ділянки накопичується окремо з проєкцій машини на вісь (трава-доріжка місцями відходить від осі WAY, тож габарит
 * самих позицій недобирав розмаху); скидається він лише тоді, коли гравець відʼїхав від ділянки далі за LEAVE.
 * Габарит — у плані (у king.exe — 3D, з позицій машини).
 */
/** Коефіцієнт діагоналі габариту гравця (king.exe 0x64b7b8 = 1,2): відкрити, проїхавши ≈ 83 % розмаху ділянки. */
export const REVEAL_K = 1.2;
/** Ближче до краю осі ділянки, м, — гравець їде нею (рахується в габарит). */
const ON_ROAD = 60;
/** Далі від усіх осей ділянки, м, — зʼїхав з неї: габарит з нуля. */
const LEAVE = 150;

export class MapReveal {
  /** Відкриті ділянки (індекси `roads.sections`). */
  readonly opened = new Set<number>();
  /** Лічильник змін (карти перебудовують дороги). */
  version = 0;
  /** Нова ділянка відкрита (кар'єра зберігає). */
  onOpen: ((key: string) => void) | null = null;
  /** Габарити ділянок, біля яких гравець зараз (у плані). */
  private readonly boxes = new Map<number, THREE.Box2>();
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
    this.boxes.clear();
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
    const near = this.roads.sectionsNear(pos, LEAVE);
    // Відʼїхав далеко — габарит з нуля (king.exe: +0x3a8 ≠ дорога PositionId).
    for (const s of this.boxes.keys()) if (!near.has(s)) this.boxes.delete(s);
    let res = -1;
    for (const [s, n] of near) {
      if (n.dist > ON_ROAD || this.opened.has(s)) continue;
      let box = this.boxes.get(s);
      if (!box) this.boxes.set(s, (box = new THREE.Box2()));
      // Проєкція на вісь, не сама машина: виляння вбік не зменшує зарахований проїзд.
      box.expandByPoint(new THREE.Vector2(n.point.x, n.point.z));
      if (box.min.distanceTo(box.max) * REVEAL_K <= this.roads.sections[s].span) continue;
      this.opened.add(s);
      this.boxes.delete(s);
      this.version++;
      this.onOpen?.(this.roads.sections[s].key);
      if (res < 0) res = s;
    }
    return res;
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
