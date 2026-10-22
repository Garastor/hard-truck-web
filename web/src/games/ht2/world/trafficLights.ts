import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from './world';

/**
 * Світлофори Дальнобойщиків 2 (king.exe; re/notes/ht2/police.md §2 «Червоне світло»).
 *
 * - Тригери — блоки B3D типу 13 з кодом події 29 (0x1D) у листках дерева площин (блоки 9: форма — площина
 *   nx·x + ny·y + nz·z + d у системі гри, f ≥ 0 — група 0, інакше 1). Діагональні площини ділять перехрестя на
 *   чотири сектори, остання — стоп-лінія: зовні — зона підʼїзду p = 0/10/20/30 (+1 — інвертована фаза), всередині —
 *   стоп-лінія p = 40. Дерево покриває весь простір, тож порт зважає на нього лише ближче RADIUS до центру
 *   перехрестя (гіпотеза: у king.exe тригери обходяться лише в кімнаті гравця).
 * - Лампи — перемикачі `refer_TrafficLightKey0/1` (6 станів); таймер 0x4ce160: tick = ⌊t·0,4⌋ mod 12 (цикл 30 с,
 *   крок 2,5 с), t — час гри в секундах (гіпотеза: реальні секунди симуляції). Key0: стани 0 0 0 0 (0↔1) 2 3 3 3 3
 *   (3↔4) 5; Key1 — зі зсувом на 6 тактів; «↔» — миготіння (частота — гіпотеза, BLINK Гц).
 * - Дозвіл: біт фази (такти 6–10); зона p: u = біт, інвертований при p mod 10 ≠ 0 і при ⌊p/10⌋ = 1 чи 3; для
 *   p = 0/20 проїзд дозволено на зелений і миготливий зелений (15–27,5 с), для 10/30 — 0–15 і 27,5–30 с
 *   (асиметрія king.exe). Стоп-лінія при «не можна» — порушення (штраф — у гри, з міліцією поруч).
 */
const RADIUS = 70;
/**
 * Трафік бачить світлофор раніше (порт): до LOOK_FAR м від центру, якщо їде на перехрестя (курс на центр ближче
 * arccos LOOK_COS). З 70 м машина на 80–90 км/год уже не встигала стати перед стоп-лінією (25–35 м від центру) і
 * проїжджала на червоне.
 */
const LOOK_FAR = 130;
const LOOK_COS = 0.9;
const NEAR = 55;
const BLINK = 2;
const KEY0 = [0, 0, 0, 0, -1, 2, 3, 3, 3, 3, -2, 5];
const KEY1 = [3, 3, 3, 3, -2, 5, 0, 0, 0, 0, -1, 2];

interface Junction {
  region: string;
  root: Block;
  center: THREE.Vector3;
}

/** Точка Three.js → система гри (x, y, висота). */
function toGame(p: THREE.Vector3): [number, number, number] {
  return [p.x, -p.z, p.y];
}

function isLight(b: Block): boolean {
  return b.data.t === 13 && b.data.trigger.i1 === 29;
}

function hasLight(b: Block): boolean {
  return isLight(b) || (b.groups ?? []).some((g) => g.some(hasLight));
}

/** Листок дерева для точки: p тригера (undefined — немає). */
function leaf(blocks: Block[], x: number, y: number, z: number): number | undefined {
  for (const b of blocks) {
    if (isLight(b)) return b.data.t === 13 ? b.data.trigger.i2 : undefined;
    if (b.data.t === 9 && b.data.shape.kind === 5) {
      const [a, bb, c, d] = b.data.shape.v;
      const r = leaf(b.groups?.[a * x + bb * y + c * z + d >= 0 ? 0 : 1] ?? [], x, y, z);
      if (r !== undefined) return r;
    } else if (b.groups) {
      for (const g of b.groups) {
        const r = leaf(g, x, y, z);
        if (r !== undefined) return r;
      }
    }
  }
  return undefined;
}

/**
 * Центр перехрестя з площин зон підʼїзду: кожна площина задає координату вздовж своєї нормалі (точка −d·n/|n|²),
 * тож x усереднюється з вагою |nx|, y — з вагою |ny|.
 */
