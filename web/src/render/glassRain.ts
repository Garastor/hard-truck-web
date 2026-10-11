import * as THREE from 'three';

/**
 * Краплі на лобовому склі й двірники. В оригіналі текстура скла `glass.txr` позначена `noload` — гра заповнює її
 * сама (спрайти крапель `glass_1/2.msk` 5×5), а двірники її протирають. Тут так само: оригінальні спрайти
 * крапель штампуються на полотно 256×256 у координатах текстури скла, двірник стирає сектор, який замів за кадр.
 * Геометрію (вісь, довжину двірника, площину й UV скла) беремо з моделі кабіни.
 */

/** Кут розмаху двірника від положення спокою, рад, і тривалість одного помаху туди-назад, с (гіпотеза). */
const SWEEP = (105 * Math.PI) / 180;
/**
 * Повний помах двірників (туди й назад), с — як довжина запису wipersSound (1,62 с, у ньому два стуки: у крайніх
 * положеннях), щоб звук ішов у такт (гіпотеза: темп помаху в оригіналі не розібрано).
 */
const PERIOD = 1.62;
/** Нових крапель за секунду під дощем і швидкість висихання без дощу (частка непрозорості за секунду). */
const DROPS_PER_SEC = 60;
const DRY_RATE = 0.08;
const SIZE = 256;

interface Wiper {
  obj: THREE.Object3D;
  base: THREE.Matrix4;
  /** Вісь і кінець двірника в системі кабіни (у спокої), довжина — з геометрії. */
  pivot: THREE.Vector3;
  length: number;
  /** Матриця «двірник → кабіна» у спокої. */
  toCab: THREE.Matrix4;
}

export class GlassRain {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly wipers: Wiper[] = [];
  /** Площина скла в системі кабіни: точка, два ребра і їхні UV — для переведення точки в UV. */
  private glass: { o: THREE.Vector3; e1: THREE.Vector3; e2: THREE.Vector3; uv0: THREE.Vector2; du1: THREE.Vector2; du2: THREE.Vector2 } | null = null;
  private phase = 0;
  /** Скільки секунд без дощу (суху текстуру не оновлюємо). */
  private dry = Infinity;
  private angle = 0;
  wipersOn = false;
  raining = false;
  /** Початок кожного помаху (звук двірників). */
  onStroke: (() => void) | null = null;

