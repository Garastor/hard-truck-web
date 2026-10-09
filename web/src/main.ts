import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { LEVELS, devServerSource, loadLevel, type LevelId, type LoadedLevel } from './assets/loader';
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
    level = await loadLevel(devServerSource, levelSel.value as LevelId, modeSel.value as 'hw' | 'sw');
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
  trucks = parseTrucks(decodeCp1251(await devServerSource.read('TRUCK.TCH')));
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
    drive = await DriveSession.start(scene, camera, built, def, overlay, level?.rmp);
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
$('fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else {
      await document.documentElement.requestFullscreen();
      await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {});
    }
  } catch {
    /* iOS Safari без Fullscreen API — ігноруємо */
  }
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
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
});

if (import.meta.env.DEV)
  Object.assign(window, { ht: { THREE, scene, camera, controls, get built() { return built; }, get level() { return level; }, get drive() { return drive; } } });

void open();
