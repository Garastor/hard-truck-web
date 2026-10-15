import { uiScale } from '@engine/ui/pixelFont';
import type { EscArt } from './escArt';

/**
 * Картки подій Дальнобойщиків 2 — `m16\mess<N>.msk` праворуч під табло (реверс king.exe, re/notes/ht2/ui.md §2):
 * штрафи міліції, неустойки, «Заказ выполнен», ліцензія на найм, радар, мафія. Суми й тексти — у місцях, де їх пише
 * king.exe (базова лінія тексту; картка подій — від y = 50 екрана, картка замовлення — посередині висоти).
 * Скільки картка лишається на екрані, в оригіналі не зʼясовано — у порту 7 с або до дотику (гіпотеза).
 */
export type CardId = 1 | 2 | 4 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 20 | 21;

export interface CardText {
  /** Сума (у верхньому чи нижньому полі картки — за номером). */
  amount?: number;
  /** Текст порушення (картка 14) чи перелік штрафів (15). */
  text?: string;
  /** Радар (16): обмеження й швидкість, км/год. */
  limit?: number;
  speed?: number;
  /** Замовлення (4): збереженість %, неустойка, гонорар. */
  integrity?: number;
  forfeit?: number;
  fee?: number;
  /** Ліцензія (1, 2): скільки водіїв, кому, строк (хв). */
  drivers?: number;
  name?: string;
  minutes?: number;
}

const SHOW_TIME = 7;
/** Колір тексту: на папері (картки замовлення) — темний, на картках міліції й мафії — світлий. */
const PAPER = 'rgb(24, 24, 40)';
const LIGHT = 'rgb(255, 236, 140)';

export class Cards {
  private readonly el: HTMLCanvasElement;
  private time = 0;

  constructor(
    private readonly art: EscArt,
    parent: HTMLElement,
  ) {
    this.el = document.createElement('canvas');
    this.el.className = 'pixel ht2-card';
    this.el.hidden = true;
    this.el.addEventListener('pointerdown', () => this.hide());
    parent.append(this.el);
  }

  show(n: CardId, t: CardText = {}): void {
    const img = this.art.canvas(`m16\\mess${n}.msk`);
    const m = this.art.matrix;
    if (!img) return;
    const order = n === 1 || n === 2 || n === 4;
    this.el.width = img.width;
    this.el.height = img.height;
    const ctx = this.el.getContext('2d')!;
    ctx.clearRect(0, 0, img.width, img.height);
    ctx.drawImage(img, 0, 0);
    if (m) {
      const color = order ? PAPER : LIGHT;
      // y king.exe — від верху картки (картка замовлення — з відступом 20), x — від лівого краю.
      const top = order ? 20 : 50;
      const at = (x: number, y: number, s: string) => m.draw(ctx, s.toUpperCase(), x, y - top - m.height, color);
      const center = (y: number, s: string) => at(Math.floor((img.width - m.measure(s.toUpperCase())) / 2), y, s);
      const money = (v: number) => `$${Math.round(v)}`;
      if (n === 4) {
        at(0xd1, 0xad, String(Math.round(t.integrity ?? 100)));
        // Знак $ на картці вже надруковано.
        at(0xac, 0xd7, String(Math.round(t.forfeit ?? 0)));
        at(0xac, 0xec, String(Math.round(t.fee ?? 0)));
        at(0xac, 299, String(Math.round((t.fee ?? 0) - (t.forfeit ?? 0))));
      } else if (n === 1 || n === 2) {
        at(0xa5, 0x10d, String((t.drivers ?? 1) % 100));
        at(0x81, 0x126, t.name ?? '');
        at(0x7d, 0x13f, `${t.minutes ?? 0} МИН`);
      } else {
        // Сума: картки неустойок і мафії — угорі, міліції — під заголовком, штрафи з «возмещением» — унизу.
        const y = n < 9 || n === 20 ? 0x94 : n < 12 ? 0x9d : n === 16 ? 0x105 : n < 20 ? 0x1af : 0;
        if (y && t.amount !== undefined) center(y, money(t.amount));
        if (n === 14 && t.text) center(0xa0, t.text);
        if (n === 16) {
          at(0x89, 0x8e, String(Math.round(t.limit ?? 0)));
          at(0x89, 0x9e, String(Math.round(t.speed ?? 0)));
        }
        if (n === 10) {
          at(0x52, 0x110, String(Math.round(t.limit ?? 0)));
          at(0x52, 0x13e, String(Math.round(t.speed ?? 0)));
        }
        if (n === 15 && t.text) {
          let y = 0xe3;
          for (const line of t.text.split('\n')) {
            at(0x2d, y, line.slice(0, 30));
            y += m.height + 2;
          }
        }
      }
    }
    // Масштаб — як у табло, але щоб картка вмістилась між табло й низом екрана.
    const tabloH = parseFloat(getComputedStyle(document.body).getPropertyValue('--ht2-tablo-h')) || 50;
    const s = Math.min(Math.max(uiScale(), window.innerHeight / 800), (window.innerHeight - tabloH - 8) / img.height);
    this.el.style.width = `${img.width * s}px`;
    this.el.style.height = `${img.height * s}px`;
    this.el.style.top = order ? `${Math.max(tabloH, (window.innerHeight - img.height * s) / 2)}px` : `${tabloH}px`;
    this.el.hidden = false;
    this.time = SHOW_TIME;
  }

  hide(): void {
    this.el.hidden = true;
    this.time = 0;
  }

  update(dt: number): void {
    if (this.time > 0 && (this.time -= dt) <= 0) this.hide();
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  dispose(): void {
    this.el.remove();
  }
}
