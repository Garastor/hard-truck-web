import { isList, num, str, type SExpr } from '../formats/sexpr';
import type { Way } from '../formats/way';
import { ukName } from '../ui/uk';

/**
 * Економіка Дальнобойщиків 2 (G6, перша версія).
 *
 * Склади (бази) — вузли WAY `node_store_NNMM` (NN — номер складу, MM — місце завантаження 00…04); місто — за
 * дорожнім знаком регіону `town_<код>.txr` (назви прочитано з текстур). Товари — `merchandise.sch`:
 * `(ID упаковка вага_кг обʼєм_м3 (кількість? ціна коеф. (класи машин)) коеф. іконка "Назва")` — розкладка полів
 * частково гіпотеза (ціна одиниці — друге число в дужках: молоко 10, говядина 375, Pentium III 5000).
 *
 * Оплата замовлення — за поведінкою HT2 (ai_ordr.cpp, розібрано спільнотою — ht2-rev; власна реалізація):
 * цінність вантажу V = √(ціна × кількість) · 10; оплата = (довжина маршруту_м · 115/1000 + (1,2 − коеф.) · √(ціна ×
 * кількість)) · 3; термінове — ×1,5. Термін, неустойка й пошкодження — гіпотези порту (див. нижче).
 */
export interface Goods {
  id: string;
  name: string;
  /** Вага й обʼєм одиниці. */
  mass: number;
  volume: number;
  price: number;
  ratio: number;
  /**
   * Міцність 0…1 — число після внутрішнього списку (`+0x40` запису товару king.exe; яйця 0,21, скло 0,23, вата 0,96,
   * нелегальне 1): шкода вантажу від удару ∝ 1 − міцність (hitPlayer 0x446d20, `cargoHit`).
   */
  durability: number;
  illegal: boolean;
  forMafia: boolean;
  /**
   * Чим возять (клас у дужках): `trucks` — вантажівки, `cars` — легкові (C_*: піца, пошта, зарплата), `fuel` —
   * лише цистерна (Ms.sch NEED_A_PETROL_SEMITRAILER).
   */
  trucks: boolean;
  fuel: boolean;
  /** Легкові вантажі (C_*). */
  cars: boolean;
  /**
   * Коефіцієнт штрафу за нелегальний товар — число після списку класів (АКМ 0,7, рад. відходи 1,2; штраф
   * 15000 × коеф., king.exe 0x430760); 0 — немає.
   */
  guilt: number;
}

export interface Store {
  /** Номер складу (00…14). */
  id: number;
  region: string;
  town: string;
  /** Товари міста (ID з merchandise.sch, `mod_<регіон>.sch`); порожньо — будь-які. */
  goods: string[];
  /** Місця завантаження (координати гри). */
  docks: [number, number, number][];
  center: [number, number, number];
}

export interface Order {
  goods: Goods;
  units: number;
  from: number;
  to: number;
  /** Довжина маршруту, м (оцінка). */
  distance: number;
  pay: number;
  value: number;
  /** Термін, с ігрового часу. */
  deadline: number;
  urgent: boolean;
  /**
   * Прихований нелегальний товар під виглядом `goods` (king.exe fillTownOrder 0x41b3a0): гравець бачить лише
   * прикриття (без сканера), оплата — за справжнім товаром; міліція конфіскує при затриманні.
   */
  hidden?: Goods;
}

/** Регіони без землі в порту: склади там не використовуємо (aa тепер має процедурний рельєф, terrain.ts). */
export const NO_GROUND = new Set<string>();

/** Міста за дорожніми знаками `town_<код>.txr` (регіон → назва). */
export const TOWNS: Record<string, string> = {
  aa: 'Алмазний',
  ad: 'Борове',
  aj: 'Приозерськ',
  am: 'Шахти',
  ap: 'Південний',
  ar: 'Залісськ',
  au: 'Єльніно',
  bd: 'Бухта',
  cb: 'Нижньогірськ',
  dc: 'Гірський',
  dr: 'Кільце',
};

export function parseGoods(sch: SExpr[]): Goods[] {
  const out: Goods[] = [];
  for (const e of sch) {
    if (!isList(e) || typeof e[0] !== 'string' || !isList(e[4])) continue;
    const inner = e[4];
    const classes = inner.find((x): x is SExpr[] => isList(x)) ?? [];
    // Деякі товари без назви (ANALEPSIN…) — показуємо ID.
    const name = ukName(str(e[e.length - 1]) || e[0]);
    out.push({
      id: e[0],
      name,
      mass: num(e[2]),
      volume: num(e[3]),
      price: num(inner[1]),
      ratio: num(inner[2], 0.8),
      durability: num(e[5], num(inner[2], 0.8)),
      illegal: classes.includes('illegal'),
      forMafia: classes.includes('formafia'),
      trucks: classes.includes('trucks'),
      fuel: classes.includes('fuel'),
      cars: classes.includes('cars'),
      guilt: typeof inner[4] === 'number' ? inner[4] : 0,
    });
  }
  return out;
}

