import { cabStyle, setCabStyle } from './viewSettings';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { HT1_FILES, LEVELS, devServerSource, idbSource, loadLevel, type LevelId, type LoadedLevel } from './files';
import type { FileSource } from '@shared/source';
import { cachedSource, importZip, missingFiles, prefetchMissing, storageInfo, storeFile } from '@shared/gameStore';
import type { GameContext } from '@shared/gameContext';
import { isStandalone } from './engine/ui/pwa';
import { setSoftFont, soften } from './engine/ui/softUi';
import { WIPER_TXR, loadCab2d, loadCab2dTexture } from './cab2d/cab2dFiles';
import { FpsMeter, FrameLimiter, QUALITY, loadQuality, loadShowFps, saveQuality, saveShowFps, type QualityId } from './engine/ui/quality';
import { blockPageZoom, enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen, toast, IOS_FULLSCREEN_HINT } from './engine/ui/mobile';
import { buildScene, type BuiltScene } from './engine/render/sceneBuilder';
import { parseTxr } from './engine/formats/txr';
import { parseMsk } from './engine/formats/msk';
import { parsePlm } from './engine/formats/plm';
import type { RgbaImage } from './engine/formats/binary';
import { decodeCp1251 } from './engine/formats/binary';
import { buildTruckModel, parseTrucks, type TruckDef } from './engine/vehicle/trucks';
import type { DriveSession } from './drive';
import type { TruckSetup } from './engine/vehicle/truckVehicle';
import { currentDriver, listCareers, loadCareer, newCareer, setCurrentDriver, truckSpec, type Career } from './career/career';
import { CareerGame, HOME_SVG, type LevelKind } from './career/careerUi';
import { modal, setHudFont } from './engine/ui/modal';
import {
  driverScreen, helpScreen, mainMenu, newGameScreen, optionsScreen,
  type ControlMode, type OptionsState, type QualityLevel,
} from './ui/menuScreens';
import { HUD_CYAN, PixelFont, box, pixelCanvas, uiScale } from './engine/ui/pixelFont';
import { MenuArt } from './engine/ui/menuArt';
import { parseFon } from './engine/formats/fon';
import { installDevTools } from './devTools';
import { loadSwap, motionOnGesture, requestMotionPermission, setSwap } from './engine/input/input';

/**
 * Дальнобойщики (перша гра): головне меню й кар'єра (LOAD.RES), їзда, а для розробки — переглядач ресурсів (обліт
 * локацій, галерея текстур і масок, техніка) з технічною панеллю `#bar`. Стан переглядача — в адресі
 * (?level=CIRCUIT&tab=scene). Запуск — runHt1 з оболонки (app/main.ts).
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const levelSel = $<HTMLSelectElement>('level');
const stats = $('stats');
const gallery = $('gallery');
const status = $('status');
const truckSel = $<HTMLSelectElement>('truck');
const overlay = $('overlay');

let qualityId = loadQuality();
/** Рендерер оболонки (GameContext) — до runHt1 не використовується. */
let renderer!: THREE.WebGLRenderer;
let ctx!: GameContext;
const limiter = new FrameLimiter(QUALITY[qualityId].fps);
const fpsMeter = new FpsMeter();
const fpsEl = $('fps');
let showFps = loadShowFps();
fpsEl.hidden = !showFps;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d8);
scene.fog = new THREE.Fog(0x8fb4d8, 400, 2500);
/**
 * Поле зору — як в оригіналі: truck.ini [RENDER] ypyramid=1.5 — висота «піраміди огляду» на відстані 1 (проєкція
 * ділить на ypyramid/2, HTruck.exe 0x452e84), тобто вертикаль 2·atan(0,75) ≈ 73,7°, при 4:3 — 90° по горизонталі.
 * На ширших екранах вертикаль та сама, горизонт ширший. (Раніше було 60° — кабіна займала більше екрана.)
 */
const Y_PYRAMID = 1.5;
const camera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(Y_PYRAMID / 2)), 1, 0.5, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.screenSpacePanning = false;
controls.maxPolarAngle = Math.PI * 0.495;

let built: BuiltScene | null = null;
let level: LoadedLevel | null = null;
let tab = 'scene';
let trucks: TruckDef[] = [];
let drive: DriveSession | null = null;
let driveStarting = false;
/** Параметри заїзду від кар'єри (вантажівка, суперники, тип, стан машини); null — швидкий заїзд. */
let careerCfg: { truck: number; rivals: TruckDef[]; kind: LevelKind; setup: TruckSetup } | null = null;
let career: CareerGame | null = null;
const truckRoot = new THREE.Group();
truckRoot.rotation.x = -Math.PI / 2;
scene.add(truckRoot);

