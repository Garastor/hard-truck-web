/**
 * Оболонка порту: рендерер на canvas `#view`, вибір гри (коли їх кілька), імпорт файлів гри на пристрій і запуск
 * гри (games/<id>/index.ts → GameModule.run). Самі ігри — у games/, спільний рушій — у engine/
 * (Docs/09-structure-plan.md).
 */
import * as THREE from 'three';
import { importFiles, importZip, missingFiles, zipNames, type FileSet as AnyFileSet } from '@shared/gameStore';
import type { GameModule, SelectArt, TextFont } from '@shared/gameContext';
import { isIos, isStandalone, registerServiceWorker } from './platform/pwa';
import { QUALITY, loadQuality } from './platform/quality';
import { blockPageZoom } from './platform/mobile';
import { watchNotch } from './platform/notch';
import { uiScale } from './platform/scale';
import { setSoftFont } from './platform/softUi';
import { GAMES, GAME_IDS, detectGame, gameFromLocation, lastGame, setLastGame, type GameId } from './registry';
import { ht1 } from '@ht1/index';
import { ht2 } from '@ht2/index';

type FileSet = AnyFileSet<GameId>;

const GAME_MODULES: Record<GameId, GameModule> = { ht1, ht2 };
const FILE_SETS = Object.fromEntries(GAME_IDS.map((id) => [id, GAME_MODULES[id].files])) as Record<GameId, FileSet>;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = $('status');
const overlay = $('overlay');
const params = new URLSearchParams(location.search);

/**
 * Рендерер — спільний для ігор, створюється після вибору гри: згладжування — як хоче гра (GameModule.antialias), інакше
 * за якістю з «Опцій» (змінюється з перезавантаженням).
 */
function makeRenderer(game: GameModule): THREE.WebGLRenderer {
  const quality = QUALITY[loadQuality()];
  const antialias = game.antialias?.() ?? quality.antialias;
  const renderer = new THREE.WebGLRenderer({ canvas: $<HTMLCanvasElement>('view'), antialias, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.dpr));
  return renderer;
}

// Сенсорні кнопки й відступи на малому екрані — пропорційно менші (style.css: var(--ui)).
function setUiScale(): void {
  document.documentElement.style.setProperty('--ui', String(uiScale()));
}
window.addEventListener('resize', setUiScale);
setUiScale();
blockPageZoom();
watchNotch();
rememberMute();
// Кермо й педалі місцями (налаштування спільне для ігор; ключ — той самий, що в керуванні ігор).
document.body.classList.toggle('swap-controls', loadSwap());

/** Тестова вкладка без звуку (?mute) — на всю сесію вкладки (ігри читають ht.mute зі sessionStorage). */
function rememberMute(): void {
  try {
    if (import.meta.env.DEV && new URLSearchParams(location.search).has('mute')) sessionStorage.setItem('ht.mute', '1');
  } catch {
    /* приватний режим */
  }
}

function loadSwap(): boolean {
  try {
    return localStorage.getItem('ht.swapControls') === '1';
  } catch {
    return false;
  }
}

function setStatus(text: string | null): void {
  status.hidden = !text;
  status.textContent = text ?? '';
}

/**
 * Екран імпорту файлів гри: перший запуск (бракує файлів) або повторний імпорт з «Опцій» (again — з кнопкою
 * «Скасувати», поверх меню). На iPhone у Safari — підказка спершу встановити гру на головний екран: у застосунку
 * з головного екрана окреме сховище, файли, імпортовані в Safari, він не побачить.
 * set — яку гру чекаємо (null — будь-яку). Гру впізнаємо за вмістом архіву чи теки: файли іншої гри теж
 * зберігаються (під її префіксом). Результат — гра, файли якої тепер повні (null — скасовано).
 */