/** Місто зі складом з `ENV/mod_<регіон>.sch`. */
export interface Town {
  store: number;
  name: string;
  region: string;
  goods: string[];
}

/**
 * Міста: `(town TOWN_AJ "Приозерск" 0 () ((node "node_store_0000" unload) …) () ((BREAD 0) (TEA 0) …) …)` — назва,
 * номер складу, вузли місць завантаження, товари (число після ID — невідоме, гіпотеза: запас чи частка). Записи
 * без вузлів `node_store_*` (АЗС, газгольдери) пропускаємо.
 */
export function parseTowns(mods: Iterable<{ region: string; sch: SExpr[] }>): Map<number, Town> {
  const out = new Map<number, Town>();
  for (const { region, sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'town' || !isList(e[5])) continue;
      const nodes = e[5].filter(isList).map((n) => str(n[1]));
      if (!nodes.some((n) => /^node_store_\d{4}$/i.test(n))) continue;
      const goods = isList(e[7]) ? e[7].filter(isList).map((g) => str(g[0]).toUpperCase()) : [];
      out.set(num(e[3]), { store: num(e[3]), name: ukName(str(e[2])), region, goods });
    }
  return out;
}

/**
 * СТО: `(service STO_AC "" 5 "sto_ac" ((PR_FORCED_ENGINE 1) … (PR_TIRES 3) …))` — вузол WAY і покращення, що там
 * продаються. Значення — варіанти бітами (шини: 1 — шосейні, 2 — позашляхові, 3 — обидва), у решти 1 — є.
 * Повертає вузол (малими) → ключі `PR_ID:варіант` (як у upgrades.ts).
 */
export function parseServices(mods: Iterable<{ region: string; sch: SExpr[] }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { sch } of mods)
    for (const e of sch) {
      if (!isList(e) || e[0] !== 'service' || !isList(e[5])) continue;
      const keys = new Set<string>();
      for (const u of e[5]) {
        if (!isList(u)) continue;
        const v = num(u[1]);
        for (let bit = 0; bit < 4; bit++) if (v & (1 << bit)) keys.add(`${str(u[0])}:${bit + 1}`);
      }
      out.set(str(e[4]).toLowerCase(), keys);
    }
  return out;
}

/** Склади з вузлів WAY усіх регіонів (назви й товари — з міст mod_*.sch, якщо є). */
export function findStores(ways: Iterable<{ id: string; way: Way }>, towns: Map<number, Town> = new Map()): Store[] {
  const byId = new Map<number, Store>();
  for (const { id: region, way } of ways)
    for (const room of way.rooms)
      for (const n of room.nodes) {
        const m = /^node_store_(\d\d)(\d\d)$/.exec(n.name);
        if (!m) continue;
        const sid = Number(m[1]);
        const t = towns.get(sid);
        const s = byId.get(sid) ?? byId.set(sid, { id: sid, region, town: t?.name || TOWNS[region] || `База ${m[1]}`, goods: t?.goods ?? [], docks: [], center: [0, 0, 0] }).get(sid)!;
        s.docks.push(n.pos);
      }
  // Склади з одним місцем (11, 13, 14) — допоміжні (гіпотеза: точки сценаріїв), у торгівлі не беруть участі.
  const stores = [...byId.values()].filter((s) => s.docks.length >= 3 && !NO_GROUND.has(s.region));
  for (const s of stores) s.center = [0, 1, 2].map((k) => s.docks.reduce((a, p) => a + p[k], 0) / s.docks.length) as [number, number, number];
  return stores.sort((a, b) => a.id - b.id);
}

/** Відстань маршруту — пряма × 1,35 (гіпотеза: дороги петляють; точний маршрут — пошуком по мережі, пізніше). */
export function routeLength(a: Store, b: Store): number {
  return Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) * 1.35;
}

