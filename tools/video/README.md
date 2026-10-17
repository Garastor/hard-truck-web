# Декодер Indeo 5 для роликів HT2 (WebAssembly)

Ролики подій HT2 (`*.bne`) — AVI з відео Indeo 5 (`IV50`) і звуком PCM (re/notes/ht2/video.md). Браузери Indeo 5
не підтримують, тож порт декодує його декодером FFmpeg `libavcodec/indeo5.c`, зібраним у WebAssembly (рішення
користувача, 17.10).

- `indeo5.c` — обгортка: `iv_open(w, h)`, `iv_input(size)` (буфер кадру), `iv_decode(size)` (1 — новий кадр),
  `iv_rgba()` (RGBA w×h; YUV 4:1:0 → RGB за BT.601), `iv_close()`.
- `build.py` — збирання без make: configure FFmpeg лише з декодером indeo5 (bash з Git for Windows), компіляція
  потрібних файлів `libavutil`/`libavcodec` за їхніми Makefile, лінкування з `indeo5.c` у ES-модуль.
- Результат (у git): `web/src/games/ht2/engine/video/indeo5.js`, `indeo5.wasm` (≈310 КБ, gzip ≈143 КБ),
  `LICENSE.LGPL-2.1.txt`. Програвач — `engine/video/player.ts`, контейнер — `formats/avi.ts`.

## Ліцензія

Код FFmpeg — LGPL-2.1 або новіша (текст — `web/src/games/ht2/engine/video/LICENSE.LGPL-2.1.txt`). Зібрано з
вихідників **FFmpeg n7.1** (https://github.com/FFmpeg/FFmpeg/tree/n7.1) без змін; обгортка й скрипт — тут, тож
модуль можна перезібрати з тих самих вихідників.

## Перезібрати

1. emsdk (https://github.com/emscripten-core/emsdk): `git clone` у `D:\emsdk`, `emsdk install latest`,
   `emsdk activate latest`.
2. Вихідники: `git clone --depth 1 --branch n7.1 https://github.com/FFmpeg/FFmpeg.git D:/ht2-build/ffmpeg`.
3. Зібрати (Git for Windows потрібен для configure):

       .venv/Scripts/python -I tools/video/build.py --ffmpeg D:/ht2-build/ffmpeg --emsdk D:/emsdk --out D:/ht2-build/out

4. Перевірити: `npm test --prefix web` (`test/ht2/engine/video.test.ts` — усі ролики, кадрів стільки ж, скільки
   в ffmpeg).
