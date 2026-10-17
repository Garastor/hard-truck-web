import * as THREE from 'three';
import { parseIni, iniGet, iniNum, iniNums, type Ini } from '../formats/ini';
import type { SceneAssembler } from '../render/sceneBuilder';

/** Опис вантажівки з TRUCK.TCH: вузли моделі [NODESn] + техніка [TECHn]. */
export interface TruckDef {
  index: number;
  carNode: string;
  prefix: string;
  /** Простори й вузли коліс: HT1 — 4 (FL, FR, BL, BR); HT2 — 4 або 6 (пари спереду назад, ліве — парне). */
  wheelSpaces: string[];
  wheelNodes: string[];
  cockpitSpace: string;
  /** 2D-кабіна (панель) — маска з програмного набору ресурсів, напр. `msk\kam_pan.msk` (перша гра: games/ht1/cab2d/cab2dFiles.ts). */
  panelMask: string;
  /** Екранні координати (x, y) 2D-приладів панелі для зовнішньої камери (TachScale/SpeedScale у TCH). */
  tachScale: [number, number];
  speedScale: [number, number];
  tech: TruckTech;
}

/** Параметри динаміки (див. re/notes/ht1/tech-params.md; значення за замовчуванням — як у HTruck.exe). */
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
      panelMask: g('panel_mask'),
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

/**
 * Масштаб стрілок [спідометр, тахометр] під розмір циферблата. У моделях кабін стрілки однакової довжини
 * (≈ 0,11–0,13 м), а циферблати намальовані на текстурі панелі різного розміру — тож на великих приладах
 * стрілка не дістає до шкали, на малих — вилазить за неї. Значення виміряно з рендера: кінчик стрілки — біля
 * внутрішнього краю поділок. Візуальне калібрування порту (не з файлів гри; оригінал, імовірно, малює
 * стрілки як є).
 */
export const NEEDLE_SCALE: Record<string, [number, number]> = {
  zil: [1.37, 0.75],
  volvo: [1.18, 1.18],
  freight: [1, 0.9],
  scania: [1, 1],
  mack: [1.03, 1.05],
  iveco: [1.13, 1.17],
  kenworth: [1.25, 1.25],
  kamaz: [1.05, 1.17],
  reno: [0.8, 0.9],
};

/** Візуальна модель вантажівки: кузов + 4 колеса (у системі гри, Z угору). */
export interface TruckModel {
  root: THREE.Group;
  body: THREE.Object3D;
  /** Колеса FL, FR, BL, BR; кожне — група з початковою матрицею простору колеса. */
  wheels: THREE.Object3D[];
  wheelBase: THREE.Matrix4[];
  /** Перемикачі моделі (лише для dynamic: вмʼятини `Damage*Key`); кількість станів перемикача. */
  setSwitch?: (name: string, state: number) => void;
  switchStates?: (name: string) => number;
}

/** Односторонні копії матеріалів моделей вантажівок (спільні для всіх екземплярів). */
const FRONT_ONLY = new WeakMap<THREE.Material, THREE.Material>();

/** dynamic — окремий екземпляр з робочими перемикачами (машина гравця: вмʼятини); інакше — копія шаблону. */
export function buildTruckModel(asm: SceneAssembler, def: TruckDef, dynamic = false): TruckModel | null {
  const dyn = dynamic ? asm.dynamicObject(def.carNode) : null;
  const bodyTpl = dyn ? null : asm.template(def.carNode);
  if (!dyn && !bodyTpl) return null;
  const root = new THREE.Group();
  root.name = def.carNode;
  const body = dyn ? dyn.root : bodyTpl!.clone();
  // Детальний рівень моделі (тип 29, група 2) містить і власні колеса-екземпляри; колеса додаємо окремо
  // (вони крутяться й повертаються), тож ці ховаємо.
  const wheelNames = new Set(def.wheelNodes.map((n) => n.toLowerCase()));
  body.traverse((o) => {
    if (wheelNames.has(o.name.toLowerCase())) o.visible = false;
    // Вогонь (Flame/SwitchFlame) у моделі — для палаючих уламків; на справній машині не показуємо.
    if (o.name === 'Flame') o.visible = false;
  });
  root.add(body);
  // Побиті колеса (`refer_DamageWheel<N>Key`, 4 стани — дедалі сильніше пошкоджене колесо): варіанти лежать у
  // вузлі колеса всередині кузова. У динамічної моделі цей вузол переносимо в групу колеса, що крутиться, —
  // перемикач показує потрібний варіант; інакше — ціле колесо-шаблон.
  const inBody = new Map<string, THREE.Object3D>();
  if (dyn) {
    for (const c of body.children) {
      const key = c.name.toLowerCase();
      if (wheelNames.has(key) && c.children.some((g) => /DamageWheel\d+Key#/.test(g.name))) inBody.set(key, c);
    }
  }
  root.updateMatrixWorld(true);
  const wheels: THREE.Object3D[] = [];
  const wheelBase: THREE.Matrix4[] = [];
  // У TCH wheel_space0..3 = FL, FR, BL, BR; вузли коліс — wheel_node_fl/fr/bl/br.
  for (let i = 0; i < def.wheelSpaces.length; i++) {
    const m = asm.space(def.wheelSpaces[i]) ?? new THREE.Matrix4();
    const w = new THREE.Group();
    w.matrixAutoUpdate = false;
    w.matrix.copy(m);
    const own = inBody.get(def.wheelNodes[i].toLowerCase());
    if (own) {
      // Матриця вузла відносно простору колеса (кузов стоїть у корені без зсуву).
      own.matrix.copy(m).invert().multiply(own.matrixWorld);
      own.matrixAutoUpdate = false;
      own.visible = true;
      w.add(own);
    } else {
      const tpl = asm.template(def.wheelNodes[i]);
      if (tpl) w.add(tpl.clone());
    }
    root.add(w);
    wheels.push(w);
    wheelBase.push(m.clone());
  }
  // Моделі вантажівок — без зворотного боку полігонів (як в оригіналі): інакше крізь прозорі вирізи
  // крил видно внутрішній чорний бік (чорне над колесами Renault).
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const one = (m: THREE.Material) => {
      let c = FRONT_ONLY.get(m);
      if (!c) {
        c = m.clone();
        c.side = THREE.FrontSide;
        // Однотонні деталі моделі лежать під текстурованими в тій самій площині (бампер Renault на чорному):
        // оригінал малює деталь пізніше — зсуваємо однотонні вглиб, деталь завжди зверху.
        if (c.polygonOffset && !(c as THREE.MeshBasicMaterial).map) {
          c.polygonOffsetFactor = 1;
          c.polygonOffsetUnits = 2;
        }
        FRONT_ONLY.set(m, c);
      }
      return c;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(one) : one(mesh.material);
  });
  return { root, body, wheels, wheelBase, setSwitch: dyn?.setSwitch, switchStates: dyn?.states };
}

/**
 * Габарити видимої геометрії моделі: без білбордів (відблиски фар бувають у кілька метрів) і схованих варіантів
 * (рівні деталізації, вмʼятини, гілки перемикачів) — інакше коробка колізії росте й не пролазить у тунелі.
 */
export function visibleBox(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  const walk = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      box.union(tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld));
    }
    for (const c of o.children) walk(c);
  };
  walk(root);
  return box;
}
