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
 * Відблиски фар і ліхтарів на мокрому асфальті (білборди refl_r / refl_w у блоках *FFara*, *BFara*): як в
 * оригіналі — смужка на дорозі між машиною й глядачем, тобто віддзеркалення ліхтаря в площині дороги.
 * Дзеркальна точка лежить під дорогою (асфальт би її закрив), тож щокадру ставимо білборд туди, де промінь
 * «камера → дзеркальна точка» перетинає дорогу, і зменшуємо пропорційно — на екрані те саме місце й розмір, а
 * перевірка глибини працює (кузови відблиск закривають).
 */
/** Наскільки над оцінкою дороги ставити відблиск, м (дорога під колесами трохи вища за розрахункову). */
const REFLECTION_LIFT = 0.15;

export class LampReflections {
  private readonly items: { sprite: THREE.Sprite; mirror: THREE.Vector3; scale: THREE.Vector2; front: boolean }[] = [];
  private readonly tmp = new THREE.Vector3();

  /** root — модель у системі гри (z угору), groundZ — висота дороги в цій системі. */
  constructor(
    private readonly root: THREE.Object3D,
    private readonly groundZ: number,
  ) {
    root.traverse((o) => {
      const sp = o as THREE.Sprite;
      if (!sp.isSprite || !/refl_[rw]/.test((sp.material.map as THREE.Texture | null)?.name ?? '')) return;
      const m = sp.position.clone();
      m.z = 2 * groundZ - m.z;
      // Передня фара (*FFara*) чи задній ліхтар (*BFara*) — за назвою блоку-предка.
      let front = false;
      for (let p: THREE.Object3D | null = sp.parent; p; p = p.parent) {
        const f = /([FB])Fara[LR]$/i.exec(p.name);
        if (f) {
          front = f[1].toUpperCase() === 'F';
          break;
        }
      }
      this.items.push({ sprite: sp, mirror: m, scale: new THREE.Vector2(sp.scale.x, sp.scale.y), front });
      // Нижнім краєм — на дорозі (інакше нижня половина білборду ховається під асфальтом).
      sp.center.y = 0;
    });
  }

  update(camera: THREE.Camera): void {
    if (!this.items.length) return;
    this.root.updateWorldMatrix(true, false);
    // Камера в системі моделі (батьки білбордів — без власних зсувів, тож система моделі = їхня).
    const c = this.root.worldToLocal(camera.getWorldPosition(this.tmp));
    for (const it of this.items) {
      const m = it.mirror;
      const g = this.groundZ + REFLECTION_LIFT;
      // Віддзеркалення видно лише з боку, куди світить ліхтар (задній — ззаду машини, фара — спереду; вісь y
      // моделі — вперед); інакше точка на дорозі виходила з протилежного боку — «рентген» крізь машину.
      const facing = it.front ? c.y > m.y : c.y < m.y;
      it.sprite.visible = facing && c.z > g;
      if (!it.sprite.visible) continue;
      const t = (c.z - g) / (c.z - m.z);
      it.sprite.position.set(c.x + (m.x - c.x) * t, c.y + (m.y - c.y) * t, g);
      it.sprite.scale.set(it.scale.x * t, it.scale.y * t, 1);
    }
  }
}
