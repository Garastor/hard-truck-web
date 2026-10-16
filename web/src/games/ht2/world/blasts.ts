import * as THREE from 'three';
import type { SceneAssembler } from '../engine/render/sceneBuilder';
import { TREE_LIGHT } from './trees';
import { toThree } from './world';

/**
 * Вибух колонки заправки й полумʼя — задачі king.exe `mnBlow3` і `mnFire` (car.cpp; re/notes/ht2/objects.md,
 * «ефекти вибуху й диму»). Усе — клуби-спрайти (aeffects.cpp): розмір s0 → s1 за життя, кадри матеріалу один раз за
 * життя (msmoke00…03, mvapor00…03, burn01…03), рух p += (v + X·вітер·0,21)·dt, гальмування |v| −= g·dt (далі 15 м
 * від народження — g = 20), обертання текстури ω·(1 − вік/життя)², ω ∈ [−2π, 2π].
 *
 * mnBlow3 (координати станції, z — угору; P — колонка (−9 | 0 | 8, 1, 1)):
 * - фаза 1, 2 с: щокадру 5 клубів на кільці 2 м навколо центру, що піднімається від P на 2 м/с, v = (1,5s₁, 1,5s₂, 2)·1,5;
 *   дим (msmoke / mvapor навпіл) 3 → 6 м, g 3, 0,75 с; з імовірністю 1 − t/2 ще вогонь (burn) 3 → 4,5 м, 0,5 с; під дахом
 *   навісу (z ≥ 4 у |x| ≤ 10, 0 ≤ y ≤ 12) дим розтікається (z = 4, v.z = 0);
 * - фаза 2, 2 с: щокадру 15 клубів з P, v = 0,5·горизонтальний напрям + 1,333·Z, 1 → 3 м, g 0, 3 с;
 * - через 2 с — два полумʼя mnFire в основі колонки (напрям (0, 0, 4)) на 60 + 30r і 30 + 15r с: щокадру burn
 *   (u.z × 0,8; 0,5 → 2,5 м; 0,75 с) чи msmoke (1 → 5 м; 1,5 с), u = (b·X + a·Y + d)·(max(k, 0,75) + 0,1)·c, a, b ∈
 *   [−2, 2], c ∈ [1, 1,5] — нова ціль раз на 0,25 с, перехід лінійний; k — частка життя, що лишилася.
 * - світло — одна лампа ThrowLamp у полумʼї: колір (1, 0,6, 0,3)·f·мерехтіння, f від k.
 *
 * Гіпотези порту: «щокадру» — 30 разів на секунду (у exe — справжні кадри, тож кількість залежить від FPS); не більше
 * MAX клубів (телефони); вогонь — адитивний, дим — прозорість текстури; уламки (5 шт., crPart) не відтворено;
 * затухання світла 1/(1 + 0,01·d²) до 70 м — гіпотеза агента; освітлення клубів — як дерев (TREE_LIGHT).
 */
const TICK = 1 / 30;
const MAX = 700;

interface Puff {
  s: THREE.Sprite;
  /** Позиція, швидкість (гра), точка народження. */
  p: THREE.Vector3;
  v: THREE.Vector3;
  born: THREE.Vector3;
  g: number;
  age: number;
  life: number;
  s0: number;
  s1: number;
  frames: THREE.Texture[];
  omega: number;
}

interface Flame {
  /** Точка й напрям (гра). */
  p: THREE.Vector3;
  dir: THREE.Vector3;
  rot: THREE.Matrix3;
  age: number;
  life: number;
  /** Тремтіння: поточні й цільові a, b, c і час до нової цілі. */
  cur: [number, number, number];
  from: [number, number, number];
  to: [number, number, number];
  t: number;
}

interface Blow {
  m: THREE.Matrix4;
  rot: THREE.Matrix3;
  P: THREE.Vector3;
  age: number;
  fired: boolean;
}

const rnd = Math.random;
const sym = () => rnd() * 2 - 1;

/** Таблиця мерехтіння світла (32 значення: відрізки по 1–5 кроків між випадковими рівнями з [0,25, 1]). */
function flickerTable(): number[] {
  const t: number[] = [];
  let a = 0.25 + 0.75 * rnd();
  while (t.length < 32) {
    const n = 1 + Math.floor(rnd() * 5);
    const b = 0.25 + 0.75 * rnd();
    for (let i = 0; i < n && t.length < 32; i++) t.push(a + ((b - a) * i) / n);
    a = b;
  }
  return t;
}

export class Blasts {
  readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private readonly free: THREE.Sprite[] = [];
  private readonly blows: Blow[] = [];
  private readonly flames: Flame[] = [];
  private readonly tex = new Map<string, THREE.Texture[]>();
  private readonly lamp = new THREE.PointLight(0xffffff, 0, 70, 1);
  private readonly flicker = flickerTable();
  private lampAge = 0;
  private acc = 0;
  /** Машина, що горить (точка гри; null — немає): дим як mnFire машини (режим 0) і світло FlameLamp. */
  private fire: THREE.Vector3 | null = null;

