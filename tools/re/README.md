# tools/re — реверс оригінальних ігор (HTruck.exe, king.exe)

| Файл | Призначення |
|------|-------------|
| `install_watcom_cspec.py` | Додає в локальну Ghidra компілятор **Watcom** (`__watcall` за замовчуванням). Запускати після встановлення Ghidra |
| `setup_ghidra_project.py` | Створює `re/htruck` і запускає автоаналіз (`--force` перестворює) |
| `gq.py` | CLI-запити до проєкту: `strings`, `decomp`, `disasm`, `xrefs`, `calls`, `rename`, `comment`, `fixcc`, `commitparams`, `exportall`, `bytes`, `floats`, `funcs`, `batch` |

Повне розгортання з нуля:
```bash
python -m venv .venv && .venv/Scripts/pip install pyghidra-mcp
python -I tools/re/install_watcom_cspec.py
.venv/Scripts/python -I tools/re/setup_ghidra_project.py --force
.venv/Scripts/python -I tools/re/gq.py fixcc ";;" commitparams 2 ";;" exportall
```
Після цього `re/decomp/*.c` містить псевдо-C усіх функцій (лише локально, **не комітити**).

MCP: `.mcp.json` у корені підключає `pyghidra-mcp` до Claude Code (стає доступним після перезапуску сесії).
Ghidra-проєкт може бути відкритий лише одним процесом: не запускати `gq.py`, поки працює MCP-сервер, і навпаки.

Телеметрія (лише читання памʼяті запущеної гри): спільне — `procmem.py` (`Proc`, `find_pid`, команди
`dump`/`record`/`analyze`); перша гра (`HTruck.exe`) — [`ht1/telemetry.py`](ht1/telemetry.py), друга (`king.exe`) —
тека [`ht2/`](ht2/README.md) (скіл `ht2-telemetry`).
