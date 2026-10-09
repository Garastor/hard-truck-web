import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

let ready: Promise<typeof RAPIER> | null = null;

/** Ініціалізує WASM Rapier (один раз). */
export function initRapier(): Promise<typeof RAPIER> {
  ready ??= RAPIER.init().then(() => RAPIER);
  return ready;
}

/** Перетворення координат гри (Z угору, Y уперед) у Three.js (Y угору, −Z уперед). */
export function g2t(v: readonly number[] | THREE.Vector3): THREE.Vector3 {
  const [x, y, z] = v instanceof THREE.Vector3 ? [v.x, v.y, v.z] : v;
  return new THREE.Vector3(x, z, -y);
}

/**
 * Створює статичні trimesh-колайдери з усіх мешів обʼєкта (у світових координатах Three.js).
 * Поки що колізійна геометрія = візуальна; пізніше — блоки 23/20 з B3D.
 */
export function addStaticMeshes(world: RAPIER.World, root: THREE.Object3D): number {
  root.updateMatrixWorld(true);
  const v = new THREE.Vector3();
  let count = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    const mat = o.material as THREE.MeshBasicMaterial;
    if (mat.transparent) return;
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute;
    const verts = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      verts[i * 3] = v.x;
      verts[i * 3 + 1] = v.y;
      verts[i * 3 + 2] = v.z;
    }
    const idx = new Uint32Array(pos.count);
    for (let i = 0; i < pos.count; i++) idx[i] = i;
    world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(1.0));
    count++;
  });
  return count;
}
