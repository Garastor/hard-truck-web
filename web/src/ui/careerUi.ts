/**
 * Кар'єра на екрані: головне меню, нова гра, база (зали «Завантаження», «Автомобілі», «Запчастини», тунелі),
 * заїзд і повернення з розрахунком. Логіка економіки — game/career.ts.
 *
 * Події бази (MENU3D, блоки 13 у кімнатах): 999/n — секція товару n, 777/n — подіум вантажівки n,
 * 888/n — вітрина запчастини n, 666/10…50 — тунелі на траси. На трасах 666 — фініш (тунель на базу).
 */
import * as THREE from 'three';
import {
  PARTS, TRACKS, TUNNELS, autoLoad, buyPart, buyTruck, canLoad, cargoVolume, cargoWeight, fmt,
  ROAD_REPAIR_TARGET, applyWear, cargoBroken, damageEffects, formatMoney as money, loadGood, recoverCost, repair, repairCost,
  roadRepairStep, saveCareer, settleTrip, truckSetup, truckValue, unloadGood, type Career, type TrackId, type TruckSpec,
} from '../game/career';
import { buildTruckModel, visibleBox, type TruckDef } from '../game/trucks';
import type { TruckSetup } from '../game/truckVehicle';
import type { Room } from '../game/track';
import type { DriveSession } from '../modes/drive';
import type { BuiltScene } from '../render/sceneBuilder';
import { HUD_CYAN, PixelFont, frame, hudScale, inset, panel, pixelCanvas } from './pixelFont';

export type LevelKind = 'laps' | 'route' | 'free';

export interface CareerHost {
  overlay: HTMLElement;
  scene: THREE.Scene;
  defs: () => Promise<TruckDef[]>;
  /** Завантажити локацію й почати їзду заданою вантажівкою. */
  play(level: 'MENU3D' | TrackId, cfg: { truck: number; rivals: TruckDef[]; kind: LevelKind; setup: TruckSetup }): Promise<DriveSession | null>;
  built(): BuiltScene | null;
  /** Вийти з кар'єри в головне меню. */
  exit(): void;
  /** Шрифт табло (MENU.FON); null — системний. */
  font: PixelFont | null;
}

const EV_TUNNEL = 666;
/** Наскільки опущені колеса стоячої вантажівки відносно точки колеса в моделі, м (хід підвіски 0,1…0,4 з TCH — гіпотеза). */
const SHOWROOM_SAG = 0.2;
/**
 * Найдальша допустима точка заду вантажівки на подіумі (система моделі, м від точки подіуму): довші
 * вантажівки зсуваємо вперед, інакше вони виступають задом крізь стіну в задній проїзд.
 */
const SHOWROOM_REAR = -5.3;
const EV_TRUCK = 777;
const EV_PART = 888;
const EV_GOOD = 999;

/** Позначення трас на перемикачах бази (K_<код>_S — світлофор, K_<код>_W — погода). */
const SIGN_CODE: Record<TrackId, string> = { CIRCUIT: 'CIRCT', TRIAL: 'TRIAL', NIGHT: 'NCITY', COUNT: 'COUNT', MOUNT: 'MOUNT' };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Модальне вікно з текстом і кнопками; повертає вибрану кнопку. */
export function modal(overlay: HTMLElement, title: string, body: string | HTMLElement, buttons: string[]): Promise<number> {
  return new Promise((resolve) => {
    const back = el('div', 'career-modal');
    const box = el('div', 'career-box');
    box.append(el('h2', '', title));
    if (typeof body === 'string') box.append(el('p', 'career-text', body));
    else box.append(body);
    const row = el('div', 'career-actions');
    buttons.forEach((b, i) => {
      const btn = el('button', i === 0 ? 'primary' : '', b);
      btn.addEventListener('click', () => {
        back.remove();
        resolve(i);
      });
      row.append(btn);
    });
    box.append(row);
    back.append(box);
    overlay.append(back);
  });
}

