"""Рядки king.exe з адресами (VA) — для пошуку імен картинок, звуків, повідомлень і класів.

    python -I tools/re/ht2/strings.py "D:/Games/Hard Truck 2/king.exe" OUT.txt [РЕГУЛЯРКА]

OUT — усі рядки ASCII ≥ 5 символів: `VA рядок` (для king.exe VA = зсув у файлі + 0x400000 — секції лежать без
зсуву; перевірено на m_16\\BackF1.txr @0x67bc58). З регуляркою — ще й друк збігів (без урахування регістру).
Корисні запити: `\\.(msk|txr)` (графіка інтерфейсу), `Sound$` (звуки), `_Car_V|_Vehicle` (фізика), `copter|Ka50`.
Порада: рядки однієї функції лежать у файлі у **зворотному** порядку використання.
"""
import re
import sys

IMAGE_BASE = 0x400000


def main() -> None:
    data = open(sys.argv[1], "rb").read()
    rows = [(m.start() + IMAGE_BASE, m.group().decode()) for m in re.finditer(rb"[\x20-\x7e]{5,}", data)]
    open(sys.argv[2], "w", encoding="utf-8").write("\n".join(f"{a:08x} {s}" for a, s in rows))
    if len(sys.argv) > 3:
        pat = re.compile(sys.argv[3], re.I)
        for a, s in rows:
            if pat.search(s):
                print(f"{a:08x} {s}")
    print(f"рядків: {len(rows)}", file=sys.stderr)


if __name__ == "__main__":
    main()
