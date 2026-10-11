import * as THREE from 'three';
import type { RgbaImage } from '../formats/binary';

/**
 * Дощ на склі й двірники 2D-кабіни — як в оригіналі (HTruck.exe: об'єкт 0x4caa10, створюється лише в режимі без
 * 3D-кабіни, 0x4c7134; оновлення 0x4d0180, спільна логіка 0x462f38, малювання 0x4638c4; розбір — re/notes/cab2d.md).
 * Буфер крапель — на всю смугу вікна: краплі `msk\drop7.msk` штампуються у випадкові місця, двірники стирають
 * сектор, який замели; лопаті — смужки за формою моделі `Wiper` (COUNT.B3D). Інтерфейс — як у GlassRain (3D-скло).
 * Текстуру лопаті не з'ясовано: у програмному наборі матеріал `wiper ttx 1`, але перша текстура COUNT.RMP
 * (flash.txr) у смузі UV лопаті — шматок спалаху; апаратна `wiper tex 133` — атлас 3D-кабін. Тому лопать — темна
 * суцільна смужка (гіпотеза).
 */

/** Швидкість помаху, рад/с (0x54625c), положення спокою (0x546264) і нижня межа помаху (поле +0x9c), рад. */
const SPEED = 2.35619445;
const REST = Math.PI / 2;
const LOW = -Math.PI / 3;
/** Нових крапель за секунду (поле +0x20 = 50). */
const DROPS_PER_SEC = 50;
/** Вісь першого двірника — x = 200 (поле +0x58); стирання від радіуса 10 (поле +0x60) до висоти буфера. */
const PIVOT_X = 200;
const HUB = 10;
/** Висихання без дощу: прозорість убуває 15 кроками (4 біти альфи буфера оригіналу) за FADE_TIME с (гіпотеза). */
const FADE_STEPS = 15;
const FADE_TIME = 0.5;
/** Ширина лопаті до довжини — як у моделі `Wiper` (COUNT.B3D: 0,08 × 0,85); колір — гіпотеза (див. вище). */
const BLADE_WIDTH = 0.08 / 0.85;
const BLADE_COLOR = 0x141414;
/** Найбільший крок часу оновлення, с. */
const MAX_DT = 0.1;

/**
 * Буфер — смуга вікна прямого виду в кадрі 640×480: truck.ini [CAR] maskYview0 = 44, maskYview1 = 250 (висота).
 * Що буфер оригіналу — саме ця смуга, гіпотеза: розмір береться з поверхні виду (param_2 + 0xc), не розібрано.
 */
export const RAIN_VIEW = { x: 0, y: 44, w: 640, h: 250 };

export class Cab2dRain {
  raining = false;
  wipersOn = false;
  /** Кожен помах (звук двірників). */
  onStroke: (() => void) | null = null;
  /** Буфер крапель і лопаті — у сцені 2D-кабіни (кадр 640×480, y униз), під маскою панелі. */
  readonly root = new THREE.Group();

  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly drop: HTMLCanvasElement | null;
  private readonly blades: THREE.Mesh[] = [];
  private readonly pivots: [number, number][];
  private angle = REST;
  /** Хід униз (від спокою до нижньої межі); інакше — угору, до спокою. */
  private down = false;
  private moving = false;
  private dropAcc = 0;
  private fadeStep = 0;
  private fadeAcc = 0;
  private dirty = false;
  private empty = true;

