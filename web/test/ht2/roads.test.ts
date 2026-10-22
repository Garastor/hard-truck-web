/** Мережа доріг HT2 (WAY): криві Безьє, смуги за формулою king.exe, зʼєднання без розворотів. */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads, type RoadLine } from '@ht2/world/roads';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'ap.way'));

const flat = (a: THREE.Vector3, b: THREE.Vector3) => b.clone().sub(a).setY(0).normalize();

describe.skipIf(!has)('HT2: мережа доріг', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);

  it('під\'їзди заправок і СТО: усі вузли станцій, в\'їзди у двори з розвилкою (markStations)', () => {
    const st = (name: string) => roads.axes.find((a) => a.name.endsWith(name))?.station;
    expect(roads.axes.filter((a) => a.station).length).toBe(138);
    // СТО ca — лише вузли node_sto_ca і node_car_repair_ca.
    for (const n of ['#1617', '#1618', '#1619', '#1620']) expect(st(n)).toBe(true);
    // Двори СТО bb і bd: короткі в'їзди з магістралі.
    for (const n of ['#1367', '#1370', '#1371', '#1374', '#1487', '#1488']) expect(st(n)).toBe(true);
    // З'єднання великого перехрестя bd з магістраллю — не в'їзд.
    for (const n of ['#1489', '#1490']) expect(st(n)).toBeFalsy();
    // Смуги, з яких шлях лише на станцію, без позначки (водій їх оминає, driver offBase): трикутник розвилки перед СТО db
    // і з'їзди розв'язки ba05 на західний вихід, що веде лише до заправки ba14.
    const trap = roads.lines.filter((l) => !l.station && l.next.length > 0 && l.next.every((n) => (n as RoadLine).station));
    // Однобічні з'їзди (біти 4/8, roads.directions) — без зустрічних смуг: було 14.
    expect(trap.length).toBe(10);
    expect(trap.every((l) => /^room_(db_028#202[45]|ba05#13(27|31|35|36|38|39)):/.test(l.name))).toBe(true);
  });

  it('смуги — за шириною (king.exe 0x4d4620)', () => {
    const byWidth = new Map<number, number>();
    for (const a of roads.axes) byWidth.set(a.width, a.lanes);
    expect(byWidth.get(5)).toBe(1);
    expect(byWidth.get(12)).toBe(2);
    expect(byWidth.get(20)).toBe(3);
    expect(byWidth.get(24)).toBe(3);
    // Смуга k — на (k + 0,5)·ширина смуги праворуч від осі.
    const a = roads.axes.find((x) => x.width === 12 && x.pts.length === 2)!;
    const l1 = roads.lines.find((l) => l.road === a.road && l.lane === 1 && !l.name.endsWith('r'))!;
    expect(l1.pts[0].distanceTo(a.pts[0])).toBeCloseTo(4.5, 3);
  });

  it('криві Безьє — гладкі, без зламів понад 30°', () => {
    let kinks = 0;
    let curves = 0;
    for (const l of roads.axes) {
      if (!(l.flags & 1)) continue; // ламані з даних мають справжні кути — king.exe їх не згладжує
      curves++;
      for (let i = 1; i + 1 < l.pts.length; i++)
        if (flat(l.pts[i - 1], l.pts[i]).dot(flat(l.pts[i], l.pts[i + 1])) < Math.cos(THREE.MathUtils.degToRad(30))) kinks++;
    }
    expect(curves).toBe(1244);
    // Раніше (контрольні точки як ламана) — 2758 зламів у всій мережі.
    expect(kinks).toBeLessThan(10);
  });

  it('продовження — без розворотів і на іншу дорогу', () => {
    let uturn = 0;
    let deadEnds = 0;
    for (const l of roads.lines) {
      if (!l.next.length) deadEnds++;
      const din = flat(l.pts[l.pts.length - 2], l.pts[l.pts.length - 1]);
      for (const n of l.next) {
        expect((n as typeof l).road).not.toBe(l.road);
        if (din.dot(flat(n.pts[0], n.pts[1])) < -0.5) uturn++;
      }
    }
    expect(uturn).toBe(0);
    // Тупики — кінці доріг у даних (раніше їх ховали розвороти на зустрічну смугу).
    expect(deadEnds / roads.lines.length).toBeLessThan(0.1);
  });

  it('розділене шосе — кожна проїжджа частина в один бік', () => {
    // ad, room_ad_020: осі з бітами 4 (x = 648) і 8 (x = 652) за 4 м, ширина 20.
    const pair = roads.axes.filter((a) => a.name.startsWith('room_ad_020#') && a.width === 20 && a.flags & 12);
    expect(pair.length).toBe(2);
    for (const a of pair) {
      const dirs = new Set(roads.lines.filter((l) => l.road === a.road).map((l) => l.name.endsWith('r')));
      expect(dirs.size).toBe(1);
    }
    const [d0, d1] = pair.map((a) => roads.lines.find((l) => l.road === a.road)!);
    // Протилежні напрямки (у найближчих точках).
    const p = d0.pts[Math.floor(d0.pts.length / 2)];
    const i = d1.pts.reduce((bi, x, k) => (x.distanceTo(p) < d1.pts[bi].distanceTo(p) ? k : bi), 0);
    const j = Math.min(i, d1.pts.length - 2);
    const k0 = Math.floor(d0.pts.length / 2);
    expect(flat(d0.pts[k0], d0.pts[k0 + 1]).dot(flat(d1.pts[j], d1.pts[j + 1]))).toBeLessThan(-0.9);
  });

  it('узбіччя — далі від осі, ніж W/2', () => {
    const a = roads.axes.find((x) => x.width === 12 && x.pts.length === 2)!;
    const p = a.pts[0].clone().lerp(a.pts[1], 0.5);
    const side = new THREE.Vector3().crossVectors(flat(a.pts[0], a.pts[1]), new THREE.Vector3(0, 1, 0));
    expect(roads.offRoad(p.clone().addScaledVector(side, 5))).toBe(false);
    expect(roads.offRoad(p.clone().addScaledVector(side, 8))).toBe(true);
  });

  it('автопілот на розвилці не звертає в тупикову гілку (вʼїзд на базу), якщо є інша', () => {
    let forks = 0;
    let wrong = 0;
    for (const l of roads.lines) {
      // Зрізалки автопілоту недоступні (markShortcuts) — розвилка лише між звичайними гілками.
      const next = (l.next as RoadLine[]).filter((n) => l.shortcut || !n.shortcut);
      const open = next.filter((n) => !roads.deadEnd(n));
      if (!open.length || open.length === next.length) continue;
      forks++;
      if (roads.deadEnd(roads.pick(l)!)) wrong++;
    }
    // Однобічні дороги (біти 4/8) — без «зустрічних» смуг газоном, що вели в тупик: таких розвилок було понад 100.
    expect(forks).toBeGreaterThan(40);
    expect(wrong).toBe(0);
    // Розвилка в регіоні ac: друга гілка — тупик (за 400 м кінець без продовження).
    const fork = roads.lines.find((l) => l.name === 'room_ac_034#193:0')!;
    expect(fork.next.map((n) => roads.deadEnd(n as RoadLine))).toEqual([false, true]);
    expect(roads.pick(fork)!.name).toBe('room_ac_024#194:0r');
  });
});
