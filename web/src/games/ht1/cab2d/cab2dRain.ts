import * as THREE from 'three';
import type { RgbaImage } from '../engine/formats/binary';
import { SceneCopy, WATER_FRAGMENT, WATER_LOOK, WATER_VERTEX, WaterBuffer, toLevels, waterUniforms, type Levels } from '../engine/render/waterBuffer';

/**
 * Дощ на склі й двірники 2D-кабіни — як в оригіналі (HTruck.exe: об'єкт 0x4caa10, створюється лише в режимі без
 * 3D-кабіни, 0x4c7134; оновлення 0x4d0180, спільна логіка 0x462f38, малювання 0x4638c4; розбір — re/notes/ht1/cab2d.md).
 * Буфер на всю смугу вікна містить рівні прозорості (0…255): маски крапель MSKR — не кольори, а рівні; на вид буфер
 * накладається кольором №3 палітри траси (191, 191, 191) з прозорістю пікселя (режим 3, 0x4773d6).
 * - краплі `msk\drop7.msk`: 50/с у випадкові місця (перезапис рівнів);
 * - краплі, що стікають, `msk\drop10.msk`: 5/с, кожна 25 px/с униз (оригінал — 50) зі зсувом убік −4…3 за крок, три відбитки на крок
 *   (0x473560) — лишає слід;
 * - двірники стирають буфер лініями з кроком 0,00314 рад від радіуса 10 до висоти буфера (0x462f38).
 * Заломлення (власний ефект порту, за згодою користувача; в оригіналі зсуву картинки немає — лише змішування з
 * кольором №3): рівні масок читаються як форма поверхні води — «лінза» drop7 (13 у центрі → 45 по краю) і сліди
 * drop10. Вода зсуває картинку під собою за нахилом поверхні й світлішає / темнішає за ним (світло згори: верхній
 * край краплі темніший, нижній — світліший); сірого кольору оригіналу (обідки) немає — на прохання користувача.
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
/**
 * Швидкість стікання, px кадру/с: в оригіналі 50 (0x546254); у порті 7,5 — на прохання користувача (удвічі, на 40 %
 * і ще вдвічі повільніше).
 */
const RUN_SPEED = 7.5;
/**
 * Крок краплі, що стікає, px. В оригіналі — round(dt·50) за кадр його ж рушія; рахувати щокадру при 60 кадр/с
 * давало б 0–1 px униз і ±4 px убік — сліди надто звивисті. 2 px — як оригінал при ≈ 25 кадр/с (гіпотеза).
 */
const RUN_TICK = 2;
/** Вісь першого двірника — x = 200 (поле +0x58); стирання від радіуса 10 (поле +0x60) до висоти буфера. */
const PIVOT_X = 200;
const HUB = 10;
/** Ширина лопаті до довжини — як у моделі `Wiper` (COUNT.B3D: 0,08 × 0,85). */
const BLADE_WIDTH = 0.08 / 0.85;
/** Без текстури (імпорт до її появи) — темна смужка. */
const BLADE_COLOR = 0x141414;
/** Смуги дощу надворі (rain.msk): прозорість і швидкість — як RainStreaks (оригінал, 0x4638c4); запас по боках кадру. */
const STREAK_OPACITY = 0.1;
const STREAK_SPEED = 400;
const STREAK_MARGIN = 200;
/** Нахил поверхні води — різниця рівнів через стільки пікселів буфера. */
const SLOPE_SPAN = 3;
/** Найбільший крок часу оновлення, с: після паузи (прихована вкладка) двірник проскочив би межу помаху. */
const MAX_DT = 0.1;

/**
 * Буфер — смуга вікна прямого виду в кадрі 640×480: truck.ini [CAR] maskYview0 = 44, maskYview1 = 250 (висота).
 * Що буфер оригіналу — саме ця смуга, гіпотеза: розмір береться з поверхні виду (param_2 + 0xc), не розібрано.
 */
export const RAIN_VIEW = { x: 0, y: 44, w: 640, h: 250 };
/**
 * Буфер детальніший за кадр у BUF_SCALE разів: маски штампуються у своєму розмірі, тож краплі й сліди дрібніші, ніж в
 * оригіналі (на прохання користувача — «зменшити масштаб»); осі, радіуси й швидкості — у пікселях кадру × BUF_SCALE.
 */
const BUF_SCALE = 2;
const BUF = { w: RAIN_VIEW.w * BUF_SCALE, h: RAIN_VIEW.h * BUF_SCALE };

export class Cab2dRain {
  raining = false;
  wipersOn = false;
  /** Кожен помах (звук двірників). */
  onStroke: (() => void) | null = null;
  /** Буфер крапель і лопаті — у сцені 2D-кабіни (кадр 640×480, y униз), під маскою панелі. */
  readonly root = new THREE.Group();

