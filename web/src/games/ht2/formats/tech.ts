import { BinReader } from '../engine/formats/binary';

/**
 * Параметри техніки Дальнобойщиків 2 (`vehicle.tech`) — бінарний відповідник `TRUCK.TCH` першої гри:
 * заголовок (імʼя «.\truck2.tch», розмір запису, кількість, межі груп), далі записи по 2416 байтів —
 * легковики, вантажівки (lorries), тягачі (tractors), напівпричепи (trailers).
 *
 * Розкладка — за `hard_truck_2_tech.ksy` (reRNR/RNRFileFormats, MIT) і `TechToTCH.1sc` (AlexKimov, MIT);
 * звірено з файлом: Zil (тягач) збігається з [TECH1] HT1 (маса 4100, 185 к.с., $18000, передачі 7,44…1,0).
 * Перетворення одиниць (як у TechToTCH): оберти — ×60 (у файлі — за секунду), кути — радіани → градуси.
 * Поля `unk*` не розібрано.
 */
export type Vec3 = [number, number, number];

export interface TechRecord {
  index: number;
  /** Група за файлом-джерелом: cars | lorries | tractors | trailers. */
  group: string;
  /** Внутрішнє імʼя (vch, напр. «ZIL»), назва, префікс вузлів моделі («Zil»), префікс кабіни, вузол моделі. */
  vch: string;
  name: string;
  prefix: string;
  prefixCab: string;
  carNode: string;
  cockpitSpace: string;
  centerMass: Vec3;
  mass: number;
  wheelRadius: number;
  wheelRadius1: number;
  tank: number;
  fuelTimeEndurance: number;
  /** Кількість передач уперед (масив у файлі довший — далі заповнювач). */
  gears: number[];
  fuelConsumption: number;
  kilometrage: number;
  airPressCoeff: number;
  airResistCoeff: number;
  airSideResistCoeff: number;
  frontWheelThickness: number;
  rearWheelThickness: number;
  maxRotMomentum: number;
  brakePower: number;
  rearAxleCoeff: number;
  reverseCoeff: number;
  /** Оберти найбільшої потужності, об/хв. */
  tachMaxPower: number;
  cargoLoad: number;
  bodyMass: number;
  bodyHeight: number;
  bodySquare: number;
  cargoBottom: Vec3;
  drivingWheels: number[];
  steeringWheels: number[];
  touchingWheels: number[];
  viewer: Vec3;
  /** Нахил погляду, градуси. */
  viewerTilt: number;
  inertia: Vec3;
  /** rs0…rs3 (+0x1a8): точки коліс у системі моделі; у ZilR — запасні (±0,6; ±1; −0,2), king.exe бере з них точки пари. */
  wheelPoints: Vec3[];
  suspension: number[];
  ks: number[];
  cs: number[];
  collisionRadius: number;
  collisionCenter: Vec3;
  rubberCollisionCoeff: number;
  slideCollisionCoeff: number;
  cornerMarks: Vec3[];
  addCollisionPoints: Vec3[];
  cornerMarksW: Vec3[];
  collisionPlanes: [number, number, number, number][];
  tvCameras: Vec3[];
  smokePosition: Vec3;
  smokeDirection: Vec3;
  /** Друга труба вихлопу (SmokePosition2/SmokeDirection2; немає — (0, 0, 20)). */
  smokePosition2: Vec3;
  smokeDirection2: Vec3;
  flamePlace: Vec3;
  faraFL: Vec3;
  faraFR: Vec3;
  faraBL: Vec3;
  faraBR: Vec3;
  faraBLs: Vec3;
  faraBRs: Vec3;
  horsePower: number;
  price: number;
  lowSaddle: Vec3;
  topSaddle: Vec3;
  towHook: Vec3;
  coupler: Vec3;
  shiftSaddle: number;
  couplerLength: number;
  /** Тип причепа (0 — не причіп; 1 — модуль, 2 — платформа, 3 — цистерна — за іменами). */
  trailerType: number;
  /**
   * Шкали приладів кабіни: [кінець шкали, кут стрілки, градуси]. Спідометр — км/год (у файлі м/с), тахометр — в
   * одиницях TCH (у файлі × 5/3, як у TechToTCH; ЗіЛ: 40 — як 50 у TRUCK.TCH першої гри, об/с).
   */
  speedScale: [number, number];
  tachScale: [number, number];
}

export interface Tech {
  records: TechRecord[];
}

export const TECH_RECORD_SIZE = 2416;
const RAD = 180 / Math.PI;

export function parseTech(bytes: Uint8Array): Tech {
  const r = new BinReader(bytes);
  r.skip(r.u32()); // «.\truck2.tch»
  r.u32(); // мітка часу
  const recSize = r.u32();
  const count = r.u32();
  if (recSize !== TECH_RECORD_SIZE) throw new Error(`TECH: розмір запису ${recSize}`);
  r.skip(28); // межі груп (зсуви індексів)
  const base = r.pos;
  const records: TechRecord[] = [];
  for (let i = 0; i < count; i++) records.push(readRecord(new BinReader(bytes, base + i * recSize), i));
  return { records };
}

