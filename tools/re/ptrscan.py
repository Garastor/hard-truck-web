"""Пошук 32-бітних вказівників у памʼяті king.exe на адреси з діапазонів (лише читання).

    python -I tools/re/ptrscan.py ADDR_LO ADDR_HI     # усі dword зі значенням у [LO, HI)
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

_find = T.find_pid
T.find_pid = lambda name=b"king.exe": _find(name)

lo, hi = int(sys.argv[1], 16), int(sys.argv[2], 16)
p = T.Proc()
hits = []
for base, data in p.chunks():
    n = len(data) // 4
    vals = struct.unpack_from(f"<{n}I", data, 0)
    for i, v in enumerate(vals):
        if lo <= v < hi:
            hits.append((base + i * 4, v))
seen = set()
for a, v in hits:
    if a in seen:
        continue
    seen.add(a)
    print(f"0x{a:08x} -> 0x{v:08x} (+0x{v - lo:x})")
print(f"разом {len(seen)}")