const params = new URLSearchParams(location.search);
for (const id of Object.keys(LEVELS)) levelSel.add(new Option(id, id));
levelSel.value = params.get('level') ?? 'CIRCUIT';

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  // Сенсорні кнопки й відступи на малому екрані — пропорційно менші (style.css: var(--ui)).
  document.documentElement.style.setProperty('--ui', String(uiScale()));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);

function setStatus(text: string | null): void {
  status.hidden = !text;
  status.textContent = text ?? '';
}

/**
 * Відкрито з налагоджувального посилання (?tab=… або ?career=1 на dev-сервері): лише тоді адреса стежить за
 * вкладкою й кар'єрою. Звичайний запуск (зокрема гра з домашнього екрана) — завжди головне меню, адреса чиста.
 */
const debugLink = import.meta.env.DEV && !isStandalone() && (params.has('tab') || params.has('career'));

function syncUrl(): void {
  if (!debugLink) return history.replaceState(null, '', location.pathname);
  if (career || careerCfg) return history.replaceState(null, '', '?career=1');
  const p = new URLSearchParams({ level: levelSel.value, tab });
  // Поки список вантажівок не завантажено, значення порожнє — лишаємо те, що було в адресі.
  const truck = truckSel.value || params.get('truck');
  if ((tab === 'trucks' || tab === 'drive') && truck) p.set('truck', truck);
  history.replaceState(null, '', `?${p}`);
}

async function open(): Promise<void> {
  syncUrl();
  stopDrive();
  setStatus(`Завантаження ${levelSel.value}…`);
  try {
    if (built) {
      scene.remove(built.root);
      if (built.sky) scene.remove(built.sky);
      built.dispose();
      built = null;
    }
    const t0 = performance.now();
    level = await loadLevel(source, levelSel.value as LevelId);
    const t1 = performance.now();
    built = buildScene(level.b3d, level.rmp, { switchGroup: Number(params.get('lod') ?? 0) });
    const t2 = performance.now();
    scene.add(built.root);
    if (built.sky) scene.add(built.sky);
    const s = built.stats;
    stats.textContent =
      `${level.id}: кімнат ${s.rooms}, мешів ${s.meshes}, трикутників ${s.triangles}\n` +
      `інстансів ${s.instances}, без текстур ${s.missingTextures}\n` +
      `розбір ${(t1 - t0).toFixed(0)} мс, побудова ${(t2 - t1).toFixed(0)} мс`;
    if (tab === 'textures' || tab === 'masks') showGallery();
    setStatus(null);
    await applyTab();
  } catch (e) {
    console.error(e);
    setStatus(`Помилка: ${(e as Error).message}`);
  }
}

async function ensureTrucks(): Promise<void> {
  if (trucks.length) return;
  trucks = parseTrucks(decodeCp1251(await source.read('TRUCK.TCH')));
  for (const t of trucks) truckSel.add(new Option(`${t.carNode} (${t.tech.horsePower} к.с., $${t.tech.price})`, String(t.index)));
  // Збережена в адресі вантажівка — лише якщо така є (порожнє чи застаріле значення лишало список порожнім).
  const want = params.get('truck');
  truckSel.value = trucks.some((t) => String(t.index) === want) ? want! : trucks.some((t) => t.index === 1) ? '1' : String(trucks[0]?.index ?? '');
}

function showTruck(): void {
  truckRoot.clear();
  if (!built) return;
  const def = trucks.find((t) => String(t.index) === truckSel.value);
  const model = def && buildTruckModel(built.assembler, def);
  if (!model) {
    stats.textContent = `Модель ${def?.carNode ?? '?'} відсутня в цій локації`;
    return;
  }
  truckRoot.add(model.root);
  truckRoot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(truckRoot);
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(r * 0.7, r * 0.35, r * 0.7));
  camera.near = 0.05;
  camera.updateProjectionMatrix();
  scene.fog = null;
  const t = def.tech;
  stats.textContent =
    `${def.carNode}: маса ${t.mass} кг, ${t.horsePower} к.с., момент ${t.maxRotMomentum}
` +
    `передачі ${t.gears.join(' / ')}, головна ${t.rearAxleCoeff}, колесо r=${t.wheelRadius} м`;
  syncUrl();
}

function stopDrive(): void {
  drive?.dispose();
  drive = null;
  controls.enabled = true;
}

