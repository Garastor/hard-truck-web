import * as THREE from 'three';

/**
 * Пакування моделі вантажівки для телефона. У B3D кожна деталь — окремий вузол, і майже всі лежать у групах
 * перемикачів (вмʼятини `Damage*Key#n`, відблиски, рівні деталізації), тож модель — 60…100 викликів малювання (з 15
 * суперниками ≈ 700 за кадр), а статично злити їх не можна: групи перемикаються незалежно.
 * Тут — динамічно: з деталей, які видно зараз, — одна сітка на матеріал (≈ 15…30 викликів). Оригінали лишаються
 * в моделі (перемикачі й видимість працюють як раніше), але на шарі, якого камера не малює. Коли набір видимих
 * деталей змінюється (вмʼятина, фари, рівень деталізації за відстанню), пакунок збирається заново; поки не зібраний —
 * машина малюється оригіналами (вигляд завжди правильний).
 * Не пакуємо: колеса (рухаються), скло й корпуси ліхтарів (`*Fara*` — їх тримає WetReflections), тінь, вогонь,
 * прозорі матеріали (порядок змішування), сітки з власним onBeforeRender.
 */
/** Шар, якого не малює жодна камера (1 — верх кабіни в оверлеї). */
const HIDDEN_LAYER = 31;

interface Part {
  mesh: THREE.Mesh;
  /** Предки від сітки до кореня (без кореня): деталь видно, коли видно всіх. */
  chain: THREE.Object3D[];
  key: string;
  /** Атрибути в системі кореня, без індексу. */
  attrs: Map<string, { array: Float32Array; itemSize: number }>;
}

export class ModelBatch {
  private readonly parts: Part[] = [];
  private readonly meshes = new Map<string, THREE.Mesh>();
  private readonly sphere = new THREE.Sphere();
  private visible: Uint8Array;
  /** Пакунок відповідає поточному набору видимих деталей. */
  private fresh = false;
  /** Оригінали зараз приховані (малюється пакунок). */
  private batched = false;

  constructor(
    private readonly root: THREE.Object3D,
    skip: (o: THREE.Object3D) => boolean,
  ) {
    root.updateMatrixWorld(true);
    const inv = root.matrixWorld.clone().invert();
    const rel = new THREE.Matrix4();
    const normal = new THREE.Matrix3();
    const box = new THREE.Box3();
    const walk = (o: THREE.Object3D, chain: THREE.Object3D[]): void => {
      for (const c of o.children) {
        if (skip(c) || /fara|shadow|flame/i.test(c.name)) continue;
        const mesh = c as THREE.Mesh;
        if (mesh.isMesh && packable(mesh)) {
          rel.multiplyMatrices(inv, mesh.matrixWorld);
          normal.getNormalMatrix(rel);
          const attrs = flatAttributes(mesh.geometry, rel, normal);
          const mat = mesh.material as THREE.Material;
          const key = `${mat.uuid}|${mesh.renderOrder}|${[...attrs.keys()].sort().join(',')}`;
          this.parts.push({ mesh, chain: [...chain], key, attrs });
          const pos = attrs.get('position')!.array;
          for (let i = 0; i < pos.length; i += 3) box.expandByPoint(new THREE.Vector3(pos[i], pos[i + 1], pos[i + 2]));
        }
        walk(c, [c, ...chain]);
      }
    };
    walk(root, []);
    box.getBoundingSphere(this.sphere);
    this.visible = new Uint8Array(this.parts.length);
  }

  get count(): number {
    return this.parts.length;
  }

