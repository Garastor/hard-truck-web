import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { buildTruckModel, visibleBox, type TruckDef } from '../engine/vehicle/trucks';
import { TIP_OFF, TIP_ON, TIRE } from '../engine/vehicle/truckVehicle';
import { HitMeter } from '../engine/vehicle/hitMeter';
import { g2t } from '../engine/physics/world';
import type { TechRecord } from '../formats/tech';
import type { SceneAssembler } from '../engine/render/sceneBuilder';
import { dentGeometry, type DentGeometry } from './dents';

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
/**
 * Зчіпка в русі king.exe (physics.md «Упор і відрив причепа»): жорсткого упору немає — від складання 32,3°
 * (|sin θ| > 0,534, 0x64fa30) пружний момент |s|·(|s| − 0,534)·10·I; відрив — складання понад 135° (0x64b810),
 * відносний тангаж чи крен понад 45° (0x64fa48), перекидання тягача чи причепа, розходження сідло–шворень понад 5 м
 * (0x64c320). Порт рух причепа задає кінематично, тож пружину передає сповільненням складання: швидкість складання
 * ×(1 − min(FOLD_MAX, FOLD_K·|s|·(|s| − 0,534))) — гіпотеза порту.
 */
const FOLD_FROM = 0.534;
const FOLD_K = 2;
const FOLD_MAX = 0.8;
const BREAK_FOLD = (135 * Math.PI) / 180;
const BREAK_TILT = Math.cos((45 * Math.PI) / 180);
const BREAK_GAP = 5;
/** Повернення до спільного крену, 1/с. */
const ROLL_RETURN = 5;

export class Trailer {
  readonly body: RAPIER.RigidBody;
  readonly visual = new THREE.Group();
  /** Маса з вантажем, кг (змінює setCargo). */
  mass: number;
  /** Вага на шворні в спокої, Н (за положенням центру мас між шворнем і віссю коліс). */
  kingpinLoad: number;
  /** Колайдер кузова (маса й центр мас) і що потрібно, щоб перерахувати їх з новим вантажем (setCargo). */
  private readonly hull: RAPIER.Collider;
  private readonly hullSize: THREE.Vector3;
  private readonly hullCenter: THREE.Vector3;
  private readonly axleZ: number;
  private readonly ctrl: RAPIER.DynamicRayCastVehicleController;
  private readonly joint: RAPIER.ImpulseJoint;
  private readonly wheels: { obj: THREE.Object3D; base: THREE.Matrix4 }[];
  private readonly kingpin: THREE.Vector3;
  private readonly saddle: THREE.Vector3;
  /** Перемикачі моделі причепа (вмʼятини, побиті колеса, габарити, стоп-сигнали) і кількість їхніх станів. */
  readonly setSwitch: ((name: string, state: number) => void) | undefined;
  readonly switchStates: ((name: string) => number) | undefined;
  /** Колеса й габарити для пошкоджень (dents.ts). */
  readonly dentGeom: DentGeometry;
  /** Горизонтальна швидкість після попереднього виклику velocityChange (удари). */
  private readonly lastVel = new THREE.Vector3();
  /** Удари в русі king.exe (follow) — без власного кінематичного кроку. */
  private readonly hits: HitMeter;
  /** Останній крок — рух king.exe (follow). */
  private kinematic = false;

