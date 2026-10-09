import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { g2t } from '../physics/world';
import type { ControlState } from '../input/input';
import type { TruckDef, TruckModel } from './trucks';

/**
 * Вантажівка на DynamicRayCastVehicleController (Rapier).
 * Параметри — з [TECHn] у TRUCK.TCH. Формули двигуна/КПП — ТИМЧАСОВЕ наближення,
 * буде замінене на відтворені з HTruck.exe (_Car_V::run2, доріжка R4).
 */
export class TruckVehicle {
  readonly body: RAPIER.RigidBody;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  /** Візуальна модель у світі Three.js. */
  readonly visual = new THREE.Group();
  gear = 1;
  rpm = 800;
  speedKmh = 0;

  private readonly wheelRadius: number;
  private readonly driven: boolean[];
  private readonly wheelVisual: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly suspRest = 0.35;
  private steerAngle = 0;
  private shiftTimer = 0;

  constructor(
    private readonly world: RAPIER.World,
    readonly def: TruckDef,
    model: TruckModel,
    spawn: { position: THREE.Vector3; forward: THREE.Vector3 },
  ) {
    const tech = def.tech;
    this.wheelRadius = tech.wheelRadius;
    this.driven = [0, 1, 2, 3].map((i) => (tech.drivingWheels[i] ?? 1) !== 0);

    // Модель у системі гри → обгортка, що повертає її у систему Three.js.
    const gameFrame = new THREE.Group();
    gameFrame.rotation.x = -Math.PI / 2;
    gameFrame.add(model.root);
    this.visual.add(gameFrame);
    this.wheelVisual = model.wheels.map((obj, i) => ({ obj, base: model.wheelBase[i] }));

    // Габарити кузова в локальних координатах Three.js.
    gameFrame.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.body);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    const forward = spawn.forward.clone().setY(0).normalize();
    const rot = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)),
        new THREE.Vector3(0, 1, 0),
        forward.clone().negate(),
      ),
    );
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spawn.position.x, spawn.position.y, spawn.position.z)
        .setRotation(rot)
        .setLinearDamping(0.05)
        .setAngularDamping(0.5)
        .setCanSleep(false), // контролер транспорту не будить тіло — сон «заморожує» вантажівку
    );
    const mass = tech.mass + tech.bodyMass;
    // Центр мас трохи нижче геометричного центру — стійкість, як у важкого тягача.
    const com = g2t(tech.centerMass);
    world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2 * 0.8, size.z / 2)
        .setTranslation(center.x, center.y + size.y * 0.05, center.z)
        .setMassProperties(mass, { x: com.x, y: Math.min(com.y, center.y - size.y * 0.2), z: com.z }, {
          x: mass * (size.y ** 2 + size.z ** 2) / 12,
          y: mass * (size.x ** 2 + size.z ** 2) / 12,
          z: mass * (size.x ** 2 + size.y ** 2) / 12,
        }, { w: 1, x: 0, y: 0, z: 0 })
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );

    this.ctrl = world.createVehicleController(this.body);
    for (let i = 0; i < 4; i++) {
      const p = new THREE.Vector3().setFromMatrixPosition(model.wheelBase[i]);
      const c = g2t(p);
      this.ctrl.addWheel({ x: c.x, y: c.y + this.suspRest * 0.5, z: c.z }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, this.suspRest, this.wheelRadius);
      this.ctrl.setWheelSuspensionStiffness(i, 28);
      this.ctrl.setWheelSuspensionCompression(i, 4.4);
      this.ctrl.setWheelSuspensionRelaxation(i, 2.3);
      this.ctrl.setWheelMaxSuspensionTravel(i, 0.3);
      this.ctrl.setWheelMaxSuspensionForce(i, mass * 40);
      this.ctrl.setWheelFrictionSlip(i, 2.2);
      this.ctrl.setWheelSideFrictionStiffness(i, 1.0);
    }
  }

  /** Крок фізики керування (до world.step). */
  update(dt: number, input: ControlState): void {
    const tech = this.def.tech;
    // Швидкість уздовж напрямку «уперед» (−Z локально), м/с; + уперед.
    const lv = this.body.linvel();
    const q = this.body.rotation();
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
    const v = lv.x * fwd.x + lv.y * fwd.y + lv.z * fwd.z;
    this.speedKmh = Math.abs(v) * 3.6;

    // Кермо: менший кут на швидкості.
    const maxSteer = 0.55 / (1 + Math.abs(v) / 15);
    const targetSteer = -input.steer * maxSteer;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 8);
    this.ctrl.setWheelSteering(0, this.steerAngle);
    this.ctrl.setWheelSteering(1, this.steerAngle);

    // Задній хід: стоїмо й тиснемо гальмо → вмикаємо R; газ на R — гальмування.
    let throttle = input.throttle;
    let brake = input.brake;
    if (this.gear > 0 && brake > 0 && throttle === 0 && v < 0.5) this.gear = -1;
    if (this.gear < 0) {
      if (throttle > 0 && v > -0.5) this.gear = 1;
      else {
        [throttle, brake] = [brake, throttle];
      }
    }

    // Обороти двигуна від швидкості коліс.
    const ratio = this.gearRatio() * tech.rearAxleCoeff;
    const wheelRpm = (Math.abs(v) / this.wheelRadius) * (60 / (2 * Math.PI));
    this.rpm = Math.max(700, wheelRpm * Math.abs(ratio));

    // Автоматична КПП.
    this.shiftTimer -= dt;
    if (this.gear > 0 && this.shiftTimer <= 0) {
      if (this.rpm > 2300 && this.gear < tech.gears.length) {
        this.gear++;
        this.shiftTimer = 0.6;
      } else if (this.rpm < 1100 && this.gear > 1) {
        this.gear--;
        this.shiftTimer = 0.6;
      }
    }

    // Крива моменту: пік біля 1400 об/хв, відсічка 2600.
    const x = (this.rpm - 1400) / 1400;
    const torque = this.rpm > 2600 ? 0 : tech.maxRotMomentum * Math.max(0.45, 1 - x * x);
    const nDriven = this.driven.filter(Boolean).length || 2;
    const wheelForce = (throttle * torque * Math.abs(ratio) * 0.85) / this.wheelRadius / nDriven;
    const dir = this.gear < 0 ? -1 : 1;
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelEngineForce(i, this.driven[i] ? -dir * wheelForce : 0);
      const b = brake * tech.brakePower * 0.004 + (input.handbrake && i >= 2 ? 400 : 0);
      this.ctrl.setWheelBrake(i, b + (throttle === 0 && brake === 0 ? 3 : 0));
    }
    this.ctrl.updateVehicle(dt);
  }

  private gearRatio(): number {
    if (this.gear < 0) return this.def.tech.reverseCoeff;
    return this.def.tech.gears[this.gear - 1] ?? 1;
  }

  /** Синхронізує візуальну модель з фізикою (після world.step). */
  syncVisual(): void {
    const t = this.body.translation();
    const r = this.body.rotation();
    this.visual.position.set(t.x, t.y, t.z);
    this.visual.quaternion.set(r.x, r.y, r.z, r.w);
    // Колеса: підвіска (зсув по Z гри), поворот керма (навколо Z), обертання (навколо X).
    for (let i = 0; i < 4; i++) {
      const w = this.wheelVisual[i];
      const len = this.ctrl.wheelSuspensionLength(i) ?? this.suspRest;
      const steer = this.ctrl.wheelSteering(i) ?? 0;
      const spin = this.ctrl.wheelRotation(i) ?? 0;
      const m = w.base.clone();
      m.multiply(new THREE.Matrix4().makeTranslation(0, 0, this.suspRest * 0.5 - len));
      m.multiply(new THREE.Matrix4().makeRotationZ(steer));
      m.multiply(new THREE.Matrix4().makeRotationX(-spin));
      w.obj.matrix.copy(m);
    }
  }

  reset(spawn: { position: THREE.Vector3; forward: THREE.Vector3 }): void {
    const f = spawn.forward.clone().setY(0).normalize();
    const q = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)), new THREE.Vector3(0, 1, 0), f.clone().negate()),
    );
    this.body.setTranslation(spawn.position, true);
    this.body.setRotation(q, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.gear = 1;
  }

  /** Поточний напрям «уперед» у світі. */
  forward(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.visual.quaternion);
  }

  dispose(): void {
    this.world.removeVehicleController(this.ctrl);
    this.world.removeRigidBody(this.body);
  }
}
