import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LEVELS, devServerSource, loadLevel, type FileSource, type LevelId, type LoadedLevel } from './assets/loader';
import { idbSource, importFiles, importZip, missingFiles } from './assets/gameFiles';
import { blockPageZoom, enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen, toast, IOS_FULLSCREEN_HINT } from './ui/mobile';
import { buildScene, type BuiltScene } from './render/sceneBuilder';
import { parseTxr } from './formats/txr';
import { parseMsk } from './formats/msk';
import { parsePlm } from './formats/plm';
import type { RgbaImage } from './formats/binary';
import { decodeCp1251 } from './formats/binary';
import { buildTruckModel, parseTrucks, type TruckDef } from './game/trucks';
import type { DriveSession } from './modes/drive';

/**
 * Переглядач ресурсів (Фази 1–2): обліт локацій, галерея текстур і масок.
 * Стан (локація/вкладка) зберігається в URL: ?level=CIRCUIT&mode=hw&tab=scene
 */

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view');
const levelSel = $<HTMLSelectElement>('level');
const modeSel = $<HTMLSelectElement>('mode');
const stats = $('stats');
const gallery = $('gallery');
const status = $('status');
const truckSel = $<HTMLSelectElement>('truck');
const overlay = $('overlay');

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fb4d8);
scene.fog = new THREE.Fog(0x8fb4d8, 400, 2500);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 5000);
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
const truckRoot = new THREE.Group();
truckRoot.rotation.x = -Math.PI / 2;
scene.add(truckRoot);

const params = new URLSearchParams(location.search);
for (const id of Object.keys(LEVELS)) levelSel.add(new Option(id, id));
levelSel.value = params.get('level') ?? 'CIRCUIT';
modeSel.value = params.get('mode') ?? 'hw';

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

function setStatus(text: string | null): void {
  status.hidden = !text;
  status.textContent = text ?? '';
}

function syncUrl(): void {
  const p = new URLSearchParams({ level: levelSel.value, mode: modeSel.value, tab });
  if (tab === 'trucks' || tab === 'drive') p.set('truck', truckSel.value);
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
    level = await loadLevel(source, levelSel.value as LevelId, modeSel.value as 'hw' | 'sw');
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
    applyTab();
    setStatus(null);
  } catch (e) {
    console.error(e);
    setStatus(`Помилка: ${(e as Error).message}`);
  }
}

async function ensureTrucks(): Promise<void> {
  if (trucks.length) return;
  trucks = parseTrucks(decodeCp1251(await source.read('TRUCK.TCH')));
  for (const t of trucks) truckSel.add(new Option(`${t.carNode} (${t.tech.horsePower} к.с., $${t.tech.price})`, String(t.index)));
  truckSel.value = params.get('truck') ?? '1';
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
    const def = trucks.find((t) => String(t.index) === truckSel.value) ?? trucks[0];
    controls.enabled = false;
    scene.fog = new THREE.Fog(0x8fb4d8, 150, 900);
    // Rapier (WASM ~2 МБ) вантажимо лише при вході в режим їзди.
    const { DriveSession } = await import('./modes/drive');
    // Суперники: кількість з ?ai= (за замовчуванням 3, як aicar у truck.ini), інші моделі вантажівок.
    const nAi = Number(params.get('ai') ?? 3);
    // Правила з довідки: Кольцо — 3 кола; Полигон — поодинці; комерційні — до фінішу; база — вільна їзда.
    const id = levelSel.value as LevelId;
    const kind = id === 'CIRCUIT' ? 'laps' : id === 'MENU3D' ? 'free' : 'route';
    const rivals = id === 'TRIAL' || id === 'MENU3D' ? [] : trucks.filter((t) => t !== def).slice(0, nAi);
    drive = await DriveSession.start(scene, camera, built, def, overlay, level?.rmp, rivals, kind);
    setStatus(null);
  } catch (e) {
    console.error(e);
    setStatus(`Помилка: ${(e as Error).message}`);
  } finally {
    driveStarting = false;
  }
}

/** Показує/ховає обʼєкти відповідно до вкладки. */
function applyTab(): void {
  gallery.hidden = tab === 'scene' || tab === 'trucks' || tab === 'drive';
  stats.hidden = !(tab === 'scene' || tab === 'trucks');
  truckSel.hidden = tab !== 'trucks' && tab !== 'drive';
  if (built) built.root.visible = tab === 'scene' || tab === 'drive';
  truckRoot.visible = tab === 'trucks';
  document.body.classList.toggle('driving', tab === 'drive');
  $('menu').hidden = tab !== 'drive';
  if (tab !== 'drive') stopDrive();
  else void startDrive();
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
    applyTab();
    if (tab === 'textures' || tab === 'masks') showGallery();
  });
}
const initialTab = params.get('tab');
if (initialTab && initialTab !== 'scene') document.querySelector<HTMLButtonElement>(`[data-tab="${initialTab}"]`)?.click();

