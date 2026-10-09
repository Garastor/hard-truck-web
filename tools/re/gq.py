"""gq — консольні запити до проєкту Ghidra (re/htruck) для HTruck.exe.

Приклади (з кореня репозиторію):
    .venv/Scripts/python -I tools/re/gq.py strings "_Car_V"           # рядки + функції, що їх використовують
    .venv/Scripts/python -I tools/re/gq.py decomp 0x4123a0             # псевдо-C функції
    .venv/Scripts/python -I tools/re/gq.py disasm 0x4123a0 40          # асемблер
    .venv/Scripts/python -I tools/re/gq.py xrefs 0x4123a0              # хто викликає
    .venv/Scripts/python -I tools/re/gq.py calls 0x4123a0              # кого викликає
    .venv/Scripts/python -I tools/re/gq.py rename 0x4123a0 Car_run2    # перейменувати (зберігається)
    .venv/Scripts/python -I tools/re/gq.py setcc all __watcall         # домовленість виклику
    .venv/Scripts/python -I tools/re/gq.py batch file.txt              # кілька команд за один запуск JVM

Кілька команд можна також розділити ";;" в одному виклику: gq.py decomp 0x401000 ";;" decomp 0x402000
"""
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
os.environ.setdefault("GHIDRA_INSTALL_DIR", str(ROOT / "tools" / "ghidra_12.1.4_PUBLIC"))
os.environ.setdefault("JAVA_HOME", r"C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot")
EXE = ROOT / "Game" / "Hard Truck" / "HTruck.exe"
PROJECT_DIR = ROOT / "re"
PROJECT_NAME = "htruck"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


class Ctx:
    def __init__(self, flat_api):
        self.api = flat_api
        self.program = flat_api.getCurrentProgram()
        self.listing = self.program.getListing()
        self.fm = self.program.getFunctionManager()
        self.refs = self.program.getReferenceManager()
        self._decomp = None
        self.dirty = False

    def addr(self, s):
        if s.startswith("0x") or re.fullmatch(r"[0-9a-fA-F]{6,8}", s):
            return self.api.toAddr(int(s, 16))
        fs = [f for f in self.fm.getFunctions(True) if f.getName() == s]
        if not fs:
            raise SystemExit(f"Немає функції/адреси {s}")
        return fs[0].getEntryPoint()

    def func(self, s):
        a = self.addr(s)
        f = self.fm.getFunctionContaining(a)
        if f is None:
            raise SystemExit(f"Адреса {a} поза функцією")
        return f

    def decompiler(self):
        if self._decomp is None:
            from ghidra.app.decompiler import DecompInterface

            d = DecompInterface()
            d.openProgram(self.program)
            self._decomp = d
        return self._decomp

    def tx(self, name):
        import pyghidra

        self.dirty = True
        return pyghidra.transaction(self.program, name)


def cmd_strings(c, pattern):
    from ghidra.program.util import DefinedStringIterator

    rx = re.compile(pattern)
    for d in DefinedStringIterator.forProgram(c.program):
        v = d.getValue()
        if not isinstance(v, str):
            v = str(v)
        if not rx.search(v):
            continue
        users = set()
        for r in c.refs.getReferencesTo(d.getAddress()):
            f = c.fm.getFunctionContaining(r.getFromAddress())
            users.add(f"{f.getName()}@{f.getEntryPoint()}" if f else str(r.getFromAddress()))
        print(f"{d.getAddress()}  {v!r}  <- {', '.join(sorted(users)) or '-'}")


def cmd_decomp(c, target):
    f = c.func(target)
    from ghidra.util.task import ConsoleTaskMonitor

    res = c.decompiler().decompileFunction(f, 120, ConsoleTaskMonitor())
    if not res.decompileCompleted():
        print("// помилка декомпіляції:", res.getErrorMessage())
        return
    print(f"// {f.getName()} @ {f.getEntryPoint()}  cc={f.getCallingConventionName()}")
    print(res.getDecompiledFunction().getC())


def cmd_disasm(c, target, n="40"):
    a = c.addr(target)
    ins = c.listing.getInstructionAt(a) or c.listing.getInstructionAfter(a)
    for _ in range(int(n)):
        if ins is None:
            break
        print(f"{ins.getAddress()}  {ins}")
        ins = ins.getNext()


