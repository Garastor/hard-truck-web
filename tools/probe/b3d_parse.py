"""Дослідницький парсер B3D (Hard Truck 1). Основа — специфікація HT2 від reRNR/RNRFileFormats (MIT),
виправлення під HT1 — за результатами розбору HTruck.exe (див. Docs/formats/b3d.md).

    python -I tools/probe/b3d_parse.py <file.b3d> [--tree] [--stop-on-error]
"""
import struct
import sys
from collections import Counter


class Err(Exception):
    pass


class R:
    def __init__(self, d, p=0):
        self.d, self.p = d, p

    def u4(self):
        v = struct.unpack_from("<I", self.d, self.p)[0]
        self.p += 4
        return v

    def i4(self):
        v = struct.unpack_from("<i", self.d, self.p)[0]
        self.p += 4
        return v

    def f4(self, n=1):
        v = struct.unpack_from(f"<{n}f", self.d, self.p)
        self.p += 4 * n
        return v if n > 1 else v[0]

    def name(self):
        s = self.d[self.p : self.p + 32].split(b"\0")[0].decode("cp1251", "replace")
        self.p += 32
        return s


def sphere(r):
    return r.f4(4)


def floats_list(r):
    n = r.u4()
    if n > 100000:
        raise Err(f"floats count {n}")
    return r.f4(n) if n > 1 else ([r.f4()] if n == 1 else [])


def simple_verts(r):
    n = r.u4()
    if n > 200000:
        raise Err(f"vert count {n}")
    r.p += n * 20
    return n


def polygon_8(r):
    fmt_raw = r.u4()
    fmt = fmt_raw ^ 1
    r.f4()
    r.u4()
    tex = r.u4()
    nv = r.u4()
    if nv > 1000:
        raise Err(f"poly verts {nv}")
    use_uv = fmt & 2 > 0
    use_n = (fmt & 0x20) > 0 and (fmt & 0x10) > 0
    uv_count = ((fmt & 0xFF00) >> 8) + (1 if use_uv else 0)
    nsw = (0 if fmt & 1 else 1) if use_n else -1
    for _ in range(nv):
        r.u4()
        if use_uv:
            r.p += 8 * uv_count
        if use_n:
            r.p += 12 if nsw == 0 else 4
    return tex


def polygon_28(r):
    fmt = r.u4()
    r.f4()
    r.u4()
    r.u4()
    nv = r.u4()
    use_uv = fmt & 2 > 0
    uv_count = ((fmt & 0xFF00) >> 8) + 1
    for _ in range(nv):
        r.p += 8
        if use_uv:
            r.p += 8 * uv_count


def complex_verts(r):
    fmt_raw = r.u4()
    fmt, uvc = fmt_raw & 0xFF, fmt_raw >> 8
    nsw = 0 if fmt in (1, 2) else 1
    n = r.u4()
    if n > 200000:
        raise Err(f"cverts {n}")
    per = 12 + 8 + 8 * uvc + (12 if nsw == 0 else 4)
    r.p += n * per
    return n


# Вид геометричної «форми» (HTruck.exe 0x44ad24): 0 — немає, 1/2/5 — 4×f32 (сфера/площина),
# 3/4 — 2×vec3 + 2×f32, 6 — n полігонів (u32 k, k×vec3), 7 — заздалегідь відома кількість vec3.
SWITCH_SHAPE = {9: 5, 10: 1, 11: 3, 22: 5}
TRIGGER_SHAPE = {12: 5, 13: 0, 14: 1, 15: 2, 16: 3, 17: 4, 23: 6}


def shape(r, kind):
    if kind in (1, 2, 5):
        r.f4(4)
    elif kind in (3, 4):
        r.f4(8)
    elif kind == 6:
        n = r.u4()
        for _ in range(n):
            k = r.u4()
            r.p += 12 * k


def trig_data(r):
    """HTruck.exe 0x44b3d4: u32, u32, u32 n, n×4 байти (параметри тригера)."""
    r.u4(); r.u4()
    n = r.u4()
    if n > 100000:
        raise Err(f"trig data {n}")
    r.p += 4 * n