  constructor(drop: RgbaImage | null) {
    const { w, h } = RAIN_VIEW;
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.flipY = false;
    this.drop = drop ? toCanvas(drop) : null;
    // Осі двірників (0x462f38): (200, h + 10) і (200 + 1,5·h, h + 10) — трохи нижче краю буфера.
    this.pivots = [
      [PIVOT_X, h + 10],
      [PIVOT_X + 1.5 * h, h + 10],
    ];
    // Лопаті: смужка від осі (x = 0) до кінця (x = 1), поперек — y −0,5…0,5.
    for (let i = 0; i < 2; i++) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, -0.5, 0, 1, -0.5, 0, 1, 0.5, 0, 0, 0.5, 0], 3));
      g.setIndex([0, 1, 2, 0, 2, 3]);
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: BLADE_COLOR, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      m.matrixAutoUpdate = false;
      m.renderOrder = -20;
      m.frustumCulled = false;
      this.blades.push(m);
      this.root.add(m);
    }
    // Краплі — поверх лопатей (в оригіналі буфер накладається на вид після світу).
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h).translate(RAIN_VIEW.x + w / 2, RAIN_VIEW.y + h / 2, 0),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
    );
    quad.renderOrder = -10;
    quad.frustumCulled = false;
    this.root.add(quad);
    this.placeBlades();
  }

  update(dt: number, _speedKmh = 0): void {
    // Після паузи (прихована вкладка) крок буває секундами — двірник проскочив би межу помаху.
    dt = Math.min(dt, MAX_DT);
    this.updateWipers(dt);
    if (this.raining && this.drop) {
      this.fadeStep = 0;
      this.dropAcc += DROPS_PER_SEC * dt;
      for (; this.dropAcc >= 1; this.dropAcc--) {
        this.ctx.drawImage(this.drop, Math.floor(Math.random() * RAIN_VIEW.w), Math.floor(Math.random() * RAIN_VIEW.h));
        this.dirty = true;
        this.empty = false;
      }
    } else if (!this.raining && !this.empty) this.dry(dt);
    if (this.dirty) {
      this.texture.needsUpdate = true;
      this.dirty = false;
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

  /** Стирає сектор між кутами a0 і a1 від радіуса HUB до висоти буфера в обох двірників. Точка лопаті під кутом a —
   * (x + r·sin a, y − r·cos a): у спокої (+90°) лопать лежить праворуч від осі, нижче краю буфера. */
  private wipe(a0: number, a1: number): void {
    if (this.empty || a0 === a1) return;
    const c = this.ctx;
    const r = RAIN_VIEW.h;
    // Кут полотна θ (від +x за годинниковою, y униз) = a − π/2.
    const t0 = Math.min(a0, a1) - Math.PI / 2;
    const t1 = Math.max(a0, a1) - Math.PI / 2;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    c.beginPath();
    for (const [x, y] of this.pivots) {
      c.moveTo(x + HUB * Math.cos(t0), y + HUB * Math.sin(t0));
      c.arc(x, y, r, t0, t1);
      c.arc(x, y, HUB, t1, t0, true);
      c.closePath();
    }
    // Лінія завтовшки в піксель, як у стирання оригіналу (0x414bb0): без щілин між кадрами.
    c.lineWidth = 1.5;
    c.fill();
    c.stroke();
    c.restore();
    this.dirty = true;
  }

  /** Висихання: альфа буфера убуває рівними кроками (у буфері оригіналу — 4-бітна альфа, 15 кроків). */
  private dry(dt: number): void {
    this.fadeAcc += dt;
    const step = FADE_TIME / FADE_STEPS;
    if (this.fadeAcc < step) return;
    this.fadeAcc = 0;
    if (++this.fadeStep >= FADE_STEPS) {
      this.ctx.clearRect(0, 0, RAIN_VIEW.w, RAIN_VIEW.h);
      this.empty = true;
      this.fadeStep = 0;
    } else {
      const img = this.ctx.getImageData(0, 0, RAIN_VIEW.w, RAIN_VIEW.h);
      const d = img.data;
      const dec = Math.ceil(255 / FADE_STEPS);
      for (let i = 3; i < d.length; i += 4) d[i] = d[i] > dec ? d[i] - dec : 0;
      this.ctx.putImageData(img, 0, 0);
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
    for (const o of this.root.children) {
      const m = o as THREE.Mesh;
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
  }
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}