export class CareerGame {
  private drive: DriveSession | null = null;
  private level: 'MENU3D' | TrackId = 'MENU3D';
  private panel: HTMLElement;
  private info: HTMLElement;
  private actions: HTMLElement;
  private player: HTMLElement;
  private playerKey = '';
  private keyLoad: (() => void) | null = null;
  private keyUnload: (() => void) | null = null;
  private keyBuy: (() => void) | null = null;
  /** Клавіатура (ПК): + — завантажити, − — повернути, Enter — купити. */
  private readonly onKey = (e: KeyboardEvent) => {
    if ((e.key === '+' || e.key === '=') && this.keyLoad) this.keyLoad();
    else if (e.key === '-' && this.keyUnload) this.keyUnload();
    else if (e.key === 'Enter' && !e.repeat && this.keyBuy) this.keyBuy();
  };
  private timer = 0;
  private showroom: THREE.Object3D[] = [];
  private zoneKey = '';
  private busy = false;
  /** Табло гравця згорнуте до значка (на трасах — за замовчуванням). */
  private playerCollapsed = false;
  /** Удари й пробіг, за які знос уже нараховано (знос рахується під час заїзду). */
  private wornHits = 0;
  private wornDist = 0;
  private damageKey = '';
  private repairSoundAt = 0;

  private constructor(
    private readonly host: CareerHost,
    private readonly c: Career,
    private readonly defs: TruckDef[],
    private readonly specs: TruckSpec[],
  ) {
    this.panel = el('div', 'career-hud');
    this.info = el('div', 'hud-info');
    this.actions = el('div', 'hud-actions');
    this.player = el('div', 'hud-player');
    this.player.setAttribute('role', 'button');
    this.player.setAttribute('aria-label', 'Табло гравця: згорнути / розгорнути');
    this.player.addEventListener('click', () => {
      this.playerCollapsed = !this.playerCollapsed;
      this.renderPlayer();
    });
    this.panel.append(this.info, this.actions, this.player);
    window.addEventListener('keydown', this.onKey);
  }

  static async start(host: CareerHost, c: Career, specs: TruckSpec[]): Promise<CareerGame> {
    const g = new CareerGame(host, c, await host.defs(), specs);
    g.save();
    host.overlay.append(g.panel);
    g.timer = window.setInterval(() => g.refresh(), 250);
    await g.goBase();
    return g;
  }

  dispose(): void {
    clearInterval(this.timer);
    window.removeEventListener('keydown', this.onKey);
    this.clearShowroom();
    this.panel.remove();
  }

  private get spec(): TruckSpec {
    return this.specs.find((s) => s.index === this.c.truck)!;
  }

  private save(): void {
    saveCareer(this.c);
  }

  // --- База ---

  private async goBase(): Promise<void> {
    this.level = 'MENU3D';
    this.drive = await this.host.play('MENU3D', { truck: this.c.truck, rivals: [], kind: 'free', setup: {} });
    if (!this.drive) return;
    this.drive.onRoomEnter = (room) => this.onBaseRoom(room);
    this.drive.applyDents(this.c.dents);
    this.playerCollapsed = false;
    this.setupBase();
    this.zoneKey = '';
    this.refresh();
    if (this.c.report) {
      const text = this.c.report;
      this.c.report = null;
      this.save();
      await modal(this.host.overlay, 'Результати рейсу', text, ['Гаразд']);
    } else if (this.c.trips === 0) {
      await modal(
        this.host.overlay,
        'База',
        'Ви на базі. Зала «Завантаження» — товари, «Автомобілі» — вантажівки, «Запчастини» — покращення. ' +
          'Щоб виїхати на трасу, проїдьте в тунель за вказівником «Выезд»: Кільце й Полігон — гонки, ' +
          'Приморськ, Перелісся, Гірський — доставка вантажу (порожніх завантажать автоматично).',
        ['Гаразд'],
      );
    }
  }

  /** Перемикачі бази: товари в секціях, погода й світлофори тунелів; вантажівки на подіумах. */
  private setupBase(): void {
    const asm = this.host.built()?.assembler;
    if (!asm) return;
    this.c.market.forEach((g, i) => asm.setSwitch(`GOOD_${i}`, g.variant));
    for (const id of Object.keys(SIGN_CODE) as TrackId[]) {
      asm.setSwitch(`K_${SIGN_CODE[id]}_W`, this.c.weather[id] === 'rain' ? 1 : 0);
      asm.setSwitch(`K_${SIGN_CODE[id]}_S`, 3);
    }
    this.placeShowroom();
  }

