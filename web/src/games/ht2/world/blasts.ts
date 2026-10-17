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
/** Уламки: розмір квадрата, м; гравітація, м/с² (0x651180 — саме 1,81); крок сліду, м. */
const PART_SIZE = 0.25;
const PART_G = 1.81;
const TRAIL_STEP = 0.1;
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
  /** Тривалість кадру, с (сліди уламків — 0,05 с, один раз); без — кадри розтягнуто на все життя. */
  fdur?: number;
}

/**
 * Уламок (king.exe 0x4ba310 → клас 0x59f070, оновлення 0x59f180; objects.md «Уламки crPart»): квадрат 0,25 м з
 * текстурою (перший кадр), що обертається всередині квадрата з ω = 2π·s; v −= 1,81·Z·dt, p += v·dt, без опору й
 * зіткнень; зникає, щойно опуститься нижче висоти народження. trail — димний слід: клуб кожні 0,1 м шляху.
 */
interface Part {
  s: THREE.Sprite;
  p: THREE.Vector3;
  v: THREE.Vector3;
  bornZ: number;
  omega: number;
  trail: boolean;
  /** Шлях, пройдений від останнього клубу сліду, м. */
  acc: number;
  /** Іскра (0x59df00): гравітація 9,81 і життя 3 с замість «нижче точки народження». */
  spark?: { age: number };
}

interface Flame {
  /** Точка й напрям (гра). */
  p: THREE.Vector3;
  dir: THREE.Vector3;
  rot: THREE.Matrix3;
  age: number;
  life: number;
  /** Режим mnFire: 1 — заправка (burn чи дим, δ = 0,1), 0 — машина (_Blow: лише дим, δ = 0,15). */
  mode?: 0 | 1;
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
  private readonly parts: Part[] = [];
  private readonly tex = new Map<string, THREE.Texture[]>();
  private readonly lamp = new THREE.PointLight(0xffffff, 0, 70, 1);
  private readonly flicker = flickerTable();
  private lampAge = 0;
  private acc = 0;
  /** Машини, що горять (ключ — машина, точка гри): дим як mnFire машини (режим 0) і світло FlameLamp. */
  private readonly fires = new Map<unknown, THREE.Vector3>();
  /** Вибухи машин (_Blow): точка гри й вік, с. */
  private readonly carBlows: { p: THREE.Vector3; age: number }[] = [];

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
    this.tex.set('crpart', frames(['crpart1', 'crpart2', 'crpart3', 'crpart4']));
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
  carFire(p: THREE.Vector3 | null, key: unknown = 'player'): void {
    if (p) this.fires.set(key, p.clone());
    else this.fires.delete(key);
  }

  /**
   * Вибух машини `_Blow` (0x4d9460; objects.md «mnBlow2 і _Blow»): 10 струменів mnFire режиму 0 (життя 0,1…0,15 с) у
   * точці p + u·(0…0,5 м), u = Rz(θ)·Y, напрям u + 5·Z; на кожен з імовірністю 0,3 — 2 іскри crPart (розмір 0,3,
   * розкид 3 м/с, w = 12·(Z + 5·зміщення)); далі 0,3 с щокадру ще по струменю.
   */
  carBlow(p: THREE.Vector3): void {
    this.carBlows.push({ p: p.clone(), age: 0 });
    for (let n = 0; n < 10; n++) this.blowJet(p);
  }

  private blowJet(p: THREE.Vector3): void {
    const a = rnd() * Math.PI * 2;
    const u = new THREE.Vector3(-Math.sin(a), Math.cos(a), 0);
    const o = u.clone().multiplyScalar(0.5 * rnd());
    const dir = u.clone().add(new THREE.Vector3(0, 0, 5));
    this.flames.push({ p: p.clone().add(o), dir, rot: new THREE.Matrix3(), age: 0, life: 0.1 + 0.05 * rnd(), mode: 0, cur: [0, 0, 1], from: [0, 0, 1], to: [0, 0, 1], t: 0 });
    if (rnd() > 0.7) this.sparks(p, dir.normalize(), new THREE.Vector3(0, 0, 1).addScaledVector(o, 5).multiplyScalar(12), 3, 2, 0.3);
  }

