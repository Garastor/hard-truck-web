import RAPIER from '@dimforge/rapier3d-compat';
import { HT2_ENGINE, HT2_INPUT, HT2_KING, HT2_KING_BRAKE, HT2_KING_ENGINE, HT2_ROLL_LIFT, HT2_STEER_LIMIT, HT2_STEER_POWER, HT2_BRAKE } from './vehicles/controls';
import * as THREE from 'three';
import type { FileSource } from '@shared/source';
import { EngineAudio } from './engine/audio/engineAudio';
import { instanceCollision, levelCollision, openPortals, roomGround, roomPosts } from './engine/physics/collision';
import { RoomBounds } from './engine/physics/roomBounds';
import { TruckVehicle } from './engine/vehicle/truckVehicle';
import { ROUGH_ASPHALT, ROUGH_GROUND } from './engine/vehicle/kingModel';
import { buildTruckModel, visibleBox, type TruckDef, type TruckModel } from './engine/vehicle/trucks';
import { Input, type Action, type Command } from './engine/input/input';
import { GROUP_WORLD, addCollisionPolys, forgetSurfaces, g2t, groups, initRapier, surfaceAt } from './engine/physics/world';
import { assoc, num, readSch, str, type SExpr } from './formats/sexpr';
import { drivable, loadTrucks, selectable, truckDef, type Ht2Trucks } from './vehicles/trucks';
import { FOV } from './ui/viewer';
import { Ht2World, toThree, yieldTask, type LoadedRegion } from './world/world';
import { noFarClip } from './engine/render/farClip';
import { AutoPilot } from './engine/vehicle/autopilot';
import { Ht2Roads } from './world/roads';
import { Traffic, recolor, spotShare, trafficKinds } from './traffic/traffic';
import { groundNear } from './traffic/layers';
import { Accidents } from './traffic/accidents';
import { TrafficLights } from './world/trafficLights';
import { CareerMode } from './career/careerMode';
import { Police, parseAmbushes, type PoliceEvent } from './traffic/police';
import { RED_LIGHT_FINE, bribeSum, copsTakeBribes, totalFine, wanted } from './career/law';
import { Mafia, parseMafiaAmbushes } from './traffic/mafia';
import { ForbiddenZone, Helicopters } from './traffic/helicopters';
import { Water } from './vehicles/water';
import { Radars } from './traffic/radars';
import { showGameOver, showVictory, type LoseScreen } from './ui/gameOver';
import { playVideo } from './engine/video/player';
import { sharedContext } from './engine/audio/engineAudio';
import { glassDrops, precipitation, trafficHeadlights, trafficLamp } from './ui/effects';
import { WeatherRooms } from './world/weatherRooms';
import { markMover } from './world/roomVisibility';
import { WIN_SHARE } from './career/share';
import { Signs } from './world/signs';
import { Markets, parseMarkets } from './career/market';
import { WorldMap, type MapPoint } from './world/worldMap';
import { MapReveal } from './world/mapReveal';
import { GlassRain } from './engine/render/glassRain';
import { Dents, dentGeometry, hitEnergy } from './vehicles/dents';
import { basePlaces, fuelNodes, Presents, roadPlaces, semiKinds, type SemiKind, type TrailerChoice } from './vehicles/presents';
import { Caches, hiddenPlaces, type Cache } from './vehicles/caches';
import { orderVehicle, vehicleOffers, vehiclePowers, vehiclePrices } from './career/carOrder';
import { HIRED_MIN_SPEED, HiredOnRoads } from './career/hired';
import { BALANCE_DPR, keyName, resolutionDpr } from './ui/menuScreens';
import { driverCosts, hiredLoad, upgradeDriver } from './career/company';
import { routeLength, type Store } from './career/economy';
import { terrainCollider } from './world/terrain';
import { parseMsk } from './engine/formats/msk';
import { findStores, parseGoods } from './career/economy';
import { Freight } from './traffic/freight';
import { Climate, sunHeight, trafficLights } from './world/climate';
import { iniGet, iniNum, parseIni } from './engine/formats/ini';
import { decodeCp1251 } from './engine/formats/binary';
import { RaceMode, compassSector, type CourseKind, type NetRace } from './race';
import { modal } from './engine/ui/modal';
import { NetCars } from './netCars';
import type { Arena } from './world/world';
import { FIRST_RIVAL, FLAG_BRAKE, FLAG_LIGHTS, FLAG_REVERSE, PLAYER_COLORS, STATE_RATE } from './net/state';
import { Trailer } from './vehicles/trailer';
import { headlightMask } from './vehicles/headlights';
import { setPoolLight } from './traffic/headPools';
import { AITRUCK, Truckers, truckerKinds, truckerNames } from './traffic/truckers';
// Точки вздовж машини у світі — для трафіку й ботів (навколо кожної півдовжина 2,5 м).
import { alongPoints } from './traffic/botDriver';
import { parseUpgrades, tireGrip, tuning, type Tuning } from './career/upgrades';
import { parseServices, parseTowns } from './career/economy';
import { Music } from './ui/music';
import { SceneAssembler, setStaticSwitch } from './engine/render/sceneBuilder';
import { parseB3d } from './engine/formats/b3d';
import { parseRmp } from './engine/formats/rmp';
import { REPAIR_PER_PERCENT, currentDriver, restoreCareer, savedCareerRaw, type Ht2Career } from './career/career';
import { HT2_MOD_REGIONS, readTextures } from './files';
import { SFX_REF, saveSettings, steerGain, timeScale, type Ht2Settings } from './ui/settings';
import { EscArt } from './ui/escArt';
import { ukMessage, ukName, ukSign } from './ui/uk';
import { Obstacles, closedAxes, parseObstacles, type Obstacle } from './world/obstacles';
import { EscMenu, type EscCommand } from './ui/escMenu';
import { biasTowardCamera } from './engine/render/nearBias';
import { FPanels, type FPanel } from './ui/fPanels';
import { updateVisibleMatrices } from './engine/render/visibleMatrices';
import { TabMap } from './ui/tabMap';
import { Radio, type RadioAsk, type RadioContact } from './ui/radio';
import type { RivalRun } from './career/competition';
import { Navigator, type NavTurn } from './world/navigator';
import { WindDebris } from './world/windDebris';
import { Precipitation } from './world/precipitation';
import { WorldObjects } from './world/objects';
import { Blasts } from './world/blasts';
import { TireTracks } from './world/tireTracks';
import { CarFires, enginePoint } from './traffic/carFires';
import { Tablo } from './ui/tablo';
import { applyTabloSkin, lcdLabel } from './ui/tabloSkin';
import { Cards } from './ui/cards';
import { GEAR_SVG, openFreeSettings, vehicleName, type FreeField } from './ui/freeSettings';

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
/** Поява машини гравця — праворуч від осьової лінії дороги WAY на стільки, м (king.exe: старт на 1,75 м від лінії). */
const SPAWN_LANE = 1.75;
/**
 * Дзеркало заднього огляду (M) — лише з кабіни, посередині під табло, у рамці `m16\mirrT?.msk` з esc16.RES
 * (S/M/L/H — 170…480 px: розмір за роздільністю, гіпотеза; ≈ 30 % ширини екрана — тут найдетальніша H, масштабована).
 * Вікно рамки H — x 10…469, y 10…159. Кут огляду — підібраний (у king.exe не знайдено).
 */
/** Режим «Баланс» (оптимізація для телефона, як типовий у першій грі): частота кадрів; щільність — BALANCE_DPR (меню). */
const MAX_FPS = 60;
/** Дзеркало оновлюється не частіше (к/с): друге малювання світу — найдорожча частина виду з кабіни. */
const MIRROR_FPS = 20;
/** Скільки прожекторів буває в сцені: без фар, фари гравця, фари гравця й зустрічної (compileLit). */
const LAMP_STATES = [0, 2, 4];
/** Робочі обʼєкти кабіни (стрілки й кермо щокадру — без нових матриць). */
const CAB_TMP = new THREE.Matrix4();
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const AXIS_Z = new THREE.Vector3(0, 0, 1);

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
/** Згладжування стрілки тахометра, с (king.exe — filterEngineTach, вікно не розібране; підібрано). */
const TACH_SMOOTH = 0.12;
/**
 * Коробка над оком у системі моделі машини (clipRoof), м: півширина, низ і верх над оком, назад і вперед від ока.
 * Козирок ScaniaR — на 0,24 м вище ока й на 1 м попереду, тонований козирок MercedesR (effect_shadedglass) — від 0,13 м.
 */
const CAB_ROOF: [number, number, number, number, number] = [1.3, 0.1, 3, 2, 2.5];
const CAB_ROOF_CLIP = Array.from({ length: 6 }, () => new THREE.Plane());
/** Запізнення камери за машиною, с (оригінал: відстань позаду = 8,8 м + 0,58 с × швидкість, повертається за ≈ 1,5 с). */
const CHASE_LAG = 0.6;
/**
 * Камера поза стінами (keepOffWalls): куля навколо камери. У king.exe радіус 0,3 м (0x599210, 0x3e99999a); у порту —
 * 1 м, як ближня площина відсікання камери за машиною (near = 1): з 0,3 м ближня площина зрізала стіну поруч, і крізь
 * неї знову було видно.
 */
const CAM_BALL = new RAPIER.Ball(1);
const IDENTITY_Q = { x: 0, y: 0, z: 0, w: 1 };
/** Звідки летить куля — висота над точкою машини, м (усередині кузова — колайдер машини не рахується). */
const CAM_WALL_FROM = 2;
/** Віддалення камери від стіни назад на своє місце, с (наближення — одразу). */
const CAM_WALL_BACK = 0.3;
/** Точка погляду — на цій відстані від місця камери в спокої під нахилом CHASE_PITCH (біля машини), м. */
const CHASE_LOOK = 10;
/** Текстур нового регіону на GPU за одне завдання (решта — у наступних, між кадрами). */
const TEXTURES_PER_TASK = 6;
/** Полігонів колізій в одному trimesh-колайдері (будуються по одному за завдання). */
const COLLIDER_CHUNK = 2500;
/** Далі за стільки метрів від свого місця камера не «доганяє», а переставляється (телепорт, 911). */
const CHASE_JUMP = 60;

/** Займання від удару об нерухоме: сила удару (зміна швидкості з урахуванням рами), м/с (king.exe 0x554c20: x > 35). */
const IMPACT_FIRE = 35;
/** Вибух машини (_Blow) у кар'єрі: +0,4 пошкодження (0x555550(−0,4)). */
const BLOW_DAMAGE = 0.4;
/** μ коліс king.exe у записі ([Car_V+0x2670], ZilR на асфальті, 2026-10-18); у порту поздовжнє підігнано з 0,71. */
const KING_EXE_MU = 0.83;
/** Колісна база king.exe [0x1f60] у записі ZilR, м, і база порту для ZilR (до найближчої задньої осі). */
const KING_EXE_BASE = 7.9;
const ZILR_BASE = 6.54;
/** Після гасіння машина не займається, с (стан вогню 4 → 0). */
const FIRE_COOL = 5;

/** Спалах блискавки: тривалість, с, і сила в піку (частка шляху розсіяного світла до (0,9, 1, 1)) — порт, мʼякше за exe. */
const FLASH_TIME = 0.45;
const FLASH_PEAK = 0.6;

/** Крива спалаху за часом від початку: наростання 0,05 с, далі плавне згасання (квадрат) до FLASH_TIME. */
function flashLevel(t: number): number {
  if (t <= 0 || t >= FLASH_TIME) return 0;
  if (t < 0.05) return t / 0.05;
  const k = 1 - (t - 0.05) / (FLASH_TIME - 0.05);
  return k * k;
}

/** Колір туману, якщо в сцені його немає (дощ — world/precipitation.ts). */
const FOG_FALLBACK = new THREE.Color(0.5, 0.5, 0.5);
/**
 * Фари гравця (mountLamps): межа ближнього світла попереду, м; півкут конуса; освітленість від однієї фари (вона ж
 * сила: без згасання й залежності від кута, vehicles/headlights.ts) — на око.
 */
const LAMP_CUTOFF = 80;
const LAMP_ANGLE = (30 * Math.PI) / 180;
const LAMP_ROAD = 0.56;
/** Прожектори найближчої зустрічної машини трафіку (по одному в кожній фарі): межа світла, м. */
const CAR_LAMP_CUTOFF = 50;
/** Висота фар легковика над дорогою для маски, м — на око (у трафіку різні машини, маска одна). */
const CAR_LAMP_HEIGHT = 0.8;
/** Колір світла фар (гравця й трафіку). */
const LAMP_COLOR = new THREE.Color(0xfff2d0);
const POOL_BASE = new THREE.Color();
/** Опір кочення поза твердим покриттям, множник (телеметрія king.exe: узбіччя ≈ +0,06 g). */
const OFFROAD_ROLL = 5;
/**
 * Тверді покриття (опір кочення king.exe 0x5021c0: B = 0,05 лише на 1, 5, 10; на решті ≥ 0,6). Назви покриттів у
 * даних не знайдено; за поширеністю 1 — дороги, 2 — ґрунт довкола.
 */
const HARD_SURFACE = new Set([1, 5, 10]);
/** Покриття, на яких колеса лишають сліди (king.exe 0x502780: гілки 1/5, 2, 3, 8; на 4/7/9 і 6/10/11 — ні). */
const TRACE_SURFACE = new Set([1, 2, 3, 5, 8]);
/** Промінь покриття — лише по світу (не по машинах і предметах). */
const GROUND_RAY = groups(GROUP_WORLD, GROUP_WORLD);
/**
 * Розсіяне світло салону кабіни (king.exe 0x4df4a8): на час проходу кабіни envamb камери підмінено сірим
 * 0,5 + 0,5·sin²(година·π/24) — 0,5 опівночі, 1 опівдні; інших світел у проході немає (0x5aea50 гасить світла світу,
 * у CABINES.B3D блоку 33 немає), тож салон рівний, без тіней від сонця.
 */
function cabAmbient(hour: number): number {
  return 0.5 + 0.5 * Math.sin((hour * Math.PI) / 24) ** 2;
}

/** Найдовше очікування готовності шейдерів compileAsync, мс. */
const COMPILE_WAIT = 2000;

/**
 * compileAsync з межею часу: шейдери вже створено (синхронна частина), чекаємо лише готовності. У Safari (iPhone)
 * готовність (KHR_parallel_shader_compile) може не настати, доки програму не використано, — завантаження гри
 * висіло б на «Підготовці шейдерів». Після межі — далі: недоготовану програму рендерер дочекається сам.
 */
function compileWithin(r: THREE.WebGLRenderer, root: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene): Promise<unknown> {
  return Promise.race([r.compileAsync(root, camera, scene).catch(() => undefined), new Promise((res) => setTimeout(res, COMPILE_WAIT))]);
}

/** Звільнити GPU-ресурси салону: збирач CABINES не зберігається (loadCab), тож геометрія, матеріали й текстури — лише його. */
function disposeCab(cab: THREE.Object3D): void {
  cab.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    o.geometry.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      (m as THREE.MeshLambertMaterial).map?.dispose();
      m.dispose();
    }
  });
}

/**
 * Підйом місця водія (разом із салоном) над `viewer` з vehicle.tech, м — на око, на прохання користувача: інакше
 * між задньою кромкою капота й панеллю приладів видно щілину (king.exe ставить око інакше — re/notes/ht2/weather.md).
 */
const COCKPIT_LIFT = new THREE.Vector3(0, 0.08, 0);
/** Межі кутів голови в кабіні (king.exe 0x535a70: 0x64f3b0, 0x64f3a8), рад — 2,5° уперед-назад і 5° убік. */
const HEAD_PITCH_MAX = 0.0436;
const HEAD_SIDE_MAX = 0.0873;
/**
 * Ослаблення гойдання в кабіні зі швидкістю (на прохання користувача: бічне прискорення росте як v·ω, і на ходу
 * голову й крен розгойдувало надміру): 1 / (1 + v / 25 м/с) — 30 км/год ×0,75, 72 — ×0,56, 100 — ×0,47.
 */
function cockpitCalm(kmh: number, span = 25): number {
  return 1 / (1 + Math.abs(kmh) / 3.6 / span);
}
/** Те саме для голови — слабше ослаблення (45 м/с): на прохання користувача голова на 60 км/год ≈ 0,56°. */
const HEAD_CALM_SPAN = 45;
/** Частка крену кузова у вигляді з кабіни (на прохання користувача — на 30 % менше). */
const COCKPIT_ROLL = 0.7;
/** Зсув глибини стрілок приладів до ока, м (на прохання користувача — стрілки не ховаються за циферблатом). */
const NEEDLE_BIAS = 0.1;
/** Розмір стрілок спідометра й тахометра (на прохання користувача — на 30 % менші за модель). */
const NEEDLE_SIZE = 0.7;
/** Зсув голови на одиницю кута, м/рад: у king.exe 4 (0x64c408), у порту на 20 % менше — на прохання користувача. */
const HEAD_SHIFT = 3.2;
/**
 * Зсув салону на частку зсуву голови: 1 − d/D, де d — відстань від ока до верху панелі (одиниці CABINES, 1,81) і D — до
 * кромки капота на тому самому промені (0,88 м, ZilR; виміряно в порту) — тоді шов капота з панеллю стоїть на місці.
 */
const CAB_PARALLAX = 1 - 1.81 / 0.88;
/** Дальність видимості трафіку без туману в сцені, м. */
const VIEW_FALLBACK = 900;
/** 911: найменша відстань місця відновлення до інших машин, крок і кількість кроків пошуку вздовж дороги, м. */
const RESCUE_CLEAR = 6;
const RESCUE_STEP = 15;
const RESCUE_TRIES = 6;
/** 911: відлік до відновлення, с, і плата, $ (гіпотези — re/notes/ht2/ui.md §5). */
/** Рація: радіус зв'язку, м; скільки після штрафу можна домовитися, с; перемирʼя з мафією, с (гіпотези). */
/** Найманий прибув на склад ближче цього, м (гіпотеза порту). */
const HIRED_ARRIVE = 60;
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
  /** Мережева гонка (net/, разом з race): гравці, суперники, свій номер. */
  net?: NetRace | null;
  /** Колір своєї машини (0…3 — варіант матеріалів моделі, як у трафіку; екран «Мережева гра»). */
  color?: number;
  /** Арена мережевої гри (MENV — Кільце, MTR — Тріал): світ — лише її регіон, без ENV. */
  arena?: Arena | null;
  /** Вид траси гонки: Кільце (3 кола) чи Тріал (зони 0 → 1 → 2). */
  course?: CourseKind;
  /** Мережева кар'єра (М6): гравці (машини інших — NetCars у відкритому світі), свій номер; разом з career. */
  netCareer?: NetRace | null;
}

type CamMode = 'chase' | 'cockpit' | 'far';
/** Порядок камер (клавіша C): з кабіни → за машиною (як в оригіналі) → згори. */
/** Швидкість обертання камери навколо машини, рад/с (king.exe 0x650af0: π/3 — 60°/с). */
const ORBIT_RATE = Math.PI / 3;
// Світіння фар у моделях машин (`refer_HeadLightKey`) — у даних TRUCKS.B3D початковий стан 1 («горять»); у king.exe
// гілку вмикають лише фари чи габарити машини (re/notes/ht2/weather.md «Фари»). Тож моделі збираються з вимкненими,
// а вмикає їх гра (гравець — фарами, трафік і боти — вночі).
setStaticSwitch('refer_HeadLightKey', 0);

const NEXT_CAM: Record<CamMode, CamMode> = { cockpit: 'chase', chase: 'far', far: 'cockpit' };

