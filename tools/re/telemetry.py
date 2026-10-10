"""Телеметрія запущеного HTruck.exe: лише ЧИТАННЯ памʼяті процесу (ReadProcessMemory), нічого не змінює.

Ідея: обʼєкт машини містить копію запису техніки з TRUCK.TCH (маса, радіус колеса, момент, гальма…).
Ці числа відомі, тож обʼєкти машин знаходимо пошуком цієї послідовності в купі процесу, а далі
записуємо всі поля обʼєкта в часі й шукаємо, які з них — швидкість, оберти, передача.

    python -I tools/re/telemetry.py find                 # знайти обʼєкти машин (адреси)
    python -I tools/re/telemetry.py dump ADDR [SIZE]     # поля як float/int
    python -I tools/re/telemetry.py record ADDR SECS OUT.csv [--size N] [--hz 20]
    python -I tools/re/telemetry.py analyze OUT.csv      # поля, що змінювались: діапазон, к-сть значень
    python -I tools/re/telemetry.py auto re/telemetry/s1 # чекає гру й машину, пише знімки до виходу з гри

Таблиця техніки: 0x59d7dc + i·0x540 (див. re/notes/tech-params.md), кількість — 0x59c744.
"""
import ctypes
import ctypes.wintypes as wt
import csv
import struct
import sys
import time

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
TH32CS_SNAPPROCESS = 0x2

TECH_TABLE = 0x59D7DC
TECH_STRIDE = 0x540
TECH_COUNT = 0x59C744
# Поля запису, що копіюються в обʼєкт машини підряд: mass, rwheel, front/rear thickness, maxrotmomentum,
# breakpower, rear_axle_coeff (+0x60…+0x7b).
PATTERN_OFF, PATTERN_LEN = 0x60, 0x1C

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
NO_DUMPS = False  # auto --no-dumps: без повних знімків памʼяті (вони підвішують гру)
sys.stdout.reconfigure(encoding="utf-8", errors="replace")


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wt.DWORD),
        ("PartitionId", wt.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wt.DWORD),
        ("Protect", wt.DWORD),
        ("Type", wt.DWORD),
    ]