  /**
   * Сноп іскор (0x4bb4c0): n квадратів crPart розміру (1 + 0,1s)·size, v = (r₁·b + r₂·a)·(1 + 0,1s)·speed + (1 + 0,1s)·w,
   * a, b ⟂ d; падають з g = 9,81 крізь землю, живуть 3 с.
   */
  private sparks(p: THREE.Vector3, d: THREE.Vector3, w: THREE.Vector3, speed: number, n: number, size: number): void {
    const Z = new THREE.Vector3(0, 0, 1);
    const a = (Math.abs(d.x) > 0.01 || Math.abs(d.y) > 0.01 ? d.clone().cross(Z) : d.clone().cross(new THREE.Vector3(0, 1, 0))).normalize();
    const b = d.clone().cross(a).normalize();
    const parts = this.tex.get('crpart') ?? [];
    for (let i = 0; i < n; i++) {
      const v = b.clone().multiplyScalar(rnd()).addScaledVector(a, rnd()).multiplyScalar((1 + 0.1 * sym()) * speed).addScaledVector(w, 1 + 0.1 * sym());
      const q = this.spawnPart(p, v, parts[Math.floor(rnd() * parts.length)], false, false, (1 + 0.1 * sym()) * size);
      if (q) {
        q.spark = { age: 0 };
        q.omega = Math.PI * (1 + rnd());
      }
    }
  }

  update(dt: number, wind: number): void {
    this.acc = Math.min(this.acc + dt, 0.2);
    while (this.acc >= TICK) {
      this.acc -= TICK;
      this.emit();
    }
    this.step(dt, wind);
    this.stepParts(dt);
    this.updateLamp(dt);
  }

  private emit(): void {
    for (let i = this.blows.length - 1; i >= 0; i--) {
      const b = this.blows[i];
      // Уламки колонки (mnBlow3): 5 одразу з точки P, v = M·(4s₁·X + 4s₂·Y + (2 + 2r)·Z).
      if (b.age === 0) for (let n = 0; n < 5; n++) this.part(b.P.clone().applyMatrix4(b.m), new THREE.Vector3(4 * sym(), 4 * sym(), 2 + 2 * rnd()).applyMatrix3(b.rot));
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
      const car = f.mode === 0;
      const u = new THREE.Vector3(bb, a, 0).applyMatrix3(f.rot).add(f.dir).multiplyScalar((Math.max(k, 0.75) + (car ? 0.15 : 0.1)) * c);
      if (car) this.spawnWorld(f.p.clone(), u, rnd() < 0.5 ? 'smoke' : 'vapor', 1, 5, 3, 1.5);
      else if (rnd() < 0.5) this.spawnWorld(f.p.clone(), u.clone().setZ(u.z * 0.8), 'burn', 0.5, 2.5, 3, 0.75);
      else this.spawnWorld(f.p.clone(), u, 'smoke', 1, 5, 3, 1.5);
    }
    for (let i = this.carBlows.length - 1; i >= 0; i--) {
      const b = this.carBlows[i];
      b.age += TICK;
      if (b.age > 0.3) this.carBlows.splice(i, 1);
      else this.blowJet(b.p);
    }
    this.emitCarFire();
  }

  private emitCarFire(): void {
    for (const fire of this.fires.values()) {
      const c = 1 + 0.5 * rnd();
      const u = new THREE.Vector3(2 * sym(), 2 * sym(), 5).multiplyScalar(0.9 * c);
      this.spawnWorld(fire.clone(), u, rnd() < 0.5 ? 'smoke' : 'vapor', 1, 5, 3, 1.5);
    }
  }

  /**
   * Уламок (0x4ba310) у точці p зі швидкістю v (гра): r < 0,4 — пара burn01 (зі слідом) і msmoke00; r < 0,8 — msmoke00 зі
   * слідом; інакше — crPart1…4 без сліду. Пропуск за налаштуванням деталізації (0x69605c) — порт не має, створює завжди.
   */
  private part(p: THREE.Vector3, v: THREE.Vector3): void {
    const r = rnd();
    if (r < 0.4) {
      this.spawnPart(p, v, this.tex.get('burn')?.[0], true, true);
      this.spawnPart(p, v, this.tex.get('smoke')?.[0], false, false);
    } else if (r < 0.8) this.spawnPart(p, v, this.tex.get('smoke')?.[0], true, false);
    else {
      const parts = this.tex.get('crpart') ?? [];
      this.spawnPart(p, v, parts[Math.floor(rnd() * parts.length)], false, false);
    }
  }