def cmd_xrefs(c, target):
    a = c.addr(target)
    for r in c.refs.getReferencesTo(a):
        f = c.fm.getFunctionContaining(r.getFromAddress())
        print(f"{r.getFromAddress()}  {r.getReferenceType()}  {f.getName() if f else '-'}")


def cmd_calls(c, target):
    from ghidra.util.task import ConsoleTaskMonitor

    f = c.func(target)
    for g in sorted(f.getCalledFunctions(ConsoleTaskMonitor()), key=lambda x: x.getEntryPoint().getOffset()):
        print(f"{g.getEntryPoint()}  {g.getName()}")


def cmd_rename(c, target, name):
    from ghidra.program.model.symbol import SourceType

    f = c.func(target)
    with c.tx("rename"):
        f.setName(name, SourceType.USER_DEFINED)
    print(f"{f.getEntryPoint()} -> {name}")


def cmd_comment(c, target, *text):
    from ghidra.program.model.listing import CommentType

    a = c.addr(target)
    with c.tx("comment"):
        c.listing.setComment(a, CommentType.PLATE, " ".join(text))


def cmd_setcc(c, target, cc):
    with c.tx("setcc"):
        if target == "all":
            n = 0
            for f in c.fm.getFunctions(True):
                if f.isThunk() or f.isExternal():
                    continue
                if f.getCallingConventionName() in ("__stdcall",) and f.getName().startswith(("WinMain", "WndProc")):
                    continue
                f.setCallingConvention(cc)
                n += 1
            print(f"{cc} встановлено для {n} функцій")
        else:
            c.func(target).setCallingConvention(cc)


def cmd_fixcc(c):
    """__watcall для всіх функцій; __cdecl там, де після виклику стек чистить викликач (ADD ESP, n)."""
    from ghidra.program.model.listing import Function
    from ghidra.program.model.symbol import SourceType

    cdecl = set()
    for f in c.fm.getFunctions(True):
        for r in c.refs.getReferencesTo(f.getEntryPoint()):
            if not r.getReferenceType().isCall():
                continue
            ins = c.listing.getInstructionAt(r.getFromAddress())
            nxt = ins.getNext() if ins else None
            if nxt and nxt.getMnemonicString() == "ADD" and str(nxt.getOpObjects(0)[0]) == "ESP":
                cdecl.add(f.getEntryPoint())
                break
    n = 0
    with c.tx("fixcc"):
        for f in c.fm.getFunctions(True):
            if f.isThunk() or f.isExternal():
                continue
            cc = "__cdecl" if f.getEntryPoint() in cdecl else "__watcall"
            f.setCallingConvention(cc)
            if f.getSignatureSource() != SourceType.USER_DEFINED:
                f.replaceParameters(Function.FunctionUpdateType.DYNAMIC_STORAGE_ALL_PARAMS, True,
                                    SourceType.DEFAULT, [])
                f.setSignatureSource(SourceType.DEFAULT)
            n += 1
    print(f"оброблено {n} функцій, з них __cdecl: {len(cdecl)}")


def _postorder(c):
    """Функції у порядку «спершу ті, кого викликають» — щоб сигнатури поширювались знизу вгору."""
    from ghidra.util.task import ConsoleTaskMonitor

    mon = ConsoleTaskMonitor()
    seen, order = set(), []
    for root in c.fm.getFunctions(True):
        stack = [(root, False)]
        while stack:
            f, done = stack.pop()
            key = f.getEntryPoint()
            if done:
                order.append(f)
                continue
            if key in seen:
                continue
            seen.add(key)
            stack.append((f, True))
            for g in f.getCalledFunctions(mon):
                if g.getEntryPoint() not in seen and not g.isExternal():
                    stack.append((g, False))
    return order


