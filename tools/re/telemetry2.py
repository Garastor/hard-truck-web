"""Телеметрія запущеного king.exe (Дальнобойщики 2): лише ЧИТАННЯ памʼяті процесу, як tools/re/telemetry.py.

Обʼєкт машини шукаємо за копією полів запису vehicle.tech (маса, радіус колеса ×2, бак, час на пальному —
зсув +0x60 запису, як у TRUCK.TCH першої гри).

    python -I tools/re/telemetry2.py find [ІМʼЯ]            # копії запису машини (ZilR, Zil…) у памʼяті
    python -I tools/re/telemetry2.py dump ADDR [SIZE]       # поля як float/int (з telemetry.py)
    python -I tools/re/telemetry2.py record ADDR SECS OUT.csv [--size N] [--hz 20]
    python -I tools/re/telemetry2.py analyze OUT.csv
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

GAME = r"D:\Games\Hard Truck 2"
REC = 2416
PAT_OFF, PAT_LEN = 0x60, 0x14

_find = T.find_pid
T.find_pid = lambda name=b"king.exe": _find(name)


def tech_records():
    """(імʼя car_node, байти запису) з vehicle.tech гри."""
    b = open(os.path.join(GAME, "vehicle.tech"), "rb").read()
    n = struct.unpack_from("<I", b, 0)[0]
    pos = 4 + n + 4
    size, count = struct.unpack_from("<II", b, pos)
    pos += 8 + 28
    assert size == REC
    out = []
    for i in range(count):
        rec = b[pos + i * REC : pos + (i + 1) * REC]
        names = [s.decode("latin-1") for s in rec.split(b"\0") if len(s) >= 3 and all(32 <= c < 127 for c in s)]
        out.append((names, rec))
    return out


def cmd_find(p, want):
    recs = [(names, rec) for names, rec in tech_records() if any(want.lower() == x.lower() for x in names)]
    if not recs:
        sys.exit(f"немає запису з імʼям {want}")
    for names, rec in recs:
        pat = rec[PAT_OFF : PAT_OFF + PAT_LEN]
        mass, rw = struct.unpack_from("<2f", pat)
        print(f"{'/'.join(names[:4])}: mass={mass:g} rwheel={rw:g}")
        hits = []
        for base, data in p.chunks():
            start = 0
            while True:
                k = data.find(pat, start)
                if k < 0:
                    break
                hits.append(base + k)
                start = k + 4
        for a in sorted(set(hits)):
            whole = p.read(a - PAT_OFF, REC)
            kind = "повний запис (таблиця)" if whole == rec else "копія полів (обʼєкт?)"
            print(f"  0x{a:08x}  {kind}")


def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    p = T.Proc()
    if a[0] == "find":
        cmd_find(p, a[1] if len(a) > 1 else "ZilR")
    elif a[0] == "dump":
        T.cmd_dump(p, int(a[1], 16), int(a[2], 0) if len(a) > 2 else 0x400)
    elif a[0] == "record":
        size = int(a[a.index("--size") + 1], 0) if "--size" in a else 0x1000
        hz = float(a[a.index("--hz") + 1]) if "--hz" in a else 20
        T.cmd_record(p, int(a[1], 16), float(a[2]), a[3], size, hz)
    elif a[0] == "analyze":
        T.cmd_analyze(a[1])
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
