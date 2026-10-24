import type { Fines } from './law';
import type { Order } from './economy';
import type { RivalRun } from './competition';
import type { HiredDriver } from './company';
import type { SavedPresent, TrailerChoice } from '../vehicles/presents';
import type { SavedCache } from '../vehicles/caches';
import type { OrderedCar } from './market';
import type { SavedTrucker } from '../traffic/fleet';

/**
 * Кар'єра Дальнобойщиків 2 (перша версія): гроші, вантажівка, стан, поточне замовлення, ігровий час. Зберігається в
 * цьому браузері — окремо від кар'єр першої гри: кожне збереження — ключ `ht2.save.<id>`, водії (імʼя, логотип, фото) —
 * `ht2.drivers.v1`. Як в оригіналі: водій — профіль `<імʼя>.pl1`, у ньому список збережень `listofgames`
 * (re/notes/ht2/menu-screens.md §3, trailers-bodies.md §9); у порту список збережень спільний для всіх водіїв.
 *
 * Гіпотези порту: стартові гроші 5000 $; ремонт — 30 $ за відсоток пошкодження; неустойка за прострочення —
 * половина цінності вантажу, за пошкодження — частка цінності, що дорівнює частці пошкодження; пальне — $1 за літр
 * (restable.sch: PR_FUEL «Fuel» 100 — одиниці невідомі).
 */
export interface ActiveOrder extends Order {
  /** Ігровий час прийняття, с. */
  taken: number;
  /** Цілісність вантажу 0…1. */
  integrity: number;
  /** Конкуренти з тим самим замовленням (competition.ts), довжина маршруту мережею, м, і премія першому. */
  rivals?: RivalRun[];
  /** Скільки суперників тримати (N) і скільки з них попереду (king.exe 0x68d15c / 0x68d160) — для доповнення. */
  rivalTarget?: number;
  rivalAhead?: number;
  route?: number;
  /** Звідки рахується маршрут суперників (місце й курс гравця, коли взяв вантаж; Three.js: x, y, z, курс x, z). */
  start?: number[];
  premium?: number;
  /** Суперник доїхав раніше — премії не буде. */
  beaten?: boolean;
}

export interface Ht2Career {
  driver: string;
  /** Збереження (`ht2.save.<id>`) і коли записано (Date.now()). */
  id?: string;
  /** Мережева кар'єра (М6, `net-<водій>`): немає в списку збережень одиночної гри. */
  net?: boolean;
  savedAt?: number;
  /** Логотип (0…7, `d/logo1…8`) і фото (0…50, `d/photo01…51`) водія — меню «Водії» (king.exe .pl1). */
  logo?: number;
  photo?: number;
  money: number;
  truck: string;
  /**
   * Фарбування машини — кластер TRUCKS.OVL з нуля (тип evehicles.sch; старт — GAME.CNF `live 1 "ZilR" 1`, купівля —
   * фарбування машини продавця). Без поля (старі збереження) — перше.
   */
  paint?: number;
  /** Пошкодження машини 0…1. */
  damage: number;
  /** Пальне в баку, л (null — повний бак, ще не їздили). */
  fuel: number | null;
  /** Ігровий час, с. */
  time: number;
  order: ActiveOrder | null;
  delivered: number;
  earned: number;
  /** Перевезено, т (рейтинг F2). */
  tons?: number;
  /** Ринок захоплено (частка X ≥ 0,51, вікно BackWin): більше не перевіряється (king.exe — поріг 1,05). */
  won?: boolean;
  /** Скільки разів доставлено першим серед конкурентів (ліцензії на найм — G9 Б7). */
  firsts?: number;
  /** Ліцензії на найм: ігровий час закінчення кожної. */
  licences?: number[];
  /** Наймані водії (company.ts). */
  company?: HiredDriver[];
  /** Встановлені покращення (`PR_ID:варіант`, див. upgrades.ts); переходять на нову вантажівку (гіпотеза). */
  upgrades?: string[];
  /** Протипожежна система: скільки зарядів витрачено (з 4; king.exe 0x5494c0). */
  fireUsed?: number;
  /** Вмʼятини за зонами кузова й шини (`W0`…, частки 0…1, dents.ts); ремонт на СТО скидає. */
  dents?: Partial<Record<string, number>>;
  /** Вмʼятини й шини напівпричепа (так само). */
  trailerDents?: Partial<Record<string, number>>;
  /** Напівпричіп тягача — підібраний на базі (vehicles/presents.ts); null — без причепа (тягач купується без нього). */
  trailer?: TrailerChoice | null;
  /** Причепи-presents (бази, дорожні місії, кинуті гравцем з вантажем) — vehicles/presents.ts. */
  presents?: SavedPresent[];
  /** Схованки `pos_hidden` — контейнери з вантажем і цистерни-декорації (vehicles/caches.ts). */
  caches?: SavedCache[];
  /** Діючий завал (id `obstacle` з mod_*.sch, world/obstacles.ts); null — жодного. */
  obstacle?: string | null;
  /** Продане й найняте на ринках (`ринок:день:місце`, лише поточний день і далі — Markets.soldKeys). */
  sold?: string[];
  /** Замовлені рацією машини, що чекають на ринках (career/carOrder.ts). */
  orderedCars?: OrderedCar[];
  /** Перемог у гонках на Кільці поспіль (career/races.ts: ліцензії за перемогу). */
  raceWins?: number;
  /** Штрафи, що висять на гравці (law.ts): розшук міліцією до затримання чи хабара. */
  fines?: Fines;
  /** Машина крадена (куплена на ринку як крадена): міліція з імовірністю 50 % вважає її викраденою. */
  stolen?: boolean;
  /** Відкриті проїздом ділянки карти (world/mapReveal.ts, ключі `MapSection.key`). */
  mapOpened?: string[];
  /** Камери-радари, що вже спрацювали (номери; кожна штрафує раз за гру — traffic/radars.ts). */
  radars?: number[];
  /** Ціна моделі нової — для відшкодування за крадену (0,8 ціни). */
  truckPrice?: number;
  /** Далекобійники світу (traffic/fleet.ts): де кожен їде, рейс і вантаж. */
  fleet?: SavedTrucker[];
  /** Остання позиція (координати гри) і склад, де стоїмо. */
  pos?: [number, number, number];
  /** Курс машини в площині гри (x, y) на момент запису; старі записи — без нього (savedHeading). */
  heading?: [number, number];
}

