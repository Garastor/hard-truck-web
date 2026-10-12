import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { FileSource } from '../../assets/loader';
import { EngineAudio } from '../../audio/engineAudio';
import { levelCollision } from '../../game/collision';
import { TruckVehicle } from '../../game/truckVehicle';
import { buildTruckModel, type TruckDef } from '../../game/trucks';
import { Input } from '../../input/input';
import { GROUP_WORLD, addCollisionPolys, g2t, groups, initRapier } from '../../physics/world';
import { assoc, num, readSch, str } from '../../formats/sexpr';
import { drivable, loadTrucks, truckDef, type Ht2Trucks } from './trucks';
import { FOV } from './viewer';
import { Ht2World, toThree, type LoadedRegion } from './world';
import { AutoPilot } from '../../game/autopilot';
import { Ht2Roads } from './roads';
import { Traffic, trafficKinds } from './traffic';

/**
 * Їзда у світі Дальнобойщиків 2 (G4): вантажівка з vehicle.tech і TRUCKS.B3D на тій самій фізиці, що й у першій
 * грі (TruckVehicle: Rapier + двигун/коробка з HTruck.exe — гіпотеза, що в HT2 вони ті самі), колізії — з `hit_*`
 * завантажених регіонів (levelCollision), регіони підвантажуються навколо машини (Ht2World).
 * Старт — `startposition` з ENV/GAME.CNF, вантажівка — `live 1 "<car_node>"` з `playertypes` (або ?truck=).
 */
export interface Ht2DriveOptions {
  renderer: THREE.WebGLRenderer;
  source: FileSource;
  overlay: HTMLElement;
  setStatus(text: string | null): void;
  onExit(): void;
  /** car_node вантажівки (Zil, ZilR, Kamaz…); без — з GAME.CNF. */
  truck?: string | null;
}

type CamMode = 'chase' | 'cockpit' | 'far';
const NEXT_CAM: Record<CamMode, CamMode> = { chase: 'cockpit', cockpit: 'far', far: 'chase' };

