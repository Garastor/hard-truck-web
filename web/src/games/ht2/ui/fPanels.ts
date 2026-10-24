import { SidePanel } from './panel';
import type { EscArt } from './escArt';
import type { CareerInfo } from '../career/careerMode';
import { formatLeft } from '../career/careerMode';
import { SCANNED, scanPhase } from '../career/stations';
import type { HiredDriver } from '../career/company';
import { netTable, type NetRow } from './netResults';

/**
 * Ліві панелі F1–F4 king.exe (0x5756f0, 0x526470; re/notes/ht2/ui.md §3): F1 «Клавіатура», F2 «Рейтинг», F3 «Інфо»,
 * F4 «Моя компанія». Гра не стає на паузу; та сама клавіша ще раз — закрити, дотик до заголовка — наступна панель.
 * Координати — пікселі фону: F1 з king.exe (рядки клавіш на базовій лінії 472 + 20·n, стовпчики x 25 / 136, друга
 * таблиця — на 170 правіше), F3 — схема машини й значки покращень з 0x574950, решта — за клітинками фону.
 */
export type FPanel = 1 | 2 | 3 | 4;

export interface FPanelData {
  info: CareerInfo | null;
  /** Суперники (names.sch) — у рейтингу після гравця. */
  rivals: string[];
  /** Частка X гравця й одного далекобійника ІІ, 0…1 (career/share.ts) — «доля перевезень». */
  share: number;
  rivalShare: number;
  /** Клавіші порту: назва дії, клавіша. */
  keys: [string, string][];
  /** Наймані водії й ліцензії; дії F4. */
  company: readonly HiredDriver[];
  licences: number;
  swap(i: number): void;
  fire(i: number): void;
  /** Мережева гра: F2 — `BackF2Tball` (місце, імʼя, час чи сума; 0x5756f0 → 0x574810) замість рейтингу кар'єри. */
  net?: NetRow[] | null;
  /** Мережева кар'єра (М6): інші гравці — після себе, перед далекобійниками ІІ. */
  netRating?: { name: string; share: number; hired: number; tons: number }[];
}

const VALUE = 'rgb(240, 232, 150)';
/**
 * Рядки рейтингу (імʼя, частка %, найнято, тонни) через 33 — сітка F2 `BackF2`; та сама сітка (зсунута) — у вікні
 * `BackLoose1` «рынок монополизирован вашим конкурентом» (ui/gameOver.ts).
 */
export function writeRating(p: SidePanel, rows: readonly [string, number, number, number][], dx = 0, dy = 0): void {
  rows.forEach(([name, share, hired, tons], i) => {
    const y = 491 + dy + i * 33;
    // Стовпчик «МЕСТО» сітки — x 16…49 (лінії фону BackF2).
    p.write(32 + dx, y, String(i + 1), VALUE, undefined, 'center', 26);
    p.write(64 + dx, y, name, VALUE, undefined, 'left', 76);
    p.write(168 + dx, y, `${share}%`, VALUE, undefined, 'center', 60);
    p.write(253 + dx, y, String(hired), VALUE, undefined, 'center', 60);
    p.write(328 + dx, y, tons.toFixed(1), VALUE, undefined, 'center', 60);
  });
}

/** Висота рядка кнопок порту під табло, CSS px. */
const HUD_ROW = 40;
const LOW = 'rgb(255, 120, 60)';
/**
 * Смуги-шкали F3/F4 king.exe (0x5756f0, 0x526c90) — суцільні прямокутники кольорами палітри `common.plm`: 5 —
 * червоний (гроші, вантаж, стан систем, аванс), 6 — жовтий (вартість машин). Суми на смузі грошей king.exe пише
 * темним шрифтом пейджера `matrix.fon` (0x569740); у порту — векторний шрифт панелей темним «чорнилом».
 */
const RED = 'rgb(255, 0, 0)';
const YELLOW = 'rgb(255, 255, 0)';
const INK = 'rgba(0, 0, 0, 0.8)';
const SELECTED = RED;

/**
 * Смуга «гроші + машини» (F3 0x5756f0, F4 0x526c90): ліворуч червона — вільні гроші, праворуч жовта — вартість машин,
 * обидві в частках від їхньої суми (менше 1 — 1) на всю ширину w; посередині лишається фон, якщо машини пошкоджені
 * (жовта — за «залишковою» вартістю worth, сума на ній — за повною value). Суми — на смугах: гроші від x0 + 6,
 * машини — до правого краю − 5. Відʼємні гроші — без червоної смуги.
 */
