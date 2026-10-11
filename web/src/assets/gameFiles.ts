import { Unzip, UnzipInflate } from 'fflate';
import { LEVELS } from './loader';
import type { FileSource } from './loader';
import { CAB2D_DIR, CAB2D_RAIN_FILES, CAB2D_SOURCE, extractCab2d } from './cab2d';

/**
 * Файли гри на пристрої гравця (Фаза 7): імпорт з HardTruck.zip або теки гри → IndexedDB.
 * IndexedDB, а не OPFS: OPFS доступний лише в захищеному контексті (HTTPS/localhost),
 * а телефон часто відкриває гру з ПК по http://192.168.… у домашній мережі.
 */

/** Канонічні шляхи потрібних файлів (лише апаратний набір + техніка, ≈ 66 МБ). */
export const REQUIRED: string[] = [
  ...Object.values(LEVELS).flatMap((l) => l.hw.map((f) => `${l.dir}/${f}`)),
  'TRUCK.TCH',
  'LOAD.RES',
  'MENU.FON',
  'large.fon',
];

const DB = 'hard-truck-files';
const STORE = 'files';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = fn(db.transaction(STORE, mode).objectStore(STORE));
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** Зіставляє довільний шлях з архіву/теки з канонічним (без урахування регістру, за останніми сегментами). */
export function canonical(path: string): string | null {
  // Витягнуті маски 2D-кабіни (див. cab2d.ts) — під власними іменами.
  if (path.startsWith(CAB2D_DIR)) return path;
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  const last = parts[parts.length - 1]?.toUpperCase();
  const parent = parts[parts.length - 2]?.toUpperCase();
  for (const req of REQUIRED) {
    const [a, b] = req.split('/');
    if (b === undefined ? last === a.toUpperCase() : last === b.toUpperCase() && parent === a.toUpperCase()) return req;
  }
  return null;
}

export async function storedFiles(): Promise<Set<string>> {
  const keys = (await tx('readonly', (s) => s.getAllKeys())) as string[];
  return new Set(keys);
}

export async function missingFiles(): Promise<string[]> {
  const have = await storedFiles();
  return REQUIRED.filter((r) => !have.has(r));
}

/** Архів програмного набору, з якого при імпорті беремо лише маски 2D-кабіни. */
function isCab2dSource(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/').toUpperCase() === CAB2D_SOURCE;
}

async function putCab2d(data: Blob): Promise<void> {
  for (const [n, b] of extractCab2d(new Uint8Array(await data.arrayBuffer()))) await put(n, b);
}

export async function storeFile(name: string, data: Uint8Array): Promise<void> {
  await put(name, data);
}

async function put(name: string, data: Uint8Array | Blob): Promise<void> {
  const blob = data instanceof Blob ? data : new Blob([data as BlobPart]);
  await tx('readwrite', (s) => s.put(blob, name));
}

export type Progress = (msg: string, fraction: number) => void;

/** Імпорт з окремих файлів або теки (input webkitdirectory). */
export async function importFiles(files: FileList | File[], progress: Progress): Promise<number> {
  let n = 0;
  const list = [...files];
  for (const [i, f] of list.entries()) {
    const path = f.webkitRelativePath || f.name;
    if (isCab2dSource(path)) {
      progress('Витягую 2D-кабіни', i / list.length);
      await putCab2d(f).catch(() => {});
      continue;
    }
    const c = canonical(path);
    if (!c) continue;
    progress(`Копіюю ${c}`, i / list.length);
    await put(c, f);
    n++;
  }
  progress('Готово', 1);
  return n;
}

