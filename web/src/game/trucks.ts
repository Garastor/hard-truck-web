import * as THREE from 'three';
import { parseIni, iniGet, iniNum, iniNums, type Ini } from '../formats/ini';
import type { SceneAssembler } from '../render/sceneBuilder';

/** Опис вантажівки з TRUCK.TCH: вузли моделі [NODESn] + техніка [TECHn]. */
export interface TruckDef {
  index: number;
  carNode: string;
  prefix: string;
  wheelSpaces: [string, string, string, string];
  wheelNodes: [string, string, string, string];
  cockpitSpace: string;
  /** Екранні координати (x, y) 2D-приладів панелі для зовнішньої камери (TachScale/SpeedScale у TCH). */
  tachScale: [number, number];
  speedScale: [number, number];
  tech: TruckTech;
}

/** Параметри динаміки (див. re/notes/tech-params.md; значення за замовчуванням — як у HTruck.exe). */
export interface TruckTech {
  mass: number;
  maxRotMomentum: number;
  brakePower: number;
  wheelRadius: number;
  rearAxleCoeff: number;
  reverseCoeff: number;
  gears: number[];
  tachMaxPower: number;
  drivingWheels: number[];
  bodyMass: number;
  cargoLoad: number;
  horsePower: number;
  price: number;
  frictionCoeff: number;
  centerMass: [number, number, number];
  /** Центр дна вантажу (center_of_cargo_bottom, система моделі: x, вперед, угору). */
  cargoBottom: [number, number, number];
  /** Висота й площа кузова (body_height, body_square): обʼєм кузова ≈ площа × висота — гіпотеза. */
  bodyHeight: number;
  bodySquare: number;
  /** Точка очей водія (OV) у системі вантажівки та нахил погляду (tangViewer, градуси). */
  viewer: [number, number, number];
  viewerTilt: number;
}

export function parseTrucks(tchText: string): TruckDef[] {
  const ini = parseIni(tchText);
  const out: TruckDef[] = [];
  for (let i = 1; ini.has(`nodes${i}`); i++) {
    const n = `NODES${i}`;
    const g = (k: string) => iniGet(ini, n, k) ?? '';
    out.push({
      index: i,
      carNode: g('car_node'),
      prefix: g('prefix'),
      wheelSpaces: [g('wheel_space0'), g('wheel_space1'), g('wheel_space2'), g('wheel_space3')],
      wheelNodes: [g('wheel_node_fl'), g('wheel_node_fr'), g('wheel_node_bl'), g('wheel_node_br')],
      cockpitSpace: g('cockpit_space'),
      tachScale: ((v) => [v[0] ?? 50, v[1] ?? 240] as [number, number])(iniNums(ini, n, 'TachScale') ?? []),
      speedScale: ((v) => [v[0] ?? 160, v[1] ?? 240] as [number, number])(iniNums(ini, n, 'SpeedScale') ?? []),
      tech: readTech(ini, `TECH${i}`),
    });
  }
  return out;
}

function readTech(ini: Ini, s: string): TruckTech {
  const gears: number[] = [];
  for (let g = 1; g <= 13; g++) {
    const v = iniNum(ini, s, `gear_trans_coeff${g}`, -100);
    if (v < -99) break;
    gears.push(v);
  }
  const cm = iniNums(ini, s, 'CenterMassInB3D') ?? [0, 0, 0];
  const cb = iniNums(ini, s, 'center_of_cargo_bottom') ?? [0, -2, 0];
  return {
    mass: iniNum(ini, s, 'mass', 1000),
    maxRotMomentum: iniNum(ini, s, 'maxrotmomentum', 500),
    brakePower: iniNum(ini, s, 'breakpower', 6000),
    wheelRadius: iniNum(ini, s, 'rwheel', 0.3),
    rearAxleCoeff: iniNum(ini, s, 'rear_axle_coeff', 5),
    reverseCoeff: iniNum(ini, s, 'reverse_trans_coeff', -4),
    gears,
    tachMaxPower: iniNum(ini, s, 'tach_with_max_power', 20),
    drivingWheels: iniNums(ini, s, 'driving_wheels') ?? [1, 1, 1, 1],
    bodyMass: iniNum(ini, s, 'body_mass', 1000),
    cargoLoad: iniNum(ini, s, 'cargo_and_body_pick_load', 6000),
    horsePower: iniNum(ini, s, 'horse_power', 150),
    price: iniNum(ini, s, 'price', 10000),
    frictionCoeff: iniNum(ini, s, 'friction_coeff', 1.4),
    centerMass: [cm[0] ?? 0, cm[1] ?? 0, cm[2] ?? 0],
    cargoBottom: [cb[0] ?? 0, cb[1] ?? -2, cb[2] ?? 0],
    bodyHeight: iniNum(ini, s, 'body_height', 2.5),
    bodySquare: iniNum(ini, s, 'body_square', 12),
    viewer: ((v) => [v[0] ?? -0.4, v[1] ?? 0.4, v[2] ?? 1.4] as [number, number, number])(iniNums(ini, s, 'OV') ?? []),
    viewerTilt: iniNum(ini, s, 'tangViewer', -7.16),
  };
}

/** Візуальна модель вантажівки: кузов + 4 колеса (у системі гри, Z угору). */
export interface TruckModel {
  root: THREE.Group;
  body: THREE.Object3D;
  /** Колеса FL, FR, BL, BR; кожне — група з початковою матрицею простору колеса. */
  wheels: THREE.Object3D[];
  wheelBase: THREE.Matrix4[];
}

export function buildTruckModel(asm: SceneAssembler, def: TruckDef): TruckModel | null {
  const bodyTpl = asm.template(def.carNode);
  if (!bodyTpl) return null;
  const root = new THREE.Group();
  root.name = def.carNode;
  const body = bodyTpl.clone();
  root.add(body);
  const wheels: THREE.Object3D[] = [];
  const wheelBase: THREE.Matrix4[] = [];
  // У TCH wheel_space0..3 = FL, FR, BL, BR; вузли коліс — wheel_node_fl/fr/bl/br.
  for (let i = 0; i < 4; i++) {
    const m = asm.space(def.wheelSpaces[i]) ?? new THREE.Matrix4();
    const tpl = asm.template(def.wheelNodes[i]);
    const w = new THREE.Group();
    w.matrixAutoUpdate = false;
    w.matrix.copy(m);
    if (tpl) w.add(tpl.clone());
    root.add(w);
    wheels.push(w);
    wheelBase.push(m.clone());
  }
  return { root, body, wheels, wheelBase };
}
