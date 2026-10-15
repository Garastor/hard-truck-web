import type { GameModule } from '@shared/gameContext';
import { HT1_FILES, devServerSource } from './files';

/** Дальнобойщики (1998) для оболонки; код гри вантажиться лише після вибору (app.ts). */
export const ht1: GameModule = {
  files: HT1_FILES,
  devSource: devServerSource,
  selectArt: async () => (await import('./selectArt')).selectArt(),
  run: async (ctx) => (await import('./app')).runHt1(ctx),
};