function showImport(set: FileSet | null, again = false): Promise<GameId | null> {
  return new Promise((resolve) => {
    status.hidden = false;
    status.innerHTML = '';
    status.classList.toggle('over-menu', again);
    const box = document.createElement('div');
    box.className = 'import-box';
    const iosHint =
      isIos() && !isStandalone()
        ? `<p class="hint">На iPhone спершу встановіть гру: «Поділитися» → «На початковий екран», відкрийте її з іконки
      й оберіть файли вже там — у Safari й на головному екрані окремі сховища.</p>`
        : '';
    const what = !set
      ? 'Для гри потрібні файли оригінальних «Дальнобійників» (≈ 66 МБ) або «Дальнобійників 2» (≈ 150 МБ). Оберіть архів чи теку встановленої гри —'
      : set.game === 'ht2'
        ? `Для гри потрібні файли «Дальнобійників 2» (≈ 150 МБ, файлів: ${set.required.length}). Оберіть архів або теку встановленої гри (GOG, диск) —`
        : `Для гри потрібні файли оригінальних «Дальнобійників» (≈ 66 МБ, файлів: ${set.required.length}). Оберіть архів <b>HardTruck.zip</b> або теку встановленої гри —`;
    box.innerHTML = `
      <h2>Файли гри${set ? ` — ${GAMES[set.game].title}` : ''}</h2>
      <p>${again ? 'Імпорт замінить файли гри на цьому пристрої. ' : ''}${what} файли залишаться лише на цьому пристрої;
      далі гра працює без інтернету.</p>
      ${iosHint}
      <label class="btn">Обрати ZIP<input type="file" accept=".zip,application/zip" hidden></label>
      <label class="btn">Обрати теку гри<input type="file" webkitdirectory multiple hidden></label>
      ${again ? '<button class="btn cancel">Скасувати</button>' : ''}
      <progress max="1" value="0" hidden></progress>
      <p class="msg"></p>`;
    status.append(box);
    const close = (got: GameId | null) => {
      status.innerHTML = '';
      status.hidden = true;
      status.classList.remove('over-menu');
      resolve(got);
    };
    box.querySelector('.cancel')?.addEventListener('click', () => close(null));
    const [zipIn, dirIn] = box.querySelectorAll('input');
    const bar = box.querySelector('progress')!;
    const msg = box.querySelector('.msg')!;
    const progress = (m: string, f: number) => {
      bar.hidden = false;
      bar.value = f;
      msg.textContent = m;
    };
    // Гра за вмістом: невпізнане — та, яку чекаємо (або перша).
    const target = (names: Iterable<string>) => FILE_SETS[detectGame(names) ?? set?.game ?? 'ht1'];
    const finish = async (got: FileSet) => {
      const left = await missingFiles(got);
      if (left.length) msg.textContent = `Бракує файлів: ${left.join(', ')}`;
      else if (set && got !== set) msg.textContent = `Це файли «${GAMES[got.game].title}» — збережено. Для «${GAMES[set.game].title}» оберіть її архів чи теку.`;
      else close(got.game);
    };
    zipIn.addEventListener('change', async () => {
      const zip = zipIn.files?.[0];
      if (!zip) return;
      const got = target(await zipNames(zip).catch(() => []));
      await importZip(zip, progress, got).catch((e) => (msg.textContent = String(e)));
      await finish(got);
    });
    dirIn.addEventListener('change', async () => {
      if (!dirIn.files) return;
      const files = [...dirIn.files];
      const got = target(files.map((f) => f.webkitRelativePath || f.name));
      await importFiles(files, progress, got).catch((e) => (msg.textContent = String(e)));
      await finish(got);
    });
  });
}

