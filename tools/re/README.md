# tools/re — реверс HTruck.exe

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

Телеметрія: `telemetry.py` — перша гра (`HTruck.exe`); другої (`king.exe`) — окрема тека [`ht2/`](ht2/README.md)
(скіл `ht2-telemetry`). `ht2/*` бере з `telemetry.py` лише доступ до памʼяті (`Proc`, `find_pid`).
