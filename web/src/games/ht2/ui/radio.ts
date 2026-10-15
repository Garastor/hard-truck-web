import { SidePanel } from './panel';
import type { EscArt } from './escArt';

/**
 * Рація F5 king.exe (re/notes/ht2/ui.md §4, Docs/ht2/gameplay.md §6). Корпус `BackF5cbradio` (0x525b50) посередині
 * екрана: «ПОШУК» (30, 135) перебирає абонентів поруч, «ПРИЙОМ» (137, 146) — розмова. Панель розмови (0x523270, теж
 * посередині): фон за абонентом, портрет, відповідь-картка, кнопки-фрази `F5?_ask1…4` (11, 205 + 45·n); фраза з ціною —
 * картка «це коштуватиме ___» і кнопки `F5?_ok` (11, 250) / `F5?_canc` (11, 295).
 * Хто відповідає й що робить фраза — радіус, ціни, ймовірності — гіпотези порту (у king.exe не розібрано).
 */
export type RadioKind = 'pol' | 'maf' | 'opp' | 'nei';

export interface RadioContact {
  kind: RadioKind;
  /** Номер для портрета (пост міліції, засідка мафії, водій). */
  id: number;
  /** Напис на дисплеї рації. */
  name: string;
}

/** Фраза гравця: ціна (null — без оплати, одразу дія) або null-фраза «до побачення»; off — недоступна (`_f`). */
export interface RadioAsk {
  key: 'ask1' | 'ask2' | 'ask3' | 'ask4';
  /** Ціна (картка «коштуватиме»); 0 — дія без оплати; null — «без шансів». */
  price?: number | null;
  off?: boolean;
  bye?: boolean;
  /** Що зробити після згоди платити. */
  act?: () => void;
}

export interface RadioWorld {
  contacts(): RadioContact[];
  asks(c: RadioContact): RadioAsk[];
  money(): number;
  pay(amount: number): boolean;
  say(text: string): void;
}

const LETTER: Record<RadioKind, string> = { pol: 'p', maf: 'm', opp: 'o', nei: 'n' };
const BACK: Record<RadioKind, string> = { pol: 'BackF5pol', maf: 'BackF5maf', opp: 'BackF5opp', nei: 'BackF5nei' };
/** Перша відповідь абонента і «без шансів». */
const HELLO: Record<RadioKind, string> = { pol: 'F5p_ans_whats', maf: 'F5m_ans_hell', opp: 'F5o_ans_probl', nei: 'F5n_ans_need' };
const NO_WAY: Partial<Record<RadioKind, string>> = { opp: 'F5o_ans_noway', nei: 'F5n_ans_nochan' };
const LCD = 'rgb(30, 40, 28)';
const PRICE = 'rgb(255, 255, 0)';

export class Radio {
  private panel: SidePanel | null = null;
  private list: RadioContact[] = [];
  private index = 0;

  constructor(
    private readonly art: EscArt,
    private readonly parent: HTMLElement,
    private readonly world: RadioWorld,
  ) {}

  get open(): boolean {
    return !!this.panel;
  }

  toggle(): void {
    if (this.panel) this.close();
    else this.body();
  }

  close(): void {
    this.panel?.close();
    this.panel = null;
  }

  /** Корпус рації з дисплеєм: абонент або «НІКОГО НЕМАЄ». */
  private body(): void {
    this.close();
    this.list = this.world.contacts();
    this.index = Math.min(this.index, Math.max(0, this.list.length - 1));
    const p = new SidePanel(this.art, this.parent, 'm_16\\BackF5cbradio.msk', 'center', [0, 435], 40);
    const lcd = () => {
      p.clear();
      const c = this.list[this.index];
      p.write(52, 112, c ? c.name : 'НІКОГО НЕМАЄ', LCD, this.art.matrix);
    };
    p.button('m_16\\F5search', 30, 135, 'Пошук', () => {
      this.list = this.world.contacts();
      if (this.list.length) this.index = (this.index + 1) % this.list.length;
      lcd();
    });
    p.button('m_16\\F5talk', 137, 146, 'Прийом', () => {
      const c = this.list[this.index];
      if (c) this.talk(c);
    });
    lcd();
    this.panel = p;
  }

  /** Розмова: портрет, перша відповідь, фрази. */
  private talk(c: RadioContact, answer = HELLO[c.kind]): void {
    this.close();
    const l = LETTER[c.kind];
    const p = new SidePanel(this.art, this.parent, `m_16\\${BACK[c.kind]}.msk`, 'center', [0, 405], 40);
    const photo = c.kind === 'pol' ? `escpolice${two((c.id % 15) + 1)}` : c.kind === 'maf' ? `escmafia${two((c.id % 8) + 1)}` : `escphoto${two((c.id % 51) + 1)}`;
    p.image(`m16\\${photo}.txr`, 17, 45);
    p.image(`m_16\\${answer}.txr`, 136, 45);
    this.world.asks(c).forEach((a, i) => {
      p.button(`m_16\\F5${l}_${a.key}`, 11, 205 + 45 * i, a.key, () => this.choose(c, a), () => (a.off ? 'f' : null));
    });
    this.panel = p;
  }

  private choose(c: RadioContact, a: RadioAsk): void {
    if (a.off) return;
    if (a.bye) return this.close();
    if (a.price === null) {
      // «Без шансів»: картка, якщо є, інакше — перша відповідь і повідомлення.
      const no = NO_WAY[c.kind];
      if (!no) this.world.say('НЕ ВИЙШЛО');
      return this.talk(c, no ?? HELLO[c.kind]);
    }
    if (!a.price) {
      a.act?.();
      return this.close();
    }
    this.offer(c, a, a.price);
  }

  /** «Це коштуватиме ___»: сума на картці, «домовилися» / «забудь про це». */
  private offer(c: RadioContact, a: RadioAsk, price: number): void {
    this.close();
    const l = LETTER[c.kind];
    const p = new SidePanel(this.art, this.parent, `m_16\\${BACK[c.kind]}.msk`, 'center', [0, 405], 40);
    const photo = c.kind === 'pol' ? `escpolice${two((c.id % 15) + 1)}` : c.kind === 'maf' ? `escmafia${two((c.id % 8) + 1)}` : `escphoto${two((c.id % 51) + 1)}`;
    p.image(`m16\\${photo}.txr`, 17, 45);
    p.image(`m_16\\F5${l}_ans_cost.txr`, 136, 45);
    // Сума — над лінією картки (нижня третина), шрифтом табло.
    p.write(150, 99, `$${price}`, PRICE, this.art.matrix);
    p.button(`m_16\\F5${l}_ok`, 11, 250, 'ok', () => {
      if (!this.world.pay(price)) return;
      a.act?.();
      this.close();
    });
    p.button(`m_16\\F5${l}_canc`, 11, 295, 'canc', () => this.talk(c));
    this.panel = p;
  }
}

function two(n: number): string {
  return String(n).padStart(2, '0');
}