async function startDrive(): Promise<void> {
  if (!built || driveStarting) return;
  stopDrive();
  driveStarting = true;
  setStatus('Підготовка фізики…');
  try {
    await ensureTrucks();
    const cfg = careerCfg;
    const def = trucks.find((t) => String(t.index) === String(cfg?.truck ?? truckSel.value)) ?? trucks[0];
    controls.enabled = false;
    scene.fog = new THREE.Fog(0x8fb4d8, 150, 900);
    // Rapier (WASM ~2 МБ) вантажимо лише при вході в режим їзди.
    const { DriveSession } = await import('./drive');
    // Суперники (тестовий режим): кількість з ?ai= або списку «Суперники»; інші моделі вантажівок, по колу, якщо
    // суперників більше, ніж моделей.
    const nAi = Number(params.get('ai') ?? rivalsSel.value);
    // Правила з довідки: Кольцо — 3 кола; Полигон — поодинці; комерційні — до фінішу; база — вільна їзда.
    const id = levelSel.value as LevelId;
    const kind = cfg?.kind ?? (id === 'CIRCUIT' ? 'laps' : id === 'MENU3D' ? 'free' : 'route');
    const others = trucks.filter((t) => t !== def);
    const rivals = cfg?.rivals ?? (id === 'TRIAL' || id === 'MENU3D' || !others.length ? [] : Array.from({ length: nAi }, (_, i) => others[i % others.length]));
    drive = await DriveSession.start(scene, camera, built, def, overlay, level?.rmp, rivals, kind, cfg?.setup ?? { arcade: difficultySel.value === 'arcade' });
    drive.onSettingsCommand = (cmd) => {
      if (cmd === 'swap') return setSwap(!loadSwap());
      const style = drive?.cabStyleCurrent === '2d' ? '3d' : '2d';
      setCabStyle(style);
      drive?.setCabStyle(style);
    };
    // Маски 2D-кабіни: з файлів на пристрої; якщо їх імпортовано раніше без масок — з ПК (dev-сервер), із записом.
    drive.setCab2dLoader(async (mask, raw) => (await loadCab2d(source, mask, storeFile, raw)) ?? (source === devServerSource ? null : loadCab2d(devServerSource, mask, storeFile, raw)));
    drive.setWiperTextureLoader(async () => (await loadCab2dTexture(source, WIPER_TXR, storeFile)) ?? (source === devServerSource ? null : loadCab2dTexture(devServerSource, WIPER_TXR, storeFile)));
    const [small, large] = await hudFonts();
    drive.setHudFonts(small, large);
    // Тестовий режим: мінікарта завжди (у кар'єрі — лише з навігаційною системою «НС»).
    if (!cfg && id !== 'MENU3D') drive.showMap(true);
    // Тестовий режим — розкладка кнопок, як на базі кар'єри (на прохання користувача): сигнал у групі «•••», на його
    // місці — «Головне меню»; група розкривається під «•••» колонками справа наліво.
    if (!cfg) {
      const home = document.createElement('button');
      home.className = 'touch-btn home';
      home.setAttribute('aria-label', 'Головне меню');
      home.innerHTML = HOME_SVG;
      soften(home);
      home.addEventListener('click', () => $('toMenu').click());
      drive.input.setBaseLayout({ group: [], top: [home] });
      // Місце групи, яке виставляє база кар'єри (поруч із вікном закупівлі), — тут не потрібне.
      document.documentElement.style.removeProperty('--base-group-right');
    }
    drive.input.onTiltDenied = () => toast(TILT_DENIED, 8000);
    if (loadControl() === 'tilt') drive.setTilt(true);
    drive.night = id === 'NIGHT';
    if (!cfg) drive.setWeather(weatherSel.value === 'rain');
    setStatus(null);
  } catch (e) {
    console.error(e);
    setStatus(`Помилка: ${(e as Error).message}`);
  } finally {
    driveStarting = false;
  }
}

/** Показує/ховає обʼєкти відповідно до вкладки. */
async function applyTab(): Promise<void> {
  gallery.hidden = tab === 'scene' || tab === 'trucks' || tab === 'drive';
  stats.hidden = !(tab === 'scene' || tab === 'trucks');
  truckSel.hidden = tab !== 'trucks' && tab !== 'drive';
  if (built) built.root.visible = tab === 'scene' || tab === 'drive';
  truckRoot.visible = tab === 'trucks';
  document.body.classList.toggle('driving', tab === 'drive');
  $('menu').hidden = tab !== 'drive';
  if (tab !== 'drive') stopDrive();
  else await startDrive();
  if (tab === 'trucks') void ensureTrucks().then(showTruck);
  else if (tab === 'scene' && built) {
    camera.near = 0.5;
    frame(built);
  }
}

function frame(b: BuiltScene): void {
  const box = new THREE.Box3().setFromObject(b.root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3()).length();
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(size * 0.25, size * 0.2, size * 0.25));
  camera.far = Math.max(5000, size * 2);
  camera.updateProjectionMatrix();
  scene.fog = new THREE.Fog(0x8fb4d8, size * 0.3, size * 1.5);
}

function toCanvas(img: RgbaImage): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