  /** Подіуми зали «Автомобілі» (space_pod_0…7): усі вантажівки, крім власної, у порядку TRUCK.TCH. */
  private placeShowroom(): void {
    this.clearShowroom();
    const built = this.host.built();
    if (!built) return;
    this.podTrucks().forEach((def, i) => {
      const m = built.assembler.space(`space_pod_${i}`);
      const model = m && buildTruckModel(built.assembler, def);
      if (!m || !model) return;
      const frame = new THREE.Group();
      frame.rotation.x = -Math.PI / 2;
      const holder = new THREE.Group();
      holder.matrixAutoUpdate = false;
      holder.matrix.copy(m);
      // Колеса в моделі — у верхньому положенні підвіски; на подіумі вантажівка стоїть — опускаємо їх.
      for (let w = 0; w < model.wheels.length; w++) {
        model.wheels[w].matrix.copy(model.wheelBase[w]).multiply(new THREE.Matrix4().makeTranslation(0, 0, -SHOWROOM_SAG));
      }
      // Тінь під вантажівкою (*Shadow) — частина моделі на рівні коліс у верхньому положенні; з опущеними
      // колесами вона висіла б над подіумом і затуляла колеса — на подіумі не показуємо.
      model.root.traverse((o) => {
        if (/shadow$/i.test(o.name)) o.visible = false;
      });
      model.root.updateMatrixWorld(true);
      const len = visibleBox(model.root);
      model.root.position.y += Math.max(0, SHOWROOM_REAR - len.min.y);
      holder.add(model.root);
      frame.add(holder);
      // Колеса — на підлогу подіуму (простір space_pod_n задає точку на подіумі, не висоту коліс).
      frame.updateMatrixWorld(true);
      const box = visibleBox(frame);
      const at = new THREE.Vector3().setFromMatrixPosition(holder.matrixWorld);
      // Подіум — видима геометрія (у колізіях його немає): промінь згори вниз від точки трохи вище подіуму.
      const ray = new THREE.Raycaster(new THREE.Vector3(at.x, at.y + 3, at.z), new THREE.Vector3(0, -1, 0), 0, 10);
      const hit = ray.intersectObjects(built.rooms, true)[0];
      const floor = hit ? hit.point.y : this.drive?.floorHeight(new THREE.Vector3(at.x, box.max.y, at.z));
      if (floor !== null && floor !== undefined) frame.position.y += floor - box.min.y;
      this.host.scene.add(frame);
      this.showroom.push(frame);
    });
  }

  private clearShowroom(): void {
    for (const o of this.showroom) this.host.scene.remove(o);
    this.showroom = [];
  }

  private podTrucks(): TruckDef[] {
    return this.defs.filter((d) => d.index !== this.c.truck).slice(0, 8);
  }

  private onBaseRoom(room: Room): void {
    const tunnel = room.events.find((e) => e.type === EV_TUNNEL);
    if (tunnel && TUNNELS[tunnel.param] && !this.busy) void this.goTrack(TUNNELS[tunnel.param]);
    this.refresh();
  }

  // --- Траса ---

