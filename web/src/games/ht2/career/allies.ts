/**
 * Мережева кар'єра «Союзники» (власний режим порту, 2026-10-26): спільна компанія гравців. Збереження — у сервера
 * (його мережева кар'єра з позначкою `allied`): спільне — гроші, наймані водії, ліцензії, тонни, доставки, ігровий
 * час; особисте кожного союзника (машина, пошкодження, пальне, замовлення, штрафи, позиція) — у `allies[імʼя водія]`.
 * Гості свого збереження не мають: стан компанії з'являється в них зі старту й оновлюється від сервера.
 *
 * Синхронізація (net: `allyOp` гостя → сервер, `allyState` сервер → усім):
 * - гроші, тонни, доставки, заробіток — журнал приростів (AllyLedger): гість шле зміни з номером, сервер додає кожну
 *   раз (HostLedger) і розсилає підсумок із номером останньої врахованої зміни кожного гостя — у гостя підсумок плюс
 *   ще не враховані власні зміни;
 * - наймані водії й ліцензії — зміни списків (diffCompany): найняв / звільнив / купив чи витратив ліцензію; найманих
 *   симулює лише сервер (у гостей їх немає на дорогах, у F2 — список від сервера).
 * Частка ринку — одна на компанію: Σ флотів усіх союзників (наймані — один раз) ÷ (те саме + далекобійники ІІ).
 */
import type { HiredDriver } from './company';
import { newCareer, type Ht2Career } from './career';
import { RIVALS, type FleetStanding } from './share';

export type CareerKind = 'rivals' | 'allies';

/** Особисте в збереженні союзника. */
export const MEMBER_KEYS = [
  'truck', 'paint', 'damage', 'fuel', 'order', 'dents', 'trailerDents', 'trailer', 'upgrades', 'fireUsed', 'stolen', 'fines', 'pos', 'heading', 'truckPrice', 'radars', 'mapOpened',
] as const satisfies readonly (keyof Ht2Career)[];
export type AllyMember = Partial<Pick<Ht2Career, (typeof MEMBER_KEYS)[number]>>;

/** Лічильники компанії, що змінюються приростами. */
export const LEDGER_KEYS = ['money', 'tons', 'delivered', 'earned'] as const satisfies readonly (keyof Ht2Career)[];
type LedgerKey = (typeof LEDGER_KEYS)[number];
export type Amounts = Record<LedgerKey, number>;

/** Стан компанії від сервера. acks — номер останньої врахованої зміни кожного гостя. */
export interface AllyState extends Amounts {
  company: HiredDriver[];
  licences: number[];
  time: number;
  won: boolean;
  acks: Record<number, number>;
}

/** Початок спільної кар'єри (у повідомленні `start`): компанія й особисте кожного за іменем водія. */
export interface AllyStart {
  state: AllyState;
  members: Record<string, AllyMember>;
}

/** Зміна гостя: номер, прирости, найнятi й звільнені (за іменем), ліцензії додані й витрачені (строки). */
export interface AllyOp {
  seq: number;
  delta: Partial<Amounts>;
  hire: HiredDriver[];
  fire: string[];
  licAdd: number[];
  licDel: number[];
}

const amounts = (c: Partial<Ht2Career>): Amounts => ({ money: c.money ?? 0, tons: c.tons ?? 0, delivered: c.delivered ?? 0, earned: c.earned ?? 0 });

export function memberOf(c: Ht2Career): AllyMember {
  const out: AllyMember = {};
  for (const k of MEMBER_KEYS) if (c[k] !== undefined) (out as Record<string, unknown>)[k] = structuredCloneSafe(c[k]);
  return out;
}

/** Стан компанії зі збереження сервера. */
export function stateOf(c: Ht2Career, acks: Record<number, number> = {}): AllyState {
  return { ...amounts(c), company: structuredCloneSafe(c.company ?? []), licences: [...(c.licences ?? [])], time: c.time, won: !!c.won, acks: { ...acks } };
}

/**
 * Кар'єра гостя-союзника: свіжа кар'єра водія, поверх — його особисте зі збереження сервера (немає — нова машина з
 * екрана), поверх — компанія. Без id: гість її не зберігає (особисте йде серверу, AllyMember).
 */
export function allyCareer(start: AllyStart, driver: string, truck: string, paint: number): Ht2Career {
  const member = start.members[driver];
  const c: Ht2Career = { ...newCareer(driver, truck), paint, ...(member ? structuredCloneSafe(member) : {}), net: true, ally: true };
  delete c.id;
  applyState(c, start.state);
  return c;
}

/** Компанія від сервера — у кар'єру (гроші — окремо, через AllyLedger, якщо є невраховані зміни). */
export function applyState(c: Ht2Career, s: AllyState, money = s.money): void {
  c.money = money;
  c.tons = s.tons;
  c.delivered = s.delivered;
  c.earned = s.earned;
  c.company = structuredCloneSafe(s.company);
  c.licences = [...s.licences];
  c.time = s.time;
  if (s.won) c.won = true;
}