function showGallery(): void {
  gallery.replaceChildren();
  if (!level) return;
  const rmp = level.rmp;
  const pal = [...rmp.palettes.values()].map(parsePlm)[0]?.palette;
  const items: [string, () => RgbaImage][] =
    tab === 'textures'
      ? [...rmp.backgrounds, ...rmp.textures].map(([n, b]) => [n, () => parseTxr(b)])
      : [...rmp.masks].map(([n, b]) => [n, () => parseMsk(b, pal)]);
  // Малюємо порціями, щоб не блокувати UI на телефоні.
  let i = 0;
  const step = () => {
    const end = Math.min(items.length, i + 24);
    for (; i < end; i++) {
      const [name, decode] = items[i];
      const fig = document.createElement('figure');
      try {
        const img = decode();
        const thumb = document.createElement('div');
        thumb.className = 'thumb';
        thumb.append(toCanvas(img));
        fig.append(thumb);
        fig.title = `${name} ${img.width}×${img.height}`;
      } catch (e) {
        fig.textContent = '✕';
        fig.title = `${name}: ${(e as Error).message}`;
      }
      const cap = document.createElement('figcaption');
      cap.textContent = name.replace(/^.*\//, '');
      fig.append(cap);
      gallery.append(fig);
    }
    if (i < items.length && (tab === 'textures' || tab === 'masks')) requestAnimationFrame(step);
  };
  step();
}

for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  btn.addEventListener('click', () => {
    tab = btn.dataset.tab!;
    for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', b === btn);
    syncUrl();
    void applyTab();
    if (tab === 'textures' || tab === 'masks') showGallery();
  });
}
const initialTab = params.get('tab');

levelSel.addEventListener('change', open);
// У режимі їзди панель згорнута; кнопка ☰ тимчасово її показує.
$('menu').addEventListener('click', () => document.body.classList.toggle('bar-open'));
truckSel.addEventListener('change', () => {
  syncUrl();
  if (tab === 'drive') void startDrive();
  else showTruck();
});
$('fullscreen').addEventListener('click', () => void toggleFullscreen());
// Поміняти місцями кермо й педалі (сенсорний екран; те саме, що «Кермо й педалі» в «Опціях»).
$('swapToggle').addEventListener('click', () => {
  setSwap(!loadSwap());
  document.body.classList.remove('bar-open');
});
// Вихід із пробного заїзду / переглядача в головне меню (у кар'єрі — кнопка «МЕНЮ» табло).
$('toMenu').addEventListener('click', () => {
  document.body.classList.remove('bar-open');
  stopDrive();
  selectTab('scene');
  void menuLoop();
});

// Якість рендера: щільність пікселів і частота кадрів змінюються одразу, згладжування — з перезавантаженням.
const qualitySel = $<HTMLSelectElement>('quality');
for (const [id, q] of Object.entries(QUALITY)) qualitySel.add(new Option(q.label, id));
qualitySel.value = qualityId;
qualitySel.addEventListener('change', () => {
  const next = qualitySel.value as QualityId;
  saveQuality(next);
  if (QUALITY[next].antialias !== QUALITY[qualityId].antialias) return location.reload();
  qualityId = next;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[next].dpr));
  limiter.fps = QUALITY[next].fps;
  resize();
});
// Погода в тестовому режимі (у кар'єрі її задає гра).
const weatherSel = $<HTMLSelectElement>('weather');
try {
  weatherSel.value = localStorage.getItem('ht.testWeather') === 'rain' ? 'rain' : 'dry';
} catch {
  /* приватний режим */
}
weatherSel.addEventListener('change', () => {
  try {
    localStorage.setItem('ht.testWeather', weatherSel.value);
  } catch {
    /* приватний режим */
  }
  if (drive && !careerCfg) drive.setWeather(weatherSel.value === 'rain');
});

// Режим гри в тестовому режимі (як у кар'єрі): симулятор — покриття й дощ впливають на машину, аркада — ні.
// За замовчуванням — аркада; вибір запам'ятовується (і після перезавантаження), доки не перейшли в кар'єру
// (на прохання користувача) — тоді знову аркада.
const DIFFICULTY_KEY = 'ht.testDifficulty';
const difficultySel = $<HTMLSelectElement>('difficulty');
try {
  difficultySel.value = localStorage.getItem(DIFFICULTY_KEY) === 'sim' ? 'sim' : 'arcade';
} catch {
  /* приватний режим */
}
difficultySel.addEventListener('change', () => {
  try {
    localStorage.setItem(DIFFICULTY_KEY, difficultySel.value);
  } catch {
    /* приватний режим */
  }
  if (tab === 'drive' && !careerCfg) void startDrive();
});
/** Перехід у кар'єру: режим тестового заїзду — знову аркада. */
function resetTestDifficulty(): void {
  difficultySel.value = 'arcade';
  try {
    localStorage.removeItem(DIFFICULTY_KEY);
  } catch {
    /* приватний режим */
  }
}

