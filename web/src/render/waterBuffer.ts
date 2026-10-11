import * as THREE from 'three';
import type { RgbaImage } from '../formats/binary';

/**
 * Вода на склі (спільне для 2D-кабіни — Cab2dRain — і скла 3D-кабіни — GlassRain): буфер рівнів 0…255 — форма
 * поверхні води (краплі, сліди); відбитки масок, стирання двірниками, висихання.
 * На відеокарту йдуть лише змінені прямокутники (gl.texSubImage2D): уся текстура щокадру — сотні КБ.
 */

/** Маска рівнів: ширина, висота, рівень кожного пікселя (0 — прозоро). */
export interface Levels {
  w: number;
  h: number;
  a: Uint8Array;
}

/** Рівні з розкодованого зображення: channel — канал рівня (0 — червоний, 3 — прозорість); прозорі пікселі — 0. */
export function toLevels(img: RgbaImage, channel = 0): Levels {
  const a = new Uint8Array(img.width * img.height);
  for (let i = 0; i < a.length; i++) a[i] = img.data[i * 4 + 3] ? img.data[i * 4 + channel] : 0;
  return { w: img.width, h: img.height, a };
}

/** Висихання: рівні убувають FADE_STEPS кроками за FADE_TIME с (тривалість — гіпотеза). */
const FADE_STEPS = 15;
const FADE_TIME = 0.5;
/** Більше змінених прямокутників за кадр — оновлюємо всю текстуру. */
const MAX_RECTS = 48;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class WaterBuffer {
  readonly levels: Uint8Array;
  readonly texture: THREE.DataTexture;
  /** Порожній — нічого малювати (і копіювати кадр для заломлення). */
  empty = true;
  private readonly rects: Rect[] = [];
  private full = true;
  private fadeStep = 0;
  private fadeAcc = 0;

  /** wrap — координати по колу (текстура скла повторюється), інакше поза межами — відкидаються. */
  constructor(
    readonly w: number,
    readonly h: number,
    private readonly wrap = false,
  ) {
    this.levels = new Uint8Array(w * h);
    this.texture = new THREE.DataTexture(this.levels, w, h, THREE.RedFormat, THREE.UnsignedByteType);
    this.texture.flipY = false;
    // Плавні рівні — плавний нахил поверхні для заломлення.
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    if (wrap) this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
  }

  /** Відбиток маски (перезапис непрозорих пікселів, як копіювання маски в оригіналі). */
  stamp(m: Levels, x0: number, y0: number): void {
    const { w, h } = this;
    for (let y = 0; y < m.h; y++) {
      let by = y0 + y;
      if (this.wrap) by = ((by % h) + h) % h;
      else if (by < 0 || by >= h) continue;
      for (let x = 0; x < m.w; x++) {
        const v = m.a[y * m.w + x];
        if (!v) continue;
        let bx = x0 + x;
        if (this.wrap) bx = ((bx % w) + w) % w;
        else if (bx < 0 || bx >= w) continue;
        this.levels[by * w + bx] = v;
      }
    }
    this.mark(x0, y0, x0 + m.w, y0 + m.h);
    this.empty = false;
  }

  /** Стерти піксель (стирання двірником); межі змін додає виклик mark. */
  erase(x: number, y: number): void {
    const { w, h } = this;
    if (this.wrap) {
      x = ((x % w) + w) % w;
      y = ((y % h) + h) % h;
    } else if (x < 0 || x >= w || y < 0 || y >= h) return;
    this.levels[y * w + x] = 0;
  }

  /**
   * Позначити змінений прямокутник [x0, x1) × [y0, y1) у координатах буфера. По колу — переносимо в межі текстури й
   * розрізаємо на частини по її краях; більший за текстуру — уся текстура.
   */
  mark(x0: number, y0: number, x1: number, y1: number): void {
    if (this.full) return;
    if (this.wrap && (x0 < 0 || y0 < 0 || x1 > this.w || y1 > this.h)) {
      if (x1 - x0 >= this.w || y1 - y0 >= this.h) {
        this.full = true;
        return;
      }
      const sx = Math.floor(x0 / this.w) * this.w;
      const sy = Math.floor(y0 / this.h) * this.h;
      x0 -= sx;
      x1 -= sx;
      y0 -= sy;
      y1 -= sy;
      for (const [ax0, ax1] of x1 > this.w ? [[x0, this.w], [0, x1 - this.w]] : [[x0, x1]])
        for (const [ay0, ay1] of y1 > this.h ? [[y0, this.h], [0, y1 - this.h]] : [[y0, y1]]) this.markIn(ax0, ay0, ax1, ay1);
      return;
    }
    this.markIn(x0, y0, x1, y1);
  }

  private markIn(x0: number, y0: number, x1: number, y1: number): void {
    if (this.full) return;
    const r = { x0: Math.max(0, Math.floor(x0)), y0: Math.max(0, Math.floor(y0)), x1: Math.min(this.w, Math.ceil(x1)), y1: Math.min(this.h, Math.ceil(y1)) };
    if (r.x1 <= r.x0 || r.y1 <= r.y0) return;
    if (this.rects.length >= MAX_RECTS) this.full = true;
    else this.rects.push(r);
  }

  /** Висихання без дощу; true — буфер став порожнім. */
  dry(dt: number): void {
    if (this.empty) return;
    this.fadeAcc += dt;
    const step = FADE_TIME / FADE_STEPS;
    if (this.fadeAcc < step) return;
    this.fadeAcc = 0;
    if (++this.fadeStep >= FADE_STEPS) {
      this.levels.fill(0);
      this.empty = true;
      this.fadeStep = 0;
    } else {
      const dec = Math.ceil(255 / FADE_STEPS);
      const a = this.levels;
      for (let i = 0; i < a.length; i++) a[i] = a[i] > dec ? a[i] - dec : 0;
    }
    this.full = true;
  }

  /** Знову дощ — висихання з початку. */
  wet(): void {
    this.fadeStep = 0;
  }

  /** Передати зміни на відеокарту (перед малюванням). */
  upload(renderer: THREE.WebGLRenderer): void {
    if (!this.full && !this.rects.length) return;
    const props = renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture };
    // Ще не завантажена — цілком (через Three.js), як і коли змін забагато.
    if (this.full || !props.__webglTexture) {
      this.texture.needsUpdate = true;
      this.full = false;
      this.rects.length = 0;
      return;
    }
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const state = renderer.state;
    state.bindTexture(gl.TEXTURE_2D, props.__webglTexture);
    // Three.js ставить ці прапорці під кожну свою текстуру — після «перевернутої» рядки лягали б дзеркально.
    state.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    state.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    state.pixelStorei(gl.UNPACK_ROW_LENGTH, this.w);
    for (const r of this.rects) {
      state.pixelStorei(gl.UNPACK_SKIP_PIXELS, r.x0);
      state.pixelStorei(gl.UNPACK_SKIP_ROWS, r.y0);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, gl.RED, gl.UNSIGNED_BYTE, this.levels);
    }
    state.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    state.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    state.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    state.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    state.unbindTexture();
    this.rects.length = 0;
  }

  /** Усе змінилось (повне оновлення). */
  markAll(): void {
    this.full = true;
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Шейдер води (власний ефект порту, за згодою користувача): картинка під водою зсувається за нахилом поверхні
 * (заломлення) й світлішає / темнішає (світло згори — нижній край краплі світліший); WATER — частка заломленої
 * картинки, решта — вид без води. Нахил рахується в UV буфера (span — крок вибірки), зсув — на екрані через похідні
 * UV (скло 3D-кабіни стоїть під кутом); uvDown — знак «униз» по v на екрані.
 */
export const WATER_FRAGMENT = `
  uniform sampler2D levels, scene;
  uniform vec2 res, origin, span;
  uniform float k, kMax, shade, water, wet;
  varying vec2 vUv;
  void main() {
    float a = texture2D(levels, vUv).r;
    if (a <= 0.0 || wet < 0.5) discard;
    float du = texture2D(levels, vUv + vec2(span.x, 0.0)).r - texture2D(levels, vUv - vec2(span.x, 0.0)).r;
    float dv = texture2D(levels, vUv + vec2(0.0, span.y)).r - texture2D(levels, vUv - vec2(0.0, span.y)).r;
    // Напрямок нахилу з UV у пікселі екрана: J — похідні UV за екраном, J⁻¹ переводить UV-вектор в екранний.
    vec2 ux = dFdx(vUv), uy = dFdy(vUv);
    float det = ux.x * uy.y - uy.x * ux.y;
    vec2 g = vec2(0.0);
    if (abs(det) > 1e-12) {
      vec2 s = vec2(uy.y * du - uy.x * dv, -ux.y * du + ux.x * dv) / det;
      float l = length(s);
      if (l > 0.0) g = s / l * length(vec2(du, dv));
    }
    vec2 off = g * k;
    float lo = length(off);
    if (lo > kMax) off *= kMax / lo;
    vec3 bg = texture2D(scene, (gl_FragCoord.xy + off - origin) / res).rgb;
    vec3 clear = texture2D(scene, (gl_FragCoord.xy - origin) / res).rgb;
    // g.y < 0 — поверхня піднімається донизу екрана (нижній край краплі): світліше; верхній край — темніше.
    float light = clamp(1.0 + shade * (-g.y - 0.3 * g.x), 0.6, 1.5);
    gl_FragColor = vec4(mix(clear, bg * light, water), 1.0);
  }`;

export const WATER_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

/** Заломлення й світлотінь (на око): зсув у px екрана на одиницю нахилу та межа, яскравість, частка води. */
export const WATER_LOOK = { refract: 20, refractMax: 3, shade: 2.5, water: 0.75 };

/**
 * Копія кадру під водою для заломлення: прямокутник буфера малювання (у пікселях, y — знизу), текстура того ж
 * розміру; uniforms шейдера (scene, res, origin).
 */
export class SceneCopy {
  private tex: THREE.FramebufferTexture | null = null;

  copy(renderer: THREE.WebGLRenderer, x: number, y: number, w: number, h: number, uniforms: Record<string, THREE.IUniform>): void {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    if (!this.tex || this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex?.dispose();
      this.tex = new THREE.FramebufferTexture(w, h);
      this.tex.magFilter = THREE.LinearFilter;
      this.tex.minFilter = THREE.LinearFilter;
    }
    const pos = new THREE.Vector2(Math.round(x), Math.round(y));
    renderer.copyFramebufferToTexture(this.tex, pos);
    uniforms.scene.value = this.tex;
    (uniforms.res.value as THREE.Vector2).set(w, h);
    (uniforms.origin.value as THREE.Vector2).copy(pos);
  }

  dispose(): void {
    this.tex?.dispose();
  }
}

/** Uniforms шейдера води. */
export function waterUniforms(levels: THREE.Texture, spanU: number, spanV: number): Record<string, THREE.IUniform> {
  return {
    levels: { value: levels },
    scene: { value: null },
    res: { value: new THREE.Vector2(1, 1) },
    origin: { value: new THREE.Vector2() },
    span: { value: new THREE.Vector2(spanU, spanV) },
    k: { value: 0 },
    kMax: { value: 0 },
    shade: { value: WATER_LOOK.shade },
    water: { value: WATER_LOOK.water },
    wet: { value: 0 },
  };
}
