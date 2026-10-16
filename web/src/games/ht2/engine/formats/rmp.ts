import { BinReader } from './binary';

/**
 * Архів ресурсів RMP (HT1) / RES. Послідовність секцій "<НАЗВА> <к-сть>\0".
 * Файлові секції: імʼя\0 + u32 розмір + дані. Рядкові (COLORS, MATERIALS, SOUNDS): рядки \0.
 * Див. Docs/ht1/analysis.md §2.1.
 */
export interface RmpArchive {
  palettes: Map<string, Uint8Array>;
  sounds: Map<string, Uint8Array>;
  backgrounds: Map<string, Uint8Array>;
  masks: Map<string, Uint8Array>;
  textures: Map<string, Uint8Array>;
  colors: string[];
  materials: string[];
  soundNames: string[];
  /** Порядок файлів у секціях (індекси, на які посилаються матеріали). */
  order: Record<FileSection, string[]>;
}

const FILE_SECTIONS = {
  PALETTEFILES: 'palettes',
  SOUNDFILES: 'sounds',
  BACKFILES: 'backgrounds',
  MASKFILES: 'masks',
  TEXTUREFILES: 'textures',
} as const;
type FileSection = keyof typeof FILE_SECTIONS;

export function parseRmp(bytes: Uint8Array): RmpArchive {
  const r = new BinReader(bytes);
  const a: RmpArchive = {
    palettes: new Map(),
    sounds: new Map(),
    backgrounds: new Map(),
    masks: new Map(),
    textures: new Map(),
    colors: [],
    materials: [],
    soundNames: [],
    order: { PALETTEFILES: [], SOUNDFILES: [], BACKFILES: [], MASKFILES: [], TEXTUREFILES: [] },
  };
  while (!r.eof) {
    const header = r.cstr();
    const sp = header.lastIndexOf(' ');
    const section = header.slice(0, sp);
    const count = Number(header.slice(sp + 1));
    if (!Number.isInteger(count)) throw new Error(`RMP: bad section header "${header}" @${r.pos}`);
    if (section in FILE_SECTIONS) {
      const key = section as FileSection;
      const map = a[FILE_SECTIONS[key]];
      for (let i = 0; i < count; i++) {
        // Після імені можуть іти прапорці через пробіл (напр. "sky1.txr noload").
        const name = normName(r.cstr().split(' ')[0]);
        const size = r.u32();
        map.set(name, r.bytesN(size));
        a.order[key].push(name);
      }
    } else {
      const list = section === 'COLORS' ? a.colors : section === 'MATERIALS' ? a.materials : section === 'SOUNDS' ? a.soundNames : null;
      if (!list) throw new Error(`RMP: unknown section "${section}"`);
      for (let i = 0; i < count; i++) list.push(r.cstr());
    }
  }
  return a;
}

/** Нормалізує імʼя ресурсу: нижній регістр, прямі слеші. */
export function normName(s: string): string {
  return s.replace(/\\/g, '/').toLowerCase();
}

/** Розібраний рядок матеріалу: `імʼя параметр значення ...`. */
export interface Material {
  name: string;
  /** Індекс текстури (tex/ttx/itx) у TEXTUREFILES, 1-based як у грі; 0 — немає. */
  tex: number;
  /** ttx — текстура з прозорістю (альфа-маска). */
  transparentTex: boolean;
  /** Індекс кольору в COLORS/палітрі (col), якщо немає текстури. */
  col: number | null;
  params: Record<string, number[]>;
  flags: Set<string>;
}

const ARGC: Record<string, number> = {
  reflect: 1, power: 1, col: 1, msk: 1, transp: 1, tex: 1, ttx: 1, itx: 1, rot: 1, att: 1, coord: 1,
  bumpcoord: 1, alphamirr: 1, specular: 1, RotPoint: 2, move: 2, env: 2,
};

export function parseMaterial(line: string): Material {
  const tok = line.trim().split(/\s+/);
  const m: Material = { name: tok[0], tex: 0, transparentTex: false, col: null, params: {}, flags: new Set() };
  for (let i = 1; i < tok.length; ) {
    const key = tok[i++];
    const argc = ARGC[key] ?? 0;
    if (argc === 0) {
      m.flags.add(key);
      continue;
    }
    const vals = tok.slice(i, i + argc).map(Number);
    i += argc;
    m.params[key] = vals;
    if (key === 'tex' || key === 'ttx' || key === 'itx') {
      m.tex = vals[0];
      m.transparentTex = key === 'ttx';
    } else if (key === 'col') {
      m.col = vals[0];
    }
  }
  return m;
}
