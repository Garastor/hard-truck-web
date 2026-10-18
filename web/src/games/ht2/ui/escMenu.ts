import { SidePanel, type ButtonState } from './panel';
import type { EscArt } from './escArt';
import type { Ht2Settings } from './settings';

/**
 * Меню «Проблемы в пути» (Esc) king.exe (0x511170, re/notes/ht2/ui.md §5): ліва панель `m_16\BackEscMain.txr`,
 * кнопки стовпчиком від (18, 454) через 45 знизу вгору в порядку додавання: вихід, головне меню, звук, керування, 911,
 * почати спочатку, завантажити, зберегти (у грі без збереження — останні три неактивні). Вихід і головне меню —
 * спершу питання «зберегти / не зберігати / скасувати» (`exsave`, `exnsave`, `excanc`; місце в стовпчику — гіпотеза).
 */
export type EscCommand = 'save' | 'load' | 'restart' | '911' | 'control' | 'sound' | 'main' | 'exit';

export interface EscMenuOptions {
  /** Є збереження кар'єри (інакше «зберегти», «завантажити», «почати спочатку» неактивні). */
  career: boolean;
  /** Розділи, що ще не працюють у порті (неактивні). */
  disabled?: EscCommand[];
  command(c: EscCommand, save?: boolean): void;
  close(): void;
  /** Налаштування звуку й керування (підменю); apply — застосувати (save — зберегти в браузері). */
  settings?: Ht2Settings;
  apply?(s: Ht2Settings, save: boolean): void;
}

/** Повзунок підменю: картинки `<name>l` / `<name>r`, поле налаштувань. */
type Slider = [name: string, key: 'sfx' | 'music' | 'engine' | 'skid' | 'steerSpeed' | 'steerCenter' | 'force'];

/**
 * «Звук» (0x516ea0): повзунки від (22, 489) з кроком 70 згори — загальна гучність (sfxvol), музика (midivol), двигун
 * (engvol), гальмування (skivol). «Керування» (0x517530): від (22, 511) — чутливість (sens), повернення керма
 * (power), віддача (force); прапорець автомата `agear` (141, 700). Доріжка на фоні — x 41…143, на 12 нижче верху
 * повзунка; стрілки 16×28 по краях. Кнопки `ok` (21, 762) і `canc` (77, 762).
 */
const SOUND: Slider[] = [
  ['vol', 'sfx'],
  ['mus', 'music'],
  ['eng', 'engine'],
  ['skid', 'skid'],
];
const CONTROL: Slider[] = [
  ['sens', 'steerSpeed'],
  ['center', 'steerCenter'],
  ['force', 'force'],
];
const TRACK_X0 = 41;
const TRACK_X1 = 143;

const X = 18;
/** Видимі рядки фону: заголовок (395) … нижня кнопка (769 + 30). */
const VIEW: [number, number] = [385, 805];
const TOP = 454;
const STEP = 45;
/** Знизу вгору — як додає king.exe; на екрані згори: зберегти … вихід. */
const ORDER: [string, EscCommand][] = [
  ['savg', 'save'],
  ['loadg', 'load'],
  ['restart', 'restart'],
  ['911', '911'],
  ['control', 'control'],
  ['sound', 'sound'],
  ['main', 'main'],
  ['exitsys', 'exit'],
];
const LABEL: Record<EscCommand, string> = {
  save: 'Зберегти гру',
  load: 'Завантажити гру',
  restart: 'Почати спочатку',
  '911': '911',
  control: 'Керування',
  sound: 'Звук',
  main: 'Головне меню',
  exit: 'Вихід',
};

export class EscMenu {
  private panel: SidePanel;
  /** Відкрите підменю «Звук»/«Керування»: меню закрили без «ОК» чи «Скасувати» — зміни, що вже діють, зберегти. */
  private unsaved = false;
  /** Дотик поза панеллю — закрити меню (на телефоні немає Esc). */
  private readonly catcher = document.createElement('div');

  constructor(
    private readonly art: EscArt,
    private readonly parent: HTMLElement,
    private readonly o: EscMenuOptions,
  ) {
    this.catcher.className = 'ht2-esc-catcher';
    this.catcher.addEventListener('pointerdown', () => this.o.close());
    parent.append(this.catcher);
    document.body.classList.add('ht2-esc-open');
    this.panel = this.main();
  }

  private main(): SidePanel {
    const p = new SidePanel(this.art, this.parent, 'm_16\\BackEscMain.txr', 'left', VIEW);
    const careerOnly: EscCommand[] = ['save', 'load', 'restart'];
    ORDER.forEach(([base, cmd], i) => {
      const off = (!this.o.career && careerOnly.includes(cmd)) || this.o.disabled?.includes(cmd);
      const state = (): ButtonState | null => (off ? 'f' : null);
      p.button(`m_16\\${base}`, X, TOP + STEP * i, LABEL[cmd], () => {
        if (off) return;
        if (cmd === 'main' || cmd === 'exit') this.ask(cmd);
        else if ((cmd === 'sound' || cmd === 'control') && this.o.settings) this.sub(cmd);
        else this.o.command(cmd);
      }, state);
    });
    return p;
  }