  /** cabRoot — внутрішня група кабіни (система моделі), у якій шукаємо скло й двірники. */
  /** sprites — оригінальні краплі (txr/glass_1.msk, glass_2.msk); без них — власний кружок. */
  constructor(
    cabRoot: THREE.Object3D,
    private readonly sprites: HTMLCanvasElement[] = [],
  ) {
    this.canvas.width = this.canvas.height = SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.wrapS = this.texture.wrapT = THREE.RepeatWrapping;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    // Рядок 0 полотна — v = 0 (як UV моделей).
    this.texture.flipY = false;
    cabRoot.updateMatrixWorld(true);
    const inv = cabRoot.matrixWorld.clone().invert();
    cabRoot.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && (mesh.material as THREE.MeshBasicMaterial).map?.name === 'txr/glass.txr' && !this.glass) {
        this.glass = glassPlane(mesh, inv);
        mesh.material = new THREE.MeshBasicMaterial({
          map: this.texture,
          transparent: true,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
      }
      // Екземпляр двірника й обʼєкт усередині мають те саме імʼя — обертаємо лише зовнішній.
      if (/^wiper\d?$/i.test(o.name) && !this.wipers.some((w) => isAncestor(w.obj, o))) {
        const toCab = o.matrixWorld.clone().premultiply(inv);
        const box = new THREE.Box3();
        const own = o.matrixWorld.clone().invert();
        o.traverse((x) => {
          const m = x as THREE.Mesh;
          if (!m.isMesh) return;
          m.geometry.computeBoundingBox();
          box.union(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld.clone().premultiply(own)));
        });
        this.wipers.push({
          obj: o,
          base: o.matrix.clone(),
          pivot: new THREE.Vector3().applyMatrix4(toCab),
          length: Math.max(0.1, box.max.x),
          toCab,
        });
      }
    });
  }

  get hasWipers(): boolean {
    return this.wipers.length > 0;
  }

  update(dt: number, _speedKmh = 0): void {
    const ctx = this.ctx;
    // Двірники: косинусний помах; вимкнені — доходять до положення спокою.
    const prev = this.angle;
    if (this.wipersOn || this.phase > 0) {
      if (this.phase === 0) this.onStroke?.();
      this.phase += dt / PERIOD;
      if (!this.wipersOn && this.phase >= 1) this.phase = 0;
      else if (this.phase >= 1) {
        this.phase %= 1;
        this.onStroke?.();
      }
    }
    this.angle = -SWEEP * (0.5 - 0.5 * Math.cos(2 * Math.PI * this.phase));
    for (const w of this.wipers) {
      w.obj.matrix.copy(w.base).multiply(new THREE.Matrix4().makeRotationY(this.angle));
    }

    let dirty = false;
    if (this.raining) this.dry = 0;
    else this.dry += dt;
    if (this.raining) {
      const n = Math.floor(DROPS_PER_SEC * dt + Math.random());
      for (let i = 0; i < n; i++) this.drop(Math.random() * SIZE, Math.random() * SIZE);
      dirty = n > 0;
    } else if (this.dry < 2 / DRY_RATE) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = `rgba(0,0,0,${Math.min(1, DRY_RATE * dt)})`;
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.globalCompositeOperation = 'source-over';
      dirty = true;
    }
    if (this.glass && prev !== this.angle) {
      for (const w of this.wipers) this.wipe(w, prev, this.angle);
      dirty = true;
    }
    if (dirty) this.texture.needsUpdate = true;
  }

  /** Крапля: оригінальний спрайт (здебільшого glass_1), у рідному розмірі. */
  private drop(x: number, y: number): void {
    const ctx = this.ctx;
    if (this.sprites.length) {
      const sp = this.sprites[Math.random() < 0.75 ? 0 : this.sprites.length - 1];
      ctx.drawImage(sp, Math.floor(x), Math.floor(y));
      return;
    }
    const r = 1.5 + Math.random() * 3;
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, 0, x, y, r);
    g.addColorStop(0, 'rgba(235,240,245,0.55)');
    g.addColorStop(0.7, 'rgba(160,170,180,0.35)');
    g.addColorStop(1, 'rgba(60,70,80,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Стерти сектор між двома положеннями двірника (з урахуванням повтору текстури). */
  private wipe(w: Wiper, a0: number, a1: number): void {
    const ctx = this.ctx;
    const pts: THREE.Vector2[] = [this.uv(w.pivot)];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      const tip = new THREE.Vector3(Math.cos(a) * w.length, 0, -Math.sin(a) * w.length).applyMatrix4(w.toCab);
      pts.push(this.uv(tip));
    }
    ctx.globalCompositeOperation = 'destination-out';
    ctx.fillStyle = '#000';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 6;
    const u0 = Math.floor(pts[0].x);
    const v0 = Math.floor(pts[0].y);
    for (const ox of [-1, 0, 1])
      for (const oy of [-1, 0, 1]) {
        ctx.beginPath();
        pts.forEach((p, i) => {
          const x = (p.x - u0 + ox) * SIZE;
          const y = (p.y - v0 + oy) * SIZE;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Точка кабіни → UV скла (проєкція на площину скла). */
  private uv(p: THREE.Vector3): THREE.Vector2 {
    const g = this.glass!;
    const d = p.clone().sub(g.o);
    const a11 = g.e1.dot(g.e1);
    const a12 = g.e1.dot(g.e2);
    const a22 = g.e2.dot(g.e2);
    const b1 = d.dot(g.e1);
    const b2 = d.dot(g.e2);
    const det = a11 * a22 - a12 * a12 || 1;
    const s = (b1 * a22 - b2 * a12) / det;
    const t = (a11 * b2 - a12 * b1) / det;
    return g.uv0.clone().addScaledVector(g.du1, s).addScaledVector(g.du2, t);
  }
}

function glassPlane(mesh: THREE.Mesh, inv: THREE.Matrix4) {
  const P = mesh.geometry.attributes.position;
  const U = mesh.geometry.attributes.uv;
  const m = mesh.matrixWorld.clone().premultiply(inv);
  const v = (i: number) => new THREE.Vector3().fromBufferAttribute(P, i).applyMatrix4(m);
  const t = (i: number) => new THREE.Vector2(U.getX(i), U.getY(i));
  const o = v(0);
  return { o, e1: v(1).sub(o), e2: v(2).sub(o), uv0: t(0), du1: t(1).sub(t(0)), du2: t(2).sub(t(0)) };
}

function isAncestor(a: THREE.Object3D, o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === a) return true;
  return false;
}
