"""Запис вікон памʼяті king.exe навколо заданих адрес (лише читання), формат snapscan.py — для winanalyze.py /
regionanalyze.py. Адреси — з stopgo.py (поки гра не перезапущена).

    python -I tools/re/recwin.py PREFIX SECS HZ ADDR...
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
prefix, secs, hz = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
addrs = sorted({int(a, 16) for a in sys.argv[4:]})
WIN = 0x1000
pid = T.find_pid(b"king.exe") or sys.exit("king.exe не запущено")
p = T.Proc.__new__(T.Proc)
p.h = T.k32.OpenProcess(T.PROCESS_VM_READ | T.PROCESS_QUERY_INFORMATION, False, pid)
p.pid = pid
files = {a: open(f"{prefix}_{a:08x}.bin", "wb") for a in addrs}
t0 = time.time()
frames = 0
print(f"{time.strftime('%H:%M:%S')} запис {secs:.0f} с, {len(addrs)} вікон", flush=True)
while time.time() - t0 < secs:
    t = time.time()
    for a, f in files.items():
        d = p.read(a - WIN, 2 * WIN) or b""
        f.write(d.ljust(2 * WIN, b"\0"))
    frames += 1
    time.sleep(max(0, 1 / hz - (time.time() - t)))
for f in files.values():
    f.close()
with open(f"{prefix}_windows.json", "w", encoding="utf-8") as f:
    json.dump({"addrs": [f"0x{a:08x}" for a in addrs], "win": WIN, "frames": frames, "hz": hz, "t0": t0}, f)
print(f"{time.strftime('%H:%M:%S')} записано {len(addrs)} × {frames} кадрів", flush=True)
