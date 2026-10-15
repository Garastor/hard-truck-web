import * as THREE from 'three';
import { DistanceSwitch, SideSwitch } from '../engine/render/sceneBuilder';

/**
 * Злиття нерухомої геометрії за матеріалом: одна сітка на матеріал у клітинці CELL × CELL (система root) замість
 * сотень (виклики малювання — головне обмеження телефона); клітинки лишають відсікання за полем зору.
 * Злиті лише звичайні меші під звичайними групами; не чіпаємо перемикачі (типи 9/10 у моделях, 21 — групи
 * `<імʼя>#<стан>`), спрайти, інстанси дерев і сховане. Геометрія — у системі `root`.
 * Повертає кількість мешів до й після.
 */
export function mergeStatic(root: THREE.Object3D, CELL = 250): { before: number; after: number } {
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const byMat = new Map<string, { mat: THREE.Material; meshes: THREE.Mesh[] }>();
  const c = new THREE.Vector3();
  let before = 0;
  const visit = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    if (o instanceof SideSwitch || o instanceof DistanceSwitch || o instanceof THREE.LOD || o instanceof THREE.Sprite) return;
    if (o !== root && /#\d+$/.test(o.name)) return; // стани перемикача 21
    if (o instanceof THREE.InstancedMesh) return;
    if (o instanceof THREE.Mesh && !Array.isArray(o.material)) {
      before++;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      c.copy(o.geometry.boundingSphere!.center).applyMatrix4(o.matrixWorld).applyMatrix4(toRoot);
      const key = `${o.material.uuid}|${Math.floor(c.x / CELL)},${Math.floor(c.y / CELL)}`;
      const e = byMat.get(key) ?? byMat.set(key, { mat: o.material, meshes: [] }).get(key)!;
      e.meshes.push(o);
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  let after = 0;
  const m = new THREE.Matrix4();
  const nm = new THREE.Matrix3();
  for (const { mat, meshes } of byMat.values()) {
    if (meshes.length < 2) {
      after += meshes.length;
      continue;
    }
    let count = 0;
    const hasNormal = meshes.every((x) => !!x.geometry.getAttribute('normal'));
    for (const x of meshes) count += x.geometry.getAttribute('position').count;
    const pos = new Float32Array(count * 3);
    const uv = new Float32Array(count * 2);
    const nrm = hasNormal ? new Float32Array(count * 3) : null;
    const v = new THREE.Vector3();
    let o = 0;
    for (const x of meshes) {
      m.multiplyMatrices(toRoot, x.matrixWorld);
      nm.getNormalMatrix(m);
      const p = x.geometry.getAttribute('position');
      const t = x.geometry.getAttribute('uv');
      const n = x.geometry.getAttribute('normal');
      for (let i = 0; i < p.count; i++, o++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m);
        pos[o * 3] = v.x;
        pos[o * 3 + 1] = v.y;
        pos[o * 3 + 2] = v.z;
        if (t) {
          uv[o * 2] = t.getX(i);
          uv[o * 2 + 1] = t.getY(i);
        }
        if (nrm && n) {
          v.fromBufferAttribute(n, i).applyMatrix3(nm).normalize();
          nrm[o * 3] = v.x;
          nrm[o * 3 + 1] = v.y;
          nrm[o * 3 + 2] = v.z;
        }
      }
      x.removeFromParent();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    if (nrm) g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = `merged:${mat.name}`;
    mesh.matrixAutoUpdate = false;
    root.add(mesh);
    after++;
  }
  return { before, after };
}
