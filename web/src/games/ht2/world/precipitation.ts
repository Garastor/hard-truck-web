import * as THREE from 'three';
import type { SceneAssembler } from '../engine/render/sceneBuilder';

/**
 * Дощ і сніг частинками — CRain (0x4bee30, кадр 0x4befa0, малювання 0x4c03d0) і CSnow (0x4be8d0, 0x4bea60, 0x4bffb0)
 * king.exe; емітер 0x4bf470/0x4bf7a0 (re/notes/ht2/weather.md «Дощ і сніг частинками»). Координати нижче — гри
 * (x, y, z угору; вітер завжди вздовж +y гри).
 * - Що саме падає — лише за висотою камери: дощ при 0 < z < 475, сніг при 470 < z < 580 (гори); вище й нижче — нічого.
 * - Народжуються при w ≥ 0,7 по одній кожні (1 + 10·(1 − f)²)·база с, f = max(0,5; (w − 0,7)·3,333); база — дощ 1e-4,
 *   сніг 0,01. Ліміт живих 50 + 130·(fps − 5) у межах 50…2000. При w < 0,7 нових немає, наявні догорають.
 * - Зона народження — ромб попереду камери: центр E = камера + уперед·0,3·|v машини|, вершина на висоті h над E,
 *   p = E + r₁·dir₊ + r₂·dir₋ (r ∈ [k, 1], k = 2/D), dir± — «уперед», повернутий на ±a (a = 0,7 поля зору), довжиною
 *   D/cos a. Дощ: D 15, h 10; сніг: D 30, h 7.
 * - Швидкість (0; 0,2·вітер; vz·(1 + rnd)), vz: дощ −30, сніг −7; прискорення вниз: дощ 0,8, сніг 0. Життя спадає
 *   на 0,06/с; гине нижче камери на 2 м чи за 16,7 с. Світові координати, дахи й колізії не перевіряються.
 * - Частинка — один трикутник, лише далі 2 м від камери (глибина d): крапля — вертикальна риска з вершиною на
 *   s·(8 + 0,5d) і основою ±σ·s·(0,25 + 0,025d) (s = 0,1; основа зсунута вітром 0,025·вітер); сніжинка — трикутник
 *   s·m, m = 0,2 + 0,1d (s = 0,05). uv: вершина (0,5; 0), основа (0; 1)…(1; 1). Текстури rain/snow (COMMON).
 * Гіпотези порту: колір краплі — колір туману з L + 0,425 і S × 0,5 (у exe — RGB невідомого обʼєкта 0x5b6700, звідки
 * — не зʼясовано); яскравість снігу (поле погоди +0x224) — яскравість кольору туману; змішування — звичайна прозорість.
 */
const MAX = 2000;
const LIFE_DECAY = 0.06;
const NEAR = 2;
const BELOW = 2;

interface Kind {
  base: number;
  size: number;
  vz: number;
  gravity: number;
  height: number;
  depth: number;
  zMin: number;
  zMax: number;
}

const RAIN: Kind = { base: 1e-4, size: 0.1, vz: -30, gravity: 0.8, height: 10, depth: 15, zMin: 0, zMax: 475 };
const SNOW: Kind = { base: 0.01, size: 0.05, vz: -7, gravity: 0, height: 7, depth: 30, zMin: 470, zMax: 580 };

class Emitter {
  readonly mesh: THREE.Mesh;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly life = new Float32Array(MAX);
  private n = 0;
  private timer = 0;
  private readonly geo = new THREE.BufferGeometry();
  private readonly vtx = new Float32Array(MAX * 9);
  private readonly col = new Float32Array(MAX * 12);

  constructor(
    private readonly kind: Kind,
    map: THREE.Texture | null,
    private readonly rain: boolean,
  ) {
    const uv = new Float32Array(MAX * 6);
    for (let i = 0; i < MAX; i++) uv.set([0.5, 0, 0, 1, 1, 1], i * 6);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.vtx, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ map, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.name = rain ? 'rain' : 'snow';
  }

