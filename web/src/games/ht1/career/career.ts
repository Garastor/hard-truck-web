/**
 * Кар'єра (база → траса → база) за правилами з довідки оригіналу (Docs/ht1/gameplay.md).
 * Чиста логіка без рендера: стан гравця, ринок товарів, покупки, розрахунок після заїзду.
 *
 * Звідки числа: ціни, маса й вантажопідйомність вантажівок — з TRUCK.TCH; 28 товарів (ціна, вага, обʼєм,
 * міцність) і ціни запчастин — з таблиці HTruck.exe (0x4c1eb0, звірено зі скріншотом бази); стартовий
 * капітал 30 000 $ — зі скріншота оригіналу; правила — з довідки. Призи, знос, надбавки за маршрут —
 * власні значення (гіпотеза), зібрані тут, щоб їх було легко підправити.
 */

export type Difficulty = 'arcade' | 'sim';
export type TrackId = 'CIRCUIT' | 'TRIAL' | 'NIGHT' | 'COUNT' | 'MOUNT';
export type Weather = 'clear' | 'rain';

/** Тунелі бази (подія 666, параметр) → траси. Порядок — як на вказівнику бази (txr/signs). */
export const TUNNELS: Record<number, TrackId> = { 10: 'CIRCUIT', 20: 'TRIAL', 30: 'NIGHT', 40: 'COUNT', 50: 'MOUNT' };

export interface TrackInfo {
  title: string;
  kind: 'laps' | 'trial' | 'commercial';
  /** Число з вказівника бази (Приморск 4, Перелесье 8, Горный 6) — вважаємо складністю маршруту. */
  difficulty: number;
}

export const TRACKS: Record<TrackId, TrackInfo> = {
  CIRCUIT: { title: 'Кільце', kind: 'laps', difficulty: 0 },
  TRIAL: { title: 'Полігон', kind: 'trial', difficulty: 0 },
  NIGHT: { title: 'Приморськ', kind: 'commercial', difficulty: 4 },
  COUNT: { title: 'Перелісся', kind: 'commercial', difficulty: 8 },
  MOUNT: { title: 'Гірський', kind: 'commercial', difficulty: 6 },
};

/** Запчастини в порядку вітрин зали (подія 888, параметр 0…6; txr/part0…6). */
export const PARTS = [
  { code: 'ФД', title: 'Форсований двигун', hint: 'потужність +20 %', price: 15000 },
  { code: 'АПС', title: 'Антипробуксовочна система', hint: 'менше заносів і пробуксовок', price: 10000 },
  { code: 'ШН', title: 'Зносостійкі шини', hint: 'нова гума, знос удвічі менший', price: 5000 },
  { code: 'ПП', title: 'Пневмопідвіска', hint: 'крихкий вантаж бʼється вдвічі менше', price: 12000 },
  { code: 'НС', title: 'Навігаційна система', hint: 'карта з суперниками', price: 16000 },
  { code: 'РС', title: 'Регульоване сидіння', hint: 'зручніший огляд', price: 1000 },
  { code: 'ДТ', title: 'Дискові гальма з вентиляцією', hint: 'гальма зношуються вдвічі менше', price: 3000 },
] as const;

/**
 * Товари оригіналу: 7 секцій × 4 (індекс = секція·4 + вигляд ящиків, стан перемикача GOOD_n і текстура goodNV).
 * [назва, ціна за упаковку $, вага кг, обʼєм м³, міцність 0…1] — HTruck.exe 0x4c1eb0; крихкість = 1 − міцність.
 */
