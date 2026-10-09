import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { addCollisionPolys, addStaticMeshes, g2t, initRapier } from '../physics/world';
import { Input } from '../input/input';
import { TruckVehicle } from '../game/truckVehicle';
import { buildTruckModel, type TruckDef } from '../game/trucks';
import type { BuiltScene } from '../render/sceneBuilder';
import { walk } from '../formats/b3d';
import type { RmpArchive } from '../formats/rmp';
import { EngineAudio } from '../audio/engineAudio';
import { EVENT_FINISH, Track } from '../game/track';
import { AutoPilot, WayNet } from '../game/autopilot';

type CamMode = 'chase' | 'cockpit' | 'far';

if (import.meta.env.DEV) Object.assign(window, { RAPIER });

/**
 * Режим їзди (Фаза 3): фізичний світ з геометрії локації, вантажівка, камера, HUD.
 */
export class DriveSession {
  private world!: RAPIER.World;
  private truck!: TruckVehicle;
  private readonly input = new Input();
  private touchUi: HTMLElement | null = null;
  private hud!: HTMLElement;
  private acc = 0;
  private camMode: CamMode = 'chase';
  private readonly camPos = new THREE.Vector3();
  private readonly camLook = new THREE.Vector3();
  private spawn!: { position: THREE.Vector3; forward: THREE.Vector3 };
  private cockpit = new THREE.Vector3(-0.4, 2.2, -1.2);
  private audio: EngineAudio | null = null;
  private lastGear = 1;
  private brakeSqueal = 0;
  private track!: Track;
  private room: string | null = null;
  private readonly prevPos = new THREE.Vector3();
  private readonly visited = new Set<string>();
  private lapStart: number | null = null;
  /** Ігровий час, с (накопичується кроками фізики). */
  private clock = 0;
  private lapTime = 0;
  private bestLap: number | null = null;
  private laps = 0;
  /** Сектор, з якого почався відлік кола. */
  private lapRoom: string | null = null;
  /** Автопілот (клавіша P): їде по лініях way_* — для тестів і як основа суперників. */
  autopilot: AutoPilot | null = null;
  private wayNet: WayNet | null = null;