function moneyBar(p: SidePanel, x0: number, y0: number, y1: number, w: number, money: number, value: number, worth: number, base: number): void {
  const total = Math.max(1, money + value);
  const part = (v: number) => Math.max(0, Math.min(w, Math.trunc((v * w) / total)));
  const red = part(money);
  const yellow = part(worth);
  p.bar(x0, y0, red, y1 - y0 + 1, RED);
  p.bar(x0 + w - yellow, y0, yellow, y1 - y0 + 1, YELLOW);
  p.write(x0 + 6, base, `$${Math.round(money)}`, INK, undefined, 'left', w / 2 - 8);
  p.write(x0 + w - 5, base, `$${Math.round(value)}`, INK, undefined, 'right', w / 2 - 8);
}

const BACK: Record<FPanel, string> = {
  1: 'm_16\\BackF1.txr',
  2: 'm_16\\BackF2.txr',
  3: 'm_16\\BackF3.txr',
  4: 'm_16\\BackMy.txr',
};
/** Видимі рядки фону: від заголовка до низу таблиць. */
const VIEW: Record<FPanel, [number, number]> = {
  1: [410, 820],
  2: [408, 808],
  3: [415, 845],
  4: [410, 815],
};
/** F2 мережевої гри: вузький фон 215 px — заголовок «РЕЙТИНГ» і 8 рядків (сітка 544…704). */
const NET_F2 = 'm_16\\BackF2Tball.txr';
const NET_F2_VIEW: [number, number] = [470, 740];

/**
 * Значки встановлених покращень на схемі F3 (king.exe 0x574950): `up_<система>_1` у точці фону; шини — на трьох
 * осях. Ключ — покращення порту (restable.sch).
 */
const UPGRADE_ICONS: [string, string, [number, number][]][] = [
  ['PR_ADJUSTABLE_SUSPENSION', 'susp', [[117, 809]]],
  ['PR_BRAKES', 'vbrake', [[44, 791]]],
  ['PR_ENGINE_BRAKE', 'ebrake', [[47, 792]]],
  ['PR_REINFORCED_CHASSIS', 'shassis', [[27, 742]]],
  ['PR_BULETPROOF_GLASS', 'glass', [[28, 755]]],
  ['PR_HEADLIGHT_PROTECTION', 'hlights', [[24, 786]]],
  ['PR_FORCED_ENGINE', 'engine', [[33, 809]]],
  ['PR_OIL_ADDITIVE', 'oil', [[61, 809]]],
  ['PR_AIR_FILTER_SNORKEL', 'snorkel', [[61, 734]]],
  ['PR_TIRES', 'tire', [[41, 786], [103, 786], [126, 786]]],
  ['PR_EXTRA_TANK', 'ftank', [[71, 785]]],
  ['PR_ABS', 'abs', [[117, 726]]],
  ['PR_ANTI_RADAR', 'radar', [[21, 747]]],
  ['PR_STEALTH_BODY_PAINT', 'stealth', [[117, 754]]],
  ['PR_CARGO_SCANNER', 'scan', [[89, 754]]],
  ['PR_FIRE_PROTECTION', 'fire', [[89, 809]]],
  ['PR_NAVIGATOR', 'navig', [[89, 726]]],
  ['PR_HORN', 'signal', [[38, 737]]],
];
/** Пошкодження, з якого на схемі — значки `engine_0` і `vbrake_0` (поріг king.exe не розібрано — гіпотеза). */
const BROKEN = 0.5;

export class FPanels {
  private panel: SidePanel | null = null;
  private kind: FPanel | null = null;
  private timer = 0;

  constructor(
    private readonly art: EscArt,
    private readonly parent: HTMLElement,
    private readonly data: () => FPanelData,
  ) {}

  get open(): FPanel | null {
    return this.kind;
  }

  /** Відкрити панель; та сама — закрити. */
  toggle(kind: FPanel): void {
    if (this.kind === kind) return this.close();
    this.close();
    this.kind = kind;
    // Під рядком кнопок порту («Меню», ♪, «Карта», «Інфо»), щоб вони не накривали заголовок.
    const net = kind === 2 && !!this.data().net;
    const view = net ? NET_F2_VIEW : VIEW[kind];
    const p = new SidePanel(this.art, this.parent, net ? NET_F2 : BACK[kind], 'left', view, HUD_ROW);
    // Дотик до заголовка — наступна панель (на телефоні немає F1–F4).
    const next = p.action(10, view[0], p.width - 20, '', () => this.toggle(((kind % 4) + 1) as FPanel));
    next.classList.add('ht2-panel-track');
    next.setAttribute('aria-label', 'Наступна панель');
    this.panel = p;
    this.timer = 0;
    if (kind === 4) this.companyControls(p);
    this.draw();
  }

  close(): void {
    this.panel?.close();
    this.panel = null;
    this.kind = null;
  }