export class Ht2Drive {
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.5, 4000);
  private rapier!: RAPIER.World;
  /** Стіни кімнат лише для машин у своїй кімнаті (як king.exe); крок фізики — через неї. */
  private roomBounds!: RoomBounds;
  truck!: TruckVehicle;
  /** Напівпричіп (лише в тягачів). */
  trailer: Trailer | null = null;
  private def!: TruckDef;
  /** Керування й двигун — криві Дальнобойщиків 2 (телеметрія king.exe, controls.ts). */
  private readonly input = new Input(HT2_INPUT);
  private audio: EngineAudio | null = null;
  private camMode: CamMode = 'cockpit';
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
  /** Регіони, чиї лінії баз ще не відсунуто від стін (`roads.clearWalls` — після кроку фізики з їхніми колайдерами). */
  private readonly wallsPending: string[] = [];
  /** Колайдери гілок перемикачів світу (регіон → `<Ключ>#<гілка>` → колайдери): обвали, ремонт мосту. */
  private readonly switchColliders = new Map<string, Map<string, RAPIER.Collider[]>>();
  /** Стани перемикачів світу, які задає гра (ключ без `refer_` → гілка); решта — початкові з B3D. */
  private readonly worldSwitches = new Map<string, number>();
  /** Обвали, повені й ремонт мосту (world/obstacles.ts). */
  obstacles: Obstacles | null = null;
  /** Катки на місцях `pos_work` діючого завалу. */
  private readonly obstacleProps = new Map<string, { root: THREE.Object3D; body: RAPIER.RigidBody }[]>();
  /** Цілі маршрутів трафіку (перераховуються, коли завал закриває чи відкриває дорогу). */
  private trafficGoals: THREE.Vector3[] = [];
  /** Збивні стовпи й рухомі предмети світу. */
  private objects!: WorldObjects;
  /** Вибухи й полумʼя (mnBlow3, mnFire). */
  private blasts: Blasts | null = null;

  private tracks: TireTracks | null = null;

  /**
   * Ефекти коліс і двигуна гравця щокадру: сліди шин (world/tireTracks.ts) на покриттях TRACE_SURFACE і вихлоп
   * (Blasts.exhaust) з труб SmokePosition.
   */
  private updateWheelFx(): void {
    if (!this.tracks) {
      this.tracks = new TireTracks(this.world.common);
      this.world.scene.add(this.tracks.group);
    }
    this.tracks.beginFrame();
    if (TRACE_SURFACE.has(this.surface)) for (const w of this.truck.traceWheels()) this.tracks.add(w.i, w.p, w.n, w.w, w.type);
    this.blastFx().exhaust(this.truck.exhaustOn() ? this.truck.exhaustPoints() : []);
    this.blastFx().brakeVapor(this.truck.brakeVaporPoints());
  }

  private blastFx(): Blasts {
    if (!this.blasts) {
      this.blasts = new Blasts(this.world.common);
      this.world.scene.add(this.blasts.group);
    }
    return this.blasts;
  }
  private acc = 0;
  private last = performance.now();
  /** Коли можна малювати наступний кадр (розклад межі частоти кадрів, frame), мс. */
  private nextFrame = 0;
  /** Остання надійна точка на дорозі (для відновлення після падіння). */
  private safe: { position: THREE.Vector3; forward: THREE.Vector3 } | null = null;
  private safeTimer = 0;
  private readonly hud = document.createElement('div');
  /** Ліва група кнопок під «☰» і сама «☰» (згортається, коли відкрито бічну панель F1–F4). */
  private hudGroup: HTMLElement | null = null;
  private hudBurger: HTMLElement | null = null;
  private sidePanelOpen = false;
  /**
   * Застосунок згорнули чи закривають (на телефоні його можуть вивантажити без dispose) — зберегти кар'єру одразу, а
   * не чекати автозбереження раз на 10 с (careerMode.update).
   */
  private readonly onHide = (e: Event) => {
    if ((e.type === 'pagehide' || document.visibilityState === 'hidden') && !this.noSave) this.careerMode?.persist();
  };
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
  /** Гелікоптери Ка-50 (Б11) і заборонена зона регіону db. */
  copters: Helicopters | null = null;
  readonly zone = new ForbiddenZone();
  private signs: Signs | null = null;
  markets: Markets | null = null;
  private worldMap: WorldMap | null = null;
  /** Приховані дороги карти й відкриття проїздом (world/mapReveal.ts); відкрите — у кар'єрі (`mapOpened`). */
  mapReveal: MapReveal | null = null;
  private revealTimer = 0;
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
  /** Мережева кар'єра (М6): машини інших гравців у світі. */
  netCars: NetCars | null = null;
  /** Мережева кар'єра: свій гравець захопив ринок — повідомити інших (netPlay). */
  onNetVictory: (() => void) | null = null;

  /** Мережева кар'єра: ринок захопив інший гравець — кінець гри (king.exe: подія 0xC чужого гравця → BackLoose1). */
  netDefeat(): void {
    this.gameOver('BackLoose1');
  }

  /** Рейтинг для вікна BackLoose1: свій гравець, інші гравці й далекобійники ІІ за часткою ринку. */
  private ratingRows(): [string, number, number, number][] {
    const cm = this.careerMode;
    if (!cm) return [];
    const d = this.fData();
    const rows: [string, number, number, number][] = [[cm.career.driver, Math.round(d.share * 100), cm.career.company?.length ?? 0, cm.info().tons]];
    for (const p of d.netRating ?? []) rows.push([p.name, Math.round(p.share * 100), p.hired, p.tons]);
    for (const n of d.rivals.slice(0, 3)) rows.push([n, Math.round(d.rivalShare * 100), 0, 0]);
    return rows.sort((a, b) => b[1] - a[1]);
  }

  /** Мережева гра: імена гравців за номером (netPlay) — таблиця F2, мінікарта. */
  netNames = new Map<number, string>();
  /** Мережева гонка: пакет стану своєї машини (і суперників господаря) — STATE_RATE разів на секунду. */
  onNetState: ((data: ArrayBuffer) => void) | null = null;
  private netTimer = 0;
  /** Мережева гра не зупиняється (меню Esc, карта): інші гравці їдуть далі, свій стан — і далі в мережу. */
  private get canPause(): boolean {
    return !this.race?.net && !this.netCars;
  }
  truckers: Truckers | null = null;
  private raceMessages = new Map<string, string>();
  private music: Music | null = null;
  /** Кабіна (вид з кабіни): інтер'єр з CABINES.B3D окремою сценою поверх світу, як у першій грі. */
  private readonly overlayScene = new THREE.Scene();
  private cab: THREE.Group | null = null;
  private cabParts: { rule?: THREE.Object3D; speed?: THREE.Object3D; tacho?: THREE.Object3D; fuel?: THREE.Object3D } = {};
  /** Згладжені оберти для стрілки тахометра, об/хв (updateCab). */
  private tachShown = 0;
  /** Вода на склі кабіни й двірники (як у першій грі: маски glass_1/glass_2.msk з CABINES.RES, Wiper*). */
  private glassRain: GlassRain | null = null;
  /** Вмʼятини гравця (перемикачі пошкоджень моделі); у кар'єрі — зберігаються. */
  dents: Dents | null = null;
  /** Зміна швидкості тягача від ударів за останній кадр (світ, м/с; detectHits). */
  readonly hitDv = new THREE.Vector3();
  private freeDents: Record<string, number> = {};
  /** Вмʼятини й шини напівпричепа (свої перемикачі моделі; у кар'єрі — career.trailerDents). */
  trailerDents: Dents | null = null;
  private freeTrailerDents: Record<string, number> = {};
  /** Габарити ввімкнені (разом з фарами) — задні ліхтарі горять габаритом. */
  private sizeLights = false;
  /** Напівпричепи на базах (кар'єра, vehicles/presents.ts) і типи з evehicles.sch. */
  presents: Presents | null = null;
  /** Схованки pos_hidden — контейнери й цистерни (кар'єра, vehicles/caches.ts). */
  caches: Caches | null = null;
  /** Контейнер, вікно якого вже показано (повторно — лише коли відʼїде далі CACHE_PICK_RANGE). */
  private cacheOffered: Cache | null = null;
  private presentsSaveTimer = 0;
  /** Наймані водії на дорогах (career/hired.ts) і їхні точки для карти (I_tr_myc). */
  private hiredRoads: HiredOnRoads | null = null;
  private hiredMarks: THREE.Vector3[] = [];
  /** Лінія, з якої маршрут до складу не знайшовся (не шукати щокадру). */
  private readonly hiredNoRoute = new Map<string, string>();
  /** Машини далекобійників, яким уже поставлено логотип (stampIcons). */
  private readonly iconed = new WeakSet<object>();
  /** Потужність моделей з evehicles.sch (вікно замовлення машини). */
  private vehiclePowers = new Map<string, number>();
  private vehiclePriceMap = new Map<string, number>();

  /** Ціна моделі з evehicles.sch (без запису — з vehicle.tech). */
  vehiclePrice(carNode: string): number {
    return this.vehiclePriceMap.get(carNode) ?? this.trucks.records.find((r) => r.carNode === carNode)?.price ?? 0;
  }
  /** Відкрито вікно причепа з вантажем (друге натискання T не відкриває ще одне). */
  private offering = false;
  private semiTypes: SemiKind[] = [];
  /** Габарити (SizeLightKey моделі). */
  private setTruckSwitch: ((n: string, s: number) => void) | undefined;
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
  /** Вихід без збереження («не зберігати», «завантажити гру», кінець гри). */
  private noSave = false;
  /**
   * Збереження на момент старту чи останнього «Зберегти гру» (рядок JSON; null — не було). Автозапис раз на 10 с і
   * після подій пише поточний стан (на телефоні вкладку можуть вивантажити без dispose), тож вихід без збереження
   * повертає цей знімок — інакше «не зберігати» й «завантажити гру» давали стан останнього автозапису.
   */
  private checkpoint: { id: string; raw: string | null } | null = null;
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
  /** Дощ і сніг частинками (CRain/CSnow king.exe). */
  private precip: Precipitation | null = null;
  private readonly debrisLook = new THREE.Vector3();
  private bolt: THREE.Sprite | null = null;
  private rainSound: ReturnType<EngineAudio['loopSound']> = null;
  private windSound: ReturnType<EngineAudio['loopSound']> = null;
  private tick = 0;
  /**
   * Фари: два прожектори на місцях Fara_FL/FR з vehicle.tech; лише клавішею L чи кнопкою (на прохання користувача —
   * у сутінках самі не вмикаються).
   */
  private readonly lamps: THREE.SpotLight[] = [];
  private lampMask: THREE.Texture | null = null;
  /** Прожектори фар зустрічної машини (Traffic.spot): увесь час у сцені вночі, без машини — сила 0 (без перекомпіляції шейдерів). */
  private readonly carLamps: THREE.SpotLight[] = [];
  private lightsManual = false;
  /** Двірники — лише вручну (W; на прохання користувача — у дощ самі не вмикаються). */
  private wipersManual = false;
  /** Маса вантажу в кузові, кг (фізика: центр мас і загальна маса). */
  private cargoMass = 0;
  /** Бак, л (з покращенням), і витрата (vehicle.tech: × 10 = л/100 км; лише для найманих водіїв) вантажівки гравця. */
  tank = 250;
  fuelConsumption = 5;
  /** fuelTimeEndurance vehicle.tech, с: стільки вистачає повного бака на повному газі (careerMode.burn). */
  fuelEndurance = 850;
  /** Оберти найбільшої потужності (tach_with_max_power), об/хв: витрата ∝ оберти / ці оберти. */
  fuelRpm = 1600;
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
    const world = await Ht2World.create(opts.source, opts.arena ?? undefined);
    const trucks = await loadTrucks(opts.source, world.common.lib.palette);
    const d = new Ht2Drive(opts, world, trucks);
    await d.init();
    opts.setStatus(null);
    return d;
  }

  private async init(): Promise<void> {
    const o = this.opts;
    this.rapier = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    this.roomBounds = new RoomBounds(this.rapier);
    this.objects = new WorldObjects(this.rapier);
    this.rapier.timestep = 1 / 60;
    // CCD-розвʼязувач Rapier вимкнено: CCD тут ніде не вмикається, а він однаково обрізав крок машини гравця біля
    // трикутників дороги (~12 % кроків — лише 4…50 % шляху за незмінної швидкості) — у виді ззаду машина смикалась.
    this.rapier.integrationParameters.maxCcdSubsteps = 0;
    this.world.onRegion = (reg, loaded) => (loaded ? this.addRegion(reg) : this.removeRegion(reg.id));
    // Новий регіон — текстури на GPU й шейдери до показу, частинами: інакше перший кадр з ним стояв 50…100 мс.
    this.world.prepare = (root) => this.prepareRegion(root);
    this.roads = new Ht2Roads(this.world.regions.values());

    // Старт і вантажівка гравця — з ENV/GAME.CNF (арена — свій GAME.CNF: MENV, MTR; у MTB немає).
    const cnf = await o.source.read(`${o.arena ?? 'ENV'}/GAME.CNF`).then(readSch).catch(() => null);
    const sp = cnf ? assoc(cnf, 'startposition') : undefined;
    let start: [number, number, number] = sp ? [num(sp[1]), num(sp[2]), num(sp[3])] : [-3020, -4625, 20];
    if (o.race) {
      // Гонка — старт на решітці (start1_1 у ENV/dr.way чи WAY арени).
      const node = [...this.world.regions.values()].flatMap((g) => g.way.rooms.flatMap((r) => r.nodes)).find((n) => n.name === 'start1_1');
      if (node) start = node.pos;
    }
    const live = cnf ? assoc(assoc(cnf, 'playertypes')?.slice(1) ?? [], 'live') : undefined;
    const want = o.career?.truck || o.truck || (live ? str(live[2]) : 'ZilR');
    const list = o.career ? drivable(this.trucks) : selectable(this.trucks);
    const rec = list.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? list[0];
    const def = rec && truckDef(this.trucks, rec);
    if (!def) throw new Error('Немає моделі вантажівки');
    this.def = def;
    if (o.career && !o.career.truck) o.career.truck = def.carNode;
    this.tank = rec.tank * this.tuning.tank;
    this.cabPrefix = rec.prefixCab;
    this.fuelConsumption = rec.fuelConsumption;
    this.fuelEndurance = rec.fuelTimeEndurance;
    this.fuelRpm = rec.tachMaxPower;

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
    if (!o.race) {
      // Не на осьовій лінії WAY, а на правій смузі: у записі king.exe машина на (−3020,7; −4616,75) при лінії дороги
      // y = −4615 — на 1,75 м праворуч від курсу (як смуги гонки, race.ts LANE). Вузька дорога — посередині правого краю.
      const right = new THREE.Vector3().crossVectors(spawn.forward, new THREE.Vector3(0, 1, 0)).normalize();
      const p = spawn.position.clone().addScaledVector(right, Math.min(SPAWN_LANE, spawn.widthRight / 2));
      spawn.position.copy(this.groundAt(p.setY(p.y - 2.5)));
    }
    if (!saved && rec.group === 'tractors' && !o.race && o.trailer !== 'none') {
      // Старт бази (GAME.CNF) — упритул до будівлі позаду: причіп (до 14 м) зʼявлявся б у ній. Тягач — на 10 м
      // далі дорогою.
      const ahead = spawn.position.clone().addScaledVector(spawn.forward, 10);
      spawn.position.copy(this.groundAt(ahead.setY(ahead.y - 2.5)));
    }
    // Нова мережева кар'єра: усі стартують з тієї самої точки GAME.CNF — гравці на 20 м один за одним уздовж дороги
    // (за номером), інакше машини з'являлися б одна в одній.
    if (o.netCareer && !saved && o.netCareer.myId > 0) {
      const p = spawn.position.clone().addScaledVector(spawn.forward, 20 * o.netCareer.myId);
      spawn.position.copy(this.groundAt(p.setY(p.y - 2.5)));
    }
    // Динамічна модель: перемикачі пошкоджень і вогнів (вмʼятини, габарити).
    const model = buildTruckModel(this.trucks.asm, def, true);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня`);
    if (o.color) recolor(model.root, this.trucks, o.color + 1);
    this.cargoMass = o.career?.order ? o.career.order.goods.mass * o.career.order.units : 0;
    this.truck = new TruckVehicle(this.rapier, def, model, spawn, this.setup(this.cargoMass));
    this.truck.visual.userData.model = model;
    this.truck.setDamage({ power: 1, lostGears: 0, brakes: this.tuning.brakes });
    this.world.scene.add(this.truck.visual);
    this.hitch();
    this.mountLamps();
    this.safe = spawn;
    this.cockpit = g2t(def.tech.viewer).add(COCKPIT_LIFT);
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
          if (/^mapPark/.test(n.name)) points.push({ pos: toThree(...n.pos), kind: 'park' });
        }
    for (const m of parseMarkets(regionMods, this.world.regions.values())) if (!m.hidden) points.push({ pos: m.spots[0].pos, kind: 'market', label: m.name });
    this.mapPoints = points;
    this.mapReveal = new MapReveal(this.roads, o.career?.mapOpened ?? []);
    this.mapReveal.onOpen = () => {
      const cm = this.careerMode;
      if (!cm) return;
      cm.career.mapOpened = this.mapReveal!.keys();
      cm.persist();
    };
    this.worldMap = new WorldMap(document.body, this.roads.axes, points, this.mapReveal);
    this.worldMap.onClose = () => {
      this.paused = false;
    };
    if (o.career) {
      this.markets = new Markets(this.world.scene, this.rapier, this.trucks, parseMarkets(regionMods, this.world.regions.values()), (p) => this.groundAtPublic(p).y - 2.5, {
        // Продавці: нові, вживані (стоянки old_car), крадені (hidden_car) — ліміти GAME.CNF.
        forsale: cnf ? num(assoc(cnf, 'forsale')?.[1], 25) : 25,
        used: cnf ? num(assoc(cnf, 'forsale_used')?.[1], 5) : 5,
        stolen: cnf ? num(assoc(cnf, 'forsale_stolen')?.[1], 5) : 5,
      });
      // Замовлені рацією машини — зі збереження (стоять на ринку, доки не куплять).
      this.markets.ordered = o.career.orderedCars ??= [];
    }
    if (o.career) {
      const [merch, messages, restable, names] = await Promise.all([
        o.source.read('merchandise.sch').then(readSch).catch(() => []),
        o.source.read('Ms.sch').then(readSch).catch(() => []),
        o.source.read('restable.sch').then(readSch).catch(() => []),
        o.source.read('names.sch').then(readSch).catch(() => []),
      ]);
      if (o.career.id) this.checkpoint = { id: o.career.id, raw: savedCareerRaw(o.career.id) };
      this.careerMode = new CareerMode(this, o.career, merch, messages, parseUpgrades(restable, true), parseTowns(regionMods), parseServices(regionMods));
      if (o.netCareer) this.netCars = new NetCars(this, o.netCareer.players, o.netCareer.myId);
      this.copBribes = copsTakeBribes(names);
      this.accidents = this.makeAccidents();
    }
    // Міліція, мафія й гелікоптери — у кар'єрі й у вільній їзді (рівень розшуку — з меню-шестерні), не в гонці.
    if (!o.race) {
      this.police = new Police(parseAmbushes(regionMods, this.world.regions.values()), {
        rapier: this.rapier,
        roads: this.roads,
        // Динамічна модель — живі перемикачі CopLightKey / CopSirenKey (мигалки й сирена).
        make: (pos, forward) => this.makeCar('BmwM5police', 0, pos, forward, 0, true),
        remove: (v) => this.removeCar(v),
        sees: (p) => this.canSee(p),
        obstacles: () => [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...(this.truckers?.positions ?? [])],
        props: (names, on) => this.world.setAmbushProps(names, on),
        people: this.copBribes.length || 15,
        chasers: () => this.copters?.chasers() ?? [],
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
      // Гелікоптери Ка-50 (Б11, re/notes/ht2/helicopters.md): модель k50 з TRUCKS.B3D, звук helicopterSound.
      this.copters = new Helicopters({
        rapier: this.rapier,
        scene: this.world.scene,
        model: () => {
          const o = this.trucks.asm.dynamicObject('k50');
          return o && { root: o.root, setSwitch: o.setSwitch };
        },
        obstacles: () => [...(this.traffic?.cars.map((c) => c.pos) ?? []), ...(this.truckers?.positions ?? [])],
        loop: () => this.audio?.loopSound('helicopter') ?? null,
      });
    }
    if (o.race) {
      const ms = await o.source.read('Ms.sch').then(readSch).catch(() => []);
      for (const m of ms) if (Array.isArray(m) && typeof m[0] === 'string') this.raceMessages.set(m[0], ukMessage(m[0], str(m[m.length - 1])));
      this.race = new RaceMode(this, this.roads, (k, fb) => this.raceMessages.get(k) ?? fb, false, o.net ?? null, o.course ?? 'ring');
      this.race.onFinish = () => o.onExit();
      // Автобол без мережі: 1000 очок — вікно з рахунком і назад у меню (у мережі — таблиця netPlay).
      if (!o.net)
        this.race.onBallOver = (scores) =>
          void modal(this.overlay, 'Автобол', `Ви набрали $${scores[0]?.points ?? 0}`, ['Гаразд']).then(() => o.onExit());
    }
    // Погода: повзунок «погода» і TRUCK.INI [EFFECTS] wtemp (період зміни, реальних годин); ?weather=bad|good — стала.
    const ini = await o.source.read('TRUCK.INI').then((b) => parseIni(decodeCp1251(b))).catch(() => null);
    const wtemp = ini ? iniNum(ini, 'EFFECTS', 'wtemp', 0.13) : 0.13;
    // TRUCK.INI [CAR] helicopters (king.exe 0x4df950): усе, крім "on", вимикає гелікоптери; без ключа — увімкнено.
    if (ini && (iniGet(ini, 'CAR', 'helicopters') ?? 'on').toLowerCase() !== 'on') {
      this.copters?.dispose();
      this.copters = null;
    }
    this.climate = new Climate(o.settings?.weather ?? 0.6, wtemp, o.weather === 'bad' ? 'bad' : o.weather ? 'good' : null);
    const vehicles = await o.source.read('evehicles.sch').then(readSch).catch(() => []);
    this.semiTypes = semiKinds(vehicles);
    this.vehiclePowers = vehiclePowers(vehicles);
    this.vehiclePriceMap = vehiclePrices(vehicles);
    // Причепи на базах — і у вільній їзді (на прохання користувача; без дорожніх місій і збереження), не в гонці.
    if (!o.race && this.semiTypes.length) {
      const limit = cnf ? num(assoc(cnf, 'semitrailers')?.[1], 28) : 28;
      this.presents = new Presents(
        {
          scene: this.world.scene,
          rapier: this.rapier,
          trucks: this.trucks,
          roadDir: (p) => {
            const n = this.roads.nearest(p);
            const dir = n ? n.line.pts[n.seg + 1].clone().sub(n.line.pts[n.seg]).setY(0) : null;
            return dir && dir.lengthSq() > 1e-6 ? dir.normalize() : null;
          },
        },
        this.semiTypes,
        basePlaces(this.world.regions.values(), fuelNodes(regionMods)),
        limit,
      );
      // Дорожні місії — причепи з вантажем на pos_road_* (ліміт `missions` з GAME.CNF, 10).
      const missions = cnf ? num(assoc(cnf, 'missions')?.[1], 10) : 10;
      const cm = this.careerMode;
      if (cm) this.presents.missions(roadPlaces(this.world.regions.values()), missions, (pl) => cm.missionLot(pl.pos));
      // Збережені причепи (king.exe зберігає всі presents, 0x4833a0) — на своїх місцях, з вантажем і строками.
      if (o.career?.presents) this.presents.restore(o.career.presents);
      // Старі збереження: невзяті причепи з легальним вантажем — тепер контрабанда (careerMode.missionLot, відступ порту).
      if (cm)
        for (const p of this.presents.list) {
          if (!p.lot || p.order || cm.goodsList.find((g) => g.id === p.lot!.goods)?.illegal) continue;
          const lot = cm.missionLot(p.pos);
          if (lot) p.lot = lot;
        }
      // Схованки pos_hidden (vehicles/caches.ts) — лише в кар'єрі: контейнери з вантажем (`containers`) і цистерни
      // (`fuel`); без CNF — 5 і 2, як у king.exe.
      if (cm) {
        const limit = (k: string, d: number) => (cnf ? num(assoc(cnf, k)?.[1], d) : d);
        this.caches = new Caches(
          {
            scene: this.world.scene,
            rapier: this.rapier,
            common: this.world.common,
            roadPoint: (p) => {
              const n = this.roads.nearest(p);
              return n ? n.line.pts[n.seg].clone().lerp(n.line.pts[n.seg + 1], n.t) : null;
            },
          },
          hiddenPlaces(this.world.regions.values()),
          { container: limit('containers', 5), fuel: limit('fuel', 2) },
          () => cm.cacheLot(),
        );
        if (o.career?.caches) this.caches.restore(o.career.caches);
      }
    }
    if (!o.race) {
      const [names, merch] = await Promise.all(['names.sch', 'merchandise.sch'].map((f) => o.source.read(f).then(readSch).catch((): SExpr[] => [])));
      // Рейси ботів: склади (вузли node_store_*, міста mod_*.sch) і товари merchandise.sch (traffic/freight.ts).
      const goods = parseGoods(merch);
      const freight = goods.length ? new Freight(this.roads, findStores(this.world.regions.values(), parseTowns(regionMods)), goods) : null;
      // Далекобійників у світі — `aitruck N` з playertypes GAME.CNF (усі існують весь час, traffic/fleet.ts).
      const ai = assoc(cnf ? (assoc(cnf, 'playertypes')?.slice(1) ?? []) : [], 'aitruck');
      this.truckers = new Truckers(this, this.roads, truckerNames(names), (r) => this.world.loaded.has(r), truckerKinds(vehicles, this.trucks), Math.round(4 * (o.settings?.traffic ?? 1)), this.semiTypes, freight, ai ? num(ai[1]) : AITRUCK);
      // Збережені далекобійники кар'єри — на своїх дорогах, з рейсами й вантажем.
      if (o.career?.fleet) this.truckers.restore(o.career.fleet);
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
      // Мережева гонка й арени — без трафіку (MENV/MTR GAME.CNF: dumb 0, у MTB доріг немає; у кожного телефона свій
      // трафік не збігався б).
      density: o.net || o.arena ? 0 : (o.settings?.traffic ?? 1),
    });
    this.traffic.signals = this.lights;
    // Цілі маршрутів трафіку — вузли WAY з FLAG & 2 (міста біля стоянок; king.exe 0x45cdc0).
    const goals: THREE.Vector3[] = [];
    for (const { way } of this.world.regions.values()) for (const room of way.rooms) for (const n of room.nodes) if (n.flag & 2) goals.push(toThree(...n.pos));
    if (goals.length) this.traffic.setGoals(goals);
    this.trafficGoals = goals;
    this.traffic.view = {
      range: () => (this.world.scene.fog as THREE.Fog | null)?.far ?? VIEW_FALLBACK,
      sees: (p) => this.canSee(p),
    };
    // Фізичні машини трафіку поруч з гравцем — та сама модель руху king.exe, що й у гравця, з їхнім vehicle.tech.
    this.traffic.physics = {
      make: (kind, pos, forward, speed, lights) => this.makeCar(kind.model, kind.variant, pos, forward, speed, true, lights),
      setLights: (v, on) => {
        const sw = this.carSwitches.get(v);
        sw?.('refer_HeadLightKey', on ? 1 : 0);
        sw?.('refer_SizeLightKey', on ? 1 : 0);
      },
      remove: (v) => this.removeCar(v),
    };
    if (!o.race) {
      // Обвали й повені (obstacle у mod_*.sch): діючий — зі збереження кар'єри.
      const list = parseObstacles(regionMods, this.world.regions.values());
      const closed = new Map<string, number[]>();
      this.obstacles = new Obstacles(
        list,
        { player: () => this.truck.visual.position, apply: (ob, on, announce) => this.applyObstacle(ob, on, announce, closed) },
        o.career?.obstacle,
      );
    }
    this.audio = await EngineAudio.create(this.world.commonRmp).catch(() => null);
    this.input.onCommand = (cmd) => {
      if (cmd === 'camera') {
        this.camMode = NEXT_CAM[this.camMode];
        // Ракурс по колу скидається разом із перемиканням камери.
        this.camOrbit = 0;
        this.input.setOrbitAvailable(this.camMode !== 'cockpit');
        // Нова камера — одразу на своєму місці: стара позиція лишилась там, де камеру вимкнули, і камера «летіла» до машини.
        this.chaseJump = true;
      }
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
      if (cmd === 'wipers') this.wipersManual = !this.wipersManual;
      if (cmd === 'mirror') this.mirrorOn = !this.mirrorOn;
      if (cmd === 'attach') this.toggleTrailer();
      // «Відновитися» — те саме, що 911 у меню Esc (на прохання користувача).
      if (cmd === 'reset') this.call911();
      if (cmd === 'menu') this.toggleEsc();
      if (cmd === 'f1' || cmd === 'f2' || cmd === 'f3' || cmd === 'f4') this.toggleF(Number(cmd[1]) as FPanel);
      if (cmd === 'f5') this.radio?.toggle();
      // Сигнал (0x543bb0): з покращенням — hornupgrSound.
      if (cmd === 'horn') this.audio?.playOnce(this.tuning.horn ? 'hornupgr' : 'horn');
      if (cmd === 'engine') {
        this.truck.engineOn = !this.truck.engineOn;
        if (this.truck.engineOn) this.audio?.play('start', 0.8);
      }
    };
    document.body.classList.add('driving');
    this.touch = this.input.mountTouch(o.overlay);
    this.input.setOrbitAvailable(this.camMode !== 'cockpit');
    // Межа керма за зчепленням для клавіатури (king.exe 0x500850) — від поточної вантажівки.
    this.input.steerLimit = () => this.truck.steerLimitNow();
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
    this.hud.append(burger);
    // Вільна їзда: шестерня — машина, телепорт, погода, розшук (ui/freeSettings.ts, на прохання користувача).
    if (!o.career && !o.race) {
      const gear = document.createElement('button');
      gear.className = 'ht2-hud-gear';
      gear.setAttribute('aria-label', 'Налаштування вільної їзди');
      gear.innerHTML = GEAR_SVG;
      gear.addEventListener('click', () => this.openFreeSettings());
      this.hud.append(gear);
    }
    this.hud.append(group);
    this.hudGroup = group;
    this.hudBurger = burger;
    document.addEventListener('pointerdown', this.onOutsideTap, true);
    document.addEventListener('visibilitychange', this.onHide);
    window.addEventListener('pagehide', this.onHide);
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
      this.tabMap = new TabMap(art, o.overlay, this.roads.axes, this.mapPoints, this.mapReveal);
      // Одразу — мінікарта (стан 2): у порту її видно з початку їзди (king.exe починає зі схованої карти).
      this.tabMap.show(2);
      document.body.classList.add('ht2-orig-ui');
    }
    window.addEventListener('resize', this.onResize);
    this.resize();
    o.setStatus('Підготовка шейдерів…');
    // Кабіна — до першого кадру, якщо їзда починається з неї (інакше вантажиться при першому вигляді з кабіни).
    if (this.camMode === 'cockpit') await this.loadCab();
    // Площини відсічення даху машини — до компіляції: вони теж у ключі шейдера (перший кадр компілював би машину знову).
    this.clipRoof(false);
    // Крок без часу — створює те, що зʼявляється з першим кадром (світло вибухів у blasts — точкове світло теж у ключі
    // шейдера, листя, опади, перші машини трафіку), щоб прогрів бачив сцену такою, як у грі.
    this.update(0);
    this.world.visibility.update(this.camera);
    await this.warmScene();
    this.last = performance.now();
    o.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /** Точка старту: найближча точка доріг WAY до (x, y) гри, напрям — уздовж сегмента; висота — променем униз. */
  private spawnAt([x, y, z]: [number, number, number]): { position: THREE.Vector3; forward: THREE.Vector3; widthRight: number } {
    let best = Infinity;
    let pos: [number, number, number] = [x, y, z];
    let dir: [number, number] = [0, 1];
    let widthRight = 0;
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
            widthRight = s.widthRight;
          }
        }
    const position = this.groundAt(toThree(...pos));
    return { position, forward: toThree(dir[0], dir[1], 0).normalize(), widthRight };
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
  /** Текстури регіону — на GPU по кілька за завдання, потім шейдери (compileAsync, без блокування де підтримується). */
  private async prepareRegion(root: THREE.Object3D): Promise<void> {
    const textures = new Set<THREE.Texture>();
    root.traverse((o) => {
      const ms = (o as THREE.Mesh).material;
      for (const m of Array.isArray(ms) ? ms : ms ? [ms] : []) {
        const t = (m as THREE.MeshLambertMaterial).map;
        if (t) textures.add(t);
      }
    });
    const r = this.opts.renderer;
    let n = 0;
    for (const t of textures) {
      r.initTexture(t);
      if (++n % TEXTURES_PER_TASK === 0) await yieldTask();
    }
    await this.compileLit(root);
  }

  /**
   * Шейдери root наперед — для всіх станів фар: без прожекторів, фари гравця (2), фари гравця й зустрічної (4).
   * Кількість прожекторів — у ключі шейдера three.js: без цього перше ввімкнення фар (чи сутінки з фарами зустрічних)
   * компілювало заново шейдери всього видимого (на ПК 16 шейдерів за 0,18 с; на телефоні — у кілька разів довше).
   * Шейдери кожного стану three.js тримає в матеріалі, тож далі перемикання — без компіляції. Стан задають сховані
   * прожектори-замінники (warmLamps, у сцені), справжні на час виклику ховаються; поточний стан — останнім.
   */
  private async compileLit(root: THREE.Object3D, scene: THREE.Scene = this.world.scene): Promise<void> {
    const r = this.opts.renderer;
    if (!this.warmLamps.length) {
      const map = new THREE.Texture();
      for (let i = 0; i < 4; i++) {
        const l = new THREE.SpotLight(0xffffff, 0);
        l.map = map;
        l.visible = false;
        this.world.scene.add(l);
        this.warmLamps.push(l);
      }
    }
    const real = [...this.lamps, ...this.carLamps];
    const now = real.filter((l) => l.visible).length;
    const tasks: Promise<unknown>[] = [];
    for (const count of [...LAMP_STATES.filter((c) => c !== now), now]) {
      if (this.disposed) break;
      const was = real.map((l) => l.visible);
      for (const l of real) l.visible = false;
      this.warmLamps.forEach((l, i) => (l.visible = i < count));
      // compileAsync будує шейдери синхронно з поточними світлами — одразу після виклику стан можна повернути.
      tasks.push(compileWithin(r, root, this.camera, scene));
      for (const l of this.warmLamps) l.visible = false;
      real.forEach((l, i) => (l.visible = was[i]));
      await yieldTask();
    }
    await Promise.all(tasks);
  }

  /** Сховані прожектори для compileLit (лише задають кількість світел під час компіляції). */
  private readonly warmLamps: THREE.SpotLight[] = [];

  /**
   * Шейдери всього, що вже в сцені (регіони старту — ще раз: їх готували до появи світла вибухів; небо, відблиски
   * сонця, опади, вибухи, машини з усіма варіантами перемикачів), — до першого кадру: інакше перша поява кожного
   * (зміна камери, дощ, вибух, фари) — ривок.
   */
  private async warmScene(): Promise<void> {
    for (const c of [...this.world.scene.children]) {
      if (this.warmLamps.includes(c as THREE.SpotLight)) continue;
      await this.compileLit(c);
    }
    // Салон — своя сцена зі своїм світлом (фари на нього не діють).
    if (this.cab) await compileWithin(this.opts.renderer, this.cab, this.camera, this.overlayScene);
  }

  /**
   * Колізії регіону — частинами між кадрами (разом ≈ 20 мс на регіон на ПК, з рештою підвантаження — ривок). Регіон
   * можуть вивантажити посеред побудови — тоді зупиняємось (готові колайдери прибрала removeRegion).
   */
  private async addRegion(reg: LoadedRegion): Promise<void> {
    const alive = () => this.world.loaded.get(reg.id) === reg && !this.disposed;
    const cs: RAPIER.Collider[] = [];
    this.colliders.set(reg.id, cs);
    const col = levelCollision(reg.built.assembler.b3d);
    // Проходи в межах-огорожах там, де на їхній лінії портал (межі ar_047…049 лежать на порталах): машина на самій
    // межі вже в сусідній кімнаті за підлогою, але ще торкається межі своєї.
    const portals = [...reg.portals.values()].flat().filter((p) => p.normal);
    openPortals(col, portals.map((p) => ({ a: [p.corners[0].x, -p.corners[0].z] as [number, number], b: [p.corners[1].x, -p.corners[1].z] as [number, number] })));
    await yieldTask();
    if (!alive()) return;
    // Колізії гілок перемикачів (обвали, рампа StartKey dr_099 біля фінішу Кільця) — окремо: діють лише в стані своєї
    // гілки й, як решта колізій кімнат, лише на машини своєї кімнати (ключ — `<гілка>|<кімната>`).
    const parts = new Map<string, { floors: number[][][]; surfaces: number[]; walls: number[][][] }>();
    const part = (tag: string, room: string) => {
      const k = `${tag}|${room}`;
      return parts.get(k) ?? parts.set(k, { floors: [], surfaces: [], walls: [] }).get(k)!;
    };
    const floors: number[][][] = [];
    const surfaces: number[] = [];
    const wallPolys: number[][][] = [];
    // Підлога кімнат — по кімнатах, як стіни нижче: чужа підлога, що перетинає дорогу (схил av_050 над дорогою
    // aw_001), — не перешкода. Без кімнати — для всіх.
    const roomSolid = new Map<string, { polys: number[][][]; surfaces: number[] }>();
    col.floors.forEach((p, i) => {
      const t = col.floorSwitch[i];
      const r = col.floorRoom[i];
      if (!t && r) {
        const g = roomSolid.get(r) ?? roomSolid.set(r, { polys: [], surfaces: [] }).get(r)!;
        g.polys.push(p);
        g.surfaces.push(col.floorSurface[i]);
        return;
      }
      (t ? part(t, r).floors : floors).push(p);
      (t ? part(t, r).surfaces : surfaces).push(col.floorSurface[i]);
    });
    // Стіни кімнат — по кімнатах: діють лише на машини в тій самій кімнаті (engine/physics/roomBounds.ts).
    const roomWalls = new Map<string, number[][][]>();
    col.walls.forEach((p, i) => {
      if (col.wallSwitch[i]) return part(col.wallSwitch[i], col.wallRoom[i]).walls.push(p);
      const r = col.wallRoom[i];
      (roomWalls.get(r) ?? roomWalls.set(r, []).get(r)!).push(p);
    });
    const roomFloors = new Map<string, number[][][]>();
    col.floors.forEach((p, i) => {
      const r = col.floorRoom[i];
      (roomFloors.get(r) ?? roomFloors.set(r, []).get(r)!).push(p);
    });
    for (const [r, polys] of roomFloors) this.roomBounds.addFloors(reg.id, r, polys);
    for (const [room, list] of reg.portals)
      this.roomBounds.addPortals(reg.id, room, list.map((p) => ({
        to: p.to,
        a: [p.corners[0].x, -p.corners[0].z] as [number, number],
        b: [p.corners[2].x, -p.corners[2].z] as [number, number],
        z0: Math.min(p.corners[0].y, p.corners[2].y),
        z1: Math.max(p.corners[0].y, p.corners[2].y),
      })));
    // Будівлі складів, СТО, заправки — окремі обʼєкти колізій, розставлені екземплярами.
    const asm = reg.built.assembler;
    const inst = instanceCollision(asm.b3d, (n) => asm.block(n) ?? this.world.common.block(n), (n) => asm.space(n));
    floors.push(...inst.floors);
    surfaces.push(...inst.floorSurface);
    wallPolys.push(...inst.walls);
    // Стовпчики sharp_* без подій (ніжки щитів і вказівників, стовпи огорож) — як стіни своєї кімнати.
    const keys = new Set([...col.wallSwitch, ...col.floorSwitch].filter(Boolean).map((t) => t.split('#')[0]));
    const posts = roomPosts(asm.b3d, (n) => asm.block(n) ?? this.world.common.block(n), (n) => asm.space(n), keys, roomGround(col));
    posts.walls.forEach((p, i) => {
      const r = posts.wallRoom[i];
      if (posts.wallSwitch[i]) part(posts.wallSwitch[i], r).walls.push(p);
      else (roomWalls.get(r) ?? roomWalls.set(r, []).get(r)!).push(p);
    });
    // Процедурний рельєф (aa) — heightfield.
    if (reg.terrain) cs.push(terrainCollider(this.rapier, reg.terrain));
    // Trimesh — шматками по COLLIDER_CHUNK полігонів (великий регіон — ≈ 100 мс одним шматком); колеса — промені,
    // шви між колайдерами їм не заважають.
    for (const [polys, friction, surf] of [[floors, 1.0, surfaces], [wallPolys, 0.4, undefined]] as const)
      for (let i = 0; i < polys.length; i += COLLIDER_CHUNK) {
        const c = addCollisionPolys(this.rapier, polys.slice(i, i + COLLIDER_CHUNK), friction, surf?.slice(i, i + COLLIDER_CHUNK));
        if (c) cs.push(c);
        await yieldTask();
        if (!alive()) return;
      }
    for (const [r, g] of roomSolid) {
      const c = this.roomBounds.addFloorCollider(reg.id, r, g.polys, g.surfaces);
      if (c) cs.push(c);
    }
    for (const [r, polys] of roomWalls) {
      const c = this.roomBounds.addWalls(reg.id, r, polys);
      if (c) cs.push(c);
    }
    const switched = new Map<string, RAPIER.Collider[]>();
    for (const [k, g] of parts) {
      const [tag, room] = k.split('|');
      const list = (room
        ? [this.roomBounds.addFloorCollider(reg.id, room, g.floors, g.surfaces), this.roomBounds.addWalls(reg.id, room, g.walls)]
        : [addCollisionPolys(this.rapier, g.floors, 1.0, g.surfaces), addCollisionPolys(this.rapier, g.walls, 0.4)]
      ).filter((c): c is RAPIER.Collider => !!c);
      const [key, branch] = tag.split('#');
      for (const c of list) c.setEnabled((this.worldSwitches.get(key) ?? 0) === Number(branch));
      switched.set(tag, [...(switched.get(tag) ?? []), ...list]);
      cs.push(...list);
    }
    this.switchColliders.set(reg.id, switched);
    for (const [key, state] of this.worldSwitches) this.showSwitch(reg, key, state);
    if (!col.hasFloor && !reg.terrain) {
      const c = groundFromMeshes(this.rapier, reg.built.root);
      if (c) cs.push(c);
    }
    this.objects.addRegion(reg.id, reg.built.root, reg.poles, reg.movables);
    this.wallsPending.push(reg.id);
  }

  /**
   * Відстань від точки лінії до стіни вбік (side), м: брусок завдовжки 2·half уздовж лінії й заввишки 0,6–3 м над
   * дорогою — ловить і рампи складів, і тонкі колони навісів, між якими промінь проскакує. Ґрунт (похила нормаль) і
   * тіла (причепи баз, машини) не рахуються.
   */
  private wallProbe = (p: THREE.Vector3, along: THREE.Vector3, side: THREE.Vector3, half: number, max: number): number => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-along.z, along.x));
    const hit = this.rapier.castShape({ x: p.x, y: p.y + 1.8, z: p.z }, q, side, new RAPIER.Cuboid(half, 1.2, 0.05), 0, max, true, undefined, undefined, undefined, undefined, (c) => !c.parent());
    return hit && Math.abs(hit.normal1.y) < 0.6 ? hit.time_of_impact : Infinity;
  };

  private removeRegion(id: string): void {
    this.roomBounds.removeRegion(id, this.colliders.get(id) ?? []);
    for (const c of this.colliders.get(id) ?? []) {
      forgetSurfaces(c);
      this.rapier.removeCollider(c, false);
    }
    this.colliders.delete(id);
    this.switchColliders.delete(id);
    this.objects.removeRegion(id);
  }

  /** Стан перемикача світу (обвали): видима гілка в усіх регіонах і колайдери гілки. */
  setWorldSwitch(key: string, state: number): void {
    this.worldSwitches.set(key, state);
    for (const reg of this.world.loaded.values()) this.showSwitch(reg, key, state);
    for (const m of this.switchColliders.values())
      for (const [tag, list] of m) {
        const [k, branch] = tag.split('#');
        if (k === key) for (const c of list) c.setEnabled(Number(branch) === state);
      }
  }

  private showSwitch(reg: LoadedRegion, key: string, state: number): void {
    reg.built.assembler.setSwitch(key, state);
    reg.built.assembler.setSwitch(`refer_${key}`, state);
  }

  /**
   * Увімкнути чи вимкнути завал (king.exe 0x42b060): перемикач, дорога між вузлами завалу (маршрути трафіку
   * перераховуються), каток на місцях `pos_work`, текст на табло.
   */
  private applyObstacle(ob: Obstacle, on: boolean, announce: boolean, closed: Map<string, number[]>): void {
    this.setWorldSwitch(ob.key, on ? 1 : 0);
    if (ob.ends) {
      if (!closed.has(ob.id)) closed.set(ob.id, closedAxes(this.roads, ob.ends));
      const at = ob.ends[0].clone().lerp(ob.ends[1], 0.5);
      for (const r of closed.get(ob.id)!) this.roads.setClosed(r, on, at);
      if (this.traffic && this.trafficGoals.length) this.traffic.setGoals(this.trafficGoals);
    }
    for (const p of this.obstacleProps.get(ob.id) ?? []) {
      this.world.scene.remove(p.root);
      this.rapier.removeRigidBody(p.body);
    }
    this.obstacleProps.delete(ob.id);
    if (on) this.obstacleProps.set(ob.id, ob.work.map((w) => this.placeKatok(w)).filter((x): x is { root: THREE.Object3D; body: RAPIER.RigidBody } => !!x));
    const text = on ? ob.closeText : ob.openText;
    if (announce && text) this.say(ukSign(text), 8);
  }

  /** Каток KATOK (TRUCKS.B3D) на вузлі `pos_work`: уздовж найближчої дороги, нерухомий брус колізії. */
  private placeKatok(at: THREE.Vector3): { root: THREE.Object3D; body: RAPIER.RigidBody } | null {
    const tpl = this.trucks.asm.template('Katok');
    if (!tpl) return null;
    const model = tpl.clone();
    const frame = new THREE.Group();
    frame.rotation.x = -Math.PI / 2;
    frame.add(model);
    const root = new THREE.Group();
    root.add(frame);
    root.updateMatrixWorld(true);
    const box = visibleBox(model);
    frame.position.y = -box.min.y;
    // Вузол WAY — на 1,5…2,5 м над дорогою, а регіон може бути ще не завантажений: висота — з лінії дороги поруч
    // (точки WAY лежать на покритті).
    const near = this.roads.nearest(at);
    const on = near && near.dist < 15 ? near.line.pts[near.seg].clone().lerp(near.line.pts[near.seg + 1], near.t) : null;
    at = new THREE.Vector3(at.x, on ? on.y : at.y, at.z);
    root.position.copy(at);
    const dir = near ? near.line.pts[near.seg + 1].clone().sub(near.line.pts[near.seg]).setY(0).normalize() : new THREE.Vector3(0, 0, -1);
    root.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, new THREE.Vector3(0, 1, 0)));
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const body = this.rapier.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(at.x, at.y, at.z).setRotation(root.quaternion));
    this.rapier.createCollider(
      RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2)
        .setTranslation(center.x, center.y - box.min.y, center.z)
        .setCollisionGroups(groups(GROUP_WORLD, 0xffff)),
      body,
    );
    this.world.scene.add(root);
    return { root, body };
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
    this.paused = this.canPause;
    const t = this.truck.body.translation();
    this.worldMap.open(new THREE.Vector3(t.x, t.y, t.z), this.truck.forward(), this.careerMode?.target() ?? null);
  }

  /** Кадрів після перестановки машини, коли удари не рахуємо (стрибок швидкості — не удар). */
  private skipHits = 0;

  /**
   * Удари: різка зміна горизонтальної швидкості за кадр від зіткнень (понад 2 м/с; кінематичний поворот king.exe —
   * не удар, HitMeter) — вмʼятина в зоні, звідки прийшов удар (зміна швидкості в системі машини, dents.ts).
   * hitDv — та сама зміна з вертикаллю, для пошкоджень кар'єри.
   */
  private detectHits(): void {
    this.hitDv.copy(this.truck.hits.take());
    if (this.skipHits > 0) {
      this.skipHits--;
      this.hitDv.set(0, 0, 0);
      return;
    }
    const dv = this.hitDv.clone().setY(0);
    // Посилена рама: імпульс удару ×0,3 від самого початку (0x554c20); захист фар — деформація переду ×0,2.
    const t = this.tuning;
    dv.multiplyScalar(t.damage);
    if (dv.length() < 2) return;
    // Займання від удару об нерухоме (0x554c20 → 0x549900): сила удару (з урахуванням рами) понад IMPACT_FIRE м/с і
    // поруч немає машини (удар не об машину).
    if (dv.length() > IMPACT_FIRE && !this.carNear(this.truck.visual.position, 10)) this.ignite(0, true);
    // Шкода для стану машини (кар'єра) — з того самого удару, що мне кузов: середній приріст часток 8 зон вмʼятин
    // (гіпотеза порту; у king.exe стан — зважена сума зон і систем, ваги не знайдено). Без перемикачів у моделі — за
    // енергією удару, як середня зона (швидкість 0,1).
    const local = dv.applyQuaternion(this.truck.visual.quaternion.clone().invert());
    this.hitWear += this.dents ? this.dents.hit(local, t.front) : (hitEnergy(dv.length()) * 0.1) / 8;
  }

  /** Шкода від ударів з останнього кроку кар'єри (0…1 стану машини; careerMode забирає й обнуляє). */
  hitWear = 0;

  /** Чи є машина (трафік, міліція, мафія, далекобійники) ближче r. */
  private carNear(p: THREE.Vector3, r: number): boolean {
    const near = (q: THREE.Vector3) => q.distanceTo(p) < r;
    return (
      (this.traffic?.cars.some((c) => near(c.pos)) ?? false) ||
      (this.police?.near(p, r) ?? false) ||
      (this.mafia?.hoods.some((h) => near(h.v.visual.position)) ?? false) ||
      (this.truckers?.positions.some(near) ?? false)
    );
  }

  /** Удари в напівпричіп — так само, за зміною його швидкості (рама тягача причіп не захищає). */
  private detectTrailerHits(): void {
    const dv = this.trailer?.velocityChange();
    if (!dv || this.skipHits > 0 || dv.length() < 2) return;
    this.trailerDents?.hit(dv);
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
      // Партнер ДТП — лише машина (king.exe 0x54f040 пише партнера, лише коли тіло — у списку машин 0x53f750):
      // стовпи, бочки, огорожі, причепи на базах, декоративні припарковані машини — без штрафу (police.md «ДТП з
      // іншими обʼєктами»). Машини — фізичний трафік, міліція, мафія, далекобійники й наймані.
      candidates: () => {
        const p = this.truck.visual.position;
        const cars = [
          ...(this.traffic?.cars.flatMap((c) => (c.vehicle ? [c.vehicle.body] : [])) ?? []),
          ...(this.police?.cops.map((c) => c.v.body) ?? []),
          ...(this.mafia?.hoods.map((h) => h.v.body) ?? []),
          ...(this.truckers?.rigs ?? []).flatMap((r) => [r.truck.body, ...(r.trailer ? [r.trailer.body] : [])]),
        ];
        return cars.filter((b) => {
          const t = b.translation();
          return Math.hypot(t.x - p.x, t.z - p.z) < 150;
        });
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
      // «Міліція поруч» (0x4cfd10): машина міліції чи гелікоптер (контролер Ка-50) ближче 200 м.
      policeNear: (p) => (this.police?.near(p, 200) ?? false) || (this.copters?.near(p, 200) ?? false),
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
    const base = { cargoMass: this.hitched ? 0 : cargo, torque: t.torque, surfaceEffects: !this.arcade, tractionControl: t.antiSpin, engineBrake: t.engineBrake };
    // Рух king.exe (G10 В3); `?physics=rapier` — колишня модель на шинах Rapier (для порівняння).
    if (new URLSearchParams(location.search).get('physics') === 'rapier') return { ...base, engine: HT2_ENGINE, brake: HT2_BRAKE, rollLift: HT2_ROLL_LIFT, steerLimit: HT2_STEER_LIMIT, steerPower: HT2_STEER_POWER };
    // Машина гравця в king.exe — у динамічному режимі 3 (телеметрія 2026-10-18): бічні сили шин, μ 0,83 із запису;
    // межа керма — з величин king.exe: C = μ·k·L = 0,83·9,8·7,9 ≈ 64 (ZilR; підгонка 8,8 була під кінематику — з шинами
    // радіуси виходили в 1,5–3 рази більші за запис). `?physics=kinematic` — колишній кінематичний рух.
    if (new URLSearchParams(location.search).get('physics') === 'kinematic') return { ...base, engine: HT2_KING_ENGINE, brake: HT2_KING_BRAKE, king: { ...HT2_KING, travel: this.rec?.suspension } };
    const king = { ...HT2_KING, travel: this.rec?.suspension, tires: true, sideGrip: KING_EXE_MU / HT2_KING.mu, steerK: (KING_EXE_MU * 9.8 * KING_EXE_BASE) / (HT2_KING.mu * ZILR_BASE), arcade: this.arcade };
    return { ...base, engine: HT2_KING_ENGINE, brake: HT2_KING_BRAKE, king };
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
    const m = this.truck.visual.userData.model as TruckModel | undefined;
    this.setTruckSwitch = m?.setSwitch;
    // Логотип компанії на кузові (у тягачів IconKey немає — лише на причепі).
    m?.setSwitch?.('refer_IconKey', this.ownIcon);
    this.dents = new Dents(this.opts.career ? (this.opts.career.dents ??= {}) : this.freeDents, m?.setSwitch, m?.switchStates, m ? dentGeometry(m, visibleBox(m.body)) : null);
    this.trailerDents = null;
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
    // Кар'єра: причіп — підібраний на базі (presents.ts); старе збереження без поля — модуль (у «Шторма» — свій).
    const c = this.opts.career;
    if (c && c.trailer === undefined) c.trailer = /^Storm/i.test(rec.carNode) ? { id: 'URAGAN_SEMITRAILER', carNode: 'STrailerStorm', cluster: 0 } : { id: 'SEMITRAILER1', carNode: 'STrailerM', cluster: 0 };
    if (c && !c.trailer) return;
    const want = c?.trailer ? c.trailer.carNode : /^Storm/i.test(rec.carNode) ? 'STrailerStorm' : this.opts.trailer || 'STrailerM';
    const tr = trailers.find((r) => r.carNode.toLowerCase() === want.toLowerCase()) ?? trailers[0];
    const def = tr && truckDef(this.trucks, tr);
    if (!tr || !def) return;
    const cluster = c?.trailer?.cluster ?? 0;
    const paint = cluster > 0 ? (root: THREE.Object3D) => recolor(root, this.trucks, cluster + 1) : undefined;
    this.trailer = new Trailer(this.rapier, this.trucks.asm, def, tr, { body: this.truck.body, saddle: rec.lowSaddle }, this.cargoMass, paint);
    this.world.scene.add(this.trailer.visual);
    this.trailer.setSwitch?.('refer_IconKey', this.ownIcon);
    const trl = this.trailer;
    this.trailerDents = new Dents(this.opts.career ? (this.opts.career.trailerDents ??= {}) : this.freeTrailerDents, trl.setSwitch, trl.switchStates, trl.dentGeom);
    this.truck.towing = true;
    const trailerBody = this.trailer.body.handle;
    this.truck.rayFilter = (c) => c.parent()?.handle !== trailerBody;
    this.truck.setTowLoad(this.trailer.kingpinLoad);
    this.truck.tow = { mass: this.trailer.mass, wheels: this.trailer.wheelCount, saddleLoad: this.trailer.kingpinLoad, saddleZ: g2t(rec.lowSaddle).z };
  }

  /**
   * Стан IconKey машини компанії гравця (king.exe 0x43f840: логотип компанії власника + 1; 0 — без логотипа):
   * логотип водія з меню «Водії» (кар'єра — збережений у ній, вільна їзда — поточного водія).
   */
  private get ownIcon(): number {
    return (this.opts.career?.logo ?? currentDriver()?.logo ?? 4) + 1;
  }

  /**
   * Логотипи на машинах далекобійників (раз на машину): у найманих — компанії гравця (роботодавця), у решти —
   * немає (власних компаній у ботів порт не веде; king.exe — логотип лише компанії з найманими, 0x476a30).
   */
  private stampIcons(): void {
    const t = this.truckers;
    if (!t) return;
    const stamp = (r: { truck: object; setSwitch?: (n: string, s: number) => void; trailer: { setSwitch?: (n: string, s: number) => void } | null }, icon: number) => {
      if (this.iconed.has(r.truck)) return;
      this.iconed.add(r.truck);
      r.setSwitch?.('refer_IconKey', icon);
      r.trailer?.setSwitch?.('refer_IconKey', icon);
    };
    for (const r of t.list) stamp(r, 0);
    for (const r of t.hired.values()) stamp(r, this.ownIcon);
  }

  /**
   * Наймані водії на дорогах (career/hired.ts): далеко — абстрактно вздовж мережі, ближче — машиною
   * (Truckers.syncHired), позиція — за машиною; новий найманий — на дорозі біля гравця.
   */
  private hiredStep(dt: number): void {
    const cm = this.careerMode;
    const c = cm?.career;
    const drivers = c?.company ?? [];
    if (!cm || !c || (!drivers.length && !this.truckers?.hired.size && !this.hiredMarks.length)) return;
    const hr = (this.hiredRoads ??= new HiredOnRoads(this.roads));
    const want: { name: string; carNode: string; pos: THREE.Vector3; forward: THREE.Vector3 }[] = [];
    // Абстрактна швидкість (0x41a9d0): не менше 13,89 м/с або згладжена швидкість гравця.
    const speed = Math.max(HIRED_MIN_SPEED, Math.abs(this.truck.speedKmh) / 3.6);
    const dock = (id: number) => {
      const st = cm.stores.find((x) => x.id === id);
      return st?.docks.length ? toThree(...st.docks[0]) : null;
    };
    for (const d of [...drivers]) {
      const rec = this.trucks.records.find((r) => r.carNode === d.truck);
      upgradeDriver(d, this.vehiclePrice(d.truck), cm.marketShare());
      const phys = this.truckers?.hired.get(d.name);
      const before = hr.at(d)?.pos ?? null;
      let meters = 0;
      // Новий найманий — на дорозі за 40 м попереду гравця (не в його машині).
      if (!d.road) hr.place(d, this.truck.visual.position.clone().addScaledVector(this.truck.forward(), 40));
      else if (phys) {
        hr.place(d, phys.truck.visual.position);
        meters = before ? before.distanceTo(phys.truck.visual.position) : 0;
      } else {
        // Маршрут до складу рейсу; немає шляху — їде далі й пробує знову з наступної лінії.
        const target = d.trip ? dock(d.trip.to) : null;
        if (target && !d.road.route && d.road.line !== this.hiredNoRoute.get(d.name)) {
          if (!hr.routeTo(d, target)) this.hiredNoRoute.set(d.name, d.road.line);
        }
        hr.advance(d, speed * dt);
        meters = speed * dt;
      }
      // Аванс і пальне (0x423f40); нема чим платити — іде й повертає вартість машини (0x476f70).
      if (!driverCosts(d, meters, c, rec?.fuelConsumption ?? 5)) {
        c.money += d.value ?? 0;
        c.company = (c.company ?? []).filter((x) => x !== d);
        this.truckers?.dropHired(d.name);
        this.say(cm.msg('NO_MONEY_FOR_ADVANCE', 'ВАШ НАЙМАНИЙ ВОДІЙ ЗВІЛЬНИВСЯ - У ВАС НЕ БУЛО ГРОШЕЙ, ЩОБ ЗАПЛАТИТИ'));
        cm.persist();
        continue;
      }
      const at = hr.at(d);
      if (at) want.push({ name: d.name, carNode: d.truck, ...at });
      if (!at) continue;
      // Рейс як у далекобійника ІІ (0x4185d0): порожнім — до найближчого складу, там вантаж до іншого складу.
      if (!d.trip) {
        const near = [...cm.stores].sort((a, b) => toThree(...a.center).distanceTo(at.pos) - toThree(...b.center).distanceTo(at.pos))[0];
        if (near) d.trip = { to: near.id };
        if (d.road) delete d.road.route;
        continue;
      }
      const target = dock(d.trip.to);
      // Прибув: біля складу або пройшов маршрут до лінії біля нього.
      if (!target || (target.distanceTo(at.pos) > HIRED_ARRIVE && !hr.routeDone(d))) continue;
      if (d.trip.load) {
        // Розвантаження: оплата — роботодавцю, прибуток водія росте; повідомлень немає (0x417660 — лише людині).
        c.money += d.trip.load.pay;
        d.profit += d.trip.load.pay;
        d.trip = undefined;
      } else {
        const from = cm.stores.find((x) => x.id === d.trip!.to)!;
        const tractor = rec?.group === 'tractors';
        const tr = tractor ? this.trucks.records.find((r) => r.carNode === 'STrailerM') : undefined;
        const body = tr ?? rec;
        const cap = { mass: body?.cargoLoad ?? 0, volume: body ? body.bodySquare * body.bodyHeight : 0 };
        d.trip = hiredLoad(from, cm.stores, cm.goodsList, cap, tractor, (to) => this.storeRoute(from, to)) ?? undefined;
      }
      if (d.road) delete d.road.route;
    }
    this.truckers?.syncHired(want, this.truck.visual.position);
    this.hiredMarks = want.map((w) => w.pos);
  }

  /** Клас машини гравця з vehicle.tech (lorries, tractors…) — суперники гонки в кар'єрі того самого класу. */
  get truckGroup(): string | undefined {
    return this.rec?.group;
  }

  /** Тягач гравця може тягти тип причепа: «Шторм» — лише свій, інші — модулі й цистерни (evehicles.sch). */
  private canTow(k: SemiKind): boolean {
    const storm = /^Storm/i.test(this.rec?.carNode ?? '');
    return storm === /^STrailerStorm$/i.test(k.carNode);
  }

  /**
   * VVK_ATTACH_SEMITRAILER (T): без причепа — причепити present поруч (умови presents.hitchable), з причепом —
   * відчепити: причіп лишається на місці present'ом. Гіпотеза порту: відчепити — лише майже на місці (до 5 км/год) і
   * без вантажу в причепі (в оригіналі причіп з вантажем стає «місією» на дорозі — ще не перенесено).
   */
  /**
   * Відчепити причіп (клавіша чи розрив зчіпки, 0x55d5d0 → looseSemitrailer 0x41fa00): у кар'єрі причіп лишається на
   * місці present'ом, з вантажем — «місією» з тим самим замовленням і строком; у вільній їзді (presents немає) —
   * зникає.
   */
  private dropTrailer(): void {
    if (!this.trailer) return;
    const c = this.opts.career;
    const t = this.trailer.visual;
    if (c && this.presents) {
      const kind = this.semiTypes.find((k) => k.id === c.trailer?.id);
      const order = c.order ?? undefined;
      if (kind) this.presents.drop(kind, t.position.clone(), new THREE.Vector3(0, 0, -1).applyQuaternion(t.quaternion), c.time, { order, dents: { ...(c.trailerDents ?? {}) } });
      if (order) c.order = null;
      c.trailer = null;
      c.trailerDents = {};
      if (order) this.setCargo(0);
    }
    this.world.scene.remove(t);
    this.trailer.dispose();
    this.trailer = null;
    this.trailerDents = null;
    this.truck.towing = false;
    this.truck.rayFilter = undefined;
    this.truck.setTowLoad(0);
    this.truck.tow = null;
    if (c && this.presents) {
      c.presents = this.presents.snapshot();
      this.careerMode?.persist();
    }
  }

  private toggleTrailer(): void {
    const c = this.opts.career;
    if (!this.hitched || this.race) return;
    // Вільна їзда (кинутих причепів — presents — немає): причіп зникає й зʼявляється знову на сідлі (порт; раніше
    // клавіша тут мовчки нічого не робила).
    if (!c || !this.presents) {
      if (this.truck.speedKmh > 5) return this.say(this.trailer ? 'ЗУПИНІТЬСЯ, ЩОБ ВІДЧЕПИТИ ПРИЧІП' : 'ЗУПИНІТЬСЯ, ЩОБ ПРИЧЕПИТИ ПРИЧІП');
      if (this.trailer) {
        this.dropTrailer();
        this.say('ПРИЧІП ВІДЧЕПЛЕНО');
      } else {
        this.hitch();
        if (this.trailer) this.say('ПРИЧІП ПРИЧЕПЛЕНО');
      }
      return;
    }
    if (this.trailer) {
      if (this.truck.speedKmh > 5) return this.say('ЗУПИНІТЬСЯ, ЩОБ ВІДЧЕПИТИ ПРИЧІП');
      this.dropTrailer();
      this.say('ПРИЧІП ВІДЧЕПЛЕНО');
      return;
    }
    const rec = this.rec!;
    const saddle = g2t(rec.lowSaddle).applyMatrix4(this.truck.visual.matrixWorld);
    const { present, why } = this.presents.hitchable(saddle, this.truck.forward(), (k) => this.canTow(k));
    if (!present) {
      this.say(why === 'type' ? 'ЦЕЙ ПРИЧІП НЕ ПІДХОДИТЬ ДО ТЯГАЧА' : why === 'align' ? 'ПІДЇДЬТЕ СІДЛОМ ДО ШВОРНЯ ПРИЧЕПА' : 'ПОРУЧ НЕМАЄ ПРИЧЕПА');
      return;
    }
    const take = () => {
      this.presents!.take(present);
      c.trailer = { id: present.kind.id, carNode: present.kind.carNode, cluster: present.kind.cluster } satisfies TrailerChoice;
      c.trailerDents = { ...(present.dents ?? {}) };
      this.hitch();
      this.say('ПРИЧІП ПРИЧЕПЛЕНО');
      c.presents = this.presents!.snapshot();
      this.careerMode?.persist();
    };
    // Свій кинутий причіп з вантажем — те саме замовлення далі (строк не скидається, 0x41f0d0).
    if (present.order) {
      if (c.order) return this.say('СПОЧАТКУ ДОСТАВТЕ ВАНТАЖ');
      const o = present.order;
      take();
      c.order = o;
      this.setCargo(o.goods.mass * o.units);
      this.careerMode?.persist();
      return;
    }
    // Причіп з вантажем — спершу вікно замовлення (0x56bc80): взяв — зчіпка й вантаж у причепі.
    const lot = present.lot;
    const trailerRec = this.trucks.records.find((r) => r.carNode.toLowerCase() === present.kind.carNode.toLowerCase());
    if (!lot || !trailerRec || !this.careerMode) return take();
    if (this.offering) return;
    this.offering = true;
    void this.careerMode.offerMission(lot, trailerRec).then((ok) => {
      this.offering = false;
      if (!ok || !this.presents?.list.includes(present)) return;
      take();
      const o = c.order;
      if (o) this.setCargo(o.goods.mass * o.units);
    });
  }

  /**
   * Схованки: дозаповнення й моделі; гравець зупинився (до 5 км/год) ближче 20 м від контейнера — вікно замовлення
   * (king.exe подія 0x14; підтвердження — «Взяти»). Взяв — контейнер зникає (місце звільняється), вантаж у кузові.
   */
  private cacheStep(cm: CareerMode, dt: number): void {
    const caches = this.caches!;
    caches.update(this.truck.visual.position, dt);
    const near = caches.near(this.truck.visual.position);
    if (this.cacheOffered && this.cacheOffered !== near) this.cacheOffered = null;
    if (!near || near === this.cacheOffered || this.offering || this.paused || this.truck.speedKmh > 5) return;
    this.cacheOffered = near;
    this.offering = true;
    void cm.offerCache(near.lot!).then((ok) => {
      this.offering = false;
      if (!ok || !caches.list.includes(near)) return;
      caches.take(near);
      const o = cm.career.order;
      if (o) this.setCargo(o.goods.mass * o.units);
      cm.career.caches = caches.snapshot();
      cm.persist();
    });
  }

  /** Вантажопідйомність і обʼєм (площа × висота, гіпотеза): кузова вантажівки або напівпричепа; тягач без причепа — 0. */
  get cargoSpace(): { mass: number; volume: number } {
    if (this.hitched && !this.trailer) return { mass: 0, volume: 0 };
    const t = this.trailer?.rec ?? this.def.tech;
    return { mass: t.cargoLoad, volume: Math.max(1, t.bodySquare * t.bodyHeight) };
  }

  /**
   * Фари — прожектори в системі машини: точки Fara_FL/FR (vehicle.tech, система моделі: x, вперед, угору), світять
   * уперед. Ближнє світло (на прохання користувача): маска vehicles/headlights.ts — межа на LAMP_CUTOFF м попереду,
   * вище неї (зустрічні машини) не світить. Вісь — горизонтально, без згасання з відстанню й без залежності від кута
   * падіння (installHeadlightShading): дорога й вертикальні предмети освітлені однаково; LAMP_ROAD і межа — на око.
   */
  private mountLamps(): void {
    this.lamps.length = 0;
    this.lampMask?.dispose();
    const rec = this.trucks.records.find((r) => r.carNode === this.def.carNode);
    const spots = rec ? [rec.faraFL, rec.faraFR] : [[-0.8, 2.4, 0.2], [0.8, 2.4, 0.2]];
    const h = g2t(spots[0] as [number, number, number]).y - this.truck.lightGeometry.groundY;
    this.lampMask = headlightMask(h, LAMP_CUTOFF, LAMP_ANGLE);
    for (const f of spots) {
      const p = g2t(f as [number, number, number]);
      const lamp = new THREE.SpotLight(0xfff2d0, LAMP_ROAD, LAMP_CUTOFF * 2, LAMP_ANGLE, 0.15, 0);
      lamp.map = this.lampMask;
      lamp.position.copy(p);
      lamp.target.position.copy(p).add(new THREE.Vector3(0, 0, -20));
      lamp.visible = false;
      this.truck.visual.add(lamp, lamp.target);
      this.lamps.push(lamp);
    }
  }

  /**
   * Прожектори фар найближчої зустрічної машини: точки й напрям — з Traffic.spot чи Truckers.spot (оновлюють
   * traffic.update і truckers.after), ближча з двох; трафік не бере машин, далших за бота-кандидата.
   */
  private updateCarLamp(on: boolean): void {
    const t = this.traffic!;
    const b = this.truckers;
    // Нічне світло дороги: розсіяне + місяць під ~45° (cos ≈ 0,7); сила фари — у тих самих одиницях (÷ π).
    POOL_BASE.copy(this.world.moonColor).multiplyScalar(0.7).add(this.world.ambientColor);
    setPoolLight(LAMP_COLOR, LAMP_ROAD / Math.PI, POOL_BASE);
    t.spotWanted = on;
    if (b) b.spotWanted = on;
    t.spotLimit = b?.spot?.dist ?? Infinity;
    if (!on) {
      for (const l of this.carLamps) l.visible = false;
      return;
    }
    if (!this.carLamps.length) {
      const mask = headlightMask(CAR_LAMP_HEIGHT, CAR_LAMP_CUTOFF, LAMP_ANGLE);
      for (let i = 0; i < 2; i++) {
        const lamp = new THREE.SpotLight(LAMP_COLOR, 0, CAR_LAMP_CUTOFF * 2, LAMP_ANGLE, 0.15, 0);
        lamp.map = mask;
        this.world.scene.add(lamp, lamp.target);
        this.carLamps.push(lamp);
      }
    }
    const s = t.spot ?? b?.spot ?? null;
    if (b) b.spotTaken = !t.spot && !!b.spot;
    // Пляма й прожектори перетікають одне в одне (spotShare), колір плями — як від прожектора (setPoolLight).
    const share = s ? spotShare(s.dist) : 0;
    this.carLamps.forEach((lamp, i) => {
      lamp.visible = true;
      lamp.intensity = LAMP_ROAD * share;
      if (!s) return;
      lamp.position.copy(i ? s.right : s.left);
      lamp.target.position.copy(lamp.position).addScaledVector(s.dir, 20);
      lamp.target.updateMatrixWorld();
    });
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
    this.debris.update(dt, anchor, this.debrisLook, wind, w, this.world.regionAt(p.x, -p.z), this.camera.position);
  }

  /** Дощ і сніг частинками (world/precipitation.ts): що падає — за висотою камери, сила — показник погоди w. */
  private updatePrecip(dt: number, wind: number, w: number): void {
    if (!this.precip) {
      this.precip = new Precipitation(this.world.common);
      this.world.scene.add(this.precip.group);
    }
    const fog = this.world.scene.fog as THREE.Fog | null;
    this.precip.update(dt, this.camera, Math.abs(this.truck.speedKmh) / 3.6, w, wind, fog?.color ?? FOG_FALLBACK, precipitation());
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
    // Спецнабір погоди кімнати (тунелі, гори; world/weatherRooms.ts) — за позицією машини гравця.
    const tp = this.truck.visual.position;
    const near = this.roads.nearestAxis(tp);
    const room = near && near.dist < 30 ? near.axis.name.split('#')[0] : null;
    this.world.special = { ...this.weatherRooms.update(this.world.loaded.values(), tp, room, this.world.regionAt(tp.x, -tp.z) ?? null) };
    this.weatherFlags = this.world.weatherFlags();
    this.updateThunder(dt);
    this.tick++;
    // Спалах: розсіяне світло до (0,9, 1, 1) (king.exe 0x005a9540 — через кадр протягом 1 с; на прохання користувача
    // — один плавний спалах без мерехтіння, коротший і мʼякший); thund=off — без спалаху.
    this.world.setClimate(hour, c.bad, this.weatherFlags.thund ? FLASH_PEAK * flashLevel(FLASH_TIME - this.flashTime) : 0, c.w());
    // Дальня площина — як у king.exe, frpl · fogf (world.viewFar); небо й ореоли не обрізаються (engine/render/farClip.ts).
    const far = this.world.viewFar;
    if (this.camera.far !== far) {
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
    this.world.updateTrees(dt, c.wind, this.camera.position);
    this.updateDebris(dt, c.wind, c.w());
    this.updatePrecip(dt, c.wind, c.w());
    this.updateWheelFx();
    this.blastFx().update(dt, c.wind, this.camera.position);
    const dusk = sunHeight(hour) < 0.2;
    this.world.setNight(dusk);
    this.cabLight?.color.setScalar(cabAmbient(hour));
    // Фари чужих машин — ще й за повзунками графіки (g > 0,5 і d > 0,5, ui/effects.ts).
    if (this.traffic) {
      this.traffic.lights = trafficLights(hour) && trafficHeadlights();
      if (this.truckers) this.truckers.lights = this.traffic.lights;
      this.updateCarLamp(this.traffic.lights && trafficLamp());
    }
    this.rainSound ??= this.audio?.loopSound('rain') ?? null;
    this.windSound ??= this.audio?.loopSound('wind') ?? null;
    // Набір кімнати з thund=off (тунелі): шум дощу й вітру не гучніший за 1 − k (king.exe 0x5a9dc0) — стихає з глибиною.
    const quiet = this.weatherFlags.thund ? 1 : 1 - this.world.special.k;
    this.rainSound?.set(this.sheltered ? 0 : Math.min(quiet, c.rainVolume));
    this.windSound?.set(Math.min(quiet, c.windVolume));
    const on = this.lightsManual;
    for (const l of this.lamps) l.visible = on;
    // Габарити й світіння фар вантажівки (SizeLightKey / HeadLightKey: 1 — горять) — разом з фарами. HeadLightKey у
    // даних моделі стоїть на 1, тож без цього скло фар світилося й удень з вимкненими фарами.
    this.setTruckSwitch?.('refer_SizeLightKey', on ? 1 : 0);
    this.setTruckSwitch?.('refer_HeadLightKey', on ? 1 : 0);
    this.trailer?.setSwitch?.('refer_SizeLightKey', on ? 1 : 0);
    this.sizeLights = on;
  }

  /**
   * Грім (king.exe 0x005a5400): раз на 10 с — блискавка (спрайт `flash` COMMON) за 300 м перед камерою, убік
   * ±300 м, на 20 м вище; 1 с — спалах світла; звук `thunder`. Розмір і тривалість спрайта — гіпотеза.
   */
  private updateThunder(dt: number): void {
    this.flashTime = Math.max(0, this.flashTime - dt);
    if (this.bolt) {
      // Спрайт — плавна прозорість за тією ж кривою (без миготіння через кадр).
      const f = flashLevel(FLASH_TIME - this.flashTime);
      this.bolt.visible = this.weatherFlags.thund && f > 0.01;
      this.bolt.material.opacity = f;
      // Текстура flash — 8 кадрів у ряд (ефект 0x005a4880: 8 кадрів): кадр за часом спалаху.
      const map = this.bolt.material.map;
      if (map) map.offset.x = Math.min(7, Math.floor(((FLASH_TIME - this.flashTime) / FLASH_TIME) * 8)) / 8;
    }
    if (!this.climate.thunder) return;
    if ((this.boltTimer -= dt) > 0) return;
    this.boltTimer = 10;
    this.flashTime = FLASH_TIME;
    if (!this.bolt) {
      const asm = this.world.common;
      const i = asm.b3d.materials.findIndex((m) => m.toLowerCase() === 'flash');
      const src = i >= 0 ? (asm.lib.material(i) as THREE.MeshBasicMaterial).map : null;
      if (!src) return;
      const map = src.clone();
      map.repeat.set(1 / 8, 1);
      this.bolt = new THREE.Sprite(new THREE.SpriteMaterial({ map, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, fog: false }));
      noFarClip(this.bolt.material);
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

  /**
   * Вантажопідйомність машини далекобійника ІІ, кг (частка X, career/share.ts): середня за моделями класу trucker з
   * evehicles.sch (гіпотеза: ІІ їздять ними й не міняють); без них — стартовий ZilR.
   */
  get rivalLoad(): number {
    const recs = this.trucks.records;
    const loads = (this.truckers?.models ?? []).map((m) => recs.find((r) => r.carNode === m)?.cargoLoad).filter((x): x is number => x != null);
    return loads.length ? loads.reduce((a, b) => a + b, 0) / loads.length : (recs.find((r) => r.carNode === 'ZilR')?.cargoLoad ?? 6000);
  }
  /** Збивні стовпи й рухомі предмети світу (м'яч Автобола — RaceMode). */
  get worldObjects(): WorldObjects {
    return this.objects;
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
    // Кар'єра купує лише вантажівки; вільна їзда (шестерня) — будь-яку машину, і легкову.
    const rec = selectable(this.trucks).find((r) => r.carNode === carNode);
    const def = rec && truckDef(this.trucks, rec);
    if (!rec || !def) return;
    this.def = def;
    this.tank = rec.tank * this.tuning.tank;
    this.fuelConsumption = rec.fuelConsumption;
    this.fuelEndurance = rec.fuelTimeEndurance;
    this.fuelRpm = rec.tachMaxPower;
    this.cabPrefix = rec.prefixCab;
    this.cockpit = g2t(def.tech.viewer).add(COCKPIT_LIFT);
    if (this.cab) {
      this.overlayScene.remove(this.cab);
      disposeCab(this.cab);
      this.glassRain?.dispose();
      this.glassRain = null;
      this.cab = null;
    }
    this.setCargo(this.cargoMass);
    this.redraw();
  }

  /** Розшук у вільній їзді (меню-шестерня): міліція й мафія женуть, доки не затримають / пограбують чи не скасуєш. */
  readonly freeWanted = { police: false, mafia: false };

  /** Вікно налаштувань вільної їзди (шестерня): машина, телепорт до міста чи заправки, погода, розшук. */
  openFreeSettings(): void {
    if (this.freeOpen || this.rescue) return;
    this.freeOpen = true;
    this.freeWasPaused = this.paused;
    this.paused = true;
    // Однакові назви вантажівки з кузовом і тягача розрізняє позначка; легкові (і автобус) — без неї.
    const kinds: Record<string, string> = { lorries: ' — з кузовом', tractors: ' — тягач' };
    const vehicles = selectable(this.trucks).map((r) => ({ value: r.carNode, label: vehicleName(r.name) + (kinds[r.group] ?? '') }));
    const places = this.teleportPlaces();
    const weather = [
      { value: 'auto', label: 'Змінна (як у грі)' },
      { value: '0', label: 'Ясно' },
      { value: '0.6', label: 'Хмарно' },
      { value: '0.75', label: 'Дощ' },
      { value: '0.9', label: 'Гроза' },
    ];
    const fixed = this.climate.fixedW;
    const police = ['Немає', 'Погоня', 'Попередження', '«Будемо стріляти»', 'Вогонь'];
    const mafia = ['Немає', 'Погоня', 'Попередження', 'Стрілянина'];
    const goTo = (list: { value: string; pos: THREE.Vector3 }[], exact: boolean) => (v: string) => {
      const p = list.find((x) => x.value === v);
      if (p) void this.teleport(p.pos, exact);
    };
    const fields: FreeField[] = [
      { label: 'Автомобіль', options: vehicles, value: () => this.def.carNode, set: (v) => this.changeTruck(v) },
      { label: 'Телепорт до міста', options: places.towns, value: () => '', set: goTo(places.towns, false), closes: true },
      { label: 'Телепорт до заправки', options: places.fuel, value: () => '', set: goTo(places.fuel, true), closes: true },
      { label: 'Погода', options: weather, value: () => (fixed === null ? 'auto' : String(weather.find((w) => w.value !== 'auto' && Math.abs(Number(w.value) - fixed) < 0.01)?.value ?? 'auto')), set: (v) => this.climate.setFixed(v === 'auto' ? null : Number(v)) },
      {
        label: 'Розшук міліції',
        options: police.map((label, i) => ({ value: String(i), label })),
        value: () => String(this.freeWanted.police ? Math.max(1, this.police?.phase ?? 1) : 0),
        set: (v) => {
          this.freeWanted.police = v !== '0';
          this.police?.setLevel(Number(v));
        },
      },
      {
        label: 'Розшук мафії',
        options: mafia.map((label, i) => ({ value: String(i), label })),
        value: () => String(this.freeWanted.mafia ? Math.max(1, this.mafia?.level ?? 1) : 0),
        set: (v) => {
          this.freeWanted.mafia = v !== '0';
          this.mafia?.setLevel(Number(v));
        },
      },
    ];
    openFreeSettings(this.overlay, fields, () => {
      this.freeOpen = false;
      if (!this.teleporting) this.paused = this.freeWasPaused;
    });
  }
  private freeOpen = false;
  private freeWasPaused = false;
  private teleporting = false;

  /** Куди телепортувати: міста (склади з mod_*.sch) і Кільце (старт гонки в dr); заправки — з найближчим містом. */
  private teleportPlaces(): { towns: { value: string; label: string; pos: THREE.Vector3 }[]; fuel: { value: string; label: string; pos: THREE.Vector3 }[] } {
    const towns = this.mapPoints.filter((p) => p.kind === 'town' && p.label).map((p) => ({ value: '', label: ukName(p.label!), pos: p.pos }));
    towns.sort((a, b) => a.label.localeCompare(b.label, 'uk'));
    const ring = this.world.regions.get('dr')?.way.rooms.flatMap((r) => r.nodes).find((n) => n.name === 'start1_1');
    if (ring) towns.unshift({ value: '', label: 'Кільце (гоночна траса)', pos: toThree(...ring.pos) });
    towns.forEach((t, i) => (t.value = `t${i}`));
    const nearest = (p: THREE.Vector3) => towns.filter((t) => !t.label.startsWith('Кільце')).reduce((a, b) => (a.pos.distanceTo(p) <= b.pos.distanceTo(p) ? a : b));
    // У заправки кілька вузлів node_car_fuel (по колонці) — одна точка на заправку.
    const stations: THREE.Vector3[] = [];
    for (const p of this.mapPoints) if (p.kind === 'fuel' && !stations.some((q) => q.distanceTo(p.pos) < 80)) stations.push(p.pos);
    const fuel = stations
      .map((pos) => ({ pos, town: nearest(pos), km: 0 }))
      .map((f) => ({ ...f, km: Math.round(f.pos.distanceTo(f.town.pos) / 100) / 10 }))
      .sort((a, b) => a.town.label.localeCompare(b.town.label, 'uk') || a.km - b.km)
      .map((f, i) => ({ value: `f${i}`, label: `Біля «${f.town.label}», ${f.km} км`, pos: f.pos }));
    return { towns, fuel };
  }

  /**
   * Телепорт (вільна їзда): гра на паузі, доки не завантажаться регіони місця; машина — на вісь найближчої дороги,
   * exact — точно в точку (вузол заправки: вісь поруч могла йти крізь острівець колонок), курс — уздовж дороги.
   */
  async teleport(target: THREE.Vector3, exact = false): Promise<void> {
    if (this.teleporting) return;
    this.teleporting = true;
    const was = this.freeOpen ? this.freeWasPaused : this.paused;
    this.paused = true;
    this.say('ПЕРЕНЕСЕННЯ…');
    try {
      await this.world.ready(target.x, -target.z);
      if (this.disposed) return;
      this.rapier.step(); // колайдери нових регіонів потрапляють у запити лише після кроку
      // На саму вісь: міста — вузли складу біля вантажної платформи, зсув на праву смугу ставив машину на її край.
      const s = this.roadPoint(target, this.truck.forward(), false);
      const first = s && !exact ? s : { position: this.roadGround(target), forward: s?.forward ?? this.truck.forward() };
      // Місце, де машина не зачіпає будівель (поруч зі складом чи заправкою — стіни, колонки): далі вздовж дороги.
      let spot = first;
      for (const k of [0, 8, -8, 16, -16, 24, -24, 32, -32, 48, -48]) {
        const c = k === 0 ? first : this.roadPoint(first.position.clone().addScaledVector(first.forward, k), first.forward, false);
        if (c && this.spotClear(c.position, c.forward)) {
          spot = c;
          break;
        }
      }
      this.truck.reset({ position: spot.position.clone(), forward: spot.forward.clone() });
      this.trailer?.reset();
      this.safe = spot;
      this.skipHits = 3;
    } finally {
      this.teleporting = false;
      // Вікно ще відкрите — пауза лишається (її зніме закриття вікна).
      this.paused = this.freeOpen || was;
    }
  }

  /** Чи вміститься машина в точці (позиція — як у reset: 2,5 м над землею) без нерухомих колізій довкола кузова. */
  private spotClear(position: THREE.Vector3, forward: THREE.Vector3): boolean {
    const box = visibleBox(this.truck.visual.userData.model?.body ?? this.truck.visual);
    const size = box.getSize(new THREE.Vector3());
    const half = { x: Math.max(0.8, size.x / 2), y: 1.1, z: Math.max(1.5, size.z / 2) };
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), forward.clone().setY(0).normalize());
    // Від 0,7 м над землею (бордюри й нерівності не рахуються) до 2,9 м.
    const center = { x: position.x, y: position.y - 2.5 + 0.7 + half.y, z: position.z };
    const hit = this.rapier.intersectionWithShape(center, { x: q.x, y: q.y, z: q.z, w: q.w }, new RAPIER.Cuboid(half.x, half.y, half.z), undefined, undefined, undefined, undefined, (c) => c.parent()?.isFixed() ?? true);
    return !hit;
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
    this.paused = this.canPause;
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
    // Панелі F1–F4 і меню Esc — ліворуч: кнопки керування з лівого боку екрана йдуть під них (ht2.css).
    document.body.classList.toggle('ht2-left-open', this.fPanels?.open != null || !!this.escMenu);
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

  private readonly storeRoutes = new Map<string, number>();

  /**
   * Довжина шляху дорогами між складами, м (оплата й строк замовлень): навігатор від центру складу (чи першого місця,
   * якщо центр далеко від доріг) до центру іншого — найкоротший шлях без зрізалок. Шляху немає — оцінка routeLength.
   */
  storeRoute(a: Store, b: Store): number {
    const key = `${a.id}>${b.id}`;
    const hit = this.storeRoutes.get(key);
    if (hit !== undefined) return hit;
    this.navigator ??= new Navigator(this.roads);
    const target = toThree(...b.center);
    let L: number | null = null;
    for (const p of [a.center, ...a.docks]) {
      L = this.navigator.remaining(toThree(...p), undefined, target);
      if (L !== null) break;
    }
    const out = L ?? routeLength(a, b);
    this.storeRoutes.set(key, out);
    return out;
  }

  /** Точка через s метрів найкоротшим шляхом дорогами від pos до цілі (navigator.pointAlong). */
  routePoint(pos: THREE.Vector3, heading: THREE.Vector3 | undefined, target: THREE.Vector3, s: number): THREE.Vector3 | null {
    this.navigator ??= new Navigator(this.roads);
    return this.navigator.pointAlong(pos, heading, target, s);
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
  private makeCar(carNode: string, variant: number, pos: THREE.Vector3, forward: THREE.Vector3, speed: number, dynamic = false, lights = false): TruckVehicle | null {
    const rec = this.trucks.records.find((r) => r.carNode === carNode);
    const def = rec && truckDef(this.trucks, rec);
    const model = def && buildTruckModel(this.trucks.asm, def, dynamic);
    if (!rec || !def || !model) return null;
    if (variant > 0) recolor(model.root, this.trucks, variant + 1);
    // Одразу на колесах на поверхні дороги (низ моделі + хід підвіски в спокої ≈ 0,1 м), а не на 2,5 м вище з падінням:
    // перехід кінематичної машини трафіку у фізичну був помітним підскоком.
    model.root.updateMatrixWorld(true);
    const bottom = new THREE.Box3().setFromObject(model.root).min.z;
    const surface = this.surfaceAt(pos);
    const at = surface === null ? this.groundAt(pos) : new THREE.Vector3(pos.x, surface - bottom + 0.1, pos.z);
    const v = new TruckVehicle(this.rapier, def, model, { position: at, forward: forward.clone() }, {
      cargoMass: 0,
      surfaceEffects: !this.arcade,
      engine: HT2_KING_ENGINE,
      brake: HT2_KING_BRAKE,
      king: { ...HT2_KING, travel: rec.suspension },
    });
    v.body.setLinvel({ x: forward.x * speed, y: 0, z: forward.z * speed }, true);
    v.engine.engageFor(speed);
    // Малюється лише з кімнатою, у якій стоїть (world/roomVisibility.ts) — не крізь зворотний бік пагорба.
    markMover(v.visual);
    this.world.scene.add(v.visual);
    if (model.setSwitch) this.carSwitches.set(v, model.setSwitch);
    // Фари трафіку, що став фізичним (кінематична модель мала їх з появи вночі): раніше гасли ближче 80 м.
    if (lights) {
      model.setSwitch?.('refer_HeadLightKey', 1);
      model.setSwitch?.('refer_SizeLightKey', 1);
    }
    return v;
  }

  /** Перемикачі моделей машин з динамічною моделлю (міліція: мигалки й сирена). */
  private readonly carSwitches = new WeakMap<TruckVehicle, (name: string, state: number) => void>();
  private readonly sirenSounds = new Map<TruckVehicle, NonNullable<ReturnType<EngineAudio['loopSound']>>>();

  /**
   * Мигалки й сирена міліції (king.exe 0x546b60, 0x547030; police.md «Мигалки й сирена»): у погоні ближче 100 м —
   * CopSirenKey = 1 і CopLightKey = 1 + trunc(6·frac(t)) (оберт за секунду, t — ігрові секунди), інакше обидва 0;
   * звук policeSound у точці машини, гучність 0,7, повна до 40 м, лінійно до нуля на 400 м.
   */
  private updateSirens(): void {
    const cops = this.police?.cops ?? [];
    const t = this.careerMode ? this.careerMode.career.time : this.freeTime;
    const phase = 1 + Math.floor(6 * (t - Math.floor(t)));
    const p = this.truck.visual.position;
    const live = new Set<TruckVehicle>();
    for (const c of cops) {
      const on = this.police!.siren(c, p);
      const sw = this.carSwitches.get(c.v);
      sw?.('CopSirenKey', on ? 1 : 0);
      sw?.('CopLightKey', on ? phase : 0);
      if (!on) continue;
      live.add(c.v);
      let snd = this.sirenSounds.get(c.v);
      if (!snd) {
        const s = this.audio?.loopSound('police') ?? null;
        if (!s) continue;
        snd = s;
        this.sirenSounds.set(c.v, snd);
      }
      const d = c.v.visual.position.distanceTo(p);
      snd.set(0.7 * (d < 40 ? 1 : Math.max(0, 1 - (d - 40) / 360)));
    }
    for (const [v, s] of this.sirenSounds)
      if (!live.has(v)) {
        s.stop();
        this.sirenSounds.delete(v);
      }
  }

  /**
   * Поверхня дороги під точкою (лише нерухомі колізії — не дах іншої машини), найближча за висотою до p.y: під мостом
   * перша згори — настил (traffic/layers.ts); null — колізій немає.
   */
  private surfaceAt(p: THREE.Vector3): number | null {
    return groundNear(this.rapier, p, 6, 10, 0)?.y ?? null;
  }

  private removeCar(v: TruckVehicle): void {
    this.world.scene.remove(v.visual);
    v.dispose();
  }

  /** Міліція (Б9): пости, погоня, попередження, стрілянина, затримання (traffic/police.ts, career/law.ts). */
  private updatePolice(dt: number): void {
    const cm = this.careerMode;
    if (!this.police || this.paused) return;
    const lv = this.truck.body.linvel();
    const events = this.police.update(dt, {
      body: this.truck.body,
      pos: this.truck.visual.position,
      forward: this.truck.forward(),
      vel: new THREE.Vector3(lv.x, 0, lv.z),
      // Заборонена зона (вогонь на ураження) — той самий лічильник розшуку.
      // Вільна їзда — рівень з меню-шестерні (freeWanted), штрафів немає.
      wanted: cm ? wanted(cm.fines) || this.zone.hot : this.freeWanted.police,
      stealth: this.tuning.stealth,
      glass: this.tuning.glass,
      stray: this.strayShot,
    });
    for (const e of events) {
      if (e.kind === 'shot' && e.hit) this.ignite(0.1);
      this.policeEvent(e);
    }
  }

  /** Горить: секунд від займання; −1 — ні (king.exe 0x54e180). */
  private burning = -1;
  /** Вода (тригери 13/16) і кінець гри. */
  /** Спецнабори погоди кімнат і прапорці набору, що діє (rain/sun/thund). */
  private readonly weatherRooms = new WeatherRooms();
  private weatherFlags = { rain: true, sun: true, thund: true };
  private readonly water = new Water((key) => this.worldSwitches.get(key) ?? 0);
  /** Стаціонарні камери-радари (картка 16). */
  private readonly radars = new Radars();
  private over = false;
  /** Перевірка банкрутства раз на 8 с (SeeIfBankrupted 0x427020). */
  private bankTimer = 8;

  /**
   * Кінець гри (king.exe 0x51eea0 / 0x51f380, upgrades.md «Вибування гравця»): гра на паузі, звуки стихають,
   * youlostSound, вікно BackLoose2 «Восстановлению не подлежит» (утонув чи машину знищено) чи BackLoose5 «Вы банкрот».
   * Збереження кар'єри не пишеться й не стирається (як .pl1 в оригіналі): «Головне меню» — вихід, «Почати
   * спочатку» — нова кар'єра. Перед вікном — ролик trirr.bne (знищено, утонув) чи trbn.bne (банкрут).
   */
  private gameOver(screen: LoseScreen = 'BackLoose2'): void {
    if (this.over) return;
    this.over = true;
    this.paused = true;
    this.noSave = true;
    this.burning = -1;
    this.blasts?.carFire(null);
    this.truck.engineOn = false;
    // Ринок захопив інший гравець (BackLoose1) — без ролика (upgrades.md «Вибування гравця»).
    void this.clip(...(screen === 'BackLoose5' ? ['trbn.bne'] : screen === 'BackLoose1' ? [] : ['TRirr.bne'])).then(async () => {
      // Екран кінця гри не тримається в памʼяті (ui/escArt.ts LAZY) — довантажити.
      await this.escArt?.ensure(`m_16\\${screen}.txr`);
      this.audio?.play('youlost');
      showGameOver(
        this.escArt,
        this.overlay,
        screen,
        {
          main: () => this.opts.onExit(),
          restart: () => this.opts.onExit('new'),
        },
        screen === 'BackLoose1' ? this.ratingRows() : undefined,
      );
    });
  }

  /**
   * Ролики подій (`*.bne` у корені гри, king.exe 0x5279e0; engine/video/player.ts, re/notes/ht2/video.md): по черзі
   * на весь екран, гра на паузі; дотик чи Esc — пропустити. Файлу немає (не імпортовано) — без ролика.
   */
  async clip(...names: string[]): Promise<void> {
    const was = this.paused;
    this.paused = true;
    try {
      for (const n of names) {
        const data = await this.opts.source.read(n).catch(() => null);
        if (data) await playVideo(data, { audio: sharedContext(), volume: this.opts.settings?.sfx ?? 1 }).catch((e: unknown) => console.warn(e));
      }
    } finally {
      this.paused = was;
    }
  }

  /**
   * Перемога «ринок захоплено» (king.exe 0x41fcf0 → подія 0xC → 0x51f380 режим 2; upgrades.md «Вибування гравця»):
   * частка X ≥ 0,51 — гра на паузі, youwinSound, вікно BackWin «Поздравляем! Вы захватили рынок перевозок региона!»
   * з кнопками «Главное меню», «Продолжить», «Начать сначала». Це не кінець кар'єри: «Продовжити» — їздити й
   * наймати далі; перемога лише раз (career.won). Перед вікном — ролик TRw1.bne.
   */
  private async victory(): Promise<void> {
    const cm = this.careerMode!;
    cm.career.won = true;
    // Мережева кар'єра: решта гравців програли (BackLoose1 «рынок монополизирован вашим конкурентом»).
    this.onNetVictory?.();
    cm.persist();
    this.paused = true;
    await this.clip('TRw1.bne');
    // Вікно перемоги не тримається в памʼяті (ui/escArt.ts LAZY) — довантажити.
    await this.escArt?.ensure('m_16\\BackWin.txr');
    this.paused = true;
    this.audio?.play('youwin');
    showVictory(this.escArt, this.overlay, {
      main: () => this.opts.onExit(),
      resume: () => {
        this.paused = false;
      },
      restart: () => this.opts.onExit('new'),
    });
  }

  /**
   * Займання від влучання кулі (0x567440): імовірність g·P·0,03/(P + 0,3) — P сила кулі (міліція й мафія 0,1,
   * гелікоптер 2,0), g — скло (броньоване 0,2).
   */
  private ignite(force: number, impact = false): void {
    // Займається лише машина, що не горить і не щойно погашена (стан 4 → 0 через 5 с, 0x54e180).
    // Займання — у кар'єрі й у вільній їзді, не в гонці.
    if (this.burning >= 0 || (!this.careerMode && this.race) || this.fireCool > 0) return;
    if (!impact && Math.random() >= (this.tuning.glass * force * 0.03) / (force + 0.3)) return;
    this.burning = 0;
    // Вибух _Blow — раз за пожежу (0x551970 → 0x549e60): у кар'єрі +0,4 пошкодження (момент вибуху — одразу [Г]).
    this.blowFx(enginePoint(this.truck));
    const c = this.careerMode?.career;
    if (c) c.damage = Math.min(1, c.damage + BLOW_DAMAGE);
    else this.freeDamage = Math.min(1, this.freeDamage + BLOW_DAMAGE);
  }

  /** Вибух машини (_Blow) у точці Three.js: ефект і звук blowkapot3, чутно до 50 м. */
  private blowFx(p: THREE.Vector3): void {
    this.blastFx().carBlow(new THREE.Vector3(p.x, -p.z, p.y));
    const d = p.distanceTo(this.truck.visual.position);
    if (d < 50) this.audio?.play('blowkapot3', 1 - d / 50);
  }

  /** Вогонь машин ІІ (traffic/carFires.ts). */
  private carFires: CarFires | null = null;

  private fires(): CarFires {
    return (this.carFires ??= new CarFires({
      fire: (v, p) => this.blastFx().carFire(p && new THREE.Vector3(p.x, -p.z, p.y), v),
      blow: (p) => this.blowFx(p),
    }));
  }

  /** Фізичні машини ІІ поруч: трафік, міліція, мафія, далекобійники й наймані, суперники в гонці. */
  private aiCars(): TruckVehicle[] {
    const out: TruckVehicle[] = [];
    for (const c of this.traffic?.cars ?? []) if (c.vehicle) out.push(c.vehicle);
    for (const c of this.police?.cops ?? []) out.push(c.v);
    for (const h of this.mafia?.hoods ?? []) out.push(h.v);
    for (const r of this.truckers?.list ?? []) out.push(r.truck);
    for (const r of this.truckers?.hired.values() ?? []) out.push(r.truck);
    for (const r of this.race?.racers.slice(1) ?? []) out.push(r.truck);
    return out;
  }

  /** Куля повз гравця влучила в інше тіло: машина ІІ — займання з імовірністю g·P·0,03/(P + 0,3), g = 1 (0x567440). */
  private readonly strayShot = (body: RAPIER.RigidBody, power: number): void => {
    const v = this.aiCars().find((c) => c.body === body);
    if (v && (this.careerMode || !this.race)) this.fires().shot(v, power);
  };

  /** Після гасіння FIRE_COOL с машина не займається. */
  private fireCool = 0;

  /** Погасити (ремонт на СТО, протипожежна система). */
  extinguish(): void {
    if (this.burning >= 0) this.fireCool = FIRE_COOL;
    this.burning = -1;
    this.blasts?.carFire(null);
  }

  /**
   * Горіння (0x54e180, 0x5494c0): двигун −1/60 стану за секунду (у порту — стан машини), бак −0,2/60 за секунду;
   * протипожежна система через 5 с гасить і витрачає заряд, після четвертого — пейджер mess 100 і системи більше
   * немає; стан машини понад 0,9 — кінець гри. Гіпотеза порту: витрата бака — частка ємності.
   */
  private updateFire(dt: number): void {
    const cm = this.careerMode;
    if (!cm || this.paused) return;
    this.fireCool = Math.max(0, this.fireCool - dt);
    const c = cm.career;
    // Утонув (0x4ce300/0x56ffd0: центр машини нижче рівня води; повітрозабірник — на 1 м глибше) чи машину знищено
    // (сума пошкоджень > 0,9, 0x597b00; у порту — стан машини) — кінець гри.
    const sunk = this.water.update(dt, this.world.loaded.values(), this.truck.visual.position, (c.upgrades ?? []).includes('PR_AIR_FILTER_SNORKEL:1'));
    if (sunk || c.damage > 0.9) return this.gameOver();
    // Вогонь машин ІІ і поширення між сусідами (зокрема на гравця й від гравця).
    if (this.fires().update(dt, this.aiCars(), { v: this.truck, burning: this.burning >= 0 })) this.ignite(0, true);
    // Банкрутство (0x427020): раз на 8 с гроші < 0 — кінець гри, BackLoose5 «Вы банкрот».
    if ((this.bankTimer -= dt) <= 0) {
      this.bankTimer = 8;
      if (c.money < 0) return this.gameOver('BackLoose5');
      // Частка X перераховується теж раз на 8 с (updateRating 0x41fcf0).
      if (!c.won && cm.marketShare() >= WIN_SHARE) return void this.victory();
    }
    if (this.burning < 0) return;
    this.burning += dt;
    c.damage = Math.min(1, c.damage + dt / 60);
    c.fuel = Math.max(0, (c.fuel ?? this.tank) - (0.2 * this.tank * dt) / 60);
    const upgrades = c.upgrades ?? [];
    if (this.burning > 5 && upgrades.includes('PR_FIRE_PROTECTION:1')) {
      c.fireUsed = (c.fireUsed ?? 0) + 1;
      if (c.fireUsed >= 4) {
        c.upgrades = upgrades.filter((k) => k !== 'PR_FIRE_PROTECTION:1');
        c.fireUsed = 0;
        this.say('СИСТЕМА ПОЖЕЖОГАСІННЯ', 5);
      }
      this.extinguish();
      cm.persist();
      return;
    }
    // Двигун — у передній третині машини, 1,5 м над її центром (гіпотеза).
    const p = this.truck.visual.position.clone().addScaledVector(this.truck.forward(), 2).setY(this.truck.visual.position.y + 1.5);
    this.blastFx().carFire(new THREE.Vector3(p.x, -p.z, p.y));
  }

  /**
   * Стан машини у вільній їзді (на прохання користувача — як у кар'єрі, лише без грошей і кінця гри): удари (hitWear),
   * займання й горіння (−1/60 за секунду), вибух +0,4; знищено (> 0,9) чи втопилася — 911 (переставляє й ремонтує).
   */
  private updateFreeDamage(dt: number): void {
    if (this.careerMode || this.race || this.paused) return;
    this.fireCool = Math.max(0, this.fireCool - dt);
    const wear = this.hitWear;
    this.hitWear = 0;
    if (wear > 0) this.freeDamage = Math.min(1, this.freeDamage + wear * (this.arcade ? 0.5 : 1));
    if (this.fires().update(dt, this.aiCars(), { v: this.truck, burning: this.burning >= 0 })) this.ignite(0, true);
    const sunk = this.water.update(dt, this.world.loaded.values(), this.truck.visual.position, false);
    if (this.burning >= 0) {
      this.burning += dt;
      this.freeDamage = Math.min(1, this.freeDamage + dt / 60);
      const p = this.truck.visual.position.clone().addScaledVector(this.truck.forward(), 2).setY(this.truck.visual.position.y + 1.5);
      this.blastFx().carFire(new THREE.Vector3(p.x, -p.z, p.y));
    }
    if ((sunk || this.freeDamage > 0.9) && !this.rescue) {
      this.say(sunk ? 'МАШИНА ПОТОНУЛА — ВИКЛИКАНО 911' : 'МАШИНУ ЗНИЩЕНО — ВИКЛИКАНО 911', 6);
      this.call911();
    }
  }

  /** Стан машини у вільній їзді: 0 — ціла, 1 — знищена (кар'єра — career.damage). */
  freeDamage = 0;

  /** Відкриття прихованих доріг карти проїздом (world/mapReveal.ts, king.exe updatePlayerBoxes 0x42cf50). */
  private updateReveal(dt: number): void {
    if (!this.mapReveal || this.paused || (this.revealTimer -= dt) > 0) return;
    // 10 разів на секунду (king.exe — щокадру; габарит від цього майже не змінюється).
    this.revealTimer = 0.1;
    this.mapReveal.update(this.truck.visual.position);
  }

  /**
   * Камери-радари (traffic/radars.ts, king.exe 0x56ffd0): перевищення — штраф 250 × ступінь одразу з грошей, картка 16;
   * кожна камера — раз за гру.
   */
  private updateRadars(dt: number): void {
    const cm = this.careerMode;
    if (!cm || this.paused) return;
    const lv = this.truck.body.linvel();
    const fired = new Set(cm.career.radars ?? []);
    const hit = this.radars.update(dt, this.world.loaded.values(), this.truck.visual.position, this.truck.forward(), Math.hypot(lv.x, lv.z), fired, this.tuning.stealth);
    if (!hit) return;
    const fine = 250 * hit.degree;
    cm.career.radars = [...fired, hit.id];
    cm.career.money -= fine;
    // Картка 16: ліміт — trunc(ліміт) − 5 (0x571913), швидкість — trunc(v·3,6).
    const limit = Math.trunc(hit.limit) - 5;
    const speed = Math.trunc(hit.speedKmh);
    if (this.cards) this.cards.show(16, { amount: fine, limit, speed });
    else this.say(`КАМЕРА: ${speed} КМ/ГОД ЗАМІСТЬ ${limit}. ШТРАФ $${fine}`, 6);
    cm.persist();
  }

  /** Гелікоптери Ка-50 (Б11) і заборонена зона db (traffic/helicopters.ts). */
  private updateCopters(dt: number): void {
    const cm = this.careerMode;
    if (!this.copters || this.paused) return;
    const pos = this.truck.visual.position;
    // Заборонена зона — лише в кар'єрі (виняток — замовлення в Алмазний); у вільній їзді гелікоптер жене розшукуваного.
    for (const e of cm ? this.zone.update(dt, this.world.loaded.values(), pos, cm.orderRegion() === 'aa') : []) {
      // mess 87, на пейджер без звуку (0x56ae60); шлях 3 → 2 → 1 — одразу вогонь (лічильник 34).
      if (e === 'warn') this.say('ЗАБОРОНЕНА ЗОНА. ВОГОНЬ НА УРАЖЕННЯ', 6);
      else if (e === 'fire') this.police?.escalate(4);
    }
    const lv = this.truck.body.linvel();
    const events = this.copters.update(dt, new Set(this.world.loaded.keys()), {
      body: this.truck.body,
      pos,
      forward: this.truck.forward(),
      vel: new THREE.Vector3(lv.x, 0, lv.z),
      phase: this.police?.phase ?? 0,
      hour: this.hour,
      glass: this.tuning.glass,
      stray: this.strayShot,
    }, this.camera.position);
    for (const e of events) {
      if (e.kind === 'shot') {
        if (e.hit) this.ignite(2);
        this.policeEvent(e);
      } else this.audio?.play('hitgrnd', Math.max(0.05, 1 - e.dist / 150));
    }
  }

  /** Мафія (Б10): на прицілі — борг мафії чи «цікавий мафії»; попередження, стрілянина, напад, міни. */
  private updateMafia(dt: number): void {
    const cm = this.careerMode;
    if (!this.mafia || this.paused) return;
    const lv = this.truck.body.linvel();
    const f = cm?.fines;
    const events = this.mafia.update(dt, {
      body: this.truck.body,
      pos: this.truck.visual.position,
      forward: this.truck.forward(),
      vel: new THREE.Vector3(lv.x, 0, lv.z),
      hunted: f ? (f.mafiaDebt ?? 0) > 0 || !!f.mafiaInterest : this.freeWanted.mafia,
      glass: this.tuning.glass,
      stray: this.strayShot,
      share: cm?.marketShare() ?? 0,
    });
    for (const e of events) {
      if (e.kind === 'warn') this.say('ЗУПИНИ МАШИНУ! ТРЕБА ПОГОВОРИТИ', 6);
      else if (e.kind === 'shot') {
        this.audio?.play('shoot', Math.max(0.1, 1 - e.dist / 150));
        if (e.hit) {
          this.audio?.play('hit_bullet');
          this.ignite(0.1);
        }
      } else if (e.kind === 'attack') {
        // Після пограбування (0x56ad20, подія 3) — ролик trml.bne, якщо лишився прихований вантаж, потім завжди trmm.bne.
        if (cm) void cm.robbed().then((hidden) => this.clip(...(hidden ? ['trml.bne'] : []), 'trmm.bne'));
        else {
          // Вільна їзда: грабувати нічого — ролик і кінець розшуку.
          this.freeWanted.mafia = false;
          this.say('ВАС ПОГРАБУВАЛА МАФІЯ');
          void this.clip('trmm.bne');
        }
      }
      else if (e.kind === 'mine') {
        // Вибух міни (mineExplose, 0x56f240): поштовх угору в точці міни [Г: сила], звук mineSound.
        const m = this.truck.body.mass();
        this.truck.body.applyImpulseAtPoint({ x: 0, y: m * 3, z: 0 }, e.pos, true);
        this.audio?.play('mine');
      }
    }
  }

  private policeEvent(e: PoliceEvent): void {
    const cm = this.careerMode;
    // Вільна їзда: штрафів немає — перевищення не рахується.
    if (e.kind === 'speeding') cm?.speeding(e.limit, e.speed, e.degree);
    else if (e.kind === 'warn') {
      // mess.txt 54/55 і звуки police_01/02 (king.exe 0x56ad20).
      this.say(e.n === 1 ? 'НЕГАЙНО ЗУПИНІТЬ МАШИНУ' : 'ЗУПИНІТЬСЯ, АБО БУДЕМО СТРІЛЯТИ', 6);
      this.audio?.play(e.n === 1 ? 'police_01' : 'police_02');
    } else if (e.kind === 'shot') {
      this.audio?.play('shoot', Math.max(0.1, 1 - e.dist / 150));
      if (e.hit) this.audio?.play('hit_bullet');
    } else if (e.kind === 'arrest') {
      this.zone.hot = false;
      // Затримання (0x56ad20, подія 2): картка, потім ролик trp.bne.
      if (cm) void cm.arrest().then((done) => (done ? this.clip('trp.bne') : undefined));
      else {
        this.freeWanted.police = false;
        this.say('ВАС ЗАТРИМАЛА МІЛІЦІЯ');
        void this.clip('trp.bne');
      }
    }
  }

  /**
   * Радар-детектор (king.exe 0x538370): пост ближче 100 м → сигнал s = відстань × 0,01; лампа RD_LampKey —
   * рівень clamp(1 + ⌊3s⌋, 1…3), блимає з частотою 2 + 5s Гц (половину періоду світить), на спалах — звук antiradar.
   */
  private updateRadarLamp(dt: number, radar: boolean): void {
    if (!this.cabSwitch) return;
    // Пост міліції (0x538370) чи зона камери-радара (0x56ffd0: сигнал 0,5).
    const s = radar ? Math.max(this.police?.radarSignal(this.truck.visual.position) ?? 0, this.radars.signal) : 0;
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
      if (d < RADIO_R) out.push({ kind: 'nei', id: i + r.name.length, name: `ВОДІЙ ${r.name.toUpperCase()}`, d, sub: 'trucker' });
    });
    // Продавці на ринках і водії звичайного трафіку (king.exe 0x526080: ближче 100 м; замовлення машини — у них).
    const day = this.careerMode ? Math.floor(this.careerMode.career.time / 86400) : 0;
    for (const m of this.markets?.list ?? [])
      for (const item of this.markets!.stock(m, day)) {
        const d = m.spots[item.spot].pos.distanceTo(p);
        if (d < RADIO_R) out.push({ kind: 'nei', id: m.id * 7 + item.spot, name: 'ПРОДАВЕЦЬ', d, sub: 'dealer' });
      }
    this.traffic?.cars.forEach((car, i) => {
      const d = car.pos.distanceTo(p);
      if (d < RADIO_R) out.push({ kind: 'nei', id: 20 + i, name: 'ВОДІЙ', d, sub: 'dumb' });
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
        // «Заказ машины» (0x433660): при боргу чи інтересі мафії — відмова (кнопка неактивна).
        cm && !((cm.fines.mafiaDebt ?? 0) > 0) && !cm.fines.mafiaInterest ? { key: 'ask3', ...this.carOrder('maf') } : { key: 'ask3', off: true },
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
      // Замовлення машини — у продавця й водія звичайного трафіку (тип 9 / 7), не в далекобійника.
      c.sub === 'dealer' || c.sub === 'dumb' ? { key: 'ask2', ...this.carOrder('nei') } : { key: 'ask2', off: true },
      { key: 'ask3', bye: true },
    ];
  }

  /** Фраза «замовити машину» (career/carOrder.ts): вікно BackF5tru, плата — одразу, машина — на ринку-місті. */
  private carOrder(kind: 'maf' | 'nei'): Partial<RadioAsk> {
    const cm = this.careerMode;
    const markets = this.markets;
    if (!cm || !markets) return { off: true };
    const from = this.truck.visual.position.clone();
    return {
      vehicles: () => vehicleOffers(kind, from, markets, this.trucks, this.vehiclePowers),
      orderVehicle: (offer, color) => {
        const c = cm.career;
        orderVehicle(kind, from, offer, color, markets, c);
        c.orderedCars = markets.ordered;
        this.say(`ЗАМОВЛЕНО ${offer.name} → ${offer.town}`);
        cm.persist();
      },
    };
  }

  /**
   * «Помінятися місцями» (F4): гравець сідає в машину водія, водій — у машину гравця (посібник: миттєво). Пошкодження
   * й пальне — як були в гравця (гіпотеза: стан чужої машини порт не веде).
   */
  private swapWithDriver(i: number): void {
    const c = this.careerMode?.career;
    const d = c?.company?.[i];
    if (!c || !d || c.order) return void (c?.order && this.say('СПЕРШУ ДОСТАВТЕ ВАНТАЖ'));
    // Гравець — на місці водія, водій — на місці гравця (career/hired.ts; машина водія зʼявиться знову з новою моделлю).
    const hr = (this.hiredRoads ??= new HiredOnRoads(this.roads));
    const there = this.truckers?.hired.get(d.name)?.truck.visual.position.clone() ?? hr.at(d)?.pos ?? null;
    const thereFwd = this.truckers?.hired.get(d.name)?.truck.forward() ?? hr.at(d)?.forward ?? null;
    const here = this.truck.visual.position.clone();
    this.truckers?.dropHired(d.name);
    [c.truck, d.truck] = [d.truck, c.truck];
    this.changeTruck(c.truck);
    hr.place(d, here);
    if (there && thereFwd) this.truck.reset({ position: this.groundAtPublic(there), forward: thereFwd });
    this.say(`ВИ ЗА КЕРМОМ ${c.truck}`);
    this.careerMode!.persist();
  }

  /** Дані панелей F1–F4. */
  private fData(): import('./ui/fPanels').FPanelData {
    const key = (b: Action | Command, def: string) => {
      const c = this.opts.settings?.keys?.[b];
      return c ? keyName(c) : def;
    };
    return {
      net: this.race?.net ? this.race.netRows(this.netNames) : null,
      netRating: this.careerMode?.netRating(),
      info: this.careerMode?.info() ?? null,
      company: this.careerMode?.career.company ?? [],
      licences: this.careerMode?.career.licences?.length ?? 0,
      swap: (i) => this.swapWithDriver(i),
      fire: (i) => {
        const c = this.careerMode?.career;
        if (!c?.company?.[i]) return;
        // Звільнення (0x476f70): водій повертає вартість машини, аванс лишає собі.
        c.money += c.company[i].value ?? 0;
        this.truckers?.dropHired(c.company[i].name);
        this.say(`${c.company[i].name.toUpperCase()} ЗВІЛЬНЕНО`);
        c.company = c.company.filter((_, k) => k !== i);
        this.careerMode!.persist();
      },
      rivals: [...(this.truckers?.allNames ?? [])],
      share: this.careerMode?.marketShare() ?? 0,
      rivalShare: this.careerMode ? this.careerMode.marketShare() * (this.rivalLoad / Math.max(1, this.careerMode.fleetLoad())) : 0,
      // Клавіші — з перепризначень меню «Керування» (ht2.settings.v1 keys), інакше типові.
      keys: [
        ['ГАЗ', key('gas', '↑')],
        ['ГАЛЬМО, НАЗАД', key('brake', '↓')],
        ['КЕРМО', `${key('left', '←')} ${key('right', '→')}`],
        ['РІЗКО', 'CTRL'],
        ['РУЧНЕ ГАЛЬМО', key('handbrake', 'SHIFT')],
        ['ДВИГУН', key('engine', 'ПРОБІЛ')],
        ['КАМЕРА', key('camera', 'C')],
        ['ФАРИ', key('lights', 'L')],
        ['ДВІРНИКИ', key('wipers', 'W')],
        ['ДЗЕРКАЛО', 'M'],
        ['СИГНАЛ', key('horn', 'H')],
        ['ВІДНОВИТИСЯ', 'R, 0'],
        ['МІНІКАРТА', key('map', 'TAB')],
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
   * Звук і керування з меню Esc: загальна гучність — множник усього звуку, і музики теж (раніше музику не чіпала, і
   * повзунок здавався непрацюючим: музика грала як грала); музика — відносно типової загальної (SFX_REF), щоб за неї
   * звучала як раніше; двигун і музика — ще й своїми повзунками,
   * чутливість і повернення керма (множники 0,5…1,5; середина — як у телеметрії, гіпотеза). Гальмування й віддача —
   * лише зберігаються (таких звуків і керма з віддачею в порті немає).
   */
  private applySettings(s: Ht2Settings, save: boolean): void {
    this.audio?.setVolumes(s.engine * s.sfx, s.sfx);
    this.music?.setVolume((s.music * s.sfx) / SFX_REF);
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
      const id = this.careerMode?.career.id;
      if (id) this.checkpoint = { id, raw: savedCareerRaw(id) };
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
   * 911 (king.exe 0x511c50 → 0x5119e0, re/notes/ht2/career-misc.md §3): одразу, на найближчій точці дороги біля місця
   * виклику (0x533590) — по дотичній до осі, праворуч від неї на 0,5·W − 1,5 м; оплата й ремонт — careerMode.pay911.
   * Порт (на прохання користувача): місце має бути вільним від інших машин — після ДТП на найближчій точці стоїть
   * той, з ким зіткнулись, і машина гравця з'являлась знову впритул до нього; тоді — далі вздовж дороги (RESCUE_STEP).
   */
  call911(): void {
    if (this.rescue) return;
    this.rescue = { left: 0, ready: Promise.resolve(this.roadside(this.truck.visual.position)), cost: 0 };
  }

  /** Точка на дорозі біля p, вільна від інших машин: спершу найближча, далі — уперед і назад уздовж дороги. */
  private roadside(p: THREE.Vector3): { position: THREE.Vector3; forward: THREE.Vector3 } | null {
    const first = this.roadPoint(p, this.truck.forward());
    if (!first) return null;
    const others = this.otherVehicles();
    // Машина гравця з напівпричепом — точки від переду назад (причіп ≈ 14 м за тягачем).
    const back = this.trailer ? 20 : 8;
    const free = (s: { position: THREE.Vector3; forward: THREE.Vector3 }) => {
      for (let k = -back; k <= 5; k += 2.5) {
        const q = s.position.clone().addScaledVector(s.forward, k);
        if (others.some((o) => Math.hypot(o.x - q.x, o.z - q.z) < RESCUE_CLEAR && Math.abs(o.y - q.y) < 6)) return false;
      }
      return true;
    };
    if (free(first)) return first;
    for (let i = 1; i <= RESCUE_TRIES; i++)
      for (const sign of [1, -1]) {
        const at = first.position.clone().addScaledVector(first.forward, sign * i * RESCUE_STEP);
        const s = this.roadPoint(at, first.forward);
        if (s && free(s)) return s;
      }
    return first;
  }

  /** Інші машини на дорозі (трафік, далекобійники з причепами, міліція, мафія) — точки для вільного місця 911. */
  private otherVehicles(): THREE.Vector3[] {
    return [
      ...(this.traffic?.cars.map((c) => c.pos) ?? []),
      ...(this.truckers?.rigs ?? []).flatMap((r) => [...alongPoints(r.truck), ...(r.trailer?.points() ?? [])]),
      ...(this.police?.cops.map((c) => c.v.visual.position) ?? []),
      ...(this.mafia?.hoods.map((h) => h.v.visual.position) ?? []),
    ];
  }

  /** Точка на дорозі біля p: вісь WAY, дотична в бік курсу heading, зсув праворуч на 0,5·W − 1,5 м. */
  private roadPoint(p: THREE.Vector3, heading: THREE.Vector3, lane = true): { position: THREE.Vector3; forward: THREE.Vector3 } | null {
    // Закриту завалом дорогу оминаємо: найближча точка могла б опинитися в камінні (world/obstacles.ts).
    const n = this.roads.nearestAxis(p, true) ?? this.roads.nearestAxis(p);
    if (!n) return null;
    const pts = n.axis.pts;
    let best = 0;
    let bd = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const d = new THREE.Line3(pts[i], pts[i + 1]).closestPointToPoint(n.point, true, new THREE.Vector3()).distanceTo(n.point);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    const forward = pts[best + 1].clone().sub(pts[best]).setY(0).normalize();
    if (forward.dot(heading) < 0) forward.negate();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    const at = n.point.clone().addScaledVector(right, lane ? Math.max(0, 0.5 * n.axis.width - 1.5) : 0);
    return { position: this.roadGround(at), forward };
  }

  /**
   * Земля під точкою осі дороги (висота WAY — рівень дороги): промінь з 1,5 м над нею, щоб під навісом (склад,
   * заправка) не стати на дах — groundAt починає з 4 м і зсередини навісу ставив машину на нього.
   */
  private roadGround(p: THREE.Vector3): THREE.Vector3 {
    const hit = this.rapier.castRay(new RAPIER.Ray({ x: p.x, y: p.y + 1.5, z: p.z }, { x: 0, y: -1, z: 0 }), 20, true);
    if (hit && hit.timeOfImpact > 0) return new THREE.Vector3(p.x, p.y + 1.5 - hit.timeOfImpact + 2.5, p.z);
    return this.groundAt(p);
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
    if (this.careerMode) this.careerMode.pay911();
    else {
      // Вільна їзда (порт): платити нічим — 911 ремонтує безкоштовно, як у кар'єрі з грошима.
      this.freeDamage = 0;
      this.dents?.repair();
      this.trailerDents?.repair();
      this.extinguish();
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
    // Роздільність з меню «Графіка»: висота кадру 480…1200 (не більше за фізичну).
    // Не задано — режим «Баланс» (як типовий у першій грі): щільність пікселів не вище BALANCE_DPR — кількість
    // пікселів найбільше гріє телефон.
    const res = this.opts.settings?.resolution;
    // Телефон і ПК — різні набори (ui/menuScreens.ts resolutionDpr): на телефоні — за кількістю пікселів.
    this.opts.renderer.setPixelRatio(res !== undefined ? resolutionDpr(res, w, h) : Math.min(window.devicePixelRatio, BALANCE_DPR));
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

  /**
   * time — мітка кадру від requestAnimationFrame (момент vsync): performance.now() усередині кадру тремтить на кілька
   * мс, і машина за кадр проїжджала то більше, то менше — за згладженою камерою ззаду вона смикалась.
   */
  /** Розмір полотна й лічильник redraw, з якими вже намальовано кадр паузи ('' — не на паузі). */
  private pausedFrame = '';
  private redraws = 0;
  /** Перемалювати кадр паузи (сцену змінено, поки гра стоїть: інша машина з шестерні). */
  redraw(): void {
    this.redraws++;
  }

  private frame(time = performance.now()): void {
    const now = time;
    // Не частіше за MAX_FPS (чи 30/40 к/с з меню «Графіка» — менше нагріву телефона): екрани 90/120 Гц інакше
    // малюють у півтора-два рази частіше. Розклад кадрів (nextFrame += інтервал), а не «від попереднього»: 40 к/с на
    // екрані 60 Гц — кадри через 2 і 1 оновлення по черзі (у середньому 40), а не 30; допуск 2 мс — тремтіння таймера.
    const interval = 1000 / (this.opts.settings?.fps ?? MAX_FPS);
    if (now < this.nextFrame - 2) return;
    // Після паузи (вкладка у фоні, довгий кадр) — розклад від поточного моменту, без «наздоганяння».
    this.nextFrame = Math.max(this.nextFrame + interval, now);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    // Пауза (меню Esc, карта, ролик, вікна): світ стоїть — кадр не змінюється, не перемальовуємо (полотно зберігає
    // зображення; раніше — повний кадр світу 60 разів на секунду даремно, як було й у першій грі). Ще раз — після
    // зміни розміру полотна (поворот, роздільність: воно тоді очищається) чи redraw() (зміна сцени на паузі).
    if (this.paused) {
      const c = this.opts.renderer.domElement;
      const key = `${c.width}x${c.height}:${this.redraws}`;
      if (key === this.pausedFrame) return;
      this.pausedFrame = key;
    } else this.pausedFrame = '';
    this.update(dt);
    const r = this.opts.renderer;
    // Лише кімнати, видимі крізь портали з камери (world/roomVisibility.ts).
    this.world.visibility.update(this.camera);
    this.renderWorld(r, this.camera);
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

  /**
   * Світ — з матрицями лише видимих гілок (engine/render/visibleMatrices.ts): рендерер не обходить сховані вузли
   * (кімнати поза порталами, варіанти й пошкодження моделей), яких у сцені ~85 %.
   */
  private renderWorld(r: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const scene = this.world.scene;
    updateVisibleMatrices(scene);
    scene.matrixWorldAutoUpdate = false;
    r.render(scene, camera);
    scene.matrixWorldAutoUpdate = true;
  }

  /** Дзеркало: вид назад з місця водія, віддзеркалений зліва направо, у вікні рамки оригіналу під табло. */
  private renderMirror(r: THREE.WebGLRenderer): void {
    const size = r.getSize(this.mirrorSize);
    const k = Math.round(size.x * MIRROR_SHARE) / MIRROR_W;
    const fw = Math.round(MIRROR_W * k);
    const fh = Math.round(MIRROR_H * k);
    const fx = Math.round((size.x - fw) / 2);
    // Висота табло (CSS-змінна) — раз на пів секунди: getComputedStyle щокадру перераховує стилі.
    const now = performance.now();
    if (now - this.tabloHAt > 500) {
      this.tabloHAt = now;
      this.tabloH = Math.round(parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 0);
    }
    const fy = this.tabloH;
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
    let fresh = now - this.mirrorAt >= 1000 / MIRROR_FPS - 2;
    if (m.rt.width !== Math.round(w * ratio) || m.rt.height !== Math.round(h * ratio)) {
      m.rt.setSize(Math.round(w * ratio), Math.round(h * ratio));
      fresh = true;
    }
    // Світ у дзеркалі — MIRROR_FPS разів на секунду; між оновленнями — та сама картинка (рамка — щокадру).
    if (fresh) this.drawMirror(r, m, w / h);
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
    const css = `${fx},${fy},${fw},${fh}`;
    if (css !== this.mirrorCss) {
      this.mirrorCss = css;
      Object.assign(m.frame.style, { left: `${fx}px`, top: `${fy}px`, width: `${fw}px`, height: `${fh}px` });
    }
  }

  private readonly mirrorSize = new THREE.Vector2();
  private readonly mirrorPoint = new THREE.Vector3();
  private tabloH = 0;
  private tabloHAt = -Infinity;
  private mirrorAt = -Infinity;
  private mirrorCss = '';
  private static readonly BACK = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI);

  /** Вид назад у текстуру дзеркала. */
  private drawMirror(r: THREE.WebGLRenderer, m: NonNullable<typeof this.mirror>, aspect: number): void {
    this.mirrorAt = performance.now();
    m.cam.aspect = aspect;
    m.cam.far = this.camera.far;
    m.cam.updateProjectionMatrix();
    // Погляд назад: орієнтація машини, розвернута на 180° навколо вертикалі, з точки дзеркала (king.exe 0x595290 —
    // верхнє дзеркало): ліве бокове дзеркало (tv_camera 0), з причепом — посередині між лівим і правим (0 і 2,
    // ×0,5). З місця водія камера бачила тент кузова. Без точок у tech — з місця водія.
    const pts = this.def.tech.mirrors;
    if (pts?.length) {
      const a = pts[0];
      const b = this.trailer && pts[2] ? pts[2] : a;
      this.mirrorPoint.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      this.truck.visual.updateWorldMatrix(true, false);
      m.cam.position.copy(this.truck.visual.localToWorld(g2t(this.mirrorPoint)));
    } else m.cam.position.copy(this.camera.position);
    m.cam.quaternion.copy(this.truck.visual.quaternion).multiply(Ht2Drive.BACK);
    m.cam.updateMatrixWorld();
    // Дзеркало дивиться назад — свої видимі кімнати (наступний кадр рахує їх для камери знову).
    this.world.visibility.update(m.cam);
    r.setRenderTarget(m.rt);
    r.clear();
    this.renderWorld(r, m.cam);
    r.setRenderTarget(null);
  }

  /** Інтер'єр кабіни `<prefixCab>Cab` (CABINES.B3D, текстури CABINES.RES) — вантажиться при першому вигляді з кабіни. */
  private async loadCab(): Promise<void> {
    if (this.cabLoading || this.cab) return;
    this.cabLoading = true;
    try {
      // CABINES.B3D і .RES (≈ 29 МБ) — лише на час збирання салону: збирач з файлами не зберігається (памʼять на
      // телефоні); інший салон (зміна машини) — читає їх знову.
      const [b3d, res] = await Promise.all([this.opts.source.read('COMMON/CABINES.B3D'), readTextures(this.opts.source, 'COMMON/CABINES.RES')]);
      if (this.disposed || this.cab) return;
      const rmp = parseRmp(res);
      const asm = new SceneAssembler(parseB3d(b3d), rmp, { lit: true, colorKey: true, nearGroup: 0, type4Space: true, palette: this.world.common.lib.palette ?? undefined });
      if (!this.cabLight) {
        // Світло в кабіні — лише розсіяне сіре cabAmbient(година) (king.exe 0x4df4a8), без сонця й envamb.
        this.cabLight = new THREE.AmbientLight(new THREE.Color().setScalar(cabAmbient(this.hour)), Math.PI);
        this.overlayScene.add(this.cabLight);
      }
      const name = `${this.cabPrefix}Cab`;
      const dyn = asm.dynamicObject(name);
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
      this.cabParts = { rule: bySpace('rulespace'), speed: bySpace('speedspace'), tacho: bySpace('tachospace'), fuel: bySpace('fuelarrowspace') };
      // Стрілки — на 10 см ближче до ока (лише глибина): на малій швидкості їх перекривала текстура панелі зліва.
      for (const n of [this.cabParts.speed, this.cabParts.tacho, this.cabParts.fuel]) if (n) biasTowardCamera(n, NEEDLE_BIAS);
      // Кермо — поверх панелі, без перевірки глибини: у ScaniaCab верх обода геометрично за верхом панелі й не
      // малювався (гіпотеза: king.exe малює салон у порядку обʼєктів; звірено на око з користувачем). Матеріал —
      // копія: текстура спільна з панеллю. Прозорий прохід (transparent, renderOrder 10) — після стрілок приладів:
      // вони прозорі, і з кермом у непрозорому проході стрілки малювались поверх обода.
      this.cabParts.rule?.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m: THREE.Material) => Object.assign(m.clone(), { depthTest: false, transparent: true }));
        o.material = Array.isArray(o.material) ? mats : mats[0];
        o.renderOrder = 10;
      });
      // Скло (GlassKey, група 1) — завжди: його текстуру (краплі) малює GlassRain, суха — прозора.
      dyn.setSwitch('GlassKey', 1);
      this.cabSwitch = dyn.setSwitch;
      this.cabRadar = null;
      const mask = (n: string) => {
        const b = rmp.masks.get(n);
        return b ? parseMsk(b, asm.lib.palette ?? undefined) : null;
      };
      this.glassRain = new GlassRain(inner, mask('txr/glass_1.msk'), mask('txr/glass_2.msk'));
      this.glassRain.onStroke = () => this.audio?.play('wipers', 0.9);
    } finally {
      this.cabLoading = false;
    }
  }

  /** Машина, чиїм матеріалам задано площини CAB_ROOF_CLIP. */
  private clipFor: TruckVehicle | null = null;

  /**
   * З кабіни не малювати модель машини над лобовим склом (на прохання користувача, власне — механізму оригіналу не
   * знайдено): коробка CAB_ROOF у системі моделі над оком (козирок, дах спереду). У ScaniaR нижню грань зовнішнього
   * козирка (текстура scania_kabfront1) око бачило майже з ребра — тонка зелена смуга через усе скло. Площини —
   * спільні з копіями тієї ж моделі в трафіку, але коробка — лише біля ока гравця; поза кабіною — порожня.
   */
  private clipRoof(inside: boolean): void {
    const v = this.truck.visual;
    if (this.clipFor !== this.truck) {
      this.clipFor = this.truck;
      this.opts.renderer.localClippingEnabled = true;
      v.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (m.clippingPlanes === CAB_ROOF_CLIP) continue;
          m.clippingPlanes = CAB_ROOF_CLIP;
          m.clipIntersection = true;
          m.needsUpdate = true;
        }
      });
    }
    if (!inside) {
      // Порожня коробка: «усередині» лише y > 1e9.
      CAB_ROOF_CLIP[0].set(new THREE.Vector3(0, -1, 0), 1e9);
      return;
    }
    const e = this.cockpit;
    const [x, y0, y1, zBack, zFront] = CAB_ROOF;
    // Нормалі — назовні коробки: фрагмент відсікається, коли він з відʼємного боку всіх шести площин.
    const local: [number, number, number, number][] = [
      [0, -1, 0, e.y + y0],
      [0, 1, 0, -(e.y + y1)],
      [1, 0, 0, -x],
      [-1, 0, 0, -x],
      [0, 0, 1, -(e.z + zBack)],
      [0, 0, -1, e.z - zFront],
    ];
    v.updateWorldMatrix(true, false);
    local.forEach(([nx, ny, nz, c], i) => CAB_ROOF_CLIP[i].set(new THREE.Vector3(nx, ny, nz), c).applyMatrix4(v.matrixWorld));
  }

  /** Перемикачі кабіни; показаний антирадар (null — ще не задано). */
  private cabSwitch: ((name: string, group: number) => void) | null = null;
  private cabRadar: boolean | null = null;

  /** Префікс кабіни (prefixCab з vehicle.tech: ZilR → Zil, RenaultR → Reno). */
  private cabPrefix = '';

  /** Кабіна: на місці ока, орієнтація машини з нахилом погляду; кермо й стрілки — за станом. */
  private updateCab(dt: number): void {
    const inside = this.camMode === 'cockpit';
    // Крен кузова в поворотах з кабіни — на 30 % менший (на прохання користувача; капот і салон хиляться разом).
    this.truck.rollScale = inside ? COCKPIT_ROLL * cockpitCalm(this.truck.speedKmh) : 1;
    if (inside && !this.cab) void this.loadCab();
    this.clipRoof(inside);
    // Модель машини з кабіни не ховається (king.exe: режим кабіни, 0x548120 → +0x2590, вимикає лише плями фар на
    // дорозі, 0x552940): крізь скло видно капот, а оболонку кабіни зсередини відсікають однобічні полігони.
    if (!this.cab) return;
    this.cab.visible = inside;
    if (this.glassRain) {
      // Під дахом (тунель, міст — промінь угору влучає в геометрію) нових крапель немає. Лише нерухомий світ: у
      // високих кабін (RenaultR, KamazR, VolvoR, MercedesR…) початок променя (+3 м над центром) буває всередині
      // власного кузова — машина «стояла під дахом», і на склі не було крапель; причіп і трафік теж не дах.
      if ((this.shelterTimer -= dt) <= 0) {
        this.shelterTimer = 0.5;
        const t = this.truck.body.translation();
        this.sheltered = this.raining && !!this.rapier.castRay(new RAPIER.Ray({ x: t.x, y: t.y + 3, z: t.z }, { x: 0, y: 1, z: 0 }), 60, true, undefined, undefined, undefined, undefined, (c) => c.parent()?.isFixed() ?? true);
      }
      // Краплі на склі — ще й за повзунками графіки (g > 0,5 і d > 0,2, ui/effects.ts).
      // Набір кімнати з rain=off (тунелі WEATHER5/8, king.exe — щокадру гасить біти крапель і двірників): ні крапель,
      // ні двірників.
      const rainOn = this.weatherFlags.rain;
      this.glassRain.raining = this.raining && !this.sheltered && glassDrops() && rainOn;
      this.glassRain.wipersOn = rainOn && this.wipersManual;
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
    this.cabBase.decompose(this.cab.position, this.cab.quaternion, this.cab.scale);
    const rot = (o: THREE.Object3D | undefined, axis: THREE.Vector3, angle: number, size = 1) => {
      if (!o) return;
      o.matrix.copy(o.userData.baseMatrix as THREE.Matrix4).multiply(CAB_TMP.makeRotationAxis(axis, angle));
      // Довжина стрілки — у площині циферблата (x, z простору стрілки), навколо осі.
      if (size !== 1) o.matrix.multiply(CAB_TMP.makeScale(size, 1, size));
    };
    const deg = Math.PI / 180;
    const needle = (v: number, [max, angle]: [number, number]) => (Math.min(Math.max(v, 0), max * 1.05) / max) * angle * deg;
    // Кермо в кабіні — π/2 × положення керма s (king.exe 0x4decc0, поле 0x29e0; δ коліс = π/4·s): удвічі більше за
    // кут коліс, уже з межею й формою керма (а не натискання клавіші).
    // Вісь — z простору керма (0x5ac0c0); навколо y кермо ставало ребром і зникало в панелі.
    rot(this.cabParts.rule, AXIS_Z, 2 * this.truck.steerAngle);
    rot(this.cabParts.speed, AXIS_Y, needle(this.truck.speedKmh, this.def.speedScale), NEEDLE_SIZE);
    // Тахометр — як king.exe 0x53d530 → 0x53d1f0: оберти (поле машини 0x51ec) / шкала tech (у файлі — об/с; порт ділить
    // її на 5/3 — сотні об/хв: VolvoR 28, ZilR 40, як позначки на циферблатах) × кут шкали. Тож стрілка — rpm/100;
    // з rpm/60 показувала в 1,67 раза більше. Холості (4 об/с) — ≈ 2,4. Оберти оригінал згладжує (filterEngineTach —
    // середнє за вікном часу, re/notes/ht2/physics.md); порт — лише для стрілки, експонентою TACH_SMOOTH: оберти
    // фізики стрибали на перемиканнях і поштовхах, і стрілка сіпалась.
    this.tachShown += (this.truck.rpm - this.tachShown) * (1 - Math.exp(-dt / TACH_SMOOTH));
    rot(this.cabParts.tacho, AXIS_Y, needle(this.tachShown / 100, this.def.tachScale), NEEDLE_SIZE);
    // Паливо (0x53d1f0, стрілка FuelArrowSpace): частка пального в баку × кут FuelScale з tech. Без кар'єри — повний.
    const c = this.careerMode?.career;
    const fuel = c ? Math.min(1, Math.max(0, (c.fuel ?? this.tank) / this.tank)) : 1;
    rot(this.cabParts.fuel, AXIS_Y, fuel * (this.def.fuelScale ?? 0) * deg);
  }

  /**
   * Покриття під машиною: поза асфальтом (далі від осі дороги WAY, ніж половина її ширини) — опір кочення ×5 (у порту: −0,53…0,66 м/с² на 4-й–5-й, як виміряно).
   * Телеметрія king.exe (симулятор, ZilR): на узбіччі прискорення на 4-й/5-й передачі на ≈ 0,6 м/с² менше, ніж на
   * асфальті (≈ +0,06 g опору). Зчеплення поза дорогою — як на асфальті (не виміряно, гіпотеза).
   */
  private updateSurface(): void {
    const p = this.truck.visual.position;
    if (!this.roads) return;
    // Покриття під машиною — з колайдера підлоги (i2 блоку 23, king.exe 0x502780); промінь униз від центру кузова
    // (гіпотеза порту: одне покриття на всю машину, в оригіналі — на кожне колесо).
    const hit = this.rapier.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y: p.y + 1, z: p.z }, { x: 0, y: -1, z: 0 }), 6, true, undefined, GROUND_RAY, undefined, this.truck.body);
    let s = hit ? surfaceAt(hit.collider, hit.featureId) : 0;
    // Без даних (рельєф aa — heightfield) — за дорогою WAY: далі від осі, ніж половина ширини W, — узбіччя (ґрунт 2).
    if (!(s >= 1 && s <= 11)) s = this.roads.offRoad(p) ? 2 : 1;
    this.surface = s;
    this.offRoad = !HARD_SURFACE.has(s);
    // μ шин за покриттям і варіантом шин відносно звичайних на асфальті в ту саму погоду (дощ — окремо, K.rain).
    this.truck.setSurface(tireGrip(this.tuning.tires, this.raining, s), this.offRoad ? OFFROAD_ROLL : 1);
    // Нерівність (0x502780): тверді 1, 5 — асфальт, решта — як ґрунт (гілки 4/6/7/9/10/11 оригіналу порт не розрізняє).
    this.truck.roughness = s === 1 || s === 5 ? ROUGH_ASPHALT : ROUGH_GROUND;
  }

  /** Покриття під машиною 1…13 (налагодження). */
  surface = 1;

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
    // До старту машина стоїть на ручнику, без газу й гальма: утримане гальмо на місці вмикає задній хід — машина
    // їхала назад під час відліку (як і в першій грі).
    if (this.race?.holding) state = { ...state, throttle: 0, brake: 0, handbrake: true };
    if (this.rescue) {
      state = { ...state, throttle: 0, brake: 1 };
      this.rescue.left -= dt;
      if (this.rescue.left <= 0 && !this.rescue.done) {
        this.rescue.done = true;
        void this.finishRescue();
      }
    }
    // Вантажівки для трафіку — точками по всій довжині (трафік бере півдовжину 2,5 м навколо кожної): одна точка в
    // центрі довгої машини, що стоїть навскіс чи частково в смузі, лишала задок або передок «невидимим» — трафік їхав
    // у нього й таранив знову після кожного здавання назад.
    // Гравець (центр — та сама точка, що й player) разом із напівпричепом — одне тіло: обʼїжджають усе; так само
    // далекобійники з напівпричепами.
    const me = [this.truck.visual.position, ...alongPoints(this.truck), ...(this.trailer?.points() ?? [])];
    // Боти — з водієм (трафік пропускає їх на перехрестях і бачить чергу, traffic.TrafficBody).
    const rigs = (this.truckers?.rigs ?? []).map((r) => Object.assign([...alongPoints(r.truck), ...(r.trailer?.points() ?? [])], { mover: r.bot.m }));
    this.traffic?.update(dt, this.truck.visual.position, [me, ...rigs]);
    // Водії ботів (як у трафіку, traffic/botDriver.ts): гравець — точками вздовж машини з причепом; зустрічні для
    // розминання — гравець і трафік (позиція й курс).
    const oncoming = [{ pos: this.truck.visual.position, forward: this.truck.forward().setY(0).normalize() }, ...(this.traffic?.cars.map((c) => ({ pos: c.pos, forward: c.heading })) ?? [])];
    const lv = this.truck.body.linvel();
    this.truckers?.think(dt, me, new THREE.Vector3(lv.x, lv.y, lv.z), oncoming);
    this.updateSurface();
    this.acc += dt;
    const step = this.rapier.timestep;
    this.objects.before();
    const walls = this.wallsPending.splice(0);
    const stepped = this.acc >= step;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.trailer?.update(step, this.truck.brakePedal(state), this.def.tech.brakePower, this.truck.kinematic, this.truck.towTires);
      this.race?.control(step);
      this.netCars?.control(step);
      this.truckers?.control(step);
      this.traffic?.control(step);
      this.police?.control(step);
      this.mafia?.control(step);
      this.roomBounds.step();
      this.acc -= step;
      // Розрив зчіпки (складання понад 135°, перекидання, крен) — причіп відривається, як клавішею (physics.md).
      if (this.trailer?.broken && !this.race) {
        this.dropTrailer();
        this.say('ПРИЧІП ВІДІРВАЛО');
      }
    }
    // Лінії баз — від стін (колайдери нових регіонів у запитах лише після кроку).
    if (stepped) for (const id of walls) if (this.world.loaded.has(id)) this.roads.clearWalls(id, this.wallProbe);
    if (!stepped) this.wallsPending.push(...walls);
    // Частка кроку фізики, що «не дійшла» до наступного, — модель між станами кроків (без ривків при 120 Гц).
    const alpha = this.acc / step;
    // Збиті знаки й стовпи, рухомі предмети (world/objects.ts) — до обліку ударів.
    for (const e of this.objects.after(dt)) {
      this.audio?.play(e.sound, e.volume);
      if (e.blast) this.blastFx().blow3(e.blast.matrix, e.blast.column);
      // Підрив цілої заправки гравцем — «злочинна недбалість», відшкодування 6200 (king.exe 0x56f120).
      const cm = this.careerMode;
      if (e.benzo?.intact && cm && e.benzo.body === this.truck.body.handle) {
        cm.fines.accident += 6200;
        cm.fines.violations |= 0x20;
        this.say(cm.msg('VIOLATION_NEGLIGENCE', 'ЗЛОЧИННА НЕДБАЛІСТЬ'), 5);
        cm.persist();
      }
    }
    this.race?.after(dt, alpha);
    this.netCars?.after(alpha);
    if ((this.race?.net || this.netCars) && this.onNetState && (this.netTimer -= dt) <= 0) {
      this.netTimer = Math.max(0, this.netTimer + 1 / STATE_RATE);
      const flags = (this.lamps[0]?.visible ? FLAG_LIGHTS : 0) | (this.truck.brakePedal(state) > 0 ? FLAG_BRAKE : 0) | (this.truck.gear < 0 ? FLAG_REVERSE : 0);
      this.onNetState(this.race?.net ? this.race.netPacket(flags) : this.netCars!.packet(flags));
    }
    this.detectHits();
    this.detectTrailerHits();
    if (this.careerMode && !this.paused) this.accidents?.update(dt);
    this.lights.update(dt, this.world.loaded.values());
    // Проїзд стоп-лінії на червоне (0x56ffd0): штраф 830, лише якщо міліція ближче 200 м; раз за перетин.
    if (this.lights.player(this.truck.visual.position) && this.careerMode && this.police?.near(this.truck.visual.position, 200)) {
      this.careerMode.fines.redLight += RED_LIGHT_FINE;
      this.careerMode.persist();
    }
    this.truckers?.after(dt, this.truck.visual.position, alpha, Math.abs(this.truck.speedKmh) / 3.6);
    this.stampIcons();
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
    this.updateCopters(dt);
    this.updateRadars(dt);
    this.updateReveal(dt);
    this.updateSirens();
    this.updateFire(dt);
    this.updateFreeDamage(dt);
    this.updateMafia(dt);
    if (this.markets && this.careerMode) this.markets.update(this.truck.visual.position, Math.floor(this.careerMode.career.time / 86400));
    this.obstacles?.update(dt);
    const sign = this.signs?.update(this.truck.visual.position, this.truck.forward());
    if (sign) this.say(sign, 6);
    this.fPanels?.update(dt);
    this.syncSidePanel();
    // Кнопка карти світиться, поки карта на екрані (огляд чи мінікарта).
    this.input.setToggle('map', this.tabMap ? this.tabMap.state !== 0 : !!this.worldMap && !this.worldMap.el.hidden);
    // Фари й двигун у групі «•••» — світяться, поки ввімкнені.
    this.input.setToggle('lights', !!this.lamps[0]?.visible);
    this.input.setToggle('engine', this.truck.engineOn);
    // Задні вогні (dents.rearLights): стоп — гальмо, задній хід — передача R; причепу тягач передає лише задній хід
    // і габарити (0x558990).
    const reverse = this.truck.gear < 0;
    this.dents?.rearLights(this.truck.brakePedal(state) > 0, reverse, this.sizeLights);
    this.trailerDents?.rearLights(false, reverse, this.sizeLights);
    // Двірники — два стани (увімкнені / вимкнені): світяться, поки ввімкнені (і без скла кабіни — за вибором чи дощем).
    this.input.setToggle('wipers', this.glassRain?.wipersOn ?? this.wipersManual);
    this.input.setToggle('mirror', this.mirrorOn);
    // Причепити / відчепити — лише тягачем; світиться, поки причіп зчеплений.
    this.input.setToggle('attach', !!this.trailer, !this.hitched || !!this.race);
    if (this.careerMode) this.hiredStep(dt);
    // Вільна їзда: причепи лише стоять (поповнення й моделі біля гравця), T прибирає й повертає свій причіп.
    if (this.presents && !this.careerMode) this.presents.update(this.truck.visual.position, 0, (k) => this.canTow(k), dt);
    if (this.presents && this.careerMode) {
      const cm = this.careerMode;
      this.presents.update(this.truck.visual.position, cm.career.time, (k) => this.canTow(k), dt);
      const expired = this.presents.expire(cm.career.time);
      // Причепи — у даних кар'єри раз на секунду (їх зберігає будь-яке збереження кар'єри), прострочення — одразу.
      if ((this.presentsSaveTimer -= dt) <= 0 || expired) {
        this.presentsSaveTimer = 1;
        cm.career.presents = this.presents.snapshot();
        if (this.caches) cm.career.caches = this.caches.snapshot();
        if (expired) cm.persist();
      }
    }
    if (this.caches && this.careerMode) this.cacheStep(this.careerMode, dt);
    this.updateNavigator(dt);
    this.tabMap?.draw(dt, {
      me: this.truck.visual.position,
      heading: this.truck.forward(),
      // Лише суперники в змаганні (king.exe 0x529890: прапорець 0x80 — гонка, конкуренти за вантаж); звичайні
      // далекобійники й трафік на карті не показуються (career-misc.md §4). Конкуренти за вантаж — на їхній частці
      // маршруту гравця (careerMode.rivalMarks, порт: їдуть без моделей).
      rivals: this.race ? this.race.racers.slice(1).filter((r) => !this.netPlayer(r)).map((r) => r.truck.visual.position) : (this.careerMode?.rivalMarks ?? []),
      players: this.race?.net
        ? this.race.racers.slice(1).filter((r) => this.netPlayer(r)).map((r) => ({ pos: r.truck.visual.position, color: PLAYER_COLORS[r.id!] ?? '#fff' }))
        : this.netCars?.visible().map((c) => ({ pos: c.pos, color: PLAYER_COLORS[c.id] ?? '#fff' })),
      target: this.careerMode?.target() ?? null,
      // Фініш гонки — значок I_race з написом mess.txt 88 «Кольцо».
      finish: this.race?.finishPos ?? null,
      // Свої наймані водії — I_tr_myc (0x529890).
      mine: this.hiredMarks,
      // Причепи з вантажем (дорожні місії) — I_trailer; порожні на базах — без значка (0x529890).
      trailers: this.presents?.withCargo.map((p) => p.pos) ?? [],
      debris: this.obstacles?.activeObstacle ? [this.obstacles.activeObstacle.pos] : [],
      finishLabel: this.race?.finishLabel ?? 'КІЛЬЦЕ',
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
      this.setBar((this.careerMode ? this.careerMode.hud(true) : this.race ? this.race.hud() : '') + who);
    } else this.setBar((this.careerMode ? `${drive}\n${this.careerMode.hud()}${this.race ? `\n${this.race.hud()}` : ''}` : this.race ? `${drive}\n${this.race.hud()}` : drive) + who);
  }

  /** Рядок табло — у DOM лише при зміні (запис textContent щокадру перераховує розкладку сторінки). */
  private setBar(text: string): void {
    if (this.barText === text) return;
    this.barText = text;
    this.bar.textContent = text;
  }

  private barText = '';

  /** Повідомлення гравцю: на пейджер (з оригінальним інтерфейсом) чи в рядок табло на time с. */
  /** Звук з набору гри (гонка: `alarm` світлофора). */
  playSound(name: string): void {
    this.audio?.play(name);
  }

  say(text: string, time = 5): void {
    if (this.tablo) this.tablo.message(text);
    else this.notice = { text, time };
  }

  /** Машина іншого гравця мережевої гри на трасі (не суперник на автопілоті, не вийшов). */
  private netPlayer(r: RaceMode['racers'][number]): boolean {
    return !!r.remote && !r.remote.gone && !r.remote.waiting && r.id !== undefined && r.id < FIRST_RIVAL;
  }

  /** Компас Тріалу на табло: сектор напрямку на наступну точку (race.compassTarget) чи null. */
  private compass(): number | null {
    const t = this.race?.compassTarget();
    return t ? compassSector(this.truck.forward(), t.clone().sub(this.truck.visual.position)) : null;
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
      condition: c ? 1 - c.damage : this.race ? 1 : 1 - this.freeDamage,
      nav: this.navTurn,
      position: this.careerMode?.race ?? (this.race?.net ? this.race.standing() : null),
      compass: this.compass(),
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

  /** Згладжені курс і нахил погляду камери за машиною (NaN — почати з поточних); стрибок — нова машина. */
  private camYaw = NaN;
  /**
   * Кут зовнішньої камери навколо машини, рад (0 — позаду): king.exe 0x59a030 крутить його клавішами «камера
   * ліворуч/праворуч» на ±ORBIT_RATE·dt і тримає в −π…π; з кабіни не діє.
   */
  private camOrbit = 0;
  private camPitch = 0;
  private chaseJump = false;
  /** Згладжені кути голови в кабіні (рад): уперед і вбік (king.exe 0x535a70); місце водія без гойдання. */
  private headA = 0;
  private headB = 0;
  /**
   * Салон — жорстко на моделі машини (з нахилом кузова, як капот), на прохання користувача: салон і капот рухаються
   * разом, гойдається лише голова. В king.exe салон хилиться окремо (0x4decc0, канали CabChan_*, 0,64 крену кузова
   * з запізненням 0,3 с) — re/notes/ht2/steering.md; не перенесено.
   */
  private readonly cabBase = new THREE.Matrix4();

  private updateCamera(dt: number): void {
    const v = this.truck.visual;
    const fwd = this.truck.forward();
    const up = new THREE.Vector3(0, 1, 0);
    if (this.camMode === 'cockpit') {
      this.camYaw = NaN;
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (this.def.tech.viewerTilt * Math.PI) / 180);
      // ВИД ІЗ КАБІНИ — повний опис (формули, константи, що з king.exe, що змінено на прохання користувача, звірка з
      // оригіналом): Docs/ht2/cockpit.md. Коротко:
      //  - модель машини видима (капот), салон CABINES — другим проходом поверх, жорстко разом із моделлю;
      //  - око = viewer з tech + COCKPIT_LIFT на моделі (з нахилом кузова); погляд — bodyQuat (без нахилу) · кивок · tilt;
      //  - голова зсувається на HEAD_SHIFT·кут, салон — на CAB_PARALLAX від того зсуву (інший масштаб CABINES);
      //  - кути голови — з (g − a) кузова, м'яка межа tanh, ослаблення й згладжування зі швидкістю;
      //  - крен кузова з кабіни — rollScale = COCKPIT_ROLL · cockpitCalm (updateCab); світло салону — cabAmbient.
      // Голова-маятник (king.exe 0x535a70): кути A = 0,005·(g − a) уперед (≤ 2,5°) і B = 0,005·(g − a) праворуч
      // (≤ 5°), згладжені 0,8^(10·dt) (τ ≈ 0,45 с); у порту — лише кивок на A і крен на 0,1·B (див. нижче).
      // На прохання користувача: плавніше (0,85 замість 0,8 — τ ≈ 0,6 с), зсув на 20 % менший (HEAD_SHIFT) і м'яка
      // межа: що ближче до краю, то повільніше росте кут (tanh замість обрізання).
      // На швидкості — ще слабше й плавніше (cockpitCalm; згладжування 0,85 на місці → ≈ 0,92 на ходу, як 0x535a70
      // робить для висоти голови).
      const ms = Math.abs(this.truck.speedKmh) / 3.6;
      const calm = cockpitCalm(this.truck.speedKmh, HEAD_CALM_SPAN);
      const f1 = (0.92 - 0.07 * (5 / (ms + 5))) ** (10 * dt);
      const soft = (x: number, max: number) => max * Math.tanh(x / max);
      const A = soft(0.005 * calm * this.truck.feltFwd, HEAD_PITCH_MAX);
      const B = soft(0.005 * calm * this.truck.feltSide, HEAD_SIDE_MAX);
      this.headA = f1 * this.headA + (1 - f1) * A;
      this.headB = f1 * this.headB + (1 - f1) * B;
      const a = this.headA;
      const b = this.headB;
      // Око — на місці водія моделі (з нахилом кузова); погляд — з орієнтації кузова без нахилу (king.exe — матриця
      // машини +0x204, тож капот і салон хиляться в кадрі разом), кивок голови на A і крен на 0,1·B. Голова
      // зсувається на (4B; угору −4(A² + B²); уперед 4A), а салон — на CAB_PARALLAX від цього зсуву: салон CABINES
      // задано не в метрах, і без поправки капот їхав відносно салону.
      const eye = this.cockpit.clone().applyQuaternion(v.quaternion).add(v.position);
      const k = HEAD_SHIFT;
      const head = new THREE.Vector3(k * b, -k * (a * a + b * b), -k * a).applyQuaternion(this.truck.bodyQuat);
      this.camera.position.copy(eye).add(head);
      const nod = new THREE.Quaternion().setFromEuler(new THREE.Euler(-a, 0, -0.1 * b, 'XYZ'));
      this.camera.quaternion.copy(this.truck.bodyQuat).multiply(nod).multiply(tilt);
      this.cabBase.compose(eye.clone().addScaledVector(head, CAB_PARALLAX), v.quaternion.clone().multiply(tilt), new THREE.Vector3(1, 1, 1));
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
      this.chaseJump = true;
    }
    const dist = far ? 28 * tow : (CHASE_BACK - this.chaseMid) * tow;
    const height = (far ? 12 : CHASE_UP) * tow;
    const flat = fwd.clone().setY(0).normalize();
    const turn = this.input.camTurn;
    if (turn) {
      this.camOrbit += turn * ORBIT_RATE * dt;
      this.camOrbit = Math.atan2(Math.sin(this.camOrbit), Math.cos(this.camOrbit));
    }
    // «Ліворуч» — камера обходить машину з її лівого боку (кут < 0), «праворуч» — з правого.
    if (this.camOrbit) flat.applyAxisAngle(up, this.camOrbit);
    // Висота машини для камери — згладжена (0,35 с): тряска кузова від нерівностей і підвіски не передається в кадр,
    // підйоми й спуски дороги камера відстежує (як в оригіналі — камера над машиною стала, без тремтіння).
    const ky = 1 - Math.exp(-dt / 0.35);
    this.camBaseY = Number.isFinite(this.camBaseY) && Math.abs(v.position.y - this.camBaseY) < 20 ? this.camBaseY + (v.position.y - this.camBaseY) * ky : v.position.y;
    const want = v.position.clone().setY(this.camBaseY).addScaledVector(flat, -dist).addScaledVector(up, height);
    if (far) {
      this.camYaw = NaN;
      const look = v.position.clone().addScaledVector(up, 2);
      if (this.chaseJump) {
        this.camPos.copy(want);
        this.camLook.copy(look);
      }
      this.camPos.lerp(want, 1 - Math.exp(-dt * 4));
      this.camLook.lerp(look, 1 - Math.exp(-dt * 10));
    } else {
      // Як в оригіналі (запис king.exe, ZilR від бази до греблі): по горизонталі камера відстає від свого місця з
      // запізненням CHASE_LAG (позаду 8,8 м на місці, 16 м на 46 км/год, 20 — на 70, 25,7 — на 100: 8,8 + 0,58·v; у
      // поворотах — убік до ±5 м), висота над машиною стала. Дивиться на точку біля машини — тож нахил сам зменшується
      // з відстанню (оригінал: 25° → 10° на 100 км/год).
      const k = 1 - Math.exp(-dt / CHASE_LAG);
      // Стрибок машини (телепорт, 911, нова машина) — камера одразу на місці, без «польоту» через карту.
      if (this.chaseJump || Math.hypot(want.x - this.camPos.x, want.z - this.camPos.z) > CHASE_JUMP) {
        this.chaseJump = true;
        this.camPos.copy(want);
      }
      this.camPos.x += (want.x - this.camPos.x) * k;
      this.camPos.z += (want.z - this.camPos.z) * k;
      this.camPos.y = want.y;
      const target = want.clone().addScaledVector(flat, CHASE_LOOK * Math.cos(CHASE_PITCH)).addScaledVector(up, -CHASE_LOOK * Math.sin(CHASE_PITCH));
      // Погляд (king.exe 0x59a030, re/notes/ht2/steering.md): з уже згладженої камери на точку машини, і курс та нахил
      // погляду згладжуються вдруге тим самим k — тож на початку повороту машина зміщується в кадрі, а кадр
      // розвертається з запізненням (курс машини змінюється одразу, як в оригіналі).
      const d = target.sub(this.camPos);
      const yaw = Math.atan2(d.x, d.z);
      const pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
      if (!Number.isFinite(this.camYaw) || this.chaseJump) {
        this.camYaw = yaw;
        this.camPitch = pitch;
      } else {
        this.camYaw += Math.atan2(Math.sin(yaw - this.camYaw), Math.cos(yaw - this.camYaw)) * k;
        this.camPitch += (pitch - this.camPitch) * k;
      }
      const len = d.length();
      this.camLook.set(Math.sin(this.camYaw) * Math.cos(this.camPitch), Math.sin(this.camPitch), Math.cos(this.camYaw) * Math.cos(this.camPitch)).multiplyScalar(len).add(this.camPos);
    }
    // Камера не заходить за стіни й у рельєф: інакше видно зворотні (непомальовані) боки стін, дахів і пагорбів, а
    // крізь них — машини й порожнечу.
    this.camera.position.copy(this.camPos);
    this.keepOffWalls(v.position.clone().addScaledVector(up, CAM_WALL_FROM), this.camera.position, dt);
    this.chaseJump = false;
    this.camera.lookAt(this.camLook);
  }

  /** Частка відстані від машини до камери, вільна від стін (згладжена при віддаленні; keepOffWalls). */
  private camReach = 1;

  /**
   * Камера за машиною — поза колізіями світу, як у king.exe (0x599210 → 0x599120: куля 0,3 м навколо камери
   * виштовхується з колізій кімнати, до 10 спроб, далі — обертання навколо машини; re/notes/ht2/steering.md). Порт —
   * простіше: куля CAM_BALL летить від точки над машиною до камери, і камера стає там, де куля вперлася в стіну, дах,
   * міст чи схил (лише нерухомі колайдери світу — без машин і причепів). Наближається одразу, віддаляється за
   * CAM_WALL_BACK с — щоб не стрибала за стовпом чи деревом.
   */
  private keepOffWalls(from: THREE.Vector3, cam: THREE.Vector3, dt: number): void {
    const dir = cam.clone().sub(from);
    const dist = dir.length();
    if (dist < 0.5) return;
    dir.divideScalar(dist);
    const hit = this.rapier.castShape(from, IDENTITY_Q, dir, CAM_BALL, 0, dist, false, undefined, undefined, undefined, undefined, (c) => !c.parent());
    const free = hit ? hit.time_of_impact / dist : 1;
    this.camReach = free < this.camReach || this.chaseJump ? free : this.camReach + (free - this.camReach) * (1 - Math.exp(-dt / CAM_WALL_BACK));
    if (this.camReach < 1) cam.copy(from).addScaledVector(dir, dist * this.camReach);
  }

  dispose(): void {
    if (this.careerMode) {
      if (!this.noSave) this.careerMode.persist();
      else if (this.checkpoint) restoreCareer(this.checkpoint.id, this.checkpoint.raw);
    }
    this.careerMode?.dispose();
    this.escMenu?.close();
    this.fPanels?.close();
    document.removeEventListener('pointerdown', this.onOutsideTap, true);
    document.removeEventListener('visibilitychange', this.onHide);
    window.removeEventListener('pagehide', this.onHide);
    document.body.classList.remove('ht2-side-open', 'ht2-left-open', 'ht2-right-open');
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
    if (this.cab) disposeCab(this.cab);
    this.music?.dispose();
    this.traffic?.dispose();
    this.debris?.dispose();
    this.blasts?.dispose();
    this.tracks?.dispose();
    this.police?.dispose();
    this.mafia?.dispose();
    this.copters?.dispose();
    this.markets?.dispose();
    this.worldMap?.dispose();
    this.race?.dispose();
    this.netCars?.dispose();
    this.truckers?.dispose();
    this.trailer?.dispose();
    this.presents?.dispose();
    this.caches?.dispose();
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
