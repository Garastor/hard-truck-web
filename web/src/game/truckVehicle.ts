import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { g2t } from '../physics/world';
import type { ControlState } from '../input/input';
import type { TruckDef, TruckModel } from './trucks';
import { Engine, GEAR_R } from './engine';

/**
 * Вантажівка на DynamicRayCastVehicleController (Rapier).
 * Параметри — з [TECHn] у TRUCK.TCH. Двигун і коробка — відтворені з HTruck.exe (engine.ts);
 * шини, підвіска й інтегрування кузова — поки Rapier (доріжка R4 продовжується).
 */
/** Кермо (телеметрія s6): межа 1,04/(1 + 0,056·v), не більше 0,913; кут колеса = 0,684 × кермо. */
const STEER_A = 1.041;
const STEER_B = 0.056;
const STEER_MAX = 0.913;
const STEER_TO_WHEEL = 0.684;
/** cot(зовнішнього) − cot(внутрішнього) кута коліс (ЗіЛ, s6: 0,624 / 0,558 рад). */
const ACKERMANN = 0.208;

/**
 * Межа зчеплення шин (Rapier frictionSlip): передні — підібрані під коло з кермом до упору (s6,
 * R ≈ 8 м на 3,5 м/с і ≈ 17,8 м на 7,5 м/с), задні — тертя колеса оригіналу [0x30b] = 0,84.
 */
const TIRE_GRIP_FRONT = 0.42;
const TIRE_GRIP_REAR = 0.84;
const TIRE_GRIP_BRAKING = 1.0;

/** Частки breakpower на колесо: передні / задні (телеметрія ЗіЛ, s6) — гіпотеза для інших вантажівок. */
const BRAKE_FRONT = 0.49;
const BRAKE_REAR = 0.35;
/** Коефіцієнт опору кочення (накат на 4-й передачі без газу, s7). */
const ROLLING_RESISTANCE = 0.015;

export class TruckVehicle {
  readonly body: RAPIER.RigidBody;
  readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  /** Візуальна модель у світі Three.js. */
  readonly visual = new THREE.Group();
  /** Передача для інтерфейсу: −1 — R, 0 — N, 1 — перша… */
  gear = 0;
  rpm = 300;
  speedKmh = 0;
  readonly engine: Engine;

  private readonly wheelRadius: number;
  private readonly driven: boolean[];
  private readonly wheelVisual: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly suspRest = 0.35;
  private steerAngle = 0;
  /** Задній хід: гравець утримує гальмо на місці (тоді «гальмо» — це газ назад). */
  private reverseMode = false;
  private brakeTime = 0;
  private readonly mass: number;

  constructor(
    private readonly world: RAPIER.World,
    readonly def: TruckDef,
    model: TruckModel,
    spawn: { position: THREE.Vector3; forward: THREE.Vector3 },
  ) {
    const tech = def.tech;
    this.wheelRadius = tech.wheelRadius;
    this.driven = [0, 1, 2, 3].map((i) => (tech.drivingWheels[i] ?? 1) !== 0);
    this.engine = new Engine({
      maxTorque: tech.maxRotMomentum,
      tachMaxPower: tech.tachMaxPower,
      rearAxle: tech.rearAxleCoeff,
      reverse: tech.reverseCoeff,
      gears: tech.gears,
      wheelRadius: tech.wheelRadius,
    });

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
        .setLinearDamping(0) // опір руху — кочення й двигун (як в оригіналі), без штучного демпфування
        .setAngularDamping(0.5)
        .setCanSleep(false), // контролер транспорту не будить тіло — сон «заморожує» вантажівку
    );
    const mass = tech.mass + tech.bodyMass;
    this.mass = mass;
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
      this.ctrl.setWheelFrictionSlip(i, i < 2 ? TIRE_GRIP_FRONT : TIRE_GRIP_REAR);
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