  /** «Зберегти перед виходом?» — у грі без кар'єри зберігати нічого, вихід одразу. */
  private ask(cmd: EscCommand): void {
    if (!this.o.career) return this.o.command(cmd, false);
    this.panel.close();
    const p = new SidePanel(this.art, this.parent, 'm_16\\BackEscMain.txr', 'left', VIEW);
    const items: [string, string, () => void][] = [
      ['exsave', 'Зберегти', () => this.o.command(cmd, true)],
      ['exnsave', 'Не зберігати', () => this.o.command(cmd, false)],
      [
        'excanc',
        'Скасувати',
        () => {
          p.close();
          this.panel = this.main();
        },
      ],
    ];
    items.forEach(([base, label, action], i) => p.button(`m_16\\${base}`, X, TOP + STEP * (2 + i), label, action));
    this.panel = p;
  }

  /** Підменю «Звук» чи «Керування»: зміни діють одразу; «ОК» — зберегти, «Скасувати» — повернути як було. */
  private sub(kind: 'sound' | 'control'): void {
    const s = this.o.settings!;
    const before = { ...s };
    this.unsaved = true;
    this.panel.close();
    const p = new SidePanel(this.art, this.parent, kind === 'sound' ? 'm_16\\BackEscSnd.txr' : 'm_16\\BackEscCtrl.txr', 'left', VIEW);
    const list = kind === 'sound' ? SOUND : CONTROL;
    const top = kind === 'sound' ? 489 : 511;
    list.forEach(([name, key], i) => this.slider(p, name, top + 70 * i, () => s[key], (v) => {
      s[key] = v;
      this.o.apply?.(s, false);
    }));
    if (kind === 'control') {
      // Порт — лише автоматична коробка: прапорець показує стан, перемкнути не можна (гіпотеза: механіка — згодом).
      p.button('m_16\\agear', 141, 700, 'Автоматична коробка передач', () => undefined, () => (s.automatic ? 'pp' : 'p')).el.classList.add('ht2-hit-wide');
    }
    const back = () => {
      this.unsaved = false;
      p.close();
      this.panel = this.main();
    };
    p.button('m_16\\ok', 21, 762, 'ОК', () => {
      this.o.apply?.(s, true);
      back();
    }).el.classList.add('ht2-hit-wide');
    p.button('m_16\\canc', 77, 762, 'Скасувати', () => {
      Object.assign(s, before);
      this.o.apply?.(s, false);
      back();
    }).el.classList.add('ht2-hit-wide');
    this.panel = p;
  }

  /** Повзунок: стрілки ±10 %, дотик чи перетягування по доріжці; бігунок `runner` (12×22) по центру доріжки. */
  private slider(p: SidePanel, name: string, y: number, get: () => number, set: (v: number) => void): void {
    const track = y + 12;
    p.image(`m_16\\${name}l_p.msk`, 22, track - 14);
    p.image(`m_16\\${name}r_p.msk`, TRACK_X1 + 3, track - 14);
    const runner = p.image('m_16\\runner_p.msk', 0, track - 11);
    if (runner) runner.style.pointerEvents = 'none';
    const show = () => runner && (runner.style.left = `${Math.round(TRACK_X0 + get() * (TRACK_X1 - TRACK_X0)) - 6}px`);
    const put = (v: number) => {
      set(Math.round(Math.max(0, Math.min(1, v)) * 100) / 100);
      show();
    };
    // Стрілки — прозорі зони дотику ширші й вищі за малюнок 16×28 (на телефоні панель ≈ 0,8): 34×40 пікселів фону.
    const step = (x: number, w: number, d: number) => {
      const b = p.action(x, track - 20, w, '', () => put(get() + d));
      b.classList.add('ht2-panel-track');
      b.style.height = '40px';
    };
    step(4, 34, -0.1);
    step(TRACK_X1 + 3, 34, 0.1);
    const area = p.action(TRACK_X0 - 3, track - 20, TRACK_X1 - TRACK_X0 + 6, '', () => undefined);
    area.classList.add('ht2-panel-track');
    area.style.height = '40px';
    const at = (e: PointerEvent) => {
      const r = area.getBoundingClientRect();
      // Доріжка — від 3 до ширина − 3 у пікселях фону (рамка дотику ширша на 3 з боків).
      const k = r.width / (TRACK_X1 - TRACK_X0 + 6);
      put((e.clientX - r.left - 3 * k) / (r.width - 6 * k));
    };
    area.addEventListener('pointerdown', (e) => {
      area.setPointerCapture(e.pointerId);
      at(e);
    });
    area.addEventListener('pointermove', (e) => {
      if (area.hasPointerCapture(e.pointerId)) at(e);
    });
    show();
  }

  close(): void {
    if (this.unsaved && this.o.settings) this.o.apply?.(this.o.settings, true);
    this.unsaved = false;
    this.panel.close();
    this.catcher.remove();
    document.body.classList.remove('ht2-esc-open');
  }
}
