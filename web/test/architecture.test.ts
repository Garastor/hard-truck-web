/**
 * Правила структури коду (Docs/09-structure-plan.md): ігри розділені повністю — кожна має свій рушій у своїй теці й
 * не імпортує іншу; спільний лише контракт запуску shared/ (GameModule, сховище файлів), який не знає ні про ігри, ні
 * про оболонку; оболонка app/ бере гру лише через її games/<гра>/index.ts і не читає форматів ігор.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(import.meta.dirname, '..', 'src');
const ALIASES: Record<string, string> = { '@engine/': 'engine/', '@shared/': 'shared/', '@app/': 'app/', '@ht1/': 'games/ht1/', '@ht2/': 'games/ht2/' };

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
  });
}

/** Шлях відносно src/ із прямими скісними. */
const rel = (p: string) => relative(SRC, p).replace(/\\/g, '/');

/** Частина: shared, app, games/<гра>, engine (тимчасово, до розділення) або '' (поза частинами). */
function part(path: string): string {
  const m = /^(shared|app|engine|games\/[^/]+)\//.exec(path);
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
/** Порушення: імпорти файлів частини `from`, ціль яких не в дозволених частинах. */
const violations = (from: (p: string) => boolean, allowed: (target: string, own: string) => boolean) =>
  all
    .filter((f) => from(part(f.path)))
    .flatMap((f) => imports(f.file).filter((i) => part(i.target) !== '' && !allowed(i.target, part(f.path))).map((i) => `${f.path} → ${i.spec}`));

describe('Структура коду', () => {
  it('усі модулі — в shared/, app/ або games/<гра>/', () => {
    expect(all.filter((f) => !part(f.path)).map((f) => f.path)).toEqual([]);
  });

  it('shared/ нічого не імпортує з ігор, оболонки й рушія', () => {
    expect(violations((p) => p === 'shared', (t) => part(t) === 'shared')).toEqual([]);
  });

  it('у shared/ немає ідентифікаторів ігор і їхніх тек dev-сервера', () => {
    const bad = all
      .filter((f) => part(f.path) === 'shared')
      .filter((f) => /['"`](ht[0-9]+|\/game[0-9]*\/)['"`]/.test(code(readFileSync(f.file, 'utf8'))))
      .map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it('ігри не імпортують одна одну й оболонку (лише свою теку й shared/)', () => {
    expect(violations((p) => p.startsWith('games/'), (t, own) => [own, 'shared', 'engine'].includes(part(t)))).toEqual([]);
  });

  it('оболонка — без рушія; гру бере лише через games/<гра>/index.ts', () => {
    expect(violations((p) => p === 'app', (t) => ['app', 'shared'].includes(part(t)) || /^games\/[^/]+\/index(\.ts)?$/.test(t))).toEqual([]);
  });
});
