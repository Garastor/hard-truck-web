import { isList, num, type SExpr } from '@engine/formats/sexpr';

/**
 * Покращення вантажівки HT2 (`restable.sch`): `(PR_ID (Назва-без 0) (Назва варіанта ціна) …)` — перший варіант —
 * «немає» за 0, далі варіанти з ціною (у шин — два: шосейні й позашляхові). Назви англійські й без лапок (слова —
 * окремі символи), останнє число — ціна, $.
 *
 * Що саме дає кожне покращення, у даних гри не записано (і в реконструкції ht2-rev не знайдено) — ефекти нижче
 * гіпотези порту. У СТО продаються лише ті, що мають дію в порту; решта (ABS, підвіска, моторне гальмо,
 * куленепробивне скло, навігатор, сканер, сигнал, протипожежна система, фарба-«невидимка», захист фар, шноркель)
 * чекають на відповідні системи гри (мафія, погода, бездоріжжя).
 */
export interface Upgrade {
  /** `PR_ID:варіант` — ключ у збереженні. */
  key: string;
  id: string;
  option: number;
  /** Назва з restable.sch (англ.). */
  original: string;
  name: string;
  effect: string;
  price: number;
}

/** Покращення з дією в порту: назва українською й опис дії (гіпотеза). */
const KNOWN: Record<string, { name: string; effect: string }> = {
  'PR_FORCED_ENGINE:1': { name: 'Форсований двигун', effect: 'момент двигуна +20 %' },
  'PR_BRAKES:1': { name: 'Вентильовані гальма', effect: 'гальма сильніші на 30 %' },
  'PR_REINFORCED_CHASSIS:1': { name: 'Посилена рама', effect: 'пошкодження від ударів −40 %' },
  'PR_EXTRA_TANK:1': { name: 'Додатковий бак', effect: 'бак +50 %' },
  'PR_TIRES:1': { name: 'Шосейні шини', effect: 'зчеплення +8 %' },
  'PR_ANTI_RADAR:1': { name: 'Антирадар', effect: 'поліція не штрафує за швидкість' },
};

export function parseUpgrades(sch: SExpr[]): Upgrade[] {
  const out: Upgrade[] = [];
  for (const e of sch) {
    if (!isList(e) || typeof e[0] !== 'string') continue;
    const id = e[0];
    e.slice(1).forEach((opt, i) => {
      if (!isList(opt) || !opt.length) return;
      const key = `${id}:${i}`;
      const known = KNOWN[key];
      const price = num(opt[opt.length - 1]);
      if (!known || price <= 0) return;
      const original = opt.slice(0, -1).map(String).join(' ');
      out.push({ key, id, option: i, original, name: known.name, effect: known.effect, price });
    });
  }
  return out;
}

/** Дія встановлених покращень на машину й кар'єру. */
export interface Tuning {
  torque: number;
  brakes: number;
  grip: number;
  tank: number;
  damage: number;
  antiRadar: boolean;
}

export function tuning(owned: readonly string[] = []): Tuning {
  const has = (k: string) => owned.includes(k);
  return {
    torque: has('PR_FORCED_ENGINE:1') ? 1.2 : 1,
    brakes: has('PR_BRAKES:1') ? 1.3 : 1,
    grip: has('PR_TIRES:1') ? 1.08 : 1,
    tank: has('PR_EXTRA_TANK:1') ? 1.5 : 1,
    damage: has('PR_REINFORCED_CHASSIS:1') ? 0.6 : 1,
    antiRadar: has('PR_ANTI_RADAR:1'),
  };
}

/** Купівля: варіанти одного покращення взаємовиключні (шини), повторно той самий — ні. */
export function install(owned: readonly string[], u: Upgrade): string[] {
  return [...owned.filter((k) => !k.startsWith(`${u.id}:`)), u.key];
}
