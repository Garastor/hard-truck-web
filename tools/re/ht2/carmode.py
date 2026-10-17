"""Режим кроку машин king.exe (Car_V+0x2638: 1 — кінематичний run1, 3 — динамічний 0x4f8260), лише читання памʼяті.

Перевірка гіпотези physics.md: з причепом тягач увесь час у режимі 3. Знаходить усі обʼєкти Car_V (таблиця методів
0x0064d2f4 на зсуві 0, конструктор 0x4d2790) і пише CSV 20 Гц: режим, маса, маса причепа [0x278c], v_fwd [0xdc8],
кермо [0x29e0], перекидання [0x3344]. Гравця позначає за швидкістю обʼєкта машини з record.py (мітка 0x00531aa0).
Переходи режимів друкує в лог одразу. Поруч — сирий файл `_raw.bin`: щокроку (20 Гц) увесь обʼєкт Car_V гравця й
машин, що їдуть з ним (причіп: |v_fwd − v гравця| < 0,5 м/с на ходу) — 0x4200 Б (підвіска 0xe18, навантаження 0xd20,
колеса 0x19a4/0x19d4, сили 0xc6c/0xc78, кермо 0x29e0, ковзання тощо — physics.md). Запис: <d t> <I адреса> <I гравець>
<I розмір> + байти.

    python -I tools/re/ht2/carmode.py [OUT_PREFIX=re/telemetry/ht2/mode]
"""
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import procmem as T  # noqa: E402
from record import find_car, open_game, read_state  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
prefix = sys.argv[1] if len(sys.argv) > 1 else "re/telemetry/ht2/mode"
# Машини — похідний клас (конструктор 0x4d2790 → 0x4ebd00, обʼєкт ≥ 0x40c0 Б); 0x0064d994 — лише основа (зразки).
VT = struct.pack("<I", 0x0064D2F4)
MODE, MASS, MTRAIL, VFWD, STEER, FLIP = 0x2638, 0x2640, 0x278C, 0xDC8, 0x29E0, 0x3344
SIZE = 0x3400
RAW = 0x4200
HZ = 20


def say(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def fields(d):
    mode = struct.unpack_from("<i", d, MODE)[0]
    mass, mtrail = struct.unpack_from("<f", d, MASS)[0], struct.unpack_from("<f", d, MTRAIL)[0]
    vfwd, steer = struct.unpack_from("<f", d, VFWD)[0], struct.unpack_from("<f", d, STEER)[0]
    flip = struct.unpack_from("<i", d, FLIP)[0]
    return mode, mass, mtrail, vfwd, steer, flip


def find_carv(p):
    found = []
    for base, d in p.chunks():
        k = d.find(VT)
        while k >= 0:
            if k % 4 == 0:
                obj = p.read(base + k, SIZE)
                if obj and len(obj) == SIZE:
                    mode, mass, mtrail, vfwd, steer, _ = fields(obj)
                    if mode in (0, 1, 2, 3, 4) and 300 < mass < 80000 and 0 <= mtrail < 80000 and abs(vfwd) < 100 and abs(steer) <= 1.01:
                        found.append(base + k)
            k = d.find(VT, k + 4)
    return sorted(set(found))


def main():
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)
    say("чекаю king.exe (Ctrl+C — зупинити)")
    p, objs, out, player, last_scan, t0 = None, [], None, None, 0, 0
    modes = {}
    mates = set()
    raw = None
    while True:
        t = time.time()
        if p is None:
            p = open_game()
            if p is None:
                time.sleep(2)
                continue
            say(f"king.exe знайдено (pid {p.pid})")
        if T.find_pid(b"king.exe") != p.pid:
            say("гру закрито")
            p, objs, player = None, [], None
            continue
        if t - last_scan > 30 or not objs:
            last_scan = t
            objs = find_carv(p)
            cars = find_car(p)
            player = cars[0] if len(cars) == 1 else None
            if objs and out is None:
                name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
                out = open(name, "w", encoding="utf-8")
                out.write("t,addr,player,mode,mass,mtrail,vfwd,steer,flip,pv\n")
                raw = open(name[:-4] + "_raw.bin", "wb")
                t0 = t
                say(f"пишу {name}")
            if not objs:
                time.sleep(2)
                continue
        pv = None
        if player:
            s = read_state(p, player)
            pv = s[4] if s else None
        best = None
        rows = []
        for a in objs:
            d = p.read(a, SIZE)
            if not d or len(d) < SIZE or d[:4] != VT:
                continue
            f = fields(d)
            rows.append((a, f))
            if pv is not None and abs(pv) > 1 and (best is None or abs(f[3] - pv) < abs(best[1][3] - pv)):
                best = (a, f)
        pa = best[0] if best and abs(best[1][3] - pv) < 0.3 else None
        if pa:
            mates.add(pa)
            if abs(pv) > 2:
                mates.update(a for a, f in rows if abs(f[3] - pv) < 0.5 and len(mates) < 4)
        for a in list(mates):
            d = p.read(a, RAW)
            if not d or len(d) < RAW or d[:4] != VT:
                mates.discard(a)
                continue
            raw.write(struct.pack("<dIII", t - t0, a, int(a == pa), RAW) + d)
        for a, (mode, mass, mtrail, vfwd, steer, flip) in rows:
            me = int(a == pa)
            out.write(f"{t - t0:.2f},{a:08x},{me},{mode},{mass:.0f},{mtrail:.0f},{vfwd:.2f},{steer:.2f},{flip},{'' if pv is None else f'{pv:.2f}'}\n")
            if modes.get(a) != mode:
                say(f"Car_V @{a:08x}{' (гравець?)' if me else ''}: режим {modes.get(a)} → {mode}, маса {mass:.0f}, причіп {mtrail:.0f}, v {vfwd:.1f}")
                modes[a] = mode
        out.flush()
        raw.flush()
        time.sleep(max(0, 1 / HZ - (time.time() - t)))


if __name__ == "__main__":
    main()
