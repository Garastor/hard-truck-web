import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '@engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '@engine/physics/world';
import type { Way } from '@engine/formats/way';
import type { Ht2Trucks } from '../vehicles/trucks';
import { toThree } from '../world/world';

/**
 * Поліція Дальнобойщиків 2 (перша версія): пости в точках засідок `polamb_<регіон>_NN` (вузли WAY, 33 у світі) —
 * патрульна машина `BmwM5police` з TRUCKS.B3D стоїть на узбіччі, радар міряє швидкість вантажівки, що проїжджає
 * ближче RADAR_R. Ліміт — 60 км/год (дорожній знак zspl60 у текстурах; гіпотеза: в оригіналі ліміт залежить від
 * ділянки), штраф — $20 за кожен км/год понад ліміт (гіпотеза). Тексти — з Ms.sch (FINE_SPEEDING).
 * Пости видно лише поблизу (до SHOW_R), щоб не тримати зайвих моделей.
 */
export const SPEED_LIMIT = 60;
const RADAR_R = 45;
const SHOW_R = 600;
/** Після штрафу пост «спить» стільки секунд (не штрафувати двічі за один проїзд). */
const COOLDOWN = 30;

interface Post {
  pos: THREE.Vector3;
  heading: THREE.Vector3;
  root: THREE.Group | null;
  body: RAPIER.RigidBody | null;
  cooldown: number;
}

export class Police {
  private readonly posts: Post[] = [];
  private template: THREE.Object3D | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly trucks: Ht2Trucks,
    ways: Iterable<{ way: Way }>,
  ) {
    for (const { way } of ways)
      for (const room of way.rooms)
        for (const n of room.nodes) {
          if (!/^polamb_/i.test(n.name)) continue;
          // Напрям машини — уздовж найближчого сегмента дороги кімнати (або на північ).
          let dir = new THREE.Vector3(0, 0, -1);
          let best = Infinity;
          for (const s of room.segments)
            for (let i = 0; i + 5 < s.points.length; i += 3) {
              const d = Math.hypot(s.points[i] - n.pos[0], s.points[i + 1] - n.pos[1]);
              if (d < best) {
                best = d;
                dir = toThree(s.points[i + 3] - s.points[i], s.points[i + 4] - s.points[i + 1], 0).normalize();
              }
            }
          this.posts.push({ pos: toThree(...n.pos), heading: dir, root: null, body: null, cooldown: 0 });
        }
  }

  get count(): number {
    return this.posts.length;
  }

  private model(): THREE.Object3D | null {
    if (!this.template) this.template = this.trucks.asm.template('BmwM5police');
    return this.template?.clone() ?? null;
  }

  /** Крок: показати/сховати машини постів; повертає штраф (км/год понад ліміт), якщо радар спрацював. */
  update(dt: number, player: THREE.Vector3, speedKmh: number): { over: number } | null {
    let fine: { over: number } | null = null;
    for (const p of this.posts) {
      p.cooldown = Math.max(0, p.cooldown - dt);
      const d = p.pos.distanceTo(player);
      if (d < SHOW_R && !p.root) this.show(p);
      else if (d > SHOW_R * 1.2 && p.root) this.hide(p);
      if (d < RADAR_R && p.cooldown === 0 && speedKmh > SPEED_LIMIT + 5) {
        p.cooldown = COOLDOWN;
        fine = { over: Math.round(speedKmh - SPEED_LIMIT) };
      }
    }
    return fine;
  }

  private show(p: Post): void {
    const model = this.model();
    if (!model) return;
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model);
    const root = new THREE.Group();
    root.add(frame);
    root.updateMatrixWorld(true);
    const box = visibleBox(model);
    frame.position.y = -box.min.y;
    root.position.copy(p.pos);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), p.heading, new THREE.Vector3(0, 1, 0)));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    p.body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.pos.x, p.pos.y, p.pos.z).setRotation(root.quaternion));
    this.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y - box.min.y, center.z)
        .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
      p.body,
    );
    this.scene.add(root);
    p.root = root;
  }

  private hide(p: Post): void {
    if (p.root) this.scene.remove(p.root);
    if (p.body) this.rapier.removeRigidBody(p.body);
    p.root = null;
    p.body = null;
  }

  dispose(): void {
    for (const p of this.posts) this.hide(p);
  }
}
