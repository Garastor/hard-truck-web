"""Перенесення модулів web/src з переписуванням імпортів (реструктуризація, Docs/09-structure-plan.md).

    python -I tools/refactor/move.py MAP.txt [--dry]

MAP.txt — рядки `старий/шлях.ts -> новий/шлях.ts` (відносно web/src; також .css, .png). Скрипт робить `git mv` і
переписує в усіх .ts web/src і web/test специфікатори імпорту (`from '…'`, `import '…'`, `import('…')`), що
вказують на перенесені файли або лежать у перенесених файлах. Між різними частинами (engine, app, games/<гра>) —
псевдоніми `@engine/…`, `@app/…`, `@ht1/…`, `@ht2/…`; усередині однієї частини — відносні шляхи.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WEB = os.path.join(ROOT, "web")
SRC = os.path.join(WEB, "src")
TEST = os.path.join(WEB, "test")
ALIASES = [("@engine/", "engine/"), ("@shared/", "shared/"), ("@app/", "app/"), ("@ht1/", "games/ht1/"), ("@ht2/", "games/ht2/")]
SPEC = re.compile(r"""((?:from|import)\s*\(?\s*)(['"])([^'"]+)\2""")
EXTS = ["", ".ts", "/index.ts"]


def norm(p):
    return os.path.normpath(p).replace("\\", "/")


def area(rel):
    """Частина проєкту для шляху відносно src (None — поза частинами, напр. main.ts)."""
    for alias, prefix in ALIASES:
        if rel.startswith(prefix):
            return alias
    return None


def resolve(spec, from_dir_rel, files):
    """Специфікатор → шлях файлу відносно src (або None — зовнішній пакет)."""
    for alias, prefix in ALIASES:
        if spec.startswith(alias):
            base = prefix + spec[len(alias):]
            break
    else:
        if not spec.startswith("."):
            return None
        base = norm(os.path.relpath(os.path.join(SRC, from_dir_rel, spec), SRC))
    for e in EXTS:
        if base + e in files:
            return base + e
    return None


def spec_for(target_rel, from_rel):
    """Специфікатор з файлу from_rel (відносно src; тест — 'test:…') на target_rel."""
    t = target_rel[:-3] if target_rel.endswith(".ts") else target_rel
    a_to = area(target_rel)
    is_test = from_rel.startswith("test:")
    a_from = None if is_test else area(from_rel)
    if a_to and (is_test or a_to != a_from):
        for alias, prefix in ALIASES:
            if alias == a_to:
                return alias + t[len(prefix):]
    from_dir = os.path.dirname(os.path.join(TEST if is_test else SRC, from_rel[5:] if is_test else from_rel))
    r = norm(os.path.relpath(os.path.join(SRC, t), from_dir))
    return r if r.startswith(".") else "./" + r


def main():
    mp = {}
    for line in open(sys.argv[1], encoding="utf-8"):
        line = line.split("#")[0].strip()
        if line:
            a, b = [x.strip() for x in line.split("->")]
            mp[a] = b
    dry = "--dry" in sys.argv
    files = set()
    for d, base in ((SRC, ""), (TEST, "test:")):
        for dp, _, fs in os.walk(d):
            for f in fs:
                files.add(base + norm(os.path.relpath(os.path.join(dp, f), d)))
    src_files = {f for f in files if not f.startswith("test:")}
    new_of = lambda f: mp.get(f, f)
    changed = 0
    for f in sorted(files):
        if not f.endswith(".ts"):
            continue
        is_test = f.startswith("test:")
        path = os.path.join(TEST, f[5:]) if is_test else os.path.join(SRC, f)
        text = open(path, encoding="utf-8").read()
        old_dir = norm(os.path.relpath(os.path.dirname(path), SRC))
        new_rel = f if is_test else new_of(f)

        def fix(m):
            spec = m.group(3)
            tgt = resolve(spec, old_dir, src_files)
            if tgt is None:
                return m.group(0)
            if tgt not in mp and f not in mp and not spec.startswith("@"):
                return m.group(0)
            s = spec_for(new_of(tgt), new_rel)
            # Розширення не-ts файлів (css, png) зберігаємо як було.
            if not tgt.endswith(".ts") and not s.endswith(os.path.splitext(tgt)[1]):
                s += os.path.splitext(tgt)[1]
            return m.group(1) + m.group(2) + s + m.group(2)

        out = SPEC.sub(fix, text)
        if out != text:
            changed += 1
            if not dry:
                open(path, "w", encoding="utf-8", newline="").write(out)
    for a, b in mp.items():
        if dry:
            print(f"mv {a} -> {b}")
            continue
        os.makedirs(os.path.dirname(os.path.join(SRC, b)), exist_ok=True)
        subprocess.run(["git", "mv", os.path.join(SRC, a), os.path.join(SRC, b)], check=True, cwd=ROOT)
    print(f"файлів з переписаними імпортами: {changed}; перенесено: {len(mp)}")


if __name__ == "__main__":
    main()
