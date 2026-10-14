"""Записувач телеметрії машини гравця в king.exe (Дальнобойщики 2), лише читання памʼяті.

Чекає на гру, знаходить обʼєкт стану машини за міткою (вказівник 0x00531aa0 на зсуві +0x8c — імовірно таблиця
методів класу) і пише CSV 10 разів на секунду. Після перезапуску гри чи завантаження — шукає обʼєкт знову.
Зсуви й одиниці — див. re/notes/ht2-telemetry.md (кермо, оберти, передача — гіпотези).

    python -I tools/re/ht2/record.py [OUT_PREFIX=re/telemetry/ht2/drive] [HZ=10]
"""
import math
import os
import struct
import sys
import time

# telemetry.py (першої гри) — спільний доступ до памʼяті процесу (Proc, find_pid).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402

sys.stdout.reconfigure(encoding="utf-8")
prefix = sys.argv[1] if len(sys.argv) > 1 else "re/telemetry/ht2/drive"
HZ = float(sys.argv[2]) if len(sys.argv) > 2 else 10
MARK = struct.pack("<I", 0x00531AA0)
MARK_OFF = 0x8C
SIZE = 0xC0
RAW = 0x200
COLS = (
    "t,x,y,z,kmh,v,steer,rpm,gear,gas,fuel,odo,n0,unk_b8,fx,fy,fz,raw90,"
    + ",".join(f"m{i}" for i in range(12))
    + ",camx,camy,camz,"
    + ",".join(f"c{i}" for i in range(9))
)
# Камера (глобальні дані king.exe): матриця 3×3 @0x007029c8 (рядки: вправо, погляд, угору), позиція @0x007029ec.
CAM_MAT = 0x007029C8
CAM_POS = 0x007029EC


def say(msg):
    print(f"{time.strftime('%H:%M:%S')} {msg}", flush=True)


def open_game():
    pid = T.find_pid(b"king.exe")
    if not pid:
        return None
    p = T.Proc.__new__(T.Proc)
    p.h = T.k32.OpenProcess(T.PROCESS_VM_READ | T.PROCESS_QUERY_INFORMATION, False, pid)
    p.pid = pid
    return p if p.h else None


def plausible(x, y, z):
    return all(math.isfinite(v) for v in (x, y, z)) and abs(x) < 20000 and abs(y) < 20000 and -200 < z < 2000


def find_car(p):
    found = []
    for base, d in p.chunks():
        k = d.find(MARK)
        while k >= 0:
            if k % 4 == 0 and k >= MARK_OFF and k - MARK_OFF + SIZE <= len(d):
                P = k - MARK_OFF
                x, y, z = struct.unpack_from("<3f", d, P)
                fuel = struct.unpack_from("<f", d, P + 0xAC)[0]
                gear = struct.unpack_from("<i", d, P + 0xB4)[0]
                if plausible(x, y, z) and (x or y) and 0 <= fuel <= 1.5 and -2 <= gear <= 20:
                    found.append(base + P)
            k = d.find(MARK, k + 4)
    return found


def read_state(p, P):
    """Стан машини або None (обʼєкт зник). fx, fy, fz — бічний вектор кузова (m0…m2; уперед — m3…m5, угору — m6…m8)."""
    d = p.read(P - 0xB0, 0xB0 + SIZE)
    if not d or len(d) < 0xB0 + SIZE or d[0xB0 + MARK_OFF : 0xB0 + MARK_OFF + 4] != MARK:
        return None
    o = 0xB0
    x, y, z = struct.unpack_from("<3f", d, o)
    if not plausible(x, y, z):
        return None
    steer, v, rpm, _, n0, odo, gas, fuel = struct.unpack_from("<8f", d, o + 0x90)
    gear, unk = struct.unpack_from("<2i", d, o + 0xB4)
    fx, fy, fz = struct.unpack_from("<3f", d, 0)
    # +0x90 буває і float (−0,6…1 на ходу), і цілим (3 на стоянці) — пишемо ще й сирим цілим.
    raw90 = struct.unpack_from("<i", d, o + 0x90)[0]
    # 12 float від P−0xb0: бічний вектор (m0…m2; asin(m2) — крен), уперед (m3…m5; asin(m5) — тангаж), угору (m6…m8),
    # позиція (m9…m11).
    m = struct.unpack_from("<12f", d, 0)
    cam = (p.read(CAM_MAT, 0x30) or b"").ljust(0x30, b"\0")
    c = struct.unpack_from("<9f", cam, 0)
    cp = struct.unpack_from("<3f", cam, CAM_POS - CAM_MAT)
    return (x, y, z, v * 3.6, v, steer, rpm, gear, gas, fuel, odo, n0, unk, fx, fy, fz, raw90, *m, *cp, *c)


def main():
    os.makedirs(os.path.dirname(prefix) or ".", exist_ok=True)
    say(f"чекаю king.exe; запис у {prefix}_*.csv, {HZ:g} Гц (Ctrl+C — зупинити)")
    p = None
    car = None
    out = None
    rows = 0
    last_note = 0
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
            p, car = None, None
            if out:
                out.close()
                raw.close()
                out = None
            continue
        if car is None:
            cars = find_car(p)
            if len(cars) != 1:
                if t - last_note > 30:
                    say(f"обʼєкт машини: знайдено {len(cars)} — чекаю (меню/завантаження?)")
                    last_note = t
                time.sleep(2)
                continue
            car = cars[0]
            name = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.csv"
            out = open(name, "w", encoding="utf-8")
            out.write(COLS + "\n")
            # Поруч — сирий обʼєкт [P − RAW, P + RAW) кожного кадру (поля, яких ще не знаємо: гальмо, колеса…).
            raw = open(name[:-4] + f"_raw_{car:08x}.bin", "wb")
            rows = 0
            t0 = t
            say(f"машина @0x{car:08x}, пишу {name}")
        s = read_state(p, car)
        if s is None:
            say("обʼєкт машини зник — шукаю знову")
            car = None
            out.close()
            raw.close()
            out = None
            continue
        raw.write((p.read(car - RAW, 2 * RAW) or b"").ljust(2 * RAW, b"\0"))
        out.write(f"{t - t0:.2f}," + ",".join(f"{v:.7g}" if isinstance(v, float) else str(v) for v in s) + "\n")
        rows += 1
        if rows % int(HZ * 30) == 0:
            out.flush()
            raw.flush()
            say(f"{rows} рядків; {s[3]:.0f} км/год, передача {s[7]}, оберти {s[6]:.1f}, паливо {s[9]:.3f}")
        time.sleep(max(0, 1 / HZ - (time.time() - t)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
