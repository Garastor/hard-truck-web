import { resolve } from 'node:path';

/**
 * Оригінальні ігри для golden-тестів (Game/ — лише читати; без файлів тести пропускаються). HT_GAME_ROOT — інша тека
 * Game (напр., з git worktree — тека основної копії).
 */
const ROOT = process.env.HT_GAME_ROOT ?? resolve(import.meta.dirname, '..', '..', 'Game');
export const HT1_DIR = resolve(ROOT, 'Hard Truck');
export const HT2_DIR = resolve(ROOT, 'Hard Truck 2');
