import { beforeEach, describe, expect, it } from 'vitest';
import {
  currentDriver, deleteDriver, listDrivers, listSaves, loadCareer, newCareer, putDriver, restoreCareer, saveCareer, savedCareerRaw, selectDriver,
} from '@ht2/career/career';

/** localStorage у пам'яті (тести — у Node). */
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

beforeEach(() => {
  const s = new MemoryStorage();
  // Object.keys(localStorage) — ключі сховища: проксі віддає їх як власні властивості.
  const proxy = new Proxy(s, {
    ownKeys: () => [...(s as unknown as { m: Map<string, string> }).m.keys()],
    getOwnPropertyDescriptor: (_, k) => ({ enumerable: true, configurable: true, value: s.getItem(String(k)) }),
  });
  Object.defineProperty(globalThis, 'localStorage', { value: proxy, configurable: true });
});

describe('збереження й водії HT2', () => {
  it('стара єдина кар\'єра переходить у збереження й водія', () => {
    localStorage.setItem('ht2.career.v1', JSON.stringify({ ...newCareer('Іван', 'ZilR'), id: undefined, logo: 2, photo: 7 }));
    const saves = listSaves();
    expect(saves).toHaveLength(1);
    expect(saves[0]!.driver).toBe('Іван');
    expect(currentDriver()).toEqual({ name: 'Іван', logo: 2, photo: 7 });
    expect(localStorage.getItem('ht2.career.v1')).toBeNull();
  });

  it('два водії — два збереження; видалення водія стирає лише його ігри', () => {
    putDriver({ name: 'Перший', logo: 0, photo: 0 });
    const a = newCareer('Перший', 'ZilR');
    saveCareer(a);
    putDriver({ name: 'Другий', logo: 1, photo: 1 });
    const b = newCareer('Другий', 'ZilR');
    b.money = 777;
    saveCareer(b);
    expect(listDrivers().map((d) => d.name)).toEqual(['Перший', 'Другий']);
    expect(currentDriver()!.name).toBe('Другий');
    expect(listSaves().map((c) => c.driver).sort()).toEqual(['Другий', 'Перший']);
    expect(loadCareer(b.id)!.money).toBe(777);
    selectDriver('Перший');
    expect(currentDriver()!.name).toBe('Перший');
    deleteDriver('Перший');
    expect(listDrivers().map((d) => d.name)).toEqual(['Другий']);
    expect(currentDriver()!.name).toBe('Другий');
    expect(listSaves().map((c) => c.driver)).toEqual(['Другий']);
  });

  it('знімок повертає збереження, а без нього — стирає', () => {
    const c = newCareer('Водій', 'ZilR');
    saveCareer(c);
    const raw = savedCareerRaw(c.id!);
    c.money = 1;
    saveCareer(c);
    restoreCareer(c.id!, raw);
    expect(loadCareer(c.id)!.money).toBe(5000);
    const fresh = newCareer('Водій', 'ZilR');
    const none = savedCareerRaw(fresh.id!);
    saveCareer(fresh);
    restoreCareer(fresh.id!, none);
    expect(loadCareer(fresh.id)).toBeNull();
  });
});