export class Ht2Drive {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000);
  private rapier!: RAPIER.World;
  truck!: TruckVehicle;
  private def!: TruckDef;
  private readonly input = new Input();
  private audio: EngineAudio | null = null;
  private camMode: CamMode = 'chase';
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private cockpit = new THREE.Vector3();
  private readonly colliders = new Map<string, RAPIER.Collider[]>();
  private acc = 0;
  private last = performance.now();
  /** Остання надійна точка на дорозі (для відновлення після падіння). */
  private safe: { position: THREE.Vector3; forward: THREE.Vector3 } | null = null;
  private safeTimer = 0;
  private readonly hud = document.createElement('div');
  private readonly bar = document.createElement('div');
  private touch: HTMLElement | null = null;
  /** Дороги всіх регіонів (WAY) і автопілот (клавіша P; для тестів — smoke). */
  roads!: Ht2Roads;
  autopilot: AutoPilot | null = null;
  traffic: Traffic | null = null;
  private readonly onResize = () => this.resize();

  private constructor(
    private readonly opts: Ht2DriveOptions,
    readonly world: Ht2World,
    private readonly trucks: Ht2Trucks,
  ) {}

  static async start(opts: Ht2DriveOptions): Promise<Ht2Drive> {
    opts.setStatus('Завантаження світу й вантажівок…');
    await initRapier();
    const world = await Ht2World.create(opts.source);
    const trucks = await loadTrucks(opts.source, world.common.lib.palette);
    const d = new Ht2Drive(opts, world, trucks);
    await d.init();
    opts.setStatus(null);
    return d;
  }

  private async init(): Promise<void> {
    const o = this.opts;
    this.rapier = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.rapier.timestep = 1 / 60;
    this.world.onRegion = (reg, loaded) => (loaded ? this.addRegion(reg) : this.removeRegion(reg.id));
    this.roads = new Ht2Roads(this.world.regions.values());

    // Старт і вантажівка гравця — з ENV/GAME.CNF.
    const cnf = await o.source.read('ENV/GAME.CNF').then(readSch).catch(() => null);
    const sp = cnf ? assoc(cnf, 'startposition') : undefined;
    const start: [number, number, number] = sp ? [num(sp[1]), num(sp[2]), num(sp[3])] : [-3020, -4625, 20];
    const live = cnf ? assoc(assoc(cnf, 'playertypes')?.slice(1) ?? [], 'live') : undefined;
    const want = o.truck || (live ? str(live[2]) : 'ZilR');
    const list = drivable(this.trucks);
    const rec = list.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? list[0];
    const def = rec && truckDef(this.trucks, rec);
    if (!def) throw new Error('Немає моделі вантажівки');
    this.def = def;

    o.setStatus('Завантаження регіонів довкола старту…');
    await this.world.ready(start[0], start[1]);
    this.rapier.step(); // колайдери потрапляють у запити (castRay) лише після кроку

    const spawn = this.spawnAt(start);
    const model = buildTruckModel(this.trucks.asm, def, false);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    this.truck = new TruckVehicle(this.rapier, def, model, spawn);
    this.world.scene.add(this.truck.visual);
    this.safe = spawn;
    this.cockpit = g2t(def.tech.viewer);
    this.camPos.copy(spawn.position).addScaledVector(spawn.forward, -14).add(new THREE.Vector3(0, 6, 0));
    this.camLook.copy(spawn.position);

    const vehicles = await o.source.read('evehicles.sch').then(readSch).catch(() => []);
    this.traffic = new Traffic(this.world.scene, this.rapier, this.roads, this.trucks, trafficKinds(vehicles, this.trucks), (r) => this.world.loaded.has(r));
    this.audio = await EngineAudio.create(this.world.commonRmp).catch(() => null);
    this.input.onCommand = (cmd) => {
      if (cmd === 'camera') this.camMode = NEXT_CAM[this.camMode];
      if (cmd === 'autopilot') this.autopilot = this.autopilot ? null : new AutoPilot(this.roads);
      if (cmd === 'reset') this.recover();
      if (cmd === 'horn') this.audio?.playOnce('horn');
      if (cmd === 'engine') {
        this.truck.engineOn = !this.truck.engineOn;
        if (this.truck.engineOn) this.audio?.play('start', 0.8);
      }
    };
    document.body.classList.add('driving');
    this.touch = this.input.mountTouch(o.overlay);
    this.hud.className = 'ht2-hud';
    const back = document.createElement('button');
    back.textContent = '← Меню';
    back.addEventListener('click', () => o.onExit());
    this.bar.className = 'ht2-drive-bar';
    this.hud.append(back);
    document.body.append(this.hud, this.bar);
    window.addEventListener('resize', this.onResize);
    this.resize();
    this.last = performance.now();
    o.renderer.setAnimationLoop(() => this.frame());
  }

  /** Точка старту: найближча точка доріг WAY до (x, y) гри, напрям — уздовж сегмента; висота — променем униз. */
  private spawnAt([x, y, z]: [number, number, number]): { position: THREE.Vector3; forward: THREE.Vector3 } {
    let best = Infinity;
    let pos: [number, number, number] = [x, y, z];
    let dir: [number, number] = [0, 1];
    for (const r of this.world.regions.values())
      for (const room of r.way.rooms)
        for (const s of room.segments) {
          const p = s.points;
          for (let i = 0; i + 5 < p.length; i += 3) {
            const d = Math.hypot(p[i] - x, p[i + 1] - y, p[i + 2] - z);
            if (d >= best) continue;
            const dx = p[i + 3] - p[i];
            const dy = p[i + 4] - p[i + 1];
            const l = Math.hypot(dx, dy);
            if (l < 0.1) continue;
            best = d;
            pos = [p[i], p[i + 1], p[i + 2]];
            dir = [dx / l, dy / l];
          }
        }
    const position = this.groundAt(toThree(...pos));
    return { position, forward: toThree(dir[0], dir[1], 0).normalize() };
  }

  /** Поверхня під точкою (Three.js) + 2,5 м — висота центру вантажівки над дорогою при появі. */
  private groundAt(p: THREE.Vector3): THREE.Vector3 {
    for (const up of [4, 200]) {
      const hit = this.rapier.castRay(new RAPIER.Ray({ x: p.x, y: p.y + up, z: p.z }, { x: 0, y: -1, z: 0 }), 1000, true);
      if (hit) return new THREE.Vector3(p.x, p.y + up - hit.timeOfImpact + 2.5, p.z);
    }
    return new THREE.Vector3(p.x, p.y + 2.5, p.z);
  }

  /** Колізії регіону: підлога й стіни з `hit_road_*`/`hit_obj_*` (усі кімнати регіону разом). */
  private addRegion(reg: LoadedRegion): void {
    const col = levelCollision(reg.built.assembler.b3d);
    const cs: RAPIER.Collider[] = [];
    const floor = addCollisionPolys(this.rapier, col.floors, 1.0);
    const walls = addCollisionPolys(this.rapier, col.walls, 0.4);
    if (floor) cs.push(floor);
    if (walls) cs.push(walls);
    if (!col.hasFloor) {
      const c = groundFromMeshes(this.rapier, reg.built.root);
      if (c) cs.push(c);
    }
    this.colliders.set(reg.id, cs);
  }

  private removeRegion(id: string): void {
    for (const c of this.colliders.get(id) ?? []) this.rapier.removeCollider(c, false);
    this.colliders.delete(id);
  }

  /** Відновитися: на останню надійну точку дороги. */
  recover(): void {
    if (this.safe) this.truck.reset({ position: this.safe.position.clone(), forward: this.safe.forward.clone() });
  }

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.opts.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.update(dt);
    this.opts.renderer.render(this.world.scene, this.camera);
  }

  /** Крок гри (також для тестів — без requestAnimationFrame). */
  update(dt: number): void {
    const manual = this.input.update(dt);
    const tp = this.truck.body.translation();
    const state = this.autopilot ? this.autopilot.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.truck.forward(), this.truck.speedKmh, dt, this.traffic?.cars.map((c) => c.pos)) : manual;
    this.traffic?.update(dt, this.truck.visual.position);
    this.acc += dt;
    const step = this.rapier.timestep;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.rapier.step();
      this.acc -= step;
    }
    this.truck.syncVisual();
    this.audio?.update(this.truck.rpm, state.throttle, this.truck.engineOn);
    this.trackSafe(dt);
    this.updateCamera(dt);
    this.world.update(this.camera);
    this.bar.textContent = `${Math.round(this.truck.speedKmh)} км/год   ${this.truck.gear < 0 ? 'R' : this.truck.gear === 0 ? 'N' : this.truck.gear}   ${Math.round(this.truck.rpm)} об/хв`;
  }

  /**
   * Автопрохід для перевірок (без requestAnimationFrame): автопілот seconds секунд — відстань, найдовше застрягання,
   * перекидання, регіони дорогою.
   */
  async smoke(seconds: number): Promise<{ seconds: number; distance: number; stuckFor: number; flips: number; regions: string[]; ok: boolean }> {
    const prev = this.autopilot;
    this.autopilot ??= new AutoPilot(this.roads);
    const regions = new Set<string>();
    let distance = 0;
    let stuck = 0;
    let stuckFor = 0;
    let flips = 0;
    let wasFlipped = false;
    const p0 = new THREE.Vector3();
    const p1 = new THREE.Vector3();
    let nextWait = 0;
    for (let t = 0; t < seconds; t += 1 / 30) {
      if (t >= nextWait) {
        // Раз на секунду гри — дати регіонам довантажитися довкола машини (у грі це відбувається між кадрами).
        nextWait = t + 1;
        const c = this.truck.body.translation();
        await this.world.ready(c.x, -c.z);
      }
      const a = this.truck.body.translation();
      p0.set(a.x, a.y, a.z);
      this.update(1 / 30);
      const b = this.truck.body.translation();
      p1.set(b.x, b.y, b.z);
      distance += p0.distanceTo(p1);
      if (this.truck.speedKmh < 2) stuck += 1 / 30;
      else stuck = 0;
      stuckFor = Math.max(stuckFor, stuck);
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.truck.visual.quaternion);
      const flipped = up.y < 0.3;
      if (flipped && !wasFlipped) flips++;
      wasFlipped = flipped;
      const r = this.world.regionAt(p1.x, -p1.z);
      if (r) regions.add(r);
    }
    this.autopilot = prev;
    return { seconds, distance: Math.round(distance), stuckFor: +stuckFor.toFixed(1), flips, regions: [...regions], ok: stuckFor < 3 && flips === 0 };
  }

  /** Раз на секунду запамʼятовуємо позицію, якщо всі колеса на землі й машина не перекинута; падіння — відновлення. */
  private trackSafe(dt: number): void {
    const p = this.truck.body.translation();
    if (p.y < -200) return this.recover();
    this.safeTimer += dt;
    if (this.safeTimer < 1) return;
    this.safeTimer = 0;
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.truck.visual.quaternion);
    let contacts = 0;
    for (let i = 0; i < 4; i++) if (this.truck.ctrl.wheelIsInContact(i)) contacts++;
    if (up.y > 0.8 && contacts >= 3) this.safe = { position: new THREE.Vector3(p.x, p.y + 0.5, p.z), forward: this.truck.forward() };
  }

  private updateCamera(dt: number): void {
    const v = this.truck.visual;
    const fwd = this.truck.forward();
    const up = new THREE.Vector3(0, 1, 0);
    if (this.camMode === 'cockpit') {
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (this.def.tech.viewerTilt * Math.PI) / 180);
      this.camera.position.copy(this.cockpit).applyQuaternion(v.quaternion).add(v.position);
      this.camera.quaternion.copy(v.quaternion).multiply(tilt);
      this.camera.near = 0.2;
      this.camera.updateProjectionMatrix();
      return;
    }
    if (this.camera.near !== 1) {
      this.camera.near = 1;
      this.camera.updateProjectionMatrix();
    }
    const dist = this.camMode === 'far' ? 28 : 13;
    const height = this.camMode === 'far' ? 12 : 5;
    const flat = fwd.clone().setY(0).normalize();
    const want = v.position.clone().addScaledVector(flat, -dist).addScaledVector(up, height);
    this.camPos.lerp(want, 1 - Math.exp(-dt * 4));
    this.camLook.lerp(v.position.clone().addScaledVector(up, 2), 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  dispose(): void {
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('driving');
    this.input.dispose();
    this.touch?.remove();
    this.hud.remove();
    this.bar.remove();
    this.audio?.dispose();
    this.traffic?.dispose();
    this.truck?.dispose();
    this.world.dispose();
    this.trucks.asm.dispose();
  }
}

/** Запасна земля з видимої геометрії (регіон без `hit_road`): пологі трикутники одним trimesh. */
function groundFromMeshes(world: RAPIER.World, root: THREE.Object3D): RAPIER.Collider | null {
  root.updateMatrixWorld(true);
  const out: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o instanceof THREE.InstancedMesh) return;
    const pos = o.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return;
    for (let i = 0; i + 2 < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
      b.fromBufferAttribute(pos, i + 1).applyMatrix4(o.matrixWorld);
      c.fromBufferAttribute(pos, i + 2).applyMatrix4(o.matrixWorld);
      n.subVectors(b, a).cross(c.clone().sub(a));
      const len = n.length();
      if (!len || n.y / len < 0.35) continue;
      out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  });
  if (!out.length) return null;
  const verts = new Float32Array(out);
  const idx = new Uint32Array(verts.length / 3).map((_, i) => i);
  return world.createCollider(RAPIER.ColliderDesc.trimesh(verts, idx).setFriction(1).setCollisionGroups(groups(GROUP_WORLD, 0xffff)));
}
