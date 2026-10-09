/**
 * INI-подібні текстові файли гри (truck.ini, TRUCK.TCH): [секції], ключ=значення, коментарі після ';'.
 * Ключі зберігаються як у файлі; пошук — без урахування регістру (як GetPrivateProfileString).
 */
export type Ini = Map<string, Map<string, string>>;

export function parseIni(text: string): Ini {
  const ini: Ini = new Map();
  let cur = new Map<string, string>();
  ini.set('', cur);
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/;.*$/, '').trim();
    if (!line) continue;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      cur = ini.get(sec[1].toLowerCase()) ?? new Map();
      ini.set(sec[1].toLowerCase(), cur);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    cur.set(line.slice(0, eq).trim().toLowerCase(), line.slice(eq + 1).trim());
  }
  return ini;
}

export function iniGet(ini: Ini, section: string, key: string): string | undefined {
  return ini.get(section.toLowerCase())?.get(key.toLowerCase());
}

export function iniNum(ini: Ini, section: string, key: string, def: number): number {
  const v = iniGet(ini, section, key);
  if (v === undefined) return def;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : def;
}

export function iniNums(ini: Ini, section: string, key: string): number[] | undefined {
  const v = iniGet(ini, section, key);
  return v?.split(/[\s,]+/).filter(Boolean).map(Number);
}