/** Потокове розпакування ZIP: беремо лише потрібні файли, решту пропускаємо без розпакування. */
export async function importZip(zip: File, progress: Progress): Promise<number> {
  const wanted = new Map<string, Uint8Array[]>();
  const done: Promise<void>[] = [];
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (isCab2dSource(file.name) && !wanted.has(CAB2D_SOURCE)) {
      const chunks: Uint8Array[] = [];
      wanted.set(CAB2D_SOURCE, chunks);
      done.push(
        new Promise<void>((resolve) => {
          file.ondata = (err, data, final) => {
            if (err) return resolve();
            chunks.push(data);
            if (final) {
              putCab2d(new Blob(chunks as BlobPart[])).then(resolve, () => resolve());
              chunks.length = 0;
            }
          };
          file.start();
        }),
      );
      return;
    }
    const c = canonical(file.name);
    if (!c || wanted.has(c)) return;
    const chunks: Uint8Array[] = [];
    wanted.set(c, chunks);
    done.push(
      new Promise<void>((resolve, reject) => {
        file.ondata = (err, data, final) => {
          if (err) return reject(err);
          chunks.push(data);
          if (final) {
            put(c, new Blob(chunks as BlobPart[])).then(resolve, reject);
            chunks.length = 0;
          }
        };
        file.start();
      }),
    );
  };
  const reader = zip.stream().getReader();
  let read = 0;
  for (;;) {
    const { value, done: end } = await reader.read();
    if (end) break;
    read += value.length;
    unzip.push(value);
    progress(`Розпаковую архів… ${(read / 1048576).toFixed(0)} / ${(zip.size / 1048576).toFixed(0)} МБ`, read / zip.size);
  }
  unzip.push(new Uint8Array(0), true);
  await Promise.all(done);
  progress('Готово', 1);
  return wanted.size;
}

/** Стан файлів гри на пристрої (для «Опцій»): скільки потрібних є, зайняте місце, чи захищене сховище. */
export interface StorageInfo {
  stored: number;
  required: number;
  /** Зайнято сайтом, байт (оцінка браузера; null — невідомо). */
  usage: number | null;
  /** Браузер не очистить дані сам (null — API немає). */
  persisted: boolean | null;
}

export async function storageInfo(): Promise<StorageInfo> {
  const missing = await missingFiles().catch(() => REQUIRED);
  // Файли дощу 2D-кабіни (витягуються з COUNT.RMP лише при імпорті) — теж у підрахунку: без них «Опції» показують
  // неповний набір, і видно, що потрібен повторний імпорт.
  const have = await storedFiles().catch(() => new Set<string>());
  const rain = CAB2D_RAIN_FILES.filter((f) => have.has(f)).length;
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const persisted = navigator.storage?.persisted ? await navigator.storage.persisted().catch(() => null) : null;
  return {
    stored: REQUIRED.length - missing.length + rain,
    required: REQUIRED.length + CAB2D_RAIN_FILES.length,
    usage: est?.usage ?? null,
    persisted,
  };
}

export async function clearFiles(): Promise<void> {
  await tx('readwrite', (s) => s.clear());
}

async function getBlob(name: string): Promise<Blob | undefined> {
  return (await tx('readonly', (s) => s.get(name))) as Blob | undefined;
}

/** Джерело файлів з IndexedDB. */
export const idbSource: FileSource = {
  async read(path) {
    const c = canonical(path) ?? path;
    const blob = await getBlob(c);
    if (!blob) throw new Error(`Файл гри ${c} не імпортовано`);
    return new Uint8Array(await blob.arrayBuffer());
  },
};

/**
 * Джерело з кешем на пристрої: спершу IndexedDB, інакше — `inner` (dev-сервер ПК) із записом у IndexedDB.
 * Файли гри незмінні, тож перевіряти свіжість не потрібно.
 */
export function cachedSource(inner: FileSource): FileSource {
  return {
    async read(path) {
      const c = canonical(path);
      const blob = c ? await getBlob(c).catch(() => undefined) : undefined;
      if (blob) return new Uint8Array(await blob.arrayBuffer());
      const data = await inner.read(path);
      if (c) await put(c, data).catch(() => {});
      return data;
    },
  };
}

/** У фоні докачує в IndexedDB решту потрібних файлів — після цього гра працює на пристрої без ПК. */
export async function prefetchMissing(inner: FileSource): Promise<number> {
  let n = 0;
  for (const f of await missingFiles()) {
    try {
      await put(f, await inner.read(f));
      n++;
    } catch {
      /* спробуємо наступного запуску */
    }
  }
  return n;
}
