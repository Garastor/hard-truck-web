import { cachedSource, idbSourceFor, missingFiles, prefetchMissing } from '@shared/gameStore';
import type { FileSource } from '@shared/source';
import { setSoftFont } from './engine/ui/softUi';
import { parseFon } from './engine/formats/fon';
import { PixelFont } from './engine/ui/pixelFont';
import type { GameContext } from '@shared/gameContext';
import { HT2_FILES, ht2DevSource } from './files';
import { Ht2MenuArt, ht2ExitScreen, ht2MainScreen, ht2MenuScreen, ht2SingleScreen, type MenuItem, type RoundKey } from './ui/menu';
import { loadSettings, saveSettings, type Ht2Settings } from './ui/settings';
import { parseIni } from './engine/formats/ini';
import { decodeCp1251 } from './engine/formats/binary';
import { WorldViewer } from './ui/viewer';
import { Ht2Drive } from './drive';
import { formatMoney, loadCareer, newCareer, type Ht2Career } from './career/career';
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

export async function runHt2(ctx: Ht2Context): Promise<void> {
  document.body.classList.add('game-ht2');
  document.title = 'Дальнобойщики 2';
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
      await ctx.showImport(true);
      continue;
    }
    if (choice === 'drive' || choice === 'career' || choice === 'new' || choice === 'race') {
      let career: Ht2Career | null = null;
      if (choice === 'new') {
        if (saved && (await modal(ctx.overlay, 'Нова гра', 'Збережену гру буде втрачено. Почати заново?', ['Почати заново', 'Скасувати'])) !== 0) continue;
        career = newCareer('Водій', '');
      } else if (choice === 'career') career = saved ?? newCareer('Водій', '');
      await new Promise<void>((resolve) => {
        let drive: Ht2Drive | null = null;
        const exit = () => {
          drive?.dispose();
          ctx.setStatus(null);
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
