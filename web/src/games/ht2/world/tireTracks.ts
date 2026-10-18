import * as THREE from 'three';
import type { SceneAssembler } from '../engine/render/sceneBuilder';

/**
 * Сліди шин king.exe (re/notes/ht2/wheel-effects.md; система 0x4bc690, додавання 0x4bcd00, квад 0x4bd850).
 *
 * Колесо, що лишає слід (прапорець фізики 1/2 → матеріал trace0/trace1 COMMON), щокадру дає точку контакту; стрічка
 * колеса росте відрізками не коротшими за 0,2 м: квад від попередньої точки до нової, ширина — товщина колеса з tech,
 * кути початку — поперек напряму попереднього відрізка (стики без щілин). Напрям повернув більше ніж на 5 рад
 * (cos 5 = 0,284 — так у коді) чи колесо пропустило кадр — стрічка рветься. Текстура вздовж: v = 0 → довжина/ширина
 * (повтор на кожен відрізок). Вершини — на площині контакту + 0,1 м. Усі колеса пишуть в одне кільце з 1200 вершин
 * (200 відрізків) на матеріал; сліди не згасають — найстаріші перезаписуються новими.
 */
const MIN_STEP = 0.2;
const BREAK_COS = Math.cos(5);
const LIFT = 0.1;
const RING = 1200;

interface Ribbon {
  state: 0 | 1 | 2;
  frame: number;
  /** Початок і кінець поточного відрізка, нормалі контактів, ширини; напрями попереднього й поточного відрізка. */
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  n0: THREE.Vector3;
  n1: THREE.Vector3;
  w0: number;
  w1: number;
  prev: THREE.Vector3;
  dir: THREE.Vector3;
}

interface Layer {
  mesh: THREE.Mesh;
  pos: Float32Array;
  uv: Float32Array;
  count: number;
}

export class TireTracks {
  readonly group = new THREE.Group();
  private readonly layers: (Layer | null)[];
  private readonly ribbons = new Map<number, Ribbon>();
  private frame = 0;

  constructor(asm: SceneAssembler) {
    this.group.name = 'tireTracks';
    const mats = asm.b3d.materials.map((m) => m.toLowerCase());
    this.layers = ['trace0', 'trace1'].map((name) => {
      const i = mats.indexOf(name);
      const map = i >= 0 ? (asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
      if (!map) return null;
      const pos = new Float32Array(RING * 3);
      const uv = new Float32Array(RING * 2);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2).setUsage(THREE.DynamicDrawUsage));
      geo.setDrawRange(0, 0);
      const mat = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: true });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = name;
      mesh.frustumCulled = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      return { mesh, pos, uv, count: 0 };
    });
  }

  /** Початок кадру сліду (лічильник кадрів king.exe [світ+0xbb0]: колесо, що пропустило кадр, рве стрічку). */
  beginFrame(): void {
    this.frame++;
  }

  /**
   * Колесо key лишає слід цього кадру: p — точка контакту, n — нормаль ґрунту (Three.js), w — ширина, м,
   * type — 0 (trace0) чи 1 (trace1).
   */
  add(key: number, p: THREE.Vector3, n: THREE.Vector3, w: number, type: number): void {
    let r = this.ribbons.get(key);
    if (!r) {
      r = { state: 0, frame: 0, p0: new THREE.Vector3(), p1: new THREE.Vector3(), n0: new THREE.Vector3(), n1: new THREE.Vector3(), w0: 0, w1: 0, prev: new THREE.Vector3(), dir: new THREE.Vector3() };
      this.ribbons.set(key, r);
    }
    if (r.frame + 1 < this.frame) r.state = 0;
    r.frame = this.frame;
    if (r.state === 0) {
      r.p0.copy(p);
      r.n0.copy(n);
      r.w0 = w;
      r.state = 1;
      return;
    }
    const from = r.state === 1 ? r.p0 : r.p1;
    if (from.distanceTo(p) < MIN_STEP) return;
    if (r.state === 2) {
      // Відрізок зсувається: кінець стає початком.
      r.p0.copy(r.p1);
      r.n0.copy(r.n1);
      r.w0 = r.w1;
      r.prev.copy(r.dir);
    }
    r.p1.copy(p);
    r.n1.copy(n);
    r.w1 = w;
    r.dir.subVectors(r.p1, r.p0).normalize();
    if (r.state === 1) r.prev.copy(r.dir);
    if (r.prev.dot(r.dir) < BREAK_COS) {
      r.state = 0;
      return;
    }
    this.quad(r, type);
    r.state = 2;
  }

  /** Квад відрізка (два трикутники) у кільце матеріалу. */
  private quad(r: Ribbon, type: number): void {
    const layer = this.layers[type] ?? this.layers[1] ?? this.layers[0];
    if (!layer) return;
    const side0 = new THREE.Vector3().crossVectors(r.prev, r.n0).normalize().multiplyScalar(r.w0 / 2);
    const side1 = new THREE.Vector3().crossVectors(r.dir, r.n1).normalize().multiplyScalar(r.w1 / 2);
    const v = r.p0.distanceTo(r.p1) / r.w1;
    const a = this.onPlane(r.p0.clone().sub(side0), r.p0, r.n0);
    const b = this.onPlane(r.p0.clone().add(side0), r.p0, r.n0);
    const c = this.onPlane(r.p1.clone().sub(side1), r.p1, r.n1);
    const d = this.onPlane(r.p1.clone().add(side1), r.p1, r.n1);
    const verts: [THREE.Vector3, number, number][] = [[b, 1, 0], [d, 1, v], [c, 0, v], [c, 0, v], [a, 0, 0], [b, 1, 0]];
    const base = layer.count % RING;
    verts.forEach(([p, u, t], k) => {
      layer.pos.set([p.x, p.y, p.z], (base + k) * 3);
      layer.uv.set([u, t], (base + k) * 2);
    });
    layer.count += 6;
    const geo = layer.mesh.geometry;
    geo.setDrawRange(0, Math.min(layer.count, RING));
    geo.attributes.position.needsUpdate = true;
    geo.attributes.uv.needsUpdate = true;
  }

  /** Точка на площині контакту (висота над точкою x, z) + підйом. */
  private onPlane(q: THREE.Vector3, p: THREE.Vector3, n: THREE.Vector3): THREE.Vector3 {
    if (Math.abs(n.y) > 0.05) q.y = p.y - (n.x * (q.x - p.x) + n.z * (q.z - p.z)) / n.y;
    return q.addScaledVector(n, LIFT);
  }

  /** Усі сліди геть (нова гра, перезавантаження світу). */
  clear(): void {
    this.ribbons.clear();
    for (const l of this.layers) {
      if (!l) continue;
      l.count = 0;
      l.mesh.geometry.setDrawRange(0, 0);
    }
  }

  dispose(): void {
    for (const l of this.layers) {
      if (!l) continue;
      l.mesh.geometry.dispose();
      (l.mesh.material as THREE.Material).dispose();
    }
    this.group.removeFromParent();
  }
}
