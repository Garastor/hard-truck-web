import * as THREE from 'three';
import type { RgbaImage } from '../formats/binary';

/**
 * Дощ на склі й двірники 2D-кабіни — як в оригіналі (HTruck.exe: об'єкт 0x4caa10, створюється лише в режимі без
 * 3D-кабіни, 0x4c7134; оновлення 0x4d0180, спільна логіка 0x462f38, малювання 0x4638c4; розбір — re/notes/cab2d.md).
 * Буфер на всю смугу вікна містить рівні прозорості (0…255): маски крапель MSKR — не кольори, а рівні; на вид буфер
 * накладається кольором №3 палітри траси (191, 191, 191) з прозорістю пікселя (режим 3, 0x4773d6).
 * - краплі `msk\drop7.msk`: 50/с у випадкові місця (перезапис рівнів);
 * - краплі, що стікають, `msk\drop10.msk`: 5/с, кожна 50 px/с униз зі зсувом убік −4…3 за крок, три відбитки на крок
 *   (0x473560) — лишає слід;
 * - двірники стирають буфер лініями з кроком 0,00314 рад від радіуса 10 до висоти буфера (0x462f38).
 * Лопаті — модель `Wiper` (COUNT.B3D): смужка 0,85 × 0,08 з матеріалом `wiper ttx 1` — перша текстура набору
 * (`txr\flash.txr`, «ttx» — текстура з прозорим чорним, 0x4530d0), смуга u 0,875…0,996 — намальований двірник
 * (важіль і щітка). Інтерфейс — як у GlassRain (3D-скло).
 */

/** Швидкість помаху, рад/с (0x54625c), положення спокою (0x546264) і нижня межа помаху (поле +0x9c), рад. */
const SPEED = 2.35619445;
const REST = Math.PI / 2;
const LOW = -Math.PI / 3;
/** Крок стирання за кутом, рад (0x54627c). */
const WIPE_STEP = 0.0031415926;
/** Нових крапель за секунду (поле +0x20 = 50) і крапель, що стікають (50 / 10, 0x54626c). */
const DROPS_PER_SEC = 50;
const RUNNERS_PER_SEC = DROPS_PER_SEC / 10;
/** Швидкість стікання, px/с (0x546254). */
const RUN_SPEED = 50;
/**
 * Крок краплі, що стікає, px. В оригіналі — round(dt·50) за кадр його ж рушія; рахувати щокадру при 60 кадр/с
 * давало б 0–1 px униз і ±4 px убік — сліди надто звивисті. 2 px — як оригінал при ≈ 25 кадр/с (гіпотеза).
 */
const RUN_TICK = 2;
/** Вісь першого двірника — x = 200 (поле +0x58); стирання від радіуса 10 (поле +0x60) до висоти буфера. */
const PIVOT_X = 200;
const HUB = 10;
/** Колір крапель — запис №3 палітри траси (на всіх трасах 191, 191, 191). */
const DROP_COLOR = new THREE.Color(191 / 255, 191 / 255, 191 / 255);
/**
 * Висихання без дощу: рівні убувають 15 кроками за FADE_TIME с. В оригіналі так висихає лише 16-бітний буфер
 * (4-бітна альфа, лічильник +0x90); тривалість — гіпотеза.
 */
const FADE_STEPS = 15;
const FADE_TIME = 0.5;
/** Ширина лопаті до довжини — як у моделі `Wiper` (COUNT.B3D: 0,08 × 0,85). */
const BLADE_WIDTH = 0.08 / 0.85;
/** Без текстури (імпорт до її появи) — темна смужка. */
const BLADE_COLOR = 0x141414;
/** Найбільший крок часу оновлення, с: після паузи (прихована вкладка) двірник проскочив би межу помаху. */
const MAX_DT = 0.1;

/**
 * Буфер — смуга вікна прямого виду в кадрі 640×480: truck.ini [CAR] maskYview0 = 44, maskYview1 = 250 (висота).
 * Що буфер оригіналу — саме ця смуга, гіпотеза: розмір береться з поверхні виду (param_2 + 0xc), не розібрано.
 */
export const RAIN_VIEW = { x: 0, y: 44, w: 640, h: 250 };