  private async goTrack(track: TrackId): Promise<void> {
    this.busy = true;
    try {
      const info = TRACKS[track];
      let note = '';
      if (info.kind === 'commercial' && !this.c.cargo.length) {
        const n = autoLoad(this.c, this.spec);
        if (n) note = `Кузов був порожній — вас завантажили (${n} уп. на ${money(this.cargoValue())}).`;
      }
      this.save();
      this.clearShowroom();
      this.level = track;
      const rivals =
        info.kind === 'trial'
          ? []
          : this.c.drivers
              .filter((d) => d.ai)
              .map((d) => this.defs.find((x) => x.index === d.truck))
              .filter((d): d is TruckDef => !!d);
      const kind: LevelKind = info.kind === 'laps' ? 'laps' : 'route';
      this.drive = await this.host.play(track, { truck: this.c.truck, rivals, kind, setup: truckSetup(this.c, this.spec, track) });
      if (!this.drive) return;
      this.drive.setRain(this.c.weather[track] === 'rain');
      this.drive.showMap(this.c.parts.includes('НС'));
      this.drive.onFinish = () => void this.finishTrip(true);
      this.drive.applyDents(this.c.dents);
      this.playerCollapsed = true;
      this.drive.onDeath = () => void this.fatal();
      this.drive.autoWreck = false;
      this.drive.onResetRequest = () => void this.askRecover();
      const d = this.drive;
      this.drive.hudStatus = () => ({
        truck: this.c.condition.tech,
        cargo: this.c.cargo.length ? 1 - cargoBroken(this.c, d.hits) : null,
        money: this.c.money,
      });
      this.wornHits = this.wornDist = 0;
      this.damageKey = '';
      this.updateDamage();
      this.zoneKey = '';
      this.refresh();
      const weather = this.c.weather[track] === 'rain' ? ' На трасі дощ — слизько, але винагорода більша.' : '';
      const goal =
        info.kind === 'laps'
          ? 'Три кола; призи за перші три місця.'
          : info.kind === 'trial'
            ? 'Проїдьте між прапорцями за стрілками до фінішу.'
            : 'Доставте вантаж до фінішу (тунель у кінці маршруту). Удари бʼють вантаж.';
      toastIn(this.host.overlay, `${info.title}. ${goal}${weather}${note ? ' ' + note : ''}`);
    } finally {
      this.busy = false;
    }
  }

  private async finishTrip(finished: boolean): Promise<void> {
    if (this.busy || this.level === 'MENU3D' || !this.drive) return;
    this.busy = true;
    try {
      const d = this.drive;
      const r = d.result;
      this.updateDamage();
      const res = {
        track: this.level as TrackId,
        finished: finished && !!r,
        place: r?.place ?? 0,
        racers: r?.racers ?? 1,
        time: r?.time ?? 0,
        hits: d.hits,
        distance: d.distance,
        liveWear: true,
      };
      if (finished && r) {
        await modal(this.host.overlay, 'Фініш!', `Місце ${r.place} з ${r.racers}, час ${fmt(r.time)}. Повертаємося на базу.`, ['На базу']);
      }
      settleTrip(this.c, this.specs, res);
      this.save();
      this.busy = false;
      await this.goBase();
    } finally {
      this.busy = false;
    }
  }

  private cargoValue(): number {
    return this.c.cargo.reduce((s, i) => s + i.qty * i.good.price, 0);
  }

  // --- Табло (як в оригіналі): зліва зверху — інформація про товар/вантажівку/запчастину,
  // знизу — «інформація гравця» (гроші, машина, 6 смуг, «За кермом»). Кнопки — для сенсорного екрана. ---

  /** Знос під час заїзду (порціями) і його вплив на машину; вмʼятини — у збереження. */
  private updateDamage(): void {
    const d = this.drive;
    if (!d || this.level === 'MENU3D') return;
    applyWear(this.c, d.hits - this.wornHits, d.distance - this.wornDist);
    this.wornHits = d.hits;
    this.wornDist = d.distance;
    this.c.dents = { ...d.dents };
    // Техстан 0 — машина вибухає; далі — лише на базу (ремонт) чи в меню.
    if (this.c.condition.tech <= 0 && !d.exploded) {
      d.explode();
      window.setTimeout(() => void this.fatal('Машина вибухнула. Її відтягнуть на базу — там можна відремонтуватися.', false), 2500);
      return;
    }
    if (d.exploded) return;
    const fx = damageEffects(this.c);
    const key = `${fx.power}/${fx.lostGears}/${fx.brakes}`;
    if (key !== this.damageKey) {
      this.damageKey = key;
      d.setDamage(fx);
    }
  }

  private needsRoadRepair(): boolean {
    const k = this.c.condition;
    const T = ROAD_REPAIR_TARGET;
    return k.tech < T.tech || k.tires < T.tires || k.brakes < T.brakes;
  }

