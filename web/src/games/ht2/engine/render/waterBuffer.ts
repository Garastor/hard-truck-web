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

/**
 * Висихання без дощу (у тунелі): рівні убувають FADE_STEPS кроками за FADE_TIME с. Тривалість і кроки — на око
 * (на прохання користувача: за 0,5 с, як було, вода в тунелі зникала одразу); кроки дрібні, щоб убування було
 * плавним, і рідкі (≈ 4 за секунду), бо кожен крок — вивантаження всієї текстури.
 */
const FADE_STEPS = 32;
const FADE_TIME = 8;
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
    // Плавні рівні — плавний нахил поверхні для заломлення. Міпмапи — середній рівень околу (густота крапель, де
    // вони зливаються в суцільну воду, WATER_FRAGMENT).
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    if (wrap) this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.needsUpdate = true;
  }

  /**
   * Відбиток маски (перезапис непрозорих пікселів, як копіювання маски в оригіналі): сліди стікання glass_2 (рівень
   * 17 з 255) змивають круглі краплі — так гарніше (користувач; спроба брати більший рівень — відкинута). Тонка вода
   * все одно спотворює картинку повністю (лінза в WATER_FRAGMENT).
   */
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
    // Залишок — у наступний крок (обнулення розтягувало висихання на частку кадру за крок).
    this.fadeAcc = Math.min(this.fadeAcc - step, step);
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

  /** Наступне вивантаження — уся текстура (після повернення з фону чи втрати контексту WebGL). */
  invalidate(): void {
    this.full = true;
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
    gl.generateMipmap(gl.TEXTURE_2D);
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
 * Шейдер води (власний ефект порту, за згодою користувача; лінза — за виглядом оригіналу): картинка під водою
 * збільшена й зібрана з текселів буфера (lens, zoom), на краях крапель — зсувається за нахилом поверхні
 * (заломлення) й світлішає / темнішає (світло згори — нижній край краплі світліший); WATER — частка заломленої
 * картинки, решта — вид без води. Нахил рахується в UV буфера (span — крок вибірки), зсув — на екрані через похідні
 * UV (скло 3D-кабіни стоїть під кутом); uvDown — знак «униз» по v на екрані.
 */
export const WATER_FRAGMENT = `
  uniform sampler2D levels, scene;
  uniform vec2 res, origin, span, cells;
  uniform float k, kMax, shade, water, wet, lens, zoom, lensCell, mergeLo, mergeHi, mergeBias, mergeWave, mergeCell, mergeZoom;
  varying vec2 vUv;
  // UV-вектор буфера → вектор на екрані (px): J — похідні UV за екраном, J⁻¹ переводить назад.
  vec2 toScreen(vec2 d, vec2 ux, vec2 uy, float det) {
    return vec2(uy.y * d.x - uy.x * d.y, -ux.y * d.x + ux.x * d.y) / det;
  }
  // Лінза: скло поділене на клітинки по cell текселів буфера; у кожній картинка збільшена навколо центру клітинки
  // (вибірка в zm разів ближча до центру), між чотирма сусідніми клітинками — лінійне згладжування.
  vec3 lensAt(float cell, float zm, vec2 ux, vec2 uy, float det) {
    vec2 grid = cells / cell;
    vec2 t = vUv * grid - 0.5;
    vec2 c0 = floor(t);
    vec2 f = t - c0;
    vec3 q[4];
    for (int i = 0; i < 4; i++) {
      vec2 c = c0 + vec2(float(i - (i / 2) * 2), float(i / 2)) + 0.5;
      vec2 d = toScreen(c / grid - vUv, ux, uy, det) * (1.0 - zm);
      q[i] = texture2D(scene, (gl_FragCoord.xy + d - origin) / res).rgb;
    }
    return mix(mix(q[0], q[1], f.x), mix(q[2], q[3], f.x), f.y);
  }
  void main() {
    float a = texture2D(levels, vUv).r;
    if (a <= 0.0 || wet < 0.5) discard;
    float du = texture2D(levels, vUv + vec2(span.x, 0.0)).r - texture2D(levels, vUv - vec2(span.x, 0.0)).r;
    float dv = texture2D(levels, vUv + vec2(0.0, span.y)).r - texture2D(levels, vUv - vec2(0.0, span.y)).r;
    vec2 ux = dFdx(vUv), uy = dFdy(vUv);
    float det = ux.x * uy.y - uy.x * ux.y;
    // Злиття: середній рівень околу (міпмап, mergeBias — на стільки рівнів грубіше) — густота води. Де крапель
    // багато, поверхня — згладжене поле (той самий міпмап): суцільна вода з пологими хвилями замість окремих цяток.
    float m = texture2D(levels, vUv, mergeBias).r;
    float merge = smoothstep(mergeLo, mergeHi, m);
    if (merge > 0.0) {
      vec2 sp = span * exp2(mergeBias);
      float su = texture2D(levels, vUv + vec2(sp.x, 0.0), mergeBias).r - texture2D(levels, vUv - vec2(sp.x, 0.0), mergeBias).r;
      float sv = texture2D(levels, vUv + vec2(0.0, sp.y), mergeBias).r - texture2D(levels, vUv - vec2(0.0, sp.y), mergeBias).r;
      du = mix(du, su * mergeWave, merge);
      dv = mix(dv, sv * mergeWave, merge);
    }
    vec2 g = vec2(0.0);
    vec3 clear = texture2D(scene, (gl_FragCoord.xy - origin) / res).rgb;
    vec3 under = clear;
    if (abs(det) > 1e-12) {
      vec2 s = toScreen(vec2(du, dv), ux, uy, det);
      float l = length(s);
      if (l > 0.0) g = s / l * length(vec2(du, dv));
      // Лінза (як в оригіналі — «збільшення, пікселі, згладжування», на прохання користувача).
      vec3 lensed = lensAt(lensCell, zoom, ux, uy, det);
      // На суцільній воді — більші клітинки й сильніше збільшення: картинка збільшена й розмита (згладжування між
      // далекими центрами клітинок), на прохання користувача.
      if (merge > 0.0) lensed = mix(lensed, lensAt(mergeCell, mergeZoom, ux, uy, det), merge);
      // Лінза — на будь-якій воді, і на тонкій (сліди стікання — рівень 17 з 255): скло під водою спотворене повністю.
      under = mix(clear, lensed, lens * smoothstep(0.0, 0.05, a));
    }
    vec2 off = g * k;
    float lo = length(off);
    if (lo > kMax) off *= kMax / lo;
    vec3 bg = texture2D(scene, (gl_FragCoord.xy + off - origin) / res).rgb;
    // g.y < 0 — поверхня піднімається донизу екрана (нижній край краплі): світліше; верхній край — темніше.
    float light = clamp(1.0 + shade * (-g.y - 0.3 * g.x), 0.6, 1.5);
    gl_FragColor = vec4(mix(under, bg * light, water * min(1.0, length(g) * 4.0)), 1.0);
  }`;

export const WATER_VERTEX = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';

/**
 * Злиття густих крапель у суцільну воду (на прохання користувача, на око): середній рівень околу 2^bias текселів
 * (bias 3 — 8 × 8 ≈ 2 см скла); від lo до hi — перехід від окремих крапель до суцільної води; wave — підсилення
 * нахилу згладженої поверхні (пологі хвилі); cell, zoom — лінза суцільної води (клітинка в текселях, множник
 * відстані вибірки: менше — більше збільшення; згладжування між центрами клітинок розмиває).
 */
const WATER_MERGE = { mergeLo: 0.05, mergeHi: 0.15, mergeBias: 3, mergeWave: 0.6, mergeCell: 14, mergeZoom: 0.15 };

/**
 * Заломлення й світлотінь (на око): зсув у px екрана на одиницю нахилу та межа, яскравість, частка води на краях
 * крапель; lens — частка «лінзи» під водою, lensCell — клітинка лінзи в текселях буфера (6 з 512 ≈ 1,4 см скла), zoom — множник відстані
 * вибірки від центру клітинки (менше — більше збільшення; 0 — суцільний колір центру, «пікселі»).
 */
export const WATER_LOOK = { refract: 20, refractMax: 3, shade: 2.5, water: 0.75, lens: 1, zoom: 0.4, lensCell: 6, ...WATER_MERGE };

/**
 * Копія кадру під водою для заломлення: прямокутник буфера малювання (у пікселях, y — знизу), текстура того ж
 * розміру; uniforms шейдера (scene, res, origin). scale < 1 — копія зменшена (blitFramebuffer з лінійним
 * згладжуванням; телефон — удвічі, на прохання користувача: копія щокадру — помітна частка роботи відеочипа). Шейдер
 * бере копію в нормованих координатах, тож розмір копії на нього не впливає. Зменшення неможливе для полотна зі
 * згладжуванням (MSAA) чи WebGL1 — тоді повна копія.
 */
export class SceneCopy {
  private tex: THREE.FramebufferTexture | null = null;
  private small: THREE.WebGLRenderTarget | null = null;

  copy(renderer: THREE.WebGLRenderer, x: number, y: number, w: number, h: number, uniforms: Record<string, THREE.IUniform>, scale = 1): void {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const pos = new THREE.Vector2(Math.round(x), Math.round(y));
    (uniforms.res.value as THREE.Vector2).set(w, h);
    (uniforms.origin.value as THREE.Vector2).copy(pos);
    const small = scale < 1 ? this.blit(renderer, pos, w, h, scale) : null;
    if (small) {
      uniforms.scene.value = small;
      return;
    }
    if (!this.tex || this.tex.image.width !== w || this.tex.image.height !== h) {
      this.tex?.dispose();
      this.tex = new THREE.FramebufferTexture(w, h);
      this.tex.magFilter = THREE.LinearFilter;
      this.tex.minFilter = THREE.LinearFilter;
    }
    renderer.copyFramebufferToTexture(this.tex, pos);
    uniforms.scene.value = this.tex;
  }

  /** Зменшена копія кадру (малювання — на екран) у власну ціль; null — неможливо. */
  private blit(renderer: THREE.WebGLRenderer, pos: THREE.Vector2, w: number, h: number, scale: number): THREE.Texture | null {
    const gl = renderer.getContext();
    if (typeof WebGL2RenderingContext === 'undefined' || !(gl instanceof WebGL2RenderingContext)) return null;
    if (renderer.getRenderTarget() || gl.getContextAttributes()?.antialias) return null;
    const tw = Math.max(1, Math.round(w * scale));
    const th = Math.max(1, Math.round(h * scale));
    if (!this.small || this.small.width !== tw || this.small.height !== th) {
      this.small?.dispose();
      this.small = new THREE.WebGLRenderTarget(tw, th, { depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
      renderer.initRenderTarget(this.small);
    }
    const fb = (renderer.properties.get(this.small) as { __webglFramebuffer?: WebGLFramebuffer }).__webglFramebuffer;
    if (!fb) return null;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
    gl.blitFramebuffer(pos.x, pos.y, pos.x + w, pos.y + h, 0, 0, tw, th, gl.COLOR_BUFFER_BIT, gl.LINEAR);
    // Назад на екран: Three.js вважає, що прив'язане полотно (малювання кабіни йде туди ж).
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.small.texture;
  }

  dispose(): void {
    this.tex?.dispose();
    this.tex = null;
    this.small?.dispose();
    this.small = null;
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
    cells: { value: new THREE.Vector2((levels.image as { width: number }).width, (levels.image as { height: number }).height) },
    lens: { value: WATER_LOOK.lens },
    zoom: { value: WATER_LOOK.zoom },
    lensCell: { value: WATER_LOOK.lensCell },
    mergeLo: { value: WATER_LOOK.mergeLo },
    mergeHi: { value: WATER_LOOK.mergeHi },
    mergeBias: { value: WATER_LOOK.mergeBias },
    mergeWave: { value: WATER_LOOK.mergeWave },
    mergeCell: { value: WATER_LOOK.mergeCell },
    mergeZoom: { value: WATER_LOOK.mergeZoom },
    k: { value: 0 },
    kMax: { value: 0 },
    shade: { value: WATER_LOOK.shade },
    water: { value: WATER_LOOK.water },
    wet: { value: 0 },
  };
}
