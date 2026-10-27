import * as THREE from 'three';
import type { RgbaImage } from '../formats/binary';
import { SceneCopy, WATER_FRAGMENT, WATER_LOOK, WATER_VERTEX, WaterBuffer, toLevels, waterUniforms, type Levels } from './waterBuffer';

/**
 * Вода на лобовому склі 3D-кабіни й двірники. В оригіналі текстура скла `glass.txr` позначена `noload` — гра
 * заповнює її сама (HTruck.exe: об'єкт 0x4ca910, конструктор 0x463d38, спільна з 2D-кабіною логіка 0x462f38):
 * - краплі `txr\glass_1.msk` — 20/с (поле +0x20), сліди стікання `txr\glass_2.msk` — 2/с (20 / 10);
 * - двірники ходять від спокою (+90°) до −18° (поле +0x9c = −π/10) зі швидкістю 135°/с (0x54625c), звук — на
 *   кожен помах; стирають сектор, який замели.
 * Тут — так само, як у 2D-кабіні (render/cab2dRain.ts): буфер рівнів води (прозорість масок MS16), на склі —
 * заломлення й світлотінь (власний ефект за згодою користувача, render/waterBuffer.ts), без сірого; сліди
 * повільніші й частіше починаються вгорі скла (на прохання користувача). Геометрію (вісь, довжину двірника,
 * площину й UV скла, напрям «униз» по склу) беремо з моделі кабіни.
 */

/**
 * Двірники Дальнобойщиків 2 (king.exe 0x5a58e0, поля обʼєкта скла 0x70/0xb0): кут від спокою −0,12217 рад (−7°) до
 * π/2 і назад зі швидкістю 3π/4 рад/с (0x651540). У порту кут відлічується від положення моделі (там двірник лежить
 * під склом) у протилежний бік: спокій — +0,12217, межа — −π/2.
 */
const REST = 0.12217304555555557;
const SWEEP = Math.PI / 2;
/** Робоча матриця повороту двірників (щокадру — без нових обʼєктів). */
const WIPER_TMP = new THREE.Matrix4();
const SPEED = 2.35619445;
/**
 * Краплі й сліди залежать від швидкості (0x5a58e0, поле 0xb8 — гіпотеза: м/с): краплі × (1 − 0,05·v), сліди ×
 * (1 + 0,05·v); понад 20 — крапель немає, слідів удвічі більше.
 */
const SPEED_K = 0.05;
const SPEED_MAX = 20;
/**
 * Нових крапель і слідів за секунду. Оригінал — 20 і 20 / 10 на текстуру 256 × 256; буфер тут удвічі більший
 * (краплі вдвічі менші, SIZE), тож щоб скло заростало так само швидко, крапель — ×4 (площа). Сліди — як в
 * оригіналі: їхня маска збільшена вдвічі (RUNNER_SCALE), тож кожен слід займає ту саму частку скла.
 */
const DROPS_PER_SEC = 20 * 4;
const RUNNERS_PER_SEC = 20 / 10;
/** Сліди: частка висоти скла за секунду (як 7,5 px/с на 250 px у 2D-кабіні), крок — 1 px буфера. */
const RUN_SPEED = 7.5 / 250;
const RUN_TICK = 1;
/**
 * Довжина сліду — частка висоти скла (випадково між межами), далі вода «закінчується» і слід зупиняється. Відступ
 * порту (на прохання користувача): сліди на всю висоту скла (перезапис рівнем 17) за 2–3 хв змивали всі краплі —
 * скло лишалося під тонкою водою без жодної круглої краплі. Як закінчує слід king.exe — не розібрано.
 */
/**
 * Збільшення маски сліду glass_2 (найближчий піксель): на буфері 512 вона вдвічі менша, ніж на glass.txr 256
 * оригіналу; на прохання користувача краплі потоку більші — ×2 (як в оригіналі відносно скла).
 */
