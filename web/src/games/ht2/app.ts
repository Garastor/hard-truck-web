import * as THREE from 'three';
import { installVertexFog } from './engine/render/vertexFog';
import { installVertexLighting } from './engine/render/vertexLighting';
import { installHeadlightShading } from './vehicles/headlights';
import { cachedSource, idbSourceFor, missingFiles, prefetchMissing, removeFiles, storedFiles } from '@shared/gameStore';
import type { FileSource } from '@shared/source';
import { setSoftFont } from './engine/ui/softUi';
import { parseFon } from './engine/formats/fon';
import { PixelFont } from './engine/ui/pixelFont';
import type { GameContext } from '@shared/gameContext';
import { HT2_FILES, HT2_MODS, HT2_MUSIC, HT2_REQUIRED, HT2_UI, HT2_VIDEO, ht2DevSource } from './files';
import { Ht2MenuArt, ht2ExitScreen, ht2MainScreen, ht2MenuScreen, ht2SingleScreen, type MenuItem, type RoundKey } from './ui/menu';
import { Input } from './engine/input/input';
import { setFx } from './ui/effects';
import { ht2ControlsScreen, ht2DriversScreen, ht2GraphicsScreen, ht2RecordsScreen } from './ui/menuScreens';
import { loadSettings, saveSettings, type Ht2Settings } from './ui/settings';
import { parseIni } from './engine/formats/ini';
import { decodeCp1251 } from './engine/formats/binary';
import { WorldViewer } from './ui/viewer';
import { Ht2Drive } from './drive';
import { DEFAULT_DRIVER, currentDriver, deleteDriver, formatMoney, listDrivers, listSaves, loadCareer, newCareer, putDriver, selectDriver, type Ht2Career } from './career/career';
import { modal, setHudFont } from './engine/ui/modal';
import { DEFAULT_CAR, ht2NetMenu, type NetStart } from './ui/netScreens';
import type { NetCar } from './net/peer';
import type { NetSession } from './net/session';
import { joinNetCareer, joinNetDrive } from './netPlay';
import type { Arena } from './world/world';

type Choice = 'world' | 'drive' | 'race' | 'career' | 'new' | 'single' | 'files' | 'exit' | 'net';

/** Налагодження: ?tab=race&arena=MTR&course=trial — гонка на арені мережевої гри без мережі. */
function arenaParam(v: string | null): Arena | null {
  return v === 'MENV' || v === 'MTR' || v === 'MTB' ? v : null;
}

/**
 * Мережева кар'єра водія (М6): окреме збереження `net-<водій>` з позначкою net (у списку збережень одиночної гри його
 * немає); немає — нова, з машиною з екрана «Мережева гра».
 */
function netCareer(driver: string, truck: string): Ht2Career {
  const id = `net-${driver}`;
  const c = loadCareer(id) ?? { ...newCareer(driver, truck), id, net: true };
  const d = listDrivers().find((x) => x.name === driver);
  if (d) Object.assign(c, { logo: d.logo, photo: d.photo });
  return c;
}

/** Машина мережевої гри (екран n/backMult) — запамʼятовується в браузері. */
const NET_CAR_KEY = 'ht2.netcar.v1';
function loadNetCar(): NetCar {
  try {
    const v = JSON.parse(localStorage.getItem(NET_CAR_KEY) ?? 'null') as NetCar | null;
    if (v && typeof v.truck === 'string' && typeof v.color === 'number') return { truck: v.truck, color: v.color & 3 };
  } catch {
    // немає сховища — типова машина
  }
  return { ...DEFAULT_CAR };
}
function saveNetCar(car: NetCar): void {
  try {
    localStorage.setItem(NET_CAR_KEY, JSON.stringify(car));
  } catch {
    // приватний режим — не запамʼятовуємо
  }
}

/**
 * Дальнобойщики 2 у порті: джерело файлів (пристрій або ПК), меню з LOAD.RES гри, режими. Свій цикл кадрів і сцена —
 * рендерер — від оболонки (app/main.ts); технічна панель першої гри схована (body.game-ht2).
 */
/** Контекст запуску від оболонки (app/main.ts). */
export type Ht2Context = GameContext;

/**
 * Верхній екран меню: «Водії», «Графіка» тощо відкриваються поверх головного окремим `.ht2-menu`, і вікно, додане до
 * першого з них (головного), лишалося під екраном — невидиме й ненатискне («Видалити водія»).
 */
function topMenu(): HTMLElement {
  const all = document.querySelectorAll<HTMLElement>('.ht2-menu');
  return all[all.length - 1]!;
}

