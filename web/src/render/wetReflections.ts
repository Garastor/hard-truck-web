import * as THREE from 'three';

/**
 * Власні відблиски ліхтарів на дорозі (не з оригіналу — замість білбордів refl_r/refl_w, див. LampReflections):
 * кожне скло, що світиться зараз (перемикачі StopFaraKey — габарит/гальмо, BackFaraKey — задній хід, FFaraKey —
 * фари), дає м'яку пляму на асфальті від ліхтаря до глядача (від фар — ширший конус). Пляма лежить на дорозі
 * (висота асфальту — променями вниз), тож з різних камер видно перспективу; під пологим кутом мокра дорога відбиває
 * сильніше. Поперек — гаусів спад, уздовж — плавне згасання (шейдер). Параметри — на око.
 */
export type ReflectionMode = 'own' | 'original';

const MODE_KEY = 'ht.reflections';

export function reflectionMode(): ReflectionMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'original' ? 'original' : 'own';
  } catch {
    return 'own';
  }
}

export function setReflectionMode(mode: ReflectionMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* без сховища — лише на цей запуск */
  }
}

/**
 * Форма плями на дорозі, м: початок від ліхтаря, довжина, ширина відносно скла (і найменша півширина),
 * розширення до кінця (×(1 + spread)). Задні ліхтарі — коротка пляма, фари — довгий конус.
 */
const REAR_PATCH = { start: 0.1, length: 2.6, width: 1.6, minHalfWidth: 0.22, spread: 0.6 };
const HEAD_PATCH = { start: 0.3, length: 7, width: 1.6, minHalfWidth: 0.3, spread: 2.2 };
/** Відрізків уздовж смуги (щоб вона йшла по дорозі). */
const SEGMENTS = 8;
/** Над дорогою, м (щоб не потонув в асфальті). */
const LIFT = 0.05;
/** Суха нічна дорога відбиває слабше за мокру. */
const DRY_FACTOR = 0.3;

type Kind = 'brake' | 'tail' | 'reverse' | 'head';

const KIND: Record<Kind, { color: THREE.Color; gain: number; needsLights: boolean }> = {
  brake: { color: new THREE.Color(1, 0.08, 0.04), gain: 3.2, needsLights: false },
  tail: { color: new THREE.Color(1, 0.08, 0.04), gain: 1.6, needsLights: true },
  reverse: { color: new THREE.Color(1, 1, 0.95), gain: 2, needsLights: false },
  head: { color: new THREE.Color(1, 0.95, 0.8), gain: 2, needsLights: true },
};

const VERTEX = /* glsl */ `
attribute vec2 band;
varying vec2 vBand;
varying float vDist;
void main() {
  vBand = band;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDist = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 color;
uniform float gain;
varying vec2 vBand;
varying float vDist;
void main() {
  // Поперек — гаусів спад, уздовж — швидке наростання на початку й плавне згасання до кінця.
  float across = exp(-vBand.x * vBand.x * 3.5);
  float v = vBand.y;
  float along = smoothstep(0.0, 0.18, v) * pow(1.0 - v, 1.4);
  float fade = 1.0 - smoothstep(80.0, 220.0, vDist);
  vec3 c = color * gain * across * along * fade;
  // Шум ±0,5/255 — без сходинок на плавному градієнті.
  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
  gl_FragColor = vec4(c + n / 255.0, 1.0);
}`;

interface Lamp {
  src: THREE.Mesh;
  kind: Kind;
  front: boolean;
  /** Центр і півширина скла в системі моделі (x — убік). */
  center: THREE.Vector3;
  halfWidth: number;
  out: THREE.Mesh;
  pos: THREE.BufferAttribute;
  material: THREE.ShaderMaterial;
}

