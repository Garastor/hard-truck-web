import { modal } from '../engine/ui/modal';
import type { EscArt } from './escArt';
import { SidePanel } from './panel';

/**
 * Таблиця мережевої гри king.exe (0x574810): рядок — номер (x0 + 5), імʼя (x0 + 38, ширина 70), значення (x0 + 112):
 * час гонки `%d:%02d` (Кільце, Тріал) чи сума `$%d` (Автобол); рядки через 20 від базової лінії y0 + 15; після
 * четвертого — стовпчик на 181 правіше. Ті самі сітки є на фонах: F2 `BackF2Tball` (x0 = 17, y0 = 545; сітка фону —
 * 8 рядків в один стовпчик, тож у порту — один стовпчик) і вікна результатів `BackWin1/2`, `BackLoose3/4`
 * (x0 = 620, y0 = 470, 2 × 4) — лінії сітки знайдено за пікселями картинок (re/notes/ht2/tracks.md §3).
 */
export interface NetRow {
  name: string;
  value: string;
  /** Номер гравця (перемога — за номером, імена можуть збігатися). */
  id?: number;
}

const VALUE = 'rgb(240, 232, 150)';

/** Таблиця в панелі (координати фону); perCol — рядків у стовпчику. */
export function netTable(p: SidePanel, x0: number, y0: number, rows: readonly NetRow[], perCol: number): void {
  rows.slice(0, 8).forEach((r, i) => {
    const x = x0 + Math.floor(i / perCol) * 181;
    // Базова лінія king.exe y0 + 15 + 20·n; write() ставить центр рядка на 4 вище за y — клітинка 20 px по центру.
    const y = y0 + 13 + (i % perCol) * 20;
    p.write(x + 5, y, String(i + 1), VALUE, undefined, 'left', 26);
    p.write(x + 38, y, r.name, VALUE, undefined, 'left', 70);
    p.write(x + 112, y, r.value, VALUE, undefined, 'left', 66);
  });
}

/** Час гонки king.exe: `%d:%02d` (хвилини:секунди). */
export function netTime(s: number): string {
  const t = Math.floor(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

export interface NetResult {
  /** Кільце й Тріал — за часом (BackWin1 / BackLoose3), Автобол — за очками (BackWin2 / BackLoose4). */
  ball: boolean;
  /** Перший у таблиці — свій гравець. */
  won: boolean;
  rows: NetRow[];
}

/**
 * Вікно результатів мережевої гри (king.exe 0x51f380 → 0x574530): картинка 1600×1200 посередині (написи
 * «РЕЗУЛЬТАТЫ ГОНОК/ИГРЫ», «ВЫ ВЫИГРАЛИ / ПРОИГРАЛИ» — у ній), таблиця 2 × 4 і кнопка «Главное меню» групи «o»
 * (`o_main`, як у вікнах кінця гри; у порту — назад до сесії). Повертає оновлення таблиці (фініш інших) і закриття.
 * Без esc16.RES — вікно порту.
 */
export function showNetResult(art: EscArt | null, overlay: HTMLElement, r: NetResult, onLobby: () => void): { update(r: NetResult): void; close(): void } {
  const bg = `m_16\\${r.won ? (r.ball ? 'BackWin2' : 'BackWin1') : r.ball ? 'BackLoose4' : 'BackLoose3'}.txr`;
  if (!art || !art.has(bg)) {
    const body = document.createElement('div');
    body.className = 'ht2-net-results';
    const fill = (x: NetResult) => (body.textContent = x.rows.map((row, i) => `${i + 1}. ${row.name} — ${row.value}`).join('\n'));
    fill(r);
    void modal(overlay, r.won ? 'Ви виграли' : 'Ви програли', body, ['До сесії']).then(onLobby);
    return { update: fill, close: () => body.closest('.career-modal')?.remove() };
  }
  let p: SidePanel | null = null;
  let last = r;
  const draw = (x: NetResult) => {
    if (!p) return;
    p.clear();
    netTable(p, 620, 470, x.rows, 4);
  };
  // Картинки вікон — у лінивій частині esc16.RES: дочитати й показати.
  void art.ensure(bg, 'm_16\\o_main_p.txr', 'm_16\\o_main_a.txr', 'm_16\\o_main_ap.txr').then(() => {
    // Рядки фону від заголовка «РЕЗУЛЬТАТЫ» до кнопки (на телефоні в ландшафті інакше верх таблиці під табло).
    p = new SidePanel(art, overlay, bg, 'center', [395, 725]);
    p.el.classList.add('ht2-game-over');
    p.button('m_16\\o_main', 589, 687, 'До сесії', () => {
      p?.close();
      onLobby();
    });
    draw(last);
  });
  return {
    update: (x) => {
      last = x;
      draw(x);
    },
    close: () => p?.close(),
  };
}