  private spawnPart(p: THREE.Vector3, v: THREE.Vector3, map: THREE.Texture | undefined, trail: boolean, additive: boolean, size = PART_SIZE): Part | null {
    if (!map || this.puffs.length + this.parts.length >= MAX) return null;
    const s = this.free.pop() ?? new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, fog: true }));
    const m = s.material;
    m.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    m.map = map;
    m.needsUpdate = true;
    m.rotation = rnd() * Math.PI * 2;
    m.color.setRGB(1, 1, 1);
    s.scale.setScalar(size);
    s.visible = true;
    this.group.add(s);
    const q: Part = { s, p: p.clone(), v: v.clone(), bornZ: p.z, omega: 2 * Math.PI * sym(), trail, acc: 0 };
    this.parts.push(q);
    return q;
  }

  /** Політ уламків і їхні сліди (0x59f180, 0x4ba820): клуб msmoke кожні 0,1 м, 0,25 → 2 м за 0,75 с, кадр 0,05 с. */
  private stepParts(dt: number): void {
    for (let i = this.parts.length - 1; i >= 0; i--) {
      const q = this.parts[i];
      q.v.z -= (q.spark ? 9.81 : PART_G) * dt;
      const old = q.p.clone();
      q.p.addScaledVector(q.v, dt);
      if (q.spark ? (q.spark.age += dt) > 3 : q.p.z < q.bornZ) {
        q.s.visible = false;
        this.group.remove(q.s);
        this.free.push(q.s);
        this.parts.splice(i, 1);
        continue;
      }
      if (q.trail) {
        const path = q.p.distanceTo(old);
        const k = THREE.MathUtils.clamp((0.75 - dt) * 1.333, 0, 1);
        const s0 = k * 0.25 + 2 * (1 - k);
        for (let d = TRAIL_STEP - q.acc; d <= path; d += TRAIL_STEP) {
          const at = old.clone().lerp(q.p, path > 0 ? d / path : 1);
          this.spawnWorld(at, new THREE.Vector3(sym(), rnd() + rnd(), rnd()), 'smoke', s0, 2, 0, 0.75, 0.05);
        }
        q.acc = (q.acc + path) % TRAIL_STEP;
      }
      q.s.material.rotation += q.omega * dt;
      toThree(q.p.x, q.p.y, q.p.z, q.s.position);
    }
  }

  /** Клуб у координатах станції. */
  private spawn(b: Blow, p: THREE.Vector3, v: THREE.Vector3, kind: string, s0: number, s1: number, g: number, life: number): void {
    this.spawnWorld(p.applyMatrix4(b.m), v.applyMatrix3(b.rot), kind, s0, s1, g, life);
  }

  private spawnWorld(p: THREE.Vector3, v: THREE.Vector3, kind: string, s0: number, s1: number, g: number, life: number, fdur?: number): void {
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
    this.puffs.push({ s, p, v, born: p.clone(), g, age: 0, life, s0, s1, frames, omega: sym() * 2 * Math.PI, fdur });
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
      const frame = q.frames[Math.min(q.frames.length - 1, Math.floor(q.fdur ? q.age / q.fdur : u * q.frames.length))];
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
      // Горить машина — лампа FlameLamp у її точці (одна на гру: у першої палаючої).
      const fire = this.fires.values().next().value;
      if (fire) {
        this.lampAge += dt;
        this.lamp.color.setRGB(1, 0.941, 0.745);
        toThree(fire.x, fire.y, fire.z + 1, this.lamp.position);
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
    for (const q of this.parts) q.s.material.dispose();
    for (const s of this.free) s.material.dispose();
    this.puffs.length = 0;
    this.parts.length = 0;
    this.free.length = 0;
    this.group.removeFromParent();
  }
}
