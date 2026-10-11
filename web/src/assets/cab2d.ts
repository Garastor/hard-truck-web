import { parseMsk, type Msk } from '../formats/msk';
import { parsePlm } from '../formats/plm';
import { parseRmp } from '../formats/rmp';
import type { FileSource } from './loader';

/**
 * 2D-кабіна (панель `panel_mask` з TRUCK.TCH, напр. msk\kam_pan.msk) — растр із програмного набору ресурсів
 * (*.RMP без «3»): порт бере на пристрій лише апаратний набір, тож маски кабін (9 штук) і її приладів (кермо
 * m_rul_01…39, цифри big/small/smallr, тахометр rpm00…16, передачі gear_r/gear00…09, autogear, park; разом ≈ 2 МБ)
 * витягуємо з COUNT.RMP під час імпорту й зберігаємо окремо (`CAB2D/<імʼя>.msk` і палітру `CAB2D/palette.plm`).
 */
export const CAB2D_SOURCE = 'COUNT/COUNT.RMP';
export const CAB2D_DIR = 'CAB2D/';
const PALETTE = `${CAB2D_DIR}palette.plm`;
const CAB2D_MASK = /^(\w+_pan|m_rul_\d\d|big\d|small\d|smallr\d|rpm\d\d|gear_r|gear\d\d|autogear|park)\.msk$/i;

/** Маски кабін і палітра з архіву програмного набору: [шлях у сховищі, байти]. */
export function extractCab2d(rmpBytes: Uint8Array): [string, Uint8Array][] {
  const rmp = parseRmp(rmpBytes);
  const out: [string, Uint8Array][] = [];
  for (const [name, bytes] of rmp.masks) {
    const base = name.split('/').pop()!;
    if (CAB2D_MASK.test(base)) out.push([`${CAB2D_DIR}${base.toLowerCase()}`, bytes]);
  }
  const plm = [...rmp.palettes.values()][0];
  if (plm) out.push([PALETTE, plm]);
  return out;
}

/** Шлях у сховищі для `panel_mask` (msk\kam_pan.msk → CAB2D/kam_pan.msk). */
export function cab2dPath(panelMask: string): string {
  return `${CAB2D_DIR}${panelMask.replace(/\\/g, '/').split('/').pop()!.toLowerCase()}`;
}

/**
 * Маски 2D-кабіни за іменами (kam_pan.msk, m_rul_01.msk…): зі сховища, інакше (dev-сервер ПК) — з COUNT.RMP із
 * записом у сховище (store). null — файлів немає (гру імпортовано до появи 2D-кабіни: потрібен повторний імпорт).
 */
export async function loadCab2d(
  src: FileSource,
  names: string[],
  store?: (name: string, data: Uint8Array) => Promise<void>,
): Promise<Map<string, Msk> | null> {
  const decode = (bytes: Map<string, Uint8Array>, plm: Uint8Array | undefined) => {
    const pal = plm ? parsePlm(plm).palette : undefined;
    const out = new Map<string, Msk>();
    for (const n of names) {
      const b = bytes.get(n.toLowerCase());
      if (!b) return null;
      out.set(n.toLowerCase(), parseMsk(b, pal));
    }
    return out;
  };
  try {
    const bytes = new Map<string, Uint8Array>();
    await Promise.all(names.map(async (n) => bytes.set(n.toLowerCase(), await src.read(`${CAB2D_DIR}${n.toLowerCase()}`))));
    return decode(bytes, await src.read(PALETTE).catch(() => undefined));
  } catch {
    try {
      const files = extractCab2d(await src.read(CAB2D_SOURCE));
      if (store) await Promise.all(files.map(([n, b]) => store(n, b).catch(() => {})));
      const bytes = new Map(files.map(([n, b]) => [n.slice(CAB2D_DIR.length), b]));
      return decode(bytes, bytes.get('palette.plm'));
    } catch {
      return null;
    }
  }
}