function centerOf(root: Block): THREE.Vector3 {
  let sx = 0;
  let wx = 0;
  let sy = 0;
  let wy = 0;
  const visit = (b: Block): void => {
    if (isLight(b) && b.data.t === 13 && b.data.trigger.i2 < 40 && b.data.trigger.values.length >= 4) {
      const f = new Float32Array(b.data.trigger.values.buffer, b.data.trigger.values.byteOffset, 4);
      const len = Math.hypot(f[0], f[1], f[2]) || 1;
      const nx = f[0] / len;
      const ny = f[1] / len;
      const k = -f[3] / len;
      sx += nx * k * Math.abs(nx);
      wx += Math.abs(nx) * Math.abs(nx);
      sy += ny * k * Math.abs(ny);
      wy += Math.abs(ny) * Math.abs(ny);
    }
    for (const g of b.groups ?? []) g.forEach(visit);
  };
  visit(root);
  return wx && wy ? new THREE.Vector3(sx / wx, 0, -(sy / wy)) : new THREE.Vector3(Infinity, 0, Infinity);
}

/** Стан зони p: чи можна проїжджати (біт фази з інверсіями). */
export function allowedAt(p: number, tick: number): boolean {
  let u = tick >= 6 && tick <= 10;
  if (p % 10 !== 0) u = !u;
  const q = Math.floor(p / 10);
  if (q === 1 || q === 3) u = !u;
  return u;
}

export class TrafficLights {
  private readonly junctions: Junction[] = [];
  private readonly seen = new WeakSet<LoadedRegion>();
  private readonly lampRegions = new Set<LoadedRegion>();
  /** Час світлофорів, с. */
  time = 0;
  /** Чи дозволено гравцеві (DAT_006f34d0): ставиться в зоні підʼїзду, перевіряється на стоп-лінії. */
  private allowed = true;
  private lastLeaf: number | undefined;
  private lastStates = '';

  /** Такт циклу 0…11. */
  get tick(): number {
    return Math.floor(this.time * 0.4) % 12;
  }

