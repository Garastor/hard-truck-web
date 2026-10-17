import * as THREE from 'three';
import type { SceneAssembler } from '../engine/render/sceneBuilder';
import { noFarClip } from '../engine/render/farClip';

/** Відстань `sun_s0` від камери в бік сонця, м (king.exe 0x005a6ad0: 50,0). */
const SUN_DIST = 50;

/**
 * Відблиски сонця на екрані — обʼєкт `lightonglass2` king.exe (0x005a6890, оновлення 0x005a6ad0; re/notes/ht2/weather.md):
 * лінзи lens0…lens7 (COMMON.B3D, матеріали mlens0…7) у просторах sun_s1…sun_s8. `sun_s0` — на 50 м у бік сонця,
 * обличчям до камери; лінза k зсунута від сонця на −(k + 2)/8 його бічного зсуву від камери — уздовж прямої
 * «сонце → центр екрана» (остання — трохи за центром). Яскравість a³², a = (cos Δазимуту + cos Δвисоти + 2)/4
 * (хто її читає в exe — не знайдено; тут — множник кольору, змішування додаванням — гіпотеза). Сховано, коли сонце
 * позаду чи поза полем зору, висота сонця ≤ 0,2 або показник погоди ≥ 0,2. Перекриття геометрією exe не перевіряє.
 */
export class LensFlare {
  readonly group = new THREE.Group();
  private readonly lenses: { holder: THREE.Group; mat: THREE.MeshBasicMaterial }[] = [];
  private readonly s = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  private readonly fwd = new THREE.Vector3();

  constructor(asm: SceneAssembler) {
    this.group.name = 'lensFlare';
    this.group.visible = false;
    // Лінзи — у Foreground_object (sun_g1); меш лінзи k — за матеріалом mlens<k>.
    const byMat = new Map<string, THREE.Mesh>();
    asm.template('Foreground_object')?.traverse((o) => {
      const name = o instanceof THREE.Mesh ? ((o.material as THREE.Material).name ?? '').toLowerCase() : '';
      if (/^mlens\d$/.test(name) && !byMat.has(name)) byMat.set(name, o as THREE.Mesh);
    });
    for (let k = 0; k < 8; k++) {
      const src = byMat.get(`mlens${k}`);
      if (!src) continue;
      const from = src.material as THREE.MeshBasicMaterial;
      const mat = new THREE.MeshBasicMaterial({
        map: from.map,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthTest: false,
        depthWrite: false,
        fog: false,
        side: THREE.DoubleSide,
      });
      noFarClip(mat);
      const mesh = new THREE.Mesh(src.geometry, mat);
      // Квадрат лінзи лежить у площині xz гри (y гри — від камери): у просторі камери three.js — площина xy.
      mesh.rotation.x = -Math.PI / 2;
      mesh.renderOrder = 10000 + k;
      mesh.frustumCulled = false;
      const holder = new THREE.Group();
      holder.add(mesh);
      this.group.add(holder);
      this.lenses.push({ holder, mat });
    }
  }

  /** sunDir — напрям на сонце (three.js), sunHeight — висота сонця s (climate.sunHeight), w — показник погоди. */
  update(camera: THREE.PerspectiveCamera, sunDir: THREE.Vector3, sunHeight: number, w: number): void {
    camera.updateMatrixWorld();
    camera.getWorldQuaternion(this.q);
    this.group.position.setFromMatrixPosition(camera.matrixWorld);
    this.group.quaternion.copy(this.q);
    const s = this.s.copy(sunDir).normalize().applyQuaternion(this.q.invert());
    const depth = -s.z;
    const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const tanH = tanV * camera.aspect;
    const show =
      this.lenses.length > 0 && depth > 0.1 && Math.abs(s.x / depth) <= tanH && Math.abs(s.y / depth) <= tanV && sunHeight > 0.2 && w < 0.2;
    this.group.visible = show;
    if (!show) return;
    // Яскравість: відхилення курсу й тангажа камери від азимута й висоти сонця.
    camera.getWorldDirection(this.fwd);
    const azS = Math.atan2(sunDir.x, sunDir.z);
    const azC = Math.atan2(this.fwd.x, this.fwd.z);
    const elS = Math.asin(THREE.MathUtils.clamp(sunDir.y / sunDir.length(), -1, 1));
    const elC = Math.asin(THREE.MathUtils.clamp(this.fwd.y, -1, 1));
    const a = Math.min(1, (Math.cos(azS - azC) + Math.cos(elS - elC) + 2) / 4);
    const k = a ** 32;
    s.multiplyScalar(SUN_DIST);
    this.lenses.forEach(({ holder, mat }, i) => {
      const f = 1 - (i + 2) / 8;
      holder.position.set(s.x * f, s.y * f, s.z);
      mat.color.setScalar(k);
    });
  }
}