def cmd_commitparams(c, passes="2"):
    from ghidra.program.model.pcode import HighFunctionDBUtil
    from ghidra.program.model.symbol import SourceType
    from ghidra.util.task import ConsoleTaskMonitor

    mon = ConsoleTaskMonitor()
    d = c.decompiler()
    order = [f for f in _postorder(c) if not (f.isThunk() or f.isExternal())]
    for p in range(int(passes)):
        ok = 0
        with c.tx(f"commitparams {p}"):
            for f in order:
                if f.getSignatureSource() == SourceType.USER_DEFINED:
                    continue
                res = d.decompileFunction(f, 60, mon)
                hf = res.getHighFunction() if res.decompileCompleted() else None
                if hf is None:
                    continue
                try:
                    HighFunctionDBUtil.commitParamsToDatabase(
                        hf, True, HighFunctionDBUtil.ReturnCommitOption.COMMIT, SourceType.ANALYSIS)
                    ok += 1
                except Exception as e:  # noqa: BLE001
                    print("  !", f.getEntryPoint(), e)
        print(f"прохід {p + 1}: збережено сигнатур {ok}/{len(order)}")


def cmd_exportall(c, outdir="re/decomp"):
    """Декомпілює все в re/decomp/<адреса>_<імʼя>.c та re/decomp/index.tsv (для grep)."""
    from ghidra.util.task import ConsoleTaskMonitor

    out = ROOT / outdir
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*.c"):
        old.unlink()
    mon = ConsoleTaskMonitor()
    d = c.decompiler()
    index = []
    for f in c.fm.getFunctions(True):
        if f.isThunk() or f.isExternal():
            continue
        res = d.decompileFunction(f, 60, mon)
        code = res.getDecompiledFunction().getC() if res.decompileCompleted() else f"// FAIL {res.getErrorMessage()}"
        name = f"{f.getEntryPoint()}_{re.sub(r'[^A-Za-z0-9_]', '_', f.getName())}"
        (out / f"{name}.c").write_text(code, encoding="utf-8")
        index.append(f"{f.getEntryPoint()}\t{f.getBody().getNumAddresses()}\t{f.getName()}")
    (out / "index.tsv").write_text("\n".join(index) + "\n", encoding="utf-8")
    print(f"експортовано {len(index)} функцій у {out}")


def cmd_funcs(c, pattern="."):
    rx = re.compile(pattern)
    for f in c.fm.getFunctions(True):
        if rx.search(f.getName()):
            print(f"{f.getEntryPoint()}  {f.getBody().getNumAddresses():6d}  {f.getName()}")


def cmd_bytes(c, target, n="64"):
    a = c.addr(target)
    data = bytes((b & 0xFF) for b in c.api.getBytes(a, int(n)))
    for i in range(0, len(data), 16):
        chunk = data[i : i + 16]
        print(f"{a.add(i)}  {chunk.hex(' ')}")


def cmd_floats(c, target, n="16"):
    import struct

    a = c.addr(target)
    data = bytes((b & 0xFF) for b in c.api.getBytes(a, int(n) * 4))
    for i in range(int(n)):
        (v,) = struct.unpack_from("<f", data, i * 4)
        print(f"{a.add(i * 4)}  {v!r}")


COMMANDS = {k[4:]: v for k, v in globals().items() if k.startswith("cmd_")}


def run(c, argv):
    if not argv:
        return
    name, *args = argv
    if name == "batch":
        for line in Path(args[0]).read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                print(f"\n===== {line}")
                run(c, line.split())
        return
    if name not in COMMANDS:
        raise SystemExit(f"Невідома команда {name}. Є: {', '.join(COMMANDS)}")
    COMMANDS[name](c, *args)


def main():
    argv = sys.argv[1:]
    if not argv:
        print(__doc__)
        return
    groups, cur = [], []
    for a in argv:
        if a == ";;":
            groups.append(cur)
            cur = []
        else:
            cur.append(a)
    groups.append(cur)

    import pyghidra

    pyghidra.start()
    import warnings

    warnings.simplefilter("ignore", DeprecationWarning)
    with pyghidra.open_program(
        str(EXE), project_location=str(PROJECT_DIR), project_name=PROJECT_NAME, analyze=False
    ) as api:
        c = Ctx(api)
        for i, g in enumerate(groups):
            if len(groups) > 1:
                print(f"\n===== {' '.join(g)}")
            run(c, g)


if __name__ == "__main__":
    main()
