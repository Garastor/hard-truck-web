import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addCollisionPolys, addStaticMeshes, g2t, initRapier } from '../physics/world';
import { floorAt, levelCollision, openPortals, roomAt, type LevelCollision } from '../game/collision';
import { Input } from '../input/input';
import { TruckVehicle, type TruckSetup } from '../game/truckVehicle';
import { GlassRain } from '../render/glassRain';
import { parseMsk, type Msk } from '../formats/msk';
import { Movables } from '../game/movables';
import { Effects } from '../render/effects';
import { TruckLights, hideLampReflections } from '../render/truckLights';
import { WetReflections } from '../render/wetReflections';
import { Headlights, litByHeadlights } from '../render/headlights';
import { NavMap } from '../ui/navMap';
import { NEEDLE_SCALE, buildTruckModel, type TruckDef } from '../game/trucks';
import { SKY_FOG, type BuiltScene } from '../render/sceneBuilder';
import { CAB2D_PARTS, Cab2d } from '../render/cab2d';
import { Cab2dRain, RainStreaks } from '../render/cab2dRain';
import type { RgbaImage } from '../formats/binary';
import { cabStyle, type CabStyle } from '../game/viewSettings';
import { walk } from '../formats/b3d';
import type { RmpArchive } from '../formats/rmp';
import { EngineAudio, type LoopSound } from '../audio/engineAudio';
import { DriveHud, odometerDigits } from '../ui/driveHud';
import { RouteProgress } from '../game/raceProgress';
import type { PixelFont } from '../ui/pixelFont';
import { EVENT_CHECKPOINT, EVENT_DEATH, EVENT_FINISH, EVENT_RAIN, Track, isHorizontalPortal, type Room } from '../game/track';
import { AutoPilot, WayNet } from '../game/autopilot';
import { RoomVisibility } from '../render/roomVisibility';
import { toast } from '../ui/mobile';

/** Камера (C): з кабіни, від першої особи (лише прилади Panel), позаду, здалеку. */
export type CamMode = 'chase' | 'cockpit' | 'first' | 'far';

if (import.meta.env.DEV) Object.assign(window, { RAPIER });

/**
 * Режим їзди (Фаза 3): фізичний світ з геометрії локації, вантажівка, камера, HUD.
 */
/** Шар Three.js для деталей кабіни, що малюються поверх решти кабіни (кермо). */
const CAB_TOP_LAYER = 1;

/** Утонули: тіло (≈ 1,1 м над дорогою, коли стоїть) нижче за цю висоту над водою. Падіння без підлоги довше — загибель. */
const DROWN_HEIGHT = 1.3;
/** Звідки над тілом пускаємо промінь до поверхні, м. */
const SURFACE_RAY_UP = 6;
const FALL_DEATH_TIME = 3;
/**
 * Покриття під колесами — за матеріалом поверхні (розібрано за текстурами трас; у файлах гри типу покриття
 * немає, тож це класифікація порту): гравій COUNT (road_20/28/29, cobble — щебінь), MOUNT (roadsd0, stones0,
 * stream0 — камʼянисте русло); ґрунт — трава, пісок, ґрунт полігону; вода. Змішані текстури (асфальт із травою
 * по краях) — за кольором текселя під колесами: зелений — трава.
 */
type Surface = 'asphalt' | 'gravel' | 'dirt' | 'water';
const SURFACE_GRAVEL = /^(road_2[089]|cobble|roadsd\d*|stones\d*|stream0)$/i;
const SURFACE_DIRT = /grass|beach|sand|grnd|ground|dirt|mud|field|forest/i;
const SURFACE_WATER = /water|river|stream[1-9]/i;
/** [зчеплення, опір кочення] відносно асфальту — гіпотеза (симулятор; аркада — без впливу). */
const SURFACE_FX: Record<Surface, [number, number]> = { asphalt: [1, 1], gravel: [0.8, 2], dirt: [0.6, 3.5], water: [0.5, 4] };

function classifySurface(name: string, texel: [number, number, number] | null): Surface {
  if (SURFACE_WATER.test(name)) return 'water';
  if (SURFACE_GRAVEL.test(name)) return 'gravel';
  if (SURFACE_DIRT.test(name)) return 'dirt';
  if (texel) {
    const [r, g, b] = texel;
    if (g > 50 && g > r * 1.15 && g > b * 1.15) return 'dirt';
  }
  return 'asphalt';
}

/**
 * Блискучість мокрої поверхні за її текстурою (на око): темний рівний асфальт — найбільше, світлий бетон і
 * плитка — менше, різке зерно (шорстка поверхня) — менше; однотонні (розмітка) — за кольором. Раз на матеріал.
 */
const glossCache = new WeakMap<THREE.Material, number>();
function surfaceGloss(mat: THREE.MeshBasicMaterial | undefined): number {
  if (!mat) return 0;
  const known = glossCache.get(mat);
  if (known !== undefined) return known;
  let mean = mat.color ? (mat.color.r + mat.color.g + mat.color.b) / 3 : 0.5;
  let spread = 0;
  const img = mat.map?.image as { data?: Uint8Array | Uint8ClampedArray; width: number; height: number } | undefined;
  if (img?.data && img.width && img.height) {
    // Сітка 24×24 текселів: середня яскравість і розкид.
    let sum = 0;
    let sq = 0;
    let n = 0;
    for (let y = 0; y < 24; y++) {
      for (let x = 0; x < 24; x++) {
        const i = (Math.floor(((y + 0.5) / 24) * img.height) * img.width + Math.floor(((x + 0.5) / 24) * img.width)) * 4;
        const l = (img.data[i] + img.data[i + 1] + img.data[i + 2]) / (3 * 255);
        sum += l;
        sq += l * l;
        n++;
      }
    }
    mean = sum / n;
    spread = Math.sqrt(Math.max(0, sq / n - mean * mean));
  }
  // Шкала під покриття трас: асфальт — яскравість 0,17…0,31, тротуари й бордюри — 0,20…0,34; розкид 0,02…0,14
  // (частина — намальована розмітка, тож вага зерна мала).
  const dark = Math.min(1, Math.max(0.3, 1 - (mean - 0.15) * 2.2));
  const smooth = Math.min(1, Math.max(0.55, 1 - (spread - 0.04) * 2.5));
  const g = dark * smooth;
  glossCache.set(mat, g);
  return g;
}