  constructor(asm: SceneAssembler) {
    this.group.name = 'blasts';
    const mats = asm.b3d.materials.map((m) => m.toLowerCase());
    const frames = (names: string[]) =>
      names.flatMap((n) => {
        const i = mats.indexOf(n);
        const map = i >= 0 ? (asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
        return map ? [map] : [];
      });
    this.tex.set('smoke', frames(['msmoke00', 'msmoke01', 'msmoke02', 'msmoke03']));
    const vapor = frames(['mvapor00', 'mvapor01', 'mvapor02', 'mvapor03']);
    this.tex.set('vapor', vapor.length ? vapor : frames(['mvsmoke00', 'mvsmoke01', 'mvsmoke02', 'mvsmoke03']));
    this.tex.set('burn', frames(['burn01', 'burn02', 'burn03']));
    // Лампа — одна на всю гру (як ThrowLamp) і вже в сцені: нове світло перекомпільовувало б усі шейдери.
    this.lamp.color.setRGB(1, 0.6, 0.3);
    this.group.add(this.lamp);
  }

  /** Вибух колонки k станції з матрицею m (координати гри). */
  blow3(m: THREE.Matrix4, column: number): void {
    const x = [-9, 0, 8][column] ?? 0;
    this.blows.push({ m: m.clone(), rot: new THREE.Matrix3().setFromMatrix4(m), P: new THREE.Vector3(x, 1, 1), age: 0, fired: false });
  }

  /**
   * Горіння машини (0x54e180; objects.md «Горіння машини»): точка в координатах гри чи null. Щокадру клуб диму
   * msmoke/mvapor (1 → 5 м, 1,5 с) з тремтінням язика mnFire (δ = 0,15, d = (0, 0, 5) — гіпотеза), світло — лампа
   * кольору FlameLamp (1, 0,941, 0,745) з тим самим мерехтінням.
   */
  carFire(p: THREE.Vector3 | null): void {
    this.fire = p ? p.clone() : null;
  }

  update(dt: number, wind: number): void {
    this.acc = Math.min(this.acc + dt, 0.2);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.emit();
    }
    this.step(dt, wind);
    this.updateLamp(dt);
  }

  private emit(): void {
    for (let i = this.blows.length - 1; i >= 0; i--) {
      const b = this.blows[i];
      b.age += TICK;
      if (b.age < 2) {
        const c = b.P.clone().add(new THREE.Vector3(0, 0, 2 * b.age));
        for (let n = 0; n < 5; n++) {
          const a = rnd() * Math.PI * 2;
          const p = c.clone().add(new THREE.Vector3(Math.cos(a) * 2, Math.sin(a) * 2, 0));
          const v = new THREE.Vector3(1.5 * sym(), 1.5 * sym(), 2).multiplyScalar(1.5);
          // Дах навісу: дим розтікається під ним.
          const q = p.clone().addScaledVector(v, 0.75);
          if (q.z >= 4 && Math.abs(q.x) <= 10 && q.y >= 0 && q.y <= 12) {
            p.z = Math.min(p.z, 4);
            v.z = 0;
          }
          this.spawn(b, p, v, rnd() < 0.5 ? 'smoke' : 'vapor', 3, 6, 3, 0.75);
          if (rnd() < 1 - b.age / 2) this.spawn(b, p, v.clone(), 'burn', 3, 4.5, 3, 0.5);
        }
      } else if (b.age < 4) {
        for (let n = 0; n < 15; n++) {
          const a = rnd() * Math.PI * 2;
          this.spawn(b, b.P.clone(), new THREE.Vector3(0.5 * Math.cos(a), 0.5 * Math.sin(a), 1.333), rnd() < 0.5 ? 'smoke' : 'vapor', 1, 3, 0, 3);
        }
      }
      if (b.age >= 2 && !b.fired) {
        b.fired = true;
        const base = b.P.clone().setZ(0).applyMatrix4(b.m);
        const dir = new THREE.Vector3(0, 0, 4).applyMatrix3(b.rot);
        for (const life of [60 + 30 * rnd(), 30 + 15 * rnd()])
          this.flames.push({ p: base.clone(), dir, rot: b.rot, age: 0, life, cur: [0, 0, 1], from: [0, 0, 1], to: [0, 0, 1], t: 0 });
        this.lampAge = 0;
      }
      if (b.age >= 4) this.blows.splice(i, 1);
    }
    for (let i = this.flames.length - 1; i >= 0; i--) {
      const f = this.flames[i];
      f.age += TICK;
      if (f.age > f.life) {
        this.flames.splice(i, 1);
        continue;
      }
      // Тремтіння: раз на 0,25 с нова ціль, перехід лінійний.
      f.t += TICK;
      if (f.t >= 0.25) {
        f.t = 0;
        f.from = [...f.cur];
        f.to = [2 * sym(), 2 * sym(), 1 + 0.5 * rnd()];
      }
      const w = f.t / 0.25;
      f.cur = [0, 1, 2].map((j) => f.from[j] + (f.to[j] - f.from[j]) * w) as [number, number, number];
      const k = 1 - f.age / f.life;
      const [a, bb, c] = f.cur;
      const u = new THREE.Vector3(bb, a, 0).applyMatrix3(f.rot).add(f.dir).multiplyScalar((Math.max(k, 0.75) + 0.1) * c);
      if (rnd() < 0.5) this.spawnWorld(f.p.clone(), u.clone().setZ(u.z * 0.8), 'burn', 0.5, 2.5, 3, 0.75);
      else this.spawnWorld(f.p.clone(), u, 'smoke', 1, 5, 3, 1.5);
    }
    this.emitCarFire();
  }