  constructor(
    private readonly world: RAPIER.World,
    asm: SceneAssembler,
    readonly def: TruckDef,
    readonly rec: TechRecord,
    private readonly tractor: { body: RAPIER.RigidBody; saddle: readonly number[] },
    cargoMass = 0,
    /** Фарбування (кластер TRUCKS.OVL, presents.ts) — перефарбувати модель. */
    paint?: (root: THREE.Object3D) => void,
  ) {
    // Окремий екземпляр моделі — свої перемикачі (вмʼятини, колеса й вогні цього причепа).
    const model = buildTruckModel(asm, def, true);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    paint?.(model.root);
    this.setSwitch = model.setSwitch;
    this.switchStates = model.switchStates;
    // Зчеплений: опори підняті (SupportKey 0, 0x55ee80); логотип — компанії власника (у гравця компанії немає — 0).
    this.setSwitch?.('SupportKey', 0);
    this.setSwitch?.('refer_IconKey', 0);
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model.root);
    this.visual.add(frame);
    this.wheels = model.wheels.map((obj, i) => ({ obj, base: model.wheelBase[i] }));
    for (const w of this.wheels) w.obj.matrixAutoUpdate = false;
    frame.updateMatrixWorld(true);
    const box = visibleBox(model.body);
    this.dentGeom = dentGeometry(model, box);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());

    this.kingpin = g2t(rec.topSaddle);
    this.saddle = g2t(tractor.saddle);
    const { position, rotation } = this.poseBehind();
    this.body = world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic().setTranslation(position.x, position.y, position.z).setRotation(rotation).setAngularDamping(0.5).setCanSleep(false),
    );
    this.hits = new HitMeter(this.body, world);
    this.hullSize = size;
    this.hullCenter = center;
    // Центр візка коліс уздовж причепа (z Three, + назад): частка ваги на шворні — важіль до центру мас.
    const axleZ = model.wheelBase.reduce((s, m) => s + g2t(new THREE.Vector3().setFromMatrixPosition(m)).z, 0) / model.wheelBase.length;
    this.axleZ = axleZ;
    this.axle.set(0, this.kingpin.y, axleZ);
    const props = this.massProps(cargoMass);
    this.mass = props.mass;
    this.kingpinLoad = props.kingpinLoad;
    this.hull = world.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, (size.y / 2) * 0.8, size.z / 2)
        .setTranslation(center.x, center.y, center.z)
        .setMassProperties(props.mass, props.com, props.inertia, { w: 1, x: 0, y: 0, z: 0 })
        .setFriction(0.3)
        .setRestitution(0.1),
      this.body,
    );
    const mass = props.mass;
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
      // Шина перекинутого причепа (як у тягача, TruckVehicle TIP_ON): опора на колесо, а не на ребро кузова.
      const tire = world.createCollider(RAPIER.ColliderDesc.ball(rec.wheelRadius).setTranslation(c.x, c.y - SUSP_ANCHOR, c.z).setDensity(0).setFriction(0.8).setRestitution(0.05), this.body);
      tire.setEnabled(false);
      this.tires.push(tire);
    });
    const joint = RAPIER.JointData.spherical(
      { x: this.saddle.x, y: this.saddle.y, z: this.saddle.z },
      { x: this.kingpin.x, y: this.kingpin.y, z: this.kingpin.z },
    );
    this.joint = world.createImpulseJoint(joint, tractor.body, this.body, true);
    this.joint.setContactsEnabled(false);
    this.syncVisual();
  }

  /**
   * Маса, центр мас (від центру колайдера) і інерція з вантажем cargo кг; вага на шворні. Центр мас порожнього —
   * CenterMassInB3D (STrailerM (0; −3,22; −0,5) — над середньою віссю: порожній причіп стоїть на своїх колесах); вантаж —
   * над дном кузова (center_of_cargo_bottom, у STrailerM — середина) на половині висоти кузова, тож завантажений тисне
   * на сідло.
   */
  private massProps(cargo: number) {
    const rec = this.rec;
    const size = this.hullSize;
    const empty = rec.mass + rec.bodyMass;
    const mass = empty + cargo;
    const cargoAt = g2t(rec.cargoBottom).add(new THREE.Vector3(0, rec.bodyHeight / 2, 0));
    const com = g2t(rec.centerMass).multiplyScalar(empty).addScaledVector(cargoAt, cargo).divideScalar(mass).sub(this.hullCenter);
    const inertia = {
      x: (mass * (size.y ** 2 + size.z ** 2)) / 12,
      y: (mass * (size.x ** 2 + size.z ** 2)) / 12,
      z: (mass * (size.x ** 2 + size.y ** 2)) / 12,
    };
    const comZ = com.z + this.hullCenter.z;
    const kingpinLoad = mass * 9.81 * THREE.MathUtils.clamp((this.axleZ - comZ) / (this.axleZ - this.kingpin.z), 0, 1);
    return { mass, com: { x: com.x, y: com.y, z: com.z }, inertia, kingpinLoad };
  }

  /**
   * Новий вантаж, кг (боти-далекобійники вантажаться й розвантажуються на складі, traffic/truckers.ts): маса й центр
   * мас кузова, сила пружин; вагу на шворні й масу для тягача (setTowLoad, tow) оновлює власник.
   */
  setCargo(cargo: number): void {
    const p = this.massProps(Math.max(0, cargo));
    this.mass = p.mass;
    this.kingpinLoad = p.kingpinLoad;
    this.hull.setMassProperties(p.mass, p.com, p.inertia, { w: 1, x: 0, y: 0, z: 0 });
    if (!this.tipped) for (let i = 0; i < this.wheels.length; i++) this.ctrl.setWheelMaxSuspensionForce(i, p.mass * 40);
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
    this.groundUp.set(0, 1, 0);
    this.updateTip();
    this.hits.reset();
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
    this.updateGroundUp();
    const n = new THREE.Vector3();
    for (let i = 0; i < this.wheels.length; i++) {
      const nr = this.ctrl.wheelIsInContact(i) ? this.ctrl.wheelContactNormal(i) : null;
      if (nr) n.add(nr as THREE.Vector3Like);
    }
    // У повітрі (чи на перешкоді) — Rapier (шарнір тримає зчіпку) з тертям і упором сідла, як у колишній моделі: без
    // упору причіп, що повис на перешкоді, тягач розвертав на повні оберти.
    if (n.lengthSq() < 1e-6) return this.hitchDamper(dt);
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
    let omega = -vK.dot(lat) / len;
    // Пружний опір складанню від 32,3° (див. FOLD_*): складання сповільнюється, розкладання — ні.
    const ta = this.tractor.body.angvel();
    const wT = ta.x * n.x + ta.y * n.y + ta.z * n.z;
    const art = this.articulation;
    const s = Math.abs(Math.sin(art));
    if (Math.abs(art) > Math.asin(FOLD_FROM) && Math.sign(omega - wT) === Math.sign(art)) {
      const k = Math.abs(art) > Math.PI / 2 ? FOLD_MAX : Math.min(FOLD_MAX, FOLD_K * s * (s - FOLD_FROM));
      omega = wT + (omega - wT) * (1 - k);
    }
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

  /**
   * Зчіпку розірвано (0x558f20 → 0x55d5d0): складання понад 135°, відносний тангаж чи крен понад 45°, тягач чи причіп
   * перекинулись, сідло й шворень розійшлись понад 5 м. Відчіплює гра (drive.ts), як клавішею.
   */
  get broken(): boolean {
    const up = (b: RAPIER.RigidBody) => {
      const r = b.rotation();
      return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    };
    const u1 = up(this.tractor.body);
    const u2 = up(this.body);
    return Math.abs(this.articulation) > BREAK_FOLD || u1.dot(u2) < BREAK_TILT || u1.y < 0 || u2.y < 0 || this.gap > BREAK_GAP;
  }

  /**
   * Перекинутий (як тягач, TruckVehicle TIP_ON): промені підвіски нахиляються з кузовом і на крені ≈ 45° підпирали
   * причіп з-під центру мас — він їхав боком на двох колесах. Кузов відхилився від нормалі ґрунту понад TIP_ON — колеса не
   * тримають і не ведуть (без руху king.exe й бічних сил), опора — кулі-шини: причіп падає; знову на колесах — ближче TIP_OFF.
   */
  tipped = false;
  private readonly tires: RAPIER.Collider[] = [];
  private readonly groundUp = new THREE.Vector3(0, 1, 0);

  private updateTip(): void {
    const r = this.body.rotation();
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w));
    const tipped = up.dot(this.groundUp) < Math.cos(this.tipped ? TIP_OFF : TIP_ON);
    if (tipped === this.tipped) return;
    this.tipped = tipped;
    for (let i = 0; i < this.wheels.length; i++) this.ctrl.setWheelMaxSuspensionForce(i, tipped ? 0 : this.mass * 40);
    for (const t of this.tires) t.setEnabled(tipped);
  }

  /**
   * Перекинута: нормаль ґрунту — променем униз з центру мас (повз власні тіла). Кузов, що ліг на схил кювету чи насипу
   * паралельно до нього, знову «на колесах» (раніше порівнювався з нормаллю дороги до падіння — причіп так і висів
   * нахиленим на узбіччі).
   */
  private probeGround(): void {
    const c = this.body.worldCom();
    const own = this.body.handle;
    const tractor = this.tractor.body.handle;
    const hit = this.world.castRayAndGetNormal(new RAPIER.Ray({ x: c.x, y: c.y + 0.5, z: c.z }, { x: 0, y: -1, z: 0 }), 6, true, undefined, undefined, undefined, undefined, (col) => {
      const p = col.parent();
      return !p || (p.handle !== own && p.handle !== tractor);
    });
    if (hit && hit.normal.y > 0.5) this.groundUp.set(hit.normal.x, hit.normal.y, hit.normal.z).normalize();
  }

  /** Після кроку підвіски на колесах: нормаль ґрунту — середня нормаль контактів. */
  private updateGroundUp(): void {
    if (this.tipped) return this.probeGround();
    const n = new THREE.Vector3();
    for (let i = 0; i < this.wheels.length; i++) {
      const nr = this.ctrl.wheelIsInContact(i) ? this.ctrl.wheelContactNormal(i) : null;
      if (nr) n.add(nr as THREE.Vector3Like);
    }
    if (n.lengthSq() > 1e-6) this.groundUp.copy(n.normalize());
  }

  /** Крок фізики (до world.step): гальма й опір кочення; kinematic — рух king.exe (follow). */
  update(dt: number, brake: number, brakePower: number, kinematic = false): void {
    this.savePrev();
    this.kinematic = kinematic;
    this.updateTip();
    if (this.tipped) {
      // Перекинутий: лише Rapier (шарнір тримає зчіпку), колеса не тримають.
      this.ctrl.updateVehicle(dt, undefined, undefined, (c) => c.parent()?.handle !== this.tractor.body.handle);
      this.updateGroundUp();
      return;
    }
    if (kinematic) {
      this.hits.begin(dt);
      this.follow(dt);
      this.hits.end();
      return;
    }
    const n = this.wheels.length;
    const force = (brake * brakePower) / n + (ROLLING * this.mass * 9.81) / n;
    for (let i = 0; i < n; i++) this.ctrl.setWheelBrake(i, force * dt);
    // Промені коліс причепа — повз тягач (і навпаки, див. drive.hitch).
    this.ctrl.updateVehicle(dt, undefined, undefined, (c) => c.parent()?.handle !== this.tractor.body.handle);
    this.updateGroundUp();
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

  /**
   * Зміна горизонтальної швидкості причепа від попереднього виклику — у системі причепа (Three.js: уперед — −z),
   * для зони вмʼятини (dents.ts). У русі king.exe — лише від зіткнень (HitMeter: кінематичний поворот — не удар).
   */
  velocityChange(): THREE.Vector3 {
    const lv = this.body.linvel();
    const v = new THREE.Vector3(lv.x, 0, lv.z);
    const hit = this.hits.take().setY(0);
    const dv = this.kinematic ? hit : v.clone().sub(this.lastVel);
    this.lastVel.copy(v);
    const r = this.body.rotation();
    return dv.applyQuaternion(new THREE.Quaternion(r.x, r.y, r.z, r.w).invert());
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