class PE32(ctypes.Structure):
    _fields_ = [
        ("dwSize", wt.DWORD),
        ("cntUsage", wt.DWORD),
        ("th32ProcessID", wt.DWORD),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", wt.DWORD),
        ("cntThreads", wt.DWORD),
        ("th32ParentProcessID", wt.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", wt.DWORD),
        ("szExeFile", ctypes.c_char * 260),
    ]


def find_pid(name=b"htruck.exe"):
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    e = PE32()
    e.dwSize = ctypes.sizeof(PE32)
    ok = k32.Process32First(snap, ctypes.byref(e))
    while ok:
        if e.szExeFile.lower() == name:
            k32.CloseHandle(snap)
            return e.th32ProcessID
        ok = k32.Process32Next(snap, ctypes.byref(e))
    k32.CloseHandle(snap)
    return None


class Proc:
    def __init__(self):
        pid = find_pid()
        if not pid:
            sys.exit("HTruck.exe не запущено")
        self.h = k32.OpenProcess(PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, False, pid)
        if not self.h:
            sys.exit(f"Не вдалося відкрити процес {pid}: помилка {ctypes.get_last_error()}")
        self.pid = pid

    def read(self, addr, size):
        buf = ctypes.create_string_buffer(size)
        n = ctypes.c_size_t()
        if not k32.ReadProcessMemory(self.h, ctypes.c_void_p(addr), buf, size, ctypes.byref(n)):
            return None
        return buf.raw[: n.value]

    def chunks(self, stats=None, chunk=1 << 20):
        """Уся доступна памʼять шматками (адреса, байти) з перекриттям 64 Б; що не читається цілим
        шматком — читаємо посторінково. stats: {'ok': байт, 'fail': байт}."""
        for base, size in self.regions():
            off = 0
            while off < size:
                n = min(chunk, size - off)
                data = self.read(base + off, min(n + 64, size - off))
                if data:
                    if stats is not None:
                        stats["ok"] = stats.get("ok", 0) + len(data)
                    yield base + off, data
                else:
                    for pg in range(0, n, 0x1000):
                        d = self.read(base + off + pg, min(0x1000, n - pg))
                        if stats is not None:
                            key = "ok" if d else "fail"
                            stats[key] = stats.get(key, 0) + min(0x1000, n - pg)
                        if d:
                            yield base + off + pg, d
                off += n

    def read_padded(self, addr, size):
        """Читає [addr, addr+size) посторінково; недоступні сторінки — нулями. None, якщо не прочиталось нічого."""
        data = self.read(addr, size)
        if data is not None and len(data) == size:
            return data
        out = bytearray(size)
        got = False
        pos = 0
        while pos < size:
            n = min(0x1000 - ((addr + pos) & 0xFFF), size - pos)
            d = self.read(addr + pos, n)
            if d:
                out[pos : pos + len(d)] = d
                got = True
            pos += n
        return bytes(out) if got else None

    def regions(self):
        addr = 0
        mbi = MBI()
        while addr < 0x7FFF0000:
            if not k32.VirtualQueryEx(self.h, ctypes.c_void_p(addr), ctypes.byref(mbi), ctypes.sizeof(mbi)):
                break
            base = mbi.BaseAddress or 0
            size = mbi.RegionSize
            if mbi.State == MEM_COMMIT and not (mbi.Protect & (PAGE_NOACCESS | PAGE_GUARD)):
                yield base, size
            addr = base + size


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


def fmt_slot(b):
    f = struct.unpack("<f", b)[0]
    i = struct.unpack("<i", b)[0]
    return f, i


def cmd_dump(p, addr, size=0x400):
    data = p.read(addr, size)
    if not data:
        sys.exit("не читається")
    for off in range(0, len(data) - 3, 4):
        f, i = fmt_slot(data[off : off + 4])
        fs = f"{f:.6g}" if abs(f) < 1e7 and (f == 0 or abs(f) > 1e-6) else "-"
        print(f"+0x{off:04x}  {fs:>14}  {i:>12}")


def cmd_record(p, addr, secs, out, size=0x1000, hz=20):
    """Записує всі 4-байтові слоти [addr, addr+size) з частотою hz у CSV (float; int — окремим файлом)."""
    n = size // 4
    t0 = time.perf_counter()
    rows = 0
    with open(out, "w", newline="") as fo, open(out.replace(".csv", ".int.csv"), "w", newline="") as fi:
        wf, wi = csv.writer(fo), csv.writer(fi)
        hdr = ["t"] + [f"+0x{k * 4:04x}" for k in range(n)]
        wf.writerow(hdr)
        wi.writerow(hdr)
        while (t := time.perf_counter() - t0) < secs:
            data = p.read(addr, size)
            if data and len(data) == size:
                fl = struct.unpack(f"<{n}f", data)
                it = struct.unpack(f"<{n}i", data)
                wf.writerow([f"{t:.3f}"] + [f"{v:.6g}" for v in fl])
                wi.writerow([f"{t:.3f}"] + list(it))
                rows += 1
            time.sleep(max(0.0, 1 / hz - 0.001))
    print(f"записано {rows} рядків у {out}")


def cmd_analyze(path):
    with open(path) as f:
        rows = list(csv.reader(f))
    hdr, data = rows[0], rows[1:]
    cols = list(zip(*data))
    print(f"{len(data)} рядків")
    for name, col in zip(hdr[1:], cols[1:]):
        vals = [float(v) for v in col]
        finite = [v for v in vals if v == v and abs(v) < 1e7]
        if len(finite) < len(vals) or len(set(vals)) < 2:
            continue
        lo, hi = min(finite), max(finite)
        print(f"{name}  [{lo:.4g} … {hi:.4g}]  різних: {len(set(vals))}")


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
