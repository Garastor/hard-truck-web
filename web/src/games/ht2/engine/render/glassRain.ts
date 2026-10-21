import * as THREE from 'three';
import type { RgbaImage } from '../formats/binary';
import { FILM_LOOK, SceneCopy, WATER_FRAGMENT, WATER_LOOK, WATER_VERTEX, WaterBuffer, toLevels, waterUniforms, type Levels } from './waterBuffer';

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
/** Нових крапель і слідів за секунду (оригінал: 20 і 20 / 10). */
const DROPS_PER_SEC = 20;
const RUNNERS_PER_SEC = DROPS_PER_SEC / 10;
/** Сліди: частка висоти скла за секунду (як 7,5 px/с на 250 px у 2D-кабіні), крок — 1 px буфера. */
const RUN_SPEED = 7.5 / 250;
const RUN_TICK = 1;
/**
 * Розмір буфера (текстура скла повторюється). В оригіналі — розмір glass.txr; тут 512: маски у своєму розмірі — краплі
 * дрібніші, як у 2D-кабіні (на прохання користувача).
 */
const SIZE = 512;
/** Нахил поверхні води — різниця рівнів через стільки пікселів буфера. */
const SLOPE_SPAN = 2;
/**
 * Водяна плівка (власний ефект порту, на прохання користувача — щоб невичищене скло заважало їхати): під дощем
 * скло поступово затягує суцільною водою, що розмиває й туманить вид (шейдер — waterBuffer.ts, FILM_LOOK). Повна
 * плівка — за FILM_TIME с на місці; на ходу швидше: × (1 + v / FILM_SPEED), v — м/с (90 км/год — у 3,5 раза,
 * ≈ 37 с). Двірники стирають плівку лише у своєму секторі; без дощу вона висихає, як краплі.
 * Координати плівки — власні, не UV текстури скла: точка площини скла від краю до краю (атрибут filmUv), бо текстура
 * скла повторюється (ZilR — утричі), і одна клітинка лягала б на кілька місць скла: двірник «чистив» і там, куди не
 * дістає. Клітинка — ≈ FILM_CELL м (не більше FILM_MAX на бік). Стирання — за геометрією лопаті (wipeFilm): точки
 * сектора в системі двірника з мʼяким краєм FILM_EDGE м біля кінця лопаті й на межах помаху.
 */
