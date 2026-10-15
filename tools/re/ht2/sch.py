"""Розшифровка SDTE (`*.sch`, `GAME.CNF` Дальнобойщиків 2) у текст cp1251 → UTF-8.

    python -I tools/re/ht2/sch.py OUT_DIR "D:/Games/Hard Truck 2/Ms.sch" "D:/Games/Hard Truck 2/ENV/*.sch" …

Шифр і початковий стан генератора — з web/src/games/ht2/formats/sdte.ts (напрацювання спільноти AlexKimov, MIT).
Незашифровані файли копіюються як є. Імʼя виходу: `<тека>_<файл>.txt`, щоб ENV/GAME.CNF і MENV/GAME.CNF не
затирали одне одного. Лише читає файли гри.
"""
import glob
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SDTE_TS = os.path.join(ROOT, "web", "src", "games", "ht2", "formats", "sdte.ts")
SEED = [int(x, 16) for x in re.findall(r"0x[0-9a-f]{8}", open(SDTE_TS, encoding="utf-8").read())]


def decode(b: bytes) -> bytes:
    if b[:4] != b"SDTE":
        return b
    t = list(SEED)
    c, z = 0, 31
    out = bytearray(len(b) - 4)
    for i in range(len(out)):
        k = (t[c] - t[z]) & 0xFFFFFFFF
        t[c] = k
        out[i] = b[i + 4] ^ (k & 0xFF)
        c = (c + 1) % 55
        z = (z + 1) % 55
    return bytes(out)


def main() -> None:
    out_dir = sys.argv[1]
    os.makedirs(out_dir, exist_ok=True)
    n = 0
    for pattern in sys.argv[2:]:
        for path in glob.glob(pattern):
            name = f"{os.path.basename(os.path.dirname(path))}_{os.path.basename(path)}.txt"
            text = decode(open(path, "rb").read()).decode("cp1251", errors="replace")
            open(os.path.join(out_dir, name), "w", encoding="utf-8").write(text)
            n += 1
    print(f"розшифровано: {n}")


if __name__ == "__main__":
    main()
