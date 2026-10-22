import * as THREE from 'three';
import { modal } from '../engine/ui/modal';
import { isList, str, type SExpr } from '../formats/sexpr';
import { PAY_PER_M, cargoHit, contrabandPay, findStores, makeOrders, orderPay, orderValue as orderValueOf, parseGoods, type Goods, type Order, type Store, type Town } from './economy';
import { FUEL_PRICE, REPAIR_PER_PERCENT, formatClock, formatMoney, saveCareer, settle, type ActiveOrder, type Ht2Career } from './career';
import { toThree } from '../world/world';
import { install, type Upgrade } from './upgrades';
import { USED_DAMAGE, type ForSale, type Market } from './market';
import type { Ht2Drive } from '../drive';
import { gasPanel, jobPanel, orderPanel, salePanel, servicePanel } from './stations';
import type { SidePanel } from '../ui/panel';
import { active, advance, makeRivals, place, PREMIUM_SHARE, progress, rivalPlan, SPECIAL_ROUTE, specialOffsets, TOP_UP_EVERY, topUpPlan, topUpSpacing, type RivalRun } from './competition';
import { hireOffer, hireTariff, LICENCE_TIME, newDriver } from './company';
import { CareerRaces } from './races';
import { ukMessage } from '../ui/uk';
import { StoreZones } from './storeZones';
import { arrestCard, ILLEGAL_FINE, noFines, SPEEDING_PER_DEGREE, type Fines } from './law';
import { fleetLoad, marketShare, netMarketShare, type FleetStanding } from './share';
import type { MissionLot } from '../vehicles/presents';
import type { CacheLot } from '../vehicles/caches';
import type { TechRecord } from '../formats/tech';

/**
 * Кар'єра в режимі їзди HT2: склади (замовлення й здача вантажу), СТО (ремонт), удари (пошкодження машини й
 * вантажу), табло (гроші, вантаж, куди й скільки лишилось часу, годинник), збереження раз на 10 с.
 * Вікна зʼявляються, коли вантажівка зупинилась біля місця завантаження складу чи біля СТО.
 */
const STO_RADIUS = 18;
const FUEL_RADIUS = 14;
/** Удар: зміна швидкості за крок, м/с — від неї пошкодження (гіпотеза, як у першій грі). */
const HIT_MIN = 1.5;
/** Суперник поруч для рації, м (king.exe 0x64b6a0 — абоненти ближче 100 м). */
const NEAR_RIVAL = 100;

export class CareerMode {
  readonly stores: Store[];
  private readonly goods: Goods[];
  /** СТО: точка й вузол WAY (за ним — перелік покращень з mod_*.sch). */
  private readonly sto: [number, number, number][] = [];
  private readonly stoNames: string[] = [];
  private readonly fuelSpots: [number, number, number][] = [];
  private busy = false;
  /** Місця біля складів — тригери будівель. */
  private readonly zones = new StoreZones();
  /** Біля якого місця вже показано вікно (повторно — лише після відʼїзду). */
  private shownAt: string | null = null;
  private saveTimer = 0;

  /** Відкрите вікно оригіналу біля обʼєкта (склад, ринок, СТО, заправка) — закривається, коли від'їхали. */
  private panel: SidePanel | null = null;
  /** Замовлення складів (по одному на місце завантаження), поки їх не розібрали чи не минула година гри. */
  private readonly storeOrders = new Map<number, { orders: Order[]; time: number }>();

  /** Повідомлення гри (Ms.sch): ключ → текст з %g / %d. */
  private readonly messages = new Map<string, string>();

  constructor(
    private readonly drive: Ht2Drive,
    readonly career: Ht2Career,
    merchandise: SExpr[],
    messages: SExpr[] = [],
    private readonly upgrades: Upgrade[] = [],
    towns: Map<number, Town> = new Map(),
    private readonly services: Map<string, Set<string>> = new Map(),
  ) {
    for (const m of messages) if (isList(m) && typeof m[0] === 'string') this.messages.set(m[0], ukMessage(m[0], str(m[m.length - 1])));
    this.goods = parseGoods(merchandise);
    this.stores = findStores(drive.world.regions.values(), towns);
    for (const r of drive.world.regions.values())
      for (const room of r.way.rooms)
        for (const n of room.nodes) {
          if (/^sto_/i.test(n.name)) {
            this.sto.push(n.pos);
            this.stoNames.push(n.name.toLowerCase());
          }
          if (/^node_car_fuel/i.test(n.name)) this.fuelSpots.push(n.pos);
        }
    this.races = new CareerRaces(drive, career, (k, fb, v) => this.msg(k, fb, v), LICENCE_TIME);
  }

  /** Бак і витрата з vehicle.tech: витрата у файлі × 10 = л/100 км (ЗіЛ — 51), запас ходу = бак / витрата. */
  private get tank(): number {
    return this.drive.tank;
  }

  /**
   * Пальне, як у king.exe (кадр двигуна 0x4ff800 → 0x500612, система бака 0x4eb6e0): поки двигун працює, стан бака
   * c ∈ [0, 1] (літри = бак·c) щокадру −= |n|·газ/n₀·B·dt/E — n, n₀ — оберти й оберти найбільшої потужності
   * (tach_with_max_power), B — присадка в масло (0,8), E — fuelTimeEndurance (с): повний бак на повному газі при n₀
   * вистачає на E с (ZilR — 846 с ≈ 14 хв), без газу пальне не витрачається. Додатковий бак подвоює і бак, і E —
   * літри за секунду ті самі: бак з tech / E. Порожній бак — двигун глухне (заводиться знову, коли заправились).
   * Аркада — витрата ×0,5 (гіпотеза порту).
   */
  private burn(dt: number, throttle: number): void {
    const c = this.career;
    c.fuel ??= this.tank;
    const d = this.drive;
    const t = d.truck;
    if (t.engineOn && d.fuelEndurance > 0) {
      const load = (Math.abs(t.rpm) * Math.max(0, throttle)) / Math.max(1, d.fuelRpm);
      const litres = (d.tank / d.tuning.tank / d.fuelEndurance) * load * d.tuning.fuel * (d.arcade ? 0.5 : 1) * dt;
      c.fuel = Math.max(0, c.fuel - litres);
    }
    if (c.fuel <= 0 && t.engineOn) t.engineOn = false;
  }

  /** Обʼєм кузова (площа × висота, гіпотеза) і вантажопідйомність. */
  private capacity(): { mass: number; volume: number } {
    return this.drive.cargoSpace;
  }

  /** Крок: час, удари, пальне, табло; зупинка біля складу/СТО/заправки — вікно. */
  /** Відкладена картка «Неустойка» після пограбування мафією (через 8 с, 0x64b698). */
  private forfeitCard: { left: number; amount: number } | null = null;

  /**
   * Лот дорожньої місії — **контрабанда** (відступ від оригіналу на прохання користувача: у king.exe 0x41d340 товар —
   * легальний зі списку найближчого складу). Товар — рівномірно серед нелегальних для вантажівок (`illegal` + `trucks`,
   * без палива: рад. і хім. відходи, АКМ, героїн, гексаген); склад відвантаження — найближчий до місця (лише для
   * запису), призначення — випадковий інший склад. Оплата — contrabandPay (economy.ts).
   */
  missionLot(pos: THREE.Vector3): MissionLot | null {
    const gx = pos.x;
    const gy = -pos.z;
    const near = [...this.stores].sort((a, b) => Math.hypot(a.center[0] - gx, a.center[1] - gy) - Math.hypot(b.center[0] - gx, b.center[1] - gy));
    const pool = this.goods.filter((g) => g.illegal && g.trucks && !g.fuel && g.price > 0 && g.mass > 0);
    const w = near[0];
    const targets = this.stores.filter((s) => s.id !== w?.id);
    if (!w || !pool.length || !targets.length) return null;
    return { goods: pool[Math.floor(Math.random() * pool.length)].id, from: w.id, to: targets[Math.floor(Math.random() * targets.length)].id };
  }

