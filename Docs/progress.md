# Журнал прогресу

Журнали ігор: [Дальнобойщики](ht1/progress.md) (і спільний журнал до 2026-10-15), [Дальнобойщики 2](ht2/progress.md).
Тут — зміни спільного рушія (`web/src/engine`), оболонки (`web/src/app`) і структури проєкту.

## 2026-10-15 — реструктуризація: рушій, оболонка, теки ігор

План — [09-structure-plan.md](09-structure-plan.md). Лише перенесення й імпорти; поведінка ігор та сама.
- `web/src/engine` — спільний рушій (формати, рендер, фізика, машина, керування, звук, сховище файлів, віджети UI),
  `web/src/app` — оболонка (вибір гри, імпорт файлів, рендерер, PWA), `web/src/games/ht1`, `web/src/games/ht2` —
  ігри (друга — за підтеками world / vehicles / traffic / career / ui). Псевдоніми `@engine`, `@app`, `@ht1`, `@ht2`.
- Гра для оболонки — `games/<гра>/index.ts` (GameModule: набір файлів, dev-сервер, `run(GameContext)`);
  `main.ts` першої гри → `games/ht1/app.ts` (`runHt1`). Сховище файлів загальне: набір гри задає `extract`/`extras`
  (перша гра — маски 2D-кабіни з COUNT.RMP).
- Тести — `test/engine`, `test/ht1`, `test/ht2`; `test/architecture.test.ts` стежить за залежностями (рушій без
  ігор, ігри не імпортують одна одну, оболонка — лише через `index.ts`).
- Нотатки реверсу — `re/notes/ht1`, `re/notes/ht2`; документи — `Docs/ht1`, `Docs/ht2`; телеметрія —
  `tools/re/procmem.py` (спільне), `tools/re/ht1`, `tools/re/ht2`.