export class WetReflections {
  private readonly lamps: Lamp[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly cam = new THREE.Vector3();
  private readonly lampW = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly fwd = new THREE.Vector3();
  private readonly across = new THREE.Vector3();

  /**
   * root — модель у системі гри (z угору); groundZ — висота дороги під машиною в цій системі (запасний варіант);
   * groundAt — висота дороги у світі під точкою (x, z), шукаючи вниз від y (Three.js).
   */
  constructor(
    private readonly root: THREE.Object3D,
    private readonly groundZ: () => number,
    private readonly groundAt?: (x: number, y: number, z: number) => number | null,
  ) {
    root.updateWorldMatrix(true, true);
    const rootInv = root.matrixWorld.clone().invert();
    const v = new THREE.Vector3();
    // Смуга: SEGMENTS+1 рядів по 2 вершини; band = (поперек −1…1, уздовж 0…1).
    const rows = SEGMENTS + 1;
    const band = new Float32Array(rows * 4);
    const index: number[] = [];
    for (let r = 0; r < rows; r++) {
      band.set([-1, r / SEGMENTS, 1, r / SEGMENTS], r * 4);
      if (r < SEGMENTS) index.push(r * 2, r * 2 + 1, r * 2 + 2, r * 2 + 1, r * 2 + 3, r * 2 + 2);
    }
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const info = lampOf(mesh);
      if (!info) return;
      const p = mesh.geometry.getAttribute('position');
      if (!p || p.count < 3) return;
      const m = rootInv.clone().multiply(mesh.matrixWorld);
      const box = new THREE.Box3();
      for (let i = 0; i < p.count; i++) box.expandByPoint(v.fromBufferAttribute(p, i).applyMatrix4(m));
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(rows * 2 * 3), 3);
      pos.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      geo.setAttribute('band', new THREE.BufferAttribute(band, 2));
      geo.setIndex(index);
      const material = new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: { color: { value: KIND[info.kind].color }, gain: { value: 0 } },
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -4,
      });
      const out = new THREE.Mesh(geo, material);
      out.frustumCulled = false;
      out.visible = false;
      out.renderOrder = 5;
      this.lamps.push({
        src: mesh,
        kind: info.kind,
        front: info.front,
        center: box.getCenter(new THREE.Vector3()),
        halfWidth: (box.max.x - box.min.x) / 2,
        out,
        pos,
        material,
      });
    });
    for (const l of this.lamps) root.add(l.out);
  }

  get count(): number {
    return this.lamps.length;
  }

  /** lights — горять габарити й фари; wet — мокра дорога; enabled — режим власних відблисків. */
  update(camera: THREE.Camera, lights: boolean, wet: boolean, enabled: boolean): void {
    if (!this.lamps.length) return;
    const on = enabled && (lights || wet);
    if (!on) {
      for (const l of this.lamps) l.out.visible = false;
      return;
    }
    this.root.updateWorldMatrix(true, false);
    const mw = this.root.matrixWorld;
    const cam = camera.getWorldPosition(this.cam);
    const c = this.root.worldToLocal(this.tmp.copy(cam));
    const surface = wet ? 1 : DRY_FACTOR;
    for (const l of this.lamps) {
      const k = KIND[l.kind];
      // Видно, лише коли світиться саме це скло, і з боку, куди світить ліхтар (задній — ззаду машини).
      let show = (!k.needsLights || lights) && effectivelyVisible(l.src, this.root) && (l.front ? c.y > l.center.y : c.y < l.center.y);
      // Дорога під ліхтарем — у світі (промінь униз), а не площина днища: на переломі дороги смуга лягає на асфальт.
      const lamp = this.lampW.copy(l.center).applyMatrix4(mw);
      const near = show ? (this.groundAt?.(lamp.x, lamp.y, lamp.z) ?? this.root.localToWorld(this.tmp.set(l.center.x, l.center.y, this.groundZ())).y) : 0;
      show &&= cam.y > near + LIFT + 0.2;
      l.out.visible = show;
      if (!show) continue;
      const g = near + LIFT;
      // Пляма лежить на асфальті й тягнеться від ліхтаря до глядача (як відблиск на мокрій дорозі), з
      // перспективою — не білборд.
      const fwd = this.fwd.set(cam.x - lamp.x, 0, cam.z - lamp.z);
      if (fwd.lengthSq() < 1e-6) fwd.set(mw.elements[4], 0, mw.elements[6]);
      fwd.normalize();
      // Ширина — поперек напрямку до глядача.
      const across = this.across.set(-fwd.z, 0, fwd.x);
      const shape = l.kind === 'head' ? HEAD_PATCH : REAR_PATCH;
      const top = near + 2;
      const rel = (x: number, z: number) => {
        const r = this.groundAt?.(x, top, z);
        return r === null || r === undefined ? 0 : Math.max(-1.5, Math.min(1.5, r - near));
      };
      const along = (d: number, out: THREE.Vector3) => out.set(lamp.x, g, lamp.z).addScaledVector(fwd, d);
      const pm = along(shape.start + shape.length / 2, this.p);
      const riseMid = rel(pm.x, pm.z);
      const pf = along(shape.start + shape.length, this.p);
      const riseFar = rel(pf.x, pf.z);
      const halfW0 = Math.max(shape.minHalfWidth, l.halfWidth * shape.width);
      for (let r = 0; r <= SEGMENTS; r++) {
        const u = r / SEGMENTS;
        const p = along(shape.start + shape.length * u, this.p);
        p.y += u < 0.5 ? riseMid * u * 2 : riseMid + (riseFar - riseMid) * (u - 0.5) * 2;
        const halfW = halfW0 * (1 + shape.spread * u);
        for (const [i, sgn] of [
          [0, -1],
          [1, 1],
        ] as const) {
          const q = this.tmp.copy(p).addScaledVector(across, sgn * halfW);
          this.root.worldToLocal(q);
          l.pos.setXYZ(r * 2 + i, q.x, q.y, q.z);
        }
      }
      l.pos.needsUpdate = true;
      // Під пологим кутом мокра дорога відбиває сильніше (Френель, на око).
      const dist = Math.hypot(lamp.x - cam.x, lamp.z - cam.z);
      const grazing = 1 - Math.min(1, (cam.y - near) / Math.max(1, dist));
      l.material.uniforms.gain.value = k.gain * surface * (0.45 + 0.55 * grazing);
    }
  }

  dispose(): void {
    for (const l of this.lamps) {
      l.out.removeFromParent();
      l.out.geometry.dispose();
      l.material.dispose();
    }
  }
}

/** Скло якого ліхтаря (за назвами предків: `<Модель>[FB]Fara[LR]` і група стану перемикача). */
function lampOf(mesh: THREE.Object3D): { kind: Kind; front: boolean } | null {
  let state: { key: string; n: number } | null = null;
  for (let p = mesh.parent; p; p = p.parent) {
    const sw = /^(StopFaraKey|BackFaraKey|FFaraKey)[LR]?#(\d+)$/.exec(p.name);
    if (sw && !state) state = { key: sw[1], n: Number(sw[2]) };
    const lamp = /([FB])Fara[LR]$/i.exec(p.name);
    if (lamp && !/Key/.test(p.name)) {
      if (!state) return null;
      const front = lamp[1].toUpperCase() === 'F';
      if (state.key === 'StopFaraKey') return state.n === 1 ? { kind: 'brake', front } : state.n === 2 ? { kind: 'tail', front } : null;
      if (state.key === 'BackFaraKey') return state.n === 1 ? { kind: 'reverse', front } : null;
      return state.n === 1 ? { kind: 'head', front } : null;
    }
  }
  return null;
}

function effectivelyVisible(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}
