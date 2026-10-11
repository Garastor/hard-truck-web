import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { walk, type B3d } from '../formats/b3d';
import { GROUP_MOVABLE, groups } from '../physics/world';

/**
 * Рухомі предмети трас (`AnmObjNNNN` — ящики, бетонні блоки, розбита машина), розставлені просторами
 * `AnmObjNNNN###Space`. Колізія — коробка блоку `hitAnmObjNNNN` (полігони 23 у системі предмета). Вантажівка їх
 * штовхає; маса оригіналу невідома — гіпотеза: ∝ обʼєму коробки (250 кг/м³, 40…1500 кг).
 */
const DENSITY = 250;
const MIN_MASS = 40;
const MAX_MASS = 1500;

interface Movable {
  node: THREE.Object3D;
  body: RAPIER.RigidBody;
  /** Центр коробки в системі предмета (система гри, до повороту кореня). */
  center: THREE.Vector3;
  home: { p: RAPIER.Vector; q: RAPIER.Rotation };
}

export class Movables {
  private readonly items: Movable[] = [];
  private readonly tmp = new THREE.Matrix4();

  constructor(
    world: RAPIER.World,
    b3d: B3d,
    rooms: THREE.Object3D[],
  ) {
    const boxes = hitBoxes(b3d);
    for (const room of rooms) {
      room.updateMatrixWorld(true);
      room.traverse((node) => {
        const box = /^anmobj\d+$/i.test(node.name) ? (boxes.get(node.name.toLowerCase()) ?? visualBox(node)) : null;
        if (!box || box.isEmpty()) return;
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const p = new THREE.Vector3();
        const q = new THREE.Quaternion();
        const centerWorld = center.clone().applyMatrix4(node.matrixWorld);
        node.matrixWorld.decompose(p, q, new THREE.Vector3());
        const body = world.createRigidBody(
          RAPIER.RigidBodyDesc.dynamic()
            .setTranslation(centerWorld.x, centerWorld.y, centerWorld.z)
            .setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
            .setCanSleep(true)
            .setSleeping(true)
            .setLinearDamping(0.3)
            .setAngularDamping(0.5),
        );
        const mass = Math.max(MIN_MASS, Math.min(MAX_MASS, size.x * size.y * size.z * DENSITY));
        world.createCollider(
          RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
            .setMass(mass)
            .setFriction(0.7)
            .setRestitution(0.1)
            .setCollisionGroups(groups(GROUP_MOVABLE, 0xffff)),
          body,
        );
        node.matrixAutoUpdate = false;
        this.items.push({ node, body, center, home: { p: body.translation(), q: body.rotation() } });
      });
    }
  }

  get count(): number {
    return this.items.length;
  }

  /** Візуальні моделі за тілами (лише ті, що рухаються); що впали крізь світ (кімната без колізій) — додому. */
  update(): void {
    for (const it of this.items) {
      if (it.body.isSleeping()) continue;
      const t = it.body.translation();
      if (t.y < it.home.p.y - 3) {
        it.body.setTranslation(it.home.p, true);
        it.body.setRotation(it.home.q, true);
        it.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
        it.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
        it.body.sleep();
      }
      const r = it.body.rotation();
      // Світ предмета = тіло · зсув(−центр); у систему батька (кімната під поворотом кореня).
      this.tmp
        .compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1))
        .multiply(new THREE.Matrix4().makeTranslation(-it.center.x, -it.center.y, -it.center.z));
      const parent = it.node.parent;
      if (parent) it.node.matrix.copy(parent.matrixWorld).invert().multiply(this.tmp);
      else it.node.matrix.copy(this.tmp);
      it.node.matrixWorldNeedsUpdate = true;
    }
  }
}

/** Коробки `hitAnmObjNNNN` (полігони типу 23) у системі предмета, за імʼям предмета. */
function hitBoxes(b3d: B3d): Map<string, THREE.Box3> {
  const out = new Map<string, THREE.Box3>();
  for (const top of b3d.blocks) {
    const m = /^hit(anmobj\d+)$/i.exec(top.name);
    if (!m) continue;
    const box = new THREE.Box3();
    for (const [blk] of walk([top])) {
      const d = blk.data;
      if (d.t !== 23 || d.shape.kind !== 6) continue;
      for (const poly of d.shape.polys) for (const v of poly) box.expandByPoint(new THREE.Vector3(v[0], v[1], v[2]));
    }
    if (!box.isEmpty()) out.set(m[1].toLowerCase(), box);
  }
  return out;
}

/** Без коробки колізії — межі видимої моделі в її власній системі. */
function visualBox(node: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const inv = node.matrixWorld.clone().invert();
  node.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.computeBoundingBox();
    box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld.clone().premultiply(inv)));
  });
  return box;
}