  private readonly water = new WaterBuffer(BUF.w, BUF.h);
  /** Копія смуги вікна з кадру (світ під кабіною) — для заломлення. */
  private readonly copy = new SceneCopy();
  private readonly uniforms: Record<string, THREE.IUniform>;
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
  /** Смуги дощу надворі (rain.msk) у вікні. */
  private streakMesh: THREE.Mesh | null = null;
  private streakTex: THREE.DataTexture | null = null;
  private streakSize: [number, number] = [1, 1];

  /**
   * drop, runner — маски drop7 і drop10, розкодовані без палітри (рівень — у червоному каналі); blade — текстура
   * flash.txr (лопать — її смуга u 0,875…0,996).
   */
  constructor(drop: RgbaImage | null, runner: RgbaImage | null, blade: RgbaImage | null = null, streaks: RgbaImage | null = null) {
    const { w, h } = RAIN_VIEW;
    const S = BUF_SCALE;
    this.drop = drop && toLevels(drop);
    this.runner = runner && toLevels(runner);
    this.uniforms = waterUniforms(this.water.texture, SLOPE_SPAN / BUF.w, SLOPE_SPAN / BUF.h);
    // Осі двірників (0x462f38): (200, h + 10) і (200 + 1,5·h, h + 10) пікселів кадру — трохи нижче краю буфера; тут —
    // у пікселях буфера.
    this.pivots = [
      [PIVOT_X * S, (h + 10) * S],
      [(PIVOT_X + 1.5 * h) * S, (h + 10) * S],
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
    // Дощ надворі, видимий крізь вікно, — смуги rain.msk, як для зовнішніх камер (RainStreaks): в оригіналі з
    // кабіни їх немає (лише вода на склі); у порті — на прохання користувача. Під лопатями й водою на склі.
    if (streaks) {
      const t = new THREE.DataTexture(new Uint8Array(streaks.data), streaks.width, streaks.height, THREE.RGBAFormat);
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.flipY = false;
      t.needsUpdate = true;
      this.streakTex = t;
      this.streakSize = [streaks.width, streaks.height];
      // Смуга на всю ширину кадру з запасом (вікна ширшого екрана), висотою — до низу вікна; панель закриває решту.
      const sx0 = -STREAK_MARGIN;
      const sw = RAIN_VIEW.w + 2 * STREAK_MARGIN;
      const sh = RAIN_VIEW.y + RAIN_VIEW.h;
      const g = new THREE.PlaneGeometry(sw, sh).translate(sx0 + sw / 2, sh / 2, 0);
      // UV у пікселях малюнка: u = x / ширина, v = y / висота (камера 2D-кабіни — y униз).
      const uv = g.attributes.uv;
      const pos = g.attributes.position;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / streaks.width, pos.getY(i) / streaks.height);
      this.streakMesh = new THREE.Mesh(
        g,
        new THREE.MeshBasicMaterial({ map: t, transparent: true, opacity: STREAK_OPACITY, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
      );
      this.streakMesh.renderOrder = -30;
      this.streakMesh.frustumCulled = false;
      this.streakMesh.visible = false;
      this.root.add(this.streakMesh);
    }
    // Вода — поверх лопатей (в оригіналі буфер накладається на вид після світу). Камера 2D-кабіни — y униз: v = 0
    // PlaneGeometry — верх смуги на екрані, як рядок 0 буфера.
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h).translate(RAIN_VIEW.x + w / 2, RAIN_VIEW.y + h / 2, 0),
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: WATER_VERTEX,
        fragmentShader: WATER_FRAGMENT,
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

  /**
   * Перед малюванням 2D-кабіни (у кадрі вже світ): зміни буфера — на відеокарту; копія лише смуги вікна з кадру.
   * view — масштаб (CSS-пікселів на піксель кадру 640×480) і зсув кадру 2D-кабіни.
   */
  prepare(renderer: THREE.WebGLRenderer, view: { s: number; ox: number; oy: number }): void {
    this.water.upload(renderer);
    this.uniforms.wet.value = this.water.empty ? 0 : 1;
    if (this.water.empty) return;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const dev = view.s * renderer.getPixelRatio();
    const pad = WATER_LOOK.refractMax * dev + 2;
    // Смуга вікна в пікселях буфера малювання (y — знизу), із запасом на зсув заломлення.
    const top = (RAIN_VIEW.y + view.oy) * dev - pad;
    const bottom = (RAIN_VIEW.y + RAIN_VIEW.h + view.oy) * dev + pad;
    const y0 = Math.max(0, size.y - bottom);
    const y1 = Math.min(size.y, size.y - top);
    this.copy.copy(renderer, 0, y0, size.x, y1 - y0, this.uniforms);
    this.uniforms.k.value = WATER_LOOK.refract * dev;
    this.uniforms.kMax.value = WATER_LOOK.refractMax * dev;
  }

  update(dt: number, _speedKmh = 0): void {
    dt = Math.min(dt, MAX_DT);
    this.updateWipers(dt);
    if (this.streakMesh && this.streakTex) {
      this.streakMesh.visible = this.raining;
      // Падають униз 400 px кадру/с (як RainStreaks): зсув v на -швидкість/висоту.
      if (this.raining) this.streakTex.offset.y = (this.streakTex.offset.y - (STREAK_SPEED * dt) / this.streakSize[1]) % 1;
    }
    if (this.raining) {
      this.water.wet();
      this.spawn(dt);
    } else {
      this.water.dry(dt);
      if (this.water.empty) this.runners.length = 0;
    }
    this.run(dt);
  }

  /** Нові краплі (0x462f38): drop7 — у випадкові місця; drop10 — початок краплі, що стікає. */
  private spawn(dt: number): void {
    const { w, h } = BUF;
    if (this.drop) {
      this.dropAcc += DROPS_PER_SEC * dt;
      for (; this.dropAcc >= 1; this.dropAcc--) this.water.stamp(this.drop, rand(w), rand(h));
    }
    if (this.runner) {
      this.runAcc += RUNNERS_PER_SEC * dt;
      // Початок сліду: в оригіналі — рівномірно по висоті; у порті ближче до верху скла (y = h·r²: половина — у
      // верхній чверті), щоб слідів угорі було більше — на прохання користувача.
      for (; this.runAcc >= 1; this.runAcc--) {
        const r = Math.random();
        this.runners.push({ x: rand(w), y: Math.floor(h * r * r), acc: 0 });
      }
    }
  }

  /** Краплі, що стікають (0x473560): крок униз, зсув убік −4…3, три відбитки вздовж кроку. */
  private run(dt: number): void {
    const m = this.runner;
    if (!m) return;
    for (let i = this.runners.length - 1; i >= 0; i--) {
      const r = this.runners[i];
      r.acc += RUN_SPEED * BUF_SCALE * dt;
      for (; r.acc >= RUN_TICK; r.acc -= RUN_TICK) {
        const step = RUN_TICK;
        const dx = Math.floor(Math.random() * 8) - 4;
        this.water.stamp(m, r.x + Math.trunc(dx / 3), r.y + Math.trunc(step / 3));
        this.water.stamp(m, r.x + Math.trunc((2 * dx) / 3), r.y + Math.trunc((2 * step) / 3));
        this.water.stamp(m, r.x + dx, r.y + step);
        r.x += dx;
        r.y += step;
      }
      if (r.y >= BUF.h) this.runners.splice(i, 1);
    }
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
   * краю буфера. На відеокарту — лише прямокутник, який замели.
   */
  private wipe(a0: number, a1: number): void {
    if (this.water.empty || a0 === a1) return;
    const h = BUF.h;
    const lo = Math.min(a0, a1);
    const hi = Math.max(a0, a1);
    const r0 = HUB * BUF_SCALE;
    // Крок кута — як в оригіналі на його буфері; на детальнішому — дрібніший, щоб лінії не лишали щілин.
    const step = WIPE_STEP / BUF_SCALE;
    for (const [px, py] of this.pivots) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (let a = lo; a <= hi + step / 2; a += step) {
        const s = Math.sin(a);
        const c = Math.cos(a);
        for (let r = r0; r <= h; r++) this.water.erase(Math.round(px + r * s), Math.round(py - r * c));
        for (const r of [r0, h]) {
          const x = px + r * s;
          const y = py - r * c;
          x0 = Math.min(x0, x);
          y0 = Math.min(y0, y);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
      }
      this.water.mark(x0 - 1, y0 - 1, x1 + 2, y1 + 2);
    }
  }

  /** Лопаті вздовж ліній стирання: від осі до радіуса — висоти буфера, у кадрі 640×480. */
  private placeBlades(): void {
    const len = RAIN_VIEW.h;
    const wid = len * BLADE_WIDTH;
    const dx = Math.sin(this.angle);
    const dy = -Math.cos(this.angle);
    this.pivots.forEach(([x, y], i) => {
      // Стовпці матриці: x — уздовж лопаті (довжина), y — поперек (ширина), зсув — вісь.
      const fx = RAIN_VIEW.x + x / BUF_SCALE;
      const fy = RAIN_VIEW.y + y / BUF_SCALE;
      this.blades[i].matrix.set(dx * len, -dy * wid, 0, fx, dy * len, dx * wid, 0, fy, 0, 0, 1, 0, 0, 0, 0, 1);
      this.blades[i].matrixWorldNeedsUpdate = true;
    });
  }

  dispose(): void {
    this.water.dispose();
    this.copy.dispose();
    this.streakTex?.dispose();
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