  /**
   * Вантаж контейнера-схованки (king.exe 0x41d340, гілка 0x40; trailers-bodies.md §10): товар — рівномірно серед
   * легальних не-паливних (клас не перевіряється, як в оригіналі), призначення — будь-який склад (найближчий теж).
   */
  cacheLot(): CacheLot | null {
    const pool = this.goods.filter((g) => !g.illegal && !g.fuel && g.price > 0 && g.mass > 0);
    if (!pool.length || !this.stores.length) return null;
    return { goods: pool[Math.floor(Math.random() * pool.length)].id, to: this.stores[Math.floor(Math.random() * this.stores.length)].id };
  }

  /**
   * Підбір контейнера (0x56ffd0 case 0x14 → loadOrder 0x442e10): вікно «ЗАКАЗ», «Взяти» — складське замовлення в кузов
   * чи причіп: кількість 0,85·min(M, V·m/v)/m, оплата orderPay (×14,4, з причепом ×21,6), строк 0,1·L (з причепом
   * ×1,3), L — шлях дорогами до складу. Відступ порту: без місця (тягач без причепа, цистерна) контейнер лишається на
   * місці з підказкою (у king.exe зникав, хоч вантаж і не брався). true — замовлення взято (контейнер прибрати).
   */
  async offerCache(lot: CacheLot): Promise<boolean> {
    const c = this.career;
    if (c.order) {
      this.drive.say('СПОЧАТКУ ДОСТАВТЕ ВАНТАЖ');
      return false;
    }
    const g = this.goods.find((x) => x.id === lot.goods);
    const to = this.stores.find((s) => s.id === lot.to);
    if (!g || !to) return false;
    if (this.drive.trailer?.rec.trailerType === 3) {
      this.drive.say('В АВТОЦИСТЕРНУ МОЖНА ЛИШЕ ЗАЛИВАТИ ПАЛЬНЕ');
      return false;
    }
    const cap = this.capacity();
    const units = Math.round(((0.85 * Math.min(cap.mass, g.volume > 0 ? (cap.volume * g.mass) / g.volume : Infinity)) / g.mass) * 100) / 100;
    if (!(units > 0)) {
      this.drive.say('НЕМАЄ КУДИ ВАНТАЖИТИ — ПОТРІБЕН ПРИЧІП');
      return false;
    }
    const trailer = !!this.drive.trailer;
    const L = this.drive.routeLeft(toThree(...to.center)) ?? Math.hypot(to.center[0] - this.drive.truck.visual.position.x, to.center[1] + this.drive.truck.visual.position.z) * 1.35;
    const pay = orderPay(g, units, L, trailer);
    const deadline = Math.round(0.1 * L * (trailer ? 1.3 : 1));
    return this.offerLoose('Контейнер', { goods: g, units, from: -1, to: to.id, distance: L, pay, value: Math.round(orderValueOf(g, units)), deadline, urgent: false });
  }

  /** Вікно замовлення «не зі складу» (причіп на дорозі, контейнер; 0x56bc80): «Взяти» — замовлення гравця. */
  private async offerLoose(title: string, o: Order): Promise<boolean> {
    const c = this.career;
    const to = this.stores.find((s) => s.id === o.to);
    const box = [
      o.goods.name,
      `→ ${to?.town ?? '?'}`,
      formatMoney(o.pay),
      `${Math.floor(o.deadline / 60)}:${String(o.deadline % 60).padStart(2, '0')}`,
      `${((o.units * o.goods.mass) / 1000).toFixed(2)} т`,
      `${(o.units * o.goods.volume).toFixed(2)} м3`,
    ].join('\n');
    this.drive.paused = true;
    try {
      const i = await modal(this.drive.overlay, title, box, ['Взяти', 'Не брати']);
      if (i !== 0 || c.order) return false;
      c.order = { ...o, deadline: o.deadline * this.drive.timeScale, taken: c.time, integrity: 1 };
      this.recountGuilt();
      this.persist();
      return true;
    } finally {
      this.drive.paused = false;
    }
  }

  /**
   * Вікно дорожньої місії при підборі (0x56bc80, case 0x19) і замовлення (0x41be60 → 0x41bca0, 0x471200):
   * кількість — 0,85 · min(M, V·m/v) / m (M, V — вантажопідйомність і обʼєм причепа, m, v — маса й обʼєм одиниці);
   * оплата — 5,4 · (PAY_PER_M · L + (1,2 − k)·√(ціна · кількість)), L — шлях до складу; строк — 0,13 с на метр (0x471780),
   * від підбору. Повертає прийняте замовлення (вантаж у причепі ставить drive) або null.
   */
  async offerMission(lot: MissionLot, trailer: TechRecord): Promise<boolean> {
    const c = this.career;
    if (c.order) {
      this.drive.say('СПОЧАТКУ ДОСТАВТЕ ВАНТАЖ');
      return false;
    }
    const g = this.goods.find((x) => x.id === lot.goods);
    const to = this.stores.find((s) => s.id === lot.to);
    if (!g || !to) return false;
    const volume = Math.max(1, trailer.bodySquare * trailer.bodyHeight);
    const units = Math.round(((0.85 * Math.min(trailer.cargoLoad, g.volume > 0 ? (volume * g.mass) / g.volume : Infinity)) / g.mass) * 100) / 100;
    const L = this.drive.routeLeft(toThree(...to.center)) ?? Math.hypot(to.center[0] - this.drive.truck.visual.position.x, to.center[1] + this.drive.truck.visual.position.z) * 1.35;
    // Контрабанда (порт) — 40–80 тис. за шлях дорогами; легальний лот — формула king.exe.
    const pay = g.illegal ? contrabandPay(L) : Math.round(5.4 * (PAY_PER_M * L + (1.2 - g.ratio) * Math.sqrt(g.price * units)));
    const deadline = Math.round(0.13 * L);
    const o: Order = { goods: g, units, from: lot.from, to: lot.to, distance: L, pay, value: Math.round(orderValueOf(g, units)), deadline, urgent: false };
    return this.offerLoose(g.illegal ? 'Причіп з контрабандою' : 'Причіп з вантажем', o);
  }

  /** Товари merchandise.sch (рейси найманих, drive.hiredStep). */
  get goodsList(): Goods[] {
    return this.goods;
  }

  /** Гонки на Кільці (career/races.ts). */
  readonly races: CareerRaces;

