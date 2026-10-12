import * as THREE from 'three';
import { modal } from '../../ui/careerUi';
import { isList, str, type SExpr } from '../../formats/sexpr';
import { findStores, makeOrders, parseGoods, type Goods, type Store } from './economy';
import { FUEL_PRICE, REPAIR_PER_PERCENT, TIME_SCALE, formatClock, formatMoney, saveCareer, settle, type Ht2Career } from './career';
import { toThree } from './world';
import { install, type Upgrade } from './upgrades';
import type { Ht2Drive } from './drive';

/**
 * Кар'єра в режимі їзди HT2: склади (замовлення й здача вантажу), СТО (ремонт), удари (пошкодження машини й
 * вантажу), табло (гроші, вантаж, куди й скільки лишилось часу, годинник), збереження раз на 10 с.
 * Вікна зʼявляються, коли вантажівка зупинилась біля місця завантаження складу чи біля СТО.
 */
const DOCK_RADIUS = 22;
const STO_RADIUS = 18;
const FUEL_RADIUS = 14;
/** Удар: зміна швидкості за крок, м/с — від неї пошкодження (гіпотеза, як у першій грі). */
const HIT_MIN = 1.5;

export class CareerMode {
  readonly stores: Store[];
  private readonly goods: Goods[];
  private readonly sto: [number, number, number][] = [];
  private readonly fuelSpots: [number, number, number][] = [];
  private readonly lastPos = new THREE.Vector3();
  private busy = false;
  /** Біля якого місця вже показано вікно (повторно — лише після відʼїзду). */
  private shownAt: string | null = null;
  private saveTimer = 0;
  private readonly prevVel = new THREE.Vector3();

  /** Повідомлення гри (Ms.sch): ключ → текст з %g / %d. */
  private readonly messages = new Map<string, string>();

  constructor(
    private readonly drive: Ht2Drive,
    readonly career: Ht2Career,
    merchandise: SExpr[],
    messages: SExpr[] = [],
    private readonly upgrades: Upgrade[] = [],
  ) {
    for (const m of messages) if (isList(m) && typeof m[0] === 'string') this.messages.set(m[0], str(m[m.length - 1]));
    this.goods = parseGoods(merchandise);
    this.stores = findStores(drive.world.regions.values());
    for (const r of drive.world.regions.values())
      for (const room of r.way.rooms)
        for (const n of room.nodes) {
          if (/^sto_/i.test(n.name)) this.sto.push(n.pos);
          if (/^node_car_fuel/i.test(n.name)) this.fuelSpots.push(n.pos);
        }
    this.lastPos.copy(drive.truck.visual.position);
  }

  /** Бак і витрата з vehicle.tech: витрата у файлі × 10 = л/100 км (ЗіЛ — 51), запас ходу = бак / витрата. */
  private get tank(): number {
    return this.drive.tank;
  }

  /**
   * Пальне: витрата за пройдений шлях, на холостому — половина (гіпотеза), з газом — повна; порожній бак — двигун
   * глухне (заводиться знову, коли заправились).
   */
  private burn(dt: number, throttle: number): void {
    const c = this.career;
    c.fuel ??= this.tank;
    const p = this.drive.truck.visual.position;
    const dist = Math.min(50, p.distanceTo(this.lastPos));
    this.lastPos.copy(p);
    const perMeter = (this.drive.fuelConsumption * 10) / 100 / 1000;
    c.fuel = Math.max(0, c.fuel - dist * perMeter * (0.5 + 0.5 * throttle) - (this.drive.truck.engineOn ? dt * 0.0005 : 0));
    if (c.fuel <= 0 && this.drive.truck.engineOn) this.drive.truck.engineOn = false;
  }

  /** Обʼєм кузова (площа × висота, гіпотеза) і вантажопідйомність. */
  private capacity(): { mass: number; volume: number } {
    return this.drive.cargoSpace;
  }

