import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { visibleBox } from '@engine/vehicle/trucks';
import { GROUP_WORLD, groups } from '@engine/physics/world';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Ht2Roads, RoadLine } from '../world/roads';
import type { Ht2Trucks } from '../vehicles/trucks';

/**
 * Трафік Дальнобойщиків 2: машини з `evehicles.sch` класу `dumb` («тупі» легковики, автобус, пікапи) — запис
 * `(vehicle ID "Модель" варіант клас поведінка …)`; модель — вузол TRUCKS.B3D, варіант 0…3 — набір матеріалів
 * (`Fiat_all1` → `Fiat_all3`; кластери TRUCKS.OVL `Fiat1_car_cl`…). Кількість у світі — `dumb 70` з ENV/GAME.CNF;
 * порт тримає їх лише довкола гравця (MAX_CARS у радіусі 150…700 м).
 *
 * Рух — без фізики оригіналу (гіпотеза порту): машина котиться смугою мережі доріг з крейсерською швидкістю,
 * пригальмовує перед машиною чи вантажівкою попереду на своїй смузі. Тіло в Rapier — кінематичне: гравець
 * упирається в нього, але штовхнути не може.
 */
const MAX_CARS = 12;
const SPAWN_MIN = 150;
const SPAWN_MAX = 600;
const DESPAWN = 750;
const GAP = 14;

export interface TrafficKind {
  model: string;
  variant: number;
}

/** Типи трафіку з evehicles.sch (клас car, поведінка dumb), моделі яких є в TRUCKS.B3D. */
export function trafficKinds(sch: SExpr[], trucks: Ht2Trucks): TrafficKind[] {
  const out: TrafficKind[] = [];
  for (const e of sch) {
    if (!isList(e) || e[0] !== 'vehicle') continue;
    const model = str(e[2]);
    const behaviour = e[5];
    const dumb = behaviour === 'dumb' || (isList(behaviour) && behaviour.includes('dumb'));
    if (e[4] !== 'car' || !dumb || !trucks.asm.block(model)) continue;
    out.push({ model, variant: num(e[3]) });
  }
  return out;
}

interface Car {
  kind: TrafficKind;
  root: THREE.Group;
  body: RAPIER.RigidBody;
  line: RoadLine;
  seg: number;
  t: number;
  speed: number;
  cruise: number;
  halfLen: number;
  pos: THREE.Vector3;
}

