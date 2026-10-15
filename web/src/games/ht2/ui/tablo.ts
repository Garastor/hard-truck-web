import { uiScale } from '@engine/ui/pixelFont';
import type { EscArt } from './escArt';

/**
 * Верхнє табло Дальнобойщиків 2 (реверс king.exe, re/notes/ht2/ui.md §1): рамка `m16\tablo.txr` 1600×50 на всю
 * ширину екрана, підписи шрифтом `matrix.fon`, числа й значки — символами `icon.fon`; пейджер — `pager_p.msk`
 * (стрічка) і `pager_a.msk` (значок нового повідомлення). Відносно рамки все стоїть, як в оригіналі при 1600: дані з
 * x = 469, пейджер — у правому гнізді (1161, 11); рамка центрована, тож на вузькому екрані видно середину з даними, а
 * пейджер — під табло (як у king.exe для 640 і 800 точок). Полотно — у пікселях оригіналу, масштаб — за висотою
 * екрана (на телефоні 1×).
 */
export interface TabloState {
  /** Місце серед суперників з тим самим замовленням. */
  position?: { place: number; of: number } | null;
  /** Залишок часу замовлення, с гри (від’ємне — 00:00). */
  timeLeft?: number | null;
  /** Ліцензії на найм: кількість і залишок часу найгарячішої, с. */
  licences?: { count: number; left: number } | null;
  speed: number;
  mph?: boolean;
  handbrake: boolean;
  automatic: boolean;
  /** −1 — задня, 0 — нейтраль, 1… — передача. */
  gear: number;
  rpm: number;
  /** Причіп: немає, зчеплено, зчіплюється (блимає). */
  trailer: 'none' | 'on' | 'coupling';
  /** Пальне й стан машини, 0…1. */
  fuel: number;
  condition: number;
  /** Навігатор: поворот на найближчій розвилці (лише з покращенням «навигатор»). */
  nav?: 'left' | 'straight' | 'right' | null;
}

interface Layout {
  /** Ширина полотна (пікселі оригіналу) і висота. */
  w: number;
  h: number;
  /** Зсув рамки tablo.txr, початок даних, місце пейджера. */
  tabloX: number;
  origin: number;
  pager: [number, number];
}

/** Дані й пейджер відносно рамки (king.exe 0x569ab0, екран 1600). */
const ORIGIN = 469;
const PAGER: [number, number] = [1161, 11];
/** Права межа табло з даними в рамці: пейджер у гнізді — лише якщо видно рамку до його кінця. */
const PAGER_END = PAGER[0] + 300;

/** Колір символів шрифтів табло (у файлах — майже чорний, 0x0002 у 565). */
const INK = 'rgb(0, 0, 16)';
/** Скільки символів пейджера зʼявляється за секунду (в оригіналі — по символу за кадр). */
const TYPE_RATE = 40;
/**
 * Пейджер видно лише з повідомленням: поки текст друкується і ще стільки секунд (тривалість в оригіналі не виміряна —
 * гіпотеза).
 */
const PAGER_HOLD = 6;

/** Мала цифра icon.fon: код цифри + 0x10. */
const small = (s: string) => [...s].map((c) => String.fromCharCode(c.charCodeAt(0) + 0x10)).join('');
const two = (n: number) => String(Math.max(0, Math.floor(n))).padStart(2, '0');

export class Tablo {
  readonly el: HTMLCanvasElement;
  private readonly hit: HTMLDivElement;
  private readonly ctx: CanvasRenderingContext2D;
  private layout: Layout = { w: 1600, h: 50, tabloX: 0, origin: ORIGIN, pager: PAGER };
  private blink = false;
  private blinkTime = 0;
  /** Черга пейджера (4 останні, як в оригіналі) і що показується. */
  private readonly pages: string[] = [];
  private page = -1;
  private typed = 0;
  private fresh = 0;
  /** Скільки ще показувати пейджер, с (після надрукованого тексту). */
  private hold = 0;
  /** Звук повідомлення пейджера (pagerSound). */
  onPage: (() => void) | null = null;