/** Що змінилось у списках компанії гостя відносно останнього стану від сервера. */
export function diffCompany(prev: Pick<AllyState, 'company' | 'licences'>, cur: Pick<Ht2Career, 'company' | 'licences'>): Pick<AllyOp, 'hire' | 'fire' | 'licAdd' | 'licDel'> {
  const was = new Set(prev.company.map((d) => d.name));
  const now = new Set((cur.company ?? []).map((d) => d.name));
  const left = [...prev.licences];
  const licAdd: number[] = [];
  for (const t of cur.licences ?? []) {
    const i = left.indexOf(t);
    if (i >= 0) left.splice(i, 1);
    else licAdd.push(t);
  }
  return {
    hire: (cur.company ?? []).filter((d) => !was.has(d.name)).map(structuredCloneSafe),
    fire: [...was].filter((n) => !now.has(n)),
    licAdd,
    licDel: left,
  };
}

/** Журнал гостя: свої зміни лічильників і списків, ще не враховані сервером. */
export class AllyLedger {
  private seq = 0;
  private pending: { seq: number; delta: Partial<Amounts> }[] = [];
  private seen: Amounts;
  private last: Pick<AllyState, 'company' | 'licences'>;

  constructor(state: AllyState) {
    this.seen = amounts(state);
    this.last = { company: state.company, licences: state.licences };
  }

  /** Зміни кар'єри з минулого разу (null — нічого). */
  collect(c: Ht2Career): AllyOp | null {
    const now = amounts(c);
    const delta: Partial<Amounts> = {};
    for (const k of LEDGER_KEYS) if (now[k] !== this.seen[k]) delta[k] = now[k] - this.seen[k];
    this.seen = now;
    const lists = diffCompany(this.last, c);
    this.last = { company: structuredCloneSafe(c.company ?? []), licences: [...(c.licences ?? [])] };
    if (!Object.keys(delta).length && !lists.hire.length && !lists.fire.length && !lists.licAdd.length && !lists.licDel.length) return null;
    const op: AllyOp = { seq: ++this.seq, delta, ...lists };
    this.pending.push({ seq: op.seq, delta });
    return op;
  }

  /**
   * Стан від сервера: усе, що він уже врахував (номер ≤ ack), — у підсумку; решта своїх приростів — поверх. Списки —
   * сервера (зміни, яких він ще не бачив, повернуться з наступним станом).
   */
  receive(c: Ht2Career, s: AllyState, myId: number): void {
    const ack = s.acks[myId] ?? 0;
    this.pending = this.pending.filter((p) => p.seq > ack);
    const extra = (k: LedgerKey) => this.pending.reduce((sum, p) => sum + (p.delta[k] ?? 0), 0);
    applyState(c, s, s.money + extra('money'));
    for (const k of ['tons', 'delivered', 'earned'] as const) c[k] = s[k] + extra(k);
    this.seen = amounts(c);
    this.last = { company: structuredCloneSafe(s.company), licences: [...s.licences] };
  }
}

/** Сервер: застосувати зміну гостя id до своєї кар'єри (кожну — раз). Повертає, чи щось змінилось. */
export function applyOp(c: Ht2Career, acks: Record<number, number>, id: number, op: AllyOp): boolean {
  if (op.seq <= (acks[id] ?? 0)) return false;
  acks[id] = op.seq;
  for (const k of LEDGER_KEYS) if (op.delta[k]) c[k] = (c[k] ?? 0) + op.delta[k]!;
  const company = (c.company ?? []).filter((d) => !op.fire.includes(d.name));
  for (const d of op.hire) if (!company.some((x) => x.name === d.name)) company.push(d);
  c.company = company;
  const lic = [...(c.licences ?? [])];
  for (const t of op.licDel) {
    // Лише та сама (строки гість має від сервера): прострочені сервер міг уже прибрати сам — тоді нічого.
    const i = lic.indexOf(t);
    if (i >= 0) lic.splice(i, 1);
  }
  c.licences = [...lic, ...op.licAdd];
  return true;
}

/**
 * Частка ринку спільної компанії: Σ вантажопідйомності всіх союзників (наймані — у стані сервера, один раз) ÷ (та сама
 * сума + вільні далекобійники ІІ). Однакова на всіх телефонах.
 */
export function alliedShare(members: readonly FleetStanding[], rivalLoad: number, rivals = RIVALS): number {
  const load = members.reduce((s, p) => s + p.load, 0);
  const hired = members.reduce((s, p) => s + p.hired, 0);
  const total = load + Math.max(0, rivals - hired) * rivalLoad;
  return total > 0 ? load / total : 0;
}

/** Найбільше гравців у мережевій кар'єрі (на прохання користувача). */
export const MAX_CAREER_PLAYERS = 5;

/**
 * Годинник доби гостя в суперництві: на скільки секунд зсунути свій час, щоб доба збігалась із сервером (у межах
 * ±12 год; дата, строки замовлень і ліцензій — свої).
 */
export function dayOffset(hostTime: number, myTime: number): number {
  const d = (((hostTime - myTime) % 86400) + 86400) % 86400;
  return d > 43200 ? d - 86400 : d;
}

function structuredCloneSafe<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}