/** Маска рівнів (MSKR): ширина, висота, рівень кожного пікселя (0 — прозоро). */
interface Levels {
  w: number;
  h: number;
  a: Uint8Array;
}

export class Cab2dRain {
  raining = false;
  wipersOn = false;
  /** Кожен помах (звук двірників). */
  onStroke: (() => void) | null = null;
  /** Буфер крапель і лопаті — у сцені 2D-кабіни (кадр 640×480, y униз), під маскою панелі. */
  readonly root = new THREE.Group();

  private readonly levels = new Uint8Array(RAIN_VIEW.w * RAIN_VIEW.h);
  private readonly texture: THREE.DataTexture;
  private readonly drop: Levels | null;
  private readonly runner: Levels | null;
  private readonly runners: { x: number; y: number; acc: number }[] = [];
  private readonly blades: THREE.Mesh[] = [];
  private readonly pivots: [number, number][];
  private angle = REST;
  /** Хід униз (від спокою до нижньої межі); інакше — угору, до спокою. */
  private down = false;
  private moving = false;
  private dropAcc = 0;
  private runAcc = 0;
  private fadeStep = 0;
  private fadeAcc = 0;
  private dirty = false;
  private empty = true;

  /**
   * drop, runner — маски drop7 і drop10, розкодовані без палітри (рівень — у червоному каналі); blade — текстура
   * flash.txr (лопать — її смуга u 0,875…0,996).
   */
  constructor(drop: RgbaImage | null, runner: RgbaImage | null, blade: RgbaImage | null = null) {
    const { w, h } = RAIN_VIEW;
    this.drop = drop && toLevels(drop);
    this.runner = runner && toLevels(runner);
    this.texture = new THREE.DataTexture(this.levels, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.flipY = false;
    this.texture.needsUpdate = true;
    // Осі двірників (0x462f38): (200, h + 10) і (200 + 1,5·h, h + 10) — трохи нижче краю буфера.
    this.pivots = [
      [PIVOT_X, h + 10],
      [PIVOT_X + 1.5 * h, h + 10],
    ];
    // Лопаті: смужка від осі (x = 0) до кінця (x = 1), поперек — y −0,5…0,5; UV — як у моделі Wiper: біля осі v = 1,
    // на кінці v = 0, поперек u 0,996…0,875.
    const map = blade ? bladeTexture(blade) : null;
    for (let i = 0; i < 2; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0], 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute([0.996, 1, 0.996, 0, 0.875, 0, 0.875, 1], 2));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const mat = map
        ? new THREE.MeshBasicMaterial({ map, alphaTest: 0.5, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
        : new THREE.MeshBasicMaterial({ color: BLADE_COLOR, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(g, mat);
      m.matrixAutoUpdate = false;
      m.renderOrder = -20;
      m.frustumCulled = false;
      this.blades.push(m);
      this.root.add(m);
    }
    // Краплі — поверх лопатей (в оригіналі буфер накладається на вид після світу): колір №3, прозорість — рівень.
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h).translate(RAIN_VIEW.x + w / 2, RAIN_VIEW.y + h / 2, 0),
      new THREE.ShaderMaterial({
        uniforms: { levels: { value: this.texture }, color: { value: DROP_COLOR } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        // Камера 2D-кабіни — y униз: v = 0 PlaneGeometry — верх смуги на екрані, як рядок 0 буфера.
        fragmentShader:
          'uniform sampler2D levels; uniform vec3 color; varying vec2 vUv; void main() { float a = texture2D(levels, vUv).r; if (a <= 0.0) discard; gl_FragColor = vec4(color, a); }',
        transparent: true,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    quad.renderOrder = -10;
    quad.frustumCulled = false;
    this.root.add(quad);
    this.placeBlades();
  }

  update(dt: number, _speedKmh = 0): void {
    dt = Math.min(dt, MAX_DT);
    this.updateWipers(dt);
    if (this.raining) {
      this.fadeStep = 0;
      this.spawn(dt);
    } else if (!this.empty) this.dry(dt);
    this.run(dt);
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
    }
  }

  /** Нові краплі (0x462f38): drop7 — у випадкові місця; drop10 — початок краплі, що стікає. */
  private spawn(dt: number): void {
    const { w, h } = RAIN_VIEW;
    if (this.drop) {
      this.dropAcc += DROPS_PER_SEC * dt;
      for (; this.dropAcc >= 1; this.dropAcc--) this.stamp(this.drop, rand(w), rand(h));
    }
    if (this.runner) {
      this.runAcc += RUNNERS_PER_SEC * dt;
      for (; this.runAcc >= 1; this.runAcc--) this.runners.push({ x: rand(w), y: rand(h), acc: 0 });
    }
  }

  /** Краплі, що стікають (0x473560): крок униз за кадр, зсув убік −4…3, три відбитки вздовж кроку. */
  private run(dt: number): void {
    const m = this.runner;
    if (!m) return;
    for (let i = this.runners.length - 1; i >= 0; i--) {
      const r = this.runners[i];
      r.acc += RUN_SPEED * dt;
      for (; r.acc >= RUN_TICK; r.acc -= RUN_TICK) {
        const step = RUN_TICK;
        const dx = Math.floor(Math.random() * 8) - 4;
        this.stamp(m, r.x + Math.trunc(dx / 3), r.y + Math.trunc(step / 3));
        this.stamp(m, r.x + Math.trunc((2 * dx) / 3), r.y + Math.trunc((2 * step) / 3));
        this.stamp(m, r.x + dx, r.y + step);
        r.x += dx;
        r.y += step;
      }
      if (r.y >= RAIN_VIEW.h) this.runners.splice(i, 1);
    }
  }

  /** Відбиток маски рівнів у буфер (перезапис непрозорих пікселів, як копіювання маски в оригіналі). */
  private stamp(m: Levels, x0: number, y0: number): void {
    const { w, h } = RAIN_VIEW;
    for (let y = 0; y < m.h; y++) {
      const by = y0 + y;
      if (by < 0 || by >= h) continue;
      for (let x = 0; x < m.w; x++) {
        const v = m.a[y * m.w + x];
        const bx = x0 + x;
        if (v && bx >= 0 && bx < w) this.levels[by * w + bx] = v;
      }
    }
    this.dirty = true;
    this.empty = false;
  }

  /** Помах (0x462f38 + 0x4d0180): у спокої при увімкнених двірниках — старт і звук; дійшов до спокою — новий
   * помах (звук) або зупинка, якщо вимкнули. Кут ходить між спокоєм (+90°) і −60°. */
  private updateWipers(dt: number): void {
    if (!this.moving) {
      if (!this.wipersOn) return;
      this.moving = true;
      this.down = true;
      this.onStroke?.();
    }
    const prev = this.angle;
    if (this.down) {
      this.angle -= SPEED * dt;
      if (this.angle < LOW) {
        this.angle = LOW;
        this.down = false;
      }
    } else {
      this.angle += SPEED * dt;
      if (this.angle > REST) {
        this.angle = REST;
        if (this.wipersOn) {
          this.down = true;
          this.onStroke?.();
        } else this.moving = false;
      }
    }
    this.wipe(prev, this.angle);
    this.placeBlades();
  }

  /**
   * Стирання (0x462f38): для кожного кроку кута між a0 і a1 — лінія від радіуса HUB до висоти буфера з обох осей.
   * Точка лопаті під кутом a — (x + r·sin a, y − r·cos a): у спокої (+90°) лопать лежить праворуч від осі, нижче
   * краю буфера.
   */
  private wipe(a0: number, a1: number): void {
    if (this.empty || a0 === a1) return;
    const { w, h } = RAIN_VIEW;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    for (let a = lo; a <= hi + WIPE_STEP / 2; a += WIPE_STEP) {
      const s = Math.sin(a);
      const c = Math.cos(a);
      for (const [px, py] of this.pivots) {
        for (let r = HUB; r <= h; r++) {
          const x = Math.round(px + r * s);
          const y = Math.round(py - r * c);
          if (x >= 0 && x < w && y >= 0 && y < h) this.levels[y * w + x] = 0;
        }
      }
    }
    this.dirty = true;
  }

  /** Висихання: рівні убувають рівними кроками. */
  private dry(dt: number): void {
    this.fadeAcc += dt;
    const step = FADE_TIME / FADE_STEPS;
    if (this.fadeAcc < step) return;
    this.fadeAcc = 0;
    if (++this.fadeStep >= FADE_STEPS) {
      this.levels.fill(0);
      this.runners.length = 0;
      this.empty = true;
      this.fadeStep = 0;
    } else {
      const dec = Math.ceil(255 / FADE_STEPS);
      const a = this.levels;
      for (let i = 0; i < a.length; i++) a[i] = a[i] > dec ? a[i] - dec : 0;
    }
    this.dirty = true;
  }

  /** Лопаті вздовж ліній стирання: від осі до радіуса — висоти буфера, у кадрі 640×480. */
  private placeBlades(): void {
    const len = RAIN_VIEW.h;
    const wid = len * BLADE_WIDTH;
    const dx = Math.sin(this.angle);
    const dy = -Math.cos(this.angle);
    this.pivots.forEach(([x, y], i) => {
      // Стовпці матриці: x — уздовж лопаті (довжина), y — поперек (ширина), зсув — вісь.
      this.blades[i].matrix.set(dx * len, -dy * wid, 0, RAIN_VIEW.x + x, dy * len, dx * wid, 0, RAIN_VIEW.y + y, 0, 0, 1, 0, 0, 0, 0, 1);
      this.blades[i].matrixWorldNeedsUpdate = true;
    });
  }

  dispose(): void {
    this.texture.dispose();
    (this.blades[0].material as THREE.MeshBasicMaterial).map?.dispose();
    for (const o of this.root.children) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

/**
 * Смуги дощу `msk\rain.msk` (800×900, власна палітра) для зовнішніх камер у режимі 2D-кабіни (біт 0x10 у 0x4d0180:
 * дощ і камера не з кабіни; 0x4638c4): поверх виду з прозорістю 0,1, двома копіями одна над одною — у (0, y) і
 * (0, y − висота маски), y += 400 px/с mod висоти: дощ падає вниз (зсув +0xac — аргумент y функції 0x415d44).
 * У програмному наборі тривимірного дощу (Foreground_object / RainKey) немає — смуги його й заміняють.
 * Кадр виду 640×480 розтягнуто на екран (гіпотеза щодо масштабу на широкому екрані).
 */
export class RainStreaks {
  readonly el = document.createElement('div');
  private readonly strip = document.createElement('div');
  private y = 0;
  private scale = 0;
  private readonly w: number;
  private readonly h: number;

  constructor(img: RgbaImage) {
    this.w = img.width;
    this.h = img.height;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    this.el.className = 'rain-streaks';
    this.el.hidden = true;
    this.strip.style.backgroundImage = `url(${c.toDataURL()})`;
    this.el.append(this.strip);
  }

  /** Кадр: on — показувати смуги. */
  update(dt: number, on: boolean): void {
    this.el.hidden = !on;
    if (!on) return;
    const s = Math.max(window.innerWidth / 640, window.innerHeight / 480);
    if (s !== this.scale) {
      this.scale = s;
      Object.assign(this.strip.style, { width: `${this.w * s}px`, height: `${this.h * s * 2}px`, backgroundSize: `${this.w * s}px ${this.h * s}px` });
    }
    this.y = (this.y + 400 * Math.min(dt, MAX_DT)) % this.h;
    // Копії в y і y − висота: смуга вдвічі вища за малюнок, зсунута на (y − висота).
    this.strip.style.transform = `translateY(${(this.y - this.h) * s}px)`;
  }
}

/** Текстура лопаті: чорне — прозоре (матеріал «ttx»), рядок 0 — v = 0. */
function bladeTexture(img: RgbaImage): THREE.DataTexture {
  const d = new Uint8Array(img.data);
  for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] === 0) d[i + 3] = 0;
  const t = new THREE.DataTexture(d, img.width, img.height, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearFilter;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

function rand(n: number): number {
  return Math.floor(Math.random() * n);
}

/** Рівні з маски, розкодованої без палітри: рівень — червоний канал, прозорі пікселі — 0. */
function toLevels(img: RgbaImage): Levels {
  const a = new Uint8Array(img.width * img.height);
  for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3] ? img.data[i * 4] : 0;
  return { w: img.width, h: img.height, a };
}
