import * as THREE from 'three';

/**
 * Світло вантажівки — лише перемикачі моделей, як в оригіналі (відблиски — білборди ReflFara* біля кожної фари й
 * ліхтаря; плям світла на дорозі в оригіналі немає). `StopFaraKey`: 2 — габарит (скло ліхтаря), 1 — гальмо
 * (яскраве червоне скло з відблиском ReflFaraKey); у групі габариту — відблиск ReflFaraKeyBG. `BackFaraKey` —
 * задній хід, `GlowF*Key` — ореол фар. Вночі й у дощ горять габарити й фари з відблисками; удень — лише скло.
 */
export interface LightGeometry {
  groundY: number;
  frontZ: number;
  backZ: number;
  width: number;
}

export class TruckLights {
  private key = '';

  constructor(
    private readonly setSwitch: ((name: string, state: number) => void) | undefined,
    _parent?: THREE.Object3D,
    _geo?: LightGeometry,
  ) {}

  /** night — нічна траса; wet — дощ: обидва вмикають габарити й фари з відблисками. */
  update(night: boolean, wet: boolean, braking: boolean, reverse: boolean): void {
    const lights = night || wet;
    const key = `${+lights}${+braking}${+reverse}`;
    if (key === this.key) return;
    this.key = key;
    const sw = this.setSwitch;
    if (!sw) return;
    for (const s of ['L', 'R']) {
      sw(`StopFaraKey${s}`, braking ? 1 : 2);
      sw(`BackFaraKey${s}`, reverse ? 1 : 0);
      sw(`GlowF${s}Key`, lights ? 1 : 0);
    }
    // ReflFaraKey — спільне імʼя для відблисків фар і стоп-сигналу.
    sw('ReflFaraKey', lights || braking ? 1 : 0);
    sw('ReflFaraKeyBG', lights ? 1 : 0);
  }
}

/**
 * Оригінальні відблиски фар і ліхтарів на мокрому асфальті (білборди refl_r / refl_w у блоках *FFara*, *BFara*)
 * сховані: їх замінюють власні (WetReflections) — на прохання користувача. Оригінал ставить білборд у точку дороги
 * між машиною й глядачем (HTruck.exe ≈ 0x4b6800, не розібрано).
 */
export function hideLampReflections(root: THREE.Object3D): void {
  root.traverse((o) => {
    const sp = o as THREE.Sprite;
    if (sp.isSprite && /refl_[rw]/.test((sp.material.map as THREE.Texture | null)?.name ?? '')) sp.visible = false;
  });
}
