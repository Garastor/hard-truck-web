import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

let ready: Promise<typeof RAPIER> | null = null;

/** Ініціалізує WASM Rapier (один раз). */
export function initRapier(): Promise<typeof RAPIER> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Перетворення координат гри (Z угору, Y уперед) у Three.js (Y угору, −Z уперед). */
/**
 * Групи колізій Rapier (u32: старші 16 біт — членство, молодші — з ким стикається). Світ — лише група WORLD,
 * щоб бампери вантажівок (лише проти рухомих предметів) не чіплялися за дорогу на трамплінах.
 */
export const GROUP_WORLD = 0x0001;
export const GROUP_MOVABLE = 0x0002;
export const GROUP_BUMPER = 0x0008;
export const groups = (member: number, filter: number) => ((member << 16) | filter) >>> 0;

export function g2t(v: readonly number[] | THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = v instanceof THREE.Vector3 ? [v.x, v.y, v.z] : v;
  return new THREE.Vector3(x, z, -y);
}

/**
 * Запасна «земля» з видимої геометрії — пологі трикутники (|ny| > minUp), якщо в локації немає `hit_road`.
 * Основні колізії — з даних гри (обʼєкти `hit_*`), див. collision.ts.
 */
export function addStaticMeshes(world: RAPIER.World, root: THREE.Object3D, minUp = 0.35): number {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let count = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    const mat = o.material as THREE.MeshBasicMaterial;
    if (mat.transparent) return;
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute;
    const out: number[] = [];
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i + 2 < pos.count; i += 3) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      a.fromBufferAttribute(pos, i + 1).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i + 2).applyMatrix4(o.matrixWorld);
      n.subVectors(a, v).cross(b.clone().sub(v));
      const len = n.length();
      if (!len || Math.abs(n.y / len) < minUp) continue;
      out.push(v.x, v.y, v.z, a.x, a.y, a.z, b.x, b.y, b.z);
    }
    if (!out.length) return;
    const verts = new Float32Array(out);
    const idx = new Uint32Array(verts.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(1.0).setCollisionGroups(groups(GROUP_WORLD, 0xffff)));
    count++;
  });
  return count;
}

/** Колізійні полігони (система гри) → один trimesh. */
export function addCollisionPolys(world: RAPIER.World, polys: number[][][], friction = 0.4): RAPIER.Collider | null {
  const out: number[] = [];
  for (const poly of polys) {
    const pts = poly.map((p) => g2t(p));
    for (let k = 1; k + 1 < pts.length; k++) {
      for (const q of [pts[0], pts[k], pts[k + 1]]) out.push(q.x, q.y, q.z);
    }
  }
  if (!out.length) return null;
  const verts = new Float32Array(out);
  const idx = new Uint32Array(verts.length / 3);
  for (let i = 0; i < idx.length; i++) idx[i] = i;
  return world.createCollider(
    RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(friction).setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
  );
}
