"""Телеметрія запущеного HTruck.exe: лише ЧИТАННЯ памʼяті процесу (ReadProcessMemory), нічого не змінює.

Ідея: обʼєкт машини містить копію запису техніки з TRUCK.TCH (маса, радіус колеса, момент, гальма…).
Ці числа відомі, тож обʼєкти машин знаходимо пошуком цієї послідовності в купі процесу, а далі
записуємо всі поля обʼєкта в часі й шукаємо, які з них — швидкість, оберти, передача.

    python -I tools/re/ht1/telemetry.py find                 # знайти обʼєкти машин (адреси)
    python -I tools/re/ht1/telemetry.py dump ADDR [SIZE]     # поля як float/int
    python -I tools/re/ht1/telemetry.py record ADDR SECS OUT.csv [--size N] [--hz 20]
    python -I tools/re/ht1/telemetry.py analyze OUT.csv      # поля, що змінювались: діапазон, к-сть значень
    python -I tools/re/ht1/telemetry.py auto re/telemetry/s1 # чекає гру й машину, пише знімки до виходу з гри

Таблиця техніки: 0x59d7dc + i·0x540 (див. re/notes/ht1/tech-params.md), кількість — 0x59c744.
"""
import csv
import os
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import procmem  # noqa: E402

TECH_TABLE = 0x59D7DC
TECH_STRIDE = 0x540
TECH_COUNT = 0x59C744
# Поля запису, що копіюються в обʼєкт машини підряд: mass, rwheel, front/rear thickness, maxrotmomentum,
# breakpower, rear_axle_coeff (+0x60…+0x7b).
PATTERN_OFF, PATTERN_LEN = 0x60, 0x1C

NO_DUMPS = False  # auto --no-dumps: без повних знімків памʼяті (вони підвішують гру)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def find_pid(name=b"htruck.exe"):
    return procmem.find_pid(name)


class Proc(procmem.Proc):
    def __init__(self):
        super().__init__(b"htruck.exe", "HTruck.exe")



def tech_records(p):
    raw = p.read(TECH_COUNT, 4)
    count = struct.unpack("<I", raw)[0] if raw else 0
    out = []
    for i in range(min(count, 32)):
        rec = p.read(TECH_TABLE + i * TECH_STRIDE, TECH_STRIDE)
        if rec:
            out.append(rec)
    return out


def cmd_find(p):
    recs = tech_records(p)
    print(f"PID {p.pid}; записів техніки: {len(recs)}")
    pats = {}
    for i, rec in enumerate(recs):
        pat = rec[PATTERN_OFF : PATTERN_OFF + PATTERN_LEN]
        mass, rw = struct.unpack_from("<2f", pat)
        print(f"  TECH{i}: mass={mass:g} rwheel={rw:g}")
        pats[pat] = i
    table_end = TECH_TABLE + TECH_STRIDE * len(recs)
    for base, size in p.regions():
        data = p.read(base, size)
        if not data:
            continue
        for pat, i in pats.items():
            start = 0
            while True:
                k = data.find(pat, start)
                if k < 0:
                    break
                addr = base + k
                if not (TECH_TABLE <= addr < table_end):
                    print(f"TECH{i}: копія на 0x{addr:08x} (поле mass); регіон 0x{base:08x}+0x{size:x}")
                start = k + 4


fmt_slot, cmd_dump, cmd_record, cmd_analyze = procmem.fmt_slot, procmem.cmd_dump, procmem.cmd_record, procmem.cmd_analyze


def find_cars(p, stats=None):
    """Обʼєкти машин: (адреса поля [0x251], індекс техніки, спосіб).

    Під час створення машини (0x4966dc) в обʼєкт пишуться float-поля [0x251] = rear_axle_coeff (запис +0x78)
    і [0x253] = maxrotmomentum (запис +0x70); вони незмінні під час гри. Маса [0x306] — ні (вантаж, кузов).
    Початок обʼєкта = адреса [0x251] − 0x944.
    """
    recs = tech_records(p)
    table_end = TECH_TABLE + TECH_STRIDE * len(recs)
    pats = {}
    for i, rec in enumerate(recs):
        axle = rec[0x78:0x7C]
        torque = rec[0x70:0x74]
        pats.setdefault(axle, []).append((torque, i))
    found = []
    for base, data in p.chunks(stats):
        for axle, cands in pats.items():
            s = 0
            while (k := data.find(axle, s)) >= 0:
                s = k + 4
                addr = base + k
                if k % 4 or TECH_TABLE <= addr < table_end:
                    continue
                for torque, i in cands:
                    if data[k + 8 : k + 12] == torque and all(abs(addr - f[0]) > 8 for f in found):
                        found.append((addr, i, "axle+torque"))
    return found


def cmd_auto(out_prefix, window_before=0x1000, window_after=0x2000, hz=30, max_minutes=120):
    """Чекає гру й машину, потім пише сирі знімки вікна навколо кожної знайденої машини до виходу з гри.

    Формат .bin: для кожного кадру — f64 час, далі для кожної машини window_before+window_after байт.
    Метадані — у .json поруч.
    """
    import json

    t_start = time.time()
    log = open(out_prefix + ".log", "w", encoding="utf-8")

    def say(msg):
        line = f"[{time.strftime('%H:%M:%S')}] {msg}"
        print(line, flush=True)
        log.write(line + "\n")
        log.flush()

    say("чекаю HTruck.exe…")
    while not find_pid():
        if time.time() - t_start > max_minutes * 60:
            return say("гру так і не запущено")
        time.sleep(2)
    p = Proc()
    say(f"гра запущена (PID {p.pid}); чекаю, поки зʼявиться машина…")
    recs = tech_records(p)
    masses = {rec[0x70:0x74] for rec in recs}  # maxrotmomentum
    seg = 0
    while find_pid() and time.time() - t_start < max_minutes * 60:
        prefix = out_prefix if seg == 0 else f"{out_prefix}-{seg}"
        if not record_segment(p, prefix, say, masses, window_before, window_after, hz, t_start, max_minutes):
            break
        seg += 1
        say("вантажівка зникла (зміна локації?) — чекаю на нову…")
        time.sleep(5)  # не заважаємо грі завантажувати локацію
    say("гру закрито — запис завершено")


