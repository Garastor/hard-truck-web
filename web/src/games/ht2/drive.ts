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
import { CareerMode } from './careerMode';
import { NavMap } from '../../ui/navMap';
import { Music } from './music';
import { SceneAssembler } from '../../render/sceneBuilder';
import { parseB3d } from '../../formats/b3d';
import { parseRmp } from '../../formats/rmp';
import { TIME_SCALE, dayTime, type Ht2Career } from './career';

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
  /** Кар'єра (гроші, замовлення); без — вільна їзда. */
  career?: Ht2Career | null;
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
  careerMode: CareerMode | null = null;
  private map: NavMap | null = null;
  private music: Music | null = null;
  /** Кабіна (вид з кабіни): інтер'єр з CABINES.B3D окремою сценою поверх світу, як у першій грі. */
  private readonly overlayScene = new THREE.Scene();
  private cab: THREE.Group | null = null;
  private cabParts: { rule?: THREE.Object3D; speed?: THREE.Object3D; tacho?: THREE.Object3D } = {};
  private cabAsm: SceneAssembler | null = null;
  private cabLoading = false;
  private cabLight: THREE.AmbientLight | null = null;
  /** Пауза (вікно складу чи СТО): фізика й час стоять. */
  paused = false;
  /** Ігровий час вільної їзди, с від півночі (кар'єра — свій); старт — 10:00 (TRUCK.INI timestart=10). */
  private freeTime = 10 * 3600;
  private period = '';
  /** Фари: два прожектори на місцях Fara_FL/FR з vehicle.tech; вмикаються в сутінках і вночі або клавішею L. */
  private readonly lamps: THREE.SpotLight[] = [];
  private lightsManual: boolean | null = null;
  /** Маса вантажу в кузові, кг (фізика: центр мас і загальна маса). */
  private cargoMass = 0;
  /** Бак, л, і витрата (vehicle.tech: × 10 = л/100 км) вантажівки гравця. */
  tank = 250;
  fuelConsumption = 5;
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
    const want = o.career?.truck || o.truck || (live ? str(live[2]) : 'ZilR');
    const list = drivable(this.trucks);
    const rec = list.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? list[0];
    const def = rec && truckDef(this.trucks, rec);
    if (!def) throw new Error('Немає моделі вантажівки');
    this.def = def;
    if (o.career && !o.career.truck) o.career.truck = def.carNode;
    this.tank = rec.tank;
    this.cabPrefix = rec.prefixCab;
    this.fuelConsumption = rec.fuelConsumption;

    o.setStatus('Завантаження регіонів довкола старту…');
    await this.world.ready(start[0], start[1]);
    this.rapier.step(); // колайдери потрапляють у запити (castRay) лише після кроку

    // Кар'єра — з місця, де зупинились минулого разу (точка дороги поруч).
    const saved = o.career?.pos;
    if (saved) await this.world.ready(saved[0], saved[1]);
    if (saved) this.rapier.step();
    const spawn = this.spawnAt(saved ?? start);
    const model = buildTruckModel(this.trucks.asm, def, false);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    this.cargoMass = o.career?.order ? o.career.order.goods.mass * o.career.order.units : 0;
    this.truck = new TruckVehicle(this.rapier, def, model, spawn, { cargoMass: this.cargoMass });
    this.world.scene.add(this.truck.visual);
    this.mountLamps();
    this.safe = spawn;
    this.cockpit = g2t(def.tech.viewer);
    this.camPos.copy(spawn.position).addScaledVector(spawn.forward, -14).add(new THREE.Vector3(0, 6, 0));
    this.camLook.copy(spawn.position);

    if (o.career) {
      const merch = await o.source.read('merchandise.sch').then(readSch).catch(() => []);
      this.careerMode = new CareerMode(this, o.career, merch);
    }
    const vehicles = await o.source.read('evehicles.sch').then(readSch).catch(() => []);
    this.traffic = new Traffic(this.world.scene, this.rapier, this.roads, this.trucks, trafficKinds(vehicles, this.trucks), (r) => this.world.loaded.has(r));
    this.audio = await EngineAudio.create(this.world.commonRmp).catch(() => null);
    this.input.onCommand = (cmd) => {
      if (cmd === 'camera') this.camMode = NEXT_CAM[this.camMode];
      if (cmd === 'autopilot') this.autopilot = this.autopilot ? null : new AutoPilot(this.roads);
      if (cmd === 'map' && this.map) this.map.el.hidden = !this.map.el.hidden;
      if (cmd === 'lights') this.lightsManual = !this.lamps[0]?.visible;
      if (cmd === 'reset') this.recover();
      if (cmd === 'horn') this.audio?.playOnce('horn');
      if (cmd === 'engine') {
        this.truck.engineOn = !this.truck.engineOn;
        if (this.truck.engineOn) this.audio?.play('start', 0.8);
      }
    };
    document.body.classList.add('driving');
    this.touch = this.input.mountTouch(o.overlay);
    // Мінікарта: осьові лінії доріг (без зворотних смуг), машини трафіку, ціль кар'єри.
    this.map = new NavMap(o.overlay, { lines: this.roads.lines.filter((l) => !l.name.endsWith('r')) });
    this.hud.className = 'ht2-hud';
    const back = document.createElement('button');
    back.textContent = '← Меню';
    back.addEventListener('click', () => o.onExit());
    this.bar.className = 'ht2-drive-bar';
    this.music = new Music(o.source);
    void this.music.next();
    const music = document.createElement('button');
    music.textContent = '♪';
    music.setAttribute('aria-label', 'Музика');
    music.addEventListener('click', () => music.classList.toggle('off', !this.music?.toggle()));
    this.hud.append(back, music);
    // У шарі overlay — під вікнами складу й СТО (вони теж там, вище).
    o.overlay.append(this.hud, this.bar);
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

  get overlay(): HTMLElement {
    return this.opts.overlay;
  }

  /** Новий вантаж у кузові: машину перебудовуємо на тому ж місці (маса й центр мас — при створенні). */
  setCargo(mass: number): void {
    this.cargoMass = mass;
    const position = this.truck.visual.position.clone().add(new THREE.Vector3(0, 0.3, 0));
    const forward = this.truck.forward();
    const model = buildTruckModel(this.trucks.asm, this.def, false);
    if (!model) return;
    this.world.scene.remove(this.truck.visual);
    this.truck.dispose();
    this.truck = new TruckVehicle(this.rapier, this.def, model, { position, forward }, { cargoMass: mass });
    this.world.scene.add(this.truck.visual);
    this.mountLamps();
  }

  /**
   * Фари — прожектори в системі машини: точки Fara_FL/FR (vehicle.tech, система моделі: x, вперед, угору), світять
   * уперед і трохи вниз. Сцена HT2 освітлюється (Lambert), тож світло лягає на дорогу без власних шейдерів.
   * Параметри (сила 350 кд, дальність 80 м, конус 26°, згасання d^1,5) — на око.
   */
  private mountLamps(): void {
    this.lamps.length = 0;
    const rec = this.trucks.records.find((r) => r.carNode === this.def.carNode);
    const spots = rec ? [rec.faraFL, rec.faraFR] : [[-0.8, 2.4, 0.2], [0.8, 2.4, 0.2]];
    for (const f of spots) {
      const p = g2t(f as [number, number, number]);
      const lamp = new THREE.SpotLight(0xfff2d0, 350, 80, (26 * Math.PI) / 180, 0.45, 1.5);
      lamp.position.copy(p);
      lamp.target.position.copy(p).add(new THREE.Vector3(0, -1.2, -20));
      lamp.visible = false;
      this.truck.visual.add(lamp, lamp.target);
      this.lamps.push(lamp);
    }
  }

  /** Пора доби (світло й туман з WEATHER.INI) і фари. */
  private updateDayTime(dt: number): void {
    const t = this.careerMode ? this.careerMode.career.time : (this.freeTime += dt * TIME_SCALE);
    const p = dayTime(t);
    if (p !== this.period) {
      this.period = p;
      this.world.setLight('good', p);
      this.world.setNight(p !== 'day');
      this.cabLight?.color.copy(this.world.ambientColor).multiplyScalar(1.4);
    }
    const on = this.lightsManual ?? (p === 'night' || p === 'sset' || p === 'srise');
    for (const l of this.lamps) l.visible = on;
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
    const r = this.opts.renderer;
    r.render(this.world.scene, this.camera);
    if (this.cab?.visible) {
      // Кабіна — другим проходом з близькою площиною відсікання поверх світу.
      const near = this.camera.near;
      this.camera.near = 0.05;
      this.camera.updateProjectionMatrix();
      const auto = r.autoClear;
      r.autoClear = false;
      r.clearDepth();
      r.render(this.overlayScene, this.camera);
      r.autoClear = auto;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Інтер'єр кабіни `<prefixCab>Cab` (CABINES.B3D, текстури CABINES1.RES) — вантажиться при першому вигляді з кабіни. */
  private async loadCab(): Promise<void> {
    if (this.cabLoading || this.cab) return;
    this.cabLoading = true;
    try {
      if (!this.cabAsm) {
        const [b3d, res] = await Promise.all([this.opts.source.read('COMMON/CABINES.B3D'), this.opts.source.read('COMMON/CABINES1.RES')]);
        this.cabAsm = new SceneAssembler(parseB3d(b3d), parseRmp(res), { lit: true, colorKey: true, nearGroup: 0, type4Space: true, palette: this.world.common.lib.palette ?? undefined });
        // Світло в кабіні — розсіяне світло пори доби (WEATHER.INI envamb) і трохи неба: уночі кабіна темна.
        this.cabLight = new THREE.AmbientLight(this.world.ambientColor.clone().multiplyScalar(1.4), Math.PI);
        this.overlayScene.add(this.cabLight, new THREE.HemisphereLight(0xffffff, 0x404040, Math.PI * 0.15));
      }
      const name = `${this.cabPrefix}Cab`;
      const dyn = this.cabAsm.dynamicObject(name);
      if (!dyn) return;
      const inner = dyn.root;
      inner.rotation.x = -Math.PI / 2;
      this.cab = new THREE.Group();
      this.cab.add(inner);
      this.overlayScene.add(this.cab);
      const prefix = this.cabPrefix.toLowerCase();
      const bySpace = (sp: string) => {
        let found: THREE.Object3D | undefined;
        inner.traverse((o) => {
          if (!found && o.userData.space === `${prefix}${sp}`) found = o;
        });
        return found;
      };
      this.cabParts = { rule: bySpace('rulespace'), speed: bySpace('speedspace'), tacho: bySpace('tachospace') };
    } finally {
      this.cabLoading = false;
    }
  }

  /** Префікс кабіни (prefixCab з vehicle.tech: ZilR → Zil, RenaultR → Reno). */
  private cabPrefix = '';

  /** Кабіна: на місці ока, орієнтація машини з нахилом погляду; кермо й стрілки — за станом. */
  private updateCab(steer: number): void {
    const inside = this.camMode === 'cockpit';
    if (inside && !this.cab) void this.loadCab();
    // Ховаємо лише модель (перший нащадок), не саму машину: її прожектори-фари мають світити й з кабіни.
    this.truck.visual.children[0].visible = !inside || !this.cab;
    if (!this.cab) return;
    this.cab.visible = inside;
    if (!inside) return;
    const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (this.def.tech.viewerTilt * Math.PI) / 180);
    this.cab.position.copy(this.camera.position);
    this.cab.quaternion.copy(this.truck.visual.quaternion).multiply(tilt);
    const rot = (o: THREE.Object3D | undefined, axis: THREE.Vector3, angle: number) => {
      if (!o) return;
      o.matrix.copy(o.userData.baseMatrix as THREE.Matrix4).multiply(new THREE.Matrix4().makeRotationAxis(axis, angle));
    };
    const deg = Math.PI / 180;
    const needle = (v: number, [max, angle]: [number, number]) => (Math.min(Math.max(v, 0), max * 1.05) / max) * angle * deg;
    rot(this.cabParts.rule, new THREE.Vector3(0, 1, 0), -steer * 2.4);
    rot(this.cabParts.speed, new THREE.Vector3(0, 1, 0), needle(this.truck.speedKmh, this.def.speedScale));
    rot(this.cabParts.tacho, new THREE.Vector3(0, 1, 0), needle(this.truck.rpm / 60, this.def.tachScale));
  }

  /** Крок гри (також для тестів — без requestAnimationFrame). */
  update(dt: number): void {
    if (this.paused) return;
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
    this.updateDayTime(dt);
    this.updateCamera(dt);
    this.updateCab(state.steer);
    this.world.update(this.camera, this.truck.visual.position);
    this.careerMode?.update(dt, state.throttle);
    this.map?.update(dt, this.truck.visual.position, this.truck.forward(), this.traffic?.cars.map((c) => c.pos) ?? [], this.careerMode?.target() ?? null);
    const drive = `${Math.round(this.truck.speedKmh)} км/год   ${this.truck.gear < 0 ? 'R' : this.truck.gear === 0 ? 'N' : this.truck.gear}   ${Math.round(this.truck.rpm)} об/хв`;
    this.bar.textContent = this.careerMode ? `${drive}
${this.careerMode.hud()}` : drive;
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
    this.careerMode?.persist();
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('driving');
    this.input.dispose();
    this.touch?.remove();
    this.map?.dispose();
    this.hud.remove();
    this.bar.remove();
    this.audio?.dispose();
    this.cabAsm?.dispose();
    this.music?.dispose();
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
