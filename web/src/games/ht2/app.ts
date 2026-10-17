import * as THREE from 'three';
import { cachedSource, idbSourceFor, missingFiles, prefetchMissing, removeFiles, storedFiles } from '@shared/gameStore';
import type { FileSource } from '@shared/source';
import { setSoftFont } from './engine/ui/softUi';
import { parseFon } from './engine/formats/fon';
import { PixelFont } from './engine/ui/pixelFont';
import type { GameContext } from '@shared/gameContext';
import { HT2_FILES, HT2_MODS, HT2_MUSIC, HT2_REQUIRED, HT2_UI, HT2_VIDEO, ht2DevSource } from './files';
import { Ht2MenuArt, ht2ExitScreen, ht2MainScreen, ht2MenuScreen, ht2SingleScreen, type MenuItem, type RoundKey } from './ui/menu';
import { Input } from './engine/input/input';
import { ht2ControlsScreen, ht2DriversScreen, ht2GraphicsScreen, ht2RecordsScreen } from './ui/menuScreens';
import { loadSettings, saveSettings, type Ht2Settings } from './ui/settings';
import { parseIni } from './engine/formats/ini';
import { decodeCp1251 } from './engine/formats/binary';
import { WorldViewer } from './ui/viewer';
import { Ht2Drive } from './drive';
import { clearCareer, formatMoney, loadCareer, newCareer, saveCareer, type Ht2Career } from './career/career';
import { modal, setHudFont } from './engine/ui/modal';

type Choice = 'world' | 'drive' | 'race' | 'career' | 'new' | 'single' | 'files' | 'exit';

/**
 * Дальнобойщики 2 у порті: джерело файлів (пристрій або ПК), меню з LOAD.RES гри, режими. Свій цикл кадрів і сцена —
 * рендерер — від оболонки (app/main.ts); технічна панель першої гри схована (body.game-ht2).
 */
/** Контекст запуску від оболонки (app/main.ts). */
export type Ht2Context = GameContext;

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
  // Світло king.exe (Direct3D) рахується просто в кольорах екрана: текстура × (розсіяне + сонце·cos), до 1. Лінійний
  // простір three.js (sRGB → лінійне → sRGB) робив розсіяне 80/255 вчетверо слабшим, а суму — темнішою: асфальт 66
  // замість 106 (текстура 112). Тож у другій грі — без керування кольором: текстури й кольори як є, вихід без
  // перетворення (вихід до вибору гри перезавантажує сторінку, першу гру це не зачіпає).
  THREE.ColorManagement.enabled = false;
  ctx.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
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
  ctx.setStatus(null);

  // Налагодження: ?game=ht2&tab=world — одразу огляд світу (&region=ab); &tab=drive — вільна їзда (&truck=Kamaz);
  // &tab=career — кар'єра.
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  let direct: Choice | null = tab === 'world' || tab === 'drive' || tab === 'career' || tab === 'race' ? tab : null;
  for (;;) {
    const saved = loadCareer();
    const note = saved ? `За кермом: ${saved.driver} · ${formatMoney(saved.money)} · доставок ${saved.delivered}` : 'Дальнобойщики 2 — порт у розробці';
    // Кругла кнопка рамки → дія (null — лишитися в меню). «Демо» — режими порту (вільна їзда, гонка, огляд, файли).
    const round = async (key: RoundKey, parent: HTMLElement): Promise<Choice | null> => {
      if (key === 'singl') return 'single';
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
            const c = loadCareer();
            close = ht2DriversScreen(art, {
              ...common,
              driver: c ? { name: c.driver, logo: c.logo ?? 4, photo: c.photo ?? 0 } : null,
              onChange: (d) => {
                const cur = loadCareer();
                if (!cur) return;
                Object.assign(cur, { driver: d.name, logo: d.logo, photo: d.photo });
                saveCareer(cur);
              },
              onDelete: () => {
                void modal(document.querySelector('.ht2-menu') as HTMLElement, 'Видалити водія', 'Стерти збережену кар\'єру цього водія?', ['Видалити', 'Ні']).then((i) => {
                  if (i !== 0) return;
                  clearCareer();
                  done(null);
                });
              },
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
              void round(key, document.querySelector('.ht2-menu') as HTMLElement).then((c) => {
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
      const next = await new Promise<Choice | null>((resolve) => {
        let busy = false;
        const close = ht2SingleScreen(art, {
          hasSave: !!saved,
          saveText: saved ? `${saved.driver}\n${formatMoney(saved.money)}\nдоставок: ${saved.delivered}` : '',
          settings,
          onNew: () => (close(), resolve('new')),
          onLoad: () => (close(), resolve('career')),
          onCancel: () => (close(), resolve(null)),
          onChange: (st) => {
            settings = st;
            saveSettings(st);
          },
          onRound: (key) => {
            if (busy || key === 'singl') return;
            busy = true;
            void round(key, document.querySelector('.ht2-menu') as HTMLElement).then((c) => {
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
    if (choice === 'drive' || choice === 'career' || choice === 'new' || choice === 'race') {
      let career: Ht2Career | null = null;
      // Без питання «збережену гру буде втрачено»: чи зберігати, гравець уже вирішив, виходячи з гри в меню.
      if (choice === 'new') career = newCareer('Водій', '');
      else if (choice === 'career') career = saved ?? newCareer('Водій', '');
      await new Promise<void>((resolve) => {
        let drive: Ht2Drive | null = null;
        // next — з меню Esc: завантажити збережену гру, почати спочатку, вийти з гри (без ctx.exit — у головне меню).
        const exit = (next?: 'career' | 'new' | 'exit') => {
          drive?.dispose();
          ctx.setStatus(null);
          direct = next === 'exit' ? (ctx.exit ? 'exit' : null) : (next ?? null);
          resolve();
        };
        Ht2Drive.start({ renderer: ctx.renderer, source, overlay: ctx.overlay, setStatus: ctx.setStatus, onExit: exit, truck: params.get('truck'), trailer: params.get('trailer'), weather: params.get('weather'), career, race: choice === 'race', settings })
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
