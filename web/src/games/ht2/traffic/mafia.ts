import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '@engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '@engine/physics/world';
import type { Way } from '@engine/formats/way';
import type { Ht2Trucks } from '../vehicles/trucks';
import { toThree } from '../world/world';

/**
 * Мафія Дальнобойщиків 2 (перша версія). З даних: засідки — вузли WAY `mafamb_*` (33 у світі), машина мафії —
 * `Cayman` (evehicles.sch: `(vehicle CAYMAN "Cayman" 0 car mafia …)`), тексти — Ms.sch (ATTACKED_BY_MAFIA, FORFEIT).
 *
 * Ціль — вантажівка з вантажем класу `formafia` (merchandise.sch: горілка, алмази, Pentium III…).
 * Поведінка — гіпотези порту: машина стоїть у засідці; таку вантажівку, що проїхала ближче TRIGGER_R,
 * переслідує її ж слідом (точки шляху гравця — тож іде дорогою, якою їхав гравець) зі швидкістю до CHASE_KMH,
 * тримаючись не ближче KEEP_GAP (кінематичне тіло інакше штовхало б вантажівку з «нескінченною» масою). Протрималась
 * поруч (до CATCH_R) CATCH_TIME с — пограбування; гравець відірвався далі ESCAPE_R чи погоня триває довше
 * CHASE_TIME — мафія відстає й повертається в засідку (поза полем зору), засідка «спить» COOLDOWN с.
 */
const TRIGGER_R = 60;
const SHOW_R = 600;
const CHASE_KMH = 95;
const ACCEL = 4;
const KEEP_GAP = 7;
const CATCH_R = 14;
const CATCH_TIME = 2;
const ESCAPE_R = 250;
const CHASE_TIME = 60;
const COOLDOWN = 180;
/** Крок запису сліду гравця, м. */
const TRAIL_STEP = 4;

interface Post {
  home: THREE.Vector3;
  heading: THREE.Vector3;
  root: THREE.Group | null;
  body: RAPIER.RigidBody | null;
  cooldown: number;
}

export interface Chase {
  post: Post;
  trail: THREE.Vector3[];
  /** Положення на сліді: індекс відрізка й частка. */
  seg: number;
  t: number;
  speed: number;
  time: number;
  close: number;
  pos: THREE.Vector3;
}

export class Mafia {
  private readonly posts: Post[] = [];
  private template: THREE.Object3D | null = null;
  chase: Chase | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly trucks: Ht2Trucks,
    ways: Iterable<{ way: Way }>,
    private readonly ground: (p: THREE.Vector3) => number,
  ) {
    for (const { way } of ways)
      for (const room of way.rooms)
        for (const n of room.nodes) {
          if (!/^mafamb/i.test(n.name)) continue;
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
          this.posts.push({ home: toThree(...n.pos), heading: dir, root: null, body: null, cooldown: 0 });
        }
  }

  get count(): number {
    return this.posts.length;
  }

  /** Позиція машини мафії, що женеться (для мінікарти й автопілота). */
  get chaser(): THREE.Vector3 | null {
    return this.chase?.pos ?? null;
  }

  /**
   * Крок: засідки (показати/сховати), погоня. `loaded` — у гравця вантаж. Повертає 'robbed', коли наздогнали,
   * 'escaped' — коли відірвався.
   */
  update(dt: number, player: THREE.Vector3, loaded: boolean): 'robbed' | 'escaped' | null {
    for (const p of this.posts) {
      p.cooldown = Math.max(0, p.cooldown - dt);
      const d = p.home.distanceTo(player);
      if (this.chase?.post === p) continue;
      // Після погоні засідка зʼявляється знову, коли «спить» уже не вона чи гравець далеко (не на очах).
      if (d < SHOW_R && !p.root && (p.cooldown === 0 || d > 300)) this.show(p);
      else if (d > SHOW_R * 1.2 && p.root) this.hide(p);
      if (!this.chase && loaded && p.root && p.cooldown === 0 && d < TRIGGER_R) this.start(p, player);
    }
    return this.chase ? this.follow(dt, player) : null;
  }

  private start(p: Post, player: THREE.Vector3): void {
    if (!p.body) return;
    // Переводимо тіло в кінематичне: рух задаємо самі.
    p.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased, true);
    const at = p.root!.position.clone();
    this.chase = { post: p, trail: [at, this.onGround(player)], seg: 0, t: 0, speed: 0, time: 0, close: 0, pos: at.clone() };
  }

  private onGround(p: THREE.Vector3): THREE.Vector3 {
    return new THREE.Vector3(p.x, this.ground(p), p.z);
  }

  private follow(dt: number, player: THREE.Vector3): 'robbed' | 'escaped' | null {
    const c = this.chase!;
    c.time += dt;
    const last = c.trail[c.trail.length - 1];
    if (last.distanceTo(player) > TRAIL_STEP) c.trail.push(this.onGround(player));
    // Швидкість: розгін до CHASE_KMH; ближче KEEP_GAP до гравця — стоп.
    const gap = c.pos.distanceTo(player);
    const want = gap < KEEP_GAP ? 0 : CHASE_KMH / 3.6;
    c.speed += THREE.MathUtils.clamp(want - c.speed, -ACCEL * 3 * dt, ACCEL * dt);
    let move = c.speed * dt;
    const dir = new THREE.Vector3();
    while (move > 0 && c.seg + 1 < c.trail.length) {
      const a = c.trail[c.seg];
      const b = c.trail[c.seg + 1];
      const len = a.distanceTo(b) || 0.001;
      const left = (1 - c.t) * len;
      dir.copy(b).sub(a);
      if (move < left) {
        c.t += move / len;
        move = 0;
      } else {
        move -= left;
        c.seg++;
        c.t = 0;
      }
    }
    const a = c.trail[c.seg];
    const b = c.trail[Math.min(c.seg + 1, c.trail.length - 1)];
    c.pos.copy(a).lerp(b, c.t);
    const root = c.post.root!;
    root.position.copy(c.pos);
    if (dir.lengthSq() > 1e-4) root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir.setY(0).normalize(), new THREE.Vector3(0, 1, 0)));
    c.post.body!.setNextKinematicTranslation(c.pos);
    c.post.body!.setNextKinematicRotation(root.quaternion);
    c.close = gap < CATCH_R ? c.close + dt : 0;
    if (c.close > CATCH_TIME) {
      this.end(false);
      return 'robbed';
    }
    if (gap > ESCAPE_R || c.time > CHASE_TIME) {
      this.end(true);
      return 'escaped';
    }
    return null;
  }

  /** Кінець погоні: машина зникає (зʼявиться в засідці, коли гравець від'їде й повернеться). */
  private end(escaped: boolean): void {
    const p = this.chase!.post;
    p.cooldown = escaped ? COOLDOWN : COOLDOWN * 2;
    this.hide(p);
    this.chase = null;
  }

  private model(): THREE.Object3D | null {
    if (!this.template) this.template = this.trucks.asm.template('Cayman');
    return this.template?.clone() ?? null;
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
    root.position.copy(p.home);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), p.heading, new THREE.Vector3(0, 1, 0)));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    p.body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(p.home.x, p.home.y, p.home.z).setRotation(root.quaternion));
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
    this.chase = null;
  }
}