  /** cam — камера (гра), fwd — горизонтальний напрям уперед (гра, одиничний), a — кут ромба, limit — ліміт живих. */
  update(dt: number, w: number, wind: number, cam: THREE.Vector3, fwd: THREE.Vector2, speed: number, a: number, limit: number, color: THREE.Color, alpha: number): void {
    const k = this.kind;
    const on = cam.z > k.zMin && cam.z < k.zMax && w >= 0.7;
    // Рух і загибель.
    let j = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      this.vel[o + 2] -= k.gravity * dt;
      const x = this.pos[o] + this.vel[o] * dt;
      const y = this.pos[o + 1] + this.vel[o + 1] * dt;
      const z = this.pos[o + 2] + this.vel[o + 2] * dt;
      const l = this.life[i] - LIFE_DECAY * dt;
      if (z <= cam.z - BELOW || l <= 0) continue;
      const q = j * 3;
      this.pos[q] = x;
      this.pos[q + 1] = y;
      this.pos[q + 2] = z;
      this.vel[q] = this.vel[o];
      this.vel[q + 1] = this.vel[o + 1];
      this.vel[q + 2] = this.vel[o + 2];
      this.life[j] = l;
      j++;
    }
    this.n = j;
    // Народження.
    if (on) {
      const f = Math.max(0.5, (w - 0.7) * 3.333);
      const interval = (1 + 10 * (1 - f) ** 2) * k.base;
      this.timer += dt;
      const r0 = 2 / k.depth;
      const len = k.depth / Math.cos(a);
      const ex = cam.x + fwd.x * 0.3 * speed;
      const ey = cam.y + fwd.y * 0.3 * speed;
      const ez = cam.z + k.height;
      const c1 = Math.cos(a);
      const s1 = Math.sin(a);
      const px = (fwd.x * c1 - fwd.y * s1) * len;
      const py = (fwd.x * s1 + fwd.y * c1) * len;
      const mx = (fwd.x * c1 + fwd.y * s1) * len;
      const my = (-fwd.x * s1 + fwd.y * c1) * len;
      while (this.timer >= interval && this.n < Math.min(limit, MAX)) {
        this.timer -= interval;
        const r1 = r0 + Math.random() * (1 - r0);
        const r2 = r0 + Math.random() * (1 - r0);
        const o = this.n * 3;
        this.pos[o] = ex + r1 * px + r2 * mx;
        this.pos[o + 1] = ey + r1 * py + r2 * my;
        this.pos[o + 2] = ez;
        this.vel[o] = 0;
        this.vel[o + 1] = 0.2 * wind;
        this.vel[o + 2] = k.vz * (1 + Math.random());
        this.life[this.n] = 1;
        this.n++;
      }
      // Не накопичувати борг випуску, коли ліміт досягнуто.
      this.timer = Math.min(this.timer, interval);
    } else this.timer = 0;
    this.build(cam, fwd, wind, color, alpha);
  }

  /** Трикутники частинок (координати three.js: x, z, −y гри). */
  private build(cam: THREE.Vector3, fwd: THREE.Vector2, wind: number, color: THREE.Color, alpha: number): void {
    const s = this.kind.size;
    // σ = вгору × уперед — горизонтальний бічний вектор.
    const sx = -fwd.y;
    const sy = fwd.x;
    let t = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const x = this.pos[o];
      const y = this.pos[o + 1];
      const z = this.pos[o + 2];
      const d = fwd.x * (x - cam.x) + fwd.y * (y - cam.y);
      if (d <= NEAR) continue;
      let top: number;
      let half: number;
      let shift = 0;
      if (this.rain) {
        top = s * (8 + 0.5 * d);
        half = s * (0.25 + 0.025 * d);
        shift = 0.025 * wind;
      } else {
        const m = 0.2 + 0.1 * d;
        top = s * m;
        half = s * m;
      }
      const v = t * 9;
      // Вершина.
      this.vtx[v] = x;
      this.vtx[v + 1] = z + top;
      this.vtx[v + 2] = -y;
      // Основа −σ (uv 0; 1) і +σ (uv 1; 1).
      this.vtx[v + 3] = x - sx * half;
      this.vtx[v + 4] = z - s;
      this.vtx[v + 5] = -(y + shift - sy * half);
      this.vtx[v + 6] = x + sx * half;
      this.vtx[v + 7] = z - s;
      this.vtx[v + 8] = -(y + shift + sy * half);
      const c = t * 12;
      for (let q = 0; q < 3; q++) {
        this.col[c + q * 4] = color.r;
        this.col[c + q * 4 + 1] = color.g;
        this.col[c + q * 4 + 2] = color.b;
        this.col[c + q * 4 + 3] = alpha;
      }
      t++;
    }
    this.geo.setDrawRange(0, t * 3);
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  get alive(): number {
    return this.n;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class Precipitation {
  readonly group = new THREE.Group();
  private readonly rain: Emitter;
  private readonly snow: Emitter;
  private fps = 60;
  private readonly cam = new THREE.Vector3();
  private readonly fwd = new THREE.Vector2();
  private readonly look = new THREE.Vector3();
  private readonly color = new THREE.Color();
  private readonly hsl = { h: 0, s: 0, l: 0 };

  constructor(asm: SceneAssembler) {
    this.group.name = 'precipitation';
    const map = (name: string): THREE.Texture | null => {
      const idx = asm.b3d.materials.findIndex((m) => m.toLowerCase() === name);
      return idx < 0 ? null : ((asm.lib.material(idx) as THREE.MeshBasicMaterial).map ?? null);
    };
    this.rain = new Emitter(RAIN, map('rain'), true);
    this.snow = new Emitter(SNOW, map('snow'), false);
    this.group.add(this.rain.mesh, this.snow.mesh);
  }

  /**
   * Кадр: camera — камера сцени, speed — швидкість машини гравця, м/с, w — показник погоди, wind — вітер (Climate),
   * fog — колір туману, on — дощ і сніг увімкнено (повзунки, ui/effects.ts precipitation()).
   */
  update(dt: number, camera: THREE.PerspectiveCamera, speed: number, w: number, wind: number, fog: THREE.Color, on: boolean): void {
    if (dt > 0) this.fps += (1 / dt - this.fps) * Math.min(1, dt * 2);
    const limit = Math.max(50, Math.min(MAX, 50 + 130 * (this.fps - 5)));
    camera.getWorldPosition(this.look);
    this.cam.set(this.look.x, -this.look.z, this.look.y);
    camera.getWorldDirection(this.look);
    this.fwd.set(this.look.x, -this.look.z);
    if (this.fwd.lengthSq() < 1e-6) this.fwd.set(1, 0);
    this.fwd.normalize();
    // Кут ромба: 0,7 горизонтального поля зору (у exe — 2·atan(xpyramid/2)).
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * camera.aspect);
    const a = 0.7 * hfov;
    const ww = on ? w : 0;
    // Дощ: колір туману, L + 0,425, S × 0,5, непрозорий.
    fog.getHSL(this.hsl);
    this.color.setHSL(this.hsl.h, this.hsl.s * 0.5, Math.min(1, this.hsl.l + 0.425));
    this.rain.update(dt, ww, wind, this.cam, this.fwd, speed, a, limit, this.color, 1);
    // Сніг: сірий clamp(1,25·яскравість; 0,25; 0,76), альфа 0,75.
    const g = Math.max(0.25, Math.min(0.76, 1.25 * (0.299 * fog.r + 0.587 * fog.g + 0.114 * fog.b)));
    this.color.setRGB(g, g, g);
    this.snow.update(dt, ww, wind, this.cam, this.fwd, speed, a, limit, this.color, 0.75);
  }

  /** Живих частинок (налагодження). */
  get count(): { rain: number; snow: number } {
    return { rain: this.rain.alive, snow: this.snow.alive };
  }

  dispose(): void {
    this.rain.dispose();
    this.snow.dispose();
    this.group.removeFromParent();
  }
}