  /** Оновлення вмісту (F2–F4 — живі дані) раз на півсекунди. */
  update(dt: number): void {
    if (!this.panel || this.kind === 1) return;
    this.timer += dt;
    if (this.timer < 0.5) return;
    this.timer = 0;
    this.draw();
  }

  private draw(): void {
    const p = this.panel!;
    const d = this.data();
    p.clear();
    for (const img of p.el.querySelectorAll('img.ht2-panel-img')) img.remove();
    if (this.kind === 1) this.keys(p, d.keys);
    else if (this.kind === 2 && d.net) netTable(p, 17, 545, d.net, 8);
    else if (this.kind === 2) this.rating(p, d);
    else if (this.kind === 3) this.infoPanel(p, d.info);
    else this.company(p, d);
  }

  /** F1: таблиця клавіш у два стовпчики по 18 рядків. */
  private keys(p: SidePanel, keys: [string, string][]): void {
    keys.slice(0, 36).forEach(([name, key], i) => {
      const x = 25 + Math.floor(i / 18) * 170;
      const y = 469 + (i % 18) * 20;
      // Клітинки фону: дія — x 16…133, клавіша — 133…176 (друга колонка — на 170 правіше).
      p.write(x, y, name, VALUE, undefined, 'left', 104);
      p.write(x + 111, y, key.slice(0, 8), VALUE, undefined, 'left', 36);
    });
  }

  /** F2: гравець і суперники — частка перевезень, найнято, тоннаж (10 рядків через 33). */
  private rating(p: SidePanel, d: FPanelData): void {
    const me = d.info;
    const rows: [string, number, number, number][] = [];
    if (me) rows.push([me.driver, Math.round(d.share * 100), d.company.length, me.tons]);
    for (const p of d.netRating ?? []) rows.push([p.name, Math.round(p.share * 100), p.hired, p.tons]);
    // Суперники — однакова частка (машин не міняють, share.ts); найнятих і перевезеного порт за них не веде.
    for (const n of d.rivals) rows.push([n, Math.round(d.rivalShare * 100), 0, 0]);
    writeRating(p, rows.slice(0, 10));
  }

  /** F3: замовлення, премія, гроші й машина, смуги вантажу й стану, схема з покращеннями. */
  private infoPanel(p: SidePanel, info: CareerInfo | null): void {
    if (!info) {
      p.write(20, 488, 'ВІЛЬНА ЇЗДА', VALUE);
      return;
    }
    const o = info.order;
    if (o) {
      // Клітинки фону (у пікселях BackF3): рядок 472…492 (x 17…205), «ЗАКАЗ» 531…557 (x 17…92) — два рядки
      // розведено до країв клітинки, щоб більші векторні літери не налазили; премія — x 96…172.
      // Зі сканером прихований товар блимає з прикриттям червоним (king.exe 0x5756f0).
      const scanned = !!o.hidden && scanPhase();
      p.write(20, 487, `${scanned ? o.hidden : o.goods} → ${o.town}`, scanned ? SCANNED : VALUE, undefined, 'left', 182);
      p.write(20, 542, `${o.arrow} ${o.km.toFixed(1)} КМ`, VALUE, undefined, 'left', 70);
      p.write(20, 555, o.left > 0 ? formatLeft(o.left).toUpperCase() : 'ТЕРМІН МИНУВ', o.left > 0 ? VALUE : LOW, undefined, 'left', 70);
      // Премія першому (конкуренти, G9 Б8); без конкурентів — прочерк.
      p.write(127, 552, o.premium ? `$${Math.round(o.premium)}` : '—', VALUE, undefined, 'left', 44);
      // Під клітинкою «ЗАКАЗ» — частка оплати, яку дадуть зараз (шкода вантажу, запізнення): 99 px на всю
      // (king.exe: поле OrderInfo +0x80 / +0x78 × 99, y 557…565).
      p.bar(17, 557, Math.max(0, Math.min(99, Math.trunc((o.payout * 99) / Math.max(1, o.pay)))), 9, RED);
    } else if (info.near) {
      p.write(20, 487, `СКЛАД ${info.near.town}`, VALUE, undefined, 'left', 182);
      p.write(20, 548, `${info.near.arrow} ${info.near.km.toFixed(1)} КМ`, VALUE, undefined, 'left', 70);
    }
    // Гроші й машина — одна смуга 158 px (x 17…175, y 587…606), king.exe 0x5756f0.
    moneyBar(p, 17, 587, 606, 158, info.money, info.truckValue, info.truckWorth, 601);
    // Назва машини — клітинка над схемою (king.exe: x 47, y 720, ширина 145).
    p.write(47, 716, info.truck, VALUE, undefined, 'left', 145);
    // Шкали 76 px заввишки 9 (king.exe: частка × 76): ліві від x 17, праві від x 96.
    const bar = (x: number, y: number, v: number) => p.bar(x, y, Math.max(0, Math.min(76, Math.trunc(76 * v))), 9, RED);
    bar(17, 628, o ? o.mass / info.capacity.mass : 0);
    bar(96, 628, o ? o.volume / info.capacity.volume : 0);
    // Стан систем king.exe — шини (+0x3f24), гальма (+0x3f58), двигун (+0x3ebc) — «системи техстану», трансмісія —
    // 1 − накопичене пошкодження від ударів (+0x3cc0). Порт знос шин і гальм не моделює (нові — повні), а двигун і
    // трансмісію веде одним пошкодженням від ударів.
    const ok = 1 - info.damage;
    bar(17, 658, 1);
    bar(96, 658, 1);
    bar(17, 688, ok);
    bar(96, 688, ok);
    // Схема машини: значки встановлених покращень, пошкоджені двигун і гальма.
    p.image('m_16\\upgradet.txr', 17, 722);
    const owned = new Set(info.upgrades.map((u) => u.split(':')[0]));
    for (const [key, name, at] of UPGRADE_ICONS) if (owned.has(key)) for (const [x, y] of at) p.image(`m_16\\up_${name}_1.msk`, x, y);
    if (info.damage >= BROKEN) {
      p.image('m_16\\up_engine_0.msk', 33, 809);
      p.image('m_16\\up_vbrake_0.msk', 44, 791);
    }
  }

