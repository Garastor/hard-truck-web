/**
 * Стан машини в мережі: кожен телефон рахує свою вантажівку сам і шле її стан 30 разів на секунду каналом `fast`
 * (без повторів — запізнілий пакет не потрібен). Машину друга малюємо за цими пакетами із запізненням INTERP_DELAY:
 * між двома відомими станами — плавно (позиція — кубічно за швидкостями, поворот — slerp), якщо пакети не встигли —
 * трохи вперед за швидкістю.
 */
import * as THREE from 'three';

/** Частота надсилання стану, Гц. */
export const STATE_RATE = 30;
/** Запізнення показу машини друга, с: ≈ 3 пакети — один-два загублені не помітні. */
const INTERP_DELAY = 0.1;
/** Найдовше передбачення за швидкістю, коли пакети не приходять, с. */
const MAX_EXTRAPOLATE = 0.3;
/** Стільки останніх пакетів для оцінки різниці годинників. */
const OFFSET_WINDOW = 90;
const BUFFER = 32;

export const FLAG_LIGHTS = 1;
export const FLAG_BRAKE = 2;
export const FLAG_REVERSE = 4;

export interface TruckState {
  /** Час відправника, с (його performance.now). */
  time: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;
  /** Кут керованих коліс, рад (+ — уліво). */
  steer: number;
  rpm: number;
  flags: number;
}

/** Пакет: тип (1 байт), час (float64), 13 чисел float32, прапорці (1 байт) — 62 байти. */
const KIND_STATE = 1;
const SIZE = 1 + 8 + 13 * 4 + 1;

export function packState(s: TruckState): ArrayBuffer {
  const buf = new ArrayBuffer(SIZE);
  const v = new DataView(buf);
  v.setUint8(0, KIND_STATE);
  v.setFloat64(1, s.time, true);
  const f = [s.pos.x, s.pos.y, s.pos.z, s.quat.x, s.quat.y, s.quat.z, s.quat.w, s.vel.x, s.vel.y, s.vel.z, s.steer, s.rpm, 0];
  f.forEach((x, i) => v.setFloat32(9 + i * 4, x, true));
  v.setUint8(SIZE - 1, s.flags);
  return buf;
}

export function unpackState(buf: ArrayBuffer): TruckState | null {
  if (buf.byteLength !== SIZE) return null;
  const v = new DataView(buf);
  if (v.getUint8(0) !== KIND_STATE) return null;
  const f = (i: number) => v.getFloat32(9 + i * 4, true);
  const s: TruckState = {
    time: v.getFloat64(1, true),
    pos: new THREE.Vector3(f(0), f(1), f(2)),
    quat: new THREE.Quaternion(f(3), f(4), f(5), f(6)).normalize(),
    vel: new THREE.Vector3(f(7), f(8), f(9)),
    steer: f(10),
    rpm: f(11),
    flags: v.getUint8(SIZE - 1),
  };
  return [s.time, s.pos.x, s.pos.y, s.pos.z, s.quat.w, s.vel.x, s.steer, s.rpm].every(Number.isFinite) ? s : null;
}

/**
 * Пакет кількох машин (своя; у господаря — ще й суперники з автопілотом): тип 2 (1 байт), кількість (1), час
 * відправника (float64), далі для кожної — номер (1 байт), 12 чисел float32 (позиція, поворот, швидкість, кут коліс,
 * оберти) і прапорці (1 байт) — 50 байтів на машину. Номери: 0, 1… — гравці (місце на старті), від FIRST_RIVAL —
 * суперники господаря.
 */
const KIND_FLEET = 2;
const CAR = 1 + 12 * 4 + 1;
export const FIRST_RIVAL = 16;

export function packFleet(time: number, cars: { id: number; s: TruckState }[]): ArrayBuffer {
  const buf = new ArrayBuffer(10 + cars.length * CAR);
  const v = new DataView(buf);
  v.setUint8(0, KIND_FLEET);
  v.setUint8(1, cars.length);
  v.setFloat64(2, time, true);
  for (let k = 0; k < cars.length; k++) {
    const { id, s } = cars[k];
    const at = 10 + k * CAR;
    v.setUint8(at, id);
    const f = (i: number, x: number) => v.setFloat32(at + 1 + i * 4, x, true);
    f(0, s.pos.x);
    f(1, s.pos.y);
    f(2, s.pos.z);
    f(3, s.quat.x);
    f(4, s.quat.y);
    f(5, s.quat.z);
    f(6, s.quat.w);
    f(7, s.vel.x);
    f(8, s.vel.y);
    f(9, s.vel.z);
    f(10, s.steer);
    f(11, s.rpm);
    v.setUint8(at + CAR - 1, s.flags);
  }
  return buf;
}

/** Стан для розбору пакетів — один на всі (одержувач копіює, RemoteTrack.push): без нових об'єктів на кожен пакет. */
const READ = emptyState();

/**
 * Розбір пакета машин: для кожної — each(номер, стан); стан — спільний буфер, дійсний лише під час виклику.
 * Повертає false, якщо пакет не такий.
 */
