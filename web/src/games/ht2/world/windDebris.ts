import * as THREE from 'three';
import type { SceneAssembler } from '../engine/render/sceneBuilder';
import { TREE_LIGHT } from './trees';
import { Billboards } from './billboards';

/**
 * Листя на вітрі — задача CWindDebris king.exe (0x4c9970, кадр 0x4c9a10; частинка 0xcc: 0x59e2f0, 0x59e490;
 * re/notes/ht2/weather.md). Координати нижче — гри (x, y, z угору; вітер завжди вздовж +y гри).
 * - Лише на сильному вітрі (> 5 — пориви), без дощу (w < 0,7) і не в модулях aa, tr, db, ac (0x4b8600/0x4b8650).
 * - Такт: з імовірністю 1 − k/2 випускає trunc(3 − 2k) листків, k = clamp((вітер − 5)/13, 0, 1); розмір
 *   (0,2 + 0,05k)·(1 ± 0,1) м; місце — випадкова точка трикутника «точка під машиною, ±45° на 42 м уздовж погляду».
 * - Швидкість (0, вітер·(1 + rnd), 0,25)·(1 + 1,5(rnd − rnd)) + (r₁, 0, −r₂)·(1 + 1,5(rnd − rnd))·2,5·rnd; гальмування
 *   3 м/с²; зупинилось або 4 с — зникає; не нижче висоти народження + 0,25; без гравітації.
 * - Кружляння: φ += ω·dt (ω = (rnd − rnd)·12,56), зсув r = 0,025·|v| уздовж (v.y, −v.x, 0) і z з cos φ / sin φ.
 * - Текстура leave01…04 (матеріали COMMON): старт випадковий, щосекунди наступна до leave04; обертання в площині
 *   (1 + rnd)·π рад/с.
 * Як у exe (перевірено кодом): випуск і зсув кружляння — щокадру, без dt (тож залежать від частоти кадрів); більшість
 * листків за вітром вилітає з кадру, поруч кружляють ті, кому випав малий множник швидкості. Гіпотези: такт
 * планувальника exe = кадр; освітлення — як у дерев (TREE_LIGHT). Малювання — пакетами інстансів (world/billboards.ts),
 * не окремими спрайтами: телефон.
 */
const LIFE = 4;
const DRAG = 3;
const MAX = 600;
const NO_LEAVES = new Set(['aa', 'tr', 'db', 'ac']);

interface Leaf {
  /** Розмір (м) і поворот текстури в площині екрана. */
  size: number;
  rot: number;
  /** Позиція й швидкість у координатах гри. */
  p: THREE.Vector3;
  v: THREE.Vector3;
  z0: number;
  age: number;
  phi: number;
  omega: number;
  spin: number;
  frame0: number;
}

const rnd = Math.random;

export class WindDebris {
  readonly group = new THREE.Group();
  private readonly maps: THREE.Texture[] = [];
  private readonly leaves: Leaf[] = [];
  private readonly bb = new Billboards(TREE_LIGHT, MAX);

  constructor(asm: SceneAssembler) {
    this.group.name = 'windDebris';
    this.group.add(this.bb.group);
    const mats = asm.b3d.materials.map((m) => m.toLowerCase());
    for (let i = 1; ; i++) {
      const idx = mats.indexOf(`leave${String(i).padStart(2, '0')}`);
      if (idx < 0) break;
      const map = (asm.lib.material(idx) as THREE.MeshBasicMaterial).map;
      if (map) this.maps.push(map);
    }
  }

  /**
   * anchor — точка землі під вантажівкою (three.js), look — напрям погляду камери, wind — вітер (Climate.wind),
   * w — показник погоди, region — регіон машини, cam — позиція камери (порядок прозорих листків).
   */
  update(dt: number, anchor: THREE.Vector3 | null, look: THREE.Vector3, wind: number, w: number, region: string | null, cam: THREE.Vector3): void {
    if (this.maps.length && anchor && wind > 5 && w < 0.7 && !(region && NO_LEAVES.has(region.slice(0, 2)))) this.emit(anchor, look, wind);
    this.step(dt);
    this.bb.begin();
    for (const l of this.leaves) {
      const map = this.maps[Math.min(this.maps.length - 1, l.frame0 + Math.floor(l.age))];
      this.bb.push(map, false, l.p.x, l.p.z, -l.p.y, l.size, l.rot);
    }
    this.bb.end(cam);
  }

  private emit(anchor: THREE.Vector3, look: THREE.Vector3, wind: number): void {
    const k = Math.min(1, Math.max(0, (wind - 5) / 13));
    if (rnd() >= 1 - k / 2) return;
    const n = Math.trunc(3 - 2 * k);
    // Точка під машиною й напрям погляду — у координатах гри.
    const rx = anchor.x;
    const ry = -anchor.z;
    const rz = anchor.y;
    const yaw = Math.atan2(-look.z, look.x);
    for (let i = 0; i < n && this.leaves.length < MAX; i++) {
      let a = rnd();
      let b = rnd();
      if (a + b > 1) {
        a = 1 - a;
        b = 1 - b;
      }
      const a1 = yaw + 0.79;
      const a2 = yaw - 0.79;
      const x = rx + 42 * (a * Math.cos(a1) + b * Math.cos(a2));
      const y = ry + 42 * (a * Math.sin(a1) + b * Math.sin(a2));
      const f1 = 1 + 1.5 * (rnd() - rnd());
      const f2 = (1 + 1.5 * (rnd() - rnd())) * 2.5 * rnd();
      const v = new THREE.Vector3(rnd() * f2, wind * (1 + rnd()) * f1, 0.25 * f1 - rnd() * f2);
      const size = (0.2 + 0.05 * k) * (1 + 0.1 * (rnd() * 2 - 1));
      this.leaves.push({
        size,
        rot: rnd() * Math.PI * 2,
        p: new THREE.Vector3(x, y, rz),
        v,
        z0: rz,
        age: 0,
        phi: 0,
        omega: (rnd() - rnd()) * 12.56,
        spin: (1 + rnd()) * Math.PI,
        frame0: Math.min(Math.floor(rnd() * this.maps.length), this.maps.length - 1),
      });
    }
  }

  private step(dt: number): void {
    for (let i = this.leaves.length - 1; i >= 0; i--) {
      const l = this.leaves[i];
      l.age += dt;
      const speed = l.v.length();
      const next = speed - DRAG * dt;
      if (l.age > LIFE || next <= 0) {
        this.leaves.splice(i, 1);
        continue;
      }
      l.v.multiplyScalar(next / speed);
      l.phi += l.omega * dt;
      // Кружляння — приріст позиції щокадру (як у exe, без dt), межа висоти — після нього.
      const r = 0.025 * next;
      const h = Math.hypot(l.v.x, l.v.y) || 1;
      l.p.x += l.v.x * dt + (l.v.y / h) * r * Math.cos(l.phi);
      l.p.y += l.v.y * dt - (l.v.x / h) * r * Math.cos(l.phi);
      l.p.z = Math.max(l.z0 + 0.25, l.p.z + l.v.z * dt + r * Math.sin(l.phi));
      l.rot += l.spin * dt;
    }
  }

  dispose(): void {
    this.bb.dispose();
    this.leaves.length = 0;
    this.group.removeFromParent();
  }
}
