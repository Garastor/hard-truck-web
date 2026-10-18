import * as THREE from 'three';

/**
 * Пакети білбордів (оптимізація порту для телефона): клуби диму, пари, вогню й уламки, що раніше були окремими
 * `THREE.Sprite` (кожен — свій виклик малювання й сортування; при гальмуванні з вихлопом — сотні), малюються
 * інстансами — один виклик на текстуру-кадр і змішування. Вигляд — як у SpriteMaterial: квадрат розміру size,
 * повернутий на rot у площині екрана, текстура × колір, туман сцени (повершинний, engine/render/vertexFog.ts),
 * прозорість без запису глибини. Усередині пакета — від дальніх до ближчих до камери.
 *
 * Користування: щокадру begin(), push() для кожного білборда (координати Three.js), end(камера).
 */

const VERTEX = `
#include <common>
#include <fog_pars_vertex>
attribute vec4 puff;
attribute float spin;
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4(puff.xyz, 1.0);
  vec2 p = position.xy * puff.w;
  float c = cos(spin);
  float s = sin(spin);
  mvPosition.xy += vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAGMENT = `
uniform sampler2D map;
uniform vec3 color;
#include <fog_pars_fragment>
varying vec2 vUv;
void main() {
  gl_FragColor = vec4(color, 1.0) * texture2D(map, vUv);
  #include <fog_fragment>
}`;

const WHITE = { value: new THREE.Color(1, 1, 1) };

class Batch {
  readonly mesh: THREE.Mesh;
  private readonly geo = new THREE.InstancedBufferGeometry();
  private readonly puff: THREE.InstancedBufferAttribute;
  private readonly spin: THREE.InstancedBufferAttribute;
  /** Зібрані за кадр: x, y, z, size, rot; глибина для сортування й порядок. */
  private readonly data: Float32Array;
  private readonly depth: Float32Array;
  private readonly order: number[] = [];
  n = 0;

  constructor(
    map: THREE.Texture,
    additive: boolean,
    color: { value: THREE.Color },
    readonly max: number,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index;
    this.geo.setAttribute('position', quad.getAttribute('position'));
    this.geo.setAttribute('uv', quad.getAttribute('uv'));
    this.puff = new THREE.InstancedBufferAttribute(new Float32Array(max * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.spin = new THREE.InstancedBufferAttribute(new Float32Array(max), 1).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('puff', this.puff);
    this.geo.setAttribute('spin', this.spin);
    this.geo.instanceCount = 0;
    this.data = new Float32Array(max * 5);
    this.depth = new Float32Array(max);
    const mat = new THREE.ShaderMaterial({
      uniforms: { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog), map: { value: map }, color },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.mesh.name = 'billboards';
  }

  push(x: number, y: number, z: number, size: number, rot: number): void {
    if (this.n >= this.max) return;
    const o = this.n++ * 5;
    this.data[o] = x;
    this.data[o + 1] = y;
    this.data[o + 2] = z;
    this.data[o + 3] = size;
    this.data[o + 4] = rot;
  }

  end(cam: THREE.Vector3): void {
    const n = this.n;
    this.geo.instanceCount = n;
    this.mesh.visible = n > 0;
    if (!n) return;
    const d = this.data;
    const order = this.order;
    order.length = n;
    for (let i = 0; i < n; i++) {
      const dx = d[i * 5] - cam.x;
      const dy = d[i * 5 + 1] - cam.y;
      const dz = d[i * 5 + 2] - cam.z;
      this.depth[i] = dx * dx + dy * dy + dz * dz;
      order[i] = i;
    }
    const depth = this.depth;
    order.sort((a, b) => depth[b] - depth[a]);
    const p = this.puff.array as Float32Array;
    const s = this.spin.array as Float32Array;
    for (let k = 0; k < n; k++) {
      const i = order[k] * 5;
      p[k * 4] = d[i];
      p[k * 4 + 1] = d[i + 1];
      p[k * 4 + 2] = d[i + 2];
      p[k * 4 + 3] = d[i + 3];
      s[k] = d[i + 4];
    }
    this.puff.clearUpdateRanges();
    this.puff.addUpdateRange(0, n * 4);
    this.puff.needsUpdate = true;
    this.spin.clearUpdateRanges();
    this.spin.addUpdateRange(0, n);
    this.spin.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

export class Billboards {
  readonly group = new THREE.Group();
  private readonly batches = new Map<string, Batch>();

  /**
   * lit — колір освітлення спільний для всіх непрозоро-змішаних білбордів (TREE_LIGHT; адитивні — білі, як
   * раніше); max — найбільше білбордів одного пакета.
   */
  constructor(
    private readonly lit: { value: THREE.Color },
    private readonly max: number,
  ) {
    this.group.name = 'billboards';
  }

  begin(): void {
    for (const b of this.batches.values()) b.n = 0;
  }

  push(map: THREE.Texture, additive: boolean, x: number, y: number, z: number, size: number, rot: number): void {
    const key = `${map.uuid}|${additive ? 1 : 0}`;
    let b = this.batches.get(key);
    if (!b) {
      b = new Batch(map, additive, additive ? WHITE : this.lit, this.max);
      this.batches.set(key, b);
      this.group.add(b.mesh);
    }
    b.push(x, y, z, size, rot);
  }

  end(cam: THREE.Vector3): void {
    for (const b of this.batches.values()) b.end(cam);
  }

  /** Білбордів у кадрі (налагодження). */
  get count(): number {
    let n = 0;
    for (const b of this.batches.values()) n += b.n;
    return n;
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    this.group.removeFromParent();
  }
}