  /** Крок: час, удари, пальне, табло; зупинка біля складу/СТО/заправки — вікно. */
  update(dt: number, throttle = 0): void {
    const c = this.career;
    if (this.busy) return;
    c.time += dt * TIME_SCALE;
    this.burn(dt, throttle);
    const v = this.drive.truck.body.linvel();
    const dv = Math.hypot(v.x - this.prevVel.x, v.y - this.prevVel.y, v.z - this.prevVel.z);
    this.prevVel.set(v.x, v.y, v.z);
    if (dv > HIT_MIN) {
      c.damage = Math.min(1, c.damage + dv * 0.004 * this.drive.tuning.damage);
      if (c.order) c.order.integrity = Math.max(0, c.order.integrity - dv * 0.01);
    }
    const p = this.drive.truck.visual.position;
    const gx = p.x;
    const gy = -p.z;
    this.saveTimer += dt;
    if (this.saveTimer > 10) {
      this.saveTimer = 0;
      this.persist();
    }
    if (this.drive.truck.speedKmh > 3) {
      // Відʼїхали — вікно цього місця можна показати знову.
      if (this.shownAt && !this.near(gx, gy, this.shownAt)) this.shownAt = null;
      return;
    }
    const store = this.stores.find((s) => s.docks.some((d) => Math.hypot(d[0] - gx, d[1] - gy) < DOCK_RADIUS));
    if (store && this.shownAt !== `s${store.id}`) {
      this.shownAt = `s${store.id}`;
      void this.atStore(store);
      return;
    }
    const sto = this.sto.findIndex((d) => Math.hypot(d[0] - gx, d[1] - gy) < STO_RADIUS);
    if (sto >= 0 && this.shownAt !== `r${sto}`) {
      this.shownAt = `r${sto}`;
      void this.atSto();
      return;
    }
    const fuel = this.fuelSpots.findIndex((d) => Math.hypot(d[0] - gx, d[1] - gy) < FUEL_RADIUS);
    if (fuel >= 0 && this.shownAt !== `f${fuel}` && (c.fuel ?? this.tank) < this.tank - 1) {
      this.shownAt = `f${fuel}`;
      void this.atFuel();
    }
  }

  /** Текст повідомлення гри з підставленим значенням (Ms.sch; без нього — запасний текст). */
  msg(key: string, fallback: string, value?: number): string {
    const t = this.messages.get(key) ?? fallback;
    return t.replace(/%[gd]/, value === undefined ? '' : String(Math.round(value))).replace(/%%/g, '%');
  }