const RUNNER_SCALE = 2;
const RUN_LENGTH_MIN = 0.05;
const RUN_LENGTH_MAX = 0.25;
/**
 * Розмір буфера (текстура скла повторюється). В оригіналі — glass.txr 256 × 256; тут 512: маски 5 × 5 у своєму
 * розмірі — краплі вдвічі менші (з 256 були завеликі, на прохання користувача), частота — DROPS_PER_SEC.
 */
const SIZE = 512;
/** Нахил поверхні води — різниця рівнів через стільки пікселів буфера. */
const SLOPE_SPAN = 2;
/** Порядок малювання лопатей двірників — після скла (0), до керма (10, drive.ts). */
const WIPER_ORDER = 5;
/** Відрізків лопаті зі своєю рамкою змін (вивантаження на відеокарту, wipe). */
const WIPE_SEGMENTS = 8;
/** Рамки відрізків: спершу мінімуми (x, y) усіх відрізків, потім максимуми. */
const WIPE_BOX = new Float64Array(WIPE_SEGMENTS * 4);
/** Найбільше відхилення дуги кінця лопаті від хорди віяла стирання, px буфера. */
const WIPE_SAG = 0.35;
/** Найбільший крок часу, с (після паузи двірник проскочив би межу помаху). */
const MAX_DT = 0.1;

interface Wiper {
  obj: THREE.Object3D;
  base: THREE.Matrix4;
  /** Вісь і кінець двірника в системі кабіни (у спокої), довжина — з геометрії. */
  pivot: THREE.Vector3;
  length: number;
  /** Матриця «двірник → кабіна» у спокої. */
  toCab: THREE.Matrix4;
}

export class GlassRain {
  private readonly wipers: Wiper[] = [];
  /** Площина скла в системі кабіни: точка, два ребра і їхні UV — для переведення точки в UV. */
  /**
   * Площина скла в системі кабіни: точка й два ребра першого трикутника (координати s, t) і трикутники скла в цих
   * координатах. UV — за трикутником, у який потрапляє точка: скло — чотирикутник-трапеція з двох трикутників, і UV
   * на них різні (ZilR — до 0,32 по v); одна площина першого трикутника зсувала стирання на другому.
   */
  private glass: { o: THREE.Vector3; e1: THREE.Vector3; e2: THREE.Vector3; tris: GlassTri[] } | null = null;
  private readonly water = new WaterBuffer(SIZE, SIZE, true);
  private readonly copy = new SceneCopy();
  /** Масштаб копії кадру під водою (SceneCopy): телефон — 0,5 (drive.ts), ПК — повна. */
  copyScale = 1;
  private readonly uniforms = waterUniforms(this.water.texture, SLOPE_SPAN / SIZE, SLOPE_SPAN / SIZE);
  private readonly drop: Levels | null;
  private readonly runner: Levels | null;
  private readonly runners: { a: number; b: number; acc: number; end: number }[] = [];
  /** Напрям «униз» по склу в пікселях буфера (одиничний), поперечний, і межі скла вздовж них. */
  private down = new THREE.Vector2(0, 1);
  private side = new THREE.Vector2(1, 0);
  private range = { a0: 0, a1: SIZE, b0: 0, b1: SIZE };
  private angle = REST;
  /** Швидкість машини, м/с (краплі й сліди). */
  private speed = 0;
  /** Хід від спокою до межі помаху; інакше — назад, до спокою. */
  private out = false;
  private moving = false;
  private dropAcc = 0;
  private runAcc = 0;
  wipersOn = false;
  raining = false;
  /** Початок кожного помаху (звук двірників). */
  onStroke: (() => void) | null = null;

