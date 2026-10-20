import * as THREE from 'three';
import type { ControlState } from '../engine/input/input';
import type { TruckVehicle } from '../engine/vehicle/truckVehicle';
import { HT2_KING } from '../vehicles/controls';
import { carrot, type Mover } from './driver';

/**
 * Керування фізичною машиною трафіку (king.exe: ближче 80 м до гравця машина — `_Car_V` з водієм 0x4d6510).
 * Рішення (смуга, обʼїзд, цільова швидкість) — ті самі, що в кінематичної (`driver.decide`); тут — педалі й кермо:
 * - педалі (0x4d60c0): ціль < 0,1 — гальмо 1; швидше цілі — гальмо min(1; BRAKE_GAIN·Δv) (у king.exe 0,2·Δv —
 *   у порту машина з таким гальмом не встигала скинути швидкість перед поворотом: кермо моделі king обмежене
 *   зчепленням); повільніше 0,9·цілі — газ min(1; 0,2·Δv). Стоячи — ручне гальмо замість педалі (у порту утримання
 *   гальма на місці вмикає задній хід); знесло від смуги далі OFF_LANE — не швидше OFF_LANE_SPEED (порт);
 * - кермо: переслідування точки на шляху за CARROT_MIN + 0,8·v м (з бічним зсувом обʼїзду) — дуга з базою машини,
 *   кут коліс → кермо як в автопілоті гравця (гіпотеза порту: у king.exe — похибка від центру смуги й курсу);
 * - застрягання (0x4d6510): ціль > 3 м/с, а машина стоїть понад 5 с без лідера поруч — 3 с заднього ходу з
 *   протилежним кермом.
 */
const CARROT_MIN = 5;
const BRAKE_GAIN = 0.5;
const OFF_LANE = 1.5;
const OFF_LANE_SPEED = 8;
const STUCK_AFTER = 5;
const REVERSE_FOR = 3;

export interface PhysState {
  ctrl: ControlState;
  stuck: number;
  reverse: number;
  /** Газ = min(1; gas·Δv) і газувати, доки швидкість нижча hold·цілі (king.exe 0,2 і 0,9; бот — сильніше, botDriver). */
  gas: number;
  hold: number;
}

export function newPhysState(): PhysState {
  return { ctrl: { steer: 0, throttle: 0, brake: 0, handbrake: false }, stuck: 0, reverse: 0, gas: 0.2, hold: 0.9 };
}

/** Кут коліс δ → кермо (обернене до δ = 45°·a·|s|^p, HT2_KING; як `Ht2Drive.pilot`). */
export function steerFor(delta: number): number {
  const k = HT2_KING;
  return Math.sign(delta) * (Math.abs(delta) / (Math.PI / 4) / k.steerScale) ** (1 / k.steerPower);
}

/**
 * Педалі й кермо на крок; want — цільова швидкість водія, м/с; blocked — лідер близько (не застрягання); shift — ще
 * зсув точки праворуч від курсу, м (тягач з причепом заходить у поворот ширше, traffic/botDriver.ts).
 */
export function control(m: Mover, v: TruckVehicle, ps: PhysState, want: number, blocked: boolean, dt: number, shift = 0): ControlState {
  const c = ps.ctrl;
  const speed = v.speedKmh / 3.6;
  if (ps.reverse > 0) {
    ps.reverse -= dt;
    c.throttle = 0;
    c.brake = 1;
    c.handbrake = false;
    return c;
  }
  ps.stuck = want > 3 && speed < 1 && !blocked ? ps.stuck + dt : 0;
  if (ps.stuck > STUCK_AFTER) {
    ps.stuck = 0;
    ps.reverse = REVERSE_FOR;
    c.steer = -c.steer;
    return c;
  }

  const bt = v.body.translation();
  const pos = new THREE.Vector3(bt.x, bt.y, bt.z);
  const fwd = v.forward();
  const target = carrot(m, CARROT_MIN + 0.8 * speed);
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  if (shift) target.addScaledVector(right, shift);
  const to = target.sub(pos).setY(0);
  const angle = Math.atan2(to.dot(right), to.dot(fwd));
  const delta = Math.atan((2 * v.base * Math.sin(angle)) / Math.max(4, to.length()));
  c.steer = THREE.MathUtils.clamp(steerFor(delta), -1, 1);

  // Далеко від запланованого зсуву (не маневр, а занесло) — повільно.
  if (Math.abs(m.lat - m.off) > OFF_LANE) want = Math.min(want, OFF_LANE_SPEED);
  const dv = want - speed;
  c.handbrake = false;
  if (want < 0.1) {
    c.throttle = 0;
    // Стоячи — ручне гальмо: утримання педалі на місці вмикає задній хід.
    c.brake = speed < 0.5 ? 0 : 1;
    c.handbrake = speed < 0.5;
  } else if (dv < 0) {
    c.throttle = 0;
    c.brake = Math.min(1, BRAKE_GAIN * -dv);
  } else if (speed < ps.hold * want) {
    c.throttle = Math.min(1, ps.gas * dv);
    c.brake = 0;
  } else {
    c.throttle = 0;
    c.brake = 0;
  }
  return c;
}