// Кількість суперників у тестовому режимі (за замовчуванням 10; у кар'єрі — з налаштувань гри).
const RIVALS_KEY = 'ht.testRivals';
const RIVALS_MAX = 15;
const rivalsSel = $<HTMLSelectElement>('rivals');
for (let n = 0; n <= RIVALS_MAX; n++) rivalsSel.add(new Option(`Суперників: ${n}`, String(n)));
rivalsSel.value = '10';
try {
  const saved = localStorage.getItem(RIVALS_KEY);
  if (saved !== null && Number(saved) >= 0 && Number(saved) <= RIVALS_MAX) rivalsSel.value = String(Number(saved));
} catch {
  /* приватний режим */
}
rivalsSel.addEventListener('change', () => {
  try {
    localStorage.setItem(RIVALS_KEY, rivalsSel.value);
  } catch {
    /* приватний режим */
  }
  // Новий склад — новий заїзд (лише в тестовому режимі; ?ai= у адресі має перевагу — прибираємо його).
  if (params.has('ai')) params.delete('ai');
  if (tab === 'drive' && !careerCfg) void startDrive();
});

$('options').addEventListener('click', () => {
  document.body.classList.remove('bar-open');
  void optionsDialog();
});

$('fpsToggle').addEventListener('click', () => {
  showFps = !showFps;
  saveShowFps(showFps);
  fpsEl.hidden = !showFps;
  showFpsValue('…');
});

/** Частота кадрів — тонкою табличкою, як кнопки табло (MENU.FON); поки шрифт не завантажено — текстом. */
function showFpsValue(text: string): void {
  if (!hudFont) {
    fpsEl.textContent = text;
    if (hudFont === undefined) void hudFonts();
    return;
  }
  const w = hudFont.measure(text) + 10;
  const h = hudFont.height + 8;
  const { canvas, ctx } = pixelCanvas(w, h);
  box(ctx, 0, 0, w, h);
  hudFont.draw(ctx, text, 5, 4, HUD_CYAN);
  fpsEl.classList.add('pixel-hud');
  fpsEl.replaceChildren(canvas);
}
async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) return exitFullscreen();
  if (!(await enterFullscreen())) toast(IOS_FULLSCREEN_HINT, 15000);
}
blockPageZoom();
// Кнопки технічного меню й кнопка ☰ — «м'які», як панелі (softUi).
for (const b of document.querySelectorAll<HTMLElement>('#bar button, #menu')) soften(b);
// На телефоні гра сама переходить на весь екран при першому дотику в режимі їзди
// (браузер дозволяє це лише з обробника дотику).
let autoFullscreenTried = false;
document.addEventListener('pointerup', (e) => {
  if (autoFullscreenTried || e.pointerType !== 'touch' || tab !== 'drive' || isFullscreen()) return;
  autoFullscreenTried = true;
  if (fullscreenSupported()) void enterFullscreen();
  else toast(IOS_FULLSCREEN_HINT, 15000);
});

const clock = new THREE.Clock();
// Пауза, коли вкладку згорнуто (економія батареї); після повернення не «надолужуємо» час.
document.addEventListener('visibilitychange', () => {
  if (!renderer) return;
  if (document.hidden) renderer.setAnimationLoop(null);
  else {
    clock.getDelta();
    renderer.setAnimationLoop(loop);
  }
});
/** Розмір полотна, з яким уже намальовано кадр паузи ('' — не на паузі). */
let pausedFrame = '';
function loop(now: number): void {
  if (!limiter.ready(now)) return;
  if (showFps && fpsMeter.tick(now)) showFpsValue(`${fpsMeter.value} fps`);
  const dt = clock.getDelta();
  if (tab === 'drive') {
    // Пауза: світ стоїть, кадр не змінюється — не перемальовуємо (полотно зберігає зображення; раніше — 60 разів на
    // секунду даремно). Ще раз — лише після зміни розміру полотна (поворот, якість): воно тоді очищається.
    if (drive?.paused) {
      const key = `${renderer.domElement.width}x${renderer.domElement.height}`;
      if (key === pausedFrame) return;
      pausedFrame = key;
    } else pausedFrame = '';
    drive?.update(dt);
  } else if (tab === 'scene' || tab === 'trucks') {
    controls.update();
  } else return;
  if (built?.sky) {
    built.sky.visible = tab === 'scene' || tab === 'drive';
    built.sky.position.copy(camera.position);
  }
  renderer.render(scene, camera);
  if (drive && tab === 'drive') {
    drive.renderOverlay(renderer, camera);
  }
}
if (import.meta.env.DEV) {
  const dev = installDevTools({ drive: () => drive, level: () => levelSel.value });
  Object.assign(window, { ht: { THREE, scene, camera, controls, get built() { return built; }, get level() { return level; }, get drive() { return drive; }, importZip, missingFiles, idbSource, dev } });
}

