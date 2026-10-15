import { parseMsk, type Msk } from '../engine/formats/msk';
import { parsePlm } from '../engine/formats/plm';
import { parseRmp } from '../engine/formats/rmp';
import { parseTxr } from '../engine/formats/txr';
import type { RgbaImage } from '../engine/formats/binary';
import type { FileSource } from '@shared/source';

/**
 * 2D-кабіна (панель `panel_mask` з TRUCK.TCH, напр. msk\kam_pan.msk) — растр із програмного набору ресурсів
 * (*.RMP без «3»): порт бере на пристрій лише апаратний набір, тож маски кабін (9 штук) і її приладів (кермо
 * m_rul_01…39, цифри big/small/smallr, тахометр rpm00…16, передачі gear_r/gear00…09, autogear, park; разом ≈ 2 МБ)
 * витягуємо з COUNT.RMP під час імпорту й зберігаємо окремо (`CAB2D/<імʼя>.msk` і палітру `CAB2D/palette.plm`).
 * Там же дощ 2D-кабіни: краплі `msk\drop7.msk`, `drop10.msk`, смуги `rain.msk` і текстура лопатей двірників
 * `txr\flash.txr` (матеріал `wiper ttx 1` — перша текстура набору; render/cab2dRain.ts).
 */
export const CAB2D_SOURCE = 'COUNT/COUNT.RMP';
export const CAB2D_DIR = 'CAB2D/';
const PALETTE = `${CAB2D_DIR}palette.plm`;
const CAB2D_MASK = /^(\w+_pan|m_rul_\d\d|big\d|small\d|smallr\d|rpm\d\d|gear_r|gear\d\d|autogear|park|drop7|drop10|rain)\.msk$/i;

/** «Палітра» значень: запис i = (i, i, i). */
const IDENTITY = new Uint8Array(768).map((_, i) => Math.floor(i / 3));

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
  const wiper = rmp.textures.get(`txr/${WIPER_TXR}`);
  if (wiper) out.push([`${CAB2D_DIR}${WIPER_TXR}`, wiper]);
  return out;
}

/** Текстура лопатей двірників 2D-кабіни (програмний набір). */
export const WIPER_TXR = 'flash.txr';

/**
 * Файли дощу 2D-кабіни, що зʼявились у порті пізніше за маски кабіни: на пристрої, імпортованому раніше, їх немає
 * (COUNT.RMP на пристрої не зберігається) — «Опції» показують неповний набір, кабіна підказує повторний імпорт.
 */
export const CAB2D_RAIN_FILES = ['drop7.msk', 'drop10.msk', 'rain.msk', WIPER_TXR].map((n) => `${CAB2D_DIR}${n}`);

/**
 * Текстура програмного набору (CAB2D/<імʼя>.txr): зі сховища, інакше (dev-сервер ПК) — з COUNT.RMP із записом у
 * сховище. null — немає (імпорт до появи цієї текстури: потрібен повторний).
 */
export async function loadCab2dTexture(
  src: FileSource,
  name: string,
  store?: (name: string, data: Uint8Array) => Promise<void>,
): Promise<RgbaImage | null> {
  const path = `${CAB2D_DIR}${name}`;
  try {
    return parseTxr(await src.read(path));
  } catch {
    try {
      const files = extractCab2d(await src.read(CAB2D_SOURCE));
      if (store) await Promise.all(files.map(([n, b]) => store(n, b).catch(() => {})));
      const f = files.find(([n]) => n === path);
      return f ? parseTxr(f[1]) : null;
    } catch {
      return null;
    }
  }
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
  raw = false,
): Promise<Map<string, Msk> | null> {
  const decode = (bytes: Map<string, Uint8Array>, plm: Uint8Array | undefined) => {
    // raw — значення пікселів без палітри (у червоному каналі): краплі дощу — це рівні прозорості, не кольори.
    const pal = raw ? IDENTITY : plm ? parsePlm(plm).palette : undefined;
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
