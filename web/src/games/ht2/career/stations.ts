import { SidePanel } from '../ui/panel';
import type { EscArt } from '../ui/escArt';
import type { Upgrade } from './upgrades';

/**
 * Вікна біля обʼєктів у вигляді king.exe (re/notes/ht2/ui.md §3): склад (`BackOrder` «ЗАКАЗ»), ринок (`BackSale`
 * «ПРОДАЁТСЯ»), СТО (`BackService` «СЕРВИС»), заправка (`BackGas` «ЗАПРАВКА»). Координати текстів, прапорців і
 * кнопок — з king.exe (0x56bc80, 0x520e30, 0x520240). Що в оригіналі робиться клавішами (Num+ — взяти/купити), у
 * порту — кнопками під полями.
 */
const VALUE = 'rgb(240, 232, 150)';
const LCD = 'rgb(255, 40, 30)';
/** Кнопки дій складу, ринку й найму: правий край вікна й ширина колонки значень, пікселі фону. */
const ACT_RIGHT = 205;
const ACT_W = 90;

export interface OrderView {
  goods: string;
  town: string;
  pay: number;
  /** Термін, години гри. */
  hours: number;
  mass: number;
  volume: number;
  /** Крихкість, % (merchandise.sch). */
  fragility: number;
  dock: number;
}

/** Склад: замовлення цього місця завантаження (king.exe: поля з x = 125, рядки 572…692 через 20). */
export function orderPanel(art: EscArt, parent: HTMLElement, o: OrderView, take: () => void): SidePanel {
  const p = new SidePanel(art, parent, 'm_16\\BackOrder.txr');
  const rows = [
    o.goods,
    o.town,
    `$${Math.round(o.pay)}`,
    `${Math.floor(o.hours)}:${String(Math.round((o.hours % 1) * 60)).padStart(2, '0')}`,
    `${(o.mass / 1000).toFixed(2)}Т`,
    `${o.volume.toFixed(2)}М3`,
    `${Math.round(o.fragility)}%`,
  ];
  rows.forEach((t, i) => p.write(125, 572 + i * 20, t.slice(0, 16), VALUE));
  // Підпис — посередині червоної смуги фону (рядки 716…735), біля правого краю вікна, як і кнопка.
  p.write(ACT_RIGHT, 730, `СКЛАД ЗАВАНТАЖЕННЯ ${o.dock}`, VALUE, undefined, 'right');
  p.action(ACT_RIGHT - ACT_W, 745, ACT_W, 'Взяти', take);
  return p;
}

export interface SaleView {
  model: string;
  price: number;
  power: number;
  load: number;
  used: boolean;
}

/** Ринок: машина, біля якої стоїмо (king.exe: x = 103, рядки 600…660). */
export function salePanel(art: EscArt, parent: HTMLElement, s: SaleView, buy: () => void): SidePanel {
  const p = new SidePanel(art, parent, 'm_16\\BackSale.txr');
  p.write(103, 600, s.model + (s.used ? ' ВЖИВ.' : ''), VALUE);
  p.write(103, 620, `$${Math.round(s.price)}`, VALUE);
  p.write(103, 640, `${Math.round(s.power)} К.С.`, VALUE);
  p.write(103, 660, `${(s.load / 1000).toFixed(2)}Т`, VALUE);
  p.action(ACT_RIGHT - ACT_W, 690, ACT_W, 'Купити', buy);
  return p;
}

export interface JobView {
  name: string;
  tariff: number;
  photo: number;
  model: string;
  price: number;
  power: number;
  load: number;
}

/**
 * Водій шукає роботу (`BackJob`, king.exe тип 0x18): фото в рамці (97, 453), рядки клітинок з 564 через 20 —
 * імʼя, тариф за 10 км, машина, ціна; потужність і вантажність — у ширших клітинках (значення з x 145).
 */
export function jobPanel(art: EscArt, parent: HTMLElement, j: JobView, hire: () => void): SidePanel {
  const p = new SidePanel(art, parent, 'm_16\\BackJob.txr');
  p.image(`m16\\escphoto${String(j.photo).padStart(2, '0')}.txr`, 98, 454);
  p.write(101, 580, j.name, VALUE);
  p.write(101, 600, `$${j.tariff} / 10 КМ`, VALUE);
  p.write(101, 620, j.model, VALUE);
  p.write(101, 640, `$${Math.round(j.price)}`, VALUE);
  p.write(145, 660, `${Math.round(j.power)} К.С.`, VALUE);
  p.write(145, 680, `${(j.load / 1000).toFixed(2)}Т`, VALUE);
  p.action(ACT_RIGHT - ACT_W, 700, ACT_W, 'Найняти', hire);
  return p;
}

