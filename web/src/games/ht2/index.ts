import type { GameModule } from '@engine/gameContext';
import { HT2_FILES, ht2DevSource } from './files';

/** Дальнобойщики 2 (2001) для оболонки; код гри вантажиться лише після вибору (app.ts). */
export const ht2: GameModule = {
  files: HT2_FILES,
  devSource: ht2DevSource,
  run: async (ctx) => (await import('./app')).runHt2(ctx),
};
