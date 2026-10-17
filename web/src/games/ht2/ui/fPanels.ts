import { SidePanel } from './panel';
import type { EscArt } from './escArt';
import type { CareerInfo } from '../career/careerMode';
import { formatLeft } from '../career/careerMode';
import type { HiredDriver } from '../career/company';

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
}

const VALUE = 'rgb(240, 232, 150)';
/** Висота рядка кнопок порту під табло, CSS px. */
const HUD_ROW = 40;
const BAR = 'rgb(165, 205, 174)';
const LOW = 'rgb(255, 120, 60)';

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
    const p = new SidePanel(this.art, this.parent, BACK[kind], 'left', VIEW[kind], HUD_ROW);
    // Дотик до заголовка — наступна панель (на телефоні немає F1–F4).
    const next = p.action(10, VIEW[kind][0], p.width - 20, '', () => this.toggle(((kind % 4) + 1) as FPanel));
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
    // Суперники — однакова частка (машин не міняють, share.ts); найнятих і перевезеного порт за них не веде.
    for (const n of d.rivals) rows.push([n, Math.round(d.rivalShare * 100), 0, 0]);
    rows.slice(0, 10).forEach(([name, share, hired, tons], i) => {
      const y = 491 + i * 33;
      p.write(64, y, name, VALUE, undefined, 'left', 76);
      p.write(168, y, `${share}%`, VALUE, undefined, 'center', 60);
      p.write(253, y, String(hired), VALUE, undefined, 'center', 60);
      p.write(328, y, tons.toFixed(1), VALUE, undefined, 'center', 60);
    });
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
      p.write(20, 487, `${o.goods} → ${o.town}`, VALUE, undefined, 'left', 182);
      p.write(20, 542, `${o.arrow} ${o.km.toFixed(1)} КМ`, VALUE, undefined, 'left', 70);
      p.write(20, 555, o.left > 0 ? formatLeft(o.left).toUpperCase() : 'ТЕРМІН МИНУВ', o.left > 0 ? VALUE : LOW, undefined, 'left', 70);
      // Премія першому (конкуренти, G9 Б8); без конкурентів — прочерк.
      p.write(127, 552, o.premium ? `$${Math.round(o.premium)}` : '—', VALUE, undefined, 'left', 44);
    } else if (info.near) {
      p.write(20, 487, `СКЛАД ${info.near.town}`, VALUE, undefined, 'left', 182);
      p.write(20, 548, `${info.near.arrow} ${info.near.km.toFixed(1)} КМ`, VALUE, undefined, 'left', 70);
    }
    p.write(23, 601, `$${Math.round(info.money)}`, VALUE, undefined, 'left', 68);
    p.write(170, 601, info.truck, VALUE, undefined, 'right', 70);
    const bar = (x: number, y: number, w: number, v: number) => p.bar(x, y, Math.round(w * Math.max(0, Math.min(1, v))), 8, v < 0.3 ? LOW : BAR);
    bar(17, 628, 75, o ? o.mass / info.capacity.mass : 0);
    bar(96, 628, 76, o ? o.volume / info.capacity.volume : 0);
    // Стан систем — один показник пошкодження порту для всіх (окремих систем порт ще не рахує).
    const ok = 1 - info.damage;
    bar(17, 658, 75, ok);
    bar(96, 658, 76, ok);
    bar(17, 688, 75, ok);
    bar(96, 688, 76, ok);
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
   * F4: гроші, машини (своя й водіїв), прибуток водіїв усього, скільки можу найняти (ліцензії); таблиця водіїв —
   * імʼя, аванс, прибуток, машина (рядки з 544 через 20); фото вибраного (32, 760); «помінятися місцями» (186, 774) і
   * «звільнити» (85, 774) — king.exe 0x526470. Значення стовпчиків «ВСЬОГО» і «МОЖУ НАЙНЯТИ» — гіпотези.
   */
  private company(p: SidePanel, d: FPanelData): void {
    const info = d.info;
    if (!info) return;
    const list = d.company;
    this.selected = Math.min(this.selected, Math.max(0, list.length - 1));
    p.write(36, 493, `$${Math.round(info.money)}`, VALUE);
    p.write(200, 493, String(1 + list.length), VALUE, undefined, 'right', 30);
    p.write(246, 493, `$${Math.round(list.reduce((s, x) => s + x.profit, 0))}`, VALUE, undefined, 'center', 60);
    p.write(323, 493, String(d.licences), VALUE, undefined, 'center', 50);
    list.slice(0, 10).forEach((x, i) => {
      const y = 559 + i * 20;
      const color = i === this.selected ? 'rgb(255, 255, 255)' : VALUE;
      p.write(36, y, x.name, color, undefined, 'left', 62);
      p.write(130, y, `$${Math.round(x.advance)}`, color, undefined, 'center', 56);
      p.write(195, y, `$${Math.round(x.profit)}`, color, undefined, 'center', 56);
      p.write(280, y, x.truck, color, undefined, 'center', 96);
    });
    const sel = list[this.selected];
    if (sel) p.image(`m16\\escphoto${String(sel.photo).padStart(2, '0')}.txr`, 33, 761);
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