export const GOODS: [string, number, number, number, number][] = [
  ['COCA COLA', 21, 36, 0.06, 0.5], ['ШАМПАНСЬКЕ', 78, 22, 0.1, 0.5], ['MARTINI', 240, 22, 0.1, 0.5], ['ГОРІЛКА', 272, 22, 0.1, 0.5],
  ['ВАТА', 50, 65, 1.0, 1], ['ЛЛЯНЕ ПОЛОТНО', 45, 15, 0.6, 1], ['БАВОВНЯНА ТКАНИНА', 64, 21, 0.4, 1], ['ЛАЙКРА', 92, 20, 0.3, 1],
  ['ТЕЛЕВІЗОР 36 см', 770, 17, 0.05, 0.6], ['ТЕЛЕВІЗОР 54 см', 989, 25, 0.17, 0.6], ['ВІДЕОКАМЕРА', 1040, 11, 0.06, 0.7], ['PENTIUM II', 1860, 36, 0.23, 0.6],
  ['ЕЛЕКТРОЛАМПИ', 270, 80, 1.0, 0.2], ['КАБЕЛЬ АППВ 3x2,5', 150, 90, 0.39, 1], ['КАБЕЛЬ РК-75/12', 254, 9, 0.08, 1], ['ЕЛЕКТРОДВИГУН', 620, 52, 0.49, 1],
  ['ПІНОПЛАСТ', 50, 48, 1.08, 1], ['СКЛО ВІКОННЕ', 175, 360, 0.39, 0.5], ['ДЗЕРКАЛО', 263, 270, 0.29, 0.5], ['ЦВЯХИ 100 мм', 98, 40, 0.05, 1],
  ['ВІТАМІН Z', 22, 19, 0.06, 0.45], ['ВАКЦИНА BRP', 61, 29, 0.09, 0.5], ['АНАЛІПСИН', 104, 14, 0.1, 1], ['ЛОРИЗИН', 243, 12, 0.11, 1],
  ['МʼЯКА ІГРАШКА', 208, 84, 1.23, 1], ['АВТОКОНСТРУКТОР', 91, 6, 0.16, 0.8], ['КОНСТРУКТОР MEGO', 172, 4, 0.11, 1], ['КОМПʼЮТЕРНІ ІГРИ', 760, 42, 0.09, 1],
];
export type PartCode = (typeof PARTS)[number]['code'];

/** Вантажівка з TRUCK.TCH — лише те, що потрібно економіці. */
export interface TruckSpec {
  index: number;
  name: string;
  price: number;
  /** Вантажопідйомність, кг (cargo_and_body_pick_load). */
  payload: number;
  /** Обʼєм кузова, м³ (body_square × body_height — гіпотеза). */
  volume: number;
  horsePower: number;
}

/** Товар в одній секції зали «Завантаження»: ціна, обʼєм і вага однієї упаковки, крихкість 0…1. */
export interface Good {
  name: string;
  section: number;
  /** Вигляд ящиків (стан перемикача GOOD_n, текстури goodN0…N3). */
  variant: number;
  price: number;
  volume: number;
  weight: number;
  fragility: number;
}

export interface CargoItem {
  good: Good;
  qty: number;
}

export interface Driver {
  name: string;
  ai: boolean;
  truck: number;
  money: number;
  /** Час фінішу останнього заїзду, с. */
  lastTime: number | null;
}

export interface Condition {
  /** Технічний стан, шини, гальма: 1 — нове. */
  tech: number;
  tires: number;
  brakes: number;
}

export interface Career {
  version: 1;
  name: string;
  difficulty: Difficulty;
  rivals: number;
  money: number;
  truck: number;
  parts: PartCode[];
  cargo: CargoItem[];
  condition: Condition;
  market: Good[];
  weather: Record<TrackId, Weather>;
  drivers: Driver[];
  trips: number;
  /** Повідомлення про результат останнього заїзду (показується на базі). */
  report: string | null;
  seed: number;
  /** Вмʼятини кузова за зонами (накопичена сила ударів) — до ремонту на базі. */
  dents?: Record<string, number>;
}

