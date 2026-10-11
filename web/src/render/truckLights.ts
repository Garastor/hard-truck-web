import * as THREE from 'three';

/**
 * Світло вантажівки. Перемикачі моделей: `StopFaraKey` (1 — габарит: червоне скло + відблиск, 2 — гальмо),
 * `ReflFaraKey` (відблиски-зірочки фар і габаритів), `ReflFaraKeyBG` (відблиск стоп-сигналу), `BackFaraKey`
 * (задній хід), `GlowF*Key` (ореол фар). Вночі й у дощ горять габарити й фари; удень — лише скло.
 * Світлові плями на асфальті (фари вночі — біла попереду, габарити/стоп — червона позаду, у дощ — відблиск на
 * мокрій дорозі) — власна реалізація порту: в оригіналі освітлення дороги немає в даних (гіпотеза щодо вигляду).
 */
export interface LightGeometry {
  /** Висота дороги в локальній системі машини (Three.js, y угору), передній і задній краї кузова (z). */
  groundY: number;
  frontZ: number;
  backZ: number;
  width: number;
}

let poolTexture: THREE.Texture | null = null;
function radial(): THREE.Texture {
  if (poolTexture) return poolTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  poolTexture = new THREE.CanvasTexture(c);
  poolTexture.colorSpace = THREE.SRGBColorSpace;
  return poolTexture;
}

function pool(color: number, w: number, l: number): THREE.Mesh {
  const mat = new THREE.MeshBasicMaterial({
    map: radial(),
    color,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
    fog: false,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), mat);
  m.rotation.x = -Math.PI / 2;
  m.renderOrder = 5;
  m.visible = false;
  return m;
}

export class TruckLights {
  private key = '';
  private readonly front: THREE.Mesh;
  private readonly rear: THREE.Mesh;

  constructor(
    private readonly setSwitch: ((name: string, state: number) => void) | undefined,
    parent: THREE.Object3D,
    geo: LightGeometry,
  ) {
    this.front = pool(0xfff2c8, geo.width * 2.6, 20);
    this.front.position.set(0, geo.groundY + 0.05, geo.frontZ - 10.5);
    this.rear = pool(0xff2010, geo.width * 1.1, 4);
    this.rear.position.set(0, geo.groundY + 0.05, geo.backZ + 1.2);
    parent.add(this.front, this.rear);
  }

  /** night — нічна траса (фари світять на дорогу); wet — дощ (відблиски габаритів на мокрому асфальті). */
  update(night: boolean, wet: boolean, braking: boolean, reverse: boolean): void {
    const lights = night || wet;
    const key = `${+night}${+wet}${+braking}${+reverse}`;
    if (key === this.key) return;
    this.key = key;
    const sw = this.setSwitch;
    if (sw) {
      for (const s of ['L', 'R']) {
        sw(`StopFaraKey${s}`, braking ? 2 : 1);
        sw(`BackFaraKey${s}`, reverse ? 1 : 0);
        sw(`GlowF${s}Key`, lights ? 1 : 0);
      }
      sw('ReflFaraKey', lights ? 1 : 0);
      sw('ReflFaraKeyBG', braking ? 1 : 0);
    }
    const fm = this.front.material as THREE.MeshBasicMaterial;
    this.front.visible = night;
    fm.opacity = 0.7;
    const rm = this.rear.material as THREE.MeshBasicMaterial;
    this.rear.visible = lights || braking;
    rm.opacity = braking ? (lights ? 0.9 : 0.45) : wet ? 0.5 : 0.35;
  }
}