// --- Джерело файлів гри: dev-сервер (розробка на ПК) або імпортовані в браузер (телефон, офлайн). ---
let source: FileSource = devServerSource;

async function devServerAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/game/TRUCK.TCH', { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('html');
  } catch {
    return false;
  }
}

/** Запуск першої гри оболонкою: рендерер, джерело файлів (пристрій, ПК або імпорт), меню чи налагоджувальне посилання. */
export async function runHt1(context: GameContext): Promise<void> {
  ctx = context;
  renderer = ctx.renderer;
  resize();
  renderer.setAnimationLoop(loop);
  if (initialTab && initialTab !== 'scene') document.querySelector<HTMLButtonElement>(`[data-tab="${initialTab}"]`)?.click();
  const missing = await missingFiles(HT1_FILES).catch(() => HT1_FILES.required);
  if (!missing.length && params.get('source') !== 'pc') {
    // Усі файли вже на пристрої — читаємо локально, навіть якщо ПК доступний (без Wi-Fi — швидше).
    source = idbSource;
  } else if (params.get('source') !== 'local' && (await devServerAvailable())) {
    // Файли з ПК, але кожен збережений на пристрої; решту докачуємо у фоні після першої локації.
    source = cachedSource(devServerSource, HT1_FILES);
    void prefetchMissing(devServerSource, HT1_FILES);
  } else {
    if (missing.length) await ctx.showImport(false);
    source = idbSource;
  }
  await startup();
}

// --- Кар'єра й головне меню ---

function selectTab(name: string): void {
  tab = name;
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('active', (b as HTMLElement).dataset.tab === name);
}

/** Завантажити локацію й почати їзду з параметрами кар'єри. */
async function play(id: LevelId, cfg: NonNullable<typeof careerCfg>): Promise<DriveSession | null> {
  careerCfg = cfg;
  levelSel.value = id;
  selectTab('drive');
  await open();
  return drive;
}

let hudFont: PixelFont | null | undefined;
let largeFont: PixelFont | null | undefined;

/** Растрові шрифти оригіналу для табло: MENU.FON (6×9) і large.fon (12×17); недоступний — null. */
async function hudFonts(): Promise<[PixelFont | null, PixelFont | null]> {
  // До вибору гри (екран вибору) шрифти першої гри — з ПК або з пристрою, що є.
  const read = (name: string) => source.read(name).catch(() => idbSource.read(name));
  const load = (name: string) => read(name).then((b) => new PixelFont(parseFon(b))).catch(() => null);
  if (hudFont === undefined) hudFont = await load('MENU.FON');
  if (largeFont === undefined) largeFont = await load('large.fon');
  setHudFont(hudFont);
  setSoftFont(hudFont);
  return [hudFont, largeFont];
}

async function startCareer(c: Career): Promise<void> {
  playModeSel.value = 'career';
  resetTestDifficulty();
  await ensureTrucks();
  await hudFonts();
  const specs = trucks.map(truckSpec);
  document.body.classList.add('career');
  career = await CareerGame.start(
    {
      overlay,
      scene,
      defs: async () => (await ensureTrucks(), trucks),
      play,
      built: () => built,
      font: hudFont ?? null,
      exit: () => {
        career = null;
        careerCfg = null;
        document.body.classList.remove('career');
        stopDrive();
        selectTab('scene');
        void menuLoop();
      },
    },
    c,
    specs,
  );
}

let menuArt: MenuArt | null | undefined;

// Перемикач у меню порту (☰): кар'єра — гра як в оригіналі; тест — переглядач і вільна їзда для налагодження.
const playModeSel = $<HTMLSelectElement>('playMode');
playModeSel.value = params.get('career') ? 'career' : 'test';
playModeSel.addEventListener('change', () => {
  document.body.classList.remove('bar-open');
  if (playModeSel.value === 'test') {
    if (career) career.leave();
    career = null;
    careerCfg = null;
    document.body.classList.remove('career');
    selectTab('drive');
    void open();
  } else {
    stopDrive();
    resetTestDifficulty();
    const saved = loadCareer();
    void (saved ? startCareer(saved) : menuLoop());
  }
});

/** Керування: кнопки чи нахил телефона (зберігається в цьому браузері). */
const CONTROL_KEY = 'ht.control';
function loadControl(): ControlMode {
  try {
    return localStorage.getItem(CONTROL_KEY) === 'tilt' ? 'tilt' : 'buttons';
  } catch {
    return 'buttons';
  }
}
const TILT_DENIED = 'Без дозволу на датчик руху нахил не працює (Safari: Параметри → Safari → Рух і орієнтація).';
// Застосунок з початкового екрана після перезапуску забуває дозвіл на датчик руху: збережено «нахил» — питаємо
// на першому дотику (ще в меню), а не посеред заїзду.
if (loadControl() === 'tilt') void motionOnGesture();
function saveControl(c: ControlMode): void {
  try {
    localStorage.setItem(CONTROL_KEY, c);
  } catch {
    /* приватний режим */
  }
}