/** Підсумок заїзду для розрахунку. */
export interface TripResult {
  track: TrackId;
  finished: boolean;
  /** Місце серед учасників (1 — перше), якщо фінішував. */
  place: number;
  racers: number;
  time: number;
  /** Сумарна сила ударів (м/с різкої зміни швидкості) — пошкодження машини й вантажу. */
  hits: number;
  /** Пройдено, м. */
  distance: number;
  /** Знос уже нараховано під час заїзду (applyWear) — не рахувати вдруге. */
  liveWear?: boolean;
}

export const START_MONEY = 30000;
/** Імена водіїв-суперників з HTruck.exe. */
const AI_NAMES = ['JOHN', 'MARY', 'ROGER', 'HELEN', 'GEORGE', 'BOB', 'RON'];

/** Детермінований генератор (mulberry32) — щоб ринок і погода не змінювались від перезавантаження. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Асортимент змінюється після кожного рейсу: у кожній із 7 секцій — один із її 4 товарів. */
export function rollMarket(seed: number): Good[] {
  const r = rng(seed);
  return Array.from({ length: 7 }, (_, section) => {
    const variant = Math.floor(r() * 4);
    const [name, price, weight, volume, durability] = GOODS[section * 4 + variant];
    return { name, section, variant, price, weight, volume, fragility: Math.round((1 - durability) * 100) / 100 };
  });
}

export function rollWeather(seed: number): Record<TrackId, Weather> {
  const r = rng(seed ^ 0x5eed);
  const w = {} as Record<TrackId, Weather>;
  for (const id of Object.keys(TRACKS) as TrackId[]) w[id] = r() < 0.3 ? 'rain' : 'clear';
  return w;
}

export function newCareer(opts: { name: string; difficulty: Difficulty; rivals: number; trucks: TruckSpec[]; seed?: number }): Career {
  const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
  const r = rng(seed ^ 0xa1);
  const cheapest = [...opts.trucks].sort((a, b) => a.price - b.price)[0];
  const rivals = Math.max(0, Math.min(7, opts.rivals));
  const drivers: Driver[] = [{ name: opts.name, ai: false, truck: cheapest.index, money: START_MONEY + cheapest.price, lastTime: null }];
  const others = opts.trucks.filter((t) => t.index !== cheapest.index);
  for (let i = 0; i < rivals; i++) {
    const t = others[i % others.length] ?? cheapest;
    drivers.push({ name: AI_NAMES[i % AI_NAMES.length], ai: true, truck: t.index, money: Math.round(t.price * (1.1 + r() * 0.4)), lastTime: null });
  }
  return {
    version: 1,
    name: opts.name,
    difficulty: opts.difficulty,
    rivals,
    money: START_MONEY,
    truck: cheapest.index,
    parts: [],
    cargo: [],
    condition: { tech: 1, tires: 1, brakes: 1 },
    market: rollMarket(seed),
    weather: rollWeather(seed),
    drivers,
    trips: 0,
    report: null,
    seed,
  };
}

export const cargoWeight = (c: Career) => c.cargo.reduce((s, i) => s + i.qty * i.good.weight, 0);
export const cargoVolume = (c: Career) => c.cargo.reduce((s, i) => s + i.qty * i.good.volume, 0);
export const cargoValue = (c: Career) => c.cargo.reduce((s, i) => s + i.qty * i.good.price, 0);

/** Вартість вантажівки з урахуванням ремонту (табло «інформація гравця»). */
export function truckValue(c: Career, spec: TruckSpec): number {
  return Math.round(spec.price * (0.6 + 0.4 * c.condition.tech) - repairCost(c, spec));
}

/** Скільки упаковок товару ще поміститься (гроші, вага, обʼєм). */
export function canLoad(c: Career, spec: TruckSpec, good: Good): number {
  const byMoney = Math.floor(c.money / good.price);
  const byWeight = Math.floor((spec.payload - cargoWeight(c)) / good.weight);
  const byVolume = Math.floor((spec.volume - cargoVolume(c)) / good.volume + 1e-9);
  return Math.max(0, Math.min(byMoney, byWeight, byVolume));
}

