"""Рядки mess.txt за індексом — те, що king.exe бере як FUN_005d2e50(N) (написи табло, тексти вікон, підказки).

    python -I tools/re/ht2/mess.py "D:/Games/Hard Truck 2/mess.txt" 0x59 0x5a 9 …
    python -I tools/re/ht2/mess.py "D:/Games/Hard Truck 2/mess.txt"          # усі з індексами

Індекс — порядковий номер рядка в лапках, коментарі `/* … */` не рахуються (перевірено: 0x59 «ПОЗИЦИЯ», 0x5a
«ОСТ.ВРЕМЯ», 0x65 «ЛИЦЕНЗИЙ», 9 «ПЛАТА ЗА ВЫЗОВ $%d»).
"""
import re
import sys


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    text = open(sys.argv[1], "rb").read().decode("cp1251")
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    rows = re.findall(r'"([^"]*)"', text)
    picks = [int(a, 0) for a in sys.argv[2:]] or range(len(rows))
    for i in picks:
        print(f"{i:#05x} {i:4d}  {rows[i] if i < len(rows) else '—'}")


if __name__ == "__main__":
    main()