const OPTION_DEFAULTS: OptionsState = { control: 'buttons', quality: 'balance', fullscreen: false, swap: false, fps: false, cab: '3d' };

/** Налаштування (ОПЦИИ) — екран оригіналу з LOAD.RES; без нього — простий діалог. */
async function optionsDialog(): Promise<void> {
  await hudFonts();
  if (menuArt === undefined) menuArt = await MenuArt.load((n) => source.read(n));
  if (menuArt) {
    const st: OptionsState = {
      control: loadControl(),
      quality: qualitySel.value as QualityLevel,
      fullscreen: isFullscreen(),
      swap: loadSwap(),
      fps: showFps,
      cab: cabStyle(),
    };
    await optionsScreen(
      menuArt,
      st,
      {
        async setControl(c) {
          if (c === 'tilt') {
            // iOS дає доступ до датчика руху лише за жестом користувача — питаємо тут, у натисканні.
            if ((await requestMotionPermission()) !== 'granted') {
              toast(TILT_DENIED, 8000);
              return loadControl();
            }
          }
          saveControl(c);
          drive?.setTilt(c === 'tilt');
          return c;
        },
        setQuality(q) {
          if (qualitySel.value === q) return;
          qualitySel.value = q;
          qualitySel.dispatchEvent(new Event('change'));
        },
        async setFullscreen(on) {
          if (on && !isFullscreen() && !(await enterFullscreen())) toast(IOS_FULLSCREEN_HINT, 15000);
          if (!on && isFullscreen()) await exitFullscreen();
          return isFullscreen();
        },
        setSwap: setSwap,
        setFps(on) {
          if (on !== showFps) $('fpsToggle').click();
        },
        setCab(style) {
          setCabStyle(style);
          drive?.setCabStyle(style);
        },
        storage: () => storageInfo(HT1_FILES),
        async reimport() {
          await ctx.showImport(true);
          // Файли тепер на пристрої — читаємо звідси (а не з ПК).
          if (!(await missingFiles(HT1_FILES)).length) source = idbSource;
        },

      },
      OPTION_DEFAULTS,
    );
    return;
  }
  const box = document.createElement('div');
  box.className = 'career-form';
  const label = document.createElement('label');
  label.textContent = 'Якість графіки';
  const sel = document.createElement('select');
  for (const [id, q] of Object.entries(QUALITY)) sel.add(new Option(q.label, id));
  sel.value = qualitySel.value;
  label.append(sel);
  box.append(label);
  const swapLabel = document.createElement('label');
  swapLabel.className = 'career-check';
  const swap = document.createElement('input');
  swap.type = 'checkbox';
  swap.checked = loadSwap();
  swapLabel.append(swap, ' Поміняти місцями кермо й педалі');
  box.append(swapLabel);
  const ok = await modal(overlay, 'Опції', box, ['Гаразд', 'Скасувати']);
  if (ok !== 0) return;
  setSwap(swap.checked);
  if (sel.value !== qualitySel.value) {
    qualitySel.value = sel.value;
    qualitySel.dispatchEvent(new Event('change'));
  }
}