async function devAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/game2/vehicle.tech', { method: 'HEAD' });
    return r.ok && !(r.headers.get('content-type') ?? '').includes('html');
  } catch {
    return false;
  }
}

/**
 * Джерело файлів: з пристрою (IndexedDB), а чого там немає — з ПК із записом на пристрій (необовʼязкова музика
 * теж). Без ПК і без повного набору — імпорт.
 */
async function pickSource(ctx: Ht2Context): Promise<FileSource> {
  const params = new URLSearchParams(location.search);
  const local = idbSourceFor(HT2_FILES);
  if (params.get('source') !== 'local' && (await devAvailable())) {
    void prefetchMissing(ht2DevSource, HT2_FILES);
    return cachedSource(ht2DevSource, HT2_FILES);
  }
  const missing = await missingFiles(HT2_FILES).catch(() => HT2_FILES.required);
  if (missing.length) await ctx.showImport(false);
  return local;
}

/**
 * «Файли гри»: що вже є на пристрої (зокрема необовʼязкові — графіка інтерфейсу esc16.RES, описи регіонів, музика)
 * і повторний імпорт — поверх наявних або з нуля (спершу видалити всі файли другої гри).
 */
async function manageFiles(ctx: Ht2Context): Promise<void> {
  const have = await storedFiles().catch(() => new Set<string>());
  const count = (list: readonly string[]) => list.filter((f) => have.has(HT2_FILES.prefix + f)).length;
  const status = [
    `Основні файли: ${count(HT2_REQUIRED)} з ${HT2_REQUIRED.length}`,
    `Графіка інтерфейсу (COMMON/esc16.RES): ${count(HT2_UI) ? 'є' : 'немає'}`,
    `Описи регіонів: ${count(HT2_MODS)} з ${HT2_MODS.length}`,
    `Музика: ${count(HT2_MUSIC)} з ${HT2_MUSIC.length}`,
    `Ролики подій (*.bne): ${count(HT2_VIDEO)} з ${HT2_VIDEO.length}`,
    '',
    '«Імпортувати» додасть файли чи замінить наявні. «З нуля» спершу видалить з пристрою всі файли «Дальнобійників 2».',
  ].join('\n');
  const i = await modal(ctx.overlay, 'Файли гри', status, ['Імпортувати', 'З нуля', 'Назад']);
  if (i === 0) await ctx.showImport(true);
  if (i !== 1) return;
  if ((await modal(ctx.overlay, 'Імпорт з нуля', 'Видалити всі файли гри з пристрою й обрати їх заново? Збережена гра лишиться.', ['Видалити й обрати', 'Скасувати'])) !== 0) return;
  await removeFiles(HT2_FILES);
  // Без файлів гра не працює — вікно імпорту без «Скасувати».
  await ctx.showImport(false);
}

