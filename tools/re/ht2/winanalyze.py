"""Розбір вікон памʼяті, записаних snapscan.py (лише аналіз файлів).

Для кожного обʼєкта: позиція — три float на зсуві WIN (центр вікна); швидкість — з різниці позицій; шукаємо float-поля
вікна, що найсильніше корелюють зі швидкістю, і поля, що змінюються взагалі.

    python -I tools/re/ht2/winanalyze.py re/telemetry/ht2/rec_10
"""
import json
import math
import struct
import sys

prefix = sys.argv[1]
meta = json.load(open(f"{prefix}_windows.json", encoding="utf-8"))
W = meta["win"]
hz = meta["hz"]
size = 2 * W


def corr(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va < 1e-9 or vb < 1e-9:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


for addr in meta["addrs"]:
    a = int(addr, 16)
    data = open(f"{prefix}_{a:08x}.bin", "rb").read()
    frames = [data[i : i + size] for i in range(0, len(data) - size + 1, size)]
    pos = [struct.unpack_from("<3f", f, W) for f in frames]
    spd = [math.dist(pos[i][:2], pos[i - 1][:2]) * hz for i in range(1, len(pos))]
    path = sum(math.dist(pos[i][:2], pos[i - 1][:2]) for i in range(1, len(pos)))
    varying = 0
    best = []
    for off in range(0, size - 3, 4):
        vals = [struct.unpack_from("<f", f, off)[0] for f in frames]
        if not all(math.isfinite(v) and abs(v) < 1e6 for v in vals) or max(vals) == min(vals):
            continue
        varying += 1
        c = corr(vals[1:], spd)
        best.append((abs(c), off - W, c, min(vals), max(vals)))
    best.sort(reverse=True)
    print(f"{addr}: шлях {path:.0f} м за {len(frames) / hz:.0f} с, швидкість до {max(spd) * 3.6:.0f} км/год, полів змінюється {varying}")
    for ac, off, c, lo, hi in best[:6]:
        print(f"   {off:+#06x}  кор {c:+.3f}  {lo:.3f} … {hi:.3f}")
