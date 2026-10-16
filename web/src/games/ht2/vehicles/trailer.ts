import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildTruckModel, visibleBox, type TruckDef } from '../engine/vehicle/trucks';
import { TIRE } from '../engine/vehicle/truckVehicle';
import { g2t } from '../engine/physics/world';
import type { TechRecord } from '../formats/tech';
import type { SceneAssembler } from '../engine/render/sceneBuilder';

/**
 * Напівпричіп Дальнобойщиків 2: модель `STrailer*` з TRUCKS.B3D (колеса — групи `…wheelN`), маса, центр мас і
 * точки зчеплення — з vehicle.tech (система моделі гри: x, уперед, угору):
 * - сідло тягача — `lowSaddle` його запису (ЗіЛ (0; −2,05; −0,06) — над задньою віссю);
 * - шкворінь причепа — `topSaddle` запису причепа (STrailerM (0; 4,94; −0,1) — біля переднього краю, над колесами).
 * Інші поля (`coupler`, `towHook`, `lowSaddle` причепа) однакові в усіх записах — гіпотеза: для причепів-дишл
 * і зчіпок, яких у грі немає.
 *
 * Окреме тіло Rapier з колесами-променями без приводу й керма; з тягачем — сферичний шарнір, контакти між ними
 * вимкнено. Гальма — разом з тягачем (сила — частка `breakpower` тягача, гіпотеза).
 */
const SUSP_REST = 0.43;
const SUSP_ANCHOR = 0.175;
const ROLLING = 0.015;
/**
 * Тертя сідла (гіпотеза порту, аркадна стійкість): обертання причепа відносно тягача гаситься за ≈ 1/HITCH_DAMP с,
 * а за HITCH_LIMIT від осі тягача — пружний упор. Без цього тягач у заносі (повне кермо на 25 км/год) різко
 * втрачає швидкість, і причіп, штовхаючи, складає зчіпку.
 */
const HITCH_DAMP = 6;
const HITCH_LIMIT = (70 * Math.PI) / 180;
/** Відновлення за межею: кутова швидкість назад, рад/с на радіан перевищення. */
const HITCH_RETURN = 3;
/** Повернення до спільного крену, 1/с. */
const ROLL_RETURN = 5;

export class Trailer {
  readonly body: RAPIER.RigidBody;
  readonly visual = new THREE.Group();
  readonly mass: number;
  /** Вага на шворні в спокої, Н (за положенням центру мас між шворнем і віссю коліс). */
  readonly kingpinLoad: number;
  private readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  private readonly joint: RAPIER.ImpulseJoint;
  private readonly wheels: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly kingpin: THREE.Vector3;
  private readonly saddle: THREE.Vector3;

