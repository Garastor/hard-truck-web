import RAPIER from '@dimforge/rapier3d-compat';
import { HT2_ENGINE, HT2_INPUT, HT2_ROLL_LIFT, HT2_STEER_LIMIT, HT2_STEER_POWER, HT2_BRAKE } from './vehicles/controls';
import * as THREE from 'three';
import type { FileSource } from '@engine/assets/source';
import { EngineAudio } from '@engine/audio/engineAudio';
import { levelCollision } from '@engine/physics/collision';
import { TruckVehicle } from '@engine/vehicle/truckVehicle';
import { buildTruckModel, type TruckDef } from '@engine/vehicle/trucks';
import { Input } from '@engine/input/input';
import { GROUP_WORLD, addCollisionPolys, g2t, groups, initRapier } from '@engine/physics/world';
import { assoc, num, readSch, str, type SExpr } from '@engine/formats/sexpr';
import { drivable, loadTrucks, truckDef, type Ht2Trucks } from './vehicles/trucks';
import { FOV } from './ui/viewer';
import { Ht2World, toThree, type LoadedRegion } from './world/world';
import { AutoPilot } from '@engine/vehicle/autopilot';
import { Ht2Roads } from './world/roads';
import { Traffic, trafficKinds } from './traffic/traffic';
import { CareerMode } from './career/careerMode';
import { Police, SPEED_LIMIT } from './traffic/police';
import { Mafia } from './traffic/mafia';
import { Signs } from './world/signs';
import { Markets, parseMarkets } from './career/market';
import { WorldMap, type MapPoint } from './world/worldMap';
import { GlassRain } from '@engine/render/glassRain';
import { Dents } from './vehicles/dents';
import { terrainCollider } from './world/terrain';
import { parseMsk } from '@engine/formats/msk';
import { findStores } from './career/economy';
import { Climate, sunHeight, trafficLights } from './world/climate';
import { iniNum, parseIni } from '@engine/formats/ini';
import { decodeCp1251 } from '@engine/formats/binary';
import { RaceMode } from './race';
import { Trailer } from './vehicles/trailer';
import { Truckers, truckerKinds, truckerNames } from './traffic/truckers';
import { parseUpgrades, tuning, type Tuning } from './career/upgrades';
import { parseServices, parseTowns } from './career/economy';
import { NavMap } from '@engine/ui/navMap';
import { Music } from './ui/music';
import { SceneAssembler } from '@engine/render/sceneBuilder';
import { parseB3d } from '@engine/formats/b3d';
import { parseRmp } from '@engine/formats/rmp';
import type { Ht2Career } from './career/career';
import { HT2_MOD_REGIONS, readTextures } from './files';
import { timeScale, type Ht2Settings } from './ui/settings';
import { EscArt } from './ui/escArt';
import { Tablo } from './ui/tablo';
import { Cards } from './ui/cards';

/**
 * Камера за машиною — підібрана так, щоб кадр збігся зі знімком оригіналу в тій самій точці (ZilR біля бази «Южный»,
 * позиція й курс — з телеметрії king.exe): 13,3 м позаду початку моделі в порту (у памʼяті гри — 8,8 м позаду точки
 * машини, отже та на ≈ 4,5 м позаду початку моделі), 4,2 м над ним (5,3 м над землею), нахил униз ≈ 17,5°.
 * Кут огляду — вертикальний 2·atan(0,45·4/3) ≈ 62°: ypyramid = 0,9 з TRUCK.INI, перераховане на екран 4:3
 * (з 48,5° вантажівка займала півкадру проти третини в оригіналі). Для інших машин — гіпотеза (ті самі числа).
 */
const CHASE_BACK = 13.3;
const CHASE_UP = 4.2;
const CHASE_PITCH = Math.asin(0.3);
const CHASE_FOV = THREE.MathUtils.radToDeg(2 * Math.atan(0.45 * (4 / 3)));
/** Запізнення камери за машиною, с (оригінал: відстань позаду = 8,8 м + 0,58 с × швидкість, повертається за ≈ 1,5 с). */
const CHASE_LAG = 0.6;
/** Точка погляду — на цій відстані від місця камери в спокої під нахилом CHASE_PITCH (біля машини), м. */
const CHASE_LOOK = 10;

/** Опір кочення поза асфальтом, множник (телеметрія king.exe: узбіччя ≈ +0,06 g). */
const OFFROAD_ROLL = 5;

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
  /** Напівпричіп для тягача (car_node запису `trailers`); типово — STrailerM. */
  trailer?: string | null;
  /** Погода для перевірки: `bad` — одразу негода з дощем, `good` — без змін погоди. */
  weather?: string | null;
  /** Налаштування одиночної гри (екран s/backsing). */
  settings?: Ht2Settings | null;
  /** Кар'єра (гроші, замовлення); без — вільна їзда. */
  career?: Ht2Career | null;
  /** Гонка на Кільці (регіон dr) з суперниками. */
  race?: boolean;
}