/**
 * Удар по вантажу (king.exe: обробник колізії 0x554c20 → слот +0xb4 0x554bb0 → hitPlayer 0x446d20). dv — сила удару,
 * м/с (зміна швидкості від зіткнення, з вертикаллю — приземлення після стрибка), уже помножена на коефіцієнт рами
 * (посилена рама ×0,3); suspension — пневмопідвіска ×0,3. Удар слабший за 2 — нічого (той самий поріг, що й для
 * вмʼятин); далі H = dv·suspension, і якщо H > 2 — частка d = (1 − міцність)·H·0,02 (≥ 1 → 1, < 0,01 → 0), якість
 * ×(1 − d). Повертає нову якість або null, якщо удар до вантажу не дійшов (повідомлення X_DAMAGED не показується).
 */
export function cargoHit(quality: number, durability: number, dv: number, suspension: number): number | null {
  if (dv < 2) return null;
  const h = dv * suspension;
  if (h <= 2) return null;
  let d = (1 - durability) * h * 0.02;
  if (d > 1) d = 1;
  else if (d < 0.01) d = 0;
  return quality * (1 - d);
}

export function orderValue(g: Goods, units: number): number {
  return Math.sqrt(g.price * units) * 10;
}

/**
 * Частка гравця X (career/share.ts, king.exe 0x41fcf0). Прихований товар — лише при X > 0,25 (fillTownOrder);
 * без частки (тести, вільна їзда) — 1.
 */
export const ILLEGAL_SHARE = 1;
const ILLEGAL_SHARE_MIN = 0.25;

/**
 * Прихований товар до замовлення (fillTownOrder 0x41b3a0): з імовірністю 1/5 — випадковий товар з класами рівно
 * `illegal` + `trucks` (рад. і хім. відходи; АКМ, героїн, гексаген — ще й formafia).
 */
export function hideIllegal(goods: Goods[], rnd: () => number): Goods | null {
  if (rnd() >= 0.2) return null;
  const pool = goods.filter((x) => x.illegal && x.trucks && !x.forMafia && !x.cars && !x.fuel);
  return pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
}

/**
 * Оплата складського замовлення гравцю (king.exe 0x471200, виклик з loadOrder 0x4436c2 — re/notes/ht2/trailers-bodies.md
 * §8, company.md §2а): (0,115·L + (1,2 − k)·√(ціна·кількість)) × 3 × 1,2 (гравець) × 4 (складське) = ×14,4, з причепом
 * ще ×1,5 = ×21,6 (найманий і ІІ — без ×1,2). Термінових замовлень у exe немає.
 */
export function orderPay(g: Goods, units: number, distance: number, trailer: boolean): number {
  const base = (1.2 - g.ratio) * Math.sqrt(g.price * units);
  return Math.round((distance * 0.115 + base) * 14.4 * (trailer ? 1.5 : 1));
}

/**
 * Замовлення складу: кілька товарів (легальних) у інші склади. Кількість — «скільки влізе»: 0,85·min(M/m, V/v)
 * (king.exe 0x41ba50); строк — 0,13 с на метр шляху (0x471780); оплата — orderPay (trailer — причіп зчеплено).
 */
export function makeOrders(
  from: Store,
  stores: Store[],
  goods: Goods[],
  capacity: { mass: number; volume: number },
  rnd = Math.random,
  n = 5,
  tanker = false,
  illegalShare = ILLEGAL_SHARE,
  trailer = false,
): Order[] {
  // Вантажі для вантажівок; паливо — лише в цистерну.
  const legal0 = goods.filter((g) => !g.illegal && g.price > 0 && g.mass > 0 && g.trucks && (!g.fuel || tanker));
  // Товари міста складу (mod_*.sch), якщо серед них є відомі; інакше — будь-які.
  const local = legal0.filter((g) => from.goods.includes(g.id.toUpperCase()));
  const legal = local.length ? local : legal0;
  const targets = stores.filter((s) => s.id !== from.id);
  const out: Order[] = [];
  for (let i = 0; i < n && targets.length && legal.length; i++) {
    const g = legal[Math.floor(rnd() * legal.length)];
    const to = targets[Math.floor(rnd() * targets.length)];
    const maxUnits = Math.floor(Math.min(capacity.mass / g.mass, g.volume > 0 ? capacity.volume / g.volume : Infinity));
    if (maxUnits < 1) continue;
    const units = Math.max(1, Math.floor(maxUnits * 0.85));
    const distance = routeLength(from, to);
    const hidden = illegalShare > ILLEGAL_SHARE_MIN && !g.fuel ? hideIllegal(goods, rnd) : null;
    out.push({
      goods: g,
      units,
      from: from.id,
      to: to.id,
      distance,
      pay: orderPay(hidden ?? g, units, distance, trailer),
      value: Math.round(orderValue(g, units)),
      deadline: Math.round(0.13 * distance),
      urgent: false,
      ...(hidden ? { hidden } : {}),
    });
  }
  return out;
}