/** Системи ремонту за клітинками вікна (king.exe: група (412, 481), стовпчики x = 0 і 181, рядки через 19). */
const REPAIRS = [
  ['engine', 0, 0],
  ['gearbox', 0, 1],
  ['transmission', 0, 2],
  ['brakes', 0, 3],
  ['lights', 1, 0],
  ['body', 1, 1],
  ['tires', 1, 2],
  ['full', 1, 3],
] as const;

/**
 * Модернізації за клітинками (група (231, 613): стовпчик x = 0 — 6 рядків з y = 0, x = 181 і 362 — по 7 з y = −19);
 * порядок — як підписи на фоні BackService.
 */
const UPGRADE_SLOTS: [string, number, number][] = [
  ['PR_ADJUSTABLE_SUSPENSION:1', 0, 0],
  ['PR_BRAKES:1', 0, 1],
  ['PR_ENGINE_BRAKE:1', 0, 2],
  ['PR_REINFORCED_CHASSIS:1', 0, 3],
  ['PR_BULETPROOF_GLASS:1', 0, 4],
  ['PR_HEADLIGHT_PROTECTION:1', 0, 5],
  ['PR_FORCED_ENGINE:1', 1, -1],
  ['PR_OIL_ADDITIVE:1', 1, 0],
  ['PR_AIR_FILTER_SNORKEL:1', 1, 1],
  ['PR_TIRES:1', 1, 2],
  ['PR_TIRES:2', 1, 3],
  ['PR_EXTRA_TANK:1', 1, 4],
  ['PR_ABS:1', 1, 5],
  ['PR_ANTI_RADAR:1', 2, -1],
  ['PR_STEALTH_BODY_PAINT:1', 2, 0],
  ['PR_CARGO_SCANNER:1', 2, 1],
  ['PR_FIRE_PROTECTION:1', 2, 2],
  ['PR_NAVIGATOR:1', 2, 3],
  ['PR_HORN:1', 2, 4],
  ['ALL', 2, 5],
];

export interface ServiceView {
  /** Пошкодження машини 0…1 і ціна повного ремонту. */
  damage: number;
  repairCost: number;
  money: () => number;
  upgrades: Upgrade[];
  owned: readonly string[];
  /** Покращення, які продає ця СТО (mod_*.sch); null — усі. */
  available: Set<string> | null;
}

/**
 * СТО: прапорці ремонту систем і модернізацій, «МОЙ БАЛАНС» та «ИТОГО», OK (`servpay`) і скасування (`servcanc`).
 * В порту пошкодження — одне число: кожна система — 1/7 ремонту, «полный ремонт» — усе (гіпотеза).
 */
