import { resolve } from 'node:path';

/** Оригінальні ігри для golden-тестів (Game/ — лише читати; без файлів тести пропускаються). */
export const HT1_DIR = resolve(import.meta.dirname, '..', '..', 'Game', 'Hard Truck');
export const HT2_DIR = resolve(import.meta.dirname, '..', '..', 'Game', 'Hard Truck 2');