  constructor(
    private readonly art: EscArt,
    parent: HTMLElement,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'pixel ht2-tablo';
    this.ctx = this.el.getContext('2d')!;
    // Дотик до табло — пейджер з попереднім повідомленням (клавіша P в оригіналі). Полотно (разом з місцем
    // пейджера під табло) дотиків не ловить — лише смуга самого табло.
    this.hit = document.createElement('div');
    this.hit.className = 'ht2-tablo-hit';
    this.hit.addEventListener('pointerdown', () => this.previous());
    parent.append(this.el, this.hit);
    this.resize();
  }

  /** Розкладка за шириною вікна; висота табло в CSS px — для розміщення кнопок під ним (--ht2-tablo-h). */
  resize(): void {
    const s = Math.max(uiScale(), window.innerHeight / 800);
    const w = Math.ceil(window.innerWidth / s);
    const tabloX = Math.round((w - 1600) / 2);
    const inSlot = tabloX + PAGER_END <= w;
    this.layout = {
      w,
      h: inSlot ? 50 : 80,
      tabloX,
      origin: tabloX + ORIGIN,
      // Вузький екран — під табло, ліворуч від середини даних (як у king.exe для 640 точок: 170 з 640).
      pager: inSlot ? [tabloX + PAGER[0], PAGER[1]] : [Math.max(0, Math.round(w / 2 - 150)), 50],
    };
    this.el.width = this.layout.w;
    this.el.height = this.layout.h;
    this.el.style.width = `${window.innerWidth}px`;
    this.el.style.height = `${this.layout.h * s}px`;
    this.hit.style.height = `${50 * s}px`;
    document.body.style.setProperty('--ht2-tablo-h', `${Math.ceil(50 * s)}px`);
    document.body.style.setProperty('--ht2-pager-h', `${Math.ceil((this.layout.h - 50) * s)}px`);
  }

  /** Нове повідомлення пейджера (повтор того самого підряд — не додається). */
  message(text: string): void {
    const t = text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (!t || this.pages[this.pages.length - 1] === t) return;
    this.pages.push(t);
    if (this.pages.length > 4) this.pages.shift();
    this.page = this.pages.length - 1;
    this.typed = 0;
    this.fresh = 3;
    this.hold = PAGER_HOLD;
    this.onPage?.();
  }

  /** Попереднє повідомлення (по колу). */
  previous(): void {
    if (!this.pages.length) return;
    // Перший дотик лише показує пейджер з останнім повідомленням, далі — гортає назад.
    if (this.hold <= 0) this.page = this.pages.length - 1;
    else this.page = (this.page - 1 + this.pages.length) % this.pages.length;
    this.typed = 1000;
    this.hold = PAGER_HOLD;
  }

