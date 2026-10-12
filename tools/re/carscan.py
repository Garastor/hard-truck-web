"""Пошук обʼєкта машини в купі king.exe: float маси й радіуса колеса поруч (до 64 байтів), лише читання.

    python -I tools/re/carscan.py MASS RWHEEL
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

_find = T.find_pid
T.find_pid = lambda name=b"king.exe": _find(name)

mass, rw = float(sys.argv[1]), float(sys.argv[2])
mb = struct.pack("<f", mass)
p = T.Proc()
for base, data in p.chunks():
    if base >= 0x70000000:
        continue
    start = 0
    while True:
        k = data.find(mb, start)
        if k < 0:
            break
        start = k + 4
        if k % 4:
            continue
        win = data[max(0, k - 64) : k + 64]
        for j in range(0, len(win) - 3, 4):
            if abs(struct.unpack_from("<f", win, j)[0] - rw) < 1e-4:
                print(f"mass 0x{base + k:08x}, rwheel {j - min(64, k):+d}")
                break
