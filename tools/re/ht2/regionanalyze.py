"""Збирає вікна памʼяті одного циклу snapscan.py в суцільні ділянки (за кадрами) й шукає в них машину:
трійки float з плавним рухом (позиція), швидкість з позиції, поля, що корелюють зі швидкістю.

    python -I tools/re/ht2/regionanalyze.py re/telemetry/ht2/rec_10 [--out region.npz-like prefix]
"""
import json
import math
import struct
import sys

sys.stdout.reconfigure(encoding="utf-8")
prefix = sys.argv[1]
meta = json.load(open(f"{prefix}_windows.json", encoding="utf-8"))
W, hz, nfr = meta["win"], meta["hz"], meta["frames"]
size = 2 * W
wins = []
for addr in meta["addrs"]:
    a = int(addr, 16)
    data = open(f"{prefix}_{a:08x}.bin", "rb").read()
    wins.append((a - W, [data[i * size : (i + 1) * size] for i in range(nfr)]))
wins.sort()
# Ділянки: вікна, що перекриваються.
regions = []
for start, frames in wins:
    if regions and start <= regions[-1][1]:
        r = regions[-1]
        r[1] = max(r[1], start + size)
        r[2].append((start, frames))
    else:
        regions.append([start, start + size, [(start, frames)]])


def assemble(r):
    lo, hi, parts = r
    out = []
    for f in range(nfr):
        buf = bytearray(hi - lo)
        for start, frames in parts:
            buf[start - lo : start - lo + size] = frames[f]
        out.append(bytes(buf))
    return out


def corr(a, b):
    n = len(a)
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va < 1e-12 or vb < 1e-12:
        return 0.0
    return sum((x - ma) * (y - mb) for x, y in zip(a, b)) / math.sqrt(va * vb)


for r in regions:
    lo, hi = r[0], r[1]
    fr = assemble(r)
    print(f"== ділянка 0x{lo:08x}…0x{hi:08x} ({hi - lo} Б)")
    pos_cands = []
    for off in range(0, hi - lo - 11, 4):
        tr = [struct.unpack_from("<3f", f, off) for f in fr]
        if not all(all(math.isfinite(v) for v in t) for t in tr):
            continue
        if not all(abs(t[0]) > 100 and abs(t[1]) > 100 and abs(t[0]) < 20000 and abs(t[1]) < 20000 and -100 < t[2] < 1000 for t in tr):
            continue
        steps = [math.dist(tr[i][:2], tr[i - 1][:2]) for i in range(1, len(tr))]
        if max(steps) > 8:
            continue
        path = sum(steps)
        if path > 20:
            pos_cands.append((path, off, tr))
    pos_cands.sort(reverse=True)
    for path, off, tr in pos_cands[:6]:
        print(f"   позиція? +0x{off:04x} шлях {path:.0f} м  {tr[0][0]:.1f},{tr[0][1]:.1f},{tr[0][2]:.1f} → {tr[-1][0]:.1f},{tr[-1][1]:.1f},{tr[-1][2]:.1f}")
    if not pos_cands:
        continue
    force = int(sys.argv[sys.argv.index('--pos') + 1], 16) if '--pos' in sys.argv else None
    pick = [c for c in pos_cands if c[1] == force] if force is not None else []
    _, poff, tr = (pick or pos_cands)[0]
    spd = [math.dist(tr[i][:2], tr[i - 1][:2]) * hz for i in range(1, len(tr))]
    # Згладжена швидкість (вікно 5 кадрів) — менше шуму від нерівного кроку запису.
    sm = [sum(spd[max(0, i - 2) : i + 3]) / len(spd[max(0, i - 2) : i + 3]) for i in range(len(spd))]
    print(f"   швидкість з позиції +0x{poff:04x}: {min(sm) * 3.6:.0f}…{max(sm) * 3.6:.0f} км/год")
    res = []
    for off in range(0, hi - lo - 3, 4):
        vals = [struct.unpack_from("<f", f, off)[0] for f in fr]
        if not all(math.isfinite(v) and abs(v) < 1e7 for v in vals) or max(vals) == min(vals):
            continue
        c = corr(vals[1:], sm)
        res.append((abs(c), off, c, min(vals), max(vals), sum(vals[1:]) / len(sm) / (sum(sm) / len(sm) or 1)))
    res.sort(reverse=True)
    for ac, off, c, a, b, ratio in res[:15]:
        print(f"   +0x{off:04x} кор {c:+.3f}  {a:.3f} … {b:.3f}  (середнє/швидкість {ratio:.3f})")