  /**
   * Після рендеру основної камери (перемикачі деталізації вже виставлено для неї): чи змінився набір видимих
   * деталей; якщо так і allowRebuild — збирає пакунок, інакше до перескладання малюємо оригінали. Повертає, чи
   * перескладав.
   */
  update(allowRebuild: boolean): boolean {
    let changed = false;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      let v = p.mesh.visible ? 1 : 0;
      for (let k = 0; v && k < p.chain.length; k++) if (!p.chain[k].visible) v = 0;
      if (v !== this.visible[i]) {
        this.visible[i] = v;
        changed = true;
      }
    }
    if (changed) this.fresh = false;
    if (this.fresh) return false;
    if (!allowRebuild) {
      this.setBatched(false);
      return false;
    }
    this.rebuild();
    this.fresh = true;
    this.setBatched(true);
    return true;
  }

  private rebuild(): void {
    const groups = new Map<string, Part[]>();
    this.parts.forEach((p, i) => {
      if (!this.visible[i]) return;
      const g = groups.get(p.key);
      if (g) g.push(p);
      else groups.set(p.key, [p]);
    });
    for (const [key, mesh] of this.meshes) {
      if (groups.has(key)) continue;
      mesh.geometry.dispose();
      mesh.removeFromParent();
      this.meshes.delete(key);
    }
    for (const [key, list] of groups) {
      const geo = new THREE.BufferGeometry();
      for (const [name, { itemSize }] of list[0].attrs) {
        let n = 0;
        for (const p of list) n += p.attrs.get(name)!.array.length;
        const out = new Float32Array(n);
        let at = 0;
        for (const p of list) {
          const a = p.attrs.get(name)!.array;
          out.set(a, at);
          at += a.length;
        }
        geo.setAttribute(name, new THREE.BufferAttribute(out, itemSize));
      }
      geo.boundingSphere = this.sphere.clone();
      let mesh = this.meshes.get(key);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        mesh = new THREE.Mesh(geo, list[0].mesh.material);
        mesh.name = 'batch';
        mesh.renderOrder = list[0].mesh.renderOrder;
        this.meshes.set(key, mesh);
        this.root.add(mesh);
      }
    }
  }

  /** Малювати пакунок (оригінали — на прихованому шарі) або оригінали (пакунок схований). */
  private setBatched(on: boolean): void {
    if (on === this.batched) return;
    this.batched = on;
    for (const p of this.parts) {
      if (on) p.mesh.layers.set(HIDDEN_LAYER);
      else p.mesh.layers.set(0);
    }
    for (const m of this.meshes.values()) m.visible = on;
  }

  dispose(): void {
    this.setBatched(false);
    for (const m of this.meshes.values()) {
      m.geometry.dispose();
      m.removeFromParent();
    }
    this.meshes.clear();
  }
}

function packable(mesh: THREE.Mesh): boolean {
  const mat = mesh.material;
  if (Array.isArray(mat) || mat.transparent) return false;
  if (mesh.onBeforeRender !== THREE.Object3D.prototype.onBeforeRender) return false;
  const g = mesh.geometry;
  return !!g.attributes.position && !g.morphAttributes.position && !(mesh as THREE.SkinnedMesh).isSkinnedMesh;
}

/** Атрибути геометрії без індексу, позиції й нормалі — у систему кореня. */
function flatAttributes(g: THREE.BufferGeometry, m: THREE.Matrix4, n: THREE.Matrix3): Map<string, { array: Float32Array; itemSize: number }> {
  const flat = g.index ? g.toNonIndexed() : g;
  const out = new Map<string, { array: Float32Array; itemSize: number }>();
  const v = new THREE.Vector3();
  for (const [name, attr] of Object.entries(flat.attributes) as [string, THREE.BufferAttribute][]) {
    const size = attr.itemSize;
    const array = new Float32Array(attr.count * size);
    for (let i = 0; i < attr.count; i++) for (let k = 0; k < size; k++) array[i * size + k] = attr.getComponent(i, k);
    if (name === 'position' || name === 'normal') {
      for (let i = 0; i < attr.count; i++) {
        v.fromArray(array, i * 3);
        if (name === 'position') v.applyMatrix4(m);
        else v.applyMatrix3(n).normalize();
        v.toArray(array, i * 3);
      }
    }
    out.set(name, { array, itemSize: size });
  }
  if (flat !== g) flat.dispose();
  return out;
}
