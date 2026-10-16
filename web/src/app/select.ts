import type { TextFont } from '@shared/gameContext';
import type { GameId, GameMeta } from './registry';
import './select.css';

/**
 * Вибір гри — перший екран, коли на пристрої (чи на dev-сервері ПК) повних ігор більше однієї. Каркас — як у меню
 * оригіналу (сцена, вписана у вікно: `.menu-screen`/`.menu-stage`): у ландшафті картки рядом (сцена 860×460 — ширша за
 * меню ігор, під ландшафт телефона), у портреті — стовпчиком (440×850); після повороту екрана розкладка
 * перебудовується. Картки — зменшені фони головних меню ігор з їхніх LOAD.RES, написи — растровим шрифтом оригіналу
 * (MENU.FON / large.fon), без шрифту — звичайним текстом.
 */
export interface GameCard {
  meta: GameMeta;
  /** Фон головного меню гри (null — LOAD.RES недоступний). */
  art: HTMLCanvasElement | null;
  /** Файлів гри ще немає на пристрої — вибір відкриє імпорт. */
  missing?: boolean;
}

const CARD_W = 396;
const CARD_H = 297;
const CARD_Y = 66;
/** Під карткою — назва (+14) і підпис (+40); у портреті наступна картка — ще на 30 нижче. */
const LABELS_H = 60;
const LAYOUT = {
  landscape: { w: 860, h: 460 },
  portrait: { w: 440, h: 850 },
};
const GOLD = 'rgb(240,220,138)';
const DIM = 'rgb(160,150,120)';

export function gameSelectScreen(cards: GameCard[], fonts: { small: TextFont | null; large: TextFont | null }, last: GameId | null): Promise<GameId> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'menu-screen game-select';
    const stage = document.createElement('div');
    stage.className = 'menu-stage';
    root.append(stage);

    let buttons: HTMLButtonElement[] = [];
    let focus = Math.max(0, cards.findIndex((c) => c.meta.id === last));
    let portrait: boolean | null = null;
    let W = 0;
    let H = 0;
    const pick = (i: number) => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      root.remove();
      // in-menu лишається, поки гра вантажиться: її меню саме зніме його, закриваючись (інакше на мить видно
      // технічну панель першої гри).
      resolve(cards[i].meta.id);
    };
    const setFocus = (i: number) => {
      focus = i;
      buttons.forEach((b, j) => b.classList.toggle('picked', j === i));
    };

    /** Сцена під орієнтацію екрана: картки рядом (ландшафт) чи стовпчиком (портрет). */
    const build = () => {
      ({ w: W, h: H } = portrait ? LAYOUT.portrait : LAYOUT.landscape);
      stage.replaceChildren();
      stage.style.width = `${W}px`;
      stage.style.height = `${H}px`;
      // Написи — одне полотно на всю сцену.
      const text = document.createElement('canvas');
      text.width = W;
      text.height = H;
      text.className = 'game-select-text';
      stage.append(text);
      const ctx = text.getContext('2d')!;
      const write = (s: string, y: number, big: boolean, color: string, x = W / 2) => {
        const f = big ? (fonts.large ?? fonts.small) : fonts.small;
        if (f) {
          f.draw(ctx, s, Math.round(x - f.measure(s) / 2), y, color);
          return;
        }
        ctx.font = `${big ? 'bold 18px' : '12px'} Arial, sans-serif`;
        ctx.fillStyle = color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(s, x, y);
      };
      write('Рушій "Клим"', 12, true, GOLD);
      write('Оберіть гру', 42, false, DIM);
      write('на честь мого друга Клима', H - 20, false, DIM);

      const gap = (W - cards.length * CARD_W) / (cards.length + 1);
      buttons = cards.map((card, i) => {
        const x = portrait ? Math.round((W - CARD_W) / 2) : Math.round(gap + i * (CARD_W + gap));
        const y = portrait ? CARD_Y + i * (CARD_H + LABELS_H + 30) : CARD_Y;
        const b = document.createElement('button');
        b.className = 'menu-abs game-card';
        b.style.left = `${x}px`;
        b.style.top = `${y}px`;
        b.setAttribute('aria-label', card.meta.title);
        const c = document.createElement('canvas');
        c.width = CARD_W;
        c.height = CARD_H;
        const g = c.getContext('2d')!;
        g.fillStyle = '#111';
        g.fillRect(0, 0, CARD_W, CARD_H);
        if (card.art) {
          g.imageSmoothingQuality = 'high';
          g.drawImage(card.art, 0, 0, CARD_W, CARD_H);
        }
        b.append(c);
        b.addEventListener('click', () => pick(i));
        b.addEventListener('pointerenter', () => setFocus(i));
        stage.append(b);
        write(card.meta.title, y + CARD_H + 14, true, GOLD, x + CARD_W / 2);
        write(card.missing ? 'Файли гри ще не імпортовано — натисніть' : card.meta.subtitle, y + CARD_H + 40, false, DIM, x + CARD_W / 2);
        return b;
      });
      setFocus(focus);
    };

    const onKey = (e: KeyboardEvent) => {
      const next = e.key === 'ArrowRight' || e.key === 'ArrowDown';
      if (next || e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        setFocus((focus + (next ? 1 : cards.length - 1)) % cards.length);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(focus);
      }
    };
    const fit = () => {
      const p = window.innerHeight > window.innerWidth;
      if (p !== portrait) {
        portrait = p;
        build();
      }
      const s = Math.min(window.innerWidth / W, window.innerHeight / H);
      stage.style.transform = `translate(-50%, -50%) scale(${s})`;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', fit);
    fit();
    document.body.append(root);
    document.body.classList.add('in-menu');
  });
}