  /** Штраф поліції за перевищення швидкості: $20 за км/год понад ліміт (гіпотеза). */
  async fine(over: number): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      const amount = over * 20;
      await modal(this.drive.overlay, 'Поліція', this.msg('FINE_SPEEDING', 'ШТРАФ ЗА ПРЕВЫШЕНИЕ СКОРОСТИ $%g', amount), ['Сплатити']);
      c.money = Math.max(0, c.money - amount);
      this.persist();
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /**
   * Мафія наздогнала: вантаж відібрано, замовнику — неустойка в половину цінності вантажу (гіпотеза, як за
   * прострочення). Тексти — Ms.sch (ATTACKED_BY_MAFIA, FORFEIT).
   */
  async robbed(): Promise<void> {
    const c = this.career;
    if (!c.order) return;
    this.busy = true;
    this.drive.paused = true;
    try {
      const forfeit = Math.round(c.order.value * 0.5);
      const text = `${this.msg('ATTACKED_BY_MAFIA', 'ВЫ ОГРАБЛЕНЫ МАФИЕЙ')}\n${c.order.goods.name} × ${c.order.units}\n${this.msg('FORFEIT', 'НЕУСТОЙКА $%g', forfeit)}`;
      await modal(this.drive.overlay, 'Мафія', text, ['Гаразд']);
      c.money = Math.max(0, c.money - forfeit);
      c.order = null;
      this.drive.setCargo(0);
      this.persist();
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /** Купівля вантажівки на складі: стара — в залік за половину ціни (гіпотеза). */
  private async buyTruck(store: Store): Promise<void> {
    const c = this.career;
    // Вантажівки з кузовом і тягачі (з напівпричепом STrailerM).
    const list = this.drive.drivableTrucks().filter((r) => r.carNode !== c.truck && !/^Storm/i.test(r.carNode)).sort((a, b) => a.price - b.price);
    const current = this.drive.drivableTrucks().find((r) => r.carNode === c.truck);
    const tradeIn = Math.round((current?.price ?? 0) * 0.5);
    const trailer = this.drive.trucksData.records.find((r) => r.carNode === 'STrailerM');
    const load = (r: (typeof list)[number]) => (r.group === 'tractors' ? `тягач, причіп ${Math.round((trailer?.cargoLoad ?? 0) / 1000)} т` : `${Math.round(r.cargoLoad / 1000)} т`);
    const labels = list.map((r) => `${r.carNode} (${r.horsePower} к.с., ${load(r)}): ${formatMoney(r.price - tradeIn)}`);
    const i = await modal(
      this.drive.overlay,
      `Вантажівки — «${store.town}»`,
      `Ваша ${current?.carNode ?? c.truck} — у залік ${formatMoney(tradeIn)}. Гроші: ${formatMoney(c.money)}.`,
      [...labels, 'Назад'],
    );
    const r = list[i];
    if (!r) return;
    const cost = r.price - tradeIn;
    if (c.money < cost) {
      await modal(this.drive.overlay, 'Вантажівки', this.msg('NOT_ENOUGH_MONEY', 'НЕ ХВАТАЕТ ДЕНЕГ'), ['Гаразд']);
      return;
    }
    if (c.order) {
      await modal(this.drive.overlay, 'Вантажівки', 'Спершу доставте вантаж.', ['Гаразд']);
      return;
    }
    c.money -= cost;
    c.truck = r.carNode;
    c.damage = 0;
    c.fuel = null;
    this.drive.changeTruck(r.carNode);
    this.persist();
  }

  private async atFuel(): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      const need = Math.ceil(this.tank - (c.fuel ?? this.tank));
      const cost = Math.round(need * FUEL_PRICE);
      const i = await modal(this.drive.overlay, 'Заправка', `У баку ${Math.round(c.fuel ?? 0)} л з ${Math.round(this.tank)}. Залити ${need} л: ${formatMoney(cost)}.`, ['Заправити', 'Не треба']);
      if (i === 0) {
        const can = Math.min(need, Math.floor(c.money / FUEL_PRICE));
        if (can <= 0) await modal(this.drive.overlay, 'Заправка', 'НЕ ХВАТАЕТ ДЕНЕГ', ['Гаразд']);
        else {
          c.money -= Math.round(can * FUEL_PRICE);
          c.fuel = Math.min(this.tank, (c.fuel ?? 0) + can);
          if (!this.drive.truck.engineOn) this.drive.truck.engineOn = true;
          this.persist();
        }
      }
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  private near(gx: number, gy: number, key: string): boolean {
    const id = Number(key.slice(1));
    if (key[0] === 's') return this.stores.find((s) => s.id === id)!.docks.some((d) => Math.hypot(d[0] - gx, d[1] - gy) < DOCK_RADIUS * 2);
    const d = key[0] === 'f' ? this.fuelSpots[id] : this.sto[id];
    return !!d && Math.hypot(d[0] - gx, d[1] - gy) < (key[0] === 'f' ? FUEL_RADIUS : STO_RADIUS) * 2;
  }

  persist(): void {
    const p = this.drive.truck.visual.position;
    const f = this.drive.truck.forward();
    this.career.pos = [p.x, -p.z, p.y];
    this.career.heading = [f.x, -f.z];
    saveCareer(this.career);
  }

  private async atStore(store: Store): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      if (c.order && c.order.to === store.id) {
        const s = settle(c.order, c.time);
        const lines = [
          `${c.order.goods.name} × ${c.order.units}`,
          `Оплата: ${formatMoney(c.order.pay)}`,
          s.damagePenalty ? `Пошкодження вантажу ${Math.round((1 - c.order.integrity) * 100)}%: −${formatMoney(s.damagePenalty)}` : '',
          s.late ? `Термін доставки минув. Неустойка: −${formatMoney(s.latePenalty)}` : '',
          `Ви заробили: ${formatMoney(s.pay)}`,
        ].filter(Boolean);
        await modal(this.drive.overlay, `Склад «${store.town}»`, lines.join('\n'), ['Гаразд']);
        c.money += s.pay;
        c.earned += s.pay;
        c.delivered++;
        c.order = null;
        this.drive.setCargo(0);
      } else if (c.order) {
        const to = this.stores.find((s) => s.id === c.order!.to);
        await modal(this.drive.overlay, `Склад «${store.town}»`, `У кузові — ${c.order.goods.name}, доставити в «${to?.town ?? '?'}».`, ['Гаразд']);
      } else {
        const orders = makeOrders(store, this.stores, this.goods, this.capacity());
        const box = document.createElement('div');
        box.className = 'career-form ht2-orders';
        box.textContent = 'Замовлення на доставку:';
        const buttons = orders.map((o) => {
          const to = this.stores.find((s) => s.id === o.to)!;
          const h = (o.deadline * TIME_SCALE) / 3600;
          return `${o.goods.name} ×${o.units} → ${to.town}: ${formatMoney(o.pay)}, ${h < 1 ? `${Math.round(h * 60)} хв` : `${h.toFixed(1)} год`}${o.urgent ? ' (терміново)' : ''}`;
        });
        const i = await modal(this.drive.overlay, `Склад «${store.town}»`, box, [...buttons, 'Купити вантажівку', 'Не брати']);
        if (i === buttons.length) await this.buyTruck(store);
        const o = orders[i];
        if (o) {
          c.order = { ...o, deadline: o.deadline * TIME_SCALE, taken: c.time, integrity: 1 };
          this.drive.setCargo(o.goods.mass * o.units);
        }
      }
      this.persist();
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /** СТО: ремонт (якщо є пошкодження) і покращення (restable.sch). */
  private async atSto(): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      for (;;) {
        const cost = Math.round(c.damage * 100 * REPAIR_PER_PERCENT);
        const damaged = c.damage > 0.01;
        const text = damaged ? `Пошкодження машини ${Math.round(c.damage * 100)}%. Ремонт: ${formatMoney(cost)}.` : 'Машина справна.';
        const options = [...(damaged ? ['Ремонт'] : []), 'Покращення', 'Поїхали'];
        const pick = options[await modal(this.drive.overlay, 'СТО', `${text} Гроші: ${formatMoney(c.money)}.`, options)];
        if (pick === 'Ремонт') {
          if (c.money < cost) await modal(this.drive.overlay, 'СТО', this.msg('NOT_ENOUGH_MONEY', 'НЕ ХВАТАЕТ ДЕНЕГ'), ['Гаразд']);
          else {
            c.money -= cost;
            c.damage = 0;
            this.persist();
          }
        } else if (pick === 'Покращення') await this.shopUpgrades();
        else break;
      }
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /** Покращення: список з цінами; встановлене — позначка; купівля — одразу на машину (перебудова фізики). */
  private async shopUpgrades(): Promise<void> {
    const c = this.career;
    const owned = c.upgrades ?? [];
    const labels = this.upgrades.map((u) => `${owned.includes(u.key) ? '✓ ' : ''}${u.name} — ${u.effect}: ${owned.includes(u.key) ? 'встановлено' : formatMoney(u.price)}`);
    const i = await modal(this.drive.overlay, 'Покращення', `Гроші: ${formatMoney(c.money)}. Дія покращень — припущення порту.`, [...labels, 'Назад']);
    const u = this.upgrades[i];
    if (!u || owned.includes(u.key)) return;
    if (c.money < u.price) {
      await modal(this.drive.overlay, 'Покращення', this.msg('NOT_ENOUGH_MONEY', 'НЕ ХВАТАЕТ ДЕНЕГ'), ['Гаразд']);
      return;
    }
    c.money -= u.price;
    const tank = this.tank;
    c.upgrades = install(owned, u);
    this.drive.applyTuning();
    // Додатковий бак — порожній (доливається на заправці).
    if (c.fuel !== null && this.tank !== tank) c.fuel = Math.min(c.fuel, this.tank);
    this.persist();
  }

  /** Куди їхати (Three.js): склад призначення, без вантажу — найближчий склад. */
  target(): THREE.Vector3 | null {
    const c = this.career;
    const p = this.drive.truck.visual.position;
    const store = c.order
      ? this.stores.find((s) => s.id === c.order!.to)
      : this.stores.reduce<Store | null>((best, s) => (!best || Math.hypot(s.center[0] - p.x, s.center[1] + p.z) < Math.hypot(best.center[0] - p.x, best.center[1] + p.z) ? s : best), null);
    return store ? toThree(...store.center) : null;
  }

  /** Табло: гроші, стан, вантаж і куди, залишок часу, годинник. */
  hud(): string {
    const c = this.career;
    const fuel = c.fuel ?? this.tank;
    const parts = [formatMoney(c.money), `стан ${Math.round((1 - c.damage) * 100)}%`, `пальне ${Math.round(fuel)} л${fuel < this.tank * 0.15 ? '!' : ''}`, formatClock(c.time)];
    if (c.order) {
      const o = c.order;
      const to = this.stores.find((s) => s.id === o.to);
      const left = o.deadline - (c.time - o.taken);
      const p = this.drive.truck.visual.position;
      const dist = to ? Math.hypot(to.center[0] - p.x, to.center[1] + p.z) : 0;
      const target = to ? toThree(...to.center) : null;
      const arrow = target ? arrowTo(this.drive.truck.forward(), target.sub(p)) : '';
      parts.push(
        `${o.goods.name} → ${to?.town ?? '?'} ${arrow} ${(dist / 1000).toFixed(1)} км, ${left > 0 ? `ще ${formatLeft(left)}` : 'термін минув'}, ціл. ${Math.round(o.integrity * 100)}%`,
      );
    } else {
      // Без вантажу — до найближчого складу.
      const p = this.drive.truck.visual.position;
      let best: Store | null = null;
      let bd = Infinity;
      for (const s of this.stores) {
        const d = Math.hypot(s.center[0] - p.x, s.center[1] + p.z);
        if (d < bd) (bd = d), (best = s);
      }
      if (best) parts.push(`склад «${best.town}» ${arrowTo(this.drive.truck.forward(), toThree(...best.center).sub(p))} ${(bd / 1000).toFixed(1)} км`);
    }
    return parts.join('   ');
  }
}

function formatLeft(s: number): string {
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год ${m % 60} хв`;
}

/** Стрілка напрямку до цілі відносно курсу машини (8 напрямків). */
function arrowTo(forward: THREE.Vector3, to: THREE.Vector3): string {
  const a = Math.atan2(forward.x * to.z - forward.z * to.x, forward.x * to.x + forward.z * to.z);
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  return arrows[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}
