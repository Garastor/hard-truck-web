import * as THREE from 'three';
import { isList, num, str, type SExpr } from '../formats/sexpr';
import { drivable, type Ht2Trucks } from '../vehicles/trucks';
import { toThree } from '../world/world';
import type { Markets } from './market';

/**
 * Замовлення машини рацією — king.exe 0x433660 / orderVehicle 0x433b60, вікно `BackF5tru` (re/notes/ht2/company.md §1):
 * - у мафії (`F5m_ask3`; відмова при боргу чи інтересі мафії) і в продавця / водія звичайного трафіку (`F5n_ask2`);
 * - 27 моделей (стрілки `F5tr_l/r`), колір 1–4 (`F5tr_col`) — кластер фарбування; фото `m16\<Модель><колір>.msk`;
 * - машину приганяють одразу на місце-місто (прапорець 4) найближчого ринку далі 500 м від абонента як звичайну
 *   машину на продаж; купується за повну ціну, наперед — лише плата за доставку;
 * - плата: у продавця — N · 300 $ (N — останнє число `parking` ринку), у мафії — 6600 + 0,66 · d (d — до ближчої з
 *   точок (−1720; 3950) і (−3000; −4715), 0x433240); гроші знімаються одразу;
 * - мафія в 30 % бере гроші й нічого не приганяє, інакше машина крадена (× 0,45); повідомлень немає.
 *
 * Гіпотези порту: асортимент продавця (у king.exe не знайдено, хто його заповнює) — будь-яка модель, яку порт може
 * водити (вантажівки й тягачі); легкових (BmwM5, Patrol, Toyota, Cayman) і моделей без запису в vehicle.tech вікно
 * пропускає, як модель «немає в продавця».
 */
export const ORDER_MODELS = [
  'Daf', 'Freightliner', 'International', 'Kamaz', 'Kenworth', 'Mack', 'Mercedes', 'Peterbilt', 'Renault', 'Scania', 'Storm', 'Volvo', 'Zil',
  'DafR', 'Sobol', 'KamazR', 'MercedesR', 'RenaultR', 'ScaniaR', 'StormR', 'VolvoR', 'ZilR', 'BmwM5', 'Patrol', 'Gazelle', 'Toyota', 'Cayman',
] as const;

/** Точки, від яких мафія рахує плату (0x433240; друга — стоянка dumb_ap; гіпотеза — бази мафії). */
const MAFIA_BASES = [toThree(-1720, 3950, 3), toThree(-3000, -4715, 20)];
const MAFIA_FEE = 6600;
const MAFIA_PER_M = 0.66;
const DEALER_PER_N = 300;
/** Мафія «кидає» з імовірністю 1 − 0,7 (DAT_0066c788). */
const MAFIA_HONEST = 0.7;

export interface VehicleOffer {
  /** Імʼя фото (без номера кольору) і car_node моделі. */
  model: string;
  name: string;
  power: number;
  /** Вантажопідйомність, т. */
  capacity: number;
  fee: number;
  town: string;
}

/** Потужність моделей з evehicles.sch: `(vehicle ID "Модель" колір клас ШІ ціна потужність …)`. */
export function vehiclePowers(sch: SExpr[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of sch) if (isList(e) && e[0] === 'vehicle' && !out.has(str(e[2]))) out.set(str(e[2]), num(e[7]));
  return out;
}

/** Що можна замовити в абонента (kind: мафія чи продавець/водій) у точці from; null — нікуди пригнати. */
export function vehicleOffers(kind: 'maf' | 'nei', from: THREE.Vector3, markets: Markets, trucks: Ht2Trucks, powers: Map<string, number>): VehicleOffer[] | null {
  const to = markets.deliveryFor(from);
  if (!to) return null;
  const fee =
    kind === 'maf'
      ? Math.round(MAFIA_FEE + MAFIA_PER_M * Math.min(...MAFIA_BASES.map((b) => Math.hypot(b.x - from.x, b.z - from.z))))
      : (markets.nearest(from)?.fee ?? 4) * DEALER_PER_N;
  const ok = new Set(drivable(trucks).map((r) => r.carNode));
  return ORDER_MODELS.filter((m) => ok.has(m)).map((model) => {
    const rec = trucks.records.find((r) => r.carNode === model)!;
    return { model, name: model.toUpperCase(), power: powers.get(model) ?? rec.horsePower, capacity: Math.round(rec.cargoLoad / 1000), fee, town: to.town || to.name };
  });
}

/**
 * Замовити: плата знімається одразу (без перевірки — може піти в мінус, як у king.exe); мафія в 30 % — нічого,
 * інакше машина крадена. Повертає, чи машину пригнали (гравцю це не повідомляють).
 */
export function orderVehicle(kind: 'maf' | 'nei', from: THREE.Vector3, offer: VehicleOffer, color: number, markets: Markets, wallet: { money: number }, rnd = Math.random): boolean {
  wallet.money -= offer.fee;
  if (kind === 'maf' && rnd() >= MAFIA_HONEST) return false;
  const to = markets.deliveryFor(from);
  if (!to) return false;
  markets.deliver(to, { carNode: offer.model, cluster: color, stolen: kind === 'maf' });
  return true;
}
