import * as THREE from 'three';
import { kingCar } from './vehicles/controls';
import { TruckVehicle } from './engine/vehicle/truckVehicle';
import { buildTruckModel } from './engine/vehicle/trucks';
import { drivable, truckDef } from './vehicles/trucks';
import { recolor } from './traffic/traffic';
import { FLAG_REVERSE, RemoteTrack, emptyState, packFleet, readFleet, type TruckState } from './net/state';
import type { Ht2Drive } from './drive';

/** Машини інших гравців — лише ближче за це до своєї, м (далі регіонів під ними може не бути, і їх однаково не видно). */
const VIEW_RANGE = 600;

interface NetCar {
  id: number;
  name: string;
  color: number;
  truck: TruckVehicle;
  track: RemoteTrack;
  state: TruckState;
  /** Гравець вийшов; стану ще не було; зараз схована (далеко чи регіон під нею не завантажено). */
  gone: boolean;
  waiting: boolean;
  hidden: boolean;
}

/**
 * Машини інших гравців мережевої кар'єри (М6) у відкритому світі: як машини з мережі в гонці (race.ts) — тіло з
 * масою без тяжіння, яке веде стан із мережі (TruckVehicle.followRemote), лише без решітки й суперників. Показуються
 * ближче VIEW_RANGE і там, де під ними завантажено регіон (світ вантажиться довкола своєї машини); далі — сховані,
 * тіло вимкнене. Своя машина — у пакеті з номером гравця.
 */
export class NetCars {
  readonly cars: NetCar[] = [];
  /** Секунди показу (performance.now / 1000), що йдуть кроками фізики (як RaceMode.simNow). */
  private simNow = -1;
  private readonly sendState = emptyState();

  constructor(
    private readonly drive: Ht2Drive,
    players: readonly { id: number; name: string; truck: string; color: number }[],
    readonly myId: number,
  ) {
    for (const p of players) if (p.id !== myId) this.add(p);
  }

  private add(p: { id: number; name: string; truck: string; color: number }): void {
    const drive = this.drive;
    const rec = drive.trucksData.records.find((r) => r.carNode === p.truck) ?? drivable(drive.trucksData)[0];
    const def = rec && truckDef(drive.trucksData, rec);
    const model = def && buildTruckModel(drive.trucksData.asm, def, false);
    if (!rec || !def || !model) return;
    if (p.color > 0) recolor(model.root, drive.trucksData, p.color + 1);
    const at = drive.truck.visual.position.clone().add(new THREE.Vector3(0, -500, 0));
    const truck = new TruckVehicle(drive.rapierWorld, def, model, { position: at, forward: new THREE.Vector3(0, 0, -1) }, kingCar(rec.suspension));
    truck.makeRemote();
    drive.world.scene.add(truck.visual);
    const car: NetCar = { id: p.id, name: p.name, color: p.color, truck, track: new RemoteTrack(), state: emptyState(), gone: false, waiting: true, hidden: false };
    this.cars.push(car);
    this.hide(car, true);
  }

  private hide(c: NetCar, hidden: boolean): void {
    if (c.hidden === hidden) return;
    c.hidden = hidden;
    c.truck.visual.visible = !hidden;
    c.truck.body.setEnabled(!hidden);
  }

  /** Пакет стану своєї машини (номер гравця); flags — фари, гальмо, задній хід. */
  packet(flags: number): ArrayBuffer {
    const t = this.drive.truck;
    const s = this.sendState;
    const p = t.body.translation();
    const q = t.body.rotation();
    const v = t.body.linvel();
    s.time = performance.now() / 1000;
    s.pos.set(p.x, p.y, p.z);
    s.quat.set(q.x, q.y, q.z, q.w);
    s.vel.set(v.x, v.y, v.z);
    s.steer = t.wheelSteer;
    s.rpm = t.rpm;
    s.flags = flags;
    return packFleet([{ id: this.myId, s }]);
  }

  /** Пакет машин з мережі. */
  pushFleet(data: ArrayBuffer): void {
    const now = performance.now() / 1000;
    readFleet(data, (id, s) => {
      const c = this.cars.find((x) => x.id === id);
      if (!c || c.gone) return;
      c.track.push(s, now);
      c.waiting = false;
    });
  }

  /** Гравці вийшли (which — за номером; без нього — усі). */
  remoteGone(which: (id: number) => boolean = () => true): void {
    for (const c of this.cars) {
      if (c.gone || !which(c.id)) continue;
      c.gone = true;
      this.hide(c, true);
    }
  }

  /** Перед кроком фізики: машини, що видно, — за станом із мережі. */
  control(dt: number): void {
    const real = performance.now() / 1000;
    this.simNow = this.simNow < 0 || Math.abs(real - this.simNow) > 0.25 ? real : this.simNow + dt;
    for (const c of this.cars) {
      if (c.gone || c.waiting || c.hidden) continue;
      const s = c.track.sample(this.simNow, c.state) ?? c.state;
      c.truck.followRemote(dt, s.pos, s.quat, s.steer, s.rpm, s.vel.length() * 3.6, (s.flags & FLAG_REVERSE) !== 0);
    }
  }

  /** Після кроку: що показати (близько й над завантаженим регіоном), моделі між кроками. */
  after(alpha: number): void {
    const me = this.drive.truck.visual.position;
    const world = this.drive.world;
    for (const c of this.cars) {
      if (c.gone || c.waiting) continue;
      // Де машина зараз за мережею (не за тілом: схована стоїть на місці).
      const s = c.track.sample(this.simNow, c.state) ?? c.state;
      const region = world.regionAt(s.pos.x, -s.pos.z);
      this.hide(c, s.pos.distanceTo(me) > VIEW_RANGE || !region || !world.loaded.has(region));
      if (!c.hidden) c.truck.syncVisual(alpha);
    }
  }

  /** Видимі машини гравців (мінікарта: кільце кольору гравця). */
  visible(): { id: number; pos: THREE.Vector3 }[] {
    return this.cars.filter((c) => !c.gone && !c.waiting && !c.hidden).map((c) => ({ id: c.id, pos: c.truck.visual.position }));
  }

  dispose(): void {
    for (const c of this.cars) {
      this.drive.world.scene.remove(c.truck.visual);
      c.truck.dispose();
    }
    this.cars.length = 0;
  }
}
