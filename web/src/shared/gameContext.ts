import type * as THREE from 'three';
import type { FileSet } from './gameStore';
import type { FileSource } from './source';

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

/** Растровий шрифт для екрана вибору гри (PixelFont кожної гри відповідає цьому інтерфейсу). */
export interface TextFont {
  /** Висота символу, пікселів. */
  readonly height: number;
  measure(text: string): number;
  /** Малює текст від лівого верхнього кута; повертає x після тексту. */
  draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string): number;
}

/** Що гра дає екрану вибору: фон її меню й шрифти (з її файлів; null — немає файлу). */
export interface SelectArt {
  background: HTMLCanvasElement | null;
  small: TextFont | null;
  large: TextFont | null;
}

/**
 * Гра для оболонки: набір файлів (імпорт, «чи імпортовано»), dev-сервер ПК, графіка для екрана вибору й запуск.
 * Метадані (назва, як упізнати архів) — app/registry.ts. Оболонка не читає форматів ігор — лише через цей контракт.
 */
export interface GameModule {
  files: FileSet;
  devSource: FileSource;
  /** Фон меню й шрифти для екрана вибору (лише коли файли гри вже на пристрої). */
  selectArt(): Promise<SelectArt>;
  /**
   * Згладжування (MSAA), яке гра хоче для рендерера: оболонка створює його після вибору гри (атрибут контексту WebGL
   * змінюється лише з перезавантаженням). null чи немає — як вирішить оболонка за якістю (`ht.quality`).
   */
  antialias?(): boolean | null;
  run(ctx: GameContext): Promise<void>;
}
