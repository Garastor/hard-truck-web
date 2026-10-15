import { SidePanel, type ButtonState } from './panel';
import type { EscArt } from './escArt';

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
}

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

  close(): void {
    this.panel.close();
    this.catcher.remove();
    document.body.classList.remove('ht2-esc-open');
  }
}
