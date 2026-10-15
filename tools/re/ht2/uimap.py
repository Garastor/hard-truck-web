"""Карта графіки інтерфейсу king.exe: яка функція завантажує яку картинку чи кнопку і де її ставить.

    python -I tools/re/ht2/uimap.py re/decomp_king NAMES.txt OUT.txt

re/decomp_king — декомпіляція (`GQ_GAME=ht2 .venv/Scripts/python -I tools/re/gq.py exportall re/decomp_king`).
NAMES.txt — базові імена картинок, по одному в рядку (з вивантаження RES: імʼя файлу без теки, розширення й
кінцівки стану `_a/_ap/_p/_pp/_f/_n/_ok/_ph`).

Шукає рядки Ghidra `s_<текст>_<адреса>` — імена картинок (`…_txr`, `…_msk`) і кнопок, — та присвоєння позиції віджета
`(X + 0x2c) = x`, `(X + 0x30) = y`, що йдуть за ними. Виклик-конструктор кнопки — у `<…>`: 0x50def0 — кнопка з
картинок `_a/_p/_ap/_f`, 0x50d1c0 / 0x50d530 — прапорець (`_pp`, `_n` / `_ok`), 0x50d860 — повзунок.

Обмеження: де Ghidra не відновив аргументи (x87, push через регістр — напр. 8 фонів F-панелей у 0x56e5a0), імена
не видно — дивитись `gq.py disasm` (PUSH 0x67…) і зіставляти з адресами рядків (`strings.py`).
"""
import os
import re
import sys

STR = re.compile(r"\bs_([A-Za-z0-9_%]+?)_([0-9a-f]{8})\b")
POS = re.compile(r"\(\w+ \+ 0x(2c|30)\) = (-?0x[0-9a-f]+|-?\d+);")
CALL = re.compile(r"(FUN_[0-9a-f]{8})\(\s*s_")


def main() -> None:
    decomp, names, out_path = sys.argv[1:4]
    base = set(open(names, encoding="utf-8").read().lower().split())
    out = []
    for fn in sorted(os.listdir(decomp)):
        if not fn.endswith(".c"):
            continue
        src = open(os.path.join(decomp, fn), encoding="utf-8", errors="replace").read()
        ev = []
        for line in src.splitlines():
            for m in STR.finditer(line):
                t = m.group(1)
                low = t.lower()
                img = re.search(r"(txr|msk)$", low)
                tail = re.sub(r"_(txr|msk)$", "", re.sub(r"^(m_?1[56]_|_s_|_s)", "", low))
                if img or tail in base or low in base:
                    c = CALL.search(line)
                    ev.append(f"{'IMG' if img else 'BTN'} {t}" + (f" <{c.group(1)}>" if c and not img else ""))
            for m in POS.finditer(line):
                v = int(m.group(2), 0) if "x" in m.group(2) else int(m.group(2))
                if v >= 0x80000000:
                    v -= 1 << 32
                ev.append(("x=" if m.group(1) == "2c" else "y=") + str(v))
        if not any(e.startswith(("IMG", "BTN")) for e in ev):
            continue
        lines, cur = [], None
        for e in ev:
            if e.startswith(("x=", "y=")):
                if cur is not None:
                    lines[cur] += " " + e
                continue
            lines.append(e)
            cur = len(lines) - 1
        out.append(f"## {fn[:-2]}\n" + "\n".join("  " + x for x in lines))
    open(out_path, "w", encoding="utf-8").write("\n".join(out))
    print(f"функцій з графікою: {len(out)} → {out_path}")


if __name__ == "__main__":
    main()
