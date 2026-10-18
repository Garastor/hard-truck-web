import * as THREE from 'three';
import { RaceMode } from '../race';
import { toThree } from '../world/world';
import type { Ht2Drive } from '../drive';
import type { Ht2Career } from './career';

/**
 * Гонки на Кільці в кар'єрі — за king.exe (re/notes/ht2/race.md, задача provideRacesRegular 0x4279d0):
 * - перша спроба — через 600…1199 с гри від початку (0x434780), далі — 300 с після кінця попередньої (0x4194a0);
 * - набір: гравець далі 700 м від start1_3 (0x64b760); пейджер RACES_TO_TAKE_PLACE_IN «НА КОЛЬЦЕ ЧЕРЕЗ %g МИН.» —
 *   хв = ⌊min(0,1·L; 3660)/60⌋, L — шлях дорогами від гравця до start1_4 (0x427e0f); відлік — хв·60 с;
 * - гравець приїхав у тригер start_svetofor, поки гонку оголошено, — світлофор і старт (0x53e510); не встиг — суперники
 *   їдуть без нього, штрафу немає (0x4278b0);
 * - 4 суперники класу машини гравця на start1_1…4, 3 кола; приз лише за перше місце: $5000 (0x426d29), YOU_MADE і
 *   ліцензії на найм — min(3; ⌊√(перемог поспіль + 1)⌋); за 2–3 місця — нічого, лічильник перемог скидається (0x426b00).
 *
 * Порт (на прохання користувача): оголошення — не частіше ніж раз на 5 хв реального часу (PAUSE; ігровий час іде в
 * десятки разів швидше, і 300 ігрових секунд king.exe давали оголошення щохвилини), і перше — теж через 5 хв; відлік
 * «через N хв» — ігровими хвилинами (годинник гри).
 *
 * Гіпотези порту: відлік — ігровий час (c.time); тригер start_svetofor (геометрія тригера в порту не розбирається) — ближче
 * 15 м від start1_5, вузла за суперниками; «перемоги поспіль» — у збереженні (`raceWins`); строк ліцензії — як за
 * доставку першим.
 */
/** Пауза перед наступною спробою оголошення (і перед першою), с реального часу. */
const PAUSE = 300;
const MIN_DIST = 700;
const PRIZE = 5000;
const TRIGGER_R = 15;

export class CareerRaces {
  private state: 'pause' | 'announced' | 'running' = 'pause';
  /** Ігровий час кінця відліку (announced). */
  private at = 0;
  /** Скільки ще чекати до спроби набору (pause), с реального часу. */
  private wait = PAUSE;
  private readonly nodes = new Map<string, THREE.Vector3>();

  constructor(
    private readonly drive: Ht2Drive,
    private readonly career: Ht2Career,
    private readonly msg: (key: string, fallback: string, value?: number) => string,
    private readonly licenceTime: number,
  ) {
    for (const r of drive.world.regions.values())
      for (const room of r.way.rooms) for (const n of room.nodes) if (/^start1_\d$/.test(n.name)) this.nodes.set(n.name, toThree(...n.pos));
  }

  /** Гонку оголошено й можна стати на старт — для підказки й карти. */
  get announced(): boolean {
    return this.state === 'announced';
  }

  /** dt — крок реального часу, с. */
  update(dt: number): void {
    const c = this.career;
    const me = this.drive.truck.visual.position;
    const s3 = this.nodes.get('start1_3');
    const s4 = this.nodes.get('start1_4');
    const s5 = this.nodes.get('start1_5');
    if (!s3 || !s4 || !s5 || this.drive.race && this.state !== 'running') return;
    if (this.state === 'pause') {
      this.wait -= dt;
      if (this.wait > 0 || me.distanceTo(s3) < MIN_DIST) return;
      const L = this.drive.routeLeft(s4) ?? me.distanceTo(s4);
      const minutes = Math.floor(Math.min(0.1 * L, 3660) / 60);
      this.drive.say(this.msg('RACES_TO_TAKE_PLACE_IN', 'НА КІЛЬЦІ ЧЕРЕЗ %g ХВ. БУДУТЬ ПЕРЕГОНИ!', minutes), 8);
      this.state = 'announced';
      this.at = c.time + minutes * 60;
      return;
    }
    if (this.state === 'announced') {
      if (me.distanceTo(s5) < TRIGGER_R) return this.start();
      if (c.time >= this.at) this.rest();
    }
  }

  private start(): void {
    const race = new RaceMode(this.drive, this.drive.roads, (k, fb) => this.msg(k, fb), true);
    race.onFinish = (place) => {
      if (place === 1) {
        const c = this.career;
        c.money += PRIZE;
        c.raceWins = (c.raceWins ?? 0) + 1;
        this.drive.say(this.msg('YOU_MADE', 'ВИ ЗАРОБИЛИ: %g', PRIZE), 6);
        // Перемога в гонці (подія 0xb з бітом 0, king.exe 0x4d76b0) — ролик кубка TRw.bne.
        void this.drive.clip('TRw.bne');
        const n = Math.min(3, Math.floor(Math.sqrt(c.raceWins + 1)));
        c.licences = [...(c.licences ?? []), ...Array.from({ length: n }, () => c.time + this.licenceTime)];
      } else this.career.raceWins = 0;
      race.dispose();
      this.drive.race = null;
      this.rest();
    };
    this.drive.race = race;
    this.state = 'running';
  }

  private rest(): void {
    this.state = 'pause';
    this.wait = PAUSE;
  }
}
