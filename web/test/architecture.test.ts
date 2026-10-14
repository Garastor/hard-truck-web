/**
 * Правила структури коду (Docs/09-structure-plan.md): спільний рушій engine/ не знає про ігри й оболонку, ігри не
 * імпортують одна одну, оболонка app/ бере гру лише через її games/<гра>/index.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');
const ALIASES: Record<string, string> = { '@engine/': 'engine/', '@app/': 'app/', '@ht1/': 'games/ht1/', '@ht2/': 'games/ht2/' };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Шлях відносно src/ із прямими скісними. */
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/** Частина: engine, app, games/<гра> або '' (поза частинами). */
function part(path: string): string {
  const m = /^(engine|app|games\/[^/]+)\//.exec(path);
  return m ? m[1] : '';
}

/** Код без коментарів (щоб згадки в документації не рахувались). */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Імпорти файлу: специфікатор → шлях цілі відносно src (зовнішні пакети — пропускаємо). */
function imports(file: string): { spec: string; target: string }[] {
  const out: { spec: string; target: string }[] = [];
  for (const m of code(readFileSync(file, 'utf8')).matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1];
    const alias = Object.keys(ALIASES).find((a) => spec.startsWith(a));
    if (alias) out.push({ spec, target: ALIASES[alias] + spec.slice(alias.length) });
    else if (spec.startsWith('.')) out.push({ spec, target: rel(resolve(dirname(file), spec)) });
  }
  return out;
}

const all = files(SRC).map((f) => ({ path: rel(f), file: f }));

describe('Структура коду', () => {
  it('усі модулі — в engine/, app/ або games/<гра>/', () => {
    expect(all.filter((f) => !part(f.path)).map((f) => f.path)).toEqual([]);
  });

  it('engine/ не імпортує ігор і оболонки', () => {
    const bad = all
      .filter((f) => part(f.path) === 'engine')
      .flatMap((f) => imports(f.file).filter((i) => part(i.target) !== 'engine' && part(i.target) !== '').map((i) => `${f.path} → ${i.spec}`));
    expect(bad).toEqual([]);
  });

  it('у коді engine/ немає ідентифікаторів ігор і їхніх тек dev-сервера', () => {
    const bad = all
      .filter((f) => part(f.path) === 'engine')
      .filter((f) => /['"`](ht[0-9]+|\/game[0-9]*\/)['"`]/.test(code(readFileSync(f.file, 'utf8'))))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('ігри не імпортують одна одну й оболонку', () => {
    const bad = all
      .filter((f) => part(f.path).startsWith('games/'))
      .flatMap((f) => imports(f.file).filter((i) => part(i.target) !== part(f.path) && part(i.target) !== 'engine').map((i) => `${f.path} → ${i.spec}`));
    expect(bad).toEqual([]);
  });

  it('оболонка бере гру лише через games/<гра>/index.ts', () => {
    const bad = all
      .filter((f) => part(f.path) === 'app')
      .flatMap((f) => imports(f.file).filter((i) => part(i.target).startsWith('games/') && !/^games\/[^/]+\/index(\.ts)?$/.test(i.target)).map((i) => `${f.path} → ${i.spec}`));
    expect(bad).toEqual([]);
  });
});