/** Завантажити n упаковок із секції (обмеження — як у canLoad). Повертає, скільки завантажено. */
export function loadGood(c: Career, spec: TruckSpec, section: number, n = 1): number {
  const good = c.market[section];
  if (!good) return 0;
  const k = Math.min(n, canLoad(c, spec, good));
  if (k <= 0) return 0;
  c.money -= k * good.price;
  const item = c.cargo.find((i) => i.good.section === section && i.good.variant === good.variant);
  if (item) item.qty += k;
  else c.cargo.push({ good: { ...good }, qty: k });
  return k;
}

/** Повернути n упаковок цієї секції (гроші — назад повністю, як на складі). */
export function unloadGood(c: Career, section: number, n = 1): number {
  const item = c.cargo.find((i) => i.good.section === section);
  if (!item) return 0;
  const k = Math.min(n, item.qty);
  item.qty -= k;
  c.money += k * item.good.price;
  if (item.qty === 0) c.cargo.splice(c.cargo.indexOf(item), 1);
  return k;
}

/**
 * Автозавантаження перед комерційною трасою, якщо кузов порожній: «з урахуванням фінансового стану» —
 * на половину готівки, найвигідніший за ціною упаковки товар, що вміщується.
 */
export function autoLoad(c: Career, spec: TruckSpec): number {
  if (c.cargo.length) return 0;
  const budget = c.money / 2;
  const goods = [...c.market].sort((a, b) => b.price / b.weight - a.price / a.weight);
  let loaded = 0;
  for (const g of goods) {
    const want = Math.floor((budget - cargoValue(c)) / g.price);
    if (want > 0) loaded += loadGood(c, spec, g.section, want);
  }
  return loaded;
}

export function repairCost(c: Career, spec: TruckSpec): number {
  const k = c.condition;
  return Math.round(spec.price * 0.25 * (1 - k.tech) + 1200 * (1 - k.tires) + 900 * (1 - k.brakes));
}

/** Ремонт на базі: повністю, якщо вистачає грошей. */
export function repair(c: Career, spec: TruckSpec): boolean {
  const cost = repairCost(c, spec);
  if (cost <= 0 || cost > c.money) return false;
  c.money -= cost;
  c.condition = { tech: 1, tires: 1, brakes: 1 };
  c.dents = {};
  return true;
}

/**
 * Знос: шини й гальма — від пробігу, техстан — від ударів (аркада теж зношує, але це не впливає на керування).
 * Нараховується під час заїзду порціями — смуги табло падають одразу.
 */
export function applyWear(c: Career, hits: number, meters: number): void {
  const km = meters / 1000;
  const k = c.condition;
  k.tires = clamp01(k.tires - km * 0.02 * (c.parts.includes('ШН') ? 0.5 : 1));
  k.brakes = clamp01(k.brakes - km * 0.015 * (c.parts.includes('ДТ') ? 0.5 : 1));
  k.tech = clamp01(k.tech - hits * 0.004);
}

/** Вплив пошкоджень на машину (лише «симулятор»). */
export interface DamageEffects {
  /** Множник моменту двигуна. */
  power: number;
  /** Скільки верхніх передач недоступно. */
  lostGears: number;
  /** Множник сили гальм. */
  brakes: number;
}

/**
 * Рівні пошкоджень як у HTruck.exe (0x4b0070, `_Car_V::check_damage`): двигун на рівні 2 — момент ÷ 3, на
 * рівні 3 — ÷ 12; коробка на рівні 1 — без верхньої передачі, на рівні 2 — без трьох; гальма на рівні 1 —
 * сила ÷ 3, на рівні 2 — × 0,125. Як стан «машина» / «гальма» переходить у рівні — гіпотеза (пороги нижче).
 */
