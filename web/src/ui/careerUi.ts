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
  formatMoney as money, loadGood, repair, repairCost, saveCareer, settleTrip, truckSetup,
  truckValue, unloadGood, type Career, type TrackId, type TruckSpec,
} from '../game/career';
import { buildTruckModel, type TruckDef } from '../game/trucks';
import type { TruckSetup } from '../game/truckVehicle';
import type { Room } from '../game/track';
import type { DriveSession } from '../modes/drive';
import type { BuiltScene } from '../render/sceneBuilder';

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
}

const EV_TUNNEL = 666;
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
      holder.add(model.root);
      frame.add(holder);
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
      const asm = this.host.built()?.assembler;
      asm?.setSwitch('RainKey', this.c.weather[track] === 'rain' ? 1 : 0);
      this.drive.onFinish = () => void this.finishTrip(true);
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
      const res = {
        track: this.level as TrackId,
        finished: finished && !!r,
        place: r?.place ?? 0,
        racers: r?.racers ?? 1,
        time: r?.time ?? 0,
        hits: d.hits,
        distance: d.distance,
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

  private refresh(): void {
    this.renderPlayer();
    const room = this.drive?.currentRoom;
    const ev = room?.events.find((e) => e.type === EV_GOOD || e.type === EV_TRUCK || e.type === EV_PART);
    const c = this.c;
    const key =
      this.level === 'MENU3D'
        ? ev
          ? `${ev.type}/${ev.param}/${c.money}/${c.truck}/${c.parts.join()}/${c.cargo.map((i) => i.qty).join()}`
          : `base/${repairCost(c, this.spec)}`
        : `track/${this.level}`;
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

  /** Табличка «назва — значення» (КОД, ЦІНА ЗА ОД., ВАГА…). */
  private table(rows: [string, string][]): void {
    const t = el('table');
    for (const [k, v] of rows) {
      const tr = el('tr');
      tr.append(el('td', '', k), el('td', '', v));
      t.append(tr);
    }
    this.info.append(t);
    this.info.hidden = false;
  }

  /** Табло гравця: «гроші / машина», смуги $, маса, обʼєм, машина, шини, гальма; «За кермом». */
  private renderPlayer(): void {
    const c = this.c;
    const s = this.spec;
    const cargo = this.cargoValue();
    const truck = Math.max(0, truckValue(c, s));
    const total = Math.max(1, c.money + cargo + truck);
    const pct = (v: number) => `${Math.max(0, Math.min(100, v * 100)).toFixed(1)}%`;
    const key = [c.money, cargo, truck, cargoWeight(c), cargoVolume(c), c.condition.tech, c.condition.tires, c.condition.brakes, c.parts.join()].join();
    if (key === this.playerKey) return;
    this.playerKey = key;
    const p = this.player;
    p.replaceChildren();
    if (c.cargo.length) p.append(el('div', 'hud-cargo', c.cargo.map((i) => i.good.name).join(', ')));
    const head = el('div', 'hud-head');
    head.append(el('span', '', `гроші ${Math.round(c.money)}`), el('span', '', `машина ${Math.round(truck)}`));
    p.append(head);
    const bars = el('div', 'hud-bars');
    const bar = (label: string, segs: [number, string][]) => {
      const row = el('div', 'hud-row');
      const track = el('div', 'hud-track');
      for (const [f, color] of segs) {
        const seg = el('i');
        seg.style.width = pct(f);
        seg.style.background = color;
        track.append(seg);
      }
      row.append(track, el('span', '', label));
      bars.append(row);
    };
    const RED = '#e01010';
    const MAG = '#e020e0';
    const WHITE = '#f4f4f4';
    // $: вантаж (пурпуровий) | готівка (червоний) | вантажівка (білий) — частки капіталу.
    bar('$', [
      [cargo / total, MAG],
      [c.money / total, RED],
      [truck / total, WHITE],
    ]);
    const w = Math.min(1, cargoWeight(c) / s.payload);
    const v = Math.min(1, cargoVolume(c) / s.volume);
    bar('маса', [
      [w, MAG],
      [1 - w, RED],
    ]);
    bar('обʼєм', [
      [v, MAG],
      [1 - v, RED],
    ]);
    bar('машина', [[c.condition.tech, RED]]);
    bar('шини', [[c.condition.tires, RED]]);
    bar('гальма', [[c.condition.brakes, RED]]);
    p.append(bars);
    p.append(el('div', 'hud-foot', `За кермом ${c.name}${c.parts.length ? '   ' + c.parts.join(' ') : ''}`));
  }

  private button(label: string, onClick: () => void, repeat = false): HTMLButtonElement {
    const b = el('button', 'hud-btn', label);
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
    ]);
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
    this.button('− ПОВЕРНУТИ', unload, true);
    this.button('+ ЗАВАНТАЖИТИ', load, true);
    if (!canLoad(c, this.spec, g)) this.info.append(el('div', 'hud-note', 'Більше не вміщується або бракує грошей'));
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
    this.table([
      ['КОД', p.code],
      ['ЦІНА', `$${p.price}`],
    ]);
    this.info.append(el('div', 'hud-note', `${p.title}: ${p.hint}.${have ? ' Встановлено.' : ''}`));
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