  /**
   * cabRoot — внутрішня група кабіни (система моделі), у якій шукаємо скло й двірники; drop, runner — маски
   * glass_1 і glass_2 (рівні — їхня прозорість).
   */
  constructor(cabRoot: THREE.Object3D, drop: RgbaImage | null, runner: RgbaImage | null) {
    this.drop = drop && toLevels(drop, 3);
    this.runner = runner && scaleLevels(toLevels(runner, 3), RUNNER_SCALE);
    cabRoot.updateMatrixWorld(true);
    const inv = cabRoot.matrixWorld.clone().invert();
    cabRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshBasicMaterial).map?.name === 'txr/glass.txr' && !this.glass) {
        this.glass = glassPlane(mesh, inv);
        this.measureGlass(mesh, inv);
        mesh.material = new THREE.ShaderMaterial({
          uniforms: this.uniforms,
          vertexShader: WATER_VERTEX,
          fragmentShader: WATER_FRAGMENT,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
      }
      // Екземпляр двірника й обʼєкт усередині мають те саме імʼя — обертаємо лише зовнішній. «WWiper» — так названо
      // частину двірників у кабінах Kenworth, International і Mack (гіпотеза: описка в даних; чи рухає їх king.exe —
      // не перевірено).
      if (/^w?wiper\d?$/i.test(o.name) &&!this.wipers.some((w) => isAncestor(w.obj, o))) {
        // Лопать — пласка смуга майже в площині скла: малюється після скла (прозорий прохід, renderOrder), інакше
        // вода на склі (шейдер малює копію кадру без кабіни) ховала її під плівкою й краплями.
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (!m.isMesh) return;
          const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((mt: THREE.Material) => Object.assign(mt.clone(), { transparent: true }));
          m.material = Array.isArray(m.material) ? mats : mats[0];
          m.renderOrder = WIPER_ORDER;
        });
        const toCab = o.matrixWorld.clone().premultiply(inv);
        const box = new THREE.Box3();
        const own = o.matrixWorld.clone().invert();
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.computeBoundingBox();
          box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld.clone().premultiply(own)));
        });
        this.wipers.push({
          obj: o,
          base: o.matrix.clone(),
          pivot: new THREE.Vector3().applyMatrix4(toCab),
          length: Math.max(0.1, box.max.x),
          toCab,
        });
      }
    });
  }

  get hasWipers(): boolean {
    return this.wipers.length > 0;
  }

  /**
   * Напрям «униз» по склу в UV (вісь моделі, проєкція якої на площину скла найдовша — z у системі гри або y у
   * Three.js) і межі скла вздовж нього — для слідів стікання.
   */
  private measureGlass(mesh: THREE.Mesh, inv: THREE.Matrix4): void {
    const g = this.glass!;
    const n = new THREE.Vector3().crossVectors(g.e1, g.e2).normalize();
    const inPlane = (v: THREE.Vector3) => v.clone().addScaledVector(n, -v.dot(n));
    const z = inPlane(new THREE.Vector3(0, 0, -1));
    const y = inPlane(new THREE.Vector3(0, -1, 0));
    const down3 = (z.lengthSq() > y.lengthSq() ? z : y).normalize();
    const c = g.o.clone().addScaledVector(g.e1, 0.5).addScaledVector(g.e2, 0.5);
    const d = this.uv(c.clone().addScaledVector(down3, 0.05)).sub(this.uv(c)).multiplyScalar(SIZE);
    if (d.lengthSq() < 1e-9) return;
    this.down = d.normalize();
    this.side = new THREE.Vector2(-this.down.y, this.down.x);
    const P = mesh.geometry.attributes.uv;
    const r = { a0: Infinity, a1: -Infinity, b0: Infinity, b1: -Infinity };
    for (let i = 0; i < P.count; i++) {
      const p = new THREE.Vector2(P.getX(i), P.getY(i)).multiplyScalar(SIZE);
      const a = p.dot(this.down);
      const b = p.dot(this.side);
      r.a0 = Math.min(r.a0, a);
      r.a1 = Math.max(r.a1, a);
      r.b0 = Math.min(r.b0, b);
      r.b1 = Math.max(r.b1, b);
    }
    this.range = r;
    void inv;
  }

  /**
   * Після згортання застосунку (телефон) чи відновлення контексту WebGL — вода на склі й копія кадру заново й цілком:
   * вивантаження лише змінених прямокутників (waterBuffer.ts) інакше лягало б на текстуру, якої на відеокарті вже немає.
   */
  private readonly refresh = (): void => {
    if (document.visibilityState === 'hidden') return;
    this.water.invalidate();
    this.copy.dispose();
  };
  private canvas: HTMLCanvasElement | null = null;

  /** Перед малюванням кабіни (у кадрі вже світ): зміни буфера — на відеокарту, копія кадру для заломлення. */
  prepare(renderer: THREE.WebGLRenderer): void {
    if (!this.canvas) {
      this.canvas = renderer.domElement;
      this.canvas.addEventListener('webglcontextrestored', this.refresh);
      document.addEventListener('visibilitychange', this.refresh);
    }
    this.water.upload(renderer);
    this.uniforms.wet.value = this.water.empty ? 0 : 1;
    if (this.water.empty) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.copy.copy(renderer, 0, 0, size.x, size.y, this.uniforms, this.copyScale);
    // Масштаб «пікселя кадру 640×480» на екрані — як у 2D-кабіни.
    const dev = size.y / 480;
    this.uniforms.k.value = WATER_LOOK.refract * dev;
    this.uniforms.kMax.value = WATER_LOOK.refractMax * dev;
  }

  update(dt: number, speedKmh = 0): void {
    dt = Math.min(dt, MAX_DT);
    this.speed = speedKmh / 3.6;
    const prev = this.angle;
    this.updateWipers(dt);
    const turn = WIPER_TMP.makeRotationY(this.angle);
    for (const w of this.wipers) w.obj.matrix.copy(w.base).multiply(turn);
    if (this.raining) {
      this.water.wet();
      this.spawn(dt);
    } else {
      this.water.dry(dt);
      if (this.water.empty) this.runners.length = 0;
    }
    this.run(dt);
    if (this.glass && prev !== this.angle) for (const w of this.wipers) this.wipe(w, prev, this.angle);
  }

  /** Помах (як 0x462f38 + 0x4d0180): у спокої — старт зі звуком; дійшов до спокою — новий помах або зупинка. */
  private updateWipers(dt: number): void {
    if (!this.moving) {
      if (!this.wipersOn) return;
      this.moving = true;
      this.out = true;
      this.onStroke?.();
    }
    if (this.out) {
      this.angle -= SPEED * dt;
      if (this.angle < -SWEEP) {
        this.angle = -SWEEP;
        this.out = false;
      }
    } else {
      this.angle += SPEED * dt;
      if (this.angle > REST) {
        this.angle = REST;
        if (this.wipersOn) {
          this.out = true;
          this.onStroke?.();
        } else this.moving = false;
      }
    }
  }

  private spawn(dt: number): void {
    const v = this.speed;
    if (this.drop) {
      this.dropAcc += DROPS_PER_SEC * (v > SPEED_MAX ? 0 : 1 - SPEED_K * v) * dt;
      for (; this.dropAcc >= 1; this.dropAcc--) this.water.stamp(this.drop, rand(SIZE), rand(SIZE));
    }
    if (this.runner) {
      this.runAcc += RUNNERS_PER_SEC * (v > SPEED_MAX ? 2 : 1 + SPEED_K * v) * dt;
      const { a0, a1, b0, b1 } = this.range;
      // Початок сліду ближче до верху скла (a = a0 + довжина·r²) — як у 2D-кабіні.
      for (; this.runAcc >= 1; this.runAcc--) {
        const r = Math.random();
        const a = a0 + (a1 - a0) * r * r;
        const len = (a1 - a0) * (RUN_LENGTH_MIN + Math.random() * (RUN_LENGTH_MAX - RUN_LENGTH_MIN));
        this.runners.push({ a, b: b0 + Math.random() * (b1 - b0), acc: 0, end: Math.min(a1, a + len) });
      }
    }
  }

  /** Сліди стікання (як 0x473560): крок униз по склу, зсув убік −1…1, відбиток glass_2 на кожен крок. */
  private run(dt: number): void {
    const m = this.runner;
    if (!m) return;
    const { a0, a1 } = this.range;
    const speed = RUN_SPEED * (a1 - a0);
    for (let i = this.runners.length - 1; i >= 0; i--) {
      const r = this.runners[i];
      r.acc += speed * dt;
      for (; r.acc >= RUN_TICK; r.acc -= RUN_TICK) {
        r.a += RUN_TICK;
        r.b += Math.floor(Math.random() * 3) - 1;
        const x = this.down.x * r.a + this.side.x * r.b;
        const y = this.down.y * r.a + this.side.y * r.b;
        this.water.stamp(m, Math.round(x - m.w / 2), Math.round(y - m.h / 2));
      }
      if (r.a > r.end) this.runners.splice(i, 1);
    }
  }

  /**
   * Стерти сектор між двома положеннями двірника (у UV скла, по колу): віяло трикутників «вісь — кінець лопаті» з
   * кроком кута, на якому дуга відходить від хорди не більше ніж на WIPE_SAG px, заливкою рядків (WaterBuffer.fillRow).
   * Раніше — точками вздовж ліній через кожні 0,7 px кінця лопаті: ≈ 80 тис. точок на двірник за кадр (лопать у
   * буфері сотні px, скло ZilR — утричі довше за текстуру), ≈ 0,8 мс процесора ПК на кадр із двірниками.
   */
  private wipe(w: Wiper, a0: number, a1: number): void {
    if (this.water.empty) return;
    const pivot = this.uv(w.pivot).multiplyScalar(SIZE);
    const tipAt = (a: number) => this.uv(new THREE.Vector3(Math.cos(a) * w.length, 0, -Math.sin(a) * w.length).applyMatrix4(w.toCab)).multiplyScalar(SIZE);
    let prev = tipAt(a0);
    const len = Math.max(1, prev.distanceTo(pivot));
    const step = 2 * Math.acos(Math.max(-1, 1 - WIPE_SAG / len));
    const n = Math.max(1, Math.ceil(Math.abs(a1 - a0) / step));
    // Змінене — рамками відрізків лопаті (WIPE_SEGMENTS): одна рамка всього сектора на похилій лопаті — майже
    // квадрат «вісь — кінець», і на відеокарту щокадру йшло в десятки разів більше пікселів, ніж стерто.
    const box = WIPE_BOX.fill(Infinity, 0, WIPE_SEGMENTS * 2).fill(-Infinity, WIPE_SEGMENTS * 2);
    const add = (tip: THREE.Vector2) => {
      for (let k = 0; k <= WIPE_SEGMENTS; k++) {
        const x = pivot.x + ((tip.x - pivot.x) * k) / WIPE_SEGMENTS;
        const y = pivot.y + ((tip.y - pivot.y) * k) / WIPE_SEGMENTS;
        for (const s of k === 0 ? [0] : k === WIPE_SEGMENTS ? [k - 1] : [k - 1, k]) {
          box[s * 2] = Math.min(box[s * 2], x);
          box[s * 2 + 1] = Math.min(box[s * 2 + 1], y);
          box[WIPE_SEGMENTS * 2 + s * 2] = Math.max(box[WIPE_SEGMENTS * 2 + s * 2], x);
          box[WIPE_SEGMENTS * 2 + s * 2 + 1] = Math.max(box[WIPE_SEGMENTS * 2 + s * 2 + 1], y);
        }
      }
    };
    add(prev);
    for (let i = 1; i <= n; i++) {
      const tip = tipAt(a0 + ((a1 - a0) * i) / n);
      this.fillTriangle(pivot, prev, tip);
      add(tip);
      prev = tip;
    }
    for (let s = 0; s < WIPE_SEGMENTS * 2; s += 2)
      if (box[s] <= box[WIPE_SEGMENTS * 2 + s]) this.water.mark(Math.floor(box[s]) - 2, Math.floor(box[s + 1]) - 2, Math.ceil(box[WIPE_SEGMENTS * 2 + s]) + 3, Math.ceil(box[WIPE_SEGMENTS * 2 + s + 1]) + 2);
  }

  /**
   * Стерти трикутник (пікселі буфера, по колу): у кожному рядку y — усе, що трикутник зачіпає в смузі y ± 0,5 (перетин
   * опуклого трикутника зі смугою — відрізки його ребер), з запасом пікселя праворуч, як у колишніх лініях (x і x + 1).
   */
  private fillTriangle(a: THREE.Vector2, b: THREE.Vector2, c: THREE.Vector2): void {
    const y0 = Math.round(Math.min(a.y, b.y, c.y));
    const y1 = Math.round(Math.max(a.y, b.y, c.y));
    for (let y = y0; y <= y1; y++) {
      const lo = y - 0.5;
      const hi = y + 0.5;
      let xl = Infinity;
      let xr = -Infinity;
      for (let e = 0; e < 3; e++) {
        const p = e === 0 ? a : e === 1 ? b : c;
        const q = e === 0 ? b : e === 1 ? c : a;
        // Відрізок ребра в смузі [lo, hi].
        let t0 = 0;
        let t1 = 1;
        const dy = q.y - p.y;
        if (Math.abs(dy) < 1e-9) {
          if (p.y < lo || p.y > hi) continue;
        } else {
          const ta = (lo - p.y) / dy;
          const tb = (hi - p.y) / dy;
          t0 = Math.max(0, Math.min(ta, tb));
          t1 = Math.min(1, Math.max(ta, tb));
          if (t0 > t1) continue;
        }
        const xa = p.x + (q.x - p.x) * t0;
        const xb = p.x + (q.x - p.x) * t1;
        xl = Math.min(xl, xa, xb);
        xr = Math.max(xr, xa, xb);
      }
      if (xl <= xr) this.water.fillRow(y, Math.round(xl), Math.round(xr) + 1);
    }
  }

  /** Точка кабіни → координати площини скла (s, t) у ребрах першого трикутника. */
  private planeST(p: THREE.Vector3): { s: number; t: number } {
    const g = this.glass!;
    return planeCoords(g.o, g.e1, g.e2, p);
  }

  /** Точка кабіни → UV скла (проєкція на площину, UV — за трикутником, у який вона потрапляє). */
  private uv(p: THREE.Vector3): THREE.Vector2 {
    const { s, t } = this.planeST(p);
    return uvAt(this.glass!.tris, s, t, new THREE.Vector2());
  }

  dispose(): void {
    this.canvas?.removeEventListener('webglcontextrestored', this.refresh);
    document.removeEventListener('visibilitychange', this.refresh);
    this.water.dispose();
    this.copy.dispose();
  }
}