export async function runHt2(ctx: Ht2Context): Promise<void> {
  document.body.classList.add('game-ht2');
  document.title = 'Дальнобойщики 2';
  // Гра — ландшафтна (сцени 800×600, табло на всю ширину); iPhone у браузері орієнтацію не фіксує — у портреті на
  // сенсорному екрані підказка повернути телефон (ht2.css, лише CSS-правилом).
  const rotate = document.createElement('div');
  rotate.className = 'ht2-rotate';
  rotate.setAttribute('role', 'alert');
  rotate.innerHTML =
    '<svg viewBox="0 0 48 48" width="64" height="64" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><rect x="15" y="6" width="18" height="32" rx="3"/><path d="M22 33h4"/><path d="M38 30a14 14 0 0 1-12 12" /><path d="M24 39l2 3-3 2"/></svg>' +
    '<p>Поверніть телефон горизонтально</p>';
  document.body.append(rotate);
  // Світло king.exe (Direct3D) рахується просто в кольорах екрана: текстура × (розсіяне + сонце·cos), до 1. Лінійний
  // простір three.js (sRGB → лінійне → sRGB) робив розсіяне 80/255 вчетверо слабшим, а суму — темнішою: асфальт 66
  // замість 106 (текстура 112). Тож у другій грі — без керування кольором: текстури й кольори як є, вихід без
  // перетворення (вихід до вибору гри перезавантажує сторінку, першу гру це не зачіпає).
  THREE.ColorManagement.enabled = false;
  ctx.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  installVertexFog();
  installHeadlightShading();
  // Після туману: дописує свій підрахунок у fog_vertex.
  installVertexLighting();
  ctx.setStatus('Завантаження «Дальнобійників 2»…');
  const source = await pickSource(ctx);
  const font = (name: string) => source.read(name).then((b) => new PixelFont(parseFon(b))).catch(() => null);
  const [large, small] = await Promise.all([font('LARGE.FON'), font('MENU.FON')]);
  // Шрифт вікон і написів сенсорних кнопок (MENU.FON) — свій у кожної гри.
  setHudFont(small);
  setSoftFont(small);
  const art = await Ht2MenuArt.load((n) => source.read(n));
  // Налаштування одиночної гри: збережені в браузері, інакше — з TRUCK.INI гри.
  const ini = await source.read('TRUCK.INI').then((b) => parseIni(decodeCp1251(b))).catch(() => null);
  let settings: Ht2Settings = loadSettings(ini);
  Input.bind(settings.keys);
  setFx(settings.effects, settings.detail);
  ctx.setStatus(null);

  // Налагодження: ?game=ht2&tab=world — одразу огляд світу (&region=ab); &tab=drive — вільна їзда (&truck=Kamaz);
  // &tab=career — кар'єра.
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  let direct: Choice | null = tab === 'world' || tab === 'drive' || tab === 'career' || tab === 'race' || tab === 'net' ? tab : null;
  // Збереження, яке завантажити («Завантажити гру» на екрані «Гра»; у меню Esc — збереження поточної гри).
  let loadId: string | undefined;
  // Мережева гра: сесія, до якої повернутися із заїзду, і заїзд, який почав сервер, поки ми ще їхали.
  let netFrom: NetSession | null = null;
  let netNext: NetStart | null = null;
  for (;;) {
    const driver = currentDriver();
    const note = driver ? `За кермом: ${driver.name}` : 'Дальнобойщики 2 — порт у розробці';
    // Кругла кнопка рамки → дія (null — лишитися в меню). «Демо» — режими порту (вільна їзда, гонка, огляд, файли).
    const round = async (key: RoundKey, parent: HTMLElement): Promise<Choice | null> => {
      if (key === 'singl') return 'single';
      if (key === 'multi' && art) return 'net';
      if (key === 'exit') {
        if (ctx.exit) return 'exit';
        await modal(parent, 'Вихід з гри', 'Щоб вийти, закрийте вкладку чи застосунок.', ['Гаразд']);
        return null;
      }
      if (key === 'demo') {
        const modes: [string, Choice][] = [
          ['Вільна їзда', 'drive'],
          ['Гонка на Кільці', 'race'],
          ['Огляд світу', 'world'],
          ['Файли гри', 'files'],
        ];
        const i = await modal(parent, 'Демо', 'Режими порту без кар\'єри:', [...modes.map((m) => m[0]), 'Назад']);
        return modes[i]?.[1] ?? null;
      }
      // Екрани LOAD.RES «Графіка», «Керування», «Водії», «Відеоплеєр» (ui/menuScreens.ts): поверх меню; кругла кнопка
      // рамки — інший розділ.
      if (art && (key === 'graph' || key === 'contr' || key === 'chang' || key === 'recor')) {
        const next = await new Promise<RoundKey | null>((resolve) => {
          let close = () => {};
          const done = (k: RoundKey | null) => {
            close();
            resolve(k);
          };
          const common = { onCancel: () => done(null), onRound: (k: RoundKey) => done(k === key ? null : k) };
          if (key === 'graph')
            close = ht2GraphicsScreen(art, {
              ...common,
              settings,
              onChange: (st) => {
                settings = st;
                saveSettings(st);
                setFx(st.effects, st.detail);
              },
            });
          else if (key === 'contr')
            close = ht2ControlsScreen(art, {
              ...common,
              keys: settings.keys ?? {},
              onChange: (keys) => {
                settings = { ...settings, keys };
                saveSettings(settings);
                Input.bind(keys);
              },
            });
          else if (key === 'recor') close = ht2RecordsScreen(art, common);
          else {
            // Водії (king.exe `<імʼя>.pl1`): нове імʼя в полі — новий водій, вибір у списку — поточний.
            close = ht2DriversScreen(art, {
              ...common,
              drivers: listDrivers,
              current: () => currentDriver()?.name ?? null,
              onPut: putDriver,
              onSelect: selectDriver,
              onDelete: (name) =>
                modal(topMenu(), 'Видалити водія', `Стерти водія «${name}» і всі його збережені ігри?`, ['Видалити', 'Ні']).then((i) => {
                  if (i !== 0) return false;
                  deleteDriver(name);
                  return true;
                }),
            });
          }
        });
        return next ? round(next, parent) : null;
      }
      await modal(parent, 'Меню', 'Цей розділ у порті ще недоступний.', ['Гаразд']);
      return null;
    };
    const choice =
      direct ??
      (await new Promise<Choice>((resolve) => {
        if (art) {
          // Головне меню оригіналу: рамка common.msk, у центрі m/back_main, круглі кнопки.
          let busy = false;
          const close = ht2MainScreen(art, {
            note,
            onRound: (key) => {
              if (busy) return;
              busy = true;
              void round(key, topMenu()).then((c) => {
                busy = false;
                if (!c) return;
                close();
                resolve(c);
              });
            },
          });
          return;
        }
        let close = () => {};
        const pick = (c: Choice) => () => {
          close();
          resolve(c);
        };
        const items: MenuItem[] = [
          { label: 'Нова гра', action: pick('new') },
          { label: 'Вільна їзда', action: pick('drive') },
          { label: 'Гонка на Кільці', action: pick('race') },
          { label: 'Огляд світу', action: pick('world') },
          { label: 'Файли гри', action: pick('files') },
        ];
        if (ctx.exit) items.push({ label: 'Вихід', action: pick('exit') });
        close = ht2MenuScreen(art, large, items, note);
      }));
    direct = null;
    if (choice === 'exit') {
      // Підтвердження — екран оригіналу «ВЫЙТИ ИЗ ИГРЫ».
      if (art && !(await ht2ExitScreen(art))) continue;
      return ctx.exit?.();
    }
    if (choice === 'single' && art) {
      // Екран одиночної гри оригіналу: нова гра / завантажити, режим, повзунки; круглі кнопки — інші розділи.
      // Збереження — заново: у меню «Водії» водія з його іграми могли стерти вже після того, як відкрилось меню.
      // Список — усіх водіїв, найновіші першими; стрілки гортають.
      const saves = listSaves()
        .filter((c) => !c.net)
        .map((c) => ({ id: c.id!, text: `${c.driver}\n${formatMoney(c.money)}\nдоставок: ${c.delivered}` }));
      const next = await new Promise<Choice | null>((resolve) => {
        let busy = false;
        const close = ht2SingleScreen(art, {
          saves,
          settings,
          onNew: () => (close(), resolve('new')),
          onLoad: (id) => {
            loadId = id;
            close();
            resolve('career');
          },
          onCancel: () => (close(), resolve(null)),
          onChange: (st) => {
            settings = st;
            saveSettings(st);
          },
          onRound: (key) => {
            if (busy || key === 'singl') return;
            busy = true;
            void round(key, topMenu()).then((c) => {
              busy = false;
              if (!c) return;
              close();
              resolve(c);
            });
          },
          note: (t, parent) => void modal(parent, 'Одиночна гра', t, ['Гаразд']),
        });
      });
      if (!next) continue;
      direct = next;
      continue;
    }
    if (choice === 'files') {
      await manageFiles(ctx);
      continue;
    }
    if (choice === 'net' && art) {
      // «Мережева гра»: вибір машини, сервер/клієнт, сесія (ui/netScreens.ts) → заїзд → назад до сесії.
      const driverName = currentDriver()?.name ?? DEFAULT_DRIVER;
      const start = netNext ?? (await ht2NetMenu(art, { driver: driverName, car: loadNetCar(), from: netFrom, onCar: saveNetCar }));
      netNext = null;
      netFrom = null;
      if (!start) continue;
      if (typeof start === 'string') {
        const c = await round(start, ctx.overlay);
        if (c) direct = c;
        continue;
      }
      await new Promise<void>((resolve) => {
        let drive: Ht2Drive | null = null;
        let unlink = () => {};
        let ended = false;
        const end = (why: string) => {
          if (ended) return;
          ended = true;
          console.info('HT2 мережа: кінець заїзду —', why);
          unlink();
          drive?.dispose();
          ctx.setStatus(null);
          if (!start.session.closed) netFrom = start.session;
          direct = 'net';
          resolve();
        };
        const { session } = start;
        const myId = session.myId;
        const mine = start.players.find((p) => p.id === myId) ?? session.me;
        const players = start.players.map((p) => ({ id: p.id, name: p.name, truck: p.truck, color: p.color }));
        const track = start.setup.track;
        const common = {
          renderer: ctx.renderer,
          source,
          overlay: ctx.overlay,
          setStatus: ctx.setStatus,
          // Будь-який вихід з їзди (меню Esc) — до сесії.
          onExit: () => end('вихід з їзди'),
          color: mine.color,
        };
        // Мережева кар'єра (М6): своє збереження `net-<водій>` (окреме від одиночних), доба й погода — свої.
        const career = track === 'career' ? netCareer(driverName, mine.truck) : null;
        // Доба, погода й складність трас — сервера (однакові в усіх); звук, графіка й клавіші — свої.
        const netSettings: Ht2Settings = { ...settings, arcade: start.setup.arcade, traffic: start.setup.traffic, dayLength: start.setup.dayLength, weather: start.setup.weather };
        (career
          ? Ht2Drive.start({ ...common, career, netCareer: { myId, host: session.host, players, rivals: [] }, settings })
          : Ht2Drive.start({
              ...common,
              truck: mine.truck,
              race: true,
              // Арени king.exe (0x5125b0): Кільце — MENV, Тріал — MTR, Автобол — MTB.
              arena: track === 'trial' ? 'MTR' : track === 'ball' ? 'MTB' : 'MENV',
              course: track === 'career' ? 'ring' : track,
              net: { myId, host: session.host, players, rivals: start.rivals },
              settings: netSettings,
            })
        )
          .then((d) => {
            drive = d;
            if (ended) return d.dispose();
            Object.assign(window, { ht2: { drive, session } });
            unlink = (career ? joinNetCareer : joinNetDrive)(d, start, driverName, {
              onRestart: (next) => {
                netNext = next;
                end('сервер почав новий заїзд');
              },
              onLobby: () => end('до сесії'),
            });
          })
          .catch((e) => {
            console.error(e);
            ctx.setStatus(`Помилка: ${(e as Error).message}`);
            setTimeout(() => end('помилка'), 4000);
          });
      });
      continue;
    }
    if (choice === 'drive' || choice === 'career' || choice === 'new' || choice === 'race') {
      let career: Ht2Career | null = null;
      // Нова гра — окреме збереження поточного водія (немає водіїв — «Водій»); інші збереження лишаються.
      // Завантаження без вибраного (?tab=career) — найновіше. Логотип і фото — з профілю водія.
      if (choice === 'career') {
        career = loadCareer(loadId);
        // «Завантажити гру» в меню Esc у ще не збереженій новій грі — збереження немає: вибрати на екрані «Гра».
        if (!career && loadId && art) {
          loadId = undefined;
          direct = 'single';
          continue;
        }
      }
      if (choice === 'new' || (choice === 'career' && !career)) {
        const d = currentDriver() ?? { name: DEFAULT_DRIVER, logo: 4, photo: 0 };
        putDriver(d);
        career = newCareer(d.name, '');
      }
      if (career) {
        const name = career.driver;
        const d = listDrivers().find((x) => x.name === name);
        if (d) Object.assign(career, { logo: d.logo, photo: d.photo });
        else putDriver({ name, logo: career.logo ?? 4, photo: career.photo ?? 0 });
        selectDriver(name);
        loadId = career.id;
      }
      await new Promise<void>((resolve) => {
        let drive: Ht2Drive | null = null;
        // next — з меню Esc: завантажити збережену гру, почати спочатку, вийти з гри (без ctx.exit — у головне меню).
        const exit = (next?: 'career' | 'new' | 'exit') => {
          drive?.dispose();
          ctx.setStatus(null);
          direct = next === 'exit' ? (ctx.exit ? 'exit' : null) : (next ?? null);
          resolve();
        };
        Ht2Drive.start({ renderer: ctx.renderer, source, overlay: ctx.overlay, setStatus: ctx.setStatus, onExit: exit, truck: params.get('truck'), trailer: params.get('trailer'), weather: params.get('weather'), career, race: choice === 'race', settings, arena: arenaParam(params.get('arena')), course: params.get('course') === 'trial' ? 'trial' : params.get('course') === 'ball' ? 'ball' : 'ring' })
          .then((d) => {
            drive = d;
            Object.assign(window, { ht2: { drive } });
          })
          .catch((e) => {
            console.error(e);
            ctx.setStatus(`Помилка: ${(e as Error).message}`);
            setTimeout(exit, 4000);
          });
      });
      continue;
    }
    await new Promise<void>((resolve) => {
      const viewer: WorldViewer = new WorldViewer({
        renderer: ctx.renderer,
        source,
        region: new URLSearchParams(location.search).get('region') ?? 'aa',
        setStatus: ctx.setStatus,
        onExit: () => {
          viewer.dispose();
          resolve();
        },
      });
      void viewer.start();
      Object.assign(window, { ht2: { viewer } });
    });
  }
}