/** Колір текстури в точці UV (текстури оригіналу — RGBA у памʼяті, рядок 0 — v = 0). */
function texelAt(map: THREE.Texture | null | undefined, uv: THREE.Vector2 | undefined): [number, number, number] | null {
  const img = map?.image as { data?: Uint8Array | Uint8ClampedArray; width: number; height: number } | undefined;
  if (!img?.data || !uv) return null;
  // Середнє по хресту 5 текселів (±3) — окремий темний піксель трави не робить її «асфальтом».
  const cx = Math.floor((((uv.x % 1) + 1) % 1) * img.width);
  const cy = Math.floor((((uv.y % 1) + 1) % 1) * img.height);
  const sum = [0, 0, 0];
  for (const [dx, dy] of [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
    const x = (cx + dx + img.width) % img.width;
    const y = (cy + dy + img.height) % img.height;
    const i = (y * img.width + x) * 4;
    for (let k = 0; k < 3; k++) sum[k] += img.data[i + k];
  }
  return [sum[0] / 5, sum[1] / 5, sum[2] / 5];
}
/** Звуки ударів: тихіші за IMPACT_SOUND_MIN (м/с за крок) не чути; від IMPACT_CRASH — аварія (гіпотеза). */
const IMPACT_SOUND_MIN = 1.5;
const IMPACT_CRASH = 6;
const CRASH_SOUNDS = ['crash2', 'crash4a', 'crash9'];
/** Тестовий режим: сила ударів, після якої машина вибухає (у кар'єрі техстан 0 — це 250 при зносі 0,004 за одиницю). */
const WRECK_HITS = 250;
/** Туман під дощем: початок і повна непрозорість, м (гіпотеза). */
/** Дзеркало: частка ширини екрана, співвідношення сторін і вертикальне поле зору, ° (на око). */
const MIRROR_WIDTH = 0.3;
const MIRROR_ASPECT = 3.2;
const MIRROR_FOV = 22;
const NEXT_CAM: Record<CamMode, CamMode> = { cockpit: 'first', first: 'chase', chase: 'far', far: 'cockpit' };
/** Вертикальне поле зору виду від першої особи: піраміда 1.6×1.2 (HTruck.exe 0x4851ac) → 2·atan(0,6). */
/** Збільшення приладів Panel на сенсорному екрані. */
const PANEL_TOUCH_SCALE = 1.8;
const PANEL_FOV = THREE.MathUtils.radToDeg(2 * Math.atan(0.6));

/** Туман: колір, початок і кінець, м (гіпотеза). */
const RAIN_FOG: [number, number, number] = [0x8d959d, 40, 420];
const NIGHT_FOG: [number, number, number] = [0x10141a, 80, 600];
const NIGHT_RAIN_FOG: [number, number, number] = [0x1a1e24, 30, 320];
/** Скло ліхтаря лежить на поверхні кузова: останні стільки метрів променя до нього не перевіряємо. */
const LAMP_SKIP = 0.6;
/** Розтяг циліндра дощу по висоті (гіпотеза, див. update). */
const RAIN_STRETCH = 1.6;
/** Зони вмʼятин за годинниковою стрілкою від переду — суфікси перемикачів `Damage<зона>Key` у моделях. */
const DENT_ZONES = ['FC', 'FR', 'R', 'BR', 'BC', 'BL', 'L', 'FL'];
/** Удари слабші за це (м/с за крок) вмʼятин не лишають; пороги рівнів — за накопиченою силою (гіпотеза). */
const DENT_MIN_HIT = 2;
const DENT_STEPS = [5, 14, 28, 50];

/** Стартовий світлофор (HTruck.exe 0x490da4): червоний 2 с + жовтий 3,5 с до старту, зелений — ще 5 с після. */
const START_RED = 2;
const START_YELLOW = 3.5;
const START_GREEN = 5;
const START_COUNTDOWN = START_RED + START_YELLOW;
type StartLamp = 'r' | 'y' | 'g' | 'off';

/** Лампа за часом від початку відліку: жовтий спалахує на кожній третій третині секунди (n mod 3 = 2, n < 9). */
function startLamp(t: number): StartLamp {
  if (t < START_RED) return 'r';
  if (t < START_COUNTDOWN) {
    const n = Math.floor((t - START_RED) * 3 + 0.01);
    return n % 3 === 2 && n < 9 ? 'y' : 'off';
  }
  return t < START_COUNTDOWN + START_GREEN ? 'g' : 'off';
}

/** Скільки суперник лежить перекинутим, перш ніж повернутися на дорогу, с (гіпотеза). */
const OPPONENT_RECOVER = 3;

/** Машина лежить на боці чи догори колесами. */
function isFlipped(t: TruckVehicle): boolean {
  const q = t.body.rotation();
  return 1 - 2 * (q.x * q.x + q.z * q.z) < 0.5;
}

export class DriveSession {
  private world!: RAPIER.World;
  private truck!: TruckVehicle;
  readonly input = new Input();
  private wakeLock: { release(): Promise<void> } | null = null;
  private touchUi: HTMLElement | null = null;
  private hud!: HTMLElement;
  private acc = 0;
  private camMode: CamMode = 'chase';
  private readonly camPos = new THREE.Vector3();
  /**
   * Інерція погляду на поворотах: камера (у кабіні й ззовні) відстає від курсу вантажівки й догоняє його
   * як на пружині — візуальний ефект оригіналу. camYaw — зсув погляду відносно курсу, рад.
   */
  private camYaw = 0;
  private camYawVel = 0;
  private lastHeading: number | null = null;
  /** Поза кабіни (без інерції погляду) — салон прикріплений до вантажівки. */
  private readonly cabQuat = new THREE.Quaternion();
  private readonly camLook = new THREE.Vector3();
  private spawn!: { position: THREE.Vector3; forward: THREE.Vector3 };
  private cockpit = new THREE.Vector3(-0.4, 2.2, -1.2);
  /** Сцена кабіни: малюється поверх світу (після очищення глибини), як в оригіналі. */
  readonly overlayScene = new THREE.Scene();
  /** Висота (Three.js y), нижче якої вантажівка вважається такою, що випала зі світу. */
  private fallY = -200;
  private hudTimer = 0;
  private pixelHud: DriveHud | null = null;
  /** Міцність машини й цілість вантажу (0…1), баланс гравця (null — не показувати) для табло; без обробника — тестовий режим. */
  hudStatus: (() => { truck: number | null; cargo: number | null; money: number | null }) | null = null;
  private cab: THREE.Group | null = null;
  private cabParts: { rule?: THREE.Object3D; tacho?: THREE.Object3D; speed?: THREE.Object3D } = {};
  private cabSwitch: ((n: string, state: number) => void) | null = null;
  /** Пробіг, м (одометр на панелі: блакитні — км, червоні — десятки метрів). */
  private odometer = 0;
  private audio: EngineAudio | null = null;
  private brakeSqueal = 0;
  private track!: Track;
  private room: string | null = null;
  private readonly prevPos = new THREE.Vector3();
  private readonly visited = new Set<string>();
  private lapStart: number | null = null;
  /** Ігровий час, с (накопичується кроками фізики). */
  private clock = 0;
  private lapTime = 0;
  private bestLap: number | null = null;
  private laps = 0;
  /** Сектор, з якого почався відлік кола. */
  private lapRoom: string | null = null;
  /** Суперники (aicar у truck.ini): вантажівки під керуванням автопілота. */
  readonly opponents: { truck: TruckVehicle; pilot: AutoPilot; odo: Odometer; lights: TruckLights | null; flippedFor: number }[] = [];
  private readonly playerOdo = new Odometer();
  /** Маршрут гонки від старту гравця — для місця в гонці. */
  private route: RouteProgress | null = null;
  /** Відлік до старту, с (світлофор над стартом, як в оригіналі: червоний → три спалахи жовтого → зелений). */
  private countdown = START_COUNTDOWN;
  /** Поточна лампа стартового світлофора; null — ще не вмикали. */
  private lamp: StartLamp | null = null;
  /** Звук спалаху жовтого (alarmSound), звучить, поки лампа горить. */
  private lampBeep: { stop(): void } | null = null;
  /** Кількість кіл гонки (Кольцо — 3, за довідкою оригіналу); 0 — без фінішу. */
  lapsToFinish = 3;
  /** Тип заїзду: кільцева гонка, маршрут до фінішу, вільна їзда (база). */
  raceKind: 'laps' | 'route' | 'free' = 'laps';
  private finished: { place: number; time: number } | null = null;
  /** Результат заїзду (місце, час) — після фінішу. */
  get result(): { place: number; time: number; racers: number } | null {
    return this.finished ? { ...this.finished, racers: this.opponents.length + 1 } : null;
  }
  /** Сумарна сила ударів (м/с різкої зміни швидкості за крок) — пошкодження машини й вантажу. */
  hits = 0;
  /** Пройдено, м. */
  get distance(): number {
    return this.odometer;
  }
  /** Поточна кімната (room_NNN) і її події. */
  get currentRoom(): Room | null {
    return this.room ? (this.track.rooms.get(this.room) ?? null) : null;
  }
  /** Дощ: струмені навколо камери (Foreground_object → RainNode/RainKey) і краплі на склі кабіни (GlassKey). */
  private rain: { root: THREE.Group; setSwitch: (n: string, s: number) => void; tex: { map: THREE.Texture; move: number[] }[] } | null = null;
  raining = false;
  setRain(on: boolean): void {
    this.raining = on;
    if (on && !this.rain) {
      const dyn = this.built.assembler.dynamicObject('Foreground_object');
      if (dyn) {
        const wrap = new THREE.Group();
        dyn.root.rotation.x = -Math.PI / 2;
        wrap.add(dyn.root);
        const tex: { map: THREE.Texture; move: number[] }[] = [];
        wrap.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.frustumCulled = false;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          // Там же відблиски сонця в обʼєктиві (lens0…7) — їх оригінал ставить за сонцем; поки не малюємо.
          if (mat.map?.name.startsWith('txr/lens')) mesh.visible = false;
          else if (mat.map) {
            // Струмені (матеріал rainout: `move 0 -1 noz`): текстура тече вниз — зсув UV за секунду з `move`;
            // `noz` — без перевірки глибини: циліндр навколо камери не обрізається землею (інакше видно коло).
            const def = mat.userData.def as { params: Record<string, number[]>; flags: Set<string> } | null;
            const m = mat.clone();
            m.map = mat.map.clone();
            m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
            m.map.needsUpdate = true;
            // Альфа текстури — 0…0,2 (сірі напівпрозорі риски): змішування, а не поріг alphaTest.
            m.alphaTest = 0;
            m.transparent = true;
            m.depthWrite = false;
            // Без перевірки глибини на всіх трасах: на COUNT це прапорець noz матеріалу, на MOUNT його немає, але
            // Foreground_object — передній план біля глядача (інакше земля обрізає циліндр і видно межу).
            m.depthTest = false;
            m.fog = false;
            // Циліндр дощу видно зсередини.
            m.side = THREE.DoubleSide;
            mesh.material = m;
            mesh.renderOrder = 10;
            tex.push({ map: m.map, move: def?.params.move ?? [0, -1] });
          }
        });
        this.scene.add(wrap);
        this.rain = { root: wrap, setSwitch: dyn.setSwitch, tex };
      }
    }
    // RainKey: група 0 — струмені, група 1 — порожня.
    this.rain?.setSwitch('RainKey', on ? 0 : 1);
    this.applyFog();
    if (this.rain) this.rain.root.visible = on;
    if (this.glassRain) {
      this.glassRain.raining = on;
      this.glassRain.wipersOn = on;
      this.wipersManual = null;
    }
  }
  /** Тестовий режим: погода — дощ і слизька дорога (×0,8 до зчеплення, як у кар'єрі). */
  setWeather(rain: boolean): void {
    this.setRain(rain);
    this.truck.weatherGrip = rain ? 0.8 : 1;
  }
  /** Оригінальні маски води на склі 3D-кабіни: краплі txr/glass_1.msk і сліди glass_2.msk (архів траси). */
  private glassMasks: { drop: RgbaImage | null; runner: RgbaImage | null } = { drop: null, runner: null };
  /** Туман і фон сцени до заїзду (повертаються в dispose). */
  private baseFog: { fog: THREE.Fog | null; bg: THREE.Scene['background'] } | undefined;
  /**
   * Туман: удень без дощу — як до заїзду; під дощем далечінь у димці — ближчий і сіріший; уночі — темний.
   * Фон сцени — колір туману (у проміжках між геометрією й небом), купол неба — у тумані біля обрію (SKY_FOG).
   * Кольори й відстані — гіпотеза (truck.ini: fog=off; оригінальний туман дощу не розібрано).
   */
  private applyFog(): void {
    this.baseFog ??= { fog: this.scene.fog as THREE.Fog | null, bg: this.scene.background };
    const rain = this.raining;
    const night = this.isNight;
    const [color, near, far] = rain ? (night ? NIGHT_RAIN_FOG : RAIN_FOG) : night ? NIGHT_FOG : [0, 0, 0];
    this.scene.fog = rain || night ? new THREE.Fog(color, near, far) : this.baseFog.fog;
    const fog = this.scene.fog as THREE.Fog | null;
    this.scene.background = fog ? fog.color.clone() : this.baseFog.bg;
    SKY_FOG.horizon.value = fog ? (rain ? 1 : 0.85) : 0;
    SKY_FOG.top.value = rain ? (night ? 0.5 : 0.7) : 0;
  }
  /** Краплі на склі кабіни й двірники. */
  /** Краплі на склі й двірники: 3D-кабіна — GlassRain (скло моделі), 2D — Cab2dRain (як в оригіналі). */
  private glassRain: GlassRain | Cab2dRain | null = null;
  /** Вмʼятини кузова: накопичена сила ударів за зонами (FC, FR, R, BR, BC, BL, L, FL). */
  dents: Record<string, number> = {};
  private modelSwitch: ((name: string, state: number) => void) | undefined;
  private modelStates: ((name: string) => number) | undefined;
  /** Фатальна ситуація (вода, прірва — подія 3264). Без обробника — рестарт на точці кімнати. */
  onDeath: (() => void) | null = null;
  /** Кнопка «↺». Без обробника — безкоштовно ставить машину на дорогу (тестовий режим). */
  onResetRequest: (() => void) | null = null;
  /** Машина лежить на боці чи догори колесами. */
  get flipped(): boolean {
    return isFlipped(this.truck);
  }
  /** Одноразовий звук з архіву траси (repair, alarm…). */
  sound(name: string, volume = 1): void {
    this.audio?.play(name, volume);
  }
  /** Той самий звук, але без накладання, поки попередній ще звучить. */
  soundOnce(name: string, volume = 1): void {
    this.audio?.playOnce(name, volume);
  }
  /** Звуки поза двигуном: двигуни суперників (extcar), двірники, грім; пауза між звуками ударів. */
  private oppSounds: (LoopSound | null)[] | null = null;
  private thunderIn = 20;
  private impactCooldown = 0;
  /** Удар: легкий — hit, сильний — один із crash* (гучність за силою). */
  private impactSound(dv: number): void {
    if (!this.audio || this.impactCooldown > 0 || dv < IMPACT_SOUND_MIN) return;
    this.impactCooldown = 0.25;
    if (dv < IMPACT_CRASH) this.audio.play('hit', Math.min(1, dv / IMPACT_CRASH));
    else this.audio.play(CRASH_SOUNDS[Math.floor(Math.random() * CRASH_SOUNDS.length)], Math.min(1, dv / 15));
  }
  /** Гравій: поверхня під машиною — ґрунт (за матеріалом), звук stones ∝ швидкості. */
  private stonesSound: LoopSound | null | undefined;
  private surfaceTimer = 0;
  private offRoad = false;
  private readonly ray = new THREE.Raycaster();
  /** Матеріал поверхні під машиною — промінь у видиму геометрію поточної кімнати (раз на 0,2 с). */
  private updateSurface(dt: number): void {
    if ((this.surfaceTimer -= dt) > 0) return;
    this.surfaceTimer = 0.2;
    const room = this.room ? this.built.rooms.find((r) => r.name === this.room) : null;
    if (!room) return;
    const t = this.truck.body.translation();
    // Промінь з 6 м над тілом: машина, що вже пірнула, теж «бачить» поверхню води над собою.
    this.ray.set(new THREE.Vector3(t.x, t.y + SURFACE_RAY_UP, t.z), new THREE.Vector3(0, -1, 0));
    this.ray.far = SURFACE_RAY_UP + 5;
    this.ray.camera = this.camera; // білборди (тип 28) без камери кидають виняток
    const name = (h: THREE.Intersection) => {
      const m = (h.object as THREE.Mesh).material;
      return (Array.isArray(m) ? m[h.face?.materialIndex ?? 0] : m)?.name ?? '';
    };
    // Стелі тунелів і мости над головою пропускаємо: поверхня — не вище 3 м над тілом (вода — будь-де, бо під нею
    // може опинитися машина, що пірнула).
    const hit = this.ray
      .intersectObject(room, true)
      .find((h) => (h.object as THREE.Mesh).isMesh && (h.distance > SURFACE_RAY_UP - 3 || /water|river/i.test(name(h))));
    // Висота тіла над видимою поверхнею (відʼємна — під нею); без влучання — високо в повітрі.
    this.surfaceHeight = hit ? hit.distance - SURFACE_RAY_UP : Infinity;
    if (!hit) {
      this.overWater = false;
      return;
    }
    const mesh = hit.object as THREE.Mesh;
    const mat = (Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material) as THREE.MeshBasicMaterial;
    this.surface = classifySurface(mat?.name ?? '', texelAt(mat?.map, hit.uv));
    this.offRoad = this.surface === 'gravel' || this.surface === 'dirt';
    this.overWater = this.surface === 'water';
    const [grip, roll] = SURFACE_FX[this.surface];
    // У повітрі (далеко над поверхнею) покриття не діє.
    if (this.surfaceHeight < 2.5) this.truck.setSurface(grip, roll);
  }
  /** Покриття під машиною (за матеріалом і кольором текстури). */
  surface: Surface = 'asphalt';
  private overWater = false;
  private surfaceHeight = Infinity;
  private deathCooldown = 0;
  private noFloorTime = 0;
  /**
   * Подія 3264 («death_NNN») позначає кімнату без форми й висоти: дорога там іде вздовж річки чи над прірвою.
   * Загибель — коли в такій кімнаті машина впала у воду (торкнулася поверхні) або довго падає без підлоги під собою.
   * Перелетіти обрив над водою на швидкості — задум гри: у повітрі під машиною вода, але це не загибель.
   */
  private checkDeath(dt: number): void {
    if ((this.deathCooldown -= dt) > 0) return;
    const room = this.currentRoom;
    if (!room || !room.events.some((e) => e.type === EVENT_DEATH)) return;
    const t = this.truck.body.translation();
    const p = new THREE.Vector3(t.x, t.y, t.z);
    const floor = this.floorHeight(p);
    this.noFloorTime = floor === null ? this.noFloorTime + dt : 0;
    const water = this.overWater && this.surfaceHeight < DROWN_HEIGHT;
    if (!water && this.noFloorTime < FALL_DEATH_TIME) return;
    this.noFloorTime = 0;
    this.deathCooldown = 2;
    this.hits += 10;
    // Утонули — сплеск; прірва — удар.
    this.audio?.play(water || this.isWaterRoom(room.name) ? 'water' : 'crash9', 1);
    if (this.onDeath) return this.onDeath();
    this.truck.reset(this.restartPoint());
    this.prevPos.copy(p);
  }
  /** Кімнати з водою (матеріали water/river) — для звуку падіння у воду. */
  private waterRooms: Set<string> | null = null;
  private isWaterRoom(name: string): boolean {
    if (!this.waterRooms) {
      this.waterRooms = new Set();
      for (const r of this.built.rooms) {
        let wet = false;
        r.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.Material | undefined;
          if (!wet && (o as THREE.Mesh).isMesh && m && /water|river/i.test(m.name)) wet = true;
        });
        if (wet) this.waterRooms.add(r.name);
      }
    }
    return this.waterRooms.has(name);
  }
  private updateSounds(dt: number): void {
    const a = this.audio;
    if (!a) return;
    this.impactCooldown -= dt;
    const kmh = this.truck.speedKmh;
    const gravel = this.offRoad && kmh > 3;
    if (gravel && this.stonesSound === undefined) this.stonesSound = a.loopSound('stones');
    // Гравій — на повну, трава й пісок — тихіше.
    const loud = this.surface === 'gravel' ? 1 : 0.5;
    this.stonesSound?.set(gravel ? loud * Math.min(0.6, kmh / 100) : 0, 0.8 + Math.min(0.6, kmh / 150));
    // Двигуни суперників: тихішають з відстанню, панорама — за положенням відносно камери.
    this.oppSounds ??= this.opponents.map(() => a.loopSound('extcar'));
    const cam = this.camera.position;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    this.opponents.forEach((o, i) => {
      const snd = this.oppSounds![i];
      if (!snd) return;
      const p = o.truck.body.translation();
      const rel = new THREE.Vector3(p.x - cam.x, p.y - cam.y, p.z - cam.z);
      const d = rel.length();
      const vol = d > 150 ? 0 : 0.5 / (1 + (d / 15) ** 2);
      snd.set(vol, Math.min(2, Math.max(0.6, o.truck.rpm / 1500)), d > 0.1 ? rel.dot(right) / d : 0);
    });
    // Грім — зрідка, коли дощ не під дахом (двірники — звук на кожен помах, див. buildCab).
    if (this.raining && this.glassRain?.raining) {
      if ((this.thunderIn -= dt) <= 0) {
        this.thunderIn = 15 + Math.random() * 30;
        a.play('thunder', 0.5 + Math.random() * 0.4);
      }
    }
  }
  /** Вибухи й вогонь. */
  private effects: Effects | null = null;
  /** Машина вибухнула (до відновлення). */
  exploded = false;
  /**
   * Тестовий режим: вибух, коли сила ударів сягне WRECK_HITS (як техстан 0 у кар'єрі), і за 4 с — знову на дорогу.
   * Кар'єра вимикає й вирішує сама (за станом «машина»).
   */
  autoWreck = true;
  /** Вибух машини гравця: кадри explosion, вогонь на уламках, звук explos; кузов — найбільші вмʼятини. */
  explode(): void {
    if (this.exploded) return;
    this.exploded = true;
    const t = this.truck.body.translation();
    this.effects?.explode(new THREE.Vector3(t.x, t.y, t.z), this.truck.visual);
    this.audio?.play('explos', 1);
    this.applyDents(Object.fromEntries(DENT_ZONES.map((z) => [z, 999])));
    this.truck.setDamage({ power: 0, lostGears: 0, brakes: 1 });
  }
  /** Рухомі предмети траси (ящики, блоки — AnmObj). */
  private movables: Movables | null = null;
  /** Навігаційна система (НС): мінікарта з суперниками. */
  private navMap: NavMap | null = null;
  /** Навігація дозволена (тест або встановлено «НС»): Tab ховає й показує карту. */
  private mapAllowed = false;
  showMap(on: boolean): void {
    this.mapAllowed = on;
    if (on && !this.navMap) {
      this.wayNet ??= new WayNet(this.built.assembler.b3d);
      const parent = this.hud?.parentElement;
      if (parent && this.wayNet.lines.length) this.navMap = new NavMap(parent, this.wayNet);
    } else if (!on && this.navMap) {
      this.navMap.dispose();
      this.navMap = null;
    }
  }
  /** Нічна траса: фари світять на дорогу (задає main за локацією). */
  private isNight = false;
  get night(): boolean {
    return this.isNight;
  }
  set night(on: boolean) {
    this.isNight = on;
    this.applyFog();
  }
  private lights: TruckLights | null = null;
  /** Відблиски ліхтарів на дорозі — власні, у формі ліхтарів (див. WetReflections; оригінальні білборди сховані). */
  private readonly wetReflections: WetReflections[] = [];
  /** Власне освітлення світу фарами гравця (в оригіналі немає; див. render/headlights.ts). */
  private headlightsFx: Headlights | null = null;
  /**
   * Фари гравця вручну (L): null — самі вночі й на дощовій трасі (зокрема в тунелях, де не капає); на сухій денній
   * трасі за замовчуванням вимкнені.
   */
  private lightsOverride: boolean | null = null;
  private get headlights(): boolean {
    return this.lightsOverride ?? (this.night || this.raining);
  }
  /** Машина під дахом — у кімнаті з подією 4 «tunnel_rain» (тунелі). */
  private get sheltered(): boolean {
    return this.currentRoom?.events.some((e) => e.type === EVENT_RAIN) ?? false;
  }
  private updateLights(state: { throttle: number; brake: number }): void {
    const wet = this.raining && (this.glassRain?.raining ?? true);
    const reverse = this.truck.gear < 0;
    this.lights?.update(this.headlights, false, reverse ? state.throttle > 0 : state.brake > 0, reverse);
    for (const o of this.opponents) o.lights?.update(this.night, wet, o.pilot.state.brake > 0, o.truck.gear < 0);
  }
  /** Кермування нахилом телефона (дозвіл на iOS — в «Опціях» або на першому дотику, див. Input.toggleTilt). */
  setTilt(on: boolean): void {
    if (on !== this.input.tiltEnabled) void this.input.toggleTilt();
  }
  /** Швидкість машини гравця, км/год. */
  get speedKmh(): number {
    return this.truck.speedKmh;
  }
  /** Вплив пошкоджень на машину гравця (див. damageEffects). */
  setDamage(d: { power: number; lostGears: number; brakes: number }): void {
    this.truck.setDamage(d);
  }
  /** Поставити машину на дорогу (рестарт у поточній кімнаті). */
  recover(): void {
    this.truck.reset(this.restartPoint());
  }
  /** Вмʼятини з попередніх заїздів (до ремонту). */
  applyDents(d: Record<string, number> | undefined): void {
    this.dents = { ...(d ?? {}) };
    for (const zone of DENT_ZONES) this.updateDent(zone);
  }
  private updateDent(zone: string): void {
    const name = `Damage${zone}Key`;
    const n = this.modelStates?.(name) ?? 0;
    if (!n) return;
    // Остання група деяких перемикачів порожня (деталь відпала) — до неї доходимо лише після дуже сильних ударів.
    const acc = this.dents[zone] ?? 0;
    const level = DENT_STEPS.filter((s) => acc >= s).length;
    this.modelSwitch?.(name, Math.min(n - 1, level));
  }
  /** Вʼїзд у нову кімнату (події залів бази, тунелі) і фініш — для кар'єри. */
  onRoomEnter: ((room: Room) => void) | null = null;
  onFinish: ((r: { place: number; time: number; racers: number }) => void) | null = null;
  /** Контрольні точки (подія 7, параметр — номер), які треба проїхати до фінішу маршруту. */
  private checkpoints = new Set<number>();
  private passed = new Set<number>();
  private col!: LevelCollision;
  /** Колайдери підлоги й стін кожної кімнати: увімкнені лише кімнати з машинами та їхні сусіди (як в оригіналі). */
  private readonly roomColliders = new Map<string, RAPIER.Collider[]>();
  private activeRooms = '';
  private roomVis: RoomVisibility | null = null;
  /** Кімнати суперників (для колізій) — оновлюються разом із кімнатою гравця. */
  private readonly opponentRooms: (string | null)[] = [];
  private locateTimer = 0;
  private readonly prevVel = new THREE.Vector3();
  private raceStart: number | null = null;
  /** Автопілот (клавіша P): їде по лініях way_* — для тестів і як основа суперників. */
  autopilot: AutoPilot | null = null;
  private wayNet: WayNet | null = null;

  private constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly built: BuiltScene,
    readonly def: TruckDef,
  ) {}

  static async start(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    built: BuiltScene,
    def: TruckDef,
    overlay: HTMLElement,
    rmp?: RmpArchive,
    rivals: TruckDef[] = [],
    raceKind: 'laps' | 'route' | 'free' = 'laps',
    setup: TruckSetup = {},
  ): Promise<DriveSession> {
    await initRapier();
    const s = new DriveSession(scene, camera, built, def);
    s.raceKind = raceKind;
    s.lapsToFinish = raceKind === 'laps' ? 3 : raceKind === 'route' ? 1 : 0;
    if (raceKind === 'free') s.countdown = 0;
    s.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    s.world.timestep = 1 / 60;
    // Колізії як в оригіналі — з обʼєктів hit_road/hit_obj; видима геометрія — лише запасний варіант.
    const col = levelCollision(built.assembler.b3d);
    s.col = col;
    s.track = new Track(built.assembler.b3d);
    // Проходи між кімнатами — без огорож сусідніх кімнат (портали в системі гри: x, y = −z Three.js).
    openPortals(col, [...s.track.rooms.values()].flatMap((r) => r.portals.filter((p) => !isHorizontalPortal(p)).map((p) => ({ a: [p.a.x, -p.a.z] as [number, number], b: [p.b.x, -p.b.z] as [number, number] }))));
    // Колізії — окремо для кожної кімнати: геометрія сусідніх кімнат перетинається в просторі
    // (тунель траси крізь зал бази), а оригінал перевіряє зіткнення лише з кімнатою машини.
    const byRoom = (polys: number[][][], rooms: string[]) => {
      const m = new Map<string, number[][][]>();
      polys.forEach((p, i) => (m.get(rooms[i]) ?? m.set(rooms[i], []).get(rooms[i])!).push(p));
      return m;
    };
    const addRoom = (room: string, c: RAPIER.Collider | null) => {
      if (c) (s.roomColliders.get(room) ?? s.roomColliders.set(room, []).get(room)!).push(c);
    };
    if (col.hasFloor) for (const [room, polys] of byRoom(col.floors, col.floorRoom)) addRoom(room, addCollisionPolys(s.world, polys, 1.0));
    else addStaticMeshes(s.world, built.root);
    for (const [room, polys] of byRoom(col.walls, col.wallRoom)) addRoom(room, addCollisionPolys(s.world, polys, 0.4));
    // Нижче найнижчої підлоги — випали за межі колізій (напр. тунелі бази до трас): рестарт.
    if (col.hasFloor) {
      let minZ = Infinity;
      for (const p of col.floors) for (const q of p) minZ = Math.min(minZ, q[2]);
      s.fallY = minZ - 15;
    }
    s.world.step(); // колайдери потрапляють у структури запитів (castRay) лише після кроку
    s.movables = new Movables(s.world, built.assembler.b3d, built.rooms);
    s.effects = new Effects(built.assembler, scene);

    const model = buildTruckModel(built.assembler, def, true);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня в цій локації`);
    s.modelSwitch = model.setSwitch;
    s.modelStates = model.switchStates;
    s.spawn = s.findSpawn();
    // База: на прохання користувача — трохи далі від тунелів, ніж Observer оригіналу, щоб було видно вказівники
    // «Погрузка» й «Запчасти» і зручно повернути.
    if (raceKind === 'free') s.spawn.position = s.groundAt(s.spawn.position.clone().addScaledVector(s.spawn.forward, -BASE_SPAWN_BACK).setY(s.spawn.position.y - 2.5));
    s.room = s.locate(s.spawn.position) ?? s.track.guessRoom(s.spawn.position);
    s.prevPos.copy(s.spawn.position);
    for (const r of s.track.rooms.values()) for (const e of r.events) if (e.type === EVENT_CHECKPOINT) s.checkpoints.add(e.param);
    s.truck = new TruckVehicle(s.world, def, model, s.spawn, setup);
    s.lights = new TruckLights(model.setSwitch, s.truck.visual, s.truck.lightGeometry);
    hideLampReflections(model.root);
    s.wetReflections.push(new WetReflections(model.root, () => s.truck.groundHeight(), (x, y, z) => s.roadBelow(x, y, z), (x, y, z) => s.glossAt(x, y, z), (f, t) => s.lampSeen(f, t)));
    scene.add(s.truck.visual);
    s.spawnOpponents(rivals);
    s.headlightsFx = new Headlights(s.truck.visual, model.root);
    litByHeadlights(scene);
    s.roomVis = new RoomVisibility(s.track, built.rooms);
    s.updateOpponentRooms();
    s.updateActiveRooms();

    // Очі водія: OV з [TECHn] (система вантажівки), як в оригіналі; вид з кабіни — за замовчуванням.
    s.cockpit = g2t(def.tech.viewer);
    s.cockpit.y += setup?.seatRaise ?? 0;
    // Оригінальні маски води на склі 3D-кабіни (MS16 із прозорістю): краплі й сліди.
    const glassMask = (n: string) => {
      const b = rmp?.masks.get(n);
      return b ? parseMsk(b, built.assembler.lib.palette ?? undefined) : null;
    };
    s.glassMasks = { drop: glassMask('txr/glass_1.msk'), runner: glassMask('txr/glass_2.msk') };
    s.buildCab();
    s.camMode = 'cockpit';

    if (rmp) s.audio = await EngineAudio.create(rmp).catch(() => null);
    s.input.onCommand = (cmd) => {
      if (cmd === 'horn') s.audio?.playOnce('horn');
      if (cmd === 'autopilot') s.toggleAutopilot();
      if (cmd === 'tilt')
        void s.input.toggleTilt().then((on) => s.touchUi?.querySelector('.tilt')?.classList.toggle('pressed', on));
      if (cmd === 'reset') {
        if (s.onResetRequest) s.onResetRequest();
        else s.recover();
      }
      if (cmd === 'camera') s.cameraMode = NEXT_CAM[s.camMode];
      if (cmd === 'lights') s.lightsOverride = !s.headlights;
      if (cmd === 'map' && s.mapAllowed && s.navMap) s.navMap.el.hidden = !s.navMap.el.hidden;
      else if (cmd === 'map' && !s.mapAllowed) toast('Навігаційної системи немає');
      if (cmd === 'engine') s.toggleEngine();
      if (cmd === 'wipers') s.toggleWipers();
      if (cmd === 'mirror') s.toggleMirror();
      if (cmd === 'cab') s.onSettingsCommand?.('cab');
      if (cmd === 'swap') s.onSettingsCommand?.('swap');
    };
    s.overlayEl = overlay;
    s.touchUi = s.input.mountTouch(overlay);
    // Не гасити екран під час їзди (Screen Wake Lock, де підтримується).
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    wl?.request('screen').then((l) => (s.wakeLock = l)).catch(() => {});
    s.hud = document.createElement('div');
    s.hud.className = 'drive-hud';
    overlay.append(s.hud);
    // Світ: ближня площина 1 м — точніший буфер глибини (з 0,1 м далекі поверхні мерехтіли, «бʼючись»
    // одна з одною). Кабіна малюється окремим проходом зі своєю ближньою площиною (renderOverlay).
    camera.near = 1;
    camera.far = 3000;
    camera.updateProjectionMatrix();
    s.camPos.copy(s.spawn.position).addScaledVector(s.spawn.forward, -14).add(new THREE.Vector3(0, 6, 0));
    return s;
  }

  /**
   * Точка старту: найближча до простору Observer точка ліній доріг (блоки 20 «way_*»),
   * напрям — уздовж лінії. Висота — променем до поверхні.
   */
  private findSpawn(): { position: THREE.Vector3; forward: THREE.Vector3 } {
    const obs = this.built.assembler.block('Observer');
    let pos = new THREE.Vector3();
    let fwd = new THREE.Vector3(0, 0, -1);
    if (obs && obs.data.t === 24) {
      pos = g2t(obs.data.position);
      fwd = g2t(obs.data.matrix[1]).setY(0).normalize();
    } else {
      // Без Observer (COUNT, MOUNT — маршрути з бази): старт — точка рестарту першої кімнати маршруту room_001
      // (кімнати пронумеровано від початку до фінішу room_999).
      const first = this.track.rooms.get('room_001')?.restart;
      if (first) return { position: this.groundAt(first.position), forward: first.forward.clone() };
      new THREE.Box3().setFromObject(this.built.root).getCenter(pos);
    }
    let best = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestDir: THREE.Vector3 | null = null;
    for (const [blk] of walk(this.built.assembler.b3d.blocks)) {
      if (blk.data.t !== 20 || !blk.name.toLowerCase().startsWith('way')) continue;
      const pts = blk.data.points.map((p) => g2t(p));
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = pts[i].distanceTo(pos);
        if (d < best) {
          best = d;
          bestPos = pts[i].clone().lerp(pts[i + 1], 0.5);
          bestDir = pts[i + 1].clone().sub(pts[i]).setY(0).normalize();
        }
      }
    }
    if (bestPos && bestDir) {
      // Напрям лінії обираємо ближчим до погляду Observer.
      if (bestDir.dot(fwd) < 0) bestDir.negate();
      return { position: this.groundAt(bestPos), forward: bestDir };
    }
    // Немає доріг (напр. полігон TRIAL) — найближча точка рестарту.
    const room = this.track.guessRoom(pos);
    const r = room ? this.track.rooms.get(room)?.restart : null;
    if (r) return { position: this.groundAt(r.position), forward: r.forward.clone() };
    return { position: this.groundAt(pos), forward: fwd };
  }

  /** Поверхня під точкою: спершу трохи вище точки (закриті приміщення — база), потім згори. */
  private groundAt(p: THREE.Vector3): THREE.Vector3 {
    for (const up of [4, 200]) {
      const hit = this.world.castRay(new RAPIER.Ray({ x: p.x, y: p.y + up, z: p.z }, { x: 0, y: -1, z: 0 }), 1000, true);
      if (hit) return new THREE.Vector3(p.x, p.y + up - hit.timeOfImpact + 2.5, p.z);
    }
    return new THREE.Vector3(p.x, p.y + 2.5, p.z);
  }

  // --- Налагодження (ht.dev, див. web/src/dev/devTools.ts) ---

  /** Камера: позаду / з кабіни / здалеку. */
  get cameraMode(): CamMode {
    return this.camMode;
  }
  set cameraMode(mode: CamMode) {
    this.camMode = mode;
    // Кабіна й вид від першої особи — різні моделі (кабіна машини / спільні прилади Panel): перебудовуємо.
    if ((mode === 'cockpit' && this.panelMode) || (mode === 'first' && !this.panelMode)) this.rebuildCab(mode === 'first');
  }
  /** Без відліку світлофора (одразу «зелений»). */
  skipCountdown(): void {
    if (this.countdown > 0) {
      this.countdown = 0;
      this.raceStart = this.clock;
    }
  }
  /** Машина гравця. */
  get playerTruck(): TruckVehicle {
    return this.truck;
  }
  /** Поточна кімната машини гравця. */
  get roomName(): string | null {
    return this.room;
  }
  /** Чи увімкнено автопілот. */
  get autopilotOn(): boolean {
    return !!this.autopilot;
  }
  /**
   * Перенести машину гравця: у точку рестарту кімнати (`room_011`) або в точку (x, z) Three.js на дорогу з
   * напрямком heading (рад, 0 — уздовж −z). Повертає false, якщо кімнати немає.
   */
  teleport(target: string | { x: number; z: number; heading?: number }): boolean {
    // Колізії ввімкнені лише біля машин: спершу кімната (і крок світу — оновити структури запитів castRay),
    // потім висота дороги; інакше машина провалювалась крізь світ.
    const activate = (room: string | null) => {
      if (room) this.room = room;
      this.updateActiveRooms();
      this.world.step();
    };
    if (typeof target === 'string') {
      const r = this.track.rooms.get(target)?.restart;
      if (!r) return false;
      activate(target);
      this.truck.reset({ position: this.groundAt(r.position), forward: r.forward.clone() });
      return true;
    }
    // Довільна точка: висота невідома — на мить вмикаємо колізії всієї траси й шукаємо дорогу згори.
    const h = target.heading ?? 0;
    for (const cs of this.roomColliders.values()) for (const c of cs) c.setEnabled(true);
    this.activeRooms = '*';
    this.world.step();
    const p = this.groundAt(new THREE.Vector3(target.x, 500, target.z));
    activate(this.locate(p) ?? this.track.guessRoom(p));
    this.truck.reset({ position: p, forward: new THREE.Vector3(-Math.sin(h), 0, -Math.cos(h)) });
    return true;
  }

  /** Рестарт як в оригіналі: точка рестарту поточної кімнати (подія 11), інакше — на місці. */
  private restartPoint() {
    const r = this.room ? this.track.rooms.get(this.room)?.restart : null;
    if (r) return { position: this.groundAt(r.position), forward: r.forward.clone() };
    return this.spawnAtTruck();
  }

  /** Скидання на місці (поставити на колеса). */
  private spawnAtTruck() {
    const t = this.truck.body.translation();
    return { position: this.groundAt(new THREE.Vector3(t.x, t.y, t.z)), forward: this.truck.forward() };
  }

  /**
   * Вид з кабіни: кабіна `<Prefix>Cab` у системі «очей водія» (y — уперед, z — угору) з кермом і стрілками, або —
   * вид від першої особи (panel) — спільні для всіх машин прилади `Panel` без кабіни (в оригіналі — один з видів
   * клавіші C; HTruck.exe 0x4e8ddc), вужче поле зору (піраміда 1.6×1.2, 0x4851ac). Прилади закріплені в кадрі
   * внизу по центру (як рушій їх розміщує, не розібрано — гіпотеза).
   */
  private buildCab(panel = false): void {
    if (!panel && this.cabStyleNow === '2d' && this.cab2dLoader) {
      this.panelMode = false;
      void this.build2dCab();
      return;
    }
    const dyn = panel ? this.built.assembler.dynamicObject('Panel') : this.built.assembler.dynamicObject(`${this.def.prefix}Cab`);
    if (!dyn) return;
    this.panelMode = panel;
    this.cabSwitch = dyn.setSwitch;
    const inner = dyn.root;
    inner.rotation.x = -Math.PI / 2;
    this.cab = new THREE.Group();
    this.cab.add(inner);
    this.overlayScene.add(this.cab);
    if (panel) {
      // Площина панелі — на відстані y від ока; нижній край — на нижньому краю кадру. На телефоні прилади
      // збільшені (на прохання користувача: інакше дрібні) — масштаб у площині панелі, глибина та сама.
      const k = matchMedia('(pointer: coarse)').matches ? PANEL_TOUCH_SCALE : 1;
      inner.scale.set(k, 1, k);
      inner.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(inner);
      const depth = -box.min.z;
      inner.position.y = -depth * Math.tan(THREE.MathUtils.degToRad(PANEL_FOV / 2)) - box.min.y;
    }
    // Деталі шукаємо за простором (імена стрілок у різних кабінах різняться: ZilStr1, FreiCabStr1…; у панелі —
    // без префікса).
    const prefix = panel ? '' : this.def.prefix;
    const bySpace = (sp: string) => {
      let found: THREE.Object3D | undefined;
      inner.traverse((o) => {
        if (!found && o.userData.space === `${prefix}${sp}`.toLowerCase()) found = o;
      });
      return found;
    };
    this.cabParts = { rule: bySpace('RuleSpace'), tacho: bySpace('TachoSpace'), speed: bySpace('SpeedSpace') };
    // Цифри одометра (KMeter*Key) і табло передач (GearKey, A — AvtoKey, P — ParkKey) — змішування замість порогу
    // alphaTest 0,5: поріг спотворював контури й лишав зубці.
    inner.traverse((o) => {
      if (!/^(KMeter\d|Gear|Avto|Park)Key#/.test(o.name)) return;
      o.traverse((g) => {
        const mesh = g as THREE.Mesh;
        if (!mesh.material) return;
        mesh.material = ([] as THREE.Material[]).concat(mesh.material).map((mat) => {
          const m = mat.clone();
          m.alphaTest = 0;
          m.transparent = true;
          m.depthWrite = false;
          return m;
        });
        if ((mesh.material as THREE.Material[]).length === 1) mesh.material = (mesh.material as THREE.Material[])[0];
      });
    });
    // Скло (GlassKey, група 1) показуємо завжди: його текстуру — краплі — малює GlassRain, суха — прозора.
    if (!panel) {
      dyn.setSwitch('GlassKey', 1);
      this.glassRain = new GlassRain(inner, this.glassMasks.drop, this.glassMasks.runner);
      this.glassRain.onStroke = () => this.audio?.play('wipers', 0.9);
      this.glassRain.raining = this.raining;
      this.glassRain.wipersOn = this.wipersManual ?? this.raining;
    }
    // Кермо частково «втоплене» в панель: оригінал малює його після кабіни, поверх неї.
    // Відтворюємо це окремим шаром, який рендериться після очищення глибини.
    this.cabParts.rule?.traverse((o) => o.layers.set(CAB_TOP_LAYER));
    // Стрілки лежать у площині циферблата — з перевіркою глибини їх перекриває шкала. Малюємо їх після
    // кабіни без перевірки глибини (кермо — окремим проходом, тож воно й далі закриває стрілки).
    for (const needle of [this.cabParts.tacho, this.cabParts.speed]) {
      needle?.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.material = (m.material as THREE.Material).clone();
        (m.material as THREE.Material).depthTest = false;
        m.renderOrder = 10;
      });
    }
  }

  /** Другий прохід кадру: кабіна поверх світу, потім кермо поверх кабіни. */
  renderOverlay(renderer: THREE.WebGLRenderer, camera: THREE.Camera): void {
    const autoClear = renderer.autoClear;
    const mask = camera.layers.mask;
    const cam = camera as THREE.PerspectiveCamera;
    const near = cam.near;
    cam.near = 0.05;
    cam.updateProjectionMatrix();
    renderer.autoClear = false;
    renderer.clearDepth();
    // Вода на склі 3D-кабіни: зміни — на відеокарту, копія кадру зі світом для заломлення (до кабіни).
    if (this.glassRain instanceof GlassRain && this.cab?.visible) this.glassRain.prepare(renderer);
    renderer.render(this.overlayScene, camera);
    if (this.cabParts.rule && this.cab?.visible) {
      renderer.clearDepth();
      camera.layers.set(CAB_TOP_LAYER);
      renderer.render(this.overlayScene, camera);
      camera.layers.mask = mask;
    }
    if (this.cab2d && this.camMode === 'cockpit') this.cab2d.render(renderer);
    renderer.autoClear = autoClear;
    cam.near = near;
    cam.updateProjectionMatrix();
    if (this.mirrorOn && (this.camMode === 'cockpit' || this.camMode === 'first')) this.renderMirror(renderer);
    else if (this.mirror) this.mirror.frame.hidden = true;
  }

  /** Дзеркало заднього огляду (M): віконце вгорі по центру з видом назад, віддзеркаленим (як у дзеркалі). */
  mirrorOn = false;
  private mirror: {
    rt: THREE.WebGLRenderTarget;
    cam: THREE.PerspectiveCamera;
    scene: THREE.Scene;
    ortho: THREE.OrthographicCamera;
    material: THREE.MeshBasicMaterial;
    frame: HTMLElement;
  } | null = null;

  private renderMirror(renderer: THREE.WebGLRenderer): void {
    const size = renderer.getSize(new THREE.Vector2());
    // У 2D-кабіні — у чорне вікно на панелі (як на знімку оригіналу), інакше — віконце вгорі по центру.
    const inPanel = this.camMode === 'cockpit' ? (this.cab2d?.mirrorOnScreen() ?? null) : null;
    const w = Math.round(inPanel ? inPanel.w : Math.min(size.x * MIRROR_WIDTH, 420));
    const h = Math.round(inPanel ? inPanel.h : w / MIRROR_ASPECT);
    const x = Math.round(inPanel ? inPanel.x : (size.x - w) / 2);
    const top = Math.round(inPanel ? inPanel.y : (this.hud?.getBoundingClientRect().bottom ?? 0) + 6);
    const ratio = renderer.getPixelRatio();
    if (!this.mirror) {
      const rt = new THREE.WebGLRenderTarget(1, 1, { colorSpace: THREE.SRGBColorSpace });
      const material = new THREE.MeshBasicMaterial({ map: rt.texture, depthTest: false, depthWrite: false });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
      // Дзеркало: ліве й праве міняються місцями.
      quad.scale.x = -1;
      const scene = new THREE.Scene();
      scene.add(quad);
      const frame = document.createElement('div');
      frame.className = 'mirror-frame';
      this.hud?.parentElement?.append(frame);
      this.mirror = { rt, cam: new THREE.PerspectiveCamera(MIRROR_FOV, MIRROR_ASPECT, 1, this.camera.far), scene, ortho: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), material, frame };
    }
    const m = this.mirror;
    m.cam.aspect = w / h;
    m.cam.updateProjectionMatrix();
    if (m.rt.width !== Math.round(w * ratio) || m.rt.height !== Math.round(h * ratio)) m.rt.setSize(Math.round(w * ratio), Math.round(h * ratio));
    // Погляд назад з місця водія: орієнтація машини, розвернута на 180° навколо вертикалі.
    m.cam.position.copy(this.camera.position);
    m.cam.quaternion.copy(this.truck.visual.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    m.cam.updateMatrixWorld();
    // Кімнати позаду — видимість за камерою дзеркала (кадр головної камери вже намальовано; наступний кадр
    // перерахує видимість для неї).
    this.roomVis?.update(m.cam, this.room);
    renderer.setRenderTarget(m.rt);
    renderer.clear();
    renderer.render(this.scene, m.cam);
    renderer.setRenderTarget(null);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setScissor(x, size.y - top - h, w, h);
    renderer.setViewport(x, size.y - top - h, w, h);
    renderer.render(m.scene, m.ortho);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = autoClear;
    Object.assign(m.frame.style, { left: `${x - 1}px`, top: `${top - 1}px`, width: `${w}px`, height: `${h}px` });
    m.frame.hidden = !!inPanel;
  }

  /** Підсвітка кнопок групи «ще» за станом (лише коли змінився). */
  private togglesKey = '';
  private syncToggles(): void {
    const st = [this.headlights, this.mirrorOn, !!this.navMap && !this.navMap.el.hidden, this.glassRain?.wipersOn ?? false, this.truck.engineOn, this.mapAllowed, !!this.glassRain];
    const key = st.map(Number).join('') + this.cabStyleNow;
    if (key === this.togglesKey) return;
    this.togglesKey = key;
    const [lights, mirror, map, wipers, engine, mapAllowed, glass] = st;
    this.input.setToggle('lights', lights);
    this.input.setToggle('mirror', mirror);
    this.input.setToggle('map', map, false, !mapAllowed);
    this.input.setToggle('wipers', wipers, !glass);
    this.input.setToggle('engine', engine);
    this.input.setToggle('cab', this.cabStyleNow === '2d');
  }

  toggleMirror(): void {
    this.mirrorOn = !this.mirrorOn;
  }

  /** Зараз побудовані прилади Panel (вид від першої особи), а не кабіна (див. buildCab). */
  private panelMode = false;

  /** Налаштування з групи «ще» (кабіна 2D/3D, поміняти місцями керування) — зберігає й застосовує main.ts. */
  onSettingsCommand: ((cmd: 'cab' | 'swap') => void) | null = null;
  get cabStyleCurrent(): CabStyle {
    return this.cabStyleNow;
  }

  /** Кабіна: 3D-модель чи 2D-растр panel_mask («Опції»). */
  setCabStyle(style: CabStyle): void {
    if (style === this.cabStyleNow) return;
    this.cabStyleNow = style;
    this.rebuildCab(this.panelMode);
  }
  private cabStyleNow: CabStyle = cabStyle();

  /** Джерело масок 2D-кабіни за іменами (main.ts: файли гри, див. assets/cab2d.ts); без нього — лише 3D. */
  private cab2dLoader: ((names: string[], raw?: boolean) => Promise<Map<string, Msk> | null>) | null = null;
  setCab2dLoader(load: (names: string[], raw?: boolean) => Promise<Map<string, Msk> | null>): void {
    this.cab2dLoader = load;
    if (this.cabStyleNow === '2d' && !this.panelMode) this.rebuildCab(false);
  }

  /** Текстура лопатей двірників 2D-кабіни (txrlash.txr програмного набору, main.ts). */
  private wiperTextureLoader: (() => Promise<RgbaImage | null>) | null = null;
  setWiperTextureLoader(load: () => Promise<RgbaImage | null>): void {
    this.wiperTextureLoader = load;
  }

  /** Шар інтерфейсу заїзду (кнопки, табло) — сюди ж смуги дощу 2D-режиму, під кнопки. */
  private overlayEl: HTMLElement | null = null;
  /**
   * Смуги дощу rain.msk для зовнішніх камер у режимі 2D-кабіни (render/cab2dRain.ts). Живуть, доки обрано
   * 2D-кабіну (поза кабіною сама 2D-кабіна розібрана); undefined — ще не вантажили.
   */
  private streaks: RainStreaks | null | undefined = undefined;
  private updateStreaks(dt: number, on: boolean): void {
    if (this.cabStyleNow !== '2d') {
      this.streaks?.el.remove();
      this.streaks = undefined;
      return;
    }
    if (this.streaks === undefined && this.cab2dLoader) {
      this.streaks = null;
      void this.cab2dLoader(['rain.msk']).then((m) => {
        const img = m?.get('rain.msk');
        if (!img || !this.overlayEl || this.cabStyleNow !== '2d' || this.streaks !== null) return;
        this.streaks = new RainStreaks(img);
        this.overlayEl.prepend(this.streaks.el);
      });
    }
    this.streaks?.update(dt, on);
  }

  /** 2D-кабіна: растр panel_mask поверх світу (прозоре — вікна) з приладами й кермом (render/cab2d.ts). */
  private cab2d: Cab2d | null = null;
  /** Номер запиту маски: застарілі (кабіну вже перебудовано) відкидаємо. */
  private cab2dToken = 0;

  private async build2dCab(): Promise<void> {
    const token = ++this.cab2dToken;
    const panel = this.def.panelMask.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
    const masks = await this.cab2dLoader!([panel, ...CAB2D_PARTS]).catch(() => null);
    if (token !== this.cab2dToken) return;
    if (!masks) {
      // Гру імпортовано до появи 2D-кабіни — масок на пристрої немає.
      toast('2D-кабіна недоступна: повторно імпортуйте файли гри (або відкрийте гру з ПК). Поки що — 3D-кабіна.');
      this.cabStyleNow = '3d';
      this.rebuildCab(false);
      return;
    }
    this.cab2d = new Cab2d(masks.get(panel)!, new Map([...masks].filter(([n]) => n !== panel)));
    // Дощ і двірники 2D-кабіни (як в оригіналі). Маски крапель — окремо й без палітри (рівні прозорості): на
    // пристрої, імпортованому до цього, їх немає — тоді двірники ходять, але крапель не буде (повторний імпорт додасть).
    const drops = await this.cab2dLoader!(['drop7.msk', 'drop10.msk'], true).catch(() => null);
    const blade = (await this.wiperTextureLoader?.().catch(() => null)) ?? null;
    const streaks = await this.cab2dLoader!(['rain.msk']).catch(() => null);
    if (token !== this.cab2dToken || !this.cab2d) return;
    if ((!drops || !blade || !streaks) && !rainHintShown) {
      rainHintShown = true;
      toast('Дощ і двірники 2D-кабіни: файли гри імпортовано раніше — повторіть імпорт ZIP в «Опціях».');
    }
    const rain = new Cab2dRain(drops?.get('drop7.msk') ?? null, drops?.get('drop10.msk') ?? null, blade, streaks?.get('rain.msk') ?? null);
    rain.onStroke = () => this.audio?.play('wipers', 0.9);
    rain.raining = this.raining;
    rain.wipersOn = this.wipersManual ?? this.raining;
    this.cab2d.attach(rain.root);
    this.cab2d.beforeDraw = (r, px) => rain.prepare(r, px);
    this.glassRain = rain;
  }

  private drop2dCab(): void {
    this.cab2dToken++;
    if (this.glassRain instanceof Cab2dRain) {
      this.glassRain.dispose();
      this.glassRain = null;
    }
    this.cab2d?.dispose();
    this.cab2d = null;
  }

  private rebuildCab(panel: boolean): void {
    this.drop2dCab();
    if (this.cab) this.overlayScene.remove(this.cab);
    this.cab = null;
    this.cabSwitch = null;
    this.cabParts = {};
    this.glassRain?.dispose();
    this.glassRain = null;
    this.buildCab(panel);
    if (this.hudFonts) this.setHudFonts(...this.hudFonts);
  }

  private updateCab(state: { steer: number }): void {
    // З кабіни зовнішній корпус власної вантажівки не малюємо (як в оригіналі).
    const inside = this.camMode === 'cockpit' || this.camMode === 'first';
    this.truck.visual.visible = !inside || (!this.cab && !this.cab2d && this.cabStyleNow !== '2d');
    if (!this.cab) return;
    this.cab.visible = inside;
    if (!this.cab.visible) return;
    this.cab.position.copy(this.camera.position);
    // Кабіна — разом із машиною (погляд з інерцією повертається в ній), панель — нерухомо в кадрі.
    this.cab.quaternion.copy(this.panelMode ? this.camera.quaternion : this.cabQuat);
    const rot = (o: THREE.Object3D | undefined, axis: THREE.Vector3, angle: number, scale = 1) => {
      if (!o) return;
      o.matrix.copy(o.userData.baseMatrix as THREE.Matrix4).multiply(new THREE.Matrix4().makeRotationAxis(axis, angle));
      // Стрілка лежить уздовж x від осі обертання: довжина — × scale, ширина — помірніше.
      if (scale !== 1) o.matrix.multiply(new THREE.Matrix4().makeScale(scale, 1, Math.sqrt(scale)));
    };
    const deg = Math.PI / 180;
    rot(this.cabParts.rule, new THREE.Vector3(0, 0, 1), -state.steer * 2.4);
    // Кут стрілки = значення × коефіцієнт (0x48f950). Шкали — TachScale/SpeedScale з [NODESn] TRUCK.TCH:
    // «значення кінця шкали, кут» (ЗіЛ: 50 об/с і 160 км/год → 240°).
    const needle = (v: number, [max, angle]: [number, number]) => (Math.min(Math.max(v, 0), max * 1.05) / max) * angle * deg;
    const [speedSize, tachSize] = NEEDLE_SCALE[this.def.carNode.toLowerCase()] ?? [1, 1];
    rot(this.cabParts.tacho, new THREE.Vector3(0, 1, 0), needle(this.truck.rpm / 60, this.def.tachScale), tachSize);
    rot(this.cabParts.speed, new THREE.Vector3(0, 1, 0), needle(this.truck.speedKmh, this.def.speedScale), speedSize);
    // Табло: A — автоматична КПП, P — ручник, передача; одометр — 5 розрядів (KMeter0Key — молодший).
    const sw = this.cabSwitch;
    if (sw) {
      sw('AvtoKey', 1);
      sw('ParkKey', this.handbrakeOn ? 1 : 0);
      // Стани GearKey — нумерація передач оригіналу: 0 — R, 1 — N, 2 — перша…
      sw('GearKey', Math.max(0, Math.min(9, this.truck.gear + 1)));
      const tens = Math.floor(this.odometer / 10);
      for (let i = 0; i < 5; i++) sw(`KMeter${i}Key`, Math.floor(tens / 10 ** i) % 10);
    }
  }

  private handbrakeOn = false;

  /** Суперники на стартовій решітці попереду гравця, з різною крейсерською швидкістю. */
  private spawnOpponents(defs: TruckDef[]): void {
    if (!defs.length) return;
    this.wayNet ??= new WayNet(this.built.assembler.b3d);
    const start = this.wayNet.nearest(this.spawn.position, this.spawn.forward);
    if (!start) return;
    this.route = new RouteProgress(this.wayNet, this.spawn.position, this.spawn.forward);
    defs.forEach((def, i) => {
      const model = buildTruckModel(this.built.assembler, def, true);
      if (!model) return;
      const along = this.wayNet!.advance(start.line, start.seg, start.t, 14 * (i + 1));
      const ahead = this.wayNet!.advance(start.line, start.seg, start.t, 14 * (i + 1) + 3);
      const fwd = ahead.clone().sub(along).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).multiplyScalar(i % 2 ? 2.5 : -2.5);
      const truck = new TruckVehicle(this.world, def, model, { position: this.groundAt(along.add(side)), forward: fwd });
      this.scene.add(truck.visual);
      const pilot = new AutoPilot(this.wayNet!);
      pilot.cruise = 58 + ((i * 7) % 18);
      const lights = new TruckLights(model.setSwitch, truck.visual, truck.lightGeometry);
      hideLampReflections(model.root);
      this.wetReflections.push(new WetReflections(model.root, () => truck.groundHeight(), (x, y, z) => this.roadBelow(x, y, z), (x, y, z) => this.glossAt(x, y, z), (f, t) => this.lampSeen(f, t)));
      this.opponents.push({ truck, pilot, odo: new Odometer(), lights, flippedFor: 0 });
    });
  }

  private stepOpponents(dt: number): void {
    const go = this.countdown <= 0;
    const vec = (t: TruckVehicle) => {
      const p = t.body.translation();
      return new THREE.Vector3(p.x, p.y, p.z);
    };
    const all = [this.truck, ...this.opponents.map((o) => o.truck)].map(vec);
    for (const [i, o] of this.opponents.entries()) {
      const pos = all[i + 1];
      const tp = pos;
      const others = all.filter((_, k) => k !== i + 1);
      const st = o.pilot.update(pos, o.truck.forward(), o.truck.speedKmh, dt, others);
      if (!go) {
        st.throttle = 0;
        st.brake = 0;
      }
      o.truck.update(dt, st);
      o.odo.update(pos, this.route);
      if (tp.y < this.fallY) o.truck.reset(this.spawn);
      // Перекинувся (лежить на боці довше OPPONENT_RECOVER с) — назад на дорогу: найближча лінія way_* за її напрямком.
      o.flippedFor = isFlipped(o.truck) ? o.flippedFor + dt : 0;
      if (o.flippedFor > OPPONENT_RECOVER && this.wayNet) {
        o.flippedFor = 0;
        const n = this.wayNet.nearest(pos);
        if (n) {
          const a = n.line.pts[n.seg];
          const b = n.line.pts[n.seg + 1];
          o.truck.reset({ position: this.groundAt(a.clone().lerp(b, n.t)), forward: b.clone().sub(a).setY(0).normalize() });
        }
      }
    }
  }

  /** Місце гравця в гонці (1 — лідер) за пройденою вздовж дороги відстанню. */
  racePosition(): number {
    return 1 + this.opponents.filter((o) => o.odo.distance > this.playerOdo.distance).length;
  }

  toggleAutopilot(on = !this.autopilot): void {
    if (on) {
      this.wayNet ??= new WayNet(this.built.assembler.b3d);
      this.autopilot = new AutoPilot(this.wayNet);
    } else this.autopilot = null;
  }

  private controls(dt: number) {
    const manual = this.input.update(dt);
    const tp = this.truck.body.translation();
    const st = this.autopilot ? this.autopilot.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.truck.forward(), this.truck.speedKmh, dt) : manual;
    if (this.countdown > 0) return { ...st, throttle: 0 };
    return st;
  }

  /** Спільний облік кроку: відлік, одометр гравця. */
  private tick(dt: number): void {
    const before = this.countdown;
    this.countdown -= dt;
    if (before > 0 && this.countdown <= 0) this.raceStart = this.clock;
    if (this.raceKind !== 'free') this.updateStartLight();
    if (this.opponents.length) {
      const tp = this.truck.body.translation();
      this.playerOdo.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.route);
    }
  }

  /**
   * Стартовий світлофор (HTruck.exe 0x490e34, перемикачі *SvetKey, стан 1 = увімкнено): 2 с червоний, далі 3,5 с
   * жовтий блимає тричі по 1/3 с, кожен спалах — alarmSound, поки лампа горить; на зеленому alarmSound повністю
   * і старт, зелений горить ще 5 с.
   */
  private updateStartLight(): void {
    const lamp = startLamp(START_COUNTDOWN - this.countdown);
    if (lamp === this.lamp) return;
    this.lamp = lamp;
    const asm = this.built.assembler;
    asm.setSwitch('RedSvetKey', lamp === 'r' ? 1 : 0);
    asm.setSwitch('YellowSvetKey', lamp === 'y' ? 1 : 0);
    asm.setSwitch('GreenSvetKey', lamp === 'g' ? 1 : 0);
    this.lampBeep?.stop();
    this.lampBeep = null;
    if (lamp === 'y') this.lampBeep = this.audio?.play('alarm', 1) ?? null;
    if (lamp === 'g') this.audio?.play('alarm', 1);
  }

  /** Детермінований крок для тестів: n кроків фізики без залежності від requestAnimationFrame. */
  simulate(steps: number): void {
    for (let i = 0; i < steps; i++) {
      const state = this.controls(this.world.timestep);
      this.truck.update(this.world.timestep, state);
      this.stepOpponents(this.world.timestep);
      this.world.step();
      this.afterStep();
      this.tick(this.world.timestep);
      this.clock += this.world.timestep;
      this.truck.syncVisual();
      for (const o of this.opponents) o.truck.syncVisual();
    this.movables?.update();
      if (this.truck.body.translation().y < this.fallY) this.truck.reset(this.restartPoint());
      this.updateTrack();
    }
  }

  /** Двірники вручну (W); null — самі під дощем. Переживає зміну виду (кабіна перебудовується). */
  private wipersManual: boolean | null = null;
  toggleWipers(): void {
    this.wipersManual = !(this.glassRain?.wipersOn ?? this.wipersManual ?? this.raining);
    if (this.glassRain) this.glassRain.wipersOn = this.wipersManual;
  }

  /** Пробіл: заглушити / завести двигун (заводиться звуком стартера start). */
  toggleEngine(): void {
    const on = !this.truck.engineOn;
    this.truck.engineOn = on;
    if (on) this.audio?.play('start', 0.8);
  }

  /** Пауза (розгорнуте меню кнопок на трасі): світ, час і звук зупинені, кадр лишається. */
  get paused(): boolean {
    return this.isPaused;
  }
  set paused(on: boolean) {
    if (on === this.isPaused) return;
    this.isPaused = on;
    this.audio?.setMuted(on);
  }
  private isPaused = false;

  update(dt: number): void {
    if (this.isPaused) return;
    const state = this.controls(dt);
    this.acc += Math.min(dt, 0.1);
    const step = this.world.timestep;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.stepOpponents(step);
      this.world.step();
      this.afterStep();
      this.tick(step);
      this.clock += step;
      this.acc -= step;
    }
    this.truck.syncVisual();
    for (const o of this.opponents) o.truck.syncVisual();
    this.movables?.update();
    // Впав зі світу — на точку рестарту.
    if (this.truck.body.translation().y < this.fallY) this.truck.reset(this.restartPoint());
    this.updateTrack();
    this.updateCamera(dt);
    this.roomVis?.update(this.camera, this.room);
    this.handbrakeOn = state.handbrake;
    this.odometer += (this.truck.speedKmh / 3.6) * dt;
    this.updateCab(state);
    if (this.cab2d) {
      const v = this.truck.body.linvel();
      const vel = new THREE.Vector3(v.x, v.y, v.z);
      const fwd = this.truck.forward();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.truck.visual.quaternion);
      const right = new THREE.Vector3().crossVectors(fwd, up).normalize();
      this.cab2d.update(dt, {
        speedKmh: this.truck.speedKmh,
        odometer: this.odometer,
        rpm: this.truck.rpm / 60 / this.def.tachScale[0],
        gear: this.truck.gear,
        handbrake: this.handbrakeOn,
        steer: state.steer,
        local: new THREE.Vector3(vel.dot(right), vel.dot(up), vel.dot(fwd)),
      });
    }
    this.updateLights(state);
    const wet = this.raining && (this.glassRain?.raining ?? true);
    this.syncToggles();
    // Відблиски на дорозі — лише на дощових трасах; фари світять і на сухих (якщо ввімкнені), у тунелях — на повну.
    this.wetReflections.forEach((r, i) => r.update(this.camera, this.raining && (i === 0 ? this.headlights : this.night || wet), wet));
    this.headlightsFx?.update(this.headlights ? (this.night || this.sheltered ? 1 : DAY_HEADLIGHTS) : 0, this.truck.forward());
    this.updateSurface(dt);
    this.checkDeath(dt);
    this.effects?.update(dt);
    this.updateSounds(dt);
    if (this.autoWreck && !this.exploded && this.hits >= WRECK_HITS) {
      this.explode();
      window.setTimeout(() => {
        this.hits = 0;
        this.exploded = false;
        this.applyDents({});
        this.truck.setDamage({ power: 1, lostGears: 0, brakes: 1 });
        this.recover();
      }, 4000);
    }
    if (this.navMap) {
      const p = (t: TruckVehicle) => {
        const v = t.body.translation();
        return new THREE.Vector3(v.x, v.y, v.z);
      };
      this.navMap.update(dt, p(this.truck), this.truck.forward(), this.opponents.map((o) => p(o.truck)));
    }
    // Під дахом (кімнати з подією 4 «tunnel_rain» — тунелі) дощу немає: ні струменів, ні нових крапель.
    // Режим 2D-кабіни — як програмний набір оригіналу: тривимірного дощу там немає; у кабіні дощ видно краплями на
    // склі, з інших камер — смугами rain.msk (0x4d0180).
    const soft = this.cabStyleNow === '2d' && !!this.cab2dLoader;
    let pouring = false;
    if (this.raining) {
      const sheltered = this.sheltered;
      pouring = !sheltered;
      if (this.rain) this.rain.root.visible = !sheltered && !soft;
      if (this.glassRain) this.glassRain.raining = !sheltered;
    }
    this.updateStreaks(dt, soft && pouring && this.camMode !== 'cockpit');
    // Двірники ходять (і чути) за будь-якої камери.
    this.glassRain?.update(dt, this.truck.speedKmh);
    if (this.rain?.root.visible) {
      // Foreground_object — «передній план» біля глядача: повертаємо разом із камерою (вісь циліндра — вгору
      // в кадрі), тож його верхній і нижній край (±8 м на 15 м) не потрапляють у кадр навіть з камери позаду.
      // Висоту ×RAIN_STRETCH — гіпотеза: з кутом огляду порту 60° край інакше видно смужкою внизу.
      this.rain.root.position.copy(this.camera.position);
      this.rain.root.quaternion.copy(this.camera.quaternion);
      this.rain.root.scale.set(1, RAIN_STRETCH, 1);
      for (const t of this.rain.tex) {
        t.map.offset.x = (t.map.offset.x + dt * t.move[0]) % 1;
        t.map.offset.y = (t.map.offset.y + dt * t.move[1]) % 1;
      }
    }
    const t = this.truck;
    if (this.audio) {
      this.audio.update(t.rpm, t.engineOn ? state.throttle : 0, t.engineOn);
      this.brakeSqueal -= dt;
      if (state.brake > 0 && t.gear > 0 && t.speedKmh > 25 && this.brakeSqueal <= 0) {
        this.audio.play('break', 0.5);
        this.brakeSqueal = 3;
      }
    }
    const lap = this.lapStart !== null ? fmtTime(this.clock - this.lapStart) : '—';
    const best = this.bestLap !== null ? `   кращий ${fmtTime(this.bestLap)}` : '';
    const place = this.opponents.length ? `   місце ${this.racePosition()}/${this.opponents.length + 1}` : '';
    const fin = this.finished ? `   ФІНІШ! місце ${this.finished.place}, час ${fmtTime(this.finished.time)}` : '';
    // Табло — 10 разів на секунду: оновлення щокадру змушує браузер перераховувати верстку.
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const status = this.hudStatus?.() ?? { truck: Math.max(0, 1 - this.hits / WRECK_HITS), cargo: null, money: null };
    const money = status.money !== null ? `$${Math.round(status.money)}` : '';
    const race =
      this.raceKind === 'free'
        ? ''
        : `коло ${Math.min(this.laps + 1, this.lapsToFinish || Infinity)}` +
          `${this.lapsToFinish ? '/' + this.lapsToFinish : ''}: ${lap}${best}${place}${fin}`;
    const raceLine = [money, race].filter(Boolean).join('   ');
    if (this.pixelHud) {
      // Типовий найширший рядок цього заїзду — для незмінної ширини табло.
      const tplRace =
        this.raceKind === 'free'
          ? ''
          : `коло 9${this.lapsToFinish ? '/9' : ''}: 9:59.9` + (this.lapsToFinish > 1 ? '   кращий 9:59.9' : '') + (this.opponents.length ? '   місце 9/9' : '');
      const template = [status.money !== null ? '$999999' : '', tplRace].filter(Boolean).join('   ');
      this.pixelHud.update({ speedKmh: t.speedKmh, gear: t.gear, truck: status.truck, cargo: status.cargo, line: raceLine, template });
      return;
    }
    // Без шрифтів оригіналу — текстом.
    const pct = (f: number | null) => (f === null ? '' : `   ${Math.round(f * 100)}%`);
    const text = `${t.speedKmh.toFixed(0)}   ${t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : t.gear}${pct(status.truck)}${pct(status.cargo)}${raceLine ? `\n${raceLine}` : ''}`;
    if (this.hud.textContent !== text) this.hud.textContent = text;
  }

  /** Шрифти оригіналу для табло (MENU.FON, large.fon); без них — текст системним шрифтом. */
  private hudFonts: [PixelFont | null, PixelFont | null] | null = null;
  setHudFonts(small: PixelFont | null, large: PixelFont | null): void {
    this.hudFonts = [small, large];
    this.pixelHud?.dispose();
    this.pixelHud = small ? new DriveHud(this.hud, small, large, this.hudDigits()) : null;
  }
  /**
   * Цифри швидкості табло — з одометра 3D-кабіни машини, незалежно від виду (у 2D-кабіні й від першої особи
   * 3D-кабіни немає — інакше табло перемикалося на інший шрифт). Беремо раз з окремої копії моделі кабіни.
   */
  private odoDigits: HTMLCanvasElement[] | null | undefined;
  private hudDigits(): HTMLCanvasElement[] | null {
    if (this.odoDigits === undefined) {
      const dyn = this.built.assembler.dynamicObject(`${this.def.prefix}Cab`);
      this.odoDigits = dyn ? odometerDigits(dyn.root) : null;
    }
    return this.odoDigits;
  }

  /** Увімкнути колізії лише кімнат з машинами та їхніх сусідів через портали (решта — вимкнені). */
  private updateActiveRooms(): void {
    if (!this.roomColliders.size) return;
    const rooms = [this.room, ...this.opponentRooms];
    if (rooms.some((r) => !r)) {
      // Кімната невідома — вмикаємо все, щоб нікуди не провалитися.
      if (this.activeRooms === '*') return;
      this.activeRooms = '*';
      for (const cs of this.roomColliders.values()) for (const c of cs) c.setEnabled(true);
      return;
    }
    const on = new Set<string>();
    for (const r of rooms as string[]) {
      on.add(r);
      for (const p of this.track.rooms.get(r)?.portals ?? []) on.add(p.to);
    }
    const key = [...on].sort().join();
    if (key === this.activeRooms) return;
    this.activeRooms = key;
    for (const [room, cs] of this.roomColliders) for (const c of cs) c.setEnabled(on.has(room) || !this.track.rooms.has(room));
  }

  private updateOpponentRooms(): void {
    let changed = false;
    this.opponents.forEach((o, i) => {
      const p = o.truck.body.translation();
      const r = this.locate(new THREE.Vector3(p.x, p.y, p.z)) ?? this.opponentRooms[i] ?? null;
      if (r !== this.opponentRooms[i]) {
        this.opponentRooms[i] = r;
        changed = true;
      }
    });
    if (changed) this.updateActiveRooms();
  }

  /** Удар: різка зміна швидкості за один крок (≫ гальмування чи розгону) — накопичуємо силу. */
  private afterStep(): void {
    const v = this.truck.body.linvel();
    const dv = Math.hypot(v.x - this.prevVel.x, v.y - this.prevVel.y, v.z - this.prevVel.z);
    if (dv > 0.8) this.hits += dv;
    this.impactSound(dv);
    // Вмʼятина — у зоні, звідки прийшов удар (протилежно до зміни швидкості), у системі машини.
    if (dv > DENT_MIN_HIT) {
      const f = this.truck.forward().setY(0).normalize();
      const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0));
      const from = new THREE.Vector3(this.prevVel.x - v.x, 0, this.prevVel.z - v.z);
      const a = Math.atan2(from.dot(right), from.dot(f)) / (Math.PI / 4);
      const zone = DENT_ZONES[((Math.round(a) % 8) + 8) % 8];
      this.dents[zone] = (this.dents[zone] ?? 0) + dv;
      this.updateDent(zone);
    }
    this.prevVel.set(v.x, v.y, v.z);
  }

  /** Висота підлоги (Three.js y) під точкою — за полігонами колізій усіх кімнат. */
  /**
   * Наскільки блищить мокра поверхня під точкою, 0…1: трава, ґрунт, гравій, вода — 0; асфальт, бетон, тротуар —
   * за текстурою (surfaceGloss). Світ нерухомий — кеш за клітинками 2 м.
   */
  glossAt(x: number, y: number, z: number): number {
    const key = `${Math.round(x / 2)},${Math.round(y / 2)},${Math.round(z / 2)}`;
    const known = this.glossCache.get(key);
    if (known !== undefined) return known;
    this.glossRay.set(new THREE.Vector3(x, y + 1.5, z), new THREE.Vector3(0, -1, 0));
    this.glossRay.far = 4;
    this.glossRay.camera = this.camera; // білборди (тип 28) без камери кидають виняток
    const rooms = this.built.rooms.filter((r) => r.visible);
    const hit = this.glossRay.intersectObjects(rooms, true).find((h) => (h.object as THREE.Mesh).isMesh);
    let v = 0;
    if (hit) {
      const mesh = hit.object as THREE.Mesh;
      const mat = (Array.isArray(mesh.material) ? mesh.material[hit.face?.materialIndex ?? 0] : mesh.material) as THREE.MeshBasicMaterial;
      v = classifySurface(mat?.name ?? '', texelAt(mat?.map, hit.uv)) === 'asphalt' ? surfaceGloss(mat) : 0;
    }
    if (this.glossCache.size > 50000) this.glossCache.clear();
    this.glossCache.set(key, v);
    return v;
  }
  private readonly glossCache = new Map<string, number>();
  private readonly glossRay = new THREE.Raycaster();

  /** Висота дороги (нерухомі колізії) під точкою, шукаючи вниз від y на 8 м; null — немає. */
  roadBelow(x: number, y: number, z: number): number | null {
    const hit = this.world.castRay(
      new RAPIER.Ray({ x, y, z }, { x: 0, y: -1, z: 0 }),
      8,
      true,
      RAPIER.QueryFilterFlags.EXCLUDE_DYNAMIC,
    );
    return hit ? y - hit.timeOfImpact : null;
  }

  /**
   * Ліхтар у точці to видно з from: промінь до нього (без останніх LAMP_SKIP м — скло на поверхні кузова) нічого не
   * перетинає. Кабіна гравця не рахується — камера з кабіни всередині її колайдера.
   */
  lampSeen(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const d = this.lampDir.subVectors(to, from);
    const len = d.length() - LAMP_SKIP;
    if (len <= 0) return true;
    d.normalize();
    const hit = this.world.castRay(new RAPIER.Ray(from, d), len, true, undefined, undefined, undefined, this.truck.body);
    return !hit;
  }
  private readonly lampDir = new THREE.Vector3();

  floorHeight(p: THREE.Vector3): number | null {
    return floorAt(this.col, p.x, -p.z, p.y)?.z ?? null;
  }

  /** Кімната під точкою (Three.js) — за підлогою hit_road/hit_obj. */
  private locate(p: THREE.Vector3): string | null {
    const r = roomAt(this.col, p.x, -p.z, p.y);
    return r && this.track.rooms.has(r) ? this.track.canonical(r) : null;
  }

  /** Кімнати й коло: перетин порталів, старт таймера, фініш (подія 666). */
  private updateTrack(): void {
    const tp = this.truck.body.translation();
    const cur = new THREE.Vector3(tp.x, tp.y, tp.z);
    // Перетин порталу, а раз на 0,25 с — ще й кімната за підлогою (база без порталів між залами,
    // пропущений перетин, рестарт).
    // Стрибок (рестарт, телепорт) — не перетин порталів: кімнату визначаємо лише за підлогою.
    const jumped = this.prevPos.distanceTo(cur) > 15;
    let next = this.room && !jumped ? this.track.crossPortal(this.room, this.prevPos, cur) : null;
    if (next) next = this.track.canonical(next);
    if (next === this.room) next = null;
    if (jumped) this.locateTimer = 0;
    if (!next && (this.locateTimer -= 1 / 60) <= 0) {
      this.locateTimer = 0.25;
      this.updateOpponentRooms();
      // Кімнату змінює перетин порталу (як в оригіналі). За підлогою — лише якщо під машиною вже немає
      // підлоги поточної кімнати (рестарт, пропущений портал): підлоги сусідніх кімнат перекриваються
      // (тунель траси під залом запчастин), і «найвища підлога» вводила в оману.
      const room = this.room;
      const inRoom = room !== null && floorAt(this.col, cur.x, -cur.z, cur.y + 1, (r) => this.track.canonical(r) === room) !== null;
      if (!inRoom) {
        const at = this.locate(cur);
        if (at && at !== this.room) next = at;
      }
    }
    {
      if (next && this.track.rooms.has(next)) {
        const now = this.clock;
        if (this.lapStart === null) {
          this.lapStart = now;
          this.lapRoom = next;
        }
        const room = this.track.rooms.get(next)!;
        this.room = next;
        this.updateActiveRooms();
        this.visited.add(next);
        for (const e of room.events) if (e.type === EVENT_CHECKPOINT) this.passed.add(e.param);
        this.onRoomEnter?.(room);
        // Кільце: фініш (подія 666) або повернення в сектор старту, пройшовши більшість траси.
        // Маршрут (комерційні траси, полігон): доїхати до сектора з подією фінішу; зараховується, лише якщо пройдено всі контрольні точки (полігон: прапорці за порядком).
        const allChecks = [...this.checkpoints].every((c) => this.passed.has(c));
        const atFinish = this.track.hasEvent(next, EVENT_FINISH) && (this.raceKind !== 'route' || allChecks);
        const lapDone =
          this.raceKind === 'laps'
            ? (atFinish || next === this.lapRoom) && this.visited.size >= this.track.rooms.size * 0.6
            : this.raceKind === 'route' && atFinish;
        if (lapDone) {
          this.lapTime = now - this.lapStart;
          this.bestLap = this.bestLap === null ? this.lapTime : Math.min(this.bestLap, this.lapTime);
          this.laps++;
          this.lapStart = now;
          this.visited.clear();
          this.audio?.play('alarm', 0.6);
          if (this.lapsToFinish && this.laps >= this.lapsToFinish && !this.finished) {
            this.finished = { place: this.racePosition(), time: now - (this.raceStart ?? 0) };
            this.onFinish?.(this.result!);
          }
        }
      }
    }
    this.prevPos.copy(cur);
  }

  private baseFov: number | undefined;
  private updateCamera(dt: number): void {
    const v = this.truck.visual;
    const fwd = this.truck.forward();
    const up = new THREE.Vector3(0, 1, 0);
    this.updateCamYaw(fwd, dt);
    const lag = new THREE.Quaternion().setFromAxisAngle(up, this.camYaw);
    // Поле зору: з панеллю — вужче (як в оригіналі), інакше — звичайне (truck.ini, див. main.ts).
    this.baseFov ??= this.camera.fov;
    const fov = this.camMode === 'first' && this.panelMode ? PANEL_FOV : this.baseFov;
    if (this.camera.fov !== fov) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    if (this.camMode === 'cockpit' || this.camMode === 'first') {
      // Камера в кабіні: орієнтація вантажівки + нахил погляду tangViewer; поворот погляду — з інерцією.
      const eye = this.cockpit.clone().applyQuaternion(v.quaternion).add(v.position);
      const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (this.def.tech.viewerTilt * Math.PI) / 180);
      this.cabQuat.copy(v.quaternion).multiply(tilt);
      this.camera.position.copy(eye);
      this.camera.quaternion.copy(lag).multiply(v.quaternion).multiply(tilt);
      return;
    }
    const dist = this.camMode === 'far' ? 28 : 13;
    const height = this.camMode === 'far' ? 12 : 5;
    const flat = fwd.clone().setY(0).normalize().applyQuaternion(lag);
    const want = v.position.clone().addScaledVector(flat, -dist).addScaledVector(up, height);
    const k = 1 - Math.exp(-dt * 4);
    this.camPos.lerp(want, k);
    this.camLook.lerp(v.position.clone().addScaledVector(up, 2), 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  /**
   * Пружина «курс → погляд»: при повороті погляд зберігає старий напрям, потім догоняє (≈ 0,3 с,
   * з невеликим перехльостом). Зсув обмежено ±20°. Параметри підібрано на око — гіпотеза.
   */
  private updateCamYaw(fwd: THREE.Vector3, dt: number): void {
    const heading = Math.atan2(-fwd.x, -fwd.z);
    if (this.lastHeading !== null && dt > 0) {
      let d = heading - this.lastHeading;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      // Рестарт або розворот на місці — без ривка.
      if (Math.abs(d) > 0.5) this.camYaw = this.camYawVel = 0;
      else this.camYaw -= d;
      const k = 40;
      const c = 2 * Math.sqrt(k) * 0.6;
      this.camYawVel += (-k * this.camYaw - c * this.camYawVel) * dt;
      this.camYaw += this.camYawVel * dt;
      const max = (20 * Math.PI) / 180;
      this.camYaw = Math.max(-max, Math.min(max, this.camYaw));
    }
    this.lastHeading = heading;
  }

  dispose(): void {
    this.drop2dCab();
    this.streaks?.el.remove();
    this.streaks = undefined;
    this.mirror?.rt.dispose();
    this.mirror?.frame.remove();
    if (this.baseFov !== undefined) {
      this.camera.fov = this.baseFov;
      this.camera.updateProjectionMatrix();
    }
    this.roomVis?.showAll();
    this.scene.remove(this.truck.visual);
    for (const o of this.opponents) this.scene.remove(o.truck.visual);
    this.input.dispose();
    this.touchUi?.remove();
    this.hud?.remove();
    this.navMap?.dispose();
    this.effects?.dispose();
    // Циліндр дощу — у спільній сцені: без цього лишався стояти там, де була камера попереднього заїзду.
    if (this.rain) this.scene.remove(this.rain.root);
    for (const r of this.wetReflections) r.dispose();
    this.headlightsFx?.dispose();
    if (this.baseFog) {
      this.scene.fog = this.baseFog.fog;
      this.scene.background = this.baseFog.bg;
    }
    SKY_FOG.horizon.value = SKY_FOG.top.value = 0;
    for (const s of this.oppSounds ?? []) s?.stop();
    this.stonesSound?.stop();
    this.audio?.dispose();
    void this.wakeLock?.release().catch(() => {});
    this.world.free();
  }
}

/** Підказку про повторний імпорт для дощу 2D-кабіни показуємо раз за сеанс. */
let rainHintShown = false;

/** Наскільки далі від тунелів бази ставити машину, м (на око: з кабіни в ландшафті телефона видно всі вказівники). */
const BASE_SPAWN_BACK = 21;

/** Сила власного світла фар удень (дощ чи суша) відносно ночі й тунелю (на око: помітне на асфальті, не засвічує). */
const DAY_HEADLIGHTS = 0.45;

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

/** Пройдена вздовж мережі доріг відстань (для визначення місця в гонці). */
/** Положення машини в гонці — відстань від старту вздовж маршруту з колами (RouteProgress), раз на 6 кроків. */
class Odometer {
  distance = 0;
  private n = 0;

  update(pos: THREE.Vector3, route: RouteProgress | null): void {
    if (!route || this.n++ % 6) return;
    this.distance = route.update(pos, this.distance);
  }
}
