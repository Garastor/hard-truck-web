"""Розбір CSV записувача record.py (лише файли): прискорення з поправкою на схил, режими (газ / вибіг / гальмо),
залежність від передачі, обертів і швидкості, повороти (бічне прискорення).

    python -I tools/re/ht2/analyze.py re/telemetry/ht2/drive_….csv [--from T0] [--to T1]
"""
import csv
import math
import sys
from collections import defaultdict

sys.stdout.reconfigure(encoding="utf-8")
path = sys.argv[1]
t_from = float(sys.argv[sys.argv.index("--from") + 1]) if "--from" in sys.argv else -1e9
t_to = float(sys.argv[sys.argv.index("--to") + 1]) if "--to" in sys.argv else 1e9
# --skip 39-52,348-372 — відрізки, які не брати (узбіччя, зрізані повороти).
skip = [tuple(map(float, x.split("-"))) for x in sys.argv[sys.argv.index("--skip") + 1].split(",")] if "--skip" in sys.argv else []
G = 9.81
R = [-4, 0, 7.44, 4.1, 2.29, 1.47, 1.0]  # ZilR, індекс передачі гри

rows = [r for r in csv.DictReader(open(path, encoding="utf-8")) if t_from <= float(r["t"]) <= t_to]
rows = [r for r in rows if not any(a <= float(r["t"]) <= b for a, b in skip)]
f = lambda r, k: float(r[k])  # noqa: E731
n = len(rows)
H = 3  # півширина вікна похідної, кадрів (0,3 с)
samples = []
for i in range(H, n - H):
    a, b = rows[i - H], rows[i + H]
    dt = f(b, "t") - f(a, "t")
    if dt <= 0 or dt > 0.8:
        continue
    acc = (f(b, "v") - f(a, "v")) / dt
    ds = math.dist((f(a, "x"), f(a, "y")), (f(b, "x"), f(b, "y")))
    slope = (f(b, "z") - f(a, "z")) / ds if ds > 1 else 0.0
    # Курс із вектора вперед (fx, fy) — швидкість повороту, рад/с.
    h0 = math.atan2(f(a, "fy"), f(a, "fx"))
    h1 = math.atan2(f(b, "fy"), f(b, "fx"))
    yaw = ((h1 - h0 + math.pi) % (2 * math.pi) - math.pi) / dt
    r = rows[i]
    gears = {int(x["gear"]) for x in rows[i - H : i + H + 1]}
    gas = [f(x, "gas") for x in rows[i - H : i + H + 1]]
    samples.append(
        dict(t=f(r, "t"), v=f(r, "v"), acc=acc, slope=slope, ag=acc + G * slope, yaw=yaw, lat=f(r, "v") * yaw,
             gear=int(r["gear"]), shift=len(gears) > 1, gas=f(r, "gas"), gas_steady=max(gas) - min(gas) < 0.05,
             rpm=f(r, "rpm"), steer=f(r, "steer"), z=f(r, "z"), x=f(r, "x"), y=f(r, "y"))
    )


def table(title, rows_, key, val, fmt="{:+.2f}"):
    b = defaultdict(list)
    for s in rows_:
        b[key(s)].append(val(s))
    print(title)
    for k in sorted(b):
        v = sorted(b[k])
        print(f"   {k}: n {len(v):4d}  медіана " + fmt.format(v[len(v) // 2]) + "  (" + fmt.format(v[len(v) // 4]) + " … " + fmt.format(v[3 * len(v) // 4]) + ")")


straight = [s for s in samples if abs(s["steer"]) < 0.08 and abs(s["yaw"]) < 0.05 and not s["shift"]]
# Газ: стабільний, педаль > 0,7 — прискорення з поправкою на схил за передачею й швидкістю.
gas = [s for s in straight if s["gas"] > 0.7 and s["gas"] < 0.86 and s["v"] > 2]
table("Газ 0,7…0,86, пряма, без перемикань: a + g·ухил, м/с² за (передача, швидкість км/год / 10)", gas,
      lambda s: (s["gear"], int(s["v"] * 3.6 // 10) * 10), lambda s: s["ag"])
# Вибіг: газ відпущений (0,05), сповільнення невелике (гальмо не записане — відсікаємо |a| > 1,5).
coast = [s for s in straight if s["gas"] < 0.06 and s["v"] > 2 and s["ag"] > -1.5]
table("Вибіг (газ 0,05, |a| < 1,5): a + g·ухил за (передача, швидкість км/год / 10)", coast,
      lambda s: (s["gear"], int(s["v"] * 3.6 // 10) * 10), lambda s: s["ag"])
brake = [s for s in samples if s["gas"] < 0.06 and s["v"] > 1 and s["ag"] < -1.5]
table("Гальмування (газ 0,05, a < −1,5): a + g·ухил за швидкістю км/год / 10", brake,
      lambda s: int(s["v"] * 3.6 // 10) * 10, lambda s: s["ag"])
turns = [s for s in samples if s["v"] > 3 and abs(s["steer"]) > 0.15]
table("Повороти: бічне прискорення v·ω, м/с² за (|кермо| / 0,2, швидкість км/год / 20)", turns,
      lambda s: (round(min(abs(s["steer"]), 1) / 0.2) * 0.2, int(s["v"] * 3.6 // 20) * 20), lambda s: abs(s["lat"]))
table("Повороти: радіус v/ω, м за (|кермо| / 0,2, швидкість км/год / 20)", [s for s in turns if abs(s["yaw"]) > 0.02],
      lambda s: (round(min(abs(s["steer"]), 1) / 0.2) * 0.2, int(s["v"] * 3.6 // 20) * 20), lambda s: s["v"] / abs(s["yaw"]), "{:.0f}")
