/**
 * Кімнати й портали траси: горизонтальні портали (відкритий верх виїмки) — прямокутник у площині, а не «стіна» по
 * діагоналі (MOUNT room_004 ↔ room_902: на дорозі до кузова машину хибно переводило у виїмку, і траса попереду зникала).
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three';
import { parseB3d } from '@engine/formats/b3d';
import { Track, isHorizontalPortal } from '../src/game/track';

const GAME = resolve(import.meta.dirname, '..', '..', 'Game', 'Hard Truck');
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe.skipIf(!existsSync(GAME))('портали', () => {
  const track = () => new Track(parseB3d(new Uint8Array(readFileSync(join(GAME, 'MOUNT', 'MOUNT2.B3D')))));

  it('MOUNT: горизонтальні портали виїмки над тунелем', () => {
    const t = track();
    const hz = [...t.rooms.values()].flatMap((r) => r.portals.filter(isHorizontalPortal).map((p) => `${p.from}>${p.to}`));
    expect(hz.sort()).toEqual(['room_004>room_900', 'room_004>room_902', 'room_900>room_004', 'room_902>room_004']);
  });

  it('MOUNT: дорога до кузова не перетинає портал виїмки, спуск у виїмку — перетинає', () => {
    const t = track();
    // Уздовж дороги на висоті машини, через діагональ прямокутника порталу room_004 → room_902.
    expect(t.crossPortal('room_004', v(60, -9, -452), v(60, -9, -460))).toBeNull();
    // Униз крізь площину порталу (y = −10) у межах прямокутника.
    expect(t.crossPortal('room_004', v(20, -9.5, -430), v(20, -10.5, -430))).toBe('room_902');
    // Униз поза прямокутником — ні.
    expect(t.crossPortal('room_004', v(90, -9.5, -430), v(90, -10.5, -430))).toBeNull();
  });
});