levelSel.addEventListener('change', open);
// У режимі їзди панель згорнута; кнопка ☰ тимчасово її показує.
$('menu').addEventListener('click', () => document.body.classList.toggle('bar-open'));
truckSel.addEventListener('change', () => (tab === 'drive' ? void startDrive() : showTruck()));
modeSel.addEventListener('change', open);
$('fullscreen').addEventListener('click', () => void toggleFullscreen());
async function toggleFullscreen(): Promise<void> {
  if (isFullscreen()) return exitFullscreen();
  if (!(await enterFullscreen())) toast(IOS_FULLSCREEN_HINT);
}
blockPageZoom();
// На телефоні гра сама переходить на весь екран при першому дотику в режимі їзди
// (браузер дозволяє це лише з обробника дотику).
let autoFullscreenTried = false;
document.addEventListener('pointerup', (e) => {
  if (autoFullscreenTried || e.pointerType !== 'touch' || tab !== 'drive' || isFullscreen()) return;
  autoFullscreenTried = true;
  if (fullscreenSupported()) void enterFullscreen();
  else toast(IOS_FULLSCREEN_HINT, 9000);
});

const clock = new THREE.Clock();
// Пауза, коли вкладку згорнуто (економія батареї); після повернення не «надолужуємо» час.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) renderer.setAnimationLoop(null);
  else {
    clock.getDelta();
    renderer.setAnimationLoop(loop);
  }
});
function loop(): void {
  const dt = clock.getDelta();
  if (tab === 'drive') {
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
renderer.setAnimationLoop(loop);

if (import.meta.env.DEV)
  Object.assign(window, { ht: { THREE, scene, camera, controls, get built() { return built; }, get level() { return level; }, get drive() { return drive; }, importZip, missingFiles, idbSource } });

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

/** Екран першого запуску: оберіть HardTruck.zip або теку гри. */
function showImport(missing: string[]): Promise<void> {
  return new Promise((resolve) => {
    status.hidden = false;
    status.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'import-box';
    box.innerHTML = `
      <h2>Файли гри</h2>
      <p>Для гри потрібні файли оригінальних «Дальнобійників» (≈ 66 МБ, файлів: ${missing.length}).
      Оберіть архів <b>HardTruck.zip</b> або теку встановленої гри — файли залишаться лише на цьому пристрої.</p>
      <label class="btn">Обрати ZIP<input type="file" accept=".zip,application/zip" hidden></label>
      <label class="btn">Обрати теку гри<input type="file" webkitdirectory multiple hidden></label>
      <progress max="1" value="0" hidden></progress>
      <p class="msg"></p>`;
    status.append(box);
    const [zipIn, dirIn] = box.querySelectorAll('input');
    const bar = box.querySelector('progress')!;
    const msg = box.querySelector('.msg')!;
    const progress = (m: string, f: number) => {
      bar.hidden = false;
      bar.value = f;
      msg.textContent = m;
    };
    const finish = async () => {
      const left = await missingFiles();
      if (left.length) msg.textContent = `Бракує файлів: ${left.join(', ')}`;
      else {
        status.innerHTML = '';
        resolve();
      }
    };
    zipIn.addEventListener('change', async () => {
      if (zipIn.files?.[0]) await importZip(zipIn.files[0], progress).catch((e) => (msg.textContent = String(e)));
      await finish();
    });
    dirIn.addEventListener('change', async () => {
      if (dirIn.files) await importFiles(dirIn.files, progress).catch((e) => (msg.textContent = String(e)));
      await finish();
    });
  });
}

async function boot(): Promise<void> {
  if (params.get('source') !== 'local' && (await devServerAvailable())) source = devServerSource;
  else {
    void navigator.storage?.persist?.();
    const missing = await missingFiles();
    if (missing.length) await showImport(missing);
    source = idbSource;
  }
  await open();
}

// PWA: офлайн-кеш коду (лише у збірці й у захищеному контексті — HTTPS/localhost).
if (import.meta.env.PROD && 'serviceWorker' in navigator && isSecureContext) {
  void navigator.serviceWorker.register('./sw.js');
}

void boot();
