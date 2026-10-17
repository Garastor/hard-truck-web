import { modal } from '../engine/ui/modal';
import type { EscArt } from './escArt';
import { SidePanel } from './panel';

/**
 * Вікно результату king.exe (0x51eea0, показ 0x51f380; re/notes/ht2/upgrades.md «Вибування гравця»): картинка
 * `m_16\BackLoose<N>.txr` 1600×1200 посередині екрана (текст «КОНЕЦ ИГРЫ» і причина намальовані в ній, написи на
 * картинках не перекладаються), кнопки 130×30 групи «o»: `o_main` «Главное меню» і `o_rest` «Начать сначала»; група
 * в (589, 687) координат фону — друга кнопка праворуч (ширина групи 290 — гіпотеза розкладки). Автозакриття немає.
 * Без `esc16.RES` — вікно порту з тим самим текстом.
 */
export type LoseScreen = 'BackLoose2' | 'BackLoose5';

const TEXT: Record<LoseScreen, string> = {
  BackLoose2: 'КІНЕЦЬ ГРИ. ВІДНОВЛЕННЮ НЕ ПІДЛЯГАЄ',
  BackLoose5: 'КІНЕЦЬ ГРИ. ВИ БАНКРУТ',
};

export function showGameOver(art: EscArt | null, overlay: HTMLElement, screen: LoseScreen, on: { main(): void; restart(): void }): void {
  if (!art || !art.has(`m_16\\${screen}.txr`)) {
    void modal(overlay, 'Кінець гри', TEXT[screen], ['Головне меню', 'Почати спочатку']).then((i) => (i === 1 ? on.restart() : on.main()));
    return;
  }
  const p = new SidePanel(art, overlay, `m_16\\${screen}.txr`, 'center');
  p.el.classList.add('ht2-game-over');
  p.button('m_16\\o_main', 589, 687, 'Головне меню', () => {
    p.close();
    on.main();
  });
  p.button('m_16\\o_rest', 749, 687, 'Почати спочатку', () => {
    p.close();
    on.restart();
  });
}