type CamMode = 'chase' | 'cockpit' | 'far';
const NEXT_CAM: Record<CamMode, CamMode> = { chase: 'cockpit', cockpit: 'far', far: 'chase' };

export class Ht2Drive {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000);
  private rapier!: RAPIER.World;
  truck!: TruckVehicle;
  /** Напівпричіп (лише в тягачів). */
  trailer: Trailer | null = null;
  private def!: TruckDef;
  /** Керування й двигун — криві Дальнобойщиків 2 (телеметрія king.exe, controls.ts). */
  private readonly input = new Input(HT2_INPUT);
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
  police: Police | null = null;
  mafia: Mafia | null = null;
  private signs: Signs | null = null;
  markets: Markets | null = null;
  private worldMap: WorldMap | null = null;
  /** Коротке повідомлення на табло (текст і скільки ще показувати, с). */
  private notice: { text: string; time: number } | null = null;
  /** Графіка інтерфейсу оригіналу (COMMON/esc16.RES) і верхнє табло з пейджером; без файлу — табло порту. */
  escArt: EscArt | null = null;
  tablo: Tablo | null = null;
  /** Картки подій (штрафи, неустойки, «Заказ выполнен», мафія) праворуч під табло. */
  cards: Cards | null = null;
  private disposed = false;
  race: RaceMode | null = null;
  truckers: Truckers | null = null;
  private raceMessages = new Map<string, string>();
  private map: NavMap | null = null;
  private music: Music | null = null;
  /** Кабіна (вид з кабіни): інтер'єр з CABINES.B3D окремою сценою поверх світу, як у першій грі. */
  private readonly overlayScene = new THREE.Scene();
  private cab: THREE.Group | null = null;
  private cabParts: { rule?: THREE.Object3D; speed?: THREE.Object3D; tacho?: THREE.Object3D } = {};
  private cabAsm: SceneAssembler | null = null;
  /** Вода на склі кабіни й двірники (як у першій грі: маски glass_1/glass_2.msk з CABINES.RES, Wiper*). */
  private glassRain: GlassRain | null = null;
  /** Вмʼятини гравця (перемикачі пошкоджень моделі); у кар'єрі — зберігаються. */
  dents: Dents | null = null;
  private readonly prevVel = new THREE.Vector3();
  private freeDents: Record<string, number> = {};
  /** Габарити (SizeLightKey моделі). */
  private setTruckSwitch: ((n: string, s: number) => void) | undefined;
  private cabRmp: ReturnType<typeof parseRmp> | null = null;
  private shelterTimer = 0;
  private sheltered = false;
  private cabLoading = false;
  private cabLight: THREE.AmbientLight | null = null;
  /** Пауза (вікно складу чи СТО): фізика й час стоять. */
  paused = false;
  /** Ігровий час вільної їзди, с від півночі (кар'єра — свій); старт — 10:00 (TRUCK.INI timestart=10). */
  private freeTime = 10 * 3600;
  /** Доба й погода як у king.exe (climate.ts): показник погоди, дощ, грім, вітер; дощ — слизька дорога. */
  private climate = new Climate();
  raining = false;
  /** Блискавка: час до наступної (с), час спалаху, спрайт `flash`. */
  private boltTimer = 0;
  private flashTime = 0;
  private bolt: THREE.Sprite | null = null;
  private rainSound: ReturnType<EngineAudio['loopSound']> = null;
  private windSound: ReturnType<EngineAudio['loopSound']> = null;
  private tick = 0;
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
    let start: [number, number, number] = sp ? [num(sp[1]), num(sp[2]), num(sp[3])] : [-3020, -4625, 20];
    if (o.race) {
      // Гонка — старт на решітці Кільця (start1_1 у ENV/dr.way).
      const node = this.world.regions.get('dr')?.way.rooms.flatMap((r) => r.nodes).find((n) => n.name === 'start1_1');
      if (node) start = node.pos;
    }
    const live = cnf ? assoc(assoc(cnf, 'playertypes')?.slice(1) ?? [], 'live') : undefined;
    const want = o.career?.truck || o.truck || (live ? str(live[2]) : 'ZilR');
    const list = drivable(this.trucks);
    const rec = list.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? list[0];
    const def = rec && truckDef(this.trucks, rec);
    if (!def) throw new Error('Немає моделі вантажівки');
    this.def = def;
    if (o.career && !o.career.truck) o.career.truck = def.carNode;
    this.tank = rec.tank * this.tuning.tank;
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
    if (!saved && rec.group === 'tractors' && !o.race && o.trailer !== 'none') {
      // Старт бази (GAME.CNF) — упритул до будівлі позаду: причіп (до 14 м) зʼявлявся б у ній. Тягач — на 10 м
      // далі дорогою.
      const ahead = spawn.position.clone().addScaledVector(spawn.forward, 10);
      spawn.position.copy(this.groundAt(ahead.setY(ahead.y - 2.5)));
    }
    // Динамічна модель: перемикачі пошкоджень і вогнів (вмʼятини, габарити).
    const model = buildTruckModel(this.trucks.asm, def, true);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    this.cargoMass = o.career?.order ? o.career.order.goods.mass * o.career.order.units : 0;
    this.truck = new TruckVehicle(this.rapier, def, model, spawn, this.setup(this.cargoMass));
    this.truck.visual.userData.model = model;
    this.truck.setDamage({ power: 1, lostGears: 0, brakes: this.tuning.brakes });
    this.world.scene.add(this.truck.visual);
    this.hitch();
    this.mountLamps();
    this.safe = spawn;
    this.cockpit = g2t(def.tech.viewer);
    this.camPos.copy(spawn.position).addScaledVector(spawn.forward, -14).add(new THREE.Vector3(0, 6, 0));
    this.camLook.copy(spawn.position);

    // Описи регіонів (міста, товари, СТО, вказівники) — необовʼязкові файли.
    const mods = await Promise.all(HT2_MOD_REGIONS.map((region) => o.source.read(`ENV/mod_${region}.sch`).then((b) => ({ region, sch: readSch(b) })).catch(() => null)));
    const regionMods = mods.filter((m): m is { region: string; sch: SExpr[] } => !!m);
    if (!o.race) this.signs = new Signs(regionMods, this.world.regions.values());
    // Карта світу: склади (міста з mod_*.sch), СТО, заправки, ринки.
    const points: MapPoint[] = findStores(this.world.regions.values(), parseTowns(regionMods)).map((s) => ({ pos: toThree(...s.center), kind: 'town' as const, label: s.town }));
    for (const r of this.world.regions.values())
      for (const room of r.way.rooms)
        for (const n of room.nodes) {
          if (/^sto_/i.test(n.name)) points.push({ pos: toThree(...n.pos), kind: 'sto' });
          if (/^node_car_fuel/i.test(n.name)) points.push({ pos: toThree(...n.pos), kind: 'fuel' });
        }
    for (const m of parseMarkets(regionMods, this.world.regions.values())) points.push({ pos: m.spots[0].pos, kind: 'market', label: m.name });
    this.worldMap = new WorldMap(document.body, this.roads.lines.filter((l) => !l.name.endsWith('r')), points);
    this.worldMap.onClose = () => {
      this.paused = false;
    };
    if (o.career) this.markets = new Markets(this.world.scene, this.rapier, this.trucks, parseMarkets(regionMods, this.world.regions.values()), (p) => this.groundAtPublic(p).y - 2.5);
    if (o.career) {
      const [merch, messages, restable] = await Promise.all([
        o.source.read('merchandise.sch').then(readSch).catch(() => []),
        o.source.read('Ms.sch').then(readSch).catch(() => []),
        o.source.read('restable.sch').then(readSch).catch(() => []),
      ]);
      this.careerMode = new CareerMode(this, o.career, merch, messages, parseUpgrades(restable), parseTowns(regionMods), parseServices(regionMods));
      this.police = new Police(this.world.scene, this.rapier, this.trucks, this.world.regions.values());
      this.mafia = new Mafia(this.world.scene, this.rapier, this.trucks, this.world.regions.values(), (p) => this.groundAtPublic(p).y - 2.5);
    }
    if (o.race) {
      const ms = await o.source.read('Ms.sch').then(readSch).catch(() => []);
      for (const m of ms) if (Array.isArray(m) && typeof m[0] === 'string') this.raceMessages.set(m[0], str(m[m.length - 1]));
      this.race = new RaceMode(this, this.roads, (k, fb) => this.raceMessages.get(k) ?? fb);
      this.race.onFinish = () => o.onExit();
    }
    // Погода: повзунок «погода» і TRUCK.INI [EFFECTS] wtemp (період зміни, реальних годин); ?weather=bad|good — стала.
    const ini = await o.source.read('TRUCK.INI').then((b) => parseIni(decodeCp1251(b))).catch(() => null);
    const wtemp = ini ? iniNum(ini, 'EFFECTS', 'wtemp', 0.13) : 0.13;
    this.climate = new Climate(o.settings?.weather ?? 0.6, wtemp, o.weather === 'bad' ? 'bad' : o.weather ? 'good' : null);
    const vehicles = await o.source.read('evehicles.sch').then(readSch).catch(() => []);
    if (!o.race) {
      const names = await o.source.read('names.sch').then(readSch).catch(() => []);
      this.truckers = new Truckers(this, this.roads, truckerNames(names), (r) => this.world.loaded.has(r), truckerKinds(vehicles, this.trucks), Math.round(4 * (o.settings?.traffic ?? 1)));
    }
    this.traffic = new Traffic(this.world.scene, this.rapier, this.roads, this.trucks, trafficKinds(vehicles, this.trucks), (r) => this.world.loaded.has(r), Math.round(12 * (o.settings?.traffic ?? 1)));
    this.audio = await EngineAudio.create(this.world.commonRmp).catch(() => null);
    this.input.onCommand = (cmd) => {
      if (cmd === 'camera') this.camMode = NEXT_CAM[this.camMode];
      if (cmd === 'autopilot') {
        this.autopilot = this.autopilot ? null : new AutoPilot(this.roads);
        // З напівпричепом — повільніше в поворотах (кермо на швидкості обмежене).
        if (this.autopilot && this.trailer) Object.assign(this.autopilot, { cruise: 45, bendGain: 5, bendFloor: 0.25 });
      }
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
    const map = document.createElement('button');
    map.textContent = 'Карта';
    map.setAttribute('aria-label', 'Карта світу');
    map.addEventListener('click', () => this.openMap());
    this.hud.append(back, music, map);
    // У шарі overlay — під вікнами складу й СТО (вони теж там, вище).
    o.overlay.append(this.hud, this.bar);
    void EscArt.load(o.source).then((art) => {
      if (!art || this.disposed) return;
      this.escArt = art;
      this.tablo = new Tablo(art, o.overlay);
      this.tablo.onPage = () => this.audio?.playOnce('pager');
      this.cards = new Cards(art, o.overlay);
      document.body.classList.add('ht2-orig-ui');
      this.resize();
    });
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
    // Процедурний рельєф (aa) — heightfield.
    if (reg.terrain) cs.push(terrainCollider(this.rapier, reg.terrain));
    const floor = addCollisionPolys(this.rapier, col.floors, 1.0);
    const walls = addCollisionPolys(this.rapier, col.walls, 0.4);
    if (floor) cs.push(floor);
    if (walls) cs.push(walls);
    if (!col.hasFloor && !reg.terrain) {
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
    // Від фізичного тіла (модель синхронізується лише в кадрі).
    const t = this.truck.body.translation();
    const position = new THREE.Vector3(t.x, t.y + 0.3, t.z);
    const forward = this.truck.forward();
    const model = buildTruckModel(this.trucks.asm, this.def, true);
    if (!model) return;
    this.world.scene.remove(this.truck.visual);
    this.truck.dispose();
    this.truck = new TruckVehicle(this.rapier, this.def, model, { position, forward }, this.setup(mass));
    this.truck.visual.userData.model = model;
    this.truck.setDamage({ power: 1, lostGears: 0, brakes: this.tuning.brakes });
    this.world.scene.add(this.truck.visual);
    this.hitch();
    this.mountLamps();
  }

  /** Карта світу поверх гри (гра на паузі, поки карта відкрита). */
  openMap(): void {
    if (!this.worldMap || this.paused) return;
    this.paused = true;
    const t = this.truck.body.translation();
    this.worldMap.open(new THREE.Vector3(t.x, t.y, t.z), this.truck.forward(), this.careerMode?.target() ?? null);
  }

  /** Кадрів після перестановки машини, коли удари не рахуємо (стрибок швидкості — не удар). */
  private skipHits = 0;

  /**
   * Удари: різка зміна горизонтальної швидкості за кадр (понад 2 м/с) — вмʼятина в зоні, звідки прийшов удар
   * (зміна швидкості в системі машини, dents.ts).
   */
  private detectHits(): void {
    const lv = this.truck.body.linvel();
    const v = new THREE.Vector3(lv.x, 0, lv.z);
    const dv = v.clone().sub(this.prevVel);
    this.prevVel.copy(v);
    if (this.skipHits > 0) {
      this.skipHits--;
      return;
    }
    if (dv.length() < 2) return;
    this.dents?.hit(dv.applyQuaternion(this.truck.visual.quaternion.clone().invert()));
  }

  /** Ігрових секунд за реальну (повзунок «тривалість доби»). */
  get timeScale(): number {
    return timeScale(this.opts.settings);
  }

  /** Аркада: менші пошкодження й витрата пального (гіпотеза, settings.ts). */
  get arcade(): boolean {
    return !!this.opts.settings?.arcade;
  }

  /** Покращення кар'єри (restable.sch) — множники моменту, гальм, зчеплення, бака (гіпотези, див. upgrades.ts). */
  get tuning(): Tuning {
    return tuning(this.opts.career?.upgrades);
  }

  /** Параметри фізики вантажівки: вантаж (у тягача — у причепі), покращення. */
  private setup(cargo: number) {
    const t = this.tuning;
    return { cargoMass: this.hitched ? 0 : cargo, torque: t.torque, grip: t.grip, engine: HT2_ENGINE, rollLift: HT2_ROLL_LIFT, steerLimit: HT2_STEER_LIMIT, steerPower: HT2_STEER_POWER, brake: HT2_BRAKE, surfaceEffects: !this.arcade };
  }

  /** Запис vehicle.tech поточної вантажівки. */
  private get rec() {
    return this.trucks.records.find((r) => r.carNode === this.def.carNode);
  }

  /** Тягач (vehicle.tech: група tractors) — вантаж везе напівпричіп. */
  private get hitched(): boolean {
    return this.rec?.group === 'tractors';
  }

  /**
   * Напівпричіп тягача: STrailerM (кузов-модуль) або заданий; у «Шторма» — свій STrailerStorm. Вантаж — у
   * причепі. Старий причіп прибираємо.
   */
  private hitch(): void {
    this.skipHits = 3;
    // Нова модель — перемикачі вмʼятин і вогнів (стан пошкоджень — з кар'єри).
    const m = this.truck.visual.userData.model as { setSwitch?: (n: string, s: number) => void; switchStates?: (n: string) => number } | undefined;
    this.setTruckSwitch = m?.setSwitch;
    this.dents = new Dents(this.opts.career ? (this.opts.career.dents ??= {}) : this.freeDents, m?.setSwitch, m?.switchStates);
    // Нова машина — дощ знову робить дорогу слизькою (зчеплення ×0,8, як у першій грі).
    this.truck.weatherGrip = this.raining ? 0.8 : 1;
    if (this.trailer) {
      this.world.scene.remove(this.trailer.visual);
      this.trailer.dispose();
      this.trailer = null;
    }
    const rec = this.rec;
    // Гонка на Кільці — без причепів (як у суперників).
    if (!rec || rec.group !== 'tractors' || this.opts.trailer === 'none' || this.opts.race) return;
    const trailers = this.trucks.records.filter((r) => r.group === 'trailers');
    const want = /^Storm/i.test(rec.carNode) ? 'STrailerStorm' : this.opts.trailer || 'STrailerM';
    const tr = trailers.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? trailers[0];
    const def = tr && truckDef(this.trucks, tr);
    if (!tr || !def) return;
    this.trailer = new Trailer(this.rapier, this.trucks.asm, def, tr, { body: this.truck.body, saddle: rec.lowSaddle }, this.cargoMass);
    this.world.scene.add(this.trailer.visual);
    this.truck.towing = true;
    const trailerBody = this.trailer.body.handle;
    this.truck.rayFilter = (c) => c.parent()?.handle !== trailerBody;
    this.truck.setTowLoad(this.trailer.kingpinLoad);
  }

  /** Вантажопідйомність і обʼєм (площа × висота, гіпотеза): кузова вантажівки або напівпричепа. */
  get cargoSpace(): { mass: number; volume: number } {
    const t = this.trailer?.rec ?? this.def.tech;
    return { mass: t.cargoLoad, volume: Math.max(1, t.bodySquare * t.bodyHeight) };
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

  /** Година доби гри (0…24). */
  get hour(): number {
    const t = this.careerMode ? this.careerMode.career.time : this.freeTime;
    return (t / 3600) % 24;
  }

  /**
   * Доба й погода (climate.ts): світло й туман плавно, дощ (w > 0,7) — слизька дорога й шум, вітер — дерева й шум,
   * грім (w ≥ 0,8) — блискавка раз на 10 с. Фари гравця — у сутінках і вночі (висота сонця < 0,2) або клавішею L;
   * трафік вмикає фари з 22:00 до 6:00.
   */
  private updateDayTime(dt: number): void {
    if (!this.careerMode) this.freeTime += dt * this.timeScale;
    const hour = this.hour;
    const c = this.climate;
    if (!this.race) c.update(dt);
    if (c.rain !== this.raining) {
      this.raining = c.rain;
      this.truck.weatherGrip = this.raining ? 0.8 : 1;
      this.say(this.raining ? 'Дощ: дорога слизька' : 'Дощ скінчився', 4);
    }
    this.updateThunder(dt);
    this.tick++;
    // Спалах: розсіяне світло (0,9, 1, 1) через кадр протягом 1 с (king.exe 0x005a9540).
    this.world.setClimate(hour, c.bad, this.flashTime > 0 && this.tick % 2 === 1);
    this.world.updateTrees(dt, c.wind);
    const dusk = sunHeight(hour) < 0.2;
    this.world.setNight(dusk);
    this.cabLight?.color.copy(this.world.ambientColor).multiplyScalar(1.4);
    if (this.traffic) this.traffic.lights = trafficLights(hour);
    this.rainSound ??= this.audio?.loopSound('rain') ?? null;
    this.windSound ??= this.audio?.loopSound('wind') ?? null;
    this.rainSound?.set(this.sheltered ? 0 : c.rainVolume);
    this.windSound?.set(c.windVolume);
    const on = this.lightsManual ?? dusk;
    for (const l of this.lamps) l.visible = on;
    // Габарити вантажівки (SizeLightKey: 1 — горять) — разом з фарами.
    this.setTruckSwitch?.('refer_SizeLightKey', on ? 1 : 0);
  }

  /**
   * Грім (king.exe 0x005a5400): раз на 10 с — блискавка (спрайт `flash` COMMON) за 300 м перед камерою, убік
   * ±300 м, на 20 м вище; 1 с — спалах світла; звук `thunder`. Розмір і тривалість спрайта — гіпотеза.
   */
  private updateThunder(dt: number): void {
    this.flashTime = Math.max(0, this.flashTime - dt);
    if (this.bolt) {
      this.bolt.visible = this.flashTime > 0.6 && this.tick % 3 !== 0;
      // Текстура flash — 8 кадрів у ряд (ефект 0x005a4880: 8 кадрів): кадр за часом спалаху.
      const map = this.bolt.material.map;
      if (map) map.offset.x = Math.min(7, Math.floor((1 - this.flashTime) * 20)) / 8;
    }
    if (!this.climate.thunder) return;
    if ((this.boltTimer -= dt) > 0) return;
    this.boltTimer = 10;
    this.flashTime = 1;
    if (!this.bolt) {
      const asm = this.world.common;
      const i = asm.b3d.materials.findIndex((m) => m.toLowerCase() === 'flash');
      const src = i >= 0 ? (asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
      if (!src) return;
      const map = src.clone();
      map.repeat.set(1 / 8, 1);
      this.bolt = new THREE.Sprite(new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      // Низ спрайта — у точці блискавки (гіпотеза: спрайт тягнеться вгору від неї).
      this.bolt.center.set(0.5, 0);
      this.bolt.scale.set(40, 160, 1);
      this.world.scene.add(this.bolt);
    }
    const fwd = new THREE.Vector3();
    this.camera.getWorldDirection(fwd);
    fwd.y = 0;
    fwd.normalize();
    const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
    this.bolt.position.copy(this.camera.position).addScaledVector(fwd, 300).addScaledVector(side, Math.random() * 600 - 300);
    this.bolt.position.y += 20;
    this.audio?.play('thunder', 0.8);
  }

  /** Для гонки: поверхня під точкою, дані вантажівок, світ фізики. */
  groundAtPublic(p: THREE.Vector3): THREE.Vector3 {
    return this.groundAt(p);
  }
  get trucksData(): Ht2Trucks {
    return this.trucks;
  }
  get rapierWorld(): RAPIER.World {
    return this.rapier;
  }

  /** Вантажівки, якими можна кермувати (для магазину). */
  drivableTrucks() {
    return drivable(this.trucks);
  }

  /** Інша вантажівка (купівля): нова модель і фізика на тому ж місці, свій бак, кабіна, фари. */
  changeTruck(carNode: string): void {
    const rec = drivable(this.trucks).find((r) => r.carNode === carNode);
    const def = rec && truckDef(this.trucks, rec);
    if (!rec || !def) return;
    this.def = def;
    this.tank = rec.tank * this.tuning.tank;
    this.fuelConsumption = rec.fuelConsumption;
    this.cabPrefix = rec.prefixCab;
    this.cockpit = g2t(def.tech.viewer);
    if (this.cab) {
      this.overlayScene.remove(this.cab);
      this.glassRain?.dispose();
      this.glassRain = null;
      this.cab = null;
    }
    this.setCargo(this.cargoMass);
  }

  /** Нові покращення: бак і перебудова фізики вантажівки (момент, гальма, зчеплення — при створенні). */
  applyTuning(): void {
    const rec = this.rec;
    if (rec) this.tank = rec.tank * this.tuning.tank;
    this.setCargo(this.cargoMass);
  }

  /** Відновитися: на останню надійну точку дороги. */
  recover(): void {
    if (this.safe) this.truck.reset({ position: this.safe.position.clone(), forward: this.safe.forward.clone() });
    this.trailer?.reset();
    this.skipHits = 3;
  }

  private resize(): void {
    this.tablo?.resize();
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.opts.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // Табло — праворуч від кнопок «Меню», ♪, «Карта» (їхня ширина залежить від шрифту й екрана).
    const right = this.hud.getBoundingClientRect().right;
    if (right > 0) {
      this.bar.style.left = `${Math.round(right + 8)}px`;
      this.bar.style.maxWidth = `calc(100vw - ${Math.round(right + 8)}px - 4 * 52px - 24px)`;
    }
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
      // Вода на склі: зміни — на відеокарту, копія кадру зі світом для заломлення (до кабіни).
      this.glassRain?.prepare(r);
      r.render(this.overlayScene, this.camera);
      r.autoClear = auto;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
  }

  /** Інтер'єр кабіни `<prefixCab>Cab` (CABINES.B3D, текстури CABINES.RES) — вантажиться при першому вигляді з кабіни. */
  private async loadCab(): Promise<void> {
    if (this.cabLoading || this.cab) return;
    this.cabLoading = true;
    try {
      if (!this.cabAsm) {
        const [b3d, res] = await Promise.all([this.opts.source.read('COMMON/CABINES.B3D'), readTextures(this.opts.source, 'COMMON/CABINES.RES')]);
        this.cabRmp = parseRmp(res);
        this.cabAsm = new SceneAssembler(parseB3d(b3d), this.cabRmp, { lit: true, colorKey: true, nearGroup: 0, type4Space: true, palette: this.world.common.lib.palette ?? undefined });
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
      // Скло (GlassKey, група 1) — завжди: його текстуру (краплі) малює GlassRain, суха — прозора.
      dyn.setSwitch('GlassKey', 1);
      const rmp = this.cabRmp!;
      const mask = (n: string) => {
        const b = rmp.masks.get(n);
        return b ? parseMsk(b, this.cabAsm!.lib.palette ?? undefined) : null;
      };
      this.glassRain = new GlassRain(inner, mask('txr/glass_1.msk'), mask('txr/glass_2.msk'));
      this.glassRain.onStroke = () => this.audio?.play('wipers', 0.9);
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
    if (this.glassRain) {
      // Під дахом (тунель, міст — промінь угору влучає в геометрію) нових крапель немає.
      if ((this.shelterTimer -= 1 / 30) <= 0) {
        this.shelterTimer = 0.5;
        const t = this.truck.body.translation();
        this.sheltered = this.raining && !!this.rapier.castRay(new RAPIER.Ray({ x: t.x, y: t.y + 3, z: t.z }, { x: 0, y: 1, z: 0 }), 60, true);
      }
      this.glassRain.raining = this.raining && !this.sheltered;
      this.glassRain.wipersOn = this.raining;
      this.glassRain.update(1 / 30, this.truck.speedKmh);
    }
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

  /**
   * Покриття під машиною: поза асфальтом (далі від осі дороги WAY, ніж половина її ширини) — опір кочення ×5 (у порту: −0,53…0,66 м/с² на 4-й–5-й, як виміряно).
   * Телеметрія king.exe (симулятор, ZilR): на узбіччі прискорення на 4-й/5-й передачі на ≈ 0,6 м/с² менше, ніж на
   * асфальті (≈ +0,06 g опору). Зчеплення поза дорогою — як на асфальті (не виміряно, гіпотеза).
   */
  private updateSurface(): void {
    const p = this.truck.visual.position;
    const n = this.roads?.nearest(p);
    if (!n) return;
    const a = n.line.pts[n.seg];
    const b = n.line.pts[n.seg + 1];
    // Лінії руху зсунуті на w/4 від осі: на дорозі, якщо до найближчої лінії ≤ w/4 (по горизонталі).
    const qx = a.x + (b.x - a.x) * n.t - p.x;
    const qz = a.z + (b.z - a.z) * n.t - p.z;
    const off = Math.hypot(qx, qz) > n.line.width / 4 + 0.5;
    this.offRoad = off;
    this.truck.setSurface(1, off ? OFFROAD_ROLL : 1);
  }

  /** Машина поза дорогою (для тестів). */
  offRoad = false;

  /** Крок гри (також для тестів — без requestAnimationFrame). */
  update(dt: number): void {
    if (this.paused) return;
    this.input.speedKmh = this.truck.speedKmh;
    const manual = this.input.update(dt);
    const tp = this.truck.body.translation();
    const rivals = this.truckers?.positions ?? [];
    let state = this.autopilot ? this.autopilot.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.truck.forward(), this.truck.speedKmh, dt, [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...rivals]) : manual;
    if (this.race?.holding) state = { ...state, throttle: 0, brake: 1 };
    this.traffic?.update(dt, this.truck.visual.position, [...(this.trailer?.points() ?? []), ...rivals]);
    const obstacles = [this.truck.visual.position, ...(this.trailer?.points() ?? []), ...(this.traffic?.cars.map((c) => c.pos) ?? [])];
    this.updateSurface();
    this.acc += dt;
    const step = this.rapier.timestep;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.trailer?.update(step, this.truck.brakePedal(state), this.def.tech.brakePower);
      this.race?.control(step);
      this.truckers?.control(step, obstacles);
      this.rapier.step();
      this.acc -= step;
    }
    this.race?.after(dt);
    this.detectHits();
    this.truckers?.after(dt, this.truck.visual.position);
    this.truck.syncVisual();
    this.trailer?.syncVisual();
    this.audio?.update(this.truck.rpm, state.throttle, this.truck.engineOn);
    this.trackSafe(dt);
    this.updateDayTime(dt);
    this.updateCamera(dt);
    this.updateCab(state.steer);
    this.world.update(this.camera, this.truck.visual.position);
    this.careerMode?.update(dt, state.throttle);
    const fine = this.police?.update(dt, this.truck.visual.position, this.truck.speedKmh);
    if (fine && this.careerMode && !this.tuning.antiRadar) void this.careerMode.fine(fine.over, SPEED_LIMIT);
    // Мафія полює лише на вантажі класу formafia (merchandise.sch: горілка, алмази, Pentium III…).
    const mafia = this.careerMode && !this.paused ? this.mafia?.update(dt, this.truck.visual.position, !!this.careerMode.career.order?.goods.forMafia) : null;
    if (mafia === 'robbed') void this.careerMode!.robbed();
    if (mafia === 'escaped') this.say('Мафія відстала', 4);
    if (this.markets && this.careerMode) this.markets.update(this.truck.visual.position, Math.floor(this.careerMode.career.time / 86400));
    const sign = this.signs?.update(this.truck.visual.position, this.truck.forward());
    if (sign) this.say(sign, 6);
    const chaser = this.mafia?.chaser;
    this.map?.update(dt, this.truck.visual.position, this.truck.forward(), [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...(this.truckers?.positions ?? []), ...(chaser ? [chaser] : [])], this.careerMode?.target() ?? null);
    const drive = `${Math.round(this.truck.speedKmh)} км/год   ${this.truck.gear < 0 ? 'R' : this.truck.gear === 0 ? 'N' : this.truck.gear}   ${Math.round(this.truck.rpm)} об/хв`;
    // Поруч далекобійник — його імʼя й машина (names.sch, vehicle.tech).
    const near = this.truckers?.nearest(this.truck.visual.position);
    let who = near ? `\n${near.name} (${near.truck.def.carNode})` : '';
    const chase = this.mafia?.chase;
    if (chase) who += `\nМАФІЯ позаду: ${Math.round(chase.pos.distanceTo(this.truck.visual.position))} м`;
    if (this.notice && (this.notice.time -= dt) > 0) who += `\n${this.notice.text}`;
    if (this.tablo) {
      // Табло оригіналу: швидкість, передача, пальне, стан і час замовлення — на ньому; у рядку — решта.
      this.drawTablo(dt, state.handbrake);
      this.cards?.update(dt);
      this.bar.textContent = (this.careerMode ? this.careerMode.hud(true) : this.race ? this.race.hud() : '') + who;
    } else this.bar.textContent = (this.careerMode ? `${drive}\n${this.careerMode.hud()}` : this.race ? `${drive}\n${this.race.hud()}` : drive) + who;
  }

  /** Повідомлення гравцю: на пейджер (з оригінальним інтерфейсом) чи в рядок табло на time с. */
  say(text: string, time = 5): void {
    if (this.tablo) this.tablo.message(text);
    else this.notice = { text, time };
  }

  private drawTablo(dt: number, handbrake: boolean): void {
    const c = this.careerMode?.career;
    const o = c?.order;
    this.tablo!.draw(dt, {
      timeLeft: o ? (o.deadline - (c!.time - o.taken)) / this.timeScale : null,
      speed: this.truck.speedKmh,
      handbrake: handbrake || (!this.truck.engineOn && this.truck.speedKmh < 1),
      automatic: true,
      gear: this.truck.gear,
      rpm: this.truck.rpm,
      trailer: this.trailer ? 'on' : 'none',
      fuel: c ? (c.fuel ?? this.tank) / this.tank : 1,
      condition: c ? 1 - c.damage : 1,
    });
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
      this.camera.fov = FOV;
      this.camera.updateProjectionMatrix();
      return;
    }
    const fov = this.camMode === 'far' ? FOV : CHASE_FOV;
    if (this.camera.near !== 1 || this.camera.fov !== fov) {
      this.camera.near = 1;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // З напівпричепом — далі й вище: причіп (13 м) інакше закриває дорогу.
    const tow = this.trailer ? 1.7 : 1;
    // Камера за машиною — як в оригіналі (CHASE_*); «далека» — порту.
    const far = this.camMode === 'far';
    const dist = (far ? 28 : CHASE_BACK) * tow;
    const height = (far ? 12 : CHASE_UP) * tow;
    const flat = fwd.clone().setY(0).normalize();
    const want = v.position.clone().addScaledVector(flat, -dist).addScaledVector(up, height);
    if (far) {
      this.camPos.lerp(want, 1 - Math.exp(-dt * 4));
      this.camLook.lerp(v.position.clone().addScaledVector(up, 2), 1 - Math.exp(-dt * 10));
    } else {
      // Як в оригіналі (запис king.exe, ZilR від бази до греблі): по горизонталі камера відстає від свого місця з
      // запізненням CHASE_LAG (позаду 8,8 м на місці, 16 м на 46 км/год, 20 — на 70, 25,7 — на 100: 8,8 + 0,58·v; у
      // поворотах — убік до ±5 м), висота над машиною стала. Дивиться на точку біля машини — тож нахил сам зменшується
      // з відстанню (оригінал: 25° → 10° на 100 км/год).
      const k = 1 - Math.exp(-dt / CHASE_LAG);
      this.camPos.x += (want.x - this.camPos.x) * k;
      this.camPos.z += (want.z - this.camPos.z) * k;
      this.camPos.y += (want.y - this.camPos.y) * (1 - Math.exp(-dt * 10));
      const target = want.clone().addScaledVector(flat, CHASE_LOOK * Math.cos(CHASE_PITCH)).addScaledVector(up, -CHASE_LOOK * Math.sin(CHASE_PITCH));
      this.camLook.copy(target);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  dispose(): void {
    this.careerMode?.persist();
    this.rainSound?.stop();
    this.windSound?.stop();
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('driving');
    this.input.dispose();
    this.touch?.remove();
    this.map?.dispose();
    this.hud.remove();
    this.bar.remove();
    this.disposed = true;
    this.tablo?.dispose();
    this.cards?.dispose();
    document.body.classList.remove('ht2-orig-ui');
    this.audio?.dispose();
    this.glassRain?.dispose();
    this.cabAsm?.dispose();
    this.music?.dispose();
    this.traffic?.dispose();
    this.police?.dispose();
    this.mafia?.dispose();
    this.markets?.dispose();
    this.worldMap?.dispose();
    this.race?.dispose();
    this.truckers?.dispose();
    this.trailer?.dispose();
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
