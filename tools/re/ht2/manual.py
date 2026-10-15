"""Офіційний посібник гри king.chm → текст із розділами й посиланнями на знімки.

    python -I tools/re/ht2/manual.py "D:/Games/Hard Truck 2/king.chm" OUT_DIR

Розпаковує CHM системним `hh.exe -decompile` (Windows) в OUT_DIR, далі зводить сторінки за змістом `king.hhc` у
OUT_DIR/manual.txt (25 розділів: керування, табло, заказы, сервис, заправка, найм, рація, «проблемы в пути»…).
Знімки — OUT_DIR/images/bm*.gif (у тексті — `[IMG …]`). Лише читає файли гри; результат — поза git.
"""
import html
import os
import re
import subprocess
import sys


def read(path: str) -> str:
    b = open(path, "rb").read()
    try:
        return b.decode("utf-8")
    except UnicodeDecodeError:
        return b.decode("cp1251")


def main() -> None:
    chm, out = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
    os.makedirs(out, exist_ok=True)
    subprocess.run(["hh.exe", "-decompile", out, chm], check=False)
    toc = read(os.path.join(out, "king.hhc"))
    items = re.findall(r'name="Name" value="([^"]*)".*?name="Local" value="([^"]*)"', toc, re.S)
    parts = []
    for name, loc in items:
        t = read(os.path.join(out, loc.replace("/", os.sep)))
        t = re.sub(r'<img[^>]*src="([^"]*)"[^>]*>', lambda m: f" [IMG {m.group(1)}] ", t, flags=re.I)
        t = re.sub(r"<(br|p|tr|li|h\d)[^>]*>", "\n", t, flags=re.I)
        t = html.unescape(re.sub(r"<[^>]+>", "", t))
        t = re.sub(r"\n\s*\n+", "\n", re.sub(r"[ \t\r]+", " ", t))
        parts.append(f"##### {name} ({loc})\n{t.strip()}\n")
    open(os.path.join(out, "manual.txt"), "w", encoding="utf-8").write("\n".join(parts))
    print(f"розділів: {len(items)} → {os.path.join(out, 'manual.txt')}")


if __name__ == "__main__":
    main()
