"""Пошук живих полів машини в king.exe порівнянням знімків памʼяті (лише читання).

Режим auto: чекає запуску king.exe, а поки гра працює — циклами: N знімків купи (адреси нижче 0x70000000) щосекунди,
пошук трійок float і double, що поводяться як позиція машини (щосекунди зсув 0,3…60 м, загалом > 5 м), запис
кандидатів у OUT_<номер>.txt. Гравцю нічого не треба узгоджувати — досить їздити.

    python -I tools/re/ht2/snapscan.py auto OUT_PREFIX [N]     # чекає гру, знімає до її закриття
    python -I tools/re/ht2/snapscan.py once OUT.txt [N]        # один цикл зараз
"""
import os
import struct
import sys
import time

# telemetry.py (першої гри) — спільний доступ до памʼяті процесу (Proc, find_pid).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import telemetry as T  # noqa: E402


def open_game():
    pid = T.find_pid(b"king.exe")
    if not pid:
        return None
    p = T.Proc.__new__(T.Proc)
    p.h = T.k32.OpenProcess(T.PROCESS_VM_READ | T.PROCESS_QUERY_INFORMATION, False, pid)
    p.pid = pid
    return p if p.h else None


def snap(p):
    s = {}
    for base, size in p.regions():
        if base >= 0x70000000 or size > 64 << 20:
            continue
        d = p.read(base, size)
        if d:
            s[base] = d
    return s


def scan(shots):
    first, last = shots[0], shots[-1]
    cands = []
    for fmt, step in (("<3f", 4), ("<3d", 8)):
        w = struct.calcsize(fmt)
        for base, d0 in first.items():
            d1 = last.get(base)
            if not d1 or len(d1) != len(d0) or d0 == d1:
                continue
            for off in range(0, len(d0) - w, 0x1000):
                if d0[off : off + 0x1000 + w] == d1[off : off + 0x1000 + w]:
                    continue
                for k in range(off, min(off + 0x1000, len(d0) - w), step):
                    a = struct.unpack_from(fmt, d0, k)
                    b = struct.unpack_from(fmt, d1, k)
                    if a == b or not all(abs(v) < 20000 for v in a + b):
                        continue
                    track = []
                    for sh in shots:
                        dd = sh.get(base)
                        if not dd or len(dd) < k + w:
                            break
                        track.append(struct.unpack_from(fmt, dd, k))
                    if len(track) != len(shots):
                        continue
                    steps = [max(abs(u[i] - v[i]) for i in range(3)) for u, v in zip(track, track[1:])]
                    moved = sum(1 for d in steps if d > 0.3)
                    total = max(abs(track[-1][i] - track[0][i]) for i in range(3))
                    if moved < len(steps) * 0.7 or max(steps) > 60 or total < 5:
                        continue
                    cands.append((fmt[-1], base + k, track))
    return cands


def write(out, cands):
    with open(out, "w", encoding="utf-8") as f:
        f.write(f"{len(cands)} кандидатів\n")
        for t, a, tr in cands:
            f.write(f"{t} 0x{a:08x} " + " | ".join(f"{x:.1f},{y:.1f},{z:.1f}" for x, y, z in tr) + "\n")
    print(f"{time.strftime('%H:%M:%S')} {len(cands)} кандидатів → {out}", flush=True)


def cycle(p, n):
    shots = []
    for _ in range(n):
        t = time.time()
        shots.append(snap(p))
        time.sleep(max(0, 1 - (time.time() - t)))
    return scan(shots)


def main():
    a = sys.argv[1:]
    if len(a) < 2:
        sys.exit(__doc__)
    n = int(a[2]) if len(a) > 2 else 10
    if a[0] == "once":
        p = open_game() or sys.exit("king.exe не запущено")
        write(a[1], cycle(p, n))
        return
    print("чекаю king.exe…", flush=True)
    i = 0
    running = False
    while True:
        p = open_game()
        if not p:
            if running:
                print(f"{time.strftime('%H:%M:%S')} гра закрилась — чекаю наступного запуску", flush=True)
                running = False
            time.sleep(2)
            continue
        if not running:
            print(f"{time.strftime('%H:%M:%S')} king.exe запущено (PID {p.pid})", flush=True)
            running = True
        i += 1
        try:
            cands = cycle(p, n)
            write(f"{a[1]}_{i}.txt", cands)
            objs = objects(cands)
            if objs:
                record_windows(p, objs, f"{a[1]}_{i}", 30, 10)
        except Exception as e:  # гра закрилась посеред циклу
            print("помилка циклу:", e, flush=True)
        time.sleep(5)


WIN = 0x800


def objects(cands, limit=12):
    """Різні рухомі обʼєкти: трійки float у купі (вище 0x01000000), згруповані за кінцевою позицією (1 м);
    висота −50…900, зсув > 5 м. Повертає адреси (найменша в групі)."""
    groups = {}
    for t, a, tr in cands:
        if t != "f" or a < 0x01000000:
            continue
        x, y, z = tr[-1]
        if not (-50 <= z <= 900) or abs(x) < 1 or abs(y) < 1:
            continue
        key = (round(x), round(y), round(z))
        groups.setdefault(key, []).append(a)
    return sorted(min(v) for v in groups.values())[:limit]


def record_windows(p, addrs, prefix, secs, hz):
    """Запис вікон памʼяті [адреса − WIN, адреса + WIN) кожного обʼєкта: .bin (кадри підряд) і .json (опис)."""
    import json

    files = {a: open(f"{prefix}_{a:08x}.bin", "wb") for a in addrs}
    t0 = time.time()
    frames = 0
    while time.time() - t0 < secs:
        t = time.time()
        for a, f in files.items():
            d = p.read_padded(a - WIN, 2 * WIN) or bytes(2 * WIN)
            f.write(d)
        frames += 1
        time.sleep(max(0, 1 / hz - (time.time() - t)))
    for f in files.values():
        f.close()
    with open(f"{prefix}_windows.json", "w", encoding="utf-8") as f:
        json.dump({"addrs": [f"0x{a:08x}" for a in addrs], "win": WIN, "frames": frames, "hz": hz, "t0": t0}, f)
    print(f"{time.strftime('%H:%M:%S')} записано {len(addrs)} обʼєктів × {frames} кадрів → {prefix}_*.bin", flush=True)


if __name__ == "__main__":
    main()