/**
 * Курс зі збереження — одиничний вектор (x, y) гри або null, якщо поля немає чи воно зіпсоване (старі записи: тоді
 * машина стає вздовж найближчої дороги, як раніше).
 */
export function savedHeading(c: Pick<Ht2Career, 'heading'>): [number, number] | null {
  const h = c.heading;
  if (!Array.isArray(h) || h.length < 2) return null;
  const [x, y] = h;
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const l = Math.hypot(x, y);
  return l > 1e-3 ? [x / l, y / l] : null;
}

const SAVE_PREFIX = 'ht2.save.';
const DRIVERS_KEY = 'ht2.drivers.v1';
/** Одна кар'єра до кількох водіїв — переноситься в перше збереження й першого водія (migrate). */
const LEGACY_KEY = 'ht2.career.v1';
export const START_MONEY = 5000;
export const REPAIR_PER_PERCENT = 30;
export const FUEL_PRICE = 1;
/** Імʼя водія за замовчуванням (king.exe: mess 0x30 «ВОДИТЕЛЬ», `lastp`). */
export const DEFAULT_DRIVER = 'Водій';
/**
 * Ігровий час (`time`, с від початку кар'єри) іде з темпом повзунка «тривалість доби» (settings.timeScale); старт —
 * 10:00, як в оригіналі (TRUCK.INI timestart=10).
 */

