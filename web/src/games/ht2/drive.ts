import RAPIER from '@dimforge/rapier3d-compat';
import { HT2_ENGINE, HT2_INPUT, HT2_KING, HT2_KING_BRAKE, HT2_KING_ENGINE, HT2_ROLL_LIFT, HT2_STEER_LIMIT, HT2_STEER_POWER, HT2_BRAKE } from './vehicles/controls';
import * as THREE from 'three';
import type { FileSource } from '@shared/source';
import { EngineAudio } from './engine/audio/engineAudio';
import { instanceCollision, levelCollision } from './engine/physics/collision';
import { TruckVehicle } from './engine/vehicle/truckVehicle';
import { ROUGH_ASPHALT, ROUGH_GROUND } from './engine/vehicle/kingModel';
import { buildTruckModel, type TruckDef } from './engine/vehicle/trucks';
import { Input } from './engine/input/input';
import { GROUP_WORLD, addCollisionPolys, g2t, groups, initRapier } from './engine/physics/world';
import { assoc, num, readSch, str, type SExpr } from './formats/sexpr';
import { drivable, loadTrucks, truckDef, type Ht2Trucks } from './vehicles/trucks';
import { FOV } from './ui/viewer';
import { Ht2World, toThree, type LoadedRegion } from './world/world';
import { AutoPilot } from './engine/vehicle/autopilot';
import { Ht2Roads } from './world/roads';
import { Traffic, recolor, trafficKinds } from './traffic/traffic';
import { Accidents } from './traffic/accidents';
import { TrafficLights } from './world/trafficLights';
import { CareerMode } from './career/careerMode';
import { Police, parseAmbushes, type PoliceEvent } from './traffic/police';
import { RED_LIGHT_FINE, bribeSum, copsTakeBribes, totalFine, wanted } from './career/law';
import { Mafia, parseMafiaAmbushes } from './traffic/mafia';
import { Signs } from './world/signs';
import { Markets, parseMarkets } from './career/market';
import { WorldMap, type MapPoint } from './world/worldMap';
import { GlassRain } from './engine/render/glassRain';
import { Dents } from './vehicles/dents';
import { terrainCollider } from './world/terrain';
import { parseMsk } from './engine/formats/msk';
import { findStores } from './career/economy';
import { Climate, sunHeight, trafficLights } from './world/climate';
import { iniNum, parseIni } from './engine/formats/ini';
import { decodeCp1251 } from './engine/formats/binary';
import { RaceMode } from './race';
import { Trailer } from './vehicles/trailer';
import { Truckers, truckerKinds, truckerNames } from './traffic/truckers';
import { parseUpgrades, tuning, type Tuning } from './career/upgrades';
import { parseServices, parseTowns } from './career/economy';
import { Music } from './ui/music';
import { SceneAssembler } from './engine/render/sceneBuilder';
import { parseB3d } from './engine/formats/b3d';
import { parseRmp } from './engine/formats/rmp';
import { REPAIR_PER_PERCENT, type Ht2Career } from './career/career';
import { HT2_MOD_REGIONS, readTextures } from './files';
import { saveSettings, steerGain, timeScale, type Ht2Settings } from './ui/settings';
import { EscArt } from './ui/escArt';
import { ukMessage } from './ui/uk';
import { EscMenu, type EscCommand } from './ui/escMenu';
import { FPanels, type FPanel } from './ui/fPanels';
import { TabMap } from './ui/tabMap';
import { Radio, type RadioAsk, type RadioContact } from './ui/radio';
import type { RivalRun } from './career/competition';
import { Navigator, type NavTurn } from './world/navigator';
import { WindDebris } from './world/windDebris';
import { Tablo } from './ui/tablo';
import { applyTabloSkin, lcdLabel } from './ui/tabloSkin';
import { Cards } from './ui/cards';

/** «☰» — ліва група кнопок; нота — музика (значки кольору тексту). */
const BURGER_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square"><path d="M4 6.5h16M4 12h16M4 17.5h16"/></svg>';
const NOTE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M9 4v11.5a3 3 0 1 0 2 2.8V8h7V4z"/></svg>';

/**
 * Камера за машиною — як у телеметрії king.exe (ZilR біля бази «Южный»): 8,8 м позаду точки машини, 5,3 м над землею
 * (4,2 м над початком моделі); нахил униз 26° — рядок «уперед» матриці камери (−0,90, 0, −0,437). Точка машини —
 * середина моделі вздовж курсу (гіпотеза: з нею ширина машини в кадрі збігається зі знімком оригіналу; у ZilR — 2,3 м
 * позаду початку моделі, що біля кабіни). Раніше камера стояла на 13,3 м позаду початку моделі — машина була вдвічі
 * меншою в кадрі.
 */
const CHASE_BACK = 8.8;
/**
 * Дзеркало заднього огляду (M) — лише з кабіни, посередині під табло, у рамці `m16\mirrT?.msk` з esc16.RES
 * (S/M/L/H — 170…480 px: розмір за роздільністю, гіпотеза; ≈ 30 % ширини екрана — тут найдетальніша H, масштабована).
 * Вікно рамки H — x 10…469, y 10…159. Кут огляду — підібраний (у king.exe не знайдено).
 */
const MIRROR_MASK = 'm16\\mirrth.msk';
const MIRROR_W = 480;
const MIRROR_H = 170;
const MIRROR_IN = [10, 10, 469, 159] as const;
const MIRROR_SHARE = 0.3;
const MIRROR_FOV = 20;
const CHASE_UP = 4.2;
const CHASE_PITCH = Math.asin(0.437);
/**
 * Кут огляду всіх камер — як у грі (king.exe 0x5972d0): ширина піраміди xpyramid з TRUCK.INI [EFFECTS] (типово
 * 1,6, клавішами 1,2…2,0) — тангенс половини горизонтального кута xpyramid/2, висота — за пропорцією екрана; у порту
 * — як на екрані 4:3 (xpyramid 2 — вертикаль ≈ 74°: обрій на знімку оригіналу на 15 % від верху), ширші екрани
 * бачать більше з боків. Раніше камера ззаду мала 62° з ypyramid [RENDER] і нахил 17,5° — неба було вдвічі більше.
 */
/** Середина видимої геометрії моделі вздовж напряму fwd відносно її початку, м. */
function modelMid(root: THREE.Object3D, fwd: THREE.Vector3): number {
  root.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  let lo = Infinity;
  let hi = -Infinity;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !o.visible) return;
    const a = o.geometry.attributes.position;
    for (let i = 0; i < a.count; i++) {
      const s = p.fromBufferAttribute(a, i).applyMatrix4(o.matrixWorld).sub(root.position).dot(fwd);
      lo = Math.min(lo, s);
      hi = Math.max(hi, s);
    }
  });
  return Number.isFinite(lo) ? (lo + hi) / 2 : 0;
}

function viewFov(xpyramid: number): number {
  return THREE.MathUtils.radToDeg(2 * Math.atan((xpyramid / 2) * (3 / 4)));
}
/** Запізнення камери за машиною, с (оригінал: відстань позаду = 8,8 м + 0,58 с × швидкість, повертається за ≈ 1,5 с). */
const CHASE_LAG = 0.6;
/** Точка погляду — на цій відстані від місця камери в спокої під нахилом CHASE_PITCH (біля машини), м. */
const CHASE_LOOK = 10;

