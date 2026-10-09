"""Додає в локальну Ghidra компілятор "Watcom" (x86:LE:32:default:watcom) з __watcall за замовчуванням.

Ghidra не містить домовленості Watcom, тому без цього автоаналіз HTruck.exe неправильно визначає аргументи.
Скрипт ідемпотентний; запускати після кожного (пере)встановлення Ghidra:
    python -I tools/re/install_watcom_cspec.py
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
LANG = next((ROOT / "tools").glob("ghidra_*_PUBLIC")) / "Ghidra/Processors/x86/data/languages"

WATCALL = """<prototype name="__watcall" extrapop="unknown" stackshift="4">
      <input>
        <pentry minsize="1" maxsize="4"><register name="EAX"/></pentry>
        <pentry minsize="1" maxsize="4"><register name="EDX"/></pentry>
        <pentry minsize="1" maxsize="4"><register name="EBX"/></pentry>
        <pentry minsize="1" maxsize="4"><register name="ECX"/></pentry>
        <pentry minsize="1" maxsize="500" align="4"><addr offset="4" space="stack"/></pentry>
      </input>
      <output>
        <pentry minsize="4" maxsize="10" metatype="float"><register name="ST0"/></pentry>
        <pentry minsize="1" maxsize="4"><register name="EAX"/></pentry>
        <pentry minsize="5" maxsize="8"><addr space="join" piece1="EDX" piece2="EAX"/></pentry>
      </output>
      <unaffected>
        <register name="ESI"/><register name="EDI"/><register name="EBP"/><register name="ESP"/>
      </unaffected>
    </prototype>"""


def main():
    src = (LANG / "x86win.cspec").read_text(encoding="utf-8")
    m = re.search(r"<default_proto>\s*(.*?)\s*</default_proto>", src, re.S)
    stdcall = m.group(1)
    out = src[: m.start()] + f"<default_proto>\n    {WATCALL}\n  </default_proto>\n  {stdcall}" + src[m.end():]
    # EBX/ECX/EDX Watcom теж зберігає, але якщо оголосити їх "unaffected", декомпілятор не бачить їх як аргументи.
    (LANG / "x86watcom.cspec").write_text(out, encoding="utf-8")

    ldefs = LANG / "x86.ldefs"
    text = ldefs.read_text(encoding="utf-8")
    entry = '<compiler name="Watcom" spec="x86watcom.cspec" id="watcom"/>'
    if entry not in text:
        anchor = '<compiler name="Visual Studio" spec="x86win.cspec" id="windows"/>'
        i = text.index(anchor)  # перше входження = x86:LE:32:default
        text = text[: i + len(anchor)] + "\n    " + entry + text[i + len(anchor):]
        ldefs.write_text(text, encoding="utf-8")
    print("OK:", LANG / "x86watcom.cspec")


if __name__ == "__main__":
    main()