def record_segment(p, out_prefix, say, masses, window_before, window_after, hz, t_start, max_minutes):
    """Шукає машини й пише один відрізок до зникнення машини. False — гру закрито до появи машини."""
    import json

    cars = []
    scans = 0
    while not cars:
        if not find_pid():
            say(f"гру закрито до появи машини (пошуків: {scans})")
            return False
        cars = find_cars(p)
        scans += 1
        if not cars:
            if scans % 5 == 1:
                hits = 0
                st = {}
                for _, data in p.chunks(st):
                    hits += sum(data.count(m) for m in masses)
                say(
                    f"пошук {scans}: машину не знайдено; збігів за моментом двигуна: {hits}; "
                    f"прочитано {st.get('ok', 0) >> 20} МБ, не прочитано {st.get('fail', 0) >> 20} МБ"
                )
            time.sleep(3)
    say("машини: " + ", ".join(f"0x{a:08x} (TECH{i}, {how})" for a, i, how in cars))
    cars = cars[:6]
    size = window_before + window_after
    meta = {
        "cars": [{"mass_addr": a, "tech": i, "how": how, "start": a - window_before} for a, i, how in cars],
        "window_before": window_before,
        "window_after": window_after,
        "hz": hz,
        "started": time.strftime("%Y-%m-%d %H:%M:%S"),
    }
    with open(out_prefix + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=1)
    frames = 0
    t0 = time.perf_counter()
    first = [p.read_padded(a - window_before, size) for a, _, _ in cars]

    def key(c):
        # [0x251] головна передача і [0x253] момент — незмінні; між ними [0x252] — оберти.
        return c[window_before : window_before + 4] + c[window_before + 8 : window_before + 12] if c else b""

    sigs = [key(c) for c in first]
    # Повні знімки памʼяті для пошуку камери: один на прямій, до трьох — на стійкому повороті.
    base_off = window_before - 0x944  # початок обʼєкта машини у вікні
    straight_since = {}
    turn_since = {}
    dumps = {"straight": 0, "turn": 0}
    last_dump = -10.0

    def fld(c, idx):
        return struct.unpack_from("<f", c, base_off + idx * 4)[0]

    def dump(kind, t, car):
        nonlocal last_dump
        path = f"{out_prefix}.dump-{kind}{dumps[kind]}.bin"
        n = 0
        with open(path, "wb") as fd:
            for addr, data in p.chunks():
                fd.write(struct.pack("<II", addr, len(data)))
                fd.write(data)
                n += len(data)
        dumps[kind] += 1
        last_dump = time.perf_counter() - t0
        say(f"знімок памʼяті {kind}: t={t:.1f} с, машина {car}, {n >> 20} МБ → {path}")

    with open(out_prefix + ".bin", "wb") as fo:
        while time.time() - t_start < max_minutes * 60:
            chunks = [p.read_padded(a - window_before, size) for a, _, _ in cars]
            if any(c is None for c in chunks) or not find_pid():
                break  # гру закрито або обʼєкт зник
            # Обʼєкт звільнено (зміна локації): незмінні поля TCH більше не на місці.
            if any(key(c) != sig for c, sig in zip(chunks, sigs)):
                break
            t = time.perf_counter() - t0
            fo.write(struct.pack("<d", t))
            for c in chunks:
                fo.write(c)
            frames += 1
            if frames % (hz * 10) == 0:
                fo.flush()
            for ci, c in enumerate(chunks):
                speed = fld(c, 0x128)
                steer = max(fld(c, 0x22F), fld(c, 0x230))
                ok_speed = speed == speed and speed > 4
                straight_since[ci] = straight_since.get(ci, t) if ok_speed and steer < 0.01 else t
                turn_since[ci] = turn_since.get(ci, t) if ok_speed and steer > 0.8 else t
                if t - last_dump > 2 and not NO_DUMPS:
                    if dumps["straight"] < 1 and t - straight_since[ci] > 1.5:
                        dump("straight", t, ci)
                    elif dumps["turn"] < 3 and t - turn_since[ci] > 1.0:
                        dump("turn", t, ci)
            time.sleep(max(0.0, 1 / hz - 0.002))
    say(f"відрізок {out_prefix}: {frames} кадрів, {time.perf_counter() - t0:.1f} с")
    return True




def main():
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "analyze":
        return cmd_analyze(a[1])
    if a[0] == "auto":
        global NO_DUMPS
        NO_DUMPS = "--no-dumps" in a
        return cmd_auto(a[1])
    p = Proc()
    if a[0] == "find":
        cmd_find(p)
    elif a[0] == "dump":
        cmd_dump(p, int(a[1], 16), int(a[2], 16) if len(a) > 2 else 0x400)
    elif a[0] == "record":
        size = int(a[a.index("--size") + 1], 16) if "--size" in a else 0x1000
        hz = float(a[a.index("--hz") + 1]) if "--hz" in a else 20
        cmd_record(p, int(a[1], 16), float(a[2]), a[3], size, hz)
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