  update(dt: number, throttle = 0): void {
    this.races.update(dt);
    if (this.forfeitCard && (this.forfeitCard.left -= dt) <= 0) {
      const amount = this.forfeitCard.amount;
      this.forfeitCard = null;
      if (this.drive.cards) this.drive.cards.show(6, { amount });
      else this.drive.say(this.msg('FORFEIT', 'НЕУСТОЙКА $%g', amount));
    }
    const c = this.career;
    if (this.busy) return;
    c.time += dt * this.drive.timeScale;
    this.burn(dt, throttle);
    this.updateRace(dt);
    this.updateCompany(dt);
    // Удар — зміна швидкості від зіткнень за кадр (drive.detectHits; кінематичний поворот — не удар).
    const dv = this.drive.hitDv.length();
    // Стан машини — шкода, яку удар завдав кузову (drive.detectHits: зони вмʼятин, посилена рама вже врахована).
    const wear = this.drive.hitWear;
    this.drive.hitWear = 0;
    if (wear > 0) c.damage = Math.min(1, c.damage + wear * (this.drive.arcade ? 0.5 : 1));
    // Пробій підвіски (приземлення після трампліна, яма): у king.exe — один точковий імпульс, що йде в той самий
    // обробник удару (physics.md, 0x4e7b4d → 0x554c20), а відбійники порту гасять швидкість кілька кадрів поспіль.
    // Тож серія кадрів з відбійником складається в один удар (гіпотеза порту); гасіння пружиною — не удар, як і в
    // king.exe (там імпульс лише при d < 0).
    const bump = this.drive.truck.bumpDv;
    this.drive.truck.bumpDv = 0;
    if (bump > 0) this.bump += bump;
    else if (this.bump > 0) {
      if (c.order) this.cargoHit(c.order, this.bump);
      this.bump = 0;
    }
    const hit = Math.hypot(this.drive.hitDv.x, this.drive.hitDv.z);
    if (c.order) this.cargoHit(c.order, hit);
    if (dv > HIT_MIN) this.recountGuilt();
    const p = this.drive.truck.visual.position;
    const gx = p.x;
    const gy = -p.z;
    this.saveTimer += dt;
    if (this.saveTimer > 10) {
      this.saveTimer = 0;
      this.persist();
    }
    // Місця складу — тригери будівлі (career/storeZones.ts): вікно, поки машина в зоні, без умови швидкості (як exe).
    const zone = this.zones.at(this.drive.world.loaded.values(), p);
    const zkey = zone ? `z${zone.store}:${zone.place}` : null;
    if (this.shownAt?.startsWith('z') && this.shownAt !== zkey) {
      this.closePanel();
      this.shownAt = null;
    }
    if (zone) {
      if (this.shownAt !== zkey && !this.drive.escArtLoading) {
        this.shownAt = zkey;
        this.atPlace(zone.store, zone.place);
      }
      return;
    }
    // Машина на продаж чи водій, що шукає роботу (king.exe 0x56fc10): ближче 20 м — вікно, без умови швидкості;
    // відʼїхав — вікно зникає.
    const day = Math.floor(c.time / 86400);
    const sale = this.drive.escArt ? (this.drive.markets?.nearSale(p, day, c.truck) ?? null) : null;
    const skey = sale ? `m${sale.market.id}:${sale.item.spot}` : null;
    if (this.shownAt?.startsWith('m') && this.shownAt !== skey) {
      this.closePanel();
      this.shownAt = null;
    }
    if (sale) {
      if (this.shownAt !== skey && !this.drive.escArtLoading) {
        this.shownAt = skey;
        this.salePanel(sale.market, sale.item);
      }
      return;
    }
    if (this.drive.truck.speedKmh > 3) {
      this.closePanel();
      // Відʼїхали — вікно цього місця можна показати знову.
      if (this.shownAt && !this.near(gx, gy, this.shownAt)) this.shownAt = null;
      return;
    }
    // Графіка вікон оригіналу ще читається — не показувати замість них діалоги порту.
    if (this.drive.escArtLoading) return;
    const sto = this.sto.findIndex((d) => Math.hypot(d[0] - gx, d[1] - gy) < STO_RADIUS);
    if (sto >= 0 && this.shownAt !== `r${sto}`) {
      this.shownAt = `r${sto}`;
      if (this.drive.escArt) this.servicePanel(this.stoNames[sto]);
      else void this.atSto(this.stoNames[sto]);
      return;
    }
    // Без графіки оригіналу — діалог порту (зупинитись біля ринку).
    const market = this.drive.escArt ? null : this.drive.markets?.at(p);
    if (market && this.shownAt !== `M${market.id}`) {
      this.shownAt = `M${market.id}`;
      void this.atMarket(market);
      return;
    }
    const fuel = this.fuelSpots.findIndex((d) => Math.hypot(d[0] - gx, d[1] - gy) < FUEL_RADIUS);
    if (fuel >= 0 && this.shownAt !== `f${fuel}` && (c.fuel ?? this.tank) < this.tank - 1) {
      this.shownAt = `f${fuel}`;
      if (this.drive.escArt) this.gasPanel();
      else void this.atFuel();
    }
  }

  /**
   * Удар по вантажу (king.exe hitPlayer 0x446d20, `cargoHit`): сила — зміна швидкості від зіткнення разом із
   * вертикаллю (приземлення після трампліна, падіння), × посилена рама; пневмопідвіска ×0,3. Після шкідливого удару —
   * пейджер X_DAMAGED з відсотком пошкодження; якість нижче 1 % — вантаж розбито.
   */
  /** Пробій підвіски, що триває: сума зміни швидкості від відбійників за серію кадрів, м/с. */
  private bump = 0;

  private cargoHit(o: ActiveOrder, dv: number): void {
    const t = this.drive.tuning;
    const q = cargoHit(o.integrity, o.goods.durability ?? o.goods.ratio, dv * t.damage, t.cargo);
    if (q === null) return;
    o.integrity = q;
    if (q < 0.01) return this.orderLost();
    if (q < 1) this.drive.say(this.msg('X_DAMAGED', 'ПОШКОДЖЕННЯ ВАНТАЖУ: %g%%', Math.trunc((1 - q) * 100)));
  }

  /**
   * Вантаж розбито вщент (Ms.sch ORDER_LOST, king.exe 0x429e40): лот з якістю < 0,01 знято, неустойка
   * (1 − якість)·10·√(ціна·кількість) (0x4713f0).
   */
  private orderLost(): void {
    const c = this.career;
    if (!c.order) return;
    const o = c.order;
    const forfeit = Math.round((1 - o.integrity) * 10 * Math.sqrt(o.goods.price * o.units));
    c.money = Math.max(0, c.money - forfeit);
    this.releaseRivals(c.order);
    c.order = null;
    this.drive.setCargo(0);
    this.drive.cards?.show(7, { amount: forfeit });
    this.drive.say(`${this.msg('ORDER_LOST', 'ТОВАР ПОВНІСТЮ РОЗБИТО')}. ${this.msg('FORFEIT', 'НЕУСТОЙКА $%g', forfeit)}`);
    this.persist();
  }

  /** Вихід з їзди: прибрати відкрите вікно. */
  dispose(): void {
    this.closePanel();
  }

  private closePanel(): void {
    this.panel?.close();
    this.panel = null;
  }

  private openPanel(p: SidePanel): void {
    this.closePanel();
    this.panel = p;
  }

  /**
   * Склад (вікно «ЗАКАЗ»): у кожного місця завантаження — своє замовлення, як в оригіналі («СКЛАД ЗАГРУЗКИ N»); їх
   * набір оновлюється раз на годину гри. Взяти — кнопкою (Num+ в оригіналі).
   */
  /**
   * Машина в місці складу (тригер будівлі): 00 — розвантаження, якщо вантаж для цього складу; 01…04 — картка
   * замовлення цього місця (king.exe 0x56ffd0, career-misc.md §1).
   */
  private atPlace(storeId: number, place: number): void {
    const c = this.career;
    const store = this.stores.find((s) => s.id === storeId);
    if (!store) return;
    if (place === 0) {
      if (c.order?.to === store.id) void this.atStore(store);
      return;
    }
    if (c.order) {
      const to = this.stores.find((s) => s.id === c.order!.to);
      this.drive.say(`У кузові — ${c.order.goods.name}, доставити в «${to?.town ?? '?'}»`);
      return;
    }
    if (this.drive.escArt) this.storePanel(store, place);
    else void this.atStore(store);
  }

  private storePanel(store: Store, dock: number): void {
    const c = this.career;
    const art = this.drive.escArt!;
    let cached = this.storeOrders.get(store.id);
    if (!cached || c.time - cached.time > 3600) {
      const n = Math.max(1, store.docks.length);
      cached = { orders: makeOrders(store, this.stores, this.goods, this.capacity(), Math.random, n, this.drive.trailer?.rec.trailerType === 3, this.marketShare(), !!this.drive.trailer, (a, b) => this.drive.storeRoute(a, b)), time: c.time };
      this.storeOrders.set(store.id, cached);
    }
    const taken = this.blockedDocks.get(`${store.id}:${dock}`);
    if (taken && c.time < taken.until) {
      this.drive.say(`Склад «${store.town}»: замовлення з цього місця забрав ${taken.by}`);
      return;
    }
    const o = cached.orders[dock % cached.orders.length];
    if (!o) {
      this.drive.say(`Склад «${store.town}»: замовлень немає`);
      return;
    }
    const to = this.stores.find((s) => s.id === o.to);
    this.drive.say('Щоб завантажити чи розвантажити — плюс/мінус');
    this.openPanel(
      orderPanel(
        art,
        this.drive.overlay,
        {
          goods: this.cargoName(o),
          town: to?.town ?? '?',
          pay: o.pay,
          hours: (o.deadline * this.drive.timeScale) / 3600,
          mass: o.goods.mass * o.units,
          volume: o.goods.volume * o.units,
          fragility: o.goods.ratio * 100,
          // Номер місця з тригера (store_NNMM: MM = 01…04).
          dock,
        },
        () => {
          if (c.order) return;
          c.order = { ...o, deadline: o.deadline * this.drive.timeScale, taken: c.time, integrity: 1 };
          this.attachRivals(c.order);
          cached!.orders = cached!.orders.filter((x) => x !== o);
          this.onOrderTaken?.(store.id, dock);
          this.drive.setCargo(o.goods.mass * o.units);
          this.drive.say(`${o.goods.name} → ${to?.town ?? '?'}`);
          this.recountGuilt();
          this.persist();
          this.closePanel();
        },
      ),
    );
  }

