"""Ітератор по вмісту RMP/RES: python -I tools/probe/rmp_iter.py <file> — друкує секції; як модуль: entries(path)."""
import struct, sys
FILE_SECTIONS = {"PALETTEFILES", "SOUNDFILES", "BACKFILES", "MASKFILES", "TEXTUREFILES"}

def entries(path):
    d = open(path, "rb").read(); p = 0
    def cstr():
        nonlocal p
        e = d.index(b"\0", p); s = d[p:e].decode("cp1251"); p = e + 1; return s
    while p < len(d):
        sec, cnt = cstr().rsplit(" ", 1)
        for _ in range(int(cnt)):
            if sec in FILE_SECTIONS:
                name = cstr(); sz = struct.unpack_from("<I", d, p)[0]; p += 4
                yield sec, name, d[p:p + sz]; p += sz
            else:
                yield sec, cstr(), None

if __name__ == "__main__":
    for sec, name, data in entries(sys.argv[1]):
        print(sec, name, len(data) if data is not None else "")
