import { decodeCp1251 } from '@engine/formats/binary';
import { decodeSdte } from './sdte';

/**
 * Скрипти й конфіги Дальнобойщиків 2 (`*.sch`, `GAME.CNF` після розшифрування SDTE) — S-вирази:
 * `( vehicle FIAT_1 "Fiat" 0 car dumb 32000 408 ())`, коментарі `;` до кінця рядка, пари `( A . "текст" )`.
 * Атоми: числа → number, рядки в лапках → {@link SStr}, решта (зокрема «.») — символи (string).
 */
export class SStr {
  constructor(readonly s: string) {}
  toString(): string {
    return this.s;
  }
}
export type SExpr = string | number | SStr | SExpr[];

const NUM = /^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i;

export function parseSexpr(text: string): SExpr[] {
  const root: SExpr[] = [];
  const stack: SExpr[][] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === ';') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '(') {
      const l: SExpr[] = [];
      stack[stack.length - 1].push(l);
      stack.push(l);
      i++;
    } else if (ch === ')') {
      if (stack.length === 1) throw new Error(`S-вираз: зайва ")" @${i}`);
      stack.pop();
      i++;
    } else if (ch === '"') {
      const end = text.indexOf('"', i + 1);
      if (end < 0) throw new Error(`S-вираз: незакритий рядок @${i}`);
      stack[stack.length - 1].push(new SStr(text.slice(i + 1, end)));
      i = end + 1;
    } else if (ch <= ' ') {
      i++;
    } else {
      let j = i;
      while (j < n && text[j] > ' ' && text[j] !== '(' && text[j] !== ')' && text[j] !== ';' && text[j] !== '"') j++;
      const tok = text.slice(i, j);
      stack[stack.length - 1].push(NUM.test(tok) ? Number(tok) : tok);
      i = j;
    }
  }
  if (stack.length !== 1) throw new Error(`S-вираз: бракує ${stack.length - 1} ")"`);
  return root;
}

/** Файл SCH/CNF (зашифрований чи ні) → список верхнього рівня. Зазвичай файл — один список, повертаємо його. */
export function readSch(bytes: Uint8Array): SExpr[] {
  const top = parseSexpr(decodeCp1251(decodeSdte(bytes)));
  return top.length === 1 && Array.isArray(top[0]) ? top[0] : top;
}

export const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e);
export const str = (e: SExpr | undefined): string => (e instanceof SStr ? e.s : typeof e === 'string' ? e : String(e ?? ''));
export const num = (e: SExpr | undefined, def = 0): number => (typeof e === 'number' ? e : def);

/** Перший підсписок з головою `key`: `(key …)`. */
export function assoc(list: SExpr[], key: string): SExpr[] | undefined {
  return list.find((e): e is SExpr[] => isList(e) && e[0] === key);
}