/** Опір кочення поза асфальтом, множник (телеметрія king.exe: узбіччя ≈ +0,06 g). */
const OFFROAD_ROLL = 5;
/** Дальність видимості трафіку без туману в сцені, м. */
const VIEW_FALLBACK = 900;
/** 911: відлік до відновлення, с, і плата, $ (гіпотези — re/notes/ht2/ui.md §5). */
const RESCUE_SECONDS = 5;
const RESCUE_COST = 1000;
/** Рація: радіус зв'язку, м; скільки після штрафу можна домовитися, с; перемирʼя з мафією, с (гіпотези). */
const RADIO_R = 500;

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
  /** Вихід з їзди; next — куди далі (меню Esc: завантажити збережену гру, почати спочатку, вийти з гри). */
  onExit(next?: 'career' | 'new' | 'exit'): void;
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
  /** Дзеркало заднього огляду ввімкнене (видно лише з кабіни). */
  private mirrorOn = false;
  private mirror: {
    rt: THREE.WebGLRenderTarget;
    cam: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    ortho: THREE.OrthographicCamera;
    frame: HTMLElement;
  } | null = null;
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private cockpit = new THREE.Vector3();
  /** Середина моделі вздовж курсу відносно її початку, м (точка машини для камери) — для якої моделі пораховано. */
  private chaseMid = 0;
  private chaseFor: TruckVehicle | null = null;
  /** Згладжена висота машини для камери ззаду. */
  private camBaseY = NaN;
  private readonly colliders = new Map<string, RAPIER.Collider[]>();
  private acc = 0;
  private last = performance.now();
  /** Остання надійна точка на дорозі (для відновлення після падіння). */
  private safe: { position: THREE.Vector3; forward: THREE.Vector3 } | null = null;
  private safeTimer = 0;
  private readonly hud = document.createElement('div');
  /** Ліва група кнопок під «☰» і сама «☰» (згортається, коли відкрито бічну панель F1–F4). */
  private hudGroup: HTMLElement | null = null;
  private hudBurger: HTMLElement | null = null;
  private sidePanelOpen = false;
  /** Дотик поза бічною панеллю F1–F4 (не по кнопці) — закрити її; дотик проходить далі (кермо, педалі працюють). */
  private readonly onOutsideTap = (e: PointerEvent) => {
    if (this.fPanels?.open == null && !this.radio?.open) return;
    // Панель пропускає дотики крізь себе (pointer-events: none) — тож попадання в неї — за прямокутником.
    if ((e.target as Element | null)?.closest('button')) return;
    for (const p of document.querySelectorAll('.ht2-panel')) {
      const r = p.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return;
    }
    this.fPanels?.close();
    this.radio?.close();
  };
  private readonly bar = document.createElement('div');
  private touch: HTMLElement | null = null;
  /** Дороги всіх регіонів (WAY) і автопілот (клавіша P; для тестів — smoke). */
  roads!: Ht2Roads;
  autopilot: AutoPilot | null = null;
  traffic: Traffic | null = null;
  careerMode: CareerMode | null = null;
  police: Police | null = null;
  /** ДТП гравця (штраф за порушення ПДР при зіткненні, king.exe 0x4cfe70) — лише в кар'єрі. */
  accidents: Accidents | null = null;
  /** Світлофори (тригери 0x1D і лампи TrafficLightKey, king.exe 0x4ce160 / 0x56ffd0). */
  readonly lights = new TrafficLights();
  /** Хто з інспекторів COP1…COP15 бере хабар (names.sch). */
  private copBribes: boolean[] = [];
  /** Радар-детектор: фаза блимання лампи RD_LampKey і чи світить. */
  private radarBlink = 0;
  private radarLit = false;
  mafia: Mafia | null = null;
  private signs: Signs | null = null;
  markets: Markets | null = null;
  private worldMap: WorldMap | null = null;
  /** Коротке повідомлення на табло (текст і скільки ще показувати, с). */
  private notice: { text: string; time: number } | null = null;
  /** Графіка інтерфейсу оригіналу (COMMON/esc16.RES) і верхнє табло з пейджером; без файлу — табло порту. */
  escArt: EscArt | null = null;
  /** Графіка інтерфейсу ще читається (esc16.RES, 57 МБ) — вікна біля обʼєктів чекають на неї. */
  escArtLoading = true;
  tablo: Tablo | null = null;
  /** Картки подій (штрафи, неустойки, «Заказ выполнен», мафія) праворуч під табло. */
  cards: Cards | null = null;
  private disposed = false;
  race: RaceMode | null = null;
  truckers: Truckers | null = null;
  private raceMessages = new Map<string, string>();
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
  /** Меню Esc «Проблемы в пути» (з графікою esc16.RES). */
  private escMenu: EscMenu | null = null;
  /** Ліві панелі F1–F4 (клавіші, рейтинг, інфо, компанія). */
  private fPanels: FPanels | null = null;
  /** Карта на Tab з графікою оригіналу (огляд → збільшено → сховано). */
  private tabMap: TabMap | null = null;
  private mapPoints: MapPoint[] = [];
  /** Рація F5. */
  private radio: Radio | null = null;
  /** Навігатор (покращення PR_NAVIGATOR): поворот на найближчій розвилці до цілі, раз на 0,25 с. */
  private navigator: Navigator | null = null;
  private navTurn: NavTurn | null = null;
  private navTimer = 0;
  /** Виклик 911: відлік до відновлення (машина на гальмах), куди перенести, ціна. */
  private rescue: { left: number; done?: boolean; ready: Promise<{ position: THREE.Vector3; forward: THREE.Vector3 } | null>; cost: number } | null = null;
  /** Вихід без збереження («не зберігати», «завантажити гру»). */
  private noSave = false;
  /** Ігровий час вільної їзди, с від півночі (кар'єра — свій); старт — 10:00 (TRUCK.INI timestart=10). */
  private freeTime = 10 * 3600;
  /** Доба й погода як у king.exe (climate.ts): показник погоди, дощ, грім, вітер; дощ — слизька дорога. */
  private climate = new Climate();
  raining = false;
  /** Блискавка: час до наступної (с), час спалаху, спрайт `flash`. */
  private boltTimer = 0;
  private flashTime = 0;
  /** Листя на вітрі (CWindDebris king.exe). */
  private debris: WindDebris | null = null;
  private readonly debrisLook = new THREE.Vector3();
  private bolt: THREE.Sprite | null = null;
  private rainSound: ReturnType<EngineAudio['loopSound']> = null;
  private windSound: ReturnType<EngineAudio['loopSound']> = null;
  private tick = 0;
  /** Фари: два прожектори на місцях Fara_FL/FR з vehicle.tech; вмикаються в сутінках і вночі або клавішею L. */
  private readonly lamps: THREE.SpotLight[] = [];
  private lightsManual: boolean | null = null;
  /** Двірники вручну (W); null — самі в дощ. */
  private wipersManual: boolean | null = null;
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
    // Графіка інтерфейсу (esc16.RES, 57 МБ) — паралельно зі світом; init чекає її перед показом інтерфейсу.
    void EscArt.load(opts.source);
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
    // Старт гри (GAME.CNF): king.exe ставить машину курсом +x гри (на схід) — у чотирьох записах телеметрії з
    // початку гри вектор «уперед» рівно (1, 0); уздовж дороги порт ставив її навпаки, носом на захід.
    if (!saved && !o.race) spawn.forward.copy(toThree(1, 0, 0)).normalize();
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
    this.mapPoints = points;
    this.worldMap = new WorldMap(document.body, this.roads.axes, points);
    this.worldMap.onClose = () => {
      this.paused = false;
    };
    if (o.career) this.markets = new Markets(this.world.scene, this.rapier, this.trucks, parseMarkets(regionMods, this.world.regions.values()), (p) => this.groundAtPublic(p).y - 2.5);
    if (o.career) {
      const [merch, messages, restable, names] = await Promise.all([
        o.source.read('merchandise.sch').then(readSch).catch(() => []),
        o.source.read('Ms.sch').then(readSch).catch(() => []),
        o.source.read('restable.sch').then(readSch).catch(() => []),
        o.source.read('names.sch').then(readSch).catch(() => []),
      ]);
      this.careerMode = new CareerMode(this, o.career, merch, messages, parseUpgrades(restable, true), parseTowns(regionMods), parseServices(regionMods));
      this.copBribes = copsTakeBribes(names);
      this.police = new Police(parseAmbushes(regionMods, this.world.regions.values()), {
        rapier: this.rapier,
        roads: this.roads,
        make: (pos, forward) => this.makeCar('BmwM5police', 0, pos, forward, 0),
        remove: (v) => this.removeCar(v),
        sees: (p) => this.canSee(p),
        obstacles: () => [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...(this.truckers?.positions ?? [])],
        props: (names, on) => this.world.setAmbushProps(names, on),
        people: this.copBribes.length || 15,
      });
      // Мафія (Б10, re/notes/ht2/mafia.md): засідки MAFIA з mod_*.sch, машини Cayman на моделі руху king.exe.
      this.mafia = new Mafia(parseMafiaAmbushes(regionMods, this.world.regions.values()), {
        rapier: this.rapier,
        roads: this.roads,
        make: (pos, forward) => this.makeCar('Cayman', 0, pos, forward, 0),
        remove: (v) => this.removeCar(v),
        sees: (p) => this.canSee(p),
        obstacles: () => [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...(this.truckers?.positions ?? [])],
        props: (names, on) => this.world.setAmbushProps(names, on),
        propPositions: (name) => [...this.world.loaded.values()].flatMap((r) => (r.props.get(name) ?? []).map((o) => o.getWorldPosition(new THREE.Vector3()))),
        policeNear: (p, r) => this.police?.near(p, r) ?? false,
      });
      this.accidents = this.makeAccidents();
    }
    if (o.race) {
      const ms = await o.source.read('Ms.sch').then(readSch).catch(() => []);
      for (const m of ms) if (Array.isArray(m) && typeof m[0] === 'string') this.raceMessages.set(m[0], ukMessage(m[0], str(m[m.length - 1])));
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
    // Населення трафіку — `dumb N` і `ghost N` з playertypes GAME.CNF, насиченість — повзунок (TRUCK.INI trafs).
    const types = cnf ? (assoc(cnf, 'playertypes')?.slice(1) ?? []) : [];
    const count = (name: string, def: number) => {
      const e = assoc(types, name);
      return e ? num(e[1]) : def;
    };
    this.traffic = new Traffic(this.world.scene, this.rapier, this.roads, this.trucks, trafficKinds(vehicles, this.trucks), (r) => this.world.loaded.has(r), {
      dumb: count('dumb', 70),
      ghost: count('ghost', 25),
      density: o.settings?.traffic ?? 1,
    });
    this.traffic.signals = this.lights;
    this.traffic.view = {
      range: () => (this.world.scene.fog as THREE.Fog | null)?.far ?? VIEW_FALLBACK,
      sees: (p) => this.canSee(p),
    };
    // Фізичні машини трафіку поруч з гравцем — та сама модель руху king.exe, що й у гравця, з їхнім vehicle.tech.
    this.traffic.physics = {
      make: (kind, pos, forward, speed) => this.makeCar(kind.model, kind.variant, pos, forward, speed),
      remove: (v) => this.removeCar(v),
    };
    this.audio = await EngineAudio.create(this.world.commonRmp).catch(() => null);
    this.input.onCommand = (cmd) => {
      if (cmd === 'camera') this.camMode = NEXT_CAM[this.camMode];
      if (cmd === 'autopilot') {
        this.autopilot = this.autopilot ? null : this.pilot();
        // З напівпричепом — повільніше в поворотах (кермо на швидкості обмежене).
        if (this.autopilot && this.trailer) Object.assign(this.autopilot, { cruise: 45, bendGain: 5, bendFloor: 0.25 });
      }
      // Tab: карта king.exe (огляд → мінікарта → сховано); без графіки оригіналу — карта світу порту.
      if (cmd === 'map') {
        if (this.tabMap) this.tabMap.cycle();
        else this.openMap();
      }
      if (cmd === 'lights') this.lightsManual = !this.lamps[0]?.visible;
      // Двірники — окрема дія гри («Wipers», W); у порту без натискання вмикаються в дощ.
      if (cmd === 'wipers') this.wipersManual = !(this.glassRain?.wipersOn ?? this.wipersManual ?? this.raining);
      if (cmd === 'mirror') this.mirrorOn = !this.mirrorOn;
      // «Відновитися» — те саме, що 911 у меню Esc (на прохання користувача).
      if (cmd === 'reset') this.call911();
      if (cmd === 'menu') this.toggleEsc();
      if (cmd === 'f1' || cmd === 'f2' || cmd === 'f3' || cmd === 'f4') this.toggleF(Number(cmd[1]) as FPanel);
      if (cmd === 'f5') this.radio?.toggle();
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
    back.dataset.lcd = 'Меню';
    back.addEventListener('click', () => (this.escArt ? this.toggleEsc() : o.onExit()));
    this.bar.className = 'ht2-drive-bar';
    this.music = new Music(o.source);
    if (o.settings) this.applySettings(o.settings, false);
    void this.music.next();
    const music = document.createElement('button');
    music.textContent = '♪';
    music.setAttribute('aria-label', 'Музика');
    music.dataset.icon = 'music';
    music.addEventListener('click', () => music.classList.toggle('off', !this.music?.toggle()));
    // Бічні панелі й рація оригіналу (на телефоні немає F-клавіш): показуються, коли є графіка esc16.RES; та сама
    // кнопка ще раз — сховати панель, інша — перемкнути на свою.
    const orig = (text: string, label: string, onClick: () => void) => {
      const b = document.createElement('button');
      b.textContent = text;
      b.dataset.lcd = text;
      b.className = 'ht2-orig-only';
      b.setAttribute('aria-label', label);
      b.addEventListener('click', onClick);
      return b;
    };
    const info = orig('Інфо', 'Інфо (F3)', () => this.toggleF(3));
    const rating = orig('Рейтинг', 'Рейтинг (F2)', () => this.toggleF(2));
    const company = orig('Компанія', 'Моя компанія (F4)', () => this.toggleF(4));
    const cb = orig('Рація', 'Рація (F5)', () => this.radio?.toggle());
    // Ліва група згорнута під «☰» (на прохання користувача; карта — праворуч, у ряду сенсорних кнопок).
    const group = document.createElement('div');
    group.className = 'ht2-hud-group';
    group.hidden = true;
    group.append(back, music, info, rating, company, cb);
    const burger = document.createElement('button');
    burger.className = 'ht2-hud-burger';
    burger.setAttribute('aria-label', 'Меню кнопок');
    burger.innerHTML = BURGER_SVG;
    burger.addEventListener('click', () => {
      group.hidden = !group.hidden;
      burger.classList.toggle('on', !group.hidden);
    });
    // Кнопка групи, що відкриває панель (Меню, Інфо, Рейтинг, Компанія, Рація), згортає групу; музика — ні.
    group.addEventListener('click', (e) => {
      if ((e.target as Element).closest('button') === music) return;
      group.hidden = true;
      burger.classList.remove('on');
    });
    this.hud.append(burger, group);
    this.hudGroup = group;
    this.hudBurger = burger;
    document.addEventListener('pointerdown', this.onOutsideTap, true);
    // У шарі overlay — під вікнами складу й СТО (вони теж там, вище).
    o.overlay.append(this.hud, this.bar);
    // Інтерфейс оригіналу — до першого кадру, щоб не блимав інтерфейс порту (графіка вже вантажиться зі start).
    const art = await EscArt.load(o.source);
    this.escArtLoading = false;
    if (this.disposed) return;
    // Файл необовʼязковий — без нього тихий інтерфейс порту; підказати, як отримати оригінальний.
    if (!art) this.say('Немає COMMON/esc16.RES — інтерфейс порту. Меню: Демо → Файли гри → Імпортувати', 12);
    else {
      this.escArt = art;
      // Кнопки порту — у стилі табло (концепт A): метал, LCD-скло, написи шрифтом табло.
      applyTabloSkin(art);
      for (const b of this.hud.querySelectorAll<HTMLElement>('[data-lcd]')) {
        const label = lcdLabel(art, b.dataset.lcd!);
        if (label) b.replaceChildren(label);
      }
      const note = this.hud.querySelector<HTMLElement>('[data-icon="music"]');
      if (note) note.innerHTML = NOTE_SVG;
      this.tablo = new Tablo(art, o.overlay);
      this.tablo.onPage = () => this.audio?.playOnce('pager');
      this.cards = new Cards(art, o.overlay);
      this.fPanels = new FPanels(art, o.overlay, () => this.fData());
      this.radio = new Radio(art, o.overlay, {
        contacts: () => this.radioContacts(),
        asks: (c) => this.radioAsks(c),
        money: () => this.careerMode?.career.money ?? Infinity,
        pay: (amount) => {
          const c = this.careerMode?.career;
          if (!c) return true;
          if (c.money < amount) {
            this.say(this.careerMode!.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'));
            return false;
          }
          c.money -= amount;
          this.careerMode!.persist();
          return true;
        },
        say: (t) => this.say(t),
      });
      this.tabMap = new TabMap(art, o.overlay, this.roads.axes, this.mapPoints);
      // Одразу — мінікарта (стан 2): у порту її видно з початку їзди (king.exe починає зі схованої карти).
      this.tabMap.show(2);
      document.body.classList.add('ht2-orig-ui');
    }
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
            const dx = p[i + 3] - p[i];
            const dy = p[i + 4] - p[i + 1];
            const l = Math.hypot(dx, dy);
            if (l < 0.1) continue;
            // Проєкція на відрізок (не найближча вершина): старт GAME.CNF у записі king.exe — (−3020,7; −4616,75),
            // тобто x старту на лінії дороги; за вершиною порт ставив машину на 14 м далі, до воріт 1 замість 0.
            const t = Math.min(1, Math.max(0, ((x - p[i]) * dx + (y - p[i + 1]) * dy) / (l * l)));
            const q: [number, number, number] = [p[i] + dx * t, p[i + 1] + dy * t, p[i + 2] + (p[i + 5] - p[i + 2]) * t];
            const d = Math.hypot(q[0] - x, q[1] - y, q[2] - z);
            if (d >= best) continue;
            best = d;
            pos = q;
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
    // Будівлі складів, СТО, заправки — окремі обʼєкти колізій, розставлені екземплярами.
    const asm = reg.built.assembler;
    const inst = instanceCollision(asm.b3d, (n) => asm.block(n) ?? this.world.common.block(n), (n) => asm.space(n));
    col.floors.push(...inst.floors);
    col.walls.push(...inst.walls);
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

  /**
   * Облік ДТП (traffic/accidents.ts): партнери — динамічні тіла поблизу (машини трафіку у фізичному режимі,
   * міліція, суперники); кути кузова — ±1,25 м убік і ±3,5 м уздовж від центру тягача (гіпотеза: у king.exe —
   * точки тіла +0xEF8).
   */
  private makeAccidents(): Accidents {
    const fines = () => this.careerMode!.fines;
    return new Accidents({
      world: this.rapier,
      roads: this.roads,
      player: () => {
        const pos = this.truck.visual.position;
        const fwd = this.truck.forward().setY(0).normalize();
        const side = new THREE.Vector3(-fwd.z, 0, fwd.x);
        const lv = this.truck.body.linvel();
        const corners = [
          [1, 1],
          [1, -1],
          [-1, 1],
          [-1, -1],
        ].map(([a, b]) => pos.clone().addScaledVector(fwd, 3.5 * a).addScaledVector(side, 1.25 * b));
        return { bodies: [this.truck.body, ...(this.trailer ? [this.trailer.body] : [])], pos, forward: fwd, vel: new THREE.Vector3(lv.x, lv.y, lv.z), corners };
      },
      candidates: () => {
        const out: RAPIER.RigidBody[] = [];
        const p = this.truck.visual.position;
        this.rapier.bodies.forEach((b) => {
          if (!b.isDynamic() || b === this.truck.body || b === this.trailer?.body) return;
          const t = b.translation();
          if (Math.hypot(t.x - p.x, t.z - p.z) < 150) out.push(b);
        });
        return out;
      },
      partner: (b) => ({ kind: this.police?.isCop(b) ? 'police' : this.mafia?.isMafia(b) ? 'mafia' : 'car', mass: b.mass() }),
      mafiaDebt: (amount) => {
        fines().mafiaDebt = (fines().mafiaDebt ?? 0) + amount;
        this.careerMode!.persist();
      },
      queueAhead: () => {
        const p = this.truck.visual.position;
        const f = this.truck.forward();
        return (this.traffic?.cars ?? []).some((c) => {
          const rel = c.pos.clone().sub(p);
          const along = rel.x * f.x + rel.z * f.z;
          return c.speed < 1 && along > 0 && along < 15 && Math.abs(rel.x * f.z - rel.z * f.x) < 2;
        });
      },
      policeNear: (p) => this.police?.near(p, 200) ?? false,
      fine: (amount, bits) => {
        fines().accident += amount;
        fines().violations |= bits;
        this.careerMode!.persist();
      },
      forget: () => {
        if (!fines().accident && !fines().violations && !fines().mafiaDebt) return;
        // 180 с без ДТП (0x4cfe70): відшкодування, порушення й борг мафії забуваються.
        fines().accident = 0;
        fines().violations = 0;
        fines().mafiaDebt = 0;
        this.careerMode!.persist();
      },
    });
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
    const base = { cargoMass: this.hitched ? 0 : cargo, torque: t.torque, grip: t.grip, surfaceEffects: !this.arcade };
    // Рух king.exe (G10 В3); `?physics=rapier` — колишня модель на шинах Rapier (для порівняння).
    if (new URLSearchParams(location.search).get('physics') === 'rapier') return { ...base, engine: HT2_ENGINE, brake: HT2_BRAKE, rollLift: HT2_ROLL_LIFT, steerLimit: HT2_STEER_LIMIT, steerPower: HT2_STEER_POWER };
    return { ...base, engine: HT2_KING_ENGINE, brake: HT2_KING_BRAKE, king: { ...HT2_KING, travel: this.rec?.suspension } };
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
    this.truck.tow = { mass: this.trailer.mass, wheels: this.trailer.wheelCount };
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

  /** Листя на вітрі: точка землі під вантажівкою (променем униз) і напрям погляду камери. */
  private updateDebris(dt: number, wind: number, w: number): void {
    if (!this.debris) {
      this.debris = new WindDebris(this.world.common);
      this.world.scene.add(this.debris.group);
    }
    const p = this.truck.visual.position;
    const anchor = wind > 5 ? this.groundAt(p.clone()) : null;
    if (anchor) anchor.y -= 2.5;
    this.camera.getWorldDirection(this.debrisLook);
    this.debris.update(dt, anchor, this.debrisLook, wind, w, this.world.regionAt(p.x, -p.z));
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
    this.world.setClimate(hour, c.bad, this.flashTime > 0 && this.tick % 2 === 1, c.w());
    this.world.updateTrees(dt, c.wind);
    this.updateDebris(dt, c.wind, c.w());
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

  /**
   * Чи може гравець бачити машину в точці p (для появи й зникнення трафіку): ближче кінця туману, у кадрі камери
   * (з запасом) і не за рельєфом чи нерухомою колізією (промінь від камери).
   */
  canSee(p: THREE.Vector3): boolean {
    const cam = this.camera.position;
    const target = p.clone().setY(p.y + 1.2);
    const dist = cam.distanceTo(target);
    const fog = this.world.scene.fog as THREE.Fog | null;
    if (fog && dist > fog.far) return false;
    this.camera.updateMatrixWorld();
    this.seeFrustum.setFromProjectionMatrix(this.seeMatrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    if (!this.seeFrustum.intersectsSphere(new THREE.Sphere(target, 6))) return false;
    if (dist < 4) return true;
    const dir = target.clone().sub(cam).divideScalar(dist);
    const hit = this.rapier.castRay(new RAPIER.Ray(cam, dir), dist - 3, true, undefined, undefined, undefined, undefined, (c) => c.parent()?.isFixed() ?? true);
    return !hit;
  }
  private readonly seeFrustum = new THREE.Frustum();
  private readonly seeMatrix = new THREE.Matrix4();
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

  /** Меню Esc: відкрити (пауза) чи закрити. Без графіки оригіналу — вихід, як раніше. */
  toggleEsc(): void {
    if (this.escMenu) return this.closeEsc();
    this.fPanels?.close();
    if (!this.escArt || this.rescue) return;
    if (this.worldMap && !this.worldMap.el.hidden) return;
    this.paused = true;
    this.escMenu = new EscMenu(this.escArt, this.opts.overlay, {
      career: !!this.careerMode,
      settings: this.opts.settings ?? undefined,
      apply: (s, save) => this.applySettings(s, save),
      command: (c, save) => this.escCommand(c, save),
      close: () => this.closeEsc(),
    });
  }

  /**
   * Бічна панель F1–F4 відкрита — ліва група кнопок згортається й іде під панель (body.ht2-side-open), щоб її не
   * перекривати; закрита — «☰» знову над сценою.
   */
  private syncSidePanel(): void {
    const open = this.fPanels?.open != null || !!this.radio?.open || !!this.escMenu;
    if (open === this.sidePanelOpen) return;
    this.sidePanelOpen = open;
    document.body.classList.toggle('ht2-side-open', open);
    if (open && this.hudGroup) {
      this.hudGroup.hidden = true;
      this.hudBurger?.classList.remove('on');
    }
  }

  /** Панель F1–F4: відкрити, та сама — закрити (меню Esc закривається). */
  toggleF(kind: FPanel): void {
    if (!this.fPanels) return;
    if (this.escMenu) this.closeEsc();
    // Кнопка «Інфо», коли панель уже відкрита, — закрити її.
    this.fPanels.toggle(kind);
  }

  /** Скільки лишилось дорогами до точки, м (навігатор; null — не на дорозі). */
  routeLeft(target: THREE.Vector3): number | null {
    this.navigator ??= new Navigator(this.roads);
    return this.navigator.remaining(this.truck.visual.position, this.truck.forward(), target);
  }

  /** Навігатор: лише з покращенням і взятим замовленням (посібник). */
  private updateNavigator(dt: number): void {
    const c = this.careerMode?.career;
    if (!c?.order || !(c.upgrades ?? []).some((u) => u.startsWith('PR_NAVIGATOR'))) {
      this.navTurn = null;
      return;
    }
    this.navTimer -= dt;
    if (this.navTimer > 0) return;
    this.navTimer = 0.25;
    this.navigator ??= new Navigator(this.roads);
    const target = this.careerMode!.target();
    this.navTurn = target ? this.navigator.turn(this.truck.visual.position, this.truck.forward(), target) : null;
  }

  /** Машина з vehicle.tech на моделі руху king.exe (фізичний трафік, міліція). */
  private makeCar(carNode: string, variant: number, pos: THREE.Vector3, forward: THREE.Vector3, speed: number): TruckVehicle | null {
    const rec = this.trucks.records.find((r) => r.carNode === carNode);
    const def = rec && truckDef(this.trucks, rec);
    const model = def && buildTruckModel(this.trucks.asm, def, false);
    if (!rec || !def || !model) return null;
    if (variant > 0) recolor(model.root, this.trucks, variant + 1);
    const v = new TruckVehicle(this.rapier, def, model, { position: this.groundAt(pos), forward: forward.clone() }, {
      cargoMass: 0,
      surfaceEffects: !this.arcade,
      engine: HT2_KING_ENGINE,
      brake: HT2_KING_BRAKE,
      king: { ...HT2_KING, travel: rec.suspension },
    });
    v.body.setLinvel({ x: forward.x * speed, y: 0, z: forward.z * speed }, true);
    v.engine.engageFor(speed);
    this.world.scene.add(v.visual);
    return v;
  }

  private removeCar(v: TruckVehicle): void {
    this.world.scene.remove(v.visual);
    v.dispose();
  }

  /** Міліція (Б9): пости, погоня, попередження, стрілянина, затримання (traffic/police.ts, career/law.ts). */
  private updatePolice(dt: number): void {
    const cm = this.careerMode;
    if (!this.police || !cm || this.paused) return;
    const lv = this.truck.body.linvel();
    const events = this.police.update(dt, {
      body: this.truck.body,
      pos: this.truck.visual.position,
      forward: this.truck.forward(),
      vel: new THREE.Vector3(lv.x, 0, lv.z),
      wanted: wanted(cm.fines),
      stealth: this.tuning.stealth,
    });
    for (const e of events) this.policeEvent(e);
  }

  /** Мафія (Б10): на прицілі — борг мафії чи «цікавий мафії»; попередження, стрілянина, напад, міни. */
  private updateMafia(dt: number): void {
    const cm = this.careerMode;
    if (!this.mafia || !cm || this.paused) return;
    const lv = this.truck.body.linvel();
    const f = cm.fines;
    const events = this.mafia.update(dt, {
      body: this.truck.body,
      pos: this.truck.visual.position,
      forward: this.truck.forward(),
      vel: new THREE.Vector3(lv.x, 0, lv.z),
      hunted: (f.mafiaDebt ?? 0) > 0 || !!f.mafiaInterest,
      share: cm.capitalShare(),
    });
    for (const e of events) {
      if (e.kind === 'warn') this.say('ЗУПИНИ МАШИНУ! ТРЕБА ПОГОВОРИТИ', 6);
      else if (e.kind === 'shot') {
        this.audio?.play('shoot', Math.max(0.1, 1 - e.dist / 150));
        if (e.hit) this.audio?.play('hit_bullet');
      } else if (e.kind === 'attack') void cm.robbed();
      else if (e.kind === 'mine') {
        // Вибух міни (mineExplose, 0x56f240): поштовх угору в точці міни [Г: сила], звук mineSound.
        const m = this.truck.body.mass();
        this.truck.body.applyImpulseAtPoint({ x: 0, y: m * 3, z: 0 }, e.pos, true);
        this.audio?.play('mine');
      }
    }
  }

  private policeEvent(e: PoliceEvent): void {
    const cm = this.careerMode!;
    if (e.kind === 'speeding') cm.speeding(e.limit, e.speed, e.degree);
    else if (e.kind === 'warn') {
      // mess.txt 54/55 і звуки police_01/02 (king.exe 0x56ad20).
      this.say(e.n === 1 ? 'НЕГАЙНО ЗУПИНІТЬ МАШИНУ' : 'ЗУПИНІТЬСЯ, АБО БУДЕМО СТРІЛЯТИ', 6);
      this.audio?.play(e.n === 1 ? 'police_01' : 'police_02');
    } else if (e.kind === 'shot') {
      this.audio?.play('shoot', Math.max(0.1, 1 - e.dist / 150));
      if (e.hit) this.audio?.play('hit_bullet');
    } else if (e.kind === 'arrest') void cm.arrest();
  }

  /**
   * Радар-детектор (king.exe 0x538370): пост ближче 100 м → сигнал s = відстань × 0,01; лампа RD_LampKey —
   * рівень clamp(1 + ⌊3s⌋, 1…3), блимає з частотою 2 + 5s Гц (половину періоду світить), на спалах — звук antiradar.
   */
  private updateRadarLamp(dt: number, radar: boolean): void {
    if (!this.cabSwitch) return;
    const s = radar ? (this.police?.radarSignal(this.truck.visual.position) ?? 0) : 0;
    if (s <= 0) {
      if (this.radarLit) this.cabSwitch('RD_LampKey', 0);
      this.radarLit = false;
      this.radarBlink = 0;
      return;
    }
    this.radarBlink = (this.radarBlink + dt * (2 + 5 * s)) % 1;
    const lit = this.radarBlink < 0.5;
    if (lit !== this.radarLit) {
      this.cabSwitch('RD_LampKey', lit ? THREE.MathUtils.clamp(1 + Math.floor(3 * s), 1, 3) : 0);
      if (lit) this.audio?.play('antiradar');
      this.radarLit = lit;
    }
  }

  /** Абоненти рації поруч (RADIO_R): міліція на постах, мафія в засідці чи в погоні, далекобійники; ближчі — першими. */
  private radioContacts(): RadioContact[] {
    const p = this.truck.visual.position;
    const out: (RadioContact & { d: number })[] = [];
    for (const s of this.police?.nearby(p, RADIO_R) ?? []) out.push({ kind: 'pol', id: s.person, name: 'МІЛІЦІЯ', d: s.pos.distanceTo(p) });
    for (const s of this.mafia?.nearby(p, RADIO_R) ?? []) out.push({ kind: 'maf', id: s.id, name: 'МАФІЯ', d: s.pos.distanceTo(p) });
    this.truckers?.list.forEach((r, i) => {
      const d = r.truck.visual.position.distanceTo(p);
      if (d < RADIO_R) out.push({ kind: 'nei', id: i + r.name.length, name: `ВОДІЙ ${r.name.toUpperCase()}`, d });
    });
    // Конкуренти з тим самим замовленням, що зараз поруч на маршруті.
    for (const r of this.careerMode?.nearRivals() ?? []) out.push({ kind: 'opp', id: r.index, name: `КОНКУРЕНТ ${r.name.toUpperCase()}`, d: 0 });
    return out.sort((a, b) => a.d - b.d);
  }

  /**
   * Фрази рації й що вони роблять (ціни, ймовірності, тривалість — гіпотези порту): міліція — замість штрафу хабар
   * 60 % суми (25 % — «штраф за спробу підкупу»), «прикрийте від бандитів» — $800, мафія не чіпає 10 хв; мафія —
   * відкуп $1500 на 10 хв (15 % — гроші взяли й обдурили, посібник: «бандити можуть обдурити»); водій — допомога з
   * ремонтом: 40 % пошкоджень за півтори ціни СТО. Конкуренти (Б8) і замовлення машини — пізніше (кнопки неактивні).
   */
  private radioAsks(c: RadioContact): RadioAsk[] {
    const cm = this.careerMode;
    // Дія проти конкурента, що попереду (найбільша частка шляху), — лише коли є конкуренти.
    const rivalAct = (price: number, fn: (r: RivalRun) => void, text: string): Partial<RadioAsk> => {
      const list = cm?.career.order?.rivals?.filter((r) => !r.out && !r.done) ?? [];
      if (!list.length) return { off: true };
      return {
        price,
        act: () => {
          const lead = list.reduce((a, b) => (a.t / a.eta >= b.t / b.eta ? a : b));
          fn(lead);
          this.say(text);
        },
      };
    };
    if (c.kind === 'pol') {
      // Хабар (king.exe offerBribe 0x432560): сума — штрафи − 200 (за штраф) чи вартість вантажу − 500 («дах»),
      // округлена; бере лише інспектор з одиницею в names.sch, інакше — штраф за спробу підкупу (+200 / +500).
      // id абонента — номер інспектора (портрет escpolice<N>).
      const takes = !!this.copBribes[c.id];
      const fineBribe = cm ? bribeSum(totalFine(cm.fines), 200) : 0;
      const roofBribe = cm?.career.order ? bribeSum(cm.career.order.value, 500) : 0;
      const refused = (extra: number) => {
        if (!cm) return;
        cm.fines.bribery += extra;
        this.say(cm.msg('FINE_BRIBERY', 'ШТРАФ ЗА СПРОБУ ПІДКУПУ $%g', cm.fines.bribery));
        cm.persist();
      };
      return [
        {
          key: 'ask1',
          price: fineBribe > 0 ? fineBribe : null,
          act: () => {
            if (!cm) return;
            if (!takes) return refused(200);
            // Штрафи міліції обнуляються; борг і інтерес мафії — ні (їх скидає «дах»).
            Object.assign(cm.fines, { illegal: 0, accident: 0, violations: 0, speeding: 0, redLight: 0, bribery: 0, stolen: 0 });
            this.say('ШТРАФИ ЗНЯТО');
            cm.persist();
          },
        },
        {
          key: 'ask2',
          price: roofBribe > 0 ? roofBribe : null,
          // «Дах» (0x4725e0): борг і інтерес мафії скидаються — мафія більше не жене.
          act: () => {
            if (!takes) return refused(500);
            if (cm) Object.assign(cm.fines, { mafiaDebt: 0, mafiaInterest: false });
            cm?.persist();
            this.say('ЗАМОВЛЕННЯ ПІД ОХОРОНОЮ МІЛІЦІЇ');
          },
        },
        { key: 'ask3', ...rivalAct(1000, (r) => (r.eta += 120), 'КОНКУРЕНТА ЗАТРИМАНО') },
        { key: 'ask4', bye: true },
      ];
    }
    const order = cm?.career.order;
    const mafiaBribe = cm ? Math.round(0.7 * ((order ? 10 * Math.sqrt(order.goods.price * order.units) : 0) + (cm.fines.mafiaDebt ?? 0))) : 0;
    if (c.kind === 'maf')
      return [
        {
          // Відкуп (offerBribe, прапорець 8): 0,7 × (вартість вантажу + борг); гроші беруть завжди, у 30 % «кидають»,
          // інакше лише прапорець 0x100000, який king.exe ніде не читає — борг і інтерес мафії лишаються (mafia.md §6).
          key: 'ask1',
          price: mafiaBribe > 0 ? mafiaBribe : null,
          act: () => this.say(Math.random() < 0.3 ? 'БАНДИТИ ВЗЯЛИ ГРОШІ Й ОБДУРИЛИ' : 'БАНДИТИ ВЗЯЛИ ГРОШІ'),
        },
        { key: 'ask2', ...rivalAct(2000, (r) => (r.out = true), 'КОНКУРЕНТ ЗІЙШОВ З ДИСТАНЦІЇ') },
        // «Заказ машины» (0x433660): при боргу чи інтересі мафії — відмова; інакше не розібрано.
        { key: 'ask3', off: true },
        { key: 'ask4', bye: true },
      ];
    if (c.kind === 'opp') {
      const r = cm?.career.order?.rivals?.[c.id];
      const prem = cm?.career.order?.premium ?? 500;
      return [
        { key: 'ask1', price: !r || r.stubborn ? null : Math.round(prem * 0.6), act: () => r && ((r.eta *= 1.3), this.say('КОНКУРЕНТ НЕ ПОСПІШАТИМЕ')) },
        { key: 'ask2', price: !r || r.stubborn ? null : Math.round(prem * 1.2), act: () => r && ((r.out = true), this.say('КОНКУРЕНТ СКИНУВ ВАНТАЖ')) },
        { key: 'ask3', bye: true },
      ];
    }
    const dmg = cm?.career.damage ?? 0;
    return [
      {
        key: 'ask1',
        price: dmg < 0.05 ? null : Math.round(dmg * 100 * 0.4 * REPAIR_PER_PERCENT * 1.5),
        act: () => {
          if (!cm) return;
          cm.career.damage *= 0.6;
          this.say('ВОДІЙ ДОПОМІГ З РЕМОНТОМ');
          cm.persist();
        },
      },
      { key: 'ask2', off: true },
      { key: 'ask3', bye: true },
    ];
  }

  /**
   * «Помінятися місцями» (F4): гравець сідає в машину водія, водій — у машину гравця (посібник: миттєво). Пошкодження
   * й пальне — як були в гравця (гіпотеза: стан чужої машини порт не веде).
   */
  private swapWithDriver(i: number): void {
    const c = this.careerMode?.career;
    const d = c?.company?.[i];
    if (!c || !d || c.order) return void (c?.order && this.say('СПЕРШУ ДОСТАВТЕ ВАНТАЖ'));
    [c.truck, d.truck] = [d.truck, c.truck];
    this.changeTruck(c.truck);
    this.say(`ВИ ЗА КЕРМОМ ${c.truck}`);
    this.careerMode!.persist();
  }

  /** Дані панелей F1–F4. */
  private fData(): import('./ui/fPanels').FPanelData {
    return {
      info: this.careerMode?.info() ?? null,
      company: this.careerMode?.career.company ?? [],
      licences: this.careerMode?.career.licences?.length ?? 0,
      swap: (i) => this.swapWithDriver(i),
      fire: (i) => {
        const c = this.careerMode?.career;
        if (!c?.company?.[i]) return;
        this.say(`${c.company[i].name.toUpperCase()} ЗВІЛЬНЕНО`);
        c.company = c.company.filter((_, k) => k !== i);
        this.careerMode!.persist();
      },
      rivals: [...(this.truckers?.allNames ?? [])],
      keys: [
        ['ГАЗ', '↑'],
        ['ГАЛЬМО, НАЗАД', '↓'],
        ['КЕРМО', '← →'],
        ['РІЗКО', 'CTRL'],
        ['РУЧНЕ ГАЛЬМО', 'SHIFT'],
        ['ДВИГУН', 'ПРОБІЛ'],
        ['КАМЕРА', 'C'],
        ['ФАРИ', 'L'],
        ['ДВІРНИКИ', 'W'],
        ['ДЗЕРКАЛО', 'M'],
        ['СИГНАЛ', 'H'],
        ['ВІДНОВИТИСЯ', 'R, 0'],
        ['МІНІКАРТА', 'TAB'],
        ['АВТОПІЛОТ', 'P'],
        ['МЕНЮ', 'ESC'],
        ['КЛАВІАТУРА', 'F1'],
        ['РЕЙТИНГ', 'F2'],
        ['ІНФО', 'F3'],
        ['МОЯ КОМПАНІЯ', 'F4'],
      ],
    };
  }

  /**
   * Звук і керування з меню Esc: загальна гучність — усе, крім музики (двигун — ще й своїм повзунком), музика,
   * чутливість і повернення керма (множники 0,5…1,5; середина — як у телеметрії, гіпотеза). Гальмування й віддача —
   * лише зберігаються (таких звуків і керма з віддачею в порті немає).
   */
  private applySettings(s: Ht2Settings, save: boolean): void {
    this.audio?.setVolumes(s.engine * s.sfx, s.sfx);
    this.music?.setVolume(s.music);
    this.input.steerSpeed = steerGain(s.steerSpeed);
    this.input.steerCenter = steerGain(s.steerCenter);
    if (save) saveSettings(s);
  }

  private closeEsc(): void {
    this.escMenu?.close();
    this.escMenu = null;
    this.paused = false;
  }

  private escCommand(c: EscCommand, save?: boolean): void {
    if (c === 'save') {
      this.careerMode?.persist();
      this.closeEsc();
      return this.say('ГРУ ЗБЕРЕЖЕНО');
    }
    if (c === '911') {
      this.closeEsc();
      return this.call911();
    }
    if (c === 'control' || c === 'sound') return;
    // Завантажити — збережене до останнього «зберегти» (поточний стан не записувати).
    if (c === 'load' || save === false) this.noSave = true;
    this.closeEsc();
    this.opts.onExit(c === 'load' ? 'career' : c === 'restart' ? 'new' : c === 'exit' ? 'exit' : undefined);
  }

  /**
   * 911 (посібник: «дуже дорога операція»): машина стоїть RESCUE_SECONDS с («Восстановление через %d сек.», mess.txt
   * 125), потім — біля найближчої СТО (у вільній їзді — на останню надійну точку дороги), плата «ПЛАТА ЗА ВЫЗОВ $%d»
   * (mess.txt 9). Відлік, місце й ціна — гіпотези: обробник кнопки в king.exe не знайдено.
   */
  call911(): void {
    if (this.rescue) return;
    const p = this.truck.visual.position;
    const sto = this.careerMode?.nearestSto(p.x, -p.z) ?? null;
    const ready = sto
      ? this.world.ready(sto[0], sto[1]).then(() => {
          this.rapier.step();
          return this.spawnAt(sto);
        })
      : Promise.resolve(null);
    this.rescue = { left: RESCUE_SECONDS, ready, cost: this.careerMode ? RESCUE_COST : 0 };
    this.say(`ВИКЛИК 911. ВІДНОВЛЕННЯ ЧЕРЕЗ ${RESCUE_SECONDS} С.`);
  }

  private async finishRescue(): Promise<void> {
    const r = this.rescue;
    if (!r) return;
    const spawn = await r.ready;
    if (this.disposed) return;
    if (spawn) {
      this.truck.reset({ position: spawn.position.clone(), forward: spawn.forward.clone() });
      this.trailer?.reset();
      this.safe = spawn;
      this.skipHits = 3;
    } else this.recover();
    const c = this.careerMode?.career;
    if (c && r.cost) {
      // Грошей бракує — забирають що є (гіпотеза): лишити гравця без допомоги не можна.
      const paid = Math.min(c.money, r.cost);
      c.money -= paid;
      this.say(`ОПЛАТА ВИКЛИКУ $${paid}`);
      this.careerMode!.persist();
    }
    this.rescue = null;
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
    if (this.mirrorOn && this.camMode === 'cockpit') this.renderMirror(r);
    else if (this.mirror) this.mirror.frame.hidden = true;
  }

  /** Дзеркало: вид назад з місця водія, віддзеркалений зліва направо, у вікні рамки оригіналу під табло. */
  private renderMirror(r: THREE.WebGLRenderer): void {
    const size = r.getSize(new THREE.Vector2());
    const k = Math.round(size.x * MIRROR_SHARE) / MIRROR_W;
    const fw = Math.round(MIRROR_W * k);
    const fh = Math.round(MIRROR_H * k);
    const fx = Math.round((size.x - fw) / 2);
    const fy = Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0);
    const x = Math.round(fx + MIRROR_IN[0] * k);
    const y = Math.round(fy + MIRROR_IN[1] * k);
    const w = Math.round((MIRROR_IN[2] - MIRROR_IN[0] + 1) * k);
    const h = Math.round((MIRROR_IN[3] - MIRROR_IN[1] + 1) * k);
    if (!this.mirror) {
      const rt = new THREE.WebGLRenderTarget(1, 1);
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: rt.texture, depthTest: false, depthWrite: false }));
      // Дзеркало: ліве й праве міняються місцями.
      quad.scale.x = -1;
      const scene = new THREE.Scene();
      scene.add(quad);
      const url = this.escArt?.url(MIRROR_MASK);
      const frame = document.createElement(url ? 'img' : 'div');
      frame.className = 'ht2-mirror';
      if (url) (frame as HTMLImageElement).src = url;
      this.opts.overlay.append(frame);
      this.mirror = { rt, cam: new THREE.PerspectiveCamera(MIRROR_FOV, w / h, 0.5, this.camera.far), scene, ortho: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), frame };
    }
    const m = this.mirror;
    const ratio = r.getPixelRatio();
    if (m.rt.width !== Math.round(w * ratio) || m.rt.height !== Math.round(h * ratio)) m.rt.setSize(Math.round(w * ratio), Math.round(h * ratio));
    m.cam.aspect = w / h;
    m.cam.far = this.camera.far;
    m.cam.updateProjectionMatrix();
    // Погляд назад з місця водія: орієнтація машини, розвернута на 180° навколо вертикалі.
    m.cam.position.copy(this.camera.position);
    m.cam.quaternion.copy(this.truck.visual.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    m.cam.updateMatrixWorld();
    r.setRenderTarget(m.rt);
    r.clear();
    r.render(this.world.scene, m.cam);
    r.setRenderTarget(null);
    const auto = r.autoClear;
    r.autoClear = false;
    r.setScissorTest(true);
    r.setScissor(x, size.y - y - h, w, h);
    r.setViewport(x, size.y - y - h, w, h);
    r.render(m.scene, m.ortho);
    r.setScissorTest(false);
    r.setViewport(0, 0, size.x, size.y);
    r.autoClear = auto;
    m.frame.hidden = false;
    Object.assign(m.frame.style, { left: `${fx}px`, top: `${fy}px`, width: `${fw}px`, height: `${fh}px` });
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
      this.cabSwitch = dyn.setSwitch;
      this.cabRadar = null;
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

  /** Перемикачі кабіни; показаний антирадар (null — ще не задано). */
  private cabSwitch: ((name: string, group: number) => void) | null = null;
  private cabRadar: boolean | null = null;

  /** Префікс кабіни (prefixCab з vehicle.tech: ZilR → Zil, RenaultR → Reno). */
  private cabPrefix = '';

  /** Кабіна: на місці ока, орієнтація машини з нахилом погляду; кермо й стрілки — за станом. */
  private updateCab(dt: number): void {
    const inside = this.camMode === 'cockpit';
    if (inside && !this.cab) void this.loadCab();
    // Ховаємо лише модель (перший нащадок), не саму машину: її прожектори-фари мають світити й з кабіни.
    this.truck.visual.children[0].visible = !inside || !this.cab;
    if (!this.cab) return;
    this.cab.visible = inside;
    if (this.glassRain) {
      // Під дахом (тунель, міст — промінь угору влучає в геометрію) нових крапель немає.
      if ((this.shelterTimer -= dt) <= 0) {
        this.shelterTimer = 0.5;
        const t = this.truck.body.translation();
        this.sheltered = this.raining && !!this.rapier.castRay(new RAPIER.Ray({ x: t.x, y: t.y + 3, z: t.z }, { x: 0, y: 1, z: 0 }), 60, true);
      }
      this.glassRain.raining = this.raining && !this.sheltered;
      this.glassRain.wipersOn = this.wipersManual ?? this.raining;
      this.input.setToggle('wipers', this.glassRain.wipersOn);
      // Крок — справжній час кадру: з 1/30 на кадр двірники на 60 Гц ходили вдвічі, на 120 Гц — учетверо швидше.
      this.glassRain.update(dt, this.truck.speedKmh);
    }
    // Антирадар на панелі (RD_Key: 1 — є) — лише куплений (king.exe 0x538370, поле машини 0x5400); лампи RD_LampKey — 0.
    const radar = !!this.tuning.antiRadar;
    if (this.cabSwitch && radar !== this.cabRadar) {
      this.cabRadar = radar;
      this.cabSwitch('RD_Key', radar ? 1 : 0);
      this.cabSwitch('RD_LampKey', 0);
    }
    this.updateRadarLamp(dt, radar);
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
    // Кермо в кабіні — π/2 × положення керма s (king.exe 0x4decc0, поле 0x29e0; δ коліс = π/4·s): удвічі більше за
    // кут коліс, уже з межею й формою керма (а не натискання клавіші).
    // Вісь — z простору керма (0x5ac0c0); навколо y кермо ставало ребром і зникало в панелі.
    rot(this.cabParts.rule, new THREE.Vector3(0, 0, 1), 2 * this.truck.steerAngle);
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
    if (!this.roads) return;
    // Далі від осі дороги WAY, ніж половина ширини W (з запасом 0,5 м) — узбіччя.
    const off = this.roads.offRoad(p);
    this.offRoad = off;
    this.truck.setSurface(1, off ? OFFROAD_ROLL : 1);
    // Узбіччя трусить як ґрунт (покриття 2 у 0x502780; що узбіччя — ґрунт, гіпотеза: покриття за матеріалом не знайдено).
    this.truck.roughness = off ? ROUGH_GROUND : ROUGH_ASPHALT;
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
    if (this.rescue) {
      state = { ...state, throttle: 0, brake: 1 };
      this.rescue.left -= dt;
      if (this.rescue.left <= 0 && !this.rescue.done) {
        this.rescue.done = true;
        void this.finishRescue();
      }
    }
    this.traffic?.update(dt, this.truck.visual.position, [...(this.trailer?.points() ?? []), ...rivals]);
    const obstacles = [this.truck.visual.position, ...(this.trailer?.points() ?? []), ...(this.traffic?.cars.map((c) => c.pos) ?? [])];
    this.updateSurface();
    this.acc += dt;
    const step = this.rapier.timestep;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.trailer?.update(step, this.truck.brakePedal(state), this.def.tech.brakePower, this.truck.kinematic);
      this.race?.control(step);
      this.truckers?.control(step, obstacles);
      this.traffic?.control(step);
      this.police?.control(step);
      this.mafia?.control(step);
      this.rapier.step();
      this.acc -= step;
    }
    // Частка кроку фізики, що «не дійшла» до наступного, — модель між станами кроків (без ривків при 120 Гц).
    const alpha = this.acc / step;
    this.race?.after(dt, alpha);
    this.detectHits();
    if (this.careerMode && !this.paused) this.accidents?.update(dt);
    this.lights.update(dt, this.world.loaded.values());
    // Проїзд стоп-лінії на червоне (0x56ffd0): штраф 830, лише якщо міліція ближче 200 м; раз за перетин.
    if (this.lights.player(this.truck.visual.position) && this.careerMode && this.police?.near(this.truck.visual.position, 200)) {
      this.careerMode.fines.redLight += RED_LIGHT_FINE;
      this.careerMode.persist();
    }
    this.truckers?.after(dt, this.truck.visual.position, alpha);
    this.traffic?.after(alpha);
    this.police?.after(alpha);
    this.mafia?.after(alpha);
    this.truck.syncVisual(alpha);
    this.trailer?.syncVisual(alpha);
    this.audio?.update(this.truck.rpm, state.throttle, this.truck.engineOn);
    this.trackSafe(dt);
    this.updateDayTime(dt);
    this.updateCamera(dt);
    this.updateCab(dt);
    this.world.update(this.camera, this.truck.visual.position);
    this.careerMode?.update(dt, state.throttle);
    this.updatePolice(dt);
    this.updateMafia(dt);
    if (this.markets && this.careerMode) this.markets.update(this.truck.visual.position, Math.floor(this.careerMode.career.time / 86400));
    const sign = this.signs?.update(this.truck.visual.position, this.truck.forward());
    if (sign) this.say(sign, 6);
    this.fPanels?.update(dt);
    this.syncSidePanel();
    // Кнопка карти світиться, поки карта на екрані (огляд чи мінікарта).
    this.input.setToggle('map', this.tabMap ? this.tabMap.state !== 0 : !!this.worldMap && !this.worldMap.el.hidden);
    // Фари й двигун у групі «•••» — світяться, поки ввімкнені.
    this.input.setToggle('lights', !!this.lamps[0]?.visible);
    this.input.setToggle('engine', this.truck.engineOn);
    // Двірники — два стани (увімкнені / вимкнені): світяться, поки ввімкнені (і без скла кабіни — за вибором чи дощем).
    this.input.setToggle('wipers', this.glassRain?.wipersOn ?? this.wipersManual ?? this.raining);
    this.input.setToggle('mirror', this.mirrorOn);
    this.updateNavigator(dt);
    this.tabMap?.draw(dt, {
      me: this.truck.visual.position,
      heading: this.truck.forward(),
      rivals: this.race ? this.race.racers.slice(1).map((r) => r.truck.visual.position) : (this.truckers?.positions ?? []),
      target: this.careerMode?.target() ?? null,
      // Фініш гонки — значок I_race з написом mess.txt 88 «Кольцо».
      finish: this.race?.finishPos ?? null,
      finishLabel: 'КІЛЬЦЕ',
    });
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
      nav: this.navTurn,
      position: this.careerMode?.race ?? null,
      licences: this.careerMode?.licenceInfo() ?? null,
    });
  }

  /**
   * Автопрохід для перевірок (без requestAnimationFrame): автопілот seconds секунд — відстань, найдовше застрягання,
   * перекидання, регіони дорогою.
   */
  /** Автопілот для поточної вантажівки: у кінематичному русі king.exe — переслідування цілі по дузі з її базою. */
  private pilot(): AutoPilot {
    const ap = new AutoPilot(this.roads);
    if (this.truck.kinematic) {
      ap.kinematicBase = this.truck.base;
      // Обернене до δ = 45°·a·|s|^p (HT2_KING).
      const k = HT2_KING;
      ap.steerFor = (delta) => Math.sign(delta) * (Math.abs(delta) / (Math.PI / 4) / k.steerScale) ** (1 / k.steerPower);
    }
    return ap;
  }

  async smoke(seconds: number): Promise<{ seconds: number; distance: number; stuckFor: number; flips: number; regions: string[]; ok: boolean }> {
    const prev = this.autopilot;
    this.autopilot ??= this.pilot();
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
      this.camera.fov = viewFov(this.opts.settings?.xpyramid ?? 1.6);
      this.camera.updateProjectionMatrix();
      return;
    }
    const fov = this.camMode === 'far' ? FOV : viewFov(this.opts.settings?.xpyramid ?? 1.6);
    if (this.camera.near !== 1 || this.camera.fov !== fov) {
      this.camera.near = 1;
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    // З напівпричепом — далі й вище: причіп (13 м) інакше закриває дорогу.
    const tow = this.trailer ? 1.7 : 1;
    // Камера за машиною — як в оригіналі (CHASE_*); «далека» — порту.
    const far = this.camMode === 'far';
    if (this.chaseFor !== this.truck) {
      this.chaseFor = this.truck;
      this.chaseMid = modelMid(v, fwd);
    }
    const dist = far ? 28 * tow : (CHASE_BACK - this.chaseMid) * tow;
    const height = (far ? 12 : CHASE_UP) * tow;
    const flat = fwd.clone().setY(0).normalize();
    // Висота машини для камери — згладжена (0,35 с): тряска кузова від нерівностей і підвіски не передається в кадр,
    // підйоми й спуски дороги камера відстежує (як в оригіналі — камера над машиною стала, без тремтіння).
    const ky = 1 - Math.exp(-dt / 0.35);
    this.camBaseY = Number.isFinite(this.camBaseY) && Math.abs(v.position.y - this.camBaseY) < 20 ? this.camBaseY + (v.position.y - this.camBaseY) * ky : v.position.y;
    const want = v.position.clone().setY(this.camBaseY).addScaledVector(flat, -dist).addScaledVector(up, height);
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
      this.camPos.y = want.y;
      const target = want.clone().addScaledVector(flat, CHASE_LOOK * Math.cos(CHASE_PITCH)).addScaledVector(up, -CHASE_LOOK * Math.sin(CHASE_PITCH));
      this.camLook.copy(target);
    }
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  dispose(): void {
    if (!this.noSave) this.careerMode?.persist();
    this.careerMode?.dispose();
    this.escMenu?.close();
    this.fPanels?.close();
    document.removeEventListener('pointerdown', this.onOutsideTap, true);
    document.body.classList.remove('ht2-side-open');
    this.tabMap?.dispose();
    this.mirror?.rt.dispose();
    this.mirror?.frame.remove();
    this.radio?.close();
    this.rainSound?.stop();
    this.windSound?.stop();
    this.opts.renderer.setAnimationLoop(null);
    window.removeEventListener('resize', this.onResize);
    document.body.classList.remove('driving');
    this.input.dispose();
    this.touch?.remove();
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
    this.debris?.dispose();
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
