import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  currentDriver, deleteDriver, listDrivers, listNetSaves, listSaves, loadCareer, netCareerFor, newCareer, putDriver, restoreCareer, saveCareer, savedCareerRaw, savedHeading, selectDriver,
} from '@ht2/career/career';
import * as THREE from 'three';
import { toThree } from '@ht2/world/world';

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

  it('курс машини: запис з курсом відновлює той самий напрям, старий запис — без курсу', () => {
    // Як careerMode.persist: «уперед» Three.js (зі схилом) → (x, −z) гри.
    const f = new THREE.Vector3(Math.cos(2.3), 0.1, Math.sin(2.3));
    const c = newCareer('Водій', 'ZilR');
    c.pos = [100, 200, 5];
    c.heading = [f.x, -f.z];
    saveCareer(c);
    const h = savedHeading(loadCareer(c.id)!);
    expect(h).not.toBeNull();
    const back = toThree(h![0], h![1], 0);
    const want = f.clone().setY(0).normalize();
    expect(back.length()).toBeCloseTo(1, 6);
    expect(back.angleTo(want)).toBeLessThan(1e-6);

    // Старе збереження без поля — завантажується як було, курсу немає (машина — уздовж дороги).
    const old = { ...newCareer('Водій', 'ZilR'), money: 1234, pos: [1, 2, 3] } as Record<string, unknown>;
    delete old.heading;
    delete old.id;
    localStorage.setItem('ht2.save.old1', JSON.stringify(old));
    const o = loadCareer('old1')!;
    expect(o.money).toBe(1234);
    expect(o.pos).toEqual([1, 2, 3]);
    expect(savedHeading(o)).toBeNull();
    expect(listSaves().some((x) => x.id === 'old1')).toBe(true);
    // Зіпсоване поле — теж як без курсу.
    expect(savedHeading({ heading: [0, 0] })).toBeNull();
    expect(savedHeading({ heading: [Number.NaN, 1] })).toBeNull();
  });
});

describe('мережева кар’єра: кілька збережень на водія', () => {
  it('у списку — лише мережеві цього водія; вибір за id, без вибору — найновіше, null — нова', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    saveCareer({ ...newCareer('Іра', 'ZilR') });
    const old = { ...newCareer('Іра', 'Mack'), id: 'net-Іра', net: true, money: 900 };
    saveCareer(old);
    vi.setSystemTime(2000);
    const second = { ...newCareer('Іра', 'VolvoR'), net: true, money: 48200 };
    saveCareer(second);
    saveCareer({ ...newCareer('Олег', 'DafR'), net: true });
    expect(listNetSaves('Іра').map((c) => c.money)).toEqual([48200, 900]);
    expect(netCareerFor('Іра', 'RenaultR').id).toBe(second.id);
    expect(netCareerFor('Іра', 'RenaultR', 'net-Іра').truck).toBe('Mack');
    const fresh = netCareerFor('Іра', 'RenaultR', null);
    expect(fresh).toMatchObject({ net: true, truck: 'RenaultR', driver: 'Іра' });
    expect(fresh.id).toBeTruthy();
    expect([second.id, 'net-Іра']).not.toContain(fresh.id);
    // Одиночне збереження — не мережева кар'єра (і навпаки, loadCareer() без id мережевих не бере).
    expect(netCareerFor('Олег', 'ZilR', listSaves().find((c) => !c.net)!.id).net).toBe(true);
    expect(loadCareer()?.net).toBeFalsy();
    vi.useRealTimers();
  });
});
