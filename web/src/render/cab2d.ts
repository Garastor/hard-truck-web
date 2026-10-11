import * as THREE from 'three';
import type { Msk } from '../formats/msk';

/**
 * 2D-кабіна, як у режимі оригіналу без 3D-кабіни (HTruck.exe 0x48fefc; розбір — re/notes/cab2d.md): растр
 * `panel_mask` з TRUCK.TCH поверх світу (прозорі серії маски — вікна), на ньому цифрові прилади й кермо-спрайт.
 * Усе — в координатах екрана оригіналу 640×480: маска в (sx − 80, sy − 30), де sx/sy — розгойдування ±30 px;
 * прилади від опорної точки P = (X + 172, Y + 356); кермо в (X + 115, Y + 325); вище маски й нижче за Y + 460 —
 * чорне. Малюється квадами в ортографічній сцені (без оновлення великої текстури щокадру).
 */

/** Імена масок 2D-кабіни, крім самої панелі (у сховищі — CAB2D/<імʼя>, див. assets/cab2d.ts). */
export const CAB2D_PARTS: string[] = [
  ...Array.from({ length: 39 }, (_, i) => `m_rul_${String(i + 1).padStart(2, '0')}.msk`),
  ...Array.from({ length: 10 }, (_, i) => `big${i}.msk`),
  ...Array.from({ length: 10 }, (_, i) => `small${i}.msk`),
  ...Array.from({ length: 10 }, (_, i) => `smallr${i}.msk`),
  ...Array.from({ length: 17 }, (_, i) => `rpm${String(i).padStart(2, '0')}.msk`),
  'gear_r.msk',
  ...Array.from({ length: 10 }, (_, i) => `gear${String(i).padStart(2, '0')}.msk`),
  'autogear.msk',
  'park.msk',
];

/**
 * Картинка-в-картинці праворуч на панелі, кадр 640×480 — виміряно зі знімка оригіналу користувача (у коді
 * оригіналу не знайдено; клавіша M там — «Switch TV Camera On/Off»). У порті — дзеркало заднього огляду.
 */
const PIP = { x: 449, y: 291, w: 167, h: 125 };
/** Межа розгойдування маски, px (0x48952c: 0x1e). */
const SWAY = 30;
/** Висота маски від її верху до чорної заливки внизу, px (truck.ini maskYtile для виду прямо). */
const TILE = 460;
/**
 * Кермо: кадр 19 ± g(|a|), a = −кермо·90 у знаках оригіналу — кадри густіші біля центру (таблиця порогів 0x547ab1:
 * до 5 — щокроку, до 13 — через крок, далі пороги 16, 20, 25, 31, 38, 46, 55, 65, 76). Тут — неперервно: між
 * порогами лінійно, щоб кадри можна було плавно змішувати (render), а не перескакувати.
 */
const WHEEL_KNOTS: [number, number][] = [
  [0, 0], [5, 5], [13, 9], [16, 10], [20, 11], [25, 12], [31, 13], [38, 14], [46, 15], [55, 16], [65, 17], [76, 18], [90, 19],
];
/**
 * Кут керма на кожному з 39 кадрів m_rul, ° (проти годинникової стрілки — додатний), відносно середнього кадру:
 * накопичені різниці сусідніх кадрів, знайдені підбором повороту, що найкраще суміщає кадр n із n + 1 (поворот
 * «еліптичний» — кермо видно під кутом, обід — еліпс 176×159). Біля центру ≈ 0,75° на кадр, на краях — 9…13°.
 */
const WHEEL_ANGLES = [
  79.5, 69.5, 60, 49.5, 41.5, 34.5, 28.25, 22.75, 18, 14.25, 11, 9, 7.25, 5.25, 3.25, 3, 2.25, 1.5, 0.75, 0, -1, -1.75,
  -2.5, -3.25, -4, -5.75, -7.75, -9.75, -11.5, -14.75, -18.5, -23.75, -29.75, -36.5, -43.75, -52.75, -62, -71, -84,
];
/** Центр обода в спрайті m_rul (180×162) і стиснення еліпса обода по вертикалі. */
const WHEEL_CX = 89.5;
const WHEEL_CY = 80;
const WHEEL_SQUASH = 79.5 / 88;
function wheelFrame(steer: number): number {
  // Знак — під кермо порту (−1 — ліворуч): кадри з меншим номером — кермо повернуте ліворуч.
  const a = THREE.MathUtils.clamp(steer, -1, 1) * 90;
  const m = Math.abs(a);
  let g = 19;
  for (let i = 1; i < WHEEL_KNOTS.length; i++) {
    const [m1, g1] = WHEEL_KNOTS[i];
    if (m <= m1) {
      const [m0, g0] = WHEEL_KNOTS[i - 1];
      g = g0 + ((m - m0) / (m1 - m0)) * (g1 - g0);
      break;
    }
  }
  return THREE.MathUtils.clamp(19 + Math.sign(a) * g, 0, 38);
}

