/**
 * «Поверхи» дороги (порт, на прохання користувача): мости, шляхопроводи, арки й навіси над дорогою. Машина трафіку чи
 * бота, що зʼявлялася чи ставала фізичною під мостом або на ньому, часто опинялася не на тому поверсі (промінь до
 * ґрунту з висоти влучав у настил над дорогою) і падала чи застрягала. Тут — шари нерухомих колізій під точкою й
 * перевірка, чи є над дорогою щось або під настилом інша поверхня.
 *
 * Колізія регіону — один trimesh, а Rapier дає одне влучання на колайдер, тож шари шукаються послідовними променями.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';

/** Над дорогою щось (настил, арка, навіс) вище за стільки від поверхні, м. */
const OVER_GAP = 1;
/** Під дорогою інша поверхня нижче за стільки — дорога на мосту, м. */
const UNDER_GAP = 2;
/** Межі пошуку шарів від висоти лінії дороги, м. */
const LOOK_UP = 12;
const LOOK_DOWN = 20;
const MAX_LAYERS = 8;

const DOWN = { x: 0, y: -1, z: 0 };
const fixed = (c: RAPIER.Collider) => c.parent()?.isFixed() ?? true;

export interface Layer {
  y: number;
  n: THREE.Vector3;
}

/** Нерухомі поверхні на вертикалі через p від p.y + up до p.y − down, згори вниз. */
export function layersAt(world: RAPIER.World, p: THREE.Vector3, up: number, down: number): Layer[] {
  const out: Layer[] = [];
  const bottom = p.y - down;
  let y = p.y + up;
  for (let i = 0; i < MAX_LAYERS && y > bottom; i++) {
    const hit = world.castRayAndGetNormal(new RAPIER.Ray({ x: p.x, y, z: p.z }, DOWN), y - bottom, false, undefined, undefined, undefined, undefined, fixed);
    if (!hit) break;
    const hy = y - hit.timeOfImpact;
    out.push({ y: hy, n: new THREE.Vector3(hit.normal.x, hit.normal.y, hit.normal.z) });
    y = hy - 0.05;
  }
  return out;
}

/**
 * Поверхня дороги під p — найближча за висотою до p.y (лінії WAY лежать на полотні), а не перша зверху: під мостом
 * промінь з висоти влучав у настил. Похилі (|n.y| < minUp) — стіни, не дорога. null — поверхні немає.
 */
export function groundNear(world: RAPIER.World, p: THREE.Vector3, up: number, down: number, minUp = 0.7): Layer | null {
  let best: Layer | null = null;
  for (const l of layersAt(world, p, up, down)) {
    if (Math.abs(l.n.y) < minUp) continue;
    if (!best || Math.abs(l.y - p.y) < Math.abs(best.y - p.y)) best = l;
  }
  if (best && best.n.y < 0) best.n.negate();
  return best;
}

/** Дорога в p має «поверхи»: над нею щось (під мостом, під аркою) чи під нею інша поверхня (на мосту). */
export function layered(world: RAPIER.World, p: THREE.Vector3): boolean {
  const ls = layersAt(world, p, LOOK_UP, LOOK_DOWN);
  if (ls.length < 2) return false;
  let g = ls[0];
  for (const l of ls) if (Math.abs(l.y - p.y) < Math.abs(g.y - p.y)) g = l;
  return ls.some((l) => l.y > g.y + OVER_GAP || l.y < g.y - UNDER_GAP);
}
