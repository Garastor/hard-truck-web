"""R0: створює проєкт Ghidra re/htruck для HTruck.exe з компілятором Watcom (__watcall за замовчуванням)
і запускає автоаналіз.

Запуск (з кореня репозиторію):
    python -I tools/re/install_watcom_cspec.py          # один раз після встановлення Ghidra
    .venv/Scripts/python -I tools/re/setup_ghidra_project.py [--force]

--force видаляє наявний проєкт re/htruck (нотатки re/notes не зачіпаються).
"""
import os
import shutil
import sys
import time
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EXE = ROOT / "Game" / "Hard Truck" / "HTruck.exe"
PROJECT_DIR = ROOT / "re"
PROJECT_NAME = "htruck"

os.environ.setdefault("GHIDRA_INSTALL_DIR", str(next((ROOT / "tools").glob("ghidra_*_PUBLIC"))))
os.environ.setdefault("JAVA_HOME", r"C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> int:
    if not EXE.exists():
        print(f"Не знайдено {EXE}", file=sys.stderr)
        return 1
    proj = PROJECT_DIR / PROJECT_NAME
    if proj.exists():
        if "--force" not in sys.argv:
            print(f"Проєкт {proj} уже існує; --force щоб перестворити")
            return 1
        shutil.rmtree(proj)
    PROJECT_DIR.mkdir(exist_ok=True)

    import pyghidra

    pyghidra.start()
    warnings.simplefilter("ignore", DeprecationWarning)
    from ghidra.util.task import ConsoleTaskMonitor

    with pyghidra.open_program(
        str(EXE),
        project_location=str(PROJECT_DIR),
        project_name=PROJECT_NAME,
        analyze=False,
        language="x86:LE:32:default",
        compiler="watcom",
    ) as flat_api:
        program = flat_api.getCurrentProgram()
        cs = program.getCompilerSpec()
        print("Програма:", program.getName(), program.getLanguageID(), cs.getCompilerSpecID(),
              "default cc:", cs.getDefaultCallingConvention().getName())
        t = time.time()
        pyghidra.analyze(program, ConsoleTaskMonitor())
        print(f"Автоаналіз {time.time() - t:.0f} с, функцій: {program.getFunctionManager().getFunctionCount()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