  private emitCarFire(): void {
    if (!this.fire) return;
    const c = 1 + 0.5 * rnd();
    const u = new THREE.Vector3(2 * sym(), 2 * sym(), 5).multiplyScalar(0.9 * c);
    this.spawnWorld(this.fire.clone(), u, rnd() < 0.5 ? 'smoke' : 'vapor', 1, 5, 3, 1.5);
  }

  /** Клуб у координатах станції. */
  private spawn(b: Blow, p: THREE.Vector3, v: THREE.Vector3, kind: string, s0: number, s1: number, g: number, life: number): void {
    this.spawnWorld(p.applyMatrix4(b.m), v.applyMatrix3(b.rot), kind, s0, s1, g, life);
  }

  private spawnWorld(p: THREE.Vector3, v: THREE.Vector3, kind: string, s0: number, s1: number, g: number, life: number): void {
    const frames = this.tex.get(kind) ?? [];
    if (!frames.length || this.puffs.length >= MAX) return;
    const s = this.free.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: true }));
    const m = s.material;
    m.blending = kind === 'burn' ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.map = frames[0];
    m.needsUpdate = true;
    m.rotation = rnd() * Math.PI * 2;
    s.visible = true;
    this.group.add(s);
    this.puffs.push({ s, p, v, born: p.clone(), g, age: 0, life, s0, s1, frames, omega: sym() * 2 * Math.PI });
  }

  private step(dt: number, wind: number): void {
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const q = this.puffs[i];
      q.age += dt;
      if (q.age >= q.life) {
        q.s.visible = false;
        this.group.remove(q.s);
        this.free.push(q.s);
        this.puffs.splice(i, 1);
        continue;
      }
      const g = q.p.distanceTo(q.born) > 15 ? 20 : q.g;
      const sp = q.v.length();
      if (sp > 0) q.v.multiplyScalar(Math.max(0, sp - g * dt) / sp);
      q.p.x += (q.v.x + wind * 0.21) * dt;
      q.p.y += q.v.y * dt;
      q.p.z += q.v.z * dt;
      const u = q.age / q.life;
      const m = q.s.material;
      const frame = q.frames[Math.min(q.frames.length - 1, Math.floor(u * q.frames.length))];
      if (m.map !== frame) {
        m.map = frame;
        m.needsUpdate = true;
      }
      m.rotation += q.omega * (1 - u) * (1 - u) * dt;
      if (m.blending !== THREE.AdditiveBlending) m.color.copy(TREE_LIGHT.value);
      else m.color.setRGB(1, 1, 1);
      q.s.scale.setScalar(q.s0 + (q.s1 - q.s0) * u);
      toThree(q.p.x, q.p.y, q.p.z, q.s.position);
    }
  }

  /** ThrowLamp: у першому живому полумʼї, колір (1, 0,6, 0,3)·f·мерехтіння. */
  private updateLamp(dt: number): void {
    const f = this.flames[0];
    if (!f) {
      // Горить машина — лампа FlameLamp у її точці.
      if (this.fire) {
        this.lampAge += dt;
        this.lamp.color.setRGB(1, 0.941, 0.745);
        toThree(this.fire.x, this.fire.y, this.fire.z + 1, this.lamp.position);
        this.lamp.intensity = Math.PI * this.flicker[Math.floor(this.lampAge / 0.1) % 31];
      } else this.lamp.intensity = 0;
      return;
    }
    this.lamp.color.setRGB(1, 0.6, 0.3);
    this.lampAge += dt;
    const k = 1 - f.age / f.life;
    const level = k > 0.5 ? k : k > 0.25 ? 0.5 : k + 0.25;
    const t = this.flicker[Math.floor(this.lampAge / 0.1) % 31];
    toThree(f.p.x, f.p.y, f.p.z + 1, this.lamp.position);
    this.lamp.intensity = Math.PI * level * t;
  }

  dispose(): void {
    for (const q of this.puffs) q.s.material.dispose();
    for (const s of this.free) s.material.dispose();
    this.puffs.length = 0;
    this.free.length = 0;
    this.group.removeFromParent();
  }
}