function readRecord(r: BinReader, index: number): TechRecord {
  const v3 = (): Vec3 => [r.f32(), r.f32(), r.f32()];
  const f = (n: number) => Array.from(r.f32s(n));
  const u = (n: number) => Array.from({ length: n }, () => r.u32());
  const vs = (n: number) => Array.from({ length: n }, v3);
  const s = (n: number) => r.fixedStr(n).trim();

  r.skip(36);
  const centerMass = v3();
  r.skip(48);
  const mass = r.f32();
  const wheelRadius = r.f32();
  const wheelRadius1 = r.f32();
  const tank = r.f32();
  const fuelTimeEndurance = r.f32();
  r.skip(36);
  // Передач уперед, без нейтралі (+0x98; поле на 8 Б раніше, +0x90, — разом з нейтраллю). Телеметрія king.exe:
  // ZilR (6) вмикає шосту — 0,714 — на 112 км/год.
  const gearCount = r.u32();
  r.skip(4);
  const fuelConsumption = r.f32();
  r.skip(4);
  const kilometrage = r.f32();
  const airPressCoeff = r.f32();
  const airResistCoeff = r.f32();
  const airSideResistCoeff = r.f32();
  const frontWheelThickness = r.f32();
  const rearWheelThickness = r.f32();
  const maxRotMomentum = r.f32();
  r.skip(4);
  const brakePower = r.f32();
  const rearAxleCoeff = r.f32();
  const reverseCoeff = r.f32();
  const allGears = f(14); // [0] — нейтраль
  const gears = allGears.slice(1, 1 + gearCount);
  const tachMaxPower = r.f32() * 60;
  const cargoLoad = r.f32();
  const bodyMass = r.f32();
  const bodyHeight = r.f32();
  const bodySquare = r.f32();
  const cargoBottom = v3();
  const drivingWheels = u(8);
  const steeringWheels = u(8);
  const touchingWheels = u(8);
  const viewer = v3();
  const viewerTilt = r.f32() * RAD;
  const inertia = v3();
  const wheelPoints = vs(4); // rs0..rs3
  r.skip(244);
  r.skip(32); // buffer
  const suspension = f(8);
  const ks = f(8);
  const cs = f(8);
  const collisionRadius = r.f32();
  const collisionCenter = v3();
  r.skip(4);
  const rubberCollisionCoeff = r.f32();
  const slideCollisionCoeff = r.f32();
  const nCorner = r.u32();
  const nAdd = r.u32();
  const cornerMarks = vs(20).slice(0, nCorner);
  const addCollisionPoints = vs(20).slice(0, nAdd);
  r.skip(36);
  const nCornerW = r.u32();
  const cornerMarksW = vs(4).slice(0, nCornerW);
  const planes = Array.from({ length: 20 }, () => [r.f32(), r.f32(), r.f32(), r.f32()] as [number, number, number, number]);
  const nPlanes = r.u32();
  r.skip(8);
  const cams = vs(5);
  const nCams = r.u32();
  r.skip(12); // tvCameraRightConer
  const smokePosition = v3();
  const smokeDirection = v3();
  const smokePosition2 = v3();
  const smokeDirection2 = v3();
  const flamePlace = v3();
  const faraFL = v3();
  const faraFR = v3();
  const faraBLs = v3();
  const faraBRs = v3();
  const faraBL = v3();
  const faraBR = v3();
  const horsePower = r.u32();
  const price = r.u32();
  r.skip(4); // glowwing
  const lowSaddle = v3();
  const topSaddle = v3();
  const towHook = v3();
  const coupler = v3();
  const shiftSaddle = r.f32();
  const couplerLength = r.f32();
  const speedScale: [number, number] = [r.f32() * 3.6, r.f32() * RAD];
  const tachScale: [number, number] = [r.f32() / (5 / 3), r.f32() * RAD];
  r.skip(4); // FuelScale
  r.skip(24 + 16 + 28 + 8); // вікна кабіни, шия водія, ?
  const cockpitSpace = s(60);
  const tch = s(30).replace(/^\.\\/, '').replace(/\.tch$/i, '');
  const vch = s(30);
  const name = s(30);
  const prefix = s(20);
  const prefixCab = s(20);
  const carNode = s(30);
  r.skip(4);
  const trailerType = r.u32();
  return {
    index, group: tch, vch, name, prefix, prefixCab, carNode, cockpitSpace, centerMass, mass, wheelRadius, wheelRadius1,
    tank, fuelTimeEndurance, gears, fuelConsumption, kilometrage, airPressCoeff, airResistCoeff, airSideResistCoeff,
    frontWheelThickness, rearWheelThickness, maxRotMomentum, brakePower, rearAxleCoeff, reverseCoeff, tachMaxPower,
    cargoLoad, bodyMass, bodyHeight, bodySquare, cargoBottom, drivingWheels, steeringWheels, touchingWheels, viewer,
    viewerTilt, inertia, wheelPoints, suspension, ks, cs, collisionRadius, collisionCenter, rubberCollisionCoeff,
    slideCollisionCoeff, cornerMarks, addCollisionPoints, cornerMarksW, collisionPlanes: planes.slice(0, nPlanes),
    tvCameras: cams.slice(0, nCams), smokePosition, smokeDirection, smokePosition2, smokeDirection2, flamePlace, faraFL, faraFR, faraBL, faraBR,
    faraBLs, faraBRs, horsePower, price, lowSaddle, topSaddle, towHook, coupler, shiftSaddle, couplerLength,
    trailerType, speedScale, tachScale,
  };
}
