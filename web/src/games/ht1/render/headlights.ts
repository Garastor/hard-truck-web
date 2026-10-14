/**
 * Власне освітлення світу фарами гравця (на прохання користувача; в оригіналі фари світ не освітлюють —
 * re/notes/ht1/headlights.md): уночі й у тунелях на повну, удень слабше; на сухій денній трасі — лише ввімкнені вручну.
 * Дві «прожекторні» фари у фрагментному шейдері незасвічених матеріалів світу й машин: конус уздовж напрямку руху з м'яким краєм, затухання з відстанню, яскравість за кутом падіння (нормаль — з похідних
 * позиції, у даних нормалей немає). Додається до кольору текстури: темні нічні текстури стають видимішими, чорне лишається
 * чорним. Без нових проходів рендеру й без нових об'єктів — лише кілька десятків операцій на піксель освітлюваних
 * полігонів. Параметри — на око.
 */
import * as THREE from 'three';

/** Дальність, де світло згасає майже до нуля (м). */
const RANGE = 60;
/** Відстань половинної яскравості (м). */
const HALF = 18;
/** Косинуси внутрішнього (повна яскравість) і зовнішнього (нуль) кута конуса: ≈ 16° і 34° від осі. */
const COS_INNER = Math.cos((16 * Math.PI) / 180);
const COS_OUTER = Math.cos((34 * Math.PI) / 180);
/** Нахил світла донизу (рад): світло лягає на дорогу перед машиною. */
const TILT = 0.06;
/** Колір і сила: теплувато-біле світло галогенових фар. */
const COLOR = new THREE.Color(1.0, 0.94, 0.8).multiplyScalar(2.2);

/** Спільні uniform усіх освітлюваних матеріалів (експорт — для налагодження в браузері). */
export const U = {
  hlOn: { value: 0 },
  hlPos0: { value: new THREE.Vector3() },
  hlPos1: { value: new THREE.Vector3() },
  hlDir: { value: new THREE.Vector3(0, 0, -1) },
  hlColor: { value: COLOR },
  hlCone: { value: new THREE.Vector2(COS_OUTER, COS_INNER) },
  hlRange: { value: new THREE.Vector2(1 / (HALF * HALF), RANGE) },
};

const FRAG_HEAD = /* glsl */ `
varying vec3 vHlWorld;
uniform float hlOn;
uniform vec3 hlPos0;
uniform vec3 hlPos1;
uniform vec3 hlDir;
uniform vec3 hlColor;
uniform vec2 hlCone;
uniform vec2 hlRange;
float hlSpot(vec3 lp, vec3 n) {
  vec3 v = vHlWorld - lp;
  float d = length(v);
  vec3 l = v / max(d, 1e-3);
  float cone = smoothstep(hlCone.x, hlCone.y, dot(l, hlDir));
  float att = 1.0 / (1.0 + d * d * hlRange.x) * (1.0 - smoothstep(hlRange.y * 0.6, hlRange.y, d));
  float facing = max(dot(n, -l), 0.0);
  return cone * att * (0.6 + 0.4 * facing);
}
`;

const FRAG_APPLY = /* glsl */ `
if (hlOn > 0.0) {
  vec3 hlN = normalize(cross(dFdx(vHlWorld), dFdy(vHlWorld)));
  if (dot(hlN, cameraPosition - vHlWorld) < 0.0) hlN = -hlN;
  float hl = hlSpot(hlPos0, hlN) + hlSpot(hlPos1, hlN);
  outgoingLight += diffuseColor.rgb * hlColor * (hl * hlOn);
}
#include <opaque_fragment>`;

function patch(sh: THREE.WebGLProgramParametersWithUniforms): void {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec3 vHlWorld;')
    .replace('#include <fog_vertex>', '#include <fog_vertex>\nvHlWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', `#include <common>\n${FRAG_HEAD}`)
    .replace('#include <opaque_fragment>', FRAG_APPLY);
}

/**
 * Додати освітлення фарами матеріалам піддерева: непрозорі незасвічені матеріали з перевіркою глибини (світ,
 * машини); небо, скло, ефекти й інтерфейс — без змін. Повторний виклик безпечний.
 */
export function litByHeadlights(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of ([] as THREE.Material[]).concat(mesh.material)) {
      if (!(m instanceof THREE.MeshBasicMaterial) || m.userData.headlights) continue;
      if (m.transparent || !m.depthTest || m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) continue;
      m.userData.headlights = true;
      m.onBeforeCompile = patch;
      m.customProgramCacheKey = () => 'headlights';
      m.needsUpdate = true;
    }
  });
}

/** Фари вантажівки: точки скла фар (вузли `*FFaraL/R` моделі) і напрямок. */
export class Headlights {
  /** Центри скла лівої й правої фари в системі машини (вершини в даних — у системі моделі, вузли без зсуву). */
  private readonly lamps: THREE.Vector3[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(
    private readonly visual: THREE.Object3D,
    model: THREE.Object3D,
  ) {
    visual.updateWorldMatrix(true, true);
    const inv = visual.matrixWorld.clone().invert();
    const bySide = new Map<string, THREE.Box3>();
    model.traverse((o) => {
      const m = /FFara([LR])$/i.exec(o.name);
      if (!m || /Key/.test(o.name) || bySide.has(m[1])) return;
      const box = new THREE.Box3();
      o.traverse((g) => {
        const mesh = g as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry.computeBoundingBox();
        box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld.clone().premultiply(inv)));
      });
      if (!box.isEmpty()) bySide.set(m[1], box);
    });
    for (const b of bySide.values()) this.lamps.push(b.getCenter(new THREE.Vector3()));
  }

  /** strength — сила світла (0 — вимкнено, 1 — ніч); forward — напрямок руху машини (одиничний). */
  update(strength: number, forward: THREE.Vector3): void {
    U.hlOn.value = strength;
    if (strength <= 0) return;
    const v = this.visual;
    v.updateWorldMatrix(true, false);
    const pts = this.lamps.map((l) => l.clone().applyMatrix4(v.matrixWorld));
    if (pts.length < 2) {
      // Без вузлів фар — дві точки на висоті 1 м по боках передка (≈ 2,5 м від центру).
      const side = this.tmp.crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
      const c = v.getWorldPosition(new THREE.Vector3()).addScaledVector(forward, 2.5).setY(v.position.y + 1);
      pts.length = 0;
      pts.push(c.clone().addScaledVector(side, -0.8), c.clone().addScaledVector(side, 0.8));
    }
    U.hlPos0.value.copy(pts[0]);
    U.hlPos1.value.copy(pts[1]);
    U.hlDir.value.copy(forward).setY(forward.y - TILT).normalize();
  }

  dispose(): void {
    U.hlOn.value = 0;
  }
}