/**
 * Трикутник скла в координатах площини (s, t): барицентричні l1, l2 — афінні від (s, t) (l = a·s + b·t + c), UV —
 * u = u0 + us·s + ut·t (так само v); l0 = 1 − l1 − l2.
 */
interface GlassTri {
  a1: number;
  b1: number;
  c1: number;
  a2: number;
  b2: number;
  c2: number;
  u0: number;
  us: number;
  ut: number;
  v0: number;
  vs: number;
  vt: number;
}

function planeCoords(o: THREE.Vector3, e1: THREE.Vector3, e2: THREE.Vector3, p: THREE.Vector3): { s: number; t: number } {
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  const dz = p.z - o.z;
  const a11 = e1.dot(e1);
  const a12 = e1.dot(e2);
  const a22 = e2.dot(e2);
  const b1 = dx * e1.x + dy * e1.y + dz * e1.z;
  const b2 = dx * e2.x + dy * e2.y + dz * e2.z;
  const det = a11 * a22 - a12 * a12 || 1;
  return { s: (b1 * a22 - b2 * a12) / det, t: (a11 * b2 - a12 * b1) / det };
}

/** UV у точці (s, t): трикутник, що її містить, а поза склом — найближчий (найбільша з найменших барицентричних). */
function uvAt(tris: readonly GlassTri[], s: number, t: number, out: THREE.Vector2): THREE.Vector2 {
  let best = tris[0];
  let bestMin = -Infinity;
  for (const q of tris) {
    const l1 = q.a1 * s + q.b1 * t + q.c1;
    const l2 = q.a2 * s + q.b2 * t + q.c2;
    const min = Math.min(l1, l2, 1 - l1 - l2);
    if (min > bestMin) {
      bestMin = min;
      best = q;
      if (min >= 0) break;
    }
  }
  return out.set(best.u0 + best.us * s + best.ut * t, best.v0 + best.vs * s + best.vt * t);
}