  /** Ринок (вікно «ПРОДАЁТСЯ»): машина near, біля якої стоїть гравець; доплата — різниця зі старою (у залік — половина). */
  private salePanel(m: Market, near: ForSale): void {
    const c = this.career;
    const markets = this.drive.markets!;
    const day = Math.floor(c.time / 86400);
    const current = this.drive.drivableTrucks().find((r) => r.carNode === c.truck);
    const tradeIn = Math.round((current?.price ?? 0) * 0.5);
    // На одному місці ринку — водій, що шукає роботу (зі своєю машиною).
    // Шукачі роботи — лише на ринках (стоянки-схованки — продавці вживаних і крадених).
    const offer = near.hire ? hireOffer(m.id, day, [near.spot], this.drive.truckers?.allNames ?? []) : null;
    if (offer) {
      // Тариф — $/км (BackJob показує за км, 0x477350).
      const job = { ...offer, tariff: Math.round(hireTariff(this.drive.vehiclePrice(near.rec.carNode), this.marketShare()) * 10) / 10, model: near.rec.carNode, price: near.price, power: near.rec.horsePower, load: near.rec.cargoLoad };
      return this.openPanel(jobPanel(this.drive.escArt!, this.drive.overlay, job, () => this.hire(m, day, near, offer)));
    }
    this.openPanel(
      salePanel(this.drive.escArt!, this.drive.overlay, { model: near.rec.carNode, price: near.price, power: near.rec.horsePower, load: near.rec.cargoLoad, used: this.scanner && near.used, stolen: this.scanner && !!near.stolen }, () => {
        const cost = near.price - tradeIn;
        if (c.order) return this.drive.say('Спершу доставте вантаж');
        if (c.money < cost) return this.drive.say(this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'));
        c.money -= cost;
        c.truck = near.rec.carNode;
        // Та сама машина продавця — з її фарбуванням (king.exe 0x4738c0 міняє записи машин місцями).
        c.paint = near.cluster ?? 0;
        this.bought(near);
        c.damage = near.used ? USED_DAMAGE : 0;
        c.dents = near.used ? { FC: 0.25, BC: 0.25 } : {};
        // Тягач — без причепа (king.exe 0x433b60): причіп підбирають на базі.
        c.trailer = null;
        c.trailerDents = {};
        c.fuel = null;
        markets.sell(m, day, near);
        this.drive.changeTruck(near.rec.carNode, c.paint);
        this.drive.say(`${this.msg('MONEY_PAID', 'СПЛАЧЕНО: ')}$${cost}`);
        this.persist();
        this.closePanel();
      }),
    );
  }

  /** СТО (вікно «СЕРВИС»): ремонт систем і модернізації; на цій СТО — її перелік (mod_*.sch). */
  private servicePanel(node: string): void {
    const c = this.career;
    this.openPanel(
      servicePanel(
        this.drive.escArt!,
        this.drive.overlay,
        {
          damage: c.damage,
          repairCost: Math.round(c.damage * 100 * REPAIR_PER_PERCENT),
          money: () => c.money,
          upgrades: this.upgrades,
          owned: c.upgrades ?? [],
          available: this.services.get(node) ?? null,
        },
        {
          pay: (share, buy) => {
            const repair = Math.round(c.damage * 100 * REPAIR_PER_PERCENT * share);
            const total = repair + buy.reduce((sum, u) => sum + u.price, 0);
            if (total <= 0) return true;
            if (c.money < total) {
              this.drive.say(this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'));
              return false;
            }
            c.money -= total;
            if (share > 0) {
              c.damage = Math.max(0, c.damage * (1 - share));
              if (share >= 1) {
                this.drive.dents?.repair();
                this.drive.trailerDents?.repair();
                this.drive.extinguish();
              }
            }
            const tank = this.tank;
            for (const u of buy) c.upgrades = install(c.upgrades ?? [], u);
            if (buy.length) this.drive.applyTuning();
            if (c.fuel !== null && this.tank !== tank) c.fuel = Math.min(c.fuel, this.tank);
            this.drive.say(this.msg('MONEY_PAID', 'СПЛАЧЕНО: ') + `$${total}`);
            this.persist();
            return true;
          },
          close: () => this.closePanel(),
        },
      ),
    );
  }

  /** Заправка (вікно «ЗАПРАВКА»): скільки літрів (повзунок чи «полный»), оплата. */
  private gasPanel(): void {
    const c = this.career;
    this.openPanel(
      gasPanel(this.drive.escArt!, this.drive.overlay, { fuel: c.fuel ?? this.tank, tank: this.tank, price: FUEL_PRICE, money: () => c.money }, {
        pay: (litres) => {
          const can = Math.min(litres, Math.floor(c.money / FUEL_PRICE));
          if (litres > 0 && can <= 0) {
            this.drive.say(this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'));
            return false;
          }
          c.money -= Math.round(can * FUEL_PRICE);
          c.fuel = Math.min(this.tank, (c.fuel ?? 0) + can);
          if (can > 0 && !this.drive.truck.engineOn) this.drive.truck.engineOn = true;
          if (can > 0) this.drive.say(`ОПЛАТА ЗАПРАВКИ $${Math.round(can * FUEL_PRICE)}`);
          this.persist();
          return true;
        },
        close: () => this.closePanel(),
      }),
    );
  }

  /** Текст повідомлення гри з підставленим значенням (Ms.sch; без нього — запасний текст). */
  msg(key: string, fallback: string, value?: number): string {
    const t = this.messages.get(key) ?? fallback;
    return t.replace(/%[gd]/, value === undefined ? '' : String(Math.round(value))).replace(/%%/g, '%');
  }

  /** Штрафи, що висять на гравці (career/law.ts); є хоч один — міліція жене. */
  get fines(): Fines {
    return (this.career.fines ??= noFines());
  }

  /** Перевищення, яке зафіксував пост (0x4d1360): штраф 250 × ступінь (перезаписується) — гравець розшукуваний. */
  private speedInfo: { limit: number; speed: number } | null = null;

  speeding(limit: number, speed: number, degree: number): void {
    this.fines.speeding = SPEEDING_PER_DEGREE * degree;
    this.speedInfo = { limit, speed };
    this.persist();
  }

  /** Сканер вантажу (PR_CARGO_SCANNER): видно прихований товар і крадену чи вживану машину. */
  get scanner(): boolean {
    return (this.career.upgrades ?? []).some((u) => u.startsWith('PR_CARGO_SCANNER'));
  }

  /**
   * Назва вантажу: без сканера — прикриття; зі сканером прихований товар блимає раз на секунду з прикриттям (king.exe
   * 0x56bc80, 0x5756f0 — інший колір; у порту — та сама назва з позначкою «!»).
   */
  cargoName(o: { goods: Goods; hidden?: Goods }): string {
    if (!o.hidden || !this.scanner) return o.goods.name;
    return Math.floor(performance.now() / 1000) % 2 ? `${o.hidden.name}!` : o.goods.name;
  }

  /**
   * Перерахунок провини (accountForGuilt 0x442850; при завантаженні, ударі, доставці): прихований товар «попадається»
   * з імовірністю 80 % — штраф 15000 × коефіцієнт; крадена машина — з імовірністю 50 %, 0,8 ціни моделі.
   */
  recountGuilt(): void {
    const c = this.career;
    const f = this.fines;
    // Прихований товар чи відверта контрабанда (причепи біля доріг у порту) — той самий штраф за товар.
    const h = c.order?.hidden ?? (c.order?.goods.illegal ? c.order.goods : undefined);
    f.illegal = h && Math.random() < 0.8 ? ILLEGAL_FINE * h.guilt : 0;
    f.stolen = c.stolen && Math.random() < 0.5 ? Math.round(0.8 * (c.truckPrice ?? 0)) : 0;
    this.recountMafia();
  }

  /**
   * «Цікавий мафії» (+0xC9, accountForGuilt 0x442850; re/notes/ht2/mafia.md §1): вантаж класу formafia (видимий чи
   * прихований) і частка капіталу > 0,15 — з імовірністю 80 % (оплата ≥ 10000) чи 50 %; інакше ні.
   */
  private recountMafia(): void {
    const o = this.career.order;
    const forMafia = !!o && (o.goods.forMafia || !!o.hidden?.forMafia);
    this.fines.mafiaInterest = forMafia && this.marketShare() > 0.15 && Math.random() < (o!.pay >= 10000 ? 0.8 : 0.5);
  }

  /** Регіон складу призначення поточного замовлення (виняток забороненої зони — Алмазний, aa; king.exe 0x41ef90). */
  orderRegion(): string | null {
    const o = this.career.order;
    return (o && this.stores.find((s) => s.id === o.to)?.region) ?? null;
  }

  /** Вантажопідйомність флоту гравця, кг (share.ts). */
  fleetLoad(): number {
    const recs = this.drive.trucksData.records;
    return fleetLoad(this.career, (n) => recs.find((r) => r.carNode === n)?.cargoLoad ?? 0);
  }

  /** Частка X гравця — «доля перевезень» (share.ts, king.exe 0x41fcf0); у мережевій кар'єрі — серед усіх гравців. */
  marketShare(): number {
    const recs = this.drive.trucksData.records;
    if (this.netOthers) return netMarketShare(this.standing(), [...this.netOthers.values()], this.drive.rivalLoad);
    return marketShare(this.career, (n) => recs.find((r) => r.carNode === n)?.cargoLoad ?? 0, this.drive.rivalLoad);
  }

  /** Свій флот для мережевої кар'єри: вантажопідйомність, найнято, перевезено тонн. */
  standing(): FleetStanding & { tons: number } {
    return { load: this.fleetLoad(), hired: this.career.company?.length ?? 0, tons: this.info().tons };
  }

  /**
   * Мережева кар'єра (М6, «змагання за ринок»): флоти інших гравців за номером (повідомлення `stand` раз на 8 с) —
   * спільна частка ринку й рейтинг F2; null — одиночна кар'єра.
   */
  netOthers: Map<number, FleetStanding & { name: string; tons: number }> | null = null;
  /** Мережева кар'єра: місця складів, з яких замовлення вже забрав інший гравець (`<склад>:<місце>` → хто, до якого часу). */
  private readonly blockedDocks = new Map<string, { by: string; until: number }>();
  /** Мережева кар'єра: свій гравець узяв замовлення на місці dock складу store — повідомити інших. */
  onOrderTaken: ((store: number, dock: number) => void) | null = null;

  /**
   * Інший гравець узяв замовлення на місці dock складу store: у нас це місце порожнє до наступного оновлення дошки
   * (3600 с гри, як storePanel).
   */
  blockDock(store: number, dock: number, by: string): void {
    this.blockedDocks.set(`${store}:${dock}`, { by, until: this.career.time + 3600 });
  }

  /** Рейтинг інших гравців для F2: імʼя, частка (та сама формула, що в них), найнято, тонни. */
  netRating(): { name: string; share: number; hired: number; tons: number }[] {
    if (!this.netOthers) return [];
    const me = this.standing();
    const all = [...this.netOthers.values()];
    return all.map((o) => ({ name: o.name, share: netMarketShare(o, [me, ...all.filter((x) => x !== o)], this.drive.rivalLoad), hired: o.hired, tons: o.tons }));
  }

  /** Купівля машини на ринку: крадена — прапорець (без повідомлення); уживана — king.exe mess 0x77. */
  private bought(s: ForSale): void {
    const c = this.career;
    c.stolen = !!s.stolen;
    c.truckPrice = s.rec.price;
    if (s.used) this.drive.say('ВАМ ПРОДАЛИ ВЖИВАНУ МАШИНУ');
    this.recountGuilt();
  }

  /** Конфіскація (cancelIllegalOrders 0x444f80): замовлення з прихованим товаром зникає без неустойки. */
  private confiscate(): void {
    const c = this.career;
    if (!c.order?.hidden && !c.order?.goods.illegal) return;
    this.releaseRivals(c.order);
    c.order = null;
    this.drive.setCargo(0);
    this.drive.say(this.msg('LOAD_SEIZED', 'ВАНТАЖ КОНФІСКОВАНО'));
  }

  /**
   * Затримання (подія 2 king.exe, 0x430a80): картка (один штраф — своя, кілька — 15 з переліком), сума списується
   * з грошей без перевірки на мінус, усі штрафи обнуляються. true — затримання було (далі — ролик trp.bne, drive.ts).
   */
  async arrest(): Promise<boolean> {
    const c = this.career;
    const card = arrestCard(this.fines);
    if (!card) return false;
    const line = (l: { key: string; amount?: number }) => this.msg(l.key, l.key, l.amount).replace(/\s*\n\s*/g, ' ');
    const text = card.lines.map(line).join('\n');
    c.money -= card.amount;
    c.fines = noFines();
    c.stolen = false;
    this.confiscate();
    const info = this.speedInfo;
    this.speedInfo = null;
    this.persist();
    if (this.drive.cards) {
      this.drive.cards.show(card.card, { amount: card.amount, text, limit: info?.limit, speed: info?.speed });
      this.drive.say(`${this.msg('MONEY_PAID', 'СПЛАЧЕНО: ')}$${card.amount}`);
      return true;
    }
    this.busy = true;
    this.drive.paused = true;
    try {
      await modal(this.drive.overlay, 'Міліція', `${text || 'Штраф'}\n${this.msg('MONEY_PAID', 'СПЛАЧЕНО: ')}$${card.amount}`, ['Сплатити']);
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
    return true;
  }

  /**
   * Мафія наздогнала: вантаж відібрано, замовнику — неустойка в половину цінності вантажу (гіпотеза, як за
   * прострочення). Тексти — Ms.sch (ATTACKED_BY_MAFIA, FORFEIT).
   */
  /**
   * Напад мафії (mafiaAttack 0x445740; mafia.md §4): вартість вантажу V = Σ 10·√(ціна × кількість); V ≤ борг мафії —
   * з грошей списується борг (картка 20, може піти в мінус); інакше вантаж забирають (картка 21), через 8 с картка 6
   * «Неустойка» з сумою V — гроші НЕ списуються (метод лише показує картку). Після — борг і інтерес мафії нуль.
   * Повертає, чи лишився прихований вантаж (king.exe `+0xC9` — гілка «гроші» його не знімає; гіпотеза: це
   * незаконний вантаж) — тоді ролик trml.bne перед trmm.bne (drive.ts).
   */
  async robbed(): Promise<boolean> {
    const c = this.career;
    const f = this.fines;
    const o = c.order;
    const value = o ? 10 * Math.sqrt(o.goods.price * o.units) : 0;
    const debt = f.mafiaDebt ?? 0;
    if (value <= debt) {
      c.money -= debt;
      if (this.drive.cards) this.drive.cards.show(20, { amount: Math.round(debt) });
      else this.drive.say(`МАФІЯ ЗАБРАЛА $${Math.round(debt)}`);
    } else {
      this.releaseRivals(c.order);
      c.order = null;
      this.drive.setCargo(0);
      f.illegal = 0;
      if (this.drive.cards) this.drive.cards.show(21);
      else this.drive.say('БАНДИТИ ЗАБРАЛИ ВАШ ВАНТАЖ');
      this.forfeitCard = { left: 8, amount: Math.round(value) };
    }
    f.mafiaDebt = 0;
    f.mafiaInterest = false;
    this.persist();
    return (f.illegal ?? 0) > 0;
  }


  /**
   * Ринок вантажівок (parking MARKET_* з mod_*.sch): машини, що стоять на місцях ринку сьогодні; стара — у залік за
   * половину ціни (гіпотеза), вживана — дешевша, але з пошкодженням.
   */
  private async atMarket(m: Market): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      const day = Math.floor(c.time / 86400);
      const markets = this.drive.markets!;
      const list = markets.stock(m, day).filter((s) => s.rec.carNode !== c.truck);
      const current = this.drive.drivableTrucks().find((r) => r.carNode === c.truck);
      const tradeIn = Math.round((current?.price ?? 0) * 0.5);
      const trailer = this.drive.trucksData.records.find((r) => r.carNode === 'STrailerM');
      const load = (r: ForSale['rec']) => (r.group === 'tractors' ? `тягач, причіп ${Math.round((trailer?.cargoLoad ?? 0) / 1000)} т` : `${Math.round(r.cargoLoad / 1000)} т`);
      const tag = (s: ForSale) => (!this.scanner ? '' : s.stolen ? ' (крадена)' : s.used ? ' (вживана)' : '');
      const labels = list.map((s) => `${s.rec.carNode}${tag(s)} — ${s.rec.horsePower} к.с., ${load(s.rec)}: ${formatMoney(s.price - tradeIn)}`);
      const title = `${m.name || (m.hidden ? 'Стоянка' : 'Ринок')}${m.town ? ` «${m.town}»` : ''}`;
      const i = await modal(this.drive.overlay, title, `Ваша ${current?.carNode ?? c.truck} — у залік ${formatMoney(tradeIn)}. Гроші: ${formatMoney(c.money)}.`, [...labels, 'Поїхали']);
      const s = list[i];
      if (!s) return;
      const cost = s.price - tradeIn;
      if (c.money < cost) {
        await modal(this.drive.overlay, title, this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'), ['Гаразд']);
        return;
      }
      if (c.order) {
        await modal(this.drive.overlay, title, 'Спершу доставте вантаж.', ['Гаразд']);
        return;
      }
      c.money -= cost;
      c.truck = s.rec.carNode;
      c.paint = s.cluster ?? 0;
      this.bought(s);
      c.damage = s.used ? USED_DAMAGE : 0;
      // Нова машина — без вмʼятин; вживана — трохи побита спереду й ззаду (гіпотеза).
      c.dents = s.used ? { FC: 0.25, BC: 0.25 } : {};
      c.trailer = null;
      c.trailerDents = {};
      c.fuel = null;
      markets.sell(m, day, s);
      this.drive.changeTruck(s.rec.carNode, c.paint);
      this.persist();
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
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
        if (can <= 0) await modal(this.drive.overlay, 'Заправка', 'НЕ ВИСТАЧАЄ ГРОШЕЙ', ['Гаразд']);
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
    const d = key[0] === 'f' ? this.fuelSpots[id] : this.sto[id];
    return !!d && Math.hypot(d[0] - gx, d[1] - gy) < (key[0] === 'f' ? FUEL_RADIUS : STO_RADIUS) * 2;
  }

  /** Ліцензії (табло «ЛІЦЕНЗІЙ N» і час найближчої до закінчення), с ігрового часу. */
  licenceInfo(): { count: number; left: number } | null {
    const l = this.career.licences ?? [];
    return l.length ? { count: l.length, left: Math.min(...l) - this.career.time } : null;
  }

  /** Закінчення ліцензій і робота найманих водіїв. */
  private updateCompany(dt: number): void {
    const c = this.career;
    if (c.licences?.length) {
      const live = c.licences.filter((t) => t > c.time);
      if (live.length < c.licences.length) this.drive.say(this.msg('LICENCES_EXPIRED', 'ЛІЦЕНЗІЙ НА НАЙМ, ЩО ЗАКІНЧИЛИСЯ: %d', c.licences.length - live.length));
      c.licences = live;
    }
    // Робота найманих — drive.hiredStep (рейси й витрати за king.exe, company.ts).
    void dt;
  }

  /**
   * Найм (king.exe 0x476bc0): ліцензія; гроші більше за 10·тариф + вартість машини водія — обидва водієві (аванс і
   * вартість машини, яку він поверне при звільненні); машина лишається в нього.
   */
  private hire(m: Market, day: number, near: ForSale, offer: { name: string; photo: number }): void {
    const c = this.career;
    const tariff = hireTariff(this.drive.vehiclePrice(near.rec.carNode), this.marketShare());
    if (!c.licences?.length) return this.drive.say(this.msg('NO_LICENCES', 'У ВАС НЕМАЄ ЛІЦЕНЗІЙ НА НАЙМ!'));
    if (!(c.money > 10 * tariff + near.price)) return this.drive.say(this.msg('NO_MONEY_TO_HIRE', 'У ВАС НЕ ВИСТАЧАЄ ГРОШЕЙ НА НАЙМ'));
    c.money -= 10 * tariff + near.price;
    c.licences = [...c.licences].sort((a, b) => a - b).slice(1);
    c.company = [...(c.company ?? []), newDriver(offer, near.rec.carNode, tariff, near.price, near.cluster ?? 0)];
    this.drive.markets!.sell(m, day, near);
    this.drive.say(`${offer.name.toUpperCase()} ПРАЦЮЄ НА ВАС`);
    this.persist();
    this.closePanel();
  }

  /** Доставка: якщо були суперники й ніхто не доїхав раніше — премія першому. */
  private firstBonus(o: NonNullable<Ht2Career['order']>): void {
    if (!o.rivals?.length || o.beaten) return;
    const c = this.career;
    c.money += o.premium ?? 0;
    c.firsts = (c.firsts ?? 0) + 1;
    this.drive.say(`ВИ ПЕРШИЙ! ПРЕМІЯ $${o.premium ?? 0}`);
    // Ліцензія на найм (посібник: за доставку першим); перша — картка 1 «можеш відкрити свою компанію», далі — 2.
    c.licences = [...(c.licences ?? []), c.time + LICENCE_TIME];
    this.drive.cards?.show(c.firsts === 1 ? 1 : 2, { drivers: c.licences.length, name: c.driver, minutes: Math.round(LICENCE_TIME / 60) });
  }

  /** Позиція серед конкурентів (табло «ПОЗИЦІЯ N З M»), оновлюється раз на пів секунди. */
  race: { place: number; of: number } | null = null;
  private raceTimer = 0;

  /**
   * Нове замовлення: можливо, його беруть і суперники (маршрут — мережею доріг). Як у king.exe — справжні далекобійники
   * світу (truckers.recruitRivals): маршрут довший за SPECIAL_ROUTE — на дорозі гравця попереду й позаду. Світу ще
   * немає (перший кадр) — суперники без водіїв (розрахунок часу).
   */
  private attachRivals(o: NonNullable<Ht2Career['order']>): void {
    const to = this.stores.find((s) => s.id === o.to);
    const route = (to && this.drive.routeLeft(toThree(...to.center))) || o.distance;
    o.route = route;
    const p = this.drive.truck.visual.position;
    const f = this.drive.truck.forward();
    o.start = [p.x, p.y, p.z, f.x, f.z];
    const T = this.drive.truckers;
    if (T?.fleet && T.freight) {
      const plan = rivalPlan(this.drive.trafficDensity);
      const offsets = route > SPECIAL_ROUTE ? specialOffsets(plan.count, plan.ahead) : null;
      const heading = f.clone().setY(0).normalize();
      const ids = T.recruitRivals(o, plan.count, offsets, p.clone(), heading);
      o.rivals = ids.map((i) => this.rivalRun(i));
      // Змагання є — далі доповнюється до N (topUpRivals), навіть якщо зараз набрано менше.
      if (plan.count > 0) (o.rivalTarget = plan.count), (o.rivalAhead = plan.ahead);
    } else o.rivals = makeRivals(route, T?.allNames ?? []);
    const n = o.rivalTarget ?? o.rivals.length;
    o.premium = n ? Math.round(o.pay * PREMIUM_SHARE) : 0;
    if (n) this.drive.say(`ЦЕЙ ВАНТАЖ ВЕЗУТЬ ЩЕ ${n}. ПРЕМІЯ ПЕРШОМУ $${o.premium}`);
  }

  private rivalRun(i: number): RivalRun {
    return { name: this.drive.truckers!.fleet!.members[i].name, member: i, eta: 0, t: 0, stubborn: Math.random() < 0.35 };
  }

  private topUpTimer = TOP_UP_EVERY;

  /**
   * Доповнення суперників до N (king.exe: задача provideCompetitionRegular кожні 30 с): замість тих, хто зійшов
   * (відкуп, мафія, «скинь вантаж»), — нові водії світу. Нікого не лишилось і до складу далі SPECIAL_ROUTE — знову
   * довкола гравця; інакше — від складу відправлення далі TOP_UP_AWAY від гравця вздовж маршруту.
   */
  private topUpRivals(o: NonNullable<Ht2Career['order']>, left: number | null): void {
    const T = this.drive.truckers;
    if (!o.rivalTarget || !o.rivals || !T?.fleet) return;
    const plan = topUpPlan(o.rivals, o.rivalTarget, left);
    if (!plan.missing) return;
    const p = this.drive.truck.visual.position.clone();
    const heading = this.drive.truck.forward().setY(0).normalize();
    // Хто вже був у цьому змаганні (зійшов чи доїхав), удруге не береться (порт).
    const was = new Set(o.rivals.flatMap((r) => (r.member === undefined ? [] : [r.member])));
    const ids = plan.special
      ? T.recruitRivals(o, plan.missing, specialOffsets(plan.missing, o.rivalAhead ?? 0), p, heading, undefined, was)
      : T.recruitRivals(o, plan.missing, null, p, heading, { spacing: topUpSpacing(o.rivalAhead ?? 0, o.route ?? 0), already: o.rivals.filter((r) => !r.out && !r.done).length }, was);
    o.rivals.push(...ids.map((i) => this.rivalRun(i)));
  }

  /** Суперники замовлення більше не змагаються (доставлено, скасовано, втрачено): водіїв відпустити. */
  releaseRivals(o: NonNullable<Ht2Career['order']> | null): void {
    for (const r of o?.rivals ?? []) if (r.member !== undefined && !r.done) this.drive.truckers?.releaseRival(r.member, r.name, false);
    if (this.drive.truckers) this.drive.truckers.playerLeft = null;
  }

  /** Крок конкуренції: суперники їдуть; хто доїхав раніше гравця — повідомлення; позиція гравця. */
  private updateRace(dt: number): void {
    const o = this.career.order;
    const T = this.drive.truckers;
    if (!o?.rivals || (!o.rivals.length && !o.rivalTarget)) {
      this.race = null;
      this.rivalMarks = [];
      if (T) T.playerLeft = null;
      return;
    }
    for (const r of advance(o.rivals, dt)) this.rivalArrived(o, r);
    this.raceTimer -= dt;
    if (this.raceTimer > 0) return;
    this.raceTimer = 0.5;
    const to = this.stores.find((s) => s.id === o.to);
    const left = to ? this.drive.routeLeft(toThree(...to.center)) : null;
    if (T) T.playerLeft = left;
    this.topUpTimer -= 0.5;
    if (this.topUpTimer <= 0) {
      this.topUpTimer = TOP_UP_EVERY;
      this.topUpRivals(o, left);
    }
    // Справжні водії: що лишилось, хто доїхав, хто зійшов; рація — затримка й «не поспішатиме».
    const marks: THREE.Vector3[] = [];
    for (const r of o.rivals) {
      if (r.member === undefined || r.done || !T) continue;
      if (r.out) {
        T.releaseRival(r.member, r.name, true);
        r.done = true;
        continue;
      }
      if (r.delay || r.slow) {
        T.steerRival(r.member, r.name, r.delay ?? 0, r.slow ?? 1);
        r.delay = 0;
      }
      const info = T.rivalInfo(r.member, r.name, o.to);
      if (!info) continue;
      if (info.gone) {
        r.out = true;
        continue;
      }
      if (info.left !== null) r.left = info.left;
      if (info.done) {
        r.done = true;
        T.releaseRival(r.member, r.name, false);
        this.rivalArrived(o, r);
        continue;
      }
      marks.push(info.pos);
    }
    const mine = left === null || !o.route ? 0 : Math.max(0, 1 - left / o.route);
    this.race = active(o.rivals).length ? place(o.rivals, mine, o.route) : null;
    this.rivalMarks = [...marks, ...this.rivalPositions(o)];
  }

  /** Суперник доїхав: перший, хто випередив гравця, — без премії (COMPETITOR_ARRIVED). */
  private rivalArrived(o: NonNullable<Ht2Career['order']>, r: RivalRun): void {
    void r;
    if (o.beaten) return;
    o.beaten = true;
    this.drive.say(this.msg('COMPETITOR_ARRIVED', 'ВАШ КОНКУРЕНТ ЩОЙНО ПРИБУВ. ПОКВАПТЕСЯ'));
  }

  /**
   * Суперники з тим самим вантажем на карті (на прохання користувача; у king.exe — лише з прапорцем 0x80, ui/tabMap.ts):
   * справжні водії — де вони є (updateRace); без водія — точка на найкоротшому шляху від місця, де гравець узяв вантаж,
   * на частці шляху суперника. Ще не виїхали, доїхали чи зійшли — не показуються. Старі збереження без `start` — від
   * складу відправлення.
   */
  rivalMarks: THREE.Vector3[] = [];

  private rivalPositions(o: NonNullable<Ht2Career['order']>): THREE.Vector3[] {
    const to = this.stores.find((s) => s.id === o.to);
    const from = this.stores.find((s) => s.id === o.from);
    if (!to || !o.route || !o.rivals) return [];
    const st = o.start;
    const pos = st ? new THREE.Vector3(st[0], st[1], st[2]) : from ? toThree(...from.center) : null;
    if (!pos) return [];
    const heading = st ? new THREE.Vector3(st[3], 0, st[4]) : undefined;
    const target = toThree(...to.center);
    return o.rivals.flatMap((r) => {
      if (r.member !== undefined || r.out || r.done || r.t <= 0) return [];
      const q = this.drive.routePoint(pos, heading, target, (r.t / r.eta) * o.route!);
      return q ? [q] : [];
    });
  }

  /**
   * Конкуренти поруч на дорозі (рація): справжній водій — ближче NEAR_RIVAL м (king.exe: абоненти рації ближче 100 м,
   * 0x64b6a0); без водія — з близькою часткою шляху (гіпотеза: «поруч» = ±10 % маршруту).
   */
  nearRivals(): { index: number; name: string }[] {
    const o = this.career.order;
    if (!o?.rivals || !o.route) return [];
    const to = this.stores.find((s) => s.id === o.to);
    const left = to ? this.drive.routeLeft(toThree(...to.center)) : null;
    const mine = left === null ? 0 : 1 - left / o.route;
    const me = this.drive.truck.visual.position;
    return o.rivals.flatMap((r, index) => {
      if (r.out || r.done) return [];
      if (r.member !== undefined) {
        const info = this.drive.truckers?.rivalInfo(r.member, r.name, o.to);
        return info && !info.gone && info.pos.distanceTo(me) < NEAR_RIVAL ? [{ index, name: r.name }] : [];
      }
      return Math.abs(progress(r) - mine) < 0.1 ? [{ index, name: r.name }] : [];
    });
  }

  /**
   * Оплата 911 (king.exe 0x511910, 0x5119e0): 1000 + 5000·пошкодження + пальне до 30 % бака по $2/л. Грошей досить —
   * ремонт, пальне до 30 %, «ПЛАТА ЗА ВИКЛИК»; ні — «НЕ ВИСТАЧАЄ ГРОШЕЙ», машину однаково переставлено, без ремонту.
   * Доплата за позначену машину (0,35 × 0,64 ціни) — не зроблено (порт не веде цієї позначки).
   */
  pay911(): void {
    const c = this.career;
    const fuel = c.fuel ?? this.tank;
    const litres = Math.max(0, 0.3 * this.tank - fuel);
    const cost = Math.round(1000 + 5000 * c.damage + 2 * litres);
    if (c.money < cost) {
      this.drive.say(this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'));
      return;
    }
    c.money -= cost;
    c.damage = 0;
    c.fuel = fuel + litres;
    this.drive.dents?.repair();
    this.drive.trailerDents?.repair();
    this.drive.extinguish();
    this.drive.say(`ПЛАТА ЗА ВИКЛИК $${cost}`);
    this.persist();
  }

  /** Найближча СТО (точка вузла sto_*, координати гри) — для 911. */
  nearestSto(gx: number, gy: number): [number, number, number] | null {
    let best: [number, number, number] | null = null;
    for (const d of this.sto) if (!best || Math.hypot(d[0] - gx, d[1] - gy) < Math.hypot(best[0] - gx, best[1] - gy)) best = d;
    return best;
  }

  persist(): void {
    const p = this.drive.truck.visual.position;
    const f = this.drive.truck.forward();
    this.career.pos = [p.x, -p.z, p.y];
    this.career.heading = [f.x, -f.z];
    if (this.drive.presents) this.career.presents = this.drive.presents.snapshot();
    if (this.drive.caches) this.career.caches = this.drive.caches.snapshot();
    if (this.drive.obstacles) this.career.obstacle = this.drive.obstacles.active;
    const fleet = this.drive.truckers?.snapshot();
    if (fleet) this.career.fleet = fleet;
    saveCareer(this.career);
  }

  private async atStore(store: Store): Promise<void> {
    const c = this.career;
    this.busy = true;
    this.drive.paused = true;
    try {
      if (c.order && c.order.to === store.id && this.drive.cards) {
        const s = settle(c.order, c.time);
        this.drive.cards.show(4, { integrity: c.order.integrity * 100, forfeit: s.damagePenalty + s.latePenalty, fee: c.order.pay });
        this.drive.say(this.msg('YOU_MADE', 'ВИ ЗАРОБИЛИ: %g', s.pay));
        c.money += s.pay;
        c.earned += s.pay;
        c.delivered++;
        c.tons = (c.tons ?? 0) + (c.order.goods.mass * c.order.units) / 1000;
        this.firstBonus(c.order);
        this.releaseRivals(c.order);
        c.order = null;
        this.drive.setCargo(0);
      } else if (c.order && c.order.to === store.id) {
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
        c.tons = (c.tons ?? 0) + (c.order.goods.mass * c.order.units) / 1000;
        this.firstBonus(c.order);
        this.releaseRivals(c.order);
        c.order = null;
        this.drive.setCargo(0);
      } else if (c.order) {
        const to = this.stores.find((s) => s.id === c.order!.to);
        await modal(this.drive.overlay, `Склад «${store.town}»`, `У кузові — ${c.order.goods.name}, доставити в «${to?.town ?? '?'}».`, ['Гаразд']);
      } else {
        const orders = makeOrders(store, this.stores, this.goods, this.capacity(), Math.random, 5, this.drive.trailer?.rec.trailerType === 3, this.marketShare(), !!this.drive.trailer, (a, b) => this.drive.storeRoute(a, b));
        const box = document.createElement('div');
        box.className = 'career-form ht2-orders';
        box.textContent = 'Замовлення на доставку:';
        const buttons = orders.map((o) => {
          const to = this.stores.find((s) => s.id === o.to)!;
          const h = (o.deadline * this.drive.timeScale) / 3600;
          return `${this.cargoName(o)} ×${o.units} → ${to.town}: ${formatMoney(o.pay)}, ${h < 1 ? `${Math.round(h * 60)} хв` : `${h.toFixed(1)} год`}${o.urgent ? ' (терміново)' : ''}${o.goods.forMafia ? ' ⚠ мафія' : ''}`;
        });
        const i = await modal(this.drive.overlay, `Склад «${store.town}»`, box, [...buttons, 'Не брати']);
        const o = orders[i];
        if (o) {
          c.order = { ...o, deadline: o.deadline * this.drive.timeScale, taken: c.time, integrity: 1 };
          this.attachRivals(c.order);
          this.drive.setCargo(o.goods.mass * o.units);
          this.recountGuilt();
        }
      }
      this.persist();
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /** СТО: ремонт (якщо є пошкодження) і покращення (restable.sch). */
  private async atSto(node: string): Promise<void> {
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
          if (c.money < cost) await modal(this.drive.overlay, 'СТО', this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'), ['Гаразд']);
          else {
            c.money -= cost;
            c.damage = 0;
            this.drive.dents?.repair();
            this.drive.extinguish();
            this.persist();
          }
        } else if (pick === 'Покращення') await this.shopUpgrades(node);
        else break;
      }
    } finally {
      this.drive.paused = false;
      this.busy = false;
    }
  }

  /** Покращення: список з цінами; встановлене — позначка; купівля — одразу на машину (перебудова фізики). */
  private async shopUpgrades(node: string): Promise<void> {
    const c = this.career;
    const owned = c.upgrades ?? [];
    // На цій СТО — лише покращення з її переліку (mod_*.sch); без даних — усі.
    const here = this.services.get(node);
    // Вікно порту — лише покращення з дією в порту (effect); вікно оригіналу (stations.ts) — усі.
    const known = this.upgrades.filter((u) => u.effect);
    const list = here ? known.filter((u) => here.has(u.key)) : known;
    if (!list.length) {
      await modal(this.drive.overlay, 'Покращення', 'На цій СТО покращень, які діють у порту, немає.', ['Гаразд']);
      return;
    }
    const labels = list.map((u) => `${owned.includes(u.key) ? '✓ ' : ''}${u.name} — ${u.effect}: ${owned.includes(u.key) ? 'встановлено' : formatMoney(u.price)}`);
    const i = await modal(this.drive.overlay, 'Покращення', `Гроші: ${formatMoney(c.money)}. Дія покращень — припущення порту.`, [...labels, 'Назад']);
    const u = list[i];
    if (!u || owned.includes(u.key)) return;
    if (c.money < u.price) {
      await modal(this.drive.overlay, 'Покращення', this.msg('NOT_ENOUGH_MONEY', 'НЕ ВИСТАЧАЄ ГРОШЕЙ'), ['Гаразд']);
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

  /**
   * Табло: гроші, стан, вантаж і куди, залишок часу, годинник. short — поруч табло оригіналу (стан і пальне вже на
   * ньому).
   */
  /** Дані для панелей F2–F4: замовлення (куди, стрілка, відстань, залишок часу), вантаж, стан, покращення. */
  info(): CareerInfo {
    const c = this.career;
    const p = this.drive.truck.visual.position;
    const fwd = this.drive.truck.forward();
    let order: CareerInfo['order'] = null;
    if (c.order) {
      const o = c.order;
      const to = this.stores.find((s) => s.id === o.to);
      order = {
        goods: this.cargoName(o),
        units: o.units,
        town: to?.town ?? '?',
        arrow: to ? arrowTo(fwd, toThree(...to.center).sub(p)) : '',
        km: to ? Math.hypot(to.center[0] - p.x, to.center[1] + p.z) / 1000 : 0,
        left: o.deadline - (c.time - o.taken),
        pay: o.pay,
        premium: o.premium ?? 0,
        integrity: o.integrity,
        mass: o.goods.mass * o.units,
        volume: o.goods.volume * o.units,
      };
    }
    let near: CareerInfo['near'] = null;
    if (!c.order) {
      let bd = Infinity;
      for (const s of this.stores) {
        const d = Math.hypot(s.center[0] - p.x, s.center[1] + p.z);
        if (d < bd) (bd = d), (near = { town: s.town, arrow: arrowTo(fwd, toThree(...s.center).sub(p)), km: d / 1000 });
      }
    }
    return {
      order,
      near,
      money: c.money,
      truck: c.truck,
      damage: c.damage,
      fuel: (c.fuel ?? this.tank) / this.tank,
      capacity: this.capacity(),
      upgrades: c.upgrades ?? [],
      delivered: c.delivered,
      tons: c.tons ?? 0,
      driver: c.driver,
      time: c.time,
    };
  }

  hud(short = false): string {
    const c = this.career;
    const fuel = c.fuel ?? this.tank;
    const parts = short ? [formatMoney(c.money), formatClock(c.time)] : [formatMoney(c.money), `стан ${Math.round((1 - c.damage) * 100)}%`, `пальне ${Math.round(fuel)} л${fuel < this.tank * 0.15 ? '!' : ''}`, formatClock(c.time)];
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

export interface CareerInfo {
  order: { goods: string; units: number; town: string; arrow: string; km: number; left: number; pay: number; premium: number; integrity: number; mass: number; volume: number } | null;
  /** Без замовлення — найближчий склад. */
  near: { town: string; arrow: string; km: number } | null;
  money: number;
  truck: string;
  damage: number;
  fuel: number;
  capacity: { mass: number; volume: number };
  upgrades: string[];
  delivered: number;
  tons: number;
  driver: string;
  time: number;
}

export function formatLeft(s: number): string {
  const m = Math.ceil(s / 60);
  return m < 60 ? `${m} хв` : `${Math.floor(m / 60)} год ${m % 60} хв`;
}

/** Стрілка напрямку до цілі відносно курсу машини (8 напрямків). */
function arrowTo(forward: THREE.Vector3, to: THREE.Vector3): string {
  const a = Math.atan2(forward.x * to.z - forward.z * to.x, forward.x * to.x + forward.z * to.z);
  const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'];
  return arrows[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}
