import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addCollisionPolys, addStaticMeshes, g2t, initRapier } from '../physics/world';
import { floorAt, levelCollision, roomAt, type LevelCollision } from '../game/collision';
import { Input } from '../input/input';
import { TruckVehicle, type TruckSetup } from '../game/truckVehicle';
import { GlassRain } from '../render/glassRain';
import { Movables } from '../game/movables';
import { Effects } from '../render/effects';
import { NavMap } from '../ui/navMap';
import { NEEDLE_SCALE, buildTruckModel, type TruckDef } from '../game/trucks';
import type { BuiltScene } from '../render/sceneBuilder';
import { walk } from '../formats/b3d';
import type { RmpArchive } from '../formats/rmp';
import { EngineAudio, type LoopSound } from '../audio/engineAudio';
import { EVENT_CHECKPOINT, EVENT_DEATH, EVENT_FINISH, EVENT_RAIN, Track, type Room } from '../game/track';
import { AutoPilot, WayNet } from '../game/autopilot';
import { RoomVisibility } from '../render/roomVisibility';

type CamMode = 'chase' | 'cockpit' | 'far';

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
/** Швидкість «стікання» текстури струменів дощу, повторів текстури за секунду (гіпотеза). */
const RAIN_SPEED = 2.5;
/** Зони вмʼятин за годинниковою стрілкою від переду — суфікси перемикачів `Damage<зона>Key` у моделях. */
const DENT_ZONES = ['FC', 'FR', 'R', 'BR', 'BC', 'BL', 'L', 'FL'];
/** Удари слабші за це (м/с за крок) вмʼятин не лишають; пороги рівнів — за накопиченою силою (гіпотеза). */
const DENT_MIN_HIT = 2;
const DENT_STEPS = [5, 14, 28, 50];

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
  readonly opponents: { truck: TruckVehicle; pilot: AutoPilot; odo: Odometer }[] = [];
  private readonly playerOdo = new Odometer();
  /** Відлік до старту, с (як світлофор над стартом: червоний → жовтий → зелений). */
  private countdown = 3;
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
  private rain: { root: THREE.Group; setSwitch: (n: string, s: number) => void; tex: THREE.Texture[] } | null = null;
  raining = false;
  setRain(on: boolean): void {
    this.raining = on;
    if (on && !this.rain) {
      const dyn = this.built.assembler.dynamicObject('Foreground_object');
      if (dyn) {
        const wrap = new THREE.Group();
        dyn.root.rotation.x = -Math.PI / 2;
        wrap.add(dyn.root);
        const tex: THREE.Texture[] = [];
        wrap.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.frustumCulled = false;
          const mat = mesh.material as THREE.MeshBasicMaterial;
          // Там же відблиски сонця в обʼєктиві (lens0…7) — їх оригінал ставить за сонцем; поки не малюємо.
          if (mat.map?.name.startsWith('txr/lens')) mesh.visible = false;
          else if (mat.map) {
            // Струмені: текстура «тече» вниз (своя копія з повтором).
            const m = mat.clone();
            m.map = mat.map.clone();
            m.map.wrapS = m.map.wrapT = THREE.RepeatWrapping;
            m.map.needsUpdate = true;
            // Альфа текстури — 0…0,2 (сірі напівпрозорі риски): змішування, а не поріг alphaTest.
            m.alphaTest = 0;
            m.transparent = true;
            m.depthWrite = false;
            mesh.material = m;
            tex.push(m.map);
          }
        });
        this.scene.add(wrap);
        this.rain = { root: wrap, setSwitch: dyn.setSwitch, tex };
      }
    }
    // RainKey: група 0 — струмені, група 1 — порожня.
    this.rain?.setSwitch('RainKey', on ? 0 : 1);
    if (this.rain) this.rain.root.visible = on;
    if (this.glassRain) {
      this.glassRain.raining = on;
      this.glassRain.wipersOn = on;
    }
  }
  /** Тестовий режим: погода — дощ і слизька дорога (×0,8 до зчеплення, як у кар'єрі). */
  setWeather(rain: boolean): void {
    this.setRain(rain);
    this.truck.weatherGrip = rain ? 0.8 : 1;
  }
  /** Краплі на склі кабіни й двірники. */
  private glassRain: GlassRain | null = null;
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
    const q = this.truck.body.rotation();
    return new THREE.Vector3(0, 1, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w)).y < 0.5;
  }
  /** Одноразовий звук з архіву траси (repair, alarm…). */
  sound(name: string, volume = 1): void {
    this.audio?.play(name, volume);
  }
  /** Звуки поза двигуном: двигуни суперників (extcar), двірники, грім; пауза між звуками ударів. */
  private oppSounds: (LoopSound | null)[] | null = null;
  private wiperSound: LoopSound | null | undefined;
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
    // Двірники — поки працюють; грім — зрідка, коли дощ не під дахом.
    const wipers = this.glassRain?.wipersOn ?? false;
    if (wipers && this.wiperSound === undefined) this.wiperSound = a.loopSound('wipers');
    this.wiperSound?.set(wipers ? 0.35 : 0);
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
  showMap(on: boolean): void {
    if (on && !this.navMap) {
      this.wayNet ??= new WayNet(this.built.assembler.b3d);
      const parent = this.hud?.parentElement;
      if (parent && this.wayNet.lines.length) this.navMap = new NavMap(parent, this.wayNet);
    } else if (!on && this.navMap) {
      this.navMap.dispose();
      this.navMap = null;
    }
  }
  private lightsKey = '';
  /** Стоп-сигнали (StopFaraKey: 1 — габарити, 2 — гальмування) і вогні заднього ходу (BackFaraKey) машини гравця. */
  private updateLights(state: { throttle: number; brake: number }): void {
    const reverse = this.truck.gear < 0;
    const braking = reverse ? state.throttle > 0 : state.brake > 0;
    const key = `${braking ? 1 : 0}${reverse ? 1 : 0}`;
    if (key === this.lightsKey || !this.modelSwitch) return;
    this.lightsKey = key;
    for (const side of ['L', 'R']) {
      this.modelSwitch(`StopFaraKey${side}`, braking ? 2 : 1);
      this.modelSwitch(`BackFaraKey${side}`, reverse ? 1 : 0);
    }
  }
  /** Кермування нахилом телефона (дозвіл на iOS питають в «Опціях», за жестом). */
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
    s.track = new Track(built.assembler.b3d);
    s.spawn = s.findSpawn();
    s.room = s.locate(s.spawn.position) ?? s.track.guessRoom(s.spawn.position);
    s.prevPos.copy(s.spawn.position);
    for (const r of s.track.rooms.values()) for (const e of r.events) if (e.type === EVENT_CHECKPOINT) s.checkpoints.add(e.param);
    s.truck = new TruckVehicle(s.world, def, model, s.spawn, setup);
    scene.add(s.truck.visual);
    s.spawnOpponents(rivals);
    s.roomVis = new RoomVisibility(s.track, built.rooms);
    s.updateOpponentRooms();
    s.updateActiveRooms();

    // Очі водія: OV з [TECHn] (система вантажівки), як в оригіналі; вид з кабіни — за замовчуванням.
    s.cockpit = g2t(def.tech.viewer);
    s.cockpit.y += setup?.seatRaise ?? 0;
    s.buildCab();
    s.camMode = 'cockpit';

    if (rmp) s.audio = await EngineAudio.create(rmp).catch(() => null);
    s.input.onCommand = (cmd) => {
      if (cmd === 'horn') s.audio?.play('horn');
      if (cmd === 'autopilot') s.toggleAutopilot();
      if (cmd === 'tilt')
        void s.input.toggleTilt().then((on) => s.touchUi?.querySelector('.tilt')?.classList.toggle('pressed', on));
      if (cmd === 'reset') {
        if (s.onResetRequest) s.onResetRequest();
        else s.recover();
      }
      if (cmd === 'camera') s.camMode = s.camMode === 'chase' ? 'cockpit' : s.camMode === 'cockpit' ? 'far' : 'chase';
    };
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

  /** Кабіна `<Prefix>Cab` у системі «очей водія» (y — уперед, z — угору) з кермом і стрілками. */
  private buildCab(): void {
    const dyn = this.built.assembler.dynamicObject(`${this.def.prefix}Cab`);
    if (!dyn) return;
    this.cabSwitch = dyn.setSwitch;
    const inner = dyn.root;
    inner.rotation.x = -Math.PI / 2;
    this.cab = new THREE.Group();
    this.cab.add(inner);
    this.overlayScene.add(this.cab);
    // Деталі шукаємо за простором (імена стрілок у різних кабінах різняться: ZilStr1, FreiCabStr1…).
    const bySpace = (sp: string) => {
      let found: THREE.Object3D | undefined;
      inner.traverse((o) => {
        if (!found && o.userData.space === `${this.def.prefix}${sp}`.toLowerCase()) found = o;
      });
      return found;
    };
    this.cabParts = { rule: bySpace('RuleSpace'), tacho: bySpace('TachoSpace'), speed: bySpace('SpeedSpace') };
    // Скло (GlassKey, група 1) показуємо завжди: його текстуру — краплі — малює GlassRain, суха — прозора.
    dyn.setSwitch('GlassKey', 1);
    this.glassRain = new GlassRain(inner);
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
    renderer.render(this.overlayScene, camera);
    if (this.cabParts.rule && this.cab?.visible) {
      renderer.clearDepth();
      camera.layers.set(CAB_TOP_LAYER);
      renderer.render(this.overlayScene, camera);
      camera.layers.mask = mask;
    }
    renderer.autoClear = autoClear;
    cam.near = near;
    cam.updateProjectionMatrix();
  }

  private updateCab(state: { steer: number }): void {
    // З кабіни зовнішній корпус власної вантажівки не малюємо (як в оригіналі).
    this.truck.visual.visible = this.camMode !== 'cockpit' || !this.cab;
    if (!this.cab) return;
    this.cab.visible = this.camMode === 'cockpit';
    if (!this.cab.visible) return;
    this.cab.position.copy(this.camera.position);
    this.cab.quaternion.copy(this.cabQuat);
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
    defs.forEach((def, i) => {
      const model = buildTruckModel(this.built.assembler, def);
      if (!model) return;
      const along = this.wayNet!.advance(start.line, start.seg, start.t, 14 * (i + 1));
      const ahead = this.wayNet!.advance(start.line, start.seg, start.t, 14 * (i + 1) + 3);
      const fwd = ahead.clone().sub(along).setY(0).normalize();
      const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).multiplyScalar(i % 2 ? 2.5 : -2.5);
      const truck = new TruckVehicle(this.world, def, model, { position: this.groundAt(along.add(side)), forward: fwd });
      this.scene.add(truck.visual);
      const pilot = new AutoPilot(this.wayNet!);
      pilot.cruise = 58 + ((i * 7) % 18);
      this.opponents.push({ truck, pilot, odo: new Odometer() });
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
      o.odo.update(pos, this.wayNet);
      if (tp.y < this.fallY) o.truck.reset(this.spawn);
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
    // Стартовий світлофор: 3–2 с червоний, 2–1 жовтий, далі зелений (перемикачі *SvetKey, стан 1 = увімкнено).
    const phase = (c: number) => (c > 2 ? 'r' : c > 1 ? 'y' : c > -6 ? 'g' : 'off');
    if (phase(before) !== phase(this.countdown) || before === 3) {
      const ph = phase(this.countdown);
      const asm = this.built.assembler;
      asm.setSwitch('RedSvetKey', ph === 'r' ? 1 : 0);
      asm.setSwitch('YellowSvetKey', ph === 'y' ? 1 : 0);
      asm.setSwitch('GreenSvetKey', ph === 'g' ? 1 : 0);
      if (ph === 'g') this.audio?.play('start', 0.5);
    }
    if (this.opponents.length) {
      const tp = this.truck.body.translation();
      this.playerOdo.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.wayNet);
    }
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

  update(dt: number): void {
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
    this.updateLights(state);
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
    if (this.raining) {
      const sheltered = this.currentRoom?.events.some((e) => e.type === EVENT_RAIN) ?? false;
      if (this.rain) this.rain.root.visible = !sheltered;
      if (this.glassRain) this.glassRain.raining = !sheltered;
    }
    if (this.cab?.visible) this.glassRain?.update(dt);
    if (this.rain?.root.visible) {
      this.rain.root.position.copy(this.camera.position);
      for (const t of this.rain.tex) t.offset.y = (t.offset.y + dt * RAIN_SPEED) % 1;
    }
    const t = this.truck;
    if (this.audio) {
      this.audio.update(t.rpm, state.throttle);
      this.brakeSqueal -= dt;
      if (state.brake > 0 && t.gear > 0 && t.speedKmh > 25 && this.brakeSqueal <= 0) {
        this.audio.play('break', 0.5);
        this.brakeSqueal = 3;
      }
    }
    const lap = this.lapStart !== null ? fmtTime(this.clock - this.lapStart) : '—';
    const best = this.bestLap !== null ? `   кращий ${fmtTime(this.bestLap)}` : '';
    const place = this.opponents.length ? `   місце ${this.racePosition()}/${this.opponents.length + 1}` : '';
    const start = this.countdown > 0 ? `
${['ЗЕЛЕНИЙ', 'ЖОВТИЙ', 'ЧЕРВОНИЙ'][Math.min(2, Math.floor(this.countdown))]}  ${Math.ceil(this.countdown)}` : '';
    const fin = this.finished ? `
ФІНІШ!  місце ${this.finished.place}, час ${fmtTime(this.finished.time)}` : '';
    const speedLine = `${t.speedKmh.toFixed(0)} км/год   ${t.gear < 0 ? 'R' : t.gear === 0 ? 'N' : t.gear}   ${t.rpm.toFixed(0)} об/хв`;
    const raceLine =
      this.raceKind === 'free'
        ? 'вільна їзда'
        : `${(this.room ?? '?').replace('room_', 'сектор ')}   коло ${Math.min(this.laps + 1, this.lapsToFinish || Infinity)}` +
          `${this.lapsToFinish ? '/' + this.lapsToFinish : ''}: ${lap}${best}${place}${start}${fin}`;
    // Табло — 10 разів на секунду: оновлення тексту щокадру змушує браузер перераховувати верстку.
    this.hudTimer -= dt;
    if (this.hudTimer > 0) return;
    this.hudTimer = 0.1;
    const text = `${speedLine}
${raceLine}`;
    if (this.hud.textContent !== text) this.hud.textContent = text;
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

  private updateCamera(dt: number): void {
    const v = this.truck.visual;
    const fwd = this.truck.forward();
    const up = new THREE.Vector3(0, 1, 0);
    this.updateCamYaw(fwd, dt);
    const lag = new THREE.Quaternion().setFromAxisAngle(up, this.camYaw);
    if (this.camMode === 'cockpit') {
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
    this.roomVis?.showAll();
    this.scene.remove(this.truck.visual);
    for (const o of this.opponents) this.scene.remove(o.truck.visual);
    this.input.dispose();
    this.touchUi?.remove();
    this.hud?.remove();
    this.navMap?.dispose();
    this.effects?.dispose();
    for (const s of this.oppSounds ?? []) s?.stop();
    this.wiperSound?.stop();
    this.stonesSound?.stop();
    this.audio?.dispose();
    void this.wakeLock?.release().catch(() => {});
    this.world.free();
  }
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}

/** Пройдена вздовж мережі доріг відстань (для визначення місця в гонці). */
class Odometer {
  distance = 0;
  private prev: THREE.Vector3 | null = null;
  private dir = new THREE.Vector3();
  private n = 0;

  update(pos: THREE.Vector3, net: WayNet | null): void {
    if (!net) return;
    if (this.n++ % 15 === 0) {
      const near = net.nearest(pos);
      if (near) this.dir.subVectors(near.line.pts[near.seg + 1], near.line.pts[near.seg]).setY(0).normalize();
    }
    if (this.prev) this.distance += pos.clone().sub(this.prev).dot(this.dir);
    this.prev = pos.clone();
  }
}
