"""Читання памʼяті процесу гри (Windows, ReadProcessMemory) — спільне для телеметрії обох ігор; лише читання.

    from procmem import Proc, find_pid      # tools/re у sys.path
    p = Proc(b"king.exe", "king.exe")       # або find_pid(b"htruck.exe")
"""
import csv
import ctypes
import ctypes.wintypes as wt
import struct
import sys
import time

PROCESS_VM_READ = 0x0010
PROCESS_QUERY_INFORMATION = 0x0400
MEM_COMMIT = 0x1000
PAGE_NOACCESS = 0x01
PAGE_GUARD = 0x100
TH32CS_SNAPPROCESS = 0x2

k32 = ctypes.WinDLL("kernel32", use_last_error=True)


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


def find_pid(name):
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
    """Відкритий на читання процес гри (exe — імʼя файлу малими літерами, напр. b"htruck.exe")."""

    def __init__(self, exe, title=None):
        pid = find_pid(exe)
        if not pid:
            sys.exit(f"{title or exe.decode()} не запущено")
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


# --- Загальні команди: поля обʼєкта як float/int, запис у CSV, розбір запису. ---


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
