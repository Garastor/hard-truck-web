import type * as THREE from 'three';
import { cachedSource, idbSourceFor, missingFiles, prefetchMissing } from '../../assets/gameFiles';
import type { FileSource } from '../../assets/loader';
import { parseFon } from '../../formats/fon';
import { PixelFont } from '../../ui/pixelFont';
import type { GameId } from '../registry';
import { HT2_FILES, ht2DevSource } from './files';
import { Ht2MenuArt, ht2MenuScreen, type MenuItem } from './menu';
import { WorldViewer } from './viewer';
import { Ht2Drive } from './drive';
import { formatMoney, loadCareer, newCareer, type Ht2Career } from './career';
import { modal } from '../../ui/careerUi';

type Choice = 'world' | 'drive' | 'race' | 'career' | 'new' | 'files' | 'exit';

/**
 * Дальнобойщики 2 у порті: джерело файлів (пристрій або ПК), меню з LOAD.RES гри, режими. Свій цикл кадрів і сцена —
 * рендерер спільний з першою грою (main.ts), її інтерфейс схований (body.game-ht2).
 */
export interface Ht2Context {
  renderer: THREE.WebGLRenderer;
  overlay: HTMLElement;
  setStatus(text: string | null): void;
  showImport(again: boolean): Promise<GameId | null>;
  /** Вихід до вибору гри (null — гра одна). */
  exit: (() => void) | null;
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

export async function runHt2(ctx: Ht2Context): Promise<void> {
  document.body.classList.add('game-ht2');
  document.title = 'Дальнобойщики 2';
  ctx.setStatus('Завантаження «Дальнобійників 2»…');
  const source = await pickSource(ctx);
  const font = (name: string) => source.read(name).then((b) => new PixelFont(parseFon(b))).catch(() => null);
  const [large] = await Promise.all([font('LARGE.FON')]);
  const art = await Ht2MenuArt.load((n) => source.read(n));
  ctx.setStatus(null);

  // Налагодження: ?game=ht2&tab=world — одразу огляд світу (&region=ab); &tab=drive — вільна їзда (&truck=Kamaz);
  // &tab=career — кар'єра.
  const params = new URLSearchParams(location.search);
  const tab = params.get('tab');
  let direct: Choice | null = tab === 'world' || tab === 'drive' || tab === 'career' || tab === 'race' ? tab : null;
  for (;;) {
    const saved = loadCareer();
    const choice = direct ?? (await new Promise<Choice>((resolve) => {
      let close = () => {};
      // Меню закривається перед будь-якою дією.
      const pick = (c: Choice) => () => {
        close();
        resolve(c);
      };
      const items: MenuItem[] = [];
      if (saved) items.push({ label: 'Продовжити', action: pick('career') });
      items.push(
        { label: 'Нова гра', action: pick('new') },
        { label: 'Вільна їзда', action: pick('drive') },
        { label: 'Гонка на Кільці', action: pick('race') },
        { label: 'Огляд світу', action: pick('world') },
        { label: 'Файли гри', action: pick('files') },
      );
      if (ctx.exit) items.push({ label: 'Вихід', action: pick('exit') });
      const note = saved ? `За кермом: ${saved.driver} · ${formatMoney(saved.money)} · доставок ${saved.delivered}` : 'Дальнобойщики 2 — порт у розробці';
      close = ht2MenuScreen(art, large, items, note);
    }));
    direct = null;
    if (choice === 'exit') return ctx.exit?.();
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
        Ht2Drive.start({ renderer: ctx.renderer, source, overlay: ctx.overlay, setStatus: ctx.setStatus, onExit: exit, truck: params.get('truck'), career, race: choice === 'race' })
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
