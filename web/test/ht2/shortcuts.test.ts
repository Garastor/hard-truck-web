/**
 * Зрізалки (осі WAY з бітами 0x20 і 0x40) і приховані ділянки карти (king.exe 0x42cf50, 0x5291a0;
 * re/notes/ht2/traffic.md «Приховані дороги»): трафік і боти туди не звертають, карта відкриває ділянку проїздом.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWay } from '@ht2/formats/way';
import { HT2_REGIONS } from '@ht2/files';
import { Ht2Roads, type RoadLine } from '@ht2/world/roads';
import { Navigator } from '@ht2/world/navigator';
import { MapReveal, REVEAL_K } from '@ht2/world/mapReveal';
import { coast, newMover, routePenalty, setGoals } from '@ht2/traffic/driver';
import { HT2_DIR } from '../gameDirs';

const has = existsSync(join(HT2_DIR, 'ENV', 'aa.way'));

/** Детермінований Math.random (mulberry32). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!has)('HT2: зрізалки й приховані дороги карти', () => {
  const regions = (has ? HT2_REGIONS : []).map((id) => ({ id, way: parseWay(new Uint8Array(readFileSync(join(HT2_DIR, 'ENV', `${id}.way`)))) }));
  const roads = new Ht2Roads(regions);
  /** Лінії, з яких можна звернути і на зрізалку, і на звичайну дорогу. */
  const forks = roads.lines.filter((l) => !l.shortcut && l.next.some((n) => (n as RoadLine).shortcut) && l.next.some((n) => !(n as RoadLine).shortcut));
  /** Лінії, що далі продовжуються лише зрізалками (ag_010, ah_010): для ботів — тупик. */
  const onlyTo = roads.lines.filter((l) => !l.shortcut && l.next.length > 0 && l.next.every((n) => (n as RoadLine).shortcut));

  beforeEach(() => {
    vi.spyOn(Math, 'random').mockImplementation(seeded(7));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setGoals([]);
  });

  it('зрізалки — осі з 0x20 і 0x40; осі з 0x20 без 0x10 — у ділянках карти', () => {
    const sc = roads.axes.filter((a) => a.shortcut);
    expect(sc.length).toBe(408);
    expect(sc.every((a) => (a.flags & 0x60) === 0x60 && !a.station && !a.base)).toBe(true);
    expect(roads.lines.filter((l) => l.shortcut).every((l) => roads.axes[l.road].shortcut)).toBe(true);
    for (const a of roads.axes) expect(a.section !== undefined).toBe((a.flags & 0x30) === 0x20);
    // Ділянки не перетинаються, ключі різні.
    expect(new Set(roads.sections.map((s) => s.key)).size).toBe(roads.sections.length);
    expect(roads.sections.reduce((n, s) => n + s.axes.length, 0)).toBe(roads.axes.filter((a) => (a.flags & 0x30) === 0x20).length);
    expect(forks.length).toBeGreaterThan(0);
  });

  it('автопілот (pick) і навігатор не звертають на зрізалку', () => {
    for (const l of forks) expect(roads.pick(l)?.shortcut).toBeFalsy();
    expect(onlyTo.length).toBeGreaterThan(0);
    for (const l of onlyTo) {
      expect(roads.pick(l)).toBeNull();
      expect(roads.deadEnd(l)).toBe(true);
    }
    const nav = new Navigator(roads);
    // Ціль — далеко на звичайній дорозі за кожною розвилкою.
    for (const l of forks.slice(0, 20)) {
      const target = l.pts[0].clone().add(new THREE.Vector3(3000, 0, 3000));
      const n = nav.next(l, target);
      if (n) expect(n.shortcut).toBeFalsy();
    }
  });

  it('водій трафіку не звертає на зрізалку (з цілями маршрутів і без)', () => {
    const goalPts = roads.nodes.filter((_, i) => roads.isJunction(i)).filter((_, i) => i % 97 === 0).map((n) => n.pos);
    for (const withGoals of [false, true]) {
      setGoals(withGoals ? goalPts.map((p) => new Navigator(roads, routePenalty).distances(p)) : []);
      let onShortcut = 0;
      let passed = 0;
      for (const l of [...forks, ...onlyTo]) {
        const m = newMover(l, Math.max(0, l.pts.length - 2), 0, 15, 2);
        for (let i = 0; i < 200 && m.line === l; i++) coast(m, 0.1);
        if (m.line === l) continue;
        passed++;
        if (m.line.shortcut) onShortcut++;
      }
      expect(passed).toBeGreaterThan(forks.length / 2);
      expect(onShortcut).toBe(0);
    }
  });

  it('ділянка відкривається, коли проїхав ≈ 83 % її розмаху; відкрите зберігається', () => {
    // Ділянка з однієї довгої осі-зрізалки.
    const s = roads.sections.findIndex((x) => x.axes.length === 1 && roads.axes[x.axes[0]].shortcut && x.span > 200);
    expect(s).toBeGreaterThanOrEqual(0);
    const axis = roads.axes[roads.sections[s].axes[0]];
    const rev = new MapReveal(roads);
    expect(rev.visible(axis)).toBe(false);
    // Точки вздовж осі кожні 2 м.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i + 1 < axis.pts.length; i++) {
      const n = Math.max(1, Math.ceil(axis.pts[i].distanceTo(axis.pts[i + 1]) / 2));
      for (let k = 0; k < n; k++) pts.push(axis.pts[i].clone().lerp(axis.pts[i + 1], k / n));
    }
    pts.push(axis.pts[axis.pts.length - 1].clone());
    // Половина — ще ні.
    let opened = -1;
    for (const p of pts.slice(0, pts.length / 2)) {
      expect(rev.update(p)).toBe(-1);
      if (roads.nearestAxis(p)?.axis.section === s) opened = 0;
    }
    expect(opened).toBe(0);
    expect(rev.visible(axis)).toBe(false);
    let at = -1;
    for (let i = pts.length / 2; i < pts.length && at < 0; i++) if (rev.update(pts[Math.floor(i)]) === s) at = Math.floor(i);
    expect(at).toBeGreaterThan(0);
    expect(rev.visible(axis)).toBe(true);
    // Відкрито не раніше, ніж габарит × REVEAL_K перевищив розмах.
    expect(pts[0].distanceTo(pts[at]) * REVEAL_K).toBeGreaterThan(roads.sections[s].span * 0.95);
    const saved = rev.keys();
    expect(saved).toEqual([roads.sections[s].key]);
    expect(new MapReveal(roads, saved).visible(axis)).toBe(true);
    // Звичайні дороги видно завжди, бази й під'їзди (0x30) — ніколи.
    expect(rev.visible(roads.axes.find((a) => !(a.flags & 0x20))!)).toBe(true);
    expect(rev.visible(roads.axes.find((a) => (a.flags & 0x30) === 0x30)!)).toBe(false);
  });

  it('не треба їхати точно по лінії: зсув ~25 м убік теж відкриває', () => {
    const s = roads.sections.findIndex((x) => x.axes.length === 1 && roads.axes[x.axes[0]].shortcut && x.span > 200);
    const axis = roads.axes[roads.sections[s].axes[0]];
    const rev = new MapReveal(roads);
    let at = -1;
    for (let i = 0; i + 1 < axis.pts.length && at < 0; i++) {
      const a = axis.pts[i];
      const b = axis.pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      // Перпендикуляр у плані, зсув то вліво, то вправо (виляння по траві).
      const side = (i % 2 ? 1 : -1) * (axis.width / 2 + 25);
      const off = new THREE.Vector3(((b.z - a.z) / len) * side, 0, (-(b.x - a.x) / len) * side);
      if (rev.update(a.clone().add(off)) === s) at = i;
    }
    if (at < 0) rev.update(axis.pts[axis.pts.length - 1]);
    expect(rev.visible(axis)).toBe(true);
  });

  it('зʼїхав на іншу дорогу — габарит з нуля', () => {
    const s = roads.sections.findIndex((x) => x.axes.length === 1 && roads.axes[x.axes[0]].shortcut && x.span > 200);
    const axis = roads.axes[roads.sections[s].axes[0]];
    const rev = new MapReveal(roads);
    const a = axis.pts[0];
    const b = axis.pts[axis.pts.length - 1];
    // Початок ділянки, потім далеко від усіх доріг, потім кінець: шматки поодинці замалі.
    rev.update(a.clone().lerp(b, 0.02));
    rev.update(a.clone().lerp(b, 0.3));
    rev.update(new THREE.Vector3(1e6, 0, 1e6));
    expect(rev.update(a.clone().lerp(b, 0.98))).toBe(-1);
  });
});