const FILM_TIME = 129;
const FILM_SPEED = 10;
const FILM_CELL = 0.03;
const FILM_MAX = 256;
const FILM_EDGE = 0.04;
/** Порядок малювання лопатей двірників — після скла (0), до керма (10, drive.ts). */
const WIPER_ORDER = 5;
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
  /** Координати площини скла (s, t) точки двірника (x, 0, z): s0 + x·sx + z·sz (афінно; рахується після glassPlane). */
  map?: { s0: number; t0: number; sx: number; tx: number; sz: number; tz: number };
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
  /** Плівка: x — уздовж t площини скла, y — уздовж s (filmBox); до появи скла — порожня 1×1. */
  private film = new WaterBuffer(1, 1);
  private filmBox = { s0: 0, ds: 1, t0: 0, dt: 1 };
  private readonly copy = new SceneCopy();
  private readonly uniforms = waterUniforms(this.water.texture, SLOPE_SPAN / SIZE, SLOPE_SPAN / SIZE, this.film.texture);
  private readonly drop: Levels | null;
  private readonly runner: Levels | null;
  private readonly runners: { a: number; b: number; acc: number }[] = [];
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
    this.runner = runner && toLevels(runner, 3);
    cabRoot.updateMatrixWorld(true);
    const inv = cabRoot.matrixWorld.clone().invert();
    cabRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshBasicMaterial).map?.name === 'txr/glass.txr' && !this.glass) {
        this.glass = glassPlane(mesh, inv);
        this.measureGlass(mesh, inv);
        this.setupFilm(mesh, inv);
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

  /** Буфер плівки за розміром скла й атрибут filmUv вершин (координати площини, нормовані до 0…1). */
  private setupFilm(mesh: THREE.Mesh, inv: THREE.Matrix4): void {
    const g = this.glass!;
    mesh.geometry = mesh.geometry.clone();
    const P = mesh.geometry.attributes.position;
    const m = mesh.matrixWorld.clone().premultiply(inv);
    const st: { s: number; t: number }[] = [];
    for (let i = 0; i < P.count; i++) st.push(planeCoords(g.o, g.e1, g.e2, new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(m)));
    const s0 = Math.min(...st.map((q) => q.s));
    const t0 = Math.min(...st.map((q) => q.t));
    const ds = Math.max(...st.map((q) => q.s)) - s0 || 1;
    const dt = Math.max(...st.map((q) => q.t)) - t0 || 1;
    this.filmBox = { s0, ds, t0, dt };
    const fuv = new Float32Array(P.count * 2);
    st.forEach((q, i) => fuv.set([(q.t - t0) / dt, (q.s - s0) / ds], i * 2));
    mesh.geometry.setAttribute('filmUv', new THREE.BufferAttribute(fuv, 2));
    const size = (len: number) => Math.max(8, Math.min(FILM_MAX, Math.ceil(len / FILM_CELL)));
    this.film.dispose();
    this.film = new WaterBuffer(size(dt * g.e2.length()), size(ds * g.e1.length()));
    this.uniforms.film.value = this.film.texture;
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
    this.film.invalidate();
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
    this.film.upload(renderer);
    const dry = this.water.empty && this.film.empty;
    this.uniforms.wet.value = dry ? 0 : 1;
    if (dry) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.copy.copy(renderer, 0, 0, size.x, size.y, this.uniforms);
    // Масштаб «пікселя кадру 640×480» на екрані — як у 2D-кабіни.
    const dev = size.y / 480;
    this.uniforms.k.value = WATER_LOOK.refract * dev;
    this.uniforms.kMax.value = WATER_LOOK.refractMax * dev;
    this.uniforms.blur.value = FILM_LOOK.blur * dev;
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
      this.film.wet();
      this.film.grow((dt / FILM_TIME) * (1 + this.speed / FILM_SPEED));
      this.spawn(dt);
    } else {
      this.water.dry(dt);
      this.film.dry(dt);
      if (this.water.empty) this.runners.length = 0;
    }
    this.run(dt);
    if (this.glass && prev !== this.angle)
      for (const w of this.wipers) {
        this.wipe(w, prev, this.angle);
        this.wipeFilm(w, prev, this.angle);
      }
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
        this.runners.push({ a: a0 + (a1 - a0) * r * r, b: b0 + Math.random() * (b1 - b0), acc: 0 });
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
      if (r.a > a1) this.runners.splice(i, 1);
    }
  }

  /** Стерти сектор між двома положеннями двірника: лінії від осі до кінця лопаті (у UV скла, по колу). */
  private wipe(w: Wiper, a0: number, a1: number): void {
    if (this.water.empty) return;
    const pivot = this.uv(w.pivot).multiplyScalar(SIZE);
    const tipAt = (a: number) => this.uv(new THREE.Vector3(Math.cos(a) * w.length, 0, -Math.sin(a) * w.length).applyMatrix4(w.toCab)).multiplyScalar(SIZE);
    const len = Math.max(1, tipAt(a0).distanceTo(pivot));
    // Крок кута — кінець лопаті зсувається не більше ніж на 0,7 px.
    const n = Math.max(1, Math.ceil((Math.abs(a1 - a0) * len) / 0.7));
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i <= n; i++) {
      const tip = tipAt(a0 + ((a1 - a0) * i) / n);
      const steps = Math.ceil(tip.distanceTo(pivot));
      for (let k = 0; k <= steps; k++) {
        const x = Math.round(pivot.x + ((tip.x - pivot.x) * k) / steps);
        const y = Math.round(pivot.y + ((tip.y - pivot.y) * k) / steps);
        this.water.erase(x, y);
        this.water.erase(x + 1, y);
      }
      x0 = Math.min(x0, tip.x);
      y0 = Math.min(y0, tip.y);
      x1 = Math.max(x1, tip.x);
      y1 = Math.max(y1, tip.y);
    }
    this.water.mark(Math.min(x0, pivot.x) - 2, Math.min(y0, pivot.y) - 2, Math.max(x1, pivot.x) + 3, Math.max(y1, pivot.y) + 3);
  }

  /**
   * Стерти плівку в секторі двірника між кутами a0 і a1: точки сектора (кільця з кроком у пів клітинки) — у системі
   * двірника, у кожній — частка стирання f з мʼяким краєм FILM_EDGE біля кінця лопаті й за межами кутів кадру
   * (усередині помаху краї сусідніх кадрів перекриваються, на межах помаху лишається плавний перехід); пікселю —
   * не більше 255·(1 − f).
   */
  private wipeFilm(w: Wiper, a0: number, a1: number): void {
    if (this.film.empty) return;
    const g = this.glass!;
    const m = (w.map ??= this.wiperMap(w));
    const { s0, ds, t0, dt } = this.filmBox;
    const W = this.film.w;
    const H = this.film.h;
    // Крок — пів клітинки в метрах (менша зі сторін клітинки).
    const h = 0.5 * Math.min((dt * g.e2.length()) / W, (ds * g.e1.length()) / H);
    const e = FILM_EDGE;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    const rMax = w.length + e;
    for (let r = h; r <= rMax; r += h) {
      const fr = smooth((w.length + e / 2 - r) / e);
      if (fr <= 0) continue;
      const pad = e / r;
      const da = h / r;
      for (let a = lo - pad; a <= hi + pad; a += da) {
        const out = a < lo ? lo - a : a > hi ? a - hi : 0;
        const f = fr * smooth(1 - (out * r) / e);
        if (f <= 0) continue;
        const x = Math.cos(a) * r;
        const z = -Math.sin(a) * r;
        const ps = m.s0 + x * m.sx + z * m.sz;
        const pt = m.t0 + x * m.tx + z * m.tz;
        // Поза склом — нічого (буфер без повторення).
        this.film.clampAt(Math.floor(((pt - t0) / dt) * W), Math.floor(((ps - s0) / ds) * H), Math.round(255 * (1 - f)));
      }
    }
    this.film.markAll();
  }

  /** Афінне відображення «система двірника → координати площини скла (s, t)». */
  private wiperMap(w: Wiper): NonNullable<Wiper['map']> {
    const o = this.planeST(new THREE.Vector3().applyMatrix4(w.toCab));
    const x = this.planeST(new THREE.Vector3(1, 0, 0).applyMatrix4(w.toCab));
    const z = this.planeST(new THREE.Vector3(0, 0, 1).applyMatrix4(w.toCab));
    return { s0: o.s, t0: o.t, sx: x.s - o.s, tx: x.t - o.t, sz: z.s - o.s, tz: z.t - o.t };
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
    this.film.dispose();
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

/** Плавний крок 0…1 (smoothstep від x, обрізаного до 0…1). */
function smooth(x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}