  draw(dt: number, s: TabloState): void {
    this.blinkTime += dt;
    if (this.blinkTime > 0.35) {
      this.blinkTime = 0;
      this.blink = !this.blink;
    }
    const { ctx, art } = this;
    const L = this.layout;
    const m = art.matrix;
    const ic = art.icon;
    ctx.clearRect(0, 0, L.w, L.h);
    const frame = art.canvas('m16\\tablo.txr');
    if (frame) {
      // Ширше за 1600 — рамка повторюється по краях (її краї — однакові металеві панелі).
      for (let x = L.tabloX; x > -1600; x -= 1600) ctx.drawImage(frame, x, 0);
      for (let x = L.tabloX + 1600; x < L.w; x += 1600) ctx.drawImage(frame, x, 0);
    }
    if (!m || !ic) return;
    const o = L.origin;
    // y у king.exe — базова лінія: символ малюється від (y − висота клітинки).
    const label = (x: number, y: number, t: string) => m.draw(ctx, t, x, y - m.height, INK);
    const icon = (x: number, y: number, t: string) => ic.draw(ctx, t, x, y - ic.height, INK);
    const right = (font: typeof m, x: number, y: number, t: string) => font.draw(ctx, t, x - font.measure(t), y - font.height, INK);
    if (s.position) {
      label(o + 26, 23, 'ПОЗИЦИЯ');
      icon(o + 26, 43, small(String(s.position.place)));
      label(o + 50 - Math.floor(m.measure('ИЗ') / 2), 38, 'ИЗ');
      icon(o + 63, 43, small(String(s.position.of)));
    }
    if (s.timeLeft != null) {
      const t = Math.max(0, Math.floor(s.timeLeft / 60));
      label(o + 85, 23, 'ОСТ.ВРЕМЯ');
      icon(o + 85, 43, small(`${two(t / 60)}:${two(t % 60)}`));
    }
    if (s.licences && s.licences.count > 0) {
      const t = Math.max(0, Math.floor(s.licences.left / 60));
      label(o + 154, 23, 'ЛИЦЕНЗИЙ');
      label(o + 210, 23, String(s.licences.count));
      icon(o + 158, 43, small(`${two(t / 60)}:${two(t % 60)}`));
    }
    right(ic, o + 287, 38, String(Math.round(s.mph ? s.speed / 1.609 : s.speed)));
    label(o + 291, 40, s.mph ? 'MPH' : 'КМ/Ч');
    if (s.handbrake && this.blink) icon(o + 315, 40, '[\\');
    const gear = s.gear < 0 ? 'R' : s.gear === 0 ? 'N' : String(s.gear);
    label(o + 361 + (s.automatic ? 15 : 0), 23, `${s.automatic ? 'АКПП' : 'КПП'}  ${gear}`);
    right(ic, o + 386, 43, small(String(Math.max(0, Math.round(s.rpm / 100)))));
    label(o + 386, 40, 'X100 ОБ/М');
    const coupled = s.trailer === 'on' || (s.trailer === 'coupling' && this.blink);
    icon(o + 458, 40, coupled ? 'MN' : 'KL');
    const level = (v: number) => String.fromCharCode(0x50 + Math.max(0, Math.min(10, Math.round(v * 10))));
    if (s.fuel > 0.3 || this.blink) icon(o + 512, 40, `?${level(s.fuel)}`);
    if (s.condition > 0.3 || this.blink) icon(o + 553, 40, `O${level(s.condition)}`);
    if (s.nav) icon(o + 608, 40, s.nav === 'left' ? ';' : s.nav === 'right' ? '=' : '<');
    this.drawPager(dt);
  }

  private drawPager(dt: number): void {
    const text0 = this.pages[this.page];
    if (!text0 || (this.typed >= text0.length && (this.hold -= dt) <= 0)) return;
    const { ctx, art } = this;
    const [px, py] = this.layout.pager;
    const strip = art.canvas('m16\\pager_p.msk');
    if (strip) ctx.drawImage(strip, px, py);
    const text = this.pages[this.page];
    const m = art.matrix;
    if (this.fresh > 0) {
      this.fresh -= dt;
      const iconImg = art.canvas('m16\\pager_a.msk');
      if (iconImg && this.blink) ctx.drawImage(iconImg, px + 5, py + 6);
    }
    if (!text || !m) return;
    this.typed = Math.min(text.length, this.typed + dt * TYPE_RATE);
    let shown = text.slice(0, Math.floor(this.typed));
    // Довше за 247 пікселів — видно кінець (текст «повзе» вліво, як в оригіналі).
    while (shown.length && m.measure(shown) > 247) shown = shown.slice(1);
    m.draw(ctx, shown, px + 34, py + 23 - m.height, INK);
  }

  dispose(): void {
    this.el.remove();
    this.hit.remove();
    document.body.style.removeProperty('--ht2-tablo-h');
    document.body.style.removeProperty('--ht2-pager-h');
  }
}
