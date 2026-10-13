"""Проєкт Ghidra re/king для king.exe (Дальнобойщики 2: MSVC 6, x86) з автоаналізом. Лише читає exe.

    .venv/Scripts/python -I tools/re/ht2/setup_ghidra_king.py [--force]

Запити — той самий gq.py з GQ_GAME=ht2:  GQ_GAME=ht2 .venv/Scripts/python -I tools/re/gq.py strings Tree
"""
import os
import shutil
import sys
import time
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
EXE = ROOT / "Game" / "Hard Truck 2" / "king.exe"
PROJECT_DIR = ROOT / "re"
PROJECT_NAME = "king"

os.environ.setdefault("GHIDRA_INSTALL_DIR", str(next((ROOT / "tools").glob("ghidra_*_PUBLIC"))))
os.environ.setdefault("JAVA_HOME", r"C:\Program Files\Eclipse Adoptium\jdk-21.0.12.101-hotspot")
sys.stdout.reconfigure(encoding="utf-8")


def main() -> int:
    proj = PROJECT_DIR / PROJECT_NAME
    if proj.exists():
        if "--force" not in sys.argv:
            print(f"Проєкт {proj} уже існує; --force щоб перестворити")
            return 1
        shutil.rmtree(proj)
    import pyghidra

    pyghidra.start()
    warnings.simplefilter("ignore", DeprecationWarning)
    from ghidra.util.task import ConsoleTaskMonitor

    with pyghidra.open_program(str(EXE), project_location=str(PROJECT_DIR), project_name=PROJECT_NAME, analyze=False,
                               language="x86:LE:32:default", compiler="windows") as flat_api:
        program = flat_api.getCurrentProgram()
        t = time.time()
        pyghidra.analyze(program, ConsoleTaskMonitor())
        print(f"Автоаналіз {time.time() - t:.0f} с, функцій: {program.getFunctionManager().getFunctionCount()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