export function damageEffects(c: Career): DamageEffects {
  if (c.difficulty === 'arcade') return { power: 1, lostGears: 0, brakes: 1 };
  const t = c.condition.tech;
  const level = t >= 0.6 ? 0 : t >= 0.35 ? 1 : t >= 0.15 ? 2 : 3;
  const b = c.condition.brakes;
  return {
    power: [1, 1, 1 / 3, 1 / 12][level],
    lostGears: [0, 1, 3, 3][level],
    brakes: b >= 0.5 ? 1 : b >= 0.2 ? 1 / 3 : 0.125,
  };
}

/** «Задовільний стан» — до нього доводить ремонт у дорозі (довідка: тримати клавішу, доки машина не оговтається). */
export const ROAD_REPAIR_TARGET = { tech: 0.6, tires: 0.5, brakes: 0.5 };

/**
 * Один «крок» ремонту в дорозі (утримання кнопки): +2 % до кожного показника нижче задовільного; ціна —
 * як на базі × 1,5 (гіпотеза). Повертає false, якщо ремонтувати нічого або бракує грошей.
 */
export function roadRepairStep(c: Career, spec: TruckSpec): boolean {
  const k = c.condition;
  const T = ROAD_REPAIR_TARGET;
  const before = { ...k };
  const step = 0.02;
  const next = {
    tech: k.tech < T.tech ? Math.min(T.tech, k.tech + step) : k.tech,
    tires: k.tires < T.tires ? Math.min(T.tires, k.tires + step) : k.tires,
    brakes: k.brakes < T.brakes ? Math.min(T.brakes, k.brakes + step) : k.brakes,
  };
  const cost = Math.round(
    1.5 * (spec.price * 0.25 * (next.tech - before.tech) + 1200 * (next.tires - before.tires) + 900 * (next.brakes - before.brakes)),
  );
  if (cost <= 0 || cost > c.money) return false;
  c.money -= cost;
  c.condition = next;
  return true;
}

/** Ціна «Відновитися» (поставити перевернуту машину на колеса): 5 % вартості вантажівки, не менше 1000 $ (гіпотеза). */
export function recoverCost(spec: TruckSpec): number {
  return Math.max(1000, Math.round(spec.price * 0.05));
}

/** Покупка вантажівки: різниця «нова − стара» має бути меншою за готівку (довідка). */
export function buyTruck(c: Career, specs: TruckSpec[], index: number): 'ok' | 'same' | 'money' | 'cargo' {
  if (index === c.truck) return 'same';
  const cur = specs.find((s) => s.index === c.truck)!;
  const next = specs.find((s) => s.index === index)!;
  const diff = next.price - truckValue(c, cur);
  if (diff >= c.money) return 'money';
  if (cargoWeight(c) > next.payload || cargoVolume(c) > next.volume) return 'cargo';
  c.money -= diff;
  c.truck = index;
  c.condition = { tech: 1, tires: 1, brakes: 1 };
  // Установлені системи переходять на нову машину (у довідці про це нічого — спрощення).
  c.drivers[0].truck = index;
  return 'ok';
}

export function buyPart(c: Career, index: number): 'ok' | 'have' | 'money' {
  const part = PARTS[index];
  if (!part) return 'have';
  // Шини можна міняти щоразу (нова гума); решту — один раз.
  if (part.code !== 'ШН' && c.parts.includes(part.code)) return 'have';
  if (part.price > c.money) return 'money';
  c.money -= part.price;
  if (!c.parts.includes(part.code)) c.parts.push(part.code);
  if (part.code === 'ШН') c.condition.tires = 1;
  return 'ok';
}