export function readFleet(buf: ArrayBuffer, each: (id: number, s: TruckState) => void): boolean {
  if (buf.byteLength < 10) return false;
  const v = new DataView(buf);
  const n = v.getUint8(1);
  if (v.getUint8(0) !== KIND_FLEET || buf.byteLength !== 10 + n * CAR) return false;
  const time = v.getFloat64(2, true);
  if (!Number.isFinite(time)) return false;
  const s = READ;
  for (let k = 0; k < n; k++) {
    const at = 10 + k * CAR;
    const f = (i: number) => v.getFloat32(at + 1 + i * 4, true);
    s.time = time;
    s.pos.set(f(0), f(1), f(2));
    s.quat.set(f(3), f(4), f(5), f(6)).normalize();
    s.vel.set(f(7), f(8), f(9));
    s.steer = f(10);
    s.rpm = f(11);
    s.flags = v.getUint8(at + CAR - 1);
    if (Number.isFinite(s.pos.x + s.pos.y + s.pos.z + s.quat.w + s.vel.x + s.vel.y + s.vel.z + s.steer + s.rpm)) each(v.getUint8(at), s);
  }
  return true;
}

/** Розбір пакета машин у нові об'єкти (для тестів і налагодження). */
export function unpackFleet(buf: ArrayBuffer): { id: number; s: TruckState }[] | null {
  const out: { id: number; s: TruckState }[] = [];
  const ok = readFleet(buf, (id, s) => {
    const c = emptyState();
    copy(c, s);
    out.push({ id, s: c });
  });
  return ok ? out : null;
}

/** Показ машини друга за пакетами (місцевий час — секунди, performance.now / 1000). */
export class RemoteTrack {
  /** Останні стани (об'єкти повторно використовуються: найстаріший стає новим). */
  private readonly states: TruckState[] = [];
  /** Кільце різниць годинників за останні OFFSET_WINDOW пакетів. */
  private readonly offsets = new Float64Array(OFFSET_WINDOW);
  private offsetCount = 0;
  private offsetAt = 0;
  /** Місцевий час мінус час відправника (найменший за вікно — найшвидший шлях пакета). */
  private offset: number | null = null;
  /** Місцевий час останнього пакета. */
  lastHeard = -Infinity;

  push(s: TruckState, localNow: number): void {
    const last = this.states[this.states.length - 1];
    if (last && s.time <= last.time) return; // запізнілий чи повтор
    const slot = this.states.length >= BUFFER ? this.states.shift()! : emptyState();
    copy(slot, s);
    this.states.push(slot);
    this.offsets[this.offsetAt] = localNow - s.time;
    this.offsetAt = (this.offsetAt + 1) % OFFSET_WINDOW;
    this.offsetCount = Math.min(OFFSET_WINDOW, this.offsetCount + 1);
    let min = Infinity;
    for (let i = 0; i < this.offsetCount; i++) min = Math.min(min, this.offsets[i]);
    this.offset = min;
    this.lastHeard = localNow;
  }

  /** Стан на місцевий час localNow (null — пакетів ще не було). */
  sample(localNow: number, out: TruckState): TruckState | null {
    const n = this.states.length;
    if (!n || this.offset === null) return null;
    const t = localNow - this.offset - INTERP_DELAY;
    let i = n - 1;
    while (i > 0 && this.states[i - 1].time > t) i--;
    const b = this.states[i];
    const a = i > 0 ? this.states[i - 1] : null;
    if (!a || t >= b.time) {
      // Новіших пакетів немає — трохи вперед за швидкістю (не далі за MAX_EXTRAPOLATE).
      const dt = Math.min(Math.max(0, t - b.time), MAX_EXTRAPOLATE);
      copy(out, b);
      out.pos.addScaledVector(b.vel, dt);
      out.time = t;
      return out;
    }
    const span = b.time - a.time;
    const u = span > 1e-4 ? (t - a.time) / span : 1;
    hermite(out.pos, a.pos, a.vel, b.pos, b.vel, span, u);
    out.quat.slerpQuaternions(a.quat, b.quat, u);
    out.vel.lerpVectors(a.vel, b.vel, u);
    out.steer = a.steer + (b.steer - a.steer) * u;
    out.rpm = a.rpm + (b.rpm - a.rpm) * u;
    out.flags = u < 0.5 ? a.flags : b.flags;
    out.time = t;
    return out;
  }
}

export function emptyState(): TruckState {
  return { time: 0, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), vel: new THREE.Vector3(), steer: 0, rpm: 0, flags: 0 };
}

function copy(out: TruckState, s: TruckState): void {
  out.time = s.time;
  out.pos.copy(s.pos);
  out.quat.copy(s.quat);
  out.vel.copy(s.vel);
  out.steer = s.steer;
  out.rpm = s.rpm;
  out.flags = s.flags;
}

/** Кубічна крива Ерміта між p0 і p1 зі швидкостями v0, v1 (м/с) на відрізку span секунд, u — 0…1. */
function hermite(out: THREE.Vector3, p0: THREE.Vector3, v0: THREE.Vector3, p1: THREE.Vector3, v1: THREE.Vector3, span: number, u: number): void {
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  out.set(
    h00 * p0.x + h10 * span * v0.x + h01 * p1.x + h11 * span * v1.x,
    h00 * p0.y + h10 * span * v0.y + h01 * p1.y + h11 * span * v1.y,
    h00 * p0.z + h10 * span * v0.z + h01 * p1.z + h11 * span * v1.z,
  );
}
