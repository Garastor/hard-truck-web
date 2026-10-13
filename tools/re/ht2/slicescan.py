"""Пошук у памʼяті king.exe копій фрагментів запису vehicle.tech (лише читання): для машини NAME перевіряє
кілька відрізків запису (передатні числа, гальма, момент…) і друкує, де вони трапляються поза таблицею техніки.

    python -I tools/re/ht2/slicescan.py NAME
"""
import os
import sys

# telemetry.py (першої гри) — спільний доступ до памʼяті процесу (Proc, find_pid).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402
from techtable import tech_records  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
SLICES = {
    "маса/колесо": (0x60, 0x70),
    "витрата…опір": (0xA0, 0xB8),
    "момент": (0xC0, 0xC4),
    "гальма/міст/реверс": (0xC8, 0xD4),
    "передачі": (0xD4, 0x10C),
}

name = sys.argv[1]
recs = [rec for names, rec in tech_records() if any(name.lower() == x.lower() for x in names)]
if not recs:
    # Імена в записі — після зсуву; шукаємо підрядок.
    recs = [rec for names, rec in tech_records() if name.encode() + b"\0" in rec]
p = T.Proc.__new__(T.Proc)
pid = T.find_pid(b"king.exe") or sys.exit("king.exe не запущено")
p.h = T.k32.OpenProcess(T.PROCESS_VM_READ | T.PROCESS_QUERY_INFORMATION, False, pid)
p.pid = pid
chunks = list(p.chunks())
for ri, rec in enumerate(recs):
    print(f"== запис {ri}")
    for label, (a, b) in SLICES.items():
        pat = rec[a:b]
        hits = []
        for base, data in chunks:
            k = data.find(pat)
            while k >= 0:
                hits.append(base + k - a)
                k = data.find(pat, k + 4)
        print(f"  {label}: " + ", ".join(f"0x{h:08x}" for h in sorted(set(hits))[:12]))
