import { modal } from '../engine/ui/modal';
import type { EscArt } from './escArt';
import { SidePanel } from './panel';
import { writeRating } from './fPanels';

/**
 * Вікно результату king.exe (0x51eea0, показ 0x51f380; re/notes/ht2/upgrades.md «Вибування гравця»): картинка
 * `m_16\BackLoose<N>.txr` 1600×1200 посередині екрана (текст «КОНЕЦ ИГРЫ» і причина намальовані в ній, написи на
 * картинках не перекладаються), кнопки 130×30 групи «o»: `o_main` «Главное меню» і `o_rest` «Начать сначала»; група
 * в (589, 687) координат фону — друга кнопка праворуч (ширина групи 290 — гіпотеза розкладки). Автозакриття немає.
 * Без `esc16.RES` — вікно порту з тим самим текстом.
 */
export type LoseScreen = 'BackLoose1' | 'BackLoose2' | 'BackLoose5';

const TEXT: Record<LoseScreen, string> = {
  BackLoose1: 'КІНЕЦЬ ГРИ. РИНОК ПЕРЕВЕЗЕНЬ МОНОПОЛІЗОВАНО ВАШИМ КОНКУРЕНТОМ',
  BackLoose2: 'КІНЕЦЬ ГРИ. ВІДНОВЛЕННЮ НЕ ПІДЛЯГАЄ',
  BackLoose5: 'КІНЕЦЬ ГРИ. ВИ БАНКРУТ',
};

/**
 * Вікно перемоги (режим 2): `m_16\BackWin.txr`, кнопки групи «ow» — `ow_main` «Главное меню», `ow_cont`
 * «Продолжить», `ow_rest` «Начать сначала» у (589, 687) координат фону (розклад трьох кнопок — гіпотеза).
 */
export function showVictory(art: EscArt | null, overlay: HTMLElement, on: { main(): void; resume(): void; restart(): void }): void {
  const text = 'ВІТАЄМО! ВИ ЗАХОПИЛИ РИНОК ПЕРЕВЕЗЕНЬ РЕГІОНУ!';
  if (!art || !art.has('m_16\\BackWin.txr')) {
    void modal(overlay, 'Перемога', text, ['Головне меню', 'Продовжити', 'Почати спочатку']).then((i) => (i === 1 ? on.resume() : i === 2 ? on.restart() : on.main()));
    return;
  }
  const p = new SidePanel(art, overlay, 'm_16\\BackWin.txr', 'center');
  p.el.classList.add('ht2-game-over');
  const buttons: [string, string, () => void][] = [
    ['ow_main', 'Головне меню', on.main],
    ['ow_cont', 'Продовжити', on.resume],
    ['ow_rest', 'Почати спочатку', on.restart],
  ];
  buttons.forEach(([id, label, act], i) =>
    p.button(`m_16\\${id}`, 589 + i * 146, 687, label, () => {
      p.close();
      act();
    }),
  );
}

/**
 * rating — для BackLoose1 (ринок захопив інший гравець, мережева кар'єра): таблиця «РЕЙТИНГ» у картинці (3 рядки,
 * сітка F2 `BackF2`, зсунута на (+605; −32) — лінії знайдено за пікселями); заповнюємо першими за часткою.
 */
export function showGameOver(art: EscArt | null, overlay: HTMLElement, screen: LoseScreen, on: { main(): void; restart(): void }, rating?: [string, number, number, number][]): void {
  if (!art || !art.has(`m_16\\${screen}.txr`)) {
    void modal(overlay, 'Кінець гри', TEXT[screen], ['Головне меню', 'Почати спочатку']).then((i) => (i === 1 ? on.restart() : on.main()));
    return;
  }
  // З таблицею — від заголовка «РЕЙТИНГ» до кнопок (на телефоні в ландшафті інакше верх таблиці під табло).
  const p = new SidePanel(art, overlay, `m_16\\${screen}.txr`, 'center', rating ? [395, 725] : undefined);
  p.el.classList.add('ht2-game-over');
  if (rating) writeRating(p, rating.slice(0, 3), 605, -32);
  p.button('m_16\\o_main', 589, 687, 'Головне меню', () => {
    p.close();
    on.main();
  });
  p.button('m_16\\o_rest', 749, 687, 'Почати спочатку', () => {
    p.close();
    on.restart();
  });
}
