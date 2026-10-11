import * as THREE from 'three';

/**
 * Власні відблиски ліхтарів на дорозі (не з оригіналу — замість білбордів refl_r/refl_w, див. LampReflections):
 * скло кожного ліхтаря моделі віддзеркалюється в площині дороги й витягується до глядача, тож відблиск має форму
 * ліхтаря і плавно згасає на кінці. Світиться лише скло, видиме зараз (перемикачі StopFaraKey — габарит/гальмо,
 * BackFaraKey — задній хід, FFaraKey — фари), тому відблиск сам іде за станом світла. Параметри — на око.
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

/** Глибина віддзеркалення нижнього й верхнього краю скла під дорогою, м: відблиск від ліхтаря до кінця смуги. */
const DEPTH_NEAR = 0.15;
const DEPTH_FAR = 1.7;
/** Яскравість дальнього кінця відносно ближнього. */
const FAR_FADE = 0;
/** Над дорогою, м (щоб не потонув в асфальті). */
const LIFT = 0.03;
/** Суха нічна дорога відбиває слабше за мокру. */
const DRY_FACTOR = 0.3;
/** Шари відблиску: ширина контуру ліхтаря (відносно центру скла), довжина й яскравість — м'які краї. */
const LAYERS = [
  { width: 1, length: 1, gain: 0.5 },
  { width: 2, length: 1.2, gain: 0.28 },
  { width: 3.5, length: 1.4, gain: 0.14 },
];

type Kind = 'brake' | 'tail' | 'reverse' | 'head';

const KIND: Record<Kind, { color: THREE.Color; gain: number; needsLights: boolean }> = {
  brake: { color: new THREE.Color(1, 0.08, 0.04), gain: 1, needsLights: false },
  tail: { color: new THREE.Color(1, 0.08, 0.04), gain: 0.4, needsLights: true },
  reverse: { color: new THREE.Color(1, 1, 0.95), gain: 0.6, needsLights: false },
  head: { color: new THREE.Color(1, 0.95, 0.8), gain: 0.55, needsLights: true },
};

interface Lamp {
  src: THREE.Mesh;
  kind: Kind;
  front: boolean;
  /** Вершини трикутників скла в системі моделі. */
  verts: Float32Array;
  /** Частка висоти скла кожної вершини (0 — низ, 1 — верх). */
  height: Float32Array;
  centerX: number;
  centerY: number;
  out: THREE.Mesh;
  pos: THREE.BufferAttribute;
  col: THREE.BufferAttribute;
}

export class WetReflections {
  private readonly lamps: Lamp[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -4,
  });

  /** root — модель у системі гри (z угору), groundZ — висота дороги під машиною в цій системі (щокадру). */
  constructor(
    private readonly root: THREE.Object3D,
    private readonly groundZ: () => number,
  ) {
    root.updateWorldMatrix(true, true);
    const rootInv = root.matrixWorld.clone().invert();
    const v = new THREE.Vector3();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const info = lampOf(mesh);
      if (!info) return;
      const p = mesh.geometry.getAttribute('position');
      if (!p || p.count < 3) return;
      const m = rootInv.clone().multiply(mesh.matrixWorld);
      const verts = new Float32Array(p.count * 3);
      let zMin = Infinity;
      let zMax = -Infinity;
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        verts.set([v.x, v.y, v.z], i * 3);
        zMin = Math.min(zMin, v.z);
        zMax = Math.max(zMax, v.z);
        cx += v.x;
        cy += v.y;
      }
      const height = new Float32Array(p.count);
      for (let i = 0; i < p.count; i++) height[i] = zMax > zMin ? (verts[i * 3 + 2] - zMin) / (zMax - zMin) : 0.5;
      const geo = new THREE.BufferGeometry();
      const pos = new THREE.BufferAttribute(new Float32Array(p.count * 3 * LAYERS.length), 3);
      const col = new THREE.BufferAttribute(new Float32Array(p.count * 3 * LAYERS.length), 3);
      pos.setUsage(THREE.DynamicDrawUsage);
      col.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('position', pos);
      geo.setAttribute('color', col);
      const out = new THREE.Mesh(geo, this.material);
      out.frustumCulled = false;
      out.visible = false;
      out.renderOrder = 5;
      this.lamps.push({
        src: mesh,
        kind: info.kind,
        front: info.front,
        verts,
        height,
        centerX: cx / p.count,
        centerY: cy / p.count,
        out,
        pos,
        col,
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
    const c = this.root.worldToLocal(camera.getWorldPosition(this.tmp));
    const ground = this.groundZ();
    const g = ground + LIFT;
    const surface = wet ? 1 : DRY_FACTOR;
    for (const l of this.lamps) {
      const k = KIND[l.kind];
      // Видно, лише коли світиться саме це скло, і з боку, куди світить ліхтар (задній — ззаду машини).
      const show = c.z > g && (!k.needsLights || lights) && effectivelyVisible(l.src, this.root) && (l.front ? c.y > l.centerY : c.y < l.centerY);
      l.out.visible = show;
      if (!show) continue;
      const gain = k.gain * surface;
      const n = l.height.length;
      LAYERS.forEach((layer, li) => {
        for (let i = 0; i < n; i++) {
          const s = l.height[i];
          const depth = DEPTH_NEAR + (DEPTH_FAR - DEPTH_NEAR) * layer.length * s;
          const mx = l.centerX + (l.verts[i * 3] - l.centerX) * layer.width;
          const my = l.verts[i * 3 + 1];
          const mz = ground - depth;
          // Точка на дорозі на промені «камера → віддзеркалення»: на екрані — там, де було б віддзеркалення.
          const t = (c.z - g) / (c.z - mz);
          const j = li * n + i;
          l.pos.setXYZ(j, c.x + (mx - c.x) * t, c.y + (my - c.y) * t, g);
          const b = gain * layer.gain * (1 - (1 - FAR_FADE) * s);
          l.col.setXYZ(j, k.color.r * b, k.color.g * b, k.color.b * b);
        }
      });
      l.pos.needsUpdate = true;
      l.col.needsUpdate = true;
    }
  }

  dispose(): void {
    for (const l of this.lamps) {
      l.out.removeFromParent();
      l.out.geometry.dispose();
    }
    this.material.dispose();
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
