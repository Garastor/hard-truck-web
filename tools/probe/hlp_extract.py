"""Мінімальний екстрактор тексту з WinHelp 3.x (.hlp): внутрішня ФС, |SYSTEM, |Phrases, |TOPIC (LZ77).

    python -I tools/probe/hlp_extract.py "Game/Hard Truck/HTruck.hlp" out.txt

Формат за описом helpdeco (M. Winterhoff, "helpfile.txt").
"""
import struct
import sys


def read_dir(d):
    magic, dir_start, _free, _size = struct.unpack_from("<IiiI", d, 0)
    assert magic == 0x00035F3F, hex(magic)
    p = dir_start + 9  # FILEHEADER: reserved, used, flags
    (bmagic, _flags, page_size) = struct.unpack_from("<HHH", d, p)
    assert bmagic == 0x293B
    root, _neg1, total_pages, nlevels, _entries = struct.unpack_from("<HhHHI", d, p + 26)
    pages = p + 38
    files = {}
    for pg in range(total_pages):
        base = pages + pg * page_size
        _unused, n, _prev, _next = struct.unpack_from("<HHhh", d, base)
        q = base + 8
        # листові сторінки: імʼя\0 + i32 зсув; індексні сторінки на рівні >1 пропускаємо евристично
        try:
            for _ in range(n):
                e = d.index(b"\0", q)
                name = d[q:e].decode("latin1")
                off = struct.unpack_from("<i", d, e + 1)[0]
                if name.startswith("|") or name.endswith((".bmp", ".shg", ".mrb")) or "." in name:
                    files[name] = off
                q = e + 5
        except (ValueError, struct.error):
            pass
    return files


def file_data(d, off):
    _reserved, used, _flags = struct.unpack_from("<iiB", d, off)
    return d[off + 9 : off + 9 + used]


def lz77(src, limit=None):
    out = bytearray()
    i = 0
    while i < len(src):
        flags = src[i]
        i += 1
        for bit in range(8):
            if i >= len(src):
                break
            if flags & (1 << bit):
                if i + 1 >= len(src):
                    i = len(src)
                    break
                t = src[i] | (src[i + 1] << 8)
                i += 2
                n = ((t >> 12) & 0xF) + 3
                pos = (t & 0x0FFF) + 1
                for _ in range(n):
                    out.append(out[-pos] if pos <= len(out) else 32)
            else:
                out.append(src[i])
                i += 1
            if limit and len(out) >= limit:
                return bytes(out)
    return bytes(out)


def main():
    d = open(sys.argv[1], "rb").read()
    files = read_dir(d)
    sysd = file_data(d, files["|SYSTEM"])
    _m, minor, major, _date, flags = struct.unpack_from("<HHHiH", sysd, 0)
    compressed = minor > 16 and flags in (4, 8)
    block = 2048 if flags == 8 else 4096
    print(f"WinHelp {major}.{minor} flags={flags} compressed={compressed} files={sorted(files)[:12]}")

    phrases = []
    if "|Phrases" in files:
        ph = file_data(d, files["|Phrases"])
        num, _hundred = struct.unpack_from("<HH", ph, 0)
        p = 4
        if minor > 16:
            dec_size = struct.unpack_from("<i", ph, p)[0]
            p += 4
        offs = struct.unpack_from(f"<{num + 1}H", ph, p)
        base = p
        chars = ph[base + 2 * (num + 1) :]
        if minor > 16:
            chars = lz77(chars, dec_size)
        rel0 = offs[0]
        for k in range(num):
            phrases.append(chars[offs[k] - rel0 : offs[k + 1] - rel0])

    hall = "|PhrIndex" in files and "|PhrImage" in files
    if hall:
        pi = file_data(d, files["|PhrIndex"])
        _magic, entries, _csize, img_size, img_csize, _z = struct.unpack_from("<iiiiii", pi, 0)
        bits = struct.unpack_from("<H", pi, 24)[0] & 0xF
        stream_bits = pi[28:]
        bitpos = 0

        def getbit():
            nonlocal bitpos
            w = struct.unpack_from("<I", stream_bits, (bitpos // 32) * 4)[0]
            r = (w >> (bitpos % 32)) & 1
            bitpos += 1
            return r

        offsets = [0]
        for _ in range(entries):
            n = 1
            while getbit():
                n += 1 << bits
            if getbit():
                n += 1
            if bits > 1 and getbit():
                n += 2
            if bits > 2 and getbit():
                n += 4
            if bits > 3 and getbit():
                n += 8
            offsets.append(offsets[-1] + n)
        img = file_data(d, files["|PhrImage"])
        if img_size != img_csize:
            img = lz77(img, img_size)
        phrases = [img[offsets[k] : offsets[k + 1]] for k in range(entries)]

    def dehall(b):
        out = bytearray()
        i = 0
        while i < len(b):
            c = b[i]
            i += 1
            if c & 1 == 0:
                k = c // 2
                out += phrases[k] if k < len(phrases) else b"?"
            elif c & 3 == 1:
                k = 128 + (c // 4) * 256 + (b[i] if i < len(b) else 0)
                i += 1
                out += phrases[k] if k < len(phrases) else b"?"
            elif c & 7 == 3:
                n = c // 8 + 1
                out += b[i : i + n]
                i += n
            elif c & 15 == 7:
                out += b" " * (c // 16 + 1)
            else:
                out += bytes(c // 16 + 1)  # NUL bytes
        return bytes(out)

    def dephrase(b):
        if hall:
            return dehall(b)
        out = bytearray()
        i = 0
        while i < len(b):
            c = b[i]
            if 0 < c < 10 and phrases and i + 1 < len(b):
                idx = 256 * (c - 1) + b[i + 1]
                ph = phrases[idx // 2] if idx // 2 < len(phrases) else b""
                out += ph
                if idx & 1:
                    out += b" "
                i += 2
            else:
                out.append(c)
                i += 1
        return bytes(out)

    topic = file_data(d, files["|TOPIC"])
    # Розпакування блоків і лінійний потік з відображенням віртуальних адрес.
    stream = bytearray()
    starts = []
    for b in range(0, len(topic), block):
        blk = topic[b : b + block]
        starts.append(len(stream))
        data = blk[12:]
        stream += lz77(data, 16384) if compressed else data

    def lin(pos):
        bi = pos >> 14 if compressed else pos // block
        off = (pos & 0x3FFF) - 12 if compressed else (pos % block) - 12
        return starts[bi] + off if bi < len(starts) else None

    out_lines = []
    p = 0
    seen = 0
    while p is not None and p + 21 <= len(stream) and seen < 100000:
        seen += 1
        size, len2, _prev, nxt, len1, rtype = struct.unpack_from("<iiiiiB", stream, p)
        if size <= 0:
            break
        rec = stream[p : p + size]
        data2 = rec[len1:]
        if rtype in (0x20, 0x23):
            if len2 > len(data2):
                data2 = dephrase(data2)
            txt = data2.replace(b"\0", b"\n").decode("cp1251", "replace").strip()
            if txt:
                out_lines.append(txt)
        elif rtype == 0x02:
            title = data2.split(b"\0")[0].decode("cp1251", "replace").strip()
            if title:
                out_lines.append(f"\n===== {title} =====")
        nl = lin(nxt) if nxt > 0 else None
        if nl is None or nl <= p:
            break
        p = nl
    open(sys.argv[2], "w", encoding="utf-8").write("\n".join(out_lines))
    print("records:", seen, "lines:", len(out_lines))


if __name__ == "__main__":
    main()