  /** Вибраний рядок водія F4 (дотик по рядку). */
  private selected = 0;

  /**
   * F4 (king.exe 0x526470, малювання 0x526c90): смуга «гроші + машини» (своя й водіїв) 172 px (x 32…204, y 479…498),
   * «ВСЬОГО» — їхня сума (208), «МОЖУ НАЙНЯТИ» (292) — ліцензії [Г]; таблиця водіїв — імʼя (вибране — червоне), аванс
   * смугою (x 89, 71 px × частка оплачених 10 км, y 545…563 + 20·n), прибуток, машина; фото вибраного (32, 760);
   * «помінятися місцями» (186, 774) і «звільнити» (85, 774).
   */
  private company(p: SidePanel, d: FPanelData): void {
    const info = d.info;
    if (!info) return;
    const list = d.company;
    this.selected = Math.min(this.selected, Math.max(0, list.length - 1));
    // Машини компанії: своя й водіїв (повертається при звільненні); жовта смуга — без пошкоджень своєї.
    const fleet = list.reduce((s, x) => s + (x.value ?? 0), 0);
    moneyBar(p, 32, 479, 498, 172, info.money, info.truckValue + fleet, info.truckWorth + fleet, 492);
    p.write(208, 492, `$${Math.round(info.money + info.truckValue + fleet)}`, VALUE, undefined, 'left', 80);
    p.write(292, 492, String(d.licences), VALUE, undefined, 'left', 50);
    list.slice(0, 10).forEach((x, i) => {
      const y = 559 + i * 20;
      // Аванс — смугою без суми (як в оригіналі): яка частина оплачених 10 км лишилась.
      const f = x.advance / Math.max(1e-6, 10 * x.tariff);
      p.bar(89, 545 + i * 20, Math.max(0, Math.min(71, Math.trunc(71 * f))), 19, RED);
      p.write(36, y, x.name, i === this.selected ? SELECTED : VALUE, undefined, 'left', 50);
      p.write(195, y, `$${Math.round(x.profit)}`, VALUE, undefined, 'center', 56);
      p.write(280, y, x.truck, VALUE, undefined, 'center', 96);
    });
    const sel = list[this.selected];
    // Фото водіїв — 100×100, а king.exe перекопіює вибране в поверхню 50×50 (0x50bda0, розмір escphoto53/54) — інакше
    // його накриває кнопка «звільнити» (85, 774).
    const photo = sel ? p.image(`m16\\escphoto${String(sel.photo).padStart(2, '0')}.txr`, 33, 761) : null;
    if (photo) photo.style.width = photo.style.height = '50px';
  }

  /** Кнопки й вибір рядка F4 — один раз при відкритті (вміст перемальовується окремо). */
  private companyControls(p: SidePanel): void {
    for (let i = 0; i < 10; i++) {
      const row = p.action(32, 544 + i * 20, 300, '', () => {
        this.selected = i;
        this.draw();
      });
      row.classList.add('ht2-panel-track');
      row.style.height = '20px';
    }
    p.button('m_16\\chan', 186, 774, 'Помінятися місцями', () => {
      this.data().swap(this.selected);
      this.draw();
    }, () => (this.data().company.length ? null : 'f'));
    p.button('m_16\\fire', 85, 774, 'Звільнити', () => {
      this.data().fire(this.selected);
      this.draw();
    });
  }
}