/** Площина скла (перший трикутник) і всі трикутники сітки в її координатах (система кабіни). */
function glassPlane(mesh: THREE.Mesh, inv: THREE.Matrix4) {
  const geo = mesh.geometry;
  const P = geo.attributes.position;
  const U = geo.attributes.uv;
  const m = mesh.matrixWorld.clone().premultiply(inv);
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(m);
  const idx = (k: number) => (geo.index ? geo.index.getX(k) : k);
  const count = geo.index ? geo.index.count : P.count;
  const o = v(idx(0));
  const e1 = v(idx(1)).sub(o);
  const e2 = v(idx(2)).sub(o);
  const tris: GlassTri[] = [];
  for (let k = 0; k + 2 < count; k += 3) {
    const ids = [idx(k), idx(k + 1), idx(k + 2)];
    const st = ids.map((i) => planeCoords(o, e1, e2, v(i)));
    const ds1 = st[1].s - st[0].s;
    const dt1 = st[1].t - st[0].t;
    const ds2 = st[2].s - st[0].s;
    const dt2 = st[2].t - st[0].t;
    const det = ds1 * dt2 - ds2 * dt1;
    if (Math.abs(det) < 1e-12) continue;
    // (l1, l2) = M⁻¹ · (s − s₀, t − t₀), M = [ds1 ds2; dt1 dt2].
    const a1 = dt2 / det;
    const b1 = -ds2 / det;
    const a2 = -dt1 / det;
    const b2 = ds1 / det;
    const c1 = -(a1 * st[0].s + b1 * st[0].t);
    const c2 = -(a2 * st[0].s + b2 * st[0].t);
    const [u0, u1, u2] = ids.map((i) => U.getX(i));
    const [w0, w1, w2] = ids.map((i) => U.getY(i));
    // u = u0·l0 + u1·l1 + u2·l2 = u0 + (u1 − u0)·l1 + (u2 − u0)·l2 — афінно від (s, t).
    const du1 = u1 - u0;
    const du2 = u2 - u0;
    const dv1 = w1 - w0;
    const dv2 = w2 - w0;
    tris.push({
      a1,
      b1,
      c1,
      a2,
      b2,
      c2,
      u0: u0 + du1 * c1 + du2 * c2,
      us: du1 * a1 + du2 * a2,
      ut: du1 * b1 + du2 * b2,
      v0: w0 + dv1 * c1 + dv2 * c2,
      vs: dv1 * a1 + dv2 * a2,
      vt: dv1 * b1 + dv2 * b2,
    });
  }
  return { o, e1, e2, tris };
}

function isAncestor(a: THREE.Object3D, o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === a) return true;
  return false;
}

/** Маска, збільшена в k разів (кожен піксель — квадрат k × k). */
function scaleLevels(m: Levels, k: number): Levels {
  const w = m.w * k;
  const h = m.h * k;
  const a = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a[y * w + x] = m.a[Math.floor(y / k) * m.w + Math.floor(x / k)];
  return { w, h, a };
}

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}