# Кожна функція читає дані блоку (після імені й типу) і повертає True, якщо блок має дочірні (children).
def b_data(t, r):
    if t == 0:
        r.f4(11)
    elif t == 1:
        r.name(); r.name()
    elif t == 2:
        sphere(r); sphere(r); return True
    elif t in SWITCH_SHAPE:  # перемикач за умовою (HTruck.exe 0x44af84): sphere, форма, дочірні
        sphere(r); shape(r, SWITCH_SHAPE[t]); return True
    elif t == 3:
        sphere(r); return True
    elif t == 4:
        sphere(r); r.name(); r.name(); return True
    elif t == 5:
        sphere(r); r.name(); return True
    elif t == 6:
        sphere(r); r.name(); r.name(); simple_verts(r); return True
    elif t == 7:
        sphere(r); r.name(); simple_verts(r); return True
    elif t == 8:
        sphere(r)
        n = r.u4()
        for _ in range(n):
            polygon_8(r)
    elif t in TRIGGER_SHAPE:  # тригери/колізії (HTruck.exe 0x44b428)
        k = TRIGGER_SHAPE[t]
        if k == 6:
            trig_data(r); shape(r, 6)
        else:
            sphere(r); shape(r, k); trig_data(r)
    elif t == 18:
        sphere(r); r.name(); r.name()
    elif t == 19:
        return True
    elif t == 20:
        sphere(r); n = r.u4(); trig_data(r); r.p += 12 * n
    elif t == 21:
        sphere(r); r.u4(); r.u4(); return True
    elif t == 24:
        r.f4(12); r.u4(); return True
    elif t == 25:  # HT1 (HTruck.exe 0x44d13c): 3×u32, імʼя звуку, 2×vec3, 5×f32
        r.u4(); r.u4(); r.u4(); r.name(); r.f4(3); r.f4(3); r.f4(5)
    elif t == 26:
        sphere(r); r.f4(9); return True
    elif t == 27:
        sphere(r); r.u4(); r.f4(3); r.u4()
    elif t == 28:
        sphere(r); r.f4(3)
        n = r.u4()
        for _ in range(n):
            polygon_28(r)
    elif t == 29:  # HTruck.exe 0x44be9c: sphere, n, прапорці, sphere, n×f32, дочірні
        sphere(r); n = r.u4(); r.u4(); sphere(r); r.f4(n) if n else None; return True
    elif t == 30:
        sphere(r); r.name(); r.f4(3); r.f4(3)
    elif t == 31:
        sphere(r); n = r.u4(); sphere(r); r.u4(); r.f4(3); r.p += 8 * n
    elif t == 33:
        sphere(r); r.u4(); r.u4(); r.u4(); r.f4(3); r.f4(3); r.f4(6); r.f4(3); return True
    elif t == 34:
        sphere(r); r.u4(); n = r.u4(); r.p += 16 * n
    elif t == 35:
        sphere(r); r.u4(); r.u4()
        n = r.u4()
        for _ in range(n):
            polygon_8(r)
    elif t == 36:
        sphere(r); r.name(); r.name(); complex_verts(r); return True
    elif t == 37:
        sphere(r); r.name(); complex_verts(r); return True
    elif t == 39:
        sphere(r); r.u4(); r.f4(3); r.u4(); return True
    elif t == 40:
        sphere(r); r.name(); r.name(); r.u4(); r.u4(); floats_list(r)
    else:
        raise Err(f"unknown type {t}")
    return False


def parse(d, tree=False, stop=False):
    if d[:4] != b"b3d\0":
        raise Err("bad magic")
    size, mo, ms, do, ds = struct.unpack_from("<5I", d, 4)
    r = R(d, mo * 4)
    nmat = r.u4()
    r.p = do * 4
    if r.u4() != 111:
        raise Err("no 111")
    stats = Counter()
    errors = []

    def block(depth):
        while True:
            m = r.u4()
            if m == 333:
                break
            if m != 444:
                raise Err(f"@{r.p - 4}: expected 333/444, got {m}")
        start = r.p
        name = r.name()
        t = r.u4()
        stats[t] += 1
        try:
            has_children = b_data(t, r)
        except Err as e:
            raise Err(f"@{start}: type {t} '{name}': {e}") from None
        if tree:
            print("  " * depth + f"[{t}] {name}")
        if has_children:
            n = r.u4()
            if n > 100000:
                raise Err(f"@{start}: type {t} '{name}' children {n}")
            for _ in range(n):
                block(depth + 1)
        e = r.u4()
        while e == 444:  # порожні групи перемикача в кінці (HTruck.exe 0x43fb88)
            e = r.u4()
        if e != 555:
            raise Err(f"@{start}: type {t} '{name}' ends at {r.p - 4} with {e} (not 555)")

    end = (do + ds) * 4
    while r.p < end - 4:
        m = struct.unpack_from("<I", d, r.p)[0]
        if m == 222:
            break
        try:
            block(0)
        except (Err, struct.error) as e:
            errors.append(str(e))
            break
    return nmat, stats, errors, r.p, end


def main():
    path = sys.argv[1]
    nmat, stats, errors, p, end = parse(open(path, "rb").read(), "--tree" in sys.argv)
    print(f"{path}: materials={nmat} blocks={sum(stats.values())} pos={p}/{end}")
    print("  types:", dict(sorted(stats.items())))
    for e in errors:
        print("  ERROR:", e)


if __name__ == "__main__":
    main()