const HELP = [
  'ДАЛЬНОБІЙНИКИ. Ви — водій вантажівки. Заробляйте на перевезеннях і гонках, купуйте кращі машини й запчастини, обійдіть суперників у рейтингу.',
  'КЕРУВАННЯ. Кермо — кнопки ◀ ▶ (або нахил телефона — «Опції» → «Керування»), газ ▲ і гальмо ▼ праворуч (можна поміняти місцями). Коробка автоматична; щоб поїхати назад — зупиніться й потримайте гальмо ▼. Угорі: «•••» — фари, дзеркало, навігація, двірники й двигун; сигнал, «↺» — відновитися, «👁» — камера. Клавіатура (як в оригіналі): стрілки — газ, гальмо й кермо; Shift — ручне гальмо; пробіл — заглушити чи завести двигун; L — фари; M — дзеркало; W — двірники; Tab — навігація; C — камера; H — сигнал; 0 або R — відновитися; у вікнах Enter — так, Esc — скасувати.',
  'БАЗА. Підʼїдьте до секції в залі «Завантаження» — зверху зʼявиться табличка товару й кнопки «+» та «−» (утримуйте). У залі «Автомобілі» — вантажівки на подіумах, у «Запчастинах» — покращення. Ремонт — кнопкою на табло бази. Виїзд на траси — тунелі за вказівником «Выезд»: над кожним видно назву траси й погоду.',
  'ТРАСИ. Кільце й Полігон — гонки на призи за місце (Полігон — між прапорцями за стрілками). Приморськ, Перелісся й Гірський — доставка: вантаж продається на фініші дорожче, ніж куплений; удари бʼють крихкий вантаж. У дощ слизько, але винагорода більша.',
  'СТАН МАШИНИ. Табло гравця (тапніть, щоб згорнути чи розгорнути): гроші, маса й обʼєм вантажу, стан машини, шин і гальм. У режимі «Симулятор» пошкоджена машина слабшає й втрачає передачі, зношені гальма гірше гальмують, лиса гума ковзає. У дорозі можна підремонтуватися до задовільного стану (кнопка «РЕМОНТ», утримувати на місці). Перевернулися — «ВІДНОВИТИСЯ» (платно).',
  'ЗАПЧАСТИНИ. ФД — потужніший двигун; АПС — менше пробуксовок; ШН — шини зношуються вдвічі повільніше; ПП — вантаж бʼється менше; НС — карта траси з суперниками; РС — вище сидіння; ДТ — гальма зношуються вдвічі повільніше.',
  'ГРА ЗБЕРІГАЄТЬСЯ автоматично для кожного водія в цьому браузері.',
].join('\n\n');

async function menuLoop(): Promise<void> {
  history.replaceState(null, '', location.pathname);
  stopDrive();
  await hudFonts(); // шрифт табло — і для вікон меню
  if (menuArt === undefined) menuArt = await MenuArt.load((n) => source.read(n));
  if (!menuArt) return fallbackMenu();
  const choice = await mainMenu(menuArt, {
    viewer: import.meta.env.DEV || !!ctx.exit,
    get driver() {
      return currentDriver();
    },
    onDriver: async () => {
      const names = [...new Set(listCareers().map((c) => c.name))];
      const n = await driverScreen(menuArt!, currentDriver(), names);
      if (n) setCurrentDriver(n);
    },
    onOptions: optionsDialog,
    onHelp: () => helpScreen(menuArt!, HELP),
  });
  if (choice === 'game') {
    await ensureTrucks();
    const driver = currentDriver();
    const pick = await newGameScreen(menuArt, listCareers(), driver);
    if (!pick) return menuLoop();
    if (pick.action === 'load') {
      const c = loadCareer(pick.name);
      return c ? startCareer(c) : menuLoop();
    }
    if (loadCareer(driver)) {
      const i = await modal(overlay, 'Нова гра', `У водія ${driver} вже є збережена гра. Почати заново?`, ['Почати заново', 'Скасувати']);
      if (i !== 0) return menuLoop();
    }
    return startCareer(newCareer({ name: driver, difficulty: pick.difficulty, rivals: pick.rivals, trucks: trucks.map(truckSpec) }));
  }
  if (choice === 'quick') {
    levelSel.value = 'CIRCUIT';
    selectTab('drive');
  } else if (ctx.exit) {
    // «Вихід» — до вибору гри (переглядач на ПК лишається за налагоджувальним посиланням ?tab=scene).
    return ctx.exit();
  } else selectTab('scene');
  await open();
}

/** Без LOAD.RES (немає файлу) — просте меню. */
async function fallbackMenu(): Promise<void> {
  document.body.classList.remove('in-menu'); // після екрана вибору гри
  const saved = loadCareer();
  const opts = saved ? ['Продовжити гру', 'Нова гра', 'Пробний заїзд'] : ['Нова гра', 'Пробний заїзд'];
  const i = await modal(overlay, 'Дальнобійники', 'Меню без графіки оригіналу (бракує LOAD.RES).', opts);
  const pick = saved ? i : i + 1;
  if (pick === 0 && saved) return startCareer(saved);
  if (pick === 1) {
    await ensureTrucks();
    return startCareer(newCareer({ name: currentDriver(), difficulty: 'sim', rivals: 3, trucks: trucks.map(truckSpec) }));
  }
  levelSel.value = 'CIRCUIT';
  selectTab('drive');
  await open();
}

/** Запуск: ?career=1 — продовжити кар'єру; ?tab=… — переглядач/швидкий заїзд (розробка); інакше — меню. */
async function startup(): Promise<void> {
  // Гравець при запуску — у головному меню; ?career=1 і ?tab=… — лише налагоджувальні посилання dev-сервера
  // (встановлена раніше гра на домашньому екрані стартувала з ?tab=drive — у standalone ігноруємо).
  if (debugLink) {
    const resume = params.get('career') ? loadCareer() : null;
    if (resume) return startCareer(resume);
    if (params.get('tab')) return open();
  }
  await menuLoop();
}
