import { isList, num, str, type SExpr } from '../../formats/sexpr';
import type { Way } from '../../formats/way';

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
  illegal: boolean;
  forMafia: boolean;
}

export interface Store {
  /** Номер складу (00…14). */
  id: number;
  region: string;
  town: string;
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
}

/** Міста за дорожніми знаками `town_<код>.txr` (регіон → назва). */
export const TOWNS: Record<string, string> = {
  aa: 'Алмазный',
  ad: 'Боровое',
  aj: 'Приозерск',
  am: 'Шахты',
  ap: 'Южный',
  ar: 'Залеск',
  au: 'Ельнино',
  bd: 'Бухта',
  cb: 'Нижнегорск',
  dc: 'Горный',
  dr: 'Кольцо',
};

export function parseGoods(sch: SExpr[]): Goods[] {
  const out: Goods[] = [];
  for (const e of sch) {
    if (!isList(e) || typeof e[0] !== 'string' || !isList(e[4])) continue;
    const inner = e[4];
    const classes = inner.find((x): x is SExpr[] => isList(x)) ?? [];
    const name = str(e[e.length - 1]);
    out.push({
      id: e[0],
      name,
      mass: num(e[2]),
      volume: num(e[3]),
      price: num(inner[1]),
      ratio: num(inner[2], 0.8),
      illegal: classes.includes('illegal'),
      forMafia: classes.includes('formafia'),
    });
  }
  return out;
}

/** Склади з вузлів WAY усіх регіонів. */
export function findStores(ways: Iterable<{ id: string; way: Way }>): Store[] {
  const byId = new Map<number, Store>();
  for (const { id: region, way } of ways)
    for (const room of way.rooms)
      for (const n of room.nodes) {
        const m = /^node_store_(\d\d)(\d\d)$/.exec(n.name);
        if (!m) continue;
        const sid = Number(m[1]);
        const s = byId.get(sid) ?? byId.set(sid, { id: sid, region, town: TOWNS[region] ?? `База ${m[1]}`, docks: [], center: [0, 0, 0] }).get(sid)!;
        s.docks.push(n.pos);
      }
  // Склади з одним місцем (11, 13, 14) — допоміжні (гіпотеза: точки сценаріїв), у торгівлі не беруть участі.
  const stores = [...byId.values()].filter((s) => s.docks.length >= 3);
  for (const s of stores) s.center = [0, 1, 2].map((k) => s.docks.reduce((a, p) => a + p[k], 0) / s.docks.length) as [number, number, number];
  return stores.sort((a, b) => a.id - b.id);
}

/** Відстань маршруту — пряма × 1,35 (гіпотеза: дороги петляють; точний маршрут — пошуком по мережі, пізніше). */
export function routeLength(a: Store, b: Store): number {
  return Math.hypot(a.center[0] - b.center[0], a.center[1] - b.center[1]) * 1.35;
}

export function orderValue(g: Goods, units: number): number {
  return Math.sqrt(g.price * units) * 10;
}

/** Оплата доставки (k = 115 — вантажівка; ×3; термінове ×1,5). */
export function orderPay(g: Goods, units: number, distance: number, urgent: boolean): number {
  const base = (1.2 - g.ratio) * Math.sqrt(g.price * units);
  const pay = (distance * 0.115 + base) * 3;
  return Math.round(urgent ? pay * 1.5 : pay);
}

/**
 * Замовлення складу: кілька товарів (легальних) у інші склади, кількість — у межах вантажопідйомності й обʼєму
 * кузова. Термін (гіпотеза): маршрут на 45 км/год + 3 хв, термінові — на 60 км/год.
 */
export function makeOrders(from: Store, stores: Store[], goods: Goods[], capacity: { mass: number; volume: number }, rnd = Math.random, n = 5): Order[] {
  const legal = goods.filter((g) => !g.illegal && g.price > 0 && g.mass > 0);
  const targets = stores.filter((s) => s.id !== from.id);
  const out: Order[] = [];
  for (let i = 0; i < n && targets.length && legal.length; i++) {
    const g = legal[Math.floor(rnd() * legal.length)];
    const to = targets[Math.floor(rnd() * targets.length)];
    const maxUnits = Math.floor(Math.min(capacity.mass / g.mass, g.volume > 0 ? capacity.volume / g.volume : Infinity));
    if (maxUnits < 1) continue;
    const units = Math.max(1, Math.round(maxUnits * (0.4 + rnd() * 0.6)));
    const distance = routeLength(from, to);
    const urgent = rnd() < 0.25;
    const speed = (urgent ? 60 : 45) / 3.6;
    out.push({
      goods: g,
      units,
      from: from.id,
      to: to.id,
      distance,
      pay: orderPay(g, units, distance, urgent),
      value: Math.round(orderValue(g, units)),
      deadline: Math.round(distance / speed + 180),
      urgent,
    });
  }
  return out;
}
