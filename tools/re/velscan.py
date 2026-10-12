"""Пошук полів швидкості машин у king.exe (лише читання памʼяті): знімки сторінок, що змінюються, позиції машин,
швидкість з позиції й кореляція кожного float у цих сторінках зі швидкістю. Потрібен NumPy.

    python -I tools/re/velscan.py OUT.txt [N=30] [HZ=2]
"""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
out = sys.argv[1]
N = int(sys.argv[2]) if len(sys.argv) > 2 else 30
HZ = float(sys.argv[3]) if len(sys.argv) > 3 else 2

pid = T.find_pid(b"king.exe") or sys.exit("king.exe не запущено")
p = T.Proc.__new__(T.Proc)
p.h = T.k32.OpenProcess(T.PROCESS_VM_READ | T.PROCESS_QUERY_INFORMATION, False, pid)
p.pid = pid


def heap():
    s = {}
    for base, size in p.regions():
        if base < 0x70000000 and size <= 64 << 20:
            d = p.read(base, size)
            if d:
                s[base] = d
    return s


# Сторінки, що змінюються за пів секунди.
a = heap()
time.sleep(0.5)
b = heap()
pages = []
for base, d0 in a.items():
    d1 = b.get(base)
    if not d1 or len(d1) != len(d0):
        continue
    for off in range(0, len(d0), 0x1000):
        if d0[off : off + 0x1000] != d1[off : off + 0x1000]:
            pages.append(base + off)
print(f"сторінок, що змінюються: {len(pages)}", flush=True)

snaps = []
times = []
for i in range(N):
    t = time.time()
    buf = bytearray(len(pages) * 0x1000)
    for j, pg in enumerate(pages):
        d = p.read(pg, 0x1000)
        if d:
            buf[j * 0x1000 : j * 0x1000 + len(d)] = d
    snaps.append(np.frombuffer(bytes(buf), dtype="<f4"))
    times.append(t)
    time.sleep(max(0, 1 / HZ - (time.time() - t)))
F = np.stack(snaps).astype(np.float64)  # N × M
M = F.shape[1]
addr = np.array([pg + 4 * i for pg in pages for i in range(0x400)], dtype=np.int64)
dt = np.diff(np.array(times))

# Позиції: трійки x, y, z (сусідні float).
x, y, z = F[:, :-2], F[:, 1:-1], F[:, 2:]
with np.errstate(invalid="ignore"):
    ok = (np.abs(x) > 100).all(0) & (np.abs(x) < 20000).all(0) & (np.abs(y) > 100).all(0) & (np.abs(y) < 20000).all(0)
    ok &= ((z > -100) & (z < 1000)).all(0)
    step = np.hypot(np.diff(x, axis=0), np.diff(y, axis=0))
    ok &= (step < 45 / HZ).all(0)
    path = step.sum(0)
    ok &= path > 15
idx = np.nonzero(ok)[0]
# Групи за кінцевою позицією (2 м).
groups = {}
for k in idx:
    key = (round(x[-1, k] / 2), round(y[-1, k] / 2))
    groups.setdefault(key, []).append(k)
lines = [f"сторінок {len(pages)}, знімків {N} по {1 / HZ:.2f} с, рухомих позицій {len(idx)}, обʼєктів {len(groups)}"]
# Стандартизовані стовпці — для кореляції.
std = F.std(0)
good = np.isfinite(F).all(0) & (std > 1e-6) & (np.abs(F) < 1e7).all(0)
Z = np.where(good, (F - F.mean(0)) / np.where(std > 0, std, 1), 0)
for key, ks in sorted(groups.items(), key=lambda kv: -path[kv[1][0]]):
    k = ks[0]
    sp = np.concatenate([[0], step[:, k] / dt])  # м/с, перший — 0
    sp[0] = sp[1]
    if sp.std() < 0.3:
        continue
    zs = (sp - sp.mean()) / sp.std()
    c = (Z * zs[:, None]).mean(0)
    best = np.argsort(-np.abs(c))[:12]
    lines.append(
        f"\n== обʼєкт: позиція 0x{addr[k]:08x} ({len(ks)} копій), шлях {path[k]:.0f} м, "
        f"{x[0, k]:.0f},{y[0, k]:.0f} → {x[-1, k]:.0f},{y[-1, k]:.0f}, швидкість {sp.min() * 3.6:.0f}…{sp.max() * 3.6:.0f} км/год"
    )
    for j in best:
        if abs(c[j]) < 0.8:
            break
        ratio = F[:, j].mean() / sp.mean() if sp.mean() else 0
        lines.append(f"   0x{addr[j]:08x} кор {c[j]:+.3f}  {F[:, j].min():.3f}…{F[:, j].max():.3f}  середнє/(м/с) {ratio:.3f}")
open(out, "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines[:60]))