export class Traffic {
  readonly cars: Car[] = [];
  private readonly templates = new Map<string, THREE.Object3D>();
  private spawnTimer = 0;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly rapier: RAPIER.World,
    private readonly roads: Ht2Roads,
    private readonly trucks: Ht2Trucks,
    private readonly kinds: TrafficKind[],
    /** Чи завантажено регіон (машини — лише там, де є дорога й колізії). */
    private readonly loaded: (region: string) => boolean,
    /** Найбільше машин довкола (повзунок «насиченість трас»). */
    private readonly maxCars = MAX_CARS,
  ) {}

  /** Фари машин, що зʼявляються (king.exe: при створенні — з 22:00 до 6:00; ставить режим їзди). */
  lights = false;

  /**
   * Модель машини потрібного кольору (кешується; повертається копія). З фарами — перемикачі моделі
   * `refer_HeadLightKey` і `refer_SizeLightKey` у стані 1.
   */
  private model(kind: TrafficKind, lights: boolean): THREE.Object3D | null {
    const key = `${kind.model}#${kind.variant}${lights ? '+L' : ''}`;
    let tpl = this.templates.get(key);
    if (!tpl) {
      let base: THREE.Object3D | null;
      if (lights) {
        const dyn = this.trucks.asm.dynamicObject(kind.model);
        dyn?.setSwitch('refer_HeadLightKey', 1);
        dyn?.setSwitch('refer_SizeLightKey', 1);
        base = dyn?.root ?? null;
      } else base = this.trucks.asm.template(kind.model);
      if (!base) return null;
      tpl = lights ? base : base.clone();
      if (kind.variant > 0) recolor(tpl, this.trucks, kind.variant + 1);
      this.templates.set(key, tpl);
    }
    return tpl.clone();
  }

  /** player — гравець; extra — інші точки, яких машини не мають наїхати (напівпричіп гравця). */
  update(dt: number, player: THREE.Vector3, extra: readonly THREE.Vector3[] = []): void {
    for (let i = this.cars.length - 1; i >= 0; i--) {
      const c = this.cars[i];
      if (c.pos.distanceTo(player) > DESPAWN || !this.loaded(c.line.region)) this.remove(i);
    }
    this.spawnTimer -= dt;
    if (this.cars.length < this.maxCars && this.spawnTimer <= 0 && this.kinds.length) {
      this.spawnTimer = 0.5;
      this.spawn(player);
    }
    const avoid = [player, ...extra];
    for (const c of this.cars) this.drive(c, dt, avoid);
  }

  private spawn(player: THREE.Vector3): void {
    const lines = this.roads.lines.filter((l) => this.loaded(l.region));
    if (!lines.length) return;
    for (let attempt = 0; attempt < 8; attempt++) {
      const line = lines[Math.floor(Math.random() * lines.length)];
      const seg = Math.floor(Math.random() * (line.pts.length - 1));
      const p = line.pts[seg];
      const d = p.distanceTo(player);
      if (d < SPAWN_MIN || d > SPAWN_MAX) continue;
      if (this.cars.some((c) => c.pos.distanceTo(p) < GAP * 2)) continue;
      const kind = this.kinds[Math.floor(Math.random() * this.kinds.length)];
      const model = this.model(kind, this.lights);
      if (!model) return;
      // Модель у системі гри → обгортка в системі Three.js (вперед −Z).
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      frame.add(model);
      const root = new THREE.Group();
      root.add(frame);
      root.updateMatrixWorld(true);
      const box = visibleBox(model);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // Модель стоїть на колесах: низ коробки — дорога.
      frame.position.y = -box.min.y;
      const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(p.x, p.y, p.z));
      this.rapier.createCollider(
        RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
          .setTranslation(center.x, center.y - box.min.y, center.z)
          .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
        body,
      );
      this.scene.add(root);
      const cruise = (40 + Math.random() * 30) / 3.6;
      this.cars.push({ kind, root, body, line, seg, t: 0, speed: cruise, cruise, halfLen: size.z / 2, pos: p.clone() });
      return;
    }
  }

  private remove(i: number): void {
    const c = this.cars[i];
    this.scene.remove(c.root);
    this.rapier.removeRigidBody(c.body);
    this.cars.splice(i, 1);
  }

  /** Рух смугою: дистанція до машин попереду (і гравця) — пригальмувати; кінець лінії — наступна лінія. */
  private drive(c: Car, dt: number, avoid: readonly THREE.Vector3[]): void {
    const a = c.line.pts[c.seg];
    const b = c.line.pts[c.seg + 1];
    const dir = b.clone().sub(a);
    const len = dir.length() || 1;
    dir.divideScalar(len);
    let ahead = Infinity;
    let blocked = false;
    for (const o of [...this.cars.map((x) => x.pos), ...avoid]) {
      if (o === c.pos) continue;
      const rel = o.clone().sub(c.pos);
      const along = rel.dot(dir);
      const side = rel.clone().addScaledVector(dir, -along).length();
      if (along > 0 && side < 3 && along < ahead) ahead = along;
      // Гравець (тягач чи причіп) упритул спереду — стоп одразу: кінематична машина інакше штовхає його з
      // «нескінченною» масою (на перехресті вантажівка з причепом виїжджає збоку, гальмувати пізно).
      if (avoid.includes(o) && along > 0 && along < c.halfLen + 5 && side < 2.5) blocked = true;
    }
    const want = ahead < GAP ? 0 : ahead < GAP * 3 ? c.cruise * ((ahead - GAP) / (GAP * 2)) : c.cruise;
    c.speed += THREE.MathUtils.clamp(want - c.speed, -8 * dt, 3 * dt);
    if (blocked) c.speed = 0;
    let move = c.speed * dt;
    while (move > 0) {
      const p0 = c.line.pts[c.seg];
      const p1 = c.line.pts[c.seg + 1];
      const segLen = p0.distanceTo(p1) || 0.001;
      const left = (1 - c.t) * segLen;
      if (move < left) {
        c.t += move / segLen;
        move = 0;
      } else {
        move -= left;
        c.t = 0;
        c.seg++;
        if (c.seg + 1 >= c.line.pts.length) {
          const next = c.line.next;
          if (!next.length) {
            // Тупик — машина зникає (зʼявиться інша).
            c.pos.set(1e9, 0, 0);
            return;
          }
          c.line = next[Math.floor(Math.random() * next.length)] as RoadLine;
          c.seg = 0;
        }
      }
    }
    const p0 = c.line.pts[c.seg];
    const p1 = c.line.pts[c.seg + 1];
    c.pos.copy(p0).lerp(p1, c.t);
    const fwd = p1.clone().sub(p0).normalize();
    // lookAt ставить +Z від цілі до ока: ціль — уперед, тож −Z (перед моделі) дивиться за рухом (з −fwd машини
    // їхали задом наперед — помітив користувач).
    const q = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), fwd, new THREE.Vector3(0, 1, 0)));
    // Плавний поворот на зламах ламаної.
    c.root.quaternion.slerp(q, Math.min(1, dt * 6));
    c.root.position.copy(c.pos);
    c.body.setNextKinematicTranslation(c.pos);
    c.body.setNextKinematicRotation(c.root.quaternion);
  }

  dispose(): void {
    for (let i = this.cars.length - 1; i >= 0; i--) this.remove(i);
  }
}

/** Варіант кольору: матеріали `<…>1` моделі → `<…>N` (Fiat_all1 → Fiat_all3), якщо такий є в TRUCKS.B3D. */
export function recolor(root: THREE.Object3D, trucks: Ht2Trucks, n: number): void {
  const names = trucks.asm.b3d.materials.map((m) => m.toLowerCase());
  const swap = new Map<THREE.Material, THREE.Material>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const one = (m: THREE.Material): THREE.Material => {
      const hit = swap.get(m);
      if (hit) return hit;
      const nm = /^(.*?)1$/.exec(m.name);
      const idx = nm ? names.indexOf(`${nm[1]}${n}`) : -1;
      const out = idx >= 0 ? trucks.asm.lib.material(idx) : m;
      swap.set(m, out);
      return out;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
}