export function servicePanel(
  art: EscArt,
  parent: HTMLElement,
  v: ServiceView,
  act: { pay(repair: number, buy: Upgrade[]): boolean; close(): void },
): SidePanel {
  const p = new SidePanel(art, parent, 'm_16\\BackService.txr');
  const repairs = new Set<string>();
  const buy = new Set<string>();
  const byKey = new Map(v.upgrades.map((u) => [u.key, u]));
  const can = (key: string) => byKey.has(key) && !v.owned.includes(key) && (!v.available || v.available.has(key));
  const damaged = v.damage > 0.005;
  const repairShare = () => (repairs.has('full') ? 1 : Math.min(1, repairs.size / 7));
  const total = () => Math.round(v.repairCost * repairShare()) + [...buy].reduce((sum, k) => sum + (byKey.get(k)?.price ?? 0), 0);
  const paints: (() => void)[] = [];
  const redraw = () => {
    p.clear();
    p.write(338, 762, `$${Math.round(v.money())}`, VALUE, art.menu, 'right');
    p.write(518, 762, `$${total()}`, VALUE, art.menu, 'right');
    for (const f of paints) f();
  };
  for (const [key, col, row] of REPAIRS) {
    const b = p.button(
      'm_16\\check',
      412 + col * 181,
      481 + row * 19,
      key,
      () => {
        if (!damaged) return;
        if (repairs.has(key)) repairs.delete(key);
        else repairs.add(key);
        redraw();
      },
      () => (!damaged ? 'ok' : repairs.has(key) || repairs.has('full') ? 'pp' : null),
    );
    paints.push(b.paint);
  }
  for (const [key, col, row] of UPGRADE_SLOTS) {
    const b = p.button(
      'm_16\\check',
      231 + col * 181,
      613 + row * 19,
      key,
      () => {
        if (key === 'ALL') {
          const all = UPGRADE_SLOTS.map((s) => s[0]).filter((k) => k !== 'PR_TIRES:2' && can(k));
          const on = all.every((k) => buy.has(k));
          for (const k of all) on ? buy.delete(k) : buy.add(k);
        } else if (can(key)) {
          if (buy.has(key)) buy.delete(key);
          else {
            // Варіанти одного покращення (шини) — взаємовиключні.
            const id = key.split(':')[0];
            for (const k of buy) if (k.startsWith(`${id}:`)) buy.delete(k);
            buy.add(key);
          }
        }
        redraw();
      },
      () => (key === 'ALL' ? null : v.owned.includes(key) ? 'ok' : !can(key) ? 'n' : buy.has(key) ? 'pp' : null),
    );
    paints.push(b.paint);
  }
  p.button('m_16\\servpay', 209, 800, 'Оплатити', () => {
    if (act.pay(repairShare(), [...buy].map((k) => byKey.get(k)!).filter(Boolean))) act.close();
    else redraw();
  });
  p.button('m_16\\servcanc', 349, 800, 'Скасувати', () => act.close());
  redraw();
  return p;
}

export interface GasView {
  fuel: number;
  tank: number;
  price: number;
  money: () => number;
}

/**
 * Заправка: табло «СУММА, $», «ЛИТРЫ», «ЗА ЛИТР» (червоні цифри), повзунок рівня (25, 655) і «полный» (175, 655),
 * літри й сума в таблиці, OK (`gaspay`, (52, 755)) і скасування (`gascanc`, (123, 755)).
 */
export function gasPanel(art: EscArt, parent: HTMLElement, g: GasView, act: { pay(litres: number): boolean; close(): void }): SidePanel {
  const p = new SidePanel(art, parent, 'm_16\\BackGas.txr');
  const room = Math.max(0, g.tank - g.fuel);
  let litres = Math.floor(room);
  let full = true;
  // Червоні табло — малі цифри icon.fon (код + 0x10), цілі числа (крапки в шрифті немає).
  const lcd = (y: number, v: number) => {
    const t = String(Math.round(v));
    if (art.icon) p.write(183, y, [...t].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x10)).join(''), LCD, art.icon, 'right');
    else p.write(183, y, t, LCD, art.menu, 'right');
  };
  let runner: HTMLImageElement | null = null;
  const redraw = () => {
    p.clear();
    const cost = litres * g.price;
    lcd(498, cost);
    lcd(553, litres);
    lcd(598, g.price);
    p.write(85, 722, String(litres), VALUE, art.menu, 'center');
    p.write(168, 722, `$${Math.round(cost)}`, VALUE, art.menu, 'center');
    if (runner) runner.style.left = `${40 + Math.round((room > 0 ? litres / room : 1) * 120) - 6}px`;
  };
  // Доріжка повзунка (40…160 по x): дотик ставить рівень.
  const track = p.action(34, 640, 132, '', () => undefined);
  track.classList.add('ht2-panel-track');
  runner = p.image('m_16\\runner_p.msk', 0, 646);
  if (runner) runner.style.pointerEvents = 'none';
  track.addEventListener('pointerdown', (e) => {
    const r = track.getBoundingClientRect();
    litres = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * room);
    full = litres >= Math.floor(room);
    fullBtn.paint();
    redraw();
  });
  const fullBtn = p.button(
    'm_16\\gasfull',
    175,
    655,
    'Повний бак',
    () => {
      full = !full;
      litres = full ? Math.floor(room) : 0;
      redraw();
    },
    () => (full ? 'pp' : null),
  );
  p.button('m_16\\gaspay', 52, 755, 'Оплатити', () => {
    if (act.pay(litres)) act.close();
  });
  p.button('m_16\\gascanc', 123, 755, 'Скасувати', () => act.close());
  redraw();
  return p;
}