    // Кермо як в оригіналі (s6): межа залежить від швидкості 1,04/(1 + 0,056·v) ≤ 0,913,
    // кут колеса = 0,684 × кермо; внутрішнє колесо повертається більше (Аккерман, cot o − cot i = 0,208).
    const limit = Math.min(STEER_MAX, STEER_A / (1 + STEER_B * Math.abs(v)));
    this.steerAngle = -input.steer * limit * STEER_TO_WHEEL;
    const inner = Math.abs(this.steerAngle);
    const outer = inner > 1e-4 ? Math.atan(1 / (1 / Math.tan(inner) + ACKERMANN)) : 0;
    const left = this.steerAngle > 0; // + — вліво
    this.ctrl.setWheelSteering(0, Math.sign(this.steerAngle) * (left ? inner : outer));
    this.ctrl.setWheelSteering(1, Math.sign(this.steerAngle) * (left ? outer : inner));

    // Задній хід: стоїмо й тримаємо гальмо → R, «гальмо» стає газом назад; газ на місці — знову вперед.
    const stopped = Math.abs(v) < 0.5;
    if (!this.reverseMode && input.brake > 0 && input.throttle === 0 && stopped) this.reverseMode = true;
    else if (this.reverseMode && input.throttle > 0 && stopped) this.reverseMode = false;
    const gas = this.reverseMode ? input.brake : input.throttle;
    const brake = this.reverseMode ? input.throttle : input.brake;

    const eng = this.engine;
    eng.update(dt, gas, brake, v, this.reverseMode);
    this.rpm = eng.rpm;
    this.gear = eng.displayGear === GEAR_R ? -1 : eng.displayGear - 1;

    // Гальмо з клавіатури наростає як t/(t + 1) (поле [0x33a] оригіналу; телеметрія s6).
    this.brakeTime = brake > 0 ? this.brakeTime + dt : 0;
    const brakePedal = brake > 0 ? brake * (this.brakeTime / (this.brakeTime + 1)) : 0;

    // Сила двигуна — порівну на ведучі колеса (у Rapier відʼємна сила — уперед).
    // Гальма: сила колеса = педаль × B (передні 0,49·breakpower, задні 0,35·breakpower — ЗіЛ, s6);
    // опір кочення ≈ 0,015·N (накат s7). Rapier бере гальмо як імпульс за крок — множимо на dt.
    const nDriven = this.driven.filter(Boolean).length || 2;
    const wheelLoad = (this.mass * 9.81) / 4;
    // Rapier ігнорує гальмо колеса, на яке діє сила двигуна, тож гальмування двигуном (сила проти руху)
    // переносимо в гальмо того ж колеса.
    // Двигун гальмує лише з відпущеним газом (сила проти руху); з газом — завжди тягне, зокрема з місця й назад.
    const engineBrakes = gas === 0 && eng.force * v < 0;
    // Межа зчеплення Rapier спільна для повороту, тяги й гальмування. Недостатню повертаність оригіналу
    // дає слабше зчеплення передніх коліс; задні (ведучі) — з тертям оригіналу 0,84, щоб тягнули повністю.
    // Під час гальмування межу передніх плавно піднімаємо (оригінал гальмує сильніше, ніж тримає в повороті).
    // На малій швидкості передні тримають повністю (поворот за геометрією коліс, як в оригіналі: R ≈ 6 м
    // на 2,7 м/с), знижене зчеплення — від 3 до 7 м/с.
    const k = Math.min(1, Math.max(0, (Math.abs(v) - 3) / 4));
    const frontBase = TIRE_GRIP_REAR + (TIRE_GRIP_FRONT - TIRE_GRIP_REAR) * k;
    const front = frontBase + (TIRE_GRIP_BRAKING - frontBase) * brakePedal;
    for (let i = 0; i < 4; i++) {
      this.ctrl.setWheelFrictionSlip(i, i < 2 ? front : Math.max(TIRE_GRIP_REAR, front));
      const engine = this.driven[i] ? eng.force / nDriven : 0;
      const share = i < 2 ? BRAKE_FRONT : BRAKE_REAR;
      let force = brakePedal * share * tech.brakePower + ROLLING_RESISTANCE * wheelLoad;
      if (input.handbrake && i >= 2) force += tech.brakePower;
      if (engineBrakes) {
        this.ctrl.setWheelEngineForce(i, 0);
        force += Math.abs(engine);
      } else this.ctrl.setWheelEngineForce(i, -engine);
      this.ctrl.setWheelBrake(i, force * dt);
    }
    this.ctrl.updateVehicle(dt);
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
    this.reverseMode = false;
    this.brakeTime = 0;
    this.engine.reset();
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