  private constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly built: BuiltScene,
    readonly def: TruckDef,
  ) {}

  static async start(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    built: BuiltScene,
    def: TruckDef,
    overlay: HTMLElement,
    rmp?: RmpArchive,
  ): Promise<DriveSession> {
    await initRapier();
    const s = new DriveSession(scene, camera, built, def);
    s.world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    s.world.timestep = 1 / 60;
    addStaticMeshes(s.world, built.root);
    // Стіни: колізійні полігони блоків 23 у кімнатах (шаблони обʼєктів не враховуємо).
    const walls: number[][][] = [];
    for (const b of built.assembler.b3d.blocks) {
      if (b.data.t !== 19) continue;
      for (const [blk] of walk([b])) if (blk.data.t === 23 && blk.data.shape.kind === 6) walls.push(...blk.data.shape.polys);
    }
    addCollisionPolys(s.world, walls);
    s.world.step(); // колайдери потрапляють у структури запитів (castRay) лише після кроку

    const model = buildTruckModel(built.assembler, def);
    if (!model) throw new Error(`Модель ${def.carNode} відсутня в цій локації`);
    s.track = new Track(built.assembler.b3d);
    s.spawn = s.findSpawn();
    s.room = s.track.guessRoom(s.spawn.position);
    s.prevPos.copy(s.spawn.position);
    s.truck = new TruckVehicle(s.world, def, model, s.spawn);
    scene.add(s.truck.visual);

    const booth = built.assembler.space(def.cockpitSpace);
    if (booth) s.cockpit = g2t(new THREE.Vector3().setFromMatrixPosition(booth)).add(new THREE.Vector3(0, 0.6, 0));

    if (rmp) s.audio = await EngineAudio.create(rmp).catch(() => null);
    s.input.onCommand = (cmd) => {
      if (cmd === 'horn') s.audio?.play('horn');
      if (cmd === 'autopilot') s.toggleAutopilot();
      if (cmd === 'reset') s.truck.reset(s.restartPoint());
      if (cmd === 'camera') s.camMode = s.camMode === 'chase' ? 'cockpit' : s.camMode === 'cockpit' ? 'far' : 'chase';
    };
    s.touchUi = s.input.mountTouch(overlay);
    s.hud = document.createElement('div');
    s.hud.className = 'drive-hud';
    overlay.append(s.hud);
    camera.near = 0.1;
    camera.updateProjectionMatrix();
    s.camPos.copy(s.spawn.position).addScaledVector(s.spawn.forward, -14).add(new THREE.Vector3(0, 6, 0));
    return s;
  }

  /**
   * Точка старту: найближча до простору Observer точка ліній доріг (блоки 20 «way_*»),
   * напрям — уздовж лінії. Висота — променем до поверхні.
   */
  private findSpawn(): { position: THREE.Vector3; forward: THREE.Vector3 } {
    const obs = this.built.assembler.block('Observer');
    let pos = new THREE.Vector3();
    let fwd = new THREE.Vector3(0, 0, -1);
    if (obs && obs.data.t === 24) {
      pos = g2t(obs.data.position);
      fwd = g2t(obs.data.matrix[1]).setY(0).normalize();
    } else {
      new THREE.Box3().setFromObject(this.built.root).getCenter(pos);
    }
    let best = Infinity;
    let bestPos: THREE.Vector3 | null = null;
    let bestDir: THREE.Vector3 | null = null;
    for (const [blk] of walk(this.built.assembler.b3d.blocks)) {
      if (blk.data.t !== 20 || !blk.name.toLowerCase().startsWith('way')) continue;
      const pts = blk.data.points.map((p) => g2t(p));
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = pts[i].distanceTo(pos);
        if (d < best) {
          best = d;
          bestPos = pts[i].clone().lerp(pts[i + 1], 0.5);
          bestDir = pts[i + 1].clone().sub(pts[i]).setY(0).normalize();
        }
      }
    }
    if (bestPos && bestDir) {
      // Напрям лінії обираємо ближчим до погляду Observer.
      if (bestDir.dot(fwd) < 0) bestDir.negate();
      return { position: this.groundAt(bestPos), forward: bestDir };
    }
    return { position: this.groundAt(pos), forward: fwd };
  }

  private groundAt(p: THREE.Vector3): THREE.Vector3 {
    const ray = new RAPIER.Ray({ x: p.x, y: p.y + 200, z: p.z }, { x: 0, y: -1, z: 0 });
    const hit = this.world.castRay(ray, 1000, true);
    const y = hit ? p.y + 200 - hit.timeOfImpact : p.y;
    return new THREE.Vector3(p.x, y + 2.5, p.z);
  }

  /** Рестарт як в оригіналі: точка рестарту поточної кімнати (подія 11), інакше — на місці. */
  private restartPoint() {
    const r = this.room ? this.track.rooms.get(this.room)?.restart : null;
    if (r) return { position: this.groundAt(r.position), forward: r.forward.clone() };
    return this.spawnAtTruck();
  }

  /** Скидання на місці (поставити на колеса). */
  private spawnAtTruck() {
    const t = this.truck.body.translation();
    return { position: this.groundAt(new THREE.Vector3(t.x, t.y, t.z)), forward: this.truck.forward() };
  }

  toggleAutopilot(on = !this.autopilot): void {
    if (on) {
      this.wayNet ??= new WayNet(this.built.assembler.b3d);
      this.autopilot = new AutoPilot(this.wayNet);
    } else this.autopilot = null;
  }

  private controls(dt: number) {
    const manual = this.input.update(dt);
    if (!this.autopilot) return manual;
    const tp = this.truck.body.translation();
    return this.autopilot.update(new THREE.Vector3(tp.x, tp.y, tp.z), this.truck.forward(), this.truck.speedKmh, dt);
  }

  /** Детермінований крок для тестів: n кроків фізики без залежності від requestAnimationFrame. */
  simulate(steps: number): void {
    for (let i = 0; i < steps; i++) {
      const state = this.controls(this.world.timestep);
      this.truck.update(this.world.timestep, state);
      this.world.step();
      this.clock += this.world.timestep;
      this.truck.syncVisual();
      this.updateTrack();
    }
  }

  update(dt: number): void {
    const state = this.controls(dt);
    this.acc += Math.min(dt, 0.1);
    const step = this.world.timestep;
    while (this.acc >= step) {
      this.truck.update(step, state);
      this.world.step();
      this.clock += step;
      this.acc -= step;
    }
    this.truck.syncVisual();
    // Впав зі світу — на точку рестарту.
    if (this.truck.body.translation().y < -200) this.truck.reset(this.restartPoint());
    this.updateTrack();
    this.updateCamera(dt);
    const t = this.truck;
    if (this.audio) {
      this.audio.update(t.rpm, state.throttle);
      if (t.gear !== this.lastGear) {
        this.audio.play('gear', 0.6);
        this.lastGear = t.gear;
      }
      this.brakeSqueal -= dt;
      if (state.brake > 0 && t.gear > 0 && t.speedKmh > 25 && this.brakeSqueal <= 0) {
        this.audio.play('break', 0.5);
        this.brakeSqueal = 3;
      }
    }
    const lap = this.lapStart !== null ? fmtTime(this.clock - this.lapStart) : '—';
    const best = this.bestLap !== null ? `   кращий ${fmtTime(this.bestLap)}` : '';
    this.hud.textContent =
      `${t.speedKmh.toFixed(0)} км/год   ${t.gear < 0 ? 'R' : t.gear}   ${t.rpm.toFixed(0)} об/хв
` +
      `${(this.room ?? '?').replace('room_', 'сектор ')}   коло ${this.laps + 1}: ${lap}${best}`;
  }

  /** Кімнати й коло: перетин порталів, старт таймера, фініш (подія 666). */
  private updateTrack(): void {
    const tp = this.truck.body.translation();
    const cur = new THREE.Vector3(tp.x, tp.y, tp.z);
    if (this.room) {
      const next = this.track.crossPortal(this.room, this.prevPos, cur);
      if (next && this.track.rooms.has(next)) {
        const now = this.clock;
        if (this.lapStart === null) {
          this.lapStart = now;
          this.lapRoom = next;
        }
        this.room = next;
        this.visited.add(next);
        // Коло: фініш (подія 666) або повернення в сектор старту відліку, пройшовши більшість траси.
        const finish = this.track.hasEvent(next, EVENT_FINISH) || next === this.lapRoom;
        if (finish && this.visited.size >= this.track.rooms.size * 0.6) {
          this.lapTime = now - this.lapStart;
          this.bestLap = this.bestLap === null ? this.lapTime : Math.min(this.bestLap, this.lapTime);
          this.laps++;
          this.lapStart = now;
          this.visited.clear();
          this.audio?.play('alarm', 0.6);
        }
      }
    }
    this.prevPos.copy(cur);
  }

  private updateCamera(dt: number): void {
    const v = this.truck.visual;
    const fwd = this.truck.forward();
    const up = new THREE.Vector3(0, 1, 0);
    if (this.camMode === 'cockpit') {
      const eye = this.cockpit.clone().applyQuaternion(v.quaternion).add(v.position);
      this.camera.position.copy(eye);
      this.camera.up.copy(up.clone().applyQuaternion(v.quaternion));
      this.camera.lookAt(eye.clone().add(fwd.clone().multiplyScalar(20)).addScaledVector(up, -1.5));
      this.camera.up.set(0, 1, 0);
      return;
    }
    const dist = this.camMode === 'far' ? 28 : 13;
    const height = this.camMode === 'far' ? 12 : 5;
    const flat = fwd.clone().setY(0).normalize();
    const want = v.position.clone().addScaledVector(flat, -dist).addScaledVector(up, height);
    const k = 1 - Math.exp(-dt * 4);
    this.camPos.lerp(want, k);
    this.camLook.lerp(v.position.clone().addScaledVector(up, 2), 1 - Math.exp(-dt * 10));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camLook);
  }

  dispose(): void {
    this.scene.remove(this.truck.visual);
    this.input.dispose();
    this.touchUi?.remove();
    this.hud?.remove();
    this.audio?.dispose();
    this.world.free();
  }
}

function fmtTime(t: number): string {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
}
