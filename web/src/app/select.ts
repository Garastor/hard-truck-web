import type { PixelFont } from '@engine/ui/pixelFont';
import type { GameId, GameMeta } from './registry';
import './select.css';

/**
 * Вибір гри — перший екран, коли на пристрої (чи на dev-сервері ПК) повних ігор більше однієї. Каркас — як у меню
 * оригіналу (сцена 760×420 — ширша за меню ігор, під ландшафт телефона, — вписана у вікно: `.menu-screen`/`.menu-stage`), картки — зменшені фони головних меню
 * ігор з їхніх LOAD.RES, написи — растровим шрифтом оригіналу (MENU.FON / large.fon), без шрифту — звичайним текстом.
 */
export interface GameCard {
  meta: GameMeta;
  /** Фон головного меню гри (null — LOAD.RES недоступний). */
  art: HTMLCanvasElement | null;
  /** Файлів гри ще немає на пристрої — вибір відкриє імпорт. */
  missing?: boolean;
}

const W = 760;
const H = 420;
const CARD_W = 320;
const CARD_H = 240;
const CARD_Y = 66;
const GOLD = 'rgb(240,220,138)';
const DIM = 'rgb(160,150,120)';

export function gameSelectScreen(cards: GameCard[], fonts: { small: PixelFont | null; large: PixelFont | null }, last: GameId | null): Promise<GameId> {
  return new Promise((resolve) => {
    const root = document.createElement('div');
    root.className = 'menu-screen game-select';
    const stage = document.createElement('div');
    stage.className = 'menu-stage';
    stage.style.width = `${W}px`;
    stage.style.height = `${H}px`;
    root.append(stage);

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
    write('на честь мого друга Клима', 400, false, DIM);

    const gap = (W - cards.length * CARD_W) / (cards.length + 1);
    const buttons: HTMLButtonElement[] = [];
    let focus = Math.max(0, cards.findIndex((c) => c.meta.id === last));
    const pick = (i: number) => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', fit);
      root.remove();
      document.body.classList.remove('in-menu');
      resolve(cards[i].meta.id);
    };
    cards.forEach((card, i) => {
      const x = Math.round(gap + i * (CARD_W + gap));
      const b = document.createElement('button');
      b.className = 'menu-abs game-card';
      b.style.left = `${x}px`;
      b.style.top = `${CARD_Y}px`;
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
      buttons.push(b);
      write(card.meta.title, CARD_Y + CARD_H + 14, true, GOLD, x + CARD_W / 2);
      write(card.missing ? 'Файли гри ще не імпортовано — натисніть' : card.meta.subtitle, CARD_Y + CARD_H + 40, false, DIM, x + CARD_W / 2);
    });
    const setFocus = (i: number) => {
      focus = i;
      buttons.forEach((b, j) => b.classList.toggle('picked', j === i));
    };
    setFocus(focus);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setFocus((focus + (e.key === 'ArrowRight' ? 1 : cards.length - 1)) % cards.length);
        e.preventDefault();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        pick(focus);
      }
    };
    const fit = () => {
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
