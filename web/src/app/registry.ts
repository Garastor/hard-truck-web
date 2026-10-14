/**
 * Ігри на рушії «Клим»: Дальнобойщики (HT1) і Дальнобойщики 2 (HT2). Профіль — назва, звідки брати файли на
 * dev-сервері ПК, фон головного меню (для картки вибору гри), як упізнати гру в архіві чи теці.
 * Див. Docs/ht2/plan.md.
 */
export type GameId = 'ht1' | 'ht2';

export interface GameMeta {
  id: GameId;
  title: string;
  /** Рік і видавець — підпис на картці вибору. */
  subtitle: string;
  /** Префікс dev-сервера ПК (vite.config.ts) і файл, за яким перевіряємо, що гра там є. */
  devPrefix: string;
  devProbe: string;
  /** Фон головного меню в LOAD.RES гри (картка вибору). */
  menuBackground: string;
}

export const GAMES: Record<GameId, GameMeta> = {
  ht1: {
    id: 'ht1',
    title: 'Дальнобойщики',
    subtitle: '1998, Путь к победе',
    devPrefix: '/game/',
    devProbe: 'TRUCK.TCH',
    menuBackground: 'm/back_mai.txr',
  },
  ht2: {
    id: 'ht2',
    title: 'Дальнобойщики 2',
    subtitle: '2001, King of the Road',
    devPrefix: '/game2/',
    devProbe: 'vehicle.tech',
    menuBackground: 'm/back_main.txr',
  },
};

export const GAME_IDS = Object.keys(GAMES) as GameId[];

/**
 * Яку гру вимагає адреса: тека-вхід `/ht1/`, `/ht2/` (прямі посилання й окремі іконки на домашньому екрані) або
 * `?game=` (налагодження). null — головна адреса: вибір гри, якщо їх кілька.
 */
export function gameFromLocation(loc: Location = location): GameId | null {
  const m = /\/(ht[12])\/(index\.html)?$/i.exec(loc.pathname);
  if (m) return m[1].toLowerCase() as GameId;
  const q = new URLSearchParams(loc.search).get('game');
  return q && q in GAMES ? (q as GameId) : null;
}

const LAST_KEY = 'ht.game';

export function lastGame(): GameId | null {
  try {
    const v = localStorage.getItem(LAST_KEY);
    return v && v in GAMES ? (v as GameId) : null;
  } catch {
    return null;
  }
}

export function setLastGame(id: GameId): void {
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {
    /* приватний режим */
  }
}

/**
 * Упізнати гру за списком шляхів з архіву чи теки: `king.exe` або `vehicle.tech` — HT2; `HTruck.exe`, `TRUCK.TCH`
 * чи теки трас першої гри — HT1. null — не впізнано.
 */
export function detectGame(paths: Iterable<string>): GameId | null {
  let ht1 = false;
  for (const p of paths) {
    const parts = p.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    const parent = parts[parts.length - 2] ?? '';
    if (last === 'king.exe' || last === 'vehicle.tech' || (parent === 'env' && last.endsWith('.way'))) return 'ht2';
    if (last === 'htruck.exe' || last === 'truck.tch' || /^(count|circuit|mount|night|trial|menu3d)$/.test(parent)) ht1 = true;
  }
  return ht1 ? 'ht1' : null;
}