/** Фізика машини в заїзді: у симуляторі — вантаж, знос шин і дощ; в аркаді — без них. */
export function truckSetup(c: Career, spec: TruckSpec, track: TrackId) {
  const torque = c.parts.includes('ФД') ? 1.2 : 1;
  // РС — сидіння вище на 12 см (гіпотеза); АПС — обмеження буксування (лише «симулятор»).
  const seatRaise = c.parts.includes('РС') ? 0.12 : 0;
  if (c.difficulty === 'arcade') return { torque, seatRaise, surfaceEffects: false };
  const rain = c.weather[track] === 'rain' ? 0.8 : 1;
  const tires = 0.75 + 0.25 * c.condition.tires;
  const fill = spec.volume > 0 ? Math.min(1, cargoVolume(c) / spec.volume) : 0;
  return {
    torque,
    seatRaise,
    tractionControl: c.parts.includes('АПС'),
    grip: rain * tires,
    cargoMass: cargoWeight(c),
    cargoHeight: fill * 2.4,
  };
}

const money = (n: number) => `${Math.round(n).toLocaleString('uk-UA')} $`;

/** Частка побитого вантажу від сили ударів за рейс: крихкість товару, пневмопідвіска (ПП) — удвічі менше. */
export function cargoBroken(c: Career, hits: number): number {
  const value = cargoValue(c);
  const fragility = c.cargo.length ? c.cargo.reduce((s, i) => s + i.good.fragility * i.qty * i.good.price, 0) / Math.max(1, value) : 0;
  const suspension = c.parts.includes('ПП') ? 0.5 : 1;
  return Math.min(0.9, (hits / 60) * fragility * suspension);
}

/**
 * Розрахунок після заїзду: виручка, знос, гроші суперників, нові ринок і погода.
 * Комерційні: продаж вантажу = вартість × (1 + надбавка за маршрут) × (1 − побите) × бонуси за місце й дощ.
 * Кільце/полігон: приз за місце (дощ — +30 %).
 */
export function settleTrip(c: Career, specs: TruckSpec[], res: TripResult): string {
  const info = TRACKS[res.track];
  const rain = c.weather[res.track] === 'rain';
  const lines: string[] = [];
  let income = 0;
  const placeBonus = res.finished ? Math.max(0, (res.racers - res.place) / Math.max(1, res.racers - 1)) : 0;

  if (info.kind === 'commercial') {
    const value = cargoValue(c);
    const broken = cargoBroken(c, res.hits);
    if (res.finished && value > 0) {
      const markup = 0.1 + info.difficulty * 0.03;
      income = value * (1 + markup) * (1 - broken) * (1 + 0.15 * placeBonus) * (rain ? 1.3 : 1);
      lines.push(`Вантаж продано за ${money(income)} (куплено за ${money(value)}).`);
      lines.push(`Побито ${Math.round(broken * 100)} % вантажу; місце ${res.place} з ${res.racers}${rain ? '; дощ +30 %' : ''}.`);
    } else if (value > 0) {
      lines.push(`Рейс не завершено — вантаж повернувся на базу (побито ${Math.round(broken * 100)} %).`);
      // Незавершений рейс: вантаж лишається в кузові, пошкоджена частина пропадає.
      for (const i of c.cargo) i.qty = Math.floor(i.qty * (1 - broken));
      c.cargo = c.cargo.filter((i) => i.qty > 0);
    } else lines.push('Рейс без вантажу — нічого продавати.');
    if (res.finished) c.cargo = [];
  } else if (res.finished) {
    const prizes = info.kind === 'laps' ? [6000, 3000, 1500] : [4000, 2500, 1500];
    income = (prizes[res.place - 1] ?? 500) * (rain ? 1.3 : 1);
    lines.push(`${info.title}: місце ${res.place} з ${res.racers}, час ${fmt(res.time)}. Приз ${money(income)}.`);
  } else lines.push(`${info.title}: заїзд не завершено.`);

  c.money += Math.round(income);

  if (!res.liveWear) applyWear(c, res.hits, res.distance);
  const rc = repairCost(c, specs.find((s) => s.index === c.truck)!);
  if (rc > 0) lines.push(`Ремонт обійдеться в ${money(rc)}.`);

  // Суперники теж заробляють: тим більше, чим вище вони фінішували (місця — випадкові).
  const r = rng(c.seed + c.trips * 7919);
  for (const d of c.drivers) {
    if (!d.ai) {
      d.money = c.money + cargoValue(c) + truckValue(c, specs.find((s) => s.index === c.truck)!);
      d.lastTime = res.finished ? res.time : null;
      continue;
    }
    d.money += Math.round((r() - 0.25) * 4000);
    d.lastTime = res.finished ? Math.round(res.time * (0.9 + r() * 0.3)) : null;
  }

  c.trips++;
  c.market = rollMarket(c.seed + c.trips);
  c.weather = rollWeather(c.seed + c.trips);
  c.report = lines.join('\n');
  return c.report;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export function formatMoney(n: number): string {
  return money(n);
}

// --- Збереження (localStorage; профілі невеликі). Як в оригіналі — кілька ігор, по одній на водія. ---
const KEY = 'ht.careers.v1';
const LAST = 'ht.career.last';
const DRIVER = 'ht.driver';
const OLD_KEY = 'ht.career.v1';

function readAll(): Record<string, Career> {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, Career>;
    // Перенесення єдиного збереження попередньої версії.
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const c = JSON.parse(old) as Career;
      if (c?.version === 1 && !all[c.name]) all[c.name] = c;
      localStorage.removeItem(OLD_KEY);
      localStorage.setItem(KEY, JSON.stringify(all));
    }
    return all;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Career>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* приватний режим тощо — гра йде без збереження */
  }
}