  /** Перевернулися — «Відновитися» (платно; довідка: «как и в реальной жизни, эта операция достаточно дорогая»). */
  private async askRecover(): Promise<void> {
    if (this.busy || !this.drive || this.level === 'MENU3D') return;
    if (this.drive.exploded) return;
    const cost = recoverCost(this.spec);
    if (this.c.money < cost) return this.fatal(`На відновлення (${money(cost)}) бракує грошей.`);
    const i = await modal(this.host.overlay, 'Відновитися', `Поставити машину на дорогу за ${money(cost)}?`, ['Відновитися', 'Скасувати']);
    if (i !== 0 || !this.drive) return;
    this.c.money -= cost;
    this.drive.recover();
    this.save();
    this.zoneKey = '';
  }

  /** Фатальна ситуація (утонули, впали в прірву) чи нема грошей на відновлення — вибір, як в оригіналі. */
  private async fatal(reason = 'Машину вже не врятувати.', canRestart = true): Promise<void> {
    if (this.busy || !this.drive || this.level === 'MENU3D') return;
    this.busy = true;
    const track = this.level;
    let i: number;
    try {
      const opts = ['Почати заїзд заново', 'На базу', 'Головне меню'];
      i = await modal(this.host.overlay, 'Аварія', reason, canRestart ? opts : opts.slice(1));
      if (!canRestart) i++;
    } finally {
      this.busy = false;
    }
    if (i === 0) return this.goTrack(track);
    if (i === 1) return this.finishTrip(false);
    // Перервати ігровий цикл: рейс не зараховано, гра збережена.
    const d = this.drive;
    this.updateDamage();
    settleTrip(this.c, this.specs, { track, finished: false, place: 0, racers: 1, time: 0, hits: d.hits, distance: d.distance, liveWear: true });
    this.save();
    this.dispose();
    this.host.exit();
  }