  constructor(
    private readonly world: RAPIER.World,
    asm: SceneAssembler,
    readonly def: TruckDef,
    readonly rec: TechRecord,
    private readonly tractor: { body: RAPIER.RigidBody; saddle: readonly number[] },
    cargoMass = 0,
  ) {
    const model = buildTruckModel(asm, def, false);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model.root);
    this.visual.add(frame);
    this.wheels = model.wheels.map((obj, i) => ({ obj, base: model.wheelBase[i] }));
    for (const w of this.wheels) w.obj.matrixAutoUpdate = false;
    frame.updateMatrixWorld(true);
    const box = visibleBox(model.body);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    this.kingpin = g2t(rec.topSaddle);
    this.saddle = g2t(tractor.saddle);
    const { position, rotation } = this.poseBehind();
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setRotation(rotation).setAngularDamping(0.5).setCanSleep(false),
    );
    const mass = rec.mass + rec.bodyMass + cargoMass;
    this.mass = mass;
    // Центр мас порожнього — CenterMassInB3D (STrailerM (0; −3,22; −0,5) — над середньою віссю: порожній причіп
    // стоїть на своїх колесах); вантаж — над дном кузова (center_of_cargo_bottom, у STrailerM — середина) на
    // половині висоти кузова, тож завантажений тисне на сідло.
    const empty = rec.mass + rec.bodyMass;
    const cargoAt = g2t(rec.cargoBottom).add(new THREE.Vector3(0, rec.bodyHeight / 2, 0));
    const com = g2t(rec.centerMass).multiplyScalar(empty).addScaledVector(cargoAt, cargoMass).divideScalar(mass).sub(center);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, (size.y / 2) * 0.8, size.z / 2)
        .setTranslation(center.x, center.y, center.z)
        .setMassProperties(mass, { x: com.x, y: com.y, z: com.z }, {
          x: (mass * (size.y ** 2 + size.z ** 2)) / 12,
          y: (mass * (size.x ** 2 + size.z ** 2)) / 12,
          z: (mass * (size.x ** 2 + size.y ** 2)) / 12,
        }, { w: 1, x: 0, y: 0, z: 0 })
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );
    // Центр візка коліс і центр мас уздовж причепа (z Three, + назад): частка ваги на шворні — важіль.
    const axleZ = model.wheelBase.reduce((s, m) => s + g2t(new THREE.Vector3().setFromMatrixPosition(m)).z, 0) / model.wheelBase.length;
    this.axle.set(0, this.kingpin.y, axleZ);
    const comZ = com.z + center.z;
    this.kingpinLoad = mass * 9.81 * THREE.MathUtils.clamp((axleZ - comZ) / (axleZ - this.kingpin.z), 0, 1);
    this.ctrl = world.createVehicleController(this.body);
    model.wheelBase.forEach((m, i) => {
      const c = g2t(new THREE.Vector3().setFromMatrixPosition(m));
      this.ctrl.addWheel({ x: c.x, y: c.y + SUSP_ANCHOR, z: c.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, SUSP_REST, rec.wheelRadius);
      this.ctrl.setWheelSuspensionStiffness(i, 15);
      this.ctrl.setWheelSuspensionCompression(i, 3.2);
      this.ctrl.setWheelSuspensionRelaxation(i, 1.7);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.38);
      this.ctrl.setWheelMaxSuspensionForce(i, mass * 40);
      this.ctrl.setWheelFrictionSlip(i, 1.4);
      // Бічні сили — як у тягача (lateral), без вбудованого тертя Rapier: воно слабшає під гальмами.
      this.ctrl.setWheelSideFrictionStiffness(i, 0);
    });
    const joint = RAPIER.JointData.spherical(
      { x: this.saddle.x, y: this.saddle.y, z: this.saddle.z },
      { x: this.kingpin.x, y: this.kingpin.y, z: this.kingpin.z },
    );
    this.joint = world.createImpulseJoint(joint, tractor.body, this.body, true);
    this.joint.setContactsEnabled(false);
    this.syncVisual();
  }

  /** Поза причепа на одній лінії з тягачем: шкворінь — у сідлі. */
  private poseBehind(): { position: THREE.Vector3; rotation: THREE.Quaternion } {
    const r = this.tractor.body.rotation();
    const t = this.tractor.body.translation();
    const rotation = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const position = this.saddle.clone().sub(this.kingpin).applyQuaternion(rotation).add(new THREE.Vector3(t.x, t.y, t.z));
    return { position, rotation };
  }

  /** Після перестановки тягача (відновлення на дорозі) — причіп за ним. */
  reset(): void {
    const { position, rotation } = this.poseBehind();
    this.body.setTranslation(position, true);
    this.body.setRotation(rotation, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.savePrev();
  }

  /** Стан тіла до останнього кроку фізики — модель між кроками інтерполюється (syncVisual(alpha)). */
  private readonly prevPos = new THREE.Vector3();
  private readonly prevQuat = new THREE.Quaternion();
  private hasPrev = false;

  /** Запамʼятати стан перед кроком фізики. */
  private savePrev(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.prevPos.set(t.x, t.y, t.z);
    this.prevQuat.set(r.x, r.y, r.z, r.w);
    this.hasPrev = true;
  }

  /**
   * Модель — між станом до й після останнього кроку (alpha = залишок накопичувача / крок): фізика йде кроками 1/60 с,
   * і при 120 Гц чи нерівних кадрах без цього машина відносно плавної камери смикалась. Стрибок понад 5 м
   * (телепорт, відновлення) — без згладжування.
   */
  private placeVisual(alpha: number): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.position.set(t.x, t.y, t.z);
    this.visual.quaternion.set(r.x, r.y, r.z, r.w);
    if (alpha < 1 && this.hasPrev && this.prevPos.distanceTo(this.visual.position) < 5) {
      this.visual.position.lerpVectors(this.prevPos, this.visual.position, alpha);
      this.visual.quaternion.slerpQuaternions(this.prevQuat, this.visual.quaternion.clone(), alpha);
    }
  }

  /**
   * Рух king.exe: причіп іде кінематично за шворнем — вісь коліс не ковзає вбік (кутова швидкість — бічна швидкість
   * шворня / відстань до осі), уздовж — як тягне сідло. Гальма й кочення причепа рахує тягач (TruckVehicle.tow).
   * Підвіска й удари — Rapier. Викликати після кроку тягача (потрібна його нова швидкість).
   */
  private follow(dt: number): void {
    for (let i = 0; i < this.wheels.length; i++) {
      this.ctrl.setWheelBrake(i, 0);
      this.ctrl.setWheelFrictionSlip(i, 0);
    }
    this.ctrl.updateVehicle(dt, undefined, undefined, (c) => c.parent()?.handle !== this.tractor.body.handle);
    const n = new THREE.Vector3();
    for (let i = 0; i < this.wheels.length; i++) {
      const nr = this.ctrl.wheelIsInContact(i) ? this.ctrl.wheelContactNormal(i) : null;
      if (nr) n.add(nr as THREE.Vector3Like);
    }
    // У повітрі — лише Rapier (шарнір тримає зчіпку).
    if (n.lengthSq() < 1e-6) return;
    n.normalize();
    const tq = this.tractor.body.rotation();
    const tt = this.tractor.body.translation();
    const kp = this.saddle.clone().applyQuaternion(new THREE.Quaternion(tq.x, tq.y, tq.z, tq.w)).add(new THREE.Vector3(tt.x, tt.y, tt.z));
    const vk = this.tractor.body.velocityAtPoint(kp);
    const vK = new THREE.Vector3(vk.x, vk.y, vk.z);
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const t = this.body.translation();
    const axle = this.axle.clone().applyQuaternion(q).add(new THREE.Vector3(t.x, t.y, t.z));
    // Від шворня до осі в площині ґрунту; бічний напрям — n × arm.
    const arm = axle.clone().sub(kp);
    arm.addScaledVector(n, -arm.dot(n));
    const len = arm.length();
    if (len < 0.5) return;
    const lat = new THREE.Vector3().crossVectors(n, arm).divideScalar(len);
    const omega = -vK.dot(lat) / len;
    const com = this.body.worldCom();
    const toCom = new THREE.Vector3(com.x, com.y, com.z).sub(kp);
    const lv = this.body.linvel();
    const vn = lv.x * n.x + lv.y * n.y + lv.z * n.z;
    const v = vK.clone().add(new THREE.Vector3().crossVectors(n, toCom).multiplyScalar(omega));
    v.addScaledVector(n, -v.dot(n));
    // Rapier за крок додасть вагу — дотичну частину віднімаємо наперед; уздовж нормалі — підвіска.
    const g = this.world.gravity;
    const gv = new THREE.Vector3(g.x, g.y, g.z);
    v.addScaledVector(gv.addScaledVector(n, -gv.dot(n)), -dt).addScaledVector(n, vn);
    this.body.setLinvel(v, true);
    const av = this.body.angvel();
    const w = new THREE.Vector3(av.x, av.y, av.z);
    w.addScaledVector(n, omega - w.dot(n));
    this.body.setAngvel(w, true);
  }

  get wheelCount(): number {
    return this.wheels.length;
  }

  /** Центр осей коліс у системі тіла (Three.js). */
  private axle = new THREE.Vector3();

  /** Крок фізики (до world.step): гальма й опір кочення; kinematic — рух king.exe (follow). */
  update(dt: number, brake: number, brakePower: number, kinematic = false): void {
    this.savePrev();
    if (kinematic) return this.follow(dt);
    const n = this.wheels.length;
    const force = (brake * brakePower) / n + (ROLLING * this.mass * 9.81) / n;
    for (let i = 0; i < n; i++) this.ctrl.setWheelBrake(i, force * dt);
    // Промені коліс причепа — повз тягач (і навпаки, див. drive.hitch).
    this.ctrl.updateVehicle(dt, undefined, undefined, (c) => c.parent()?.handle !== this.tractor.body.handle);
    this.lateral(dt);
    this.hitchDamper(dt);
  }

  /** Тертя й упор сідла: парні моменти на причіп і тягач навколо вертикалі причепа. */
  private hitchDamper(dt: number): void {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const a = this.body.angvel();
    const b = this.tractor.body.angvel();
    const rel = (a.x - b.x) * up.x + (a.y - b.y) * up.y + (a.z - b.z) * up.z;
    // Зведений момент інерції пари навколо вертикалі: імпульс змінює відносну кутову швидкість на impulse / I.
    const inertia = 1 / (invInertia(this.body, up) + invInertia(this.tractor.body, up));
    let impulse = -HITCH_DAMP * inertia * rel * dt;
    const angle = this.articulation;
    const over = Math.abs(angle) - HITCH_LIMIT;
    if (over > 0) {
      // Упор: складання далі гаситься повністю, і зчіпка повертається до межі.
      const want = -Math.sign(angle) * HITCH_RETURN * over;
      impulse = (rel - want) * Math.sign(angle) > 0 ? -inertia * (rel - want) : 0;
    }
    const t = up.clone().multiplyScalar(impulse);

    // Крен: сідло (пʼяте колесо) дає причепу повертатися лише навколо шворня (вертикаль причепа) і хитатися
    // навколо поперечної осі тягача; третя вісь заблокована — тягач і причіп кренуться разом, важкий причіп
    // тримає легкий тягач. Відносна кутова швидкість уздовж неї гаситься, похибка (y причепа · x тягача) — теж.
    const tr = this.tractor.body.rotation();
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(tr.x, tr.y, tr.z, tr.w));
    const axis = new THREE.Vector3().crossVectors(right, up);
    if (axis.lengthSq() > 1e-4) {
      axis.normalize();
      const relRoll = (a.x - b.x) * axis.x + (a.y - b.y) * axis.y + (a.z - b.z) * axis.z;
      const err = up.dot(right);
      const k = new THREE.Vector3().crossVectors(axis, up).dot(right);
      const want = Math.abs(k) > 0.1 ? (-ROLL_RETURN * err) / k : 0;
      const rollInertia = 1 / (invInertia(this.body, axis) + invInertia(this.tractor.body, axis));
      t.addScaledVector(axis, -rollInertia * (relRoll - want));
    }
    this.body.applyTorqueImpulse({ x: t.x, y: t.y, z: t.z }, true);
    this.tractor.body.applyTorqueImpulse({ x: -t.x, y: -t.y, z: -t.z }, true);
  }

  /** Кут складання, рад: причіп відносно тягача навколо вертикалі (+ — проти годинникової зверху). */
  get articulation(): number {
    const tr = this.tractor.body.rotation();
    const r = this.body.rotation();
    const f1 = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(tr.x, tr.y, tr.z, tr.w));
    const f2 = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    return Math.atan2(f1.z * f2.x - f1.x * f2.z, f1.x * f2.x + f1.z * f2.z);
  }

  /**
   * Бічні сили шин причепа: межа — TIRE.mu × навантаження на куті проковзування TIRE.slip_peak (як у тягача, без
   * заносу); за крок — не більше, ніж гасить бічну швидкість маси, що спирається на колесо.
   */
  private lateral(dt: number): void {
    const r = this.body.rotation();
    const q = new THREE.Quaternion(r.x, r.y, r.z, r.w);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
    const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
    for (let i = 0; i < this.wheels.length; i++) {
      if (!this.ctrl.wheelIsInContact(i)) continue;
      const load = this.ctrl.wheelSuspensionForce(i) ?? 0;
      const p = this.ctrl.wheelContactPoint(i);
      if (load <= 0 || !p) continue;
      const vp = this.body.velocityAtPoint(p);
      const vLong = vp.x * fwd.x + vp.y * fwd.y + vp.z * fwd.z;
      const vLat = vp.x * right.x + vp.y * right.y + vp.z * right.z;
      const alpha = Math.atan2(Math.abs(vLat), Math.max(Math.abs(vLong), TIRE.low_speed));
      let force = Math.min(1, alpha / TIRE.slip_peak) * TIRE.mu * load;
      force = Math.min(force, (load / 9.81) * Math.abs(vLat) / dt);
      // Точка прикладання — піднята до центру мас на TIRE.roll_lift, як у тягача (інакше завантажений причіп з
      // високим центром мас перекидав зчіпку в звичайних поворотах на 35 км/год).
      const com = this.body.worldCom();
      const h = (com.x - p.x) * up.x + (com.y - p.y) * up.y + (com.z - p.z) * up.z;
      const at = { x: p.x + up.x * h * TIRE.roll_lift, y: p.y + up.y * h * TIRE.roll_lift, z: p.z + up.z * h * TIRE.roll_lift };
      this.body.applyImpulseAtPoint(right.clone().multiplyScalar(-Math.sign(vLat) * force * dt), at, true);
    }
  }

  syncVisual(alpha = 1): void {
    this.placeVisual(alpha);
    for (let i = 0; i < this.wheels.length; i++) {
      const w = this.wheels[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? SUSP_REST;
      const spin = this.ctrl.wheelRotation(i) ?? 0;
      w.obj.matrix
        .copy(w.base)
        .multiply(new THREE.Matrix4().makeTranslation(0, 0, SUSP_ANCHOR - len))
        .multiply(new THREE.Matrix4().makeRotationX(-spin));
    }
  }

  /** Точки вздовж причепа у світі (перед, середина, зад) — для трафіку. */
  points(): THREE.Vector3[] {
    this.visual.updateMatrix();
    return [-4, 0, 5].map((z) => new THREE.Vector3(0, 0, z).applyMatrix4(this.visual.matrix));
  }

  /** Відстань між шкворнем і сідлом (розрив зчеплення, для перевірки). */
  get gap(): number {
    const a = this.saddle.clone().applyMatrix4(matrixOf(this.tractor.body));
    const b = this.kingpin.clone().applyMatrix4(matrixOf(this.body));
    return a.distanceTo(b);
  }

  dispose(): void {
    this.world.removeImpulseJoint(this.joint, true);
    this.world.removeVehicleController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}

/**
 * Обернений момент інерції тіла навколо світової осі (aᵀ·I⁻¹·a). Не principalInertia(): Rapier сортує головні осі
 * (у тягача «z» виявилась віссю тангажа), і імпульс з неправильним моментом розгойдував крен до перекидання.
 */
function invInertia(b: RAPIER.RigidBody, a: THREE.Vector3): number {
  const m = b.effectiveWorldInvInertia();
  return (
    a.x * (m.m11 * a.x + m.m12 * a.y + m.m13 * a.z) +
    a.y * (m.m12 * a.x + m.m22 * a.y + m.m23 * a.z) +
    a.z * (m.m13 * a.x + m.m23 * a.y + m.m33 * a.z)
  );
}

function matrixOf(b: RAPIER.RigidBody): THREE.Matrix4 {
  const t = b.translation();
  const r = b.rotation();
  return new THREE.Matrix4().compose(new THREE.Vector3(t.x, t.y, t.z), new THREE.Quaternion(r.x, r.y, r.z, r.w), new THREE.Vector3(1, 1, 1));
}
