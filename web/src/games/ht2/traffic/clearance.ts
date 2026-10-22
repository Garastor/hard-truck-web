/**
 * Вільне місце для появи машини (порт, на прохання користувача: боти з'являлися там, звідки не могли рушити — край
 * узбіччя біля дерева, стовпа чи огорожі — і так і стояли). Тягач з причепом створюється на лінії смуги, а причіп —
 * прямо позаду за курсом тягача (truckers.make → Trailer): на кривій чи біля краю дороги він опинявся на газоні, у
 * деревах чи в огорожі. Тут — перевірка габариту від переду до заду: під кожною точкою є нерухома поверхня, точка не
 * далі краю полотна (вісь WAY ± W/2 з запасом), збоку ближче півширини немає стіни чи стовпа (брусок 0,6–3 м над
 * поверхнею, як drive.wallProbe), поруч немає інших машин.
 */
import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import type { Ht2Roads } from '../world/roads';
import { groundNear } from './layers';

/** Крок точок уздовж габариту, м. */
const STEP = 2;
/** Колесо може виступати за край полотна на стільки, м (вузькі дороги W5: смуга 2,5 м). */
const EDGE_OVER = 0.4;
/** Від борту до стіни чи стовпа щонайменше, м. */
const WALL_GAP = 0.3;
/** Інша машина ближче за стільки до точки габариту — місце зайняте, м. */
const OTHER_R = 6;

/** Відстань від q (на поверхні) до стіни в бік side, м; Infinity — далі за max. */
function sideWall(world: RAPIER.World, q: THREE.Vector3, along: THREE.Vector3, side: THREE.Vector3, max: number): number {
  const rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.atan2(-along.z, along.x));
  const hit = world.castShape({ x: q.x, y: q.y + 1.8, z: q.z }, rot, side, new RAPIER.Cuboid(STEP / 2, 1.2, 0.05), 0, max, true, undefined, undefined, undefined, undefined, (c) => !c.parent());
  return hit && Math.abs(hit.normal1.y) < 0.6 ? hit.time_of_impact : Infinity;
}

/** Точки габариту: від front м попереду pos до back м позаду вздовж fwd (горизонтального). */
export function footprint(pos: THREE.Vector3, fwd: THREE.Vector3, front: number, back: number): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  const n = Math.max(1, Math.ceil((front + back) / STEP));
  for (let i = 0; i <= n; i++) out.push(pos.clone().addScaledVector(fwd, front - ((front + back) * i) / n));
  return out;
}

/**
 * Чи вільне місце для машини: pos — на лінії смуги, fwd — курс (горизонтальний, одиничний), front/back — від pos до
 * переду й заду габариту (з причепом), half — півширина; others — центри інших машин поруч.
 */
export function placeFree(
  world: RAPIER.World,
  roads: Ht2Roads,
  pos: THREE.Vector3,
  fwd: THREE.Vector3,
  front: number,
  back: number,
  half: number,
  others: readonly THREE.Vector3[] = [],
): boolean {
  const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
  const left = right.clone().negate();
  const clear = half + WALL_GAP;
  for (const q of footprint(pos, fwd, front, back)) {
    // Поверхня — найближча до висоти лінії (не настил мосту над нею), лише нерухома, не стіна.
    const g = groundNear(world, q, 4, 6);
    if (!g) return false;
    q.y = g.y;
    if (roads.offRoad(q, EDGE_OVER - half)) return false;
    if (sideWall(world, q, fwd, right, clear) < clear || sideWall(world, q, fwd, left, clear) < clear) return false;
    for (const o of others) if (Math.hypot(o.x - q.x, o.z - q.z) < OTHER_R) return false;
  }
  return true;
}
