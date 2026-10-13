"""Пошук машини гравця в king.exe за впізнаваним профілем руху (стоянка → розгін → гальмування до 0), лише
читання памʼяті. Фаза 1: позиції всіх правдоподібних трійок у сторінках, що змінюються; машина гравця — та, що
кілька разів зупиняється й розганяється (трафік їде рівно). Фаза 2: запис вікон памʼяті навколо знайденого
обʼєкта (формат snapscan.py — для winanalyze.py / regionanalyze.py).

    python -I tools/re/ht2/stopgo.py PREFIX [SECS1=90] [SECS2=60]
"""
import json
import os
import sys
import time

import numpy as np

# telemetry.py (першої гри) — спільний доступ до памʼяті процесу (Proc, find_pid).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
prefix = sys.argv[1]
SECS1 = float(sys.argv[2]) if len(sys.argv) > 2 else 90
SECS2 = float(sys.argv[3]) if len(sys.argv) > 3 else 60
HZ1, HZ2, WIN = 2.0, 10.0, 0x1000

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


def changing(a, b):
    out = set()
    for base, d0 in a.items():
        d1 = b.get(base)
        if not d1 or len(d1) != len(d0):
            continue
        for off in range(0, len(d0), 0x1000):
            if d0[off : off + 0x1000] != d1[off : off + 0x1000]:
                out.add(base + off)
    return out


def read_pages(pages):
    buf = bytearray(len(pages) * 0x1000)
    for j, pg in enumerate(pages):
        d = p.read(pg, 0x1000)
        if d:
            buf[j * 0x1000 : j * 0x1000 + len(d)] = d
    return np.frombuffer(bytes(buf), dtype="<f4")


def plausible(f):
    x, y, z = f[:-2], f[1:-1], f[2:]
    with np.errstate(invalid="ignore"):
        return (np.abs(x) > 100) & (np.abs(x) < 20000) & (np.abs(y) > 100) & (np.abs(y) < 20000) & (z > -100) & (z < 1000)


# Сторінки, що змінюються (обʼєднання двох проміжків — машина, що стоїть, може змінюватися рідше).
a = heap()
time.sleep(0.5)
b = heap()
time.sleep(0.5)
c = heap()
pages = sorted(changing(a, b) | changing(b, c))
del a, b, c
F0 = read_pages(pages)
cand = np.nonzero(plausible(F0))[0]
addr = np.array(pages, dtype=np.int64)[cand // 0x400] + 4 * (cand % 0x400)
print(f"{time.strftime('%H:%M:%S')} сторінок {len(pages)}, кандидатів-позицій {len(cand)}; фаза 1 — {SECS1:.0f} с", flush=True)

xs, ys, ts = [], [], []
t0 = time.time()
while time.time() - t0 < SECS1:
    t = time.time()
    F = read_pages(pages)
    xs.append(F[cand].copy())
    ys.append(F[cand + 1].copy())
    ts.append(t)
    time.sleep(max(0, 1 / HZ1 - (time.time() - t)))
X, Y = np.stack(xs).astype(np.float64), np.stack(ys).astype(np.float64)
np.savez_compressed(f"{prefix}_pos.npz", x=np.stack(xs), y=np.stack(ys), t=np.array(ts), addr=addr)
dt = np.diff(np.array(ts))
with np.errstate(invalid="ignore"):
    ok = plausible_all = ((np.abs(X) > 100) & (np.abs(X) < 20000) & (np.abs(Y) > 100) & (np.abs(Y) < 20000)).all(0)
    step = np.hypot(np.diff(X, axis=0), np.diff(Y, axis=0))
    ok &= (step < 45 / HZ1).all(0)
    sp = step / dt[:, None]  # м/с
    # Згладжування по 3 кроки.
    k = np.ones(3) / 3
    sm = np.apply_along_axis(lambda s: np.convolve(s, k, mode="same"), 0, sp[:, ok])
idx = np.nonzero(ok)[0]
stopped = sm < 0.5
moving = sm > 8
# Переходи «стоїть → їде» (з урахуванням проміжних кроків).
starts = np.zeros(len(idx), dtype=int)
state = np.full(len(idx), -1)
for i in range(sm.shape[0]):
    s = np.where(stopped[i], 0, np.where(moving[i], 1, -1))
    starts += (state == 0) & (s == 1)
    state = np.where(s >= 0, s, state)
# Гравець не лише зупиняється, а й кудись їде (чисте зміщення), трафік на місці не стоїть.
net = np.hypot(X[-1, idx] - X[0, idx], Y[-1, idx] - Y[0, idx])
score = starts * 10 + stopped.mean(0) * 5 + (moving.mean(0) > 0.1) + np.minimum(net, 500) / 25
order = np.argsort(-score)
lines = [f"сторінок {len(pages)}, кандидатів {len(cand)}, рухомих {len(idx)}, кадрів {X.shape[0]} по {1 / HZ1:.1f} с"]
groups = {}
for o in order[:400]:
    j = idx[o]
    key = (round(X[-1, j] / 2), round(Y[-1, j] / 2))
    groups.setdefault(key, []).append(o)
best = []
for key, os_ in sorted(groups.items(), key=lambda kv: -score[kv[1][0]])[:12]:
    o = os_[0]
    j = idx[o]
    best.append([int(addr[idx[q]]) for q in os_])
    prof = "".join("_" if v < 0.5 else ("#" if v > 8 else ".") for v in sm[:, o])
    lines.append(
        f"\n== 0x{addr[j]:08x} ({len(os_)} копій) зупинок→розгонів {starts[o]}, зміщення {net[o]:.0f} м, стоїть {stopped[:, o].mean() * 100:.0f} %, "
        f"до {sm[:, o].max() * 3.6:.0f} км/год, {X[0, j]:.0f},{Y[0, j]:.0f} → {X[-1, j]:.0f},{Y[-1, j]:.0f}\n   {prof}\n   копії: "
        + ", ".join(f"0x{addr[idx[q]]:08x}" for q in os_[:16])
    )
open(f"{prefix}_stopgo.txt", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print("\n".join(lines[:40]), flush=True)
if not best or starts[order[0]] < 1:
    sys.exit("впізнаваного профілю не знайдено")

# Фаза 2: вікна навколо копій найкращого обʼєкта.
addrs = sorted(set(best[0]))[:16]
print(f"{time.strftime('%H:%M:%S')} фаза 2 — {SECS2:.0f} с, вікна ±0x{WIN:x} навколо {len(addrs)} копій", flush=True)
files = {a: open(f"{prefix}_{a:08x}.bin", "wb") for a in addrs}
t0 = time.time()
frames = 0
while time.time() - t0 < SECS2:
    t = time.time()
    for a, f in files.items():
        d = p.read(a - WIN, 2 * WIN) or b"\0" * (2 * WIN)
        f.write(d.ljust(2 * WIN, b"\0"))
    frames += 1
    time.sleep(max(0, 1 / HZ2 - (time.time() - t)))
for f in files.values():
    f.close()
with open(f"{prefix}_windows.json", "w", encoding="utf-8") as f:
    json.dump({"addrs": [f"0x{a:08x}" for a in addrs], "win": WIN, "frames": frames, "hz": HZ2, "t0": t0}, f)
print(f"{time.strftime('%H:%M:%S')} записано {len(addrs)} × {frames} кадрів → {prefix}_*.bin", flush=True)
