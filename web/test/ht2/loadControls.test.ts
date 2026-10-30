import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HT2_DIR } from '../gameDirs';
import { parseRmp, normName } from '@ht2/engine/formats/rmp';
import { parseTxr } from '@ht2/engine/formats/txr';
import { RUNNER_Y } from '@ht2/ui/loadScreen';
import { loadSettings, pedalsLeft, savePedalsLeft, saveSettings } from '@ht2/ui/settings';

/** localStorage у пам'яті (тести — у Node). */
class MemoryStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { value: new MemoryStorage(), configurable: true });
});

describe('розкладка сенсорних кнопок HT2', () => {
  it('типово — кермо праворуч, газ і гальмо ліворуч', () => {
    expect(pedalsLeft(loadSettings(null))).toBe(true);
    expect(pedalsLeft(null)).toBe(true);
  });

  it('перемикач запамʼятовується й не чіпає спільний ключ першої гри', () => {
    savePedalsLeft(false);
    expect(pedalsLeft(loadSettings(null))).toBe(false);
    expect(localStorage.getItem('ht.swapControls')).toBeNull();
  });

  it('збереження застарілої копії налаштувань не повертає стару розкладку', () => {
    const stale = loadSettings(null);
    savePedalsLeft(false);
    saveSettings({ ...stale, music: 0.1 });
    const s = loadSettings(null);
    expect(s.music).toBe(0.1);
    expect(pedalsLeft(s)).toBe(false);
  });
});

const IND = join(HT2_DIR, 'COMMON', 'ind16.RES');

describe.skipIf(!existsSync(IND))('екран завантаження (ind16.RES)', () => {
  it('є картинка loadpix і смуга loadrunner у межах картинки', () => {
    const res = parseRmp(new Uint8Array(readFileSync(IND)));
    const pix = parseTxr(res.textures.get(normName('m16\\loadpix.txr'))!);
    const runner = parseTxr(res.textures.get(normName('m16\\loadrunner.txr'))!);
    expect(pix.width).toBeGreaterThan(0);
    expect(runner.width).toBeLessThanOrEqual(pix.width);
    expect(RUNNER_Y + runner.height).toBeLessThanOrEqual(pix.height);
    console.info(`loadpix ${pix.width}×${pix.height}, loadrunner ${runner.width}×${runner.height}`);
  });
});