  private refresh(): void {
    this.updateDamage();
    this.renderPlayer();
    const room = this.drive?.currentRoom;
    const ev = room?.events.find((e) => e.type === EV_GOOD || e.type === EV_TRUCK || e.type === EV_PART);
    const c = this.c;
    const key =
      this.level === 'MENU3D'
        ? ev
          ? `${ev.type}/${ev.param}/${c.money}/${c.truck}/${c.parts.join()}/${c.cargo.map((i) => i.qty).join()}`
          : `base/${repairCost(c, this.spec)}`
        : `track/${this.level}/${this.drive?.flipped ? 1 : 0}/${this.needsRoadRepair() ? 1 : 0}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    this.info.replaceChildren();
    this.actions.replaceChildren();
    this.keyLoad = this.keyUnload = this.keyBuy = null;
    this.info.hidden = true;
    if (this.level !== 'MENU3D') return this.trackZone();
    if (!ev) return this.baseZone();
    if (ev.type === EV_GOOD) this.goodZone(ev.param);
    else if (ev.type === EV_TRUCK) this.truckZone(ev.param);
    else this.partZone(ev.param);
  }

  /** Текст піксельним шрифтом оригіналу (або системним, якщо MENU.FON недоступний). */
  private text(ctx: CanvasRenderingContext2D, t: string, x: number, y: number, color: string): void {
    if (this.host.font) this.host.font.draw(ctx, t, x, y, color);
    else {
      ctx.fillStyle = color;
      ctx.font = '8px monospace';
      ctx.textBaseline = 'top';
      ctx.fillText(t, x, y);
    }
  }

  private measure(t: string): number {
    return this.host.font ? this.host.font.measure(t) : t.length * 5;
  }

  /** Розбиває текст на рядки не ширші за w пікселів шрифту. */
  private wrap(t: string, w: number): string[] {
    const out: string[] = [];
    let line = '';
    for (const word of t.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (line && this.measure(next) > w) {
        out.push(line);
        line = word;
      } else line = next;
    }
    if (line) out.push(line);
    return out;
  }

  /**
   * Табличка «назва — значення» як в оригіналі (виміряно зі скріншота: підписи з x = 20, значення з x = 130,
   * перший рядок y = 17, крок 15, ширина ≈ 246) + необовʼязкова примітка.
   */
  private table(rows: [string, string][], note?: string): void {
    const left = 20;
    const valueX = Math.max(130, left + Math.max(...rows.map(([k]) => this.measure(k))) + 14);
    const w = Math.max(246, valueX + Math.max(...rows.map(([, v]) => this.measure(v))) + 18);
    const noteLines = note ? this.wrap(note, w - left * 2) : [];
    const h = 17 + rows.length * 15 + 4 + (noteLines.length ? 4 + noteLines.length * 12 : 0);
    const { canvas, ctx } = pixelCanvas(w, h);
    panel(ctx, 0, 0, w, h);
    rows.forEach(([k, v], i) => {
      this.text(ctx, k, left, 17 + i * 15, HUD_CYAN);
      this.text(ctx, v, valueX, 17 + i * 15, HUD_CYAN);
    });
    noteLines.forEach((l, i) => this.text(ctx, l, left, 17 + rows.length * 15 + 2 + i * 12, HUD_CYAN));
    this.info.append(canvas);
    this.info.hidden = false;
  }

  /**
   * Табло гравця як в оригіналі: над рамкою — вантаж; у рамці — «гроші / машина» і шість смуг
   * ($ — вантаж/готівка/вантажівка, маса, обʼєм, машина, шини, гальма); нижче — «За кермом …». Текст бірюзовий.
   */
  private renderPlayer(): void {
    const c = this.c;
    const s = this.spec;
    const cargo = this.cargoValue();
    const truck = Math.max(0, truckValue(c, s));
    const key = [c.money, cargo, truck, cargoWeight(c), cargoVolume(c), c.condition.tech, c.condition.tires, c.condition.brakes, c.parts.join(), window.innerHeight, this.playerCollapsed].join();
    if (key === this.playerKey) return;
    this.playerKey = key;
    const CYAN = HUD_CYAN;
    const RED = '#e00000';
    const MAG = '#e000e0';
    const WHITE = '#f0f0f0';
    if (this.playerCollapsed) {
      // Значок: рамка табло з трьома смугами стану (машина, шини, гальма) — видно знос і згорнутим.
      const { canvas, ctx } = pixelCanvas(30, 22, hudScale() * 1.5);
      frame(ctx, 0, 0, 30, 22);
      inset(ctx, 4, 4, 23, 15);
      [c.condition.tech, c.condition.tires, c.condition.brakes].forEach((f, i) => {
        ctx.fillStyle = RED;
        ctx.fillRect(6, 6 + i * 4, Math.max(1, Math.round(19 * f)), 3);
      });
      this.player.replaceChildren(canvas);
      return;
    }
    // Розмітка виміряна зі скріншота оригіналу: одна рамка на все табло, усередині дві втиснуті панелі
    // (смуги й «За кермом»), підписи смуг — праворуч від панелі; «гроші» лежать на верхній лінії рамки.
    const W = 262;
    const cargoLine = c.cargo.length ? this.wrap(c.cargo.map((i) => i.good.name).join(', '), W)[0] : '';
    const o = (cargoLine ? 11 : 0) + 5;
    const H = o + 114;
    const { canvas, ctx } = pixelCanvas(W, H);
    frame(ctx, 0, o, W, H - o);
    if (cargoLine) this.text(ctx, cargoLine, 2, 0, CYAN);
    const boxX = 10;
    const boxW = 200;
    inset(ctx, boxX, o + 2, boxW, 74);
    this.text(ctx, `гроші ${Math.round(c.money)}`, 10, o - 5, CYAN);
    const truckText = `машина ${Math.round(truck)}`;
    this.text(ctx, truckText, boxX + boxW - 3 - this.measure(truckText), o + 6, CYAN);
    const barX = boxX + 1;
    const barW = boxW - 2;
    const total = Math.max(1, c.money + cargo + truck);
    const rows: [string, [number, string][]][] = [
      ['$', [[cargo / total, MAG], [c.money / total, RED], [truck / total, WHITE]]],
      ['маса', [[Math.min(1, cargoWeight(c) / s.payload), MAG]]],
      ['обʼєм', [[Math.min(1, cargoVolume(c) / s.volume), MAG]]],
      ['машина', [[c.condition.tech, RED]]],
      ['шини', [[c.condition.tires, RED]]],
      ['гальма', [[c.condition.brakes, RED]]],
    ];
    rows.forEach(([label, segs], i) => {
      const y = o + 17 + Math.round(i * 9.6);
      let x = barX;
      for (const [f, color] of segs) {
        const w = Math.round(Math.max(0, Math.min(1, f)) * barW);
        ctx.fillStyle = color;
        ctx.fillRect(x, y, w, 5);
        x += w;
      }
      this.text(ctx, label, boxX + boxW + 4, y - 2, CYAN);
    });
    inset(ctx, boxX, o + 80, boxW, 30);
    this.text(ctx, `За кермом ${c.name}${c.parts.length ? '  ' + c.parts.join(' ') : ''}`, boxX + 6, o + 91, CYAN);
    this.player.replaceChildren(canvas);
  }

  private button(label: string, onClick: () => void, repeat = false): HTMLButtonElement {
    const b = el('button', 'hud-btn');
    b.setAttribute('aria-label', label);
    const { canvas, ctx } = pixelCanvas(this.measure(label), this.host.font?.height ?? 8);
    this.text(ctx, label, 0, 0, HUD_CYAN);
    b.append(canvas);
    if (!repeat) b.addEventListener('click', onClick);
    else {
      // Утримання — повторювати (як утримання клавіші в оригіналі).
      let t = 0;
      const stop = () => clearInterval(t);
      b.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        onClick();
        stop();
        t = window.setInterval(onClick, 130);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel'] as const) b.addEventListener(ev, stop);
    }
    this.actions.append(b);
    return b;
  }

  private baseZone(): void {
    const rc = repairCost(this.c, this.spec);
    if (rc > 0)
      this.button(`РЕМОНТ $${rc}`, () => {
        if (!repair(this.c, this.spec)) return toastIn(this.host.overlay, 'Недостатньо грошей');
        this.save();
        this.zoneKey = '';
        this.refresh();
      });
    this.button('РЕЙТИНГ', () => void this.rating());
    this.button('МЕНЮ', () => void this.quit());
  }

  private trackZone(): void {
    this.button('НА БАЗУ', () => void this.leaveTrack());
    this.button('РЕЙТИНГ', () => void this.rating());
    // Ремонт у дорозі: утримувати кнопку, доки машина не прийде в задовільний стан (лише на місці).
    if (this.needsRoadRepair())
      this.button(
        'РЕМОНТ',
        () => {
          if ((this.drive?.speedKmh ?? 99) > 2) return toastIn(this.host.overlay, 'Ремонт — лише на місці: зупиніться.', 2000);
          if (!roadRepairStep(this.c, this.spec)) return;
          // Звук ремонту — не частіше ніж раз на ~0,8 с (кнопку утримують).
          const now = performance.now();
          if (now - this.repairSoundAt > 800) {
            this.repairSoundAt = now;
            this.drive?.sound('repair', 0.8);
          }
          this.renderPlayer();
          if (!this.needsRoadRepair()) {
            this.save();
            this.zoneKey = '';
            this.refresh();
          }
        },
        true,
      );
    if (this.drive?.flipped) this.button(`ВІДНОВИТИСЯ ${money(recoverCost(this.spec))}`, () => void this.askRecover());
  }

  /** Завантаження/повернення товару: утримання кнопки, як утримання клавіші в оригіналі; з клавіатури — + і −. */
  private goodZone(section: number): void {
    const c = this.c;
    const g = c.market[section];
    if (!g) return;
    const inCargo = c.cargo.find((i) => i.good.section === section)?.qty ?? 0;
    this.table([
      ['КОД', g.name],
      ['ЦІНА ЗА ОД.', `$${g.price}`],
      ['ВАГА', `${g.weight.toFixed(2)}кг`],
      ['ОБʼЄМ', `${g.volume.toFixed(2)}м3`],
      ['КРИХКІСТЬ', `${Math.round(g.fragility * 100)}%`],
      ['У КУЗОВІ', `${inCargo}`],
    ], canLoad(c, this.spec, g) ? undefined : 'Більше не вміщується або бракує грошей');
    const act = (fn: () => number) => () => {
      if (fn()) {
        this.save();
        this.zoneKey = '';
        this.refresh();
      }
    };
    const load = act(() => loadGood(c, this.spec, section, 1));
    const unload = act(() => unloadGood(c, section, 1));
    this.keyLoad = load;
    this.keyUnload = unload;
    this.button('- ПОВЕРНУТИ', unload, true);
    this.button('+ ЗАВАНТАЖИТИ', load, true);
  }

  private truckZone(pod: number): void {
    const def = this.podTrucks()[pod];
    if (!def) return;
    const s = this.specs.find((x) => x.index === def.index)!;
    const diff = s.price - truckValue(this.c, this.spec);
    this.table([
      ['КОД', s.name.toUpperCase()],
      ['ЦІНА', `$${s.price}`],
      ['ПОТУЖНІСТЬ', `${s.horsePower.toFixed(2)}к.с.`],
      ['ВАНТАЖОПІДЙОМНІСТЬ', `${(s.payload / 1000).toFixed(2)}т`],
      ['КУЗОВ', `${s.volume.toFixed(1)}м3`],
      ['ДОПЛАТА', `$${Math.max(0, Math.round(diff))}`],
    ]);
    const buy = () => {
      const r = buyTruck(this.c, this.specs, def.index);
      if (r !== 'ok') return toastIn(this.host.overlay, r === 'money' ? 'Недостатньо грошей' : 'Вантаж не поміститься — спершу розвантажтесь');
      this.save();
      // Нова вантажівка: перезапуск бази на ній (стара стає на подіум).
      void this.goBase();
    };
    this.keyBuy = buy;
    this.button('КУПИТИ', buy);
  }

  private partZone(i: number): void {
    const p = PARTS[i];
    if (!p) return;
    const have = this.c.parts.includes(p.code) && p.code !== 'ШН';
    this.table(
      [
        ['КОД', p.code],
        ['ЦІНА', `$${p.price}`],
      ],
      `${p.title}: ${p.hint}.${have ? ' Встановлено.' : ''}`,
    );
    if (have) return;
    const buy = () => {
      const r = buyPart(this.c, i);
      if (r !== 'ok') return toastIn(this.host.overlay, r === 'money' ? 'Недостатньо грошей' : 'Вже встановлено');
      this.save();
      this.zoneKey = '';
      this.refresh();
      toastIn(this.host.overlay, `Встановлено: ${p.title}`);
    };
    this.keyBuy = buy;
    this.button('КУПИТИ', buy);
  }

  private async leaveTrack(): Promise<void> {
    if (this.drive?.result) return this.finishTrip(true);
    const i = await modal(this.host.overlay, 'Повернутися на базу?', 'Заїзд не завершено: приз не нараховується, вантаж повернеться на базу.', ['На базу', 'Залишитися']);
    if (i === 0) await this.finishTrip(false);
  }

  private async rating(): Promise<void> {
    const table = el('table', 'career-table');
    const head = el('tr');
    for (const h of ['Водій', 'Машина', 'Капітал', 'Час']) head.append(el('th', '', h));
    table.append(head);
    const rows = [...this.c.drivers].sort((a, b) => b.money - a.money);
    for (const d of rows) {
      const tr = el('tr', d.ai ? '' : 'me');
      const truck = this.specs.find((s) => s.index === d.truck)?.name ?? '?';
      for (const v of [`${d.name}${d.ai ? ' *' : ''}`, truck, money(d.money), d.lastTime ? fmt(d.lastTime) : '—']) tr.append(el('td', '', v));
      table.append(tr);
    }
    await modal(this.host.overlay, 'Рейтинг', table, ['Закрити']);
  }

  /** Вийти з кар'єри без діалогу (перемикач «Кар'єра / Тест» у меню порту): зберегти й прибрати табло. */
  leave(): void {
    this.save();
    this.dispose();
  }

  private async quit(): Promise<void> {
    const i = await modal(this.host.overlay, 'Вийти в меню?', 'Прогрес збережено.', ['Вийти', 'Залишитися']);
    if (i !== 0) return;
    this.save();
    this.dispose();
    this.host.exit();
  }
}

/** Коротке повідомлення поверх гри. */
export function toastIn(overlay: HTMLElement, text: string, ms = 4500): void {
  const t = el('div', 'career-toast', text);
  overlay.append(t);
  setTimeout(() => t.remove(), ms);
}
