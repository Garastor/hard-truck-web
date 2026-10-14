"""Перенесення документів і нотаток з переписуванням посилань на них (реструктуризація, Docs/09-structure-plan.md).

    python -I tools/refactor/move_docs.py MAP.txt [--dry]

MAP.txt — рядки `старий/шлях.md -> новий/шлях.md` (від кореня репозиторію). Скрипт робить `git mv` і переписує в
.md/.ts/.py/.json/.html репозиторію згадки перенесених файлів: від кореня (`Docs/04-roadmap.md`) — від кореня,
відносні (markdown-посилання, `../re/notes/…`) — відносно нового місця файлу, що посилається.
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SKIP = {".git", "node_modules", "Game", "dist", ".worktrees", "re/htruck", "re/king", "re/decomp", "re/telemetry", "tools/refactor"}
EXT = (".md", ".ts", ".py", ".json", ".html")


def norm(p):
    return os.path.normpath(p).replace("\\", "/")


def main():
    mp = {}
    for line in open(sys.argv[1], encoding="utf-8"):
        line = line.split("#")[0].strip()
        if line:
            a, b = [x.strip() for x in line.split("->")]
            mp[a] = b
    dry = "--dry" in sys.argv
    names = sorted({os.path.basename(a) for a in mp}, key=len, reverse=True)
    pat = re.compile(r"[\w./-]*(?:" + "|".join(re.escape(n) for n in names) + r")")
    texts = []
    for dp, dns, fs in os.walk(ROOT):
        rel_dp = norm(os.path.relpath(dp, ROOT))
        dns[:] = [d for d in dns if d not in SKIP and norm(os.path.join(rel_dp, d)).lstrip("./") not in SKIP]
        for f in fs:
            if f.endswith(EXT):
                texts.append(norm(os.path.relpath(os.path.join(dp, f), ROOT)))
    changed = 0
    for f in texts:
        path = os.path.join(ROOT, f)
        text = open(path, encoding="utf-8").read()
        new_f = mp.get(f, f)

        def fix(m):
            ref = m.group(0)
            core = ref.lstrip("./") if ref.startswith("./") else ref
            # Від кореня.
            if core in mp:
                return ref[: len(ref) - len(core)] + mp[core]
            # Відносно файлу.
            target = norm(os.path.join(os.path.dirname(f), ref))
            if target in mp:
                r = norm(os.path.relpath(mp[target], os.path.dirname(new_f) or "."))
                return r
            # Файл, що посилається, переїхав, а ціль — ні: відносне посилання на неперенесений файл.
            return ref

        out = pat.sub(fix, text)
        # Відносні посилання з перенесених файлів на неперенесені (markdown-посилання).
        if f in mp:
            def fix_rel(m):
                link = m.group(2)
                if re.match(r"^[a-z]+:|^#|^/", link):
                    return m.group(0)
                tgt = norm(os.path.join(os.path.dirname(f), link.split("#")[0]))
                if tgt in mp.values() or not os.path.exists(os.path.join(ROOT, tgt)):
                    return m.group(0)
                anchor = "#" + link.split("#", 1)[1] if "#" in link else ""
                return m.group(1) + norm(os.path.relpath(tgt, os.path.dirname(new_f) or ".")) + anchor + ")"
            out = re.sub(r"(\]\()([^)\s]+)\)", fix_rel, out)
        if out != text:
            changed += 1
            if not dry:
                open(path, "w", encoding="utf-8", newline="").write(out)
            else:
                print("edit", f)
    for a, b in mp.items():
        if dry:
            print(f"mv {a} -> {b}")
            continue
        os.makedirs(os.path.dirname(os.path.join(ROOT, b)), exist_ok=True)
        subprocess.run(["git", "mv", a, b], check=True, cwd=ROOT)
    print(f"файлів з переписаними посиланнями: {changed}; перенесено: {len(mp)}")


if __name__ == "__main__":
    main()
