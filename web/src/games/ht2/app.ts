import type * as THREE from 'three';
import { cachedSource, idbSourceFor, missingFiles, prefetchMissing } from '../../assets/gameFiles';
import type { FileSource } from '../../assets/loader';
import { parseFon } from '../../formats/fon';
import { PixelFont } from '../../ui/pixelFont';
import type { GameId } from '../registry';
import { HT2_FILES, ht2DevSource } from './files';
import { Ht2MenuArt, ht2MenuScreen, type MenuItem } from './menu';
import { WorldViewer } from './viewer';

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

/** Джерело файлів: повний набір на пристрої — звідти; інакше ПК (з кешуванням) або імпорт. */
async function pickSource(ctx: Ht2Context): Promise<FileSource> {
  const params = new URLSearchParams(location.search);
  const local = idbSourceFor(HT2_FILES);
  const missing = await missingFiles(HT2_FILES).catch(() => HT2_FILES.required);
  if (!missing.length && params.get('source') !== 'pc') return local;
  if (params.get('source') !== 'local' && (await devAvailable())) {
    void prefetchMissing(ht2DevSource, HT2_FILES);
    return cachedSource(ht2DevSource, HT2_FILES);
  }
  await ctx.showImport(false);
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

  // Налагодження: ?game=ht2&tab=world — одразу огляд світу (&region=ab).
  let direct = new URLSearchParams(location.search).get('tab') === 'world';
  for (;;) {
    const choice = direct ? 'world' : await new Promise<'world' | 'files' | 'exit'>((resolve) => {
      let close = () => {};
      // Меню закривається перед будь-якою дією.
      const pick = (c: 'world' | 'files' | 'exit') => () => {
        close();
        resolve(c);
      };
      const items: MenuItem[] = [
        { label: 'Огляд світу', action: pick('world') },
        { label: 'Файли гри', action: pick('files') },
      ];
      if (ctx.exit) items.push({ label: 'Вихід', action: pick('exit') });
      close = ht2MenuScreen(art, large, items, 'Дальнобойщики 2 — порт у розробці: поки лише огляд світу');
    });
    direct = false;
    if (choice === 'exit') return ctx.exit?.();
    if (choice === 'files') {
      await ctx.showImport(true);
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