/** Чи є гра на dev-сервері ПК (файли за /game/ чи /game2/). */
async function devHas(id: GameId): Promise<boolean> {
  try {
    const r = await fetch(`${GAMES[id].devPrefix}${GAMES[id].devProbe}`, { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('html');
  } catch {
    return false;
  }
}

/** Ігри, доступні зараз: повністю імпортовані на пристрій або на dev-сервері ПК. */
async function availableGames(): Promise<GameId[]> {
  const ok = await Promise.all(
    GAME_IDS.map(async (id) => (await missingFiles(FILE_SETS[id]).catch(() => [''])).length === 0 || (params.get('source') !== 'local' && (await devHas(id)))),
  );
  return GAME_IDS.filter((_, i) => ok[i]);
}

/** Вихід до вибору гри: головна адреса порту (без теки-входу /ht1/, /ht2/ і параметрів) — з перезавантаженням. */
function exitToGameSelect(): void {
  location.assign(location.pathname.replace(/ht[12]\/(index\.html)?$/i, ''));
}

/**
 * Гра не запустилась (помилка в коді гри чи її файлах): повідомлення з причиною замість технічної панелі першої гри
 * (вона в index.html спільна й лишалася б на екрані сама). id — null, якщо збій ще до вибору гри.
 */
function showStartError(id: GameId | null, e: unknown): void {
  console.error('Гра не запустилась', e);
  document.body.classList.add('booting');
  status.hidden = false;
  status.innerHTML = '';
  status.classList.add('over-menu');
  const box = document.createElement('div');
  box.className = 'import-box';
  const h = document.createElement('h2');
  h.textContent = id ? `Не вдалося запустити «${GAMES[id].title}»` : 'Не вдалося запустити гру';
  const p = document.createElement('p');
  p.textContent = 'Гра зупинилась під час запуску. Спробуйте ще раз; якщо не допоможе — поверніться до вибору гри.';
  // Причина — для звіту про помилку (текст винятку, без стека).
  const why = document.createElement('p');
  why.className = 'msg';
  why.textContent = e instanceof Error ? e.message : String(e);
  const retry = document.createElement('button');
  retry.className = 'btn';
  retry.textContent = 'Спробувати ще';
  retry.addEventListener('click', () => location.reload());
  box.append(h, p, why, retry);
  if (GAME_IDS.length > 1) {
    const back = document.createElement('button');
    back.className = 'btn';
    back.textContent = 'До вибору гри';
    back.addEventListener('click', exitToGameSelect);
    box.append(back);
  }
  status.append(box);
}

/** Графіка ігор для екрана вибору (фон меню й шрифти — з файлів самої гри, GameModule.selectArt). */
async function chooseGame(ids: readonly GameId[], available: GameId[]): Promise<GameId> {
  const arts = new Map<GameId, SelectArt>();
  await Promise.all(available.map(async (id) => arts.set(id, await GAME_MODULES[id].selectArt().catch(() => ({ background: null, small: null, large: null })))));
  // Шрифти — першої гри, що їх має.
  const pick = (k: 'small' | 'large'): TextFont | null => available.map((id) => arts.get(id)?.[k] ?? null).find((f) => f) ?? null;
  const fonts = { small: pick('small'), large: pick('large') };
  setSoftFont(fonts.small);
  const { gameSelectScreen } = await import('./select');
  const cards = ids.map((id) => ({ meta: GAMES[id], art: arts.get(id)?.background ?? null, missing: !available.includes(id) }));
  return gameSelectScreen(cards, fonts, lastGame());
}

/**
 * Відкрито з налагоджувального посилання першої гри (?tab=… або ?career=1 на dev-сервері) — без вибору гри, як до
 * появи другої.
 */
const debugLink = import.meta.env.DEV && !isStandalone() && (params.has('tab') || params.has('career'));

async function boot(): Promise<void> {
  void navigator.storage?.persist?.();
  const games = await availableGames();
  let game: GameId | null = gameFromLocation() ?? (debugLink ? 'ht1' : null);
  // Вибір гри — завжди з усіма іграми; ще не імпортовану — імпорт, далі файли вже на пристрої.
  while (!game) {
    const pick = await chooseGame(GAME_IDS, games);
    if (games.includes(pick)) game = pick;
    else if ((await showImport(FILE_SETS[pick], true)) === pick) game = pick;
  }
  setLastGame(game);
  // Технічна панель першої гри (index.html: #bar, #menu, #stats) — лише для неї: до запуску не показуємо
  // (body.booting), щоб не блимала, поки шукаємо файли й готуємо екран вибору; друга гра її не використовує — інакше
  // вона видна, поки вантажиться код другої гри.
  const id = game;
  if (id === 'ht1') document.body.classList.remove('booting');
  try {
    await GAME_MODULES[id].run({
      renderer: makeRenderer(GAME_MODULES[id]),
      overlay,
      setStatus,
      showImport: async (again) => (await showImport(FILE_SETS[id], again)) === id,
      exit: GAME_IDS.length > 1 ? exitToGameSelect : null,
    });
  } catch (e) {
    showStartError(id, e);
  }
}

// PWA: офлайн-кеш коду й оновлення (лише у збірці й у захищеному контексті — HTTPS/localhost).
registerServiceWorker();

boot().catch((e: unknown) => showStartError(null, e));
