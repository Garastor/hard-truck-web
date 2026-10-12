import type { FileSource } from '../../assets/loader';
import { parseB3d, type Block } from '../../formats/b3d';
import { parseRmp } from '../../formats/rmp';
import { parseTech, type TechRecord } from '../../formats/tech';
import { SceneAssembler } from '../../render/sceneBuilder';
import type { TruckDef } from '../../game/trucks';

/**
 * Вантажівки Дальнобойщиків 2: параметри — `vehicle.tech` (formats/tech.ts), моделі — `COMMON/TRUCKS.B3D`
 * (+ текстури TRUCKS1.RES, кольори й колір-ключ — палітра common.plm).
 *
 * Модель збірна: група `<prefix>` (car_node) з посиланнями (18) на деталі в просторах `<prefix>…Space` і
 * групами коліс `<prefix>wheel0…N` — у кожній посилання на простір `<prefix>WheelNSpace` і модель колеса
 * (`Single0Wheel21`…). Колеса: 0, 1 — передні (керовані), далі пари назад; парне — ліве (гіпотеза за назвами
 * `Single0`/`Single1`, перевіряється на моделі).
 */
export interface Ht2Trucks {
  records: TechRecord[];
  asm: SceneAssembler;
}

export async function loadTrucks(source: FileSource, palette: Uint8Array | null): Promise<Ht2Trucks> {
  const [tech, b3d, res] = await Promise.all([
    source.read('vehicle.tech'),
    source.read('COMMON/TRUCKS.B3D'),
    source.read('COMMON/TRUCKS1.RES'),
  ]);
  const asm = new SceneAssembler(parseB3d(b3d), parseRmp(res), { lit: true, colorKey: true, palette: palette ?? undefined, nearGroup: 0 });
  return { records: parseTech(tech).records, asm };
}

/** Вантажівки, якими можна кермувати: тягачі й вантажівки з кузовом, модель яких є в TRUCKS.B3D. */
export function drivable(t: Ht2Trucks): TechRecord[] {
  return t.records.filter((r) => (r.group === 'tractors' || r.group === 'lorries') && !!t.asm.block(r.carNode));
}

/** Колеса моделі: групи `<prefix>wheelN` у вузлі car_node → простір і модель колеса з посилання (18). */
function wheelsOf(body: Block, prefix: string): { space: string; node: string }[] {
  const out: { space: string; node: string }[] = [];
  const re = new RegExp(`^${prefix}wheel(\\d+)$`, 'i');
  for (const g of body.groups ?? [])
    for (const c of g) {
      const m = re.exec(c.name);
      if (!m) continue;
      const ref = c.groups?.flat().find((x) => x.data.t === 18);
      if (ref && ref.data.t === 18) out[Number(m[1])] = { space: ref.data.space, node: ref.data.object };
    }
  return out.filter(Boolean);
}

/** TruckDef (спільний з першою грою) з запису vehicle.tech. */
export function truckDef(t: Ht2Trucks, r: TechRecord): TruckDef | null {
  const body = t.asm.block(r.carNode);
  if (!body) return null;
  const wheels = wheelsOf(body, r.prefix);
  if (wheels.length < 4) return null;
  return {
    index: r.index,
    carNode: r.carNode,
    prefix: r.prefix,
    wheelSpaces: wheels.map((w) => w.space),
    wheelNodes: wheels.map((w) => w.node),
    cockpitSpace: r.cockpitSpace,
    panelMask: '',
    tachScale: [50, 240],
    speedScale: [160, 240],
    tech: {
      mass: r.mass,
      maxRotMomentum: r.maxRotMomentum,
      brakePower: r.brakePower,
      wheelRadius: r.wheelRadius,
      rearAxleCoeff: r.rearAxleCoeff,
      reverseCoeff: r.reverseCoeff,
      gears: r.gears,
      tachMaxPower: r.tachMaxPower,
      drivingWheels: r.drivingWheels.slice(0, wheels.length),
      bodyMass: r.bodyMass,
      cargoLoad: r.cargoLoad,
      horsePower: r.horsePower,
      price: r.price,
      frictionCoeff: 1.4,
      centerMass: r.centerMass,
      cargoBottom: r.cargoBottom,
      bodyHeight: r.bodyHeight,
      bodySquare: r.bodySquare,
      viewer: r.viewer,
      viewerTilt: r.viewerTilt,
    },
  };
}