  /** Нові/вивантажені регіони: перехрестя з тригерами 0x1D і регіони з лампами. */
  sync(loaded: Iterable<LoadedRegion>): void {
    const live = new Set<LoadedRegion>(loaded);
    for (const r of live) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      const find = (bs: Block[]): void => {
        for (const b of bs) {
          if (b.data.t === 9 && hasLight(b)) this.junctions.push({ region: r.id, root: b, center: centerOf(b) });
          else if (b.groups) b.groups.forEach(find);
        }
      };
      find(r.built.assembler.b3d.blocks);
      this.lampRegions.add(r);
      this.lastStates = '';
    }
    for (const r of [...this.lampRegions]) if (!live.has(r)) this.lampRegions.delete(r);
    const ids = new Set([...live].map((r) => r.id));
    for (let i = this.junctions.length - 1; i >= 0; i--) if (!ids.has(this.junctions[i].region)) this.junctions.splice(i, 1);
  }

  /** Крок таймера й ламп. */
  update(dt: number, loaded: Iterable<LoadedRegion>): void {
    this.time += dt;
    this.sync(loaded);
    const t = this.tick;
    const blinkOn = Math.floor(this.time * BLINK * 2) % 2 === 0;
    const state = (s: number) => (s === -1 ? (blinkOn ? 0 : 1) : s === -2 ? (blinkOn ? 3 : 4) : s);
    const s0 = state(KEY0[t]);
    const s1 = state(KEY1[t]);
    const key = `${s0},${s1}`;
    if (key === this.lastStates) return;
    this.lastStates = key;
    for (const r of this.lampRegions) {
      r.built.assembler.setSwitch('refer_TrafficLightKey0', s0);
      r.built.assembler.setSwitch('refer_TrafficLightKey1', s1);
    }
  }

  /** Листок перехрестя для точки (ближче RADIUS до центру) чи undefined. */
  zoneAt(p: THREE.Vector3): number | undefined {
    for (const j of this.junctions) {
      if (Math.hypot(j.center.x - p.x, j.center.z - p.z) > RADIUS) continue;
      const [x, y, z] = toGame(p);
      const r = leaf([j.root], x, y, z);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  /**
   * Гравець (подія 0x1D, 0x56ffd0): у зоні підʼїзду — запамʼятати дозвіл; вʼїзд у стоп-лінію при «не можна» —
   * true (порушення; раз за перетин), після стоп-лінії — знову «можна».
   */
  player(p: THREE.Vector3): boolean {
    const z = this.zoneAt(p);
    let red = false;
    if (z !== undefined && z < 40) this.allowed = allowedAt(z, this.tick);
    else if (z !== undefined && z >= 40 && this.lastLeaf !== z) {
      red = !this.allowed;
      this.allowed = true;
    }
    this.lastLeaf = z;
    return red;
  }

  /**
   * Для трафіку: відстань до стоп-лінії, перед якою треба стати (червоне для зони машини), чи Infinity. Стоп-лінія
   * — площина зони (у тригері зони), відстань — уздовж курсу машини.
   */
  stopAhead(p: THREE.Vector3, heading: THREE.Vector3): number {
    for (const j of this.junctions) {
      const dx = j.center.x - p.x;
      const dz = j.center.z - p.z;
      const r = Math.hypot(dx, dz);
      if (r > LOOK_FAR || (r > RADIUS && dx * heading.x + dz * heading.z < LOOK_COS * r)) continue;
      const [x, y, z] = toGame(p);
      // Дерево зон надійне лише поблизу (далі ~70 м — чужі площини): зону дальньої машини беремо в точці на її курсі
      // за NEAR м від центру; відстань до стоп-лінії — від самої машини.
      const ahead = Math.max(0, r - NEAR);
      const [qx, qy, qz] = ahead ? toGame(new THREE.Vector3(p.x + heading.x * ahead, p.y, p.z + heading.z * ahead)) : [x, y, z];
      const blk = leafBlock([j.root], qx, qy, qz);
      if (!blk || blk.data.t !== 13) continue;
      const pz = blk.data.trigger.i2;
      // Трафік — лише на зелений (порт): такти 5 і 11 — жовтий чи червоний із жовтим для всіх; king.exe дозволяє
      // зонам 10/30 і їх (гравцеві штрафу немає), але машина, що рушає на червоний із жовтим, виглядає порушником.
      // Хто вже не встигає стати, проїде й так (driver.decide).
      const go = allowedAt(pz, this.tick) && this.tick % 6 !== 5;
      if (pz >= 40 || go || blk.data.trigger.values.length < 4) return Infinity;
      const f = new Float32Array(blk.data.trigger.values.buffer, blk.data.trigger.values.byteOffset, 4);
      // Площина в системі гри → Three.js: n = (nx, nz, −ny).
      const n = new THREE.Vector3(f[0], f[2], -f[1]);
      const len = n.length() || 1;
      const side = (f[0] * x + f[1] * y + f[2] * z + f[3]) / len;
      // Наближення до площини: зсув уздовж курсу зменшує |side|.
      const approach = -Math.sign(side) * (n.dot(heading) / len);
      if (approach <= 0.2) return Infinity;
      return Math.abs(side) / approach;
    }
    return Infinity;
  }
}

/** Листок-блок (для площини стоп-лінії). */
function leafBlock(blocks: Block[], x: number, y: number, z: number): Block | undefined {
  for (const b of blocks) {
    if (isLight(b)) return b;
    if (b.data.t === 9 && b.data.shape.kind === 5) {
      const [a, bb, c, d] = b.data.shape.v;
      const r = leafBlock(b.groups?.[a * x + bb * y + c * z + d >= 0 ? 0 : 1] ?? [], x, y, z);
      if (r) return r;
    } else if (b.groups) {
      for (const g of b.groups) {
        const r = leafBlock(g, x, y, z);
        if (r) return r;
      }
    }
  }
  return undefined;
}