export interface Cab2dState {
  speedKmh: number;
  /** Пробіг, м. */
  odometer: number;
  /** Частка обертів до кінця шкали тахометра (0…1). */
  rpm: number;
  /** −1 — R, 0 — N, 1… */
  gear: number;
  handbrake: boolean;
  /** Кермо −1…1. */
  steer: number;
  /** Швидкість машини в її системі: x — праворуч, y — угору, z — уперед, м/с (для розгойдування). */
  local: THREE.Vector3;
}

export class Cab2d {
  private readonly scene = new THREE.Scene();
  private readonly cam = new THREE.OrthographicCamera(0, 640, 0, 480, -1, 1);
  private readonly tex = new Map<string, THREE.Texture>();
  private readonly size = new Map<string, [number, number]>();
  private readonly quads: THREE.Mesh[] = [];
  private used = 0;
  private sx = 0;
  private sy = 0;
  /** Видима область кадру 640×480 на екрані (оновлює render): масштаб і зсув. */
  private view = { s: 1, ox: 0, oy: 0, w: 640, h: 480 };

  constructor(
    private readonly panel: Msk,
    parts: Map<string, Msk>,
  ) {
    this.add('panel', panel);
    for (const [n, m] of parts) this.add(n.replace(/\.msk$/, ''), m);
  }

  private add(name: string, m: Msk): void {
    const t = new THREE.DataTexture(new Uint8Array(m.data.buffer, m.data.byteOffset, m.data.byteLength), m.width, m.height);
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearFilter;
    t.flipY = false;
    t.needsUpdate = true;
    this.tex.set(name, t);
    this.size.set(name, [m.width, m.height]);
  }

  /** Розгойдування маски (0x48bc44): за кутом ковзання й вертикальною швидкістю, з обмеженням кроку за кадр. */
  update(dt: number, st: Cab2dState): void {
    const v = st.local;
    let tx = 0;
    let ty = 0;
    // На малій швидкості відношення шумне — розгойдування лише в русі.
    if (Math.abs(v.z) > 2) {
      tx = (-v.x / v.z) * 100;
      ty = (v.y / v.z) * 70;
    }
    tx = THREE.MathUtils.clamp(tx, -SWAY, SWAY);
    ty = THREE.MathUtils.clamp(ty, -SWAY, SWAY);
    // Плавно, без цілих пікселів (в оригіналі — крок до round(dt·20) px за кадр; на збільшеному екрані телефона
    // цілі кроки маски помітно смикались).
    const k = 1 - Math.exp(-dt * 4);
    this.sx += (tx - this.sx) * k;
    this.sy += (ty - this.sy) * k;
    this.state = st;
  }
  private state: Cab2dState | null = null;

  /**
   * Кадр 640×480 на екрані: масштаб за висотою, але не менше ширини 800 (маска 985 px покриває 80 px ліворуч від
   * кадру): на широкому екрані телефона обрізаються дах і низ під приладами, на 4:3 — нічого. Гіпотеза порту.
   */
  private layout(w: number, h: number): void {
    const s = Math.max(h / 480, w / 800);
    const vw = w / s;
    const vh = h / s;
    const ox = (vw - 640) / 2;
    // Знизу — край маски (Y + 460 = 430): по висоті кадр притиснутий до нього, якщо не вміщається.
    const oy = vh >= 480 ? (vh - 480) / 2 : Math.min(0, vh - 430);
    this.view = { s, ox, oy, w: vw, h: vh };
    this.cam.left = -ox;
    this.cam.right = vw - ox;
    this.cam.top = -oy;
    this.cam.bottom = vh - oy;
    this.cam.updateProjectionMatrix();
  }

  /** Прямокутник дзеркала (картинки-в-картинці) в пікселях екрана (CSS). */
  mirrorOnScreen(): { x: number; y: number; w: number; h: number } {
    const { s, ox, oy } = this.view;
    const r = PIP;
    return { x: (r.x + ox) * s, y: (r.y + oy) * s, w: r.w * s, h: r.h * s };
  }

