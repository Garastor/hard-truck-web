import type * as THREE from 'three';
import type { FileSet } from './assets/gameStore';
import type { FileSource } from './assets/source';

/**
 * Що оболонка (app/main.ts) дає грі під час запуску: спільний рендерер на canvas `#view`, шар вікон, рядок стану,
 * імпорт файлів цієї гри й вихід до вибору гри.
 */
export interface GameContext {
  renderer: THREE.WebGLRenderer;
  overlay: HTMLElement;
  setStatus(text: string | null): void;
  /** Екран імпорту файлів цієї гри (again — повторний, з «Опцій»); true — файли тепер повні. */
  showImport(again: boolean): Promise<boolean>;
  /** Вихід до вибору гри (null — гра одна). */
  exit: (() => void) | null;
}

/**
 * Гра для оболонки: набір файлів (імпорт, «чи імпортовано»), dev-сервер ПК і запуск. Метадані (назва, фон меню,
 * як упізнати архів) — app/registry.ts.
 */
export interface GameModule {
  files: FileSet;
  devSource: FileSource;
  run(ctx: GameContext): Promise<void>;
}