export function saveCareer(c: Career): void {
  const all = readAll();
  all[c.name] = c;
  writeAll(all);
  try {
    localStorage.setItem(LAST, c.name);
  } catch {
    /* ігноруємо */
  }
}

/** Гра водія name (або остання зіграна). */
export function loadCareer(name?: string): Career | null {
  const all = readAll();
  let key = name;
  if (key === undefined) {
    try {
      key = localStorage.getItem(LAST) ?? undefined;
    } catch {
      key = undefined;
    }
  }
  const c = key !== undefined ? all[key] : undefined;
  return c?.version === 1 ? c : null;
}

/** Усі збережені ігри (список «Существующие игры»). */
export function listCareers(): Career[] {
  return Object.values(readAll()).filter((c) => c?.version === 1);
}

export function deleteCareer(name: string): void {
  const all = readAll();
  delete all[name];
  writeAll(all);
}

/** Поточний водій (екран «Сменить водителя»); за замовчуванням — як в оригіналі. */
export function currentDriver(): string {
  try {
    return localStorage.getItem(DRIVER) || 'Водій';
  } catch {
    return 'Водій';
  }
}

export function setCurrentDriver(name: string): void {
  try {
    localStorage.setItem(DRIVER, name);
  } catch {
    /* ігноруємо */
  }
}

const TRUCK_NAMES: Record<string, string> = {
  zil: 'ЗіЛ',
  volvo: 'Volvo',
  freight: 'Freightliner',
  scania: 'Scania',
  mack: 'Mack',
  iveco: 'Iveco',
  kenworth: 'Kenworth',
  kamaz: 'КамАЗ',
  reno: 'Renault',
};

/** Економічні дані вантажівки з її опису в TRUCK.TCH. */
export function truckSpec(def: {
  index: number;
  carNode: string;
  tech: { price: number; cargoLoad: number; bodySquare: number; bodyHeight: number; horsePower: number };
}): TruckSpec {
  const t = def.tech;
  return {
    index: def.index,
    name: TRUCK_NAMES[def.carNode.toLowerCase()] ?? def.carNode,
    price: t.price,
    payload: t.cargoLoad,
    volume: Math.round(t.bodySquare * t.bodyHeight * 10) / 10,
    horsePower: t.horsePower,
  };
}
