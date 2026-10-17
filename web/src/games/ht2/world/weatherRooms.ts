import * as THREE from 'three';
import type { Block } from '../engine/formats/b3d';
import type { LoadedRegion } from './world';

/**
 * Спецнабори погоди кімнат (king.exe 0x56ffd0 case 0x17; re/notes/ht2/weather.md «Набори WEATHER1…8»): подія-блок 13
 * `weather_change*` з даними `(23, n; nx, ny, nz, d)` у кімнаті — набір WEATHERn (5 — техн. тунель, 6 — гори,
 * 7 — рельєф, 8 — тунель-копанка) і площина. Поки машина гравця в цій кімнаті, вага спецнабору
 * t = clamp((P·n + d)·0,02, 0, 1): з додатного боку площини він наростає за 50 м (плавно за відстанню, не за часом);
 * після виходу з кімнати вага лишається останньою (гра її не скидає). Старт рівня (0x56d810) — за модулем стартової
 * кімнати: aa — WEATHER7, db — WEATHER6, da і ab — WEATHER8 повністю, інші — звичайна погода.
 *
 * Гіпотеза порту: кімната машини — кімната найближчої дороги WAY (ближче 30 м; далі — остання відома): кімнат, як
 * king.exe (портали), порт не відстежує, а габарити геометрії не годяться — частина кімнат з подіями порожня.
 */
interface Zone {
  set: number;
  plane: [number, number, number, number];
}

export interface Special {
  /** Номер набору WEATHERn (0 — немає). */
  set: number;
  /** Вага спецнабору 0…1 (king.exe 1 − e8). */
  k: number;
}

const START: Record<string, number> = { aa: 7, db: 6, da: 8, ab: 8 };

/** Події погоди в блоках регіону: кімната, набір, площина (гра: x, y, z угору). */
export function weatherTriggers(blocks: readonly Block[]): { room: string; set: number; plane: Zone['plane'] }[] {
  const out: { room: string; set: number; plane: Zone['plane'] }[] = [];
  const walk = (b: Block, room: string) => {
    if (b.data.t === 13 && b.data.trigger.i1 === 23 && b.data.trigger.values.length >= 4) {
      const v = b.data.trigger.values;
      const f = new Float32Array(v.buffer, v.byteOffset, 4);
      out.push({ room, set: b.data.trigger.i2, plane: [f[0], f[1], f[2], f[3]] });
      return;
    }
    for (const g of b.groups ?? []) for (const c of g) walk(c, room);
  };
  for (const b of blocks) if (b.data.t === 19 && b.name) walk(b, b.name.toLowerCase());
  return out;
}

export class WeatherRooms {
  readonly special: Special = { set: 0, k: 0 };
  private readonly seen = new WeakSet<LoadedRegion>();
  /** Події за кімнатою (у кімнаті їх може бути кілька — діє перша, як у порядку обходу гри). */
  private readonly rooms = new Map<string, Zone>();
  private started = false;

  /** Кадр: позиція машини (Three.js), її кімната (null — невідома) і модуль під нею (для старту рівня). */
  update(loaded: Iterable<LoadedRegion>, pos: THREE.Vector3, room: string | null, region: string | null): Special {
    this.sync(loaded);
    if (!this.started && region) {
      this.started = true;
      const s = START[region];
      if (s) Object.assign(this.special, { set: s, k: 1 });
    }
    const w = room ? this.rooms.get(room.toLowerCase()) : undefined;
    if (w) {
      const [nx, ny, nz, d] = w.plane;
      this.special.set = w.set;
      this.special.k = THREE.MathUtils.clamp((nx * pos.x + ny * -pos.z + nz * pos.y + d) * 0.02, 0, 1);
    }
    return this.special;
  }

  private sync(loaded: Iterable<LoadedRegion>): void {
    for (const r of loaded) {
      if (this.seen.has(r)) continue;
      this.seen.add(r);
      for (const t of weatherTriggers(r.built.assembler.b3d.blocks)) if (!this.rooms.has(t.room)) this.rooms.set(t.room, { set: t.set, plane: t.plane });
    }
  }
}