export function newCareer(driver: string, truck: string): Ht2Career {
  return { driver, id: newId(), money: START_MONEY, truck, damage: 0, fuel: null, time: 10 * 3600, order: null, delivered: 0, earned: 0 };
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function get(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function set(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* приватний режим, сховище повне */
  }
}

function keys(): string[] {
  try {
    return Object.keys(localStorage);
  } catch {
    return [];
  }
}

/** Стара єдина кар'єра → збереження й водій (раз). */
function migrate(): void {
  const raw = get(LEGACY_KEY);
  if (raw === null) return;
  try {
    const c = JSON.parse(raw) as Ht2Career;
    c.id ??= newId();
    c.savedAt ??= Date.now();
    set(SAVE_PREFIX + c.id, JSON.stringify(c));
    const d = readDrivers();
    if (!d.list.some((x) => x.name === c.driver)) d.list.push({ name: c.driver, logo: c.logo ?? 4, photo: c.photo ?? 0 });
    d.current ??= c.driver;
    writeDrivers(d);
  } catch {
    /* зіпсоване — лише прибрати */
  }
  set(LEGACY_KEY, null);
}

/** Усі збереження, найновіші першими. */
export function listSaves(): Ht2Career[] {
  migrate();
  const out: Ht2Career[] = [];
  for (const k of keys()) {
    if (!k.startsWith(SAVE_PREFIX)) continue;
    try {
      const c = JSON.parse(get(k)!) as Ht2Career;
      c.id = k.slice(SAVE_PREFIX.length);
      out.push(c);
    } catch {
      /* зіпсоване пропустити */
    }
  }
  return out.sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
}

/** Збереження за id; без id — найновіше. */
export function loadCareer(id?: string): Ht2Career | null {
  if (id === undefined) return listSaves().find((c) => !c.net) ?? null;
  migrate();
  try {
    const s = get(SAVE_PREFIX + id);
    return s ? { ...(JSON.parse(s) as Ht2Career), id } : null;
  } catch {
    return null;
  }
}

/** Записати кар'єру в її збереження (немає id — нове). */
export function saveCareer(c: Ht2Career): void {
  c.id ??= newId();
  c.savedAt = Date.now();
  set(SAVE_PREFIX + c.id, JSON.stringify(c));
}

export function deleteSave(id: string): void {
  set(SAVE_PREFIX + id, null);
}

/** Збереження як є (рядок JSON) чи null — щоб повернути його після виходу без збереження (restoreCareer). */
export function savedCareerRaw(id: string): string | null {
  return get(SAVE_PREFIX + id);
}

/** Повернути збереження до знімка savedCareerRaw (null — збереження не було: стерти). */
export function restoreCareer(id: string, raw: string | null): void {
  set(SAVE_PREFIX + id, raw);
}

/** Водій — профіль (king.exe `<імʼя>.pl1`): імʼя, логотип 0…7 і фото 0…50. */
export interface DriverInfo {
  name: string;
  logo: number;
  photo: number;
}

interface Drivers {
  /** Поточний водій (king.exe `lastp`). */
  current?: string;
  list: DriverInfo[];
}

function readDrivers(): Drivers {
  try {
    const d = JSON.parse(get(DRIVERS_KEY) ?? '') as Drivers;
    if (Array.isArray(d.list)) return d;
  } catch {
    /* немає */
  }
  return { list: [] };
}

function writeDrivers(d: Drivers): void {
  set(DRIVERS_KEY, JSON.stringify(d));
}

export function listDrivers(): DriverInfo[] {
  migrate();
  return readDrivers().list;
}

export function currentDriver(): DriverInfo | null {
  migrate();
  const d = readDrivers();
  return d.list.find((x) => x.name === d.current) ?? null;
}

/** Створити водія чи оновити логотип і фото наявного; зробити поточним. */
export function putDriver(info: DriverInfo): void {
  migrate();
  const d = readDrivers();
  const i = d.list.findIndex((x) => x.name === info.name);
  if (i >= 0) d.list[i] = { ...info };
  else d.list.push({ ...info });
  d.current = info.name;
  writeDrivers(d);
}

/** Зробити поточним наявного водія. */
export function selectDriver(name: string): void {
  const d = readDrivers();
  if (!d.list.some((x) => x.name === name)) return;
  d.current = name;
  writeDrivers(d);
}

/**
 * Видалити водія разом з його збереженнями (king.exe: «Удалить» стирає `<імʼя>.pl1`, а з ним і `listofgames`);
 * поточним стає наступний у списку.
 */
export function deleteDriver(name: string): void {
  migrate();
  const d = readDrivers();
  const i = d.list.findIndex((x) => x.name === name);
  if (i < 0) return;
  d.list.splice(i, 1);
  if (d.current === name) d.current = d.list[Math.min(i, d.list.length - 1)]?.name;
  writeDrivers(d);
  for (const c of listSaves()) if (c.driver === name) deleteSave(c.id!);
}

export function settle(o: ActiveOrder, now: number): { pay: number; late: boolean; damagePenalty: number; latePenalty: number } {
  const late = now - o.taken > o.deadline;
  const damagePenalty = Math.round(o.value * (1 - o.integrity));
  const latePenalty = late ? Math.round(o.value * 0.5) : 0;
  return { pay: Math.max(0, o.pay - damagePenalty - latePenalty), late, damagePenalty, latePenalty };
}

export function formatMoney(v: number): string {
  return `$${Math.round(v).toLocaleString('uk-UA')}`;
}

export function formatClock(t: number): string {
  const h = Math.floor(t / 3600) % 24;
  const m = Math.floor(t / 60) % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