  private quad(name: string | null, x: number, y: number, w?: number, h?: number, color?: number, rotation = 0, opacity = 1): void {
    let q = this.quads[this.used];
    if (!q) {
      q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.5, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
      q.renderOrder = this.used;
      this.quads.push(q);
      this.scene.add(q);
    }
    this.used++;
    const m = q.material as THREE.MeshBasicMaterial;
    const [tw, th] = name ? (this.size.get(name) ?? [0, 0]) : [w ?? 0, h ?? 0];
    const tex = name ? (this.tex.get(name) ?? null) : null;
    if (m.map !== tex) {
      m.map = tex;
      m.needsUpdate = true;
    }
    m.color.set(color ?? 0xffffff);
    // Напівпрозорий кадр керма (перехід між кадрами) — змішуванням, без порогу.
    m.alphaTest = tex && opacity >= 1 ? 0.5 : 0;
    m.opacity = opacity;
    q.visible = !!tex || color !== undefined;
    // Площина 1×1 з центром у нулі; камера — y униз (top < bottom), рядок 0 маски (flipY = false) — угорі.
    q.matrixAutoUpdate = false;
    q.matrix.makeScale(tw, th, 1).setPosition(x + tw / 2, y + th / 2, 0);
    if (rotation) {
      // Доповорот керма — навколо центру обода, «еліптичний»: розтягнути еліпс до кола, повернути, стиснути назад.
      const c = new THREE.Vector3(x + WHEEL_CX, y + WHEEL_CY, 0);
      const r = new THREE.Matrix4()
        .makeTranslation(c.x, c.y, 0)
        .multiply(new THREE.Matrix4().makeScale(1, WHEEL_SQUASH, 1))
        .multiply(new THREE.Matrix4().makeRotationZ(rotation))
        .multiply(new THREE.Matrix4().makeScale(1, 1 / WHEEL_SQUASH, 1))
        .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, 0));
      q.matrix.premultiply(r);
    }
    // Матриця задана вручну — світову перерахувати (інакше лишалась перша: ні доповороту, ні розгойдування).
    q.matrixWorldNeedsUpdate = true;
  }

  render(renderer: THREE.WebGLRenderer): void {
    const st = this.state;
    if (!st) return;
    const size = renderer.getSize(new THREE.Vector2());
    this.layout(size.x, size.y);
    this.used = 0;
    const X = this.sx - 80;
    const Y = this.sy - 30;
    this.quad('panel', X, Y);
    // Прилади (0x48f770): P = (X + 172, Y + 356).
    const px = X + 172;
    const py = Y + 356;
    const speed = Math.min(999, Math.round(Math.abs(st.speedKmh)));
    const sd = String(speed).padStart(3, ' ');
    for (let i = 0; i < 3; i++) if (sd[i] !== ' ') this.quad(`big${sd[i]}`, px + 10 * i, py);
    const m = Math.max(0, Math.round(st.odometer));
    for (let k = 0; k < 5; k++) {
      const d = Math.floor(m / 10 ** (5 - k)) % 10;
      this.quad(k < 3 ? `small${d}` : `smallr${d}`, px + 8 * k + (k < 3 ? 0 : 2), py + 15);
    }
    this.quad(`rpm${String(Math.min(16, Math.floor(Math.max(0, st.rpm) * 17))).padStart(2, '0')}`, px + 45, py - 6);
    this.quad(st.gear < 0 ? 'gear_r' : `gear${String(Math.min(9, st.gear)).padStart(2, '0')}`, px + 65, py + 5);
    this.quad('autogear', px + 96, py - 8);
    if (st.handbrake) this.quad('park', px + 39, py - 5);
    // Кермо: найближчий кадр, доповернутий на залишок кута до неперервного положення (39 кадрів на весь хід, на
    // краях — до 9° між кадрами: без доповороту кермо поверталось ривками; змішування кадрів давало двоїння).
    // Обертання — навколо центру спрайта (≈ центр обода); камера з y униз — знак протилежний.
    // Обидва сусідні кадри доповернуті до одного точного кута й плавно змішані: без змішування на межі кадрів
    // перескакував сам малюнок (ракурс маточини на краях помітно різний), без доповороту — двоїлося.
    const wf = wheelFrame(st.steer);
    const f0 = Math.min(37, Math.floor(wf));
    const t = wf - f0;
    const exact = WHEEL_ANGLES[f0] + (WHEEL_ANGLES[f0 + 1] - WHEEL_ANGLES[f0]) * t;
    const wheel = (f: number, opacity = 1) =>
      this.quad(`m_rul_${String(f + 1).padStart(2, '0')}`, X + 115, Y + 325, undefined, undefined, undefined, -THREE.MathUtils.degToRad(exact - WHEEL_ANGLES[f]), opacity);
    wheel(f0);
    if (t > 0.01) wheel(f0 + 1, THREE.MathUtils.smoothstep(t, 0, 1));
    // Чорне поза маскою: над нею й нижче за Y + 460, а також боки, якщо екран ширший за маску.
    const { ox, oy, w, h } = this.view;
    const left = -ox;
    const top = -oy;
    const black = 0x000000;
    if (Y > top) this.quad(null, left, top, w, Y - top, black);
    if (Y + TILE < top + h) this.quad(null, left, Y + TILE, w, top + h - Y - TILE, black);
    if (X > left) this.quad(null, left, top, X - left, h, black);
    const right = X + this.panel.width;
    if (right < left + w) this.quad(null, right, top, left + w - right, h, black);
    for (let i = this.used; i < this.quads.length; i++) this.quads[i].visible = false;
    renderer.render(this.scene, this.cam);
  }

  dispose(): void {
    for (const t of this.tex.values()) t.dispose();
    for (const q of this.quads) {
      q.geometry.dispose();
      (q.material as THREE.Material).dispose();
    }
  }
}
