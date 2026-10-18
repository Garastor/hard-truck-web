import * as THREE from 'three';

/**
 * Зсув глибини до камери на `bias` метрів уздовж променя погляду — лише глибина, місце на екрані те саме. Для стрілок
 * приладів кабіни: на малій швидкості стрілку спідометра перекривала текстура панелі зліва; зі зсувом вони
 * завжди над шкалою, а кермо (на десятки сантиметрів ближче) їх і далі закриває. Матеріали клонуються — спільні з
 * іншими деталями кабіни не змінюються.
 */
export function biasTowardCamera(root: THREE.Object3D, bias: number): void {
  const done = new Map<THREE.Material, THREE.Material>();
  const fix = (m: THREE.Material): THREE.Material => {
    let c = done.get(m);
    if (c) return c;
    c = m.clone();
    const key = m.customProgramCacheKey();
    const prev = m.onBeforeCompile;
    c.onBeforeCompile = (sh, r) => {
      prev.call(c, sh, r);
      sh.vertexShader = sh.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
{
  vec4 nearMv = mvPosition;
  nearMv.xyz *= max(0.0, 1.0 - ${bias.toFixed(4)} / max(length(nearMv.xyz), 1e-4));
  vec4 nearClip = projectionMatrix * nearMv;
  gl_Position.z = nearClip.z / nearClip.w * gl_Position.w;
}`,
      );
    };
    c.customProgramCacheKey = () => `${key}|near${bias}`;
    done.set(m, c);
    return c;
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(fix) : fix(mesh.material);
  });
}
